// Does the bye penalty actually reduce collisions across full drafts, and at what cost?
import fs from 'node:fs'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname,'..');
const cfgPath = configPath(loadConfig(process.env.LEAGUE).id);
const orig = fs.readFileSync(cfgPath,'utf8');
const board = JSON.parse(fs.readFileSync(boardPath(loadConfig(process.env.LEAGUE).id), 'utf8'));
const byName = new Map(board.players.map(p=>[p.name,p]));

function run(enabled){
  const c = JSON.parse(orig); c.draftRules.byeWeights.enabled = enabled;
  fs.writeFileSync(cfgPath, JSON.stringify(c,null,2));
  const rows=[];
  for (const slot of [1,4,8,12]) for (const seed of [7,42,99]) {
    const out = execFileSync('node',[path.join(root,'scripts/simulate.js'),String(slot),String(seed)],{encoding:'utf8'});
    const my = out.slice(out.indexOf('MY ROSTER'));
    const names=[...my.matchAll(/R\s?\d+\s+(?:START|  ben)\s+(.+?)\s{2,}[A-Z]{1,4}\s/g)].map(m=>m[1]);
    const players=names.map(n=>byName.get(n)).filter(Boolean);
    const byes={}; for(const p of players) if(p.bye) byes[p.bye]=(byes[p.bye]||0)+1;
    const worst=Math.max(0,...Object.values(byes));
    const total=Number(my.match(/lineup total: (\d+)/)?.[1]||0);
    rows.push({slot,seed,worst,total,byes});
  }
  return rows;
}
const off = run(false), on = run(true);
fs.writeFileSync(cfgPath, orig);   // always restore
const avg = a => (a.reduce((x,y)=>x+y,0)/a.length);
console.log('                       penalty OFF   penalty ON');
console.log(`  worst bye-week count   ${avg(off.map(r=>r.worst)).toFixed(2).padStart(9)}   ${avg(on.map(r=>r.worst)).toFixed(2).padStart(9)}`);
console.log(`  max seen               ${Math.max(...off.map(r=>r.worst)).toString().padStart(9)}   ${Math.max(...on.map(r=>r.worst)).toString().padStart(9)}`);
console.log(`  projected lineup       ${avg(off.map(r=>r.total)).toFixed(0).padStart(9)}   ${avg(on.map(r=>r.total)).toFixed(0).padStart(9)}`);
const bad = a => a.filter(r=>r.worst>=5).length;
console.log(`  drafts with 5+ sharing ${String(bad(off)).padStart(9)}   ${String(bad(on)).padStart(9)}   (of ${off.length})`);
