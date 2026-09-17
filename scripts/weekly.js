// The weekly routine for every league, as one command.
//   node scripts/weekly.js [league ...] [--no-refresh] [--at <time>] [--week <n>]
//
// Refreshes the shared ESPN player dump, rebuilds each league's board, syncs each league, then
// prints only what needs doing this week:
//   - lineup changes that can still be made - a player whose game has started cannot move
//   - starting slots that score zero this week, and the best free-agent stream for each
//   - starters carrying an injury designation, and the next week with a dead slot
// It ends with a to-do list, so a week with nothing to do says exactly that.
//
// The routine used to be a loop of commands per league, and a loop nothing prompts is a loop
// that gets skipped. This is meant to be run blind.
//
//   --no-refresh  skip the dump download and board rebuilds; still syncs. For a quick game-day
//                 re-check when projections were refreshed earlier.
//   --at <time>   judge game locks as of that moment, e.g. --at 2026-09-20T11:00
//   --week <n>    preview a later week against today's rosters - the bye you will need to stream
//
// Deeper questions for one league still belong to season.js: `waivers` over a window, `byes`.
import fs from 'node:fs'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listLeagues, loadConfig, boardPath, rawPath } from '../src/league.js';
import { flexSlots, flexSlotNames } from '../src/score.js';
import {
  optimizeLineup, lineupDelta, weakWeeks, bestSwaps, weekPoints, isBye, isUnavailable, UNAVAILABLE_STATUS,
} from '../src/season.js';
import {
  syncLeague, myTeam, resolveRoster, currentStarterIds, freeAgents, lockInfo, teamKickoff,
  describeAge, describeKickoff,
} from '../src/league-state.js';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const atIdx = argv.indexOf('--at');
const now = atIdx >= 0 ? Date.parse(argv.splice(atIdx, 2)[1]) : Date.now();
if (!Number.isFinite(now)) { console.error('\n  --at wants a date and time, e.g. --at 2026-09-20T11:00\n'); process.exit(1); }
const noRefreshIdx = argv.indexOf('--no-refresh');
if (noRefreshIdx >= 0) argv.splice(noRefreshIdx, 1);
const refresh = noRefreshIdx < 0;
const weekIdx = argv.indexOf('--week');
const weekArg = weekIdx >= 0 ? Number(argv.splice(weekIdx, 2)[1]) : null;
if (weekIdx >= 0 && !(Number.isInteger(weekArg) && weekArg >= 1 && weekArg <= 18)) {
  console.error('\n  --week wants a week number, 1-18\n'); process.exit(1);
}

let cfgs;
try { cfgs = (argv.length ? argv : listLeagues().map(l => l.id)).map(id => loadConfig(id)); }
catch (e) { console.error(`\n  ${e.message}\n`); process.exit(1); }
if (!cfgs.length) { console.error('\n  No league configs found. Create one with scripts/make-league-config.js.\n'); process.exit(1); }

const MATERIAL = 1.0;          // as in `season.js lineup`: below this a change is projection noise
const SEASON_END = 18;
const STREAM_POOL = 8;         // free agents per hole worth pricing as a swap
const round1 = x => Math.round(x * 10) / 10;
const signed = x => (x >= 0 ? `+${x}` : `${x}`);
const span = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// ------------------------------------------------------------------------------ refresh

const run = (script, env = {}) => execFileSync(process.execPath, [path.join(root, 'scripts', script)],
  { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const firstLine = e => String(e.stderr || e.stdout || e.message).trim().split('\n').find(Boolean) || 'failed';
const notes = [];      // anything that went wrong before the report, printed under the banner

console.log('');
if (refresh) {
  process.stdout.write('  refreshing the ESPN player dump ... ');
  try { run('fetch-espn.js'); console.log('ok'); }
  catch (e) { console.log('FAILED'); notes.push(`⚠ player dump did not refresh (${firstLine(e)}) — boards use the previous one`); }
  process.stdout.write(`  rebuilding ${cfgs.length} board${cfgs.length > 1 ? 's' : ''} ... `);
  for (const cfg of cfgs) {
    try {
      const out = run('build-board.js', { LEAGUE: cfg.id });
      for (const l of out.split('\n').filter(l => l.startsWith('!!'))) notes.push(`${cfg.name}: ${l.slice(2).trim()}`);
    } catch (e) { notes.push(`⚠ ${cfg.name}: board did not rebuild (${firstLine(e)}) — using the last one`); }
  }
  console.log('done');
}

// --------------------------------------------------------------------------- per league

/** Slot name -> positions that may fill it, for every starting slot the config has. */
function slotPositions(cfg) {
  const st = cfg.roster.starters, flexNames = flexSlotNames(cfg);
  const out = {};
  for (const s of Object.keys(st)) if (!flexNames.has(s) && s !== 'DP') out[s] = [s];
  for (const f of flexSlots(cfg)) out[f.name] = f.eligible;
  if (st.DP) out.DP = cfg.roster.dpEligible;
  return out;
}

/**
 * A free-agent stream for each starting slot that scores zero this week, with the drop that
 * makes room.
 *
 * Priced two ways because they answer different questions. `thisWeek` is what the stream fixes,
 * and is the reason to act. `net` is the same swap kept for the rest of the season: with no
 * bench the drop is usually the player on bye, and a streamer kept forever is often worse than
 * he was - so a negative net means "get him back, or stream again next week", not "don't".
 *
 * Holes are filled one at a time, each priced on the roster the previous stream left behind, so
 * two holes are never both paid for with the same drop, and an earlier stream is never the drop
 * for a later one. A free agent whose game has started cannot be added, a locked player is never
 * the drop, and a locked zero is not a hole anything can fill.
 */
function streamPicks({ cfg, state, board, roster, week, opts, holes }) {
  const eligible = slotPositions(cfg);
  const wk = p => weekPoints(p, week, cfg) || 0;
  const started = p => { const k = teamKickoff(state, week, p.team); return k != null && k <= now; };
  const pool = freeAgents(state, board).filter(p => !UNAVAILABLE_STATUS.has(p.injury) && !started(p) && wk(p) > 0);

  const picks = [], stuck = new Set(), added = new Set();
  let current = roster;
  for (let i = 0; i < holes; i++) {
    const before = optimizeLineup(current, week, cfg, opts);
    const hole = before.lineup.find(l => (l.empty || !l.wpts) && !l.locked && !stuck.has(l.slot));
    if (!hole) break;
    const fits = new Set(eligible[hole.slot] || []);
    const candidates = pool.filter(p => fits.has(p.pos) && !added.has(p.id))
      .sort((a, b) => wk(b) - wk(a)).slice(0, STREAM_POOL);
    const { swaps } = candidates.length
      ? bestSwaps({
        roster: current, candidates, cfg, fromWeek: week, toWeek: SEASON_END, limit: candidates.length,
        protect: new Set([...opts.locked, ...added]),
      })
      : { swaps: [] };
    const options = swaps
      .map(s => ({
        ...s,
        thisWeek: round1(optimizeLineup(current.filter(p => p.id !== s.drop.id).concat(s.add), week, cfg, opts).total - before.total),
      }))
      .filter(s => s.thisWeek > 0)
      .sort((a, b) => b.thisWeek - a.thisWeek || b.net - a.net);

    picks.push({ slot: hole.slot, best: options[0] || null, next: options[1] || null });
    if (!options[0]) { stuck.add(hole.slot); continue; }
    current = current.filter(p => p.id !== options[0].drop.id).concat(options[0].add);
    added.add(options[0].add.id);
  }
  return picks;
}

function analyse(cfg, state) {
  const board = JSON.parse(fs.readFileSync(boardPath(cfg.id), 'utf8'));
  const byId = new Map(board.players.map(p => [p.id, p]));
  const me = myTeam(state);
  // A later week has no locks (lockInfo only locks the week ESPN is scoring), so a preview is wide open.
  const week = weekArg ?? state.scoringPeriodId;
  const live = week === state.scoringPeriodId;
  const { players: roster } = resolveRoster(me.roster, byId);
  const currentIds = currentStarterIds(me.roster);
  // Today's OUT says nothing about a later week, so a preview goes by projections alone - ESPN
  // zeroes the weeks it is confident a player will miss.
  const unavailable = live ? new Set(roster.filter(isUnavailable).map(p => p.id)) : new Set();
  const { locked, kickoff } = lockInfo(state, me.roster, week, now);
  const opts = { unavailable, locked };

  const d = lineupDelta(roster, currentIds, week, cfg, opts);
  const dead = d.optimal.lineup.filter(l => l.empty || !l.wpts);
  const startingOut = roster.filter(p => currentIds.has(p.id) && unavailable.has(p.id));
  // Somebody the board has never heard of is invisible to the optimiser - loud, not silent.
  const unscored = me.roster.filter(e => e.starter && !byId.has(e.playerId));
  const watch = d.optimal.lineup.filter(l => !l.empty && !locked.has(l.id) && !unavailable.has(l.id)
    && l.injuryStatus && !['ACTIVE', 'NORMAL'].includes(l.injuryStatus));
  // Projections only, for the same reason as a preview.
  const next = weakWeeks(roster, cfg, SEASON_END).find(w => w.week > week) || null;
  const holes = dead.filter(l => !l.locked).length;
  const streams = holes ? streamPicks({ cfg, state, board, roster, week, opts, holes }) : [];

  const period = weekArg ?? state.currentMatchupPeriod ?? week;
  const game = state.schedule.find(g => g.week === period && [g.home.espnId, g.away.espnId].includes(me.espnId));
  const oppId = game && (game.home.espnId === me.espnId ? game.away.espnId : game.home.espnId);
  const opp = state.teams.find(t => t.espnId === oppId) || null;

  return { cfg, state, me, opp, week, d, dead, startingOut, unscored, watch, next, streams, locked, kickoff };
}

const reports = [];
for (const cfg of cfgs) {
  process.stdout.write(`  syncing ${cfg.name} ... `);
  const r = await syncLeague(cfg, root);
  console.log(r.error ? 'FAILED' : 'ok');
  reports.push(r.error ? { cfg, error: r.error } : analyse(cfg, r.state));
}

// ------------------------------------------------------------------------------- report

const ok = reports.filter(r => !r.error);
const week = ok[0]?.week;
const dumpFile = rawPath(`espn-players-${cfgs[0].season}.json`);
const dumpAge = fs.existsSync(dumpFile) ? describeAge(Date.now() - fs.statSync(dumpFile).mtimeMs) : 'MISSING';
const as = atIdx >= 0 ? ` · as of ${describeKickoff(now)}` : '';

console.log(`\n  WEEK ${week ?? '?'} · ${cfgs.length} league${cfgs.length > 1 ? 's' : ''} · player dump ${dumpAge}${as}`);
if (ok.length && week !== ok[0].state.scoringPeriodId) {
  console.log(`  PREVIEW — ESPN is scoring week ${ok[0].state.scoringPeriodId}; this is week ${week} against today's rosters and free agents`);
}
const kicks = Object.values(ok.find(r => r.state.kickoffs)?.state.kickoffs?.[week] || {}).sort((a, b) => a - b);
if (ok.length && !kicks.length) console.log('  ⚠ no kickoff times — game locks were NOT checked');
else if (kicks.length && now < kicks[0]) console.log(`  first kickoff ${describeKickoff(kicks[0])}, ${span(kicks[0] - now)} from now`);
else if (kicks.length && now < kicks.at(-1)) {
  const nextK = kicks.find(k => k > now);
  console.log(`  games under way: ${kicks.filter(k => k <= now).length} of ${kicks.length} teams have kicked off · next ${describeKickoff(nextK)}`);
} else if (kicks.length) console.log('  every game this week has kicked off — nothing left to change');
for (const n of notes) console.log(`  ${n}`);

const record = t => `${t.wins ?? 0}-${t.losses ?? 0}${t.ties ? `-${t.ties}` : ''}`;
const row = p => `${(p.name || '').padEnd(24)} ${(p.pos || '').padEnd(4)} ${String(p.wpts ?? 0).padStart(5)}`;
const hurt = p => (p.injuryStatus && !['ACTIVE', 'NORMAL'].includes(p.injuryStatus)) ? `  ${p.injuryStatus}` : '';
const todo = [];

for (const r of reports) {
  console.log(`\n  ${r.cfg.name}`);
  if (r.error) {
    console.log(`    ⚠ SYNC FAILED — ${r.error}`);
    todo.push(`${r.cfg.name}: sync failed, nothing checked`);
    continue;
  }
  const { d, week: w, locked, kickoff } = r;
  console.log(`    ${r.me.name} ${record(r.me)}${r.opp ? `  vs ${r.opp.name} ${record(r.opp)}` : ''}`);

  const fixable = r.startingOut.filter(p => !locked.has(p.id));
  const material = d.gain >= MATERIAL || fixable.length > 0;
  if (!d.moves.length) console.log('    LINEUP  optimal');
  else {
    const n = d.moves.length, s = n > 1 ? 's' : '';
    console.log(material ? `    LINEUP  ${n} change${s}, +${d.gain}` : `    LINEUP  optimal within ${MATERIAL} pt — ${n} optional tweak${s}`);
    const moves = [...d.moves.filter(m => m.action === 'START'), ...d.moves.filter(m => m.action === 'BENCH')];
    for (const m of moves) {
      const k = kickoff.get(m.id);
      console.log(`            ${m.action.padEnd(5)}  ${row(m)}${hurt(m)}${k ? `   locks ${describeKickoff(k)}` : ''}`);
    }
    if (material) {
      const deadline = moves.map(m => kickoff.get(m.id)).filter(k => k != null && k > now).sort((a, b) => a - b)[0];
      todo.push(`${r.cfg.name}: ${n} lineup change${s} (+${d.gain})${deadline ? `, before ${describeKickoff(deadline)}` : ''}`);
    }
  }
  const tooLate = r.startingOut.filter(p => locked.has(p.id));
  if (tooLate.length) console.log(`    OUT     ${tooLate.map(p => p.name).join(', ')} — ruled out and already locked in, too late to change`);
  if (r.unscored.length) console.log(`    ⚠       starting with no projection on the board: ${r.unscored.map(e => e.name).join(', ')}`);
  if (locked.size) console.log(`    LOCKED  ${locked.size} player${locked.size > 1 ? 's' : ''} whose game has started`);

  if (!r.dead.length) console.log('    DEAD    none this week');
  for (const l of r.dead) {
    const why = l.empty ? '— EMPTY —'
      : `${l.name} (${isBye(l, w) ? 'BYE' : l.injuryStatus && !['ACTIVE', 'NORMAL'].includes(l.injuryStatus) ? l.injuryStatus : 'no projection'}${l.locked ? ', locked' : ''})`;
    console.log(`    DEAD    ${l.slot}: ${why}`);
  }
  for (const s of r.streams) {
    if (!s.best) { console.log(`    STREAM  ${s.slot}: no free agent fills it this week`); continue; }
    const b = s.best;
    console.log(`    STREAM  ${s.slot}: +${b.add.name} (${b.add.pos}, ${weekPoints(b.add, w, r.cfg)})  for  -${b.drop.name}`);
    console.log(`            +${b.thisWeek} this week · ${signed(b.net)} over weeks ${w}-${SEASON_END} if ${b.drop.name} never comes back`
      + (s.next ? ` · else ${s.next.add.name} +${s.next.thisWeek}` : ''));
    todo.push(`${r.cfg.name}: stream ${b.add.name} for ${b.drop.name} at ${s.slot} (+${b.thisWeek} this week)`);
  }

  if (r.watch.length) console.log(`    WATCH   ${r.watch.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}`);
  if (r.next) console.log(`    NEXT    week ${r.next.week} — ${r.next.dead.map(x => `${x.slot}: ${x.name ?? 'EMPTY'}`).join(', ')}`);
}

console.log(todo.length ? '\n  TO DO' : '\n  NOTHING TO DO this week.');
for (const t of todo) console.log(`   - ${t}`);
console.log('');
if (reports.some(r => r.error)) process.exitCode = 1;
