// ff-manager: zero-dependency draft companion server.  node server.js [leagueConfig] [port]
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DraftState } from './src/draft-state.js';
import { recommend, bestLineupPoints, unfilledStarterSlots } from './src/recommend.js';
import { fetchLeagueDraft, haveCookies } from './src/espn-live.js';
import { readLiveState, livePicks, liveMySlot, liveStatus } from './src/live-bridge.js';
import { loadConfig, boardPath, draftPath, ensureDirs } from './src/league.js';

const root = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.argv[3] || 8777);

const cfg = loadConfig(process.argv[2] || process.env.LEAGUE);
const LEAGUE = cfg.id;
ensureDirs();
if (!fs.existsSync(boardPath(LEAGUE))) {
  console.error(`
No board found for "${LEAGUE}".

` +
    `Build one first:
` +
    `  node scripts/fetch-espn.js      # download ESPN projections (once per day is plenty)
` +
    `  node scripts/build-board.js     # score them under this league's rules

` +
    `Expected at: ${boardPath(LEAGUE)}
`);
  process.exit(1);
}
const board = JSON.parse(fs.readFileSync(boardPath(LEAGUE), 'utf8'));
const repl = board.replacement;
const players = board.players;
const byId = new Map(players.map(p => [p.id, p]));
const state = new DraftState(cfg, draftPath(LEAGUE));

// Last thing ESPN told us about the draft order. `orderFinal` is false until ESPN randomises
// the order shortly before the draft, so a slot read before then is provisional.
let leagueInfo = { orderFinal: false, mySlot: null, teamNames: null, teamIdBySlot: null, checkedAt: null };

// Per-manager draft tendencies from this league's 2024-2025 drafts, keyed by ESPN team id.
// Team ids persist across seasons; the 5PM randomisation only shuffles which SLOT each team
// drafts from, so these survive the reshuffle once we know the slot->teamId mapping.
let opponentProfiles = null;
try {
  opponentProfiles = JSON.parse(fs.readFileSync(
    path.join(root, 'data/history/opponent-profiles.json'), 'utf8')).profiles || null;
} catch { /* optional */ }

// ---- fuzzy search over player names -------------------------------------------------
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
const index = players.map(p => {
  const n = norm(p.name);
  const parts = n.split(' ');
  return {
    p, n, parts,
    // Surname must skip generational suffixes, or "James Cook III" has a surname of "iii"
    // and typing `cook` lands on Bryan Cook instead. Same for Jr / Sr / II / IV / V.
    last: (parts.filter(w => !/^(jr|sr|ii|iii|iv|v)$/.test(w)).pop()) || parts[parts.length - 1],
    flat: n.replace(/ /g, ''),                      // "christianmccaffrey"
    initials: parts.map(w => w[0]).join(''),        // "cm"
  };
});
/** Is `q` a subsequence of `t`? Lets "cmc" match christian mccaffrey, "stbrown" St. Brown. */
function subseq(q, t) {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}
function search(q, taken, limit = 12) {
  const nq = norm(q);
  if (!nq) return [];
  const out = [];
  for (const e of index) {
    if (taken.has(e.p.id)) continue;
    let s = 0;
    // SURNAME OUTRANKS FIRST NAME. Fantasy players are named by surname, so typing `chase`
    // means Ja'Marr Chase, not Chase Brown; `taylor` means Jonathan Taylor, not Taylor Rapp.
    // The old order scored a first-name prefix 800 and a surname prefix 700, so a scrub whose
    // FIRST name matched beat the star whose SURNAME did - a live mis-draft risk on a 30s clock.
    if (e.n === nq) s = 1000;
    else if (e.last.startsWith(nq)) s = 850 - e.n.length;
    else if (e.n.startsWith(nq)) s = 800 - e.n.length;
    else if (e.n.includes(nq)) s = 500 - e.n.length;
    else {
      const parts = e.parts;
      // any word prefix: "njigba" -> Smith-Njigba, "achane" -> De'Von Achane
      if (parts.some(w => w.startsWith(nq))) s = 640 - e.n.length;
      // initials + surname: "jgibbs", "cmccaffrey"
      else if ((e.initials + e.last).startsWith(nq)) s = 600;
      // initials only: "jsn" -> Jaxon Smith-Njigba, "cmc" -> Christian McCaffrey
      else if (nq.length >= 2 && (e.initials.startsWith(nq)
               || (e.initials + e.last[0]).startsWith(nq)
               || subseq(nq, e.initials + e.last))) s = 560;
      // de-spaced subsequence: "stbrown" -> amonra st brown, "mccaff" -> mccaffrey
      else if (nq.length >= 3 && subseq(nq, e.flat)) s = 520 - e.n.length;
      else continue;
    }
    // Tie-break on draft relevance so equal-quality matches favour the player actually worth
    // drafting: rostered% plus an ADP bonus that decays to nothing by pick ~150.
    const adpBonus = e.p.adp == null ? 0 : Math.max(0, 60 - e.p.adp / 2.5);
    out.push({ ...e.p, _s: s + Math.min(80, (e.p.owned || 0)) + adpBonus });
  }
  out.sort((a, b) => b._s - a._s);
  return out.slice(0, limit);
}

// ---- snapshot the whole view the UI needs -------------------------------------------
/**
 * Pull anything the draft-watch.py sidecar has seen on the ESPN socket.
 * Safe to call constantly: syncFrom() dedupes by player id.
 */
function absorbLive() {
  try {
    return absorbLiveInner();
  } catch (e) {
    // The live feed must never be able to take down the board. Manual entry is the
    // guaranteed path and it needs /api/state to keep answering.
    liveError = String(e?.message || e);
    return 0;
  }
}
let liveError = null;
function absorbLiveInner() {
  const live = readLiveState(root);
  if (!live) return 0;
  if (state.mySlot == null) {
    const s = liveMySlot(live, cfg.teams);
    if (s) { state.mySlot = s; state.save(); }
  }
  return state.syncFrom(livePicks(live, cfg.teams), byId);
}

function snapshot() {
  absorbLive();
  const taken = state.takenIds;
  const available = players.filter(p => !taken.has(p.id));
  // Unknown placeholders hold their pick slot but contribute nothing to the roster maths.
  const myRoster = state.myRoster().map(p => byId.get(p.playerId)).filter(Boolean);
  // My upcoming pick, and the one after it. When I am ON the clock, the horizon that matters
  // for "can I wait?" is my NEXT turn, not this one.
  const myUpcoming = state.nextMyPick(state.currentPickNo - 1);
  const myAfterThat = state.nextMyPick(myUpcoming || 0);
  const horizon = state.isMyTurn ? myAfterThat : myUpcoming;
  // Who picks between now and my next turn, and what has each of them already drafted?
  // This is what turns "who does the market take" into "what will THESE teams take".
  const upcoming = [];
  if (horizon) {
    for (let n = state.currentPickNo; n < horizon; n++) {
      const team = state.order[n - 1];
      if (team == null || team === state.mySlot) continue;
      upcoming.push({ team, round: Math.floor((n - 1) / cfg.teams) + 1 });
    }
  }
  // Re-key the historical profiles by draft SLOT for whatever order is currently in force.
  let profilesBySlot = null;
  if (opponentProfiles && leagueInfo.teamIdBySlot) {
    profilesBySlot = {};
    for (const [slot, espnId] of Object.entries(leagueInfo.teamIdBySlot)) {
      const p = opponentProfiles[String(espnId)];
      if (p) profilesBySlot[slot] = p;
    }
  }

  const rostersByTeam = {};
  for (let t = 1; t <= cfg.teams; t++) {
    rostersByTeam[t] = state.rosterOf(t).map(p => byId.get(p.playerId)).filter(Boolean);
  }

  // What do the teams between me and my next pick still need? This is the single most useful
  // thing the opponent model knows, so surface it rather than burying it in probabilities.
  const upcomingNeeds = {};
  const seenTeams = new Set();
  for (const u of upcoming) {
    if (seenTeams.has(u.team)) continue;
    seenTeams.add(u.team);
    for (const slot of unfilledStarterSlots(rostersByTeam[u.team] || [], cfg)) {
      if (slot === 'K' || slot === 'DST' || slot === 'DP') continue;   // nobody takes these yet
      upcomingNeeds[slot] = (upcomingNeeds[slot] || 0) + 1;
    }
  }

  const { ranked, runs, opponentAware } = recommend({
    available, myRoster, currentPick: state.currentPickNo,
    nextPick: horizon, upcoming, rostersByTeam, profiles: profilesBySlot,
    cfg, repl, recentPicks: state.picks.slice(-12).map(p => byId.get(p.playerId)).filter(Boolean),
    round: state.currentRound,
    rosterKnown: state.mySlot != null,
  });
  const lineup = bestLineupPoints(myRoster, cfg, repl);
  const starterIds = new Set(lineup.starters.map(p => p.id));
  return {
    league: cfg.name, mySlot: state.mySlot, teams: cfg.teams, rounds: cfg.draft.rounds,
    // A slot set on an earlier day is almost certainly stale - the order randomises at 5PM.
    slotStale: !!(state.mySlot != null && state.picks.length === 0 &&
      (!state.slotSetAt || state.slotSetAt.slice(0, 10) !== new Date().toISOString().slice(0, 10))),
    pickNo: state.currentPickNo, round: state.currentRound, onTheClock: state.onTheClock,
    isMyTurn: state.isMyTurn, untilMyTurn: state.picksUntilMyTurn(),
    myPicks: state.myPickNumbers(), nextPick: myUpcoming, horizon,
    horizonWindow: horizon ? horizon - state.currentPickNo : null,
    complete: state.picks.length >= state.totalPicks,
    recs: ranked.filter(r => r.score > -900).slice(0, 40),
    blocked: ranked.filter(r => r.score <= -900).slice(0, 8),
    runs,
    roster: myRoster.map(p => ({ ...p, starter: starterIds.has(p.id) })),
    lineupTotal: Math.round(lineup.total),
    recent: state.picks.slice(-14).reverse(),
    rosters: Object.fromEntries(Array.from({ length: cfg.teams }, (_, i) => [i + 1,
      state.rosterOf(i + 1).map(p => ({ name: p.name, pos: p.pos }))])),
    replacement: repl,
    espnLinked: haveCookies(root),
    unknownPicks: state.unknownPicks || 0,
    teamNames: leagueInfo.teamNames,
    opponentAware: !!opponentAware,
    profiledOpponents: opponentAware && profilesBySlot ? Object.keys(profilesBySlot).length : 0,
    upcomingNeeds, upcomingTeamCount: seenTeams.size,
    espnOrderFinal: leagueInfo.orderFinal,
    espnSlot: leagueInfo.mySlot,
    slotProvisional: !!(state.mySlot != null && leagueInfo.checkedAt && !leagueInfo.orderFinal),
    live: liveStatus(root, cfg.teams),
    counts: available.reduce((a, p) => { a[p.pos] = (a[p.pos] || 0) + 1; return a; }, {}),
  };
}

// ---- http ----------------------------------------------------------------------------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  // Buffers (static files) must pass through untouched - JSON.stringify would turn them into
  // {"type":"Buffer","data":[...]} and the browser would render that literal text.
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const P = url.pathname;
  try {
    if (P === '/api/state') return send(res, 200, snapshot());
    if (P === '/api/search') return send(res, 200, search(url.searchParams.get('q') || '', state.takenIds));
    if (P === '/api/player') {
      const p = byId.get(Number(url.searchParams.get('id')));
      return send(res, p ? 200 : 404, p || { error: 'not found' });
    }
    if (req.method === 'POST') {
      const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      const j = body ? JSON.parse(body) : {};
      if (P === '/api/pick') {
        const p = byId.get(Number(j.id));
        if (!p) return send(res, 400, { error: 'unknown player' });
        state.addPick(p, j.team ?? null);
        return send(res, 200, snapshot());
      }
      if (P === '/api/undo') {
        // snapshot() re-absorbs the live feed, so undoing a pick the sidecar has already
        // reported puts it straight back. That is the right outcome - ESPN is the source of
        // truth - but the UI used to toast "Undid last pick." either way. Report what happened.
        const before = state.picks.length;
        state.undo();
        const snap = snapshot();
        snap.undone = state.picks.length < before;
        return send(res, 200, snap);
      }
      if (P === '/api/reset') { state.reset(); return send(res, 200, snapshot()); }
      if (P === '/api/slot') {
        state.mySlot = Number(j.slot) || null;
        state.slotSetAt = new Date().toISOString();
        state.save();
        return send(res, 200, snapshot());
      }
      if (P === '/api/sync') {
        // 1. the websocket sidecar is the real live feed
        let added = absorbLive();
        // 2. mDraftDetail sits FROZEN during a live draft (measured), so it is only a
        //    belt-and-braces reconcile - never the primary path.
        if (haveCookies(root)) {
          const r = await fetchLeagueDraft(cfg, root);
          if (!r.error) {
            added += state.syncFrom(r.picks, byId);
            leagueInfo = {
              orderFinal: r.orderFinal, mySlot: r.mySlot, teamNames: r.teamNames,
              teamIdBySlot: r.teamIdBySlot, checkedAt: new Date().toISOString(),
            };
            // Adopt ESPN's slot when the order is locked in, or when we have nothing at all.
            // Before the 5PM randomisation the order is a placeholder, so only take it
            // provisionally - and always re-take it once ESPN says it is final.
            if (r.mySlot && (r.orderFinal || state.mySlot == null)) {
              if (state.mySlot !== r.mySlot) {
                state.mySlot = r.mySlot;
                state.slotSetAt = new Date().toISOString();
                state.save();
              }
            }
          } else if (!added && !readLiveState(root)) {
            return send(res, 200, { synced: 0, error: r.error });
          }
        } else if (!readLiveState(root)) {
          return send(res, 200, { synced: 0, error: 'no ESPN auth and draft-watch.py is not running - manual entry mode' });
        }
        return send(res, 200, { synced: added, ...snapshot() });
      }
    }
    // static
    const file = P === '/' ? '/index.html' : P;
    const fp = path.join(root, 'web', file);
    if (fp.startsWith(path.join(root, 'web')) && fs.existsSync(fp)) {
      return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'text/plain');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

/** First non-internal IPv4, so the phone on the same wifi can reach this as a second screen. */
function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces || [])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

/**
 * Pull the league's draft order once at startup so the very first page render already knows
 * the team names and whether the slot it is showing is still provisional. Best-effort: a
 * failure here must never stop the server from coming up.
 */
async function primeLeagueInfo() {
  if (!haveCookies(root)) return;
  try {
    const r = await fetchLeagueDraft(cfg, root);
    if (r.error) { console.log(`  espn: ${r.error}`); return; }
    state.syncFrom(r.picks, byId);
    leagueInfo = {
      orderFinal: r.orderFinal, mySlot: r.mySlot, teamNames: r.teamNames,
      teamIdBySlot: r.teamIdBySlot, checkedAt: new Date().toISOString(),
    };
    if (r.mySlot && (r.orderFinal || state.mySlot == null)) {
      state.mySlot = r.mySlot;
      state.slotSetAt = new Date().toISOString();
      state.save();
    }
    console.log(`  espn: slot ${r.mySlot ?? '?'} (${r.orderFinal ? 'ORDER FINAL' : 'order not randomised yet - provisional'})`
      + `, ${r.picks.length} picks on the board`);
  } catch (e) { console.log(`  espn: ${e.message}`); }
}

server.listen(PORT, '0.0.0.0', async () => {
  const lan = lanAddress();
  console.log(`\n  ff-manager  ->  http://localhost:${PORT}`);
  if (lan) console.log(`  on your phone ->  http://${lan}:${PORT}   (same wifi)`);
  console.log(`  league: ${cfg.name} | ${players.length} players scored | my slot: ${state.mySlot ?? 'NOT SET'}`);
  console.log(`  board built: ${board.generatedAt || 'unknown'} | adp: ${board.adpSource || 'espn'}`);
  console.log(`  espn cookies: ${haveCookies(root) ? 'linked' : 'not linked (manual entry mode)'}`);
  await primeLeagueInfo();
  console.log('');
});
