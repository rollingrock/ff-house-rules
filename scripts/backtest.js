// Settles projections-vs-actuals: how big is the QB edge REALLY in this format?
import fs from 'node:fs'; import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';
import { normalize } from '../src/espn.js';
import { scoreStats, replacementLevels } from '../src/score.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const raw = JSON.parse(fs.readFileSync(path.join(root,'data/raw/espn-players-2026.json'),'utf8'));
const std = JSON.parse(JSON.stringify(cfg));
std.scoring.passing = {"3":0.04,"4":4,"20":-2,"19":2};

const rows = [];
for (const e of raw) {
  const p = e.player || e;
  if (!p.fullName) continue;
  const pos = POSITION_BY_ID[p.defaultPositionId];
  if (!pos || pos === 'P') continue;
  const act25 = (p.stats||[]).find(s=>s.seasonId===2025 && s.statSourceId===0 && !s.scoringPeriodId)?.stats;
  const proj26 = (p.stats||[]).find(s=>s.seasonId===2026 && s.statSourceId===1 && !s.scoringPeriodId)?.stats;
  if (act25 && Object.keys(act25).length) rows.push({name:p.fullName,pos,src:'act25',
    cust:scoreStats(act25,pos,cfg), stdp:scoreStats(act25,pos,std), g:act25['210']||0});
  if (proj26) rows.push({name:p.fullName,pos,src:'proj26',
    cust:scoreStats(proj26,pos,cfg), stdp:scoreStats(proj26,pos,std), g:proj26['210']||0});
}
const spread = (src,pos,a,b,key) => {
  const arr = rows.filter(r=>r.src===src&&r.pos===pos).sort((x,y)=>y[key]-x[key]);
  return arr.length>b ? Math.round(arr[a-1][key]-arr[b-1][key]) : null;
};
console.log('                       CUSTOM (this league)      STANDARD PPR');
for (const [pos,a,b] of [['QB',1,12],['RB',1,24],['WR',1,24],['TE',1,12]]) {
  const l=`${pos}${a}-${pos}${b}`.padEnd(10);
  console.log(`  2025 ACTUAL   ${l} ${String(spread('act25',pos,a,b,'cust')).padStart(8)}          ${String(spread('act25',pos,a,b,'stdp')).padStart(8)}`);
  console.log(`  2026 PROJ     ${l} ${String(spread('proj26',pos,a,b,'cust')).padStart(8)}          ${String(spread('proj26',pos,a,b,'stdp')).padStart(8)}`);
}
console.log('\n--- 2025 ACTUAL top 12 QB in THIS scoring (games played matters) ---');
rows.filter(r=>r.src==='act25'&&r.pos==='QB').sort((a,b)=>b.cust-a.cust).slice(0,14)
  .forEach((r,i)=>console.log(`  ${String(i+1).padStart(2)}. ${r.name.padEnd(22)} ${Math.round(r.cust).toString().padStart(4)}  (${r.g} games, ${(r.cust/Math.max(1,r.g)).toFixed(1)}/gm)`));
console.log('\n--- same list on a PER-GAME basis (removes injury/availability noise) ---');
rows.filter(r=>r.src==='act25'&&r.pos==='QB'&&r.g>=8).sort((a,b)=>b.cust/b.g-a.cust/a.g).slice(0,14)
  .forEach((r,i)=>console.log(`  ${String(i+1).padStart(2)}. ${r.name.padEnd(22)} ${(r.cust/r.g).toFixed(1)}/gm  (${r.g} g)`));
const pg=(pos,a,b)=>{const arr=rows.filter(r=>r.src==='act25'&&r.pos===pos&&r.g>=8).sort((x,y)=>y.cust/y.g-x.cust/x.g);
  return arr.length>b?((arr[a-1].cust/arr[a-1].g)-(arr[b-1].cust/arr[b-1].g)).toFixed(1):null;};
console.log('\n2025 PER-GAME spread (custom scoring):  QB1-QB12', pg('QB',1,12), ' RB1-RB24', pg('RB',1,24), ' WR1-WR24', pg('WR',1,24));
