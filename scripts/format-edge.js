import fs from 'node:fs'; import path from 'node:path';
import { POSITION_BY_ID, STAT } from '../src/statmap.js';
import { normalize } from '../src/espn.js';
import { scoreStats, scoreDstBrackets, replacementLevels } from '../src/score.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const raw = JSON.parse(fs.readFileSync(path.join(root,'data/raw/espn-players-2026.json'),'utf8'));
// standard ESPN PPR clone of the config for A/B comparison
const std = JSON.parse(JSON.stringify(cfg));
std.scoring.passing = {"3":0.04,"4":4,"20":-2,"19":2};
std.roster.starters = { QB:1, RB:2, WR:2, TE:1, FLEX:1, DST:1, K:1 };   // no DP in standard
const base = normalize(raw, 2026);
const build = (config) => {
  const ps = base.map(p => {
    let pts = scoreStats(p.proj, p.pos, config);
    if (p.pos === 'DST') pts += scoreDstBrackets(Object.values(p.weekly), config);
    return { id: p.id, name: p.name, pos: p.pos, pts, adp: p.adp };
  });
  const {levels}=replacementLevels(ps,config);
  for(const p of ps) p.vorp=p.pts-(levels[p.pos]??0);
  ps.sort((a,b)=>b.vorp-a.vorp); ps.forEach((p,i)=>p.rank=i+1);
  return {ps,levels};
};
const A=build(cfg), B=build(std);
const bmap=new Map(B.ps.map(p=>[p.id,p]));
console.log('QB replacement  custom:',Math.round(A.levels.QB),' standard:',Math.round(B.levels.QB));
console.log('QB1-QB12 spread custom:', (()=>{const q=A.ps.filter(p=>p.pos==='QB').sort((a,b)=>b.pts-a.pts);return Math.round(q[0].pts-q[11].pts)})(),
            ' standard:', (()=>{const q=B.ps.filter(p=>p.pos==='QB').sort((a,b)=>b.pts-a.pts);return Math.round(q[0].pts-q[11].pts)})());
console.log('\n===== FORMAT ARBITRAGE: biggest VORP-rank gains vs STANDARD PPR =====');
const drift=A.ps.filter(p=>p.rank<=220&&bmap.has(p.id)).map(p=>({...p,stdRank:bmap.get(p.id).rank,gain:bmap.get(p.id).rank-p.rank}));
drift.sort((a,b)=>b.gain-a.gain);
console.log('\n-- RISE in this format (draft these EARLIER than the room will) --');
drift.slice(0,18).forEach(p=>console.log(`  ${p.name.padEnd(24)} ${p.pos.padEnd(4)} thisLeagueRank ${String(p.rank).padStart(3)}  stdRank ${String(p.stdRank).padStart(3)}  (+${p.gain})  espnADP ${p.adp?p.adp.toFixed(0):'-'}`));
console.log('\n-- FALL in this format (let the room overpay) --');
drift.slice(-12).reverse().forEach(p=>console.log(`  ${p.name.padEnd(24)} ${p.pos.padEnd(4)} thisLeagueRank ${String(p.rank).padStart(3)}  stdRank ${String(p.stdRank).padStart(3)}  (${p.gain})  espnADP ${p.adp?p.adp.toFixed(0):'-'}`));
console.log('\n===== TOP 60 OVERALL, THIS LEAGUE (VORP) vs ESPN ADP =====');
A.ps.slice(0,60).forEach(p=>{const d=p.adp?p.adp-p.rank:null;
  console.log(`${String(p.rank).padStart(3)}. ${p.name.padEnd(24)} ${p.pos.padEnd(4)} vorp ${String(Math.round(p.vorp)).padStart(4)}  adp ${String(p.adp?p.adp.toFixed(0):'-').padStart(4)}${d!==null&&d>15?'   <<<< VALUE':d!==null&&d<-15?'   >>>> reach':''}`);});
