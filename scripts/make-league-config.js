// Generate a league config straight from ESPN's own settings. Needs cookies.
//   node scripts/make-league-config.js <leagueId> [outputName]
//
// This removes all hand-derivation from scoring. ESPN stores scoring as a flat list of
// {statId, points, pointsOverrides}, where pointsOverrides is keyed by POSITION id - notably
// 16 = D/ST. So the real model is one map for everyone plus a D/ST-specific override map,
// not the position-branching I originally guessed at.
import fs from 'node:fs';
import path from 'node:path';
import { readCookies } from '../src/espn-live.js';
import { FORBIDDEN } from '../src/statmap.js';

const root = path.resolve(import.meta.dirname, '..');
const leagueId = Number(process.argv[2]);
if (!leagueId) { console.error('usage: node scripts/make-league-config.js <leagueId> [name]'); process.exit(1); }
const season = Number(process.env.SEASON || 2026);

const c = readCookies(root);
if (!c) { console.error('no ESPN cookies - see SETUP.md'); process.exit(1); }

const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`
  + '?view=mSettings&view=mTeam';
const res = await fetch(url, {
  headers: { cookie: `espn_s2=${c.espn_s2}; SWID=${c.SWID}`, accept: 'application/json' },
});
if (!res.ok) { console.error(`ESPN returned ${res.status}`); process.exit(1); }
const d = await res.json();
const s = d.settings || {};
const rs = s.rosterSettings || {}, sc = s.scoringSettings || {}, ds = s.draftSettings || {};

// ---- roster ---------------------------------------------------------------------------
const SLOT_NAME = {
  0: 'QB', 2: 'RB', 3: 'RBWR', 4: 'WR', 5: 'WRTE', 6: 'TE', 7: 'OP',
  8: 'DT', 9: 'DE', 10: 'LB', 11: 'DL', 12: 'CB', 13: 'S', 14: 'DB',
  15: 'DP', 16: 'DST', 17: 'K', 18: 'P', 19: 'HC', 20: 'BE', 21: 'IR', 23: 'FLEX',
};
const counts = rs.lineupSlotCounts || {};
const starters = {};
let bench = 0, ir = 0;
for (const [id, n] of Object.entries(counts)) {
  if (!n) continue;
  const name = SLOT_NAME[id] || `SLOT${id}`;
  if (name === 'BE') { bench = n; continue; }
  if (name === 'IR') { ir = n; continue; }
  starters[name] = n;
}
// ESPN has several flex slot types: 23 = RB/WR/TE, 5 = WR/TE, 3 = RB/WR, 7 = any offensive
// player. The lineup optimiser currently supports ONE flex type, so merge only when a league
// uses a single kind - and warn loudly rather than silently mis-modelling a multi-flex league.
const FLEX_KINDS = {
  FLEX: ['RB', 'WR', 'TE'], WRTE: ['WR', 'TE'], RBWR: ['RB', 'WR'],
  OP: ['QB', 'RB', 'WR', 'TE'],
};
const flexPresent = Object.keys(FLEX_KINDS).filter(k => starters[k]);
let flexEligible = ['RB', 'WR', 'TE'];
const warnings = [];
if (flexPresent.length === 1) {
  const k = flexPresent[0];
  flexEligible = FLEX_KINDS[k];
  if (k !== 'FLEX') { starters.FLEX = starters[k]; delete starters[k]; }
} else if (flexPresent.length > 1) {
  // Keep the widest eligibility so nobody is wrongly excluded, and flag it for a human.
  const total = flexPresent.reduce((a, k) => a + starters[k], 0);
  const widest = flexPresent.reduce((a, b) => (FLEX_KINDS[a].length >= FLEX_KINDS[b].length ? a : b));
  flexEligible = FLEX_KINDS[widest];
  for (const k of flexPresent) delete starters[k];
  starters.FLEX = total;
  warnings.push(`This league uses ${flexPresent.length} DIFFERENT flex types `
    + `(${flexPresent.map(k => `${k}x${counts[Object.keys(SLOT_NAME).find(i => SLOT_NAME[i] === k)] ?? '?'}`).join(', ')}). `
    + `They have been merged into FLEX x${total} with the widest eligibility [${flexEligible.join('/')}], `
    + `which is APPROXIMATE - the optimiser may start a player in a slot he is not eligible for. `
    + `Review config.roster before trusting this league's lineup output.`);
}

// ---- scoring --------------------------------------------------------------------------
// `points` applies to every position; pointsOverrides[16] replaces it for D/ST.
const all = {}, dst = {};
for (const it of sc.scoringItems || []) {
  const id = String(it.statId);
  if (FORBIDDEN.has(id)) continue;                 // never score a derived/aggregate id
  const base = it.points || 0;
  const over = it.pointsOverrides?.['16'];
  if (base) all[id] = base;
  const dv = over === undefined ? base : over;
  if (dv) dst[id] = dv;
}

const teams = (d.teams || []).map(t => (t.name || `${t.location || ''} ${t.nickname || ''}`).trim());
const id = (process.argv[3] || s.name || `league-${leagueId}`)
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const cfg = {
  id,
  name: s.name,
  espnLeagueId: leagueId,
  season,
  myTeamName: null,                                 // fill this in
  teams: s.size,
  draft: {
    type: (ds.type || 'SNAKE').toLowerCase(),
    rounds: Object.values(counts).reduce((a, b) => a + b, 0) - ir,   // IR slots are not drafted
    datetime: ds.date ? new Date(ds.date).toISOString() : null,
    secondsPerPick: ds.timePerSelection ?? null,
    myPickSlot: null,
  },
  roster: {
    starters,
    flexEligible,
    dpEligible: ['LB', 'DE', 'DT', 'CB', 'S'],
    benchSlots: bench,
    irSlots: ir,
    totalSize: Object.values(counts).reduce((a, b) => a + b, 0) - ir,
    positionMax: rs.positionLimits || {},
    replacementMode: 'postdraft',
    draftedCounts: null,                            // set after a sweep; see README
  },
  scoring: {
    _comment: 'Generated from ESPN scoringSettings.scoringItems. `all` applies to every position; '
      + '`dst` is the D/ST override map (ESPN pointsOverrides keyed by position 16).',
    all, dst,
  },
  tuning: {
    valueWeight: 0.2, urgencyWeight: 1.0, benchWeight: 0.35, runBoost: 6,
    thinnessWeight: 0.9, adpCensorFrom: 158, survivalNoise: 0.16,
    adpOverrides: { LB: 170, DE: 185, DT: 190, CB: 190, S: 185 },
  },
  draftRules: {
    earliestRound: {}, targetMax: {}, secondAtPositionEarliest: {}, minByEndOfDraft: {},
  },
  _espnTeams: teams,
  _warnings: warnings.length ? warnings : undefined,
};

// Preserve anything hand-tuned if this config already exists: ESPN owns the rules and the
// scoring, we own myTeamName, the draft guardrails, the weights, and the drafted counts.
const out = path.join(root, 'config', `${id}.json`);
if (fs.existsSync(out)) {
  const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
  cfg.myTeamName = prev.myTeamName ?? cfg.myTeamName;
  cfg.tuning = prev.tuning ?? cfg.tuning;
  cfg.draftRules = prev.draftRules ?? cfg.draftRules;
  cfg.roster.draftedCounts = prev.roster?.draftedCounts ?? cfg.roster.draftedCounts;
  cfg.roster.positionMax = Object.keys(cfg.roster.positionMax || {}).length
    ? cfg.roster.positionMax : (prev.roster?.positionMax || {});
  cfg.waivers = prev.waivers; cfg.lineupProtection = prev.lineupProtection;
  cfg.lineupLock = prev.lineupLock; cfg.playoffTeams = prev.playoffTeams;
  cfg.regularSeasonWeeks = prev.regularSeasonWeeks;
  console.log('  (merged over the existing config: kept myTeamName, tuning, draftRules, draftedCounts)');
}
fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
console.log(`wrote ${path.relative(root, out)}`);
console.log(`  ${s.name} | ${s.size} teams | ${cfg.draft.rounds} rounds | ${cfg.draft.secondsPerPick}s/pick`);
console.log(`  draft: ${cfg.draft.datetime ? new Date(cfg.draft.datetime).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CDT' : 'not scheduled'}`);
console.log(`  starters: ${Object.entries(starters).map(([k, v]) => k + ':' + v).join(' ')} | bench ${bench} | IR ${ir}`);
console.log(`  scoring: ${Object.keys(all).length} ids for all positions, ${Object.keys(dst).length} for D/ST`);
console.log(`  teams: ${teams.join(' | ')}`);
for (const w of warnings) console.log(`\n  !! WARNING: ${w}`);
if (!bench) console.log('\n  note: no bench slots - every drafted player is a starter here.');
console.log(`\nNext: set "myTeamName" in the config, then draftRules, then build-board.`);
