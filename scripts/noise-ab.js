// Paired A/B on tuning.noiseRegression. Board MUST be rebuilt between arms (repl is baked in).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const CFG = configPath(loadConfig(process.env.LEAGUE).id);
const original = fs.readFileSync(CFG, 'utf8');
const A = Number(process.argv[2] ?? 0), B = Number(process.argv[3] ?? 0.7);
const run = () => {
  const rows = [];
  for (let slot = 1; slot <= 12; slot++) for (const seed of [7, 42, 99]) {
    const out = execFileSync('node', ['scripts/simulate.js', String(slot), String(seed)], { encoding: 'utf8' });
    const my = out.slice(out.indexOf('MY ROSTER'));
    const cells = [...my.matchAll(/R\s?(\d+)\s+(START|  ben)\s+(.+?)\s{2,}([A-Z]{1,4})\s/g)];
    const firstRound = {};
    for (const c of cells) firstRound[c[4]] ??= Number(c[1]);
    rows.push({
      finish: Number(my.match(/(\d+)\. team\s+\d+\s+<-- ME/)?.[1] || 0),
      kRd: firstRound.K ?? 99, dRd: firstRound.DST ?? 99,
      // value of the roster EXCLUDING k/dst, scored on raw (unregressed) points
      cells,
    });
  }
  return rows;
};
const withK = v => {
  const c = JSON.parse(original); c.tuning.noiseRegression = v;
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
  execFileSync('node', ['scripts/build-board.js'], { encoding: 'utf8' });
  return run();
};
// Score both arms on the SAME yardstick: raw (unregressed) projections for skill players only.
const rawBoard = () => {
  const c = JSON.parse(original); c.tuning.noiseRegression = 0;
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
  execFileSync('node', ['scripts/build-board.js'], { encoding: 'utf8' });
  const b = JSON.parse(fs.readFileSync(boardPath(loadConfig(process.env.LEAGUE).id), 'utf8'));
  return new Map(b.players.map(p => [p.name, p]));
};
try {
  const a = withK(A), b = withK(B);
  const raw = rawBoard();
  const skill = rows => rows.map(r => {
    const seen = new Set(); let tot = 0;
    const take = pred => { const c = r.cells.filter(x => !seen.has(x[3] + x[2]) && pred(x[4]))
      .map(x => ({ k: x[3] + x[2], p: raw.get(x[3].trim()) })).filter(x => x.p)
      .sort((m, n) => n.p.pts - m.p.pts)[0];
      if (c) { seen.add(c.k); tot += c.p.pts; } };
    take(p => p === 'QB'); take(p => p === 'RB'); take(p => p === 'RB');
    take(p => p === 'WR'); take(p => p === 'WR'); take(p => p === 'TE');
    take(p => ['RB','WR','TE'].includes(p));
    return tot;
  });
  const sa = skill(a), sb = skill(b);
  const avg = x => (x.reduce((s, v) => s + v, 0) / x.length).toFixed(0);
  console.log(`  noiseRegression ${A} vs ${B}`);
  console.log(`  first round K taken : ${(a.reduce((s,r)=>s+r.kRd,0)/a.length).toFixed(1)}  ->  ${(b.reduce((s,r)=>s+r.kRd,0)/b.length).toFixed(1)}`);
  console.log(`  first round DST taken: ${(a.reduce((s,r)=>s+r.dRd,0)/a.length).toFixed(1)}  ->  ${(b.reduce((s,r)=>s+r.dRd,0)/b.length).toFixed(1)}`);
  console.log(`  SKILL-ONLY starters (raw pts, same yardstick): ${avg(sa)}  ->  ${avg(sb)}   delta ${(avg(sb)-avg(sa)).toFixed(0)}`);
  let w=0,l=0,t=0; for(let i=0;i<sa.length;i++){ if(sb[i]>sa[i])w++; else if(sb[i]<sa[i])l++; else t++; }
  console.log(`  regression wins ${w} | loses ${l} | tie ${t}  (n=${sa.length})`);
} finally {
  fs.writeFileSync(CFG, original);
  execFileSync('node', ['scripts/build-board.js'], { encoding: 'utf8' });
  console.log('  config + board restored');
}
