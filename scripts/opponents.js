// Per-manager draft profiles, keyed by ESPN team id (which persists across seasons even when
// team NAMES change). Answers: who is actually good, what do they do differently, and what
// does that imply for tonight?
//   node scripts/opponents.js
import fs from 'node:fs';
import path from 'node:path';
import { POSITION_BY_ID } from '../src/statmap.js';
import { scoreStats } from '../src/score.js';
import { bestLineupPoints } from '../src/recommend.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const IDP = ['LB', 'DE', 'DT', 'CB', 'S'];
const bucket = pos => (IDP.includes(pos) ? 'DP' : pos);
const ZERO = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, LB: 0, DE: 0, DT: 0, CB: 0, S: 0 };

function loadYear(yr, dumpFile) {
  const hist = JSON.parse(fs.readFileSync(path.join(root, `data/history/league-${yr}.json`), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(root, dumpFile), 'utf8'));
  const act = new Map(), meta = new Map();
  for (const e of raw) {
    const p = e.player || e;
    if (!p.fullName) continue;
    const pos = POSITION_BY_ID[p.defaultPositionId] || (p.id < -1 ? 'DST' : '?');
    meta.set(p.id, { name: p.fullName, pos });
    const a = (p.stats || []).find(s => s.seasonId === yr && s.statSourceId === 0 && !s.scoringPeriodId)?.stats;
    if (a && Object.keys(a).length) act.set(p.id, scoreStats(a, pos, cfg, p.eligibleSlots));
  }
  const teams = {};
  for (const t of hist.teams || []) {
    teams[t.id] = { name: (t.name || '').trim(), rec: t.record?.overall || null };
  }
  const picks = (hist.draftDetail?.picks || [])
    .filter(p => p.playerId && p.playerId !== -1)
    .map(p => ({ ...p, ...(meta.get(p.playerId) || { name: `#${p.playerId}`, pos: '?' }), actual: act.get(p.playerId) ?? null }))
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber);
  return { yr, teams, picks };
}

const years = [loadYear(2024, 'data/history/players-2024.json'), loadYear(2025, 'data/raw/espn-players-2026.json')];

// ---- per team-id, per year ------------------------------------------------------------
const prof = {};
for (const { yr, teams, picks } of years) {
  for (const [tid, t] of Object.entries(teams)) {
    const mine = picks.filter(p => String(p.teamId) === tid);
    if (!mine.length) continue;
    const scored = mine.filter(p => p.actual != null).map(p => ({ ...p, pts: p.actual }));
    const draftPts = Math.round(bestLineupPoints(scored, cfg, ZERO).total);
    const first = {};
    for (const p of mine) { const b = bucket(p.pos); if (!first[b]) first[b] = p.roundId; }
    (prof[tid] ||= { name: t.name, years: [] }).years.push({
      yr, name: t.name, draftPts, first,
      wins: t.rec?.wins ?? null, losses: t.rec?.losses ?? null, pf: t.rec?.pointsFor ?? null,
      qbCount: mine.filter(p => p.pos === 'QB').length,
      earlyRB: mine.filter(p => p.pos === 'RB' && p.roundId <= 3).length,
      earlyWR: mine.filter(p => p.pos === 'WR' && p.roundId <= 3).length,
    });
    prof[tid].name = t.name;   // most recent name wins
  }
}

const rows = Object.entries(prof).filter(([, p]) => p.years.length === 2).map(([tid, p]) => {
  const a = p.years[0], b = p.years[1];
  return {
    tid, name: p.name,
    draftAvg: Math.round((a.draftPts + b.draftPts) / 2),
    winsTot: (a.wins ?? 0) + (b.wins ?? 0),
    pfAvg: Math.round(((a.pf ?? 0) + (b.pf ?? 0)) / 2),
    qb: avg(a.first.QB, b.first.QB), rb: avg(a.first.RB, b.first.RB),
    wr: avg(a.first.WR, b.first.WR), te: avg(a.first.TE, b.first.TE),
    dp: avg(a.first.DP, b.first.DP), dst: avg(a.first.DST, b.first.DST), k: avg(a.first.K, b.first.K),
    qbCount: ((a.qbCount + b.qbCount) / 2).toFixed(1),
    earlyRB: ((a.earlyRB + b.earlyRB) / 2).toFixed(1),
    earlyWR: ((a.earlyWR + b.earlyWR) / 2).toFixed(1),
    detail: p.years.map(y => `${y.yr} ${y.wins}-${y.losses} draft ${y.draftPts}`).join('  |  '),
  };
});
function avg(x, y) { const v = [x, y].filter(n => n != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null; }

rows.sort((a, b) => b.draftAvg - a.draftAvg);
console.log('MANAGERS PRESENT IN BOTH 2024 AND 2025, ranked by average draft value captured\n');
console.log('  team                    draftAvg  W(2yr)   PFavg |  first-pick round by position');
console.log('                                                   |    QB    RB    WR    TE    DP   DST     K   QBs');
for (const r of rows) {
  const me = r.name === cfg.myTeamName ? ' <<<' : '';
  console.log(`  ${r.name.slice(0, 22).padEnd(24)}${String(r.draftAvg).padStart(7)}${String(r.winsTot).padStart(8)}${String(r.pfAvg).padStart(8)} | `
    + [r.qb, r.rb, r.wr, r.te, r.dp, r.dst, r.k].map(v => (v == null ? '—' : v.toFixed(1)).padStart(5)).join('')
    + String(r.qbCount).padStart(6) + me);
}

// ---- what separates the top half from the bottom half? --------------------------------
const mid = Math.floor(rows.length / 2);
const top = rows.slice(0, mid), bot = rows.slice(mid);
const m = (arr, k) => { const v = arr.map(r => r[k]).filter(n => n != null); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length) : null; };
console.log('\nTOP HALF vs BOTTOM HALF (by draft value captured)');
console.log('  metric              top    bottom    gap');
for (const [label, key] of [['first QB round', 'qb'], ['first RB round', 'rb'], ['first WR round', 'wr'],
  ['first TE round', 'te'], ['first DP round', 'dp'], ['first DST round', 'dst'], ['first K round', 'k']]) {
  const t = m(top, key), b = m(bot, key);
  if (t == null || b == null) continue;
  console.log(`  ${label.padEnd(18)}${t.toFixed(1).padStart(5)}${b.toFixed(1).padStart(9)}${(t - b >= 0 ? '+' : '') + (t - b).toFixed(1)}`);
}
const numAvg = (arr, k) => (arr.reduce((a, r) => a + Number(r[k]), 0) / arr.length).toFixed(2);
console.log(`  QBs drafted       ${numAvg(top, 'qbCount').padStart(5)}${numAvg(bot, 'qbCount').padStart(9)}`);
console.log(`  RBs in rounds 1-3 ${numAvg(top, 'earlyRB').padStart(5)}${numAvg(bot, 'earlyRB').padStart(9)}`);
console.log(`  WRs in rounds 1-3 ${numAvg(top, 'earlyWR').padStart(5)}${numAvg(bot, 'earlyWR').padStart(9)}`);

console.log('\nYEAR BY YEAR');
for (const r of rows) console.log(`  ${r.name.slice(0, 24).padEnd(26)} ${r.detail}`);
