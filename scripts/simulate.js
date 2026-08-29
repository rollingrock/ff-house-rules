// Mock-draft the whole league: 11 ADP-driven bots + my recommender. Validation + rehearsal.
import fs from 'node:fs'; import path from 'node:path';
import { recommend, bestLineupPoints } from '../src/recommend.js';
import { isCensoredAdp } from '../src/score.js';
import { loadConfig, boardPath } from '../src/league.js';

// Bot draft order. ESPN ADP is censored past ~158 (hundreds of players parked at 170), so for
// those the bots fall back to projected value, which is what a real manager would use.
const botAdp = (p, cfg) => {
  const o = cfg.tuning.adpOverrides?.[p.pos];
  if (o) return o;
  if (!isCensoredAdp(p.adp, cfg)) return p.adp;
  return 160 + Math.max(0, 400 - (p.pts ?? 0)) / 8;
};
const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const board = JSON.parse(fs.readFileSync(boardPath(cfg.id), 'utf8'));
const repl = board.replacement;

const T = cfg.teams, R = cfg.draft.rounds;
const MY_SLOT = Number(process.argv[2] || 6);          // 1-indexed draft position
const SEED = Number(process.argv[3] || 42);
let seed = SEED; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const pickOrder = [];                                   // snake
for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) pickOrder.push(r % 2 === 0 ? t + 1 : T - t);
const myPicks = pickOrder.map((t, i) => t === MY_SLOT ? i + 1 : null).filter(Boolean);

const pool = board.players.map(p => ({ ...p }));
const avail = new Set(pool.map(p => p.id));
const rosters = Object.fromEntries(Array.from({ length: T }, (_, i) => [i + 1, []]));
const picks = [];

// bot need model: won't take a 3rd QB/TE/K/DST etc, and won't take K/DST/DP before round 13
const botWants = (roster, pos, round) => {
  const n = roster.filter(p => p.pos === pos).length;
  if (['K', 'DST'].includes(pos)) return round >= 13 && n < 1;
  if (cfg.roster.dpEligible.includes(pos)) return round >= 14 && n < 1;
  if (pos === 'QB') return n < (round >= 10 ? 2 : 1);
  if (pos === 'TE') return n < (round >= 11 ? 2 : 1);
  return n < (cfg.roster.positionMax[pos] ?? 8);
};

for (let i = 0; i < pickOrder.length; i++) {
  const pickNo = i + 1, team = pickOrder[i], round = Math.floor(i / T) + 1;
  const list = pool.filter(p => avail.has(p.id));
  let chosen;
  if (team === MY_SLOT) {
    const next = myPicks.find(p => p > pickNo) || null;
    const { ranked } = recommend({ available: list, myRoster: rosters[team], currentPick: pickNo,
                                   nextPick: next, cfg, repl, recentPicks: picks.slice(-12), round });
    chosen = ranked[0];
    console.log(`R${String(round).padStart(2)} P${String(pickNo).padStart(3)}  >>> ME: ${chosen.name} (${chosen.pos}) ` +
      `mv ${chosen.marginal} urg ${chosen.urgency} | next@${next ?? '-'} | ${chosen.reason}`);
    const alts = ranked.slice(1, 4).map(a => `${a.name}(${a.pos},${a.score})`).join('  ');
    console.log(`         alternatives: ${alts}`);
  } else {
    // bot: noisy ADP, respecting simple roster needs
    const cands = list.filter(p => botWants(rosters[team], p.pos, round))
      .map(p => ({ p, key: botAdp(p, cfg) * (0.85 + rnd() * 0.3) }))
      .sort((a, b) => a.key - b.key);
    chosen = (cands[0] || { p: list[0] }).p;
  }
  avail.delete(chosen.id);
  rosters[team].push(chosen);
  picks.push(chosen);
}

console.log(`\n================ MY ROSTER (slot ${MY_SLOT}, seed ${SEED}) ================`);
const mine = rosters[MY_SLOT];
const { total, starters } = bestLineupPoints(mine, cfg, repl);
const sset = new Set(starters.map(p => p.id));
mine.forEach((p, i) => console.log(`  R${String(i + 1).padStart(2)} ${sset.has(p.id) ? 'START' : '  ben'} ${p.name.padEnd(24)} ${p.pos.padEnd(4)} ${String(p.pts).padStart(6)}`));
console.log(`  optimal starting lineup total: ${Math.round(total)}`);

// Optionally persist the finished draft so the in-season tools have a real roster to work on.
if (process.argv[4]) {
  const outFile = path.join(root, 'data/drafts', `${process.argv[4]}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    mySlot: MY_SLOT,
    picks: picks.map((p, i) => ({ pickNo: i + 1, round: Math.floor(i / T) + 1,
      team: pickOrder[i], playerId: p.id, name: p.name, pos: p.pos, pts: p.pts })),
    teamNames: {},
  }, null, 1));
  console.log(`
wrote ${outFile}`);
}

const scores = Object.entries(rosters).map(([t, r]) => ({ t: +t, pts: bestLineupPoints(r, cfg, repl).total }));
scores.sort((a, b) => b.pts - a.pts);
console.log('\n LEAGUE FINISH (projected starting-lineup points):');
scores.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. team ${String(s.t).padStart(2)}${s.t === MY_SLOT ? '  <-- ME' : '    '}  ${Math.round(s.pts)}`));
