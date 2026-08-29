# ESPN stat-id map — EMPIRICALLY VERIFIED (2026-08-28)

Verified two ways: (1) internal consistency identities, (2) against known real 2025 stat lines.

## Identities that hold across every player (strong proof)
- `107 + 108 = 109`  (solo + assist = TOTAL TACKLES) - holds for LB/S/CB/DE/DT
- `74 + 77 + 80 = 83` (FG made by distance bucket = total FG made)
- `83 + 85 = 84`      (FG made + FG missed = FG attempted)
- `86 + 88 = 87`      (PAT made + PAT missed = PAT attempted)
- `1 + 2 = 0`         (completions + incompletions = pass attempts)
- `5,6,7,8,9,10` = passYds/5, /10, /20, /25, /50, /100 -> DERIVED buckets, never score these

## Verified against real 2025 lines
| Player | id | value | real 2025 | verdict |
|---|---|---|---|---|
| Josh Allen | 3 | 3668 | 3668 pass yds | passYds |
| Josh Allen | 4 | 25 | 25 pass TD | passTD |
| Josh Allen | 20 | 10 | 10 INT | intThrown |
| Josh Allen | 24/25 | 579/14 | 579 rush yds, 14 rush TD | rushYds/rushTD |
| Lamar Jackson | 210 | 13 | played 13 gms | games |
| Ja'Marr Chase | 42/43 | 1412/8 | 1412 rec yds, 8 rec TD | recYds/recTD |
| Ja'Marr Chase | 41 & 53 | 125 & 125 | 125 rec | receptions (BOTH ids; use 53, fallback 41) |
| Fred Warner | 109 | 51 in 6 gms | ankle injury, 6 gms | totalTackles |
| Brandon Aubrey | 83/84/85 | 36/42/6 | 36-of-42 FG | FGM/FGA/FGmiss |
| Brandon Aubrey | 86/87/88 | 47/48/1 | 47-of-48 PAT | PATmade/att/miss |

## Positional-signature proof for defensive ids (mean of top-12 at each position)
| id | DST | DE | DT | LB | S | CB | => meaning |
|---|---|---|---|---|---|---|---|
| 99 | 41.9 | 9.65 | 5.37 | 2.34 | 1.15 | 0.81 | **sacks** (edge>interior>LB>DB) |
| 95 | 12.3 | ~0 | ~0 | 0.91 | 1.95 | 1.90 | **interceptions** (DBs lead) |
| 96 | 7.8 | 1.72 | 0.62 | 1.02 | 0.67 | 0.49 | **fumble recoveries** |
| 106 | 12.0 | 2.65 | 0.95 | 1.57 | 1.03 | 0.75 | **forced fumbles** (edge lead) |
| 112 | - | 7.47 | 5.03 | 6.02 | 2.90 | 3.24 | tackles-for-loss (half values appear) |
| 113 | - | 2.70 | 1.25 | 5.48 | 7.52 | 14.65 | passes defensed (CB lead) |
| 109 | 1027 | 61 | 60 | 153 | 106 | 91 | **total tackles** |

## FG distance buckets - ORDER IS COUNTERINTUITIVE
Aubrey 2025: 74=11, 77=10, 80=15 (sum 36 = FGM). Aubrey led the NFL in long FGs, so:
- **80 = FG 0-39 made** (75 att / 76 miss)  <- the BIGGEST bucket, lowest id-ordinal
- **77 = FG 40-49 made** (78 att / 79 miss)
- **74 = FG 50+ made**   (75? see below)
- **198/199/200 = FG 50-59 made/att/miss** (Aubrey 8/13/5)
=> FG 60+ made = `74 - 198` (Aubrey 11-8 = 3, matches his 60+ reputation)

## Fumbles - the one that bites
Josh Allen 2025: 68=7, 72=3, 73=13.  Allen fumbled 7, lost 3.
- **68 = fumbles (total)**, **72 = FUMBLES LOST** <- this is the -2 one
- 73 coincidentally equals 72 for skill players but NOT for QBs. Do not use 73.

## D/ST team context
- **120 = points allowed (season)**, 126 = points allowed per game
- **127 = yards allowed (season)**, 137 = yards allowed per game
Season totals cannot produce PA/YA *bracket* counts -> use the PER-WEEK projections
(stat ids `1120261`..`11202618`) to score the brackets week by week.

## NEVER SCORE (derived / double-count traps)
5,6,7,8,9,10 (passYds buckets) | 11,12,13,14 (passTD buckets) | 100 (= 99 x 2)
41 if also using 53 | 73 | 61,60 (per-game rates) | 211,212,213 (unidentified aggregates)
| 47,48,49,50,51 (target/reception distance buckets) | 210 is games, not a scoring stat
