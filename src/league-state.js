// Ground truth about the league AS IT IS RIGHT NOW - not as it was on draft night.
//
// Everything in-season was previously derived from the draft file, which is wrong the moment
// anybody makes a waiver claim: my roster is stale, and the "free agent" pool was the board
// filtered by ESPN's GLOBAL rostered percentage rather than by who is actually unowned in THIS
// league. In a 10-team league half of those "free agents" are sitting on somebody's bench.
//
// This module answers four questions from one ESPN call:
//   - which players does each team own            -> the real free-agent pool
//   - which of mine are currently in a start slot -> what the lineup advice must diff against
//   - who is hurt                                 -> ESPN's own injury designation
//   - what is the schedule                        -> captured now so matchup work needs no refetch
//
// The fetch needs cookies. Everything degrades gracefully without them: callers fall back to the
// draft file and say so, so a fresh public clone with no credentials still works.

import fs from 'node:fs';
import { espnGet } from './espn-live.js';
import { SLOT } from './statmap.js';
import { statePath, ensureDirs } from './league.js';

/** Roster slots that are NOT a starting spot. Everything else counts as started. */
const NON_STARTING = new Set([SLOT.BE, SLOT.IR]);

export const POSITION_BY_ID = {
  1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 7: 'P',
  9: 'DT', 10: 'DE', 11: 'LB', 12: 'CB', 13: 'S', 16: 'DST',
};

const teamName = t => (t.name || `${t.location || ''} ${t.nickname || ''}`).trim();

// ESPN's slot ids are numbers; a readable name helps every caller that prints a lineup.
const SLOT_NAME = Object.fromEntries(Object.entries(SLOT).map(([k, v]) => [v, k]));

/**
 * Pull the whole league in one request.
 *
 * `mRoster` carries each entry's `lineupSlotId`, which is the currently-set lineup - the thing
 * the optimiser has to be compared against. `mTeam` gives records and names, `mMatchup` the
 * schedule. One call, three views, because ESPN rate-limits and this runs on a laptop.
 */
export async function fetchLeagueState(cfg, root) {
  const r = await espnGet(cfg, root, ['mRoster', 'mTeam', 'mMatchup', 'mSettings']);
  if (r.error) return r;
  const d = r.data;

  const teams = (d.teams || []).map(t => ({
    espnId: t.id,
    name: teamName(t),
    wins: t.record?.overall?.wins ?? null,
    losses: t.record?.overall?.losses ?? null,
    ties: t.record?.overall?.ties ?? null,
    pointsFor: t.record?.overall?.pointsFor ?? null,
    roster: (t.roster?.entries || []).map(e => {
      const p = e.playerPoolEntry?.player || {};
      const slotId = e.lineupSlotId;
      return {
        playerId: e.playerId,
        name: p.fullName ?? null,
        pos: POSITION_BY_ID[p.defaultPositionId] ?? (e.playerId < -1 ? 'DST' : null),
        slotId,
        slot: SLOT_NAME[slotId] ?? String(slotId),
        starter: !NON_STARTING.has(slotId),
        injuryStatus: p.injuryStatus ?? null,
        acquisitionType: e.acquisitionType ?? null,
      };
    }),
  }));

  // Team names change mid-season, so match on the configured name but remember the id: once we
  // have stored an id, it stays authoritative even if somebody renames their team.
  const want = String(cfg.myTeamName || '').trim().toLowerCase();
  const me = teams.find(t => t.espnId === cfg.myEspnTeamId)
    || teams.find(t => t.name.toLowerCase() === want);

  const ownedIds = [];
  const ownerByPlayer = {};
  for (const t of teams) {
    for (const p of t.roster) { ownedIds.push(p.playerId); ownerByPlayer[p.playerId] = t.espnId; }
  }

  // Schedule, flattened. Captured now purely as ground truth - nothing consumes it yet.
  const schedule = (d.schedule || []).map(m => ({
    week: m.matchupPeriodId,
    home: m.home ? { espnId: m.home.teamId, score: m.home.totalPoints ?? null } : null,
    away: m.away ? { espnId: m.away.teamId, score: m.away.totalPoints ?? null } : null,
    winner: m.winner ?? null,
  })).filter(m => m.home && m.away);

  return {
    league: cfg.id,
    season: cfg.season,
    fetchedAt: new Date().toISOString(),
    // ESPN's own idea of what week it is - better than defaulting to 1 in every CLI.
    scoringPeriodId: d.scoringPeriodId ?? null,
    currentMatchupPeriod: d.status?.currentMatchupPeriod ?? null,
    myEspnTeamId: me ? me.espnId : null,
    myTeamName: me ? me.name : null,
    teams,
    ownedIds,
    ownerByPlayer,
    schedule,
  };
}

export function saveState(id, state) {
  ensureDirs();
  fs.writeFileSync(statePath(id), JSON.stringify(state, null, 1));
  return statePath(id);
}

export function loadState(id) {
  const p = statePath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Milliseconds since the sync, or null if unknown. Callers decide what counts as stale. */
export function stateAgeMs(state) {
  const t = state?.fetchedAt ? new Date(state.fetchedAt).getTime() : NaN;
  return Number.isFinite(t) ? Date.now() - t : null;
}

export function describeAge(ms) {
  if (ms == null) return 'unknown age';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const myTeam = state => state?.teams?.find(t => t.espnId === state.myEspnTeamId) || null;

/**
 * Join a team's ESPN roster onto the scored board.
 *
 * The board drops anyone projected at 0 points (see build-board), so a player on IR or with no
 * projection will not resolve. Those are returned separately rather than silently vanishing -
 * a missing starter is exactly the kind of thing that should be loud.
 *
 * The ESPN slot is attached as `espnSlot`, NOT `slot`: optimizeLineup builds its output with
 * `{ slot, ...player }`, so a `slot` key on the player would silently overwrite the slot the
 * optimiser just assigned it.
 */
export function resolveRoster(entries, byId) {
  const players = [], missing = [];
  for (const e of entries) {
    const p = byId.get(e.playerId);
    if (p) players.push({ ...p, slotId: e.slotId, espnSlot: e.slot, starter: e.starter, injuryStatus: e.injuryStatus });
    else missing.push(e);
  }
  return { players, missing };
}

/** Ids currently occupying a starting slot - what `lineupDelta` diffs the optimum against. */
export const currentStarterIds = entries => new Set(entries.filter(e => e.starter).map(e => e.playerId));

/**
 * Genuinely available players: on the board, not on ANY roster in this league.
 * This is the pool `waiverTargets` should have been using all along.
 */
export function freeAgents(state, board) {
  const owned = new Set(state.ownedIds);
  return board.players.filter(p => !owned.has(p.id));
}
