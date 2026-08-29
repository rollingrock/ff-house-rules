I have everything needed. Writing up the analysis.

---

# VALUATION MATH FOR '26 ELITE FFL — quantified from live 2026 ESPN projections

**All numbers below are computed, not estimated.** I rescored all 11,617 players (2026 projections) under exact league rules, and calibrated against 2025 preseason-projection→actual outcomes (n=2,876). Work is in `<local scratch>` (`score.py`, `vbd.py`, `calib.py`, `compare.py`, `board.py`; cached `players2026.json`, `players2025.json`, `scored.json`).

---

## 0. THREE CORRECTIONS TO THE WORKING ASSUMPTIONS — read first

**(a) The stat-ID map is now verified** (was flagged "highest-risk unknown"). Validated by reconstructing ESPN's own `appliedTotal`: Gibbs rescores to 364.78 vs ESPN's 364.86.

```
Offense: 3 passYd, 4 passTD, 20 INT, 19 pass2pt, 23 rushAtt, 24 rushYd, 25 rushTD,
         26 rush2pt, 42 recYd, 43 recTD, 44 rec2pt, 53 receptions, 58 targets,
         72 fumblesLOST (not 68 = total fumbles), 210 games
K:  80 FGmade0-39, 77 FGmade40-49, 74 FGmade50+, 85 FGmissed(total), 86 PATmade
    !! ESPN does NOT split 50-59 vs 60+. League pays 4 vs 5. Use effective
       value 4.08/make (assume ~8% of 50+ are 60+). Error is <1.5 pts/season.
IDP: 109 totalTackles (=107 solo + 108 assist, verified exact), 99 sacks, 95 INT,
     96 fumRec, 97 blockedKick, 98 safety, 105 allDefTD
D/ST: 99 sack, 95 INT, 96 FR, 97 blk, 98 safety, 105 allTD
  PointsAllowed buckets: 89=0, 90=1-6, 91=7-13, 92=14-17, 121=18-21, 122=22-27,
                         123=28-34, 124=35-45, 125=46+
  YardsAllowed buckets:  128=<100, 129=100-199, 130=200-299, 131=300-349,
                         132=350-399, 133=400-449, 134=450-499, 135=500-549, 136=550+
```
Both bucket sets sum to exactly 17.0 games, and reconstructed PA/game matches ESPN's own stat 126 to within 1.0. **Do not use `appliedTotal`** — it is broken for K (Aubrey shows 1602) and inconsistent for DL.

**(b) ESPN ADP is synthetic past ~pick 160.** 989 players share ADP = exactly 170.0; 1,110 sit in the 170–179 bucket. Only ~155 players have real ADP signal. Any survival model must treat ADP > 160 as **censored**, not as data. Fall back to `draftRanksByRankType.PPR.rank` or `percentOwned` for those.

**(c) The QB-premium thesis is backwards, and it's the most important finding here.** Detail in §2.

---

## 1. VALUATION FRAMEWORK

### The four baselines, and which to use
- **VOLS** (Value Over Last Starter): baseline = last player who starts league-wide. Too strict; assumes free access to the next guy.
- **VORP/VBD** (Value Over Replacement): baseline = best player at that position freely available *after* the draft. This is the correct one for a draft.
- **VONA** (Value Over Next Available): dynamic, in-draft; the only one that answers "pick now or wait." Use in §3.
- **EPA-style approaches** don't apply here — you're not valuing plays, you're valuing season totals. Ignore.

### Replacement level done correctly (the FLEX trap)
The common mistake is `RB_repl = RB25` (12 teams × 2 RB + 1), ignoring that the FLEX also eats RBs and WRs. Correct algorithm:

```
1. Fill mandatory slots:  QB 12, RB 24, WR 24, TE 12, DP 12, DST 12, K 12
2. Pool the NEXT-best RB/WR/TE (raw projected points — valid because the FLEX
   is positionally neutral), take the top 12 → flex allocation
3. repl_index[p] = mandatory[p] + flex_share[p] + 1
```
Computed result: **FLEX splits 4 RB / 8 WR / 0 TE.**

| Pos | starter demand | VOLS idx / pts | est. rostered | **VORP idx / pts (use this)** |
|---|---|---|---|---|
| QB | 12 | QB13 / 574 | 18 | **QB19 / 540** |
| RB | 24+4 = 28 | RB29 / 186.0 | 50 | **RB51 / 91** |
| WR | 24+8 = 32 | WR33 / 186.7 | 58 | **WR59 / 137** |
| TE | 12+0 = 12 | TE13 / 166.6 | 18 | **TE19 / 143** |
| DP | 12 | DP13 / 148.7 | 17 | **DP18 / 140** |
| K | 12 | K13 / 129.9 | 13 | **K14 / 129** |
| D/ST | 12 | DST13 / 139.4 | 15 | **DST16 / 134** |

Rostered counts sum to 189 ≈ 192 total picks — self-consistent.

**Validation that the flex math is right:** RB29 = 186.0 and WR33 = 186.7 converge to the same value. That equalization of marginal RB/WR value is exactly what flex equilibrium predicts, and it falls out of the data rather than being imposed. TE13 = 166.6 sits ~20 pts lower because no TE clears the flex bar — which is *why* McBride/Bowers carry a real premium.

### Formula
```
VORP_j = Proj_j − Baseline[pos_j]
```
Rank the board by VORP, not by projected points. Never compare raw points across positions.

---

## 2. THE QB PREMIUM — quantified, and it does NOT mean draft a QB early

### The absolute numbers confirm the premium
Josh Allen projects **658.8** pts; Gibbs (RB1) **364.8**. So yes, the top QB outscores the top RB by 294 points.

### But absolute points are irrelevant. Here is the actual curve:

```
QB   1:659  4:618  8:594  12:579  14:566  16:561  18:543  20:531  22:526  24:496
RB   1:365  6:281  12:274  18:232  24:203  30:186  36:171
WR   1:356  6:294  12:248  18:232  24:213  30:197  36:184
TE   1:242  3:211   6:189   9:181  12:169
DP   1:193  6:163  12:150  18:140  24:132  30:124
```

**Headline gaps — the direct answer to the question asked:**

| Gap | Points |
|---|---|
| **QB1 → QB12** | **79.4** |
| QB1 → QB18 | 115.6 |
| **RB1 → RB24** | **162.0** |
| **WR1 → WR30** | **158.9** |
| TE1 → TE12 | 72.6 |
| DP1 → DP12 | 42.9 |

**The QB1→QB12 gap (79) is HALF the RB1→RB24 gap (162) and half the WR1→WR30 gap (159).**

The premium inflates every QB *identically*. Since all 12 teams start exactly one QB and QBs 1–18 span only 659→543, the QB slot is close to a **league-wide constant**. Constants don't create edge. Edge comes from VORP, and the QB pool is the flattest on the board.

### VORP board (VOLS baselines) — Allen is the 20th most valuable player
```
 1 178.8 RB1  Gibbs        ADP  1.4      12  94.7 RB6  Jeanty      ADP 18.3
 2 169.5 WR1  Nacua        ADP  5.2      ...
 3 166.7 RB2  Bijan        ADP  2.4      20  84.9 QB1  Josh Allen  ADP 21.7
 4 156.7 RB3  McCaffrey    ADP  7.4      23  75.3 TE1  McBride     ADP 21.0
 5 150.8 WR2  Chase        ADP  4.0      39  45.9 QB2  Stafford    ADP 82.0
 6 140.0 WR3  Smith-Njigba ADP  5.8      41  45.0 QB3  Maye        ADP 47.4
 7 137.2 WR4  St. Brown    ADP  8.2      44  44.0 DP1  Cashman     ADP 74.0
 8 130.4 RB4  J. Taylor    ADP  7.4      50  34.1 QB5  Lamar       ADP 38.3
```
Under the stricter post-draft VORP baselines the ordering is unchanged: Gibbs 273.5 vs Allen 118.7. **The conclusion is invariant to baseline choice** — elite RB/WR are worth ~2.1–2.3× the top QB.

### Answer: is this a round 1–2 QB league?
**No.** Allen at ADP 21.7 is *fairly priced*, not a bargain — his VORP rank is 20. Every other QB is a round-5-or-later value. Taking a QB before ~pick 20 is a mistake.

### Where is the cliff?
**There isn't one until QB28.** Gap-based tiering puts Allen alone in T1, then a **27-man T2 running from Stafford (620) all the way down to ~478**, then a drop to Brissett (430). QB2→QB18 declines at an average of 4.8 pts per QB. With only 12 QB starters needed and 22+ startable QBs, QB scarcity does not exist in this league.

### The real, exploitable distortion: this league DELETES the rushing-QB premium
This is the mechanism nobody will notice:

| | ESPN default | This league | Effect |
|---|---|---|---|
| Pass yd vs rush yd | 0.04 vs 0.1 → **rush worth 2.5×** | 0.1 vs 0.1 → **equal** | rushing premium eliminated |
| Pass TD vs rush TD | 4 vs 6 → **rush worth 1.5×** | 6 vs 6 → **equal** | rushing premium eliminated |

So the league doesn't reward "Konami-code" QBs — it rewards **high-volume pocket passers**, who are exactly the QBs the ADP market discounts.

```
name              leaguePts   passPts  rushPts   stdPts    ADP
Matthew Stafford      619.8     637.7      7.5    293.0   82.0   <-- QB2, round 7
Jared Goff            579.4     595.9      9.0    268.3  136.6   <-- QB12, round 12
Dak Prescott          593.1     590.2     31.5    286.7   83.2
Brock Purdy           597.3     580.5     48.8    292.3  103.3
Lamar Jackson         608.0     544.9     89.3    322.7   38.3   <-- overpriced here
Jayden Daniels        593.9     519.2     97.7    318.2   51.3   <-- overpriced here
Jalen Hurts           593.8     519.0     98.7    320.1   51.6   <-- overpriced here
```
Under standard scoring Lamar beats Stafford by 29.7 pts. Under league scoring **Stafford beats Lamar by 11.8** — a 41.5-point relative swing — while costing 44 picks less.

**Actionable rule: fade Lamar/Daniels/Hurts, buy Stafford/Prescott/Purdy/Mahomes/Goff in rounds 7–12.** Goff at ADP 137 is the single largest mispricing on the board (QB12 production at a round-12 price).

### Calibration check: does the flat QB curve survive contact with reality?
Projected QB top-24 sd = 39.0; 2025 *realized* sd = 100.6 (ratio 2.58, vs 1.28–1.46 for WR/RB). ESPN compresses QBs badly, which could mean the flat curve is an artifact. So I measured **E[actual | projected rank]** on 2025:

```
QB proj rank 1-3   → proj 670  actual 373   (10.7 games played)
QB proj rank 4-6   → proj 643  actual 499
QB proj rank 7-12  → proj 610  actual 509
QB proj rank 13-18 → proj 584  actual 470
QB proj rank 19-24 → proj 553  actual 473
```
The realized gap between drafting a projected QB7–12 and a projected QB19–24 was **36 points**. The projected top-3 QBs were the *worst* group in the sample. One season, small n — but it cuts against paying up for QB, not for it. The flat-QB conclusion holds under both projected and realized data.

---

## 3. BUILDING THE LIVE BOARD: value + need + survival

### 3a. Snake pick arithmetic (slot known at 5PM)
For 12 teams, slot `s` (1-indexed), round `r`:
```
r odd :  pick(r) = 12(r-1) + s
r even:  pick(r) = 12(r-1) + (13-s)
gap(odd r → r+1)  = 25 - 2s     gap(even r → r+1) = 2s - 1
```
Opponents picking between your turns alternates: `(24-2s)` and `(2s-2)`. Slot 1 → 22 then 0; slot 12 → 0 then 22; slot 6 → 12 then 10.

### 3b. Survival probability
```
s_j(n) = P(player j still available at pick n) = 1 - Φ( (n - ADP_j) / σ_j )
```
Use a **right-skewed** distribution (lognormal on ADP, or skew-normal): players rarely go far *earlier* than ADP but fall a long way.

σ estimated from in-data dispersion (|ADP − ESPN PPR rank| by band, ×1.25):
```
ADP   1-12 → σ ≈ 1.1      ADP  73-96  → σ ≈ 24
ADP  13-24 → σ ≈ 3.3      ADP  97-120 → σ ≈ 44
ADP  25-48 → σ ≈ 6.5      ADP 121-160 → σ ≈ 50
ADP  49-72 → σ ≈ 14
```
This proxy is an **upper bound** (it measures cross-source disagreement, not draft-to-draft variance). Operational default: `σ_j = max(2, 0.20 · ADP_j)`, which sits inside the bracket above. **For ADP > 160, do not use ADP at all** — it's the synthetic 170 constant.

### 3c. VONA — the pick-now-vs-wait calculus
Expected best VORP still available at your next pick `n'`, for position `p`:
```
E_best(p, n') = Σ_j  VORP_j · s_j(n') · Π_{k: VORP_k > VORP_j}  (1 − s_k(n'))
```
(sum over players at position p in descending VORP; the product is the probability everyone better is gone.)

```
VONA(p) = VORP_best_available_now(p) − E_best(p, n')
```
**Draft argmax_p VONA(p)**, not argmax VORP. This is what makes you take the position about to fall off a cliff rather than the highest raw value.

### 3d. Folding in roster need — use marginal lineup value, not positional counters
Don't hand-code "need." Compute it:
```
ΔLineup_j = OptimalStarterPoints(myRoster ∪ {j}) − OptimalStarterPoints(myRoster)
```
where `OptimalStarterPoints` solves the lineup assignment (QB1/RB2/WR2/TE1/FLEX1/DP1/DST1/K1) — a trivial assignment problem at this size. This automatically handles flex eligibility, positional saturation (your 3rd RB only adds flex value), and diminishing returns. Then:

```
PickScore_j = ΔLineup_j + λ · BenchOptionValue_j − E[ best ΔLineup available at n' ]
```
with λ ≈ 0.35 early, rising late (see §4). Under a 30-second clock, precompute the survival matrix between picks and only re-solve the top ~25 candidates.

### 3e. Tiers (Boris-Chen style) — computed, gap-based
Break where the drop to the next player exceeds `mean(gap) + 0.9·sd(gap)`:
```
QB : T1 = Allen alone | T2 = 27 players (620 → 478)  ← no cliff, ever
RB : T1 Gibbs | T2 Bijan/CMC | T3 Taylor | T4 Achane | T5 11 players (281-272)
WR : T1 Nacua | T2 Chase | T3 JSN/StBrown | T4 Jefferson/Lamb | T5 34 players
TE : T1 McBride/Bowers | T2 Warren/Loveland | T3 27 players (189-169)
DP : T1 Cashman/Brooks | T2 5 players | T3 7 players | T4 26 players
K  : one tier, all 32
DST: T1 Broncos/Texans | T2 4 teams | T3 20 teams
```
Tier structure's real job is **cliff detection**: only reach when your position's tier will empty before your next pick. The RB T5 (11 players, 281→272) and WR T5 (34 players) mean there is almost no cost to waiting inside those blocks.

### 3f. Cost of waiting (pts lost from position-rank i to i+6 / i+12)
```
QB   r1:-62/-79   r6:-16/-49   r12:-31/-78
RB   r1:-84/-91   r6: -7/-35   r12:-27/-69
WR   r1:-63/-108  r6:-45/-57   r12:-12/-35
TE   r1:-53/-73   r6:-12/-39   r12:-19/-36
DP   r1:-30/-43   r6:-11/-21   r12: -8/-17
K    r1:-15/-25   r6:-10/-14
DST  r1: -9/-30   r6:-17/-28
```
Reading: the RB curve is brutal at the very top (−84 from RB1 to RB6) then flat (−7 from RB6 to RB12). **Elite RB or nothing** — if you miss the top 5 RBs, wait until round 4+, because RB6–RB13 are within 9 points of each other.

---

## 4. RISK, VARIANCE, AND WHEN UPSIDE BEATS FLOOR

### 4a. ESPN projections are systematically optimistic — measured
2025 preseason projection → actual, top-24 by position:
```
pos  mean(actual/proj)  bust(<75%)  boom(>125%)  played ≥16g  sd(ratio)
QB        0.79            42%          0%           50%         0.28
RB        0.87            25%          8%           75%         0.28
WR        0.73            50%          8%           42%         0.31
TE        0.89            38%          8%           54%         0.25
DP        0.86            29%          4%           67%         0.22
```
Root cause: **ESPN projects 17.0 games for essentially every player.** Apply an availability haircut:
```
Proj_adj_j = Proj_j × A_pos × I_j
A_pos: QB 0.82, RB 0.87, WR 0.78, TE 0.88, DP 0.87, K 0.95, DST 1.00
I_j:   healthy 1.00 | QUESTIONABLE 0.93 | DOUBTFUL 0.75 | OUT/IR 0.55
```
The within-position haircut is near-uniform so it barely reorders a position — but it **does** shift value across positions (WR 0.78 vs TE 0.88), so apply it before computing VORP.

### 4b. Projection uncertainty
```
σ_j ≈ c_pos · μ_j     c: QB 0.28, RB 0.28, WR 0.31, TE 0.25, DP 0.22
```
Scale c up ~25% for rookies, players with <10 projected games, or ADP > 100.

**DP is the most predictable position on the board** (ratio sd 0.22, bust 29%, proj-vs-actual spread ratio only 1.13 vs QB's 2.58). Tackle volume is highly stable. This is a strong argument for confidently waiting on DP — you can trust the projection ranking there more than anywhere else.

### 4c. Age
```
RB:  ×(1 − 0.045·max(0, age−26))   (cliff ~28)
WR:  ×(1 − 0.030·max(0, age−29))
TE:  ×(1 − 0.025·max(0, age−30))
QB:  ×(1 − 0.020·max(0, age−36))
```

### 4d. When upside beats floor — the rigorous version
The right reason to prefer variance late is **not** risk preference, it's **optionality**: you can cut a late pick for free, so his payoff is truncated below at waiver replacement `R`. Value him at `E[max(X, R)]`, not `E[X]`:

```
z = (μ_j − R) / σ_j
V_option(j) = R + σ_j·φ(z) + (μ_j − R)·Φ(z)
```
This is convex in σ — it mechanically rewards high-variance players, and only for picks you can actually cut. So:

- **Rounds 1–5:** use `μ` (adjusted). These picks are un-cuttable in practice; you are buying the mean. Prefer the safe floor.
- **Rounds 6–10:** blend, `μ + 0.2σ`.
- **Rounds 11–16:** use `V_option`. Draft the highest-variance profiles — backup RBs behind shaky starters, rookie WRs, high-upside QBs.

### 4e. League-structure adjustments
- **6 of 12 make playoffs (50%)** — a low bar. To *reach* the playoffs, an above-median team is hurt by variance. Maximize mean through round 10.
- **Seeding tiebreak = total points for** — pure mean. Another vote for mean over variance in the core roster.
- **To win the title** you need to be top-1 of 12 across a 3-round single-elimination bracket, which favors variance. Resolution: buy mean with your starters, buy variance with your bench. That's exactly what 4d prescribes for independent reasons.
- **LINEUP PROTECTION IS OFF + lineups lock individually.** An injured starter left in your lineup scores 0. This raises the value of (i) bench depth at RB/WR specifically, and (ii) playing-time certainty over talent at the margin. It also means the in-season tool's highest-leverage job is a pre-gametime lineup check, not waiver churn.

---

## 5. POSITION-BY-POSITION BOTTOM LINE

| Pos | When to draft | Why (computed) |
|---|---|---|
| **RB** | Rounds 1–2 for a top-5, else wait to round 4+ | RB1→RB6 = −84 pts; RB6→RB12 = −7 pts. Cliff is at the very top only. |
| **WR** | Rounds 1–5 continuously | Deepest VORP block; WR T5 has 34 players. |
| **TE** | McBride/Bowers rd 2–3, else round 8+ | TE1/2 = 75 VORP (no TE clears flex, so baseline is 20 pts lower). T3 has 27 players. |
| **QB** | **Rounds 7–12. Never before pick 20.** | QB1→QB12 = 79 pts. 27-man flat tier. Target Stafford/Prescott/Purdy/Mahomes/**Goff (ADP 137)**. Fade Lamar/Daniels/Hurts. |
| **DP** | Rounds 11–13 | DP1→DP12 = 43 pts; DP1→DP24 = 61. Most predictable position. **ESPN's DP ADP (70–90) is unreliable** — it comes from leagues with 3–7 IDP starters; this league needs only 12 DP total. |
| **D/ST** | Round 15 | DST1→DST12 = 30 pts. Note the league's harsh yards-allowed brackets make most D/STs net-negative on YA, compressing the position further. |
| **K** | Round 16 (last pick) | K1→K12 = 25 pts = 1.5/week. Single tier. |

**One-line strategy:** *Spend rounds 1–5 exclusively on RB/WR (plus McBride/Bowers if they fall), take a high-volume pocket passer in rounds 7–12, and fill DP/D-ST/K in the last five rounds. The QB premium is a mirage — it raises everyone's score equally and creates almost no draftable edge.*