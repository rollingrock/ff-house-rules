# Draft-Companion & Season-Manager: Survey → Spec

## 1. SURVEY — what's real vs. what's marketing

**FantasyPros Draft Wizard / Draft Assistant**
- *Real:* ECR as a **market prior** (distinct from projections — it tells you what the room will do); live league sync that auto-updates as picks land; the mock simulator for rehearsing a specific draft slot.
- *Marketing:* "Wizard mode" recommendations are ECR-minus-taken plus a light need nudge. Their projections are not the edge; the consensus is. Their scoring presets cannot express 0.1/passing-yd or 1.0/tackle, so for us the recommendation engine is structurally wrong.
- *Steal:* live sync, ADP-as-market-signal. *Skip:* their pick recommendation.

**Sleeper draft board** — zero analytics, best-in-class *display*: dense grid, position color-coding, recent-picks ticker, full board on one screen. Steal the visual grammar only.

**ESPN draft room** (our platform) — source of truth, queue works, the 2024+ Draft Board view shows all picks color-coded. Its "best available" is ESPN's default-PPR rank, which in this league is **actively wrong** (undervalues QBs by ~2.5x on passing yards, has no real IDP intelligence). The entire room drafting off those ranks *is our arbitrage.* Operational fact confirmed by third-party overlay vendors: **never reload the ESPN draft tab mid-draft — it can log you out and cost your seat.**

**DraftSharks** — the one genuinely good idea is **"3D Value": a single composite number** that already contains projections + filled roster slots + dropoff-to-your-next-pick + tiers. That is the correct design. Their brag of "17 in-draft value indicators tracked in real time" is the anti-pattern: nobody reads 17 indicators in 30 seconds. Steal the one number, drop the other 14.

**Fantasy Life Draft Companion** — closest existing thing to what we want. Two ideas worth taking: (a) **availability probability as a first-class column** next to projections, (b) overlay lives inside the draft room so there's no tab-switch. Can't express our scoring; paid tier; free-leagues-only.

**RotoWire** — draft tool is a thinner FantasyPros. Their *in-season* asset (news velocity, snap counts, target share) is the better product. Steal for October, not tonight.

**Boris Chen tiers** — the most-cited free tool among power users, and the method is what matters: Gaussian-mixture clustering over ECR, producing tiers with visible error bars. The load-bearing insight: **rank order between adjacent players is noise; tier membership is signal.** But his clusters run on standard-scoring ECR with no IDP — useless to us directly. We must re-cluster on *our* rescored projected points. That's ~20 lines (1-D k-means or Jenks natural breaks).

**Open-source (GitHub)**
- `jjti/ff` — cleanest core: VOR where the baseline is the (n+1)th player at position given team count *and roster slots*, recomputed under league scoring; click-a-player-to-draft-him; tags for bye conflicts and handcuffs. Simple and correct.
- `JROtto5/draft-war-room` — Monte Carlo survival odds, "on-the-clock takeover" screen, keyboard shortcuts (`/` search, `M` mine, `T` taken), snipe alerts, run ticker. Good bones wrapped in gimmicks (ghost drafter, story replay, time machine).
- `howrealizdat/draft-co-pilot` — MV3 Chrome extension reading the live ESPN board, ranking by VOR under league scoring. Literally our architecture, and unproven (0 stars).
- Pattern: nearly all are one-season projects with ≤5 stars. **Depend on none; steal the ideas.**

**What power users actually say wins drafts**
1. Tiers beat ranks. The only question that matters is "am I about to fall out of a tier."
2. Rankings matched to *your* scoring and roster beat consensus — and nobody in a casual ESPN league does it.
3. VONA (value over next available) is the right *live* heuristic; VORP/VOLS are the right *pre-draft* ranking.
4. Don't chase runs. Missing a run is survivable; the panic pick right after the run is what does the damage.
5. **The killer operational finding.** Footballguys veterans abandon Draft Dominator for a *printed sheet* because it "gets too hard to keep up with when using a 90 second clock and players being chosen within 20 seconds." **Our clock is 30 seconds.** Any tool requiring manual pick entry is dead on arrival. This is the single hardest constraint on tonight's build.

---

## 2. THE 30-SECOND PROBLEM

**Time budget, honestly.** Of 30 seconds: ~3s to register who just went, ~10s to find the player in ESPN's search box and click draft, ~5s of safety buffer. That leaves **~10 seconds of actual decision time.** The screen must be readable in one saccade — not a table you scan, a short ranked list with one dominant number.

### The ONE number: EDGE (VONA, in points)

Not projected points (doesn't account for scarcity). Not VOR (doesn't account for *this* draft's flow). Not ADP (that's the room's opinion under the wrong scoring).

```
EDGE(p) = proj(p) - E[best available at p's usable slot at my NEXT pick]
```

EDGE is the one number because it already contains all four things you'd otherwise need four widgets for: player quality, positional scarcity, roster need (via "usable slot"), and tier cliffs (a cliff collapses the expectation). Run pressure enters automatically as survival probabilities shift.

Concretely:
```
surv(p)   = 1 - Φ((nextPick - ADP_p) / σ_p),   σ_p = max(4, ADP_p / 4)
E_next(s) = Σ_p  proj(p) · surv(p) · Π_{q ranked above p at slot s} (1 - surv(q))
EDGE(p)   = proj(p) - E_next(best slot p fills)
```
σ = ADP/4 is DraftKick's public approximation (min/max pick range ≈ ADP). Runs in <50ms over ~600 relevant players.

**Known caveat, handled deliberately:** EDGE under-rates elite players in round 1 (everyone's next-available is fine early). So **sort** by a blend, **display** EDGE:
```
SCORE = w·z(VOR_season) + (1−w)·z(EDGE),   w = 0.70 (R1-3), 0.50 (R4-8), 0.25 (R9-16)
```
The list *order* is the recommendation; the big number is the *urgency*. The numbers will not be monotonic down the list — that is intentional, not a bug.

### The second number: SURV%

Answers "do I have to do it now." Use DraftKick's calibrated thresholds: **≥65% → you can wait. ≤25% → take him now.** Render the extremes as words/color, not digits — only the ambiguous 25-65% band needs a readable percentage.

### Everything else, compressed

- **Tiers** → not "Tier 4" but **"T4 (2 left)"**. The *remaining count* is the actionable quantity. When a tier you need drops to ≤2, the row group gets a border.
- **Positional runs** → one strip of position letters for the last 8 picks (`RB WR WR RB WR WR TE WR`). A human parses that instantly, no algorithm needed. Add a one-line alert *only when it changes the math*: "WR RUN 5/7 — WR surv 41% → 18%."
- **Roster need** → NOT a needs panel. It's already inside EDGE via usable-slot logic. Surface it only as a 10-cell starter strip with filled/empty.
- **"Will he last"** → the SURV% column. That's it.

### Second-screen ergonomics

The user is *in* ESPN; this is a companion, not a replacement. Therefore:
- Dark, big type (18-22px list, 48px+ for EDGE), top 8 visible with **zero scrolling**.
- **Never requires interaction to stay correct.** Auto-ingest picks.
- Names rendered in the exact form ESPN's search box matches; top row is one-click-copy. This micro-feature buys ~4 seconds per pick, which is more than any analytical feature buys.
- Visual gradient: top 3 get card treatment with the boxed number, ranks 4-8 get one compact line each. Most picks are decided in the top 3.

### Layout

```
+----------------------------------------------------------------------------------------------+
| PICK 4.07 (#43)   ON THE CLOCK  0:23         YOUR NEXT: #54 (11 away)  ->  then #67           |
| RUN: RB WR WR RB WR WR TE WR  <- last 8      (!) WR RUN 5/7 - WR surv 41% -> 18%              |
| ME: QB[x] RB[x x] WR[ . ] TE[ ] FLX[ ] DP[ ] DST[ ] K[ ]      BENCH 0/6                       |
+-----------------------------------------------------------+----------------------------------+
|                                                           |  IF YOU WAIT TO #54              |
|  +------+                                                 |  ------------------------------  |
|  | +38  |  JAXON SMITH-NJIGBA        WR   T3 (2 left)     |  QB  Nix ......... 86%   (-12)   |
|  +------+  312.4 pts | VOR 71 | ADP 39 | SURV 14%  GONE   |  RB  Tuten ....... 71%   (-29)   |
|            > WR tier 3 empties in ~4 picks                |  WR  Nabers ...... 18%   (-38)   |
|                                                           |  TE  Ferguson .... 64%   ( -9)   |
|  +------+                                                 |  DP  Wagner ...... 92%   ( -4)   |
|  | +31  |  JUSTIN HERBERT            QB   T2 (3 left)     |  ------------------------------  |
|  +------+  681.2 pts | VOR 118 | ADP 61 | SURV 58%        |  SCARCITY CLOCK                  |
|            > QB2 tier holds ~3 more rounds                |  QB  T2:3   T3:5    cliff @ R7   |
|                                                           |  RB  T4:2 ! T5:9    cliff @ NOW  |
|  +------+                                                 |  WR  T3:2 ! T4:11   cliff @ NOW  |
|  | +29  |  BUCKY IRVING              RB   T4 (2 left)     |  TE  T3:4   T4:6    cliff @ R6   |
|  +------+  248.9 pts | VOR 63  | ADP 44 | SURV 22%  GONE  |  DP  T1:6   T2:14   cliff @ R11  |
|            > RB tier 4 empties in ~3 picks                |  ------------------------------  |
|                                                           |  DON'T PANIC                     |
|    +24    LADD MCCONKEY            WR  T3 (2 left)   31%  |  DP pool is 6 deep in T1 and the |
|    +19    TREY MCBRIDE             TE  T2 (1 left)   44%  |  room drafts DP after R13.       |
|    +18    ZAY FLOWERS              WR  T4 (11)       77%  |  Nobody is taking your LB.       |
|    +12    BO NIX                   QB  T3 (5)        71%  |                                  |
|    +11    JAHMYR GIBBS             RB  T3 (1 left)    9%  |  LAST 3: 4.06 CIN WR / 4.05 ...  |
|                                                           |                                  |
+-----------------------------------------------------------+----------------------------------+
| [search / mark-taken] ______________________   SYNC: live 2s ago    [R] refresh  [M] manual   |
+----------------------------------------------------------------------------------------------+
```

Three zones, ordered left-to-right by decreasing urgency. Zone A (top strip) is context that never moves. Zone B (left 60%) is THE BOARD — the only thing you read when the clock is under 10. Zone C (right 40%) is the "am I being dumb" check you read when you have 20+ seconds. The "DON'T PANIC" box is deliberate: it is the counter-weight to run-chasing, which is the documented #1 way good drafters lose value.

---

## 3. IN-SEASON, ranked by value actually delivered

**1. Waiver / FA recommendation — dominant, by a wide margin.**
192 of ~11,600 players get drafted. The remaining pool is systematically mispriced here because no other tool in this league scores tackles at 1.0 or passing yards at 0.1. The inverse-standings mechanic changes the logic entirely versus FAAB: you hold **one** claim that resets weekly, and spending it costs you queue position. So the recommendation is not "is he good" but **"is he worth burning priority #N"** — a threshold on ROS-points-added-over-your-worst-roster-spot against the option value of holding. Since waiver order is inverse standings and *visible*, we can also predict whether a claim will even land.
*Highest-ROI sub-module:* the **DP slot**. Only 12 DP starters exist league-wide. Off-ball LB role/snap-share changes are the most reliably exploitable weekly signal in this format and literally nobody else is watching them. Same logic for streaming K (FG50-59=4, FG60+=5) and D/ST against the dual points-allowed + yards-allowed brackets.

**2. Inactive alarm (not "start/sit optimizer").**
Lineup protection is OFF and lineups lock individually at gametime. Those two facts combine into the one thing that actually loses seasons: an inactive starter scores a zero and nobody swaps him. The feature is two Sunday pings — **11:30am CT and 12:20pm CT** — listing any starter who is Q/D/O, on the inactive list, or in a game already underway. This is pure downside protection and it is worth more than the optimizer half. Weekly Thursday/Monday pings too.

**3. Optimal-lineup optimizer.** Real but smaller — under our scoring, the correct starters are usually obvious once projections are rescored. Bundles into #2; don't build it separately.

**4. Playoff-odds awareness.** Moderate value with one concrete hook: **seeding tiebreak is total points for**, so "max points even in a blowout" is always correct and late-season ceiling-chasing gets a real answer. Monte Carlo over the remaining schedule is cheap to build. Only matters weeks 8-14 — build it in October.

**5. Trade evaluation — last, possibly never.** Casual 12-team leagues trade little and the analysis is easy ad hoc. Its one genuinely useful form: **"who on my roster is a sell-high because the league's scoring is mispriced"** — our QBs are worth far more here than any trade partner's default tool will report.

---

## 4. ANTI-FEATURES (things these tools do that hurt)

1. **Manual pick entry.** The documented failure mode at 90-second clocks; catastrophic at 30. A tool that falls behind gives *wrong* advice, which is worse than no advice. Auto-ingest or degrade to a static sheet — never a middle path that silently rots.
2. **Scrolling 200-row tables with 12 columns.** You cannot read a table in 10 seconds. Every added column costs you attention you don't have.
3. **Reloading the ESPN tab to scrape.** Documented to log you out and cost your seat. Read-only DOM observation, or cookie-authed API polling from a *separate* process. Never a reload.
4. **An opaque single recommendation with no reason.** You will override it at exactly the wrong moments. One number plus a four-word reason ("QB cliff after Herbert") is right; a black box is not.
5. **Ceiling/floor bands, SOS, "trust factor", breakout %, sleeper flags — mid-draft.** All of these are *pre-draft inputs*. In-draft they are noise. Fold them into the ranking before 6PM or delete them.
6. **Chat, booth tickers, ghost drafters, live draft grades, celebration animations.** Entertainment consuming the scarcest resource in the room. Grade the draft at 9PM.
7. **Bye-week warnings before round 9.** They fire constantly, are almost never decision-relevant early, and train you to ignore all alerts. Suppress until R9+, and only when it would put 3+ starters on one bye.
8. **Breaking-news feeds during the draft.** Anything after ~4pm should already be in the projections. A live feed mid-draft causes panic pivots.
9. **Auto-queue that reorders itself.** If we ever write to ESPN's queue it must be additive and stable — a reshuffling queue is worse than none, because a timeout autodrafts from the queue top.
10. **BPA without slot logic in the late rounds.** A 16-man roster with mandatory DP/D-ST/K means round-13 BPA hands you a 7th WR and no kicker. Constrain to fillable slots from ~R12.
11. **Ours specifically: never rank by ADP.** ESPN ADP encodes default-scoring behavior. That's a *gift* — it tells us QBs and LBs will go late, which is the whole arbitrage. Use ADP for survival probability only.

---

## 5. PRIORITIZED BUILD LIST

### MUST-HAVE BY 6PM (in strict build order)

| # | Item | Deadline | Note |
|---|---|---|---|
| 0 | **espn_s2 + SWID cookie capture** from user's Chrome, verified against `?view=mDraftDetail` | **4:30pm** | Everything live depends on this. I confirmed `mDraftDetail`, `mTeam`, `mRoster` all return **401** unauthenticated. Fallback: Chrome MCP DOM read of the draft board. |
| 1 | **Custom-rescored projections**, all ~11.6k players, from `stats["102026"]` raw stat-ids × our scoring | 4:00pm | This is the entire edge. Must include IDP and the QB distortion. |
| 2 | **VOR/VOLS baselines** per position for 12tm/16-roster/1QB-2RB-2WR-1TE-1FLEX-1DP-1DST-1K. DP baseline = **DP12**. QB baseline = **QB12**. | 4:15pm | This is what makes the QB and LB premium *numerical* rather than a hunch. |
| 3 | **Tiers** via 1-D clustering (Jenks/k-means) on rescored points, per position | 4:30pm | Boris Chen's method, our data. Do not borrow his charts. |
| 4 | **STATIC PRINTABLE BOARD** — top 200 overall by VOR w/ tiers + position, one page, plus per-position sheets | **5:00pm, hard** | **This is the floor.** If everything else dies at 6:01, this alone beats the room. Print it. |
| 5 | **Live pick ingestion** — poll `mDraftDetail` every 3-5s → available-player set | 5:15pm | |
| 6 | **Live board UI** — the layout above | 5:45pm | |
| 7 | **Survival probability** vs. *your* next pick number | 5:30pm | σ = max(4, ADP/4) |
| 8 | **Draft-slot-agnostic**: "my slot" is a config value set at 5:01pm; all snake pick numbers derived | built-in | Order randomizes at 5PM. Nothing may be hardcoded. |
| 9 | **Graceful degrade** — red banner on sync loss + manual "mark taken" search that keeps the board working off last-known state | 5:50pm | |

**If time remains, in this order:** run detector + one-line alert → late-round slot constraints (force K/D-ST/DP/bye coverage from R12) → copy-name-to-clipboard on top row → pre-draft "cliff map" printed on the static sheet.

**Explicitly NOT tonight:** mock draft simulator, full-draft Monte Carlo, trade evaluator, playoff odds, ceiling/floor bands, SOS, handcuff graph, ESPN queue write-back (write access mid-draft is a seat risk), any auth flow, any database.

### IN-SEASON — build by Tue Sep 8 (before Week 1 waivers)

1. Waiver board with inverse-priority "burn or hold" logic + landing-probability
2. Sunday inactive alarm (11:30am / 12:20pm CT pings)
3. Weekly optimal lineup under rescored projections
4. DP / K / D-ST streaming module *(best hours-to-points ratio of the three)*
5. Playoff odds w/ points-for tiebreak — by Week 8
6. Trade evaluator — optional, framed as "sell-high under mispriced scoring"

---

**Sources:** [Footballguys forums — Cheatsheets vs Draft Dominator](https://forums.footballguys.com/threads/cheatsheets-versus-draft-dominator.798999/) · [DraftKick — Projected Availability](https://draftkick.com/blog/projected-availability/) · [FantasyPros — VBD: VORP/VOLS/VONA](https://www.fantasypros.com/2025/06/fantasy-football-draft-strategy-value-based-drafting-vorp-vols-vona/) · [DraftSharks — Inside the War Room](https://www.draftsharks.com/league/mvp/inside) · [DraftSharks — Fantasy Football Tiers](https://www.draftsharks.com/article/fantasy-football-tiers) · [Fantasy Life — Draft Companion](https://www.fantasylife.com/tools/draft-companion) · [Boris Chen — Draft Kit](http://www.borischen.co/p/draft-kit.html) · [GitHub — draft-assistant topic](https://github.com/topics/draft-assistant) · [jjti/ff](https://github.com/jjti/ff) · [JROtto5/draft-war-room](https://github.com/JROtto5/draft-war-room) · [ESPN Draft Overlay (technical)](https://fantasyfootballdashboard.com/draft-overlay-espn/) · [Yahoo — Navigating Positional Runs](https://sports.yahoo.com/articles/tips-navigating-positional-runs-fantasy-225620788.html) · [Footballguys — IDP Draft Blueprint](https://www.footballguys.com/article/2026-idp-draft-blueprint-godfathers-step-by-step-guide) · [IDP+ — 2026 IDP Draft Strategy](https://idpplus.com/2026-idp-draft-strategy-guide-when-to-draft-lbs-dl-and-dbs-with-position-tiers/) · [PFF — Adjusting for 6-pt passing TDs](https://www.pff.com/news/fantasy-football-adjusting-for-fantasy-football-leagues-with-6-points-for-passing-tds)