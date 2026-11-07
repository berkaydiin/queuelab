// Analytical queueing results. All rates are per minute, times in minutes.
//
//   lambda  arrival rate
//   mu      service rate (1 / mean service time)
//   c       number of parallel servers
//   K       total system capacity (servers + waiting spots); Infinity if unlimited
//
// Formulas follow Gross & Harris, "Fundamentals of Queueing Theory".

function logFactorial(n) {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

// Erlang C: probability an arriving customer has to wait (M/M/c, infinite room).
export function erlangC(lambda, mu, c) {
  const a = lambda / mu;        // offered load in Erlangs
  const rho = a / c;
  if (rho >= 1) return 1;
  let sum = 0;
  for (let n = 0; n < c; n++) sum += Math.exp(n * Math.log(a) - logFactorial(n));
  const last = Math.exp(c * Math.log(a) - logFactorial(c)) / (1 - rho);
  return last / (sum + last);
}

// M/M/c with unlimited waiting room.
export function mmc(lambda, mu, c) {
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) {
    return { stable: false, rho, a, C: 1, Lq: Infinity, Wq: Infinity, L: Infinity, W: Infinity, pWait: 1, blocked: 0 };
  }
  const C = erlangC(lambda, mu, c);
  const Lq = (C * rho) / (1 - rho);
  const Wq = Lq / lambda;
  const W = Wq + 1 / mu;
  const L = lambda * W;
  return { stable: true, rho, a, C, Lq, Wq, L, W, pWait: C, blocked: 0, lambdaEff: lambda };
}

// P(Wq > t) for M/M/c: C * exp(-(c*mu - lambda) t)
export function mmcWaitTail(lambda, mu, c, t) {
  const C = erlangC(lambda, mu, c);
  return C * Math.exp(-(c * mu - lambda) * t);
}

// Quantile of the waiting-time distribution for M/M/c (0 if the mass at zero covers it).
export function mmcWaitQuantile(lambda, mu, c, q) {
  const C = erlangC(lambda, mu, c);
  if (q <= 1 - C) return 0;
  return -Math.log((1 - q) / C) / (c * mu - lambda);
}

// M/M/c/K: finite capacity, arrivals finding K in system are turned away.
export function mmck(lambda, mu, c, K) {
  const a = lambda / mu;
  const rho = a / c;
  // Unnormalised state probabilities p_n for n = 0..K (log-space for stability).
  const logp = new Array(K + 1);
  for (let n = 0; n <= K; n++) {
    if (n <= c) {
      logp[n] = n * Math.log(a) - logFactorial(n);
    } else {
      logp[n] = c * Math.log(a) - logFactorial(c) + (n - c) * Math.log(rho);
    }
  }
  let m = -Infinity;
  for (const v of logp) if (v > m) m = v;
  let Z = 0;
  for (let n = 0; n <= K; n++) Z += Math.exp(logp[n] - m);
  const p = logp.map((v) => Math.exp(v - m) / Z);

  const blocked = p[K];
  const lambdaEff = lambda * (1 - blocked);
  let Lq = 0;
  for (let n = c + 1; n <= K; n++) Lq += (n - c) * p[n];
  let busy = 0;
  for (let n = 0; n <= K; n++) busy += Math.min(n, c) * p[n];
  const L = Lq + busy;
  const Wq = lambdaEff > 0 ? Lq / lambdaEff : 0;
  const W = lambdaEff > 0 ? L / lambdaEff : 0;
  let pWait = 0;
  for (let n = c; n < K; n++) pWait += p[n];   // arrivals that are admitted but must wait
  pWait = blocked < 1 ? pWait / (1 - blocked) : 0;
  return { stable: true, rho: busy / c, a, Lq, Wq, L, W, pWait, blocked, lambdaEff, p };
}

// Allen-Cunneen approximation for M/G/c: scale the M/M/c queue wait by the
// variability of service (Poisson arrivals so CV_a^2 = 1).
export function mgcApprox(lambda, mu, c, cv2) {
  const base = mmc(lambda, mu, c);
  if (!base.stable) return base;
  const factor = (1 + cv2) / 2;
  const Wq = base.Wq * factor;
  const Lq = lambda * Wq;
  const W = Wq + 1 / mu;
  return { ...base, Wq, Lq, W, L: lambda * W, approximate: true };
}

// Non-preemptive priority, two classes, identical exponential service (Cobham's
// formula for M/M/c). lambdaHigh gets served first; lambdaLow waits behind.
export function mmcPriority(lambdaHigh, lambdaLow, mu, c) {
  const lambda = lambdaHigh + lambdaLow;
  const base = mmc(lambda, mu, c);
  if (!base.stable) return null;
  const W0 = base.C / (c * mu);
  const s1 = lambdaHigh / (c * mu);
  const s2 = lambda / (c * mu);
  const WqHigh = W0 / (1 - s1);
  const WqLow = W0 / ((1 - s1) * (1 - s2));
  return { ...base, high: { Wq: WqHigh, W: WqHigh + 1 / mu }, low: { Wq: WqLow, W: WqLow + 1 / mu } };
}

// Smallest number of servers for which the (M/M/c) mean queue wait stays under target.
export function serversForTarget(lambda, mu, targetWq, maxC = 200) {
  for (let c = 1; c <= maxC; c++) {
    const r = mmc(lambda, mu, c);
    if (r.stable && r.Wq <= targetWq) return c;
  }
  return null;
}

// One entry point the UI calls: picks the right model for a configuration and
// returns a uniform result object (null fields when theory is unavailable).
export function theoryFor(cfg) {
  const lambda = cfg.arrivalsPerHour / 60;
  const mu = 1 / cfg.serviceMean;
  const c = cfg.servers;
  const cv2 = cfg.serviceCv2;
  const finite = Number.isFinite(cfg.maxQueue);
  const K = finite ? c + cfg.maxQueue : Infinity;

  let model;
  let r;
  let notes = [];

  if (finite) {
    if (cv2 === 1) {
      r = mmck(lambda, mu, c, K);
      model = `M/M/${c}/${K}`;
    } else {
      // No closed form for M/G/c/K; report the M/M/c/K numbers and say so.
      r = mmck(lambda, mu, c, K);
      model = `M/M/${c}/${K}`;
      notes.push('No closed form exists for a finite room with non-exponential service, so the exponential-service model is shown for reference.');
      r = { ...r, approximate: true };
    }
  } else if (cv2 === 1) {
    r = mmc(lambda, mu, c);
    model = `M/M/${c}`;
  } else {
    r = mgcApprox(lambda, mu, c, cv2);
    model = `M/G/${c} (Allen-Cunneen)`;
    notes.push('Non-exponential service: queue waits use the Allen-Cunneen approximation, scaling the M/M/c result by (1 + CV²)/2.');
  }

  // The wait distribution (tail, percentile) is only known for FIFO M/M/c.
  let q95 = null;
  let pWaitOver = null;
  if (!finite && cv2 === 1 && r.stable && cfg.discipline === 'fifo') {
    q95 = mmcWaitQuantile(lambda, mu, c, 0.95);
    pWaitOver = mmcWaitTail(lambda, mu, c, cfg.waitThreshold);
  } else if (!finite && cv2 === 1 && r.stable) {
    notes.push('The wait distribution (percentile, share over the threshold) is only known analytically for first-come-first-served; the mean wait is the same under every work-conserving discipline.');
  }
  // Allen-Cunneen only scales the mean; the probability of waiting is not covered.
  let pWait = r.pWait;
  if (!finite && cv2 !== 1) pWait = null;

  let priority = null;
  if (cfg.discipline === 'priority' && !finite && cv2 === 1) {
    const lh = lambda * cfg.priorityShare;
    priority = mmcPriority(lh, lambda - lh, mu, c);
  } else if (cfg.discipline === 'priority') {
    notes.push('Per-class waits are only available analytically for M/M/c with unlimited room; the overall figures still apply.');
  }

  // Rough time for the queue to forget its empty start: 1 / (cμ (1-√ρ)²).
  let settleTime = null;
  if (r.stable && !finite) {
    settleTime = 1 / (c * mu * Math.pow(1 - Math.sqrt(r.rho), 2));
    if (cfg.warmup < 2 * settleTime) {
      const suggest = Math.min(100000, Math.ceil((3 * settleTime) / 60) * 60);
      notes.push(`At ρ = ${r.rho.toFixed(2)} the queue needs roughly ${Math.round(settleTime)} min to forget that it started empty, but only ${cfg.warmup} min are excluded. Early averages will run low; a warm-up of about ${suggest} min would be safer.`);
    }
  }

  if (!r.stable) {
    notes.push(`Offered load ρ = ${(r.a / c).toFixed(2)} ≥ 1: the queue grows without bound, so long-run averages do not exist. Add servers or cut arrivals.`);
  }

  return {
    model,
    lambda,
    mu,
    c,
    rho: r.rho,                 // utilisation (equals offered load when the room is unlimited)
    offeredLoad: r.a / c,
    finite,
    stable: r.stable,
    Wq: r.Wq,
    W: r.W,
    Lq: r.Lq,
    L: r.L,
    pWait,
    blocked: r.blocked,
    q95,
    pWaitOver,
    approximate: !!r.approximate,
    priority,
    notes,
    requiredServers: serversForTarget(lambda, mu, cfg.targetWait),
    settleTime,
  };
}
