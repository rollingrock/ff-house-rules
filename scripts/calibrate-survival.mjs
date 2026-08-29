import fs from 'node:fs';
import { recommend } from '../src/recommend.js';
import { loadConfig, boardPath, draftPath } from '../src/league.js';
const cfg = loadConfig(process.env.LEAGUE);
const board = JSON.parse(fs.readFileSync(boardPath(cfg.id), 'utf8'));
const draft = JSON.parse(fs.readFileSync(draftPath(cfg.id), 'utf8'));
const repl = board.replacement;
const byId = new Map(board.players.map(p => [p.id, p]));
const picks = draft.picks.slice().sort((a, b) => a.pickNo - b.pickNo);
const MY = Number(process.env.SLOT || draft.mySlot || 1), T = cfg.teams;
const myPicks = []; for (let r = 1; r <= cfg.draft.rounds; r++) myPicks.push(r % 2 ? (r - 1) * T + MY : (r - 1) * T + (T - MY + 1));

const buckets = new Map();                       // predicted-decile -> {n, survived}
let rows = [];
for (let i = 0; i < myPicks.length - 1; i++) {
  const at = myPicks[i], next = myPicks[i + 1];
  const taken = new Set(picks.filter(p => p.pickNo < at).map(p => p.playerId));
  const available = board.players.filter(p => !taken.has(p.id));
  const myRoster = picks.filter(p => p.pickNo < at && p.team === MY).map(p => byId.get(p.playerId)).filter(Boolean);
  const { ranked } = recommend({
    available, myRoster, currentPick: at, nextPick: next, cfg, repl,
    recentPicks: picks.filter(p => p.pickNo < at).slice(-12).map(p => byId.get(p.playerId)).filter(Boolean),
    round: Math.floor((at - 1) / T) + 1, rosterKnown: true,
  });
  const goneBefore = new Set(picks.filter(p => p.pickNo > at && p.pickNo < next).map(p => p.playerId));
  for (const r of ranked.slice(0, 25)) {
    if (r.survival == null) continue;
    const survived = !goneBefore.has(r.id);
    const d = Math.min(9, Math.floor(r.survival / 10));
    const b = buckets.get(d) || { n: 0, s: 0 }; b.n++; if (survived) b.s++; buckets.set(d, b);
    rows.push({ at, name: r.name, pos: r.pos, pred: r.survival, survived });
  }
}
console.log('CALIBRATION OF "% lasts" — replayed against the real draft');
console.log('predicted   n   actually survived   error');
let tot = 0, totN = 0;
for (let d = 0; d <= 9; d++) {
  const b = buckets.get(d); if (!b) continue;
  const pred = d * 10 + 5, act = 100 * b.s / b.n;
  const err = act - pred; tot += Math.abs(err) * b.n; totN += b.n;
  const bar = '#'.repeat(Math.round(act / 5));
  console.log(`  ${String(d*10).padStart(3)}-${String(d*10+9).padEnd(3)} ${String(b.n).padStart(4)}   ${act.toFixed(0).padStart(3)}%  ${bar.padEnd(20)} ${err >= 0 ? '+' : ''}${err.toFixed(0)}`);
}
console.log(`\nweighted mean absolute calibration error: ${(tot/totN).toFixed(1)} points`);
console.log('\nWORST MISSES (model said safe, player vanished):');
rows.filter(r => r.pred >= 70 && !r.survived).sort((a,b)=>b.pred-a.pred).slice(0,10)
  .forEach(r => console.log(`  pick ${String(r.at).padStart(3)}  ${r.name.padEnd(22)}${r.pos.padEnd(4)} said ${String(r.pred).padStart(3)}% to last — GONE`));
