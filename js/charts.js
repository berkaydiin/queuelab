// Chart.js wrappers. Three charts: queue length over time, wait-time
// distribution, and per-server utilisation. Each shows the theoretical value
// as a dashed grey reference so the eye can compare without reading numbers.

/* global Chart */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function baseOptions() {
  const ink2 = cssVar('--ink-2'), rule = cssVar('--rule-2');
  Chart.defaults.font.family = '"Bricolage Grotesque", system-ui, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = ink2;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 14 } },
      tooltip: { backgroundColor: cssVar('--ink'), titleColor: cssVar('--paper'), bodyColor: cssVar('--paper'), displayColors: false, padding: 8 },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 }, border: { color: rule } },
      y: { grid: { color: rule }, border: { display: false }, ticks: { maxTicksLimit: 5 }, beginAtZero: true },
    },
  };
}

// Hex colour -> rgba string with the given opacity.
function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function fmtMin(m) {
  if (m >= 1440) return `${(m / 1440).toFixed(1)} d`;
  if (m >= 120) return `${(m / 60).toFixed(1)} h`;
  return `${Math.round(m)} min`;
}

export class Charts {
  constructor() {
    this.build();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.destroy(); this.build(); });
  }

  destroy() { for (const c of [this.queue, this.wait, this.util]) c?.destroy(); }

  build() {
    const wait = cssVar('--wait'), serve = cssVar('--serve'), theory = cssVar('--theory');
    const opt = baseOptions();

    this.queue = new Chart(document.getElementById('chart-queue'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Queue length', data: [], borderColor: withAlpha(wait, 0.45), backgroundColor: wait, borderWidth: 1, pointRadius: 0, stepped: true },
          { label: 'Running average', data: [], borderColor: cssVar('--ink'), backgroundColor: cssVar('--ink'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Theory Lq', data: [], borderColor: theory, backgroundColor: theory, borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
        ],
      },
      options: {
        ...opt,
        scales: {
          ...opt.scales,
          x: { ...opt.scales.x, type: 'linear', ticks: { ...opt.scales.x.ticks, callback: (v) => fmtMin(v) } },
          y: { ...opt.scales.y, title: { display: true, text: 'customers', color: cssVar('--ink-2') } },
        },
        plugins: { ...opt.plugins, tooltip: { ...opt.plugins.tooltip, callbacks: { title: (items) => `t = ${fmtMin(items[0].parsed.x)}`, label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(2)}` } } },
      },
    });

    this.wait = new Chart(document.getElementById('chart-wait'), {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Share of customers', data: [], backgroundColor: wait, borderRadius: 2, barPercentage: 1, categoryPercentage: 0.92 },
      ] },
      options: {
        ...opt,
        plugins: {
          ...opt.plugins,
          legend: { display: false },
          tooltip: { ...opt.plugins.tooltip, callbacks: { title: (items) => items[0].label, label: (it) => `${(it.parsed.y * 100).toFixed(1)}% of customers` } },
        },
        scales: {
          x: { ...opt.scales.x, title: { display: true, text: 'minutes waited', color: cssVar('--ink-2') }, ticks: { ...opt.scales.x.ticks, maxTicksLimit: 8 } },
          y: { ...opt.scales.y, ticks: { ...opt.scales.y.ticks, callback: (v) => `${Math.round(v * 100)}%` } },
        },
      },
      plugins: [refLinePlugin()],
    });

    this.util = new Chart(document.getElementById('chart-util'), {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Simulation', data: [], backgroundColor: serve, borderRadius: 2, barPercentage: 0.7 },
        { label: 'Theory ρ', data: [], type: 'line', borderColor: theory, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, stepped: 'middle' },
      ] },
      options: {
        ...opt,
        scales: {
          x: { ...opt.scales.x, ticks: { ...opt.scales.x.ticks, maxTicksLimit: 24 } },
          y: { ...opt.scales.y, max: 1, ticks: { ...opt.scales.y.ticks, callback: (v) => `${Math.round(v * 100)}%` } },
        },
        plugins: { ...opt.plugins, tooltip: { ...opt.plugins.tooltip, callbacks: { label: (it) => `${it.dataset.label}: ${(it.parsed.y * 100).toFixed(1)}%` } } },
      },
    });
  }

  update(sim, summary, theory) {
    // Queue length over time
    const s = sim.series;
    const pts = s.t.map((t, i) => ({ x: t, y: s.lq[i] }));
    this.queue.data.datasets[0].data = pts;
    // Running time-average of the queue length, counted from the end of warm-up.
    const run = []; let acc = 0, n = 0;
    for (let i = 0; i < s.t.length; i++) {
      if (s.t[i] < sim.cfg.warmup) continue;
      acc += s.lq[i]; n++;
      run.push({ x: s.t[i], y: acc / n });
    }
    this.queue.data.datasets[1].data = run;
    const lqTh = theory.stable && Number.isFinite(theory.Lq) ? theory.Lq : null;
    this.queue.data.datasets[2].data = lqTh !== null && pts.length ? [{ x: pts[0].x, y: lqTh }, { x: pts[pts.length - 1].x, y: lqTh }] : [];
    this.queue.update('none');

    // Wait histogram
    const h = sim.histogram(24);
    if (h.counts.length) {
      const total = h.total || 1;
      const d = h.max < 5 ? 2 : 1;
      const labels = h.counts.map((_, i) => `${h.edges[i].toFixed(d)}–${h.edges[i + 1].toFixed(d)}`);
      labels.unshift('0');
      labels.push(`> ${h.max.toFixed(d)}`);
      const data = [h.zero / total, ...h.counts.map((c) => c / total), h.overflow / total];
      this.wait.data.labels = labels;
      this.wait.data.datasets[0].data = data;
      // Reference lines expressed as fractional category positions.
      const binW = h.max / 24;
      const toPos = (v) => (v <= 1e-9 ? 0 : 0.5 + v / binW);   // 0 bin occupies position 0, bins start at 0.5
      this.wait.$refs = [
        summary.Wq !== null ? { x: toPos(summary.Wq), color: cssVar('--wait'), label: `sim mean ${summary.Wq.toFixed(1)}` } : null,
        theory.stable && Number.isFinite(theory.Wq) ? { x: toPos(theory.Wq), color: cssVar('--theory'), label: `theory ${theory.Wq.toFixed(1)}`, dash: true } : null,
      ].filter(Boolean);
    } else {
      this.wait.data.labels = []; this.wait.data.datasets[0].data = []; this.wait.$refs = [];
    }
    this.wait.update('none');

    // Utilisation
    const per = summary.perServer;
    this.util.data.labels = per.map((p) => `S${p.index + 1}`);
    this.util.data.datasets[0].data = per.map((p) => p.utilisation);
    this.util.data.datasets[1].data = per.map(() => (theory.stable ? Math.min(1, theory.rho) : null));
    this.util.update('none');
  }
}

// Draws vertical reference lines stored on chart.$refs (in category-axis units).
function refLinePlugin() {
  return {
    id: 'refLines',
    afterDatasetsDraw(chart) {
      const refs = chart.$refs || [];
      if (!refs.length) return;
      const { ctx, chartArea, scales } = chart;
      const x = scales.x;
      ctx.save();
      ctx.font = '500 11px "Bricolage Grotesque", system-ui, sans-serif';
      refs.forEach((r, i) => {
        const px = x.getPixelForValue(r.x);
        if (px < chartArea.left || px > chartArea.right) return;
        ctx.strokeStyle = r.color; ctx.lineWidth = 1.5;
        ctx.setLineDash(r.dash ? [5, 4] : []);
        ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = r.color; ctx.textAlign = 'left';
        ctx.fillText(r.label, px + 4, chartArea.top + 12 + i * 14);
      });
      ctx.restore();
    },
  };
}
