// What do THESE eleven managers actually do in a draft?
//
// The league keeps the same ESPN id year over year, so 2024 and 2025 are the same format as 2026
// (QB1 RB2 WR2 TE1 DP1 DST1 K1, 0.1/passing yard, 6-pt passing TDs, 1 per tackle) with mostly
// the same people. That makes them a far better model of this room than generic ADP.
//   node scripts/history.js
import fs from 'node:fs';
import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';

const root = path.resolve(import.meta.dirname, '..');
const YEARS = [2024, 2025];                       // 2023 used 0.08/passing yard - excluded
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/raw/espn-players-2026.json'), 'utf8'));

// ESPN player ids are stable across seasons, so the 2026 universe resolves most historic picks.
const posById = new Map(), nameById = new Map();
for (const e of raw) {
  const p = e.player || e;
  if (!p.fullName) continue;
  nameById.set(p.id, p.fullName);
  posById.set(p.id, POSITION_BY_ID[p.defaultPositionId] || '?');
}
// D/ST ids are negative and stable: -(16000 + proTeamId)
const posOf = id => (id < -1 ? 'DST' : posById.get(id) || '?');
const nameOf = id => (id < -1 ? `DST ${-id - 16000}` : nameById.get(id) || `#${id}`);

const drafts = [];
for (const yr of YEARS) {
  const f = path.join(root, `data/history/league-${yr}.json`);
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const teams = Object.fromEntries((d.teams || []).map(t => [t.id, (t.name || '').trim()]));
  const picks = (d.draftDetail?.picks || [])
    .filter(p => p.playerId && p.playerId !== -1)
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber)
    .map(p => ({
      year: yr, overall: p.overallPickNumber, round: p.roundId,
      teamId: p.teamId, team: teams[p.teamId] || `team${p.teamId}`,
      playerId: p.playerId, pos: posOf(p.playerId), name: nameOf(p.playerId),
      auto: !!p.autoDraftTypeId,
    }));
  drafts.push({ year: yr, picks, teams });
}

const all = drafts.flatMap(d => d.picks);
const IDP = ['LB', 'DE', 'DT', 'CB', 'S'];
const bucket = p => (IDP.includes(p.pos) ? 'DP' : p.pos);

console.log(`${all.length} real picks across ${drafts.map(d => d.year).join(', ')}\n`);

// ---- 1. when does this room take each position? -------------------------------------
console.log('WHEN THIS ROOM DRAFTS EACH POSITION (share of all picks in each round)');
const rounds = 16;
const posList = ['QB', 'RB', 'WR', 'TE', 'DP', 'DST', 'K'];
console.log('  rd ' + posList.map(p => p.padStart(5)).join('') + '   picks');
for (let r = 1; r <= rounds; r++) {
  const inR = all.filter(p => p.round === r);
  if (!inR.length) continue;
  const row = posList.map(pos => {
    const n = inR.filter(p => bucket(p) === pos).length;
    return (n ? (100 * n / inR.length).toFixed(0) + '%' : '·').padStart(5);
  }).join('');
  console.log(`  ${String(r).padStart(2)} ${row}   ${inR.length}`);
}

// ---- 2. first round each position appears -------------------------------------------
console.log('\nFIRST ROUND EACH POSITION IS TAKEN (per team-season), vs my guardrails');
const guard = loadConfig(process.env.LEAGUE).draftRules.earliestRound;
for (const pos of posList) {
  const firsts = [];
  for (const d of drafts) {
    const byTeam = {};
    for (const p of d.picks) if (bucket(p) === pos && !byTeam[p.teamId]) byTeam[p.teamId] = p.round;
    firsts.push(...Object.values(byTeam));
  }
  if (!firsts.length) { console.log(`  ${pos.padEnd(4)} never drafted`); continue; }
  firsts.sort((a, b) => a - b);
  const med = firsts[Math.floor(firsts.length / 2)];
  const g = guard[pos] ?? guard[pos === 'DP' ? 'LB' : pos];
  console.log(`  ${pos.padEnd(4)} earliest R${String(firsts[0]).padStart(2)}  median R${String(med).padStart(2)}  latest R${String(firsts[firsts.length - 1]).padStart(2)}`
    + `   (n=${firsts.length})${g ? `   my guardrail: R${g}` : ''}`);
}

// ---- 3. per-manager tendencies -------------------------------------------------------
console.log('\nPER-MANAGER: average round they first take each position');
const byTeamName = {};
for (const d of drafts) {
  for (const p of d.picks) {
    const k = p.team;
    (byTeamName[k] ||= {});
    const b = bucket(p);
    byTeamName[k][b] ??= {};
    byTeamName[k][b][p.year] = Math.min(byTeamName[k][b][p.year] ?? 99, p.round);
  }
}
const avg = o => { const v = Object.values(o || {}); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length) : null; };
const rows = Object.entries(byTeamName).map(([team, m]) => ({
  team, ...Object.fromEntries(posList.map(p => [p, avg(m[p])])),
})).filter(r => r.QB != null);
rows.sort((a, b) => (a.QB ?? 99) - (b.QB ?? 99));
console.log('  team                      ' + posList.map(p => p.padStart(6)).join(''));
for (const r of rows) {
  console.log('  ' + r.team.slice(0, 24).padEnd(26)
    + posList.map(p => (r[p] == null ? '—' : r[p].toFixed(1)).padStart(6)).join(''));
}

fs.writeFileSync(path.join(root, 'data/history/picks.json'), JSON.stringify(all));
console.log(`\nwrote data/history/picks.json (${all.length} picks)`);
