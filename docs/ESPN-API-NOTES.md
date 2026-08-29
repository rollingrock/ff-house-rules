# ESPN Fantasy API — verified findings (probed 2026-08-28)

Base: https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026

## PUBLIC (no auth) — VERIFIED WORKING
- `/players?scoringPeriodId=0&view=kona_player_info` + `x-fantasy-filter` header
  -> **11,617 players, 39MB**. Includes IDP. This is THE endpoint.
  Per player: fullName, id, defaultPositionId, eligibleSlots, injured/injuryStatus,
  ownership{averageDraftPosition, auctionValueAverage, percentOwned, percentStarted},
  draftRanksByRankType{PPR:{rank,auctionValue}}, seasonOutlook, stats[]
  stats[] entries keyed by id:
    "102026" statSourceId=1 -> 2026 FULL-SEASON PROJECTION (raw stats dict)
    "002025" statSourceId=0 -> 2025 actual season totals
    "1120261".."11202618"   -> 2026 PER-WEEK projections (week = trailing digits)
    "002026"                -> 2026 actuals (0 until games played)
  `stats` dict = raw stat-id -> value. NOT pre-scored => can rescore for custom scoring. KEY.
- `/players?view=players_wl` -> light universe list (648KB)
- `/leaguedefaults/{1..6}?view=kona_player_info` -> works but universe is FILTERED to that
  default's roster slots => **no IDP**. Do not use for this league. Use /players instead.

## Slot IDs (confirmed from eligibleSlots)
0 QB, 2 RB, 3 RB/WR, 4 WR, 5 WR/TE, 6 TE, 7 OP, 8 DT, 9 DE, 10 LB, 11 DL,
12 CB, 13 S, 14 DB, **15 DP**, **16 D/ST**, **17 K**, 20 BE, 21 IR, 23 FLEX
(verified: Barham LB -> [10,15,20,21]; Aubrey K -> [17,20,21]; Texans D/ST -> [16,20,21];
 Travis Hunter -> [3,4,5,23,7,20,21,12,14,15] i.e. WR+CB+DP eligible)

## Stat IDs — partially decoded, NEEDS VERIFICATION
Offense: 23 rushAtt, 24 rushYds, 25 rushTD, 42 recYds, 43 recTD, 53 receptions,
         58 targets, 61 recYds/g, 210 games. (3/4/20 = passYds/passTD/INT expected)
IDP (from Barham LB): 107 soloTackles, 108 assistTackles, 109 totalTackles (107+108 checks out)
K (from Aubrey): 74-88 = FG made/att by distance bucket, 198-200 = ?
D/ST (Texans): 89-106 = sacks/INT/FR/TD etc, 109-111 = team tackle/yardage counters
=> MUST build a verified stat-id map before scoring. Highest-risk unknown.

## PRIVATE (401 without cookies) — NEEDS SETUP
- `/leagues/<your-league-id>?view=mSettings|mTeam|mRoster|mDraftDetail|mMatchup`
  -> 401 AUTH_LEAGUE_NOT_VISIBLE. Requires cookies `espn_s2` and `SWID` from a
  logged-in browser session. **This is the one thing I need from the author.**
  Unlocks: live draft board, opponent rosters, who-picked-what, waiver wire, my lineup.
