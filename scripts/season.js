// In-season CLI.
//   node scripts/season.js sync                 refresh league ground truth from ESPN
//   node scripts/season.js lineup [week]        what to start, and what to change
//   node scripts/season.js roster               my roster as ESPN has it right now
//   node scripts/season.js waivers [week]       free agents worth adding
//   node scripts/season.js byes
//
// Roster resolution, in order:
//   1. the synced ESPN state   - real: includes waiver adds and the currently-set lineup
//   2. the draft file          - correct only until the first transaction, and says so loudly
import fs from 'node:fs'; import path from 'node:path';
import {
  optimizeLineup, waiverTargets, byeReport, lineupDelta, weekPoints, isBye, isUnavailable, isZeroProjected,
} from '../src/season.js';
import { loadConfig, boardPath, draftPath } from '../src/league.js';
import { haveCookies } from '../src/espn-live.js';
import {
  fetchLeagueState, saveState, loadState, stateAgeMs, describeAge,
  myTeam, resolveRoster, currentStarterIds, freeAgents,
} from '../src/league-state.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const LEAGUE = cfg.id;
const board = JSON.parse(fs.readFileSync(boardPath(LEAGUE), 'utf8'));
const byId = new Map(board.players.map(p => [p.id, p]));

const [cmd, arg] = process.argv.slice(2);
const STALE_MS = 6 * 60 * 60 * 1000;      // a roster six hours old has probably seen a waiver run

// ---------------------------------------------------------------------------------- sync

if (cmd === 'sync') {
  if (!haveCookies(root)) {
    console.error('\n  No ESPN cookies. Add config/espn-cookies.json with espn_s2 and SWID.\n');
    process.exit(1);
  }
  const s = await fetchLeagueState(cfg, root);
  if (s.error) { console.error(`\n  ${s.error}\n`); process.exit(1); }
  if (!s.myEspnTeamId) {
    console.error(`\n  Could not find your team. Config myTeamName is ${JSON.stringify(cfg.myTeamName)}; ESPN has:\n`
      + s.teams.map(t => `    ${t.name}`).join('\n')
      + '\n\n  Fix myTeamName in the config, or set myEspnTeamId.\n');
    process.exit(1);
  }
  const file = saveState(LEAGUE, s);
  const me = myTeam(s);
  const unowned = board.players.filter(p => !new Set(s.ownedIds).has(p.id)).length;
  console.log(`\n  SYNCED ${cfg.name} — ESPN week ${s.scoringPeriodId ?? '?'}`);
  console.log(`  ${s.teams.length} teams · ${s.ownedIds.length} players rostered · ${unowned} on the board unowned`);
  console.log(`  you: ${me.name} (${me.wins ?? 0}-${me.losses ?? 0}) — ${me.roster.length} players, ${me.roster.filter(p => p.starter).length} in start slots`);
  const hurt = me.roster.filter(p => p.injuryStatus && !['ACTIVE', 'NORMAL'].includes(p.injuryStatus));
  if (hurt.length) console.log(`  flagged: ${hurt.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}`);
  console.log(`  -> ${file}\n`);
  process.exit(0);
}

// --------------------------------------------------------------------- roster resolution

const state = loadState(LEAGUE);
let myRoster, currentIds = null, missing = [], source, ageNote;

if (state && myTeam(state)) {
  const me = myTeam(state);
  const r = resolveRoster(me.roster, byId);
  myRoster = r.players;
  missing = r.missing;
  currentIds = currentStarterIds(me.roster);
  source = 'espn';
  const age = stateAgeMs(state);
  ageNote = `synced ${describeAge(age)}`;
  if (age != null && age > STALE_MS) ageNote += '  ⚠ re-run `season.js sync`';
} else {
  const draftFile = draftPath(LEAGUE);
  const draft = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf8')) : { picks: [], mySlot: null };
  myRoster = draft.picks.filter(p => p.team === draft.mySlot).map(p => byId.get(p.playerId)).filter(Boolean);
  source = 'draft';
  ageNote = 'from the DRAFT FILE — stale after any add/drop';
}

if (!myRoster.length) {
  console.log('\n  No roster yet. Run `node scripts/season.js sync`, or draft first.\n');
  process.exit(0);
}

const week = Number(arg) || state?.scoringPeriodId || 1;

function header(title) {
  console.log(`\n  ${title}`);
  console.log(`  ${cfg.name} · week ${week} · ${ageNote}`);
  if (source === 'draft') console.log('  ⚠ roster is draft-night state, not live. Run `season.js sync`.');
  if (missing.length) console.log(`  ⚠ no projection on the board: ${missing.map(m => m.name || m.playerId).join(', ')}`);
  console.log('');
}

const wp = p => p.wpts ?? weekPoints(p, week, cfg) ?? 0;
const line = p => `${(p.name || '').padEnd(24)} ${(p.pos || '').padEnd(4)} ${String(wp(p)).padStart(5)}`;
const flag = p => (p.injuryStatus && !['ACTIVE', 'NORMAL'].includes(p.injuryStatus)) ? `  (${p.injuryStatus})` : '';
// Why is this player worth nothing this week? A bye is structural; a zeroed line is news.
const zeroNote = p => isBye(p, week) ? '  (BYE)'
  : isZeroProjected(p, week) ? '  ⚠ NO PROJECTION — ESPN expects him to miss' : '';

// Ruled out by ESPN. Their projections are often still non-zero, so this has to be explicit.
const unavailable = new Set(myRoster.filter(isUnavailable).map(p => p.id));
// Below this, a "change" is projection noise, not a decision worth making.
const MATERIAL = 1.0;

// -------------------------------------------------------------------------------- lineup

if (cmd === 'lineup' || !cmd) {
  const opt = optimizeLineup(myRoster, week, cfg, { unavailable });

  if (currentIds) {
    const d = lineupDelta(myRoster, currentIds, week, cfg, { unavailable });
    const startingOut = myRoster.filter(p => currentIds.has(p.id) && unavailable.has(p.id));
    const material = d.gain >= MATERIAL || startingOut.length > 0;

    header(!d.moves.length ? 'LINEUP IS ALREADY OPTIMAL'
      : material ? `${d.moves.length} LINEUP CHANGE${d.moves.length > 1 ? 'S' : ''} NEEDED   +${d.gain} pts`
      : `lineup is optimal within ${MATERIAL} pt — ${d.moves.length} optional tweak${d.moves.length > 1 ? 's' : ''} below`);

    if (startingOut.length) {
      console.log(`   ⚠ RULED OUT BUT STILL STARTING: ${startingOut.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}\n`);
    }
    if (d.moves.length) {
      for (const m of d.moves.filter(m => m.action === 'START')) console.log(`   START   ${line(m)}${flag(m)}`);
      for (const m of d.moves.filter(m => m.action === 'BENCH')) console.log(`   BENCH   ${line(m)}${zeroNote(m)}${flag(m)}`);
      console.log(`\n   currently set ${d.currentPoints}  ->  optimal ${opt.total}\n`);
    }
  } else {
    header('OPTIMAL LINEUP');
  }

  console.log(`  OPTIMAL LINEUP  (projected ${opt.total})`);
  for (const l of opt.lineup) {
    if (l.empty) { console.log(`   ${String(l.slot).padEnd(5)}   — EMPTY —`); continue; }
    const mark = currentIds ? (currentIds.has(l.id) ? ' ' : '*') : ' ';
    console.log(`   ${String(l.slot).padEnd(5)} ${mark} ${line(l)}${zeroNote(l)}${flag(l)}`);
  }
  if (opt.bench.length) {
    console.log('\n  BENCH:');
    for (const b of opt.bench) {
      const mark = currentIds ? (currentIds.has(b.id) ? '*' : ' ') : ' ';
      console.log(`         ${mark} ${line(b)}${zeroNote(b)}${flag(b)}`);
    }
  }
  if (currentIds) console.log('\n  * = differs from your currently-set lineup');
  console.log('');

// -------------------------------------------------------------------------------- roster

} else if (cmd === 'roster') {
  header('MY ROSTER');
  const sorted = [...myRoster].sort((a, b) => (b.starter === true) - (a.starter === true) || (b.pts || 0) - (a.pts || 0));
  for (const p of sorted) {
    const slot = source === 'espn' ? String(p.espnSlot || '').padEnd(5) : '     ';
    console.log(`   ${slot} ${(p.name || '').padEnd(24)} ${(p.pos || '').padEnd(4)} season ${String(Math.round(p.pts || 0)).padStart(4)}  wk${week} ${String(wp(p)).padStart(5)}${flag(p)}`);
  }
  console.log('');

// ------------------------------------------------------------------------------- waivers

} else if (cmd === 'waivers') {
  let avail, poolNote;
  if (state) {
    avail = freeAgents(state, board);
    poolNote = `${avail.length} genuinely unowned in this league`;
  } else {
    const draftFile = draftPath(LEAGUE);
    const draft = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf8')) : { picks: [] };
    const taken = new Set(draft.picks.map(p => p.playerId));
    avail = board.players.filter(p => !taken.has(p.id) && (p.owned ?? 0) < 60);
    poolNote = `${avail.length} by ESPN GLOBAL ownership — not this league's real pool. Run sync.`;
  }
  // Cost is O(pool x weeks x optimizeLineup), so the pool is capped - but never silently.
  const CAP = 250;
  const ranked = [...avail].sort((a, b) => (b.pts || 0) - (a.pts || 0));
  const { targets, drops, baseline } =
    waiverTargets({ roster: myRoster, available: ranked.slice(0, CAP), cfg, fromWeek: week });

  header(`WAIVER TARGETS from week ${week}`);
  console.log(`  pool: ${poolNote}`);
  if (ranked.length > CAP) console.log(`  evaluated the top ${CAP} by projection; ${ranked.length - CAP} lower-projected not scored`);
  console.log(`  rest-of-season starting-lineup baseline: ${baseline}\n`);
  const hits = targets.filter(t => t.restOfSeasonGain > 0);
  if (!hits.length) console.log('   nothing available improves your starting lineup.\n');
  hits.slice(0, 15).forEach((t, i) =>
    console.log(`   ${String(i + 1).padStart(2)}. ${(t.name || '').padEnd(24)} ${(t.pos || '').padEnd(4)} +${String(t.restOfSeasonGain).padStart(5)}  (${Math.round(t.owned ?? 0)}% rostered globally)`));
  console.log('\n  CHEAPEST DROPS:');
  drops.slice(0, 5).forEach(d => console.log(`      ${(d.name || '').padEnd(24)} ${(d.pos || '').padEnd(4)} costs ${d.costToDrop}`));
  console.log('');

// ---------------------------------------------------------------------------------- byes

} else if (cmd === 'byes') {
  header('BYE-WEEK COLLISIONS');
  const rep = byeReport(myRoster, cfg);
  if (!rep.length) console.log('   none — no week has two players out.\n');
  for (const b of rep) console.log(`   week ${String(b.week).padStart(2)}: ${b.count} out — ${b.players.join(', ')}`);
  console.log('');

} else {
  console.log('usage: node scripts/season.js sync | lineup [week] | roster | waivers [week] | byes');
}
