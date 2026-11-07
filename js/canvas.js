// Animation layer: draws the live state of the simulation on a canvas.
// Positions are tweened between frames so customers glide instead of jumping.

const W = 1200;
const H = 340;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = new Map();     // id -> { x, y, alpha, mode }
    this.exiting = new Map();     // id -> { x, y, alpha, vx, mode, t0 }
    this.seenDepartures = new Set();
    this.lastFrame = performance.now();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.refreshColors();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshColors());
  }

  refreshColors() {
    this.colors = {
      ink: cssVar('--ink'), ink2: cssVar('--ink-2'), rule: cssVar('--rule'), rule2: cssVar('--rule-2'),
      wait: cssVar('--wait'), serve: cssVar('--serve'), serveSoft: cssVar('--serve-soft'),
      panel: cssVar('--panel'), panel2: cssVar('--panel-2'), turned: cssVar('--turned'), done: cssVar('--done'),
    };
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(640, this.canvas.parentElement.clientWidth - 32);   // stage padding; scrolls sideways on phones
    const cssH = cssW * (H / W);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Forget every sprite. Pass the current snapshot so customers who already
  // left are not replayed as a burst of exit animations.
  reset(snapshot) {
    this.sprites.clear();
    this.exiting.clear();
    this.seenDepartures = new Set(snapshot ? snapshot.departures.map((d) => d.id) : []);
    this.snapNext = true;   // place everyone directly on the next frame instead of gliding in
  }

  // Geometry for c servers: returns array of {x, y, w, h}.
  serverBoxes(c) {
    const cols = c <= 6 ? 1 : c <= 12 ? 2 : c <= 18 ? 3 : 4;
    const rows = Math.ceil(c / cols);
    const areaX = 820, areaW = 340, areaY = 30, areaH = H - 60;
    const gapY = 10, gapX = 14;
    const h = Math.min(54, (areaH - gapY * (rows - 1)) / rows);
    const w = Math.min(150, (areaW - gapX * (cols - 1)) / cols);
    const totalH = rows * h + (rows - 1) * gapY;
    const y0 = areaY + (areaH - totalH) / 2;
    const totalW = cols * w + (cols - 1) * gapX;
    const x0 = areaX + (areaW - totalW) / 2;
    const boxes = [];
    for (let i = 0; i < c; i++) {
      const col = Math.floor(i / rows), row = i % rows;
      boxes.push({ x: x0 + col * (w + gapX), y: y0 + row * (h + gapY), w, h });
    }
    return boxes;
  }

  draw(snapshot, cfg) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const k = this.reducedMotion || this.snapNext ? 1 : 1 - Math.exp(-dt * 11);
    this.snapNext = false;
    const ctx = this.ctx;
    const C = this.colors;
    ctx.clearRect(0, 0, W, H);

    const laneY = H / 2;
    const laneX0 = 130, laneX1 = 780;
    const slot = 26;
    const visible = Math.floor((laneX1 - laneX0) / slot);
    const boxes = this.serverBoxes(cfg.servers);

    // --- static scenery -----------------------------------------------------
    ctx.save();
    ctx.font = '500 13px "Bricolage Grotesque", system-ui, sans-serif';
    ctx.fillStyle = C.ink2;
    ctx.textBaseline = 'alphabetic';
    // entrance
    ctx.strokeStyle = C.rule; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(72, laneY - 60); ctx.lineTo(72, laneY + 60); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText('arrivals', 72, laneY + 84);
    // lane
    ctx.setLineDash([3, 7]); ctx.strokeStyle = C.rule; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(laneX0 - 20, laneY + 16); ctx.lineTo(laneX1 + 10, laneY + 16); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    const waiting = snapshot.queueLength;
    ctx.fillStyle = waiting ? C.ink : C.ink2;
    ctx.font = '600 14px "Bricolage Grotesque", system-ui, sans-serif';
    ctx.fillText(`${waiting} waiting${waiting > visible ? ` (${visible} shown)` : ''}`, laneX0 - 20, laneY - 44);
    if (Number.isFinite(cfg.maxQueue)) {
      ctx.font = '500 13px "Bricolage Grotesque", system-ui, sans-serif';
      ctx.fillStyle = C.ink2;
      ctx.fillText(`room for ${cfg.maxQueue}`, laneX0 - 20, laneY + 40);
    }
    // servers
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i], sv = snapshot.servers[i];
      ctx.beginPath(); roundRect(ctx, b.x, b.y, b.w, b.h, 6);
      ctx.fillStyle = C.panel2; ctx.fill();
      if (sv.busy) {
        const frac = Math.max(0, Math.min(1, (snapshot.clock - sv.start) / Math.max(1e-9, sv.end - sv.start)));
        ctx.save(); ctx.clip();
        ctx.fillStyle = C.serveSoft; ctx.fillRect(b.x, b.y, b.w * frac, b.h);
        ctx.restore();
        ctx.setLineDash([]); ctx.strokeStyle = C.serve;
      } else {
        ctx.setLineDash([4, 4]); ctx.strokeStyle = C.rule;
      }
      ctx.lineWidth = 1.5; ctx.beginPath(); roundRect(ctx, b.x, b.y, b.w, b.h, 6); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.ink2; ctx.textAlign = 'left';
      ctx.font = '500 12px "Bricolage Grotesque", system-ui, sans-serif';
      if (b.h >= 26) ctx.fillText(`S${i + 1}`, b.x + 8, b.y + 15);
    }
    ctx.restore();

    // --- customers ------------------------------------------------------------
    const alive = new Set();
    const place = (cust, tx, ty, mode) => {
      alive.add(cust.id);
      let s = this.sprites.get(cust.id);
      if (!s) { s = { x: 40, y: laneY, alpha: 0, mode, cls: cust.cls }; this.sprites.set(cust.id, s); }
      s.x += (tx - s.x) * k; s.y += (ty - s.y) * k; s.alpha += (1 - s.alpha) * k; s.mode = mode;
    };
    snapshot.queue.forEach((cust, i) => {
      if (i < visible) place(cust, laneX0 + i * slot, laneY, 'wait');
    });
    snapshot.servers.forEach((sv, i) => {
      if (sv.busy && sv.customer) {
        const b = boxes[i];
        place(sv.customer, b.x + b.w / 2 + 12, b.y + b.h / 2, 'serve');
      }
    });

    // Departures: start an exit animation once per customer.
    for (const d of snapshot.departures) {
      if (this.seenDepartures.has(d.id)) continue;
      this.seenDepartures.add(d.id);
      const sp = this.sprites.get(d.id);
      if (d.blocked) {
        this.exiting.set(d.id, { x: laneX0 - 30, y: laneY - 10, alpha: 1, vx: -140, vy: -40, mode: 'turned', cls: d.cls });
      } else if (sp) {
        this.exiting.set(d.id, { x: sp.x, y: sp.y, alpha: 1, vx: 260, vy: 0, mode: 'done', cls: d.cls });
      }
    }
    if (this.seenDepartures.size > 4000) {
      const keep = new Set(snapshot.departures.map((d) => d.id));
      this.seenDepartures = keep;
    }
    for (const id of [...this.sprites.keys()]) if (!alive.has(id)) this.sprites.delete(id);

    const drawCustomer = (s, alpha) => {
      if (s.mode === 'hidden') return;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
      if (s.mode === 'turned') {
        ctx.lineWidth = 2; ctx.strokeStyle = C.turned; ctx.stroke();
      } else {
        ctx.fillStyle = s.mode === 'serve' ? C.serve : s.mode === 'done' ? C.done : C.wait;
        ctx.fill();
      }
      if (s.cls === 1 && s.mode !== 'turned') {
        ctx.lineWidth = 2; ctx.strokeStyle = s.mode === 'serve' ? C.serve : C.wait;
        ctx.beginPath(); ctx.arc(s.x, s.y, 13, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    for (const s of this.sprites.values()) drawCustomer(s, s.alpha);
    for (const [id, e] of this.exiting) {
      e.x += e.vx * dt; e.y += (e.vy || 0) * dt; e.alpha -= dt * 1.8;
      if (e.alpha <= 0 || e.x > W + 20 || e.x < -20) { this.exiting.delete(id); continue; }
      drawCustomer(e, e.alpha);
    }

    // Warm-up veil
    if (snapshot.inWarmup) {
      ctx.save();
      ctx.font = '500 13px "Bricolage Grotesque", system-ui, sans-serif';
      ctx.fillStyle = C.ink2; ctx.textAlign = 'right';
      ctx.fillText('warm-up: nothing counted yet', W - 16, 22);
      ctx.restore();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
