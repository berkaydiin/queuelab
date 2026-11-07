// Seeded pseudo-random number generator (mulberry32) plus the sampling
// routines the simulator needs. Seeding makes every run reproducible:
// the same seed and parameters give the same sequence of customers.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 12345) {
    this.seed = seed;
    this.next = mulberry32(seed);
  }

  uniform() {
    // Guard against exactly 0 so log() never sees it.
    let u = this.next();
    return u === 0 ? Number.MIN_VALUE : u;
  }

  exponential(mean) {
    return -Math.log(this.uniform()) * mean;
  }

  // Sum of k exponentials, each with mean/k. Coefficient of variation 1/sqrt(k).
  erlang(k, mean) {
    let s = 0;
    for (let i = 0; i < k; i++) s += this.exponential(mean / k);
    return s;
  }

  // Two-phase hyperexponential with balanced means, tuned to a target
  // squared coefficient of variation (cv2 > 1).
  hyperexponential(mean, cv2) {
    const p = 0.5 * (1 + Math.sqrt((cv2 - 1) / (cv2 + 1)));
    const m1 = mean / (2 * p);
    const m2 = mean / (2 * (1 - p));
    return this.uniform() < p ? this.exponential(m1) : this.exponential(m2);
  }
}

// Service-time distribution catalogue. Each entry knows its squared
// coefficient of variation, which the theory module needs for the
// M/G/c approximation.
export const SERVICE_DISTRIBUTIONS = {
  exponential: { label: 'Exponential', cv2: 1, kendall: 'M' },
  erlang2: { label: 'Erlang-2', cv2: 0.5, kendall: 'E2' },
  erlang4: { label: 'Erlang-4', cv2: 0.25, kendall: 'E4' },
  deterministic: { label: 'Deterministic', cv2: 0, kendall: 'D' },
  hyper: { label: 'Hyperexponential', cv2: 4, kendall: 'H2' },
};

export function sampleService(rng, kind, mean) {
  switch (kind) {
    case 'exponential': return rng.exponential(mean);
    case 'erlang2': return rng.erlang(2, mean);
    case 'erlang4': return rng.erlang(4, mean);
    case 'deterministic': return mean;
    case 'hyper': return rng.hyperexponential(mean, 4);
    default: throw new Error(`Unknown service distribution: ${kind}`);
  }
}
