// How much does a bye-week collision ACTUALLY cost, and is it worth biasing a pick?
import fs from 'node:fs'; import path from 'node:path';
import { optimizeLineup } from '../src/season.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const board = JSON.parse(fs.readFileSync(boardPath(loadConfig(process.env.LEAGUE).id), 'utf8'));
const byId = new Map(board.players.map(p=>[p.id,p]));
const draft = JSON.parse(fs.readFileSync(path.join(root,'data/drafts/byetest.json'),'utf8'));
const mine = draft.picks.filter(p=>p.team===draft.mySlot).map(p=>byId.get(p.playerId)).filter(Boolean);

console.log('roster byes:', mine.map(p=>`${p.name.split(' ').slice(-1)[0]}:${p.bye??'?'}`).join(' '));
const weeks=[]; 
for (let w=1;w<=14;w++){ const o=optimizeLineup(mine,w,cfg); weeks.push({w,total:o.total,out:mine.filter(p=>p.bye===w).length}); }
const clean = weeks.filter(x=>x.out===0);
const avgClean = clean.reduce((a,b)=>a+b.total,0)/clean.length;
console.log('\nweek  starters-on-bye  lineup   vs a clean week');
for (const x of weeks) {
  const d = x.total-avgClean;
  console.log(`  ${String(x.w).padStart(2)}   ${String(x.out).padStart(6)}          ${x.total.toFixed(0).padStart(6)}   ${d>=0?'+':''}${d.toFixed(0)}`);
}
const worst = weeks.reduce((a,b)=>a.total<b.total?a:b);
console.log(`\nclean-week average: ${avgClean.toFixed(0)}`);
console.log(`worst week: W${worst.w} with ${worst.out} on bye -> ${worst.total.toFixed(0)} (${(worst.total-avgClean).toFixed(0)})`);
// what does a point of weekly lineup actually buy? league scoring spread across teams
console.log(`\nA typical weekly lineup here is ~${avgClean.toFixed(0)} points.`);
console.log(`So the worst bye week costs ${Math.abs(((worst.total-avgClean)/avgClean*100)).toFixed(0)}% of a normal week's output.`);
