# DATA SOURCE INVENTORY — all empirically tested 2026-08-28 ~15:20 UTC

## TIER 1 — RELY ON THESE TONIGHT (zero setup, all verified working)

### 1. DynastyProcess ID crosswalk — **THE critical find**
- URL: `https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv`
- Auth: NO. `curl -sL -o db_playerids.csv "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv"` → **HTTP 200, 2.6MB, 12,484 rows**
- Shape: 35 cols incl. `mfl_id, sportradar_id, fantasypros_id, gsis_id, pff_id, sleeper_id, espn_id, yahoo_id, cbs_id, pfr_id, rotowire_id, ktc_id, name, merge_name, position, team, db_season`
- **Freshness: rebuilt TODAY 2026-08-28T11:36:28Z** (automated weekly pipeline, Fridays). All 12,484 rows tagged `db_season=2026`.
- **Join test result: 100.0% of ESPN's top-300 players-by-ADP resolve** (300/300); 98.8% across all 2,520 ESPN players with ADP; **864/868 (99.5%) of IDP players with 2026 projections**. 2026 draft class = 294 players, 100% have BOTH sleeper_id and espn_id.
- ToS risk: none, public CC-licensed GitHub repo.

### 2. ESPN `/players` (already known, but I found the important details)
- Full pull: **HTTP 200, 39MB, 1.03s**, 11,617 players. Chase ADP 4.02, ownership timestamped today.
- **`limit` in x-fantasy-filter does NOT work** on `kona_player_info` — always returns all 11,617. Don't fight it; pull once (1 second) and cache. ADP doesn't move mid-draft anyway.
- Lightweight poller exists: `view=players_wl` with NO filter → **12KB / 0.03s**, 50 players, includes `ownership` + `lastNewsDate`. Adding a filter to it strips ownership.
- **No rate limiting observed** (5 rapid consecutive calls, all 200, ~30ms each).

### 3. **ESPN IDP stat-ID decode — verified against nflverse 2025 actuals**
This is what makes the DP slot solvable. I cross-checked ESPN's `002025` actuals against nflverse `stats_player_reg_2025.csv` for 6 players:

| ESPN id | Meaning | Evidence |
|---|---|---|
| **109** | **total tackles** | `107+108==109` holds for **738/738** IDP players, zero failures |
| 108 | solo tackles | Garrett 43 vs nflverse 40 |
| **107** | **assisted tackles** | EXACT: Franklin 63=63, Wagner 83=83, Garrett 17=17, Baker 63=63 |
| **99** | **sacks** | EXACT: Wagner 4.5=4.5, Garrett 23=23, Baker 0.5=0.5 |
| **95** | **interceptions** | EXACT: Wagner 2=2, Baker 1=1 |
| **106** | **forced fumbles** | EXACT: Garrett 3=3, Franklin 1=1, Hendrickson 1=1 |
| 96 | fumble recovery (likely) | lower confidence |
| 113 | passes defended | EXACT: Franklin 5, Wagner 4, Baker 5 |
| 100 | **derived artifact = 2×sacks exactly** — DO NOT COUNT | Garrett 46=2×23 |

Because this league scores solo AND assist at 1.0 each, **you just use id 109 directly** — no solo/assist split needed. League DP formula: `109*1.0 + 99*2 + 95*2 + 96*2 + defTD*6`.

**Actionable output (868 IDP have 2026 projections):** DP1 Blake Cashman 191.8 pts (ADP 74) → DP12 Quay Walker 148.9 (ADP 165) → DP24 131.0. **Gap DP1→DP12 is only 42.9 pts over 14 weeks ≈ 3 pts/week, but costs ~90 draft picks. Wait on DP.** Top of board: Cashman 191.8, Jordyn Brooks 188.5, Jack Campbell 166.0, Cedric Gray 165.7 (ADP 125, 81% own), Nick Bolton 165.1.

### 4. Sleeper — no auth, fast, but ONE TRAP
- `https://api.sleeper.app/v1/state/nfl` → 200, confirms `season 2026, pre week 3`
- `https://api.sleeper.app/v1/players/nfl` → **200, 14.6MB, 0.28s**, 12,225 players
- `https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=25` → 200 (and `/drop`)
- **TRAP: `espn_id` is only 42–48% populated and is DEAD for modern players.** Coverage by entry year: 2020 and earlier = 100%; 2021 = 10/47; 2022 = 6/62; 2023 = 10/84; 2024 = 9/104; **2025 = 0/104; 2026 = 0/68.** Ja'Marr Chase's `espn_id` is `null`. Never join Sleeper→ESPN on `espn_id` — go through db_playerids.csv.
- **Best injury feed available:** 664 active players carry `injury_status` (440 Questionable, 109 IR, 40 PUP, 5 Out, 8 Sus) plus `injury_body_part`, `practice_participation`, `news_updated` epoch-ms. Most recent news stamp 2026-08-28T14:55Z (~25 min before test); 116 players updated in last 24h. Live flags right now include Mahomes (Knee-ACL), CMC (Undisclosed), Kittle (Achilles), Mike Evans (Foot).
- **No public ADP endpoint** — `/v1/adp/nfl/2026`, `/v1/players/nfl/adp/2026`, `/v1/draft/nfl/adp` all **404**.
- ToS: public undocumented API, no key. Sleeper asks <1000 calls/min. Low risk.

### 5. FantasyFootballCalculator — real human ADP, exactly your league size
- `https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2026` (**must follow redirect, `-L`** — the www host 301s)
- → **HTTP 200**, `{status, meta:{type:PPR, teams:12, rounds:15, total_drafts:8104, start_date:2026-08-21, end_date:2026-08-28}, players:[...]}`, **265 players**
- Per player: `adp, adp_formatted, times_drafted, high, low, stdev, bye, position, team`
- **Update frequency: rolling 7-day window, recomputed daily.** 8,104 real drafts.
- Positions: RB 69, WR 91, TE 27, QB 30, DEF 25, PK 23. **No IDP.**
- **`stdev` is the sleeper feature** — tells you who might last another round. Highest-variance in top 60 are all QBs/TEs: Josh Allen ADP 33.6 (range 9–50, stdev 9.3), Colston Loveland 56.4 (32–80), Burrow 57.2 (36–75), Maye 50.4, Lamar 56.8 (37–73), Bowers 35.1 (16–52). **Note this is standard-scoring ADP — in your QB-premium format those QBs are badly underpriced by this market AND highly variable, so the room may let one fall.**

### 6. FantasyPros — API paywalled, HTML scrape works, **includes IDP**
- ❌ `https://api.fantasypros.com/v2/json/nfl/2026/consensus-rankings?...` → **HTTP 403 `{"message":"Forbidden"}`** (needs paid key)
- ✅ HTML pages embed `var ecrData = {...};` — parse with `/var\s+ecrData\s*=\s*(\{[\s\S]*?\});/`. Requires a browser User-Agent.
- `nfl/rankings/ppr-cheatsheets.php` → 200, **517 players, 107 experts, updated 8/28 (today)**, 16 tiers. Per player: `rank_ecr, rank_min, rank_max, rank_ave, rank_std, tier, pos_rank, player_bye_week, player_owned_avg, player_id` (= `fantasypros_id`, joins via db_playerids.csv).
- **IDP pages confirmed working:** `rankings/lb.php` (340 players), `dl.php` (437), `db.php` (435), `idp-cheatsheets.php` (194), `dst.php` (52), `k.php` (50).
- **IDP caveat:** LB page is only **3 experts, STD scoring, updated 8/25**, and `tier` is undefined on IDP pages. Use it as a sanity check, not a source of truth — your rescored ESPN projections are better. (FP LB1 Jordyn Brooks vs my rescore's Cashman/Brooks 1-2 — broadly agrees.)
- ❌ `nfl/adp/ppr-overall.php` has NO `ecrData` — it's a plain HTML table needing separate parsing. Use FFC instead.
- ToS risk: **MEDIUM — this is scraping, FP ToS prohibits it.** Cache aggressively, one fetch per page per session, real UA. Don't hammer.

### 7. nflverse — fully alive with 2026 data (in-season workhorse)
- Release index: `https://api.github.com/repos/nflverse/nflverse-data/releases?per_page=100` → 200, 25 tags
- Download pattern: `https://github.com/nflverse/nflverse-data/releases/download/{tag}/{asset}` (needs `-L`)
- Verified 200: `depth_charts/depth_charts_2026.csv` (45MB), `rosters/roster_2026.csv` (927KB), `weekly_rosters/roster_weekly_2026.csv`, `snap_counts/snap_counts_2025.csv` (2.4MB), `stats_player/stats_player_reg_2025.csv` (882KB), `pfr_advstats/advstats_season_def.csv` (842KB), `ftn_charting/ftn_charting_2025.csv` (8.1MB), `players/players.csv` (7MB, 25,065 rows)
- **Freshness: schedules updated 2026-08-28 (today); depth_charts, weekly_rosters, players all 2026-08-27; stats_player/stats_team 2026-08-26.** Typically refreshes within ~24h of games.
- `stats_player_reg_YYYY.csv` has the full IDP column set: `def_tackles_solo, def_tackle_assists, def_tackles_for_loss, def_fumbles_forced, def_sacks, def_qb_hits, def_interceptions, def_pass_defended, def_tds`. This is your in-season DP truth source.
- `players/players.csv` has `espn_id, gsis_id, pfr_id, pff_id, otc_id` but **NO `sleeper_id`** — that's why DynastyProcess is the crosswalk, not this.
- ❌ `nextgen_stats/ngs_2025_receiving.csv.gz` → 404 (naming varies by year; enumerate assets from the API rather than guessing).
- ToS: none, public CC-BY. Prefer `.parquet`/`.csv.gz` over `.csv` for bandwidth.

---

## TIER 2 — WORKS, LOWER VALUE

**Boris Chen** — partially alive, **extension is `.txt` not `.csv`**
- ✅ 200: `https://s3-us-west-1.amazonaws.com/fftiers/out/text_{RB,WR,QB,TE,FLX,K,DST,PPR-RB,PPR-WR,PPR-TE}.txt`
- ❌ 403 AccessDenied: every `.csv` variant, plus `PPR-FLX`, `half-PPR-*`, and **all IDP (`LB`, `DL`, `DB`, `IDP-LB`)**
- Format is human-readable text: `Tier 1: Jahmyr Gibbs, Bijan Robinson, Jonathan Taylor, ...` — needs name-parsing, no IDs.
- **Largely redundant** — FantasyPros `ecrData` already gives you `tier` as an integer with 107 experts.

**RotoWire RSS** — `https://www.rotowire.com/rss/news.php?sport=NFL` → **200, 3.3KB, `<ttl>10</ttl>`** (10-min refresh). Clean XML, item guids like `nfl634997`. Good pollable in-draft news ticker, but no player IDs — needs name matching.

**ESPN general news** — `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50` → 200, articles with `lastModified`/`published` (freshest was 2026-08-28T15:15Z, a fantasy-relevant Sam LaPorta item). Usable.

---

## TIER 3 — FAILED / DON'T BOTHER (verified negatives)

| Source | Result |
|---|---|
| FantasyPros API v2 | **403 Forbidden** — paid key required |
| Sleeper ADP (3 URL patterns) | **404** — no public ADP endpoint exists |
| Underdog (4 URL patterns tried) | **404** on all — `api.underdogfantasy.com/v1/rankings`, `/v2/rankings/best_ball_adp`, `/v1/pickem/rankings`, `stats.underdogfantasy.com/v1/adp` |
| Boris Chen IDP + all `.csv` | **403 AccessDenied** |
| ESPN fantasy player news | `site.api.espn.com/apis/fantasy/v2/games/ffl/news/players` → **403, blocked at Akamai edge** |
| ESPN core injuries | `sports.core.api.espn.com/.../injuries` → **404**; per-team `.../teams/12/injuries` → 200 but **empty `{}`** |
| ESPN RSS | `espn.com/espn/rss/nfl/news` → **202, 0 bytes** |
| DraftKings | `api.draftkings.com/draftgroups/v1/draftgroups` → **400**. `draftkings.com/lobby/getcontests?sport=NFL` → 200/2.9MB but it's **DFS contest data, not season-long ADP** — irrelevant to a snake draft |

---

## RECOMMENDED STACK FOR TONIGHT

**Pre-draft (run once, ~3 seconds total):** ESPN `/players` kona_player_info (39MB) + `db_playerids.csv` + FFC PPR 12-team ADP + FP `ppr-cheatsheets.php` + Sleeper `/players/nfl`. Join everything on `espn_id` → crosswalk → `sleeper_id`/`fantasypros_id`. Rescore all projections with league scoring (QB 0.1/passyd + 6/passTD; DP formula above).

**In-draft:** nothing needs re-fetching — ADP is static during a draft. Poll Sleeper `/players/nfl` every ~5 min only for late injury scratches (it caught news 25 min old), and RotoWire RSS (ttl 10) as a ticker.

**Two gaps you should know about:**
1. **Live pick tracking still needs auth.** Every source here is pre-draft board data. Reading who's actually been drafted requires the league endpoint (401 without `espn_s2`+`SWID`) or driving the Chrome MCP against the logged-in draft room. That's the one unsolved piece for "live in-draft monitoring" — worth resolving before 6PM.
2. **`stdev` from FFC + QB-premium scoring is your biggest edge signal.** The public market prices QBs at standard scoring with huge variance (Josh Allen range 9–50). Your league makes a 4500/35 QB worth ~660 passing points alone. Build the QB tier off rescored ESPN projections, not any external ranking — every external source here is standard/PPR-scored and will systematically underrate QBs for you.

**Cached artifacts** (all in `<local scratch>`): `espn_players.json` (39MB), `sleeper_players.json` (14.6MB), `db_playerids.csv`, `ffc.json`, `fp_ppr.html`, `fp_lb.html`, `players.csv`, `ps2025.csv`, `nflv.json`. Working scripts: `jointest2.js` (join validation), `decode.js` (stat-ID decode vs nflverse), `dp.js` (DP rescoring).