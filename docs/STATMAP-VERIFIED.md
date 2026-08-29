# ESPN Fantasy Football Stat ID Map — VERIFIED

## Method & evidence base
Cross-checked 3 ways: (1) `cwendt94/espn-api` source (`constant.py` — **two maps**, `PLAYER_STATS_MAP` and `SETTINGS_SCORING_FORMAT_MAP`; the settings map is the more accurate one and I found real errors in the player map); (2) live endpoint pull, full 2026 universe, 11,617 players / 3,024 with stats, saved at `<local scratch>`; (3) web-verified 2025 box scores + internal arithmetic identities run across all players.

**Arithmetic identities that passed at scale** (strongest evidence class):
- `109 == 107+108` — **1425/1425 players, zero mismatches**
- `73 == 20+72` (turnovers = INT thrown + fumbles lost) — **210/210**
- D/ST points-allowed brackets and yards-allowed brackets each sum to games played — **32/32 teams, both**
- K: `83==74+77+80`, `74==198+201`, `75==199+202` — 38–42/42 each

**Web-verified box scores:** Garrett 43 solo/17 ast/23 sk; Chase 125 rec/1412 yd/8 TD/185 tgt/16 g; Allen 3668/25/10 + 579/14, 69.3% comp; Aubrey 36-42 FG, 11-17 from 50+, 47-48 XP, long 64.

---

## ⚠️ THREE CORRECTIONS TO THE ORCHESTRATOR'S HYPOTHESES

**1. `107`/`108` ARE REVERSED. This is the big one — it's an IDP league.**
`107 = ASSISTED tackles`, `108 = SOLO tackles`. Proof: Myles Garrett (edge rusher, solo-heavy by nature) has `108=43, 107=17`, and the web confirms **43 solo / 17 assists**. Hendrickson `108=11, 107=5`. Off-ball LBs are near 50/50 so they can't distinguish it — an edge rusher is the discriminating test.
*Practical impact for THIS league: none numerically*, because you score solo and assist at 1.0 each, so `109` is correct and safe. But it matters the moment you display "solo tackles" in a UI or reason about tackle floor vs. big-play upside. **Use `109` for scoring.**

**2. `42` is receiving yards but `53` — not `41` — is the receptions id you must use.** Both `41` and `53` equal receptions in *actuals* (Chase: both = 125). But **`41` is absent from every projection**; only `53` appears in `102026` and weekly. Keying on 41 silently zeroes all PPR points in a full-PPR league.

**3. Kicker `74` is "50+" aggregate, NOT the 50-59 bucket your league scores.** Your league pays FG50-59=4 and FG60+=5. Correct ids are **`198` (50-59)** and **`201` (60+)**. `74 = 198+201`. Using 74 for the 4-pt bucket overpays 60-yarders.

---

## OFFENSE (confidence: HIGH unless noted)

| id | meaning | applies to | conf |
|---|---|---|---|
|0|pass attempts|QB|HIGH|
|1|pass completions|QB|HIGH|
|2|pass incompletions (=0−1)|QB|HIGH|
|**3**|**passing yards**|QB|**HIGH** (Allen 3668 ✓)|
|**4**|**passing TD**|QB|**HIGH** (25 ✓)|
|5,6,7,8,9,10|every 5 / 10 / 20 / 25 / 50 / 100 pass yds|QB|HIGH|
|11,12|every 5 / 10 completions|QB|HIGH|
|13,14|every 5 / 10 incompletions|QB|HIGH — *actuals only, absent from projections*|
|15,16|40+ / 50+ yd TD pass. **16 ⊂ 15** (nested, don't sum)|QB|HIGH|
|17,18|300-399 / 400+ yd pass game|QB|HIGH|
|19|2pt pass conversion|QB|HIGH|
|**20**|**INT thrown**|QB|**HIGH** (Allen 10 ✓; 73 identity)|
|21|completion pct (0–1 decimal)|QB|HIGH (0.693 ✓)|
|**22**|**passing yards PER GAME** ⚠ *not* a dup of 3|QB|**HIGH** (3668/17=215.76 ✓)|
|23,24,25|rush att / **rush yds** / **rush TD**|all|HIGH (579/14 ✓)|
|26|2pt rush conversion|all|HIGH|
|27–34|every 5/10/20/25/50/100 rush yds; every 5/10 rush att|all|HIGH|
|35,36|40+ / 50+ yd TD rush (**36 ⊂ 35**)|all|HIGH|
|37,38|100-199 / 200+ yd rush game|all|HIGH|
|39|rush yds per attempt|all|HIGH|
|**40**|**rush yards PER GAME** ⚠|all|**HIGH** (579/17=34.06 ✓)|
|41|receptions — **actuals only, NOT in projections**|all|HIGH|
|**42**|**receiving yards**|all|**HIGH** (Chase 1412 ✓)|
|**43**|**receiving TD**|all|**HIGH** (8 ✓)|
|44|2pt receiving conversion|all|HIGH|
|45,46|40+ / 50+ yd TD rec (**46 ⊂ 45**)|all|HIGH|
|47–52|every 5/10/20/25/50/100 rec yds|all|HIGH|
|**53**|**receptions ← USE THIS ONE**|all|**HIGH** (125 ✓, in projections)|
|54,55|every 5 / 10 receptions|all|HIGH|
|56,57|100-199 / 200+ yd rec game|all|HIGH|
|**58**|**targets**|all|**HIGH** (185 ✓)|
|59|receiving yards after catch|all|MED (actuals only)|
|60|rec yards per reception|all|HIGH (1412/125 ✓)|
|**61**|**rec yards PER GAME** ⚠|all|**HIGH** (1412/16 ✓)|
|62|total 2pt conversions|all|HIGH|
|63|fumble recovered for TD|all|MED|
|64|times sacked|QB|HIGH|
|65,66,67|passing/rushing/receiving fumbles|—|**LOW — DO NOT USE**|
|**68**|**total fumbles**|all|MED|
|69,70,71|passing/rushing/receiving fumbles lost|—|**LOW — DO NOT USE**|
|**72**|**total fumbles LOST** ← your −2 rule|all|**HIGH** (73 identity, 210/210)|
|73|total turnovers (=20+72)|all|HIGH|
|175–178|0-9/10-19/20-29/30-39 yd TD **pass** bonus|QB|HIGH (175+176+177+178+15 = 25 = total passTD ✓)|
|179–182|same buckets, TD **rush**|all|HIGH|
|183–186|same buckets, TD **reception**|all|HIGH (Chase 4+3+1=8 ✓)|
|210|games played|all|HIGH|
|211,212,213|passing / rushing / receiving first downs|all|HIGH|

**Fumble sub-split warning:** `65+66+67 == 68` fails on **168 of 275** players, and `69+70+71 == 72` fails on **134 of 275**. These sub-splits are populated inconsistently by ESPN's feed. Only the aggregates `68` and `72` are trustworthy — and `72` is independently proven by the turnovers identity. Your −2 fumble rule → **id 72**.

---

## KICKER (all HIGH — Aubrey's line reconciles perfectly)

`74/75/76` = made/att/missed **50+** · `77/78/79` = **40-49** · `80/81/82` = **0-39** · `83/84/85` = **total** made/att/missed · `86/87/88` = XP made/att/missed · **`198/199/200` = 50-59** · **`201/202/203` = 60+** · `214/215/216` = FG made/missed/attempt **yards** · `217–234` = every-N-yards increments.

Aubrey 2025: 198=8 + 201=3 → 74=11 ✓ (web: 11-17 from 50+). 74+77+80 = 11+10+15 = 36 = 83 ✓ (web: 36-42). 86=47, 87=48 ✓ (web: 97.9%).

**🚨 CRITICAL PROJECTION GAP:** `201/202/203` (60+) are **entirely absent from `102026` projections** — ESPN projects zero 60-yard FGs for every kicker in the league. Your FG60+ = 5pts rule contributes **exactly 0** to any projected total. Aubrey actually made 3 from 60+ in 2025 (long 64). If you want his real edge to show up in the draft model, hand-add ~2-3 × 5pts for him specifically. In projections `74 == 198` identically, so the 4-pt bucket is safe to read from either.

---

## IDP — the DP slot (all HIGH; present in both actuals and projections)

| id | meaning | conf | your scoring |
|---|---|---|---|
|**107**|**assisted tackles**|HIGH|1.0 |
|**108**|**solo tackles**|HIGH|1.0 |
|**109**|**total tackles (=107+108, 1425/1425)**|**HIGH**|**1.0 ← use this**|
|110,111|every 3 / every 5 total tackles|HIGH|—|
|112|stuffs / TFL|MED|—|
|113|passes defensed|MED-HIGH|—|
|**95**|**interceptions**|HIGH|2|
|**96**|**fumbles recovered**|HIGH|2|
|**99**|**sacks** (halves as .5)|HIGH (Garrett 23 ✓)|2|
|100|half-sacks (= 99 × 2, exact)|HIGH|—|
|106|forced fumbles|HIGH|—|
|**94**|**defensive TD** (INT-ret + FR-ret; `=103+104`)|HIGH|6 ← use this|
|93|blocked kick returned for TD|MED|—|
|97|blocked kicks|MED|—|
|98|safeties|MED|—|
|103,104|INT-return TD / fumble-return TD|HIGH|—|
|105|**total** return TD (`=94+93`, incl. special teams)|HIGH|—|

**Def-TD id choice:** use **`94`** (pure defensive). `105` adds blocked-kick and, for D/ST, kick/punt-return TDs — double-counts if you also score return TDs. Verified: Franklin proj `103=.081 + 104=.038 = 94=.119`, and `94+93=.128=105`.

**Per-game increment quirk (affects 5–14, 27–34, 47–52, 110, 111, 116–119):** these are computed **per game then summed**, not from the season total. Allen: 3668 pass yds but id 5 = 726, not 733. Never derive them yourself.

---

## D/ST (all HIGH — 32/32 teams reconcile on both bracket families)

**Points allowed:** `120` = total PA · `126` = PA/game · brackets **`89`**=0, **`90`**=1-6, **`91`**=7-13, **`92`**=14-17, **`121`**=18-21, **`122`**=22-27, **`123`**=28-34, **`124`**=35-45, **`125`**=46+.

**Yards allowed:** `127` = total YA · `137` = YA/game · brackets **`128`**=<100, **`129`**=100-199, **`130`**=200-299, **`131`**=300-349, **`132`**=350-399, **`133`**=400-449, **`134`**=450-499, **`135`**=500-549, **`136`**=550+.

Both families sum to exactly 17 for all 32 teams. Falcons PA: 0+2+0+2+2+6+4+1 = 17 ✓. YA: 0+1+6+6+2+0+1+1+0 = 17 ✓.

**Use the 89–92/121–125 set, NOT 187–196.** `187` (=`120`) and `188–196` are D/ST-prefixed duplicates that exist **only in actuals** — they are absent from `102026` projections. Verified identical values (Falcons: 188=0,189=2,190=0,191=2,192=2,193=6,194=4,195=1 mirrors 89,90,91,92,121,122,123,124).

Also on D/ST: `95` INT, `96` FR, `97` blocked kicks, `98` safeties, `99` sacks, `106` FF, `101/102` KR/PR TD, `109` team total tackles, `114/115` KR/PR yards, `116/117` every 10/25 KR yds, `118/119` every 10/25 PR yds.
⚠ espn-api's `PLAYER_STATS_MAP` mislabels **`118` as "puntsReturned"** — it is *every 10 punt-return yards* (Falcons 115=168 yds → 118=12). Use the settings map.
`128` (<100 yds allowed) is real but was **0 for all 32 teams** and is absent from projections — effectively dead.

---

## Bonus findings (operationally useful tonight)

**`stats[].id` format decodes as `{statSourceId}{statSplitTypeId}{seasonId}{scoringPeriodId}`:**
- `102026` = 2026 season projection ← draft board
- `002026` = 2026 actuals — **exists but empty today**; this is what populates in-season for live scoring
- `1120261`…`11202618` = 2026 **weekly** projections, wk 1-18, ~1,554 players (`11202619-22` = playoffs, 44 entries)
- `002025` = 2025 actuals; `102025` = 2025 preseason projection (useful for measuring ESPN's projection bias)
- `0140177xxxx` = individual 2025 **game** logs keyed by ESPN gameId

**Bye weeks are extractable for free:** an empty weekly projection = bye. Resolved **all 32 teams unanimously** (CIN W6, IND W11, BUF W7, KC W5, DAL W14, ARI W14…). No extra API call needed for bye-week draft/lineup logic.

**Team context on every player:** `155/156/157` = his team's W/L/T, `158` = team points scored. Present on offensive players too — do **not** mistake `158` for player fantasy points.

**End-to-end validation:** I implemented your league's scoring against this map on `102026`. It reproduces both stated distortions exactly — QBs occupy **all of the top 25** (Allen 659, Stafford 620, Maye 619 vs. Gibbs 365 RB1), and tackle-machine LBs dominate DP (Cashman 193 / Brooks 189 vs. Garrett 90), with several 180-tackle LBs going at ADP 70-125. The map is sound.

## Could NOT confirm (low/no evidence)
- `65,66,67,69,70,71` fumble sub-splits — **actively fail arithmetic; do not use**
- `112` stuffs/TFL, `113` passes defensed, `97` blocked kicks, `98` safeties — plausible and consistently placed, but no external box-score cross-check; all low-frequency
- `128` <100 yds allowed — never nonzero in 2025
- `138–154` punter, `159,173` per-game HC rates, `204,207,208,209` (offensive 2pt return, 1pt safeties) — **not observed in any player record**; no P/HC slots in this game's universe. Irrelevant to your league.
- `205/206` defensive 2pt returns — observed on D/ST actuals only, never nonzero
- `022026`-style 2026 actuals — structurally present, empty until Week 1 kicks off

Sources: [espn-api constant.py](https://raw.githubusercontent.com/cwendt94/espn-api/master/espn_api/football/constant.py) · [Garrett 2025](https://www.espn.com/nfl/player/gamelog/_/id/3122132/myles-garrett) · [Chase 2025](https://www.espn.com/nfl/player/gamelog/_/id/4362628/jamarr-chase) · [Allen 2025](https://www.espn.com/nfl/player/gamelog/_/id/3918298/josh-allen) · [Aubrey 2025](https://www.foxsports.com/nfl/brandon-aubrey-player-stats?category=kicking&seasonType=reg)