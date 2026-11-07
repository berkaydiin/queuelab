import { Simulation, normaliseConfig, DEFAULT_CONFIG } from './sim.js';
import { theoryFor } from './theory.js';
import { StageRenderer } from './canvas.js';
import { Charts } from './charts.js';

// --- presets (minutes for service, per hour for arrivals) -------------------
const PRESETS = {
  cafe:       { arrivalsPerHour: 60,  serviceMean: 1.5, servers: 2,  serviceDist: 'erlang2',     discipline: 'fifo',     maxQueue: Infinity, warmup: 60,  waitThreshold: 3,  targetWait: 1.5 },
  canteen:    { arrivalsPerHour: 200, serviceMean: 0.5, servers: 2,  serviceDist: 'exponential', discipline: 'fifo',     maxQueue: Infinity, warmup: 30,  waitThreshold: 2,  targetWait: 1 },
  callcenter: { arrivalsPerHour: 120, serviceMean: 4,   servers: 10, serviceDist: 'exponential', discipline: 'fifo',     maxQueue: 12,       warmup: 120, waitThreshold: 0.5, targetWait: 0.5 },
  airport:    { arrivalsPerHour: 300, serviceMean: 0.7, servers: 4,  serviceDist: 'deterministic', discipline: 'fifo',   maxQueue: Infinity, warmup: 60,  waitThreshold: 10, targetWait: 5 },
  er:         { arrivalsPerHour: 10,  serviceMean: 25,  servers: 5,  serviceDist: 'exponential', discipline: 'priority', priorityShare: 0.25, maxQueue: Infinity, warmup: 1440, waitThreshold: 30, targetWait: 15 },
  overload:   { arrivalsPerHour: 70,  serviceMean: 4,   servers: 4,  serviceDist: 'exponential', discipline: 'fifo',     maxQueue: Infinity, warmup: 60,  waitThreshold: 5,  targetWait: 2 },
};

// --- URL state ------------------------------------------------------------------
const URL_KEYS = ['arrivalsPerHour', 'serviceMean', 'servers', 'serviceDist', 'discipline', 'priorityShare', 'maxQueue', 'warmup', 'waitThreshold', 'targetWait', 'seed'];
function readUrl() {
  const p = new URLSearchParams(location.search);
  const out = {};
  for (const k of URL_KEYS) if (p.has(k)) out[k] = p.get(k);
  return out;
}
function writeUrl(c) {
  const p = new URLSearchParams();
  for (const k of URL_KEYS) {
    const v = c[k];
    if (v === DEFAULT_CONFIG[k]) continue;
    if (k === 'maxQueue' && !Number.isFinite(v)) continue;
    p.set(k, v);
  }
  const q = p.toString();
  history.replaceState(null, '', q ? `?${q}` : location.pathname);
}

const $ = (sel) => document.querySelector(sel);
const form = $('#controls');
const stageCanvas = $('#stage');

let cfg = normaliseConfig(readUrl());
let sim = new Simulation(cfg);
let theory = theoryFor(sim.cfg);
let running = false;
let speed = +$('#speed').value;   // simulated minutes per real second
let lastTs = null;
let lastPanelUpdate = 0;

const renderer = new StageRenderer(stageCanvas);
const charts = new Charts();

// --- form <-> config -----------------------------------------------------------
function writeForm(c) {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.name === 'maxQueue') el.value = Number.isFinite(c.maxQueue) ? c.maxQueue : '';
    else if (c[el.name] !== undefined) el.value = c[el.name];
  }
  refreshOutputs();
}

function readForm() {
  const data = Object.fromEntries(new FormData(form).entries());
  return normaliseConfig(data);
}

function refreshOutputs() {
  const v = Object.fromEntries(new FormData(form).entries());
  $('#out-arrivalsPerHour').textContent = (+v.arrivalsPerHour).toString();
  $('#out-serviceMean').textContent = (+v.serviceMean).toFixed(1);
  $('#out-servers').textContent = v.servers;
  $('#out-priorityShare').textContent = Math.round(+v.priorityShare * 100);
  $('#field-priorityShare').hidden = v.discipline !== 'priority';
  const rho = (+v.arrivalsPerHour / 60) * +v.serviceMean / +v.servers;
  const finiteRoom = v.maxQueue !== '' && Number.isFinite(+v.maxQueue);
  const line = $('#load-line');
  const suffix = rho >= 1 ? (finiteRoom ? ', the room will fill and people will be turned away' : ', unstable: the line keeps growing') : rho >= 0.9 ? ', heavy' : '';
  line.innerHTML = `Offered load ρ = <b>${rho.toFixed(2)}</b>${suffix}`;
  line.classList.toggle('hot', rho >= 1 && !finiteRoom);
}

function applyConfig(newCfg, { fromPreset = null, syncForm = true } = {}) {
  cfg = normaliseConfig(newCfg);
  sim = new Simulation(cfg);
  theory = theoryFor(sim.cfg);
  renderer.reset();
  if (syncForm) { writeForm(cfg); writeUrl(cfg); }
  for (const b of document.querySelectorAll('.presets button')) b.setAttribute('aria-pressed', b.dataset.preset === fromPreset ? 'true' : 'false');
  updatePanels(true);
}

form.addEventListener('input', () => {
  refreshOutputs();
  // Sliders fire continuously; rebuild the simulation on each change so the
  // picture tracks the control. The form is left alone while the person types.
  applyConfig(readForm(), { syncForm: false });
});
form.addEventListener('change', () => applyConfig(readForm()));   // also writes the URL

$('#btn-reseed').addEventListener('click', () => {
  form.elements.seed.value = Math.floor(Math.random() * 1e9) + 1;
  applyConfig(readForm());
});

for (const b of document.querySelectorAll('.presets button')) {
  b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    applyConfig({ ...DEFAULT_CONFIG, ...p, seed: cfg.seed }, { fromPreset: b.dataset.preset });
    if (!running) toggleRun(true);
  });
}

// --- transport -----------------------------------------------------------------
function toggleRun(force) {
  running = force === undefined ? !running : force;
  $('#btn-run').textContent = running ? 'Pause' : 'Run';
  lastTs = null;
}
$('#btn-run').addEventListener('click', () => toggleRun());
$('#btn-reset').addEventListener('click', () => { applyConfig(cfg); });
$('#speed').addEventListener('change', (e) => { speed = +e.target.value; });
$('#btn-ff').addEventListener('click', () => {
  // Jump ahead past the warm-up if needed, then 50k customers.
  if (sim.clock < cfg.warmup) sim.advanceTo(cfg.warmup);
  sim.runCustomers(50000);
  renderer.reset(sim.snapshot());
  updatePanels(true);
});

// --- export & share -------------------------------------------------------------
$('#btn-csv').addEventListener('click', () => {
  if (sim.customerLog.arrival.n === 0) { toast('Nothing to export yet: let the simulation pass the warm-up first'); return; }
  const csv = sim.customerCsv();
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `queuelab-${describe(cfg)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`${sim.customerLog.arrival.n.toLocaleString()} customers exported`);
});

$('#btn-share').addEventListener('click', async () => {
  const url = location.href;
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { toast('Copy failed: the link is in the address bar'); }
});

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.textContent = ''; }, 2600);
}

function describe(c) {
  return `${c.arrivalsPerHour}ph-${c.serviceMean}min-${c.servers}s-${c.serviceDist}-${c.discipline}`;
}

// --- results panel --------------------------------------------------------------
const fmt = {
  min: (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v < 10 ? `${v.toFixed(2)} min` : `${v.toFixed(1)} min`),
  num: (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2)),
  pct: (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`),
};

function gapCell(simV, thV, kind, ci = null) {
  if (simV === null || thV === null || simV === undefined || thV === undefined || !Number.isFinite(thV) || !Number.isFinite(simV)) return { text: '—', cls: '' };
  if (ci !== null && ci !== undefined) {
    // When a confidence interval exists, agreement means theory lies inside it.
    const rel = thV !== 0 ? (simV - thV) / thV : simV - thV;
    const inside = Math.abs(simV - thV) <= ci;
    return { text: `${rel >= 0 ? '+' : '−'}${(Math.abs(rel) * 100).toFixed(1)}%${inside ? ' · within CI' : ''}`, cls: inside ? 'ok' : Math.abs(rel) <= 0.15 ? '' : 'warn' };
  }
  if (kind === 'pct' || Math.abs(thV) < 1e-9) {
    const d = simV - thV;
    const abs = Math.abs(d);
    return { text: `${d >= 0 ? '+' : '−'}${(abs * (kind === 'pct' ? 100 : 1)).toFixed(kind === 'pct' ? 1 : 2)}${kind === 'pct' ? ' pt' : ''}`, cls: abs <= (kind === 'pct' ? 0.02 : 0.05) ? 'ok' : abs <= (kind === 'pct' ? 0.05 : 0.2) ? '' : 'warn' };
  }
  const rel = (simV - thV) / thV;
  const a = Math.abs(rel);
  return { text: `${rel >= 0 ? '+' : '−'}${(a * 100).toFixed(1)}%`, cls: a <= 0.05 ? 'ok' : a <= 0.15 ? '' : 'warn' };
}

function row(label, simText, thText, gap, { sub = false, pending = false } = {}) {
  return `<tr${sub ? ' class="sub"' : ''}><th scope="row">${label}</th><td class="sim${pending ? ' pending' : ''}">${simText}</td><td class="theory">${thText}</td><td class="gap ${gap.cls}">${gap.text}</td></tr>`;
}

function updatePanels(force = false) {
  const now = performance.now();
  if (!force && now - lastPanelUpdate < 250) return;
  lastPanelUpdate = now;

  const s = sim.summary();
  const th = theory;
  const pending = !s.warmupDone || s.served === 0;

  $('#model-line').textContent = th.finite
    ? `${th.model}${th.approximate ? ' · approximate' : ''} · offered load ${th.offeredLoad.toFixed(2)} · utilisation ${th.rho.toFixed(2)}`
    : `${th.model}${th.approximate ? ' · approximate' : ''} · ρ = ${th.rho.toFixed(2)}`;

  const ci = s.WqCi !== null && s.WqCi !== undefined ? ` <span class="ci">± ${s.WqCi.toFixed(2)}</span>` : '';
  const rows = [];
  rows.push(row('Average wait in line (Wq)', pending ? 'collecting…' : fmt.min(s.Wq) + ci, fmt.min(th.Wq), gapCell(s.Wq, th.Wq, 'min', s.WqCi), { pending }));
  if (cfg.discipline === 'priority') {
    const ph = th.priority?.high?.Wq ?? null, pl = th.priority?.low?.Wq ?? null;
    rows.push(row('high priority', fmt.min(s.WqHigh), fmt.min(ph), gapCell(s.WqHigh, ph), { sub: true }));
    rows.push(row('normal', fmt.min(s.WqLow), fmt.min(pl), gapCell(s.WqLow, pl), { sub: true }));
  }
  rows.push(row('Average time in system (W)', fmt.min(s.W), fmt.min(th.W), gapCell(s.W, th.W)));
  rows.push(row('Average number waiting (Lq)', fmt.num(s.Lq), fmt.num(th.Lq), gapCell(s.Lq, th.Lq)));
  rows.push(row('Average number in system (L)', fmt.num(s.L), fmt.num(th.L), gapCell(s.L, th.L)));
  rows.push(row('Server utilisation', fmt.pct(s.rho), th.stable ? fmt.pct(th.rho) : `100% (load ${(th.offeredLoad * 100).toFixed(0)}%)`, th.stable ? gapCell(s.rho, th.rho, 'pct') : { text: '—', cls: '' }));
  rows.push(row('Customers who had to wait', fmt.pct(s.pWait), fmt.pct(th.pWait), gapCell(s.pWait, th.pWait, 'pct')));
  rows.push(row(`Waited more than ${cfg.waitThreshold} min`, fmt.pct(s.pOver), fmt.pct(th.pWaitOver), gapCell(s.pOver, th.pWaitOver, 'pct')));
  rows.push(row('95th percentile wait', fmt.min(s.q95), fmt.min(th.q95), gapCell(s.q95, th.q95)));
  if (Number.isFinite(cfg.maxQueue)) rows.push(row('Turned away (room full)', fmt.pct(s.blockedShare), fmt.pct(th.blocked), gapCell(s.blockedShare, th.blocked, 'pct')));
  rows.push(row('Customers served after warm-up', s.served.toLocaleString(), '', { text: '', cls: '' }));
  rows.push(row('Longest line seen', s.maxQueue.toLocaleString(), '', { text: '', cls: '' }));
  $('#results-table tbody').innerHTML = rows.join('');

  // Staffing line
  const st = $('#staffing-line');
  if (th.requiredServers) {
    const diff = th.requiredServers - cfg.servers;
    const verdict = diff <= 0 ? `Your ${cfg.servers} server${cfg.servers > 1 ? 's' : ''} already meet it.` : `You have ${cfg.servers}, so add ${diff}.`;
    st.innerHTML = `To keep the average wait under <b>${cfg.targetWait} min</b> at this demand, M/M/c needs <b>${th.requiredServers} server${th.requiredServers > 1 ? 's' : ''}</b>. ${verdict}`;
  } else {
    st.textContent = `No number of servers up to 200 brings the average wait under ${cfg.targetWait} min at this demand.`;
  }

  const notes = [...th.notes];
  if (s.warmupDone && s.served > 0 && s.served < 2000) notes.push(`Only ${s.served.toLocaleString()} customers counted so far: the simulation column is still noisy. Let it run or fast-forward.`);
  $('#theory-notes').innerHTML = notes.map((n) => `<li>${n}</li>`).join('');

  charts.update(sim, s, th);
}

// --- main loop -------------------------------------------------------------------
function fmtClock(min) {
  const total = Math.floor(min);
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  return d > 0 ? `${d}d ${h}:${String(m).padStart(2, '0')}` : `${h}:${String(m).padStart(2, '0')}`;
}

function frame(ts) {
  try {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (running) sim.advanceTo(sim.clock + dt * speed);

    renderer.draw(sim.snapshot(), cfg);
    $('#clock-time').textContent = fmtClock(sim.clock);
    const state = $('#clock-state');
    if (sim.clock < cfg.warmup) { state.textContent = 'warming up'; state.className = 'pill'; }
    else if (running) { state.textContent = 'measuring'; state.className = 'pill live'; }
    else { state.textContent = 'paused'; state.className = 'pill paused'; }
    if (running) updatePanels();
  } catch (err) {
    console.error(err);   // one bad frame must not stop the animation loop
  }
  requestAnimationFrame(frame);
}

// --- boot ---------------------------------------------------------------------------
writeForm(cfg);
updatePanels(true);
requestAnimationFrame(frame);
toggleRun(true);

// Console access for the curious: `queuelab.sim.summary()` in the devtools console.
window.queuelab = { get sim() { return sim; }, get cfg() { return cfg; }, get theory() { return theory; } };
