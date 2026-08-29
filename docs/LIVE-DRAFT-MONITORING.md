# LIVE DRAFT MONITORING — RANKED RECOMMENDATION

## THE HEADLINE FINDING (this changes the plan)

**`?view=mDraftDetail` does NOT stream picks during a live draft.** It serves an empty pick *skeleton* before the draft, freezes for the entire draft, and flushes all picks atomically at completion. Two independent reverse-engineering efforts measured this on live drafts:

- `worthybrae/fantasy-football` — *"measured in a live 8-team mock: `inProgress` true, 128 picks on the board, every `playerId` still -1 fifteen minutes in."*
- `howell/draft-builder` (real 4-team auction, league 390366456, 2026-07-19) — *"The view then freezes for the entire draft. Zero incremental updates across 44 minutes of picks; cache-busting headers and the `mRoster` view don't help. All 64 picks appeared in one atomic flush at completion."*

Also note: `cwendt94/espn-api`'s `League.draft` is **useless mid-draft by construction** — `base_league._fetch_draft()` opens with `if not data.get('draftDetail', {}).get('drafted'): return`, and `drafted` is `false` until the draft ends. Do not build on `espn-api` for live.

Polling REST as the primary source would have left us blind all night. The real live feed is the draft room's own WebSocket.

---

## RANKING

| # | Path | Latency | Reliability | Verdict |
|---|---|---|---|---|
| **1** | **`wss://fantasydraft.espn.com` draft-room socket, opened directly from Python** | sub-second | High — protocol decoded and **replay-verified by me today** against a real snake capture | **PRIMARY** |
| **2** | `?view=mDraftDetail` poll @ 6s | n/a live | Near-certain to sit frozen; **authoritative at completion** | **RUN CONCURRENTLY** (free insurance + post-draft reconcile) |
| **3** | Manual keyboard entry | human | Cannot fail | **BUILT + TESTED**, always running |
| **4** | claude-in-chrome DOM/network scraping | 1–3s | **Extension is not even connected right now** (verified: `list_connected_browsers` → `[]`, `tabs_context_mcp` → "Browser extension is not connected") | **REJECTED** as a live path |

---

## 1. PRIMARY — THE DRAFT-ROOM WEBSOCKET

### The chain (all four steps verified against real captures / live probes)

**Step 1 — mint the socket token.** ESPN's undocumented `draftSecurity` endpoint returns a **bare signed integer** as the whole body:

```
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026
      /segments/0/leagues/<your-league-id>/teams/{teamId}/draftSecurity
  Cookie: espn_s2=...; SWID={...}
  accept: application/json
  x-fantasy-source: kona
  origin: https://fantasy.espn.com
  referer: https://fantasy.espn.com/
→ 200  body: -1781796296        (yes, negative; parse as int, not JSON)
```
I probed this route unauthenticated today: it returns **401 `AUTH_LEAGUE_NOT_VISIBLE`, not 404** — the route exists on league <your-league-id>.

**Step 2 — build the JOIN url** (shape copied byte-for-byte from a real capture; braces in SWID are sent **literally**, not percent-encoded):

```
wss://fantasydraft.espn.com/game-1/league-{leagueId}/JOIN
  ?1=1&2={leagueId}&3={teamId}&4={SWID}
  &5=1:{leagueId}:{teamId}:{SWID}:{token}
  &6=false&7=false&8=KONA
```

**Step 3 — handshake.** `Cookie: SWID={...}` + `Origin: https://fantasy.espn.com`. `espn_s2` is *accepted but not required* on the socket itself (it is required to mint the token). Disable the library's protocol-level ping — ESPN speaks its own.

I probed the host live today with a deliberately bogus token: **`wss://fantasydraft.espn.com` is reachable and rejects with HTTP 500** (`InvalidStatus`, text/plain). That is the diagnostic signature to memorise: **500 at handshake = bad/expired token → re-mint**; 401/403 = bad SWID.

**Step 4 — the frame protocol** (plain text, space-delimited, one event per frame). Confirmed by me against a **real 8-team snake draft with a 30-second clock** — i.e. structurally identical to tonight:

```
SELECTING <teamId> <msRemaining>            on the clock          e.g. "SELECTING 3 30000"
SELECTED  <teamId> <playerId> <slotId> [{SWID}]  THE PICK         e.g. "SELECTED 2 4429795 2 {8491...}"
CLOCK     <phase> <msRemaining> [<teamId>]  phase 0=pre-draft, 6=picking; ticks ~5s
AUTOSUGGEST <playerId>                      ESPN's suggestion for US (free signal)
AUTODRAFT <teamId> <true|false>             broadcast for every team
JOINED / LEFT <teamId> {SWID}
TOKEN 1:<leagueId>:<teamId>:{SWID}:<nonce>  names OUR team, once, near connect
INIT <base64>                               full room snapshot (see below)
STATE <n>                                   draft started
PING PING%20<ms>  →  PONG PING%20<ms>       CLIENT pings first, every ~15s
```
The trailing `{SWID}` on `SELECTED` is present when a human clicked and absent when the server autopicked (strong inference from the capture — 4 of 8 teams never carried one — not proven).

### The INIT blob — I decoded it today, and it is a bigger win than expected

On connect, ESPN sends `INIT <base64>`, a big-endian binary snapshot. I ran a structural scan over the real snake capture and **confirmed the pick ledger**: the longest run of 45-byte records beginning with the league id decodes as

```
>IIIiII  =  leagueId | teamId | pickNumber | playerId(int32) | slotHint | price
```

and that run was **exactly 128 records (8 teams × 16 rounds)**, with the teamId column reading `1..8, 8..1, 1..8, 8..1` — **the complete snake grid, delivered on connect.** Completed picks carry a real `playerId`; pending ones carry `-1`.

Consequence for tonight: **the moment we connect we know every pick number → team mapping for all 192 picks**, so the 5PM order randomization is a non-issue, we know the author's slot and all his future picks immediately, and a mid-draft (re)connect is lossless. This also means we do not depend on the REST skeleton at all.

### What I built and tested

`<local scratch>` — Python sidecar (Python 3.14.2 + `websockets` 16.0 + `requests`, **all already installed; zero new dependencies**). It runs the socket, the REST poll, and a manual-entry tail *simultaneously* into one board, and publishes:

- `<local scratch>` — atomic (`os.replace`), rewritten on every change
- `<local scratch>` — append-only raw frames, flushed per line (a crash cannot eat picks; it is replayable)

**Why Python in a Node repo:** the handshake needs a literal `Cookie` header, an `Origin`, and the HTTP status back on rejection. Node 25's built-in `WebSocket` accepts `{headers, origin}` (I verified) but hides the reject status in an opaque `ErrorEvent`, and `ws` is not installed. Python gives all three today with nothing to install. The two processes are coupled only by JSON files, which is also the failure isolation you want at 6:00:30pm.

**Verified end-to-end today** by replaying the real captured snake draft through the exact live state machine:

```
$ python scripts/draft-watch.py --replay <capture>.jsonl --mock-league 196877779 --teams 8
[10:35:08] draft order locked: 128 picks, round 1 = [1, 2, 3, 4, 5, 6, 7, 8]
[10:35:08] INIT: 128 grid slots, 0 picks already made
[10:35:08] PICK   1  team  1  Bijan Robinson (RB-ATL) [RB]  (autopick)
[10:35:08] *** YOU ARE ON THE CLOCK *** (30000 ms)
[10:35:08] PICK   2  team  2  Jahmyr Gibbs (RB-DET) [RB] <<< MY PICK
[10:35:08] PICK   3  team  3  Puka Nacua (WR-LAR) [WR]
... 23/23 picks, correct teams, snake order, names resolved from data/cache/board-<league>.json
```

Player ids come straight off the wire and `data/cache/board-<league>.json` is already keyed on `id`, so **no name matching ever happens on the clock**.

### State contract for the recommender

```jsonc
{ "updatedAt":…, "status":"pre|live|done", "myTeamId":5,
  "source":{"ws":"connected","rest":"frozen","lastWsFrame":…,"lastRestPoll":…},
  "order":[teamId per overall pick, 192 long],
  "myPicks":[5,20,29,44,…], "myNextPicks":[…], "picksUntilMine":3,
  "onTheClock":{"teamId":3,"overall":17,"msRemaining":21000,"isMe":false},
  "picks":[{"overall":1,"teamId":3,"playerId":4429795,"slotId":2,"bySwid":true,"src":"ws","at":…}],
  "draftedIds":[…], "autodraft":{"3":true} }
```
`src` is `ws | init | rest | manual` — one shape regardless of which transport is alive.

### Robustness decisions worth knowing

- **Dedupe by player id, never by pick number.** ESPN replays the room on every re-JOIN; counting a replayed `SELECTED` as new would double the board after one dropped socket.
- **ESPN drops even a correctly pinged draft socket every few minutes with no close frame.** The loop reconnects, re-**mints a fresh token each attempt** (a token that is fine at 5:45 can be refused later, and "room not open yet" looks identical), and INIT re-establishes truth.
- **A missed frame self-heals**: a pick is assigned to the first unfilled slot belonging to that team, so a gap stays a gap instead of shifting every later pick onto the wrong roster.
- **D/ST player ids are negative** — `-(16000 + proTeamId)`, e.g. `-16033` Baltimore. Only `-1`/`0` are sentinels. A naive `id > 0` test silently drops all 12 defenses.
- `slotHint` from INIT and `slotId` from `SELECTED` disagree with the final lineup slot about half the time — never place a player by them; use our own board's position.

### Risk to weigh: a second socket as the same team

the author's Chrome will hold its own socket for the same `teamId`. `worthybrae` initially feared ESPN would not tolerate a second connection, then shipped the direct-connect path anyway and reported it verified live under three cookie conditions. `JOINED`/`LEFT` frames carry a team id and a SWID and are broadcast normally — two devices per manager is ordinary user behaviour. **Assessment: low risk, not zero.** Mitigation: if his draft room misbehaves in the first minute, `Ctrl-C` the watcher — REST poll + manual entry continue, and nothing is lost.

*(Also noted and rejected: the room opens a second socket to `espn.connections.edge.bamgrid.com`. That is Disney telemetry — ignore it.)*

*(Capability, not a recommendation: the same socket accepts `SELECT <playerId>` from the client — that is how ESPN's own room submits a pick. Do not wire this up without the author explicitly asking; it takes actions on his behalf.)*

---

## 2. SECONDARY — REST POLL (runs concurrently, costs nothing)

```
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026
      /segments/0/leagues/<your-league-id>?view=mDraftDetail
  Cookie: espn_s2=…; SWID={…}
```
Response: `draftDetail: { drafted: bool, inProgress: bool, completeDate, picks: [ {id, playerId, teamId, roundId, roundPickNumber, overallPickNumber, lineupSlotId, autoDraftTypeId, keeper, bidAmount, nominatingTeamId, memberId, reservedForKeeper, tradeLocked} ] }`.

- **Expect `picks` to be a 192-slot skeleton with `playerId: -1` all night.** That is the measured behaviour, not an error. If picks *do* appear, they merge into the same board and nothing else changes.
- **Rate limiting:** nothing documented. The league endpoint returns `Cache-Control: max-age=5` (CloudFront), so **6s is the sensible floor** — ~1,200 requests over the draft, trivial. ESPN also CORS-exposes a `Polling-Interval` header (it is in `Access-Control-Expose-Headers` on every response) which is how ESPN's own client paces itself — honour it if it ever appears. **Do not add cache-busting query params**; that bypasses the CDN for no gain.
- Its real job: **post-draft reconciliation** (`drafted: true` → the authoritative final board) and `?view=mSettings → settings.draftSettings.pickOrder / timePerSelection / date`, plus `?view=mTeam` to resolve the author's `teamId` from his SWID.

---

## 3. TERTIARY — MANUAL ENTRY (built, tested, no dependencies)

`<local scratch>` — zero deps, zero network, zero auth. Type-ahead over the 600KB board file.

```
<letters>  filter (punctuation/case-insensitive: "jamarr" → Ja'Marr Chase)
ENTER      draft row 1        1..6   draft that row outright
BACKSPACE  edit   ESC/^U clear   ^Z undo last   #4429795 raw ESPN id   ^C quit
```
Ranking is prefix-on-last-name → prefix-on-full-name → substring → subsequence, ties broken by ADP, already-drafted excluded. Measured today:

```
"cee"    → 1. CeeDee Lamb          "cmc"    → 1. Christian McCaffrey
"jamarr" → 1. Ja'Marr Chase        "texans" → 1. Texans D/ST
"jeanty" → 1. Ashton Jeanty        "bijan"  → 1. Bijan Robinson
```
**≈4 keystrokes and ~1.5 seconds per pick** against a 30-second clock, with 11 picks of slack between his turns.

It appends `{"playerId":N}` to `data/live/manual_picks.jsonl`, which `draft-watch.py` tails and folds into the *same* state file — so manual and automatic can run at once and the recommender never learns which was alive. If the watcher is dead (state file older than 20s) manual-draft takes over writing `draft_state.json` itself, so manual-only is a complete system. Tested both ways today (4 picks entered → folded into a 192-slot 12-team snake grid with `myPicks: [5,20,29,44,53]` and `picksUntilMine` correct).

---

## 4. REJECTED — BROWSER AUTOMATION

Not "risky in theory" — **unavailable in fact**: `list_connected_browsers` returned `[]` and `tabs_context_mcp` returned *"Browser extension is not connected"* when I probed it today. On top of that it needs per-site permission grants, a foreground tab that must not be navigated away, and ESPN's draft-room DOM is obfuscated React that can shift without notice. Even at its best it would be a slower, more fragile way to read the same socket that we can read directly.

**One thing browser automation is genuinely good for and should be kept for:** a 30-second *credential* grab (below), and an emergency eyeball if everything else dies.

---

## 5. GETTING `espn_s2` AND `SWID` — 60 SECONDS

**Measured fact that makes this easy: neither cookie is HttpOnly** (Chrome reports `httpOnly=false, sameSite=Lax`). So the console path works.

**Option A — console paste (~20s), written up in `<local scratch>`:**
1. Open `https://fantasy.espn.com/football/team?leagueId=<your-league-id>` in Chrome (signed in).
2. `F12` → **Console** tab. If Chrome asks, type `allow pasting` + Enter.
3. Paste this one line, Enter — it prints the JSON **and copies it to the clipboard**:
```js
(async()=>{const g=n=>(document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'))||[])[1];const s2=g('espn_s2'),sw=g('SWID');if(!s2||!sw){alert('Sign in to ESPN in this tab first');return}const o={espn_s2:decodeURIComponent(s2),swid:decodeURIComponent(sw)};const t=JSON.stringify(o,null,2);console.log(t);try{copy(t);console.log('copied to clipboard')}catch(e){}try{await navigator.clipboard.writeText(t)}catch(e){}})()
```
4. Paste into `<local scratch>`.

**Option B — click-through (no typing):** `F12` → **Application** tab (may be under `»`) → Storage → Cookies → `https://fantasy.espn.com` → filter `espn_s2`, copy the *whole* ~300-char value from the bottom panel; clear filter, type `SWID`, copy that value **with the braces**. Then write:
```json
{"espn_s2": "AEB...", "swid": "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"}
```

**Could claude-in-chrome read them directly?** Yes in principle — `javascript_tool` running `document.cookie` on an ESPN tab would return both, since neither is HttpOnly. But the extension is not connected, and this would put the account session cookie through the tool transcript. Have him paste it into a gitignored file instead. **I added `<local scratch>` (`local/`, `data/live/`, `data/raw/`, `data/cache/`, `node_modules/`) — the repo had none and `espn_s2` is a full account session.**

---

## TONIGHT'S RUNBOOK

| When | Do |
|---|---|
| **ASAP** | the author pastes cookies into `local/espn-auth.json`. |
| **then** | `python scripts/draft-watch.py --probe` → prints teamId, all 12 team names, `draftSettings` (type/timePerSelection/date/pickOrder), mDraftDetail state, and whether the token mints. |
| **~4:30pm (optional, high value)** | **Dress rehearsal in a real ESPN mock.** `GET .../seasons/2026/leaguedirectory/MOCKDRAFT_LOBBY` lists open rooms (`leagueId`, `leagueSize`, `draftDate` epoch-ms, `draftType`, `full`); `POST https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/{id}/invites?memberId={SWID}&join=true` with body `[{"teamId": -1}]` → `201 [{"teamId":7}]`. Then `python scripts/draft-watch.py --mock-league <id> --mock-team <n>`. This is the only way to see the real thing before 6pm — but joining takes a seat from a real person, so prefer a room that is nearly full, and it needs the author's say-so. |
| **5:00pm** | Order randomizes. Re-run `--probe` to capture `pickOrder`. (Not load-bearing — INIT will hand us the grid anyway.) |
| **5:45pm** | Start `python scripts/draft-watch.py` for real. Expect `token-error` retries until ESPN opens the room (~10 min before picks, when `inProgress` flips true) — that is normal and self-healing. |
| **5:50pm** | Open a second terminal with `node scripts/manual-draft.js` and **leave it running all night.** Zero cost when unused; the entire safety net when needed. |
| **6:00pm** | Watch the log. `socket connected` + `INIT: 192 grid slots` + `draft order locked` = green. |

**Green/amber/red at a glance** (`source` in `draft_state.json`): `ws: connected` = green. `ws: rejected-500` repeating = token/room problem, REST + manual carry on. `ws: failed` = start typing picks into `manual-draft.js`; the board keeps updating and the recommender never notices the difference.

---

## FILES DELIVERED

- `<local scratch>` — primary WS listener + concurrent REST poll + manual-file tail; `--probe`, `--replay`, `--mock-league/--mock-team`, `--no-rest`. Compiles clean; replay-verified against a real snake capture.
- `<local scratch>` — fallback keyboard entry. `node --check` clean; record/undo/`#id`/state-handoff all tested.
- `<local scratch>` — the three credential paths + the console one-liner.
- `<local scratch>` — new; keeps `espn_s2` out of git.
- Outputs (created at runtime): `data\live\draft_state.json`, `data\live\draft_events.jsonl`, `data\live\manual_picks.jsonl`.

**Caveat on sourcing:** the protocol facts came from three independent public reverse-engineering repos plus one real captured draft session, which I re-verified myself by decoding the INIT blob and replaying all 141 frames through the shipped parser. Nothing here has been tested against *this* league's live draft, which is why all three transports run at once and each degrades into the next without touching the recommender.

Sources: [cwendt94/espn-api](https://github.com/cwendt94/espn-api) · [worthybrae/fantasy-football](https://github.com/worthybrae/fantasy-football) (`pipeline/draft_socket.py`, `pipeline/draft_listener.py`, `pipeline/espn_live.py`, `tests/fixtures/espn_draft_socket.jsonl`, `bookmarklet/bookmarklet.js`, `docs/superpowers/reference/espn-mock-lobby-endpoints.md`) · [howell/draft-builder](https://github.com/howell/draft-builder) (`design-docs/features/live-draft/espn-draft-room-protocol.md`) · [kaedonj16/fantasy-dashboard](https://github.com/kaedonj16/fantasy-dashboard) (`docs/espn-live-draft-sync.md`) · [puniakartik/draft_tool](https://github.com/puniakartik/draft_tool) · [Accessing Fantasy Football Data Through ESPN's API](https://onyxmueller.net/2022/12/28/accessing-fantasy-football-data-through-espns-api/) · [ffscrapr ESPN endpoints](https://ffscrapr.ffverse.com/articles/espn_getendpoint.html)