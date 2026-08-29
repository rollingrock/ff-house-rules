// Grade the 2025 draft on what the drafted players ACTUALLY scored, in this league's scoring.
//
// The 2026 player dump carries 2025 actuals (stat set "002025") and ESPN player ids are stable,
// so every 2025 pick can be re-scored after the fact. 2025 used the same roster and the same
// scoring as 2026, which makes it a fair test of both the managers and of my own valuation.
//   node scripts/grade-drafts.js
import fs from 'node:fs';
import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';
import { scoreStats } from '../src/score.js';
import { bestLineupPoints } from '../src/recommend.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/raw/espn-players-2026.json'), 'utf8'));
const hist = JSON.parse(fs.readFileSync(path.join(root, 'data/history/league-2025.json'), 'utf8'));

// actual 2025 points, and preseason 2025 projection, per player id
const actual = new Map(), proj = new Map(), meta = new Map();
for (const e of raw) {
  const p = e.player || e;
  if (!p.fullName) continue;
  const pos = POSITION_BY_ID[p.defaultPositionId] || (p.id < -1 ? 'DST' : '?');
  meta.set(p.id, { name: p.fullName, pos });
  const a = (p.stats || []).find(s => s.seasonId === 2025 && s.statSourceId === 0 && !s.scoringPeriodId)?.stats;
  const j = (p.stats || []).find(s => s.seasonId === 2025 && s.statSourceId === 1 && !s.scoringPeriodId)?.stats;
  if (a && Object.keys(a).length) actual.set(p.id, scoreStats(a, pos, cfg, p.eligibleSlots));
  if (j) proj.set(p.id, scoreStats(j, pos, cfg, p.eligibleSlots));
}

const teams = Object.fromEntries((hist.teams || []).map(t => [t.id, (t.name || '').trim()]));
const record = Object.fromEntries((hist.teams || []).map(t => [t.id, t.record?.overall || null]));
const picks = (hist.draftDetail?.picks || [])
  .filter(p => p.playerId && p.playerId !== -1)
  .sort((a, b) => a.overallPickNumber - b.overallPickNumber);

const byTeam = {};
for (const p of picks) {
  const m = meta.get(p.playerId) || { name: `#${p.playerId}`, pos: '?' };
  (byTeam[p.teamId] ||= []).push({
    ...p, ...m, actual: actual.get(p.playerId) ?? null, proj: proj.get(p.playerId) ?? null,
  });
}

// "Draft value captured": the best starting lineup you could field from ONLY your drafted
// players, using what they actually scored. Ignores in-season management, which is the point -
// this grades the draft, not the season.
const rows = [];
for (const [tid, list] of Object.entries(byTeam)) {
  const scored = list.filter(p => p.actual != null).map(p => ({ ...p, pts: p.actual }));
  const lineup = bestLineupPoints(scored, cfg, { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, LB: 0, DE: 0, DT: 0, CB: 0, S: 0 });
  const totalAll = scored.reduce((a, b) => a + b.pts, 0);
  const rec = record[tid];
  rows.push({
    tid, team: teams[tid] || `team${tid}`,
    starters: Math.round(lineup.total), all: Math.round(totalAll),
    n: scored.length, of: list.length,
    wins: rec?.wins ?? null, losses: rec?.losses ?? null, pf: rec?.pointsFor ?? null,
  });
}
rows.sort((a, b) => b.starters - a.starters);

console.log('2025 DRAFT GRADE - best lineup obtainable from your drafted players, on ACTUAL 2025 points\n');
console.log('  rk  team                        draft-only   all 16   actual W-L      PF');
rows.forEach((r, i) => {
  const me = r.team === cfg.myTeamName ? '  <<<' : '';
  console.log(`  ${String(i + 1).padStart(2)}  ${r.team.slice(0, 26).padEnd(28)}${String(r.starters).padStart(8)}`
    + `${String(r.all).padStart(9)}   ${r.wins != null ? `${r.wins}-${r.losses}`.padStart(6) : '     -'}`
    + `${r.pf != null ? String(Math.round(r.pf)).padStart(8) : '       -'}${me}`);
});

// Best and worst individual picks, by actual points minus what the pick slot typically returns.
const all = Object.values(byTeam).flat().filter(p => p.actual != null);
const bySlot = [...all].sort((a, b) => a.overallPickNumber - b.overallPickNumber);
const windowAvg = (i) => {
  const w = bySlot.slice(Math.max(0, i - 12), i + 12).map(p => p.actual);
  return w.reduce((a, b) => a + b, 0) / w.length;
};
const graded = bySlot.map((p, i) => ({ ...p, over: p.actual - windowAvg(i) }));
graded.sort((a, b) => b.over - a.over);
console.log('\nBEST VALUE PICKS OF THE 2025 DRAFT (actual points vs what that area of the board returned)');
graded.slice(0, 8).forEach(p => console.log(`  R${String(p.roundId).padStart(2)} pick ${String(p.overallPickNumber).padStart(3)}  `
  + `${p.name.padEnd(22)} ${p.pos.padEnd(4)} ${String(Math.round(p.actual)).padStart(4)} pts  +${Math.round(p.over)}   ${teams[p.teamId]}`));
console.log('\nWORST');
graded.slice(-6).reverse().forEach(p => console.log(`  R${String(p.roundId).padStart(2)} pick ${String(p.overallPickNumber).padStart(3)}  `
  + `${p.name.padEnd(22)} ${p.pos.padEnd(4)} ${String(Math.round(p.actual)).padStart(4)} pts  ${Math.round(p.over)}   ${teams[p.teamId]}`));

// your own draft, pick by pick
const mine = byTeam[5] || [];
console.log('\nYOUR 2025 DRAFT, PICK BY PICK (actual 2025 points in this scoring)');
for (const p of mine) {
  const a = p.actual == null ? '   —' : String(Math.round(p.actual)).padStart(4);
  const j = p.proj == null ? '   —' : String(Math.round(p.proj)).padStart(4);
  const d = (p.actual != null && p.proj != null) ? (p.actual - p.proj >= 0 ? '+' : '') + Math.round(p.actual - p.proj) : '';
  console.log(`  R${String(p.roundId).padStart(2)} pick ${String(p.overallPickNumber).padStart(3)}  ${p.name.padEnd(22)} ${p.pos.padEnd(4)} actual ${a}  preseason proj ${j}   ${d}`);
}
