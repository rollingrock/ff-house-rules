// Audit the news overlay against ESPN's live injury designations.
//   node scripts/overrides.js            audit every league you have synced
//   node scripts/overrides.js <league>   just one
//
// news-overrides.json is the highest-leverage manual input in the whole tool and the easiest
// to forget: ESPN projects 17 games for everybody, so without it a season-ender still shows a
// full projection. The failure mode is silent and asymmetric - a discount written in August
// keeps applying in December, quietly suppressing a player who has been healthy for months.
//
// This does not decide anything. It surfaces three things and leaves the judgement to you:
//   1. overrides ESPN now contradicts        - probably stale, worth re-checking
//   2. players ESPN has ruled out            - missing or too-mild an override
//   3. what any of it is worth on YOUR rosters, in points, per league
import fs from 'node:fs';
import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';
import { listLeagues, loadConfig, loadNewsOverrides, boardPath, configDir, rawPath } from '../src/league.js';
import { loadState, myTeam } from '../src/league-state.js';

const RULED_OUT = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION']);
const HEALTHY = new Set(['ACTIVE', 'NORMAL']);
const only = process.argv[2];

const news = loadNewsOverrides();
const players = news.players || {};
const updated = news.updated ? new Date(news.updated) : null;
const ageDays = updated ? Math.round((Date.now() - updated.getTime()) / 86400000) : null;

// ESPN's live view of every player, from the raw dump (refresh it with fetch-espn.js).
const raw = JSON.parse(fs.readFileSync(rawPath('espn-players-2026.json'), 'utf8'));
const espn = new Map();
for (const e of raw) {
  const p = e.player || e;
  if (!p.fullName) continue;
  espn.set(p.fullName, {
    id: p.id,
    pos: POSITION_BY_ID[p.defaultPositionId] || (p.id < -1 ? 'DST' : '?'),
    status: p.injuryStatus || null,
    rostered: p.ownership?.percentOwned ?? null,
  });
}
const rawAge = Math.round((Date.now() - fs.statSync(rawPath('espn-players-2026.json')).mtimeMs) / 86400000);

console.log(`\n  NEWS OVERRIDES AUDIT`);
console.log(`  ${path.join(configDir(), 'news-overrides.json')}`);
console.log(`  ${Object.keys(players).length} entries · file dated ${news.updated || '(undated)'}`
  + (ageDays == null ? '' : ` — ${ageDays} day${ageDays === 1 ? '' : 's'} old`));
console.log(`  ESPN player dump is ${rawAge} day${rawAge === 1 ? '' : 's'} old`
  + (rawAge > 2 ? '  ⚠ run `node scripts/fetch-espn.js`' : ''));
if (ageDays != null && ageDays > 7) console.log(`  ⚠ overrides are ${ageDays} days old — in-season this wants updating weekly.`);

// ------------------------------------------------------------ 1. overrides ESPN contradicts

const contradicted = [];
const unmatched = [];
for (const [name, o] of Object.entries(players)) {
  if (name.startsWith('_')) continue;
  const e = espn.get(name);
  if (!e) { unmatched.push(name); continue; }
  // A discount on somebody ESPN lists as healthy is the stale-intel signature.
  if (o.mult < 1 && HEALTHY.has(e.status)) contradicted.push({ name, ...o, status: e.status, pos: e.pos });
}
contradicted.sort((a, b) => a.mult - b.mult);

console.log(`\n  1. DISCOUNTED HERE, ACTIVE ON ESPN  (${contradicted.length})`);
if (!contradicted.length) console.log('     none — no override contradicts ESPN.');
for (const c of contradicted) {
  console.log(`     ${c.name.padEnd(23)} ${c.pos.padEnd(4)} x${String(c.mult).padEnd(5)} ESPN ${c.status}`);
  console.log(`     ${''.padEnd(23)} ${c.note}`);
}
if (unmatched.length) console.log(`\n     not found in the ESPN dump (renamed or retired?): ${unmatched.join(', ')}`);

// ------------------------------------------------------- 2. ruled out with no/weak override

const missing = [];
for (const [name, e] of espn) {
  if (!RULED_OUT.has(e.status)) continue;
  if ((e.rostered ?? 0) < 5) continue;              // ignore the long tail nobody rosters
  const o = players[name];
  if (!o || o.mult > 0.5) missing.push({ name, ...e, mult: o ? o.mult : null });
}
missing.sort((a, b) => (b.rostered ?? 0) - (a.rostered ?? 0));

console.log(`\n  2. RULED OUT BY ESPN, NOT REFLECTED HERE  (${missing.length})`);
if (!missing.length) console.log('     none.');
for (const m of missing.slice(0, 20)) {
  console.log(`     ${m.name.padEnd(23)} ${m.pos.padEnd(4)} ESPN ${String(m.status).padEnd(15)}`
    + `${m.mult == null ? 'no override' : `override x${m.mult}`}   ${Math.round(m.rostered)}% rostered`);
}
if (missing.length > 20) console.log(`     ... and ${missing.length - 20} more`);

// ------------------------------------------------------------------ 3. what it costs me

console.log(`\n  3. ON YOUR ROSTERS`);
const leagues = listLeagues().filter(l => !only || l.id === only);
let any = false;
for (const l of leagues) {
  const state = loadState(l.id);
  if (!state) continue;
  const me = myTeam(state);
  if (!me) continue;
  let board;
  try { board = JSON.parse(fs.readFileSync(boardPath(l.id), 'utf8')); } catch { continue; }
  const byId = new Map(board.players.map(p => [p.id, p]));

  const rows = [];
  for (const entry of me.roster) {
    const o = players[entry.name];
    if (!o || o.mult === 1) continue;
    const p = byId.get(entry.playerId);
    // p.pts already has the multiplier applied, so the undiscounted figure is pts / mult.
    const full = p && o.mult > 0 ? p.pts / o.mult : null;
    rows.push({
      name: entry.name, mult: o.mult, note: o.note,
      espnStatus: entry.injuryStatus, starter: entry.starter,
      swing: full == null ? null : Math.round(full - p.pts),
    });
  }
  if (!rows.length) continue;
  any = true;
  rows.sort((a, b) => (b.swing ?? 0) - (a.swing ?? 0));
  const total = rows.reduce((s, r) => s + (r.swing ?? 0), 0);
  console.log(`\n     ${l.name}  —  ${rows.length} player${rows.length === 1 ? '' : 's'}, ${total} pts of adjustment`);
  for (const r of rows) {
    const disagree = r.mult < 1 && HEALTHY.has(r.espnStatus) ? '  ← ESPN says healthy' : '';
    console.log(`       ${r.starter ? 'START' : 'bench'} ${r.name.padEnd(23)} x${String(r.mult).padEnd(5)}`
      + `${r.swing == null ? '     ' : String(r.swing > 0 ? '-' + r.swing : '+' + -r.swing).padStart(5)} pts   `
      + `ESPN ${r.espnStatus || '-'}${disagree}`);
  }
}
if (!any) console.log('     no synced league has an affected player. Run `season.js sync` first.');

console.log(`\n  ESPN's designation is coarse — it lists most of the league QUESTIONABLE in`);
console.log(`  September — so treat agreement as weak evidence and disagreement as a prompt`);
console.log(`  to go and read the actual beat report.\n`);
