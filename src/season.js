// In-season engine: weekly lineup optimization + waiver/FA recommendations.
// Reuses the exact same scoring and replacement-level machinery as the draft board.
import { scoreStats, scoreDstBrackets, flexSlots, flexSlotNames } from './score.js';
import { STAT } from './statmap.js';

/** Score one player's projection for a single week under league scoring. */
export function weekPoints(player, week, cfg) {
  if (player.wk && player.wk[week] != null) return player.wk[week];   // precomputed by build-board
  const w = player.weekly?.[week];
  if (!w) return null;
  let pts = scoreStats(w, player.pos, cfg);
  if (player.pos === 'DST') pts += scoreDstBrackets([w], cfg) / 17;
  return Math.round(pts * 10) / 10;
}

/**
 * Is this player on bye this week? ESPN emits the week with a value of 0 rather than
 * omitting it, so an absent week and a 0 week both mean "not playing".
 */
export const isBye = (player, week) => {
  if (player.wk) { const v = player.wk[week]; return v == null || v === 0; }
  return !player.weekly?.[week];
};

/**
 * ESPN designations meaning the player will not take a snap. Their weekly PROJECTION is often
 * still non-zero - ESPN projects the role, not the availability - so an optimiser that trusts
 * projections alone will cheerfully tell you to start someone who has been ruled out.
 * DOUBTFUL is deliberately absent: it is surfaced as a warning and left to the manager.
 */
export const UNAVAILABLE_STATUS = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION']);
export const isUnavailable = p => UNAVAILABLE_STATUS.has(p?.injuryStatus);

/**
 * Optimal starting lineup for a week. Exhaustive over flex/DP assignment, which is
 * tiny here (one FLEX, one DP), so this is genuinely optimal rather than greedy.
 *
 * Players whose id is in `opts.unavailable` are never assigned a slot, but they still appear
 * on the bench: a ruled-out starter should stay visible, not quietly disappear.
 */
export function optimizeLineup(roster, week, cfg, opts = {}) {
  const st = cfg.roster.starters;
  const blocked = opts.unavailable || new Set();
  const pool = roster
    .map(p => ({ ...p, wpts: weekPoints(p, week, cfg) }))
    .filter(p => p.wpts != null);
  const bye = roster.filter(p => isBye(p, week));

  const byPos = {};
  for (const p of pool) { if (!blocked.has(p.id)) (byPos[p.pos] ||= []).push(p); }
  for (const k in byPos) byPos[k].sort((a, b) => b.wpts - a.wpts);

  const used = new Set();
  const lineup = [];
  const fill = (slot, pos, n) => {
    for (let i = 0; i < n; i++) {
      const p = (byPos[pos] || []).find(x => !used.has(x.id));
      if (p) { used.add(p.id); lineup.push({ slot, ...p }); }
      else lineup.push({ slot, empty: true });
    }
  };
  const FLEXNAMES = flexSlotNames(cfg);
  for (const [pos, n] of Object.entries(st)) {
    if (FLEXNAMES.has(pos) || pos === 'DP') continue;
    fill(pos, pos, n);
  }
  // FLEX: best remaining flex-eligible
  for (const fs of flexSlots(cfg)) {
    for (let i = 0; i < fs.n; i++) {
      const cand = fs.eligible.flatMap(x => byPos[x] || [])
        .filter(x => !used.has(x.id)).sort((a, b) => b.wpts - a.wpts)[0];
      if (cand) { used.add(cand.id); lineup.push({ slot: fs.name, ...cand }); }
      else lineup.push({ slot: fs.name, empty: true });
    }
  }
  // DP
  for (let i = 0; i < (st.DP || 0); i++) {
    const cand = cfg.roster.dpEligible.flatMap(x => byPos[x] || [])
      .filter(x => !used.has(x.id)).sort((a, b) => b.wpts - a.wpts)[0];
    if (cand) { used.add(cand.id); lineup.push({ slot: 'DP', ...cand }); }
    else lineup.push({ slot: 'DP', empty: true });
  }
  const bench = pool.filter(p => !used.has(p.id)).sort((a, b) => b.wpts - a.wpts);
  const total = lineup.reduce((a, b) => a + (b.wpts || 0), 0);
  return { lineup, bench, bye, total: Math.round(total * 10) / 10 };
}

/**
 * What the CURRENT lineup costs vs. optimal. This is the actionable number:
 * lineup protection is OFF in these leagues, so nobody swaps injured starters for you.
 *
 * A ruled-out player already in the lineup still scores zero, so his projection is not
 * counted toward the current total - otherwise the tool would understate what a swap is worth.
 */
export function lineupDelta(roster, currentStarterIds, week, cfg, opts = {}) {
  const blocked = opts.unavailable || new Set();
  const opt = optimizeLineup(roster, week, cfg, opts);
  const wp = p => (blocked.has(p.id) ? 0 : (weekPoints(p, week, cfg) || 0));
  const cur = roster.filter(p => currentStarterIds.has(p.id)).reduce((a, p) => a + wp(p), 0);
  const moves = [];
  const optIds = new Set(opt.lineup.filter(l => !l.empty).map(l => l.id));
  for (const p of roster) {
    if (currentStarterIds.has(p.id) && !optIds.has(p.id)) moves.push({ action: 'BENCH', ...p, wpts: weekPoints(p, week, cfg) });
    if (!currentStarterIds.has(p.id) && optIds.has(p.id)) moves.push({ action: 'START', ...p, wpts: weekPoints(p, week, cfg) });
  }
  // Biggest swing first: with several moves the first one is the one that matters.
  moves.sort((a, b) => (b.wpts || 0) - (a.wpts || 0));
  return { optimal: opt, currentPoints: Math.round(cur * 10) / 10, gain: Math.round((opt.total - cur) * 10) / 10, moves };
}

/**
 * Waiver / free-agent targets. Ranked by how much they would actually improve my
 * STARTING lineup over the remaining weeks - not by raw points, which just surfaces
 * players at positions I am already strong.
 */
export function waiverTargets({ roster, available, cfg, fromWeek, toWeek = 18, limit = 25 }) {
  const weeks = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const baseline = weeks.reduce((a, w) => a + optimizeLineup(roster, w, cfg).total, 0);

  const scored = available.map(p => {
    const withHim = weeks.reduce((a, w) => a + optimizeLineup([...roster, p], w, cfg).total, 0);
    return { ...p, restOfSeasonGain: Math.round((withHim - baseline) * 10) / 10 };
  });
  scored.sort((a, b) => b.restOfSeasonGain - a.restOfSeasonGain);

  // who I would drop: my lowest rest-of-season contributor
  const droppable = roster.map(p => {
    const without = roster.filter(x => x.id !== p.id);
    const w = weeks.reduce((a, wk) => a + optimizeLineup(without, wk, cfg).total, 0);
    return { ...p, costToDrop: Math.round((baseline - w) * 10) / 10 };
  }).sort((a, b) => a.costToDrop - b.costToDrop);

  return { targets: scored.slice(0, limit), drops: droppable.slice(0, 8), baseline: Math.round(baseline) };
}

/** Bye-week collisions across the roster - the thing that quietly loses weeks. */
export function byeReport(roster, cfg, weeks = 18) {
  const out = [];
  for (let w = 1; w <= weeks; w++) {
    const off = roster.filter(p => isBye(p, w));
    if (off.length >= 2) out.push({ week: w, count: off.length, players: off.map(p => `${p.name} (${p.pos})`) });
  }
  return out.sort((a, b) => b.count - a.count);
}
