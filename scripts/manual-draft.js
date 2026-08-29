#!/usr/bin/env node
/**
 * MANUAL DRAFT ENTRY - the fallback that must never need debugging at 6:01pm.
 *
 * Zero dependencies, zero network, zero auth. If the socket, the REST poll and
 * the whole ESPN API disappear, this still tracks the board: you watch the
 * draft room with your eyes and type ~3 characters per pick.
 *
 * SPEED IS THE ONLY FEATURE. Type-ahead filters as you type; the top match is
 * always on row 1; ENTER takes row 1; 1-6 take that row outright. "cee<ENTER>"
 * = CeeDee Lamb. Four keystrokes, ~1.5 seconds, and a 30-second clock is not
 * even close to threatened.
 *
 *   <letters>   filter (case/punctuation-insensitive: "jamarr" finds Ja'Marr)
 *   ENTER       draft row 1
 *   1..6        draft that row
 *   BACKSPACE   edit the query      ESC / ctrl+U   clear it
 *   ctrl+Z      undo the last pick you entered
 *   #4429795    enter a raw ESPN player id (paste-safe)
 *   ctrl+C      quit
 *
 * WRITES data/live/manual_picks.jsonl (append-only, one {"playerId":N} per
 * line). scripts/draft-watch.py tails that file and folds it into the same
 * data/live/draft_state.json the socket feeds, so the recommender never learns
 * which source was alive.
 *
 * IF THE WATCHER IS DEAD (state file older than 20s) this process takes over
 * writing draft_state.json itself, so manual-only is a complete system rather
 * than half of one.
 *
 *   node scripts/manual-draft.js
 *   node scripts/manual-draft.js --test "jamarr"      # non-interactive check
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = boardPath(loadConfig(process.env.LEAGUE).id);
const CONFIG = configPath(loadConfig(process.env.LEAGUE).id);
const LIVE = path.join(REPO, 'data', 'live');
const PICKS = path.join(LIVE, 'manual_picks.jsonl');
const STATE = path.join(LIVE, 'draft_state.json');
const STALE_MS = 20000;

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// A handful of the nicknames a human actually types under pressure.
const ALIAS = {
  cmc: 'christianmccaffrey', jsn: 'jaxonsmithnjigba', arsb: 'amonrastbrown',
  bijan: 'bijanrobinson', jj: 'justinjefferson', ceedee: 'ceedeelamb',
  nabers: 'malknabers', mhj: 'marvinharrisonjr', bts: 'bretttucker',
};

const players = board.players.map((p) => ({
  id: p.id, name: p.name, pos: p.pos, team: p.team, adp: p.adp ?? 999,
  pts: p.pts ?? 0,
  key: norm(p.name),
  last: norm((p.name || '').split(' ').slice(1).join('')),
}));
const byId = new Map(players.map((p) => [p.id, p]));

const drafted = new Set();
const mine = [];                                   // ids I entered, for undo

// Anything the watcher already knows about counts as drafted here too.
function loadWatcherState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const id of st.draftedIds || []) drafted.add(id);
    return st;
  } catch { return null; }
}
function loadManual() {
  try {
    for (const line of fs.readFileSync(PICKS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.playerId) { drafted.add(r.playerId); mine.push(r.playerId); }
    }
  } catch { /* first run */ }
}

/** Rank candidates for a query. Prefix-on-last-name beats prefix-on-full-name
 *  beats substring beats subsequence; ties break by ADP so the guy who is
 *  actually about to go is row 1. */
function search(q, limit = 6) {
  const raw = norm(q);
  if (!raw) return [];
  const needle = ALIAS[raw] || raw;
  const out = [];
  for (const p of players) {
    if (drafted.has(p.id)) continue;
    let score = null;
    if (p.last.startsWith(needle)) score = 0;
    else if (p.key.startsWith(needle)) score = 1;
    else if (p.key.includes(needle)) score = 2;
    else if (subsequence(needle, p.key)) score = 3;
    if (score === null) continue;
    out.push([score, p.adp, p]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, limit).map((r) => r[2]);
}
function subsequence(needle, hay) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return i === needle.length;
}

function record(id) {
  if (!id || drafted.has(id)) return false;
  fs.mkdirSync(LIVE, { recursive: true });
  fs.appendFileSync(PICKS, JSON.stringify({ playerId: id, at: Date.now() }) + '\n');
  drafted.add(id); mine.push(id);
  maybeWriteState();
  return true;
}
function undo() {
  const id = mine.pop();
  if (!id) return null;
  drafted.delete(id);
  // Rewrite the log without that pick; the watcher only ever ADDS ids, so a
  // rewritten file is re-read from the top on its next restart and matches.
  const kept = mine.map((p) => JSON.stringify({ playerId: p }) + '\n').join('');
  fs.writeFileSync(PICKS, kept);
  maybeWriteState();
  return id;
}

/** Only take over the state file when nothing else is writing it.
 *
 *  `lastWrittenAt` is what makes that test work: without it the second pick
 *  reads back the fresh file THIS process just wrote, concludes a live watcher
 *  owns it, and silently stops recording - the fallback failing in exactly the
 *  situation it exists for. */
let lastWrittenAt = 0;
function maybeWriteState() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* none */ }
  const ours = st && Math.abs((st.updatedAt || 0) - lastWrittenAt) < 1e-6;
  const fresh = st && (Date.now() / 1000 - (st.updatedAt || 0)) * 1000 < STALE_MS;
  if (fresh && !ours) return;                       // a live watcher owns it
  const picks = mine.map((id, i) => ({
    overall: i + 1, teamId: st?.order?.[i] ?? null, playerId: id,
    slotId: null, src: 'manual', at: Date.now() / 1000,
  }));
  const out = {
    updatedAt: Date.now() / 1000,
    leagueId: cfg.espnLeagueId, season: cfg.season,
    myTeamId: st?.myTeamId ?? null, status: 'live',
    teams: cfg.teams, rounds: cfg.draft.rounds, picksMade: picks.length,
    source: { ws: 'manual', rest: 'manual' },
    order: st?.order ?? [], myPicks: st?.myPicks ?? [],
    onTheClock: { teamId: st?.order?.[picks.length] ?? null,
                  overall: picks.length + 1, msRemaining: null,
                  isMe: st?.myTeamId != null && st?.order?.[picks.length] === st.myTeamId },
    picks, draftedIds: [...drafted],
  };
  fs.mkdirSync(LIVE, { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
  fs.renameSync(tmp, STATE);                        // atomic for the reader
  lastWrittenAt = out.updatedAt;
}

// ---------------------------------------------------------------- interactive
let query = '';
let rows = [];
let flash = '';

function render() {
  const st = loadWatcherState();
  const made = drafted.size;
  const nextMine = (st?.myPicks || []).find((n) => n > made);
  const until = nextMine ? nextMine - made - 1 : null;
  const src = st ? `${st.source?.ws}/${st.source?.rest}` : 'manual only';
  const lines = [];
  lines.push('');
  lines.push(`  picks in: ${made}/${cfg.teams * cfg.draft.rounds}` +
    (until != null ? `   your next: #${nextMine} (${until} away)` : '') +
    `   feed: ${src}`);
  lines.push('  ' + '-'.repeat(72));
  rows = search(query);
  if (!rows.length && query) lines.push('  (no match)');
  rows.forEach((p, i) => {
    lines.push(`  ${i + 1}  ${p.name.padEnd(24)} ${String(p.pos).padEnd(4)} ` +
      `${String(p.team).padEnd(4)} adp ${String(p.adp).padStart(5)}  ` +
      `${p.pts.toFixed(0).padStart(4)} pts`);
  });
  for (let i = rows.length; i < 6; i++) lines.push('');
  lines.push('  ' + '-'.repeat(72));
  lines.push(`  > ${query}${flash ? '        ' + flash : ''}`);
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n'));
}

function take(i) {
  const p = rows[i];
  if (!p) return;
  record(p.id);
  flash = `drafted ${p.name}`;
  query = '';
  render();
}

function main() {
  loadWatcherState();
  loadManual();
  const testArg = process.argv.indexOf('--test');
  if (testArg > -1) {
    query = process.argv[testArg + 1] || '';
    console.log(search(query).map((p, i) =>
      `${i + 1}. ${p.name} ${p.pos}-${p.team} adp ${p.adp}`).join('\n'));
    return;
  }
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    flash = '';
    if (key.ctrl && key.name === 'c') { process.stdout.write('\n'); process.exit(0); }
    if (key.ctrl && key.name === 'u') { query = ''; }
    else if (key.ctrl && key.name === 'z') {
      const id = undo();
      flash = id ? `undid ${byId.get(id)?.name ?? id}` : 'nothing to undo';
    } else if (key.name === 'escape') query = '';
    else if (key.name === 'backspace') query = query.slice(0, -1);
    // 'return' is a TTY's \r; 'enter' is the \n a pipe or some terminals send.
    else if (key.name === 'return' || key.name === 'enter') { take(0); return; }
    // A digit is a row selector whenever rows are showing - no player name
    // needs one, and one keystroke beats two on every single pick.
    else if (/^[1-6]$/.test(str || '') && rows.length && !query.startsWith('#')) {
      take(Number(str) - 1); return;
    } else if (str === '#') query = '#';
    else if (query.startsWith('#') && /^[0-9]$/.test(str || '')) query += str;
    else if (str && str.length === 1 && str >= ' ') query += str;
    if (query.startsWith('#') && query.length > 4) {
      const id = Number(query.slice(1));
      if (byId.has(id)) { record(id); flash = `drafted ${byId.get(id).name}`; query = ''; }
    }
    render();
  });
  // resume() and a live interval, both deliberate: without them Node sees no
  // pending work on a non-TTY stdin and exits the instant it starts.
  process.stdin.resume();
  setInterval(render, 2000);
  render();
}

main();
