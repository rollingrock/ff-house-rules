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
 * Is this player on bye this week?
 *
 * A zero week does NOT mean bye. ESPN empties the weekly stat line for anyone it expects to
 * miss, so "no projection" covers two very different situations: the team's scheduled bye,
 * which is structural and known in August, and an injury ESPN has priced in, which is news.
 * Reporting the second as a bye hides exactly the thing worth acting on. Prefer the board's
 * `bye` field, and keep the old zero heuristic only for players that lack one.
 */
export const isBye = (player, week) => {
  if (player.bye != null) return player.bye === week;
  if (player.wk) { const v = player.wk[week]; return v == null || v === 0; }
  return !player.weekly?.[week];
};

/**
 * Projected zero in a week that is NOT his bye — ESPN has zeroed the line because it does
 * not expect him to play. Worth surfacing loudly: it is the earliest signal the feed carries.
 */
export function isZeroProjected(player, week) {
  const v = player.wk ? player.wk[week] : player.weekly?.[week];
  return (v == null || v === 0) && !isBye(player, week);
}

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

/**
 * The actual in-season transaction: add somebody AND drop somebody, evaluated as one move.
 *
 * waiverTargets scores an add as though the roster could just grow, and a drop as though
 * nothing replaced it. Those two numbers do not compose - and in a zero-bench league they are
 * meaningless on their own, because every add forces a drop. This searches (add, drop) pairs
 * and returns the net change to the starting lineup over the window, which is the only figure
 * that answers "should I do this".
 *
 * Cost is O(candidates x roster x weeks x optimizeLineup), so pass a shortlist of candidates.
 */
export function bestSwaps({ roster, candidates, cfg, fromWeek, toWeek = 18, limit = 10, protect }) {
  const weeks = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const total = r => weeks.reduce((a, w) => a + optimizeLineup(r, w, cfg).total, 0);
  const baseline = total(roster);
  const keep = protect || new Set();

  const out = [];
  for (const add of candidates) {
    let best = null;
    for (const drop of roster) {
      if (keep.has(drop.id)) continue;
      const after = total(roster.filter(p => p.id !== drop.id).concat(add));
      const net = after - baseline;
      if (!best || net > best.net) best = { drop, net };
    }
    if (best) out.push({ add, drop: best.drop, net: Math.round(best.net * 10) / 10 });
  }
  out.sort((a, b) => b.net - a.net);
  return { swaps: out.slice(0, limit), baseline: Math.round(baseline) };
}

/**
 * Weeks where a STARTING slot scores nothing - the actionable form of a bye report.
 *
 * Counting how many players are out is the wrong question: two backups on bye cost nothing,
 * while one kicker on bye with no second kicker is a guaranteed zero in a slot you must fill.
 * What matters is whether a slot ends up empty or occupied by somebody projected at zero.
 *
 * In a zero-bench league every single bye lands here by construction, which is the correct
 * answer: that format is not solved by roster shape, only by streaming.
 */
export function weakWeeks(roster, cfg, weeks = 18, opts = {}) {
  const out = [];
  for (let w = 1; w <= weeks; w++) {
    const o = optimizeLineup(roster, w, cfg, opts);
    const dead = o.lineup
      .filter(l => l.empty || !l.wpts)
      .map(l => ({ slot: l.slot, name: l.empty ? null : l.name, pos: l.empty ? null : l.pos }));
    if (dead.length) out.push({ week: w, total: o.total, dead });
  }
  return out;
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
