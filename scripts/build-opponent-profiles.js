// Build per-manager draft profiles keyed by ESPN team id, for the opponent model.
//
// Team ids persist across seasons even when team NAMES change, and the 5PM randomisation only
// shuffles which SLOT a team drafts from - not who they are. So a profile keyed by team id
// survives the reshuffle, and the live feed gives us the slot->teamId mapping.
//
// Evidence is thin (two seasons per manager), so these are used as a MILD prior that nudges the
// generic need model, never as a hard rule. See opponentNeed() in src/recommend.js.
//   node scripts/build-opponent-profiles.js
import fs from 'node:fs';
import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';

const root = path.resolve(import.meta.dirname, '..');
const IDP = ['LB', 'DE', 'DT', 'CB', 'S'];
const bucket = pos => (IDP.includes(pos) ? 'DP' : pos);
const YEARS = [2024, 2025];

// Player id -> position, from whichever dump covers that season.
function posMap(file, season) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const m = new Map();
  for (const e of raw) {
    const p = e.player || e;
    if (!p.fullName) continue;
    m.set(p.id, POSITION_BY_ID[p.defaultPositionId] || (p.id < -1 ? 'DST' : '?'));
  }
  return m;
}
const maps = {
  2024: posMap('data/history/players-2024.json', 2024),
  2025: posMap('data/raw/espn-players-2026.json', 2025),
};

const byTeam = {};
for (const yr of YEARS) {
  const f = path.join(root, `data/history/league-${yr}.json`);
  if (!fs.existsSync(f)) continue;
  const hist = JSON.parse(fs.readFileSync(f, 'utf8'));
  const names = Object.fromEntries((hist.teams || []).map(t => [t.id, (t.name || '').trim()]));
  const picks = (hist.draftDetail?.picks || [])
    .filter(p => p.playerId && p.playerId !== -1)
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber);
  for (const p of picks) {
    const pos = bucket(maps[yr].get(p.playerId) || '?');
    if (pos === '?') continue;
    const t = (byTeam[p.teamId] ||= { name: names[p.teamId], seasons: {}, counts: {} });
    t.name = names[p.teamId] || t.name;
    const s = (t.seasons[yr] ||= { first: {}, count: {} });
    if (s.first[pos] == null) s.first[pos] = p.roundId;
    s.count[pos] = (s.count[pos] || 0) + 1;
  }
}

const POS = ['QB', 'RB', 'WR', 'TE', 'DP', 'DST', 'K'];
const profiles = {};
for (const [tid, t] of Object.entries(byTeam)) {
  const yrs = Object.values(t.seasons);
  if (!yrs.length) continue;
  const firstRound = {}, avgCount = {};
  for (const pos of POS) {
    const f = yrs.map(y => y.first[pos]).filter(v => v != null);
    if (f.length) firstRound[pos] = +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1);
    const c = yrs.map(y => y.count[pos] || 0);
    avgCount[pos] = +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2);
  }
  profiles[tid] = { name: t.name, seasons: yrs.length, firstRound, avgCount };
}

const out = {
  _comment: 'Per-manager draft tendencies keyed by ESPN team id, from the 2024 and 2025 drafts of '
    + 'this same league. firstRound[pos] is the average round that manager first took the position; '
    + 'avgCount[pos] is how many they take per draft. Two seasons is thin evidence, so the opponent '
    + 'model uses this as a mild prior only.',
  builtFrom: YEARS,
  profiles,
};
fs.mkdirSync(path.join(root, 'data/history'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/history/opponent-profiles.json'), JSON.stringify(out, null, 2));

console.log(`profiles for ${Object.keys(profiles).length} managers\n`);
console.log('  id  team                     ' + POS.map(p => p.padStart(6)).join(''));
for (const [tid, p] of Object.entries(profiles).sort((a, b) => (a[1].firstRound.QB ?? 99) - (b[1].firstRound.QB ?? 99))) {
  console.log(`  ${tid.padStart(2)}  ${p.name.slice(0, 22).padEnd(24)}`
    + POS.map(x => (p.firstRound[x] == null ? '—' : p.firstRound[x].toFixed(1)).padStart(6)).join(''));
}
console.log('\nwrote data/history/opponent-profiles.json');
