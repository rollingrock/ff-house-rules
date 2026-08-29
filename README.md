# ff-house-rules

**A fantasy football draft companion and season manager that scores every projection under your
league's actual rules — not the defaults.**

Most fantasy tools rank players for a generic league. If yours pays 6 points for a passing
touchdown, starts an IDP, uses full PPR, or has four flex slots, those rankings are quietly wrong
for you — and the wrongness is largest exactly where the edge is.

This reads your league's real scoring settings out of ESPN, re-scores every player against them,
computes value over replacement for *your* roster shape, and then advises you live during the
draft and every week of the season.

**No npm dependencies, no build step, no database.** Node ≥ 20.11 runs everything described
below.

The one exception is the optional live-draft sidecar (`scripts/draft-watch.py`), which needs
Python 3 and two packages: `pip install -r requirements.txt`. It is disabled by default — see
below for why — so you can ignore it entirely.

---

## What it actually does

**Before the draft** — pulls ESPN's projections and your league settings, re-scores all ~1,200
players under your rules, computes replacement level per position from how your league actually
drafts, blends in consensus ADP, and builds a tiered board.

**During the draft** — a local web app on your laptop (and your phone, over your wifi). Type each
pick as it happens, or let it sync from ESPN. For every available player it shows:

- **pick value** — marginal points added to your best starting lineup, plus urgency
- **% lasts** — probability he survives to your next turn
- **why** — position runs, roster holes, bye-week collisions

The core idea is simple: when two players are close in value, take the one **less likely to last**.

**During the season** — optimal weekly lineup, waiver targets, and a bye-week report that tells
you which weeks you cannot field a full roster.

---

## Quick start

```bash
git clone https://github.com/rollingrock/ff-house-rules.git
cd ff-house-rules

# 1. generate a config from your league's real ESPN settings
node scripts/make-league-config.js <your-espn-league-id>

# 2. pull projections and build the board
node scripts/fetch-espn.js
node scripts/build-board.js

# 3. run it
node server.js            # → http://localhost:8777
```

Your ESPN league id is the number in the URL when you view your league:
`fantasy.espn.com/football/league?leagueId=`**`123456`**

### Private leagues need a cookie

Public leagues work with no credentials. For a private league you need two cookies from a browser
where you're logged into ESPN — `espn_s2` and `SWID`. Put them in `config/espn-cookies.json`:

```json
{ "espn_s2": "...", "SWID": "{...}" }
```

That file is gitignored. **Treat `espn_s2` like a password** — it is a session token for your ESPN
account.

---

## Multiple leagues

Configs live in `config/`, one JSON per league. Pick one with `LEAGUE`:

```bash
LEAGUE=my-dynasty node server.js
LEAGUE=my-dynasty node scripts/season.js lineup 4
```

With exactly one config present it's selected automatically. With several and no hint, every
command stops and lists them rather than guessing.

### Keeping your league data private

The engine is public; your configs, draft history and notes probably shouldn't be. Put them in a
separate private directory and point `FF_DATA` at it:

```
repos/
  ff-house-rules/        # this repo, public
  ff-house-rules-data/   # yours, private
    config/
    data/
```

A sibling directory named `<repo>-data` is picked up automatically. Otherwise set `FF_DATA`
explicitly. With neither, everything just lives in the repo (and is gitignored).

---

## Draft night

Two things to know.

**Type every pick — yours and everyone else's.** Three or four letters and Enter. The app knows
whose turn it is from the snake order. This path has no dependencies and cannot fail.

**Keys:** `1`–`9` draft that recommendation · `Ctrl`+`Z` undo · `/` focus search · `Esc` clear
search · `S` sync from ESPN.

Read the screen in this order: the clock pill → the top recommendation's value → `% lasts` → the
reason line.

### ⚠️ The live feed is disabled, and you should know why

`scripts/draft-watch.py` connects to ESPN's draft-room websocket to record picks automatically.
**It does not work, because ESPN allows one connection per team and the watcher joins as you — so
it evicts you from your own draft room.** Discovered live, twenty minutes before a real draft.

Using it would require a second ESPN account in the league as a spectator. It is left in the repo,
documented and disabled, because the protocol decoding is genuinely useful if someone wants to
solve the credential problem properly.

Until then: **type the picks.** It takes about four keystrokes every thirty seconds.

---

## In-season

```bash
node scripts/season.js lineup 5     # optimal lineup for week 5
node scripts/season.js waivers 5    # waiver targets
node scripts/season.js byes         # weeks you cannot fill a lineup
```

Injuries and role changes go in `config/news-overrides.json`, a multiplier per player, applied at
board-build time:

```json
{ "players": {
  "Some Player": { "mult": 0,    "note": "torn ACL - out for the year" },
  "Other Player": { "mult": 0.88, "note": "hamstring, expected back week 3" }
}}
```

ESPN projects 17 games for **every** player and knows nothing about season-enders, so this is the
highest-leverage manual input in the whole tool.

---

## Measure your changes

Every tuning knob ships with a harness that A/B tests it over paired mock drafts — same slots,
same seeds, one thing changed:

```bash
node scripts/sweep.js                                    # 36 mock drafts, roster legality
node scripts/knob-ab.js draftRules.byeWeights.enabled true false
node scripts/rail-ab.js LB 8 11                          # positional round rails
node scripts/code-ab.js src/recommend.js                 # working tree vs committed
```

This exists because most "improvements" here measured **negative**. An opponent-need model, a
bye-week fix, and a rebuilt replacement-level table were all built, measured, and thrown away.
If a change doesn't survive its A/B, don't ship it.

**One caveat worth inheriting:** any knob that feeds `board.replacement` needs the board rebuilt
between arms, or you'll measure nothing and get a suspiciously clean tie.

---

## How the valuation works

- **Replacement level** — the points of the Nth player at a position, where N is how many your
  league actually drafts. Not a league-average constant.
- **Marginal value** — how much a player adds to your *current best starting lineup*, or his depth
  value if he doesn't crack it, whichever is larger. Monotone in projected points, which sounds
  obvious and was the source of the worst bug in this repo's history.
- **Survival** — a rank-based logistic centred on your pick window, blended with per-player ADP
  standard deviation from real drafts.
- **Bye collisions** — a penalty for stacking starters on the same bye week.

`docs/VALUATION-MATH.md` has the derivations.

### Known limits

- Survival is ADP-based and **blind to opponent need**. It is well calibrated on average (5.2
  points mean absolute error over a real draft) but systematically too confident at one-per-team
  positions — QB, TE, IDP — where a manager decides "I need one now" and ignores ADP.
- Projections are ESPN's. They are mediocre, particularly for backfield committees and rookies.
  The tool corrects the *scoring*, not the underlying forecast.
- ESPN's API is undocumented and changes without notice.

---

## Layout

```
src/          engine: scoring, valuation, recommendation, draft state
scripts/      CLI tools, A/B harnesses, the live feed
web/          the draft-night UI (vanilla JS, no framework)
docs/         stat-id map, valuation maths, ESPN API notes
server.js     local HTTP server
```

---

## License

MIT. Not affiliated with or endorsed by ESPN. Uses ESPN's undocumented fantasy API; be reasonable
with request volume.
