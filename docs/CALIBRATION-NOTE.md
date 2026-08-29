# Projection calibration — tested, and deliberately NOT applied

## The question
ESPN's 2026 projections give a QB1-QB12 spread of only **79 points**, but the 2025 *actuals*
rescored in this league's format show **182**. Should I re-inflate the projections so QB VORP
reflects the wider real-world spread?

## What I measured
`node scripts/calibrate.js` regresses 2025 ACTUALS on ESPN's own 2025 PRESEASON projections
(stat ids `002025` vs `102025`), per position, over each position's draftable pool.

| pos | r | sd(actual)/sd(proj) | beta = r x sdRatio |
|---|---|---|---|
| QB | **-0.14** | 4.11 | -0.59 |
| RB | 0.70 | 1.46 | 1.03 |
| WR | 0.42 | 1.65 | 0.69 |
| TE | 0.51 | 1.42 | 0.73 |
| LB | 0.14 | 2.50 | 0.36 |
| DST | 0.38 | 2.26 | 0.85 |
| K | 0.14 | 1.52 | 0.22 |

## Why I did NOT apply it
**The QB row is a one-season injury artifact, not a signal.** Among 2025's top-projected QBs,
Burrow (proj 4645 pass yds -> played 8 games), Stroud (4477 -> 14 g) and Mahomes (4349 -> 14 g)
all got hurt, while Maye (3664 -> 4394) and Goff (4337 -> 4564) overperformed. That alone flips
the correlation negative. With n=24 and a single season, the estimate is far too noisy to act on
— and applying beta = -0.59 would literally **invert the QB board**. Catastrophic if wrong.

A multi-season calibration (2019-2025) would be worth doing; one season is not.

## The one robust takeaway I DID keep
**ESPN projects 17 games played for essentially every player**, so its projections carry no
injury discount at all. That is a real, systematic bias. It is handled where it belongs — in the
explicit injury penalty in `src/recommend.js` (OUT/IR/SUSPENSION) — rather than by rescaling
whole positions on noisy evidence.

## Net effect on strategy
Truth sits between the two numbers. See your own league strategy notes, which are written from
the 2025 *actuals* backtest (the more honest estimate of real spread) rather than from ESPN's
compressed projections.
