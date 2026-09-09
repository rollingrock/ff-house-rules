// The draft brain: marginal lineup value + ADP survival -> VONA-style pick recommendation.
import { survivalCurve, survivalCurveOpponentAware, isCensoredAdp, flexSlots, flexSlotNames } from './score.js';

/** Optimal starting-lineup points. Unfilled slots fall back to replacement level. */
export function bestLineupPoints(roster, cfg, repl) {
  const st = cfg.roster.starters, flexElig = cfg.roster.flexEligible, dpElig = cfg.roster.dpEligible;
  const pool = {};
  for (const p of roster) (pool[p.pos] ||= []).push(p);
  for (const k in pool) pool[k].sort((a, b) => b.pts - a.pts);
  const take = (pos, n) => (pool[pos] || []).splice(0, n);

  let total = 0, used = [];
  for (const [pos, n] of Object.entries(st)) {
    if (pos === 'FLEX' || pos === 'DP') continue;
    const got = take(pos, n);
    used.push(...got);
    total += got.reduce((a, b) => a + b.pts, 0);
    total += (n - got.length) * (repl[pos] ?? 0);          // empty slot = replacement player
  }
  // FLEX
  const flexTaken = new Set(used.map(p => p.id));
  for (const fs of flexSlots(cfg)) {
    const fp = fs.eligible.flatMap(p => pool[p] || [])
      .filter(p => !flexTaken.has(p.id)).sort((a, b) => b.pts - a.pts);
    const got = fp.slice(0, fs.n);
    for (const g of got) flexTaken.add(g.id);
    used.push(...got);
    total += got.reduce((a, b) => a + b.pts, 0);
    const fallback = Math.max(...fs.eligible.map(p => repl[p] ?? 0), 0);
    total += (fs.n - got.length) * fallback;
  }
  // DP
  const dpPool = dpElig.flatMap(p => pool[p] || []).sort((a, b) => b.pts - a.pts);
  const dN = st.DP || 0;
  const dpGot = dpPool.slice(0, dN);
  used.push(...dpGot);
  total += dpGot.reduce((a, b) => a + b.pts, 0);
  total += (dN - dpGot.length) * (repl.LB ?? 0);
  return { total, starters: used };
}

/** How much does adding this player improve my optimal starting lineup? */
export function marginalValue(player, roster, cfg, repl) {
  const before = bestLineupPoints(roster, cfg, repl).total;
  const after = bestLineupPoints([...roster, player], cfg, repl).total;
  const lineupGain = after - before;

  // Depth/insurance value: quality over replacement, scaled up when I am THIN at the position
  // (a 3rd WR when I own two is worth far more than a 6th RB).
  const depth = (player.pts - (repl[player.pos] ?? 0)) * cfg.tuning.benchWeight
    + thinnessBonus(player, roster, cfg, repl);

  // MAX, never either/or. Branching on `lineupGain > 0` put the two valuations on different
  // scales and made the function non-monotone in projected points: a player good enough to
  // crack the lineup got only his *incremental* upgrade (small, because the incumbent is good),
  // while a slightly worse player who missed the cut got a large fraction of full VORP. That
  // inverted the board in a band starting at the current worst starter - exactly where the best
  // available player sits mid-draft. Both terms are monotone in pts, so their max is too.
  // ...but max() alone leaves a FLAT REGION. lineupGain is exactly 0 for everyone who does not
  // crack the lineup, and depth is negative for everyone below replacement, so max(0, negative)
  // collapses the whole sub-replacement pool to exactly 0. Measured: by round 13 the entire
  // visible top-40 scored the same, i.e. rounds 13-16 - a quarter of the draft - were ordered
  // arbitrarily. Falling through to `depth` there restores the ordering and stays monotone in
  // points: both branches are increasing in pts, and they agree where depth crosses zero.
  const m = Math.max(lineupGain, depth);
  return m > 0 ? m : depth;
}

/**
 * Bye-week collision cost.
 *
 * marginalValue works in SEASON totals, so it is blind to when the points arrive. Measured on a
 * real drafted roster, a week with three starters on bye scored 131 against a 151 clean-week
 * average - a 20-point hole, about the margin of a typical head-to-head game. Concentrated losses
 * hurt more than spread ones in H2H: 20 points gone from one week probably flips that game, while
 * the same 20 spread over 14 weeks flips nothing.
 *
 * So this prices only the concentration, not the player. It asks: in THIS player's bye week, how
 * far below my normal output does my lineup already sit? Adding him deepens a hole that already
 * exists. Returns a positive number of points to subtract.
 */
export function byeCollisionCost(player, roster, cfg) {
  const bye = player.bye;
  if (!bye || !roster.length) return 0;
  const w = cfg.draftRules?.byeWeights;
  if (w?.enabled === false) return 0;

  // How many of the starters I already have share this bye?
  const starters = cfg.roster.starters;
  const clash = roster.filter(p => p.bye === bye).length;
  if (clash === 0) return 0;

  // Only count it once the hole is real: one shared bye is trivially covered off the bench.
  const freeCover = w?.freeCover ?? 1;
  const over = clash - freeCover;
  if (over <= 0) return 0;

  // Each starter beyond what the bench absorbs costs roughly the gap between a startable player
  // and what is left, for one week.
  const perStarter = w?.pointsPerExtraStarter ?? 8;
  const totalStarters = Object.values(starters).reduce((a, b) => a + b, 0);
  const weight = w?.weight ?? 1;
  return Math.min(over, totalStarters) * perStarter * weight;
}

/** Extra credit for covering a position where an injury would drop me to replacement level. */
function thinnessBonus(player, roster, cfg, repl) {
  const pos = player.pos;
  const need = cfg.draftRules?.minByEndOfDraft?.[pos];
  if (!need) return 0;
  const have = roster.filter(p => p.pos === pos).length;
  if (have >= need) return 0;
  const short = need - have;
  // value of not being forced to start a replacement player if a starter goes down
  return short * Math.max(0, player.pts - (repl[pos] ?? 0)) * cfg.tuning.thinnessWeight * 0.25
       + short * cfg.tuning.thinnessWeight * 4;
}

/**
 * Expected value of the BEST player at a position still on the board at my next pick.
 * Exact expected-max over independent survival events, walking the position in value order.
 */
export function expectedBestAtNextPick(cands, surv, valueOf) {
  let e = 0, none = 1;
  for (const p of cands) {
    const s = surv.get(p.id) ?? 0.15;
    e += valueOf(p) * s * none;
    none *= (1 - s);
    if (none < 0.0005) break;
  }
  return e;
}

/**
 * Rank every available player for the pick on the clock.
 * score = marginal lineup value  -  what I could still get at that position next turn
 */
/**
 * How much would a team with THIS roster want a player at THIS position, right now?
 * Reuses the same guardrails we apply to ourselves - nobody takes a kicker in round 3, and a
 * team that already has its starters at a position is far less likely to take another.
 */
export function opponentNeed(player, roster, round, cfg, profile = null) {
  if (violatesRules(player, roster, round, cfg, true)) return 0.04;   // possible, but unlikely
  let need;
  const needed = unfilledStarterSlots(roster, cfg);
  if (fillsAnySlot(player, needed, cfg)) need = 2.4;                  // fills a hole they must fill
  else {
    const have = roster.filter(p => p.pos === player.pos).length;
    need = have >= 3 ? 0.35 : have >= 2 ? 0.7 : 1;                    // depth, diminishing
  }
  return need * historicalPrior(profile, player.pos, round);
}

const IDP_POS = ['LB', 'DE', 'DT', 'CB', 'S'];

/**
 * Nudge by what THIS manager has actually done in past drafts of this league.
 *
 * Team ids persist across seasons, and the 5PM randomisation only shuffles which slot a team
 * drafts from - not who they are - so a profile keyed by team id survives the reshuffle.
 * Evidence is two seasons per manager, which is thin, so the effect is deliberately clamped to
 * +/-35%: enough to express "this manager reaches for a linebacker around round 7" without
 * letting a two-point sample override the roster logic.
 */
export function historicalPrior(profile, pos, round) {
  const fr = profile?.firstRound?.[IDP_POS.includes(pos) ? 'DP' : pos];
  if (fr == null) return 1;
  const delta = round - fr;
  return delta >= 0
    ? 1 + Math.min(0.35, delta * 0.12)      // at or past their usual round -> more likely
    : Math.max(0.65, 1 + delta * 0.10);     // well before it -> less likely
}

export function recommend({ available, myRoster, currentPick, nextPick, cfg, repl, recentPicks = [], round = 1, rosterKnown = true, upcoming = null, rostersByTeam = null, profiles = null }) {
  const byPos = {};
  for (const p of available) (byPos[p.pos] ||= []).push(p);
  for (const k in byPos) byPos[k].sort((a, b) => b.pts - a.pts);

  // positional run detection over the last 12 picks
  const runs = {};
  for (const p of recentPicks.slice(-12)) runs[p.pos] = (runs[p.pos] || 0) + 1;

  // Survival to my next turn. When the live feed tells us who picks next and what they have
  // already drafted, model those specific teams; otherwise fall back to the market-only curve.
  const window = nextPick ? nextPick - currentPick : 0;
  // Gated OFF by default - see tuning.opponentModel in the league config for the measurements.
  // The market curve is the validated path; this stays in the tree, one flag from being re-enabled.
  const useOpponents = (cfg.tuning?.opponentModel?.enabled === true)
    && !!(window && upcoming?.length && rostersByTeam);
  const surv = useOpponents
    ? survivalCurveOpponentAware({
      available, upcoming, rostersByTeam, cfg, currentPick,
      needFn: (p, roster, r, team) => opponentNeed(p, roster, r, cfg, profiles?.[team]),
    })
    : survivalCurve(available, window, cfg, currentPick);

  // VONA baseline per position: expected best marginal value still there at my next pick
  const vona = {};
  for (const [pos, arr] of Object.entries(byPos)) {
    const cands = arr.filter(p => !violatesRules(p, myRoster, round + 1, cfg, rosterKnown)).slice(0, 40);
    vona[pos] = window
      ? expectedBestAtNextPick(cands, surv, p => marginalValue(p, myRoster, cfg, repl))
      : 0;
  }

  const out = [];
  for (const p of available) {
    const mv = marginalValue(p, myRoster, cfg, repl);
    const known = !!window;
    const sv = known ? surv.get(p.id) : null;
    const urgency = known ? mv - (vona[p.pos] ?? 0) : 0;   // the VONA delta
    // A run has to be unusual to mean anything - see draftRules.runThresholds.
    const runThresh = cfg.draftRules?.runThresholds?.[p.pos] ?? 3;
    const runBoost = (runs[p.pos] || 0) >= runThresh ? cfg.tuning.runBoost : 0;
    const injPenalty = INJURY_PENALTY[p.injury] ?? 0;
    const byeCost = byeCollisionCost(p, myRoster, cfg);
    const blocked = violatesRules(p, myRoster, round, cfg, rosterKnown);
    out.push({
      ...p, marginal: r1(mv), vorp: r1(p.pts - (repl[p.pos] ?? 0)),
      survival: sv == null ? null : Math.round(sv * 100),
      adpCensored: isCensoredAdp(p.adp, cfg), urgency: r1(urgency),
      blocked,
      byeCost: r1(byeCost),
      score: blocked ? -999
        : r1(mv * cfg.tuning.valueWeight + urgency * cfg.tuning.urgencyWeight
             + runBoost - injPenalty - byeCost),
      reason: blocked || explain(p, mv, urgency, sv, runBoost ? (runs[p.pos] || 0) : 0,
        byeCost > 0 ? myRoster.filter(x => x.bye === p.bye).length : 0),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { ranked: out, vona, runs, opponentAware: useOpponents };
}

// Late-August QUESTIONABLE is usually a precautionary preseason tag, so it is noise.
// OUT / IR / SUSPENSION are not.
const INJURY_PENALTY = { OUT: 25, DOUBTFUL: 18, INJURY_RESERVE: 60, SUSPENSION: 30, QUESTIONABLE: 0 };

const r1 = n => Math.round(n * 10) / 10;
const countPos = (roster, pos) => roster.filter(p => p.pos === pos).length;

/** Which required starting slots do I still have nobody for? */
export function unfilledStarterSlots(roster, cfg) {
  const st = cfg.roster.starters;
  const out = [];
  const used = new Set();
  const takeOne = pred => {
    const p = roster.find(x => !used.has(x.id) && pred(x));
    if (p) { used.add(p.id); return true; }
    return false;
  };
  const FLEXNAMES = flexSlotNames(cfg);
  for (const [slot, n] of Object.entries(st)) {
    if (FLEXNAMES.has(slot) || slot === 'DP') continue;
    for (let i = 0; i < n; i++) if (!takeOne(x => x.pos === slot)) out.push(slot);
  }
  for (const fs of flexSlots(cfg))
    for (let i = 0; i < fs.n; i++)
      if (!takeOne(x => fs.eligible.includes(x.pos))) out.push(fs.name);
  for (let i = 0; i < (st.DP || 0); i++)
    if (!takeOne(x => cfg.roster.dpEligible.includes(x.pos))) out.push('DP');
  return out;
}

function fillsAnySlot(player, needed, cfg) {
  const fsByName = new Map(flexSlots(cfg).map(f => [f.name, f]));
  return needed.some(slot =>
    fsByName.has(slot) ? fsByName.get(slot).eligible.includes(player.pos)
    : slot === 'DP' ? cfg.roster.dpEligible.includes(player.pos)
    : player.pos === slot);
}

/**
 * Hard guardrails. Positions with dirt-cheap replacement (K/DST/IDP) must not be taken early:
 * VORP says a kicker is worth 26 points, but you can still get 90% of that in round 15, and the
 * WR you skipped is gone forever. Returns a reason string if the pick is disallowed.
 */
export function violatesRules(player, roster, round, cfg, rosterKnown = true) {
  // END-GAME OVERRIDE. Mid-draft, an unfilled starter slot is valued at replacement level
  // because you can always get a replacement-level player later. In the last few rounds that
  // is false: an unfilled slot scores ZERO, not replacement. So once picks-remaining equals
  // slots-still-needed, only players who fill a needed slot are legal.
  //
  // Only meaningful when we actually know the roster. Before the 5PM order reveal mySlot is
  // null and myRoster() is [], which made this fire from round 9 and silently disable every
  // earliestRound guardrail (kickers and IDP would surface in round 9).
  const rounds = cfg.draft?.rounds ?? 16;
  const picksLeft = rounds - round + 1;
  const needed = rosterKnown ? unfilledStarterSlots(roster, cfg) : [];
  if (needed.length && picksLeft <= needed.length) {
    return fillsAnySlot(player, needed, cfg) ? null
      : `must fill ${needed.join('/')} - only ${picksLeft} pick${picksLeft === 1 ? '' : 's'} left`;
  }

  const rules = cfg.draftRules || {};
  const n = countPos(roster, player.pos);
  const dpGroup = cfg.roster.dpEligible.includes(player.pos);
  const cap = rules.targetMax?.[player.pos];
  if (cap != null && n >= cap) return `already have ${n} ${player.pos}`;
  if (dpGroup) {
    const dpTotal = roster.filter(p => cfg.roster.dpEligible.includes(p.pos)).length;
    if (dpTotal >= 2) return 'already have 2 IDP';
  }
  const early = rules.earliestRound?.[player.pos];
  if (early != null && round < early) return `too early for ${player.pos} (wait until R${early})`;
  const second = rules.secondAtPositionEarliest?.[player.pos];
  if (second != null && n >= 1 && round < second) return `${player.pos}2 too early (wait until R${second})`;
  return null;
}

function explain(p, mv, urgency, surv, run, byeClash = 0) {
  const bits = [];
  if (mv > 60) bits.push('big lineup upgrade');
  else if (mv < 5) bits.push('depth only');
  if (surv != null) {
    if (urgency > 25) bits.push('WILL NOT last to your next pick');
    else if (surv > 0.7) bits.push(`${Math.round(surv * 100)}% to last — you can wait`);
  }
  if (run >= 3) bits.push(`${run}-deep ${p.pos} run happening`);
  if (p.injury && p.injury !== 'QUESTIONABLE') bits.push(`⚠ ${p.injury.replace('_', ' ')}`);
  if (byeClash) bits.push(`bye wk${p.bye} — ${byeClash} of your starters already out`);
  return bits.join(' · ');
}
