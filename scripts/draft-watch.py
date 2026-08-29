#!/usr/bin/env python3
"""Live ESPN snake-draft monitor for an ESPN fantasy football draft.

DISABLED BY DEFAULT: ESPN permits one draft-room connection per team, and this joins
as YOU - so running it evicts you from your own draft. It needs a separate ESPN account
in the league as a spectator. Kept because the protocol decoding is the hard part.

WHY PYTHON, IN A NODE REPO: this process needs full control of a WebSocket
handshake (a literal `Cookie: SWID={...}` header, an `Origin`, and the HTTP
status code back when ESPN rejects it). Python's `websockets` (already
installed, v16) gives all three; Node's built-in WebSocket hides the reject
status. So this runs as a sidecar and publishes plain files the Node app
reads:

    data/live/draft_state.json   <- atomic, rewritten on every change
    data/live/draft_events.jsonl <- append-only raw frame log (replayable)

TWO SOURCES, ONE STATE. Both run at once and merge into the same board:

  1. PRIMARY - the draft room's own WebSocket, wss://fantasydraft.espn.com.
     Sub-second. Carries SELECTING (who is on the clock), SELECTED (the pick),
     CLOCK (ms left), AUTODRAFT, and an INIT blob on connect that contains the
     ENTIRE pick grid (overall pick -> team, plus every pick already made).
  2. SECONDARY - polling ?view=mDraftDetail every 6s. Two independent
     reverse-engineering write-ups measured this view FROZEN for the whole
     draft (every playerId still -1, flushing atomically at completion), so it
     is a belt, not the trousers: it costs nothing, it fills the board if ESPN
     behaves differently tonight, and it is the authoritative post-draft
     reconcile.

Manual entry (scripts/manual-draft.js) writes the same state file, so the
recommender never has to know which source is alive.

USAGE
    python scripts/draft-watch.py --probe       # 60-second preflight, no socket
    python scripts/draft-watch.py               # the real thing
    python scripts/draft-watch.py --mock-league <id> --mock-team <n>
    python scripts/draft-watch.py --replay <captured.jsonl>   # offline test

AUTH  local/espn-auth.json  (gitignore this):
    {"espn_s2": "AEB...", "swid": "{XXXXXXXX-...}"}
teamId is discovered automatically from ?view=mTeam.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import struct
import sys
import threading
import time
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
AUTH_PATH = REPO / "local" / "espn-auth.json"
LEAGUE = os.environ.get("LEAGUE", "")
CONFIG_PATH = REPO / "config" / f"{LEAGUE}.json"
BOARD_PATH = REPO / "data" / "cache" / f"board-{LEAGUE}.json"
OUT_DIR = REPO / "data" / "live"
STATE_PATH = OUT_DIR / "draft_state.json"
EVENTS_PATH = OUT_DIR / "draft_events.jsonl"

BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
SOCKET_HOST = "wss://fantasydraft.espn.com"

# x-fantasy-source: kona matters. Elsewhere in ESPN's API a missing source
# header silently DEGRADES a response (the player directory caps at 50 rows)
# instead of erroring, so there is no failure that would teach us it is needed.
HEADERS = {
    "accept": "application/json",
    "x-fantasy-source": "kona",
    "x-fantasy-platform": "kona-PROD",
    "origin": "https://fantasy.espn.com",
    "referer": "https://fantasy.espn.com/",
    "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
}

REST_POLL_SECONDS = 6.0      # ESPN serves Cache-Control: max-age=5 on this view
PING_SECONDS = 15.0          # matches the real client's cadence in a capture
RECV_TIMEOUT = 1.0
RECONNECT_BACKOFF = 2.0
MAX_EMPTY_RECONNECTS = 6

# ESPN lineup slot ids, for logging only. The board already knows positions.
SLOT = {0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
        8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB",
        15: "DP", 16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX"}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------
# auth + REST
# --------------------------------------------------------------------------

def load_auth() -> dict:
    # Accept EITHER convention. server.js (src/espn-live.js) reads both of these paths, so the
    # sidecar must too - otherwise following SETUP.md leaves the server saying "cookies linked"
    # while the websocket feed silently never starts.
    s2 = os.environ.get("ESPN_S2")
    swid = os.environ.get("ESPN_SWID")
    for path in (AUTH_PATH, REPO / "config" / "espn-cookies.json"):
        if s2 and swid:
            break
        if not path.exists():
            continue
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        s2 = s2 or raw.get("espn_s2") or raw.get("ESPN_S2")
        swid = swid or raw.get("swid") or raw.get("SWID")
    if not s2 or not swid:
        sys.exit(f"No ESPN cookies. Write {AUTH_PATH} (or config/espn-cookies.json) as "
                 '{"espn_s2": "...", "swid": "{...}"} or set ESPN_S2 / ESPN_SWID.')
    swid = swid.strip()
    if not swid.startswith("{"):
        swid = "{" + swid.strip("{}") + "}"      # ESPN always wants the braces
    return {"espn_s2": s2.strip(), "swid": swid}


def rest(session: requests.Session, url: str, params=None, timeout=10):
    r = session.get(url, params=params, headers=HEADERS, timeout=timeout)
    if r.status_code == 401:
        raise PermissionError(
            "401 from ESPN - espn_s2/SWID are wrong or expired. Re-grab them "
            "(see scripts/espn-mint.bookmarklet.js) and restart.")
    r.raise_for_status()
    return r


def league_url(league_id: int, season: int) -> str:
    return f"{BASE}/seasons/{season}/segments/0/leagues/{league_id}"


def find_my_team(session, league_id, season, swid) -> tuple[int | None, dict]:
    """teamId whose owner is our SWID. Matching is case- and brace-insensitive
    because ESPN is not consistent about either between views."""
    data = rest(session, league_url(league_id, season),
                params={"view": "mTeam"}).json()
    want = swid.strip("{}").upper()
    for team in data.get("teams", []):
        owners = team.get("owners") or []
        if team.get("primaryOwner"):
            owners = list(owners) + [team["primaryOwner"]]
        if any(str(o).strip("{}").upper() == want for o in owners):
            return int(team["id"]), data
    return None, data


def mint_token(session, league_id, season, team_id) -> int:
    """The socket URL's trailing nonce. ESPN serves it as a BARE INTEGER body
    (and it can be negative). Anything else means the cookies died."""
    url = f"{league_url(league_id, season)}/teams/{team_id}/draftSecurity"
    body = rest(session, url).text.strip()
    try:
        return int(body)
    except ValueError:
        raise RuntimeError(f"draftSecurity returned {body[:120]!r}, not an "
                           "integer - cookies expired or ESPN changed shape")


def socket_url(league_id, team_id, swid, token) -> str:
    """Verbatim shape from a real captured draft-room session. Braces in SWID
    are sent literally; parameters 1/6/7/8 have never been observed to vary."""
    return (f"{SOCKET_HOST}/game-1/league-{league_id}/JOIN"
            f"?1=1&2={league_id}&3={team_id}&4={swid}"
            f"&5=1:{league_id}:{team_id}:{swid}:{token}"
            f"&6=false&7=false&8=KONA")


# --------------------------------------------------------------------------
# board state
# --------------------------------------------------------------------------

def is_real_player(pid) -> bool:
    """-1 and 0 are ESPN's empty-slot sentinels. D/STs are legitimately
    NEGATIVE (-(16000 + proTeamId), e.g. -16033 Baltimore), so a plain
    `pid > 0` test would silently drop every defense."""
    if pid is None:
        return False
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    return pid not in (0, -1)


def parse_init_ledger(blob: bytes, league_id: int) -> list[dict]:
    """The pick grid out of the INIT blob ESPN sends on connect.

    VERIFIED against a real 8-team snake capture: the longest run of 45-byte
    records that start with the league id decodes as
    `>IIIiII` = league, teamId, pickNumber, playerId, slotHint, price, and the
    run was exactly 128 records long (8 teams x 16 rounds) with the teamId
    column reading 1..8, 8..1, 1..8 - i.e. the whole snake order, up front.
    Completed picks carry a real playerId; pending ones carry -1.

    slotHint is the room's provisional lineup slot and disagrees with the final
    one about half the time; never place a player by it.
    """
    if not blob:
        return []
    offsets = {i for i in range(len(blob) - 3)
               if struct.unpack_from(">I", blob, i)[0] == league_id}
    best: list[int] = []
    for start in sorted(offsets):
        run = [start]
        while (run[-1] + 45) in offsets:
            run.append(run[-1] + 45)
        if len(run) > len(best):
            best = run
    out = []
    for off in best:
        _lg, team, pick, player, slot, _price = struct.unpack_from(">IIIiII", blob, off)
        out.append({"overall": int(pick), "teamId": int(team),
                    "playerId": int(player), "slotId": int(slot)})
    return out


class Board:
    """One draft board, fed by any of: INIT, WS frames, REST, manual entry.

    Everything is keyed on ESPN player id, which is exactly what
    the cached board is keyed on, so no name matching ever
    happens on the clock.
    """

    def __init__(self, league_id, season, teams, rounds, my_team_id=None):
        self.league_id = league_id
        self.season = season
        self.teams = teams
        self.rounds = rounds
        self.total = teams * rounds
        self.my_team_id = my_team_id
        self.order: list[int] = []            # index = overall-1 -> teamId
        self.order_source: str | None = None  # settings (placeholder) | init | rest
        self.picks: dict[int, dict] = {}      # overall -> pick record
        self.by_player: dict[int, int] = {}   # playerId -> overall
        self.on_clock_team = None
        self.on_clock_ms = None
        self.autodraft: dict[int, bool] = {}
        self.status = "pre"
        self.ws_state = "down"
        self.rest_state = "unknown"
        self.last_ws_frame = None
        self.last_rest_poll = None
        self.lock = threading.RLock()
        self.dirty = True
        self.names = {}

    # -- order -------------------------------------------------------------
    def set_order(self, order: list[int], source: str = "settings") -> None:
        """Install the draft grid.

        Three sources, and they are NOT equal. settings.draftSettings.pickOrder is the
        PLACEHOLDER order shown before the draft randomises; with orderType=DRAFT_START the
        real grid does not exist until the draft actually starts. INIT and the REST skeleton
        both state the true grid. The old guard was `not self.order`, i.e. first writer wins
        forever - so the placeholder seeded at startup permanently blocked the real order,
        and every team-to-slot mapping would have been wrong all night. (The comment at the
        seeding site even said "INIT will confirm/replace it"; the code could not.)
        """
        with self.lock:
            if not order or len(order) < self.total:
                return
            authoritative = source in ("init", "rest")
            if self.order and not (authoritative and self.order_source == "settings"):
                return
            replacing = bool(self.order)
            same = replacing and self.order[:self.total] == order[:self.total]
            self.order = order[:self.total]
            self.order_source = source
            if replacing:
                log(f"draft order REPLACED from {source} "
                    f"(placeholder was {'identical' if same else 'DIFFERENT'}): "
                    f"round 1 = {self.order[:self.teams]}")
            else:
                log(f"draft order locked from {source}: {self.total} picks, "
                    f"round 1 = {self.order[:self.teams]}")
            if self.my_team_id:
                log(f"my picks: {self.my_pick_numbers()[:8]} ...")
            self.dirty = True

    def order_from_pick_order(self, pick_order: list[int]) -> list[int]:
        """Snake grid from ESPN's round-1 seat list (settings.draftSettings
        .pickOrder). Only used when neither INIT nor the REST skeleton is
        available - both of those state the grid outright."""
        grid = []
        for rnd in range(self.rounds):
            seats = pick_order if rnd % 2 == 0 else list(reversed(pick_order))
            grid.extend(seats)
        return grid

    def my_pick_numbers(self) -> list[int]:
        if not (self.order and self.my_team_id):
            return []
        return [i + 1 for i, t in enumerate(self.order) if t == self.my_team_id]

    def next_unfilled(self, start=1, team=None) -> int:
        for n in range(start, self.total + 1):
            if n in self.picks:
                continue
            if team is None or not self.order or self.order[n - 1] == team:
                return n
        return max(self.picks) + 1 if self.picks else start

    # -- picks -------------------------------------------------------------
    def add_pick(self, player_id, team_id=None, overall=None, slot_id=None,
                 src="ws", by_swid=None) -> bool:
        """Idempotent. Returns True if this is news.

        Dedupe is by PLAYER ID, not by pick number, because ESPN replays the
        picks so far on every (re)connect: counting a replayed SELECTED as a
        fresh pick would double the board after a single dropped socket.
        """
        with self.lock:
            if not is_real_player(player_id):
                return False
            player_id = int(player_id)
            if player_id in self.by_player:
                return False
            if overall is None:
                # first unfilled slot belonging to this team; falls back to the
                # next free number if the order is not known yet. A gap left by
                # a frame we never saw self-heals instead of shifting everyone.
                overall = self.next_unfilled(1, team_id)
            if team_id is None and self.order and 1 <= overall <= len(self.order):
                team_id = self.order[overall - 1]
            self.picks[overall] = {
                "overall": int(overall),
                "teamId": int(team_id) if team_id is not None else None,
                "playerId": player_id,
                "slotId": int(slot_id) if slot_id is not None else None,
                "bySwid": by_swid,
                "src": src,
                "at": round(time.time(), 3),
            }
            self.by_player[player_id] = int(overall)
            self.status = "live"
            self.dirty = True
            return True

    def drafted_ids(self) -> list[int]:
        return sorted(self.by_player)

    def snapshot(self) -> dict:
        with self.lock:
            made = len(self.picks)
            nxt = None
            if self.order and self.my_team_id:
                nxt = [n for n in self.my_pick_numbers() if n not in self.picks]
            on_clock_overall = None
            if self.on_clock_team is not None:
                on_clock_overall = self.next_unfilled(1, self.on_clock_team)
            return {
                "updatedAt": round(time.time(), 3),
                "leagueId": self.league_id,
                "season": self.season,
                "myTeamId": self.my_team_id,
                "status": self.status,
                "teams": self.teams,
                "rounds": self.rounds,
                "picksMade": made,
                "source": {
                    "ws": self.ws_state,
                    "rest": self.rest_state,
                    "lastWsFrame": self.last_ws_frame,
                    "lastRestPoll": self.last_rest_poll,
                },
                "order": self.order,
                "myPicks": self.my_pick_numbers(),
                "myNextPicks": (nxt or [])[:4],
                "picksUntilMine": (min(nxt) - made - 1) if nxt else None,
                "onTheClock": {
                    "teamId": self.on_clock_team,
                    "overall": on_clock_overall,
                    "msRemaining": self.on_clock_ms,
                    "isMe": (self.on_clock_team is not None
                             and self.on_clock_team == self.my_team_id),
                },
                "autodraft": {str(k): v for k, v in self.autodraft.items()},
                "picks": [self.picks[k] for k in sorted(self.picks)],
                "draftedIds": self.drafted_ids(),
            }

    def name(self, pid) -> str:
        return self.names.get(int(pid), f"player {pid}")


def write_state(board: Board) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(board.snapshot(), indent=1), encoding="utf-8")
    os.replace(tmp, STATE_PATH)          # atomic: a reader never sees a half file


_REPLAY = False          # offline replay must never write into the live log


def append_event(kind: str, payload: str) -> None:
    if _REPLAY:
        return
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with EVENTS_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"t": round(time.time(), 3), "kind": kind,
                             "payload": payload}) + "\n")
        fh.flush()                        # never buffer: a crash must not eat picks


# --------------------------------------------------------------------------
# frame handling
# --------------------------------------------------------------------------

def handle_frame(board: Board, text: str) -> bool:
    """Fold one plain-text, space-delimited frame. Returns True on a change.

    Grammar confirmed against a real 8-team / 30-second-clock snake capture:
      SELECTING <teamId> <msRemaining>          - on the clock
      SELECTED  <teamId> <playerId> <slotId> [{SWID}]   - the pick
      CLOCK     <phase> <msRemaining> [<teamId>] - phase 0 pre-draft, 6 picking
      AUTOSUGGEST <playerId>  AUTODRAFT <teamId> <bool>
      JOINED/LEFT <teamId> {SWID}   TOKEN 1:<lg>:<team>:{SWID}:<nonce>
      INIT <base64>   STATE <n>   PING/PONG
    """
    text = (text or "").strip()
    if not text:
        return False
    append_event("recv", text)
    board.last_ws_frame = round(time.time(), 3)
    parts = text.split()
    verb, args = parts[0], parts[1:]

    if verb == "SELECTED" and len(args) >= 2:
        team = _int(args[0])
        pid = _int(args[1])
        slot = _int(args[2]) if len(args) > 2 else None
        by_swid = len(args) > 3 and args[3].startswith("{")
        if board.add_pick(pid, team_id=team, slot_id=slot, src="ws",
                          by_swid=by_swid):
            overall = board.by_player.get(int(pid))
            mine = " <<< MY PICK" if team == board.my_team_id else ""
            auto = "" if by_swid else "  (autopick)"
            log(f"PICK {overall:>3}  team {team:>2}  {board.name(pid)} "
                f"[{SLOT.get(slot, slot)}]{auto}{mine}")
            return True
        return False

    if verb == "SELECTING" and args:
        board.on_clock_team = _int(args[0])
        board.on_clock_ms = _int(args[1]) if len(args) > 1 else None
        board.status = "live"
        if board.on_clock_team == board.my_team_id:
            log(f"*** YOU ARE ON THE CLOCK *** ({board.on_clock_ms} ms)")
        return True

    if verb == "CLOCK" and len(args) > 1:
        board.on_clock_ms = _int(args[1])
        if len(args) > 2:
            board.on_clock_team = _int(args[2])
        return False                        # ticks ~every 5s; not worth a rewrite

    if verb == "INIT" and args:
        try:
            blob = base64.b64decode(args[0])
        except Exception:
            return False
        ledger = parse_init_ledger(blob, board.league_id)
        if not ledger:
            log("INIT decoded 0 ledger records (blob shape changed?) - "
                "relying on REST/live frames for the order")
            return False
        board.set_order([r["teamId"] for r in sorted(
            ledger, key=lambda r: r["overall"])], source="init")
        changed = False
        for rec in sorted(ledger, key=lambda r: r["overall"]):
            if is_real_player(rec["playerId"]):
                changed |= board.add_pick(rec["playerId"], rec["teamId"],
                                          overall=rec["overall"], src="init")
        log(f"INIT: {len(ledger)} grid slots, "
            f"{sum(1 for r in ledger if is_real_player(r['playerId']))} picks already made")
        return True

    if verb == "AUTODRAFT" and len(args) > 1:
        team, flag = _int(args[0]), args[1].strip().lower()
        if team is not None and flag in ("true", "false"):
            board.autodraft[team] = (flag == "true")
            return True
        return False

    if verb == "TOKEN" and args and board.my_team_id is None:
        bits = args[0].split(":")
        if len(bits) >= 3:
            board.my_team_id = _int(bits[2])
            log(f"socket says my team id is {board.my_team_id}")
            return True
    return False


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# transports
# --------------------------------------------------------------------------

def run_socket(board: Board, mint, swid: str, stop: threading.Event) -> None:
    """Hold the draft socket, reconnecting forever.

    ESPN drops even a correctly pinged draft socket every few minutes with no
    close frame. That must not end the watch: on re-JOIN ESPN replays the room
    (INIT carries the full ledger), and add_pick dedupes by player id, so a
    reconnect is lossless and free.

    `mint` is a callable returning a FRESH socket url, not a fixed string. The
    draftSecurity token is per-draft and can be refused before the room opens
    or after it expires, and both look identical from here (HTTP 500 on the
    handshake). Re-minting every attempt turns "started the watcher too early"
    from a fatal mistake into a few seconds of retrying.
    """
    from websockets.sync.client import connect
    from websockets.exceptions import ConnectionClosed, InvalidStatus

    empty = 0
    while not stop.is_set():
        got = False
        try:
            url = mint()
        except Exception as exc:
            board.ws_state = "token-error"
            log(f"could not mint a draft token ({exc}); retrying in 20s "
                "(normal until ESPN opens the room, ~10 min before picks)")
            stop.wait(20.0)
            continue
        try:
            ws = connect(url,
                         additional_headers={"Cookie": f"SWID={swid}"},
                         origin="https://fantasy.espn.com",
                         ping_interval=None,       # ESPN speaks its own PING
                         open_timeout=10,
                         max_size=8 * 1024 * 1024)
            board.ws_state = "connected"
            log("socket connected")
        except InvalidStatus as exc:
            code = exc.response.status_code
            board.ws_state = f"rejected-{code}"
            log(f"socket handshake rejected: HTTP {code} "
                "(500 = stale/rejected draftSecurity token, re-minting; "
                "401/403 = bad SWID cookie)")
            empty += 1
            if empty >= MAX_EMPTY_RECONNECTS:
                log("giving up on the socket; REST poll + manual entry carry on")
                board.ws_state = "failed"
                return
            stop.wait(RECONNECT_BACKOFF * empty)      # back off as it repeats
            continue
        except Exception as exc:
            board.ws_state = "error"
            log(f"socket connect failed: {type(exc).__name__}: {exc}")
            empty += 1
            if empty >= MAX_EMPTY_RECONNECTS:
                board.ws_state = "failed"
                return
            stop.wait(RECONNECT_BACKOFF)
            continue

        try:
            last_ping = time.monotonic()
            while not stop.is_set():
                now = time.monotonic()
                if now - last_ping >= PING_SECONDS:
                    ws.send(f"PING PING%20{int(time.time() * 1000)}\n")
                    last_ping = now
                try:
                    frame = ws.recv(timeout=RECV_TIMEOUT)
                except TimeoutError:
                    continue
                except ConnectionClosed:
                    break
                got = True
                if handle_frame(board, frame if isinstance(frame, str)
                                else frame.decode("utf-8", "replace")):
                    write_state(board)
        finally:
            board.ws_state = "reconnecting"
            try:
                ws.close()
            except Exception:
                pass
        empty = 0 if got else empty + 1
        if empty >= MAX_EMPTY_RECONNECTS:
            log("socket keeps dropping with no data - token likely expired")
            board.ws_state = "failed"
            return
        stop.wait(RECONNECT_BACKOFF)


def run_rest_poll(board: Board, session, stop: threading.Event) -> None:
    """Poll ?view=mDraftDetail. Cheap insurance, and the post-draft truth.

    Expect this to sit at 0 real picks all night (measured frozen in two
    independent live tests) - that is NOT an error, it is why the socket is
    primary. If picks DO start appearing here, they merge in exactly the same
    way and nothing else changes.
    """
    url = league_url(board.league_id, board.season)
    seen_order = False
    while not stop.is_set():
        try:
            data = rest(session, url, params={"view": "mDraftDetail"}).json()
            board.last_rest_poll = round(time.time(), 3)
            detail = data.get("draftDetail") or {}
            picks = detail.get("picks") or []
            if picks and not seen_order and (
                    not board.order or board.order_source == "settings"):
                grid = sorted((p for p in picks if p.get("overallPickNumber")),
                              key=lambda p: p["overallPickNumber"])
                if len(grid) >= board.total:
                    board.set_order([int(p["teamId"]) for p in grid], source="rest")
                    seen_order = True
            real = [p for p in picks if is_real_player(p.get("playerId"))]
            changed = False
            for p in sorted(real, key=lambda p: p.get("overallPickNumber") or 0):
                changed |= board.add_pick(p["playerId"], p.get("teamId"),
                                          overall=p.get("overallPickNumber"),
                                          slot_id=p.get("lineupSlotId"),
                                          src="rest")
            board.rest_state = ("live" if real else
                                ("frozen" if detail.get("inProgress") else "pre"))
            if detail.get("drafted"):
                board.rest_state = "complete"
                board.status = "done"
                changed = True
            if changed:
                write_state(board)
        except PermissionError as exc:
            board.rest_state = "auth-error"
            log(str(exc))
        except Exception as exc:
            board.rest_state = "error"
            log(f"rest poll: {type(exc).__name__}: {exc}")
        stop.wait(REST_POLL_SECONDS)


def watch_manual_file(board: Board, stop: threading.Event) -> None:
    """The manual fallback drops picks into data/live/manual_picks.jsonl
    ({"playerId": 1234} per line). Read it in so the SAME state file carries
    them - the recommender never learns which source was alive."""
    path = OUT_DIR / "manual_picks.jsonl"
    pos = 0
    while not stop.is_set():
        try:
            if path.exists():
                with path.open("r", encoding="utf-8") as fh:
                    fh.seek(pos)
                    changed = False
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        changed |= board.add_pick(rec.get("playerId"),
                                                  rec.get("teamId"),
                                                  overall=rec.get("overall"),
                                                  src="manual")
                    pos = fh.tell()
                if changed:
                    write_state(board)
        except Exception as exc:
            log(f"manual watch: {exc}")
        stop.wait(1.0)


# --------------------------------------------------------------------------
# entry points
# --------------------------------------------------------------------------

def load_names() -> dict:
    names = {}
    try:
        board = json.loads(BOARD_PATH.read_text(encoding="utf-8"))
        for p in board.get("players", []):
            names[int(p["id"])] = f"{p['name']} ({p.get('pos')}-{p.get('team')})"
    except Exception:
        pass
    return names


def preflight(args) -> int:
    """Everything that can be checked before ESPN opens the room. Run this the
    moment the cookies exist, and again right after the 5PM order reveal."""
    auth = load_auth()
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    league_id = args.mock_league or cfg["espnLeagueId"]
    season = cfg["season"]
    session = requests.Session()
    session.cookies.set("espn_s2", auth["espn_s2"], domain=".espn.com")
    session.cookies.set("SWID", auth["swid"], domain=".espn.com")

    log(f"league {league_id} season {season}")
    team_id = args.mock_team
    if not team_id:
        team_id, team_data = find_my_team(session, league_id, season, auth["swid"])
        log(f"my teamId: {team_id}")
        for t in team_data.get("teams", []):
            log(f"  team {t['id']:>2}  {t.get('name') or t.get('nickname') or ''}")
    if not team_id:
        log("COULD NOT MATCH SWID TO A TEAM - check the SWID braces")
        return 2

    st = rest(session, league_url(league_id, season),
              params={"view": "mSettings"}).json()
    ds = ((st.get("settings") or {}).get("draftSettings") or {})
    log(f"draft: type={ds.get('type')} sec/pick={ds.get('timePerSelection')} "
        f"date={ds.get('date')} pickOrder={ds.get('pickOrder')}")

    dd = rest(session, league_url(league_id, season),
              params={"view": "mDraftDetail"}).json().get("draftDetail") or {}
    picks = dd.get("picks") or []
    real = [p for p in picks if is_real_player(p.get("playerId"))]
    log(f"mDraftDetail: drafted={dd.get('drafted')} inProgress={dd.get('inProgress')} "
        f"skeleton={len(picks)} realPicks={len(real)}")

    try:
        token = mint_token(session, league_id, season, team_id)
        log(f"draftSecurity token minted OK ({len(str(token))} digits)")
        log("socket url: " + socket_url(league_id, team_id, "{SWID}", token)
            .replace(str(token), "<token>"))
    except Exception as exc:
        log(f"draftSecurity FAILED: {exc}")
        log("  (this endpoint is expected to work only once the room exists; "
            "re-run inside the hour before the draft)")
        return 1
    log("PREFLIGHT OK")
    return 0


def replay(path: str, cfg, league_id=None, teams=None) -> int:
    """Feed a captured .jsonl (ours, or a Playwright ws trace) through the
    exact state machine that runs live. This is how the parser gets tested
    when no live draft exists to test against."""
    global _REPLAY
    _REPLAY = True
    board = Board(league_id or cfg["espnLeagueId"], cfg["season"],
                  teams or cfg["teams"], cfg["draft"]["rounds"])
    board.names = load_names()
    n = 0
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("kind") in ("ws-send", "send"):
            continue
        payload = rec.get("payload")
        if isinstance(payload, str):
            n += 1
            handle_frame(board, payload)
    snap = board.snapshot()
    print(json.dumps({"framesRead": n, "picksMade": snap["picksMade"],
                      "orderLen": len(snap["order"]),
                      "firstRound": snap["order"][:board.teams],
                      "onTheClock": snap["onTheClock"],
                      "firstPicks": snap["picks"][:5]}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="preflight only")
    ap.add_argument("--replay", help="replay a captured frame jsonl offline")
    ap.add_argument("--mock-league", type=int, help="use a mock draft league id")
    ap.add_argument("--mock-team", type=int, help="team id in that mock league")
    ap.add_argument("--no-rest", action="store_true")
    ap.add_argument("--teams", type=int, help="replay only: team count")
    args = ap.parse_args()

    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if args.replay:
        return replay(args.replay, cfg, args.mock_league, args.teams)
    if args.probe:
        return preflight(args)

    auth = load_auth()
    league_id = args.mock_league or cfg["espnLeagueId"]
    season = cfg["season"]
    session = requests.Session()
    session.cookies.set("espn_s2", auth["espn_s2"], domain=".espn.com")
    session.cookies.set("SWID", auth["swid"], domain=".espn.com")

    team_id = args.mock_team or find_my_team(session, league_id, season,
                                             auth["swid"])[0]
    if not team_id:
        return 2
    board = Board(league_id, season, cfg["teams"], cfg["draft"]["rounds"], team_id)
    board.names = load_names()
    log(f"watching league {league_id} as team {team_id}; "
        f"{len(board.names)} player names loaded")

    # Order, if ESPN will already tell us. INIT will confirm/replace it.
    try:
        po = (((rest(session, league_url(league_id, season),
                     params={"view": "mSettings"}).json().get("settings") or {})
               .get("draftSettings") or {}).get("pickOrder"))
        if po:
            board.set_order(board.order_from_pick_order([int(x) for x in po]))
    except Exception as exc:
        log(f"pickOrder unavailable ({exc}); waiting for INIT")

    def mint():
        token = mint_token(session, league_id, season, team_id)
        return socket_url(league_id, team_id, auth["swid"], token)

    stop = threading.Event()
    threads = [threading.Thread(target=run_socket,
                                args=(board, mint, auth["swid"], stop), daemon=True),
               threading.Thread(target=watch_manual_file, args=(board, stop),
                                daemon=True)]
    if not args.no_rest:
        threads.append(threading.Thread(target=run_rest_poll,
                                        args=(board, session, stop), daemon=True))
    for t in threads:
        t.start()
    write_state(board)
    log(f"state -> {STATE_PATH}")
    try:
        while True:
            time.sleep(2)
            write_state(board)              # keeps heartbeat fields fresh
    except KeyboardInterrupt:
        stop.set()
        write_state(board)
        log("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
