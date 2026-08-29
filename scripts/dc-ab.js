// Paired A/B: draftedCounts derived from 36 sim drafts vs derived from this league's real drafts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const CFG = configPath(loadConfig(process.env.LEAGUE).id);
const original = fs.readFileSync(CFG, 'utf8');
const A = { QB:24, RB:42, WR:54, TE:24, K:12, DST:12, IDP:24 };          // current (from sweep.js)
const B = { QB:20, RB:50, WR:63, TE:17, K:12, DST:14, IDP:16 };          // 2024+2025 actuals, =192
const run = () => {
  const rows = [];
  for (let slot = 1; slot <= 12; slot++) for (const seed of [7, 42, 99]) {
    const out = execFileSync('node', ['scripts/simulate.js', String(slot), String(seed)], { encoding: 'utf8' });
    const my = out.slice(out.indexOf('MY ROSTER'));
    const rows_ = [...my.matchAll(/R\s?\d+\s+(START|  ben)\s+(.+?)\s{2,}([A-Z]{1,4})\s/g)];
    const pos = {}; for (const r of rows_) pos[r[3]] = (pos[r[3]] || 0) + 1;
    rows.push({ total: Number(my.match(/lineup total: (\d+)/)?.[1] || 0),
                finish: Number(my.match(/(\d+)\. team\s+\d+\s+<-- ME/)?.[1] || 0), pos });
  }
  return rows;
};
// simulate.js reads board.replacement, which build-board.js bakes in from draftedCounts.
// Changing the config alone is a no-op - the board MUST be rebuilt between arms.
const withCounts = c => {
  const o = JSON.parse(original); Object.assign(o.roster.draftedCounts, c);
  fs.writeFileSync(CFG, JSON.stringify(o, null, 2));
  execFileSync('node', ['scripts/build-board.js'], { encoding: 'utf8' });
  const b = JSON.parse(fs.readFileSync(boardPath(loadConfig(process.env.LEAGUE).id), 'utf8'));
  console.log('  repl:', JSON.stringify(Object.fromEntries(['QB','RB','WR','TE'].map(k => [k, Math.round(b.replacement[k])]))));
  return run();
};
try {
  const a = withCounts(A), b = withCounts(B);
  let aw=0, bw=0, tie=0, sum=0;
  for (let i=0;i<a.length;i++){ const d=b[i].total-a[i].total; sum+=d; if(d>0)bw++; else if(d<0)aw++; else tie++; }
  const n=a.length;
  console.log(`  sim-derived wins ${aw} | real-derived wins ${bw} | tie ${tie}`);
  console.log(`  mean delta (real minus sim): ${(sum/n).toFixed(2)} pts over ${n} paired drafts`);
  console.log(`  1st: sim ${a.filter(r=>r.finish===1).length}/${n} | real ${b.filter(r=>r.finish===1).length}/${n}`);
  const avg=(rows,k)=>(rows.reduce((s,r)=>s+(r.pos[k]||0),0)/rows.length).toFixed(1);
  console.log('  roster shape  sim -> real:');
  for (const k of ['QB','RB','WR','TE','LB']) console.log(`    ${k.padEnd(4)} ${avg(a,k)} -> ${avg(b,k)}`);
} finally { fs.writeFileSync(CFG, original); console.log('  config restored'); }
