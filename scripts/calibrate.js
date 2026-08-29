// How much of ESPN's projected spread is REAL SIGNAL, by position?
//
// Measured honestly: ESPN's own 2025 PRESEASON projection (102025) vs 2025 actuals (002025).
// The naive statistic is sdRatio = sd(actual)/sd(projection), but that is misleading: a
// kicker's realized spread is enormous and almost entirely luck. The right statistic is the
// OLS slope of actual on projected, beta = r * sdRatio, which is the part of the spread ESPN
// actually predicts. beta > 1 means ESPN compresses a position and its VORP is understated.
import fs from 'node:fs'; import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';
import { scoreStats } from '../src/score.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/raw/espn-players-2026.json'), 'utf8'));

const rows = [];
for (const e of raw) {
  const p = e.player || e; if (!p.fullName) continue;
  const pos = POSITION_BY_ID[p.defaultPositionId]; if (!pos || pos === 'P') continue;
  const pj = (p.stats || []).find(s => s.seasonId === 2025 && s.statSourceId === 1 && !s.scoringPeriodId)?.stats;
  const ac = (p.stats || []).find(s => s.seasonId === 2025 && s.statSourceId === 0 && !s.scoringPeriodId)?.stats;
  if (!pj || !ac || !Object.keys(ac).length) continue;
  rows.push({ name: p.fullName, pos, proj: scoreStats(pj, pos, cfg), act: scoreStats(ac, pos, cfg), g: ac['210'] || 0 });
}

// Calibrate on the DRAFTABLE pool at each position, not the whole universe, or the
// long tail of never-played zeros dominates the fit.
const N = { QB: 24, RB: 48, WR: 60, TE: 24, LB: 36, DST: 32, K: 32 };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return n / Math.sqrt(dx * dy);
}

const out = {};
console.log('pos    n      r    sdRatio     beta       interpretation');
for (const [pos, n] of Object.entries(N)) {
  const g = rows.filter(r => r.pos === pos).sort((a, b) => b.proj - a.proj).slice(0, n);
  if (g.length < 10) { console.log(`${pos}  too few (${g.length})`); continue; }
  const P = g.map(r => r.proj), A = g.map(r => r.act);
  const r = pearson(P, A), sdr = sd(A) / sd(P), beta = r * sdr;
  out[pos] = Math.round(beta * 100) / 100;
  const note = beta > 1.25 ? 'ESPN UNDER-spreads -> expand'
    : beta < 0.85 ? 'ESPN OVER-spreads -> shrink' : 'about right';
  console.log(`${pos.padEnd(5)} ${String(g.length).padStart(3)} ${r.toFixed(2).padStart(6)} ${sdr.toFixed(2).padStart(9)} ${beta.toFixed(2).padStart(9)}    ${note}`);
}
console.log('\nbeta = OLS slope of ACTUAL on PROJECTED = the share of spread ESPN really predicts.');
console.log('Raw sdRatio alone would be wrong: a kicker\'s spread is huge but nearly all luck (low r).');
console.log('\ncalibration:', JSON.stringify(out));
