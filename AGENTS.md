# ff-house-rules

Fantasy football draft companion and season manager. Node >= 20.11, ESM, zero npm dependencies.

## Private data lives outside this repo

This repo is public. League configs, draft history, synced rosters and notes live in a separate
data root, resolved by `src/league.js`: `$FF_DATA`, else a sibling `../<repo>-data`
(`../ff-house-rules-data` by default), else this repo with everything gitignored.

**If `../ff-house-rules-data/START-HERE.md` exists, read it before doing anything else.** It holds
the current state of the leagues, the weekly routine, and the outstanding work.

## Rules that have been broken before

- **Never build a path to `data/` or `config/` by hand.** Use the helpers in `src/league.js`
  (`rawPath`, `boardPath`, `statePath`, `dataDir`, `configDir`). `fetch-espn.js` once wrote to
  `<repo>/data/raw`, and every projection refresh silently did nothing.
- **Nothing league-specific goes in this repo** — no league ids, team or manager names, ESPN
  account ids or pick numbers, in code, docs, or commit messages. Commit messages have leaked
  before; scan them too.
- **ESPN cookies are never committed**, here or anywhere (`config/espn-cookies.json`,
  `local/espn-auth.json`). `espn_s2` is a session token.
- **Measure a tuning change before shipping it**, with the A/B harnesses (`scripts/*-ab.js`,
  `sweep.js`): same slots, same seeds, one knob. If the knob feeds `board.replacement`, rebuild the
  board between arms or the test measures nothing.
- **`server.js` reads the board once at startup** — restart it after any rebuild.

## In-season

Pick a league with `LEAGUE=<id>`. Run `node scripts/season.js sync` before any other in-season
command: without it the roster comes from the draft file, which is wrong after the first
transaction.
