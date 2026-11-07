// Discrete-event simulation of a multi-server queue.
//
// Time unit: minutes. Arrivals are Poisson; service times come from the
// distribution named in the configuration. The engine is pure JavaScript
// with no DOM dependency, so the same code runs in the browser and in the
// Node test-suite.

import { Rng, sampleService, SERVICE_DISTRIBUTIONS } from './rng.js';

class Deque {
  constructor() { this.items = []; this.head = 0; }
  get length() { return this.items.length - this.head; }
  push(x) { this.items.push(x); }
  shift() {
    const x = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return x;
  }
  pop() { return this.items.pop(); }
  toArray() { return this.items.slice(this.head); }
  first(n) { return this.items.slice(this.head, this.head + n); }
  clear() { this.items = []; this.head = 0; }
}

class GrowableF64 {
  constructor(cap = 4096) { this.buf = new Float64Array(cap); this.n = 0; }
  push(v) {
    if (this.n === this.buf.length) {
      const nb = new Float64Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = v;
  }
  view() { return this.buf.subarray(0, this.n); }
}

export const DEFAULT_CONFIG = {
  arrivalsPerHour: 40,
  serviceMean: 4,          // minutes
  servers: 3,
  serviceDist: 'exponential',
  maxQueue: Infinity,      // waiting spots; Infinity = unlimited
  discipline: 'fifo',      // fifo | lifo | priority
  priorityShare: 0.2,      // fraction of arrivals that are high priority
  warmup: 60,              // minutes excluded from statistics
  waitThreshold: 5,        // minutes, for P(wait > threshold)
  targetWait: 2,           // minutes, staffing target
  seed: 42,
};

export function normaliseConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  // Any numeric field that fails to parse falls back to its default.
  const num = (key, lo, hi) => {
    const v = +cfg[key];
    const d = DEFAULT_CONFIG[key];
    return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : d));
  };
  cfg.arrivalsPerHour = num('arrivalsPerHour', 0.1, 100000);
  cfg.serviceMean = num('serviceMean', 0.05, 100000);
  cfg.servers = Math.round(num('servers', 1, 24));
  cfg.maxQueue = cfg.maxQueue === '' || cfg.maxQueue === null || cfg.maxQueue === undefined || cfg.maxQueue === 'Infinity'
    ? Infinity : (Number.isFinite(+cfg.maxQueue) && +cfg.maxQueue >= 0 ? Math.min(500, Math.round(+cfg.maxQueue)) : Infinity);
  cfg.priorityShare = num('priorityShare', 0.05, 0.95);
  cfg.warmup = num('warmup', 0, 100000);
  cfg.waitThreshold = num('waitThreshold', 0, 100000);
  cfg.targetWait = num('targetWait', 0.01, 100000);
  cfg.seed = (+cfg.seed >>> 0) || 1;
  if (!SERVICE_DISTRIBUTIONS[cfg.serviceDist]) cfg.serviceDist = 'exponential';
  if (!['fifo', 'lifo', 'priority'].includes(cfg.discipline)) cfg.discipline = 'fifo';
  cfg.serviceCv2 = SERVICE_DISTRIBUTIONS[cfg.serviceDist].cv2;
  return cfg;
}

export class Simulation {
  constructor(config) {
    this.cfg = normaliseConfig(config);
    this.reset();
  }

  reset() {
    const cfg = this.cfg;
    this.rng = new Rng(cfg.seed);
    this.lambda = cfg.arrivalsPerHour / 60;
    this.clock = 0;
    this.nextArrival = this.rng.exponential(1 / this.lambda);
    this.nextId = 1;

    this.queueHigh = new Deque();
    this.queueLow = new Deque();
    this.servers = Array.from({ length: cfg.servers }, (_, i) => ({
      index: i, busy: false, customer: null, start: 0, end: Infinity, busyTime: 0, served: 0, idleSince: 0,
    }));

    this.recentDepartures = [];   // for the animation layer

    // Statistics (post warm-up)
    this.stats = {
      arrived: 0, admitted: 0, blocked: 0, served: 0, waited: 0,
      overThreshold: 0, highServed: 0, lowServed: 0,
      sumWait: 0, sumSystem: 0, sumWaitHigh: 0, sumWaitLow: 0,
      areaQ: 0, areaBusy: 0, lastT: cfg.warmup, maxQueue: 0,
    };
    this.waits = new GrowableF64();
    this.customerLog = { arrival: new GrowableF64(), start: new GrowableF64(), depart: new GrowableF64(), cls: new GrowableF64(), server: new GrowableF64() };
    this.logLimit = 250000;

    // Time series of queue length, sampled on a fixed grid.
    this.sampleInterval = 0.5;
    this.nextSample = 0;
    this.series = { t: [], lq: [], busy: [] };
    this.seriesLimit = 1500;
  }

  get queueLength() { return this.queueHigh.length + this.queueLow.length; }
  get busyCount() { return this.servers.reduce((s, sv) => s + (sv.busy ? 1 : 0), 0); }
  get inSystem() { return this.queueLength + this.busyCount; }

  // --- time accounting -----------------------------------------------------

  _accrue(t) {
    const w = this.cfg.warmup;
    if (t <= w) return;
    const from = Math.max(this.stats.lastT, w);
    const dt = t - from;
    if (dt > 0) {
      this.stats.areaQ += this.queueLength * dt;
      this.stats.areaBusy += this.busyCount * dt;
      this.stats.lastT = t;
    }
  }

  _sampleSeries(t) {
    while (this.nextSample <= t) {
      this.series.t.push(this.nextSample);
      this.series.lq.push(this.queueLength);
      this.series.busy.push(this.busyCount);
      this.nextSample += this.sampleInterval;
      if (this.series.t.length > this.seriesLimit) {
        // Halve resolution: keep every other point.
        for (const k of ['t', 'lq', 'busy']) this.series[k] = this.series[k].filter((_, i) => i % 2 === 0);
        this.sampleInterval *= 2;
      }
    }
  }

  // --- events --------------------------------------------------------------

  _nextEventTime() {
    let t = this.nextArrival;
    for (const sv of this.servers) if (sv.busy && sv.end < t) t = sv.end;
    return t;
  }

  _dequeue() {
    const d = this.cfg.discipline;
    if (d === 'priority') {
      if (this.queueHigh.length) return this.queueHigh.shift();
      return this.queueLow.length ? this.queueLow.shift() : null;
    }
    if (d === 'lifo') return this.queueLow.length ? this.queueLow.pop() : null;
    return this.queueLow.length ? this.queueLow.shift() : null;
  }

  _startService(sv, cust, t) {
    const s = sampleService(this.rng, this.cfg.serviceDist, this.cfg.serviceMean);
    sv.busy = true; sv.customer = cust; sv.start = t; sv.end = t + s;
    cust.start = t; cust.server = sv.index;
  }

  _arrival(t) {
    const cfg = this.cfg;
    const counted = t > cfg.warmup;
    const cls = cfg.discipline === 'priority' && this.rng.uniform() < cfg.priorityShare ? 1 : 0;
    const cust = { id: this.nextId++, cls, arrival: t, start: null, depart: null, server: -1 };
    if (counted) this.stats.arrived++;

    // Longest-idle routing, as most call-centre and counter systems do it:
    // the server that has waited longest for work takes the next customer.
    let idle = null;
    for (const sv of this.servers) if (!sv.busy && (idle === null || sv.idleSince < idle.idleSince)) idle = sv;
    if (idle) {
      this._startService(idle, cust, t);
      if (counted) this.stats.admitted++;
    } else if (this.queueLength >= cfg.maxQueue) {
      if (counted) this.stats.blocked++;
      cust.blocked = true;
      this.recentDepartures.push({ ...cust, depart: t, blocked: true });
    } else {
      if (counted) this.stats.admitted++;
      (cls === 1 ? this.queueHigh : this.queueLow).push(cust);
      if (counted && this.queueLength > this.stats.maxQueue) this.stats.maxQueue = this.queueLength;
    }
    this.nextArrival = t + this.rng.exponential(1 / this.lambda);
  }

  _departure(sv, t) {
    const cust = sv.customer;
    cust.depart = t;
    const countedFrom = Math.max(sv.start, this.cfg.warmup);
    if (t > countedFrom) { sv.busyTime += t - countedFrom; if (cust.arrival > this.cfg.warmup) sv.served++; }
    this._record(cust);
    this.recentDepartures.push(cust);
    if (this.recentDepartures.length > 64) this.recentDepartures.splice(0, this.recentDepartures.length - 64);

    const next = this._dequeue();
    if (next) this._startService(sv, next, t);
    else { sv.busy = false; sv.customer = null; sv.end = Infinity; sv.idleSince = t; }
  }

  _record(cust) {
    if (cust.arrival <= this.cfg.warmup) return;
    const wait = cust.start - cust.arrival;
    const sys = cust.depart - cust.arrival;
    const s = this.stats;
    s.served++;
    s.sumWait += wait;
    s.sumSystem += sys;
    if (wait > 1e-12) s.waited++;
    if (wait > this.cfg.waitThreshold) s.overThreshold++;
    if (cust.cls === 1) { s.highServed++; s.sumWaitHigh += wait; } else { s.lowServed++; s.sumWaitLow += wait; }
    this.waits.push(wait);
    if (this.customerLog.arrival.n < this.logLimit) {
      const L = this.customerLog;
      L.arrival.push(cust.arrival); L.start.push(cust.start); L.depart.push(cust.depart);
      L.cls.push(cust.cls); L.server.push(cust.server);
    }
  }

  step() {
    const t = this._nextEventTime();
    this._accrue(t);
    this._sampleSeries(t);
    this.clock = t;
    if (t === this.nextArrival) {
      this._arrival(t);
    } else {
      for (const sv of this.servers) if (sv.busy && sv.end === t) { this._departure(sv, t); break; }
    }
  }

  // Advance simulated time to `t`, processing every event on the way.
  advanceTo(t) {
    let guard = 0;
    while (this._nextEventTime() <= t) {
      this.step();
      if (++guard > 5e6) break;   // safety valve for pathological settings
    }
    this._accrue(t);
    this._sampleSeries(t);
    this.clock = t;
  }

  // Fast-forward until `n` more customers have been served.
  runCustomers(n) {
    const target = this.stats.served + n;
    let guard = 0;
    while (this.stats.served < target && guard++ < 2e7) this.step();
  }

  // --- reporting -----------------------------------------------------------

  // Batch-means 95% confidence half-width for the mean of `arr`.
  // Ten long batches cope better with the strong autocorrelation of waits
  // in a busy queue than many short ones would.
  static ciHalfWidth(arr, batches = 10) {
    const n = arr.length;
    if (n < batches * 20) return null;
    const b = Math.floor(n / batches);
    const means = [];
    for (let i = 0; i < batches; i++) {
      let s = 0;
      for (let j = i * b; j < (i + 1) * b; j++) s += arr[j];
      means.push(s / b);
    }
    const m = means.reduce((a, v) => a + v, 0) / batches;
    const v = means.reduce((a, v) => a + (v - m) ** 2, 0) / (batches - 1);
    return 2.262 * Math.sqrt(v / batches);   // t(0.975, 9)
  }

  // Sorted copy of the recorded waits, recomputed only when new waits arrived.
  _sortedWaits() {
    const n = this.waits.n;
    if (this._sortedN !== n) {
      this._sorted = n ? Float64Array.from(this.waits.view()).sort() : null;
      this._sortedN = n;
    }
    return this._sorted;
  }

  summary() {
    const s = this.stats;
    const T = Math.max(0, this.stats.lastT - this.cfg.warmup);
    const waits = this.waits.view();
    const sorted = this._sortedWaits();
    const q = (p) => (sorted ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
    return {
      clock: this.clock,
      observed: T,
      warmupDone: this.clock > this.cfg.warmup,
      arrived: s.arrived,
      served: s.served,
      blocked: s.blocked,
      blockedShare: s.arrived ? s.blocked / s.arrived : 0,
      Wq: s.served ? s.sumWait / s.served : null,
      WqCi: Simulation.ciHalfWidth(waits),
      W: s.served ? s.sumSystem / s.served : null,
      Lq: T > 0 ? s.areaQ / T : null,
      L: T > 0 ? (s.areaQ + s.areaBusy) / T : null,
      rho: T > 0 ? s.areaBusy / T / this.cfg.servers : null,
      pWait: s.served ? s.waited / s.served : null,
      pOver: s.served ? s.overThreshold / s.served : null,
      q95: q(0.95),
      maxQueue: s.maxQueue,
      WqHigh: s.highServed ? s.sumWaitHigh / s.highServed : null,
      WqLow: s.lowServed ? s.sumWaitLow / s.lowServed : null,
      perServer: this.servers.map((sv) => ({ index: sv.index, served: sv.served, utilisation: T > 0 ? sv.busyTime / T : 0 })),
    };
  }

  // Wait-time histogram with `bins` equal-width buckets up to the 99th percentile.
  // Wait-time histogram: `bins` equal-width buckets up to the 99th percentile,
  // plus one overflow bucket for everything above it.
  histogram(bins = 24) {
    const w = this.waits.view();
    if (!w.length) return { edges: [], counts: [], overflow: 0, zero: 0, total: 0, max: 0 };
    const sorted = this._sortedWaits();
    let max = sorted[Math.floor(0.99 * (sorted.length - 1))];
    if (max <= 1e-9) max = 1;   // all waits zero: keep the axis readable
    const width = max / bins;
    const counts = new Array(bins).fill(0);
    let zero = 0, overflow = 0;
    for (const v of w) {
      if (v <= 1e-12) { zero++; continue; }
      const i = Math.floor(v / width);
      if (i >= bins) overflow++; else counts[i]++;
    }
    const edges = Array.from({ length: bins + 1 }, (_, i) => i * width);
    return { edges, counts, overflow, zero, total: w.length, max };
  }

  // State for the animation layer. Only the first `limit` people in line are
  // listed; the full count travels separately so a runaway queue stays cheap.
  snapshot(limit = 40) {
    let order;
    if (this.cfg.discipline === 'priority') {
      order = this.queueHigh.first(limit);
      if (order.length < limit) order = order.concat(this.queueLow.first(limit - order.length));
    } else {
      order = this.queueLow.first(limit);
    }
    return {
      clock: this.clock,
      queue: order,
      queueLength: this.queueLength,
      servers: this.servers.map((sv) => ({ index: sv.index, busy: sv.busy, customer: sv.customer, start: sv.start, end: sv.end })),
      departures: this.recentDepartures,
      inWarmup: this.clock < this.cfg.warmup,
    };
  }

  customerCsv() {
    const L = this.customerLog;
    const n = L.arrival.n;
    const rows = ['customer,class,arrival_min,service_start_min,departure_min,wait_min,service_min,server'];
    for (let i = 0; i < n; i++) {
      const a = L.arrival.buf[i], st = L.start.buf[i], d = L.depart.buf[i];
      rows.push(`${i + 1},${L.cls.buf[i] === 1 ? 'high' : 'normal'},${a.toFixed(3)},${st.toFixed(3)},${d.toFixed(3)},${(st - a).toFixed(3)},${(d - st).toFixed(3)},${L.server.buf[i] + 1}`);
    }
    return rows.join('\n');
  }
}
