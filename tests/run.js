// Test-suite: checks the analytical module against textbook values and the
// simulator against the analytical module. Run with `npm test`.

import { mmc, mmck, erlangC, mmcPriority, mgcApprox, serversForTarget, theoryFor, mmcWaitQuantile } from '../js/theory.js';
import { Simulation } from '../js/sim.js';

let failures = 0;
function check(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got.toFixed(4)}, expected ${want.toFixed(4)} (±${tol})`);
  if (!ok) failures++;
}

console.log('\n== Analytical module ==');
// M/M/1 with ρ = 0.8: Lq = ρ²/(1-ρ) = 3.2, Wq = Lq/λ = 4
check('M/M/1 Lq', mmc(0.8, 1, 1).Lq, 3.2, 1e-9);
check('M/M/1 Wq', mmc(0.8, 1, 1).Wq, 4.0, 1e-9);
// M/M/2 with a = 1.5: P0 = 1/7, C = 4.5/7, Lq = C·ρ/(1-ρ) = 1.92857
check('M/M/2 Erlang C', erlangC(1.5, 1, 2), 4.5 / 7, 1e-9);
check('M/M/2 Lq', mmc(1.5, 1, 2).Lq, 1.928571, 1e-5);
// M/M/1/K reduces to the classic finite-queue formula: with ρ = 0.5, K = 3,
// p_n = ρ^n (1-ρ)/(1-ρ^(K+1)) → p3 = 0.125·0.5/0.9375 = 0.066667
check('M/M/1/3 blocking', mmck(0.5, 1, 1, 3).blocked, 0.0666667, 1e-6);
// M/M/c/K with K → large should match M/M/c.
check('M/M/3/200 → M/M/3 Lq', mmck(2.4, 1, 3, 200).Lq, mmc(2.4, 1, 3).Lq, 1e-6);
// Priority: with a single class the formula collapses to the plain M/M/c wait.
const pr = mmcPriority(0.3, 0.5, 1, 1);
check('Priority high-class Wq (M/M/1, ρ1=0.3, ρ=0.8)', pr.high.Wq, (0.8 / 1) / (1 - 0.3), 1e-9);
check('Priority low-class Wq', pr.low.Wq, (0.8 / 1) / ((1 - 0.3) * (1 - 0.8)), 1e-9);
// Conservation: λ-weighted class waits equal the FIFO wait.
check('Priority conservation', (0.3 * pr.high.Wq + 0.5 * pr.low.Wq) / 0.8, mmc(0.8, 1, 1).Wq, 1e-9);
// M/D/1 exact: Wq = ρ/(2μ(1-ρ)); Allen-Cunneen is exact for c = 1.
check('M/D/1 via Allen-Cunneen', mgcApprox(0.8, 1, 1, 0).Wq, 0.8 / (2 * 1 * 0.2), 1e-9);
check('Staffing: servers for Wq ≤ 1 min at λ=2/min, 1/μ=1 min', serversForTarget(2, 1, 1), 3, 0);
check('M/M/1 wait 95th pct', mmcWaitQuantile(0.8, 1, 1, 0.95), -Math.log(0.05 / 0.8) / 0.2, 1e-9);

console.log('\n== Simulator vs theory (long runs) ==');
function simRun(cfg, customers) {
  const sim = new Simulation(cfg);
  sim.runCustomers(customers);
  return { sim, s: sim.summary(), th: theoryFor(sim.cfg) };
}

{
  const { s, th } = simRun({ arrivalsPerHour: 48, serviceMean: 3, servers: 3, warmup: 500, seed: 7 }, 400000);
  console.log(`   M/M/3 ρ=${th.rho.toFixed(2)}  sim Wq=${s.Wq.toFixed(3)} ±${s.WqCi.toFixed(3)}`);
  check('M/M/3 Wq', s.Wq, th.Wq, 3 * s.WqCi + 0.01);
  check('M/M/3 Lq', s.Lq, th.Lq, 0.05 * th.Lq + 0.02);
  check('M/M/3 utilisation', s.rho, th.rho, 0.01);
  check('M/M/3 P(wait)', s.pWait, th.pWait, 0.01);
  check('M/M/3 95th pct wait', s.q95, th.q95, 0.05 * th.q95 + 0.05);
}
{
  const { s, th } = simRun({ arrivalsPerHour: 60, serviceMean: 1, servers: 1, maxQueue: 4, warmup: 500, seed: 3 }, 400000);
  console.log(`   M/M/1/5 blocking sim=${s.blockedShare.toFixed(4)} theory=${th.blocked.toFixed(4)}`);
  check('M/M/1/5 blocked share', s.blockedShare, th.blocked, 0.005);
  check('M/M/1/5 Lq', s.Lq, th.Lq, 0.03);
  check('M/M/1/5 Wq', s.Wq, th.Wq, 0.03);
}
{
  const { s, th } = simRun({ arrivalsPerHour: 48, serviceMean: 1, servers: 1, serviceDist: 'deterministic', warmup: 500, seed: 11 }, 400000);
  console.log(`   M/D/1 sim Wq=${s.Wq.toFixed(3)} theory=${th.Wq.toFixed(3)}`);
  check('M/D/1 Wq (Allen-Cunneen exact for c=1)', s.Wq, th.Wq, 3 * (s.WqCi || 0.05) + 0.01);
}
{
  const { s, th } = simRun({ arrivalsPerHour: 48, serviceMean: 1, servers: 1, serviceDist: 'erlang4', warmup: 500, seed: 5 }, 400000);
  console.log(`   M/E4/1 sim Wq=${s.Wq.toFixed(3)} theory=${th.Wq.toFixed(3)}`);
  check('M/E4/1 Wq (Pollaczek-Khinchine exact for c=1)', s.Wq, th.Wq, 3 * (s.WqCi || 0.05) + 0.01);
}
{
  const { s, th } = simRun({ arrivalsPerHour: 48, serviceMean: 3, servers: 3, discipline: 'priority', priorityShare: 0.3, warmup: 500, seed: 9 }, 400000);
  console.log(`   Priority M/M/3  high sim=${s.WqHigh.toFixed(3)} th=${th.priority.high.Wq.toFixed(3)}  low sim=${s.WqLow.toFixed(3)} th=${th.priority.low.Wq.toFixed(3)}`);
  check('Priority high-class Wq', s.WqHigh, th.priority.high.Wq, 0.05 * th.priority.high.Wq + 0.02);
  check('Priority low-class Wq', s.WqLow, th.priority.low.Wq, 0.05 * th.priority.low.Wq + 0.02);
}
{
  // LIFO changes the wait distribution but not the mean (work conservation).
  const { s, th } = simRun({ arrivalsPerHour: 48, serviceMean: 3, servers: 3, discipline: 'lifo', warmup: 500, seed: 13 }, 400000);
  check('LIFO mean Wq equals FIFO theory', s.Wq, th.Wq, 3 * s.WqCi + 0.02);
}
{
  // Reproducibility: same seed, same result.
  const a = simRun({ seed: 99 }, 20000).s.Wq;
  const b = simRun({ seed: 99 }, 20000).s.Wq;
  check('Seeded runs are identical', a, b, 0);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
