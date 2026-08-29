// Optional ESPN private-league sync. Everything degrades gracefully when cookies are absent.
import fs from 'node:fs';
import path from 'node:path';

// Two conventions exist in this repo; accept either, and either casing of SWID.
const AUTH_FILES = ['local/espn-auth.json', 'config/espn-cookies.json'];
export function readCookies(root) {
  for (const rel of AUTH_FILES) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
      const swid = c.SWID || c.swid;
      if (c.espn_s2 && swid) return { espn_s2: c.espn_s2, SWID: swid };
    } catch {}
  }
  return null;
}
export const haveCookies = root => !!readCookies(root);

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

async function espnGet(cfg, root, views) {
  const c = readCookies(root);
  if (!c) return { error: 'no espn cookies — see SETUP.md' };
  const swid = c.SWID.startsWith('{') ? c.SWID : `{${c.SWID}}`;
  const url = `${BASE}/${cfg.season}/segments/0/leagues/${cfg.espnLeagueId}?${views.map(v => `view=${v}`).join('&')}`;
  try {
    const r = await fetch(url, {
      headers: { cookie: `espn_s2=${c.espn_s2}; SWID=${swid}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) return { error: 'ESPN rejected the cookies (401) — they may have expired' };
    if (!r.ok) return { error: `ESPN returned ${r.status}` };
    return { data: await r.json() };
  } catch (e) { return { error: `ESPN request failed: ${e.message}` }; }
}

const teamName = t => (t.name || `${t.location || ''} ${t.nickname || ''}`).trim();

/**
 * Pull the draft board plus the authoritative slot mapping.
 *
 * Two things learned from the live league: ESPN team ids are NOT contiguous (this league runs
 * 1-10,12,13 - there is no team 11), so slots must come from `settings.draftSettings.pickOrder`
 * rather than being inferred; and ESPN pads team names with trailing spaces, so name matching
 * has to be trimmed.
 *
 * `orderType: "DRAFT_START"` means the order shown is a PLACEHOLDER until it is randomised
 * shortly before the draft, so the caller is told whether the order can be trusted yet.
 */
export async function fetchLeagueDraft(cfg, root) {
  const r = await espnGet(cfg, root, ['mDraftDetail', 'mTeam', 'mSettings']);
  if (r.error) return r;
  const d = r.data;
  const teams = d.teams || [];
  const ds = d.settings?.draftSettings || {};
  const picksRaw = d.draftDetail?.picks || [];

  // slot mapping: pickOrder is authoritative; fall back to round-1 pick order.
  const slotOf = new Map();
  if (Array.isArray(ds.pickOrder) && ds.pickOrder.length) {
    ds.pickOrder.forEach((teamId, i) => slotOf.set(teamId, i + 1));
  } else {
    picksRaw.filter(p => p.roundId === 1)
      .sort((a, b) => a.roundPickNumber - b.roundPickNumber)
      .forEach((p, i) => slotOf.set(p.teamId, i + 1));
  }

  const picks = picksRaw
    .filter(p => p.playerId && p.playerId !== -1)
    .sort((a, b) => (a.overallPickNumber || 0) - (b.overallPickNumber || 0))
    .map(p => ({
      pickNo: p.overallPickNumber, round: p.roundId,
      team: slotOf.get(p.teamId) ?? null, espnTeamId: p.teamId,
      playerId: p.playerId, auto: !!p.autoDraftTypeId, src: 'rest',
    }));

  const want = String(cfg.myTeamName || '').trim().toLowerCase();
  const me = teams.find(t => teamName(t).toLowerCase() === want);

  // The order is only trustworthy once ESPN has locked it in.
  const orderFinal = ds.orderType !== 'DRAFT_START' || !!d.draftDetail?.drafted
    || !!d.draftDetail?.inProgress || picks.length > 0;

  const teamIdBySlot = {};
  for (const [espnId, slot] of slotOf) teamIdBySlot[slot] = espnId;

  return {
    picks, teamIdBySlot,
    mySlot: me ? (slotOf.get(me.id) ?? null) : null,
    myEspnTeamId: me ? me.id : null,
    orderFinal,
    orderType: ds.orderType || null,
    draftDate: ds.date || null,
    skeletonOnly: picksRaw.length > 0 && picks.length === 0,
    drafted: !!d.draftDetail?.drafted,
    inProgress: !!d.draftDetail?.inProgress,
    teamNames: Object.fromEntries(teams.map(t => [slotOf.get(t.id) ?? `espn${t.id}`, teamName(t)])),
  };
}

/** In-season: my roster + everyone's, for lineup and waiver work. */
export async function fetchRosters(cfg, root, week) {
  const r = await espnGet(cfg, root, ['mRoster', 'mTeam', 'mMatchup']);
  if (r.error) return r;
  return { teams: (r.data.teams || []).map(t => ({
    id: t.id, name: t.name || `${t.location || ''} ${t.nickname || ''}`.trim(),
    roster: (t.roster?.entries || []).map(e => ({
      playerId: e.playerId, slotId: e.lineupSlotId,
      name: e.playerPoolEntry?.player?.fullName,
    })),
  })) };
}
