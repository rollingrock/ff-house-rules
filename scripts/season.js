// In-season CLI.
//   node scripts/season.js sync                 refresh league ground truth from ESPN
//   node scripts/season.js lineup [week]        what to start, and what to change
//   node scripts/season.js roster               my roster as ESPN has it right now
//   node scripts/season.js waivers [week] [to]  free agents worth adding over a window
//   node scripts/season.js byes
//
//   --at <time>   judge game locks as of that moment instead of now, e.g. --at 2026-09-20T11:00
//
// For every league at once, printing only what needs doing: node scripts/weekly.js
//
// Roster resolution, in order:
//   1. the synced ESPN state   - real: includes waiver adds and the currently-set lineup
//   2. the draft file          - correct only until the first transaction, and says so loudly
import fs from 'node:fs'; import path from 'node:path';
import {
  optimizeLineup, waiverTargets, bestSwaps, byeReport, weakWeeks, lineupDelta, weekPoints, isBye, isUnavailable,
  isZeroProjected,
} from '../src/season.js';
import { loadConfig, boardPath, draftPath } from '../src/league.js';
import {
  syncLeague, loadState, stateAgeMs, describeAge, describeKickoff,
  myTeam, resolveRoster, currentStarterIds, freeAgents, lockInfo,
} from '../src/league-state.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const LEAGUE = cfg.id;
const board = JSON.parse(fs.readFileSync(boardPath(LEAGUE), 'utf8'));
const byId = new Map(board.players.map(p => [p.id, p]));

const argv = process.argv.slice(2);
const atIdx = argv.indexOf('--at');
const now = atIdx >= 0 ? Date.parse(argv.splice(atIdx, 2)[1]) : Date.now();
if (!Number.isFinite(now)) { console.error('\n  --at wants a date and time, e.g. --at 2026-09-20T11:00\n'); process.exit(1); }
const [cmd, arg, arg2] = argv;
const STALE_MS = 6 * 60 * 60 * 1000;      // a roster six hours old has probably seen a waiver run

// ---------------------------------------------------------------------------------- sync

if (cmd === 'sync') {
  const { state: s, file, error } = await syncLeague(cfg, root);
  if (error) { console.error(`\n  ${error}\n`); process.exit(1); }
  const me = myTeam(s);
  const unowned = board.players.filter(p => !new Set(s.ownedIds).has(p.id)).length;
  console.log(`\n  SYNCED ${cfg.name} — ESPN week ${s.scoringPeriodId ?? '?'}`);
  console.log(`  ${s.teams.length} teams · ${s.ownedIds.length} players rostered · ${unowned} on the board unowned`);
  console.log(`  you: ${me.name} (${me.wins ?? 0}-${me.losses ?? 0}) — ${me.roster.length} players, ${me.roster.filter(p => p.starter).length} in start slots`);
  const hurt = me.roster.filter(p => p.injuryStatus && !['ACTIVE', 'NORMAL'].includes(p.injuryStatus));
  if (hurt.length) console.log(`  flagged: ${hurt.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}`);
  if (s.kickoffsError) console.log(`  ⚠ no kickoff times (${s.kickoffsError}) — lineup cannot tell which games have locked`);
  console.log(`  -> ${file}\n`);
  process.exit(0);
}

// --------------------------------------------------------------------- roster resolution

const state = loadState(LEAGUE);
let myRoster, currentIds = null, entries = null, missing = [], source, ageNote;

if (state && myTeam(state)) {
  const me = myTeam(state);
  const r = resolveRoster(me.roster, byId);
  myRoster = r.players;
  missing = r.missing;
  entries = me.roster;
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

// Locks exist only in the week ESPN is scoring, and only for a synced roster - a draft file has no slots.
const { locked, kickoff } = entries ? lockInfo(state, entries, week, now) : { locked: new Set(), kickoff: new Map() };

function header(title, notes = []) {
  console.log(`\n  ${title}`);
  console.log(`  ${cfg.name} · week ${week} · ${ageNote}`);
  for (const n of notes) console.log(`  ${n}`);
  if (source === 'draft') console.log('  ⚠ roster is draft-night state, not live. Run `season.js sync`.');
  if (missing.length) console.log(`  ⚠ no projection on the board: ${missing.map(m => m.name || m.playerId).join(', ')}`);
  console.log('');
}

// The lock clock in one line: the deadline matters as much as the move.
function lockNote() {
  if (!entries || week !== state.scoringPeriodId) return [];
  const as = atIdx >= 0 ? ` (as of ${describeKickoff(now)})` : '';
  if (!state.kickoffs) return [`⚠ this sync has no kickoff times — game locks NOT checked. Re-run \`season.js sync\`.${as}`];
  const next = [...kickoff.values()].filter(k => k != null && k > now).sort((a, b) => a - b)[0];
  const nextNote = next ? `next kickoff ${describeKickoff(next)}` : 'every game has kicked off';
  if (!locked.size) return [`nothing locked yet · ${nextNote}${as}`];
  return [`locked, game started: ${entries.filter(e => locked.has(e.playerId)).map(e => e.name).join(', ')} · ${nextNote}${as}`];
}

const wp = p => p.wpts ?? weekPoints(p, week, cfg) ?? 0;
const line = p => `${(p.name || '').padEnd(24)} ${(p.pos || '').padEnd(4)} ${String(wp(p)).padStart(5)}`;
const flag = p => (p.injuryStatus && !['ACTIVE', 'NORMAL'].includes(p.injuryStatus)) ? `  (${p.injuryStatus})` : '';
const lockTag = p => locked.has(p.id) ? '  LOCKED' : '';
const locksAt = p => kickoff.get(p.id) ? `   locks ${describeKickoff(kickoff.get(p.id))}` : '';
// Why is this player worth nothing this week? A bye is structural; a zeroed line is news.
const zeroNote = p => isBye(p, week) ? '  (BYE)'
  : isZeroProjected(p, week) ? '  ⚠ NO PROJECTION — ESPN expects him to miss' : '';

// Ruled out by ESPN. Their projections are often still non-zero, so this has to be explicit.
const unavailable = new Set(myRoster.filter(isUnavailable).map(p => p.id));
// Below this, a "change" is projection noise, not a decision worth making.
const MATERIAL = 1.0;

// -------------------------------------------------------------------------------- lineup

if (cmd === 'lineup' || !cmd) {
  const opts = { unavailable, locked };
  const opt = optimizeLineup(myRoster, week, cfg, opts);

  if (currentIds) {
    const d = lineupDelta(myRoster, currentIds, week, cfg, opts);
    const startingOut = myRoster.filter(p => currentIds.has(p.id) && unavailable.has(p.id));
    // Ruled out and already locked is a zero nobody can fix any more: worth saying, not a change.
    const fixable = startingOut.filter(p => !locked.has(p.id));
    const tooLate = startingOut.filter(p => locked.has(p.id));
    const material = d.gain >= MATERIAL || fixable.length > 0;

    header(!d.moves.length ? 'LINEUP IS ALREADY OPTIMAL'
      : material ? `${d.moves.length} LINEUP CHANGE${d.moves.length > 1 ? 'S' : ''} NEEDED   +${d.gain} pts`
      : `lineup is optimal within ${MATERIAL} pt — ${d.moves.length} optional tweak${d.moves.length > 1 ? 's' : ''} below`,
      lockNote());

    if (fixable.length) {
      console.log(`   ⚠ RULED OUT BUT STILL STARTING: ${fixable.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}\n`);
    }
    if (tooLate.length) {
      console.log(`   ruled out and already locked in, too late to change: ${tooLate.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}\n`);
    }
    if (d.moves.length) {
      for (const m of d.moves.filter(m => m.action === 'START')) console.log(`   START   ${line(m)}${flag(m)}${locksAt(m)}`);
      for (const m of d.moves.filter(m => m.action === 'BENCH')) console.log(`   BENCH   ${line(m)}${zeroNote(m)}${flag(m)}${locksAt(m)}`);
      console.log(`\n   currently set ${d.currentPoints}  ->  optimal ${opt.total}\n`);
    }
  } else {
    header('OPTIMAL LINEUP');
  }

  console.log(`  OPTIMAL LINEUP  (projected ${opt.total})`);
  for (const l of opt.lineup) {
    if (l.empty) { console.log(`   ${String(l.slot).padEnd(5)}   — EMPTY —`); continue; }
    const mark = currentIds ? (currentIds.has(l.id) ? ' ' : '*') : ' ';
    console.log(`   ${String(l.slot).padEnd(5)} ${mark} ${line(l)}${zeroNote(l)}${flag(l)}${lockTag(l)}`);
  }
  if (opt.bench.length) {
    console.log('\n  BENCH:');
    for (const b of opt.bench) {
      const mark = currentIds ? (currentIds.has(b.id) ? '*' : ' ') : ' ';
      console.log(`         ${mark} ${line(b)}${zeroNote(b)}${flag(b)}${lockTag(b)}`);
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
  // Rank by VORP, not raw points: raw points is not comparable across positions and fills the
  // cap with quarterbacks, cutting off exactly the running back depth a waiver search wants.
  const CAP = 250;
  const ranked = [...avail].sort((a, b) => (b.vorp ?? -1e9) - (a.vorp ?? -1e9));
  // A rest-of-season view hides a short-term hole: an injured starter due back in week 7 makes
  // weeks 1-6 the actual need, and a player who only helps then scores near zero over 18 weeks.
  const toWeek = Number(arg2) || 18;
  const { targets, drops, baseline } =
    waiverTargets({ roster: myRoster, available: ranked.slice(0, CAP), cfg, fromWeek: week, toWeek });

  header(`WAIVER TARGETS — weeks ${week}-${toWeek}`);
  console.log(`  pool: ${poolNote}`);
  if (ranked.length > CAP) console.log(`  evaluated the top ${CAP} by VORP; ${ranked.length - CAP} below that not scored`);
  console.log(`  starting-lineup baseline over this window: ${baseline}\n`);
  const hits = targets.filter(t => t.restOfSeasonGain > 0);
  if (hits.length) console.log('  ADD CANDIDATES  (gain assuming a free roster spot — see swaps below for the real number)');
  if (!hits.length) console.log('   nothing available improves your starting lineup.\n');
  hits.slice(0, 15).forEach((t, i) =>
    console.log(`   ${String(i + 1).padStart(2)}. ${(t.name || '').padEnd(24)} ${(t.pos || '').padEnd(4)} +${String(t.restOfSeasonGain).padStart(5)}  (${Math.round(t.owned ?? 0)}% rostered globally)`));
  // Once the roster is full every add forces a drop - in a zero-bench league, always. Only the
  // paired figure answers "should I do this", so the swap is the headline and the raw add is not.
  const shortlist = hits.slice(0, 12);
  if (shortlist.length) {
    const { swaps } = bestSwaps({ roster: myRoster, candidates: shortlist, cfg, fromWeek: week, toWeek });
    const real = swaps.filter(s => s.net > 0);
    console.log(`\n  BEST SWAPS  (add + drop together, net over weeks ${week}-${toWeek})`);
    if (!real.length) console.log('     none — no add/drop pair improves the lineup.');
    real.forEach((s, i) => console.log(
      `   ${String(i + 1).padStart(2)}. +${(s.add.name || '').padEnd(22)} ${(s.add.pos || '').padEnd(4)}`
      + `  for  -${(s.drop.name || '').padEnd(22)} ${(s.drop.pos || '').padEnd(4)}  net +${String(s.net).padStart(5)}`
      + (s.deadDelta > 0 ? `   ⚠ opens ${s.deadDelta} new dead slot${s.deadDelta > 1 ? 's' : ''}`
         : s.deadDelta < 0 ? `   fills ${-s.deadDelta} dead slot${s.deadDelta < -1 ? 's' : ''}` : '')));
  }
  console.log('\n  CHEAPEST DROPS  (cost if dropped with nothing added back):');
  drops.slice(0, 5).forEach(d => console.log(`      ${(d.name || '').padEnd(24)} ${(d.pos || '').padEnd(4)} costs ${d.costToDrop}`));
  console.log('');

// ---------------------------------------------------------------------------------- byes

} else if (cmd === 'byes') {
  header('WEEKS THAT SCORE ZERO IN A STARTING SLOT');
  const weak = weakWeeks(myRoster, cfg, 18, { unavailable });
  if (!weak.length) console.log('   none — every week fields a full, non-zero lineup.');
  let lost = 0;
  for (const w of weak) {
    const what = w.dead.map(d => d.name ? `${d.slot}: ${d.name}` : `${d.slot}: — EMPTY —`).join(', ');
    console.log(`   week ${String(w.week).padStart(2)}  total ${String(w.total).padStart(5)}   ${what}`);
    lost += w.dead.length;
  }
  if (weak.length) {
    console.log(`\n   ${lost} dead starting slot${lost === 1 ? '' : 's'} across ${weak.length} week${weak.length === 1 ? '' : 's'}.`);
    if (!cfg.roster.benchSlots) {
      console.log('   Zero bench: every bye lands here by construction. Only streaming fixes it —');
      console.log('   drop the player on bye, add the best free agent at that slot, each week.');
    } else {
      console.log('   Each of these is a slot you must fill and currently cannot. A bench player who');
      console.log('   never starts can usually be swapped for cover at no cost — check `waivers`.');
    }
  }
  // The raw collision count, kept: it is how you spot trouble building before it bites.
  const rep = byeReport(myRoster, cfg);
  if (rep.length) {
    console.log('\n  BYE COLLISIONS (2+ players out, whether or not it costs you):');
    for (const b of rep) console.log(`   week ${String(b.week).padStart(2)}: ${b.count} out — ${b.players.join(', ')}`);
  }
  console.log('');

} else {
  console.log('usage: node scripts/season.js sync | lineup [week] | roster | waivers [week] [to] | byes   [--at <time>]');
}
