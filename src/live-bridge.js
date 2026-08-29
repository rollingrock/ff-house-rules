// Bridges scripts/draft-watch.py (the ESPN websocket sidecar) into the web app.
//
// draft-watch.py owns the socket and publishes data/live/draft_state.json atomically.
// This module only READS that file and translates ESPN team ids into 1..N draft slots,
// so the web UI never has to know which transport produced a pick.
import fs from 'node:fs';
import path from 'node:path';

export function liveFile(root) { return path.join(root, 'data/live/draft_state.json'); }

export function readLiveState(root) {
  try {
    const raw = fs.readFileSync(liveFile(root), 'utf8');
    if (!raw.trim()) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    // Normalise the shapes the rest of this module indexes into. draft-watch.py writes
    // `picks` as a sorted list, but four of its threads write the same temp path without a
    // lock, so a mangled or half-written file is possible. Any surprise here used to throw
    // out of /api/state and blank the entire board mid-draft; now it degrades to "no feed",
    // which is the state the manual-entry fallback is designed for.
    if (!Array.isArray(d.picks)) {
      d.picks = d.picks && typeof d.picks === 'object' ? Object.values(d.picks) : [];
    }
    d.picks = d.picks.filter(p => p && typeof p === 'object');
    if (!Array.isArray(d.order)) d.order = [];
    return d;
  } catch { return null; }
}

/**
 * ESPN team ids are arbitrary (e.g. 1,2,4,7,...). The `order` array gives the team id for
 * every overall pick, so round 1 IS the slot mapping: order[0] is slot 1, order[1] slot 2...
 */
export function slotMap(live, teams) {
  const m = new Map();
  const order = live?.order;
  if (!Array.isArray(order) || order.length < teams) return m;
  for (let i = 0; i < teams; i++) m.set(order[i], i + 1);
  return m;
}

/**
 * Translate the sidecar's picks into the shape DraftState.syncFrom expects.
 * Sorted by overall pick so a missed frame leaves a gap instead of shifting rosters.
 */
export function livePicks(live, teams) {
  if (!live?.picks?.length) return [];
  const m = slotMap(live, teams);
  return live.picks
    .filter(p => p.playerId != null && p.playerId !== -1 && p.playerId !== 0)
    .sort((a, b) => (a.overall ?? 0) - (b.overall ?? 0))
    .map(p => ({
      pickNo: p.overall ?? null,
      round: p.overall ? Math.floor((p.overall - 1) / teams) + 1 : null,
      team: m.get(p.teamId) ?? null,
      playerId: p.playerId,
      auto: p.bySwid === false,
      src: p.src || 'ws',
    }));
}

/** My draft slot, discovered from the socket - removes the need to enter it at 5pm. */
export function liveMySlot(live, teams) {
  if (live?.myTeamId == null) return null;
  return slotMap(live, teams).get(live.myTeamId) ?? null;
}

/** Compact status for the UI header. */
export function liveStatus(root, teams) {
  const live = readLiveState(root);
  if (!live) return { running: false };
  // draft-watch.py writes updatedAt as time.time() - a float epoch in SECONDS. Passing that
  // straight to new Date() reads it as milliseconds and lands in Jan 1970, making every age
  // come out around 56 years and rendering the staleness check meaningless. Accept seconds,
  // milliseconds and ISO strings so it cannot silently break again if the writer changes.
  const raw = live.updatedAt;
  let ts = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) ts = raw < 1e12 ? raw * 1000 : raw;
  else if (typeof raw === 'string') { const d = new Date(raw).getTime(); if (Number.isFinite(d)) ts = d; }
  const age = ts == null ? null : Date.now() - ts;
  return {
    running: true,
    status: live.status || null,
    ws: live.source?.ws || null,
    rest: live.source?.rest || null,
    picks: live.picks?.filter(p => p.playerId > 0 || p.playerId < -1).length ?? 0,
    onTheClock: live.onTheClock || null,
    mySlot: liveMySlot(live, teams),
    staleMs: age,
  };
}
