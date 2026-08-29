// Generates the draft-day cheat sheet data: tiers by position + value/avoid lists.
import fs from 'node:fs'; import path from 'node:path';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const LEAGUE = loadConfig(process.env.LEAGUE).id;
const board = JSON.parse(fs.readFileSync(path.join(root, 'data/cache', `board-${LEAGUE}.json`), 'utf8'));
const P = board.players;

const out = { replacement: board.replacement, positions: {}, values: [], avoid: [], overall: [] };
const IDP = ['LB','DE','DT','CB','S'];

for (const pos of ['QB','RB','WR','TE','LB','DST','K']) {
  const arr = P.filter(p => p.pos === pos).sort((a,b)=>b.pts-a.pts).slice(0, pos==='QB'?18:pos==='LB'?16:pos==='TE'?16:pos==='K'||pos==='DST'?14:44);
  const tiers = {};
  for (const p of arr) (tiers[p.tier] ||= []).push({
    name: p.name, team: p.team, pts: p.pts, vorp: p.vorp,
    adp: p.adp ? Math.round(p.adp) : null, inj: p.injury && p.injury!=='QUESTIONABLE' ? p.injury : null,
  });
  out.positions[pos] = tiers;
}
const ranked = [...P].sort((a,b)=>b.vorp-a.vorp);
ranked.forEach((p,i)=>p._r=i+1);
out.overall = ranked.slice(0,60).map(p=>({rank:p._r,name:p.name,pos:p.pos,team:p.team,pts:p.pts,vorp:p.vorp,adp:p.adp?Math.round(p.adp):null,tier:p.tier}));
// ADP arbitrage. Skill positions ONLY: IDP ADP comes from deep-IDP leagues and is
// meaningless here, and K/DST rank high on VORP but must still be taken last (see STRATEGY.md).
const skill = ranked.filter(p=>p.adp && p._r<=170 && !IDP.includes(p.pos) && !['K','DST'].includes(p.pos));
// Cap per position. Under this scoring nearly every volume passer beats his standard-league ADP,
// so an uncapped list is 12 QBs deep - true, but you only need two of them.
const CAP={QB:4,RB:5,WR:5,TE:3};
const seen={};
out.values = skill.filter(p=>p.adp-p._r>=14).filter(p=>{
  seen[p.pos]=(seen[p.pos]||0)+1; return seen[p.pos]<=(CAP[p.pos]??3);
}).slice(0,14)
  .map(p=>({name:p.name,pos:p.pos,rank:p._r,adp:Math.round(p.adp),gap:Math.round(p.adp-p._r)}));
out.avoid  = skill.filter(p=>p._r-p.adp>=14).sort((a,b)=>(b._r-b.adp)-(a._r-a.adp)).slice(0,14)
  .map(p=>({name:p.name,pos:p.pos,rank:p._r,adp:Math.round(p.adp),gap:Math.round(p._r-p.adp)}));
fs.writeFileSync(path.join(root,'data/cache',`cheatsheet-${LEAGUE}.json`), JSON.stringify(out,null,1));
console.log('tiers per position:', Object.fromEntries(Object.entries(out.positions).map(([k,v])=>[k,Object.keys(v).length])));
console.log('values:', out.values.length, 'avoid:', out.avoid.length);
console.log('\nVALUES:'); out.values.forEach(v=>console.log(`  ${v.name.padEnd(24)} ${v.pos.padEnd(4)} rank ${String(v.rank).padStart(3)} vs ADP ${String(v.adp).padStart(3)}  (+${v.gap})`));
console.log('\nAVOID AT ADP:'); out.avoid.forEach(v=>console.log(`  ${v.name.padEnd(24)} ${v.pos.padEnd(4)} rank ${String(v.rank).padStart(3)} vs ADP ${String(v.adp).padStart(3)}  (-${v.gap})`));
