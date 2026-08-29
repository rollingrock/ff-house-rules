// Honest A/B of the opponent-aware survival curve against the market-only curve.
//
// IMPORTANT CAVEAT, and the reason this is not the deciding evidence: simulate.js opponents draft
// from noisy FFC ADP, which is very nearly the generative model of the market curve. The market
// curve therefore wins this test by construction. Parity is the bar here, not victory - the real
// justification is calibration, which is checked separately.
import fs from 'node:fs';
import path from 'node:path';
import { recommend, bestLineupPoints } from '../src/recommend.js';
import { isCensoredAdp } from '../src/score.js';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const board = JSON.parse(fs.readFileSync(boardPath(loadConfig(process.env.LEAGUE).id), 'utf8'));
const repl = board.replacement;
const T = cfg.teams, R = cfg.draft.rounds;

const botAdp = (p) => {
  const o = cfg.tuning.adpOverrides?.[p.pos];
  if (o) return o;
  if (!isCensoredAdp(p.adp, cfg)) return p.adp;
  return 160 + Math.max(0, 400 - (p.pts ?? 0)) / 8;
};

function runDraft(mySlot, seed, useOpponents) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const order = [];
  for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) order.push(r % 2 === 0 ? t + 1 : T - t);
  const myPicks = order.map((t, i) => (t === mySlot ? i + 1 : null)).filter(Boolean);
  const pool = board.players.map(p => ({ ...p }));
  const avail = new Set(pool.map(p => p.id));
  const rosters = Object.fromEntries(Array.from({ length: T }, (_, i) => [i + 1, []]));
  const picks = [];
  const botWants = (roster, pos, round) => {
    const n = roster.filter(p => p.pos === pos).length;
    if (['K', 'DST'].includes(pos)) return round >= 13 && n < 1;
    if (cfg.roster.dpEligible.includes(pos)) return round >= 9 && n < 1;
    if (pos === 'QB') return n < (round >= 10 ? 2 : 1);
    if (pos === 'TE') return n < (round >= 11 ? 2 : 1);
    return n < 8;
  };
  for (let i = 0; i < order.length; i++) {
    const pickNo = i + 1, team = order[i], round = Math.floor(i / T) + 1;
    const list = pool.filter(p => avail.has(p.id));
    let chosen;
    if (team === mySlot) {
      const next = myPicks.find(p => p > pickNo) || null;
      const upcoming = [];
      if (next) {
        for (let n = pickNo; n < next; n++) {
          const t = order[n - 1];
          if (t != null && t !== mySlot) upcoming.push({ team: t, round: Math.floor((n - 1) / T) + 1 });
        }
      }
      const { ranked } = recommend({
        available: list, myRoster: rosters[team], currentPick: pickNo, nextPick: next,
        cfg, repl, recentPicks: picks.slice(-12), round,
        upcoming: useOpponents ? upcoming : null,
        rostersByTeam: useOpponents ? rosters : null,
      });
      chosen = ranked[0];
    } else {
      const cands = list.filter(p => botWants(rosters[team], p.pos, round))
        .map(p => ({ p, key: botAdp(p) * (0.85 + rnd() * 0.3) }))
        .sort((a, b) => a.key - b.key);
      chosen = (cands[0] || { p: list[0] }).p;
    }
    avail.delete(chosen.id);
    rosters[team].push(chosen);
    picks.push(chosen);
  }
  return bestLineupPoints(rosters[mySlot], cfg, repl).total;
}

const results = [];
for (let slot = 1; slot <= 12; slot++) {
  for (const seed of [7, 42, 99]) {
    const off = runDraft(slot, seed, false);
    const on = runDraft(slot, seed, true);
    results.push({ slot, seed, off, on, d: on - off });
  }
}
const n = results.length;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const ds = results.map(r => r.d);
const m = mean(ds);
const sd = Math.sqrt(ds.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
const se = sd / Math.sqrt(n);
console.log(`${n} paired drafts (same slot, same seed, same bots)\n`);
console.log(`  market-only      ${mean(results.map(r => r.off)).toFixed(1)}`);
console.log(`  opponent-aware   ${mean(results.map(r => r.on)).toFixed(1)}`);
console.log(`  difference       ${m >= 0 ? '+' : ''}${m.toFixed(2)}  (se ${se.toFixed(2)}, t = ${(m / se).toFixed(2)})`);
console.log(`  better ${ds.filter(d => d > 0.01).length} / worse ${ds.filter(d => d < -0.01).length} / tie ${ds.filter(d => Math.abs(d) <= 0.01).length}`);
console.log('\nRemember: the bots here draft from ADP, which is what the market curve models,');
console.log('so this test is biased toward market-only. Parity is a pass.');
