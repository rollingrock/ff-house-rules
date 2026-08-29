// Builds the rescored, ranked draft board for a league config.
//   node scripts/build-board.js [league.json]
import fs from 'node:fs';
import path from 'node:path';
import { STAT } from '../src/statmap.js';
import { normalize } from '../src/espn.js';
import { scoreStats, replacementLevels, tierize } from '../src/score.js';
import { loadFfc } from '../src/ffc.js';
import { loadConfig, loadNewsOverrides, boardPath, rawPath, dataDir, ensureDirs } from '../src/league.js';

const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig((process.argv[2] || '').replace(/\.json$/, '') || process.env.LEAGUE);
ensureDirs();
const raw = JSON.parse(fs.readFileSync(rawPath(`espn-players-${cfg.season}.json`), 'utf8'));
const SEASON = cfg.season;

// News overlay: ESPN projects 17 games for EVERY player, so it carries no injury discount
// and knows nothing about season-enders. This is the highest-leverage manual input.
const newsDoc = loadNewsOverrides();
const news = newsDoc.players || {};
const unmatched = new Set(Object.keys(news).filter(k => !k.startsWith('_')));
let applied = 0;

const DP_SLOT = 15;
let players = normalize(raw, SEASON).map(p => {
  let pts = scoreStats(p.proj, p.pos, cfg, p.slots);
  // Travis Hunter is the only player in the 2026 universe who is both a skill player and
  // DP-eligible; record his defensive contribution separately so it is auditable.
  let dpPts = (!cfg.roster.dpEligible.includes(p.pos) && p.slots?.includes(DP_SLOT))
    ? Math.round(scoreStats(p.proj, 'LB', cfg) * 10) / 10 : null;
  // per-week projected points, so in-season tools never need the 39MB raw file
  const wk = {};
  for (const [w, st] of Object.entries(p.weekly)) wk[w] = scoreStats(st, p.pos, cfg, p.slots);

  const n = news[p.name];
  if (n) {
    unmatched.delete(p.name);
    applied++;
    pts *= n.mult;
    for (const k of Object.keys(wk)) wk[k] *= n.mult;
    // dpPts is a SECOND scoring of the same projection, so it needs the same discount. Without
    // this a news override silently applied to a dual-eligible player's offensive value but not
    // to the DP value the recommender ranks him on - i.e. the override did nothing where it
    // mattered most. Only Travis Hunter is dual-eligible in 2026, and he is exactly the case.
    if (dpPts != null) dpPts = Math.round(dpPts * n.mult * 10) / 10;
  }
  for (const k of Object.keys(wk)) wk[k] = Math.round(wk[k] * 10) / 10;

  return {
    dpPts, dpEligible: !!p.slots?.includes(DP_SLOT),
    id: p.id, name: p.name, pos: p.pos, team: p.team,
    pts: Math.round(pts * 10) / 10,
    prevPts: p.prev ? Math.round(scoreStats(p.prev, p.pos, cfg) * 10) / 10 : null,
    adp: p.adp, auction: p.auction, owned: p.owned, espnRank: p.espnRank,
    injury: p.injury, games: p.proj[STAT.games] ?? null, slots: p.slots, outlook: p.outlook,
    news: n ? n.note : null, newsMult: n ? n.mult : null,
    wk,
  };
});

if (unmatched.size) console.log('!! news-overrides names matching NO player:', [...unmatched].join(', '));
console.log(`news overlay applied to ${applied} players`);

// Consensus ADP from real mock drafts beats ESPN's censored ADP wherever it exists.
// Optional: a FantasyFootballCalculator consensus-ADP export. Absent is fine - the board
// falls back to ESPN's own ADP, which is censored past ~pick 158 but workable.
const ffcPath = process.env.FFC_ADP || path.join(dataDir(), 'adp', `ffc-${cfg.id}.json`);
const ffc = loadFfc(ffcPath, players);
if (ffc) {
  for (const p of players) {
    const f = ffc.byId.get(p.id);
    if (!f) continue;
    p.espnAdp = p.adp;
    p.adp = f.adp;
    p.adpStdev = f.stdev;
    p.adpSource = 'ffc';
    if (f.bye) p.bye = f.bye;
  }
  console.log(`FFC consensus ADP matched ${ffc.matched}/${ffc.total}` +
    (ffc.meta ? ` (${ffc.meta.total_drafts} drafts, ${ffc.meta.teams}-team ${ffc.meta.type}, to ${ffc.meta.end_date})` : ''));
} else {
  console.log('no FFC file - using ESPN ADP only (censored past ~158)');
}

// BYE WEEKS. ESPN marks a skill player's bye with a 0-point week, but emits a FULL stat line for
// a D/ST on its bye - so a defense would otherwise be projected to score on a week it does not
// play. Resolve each team's bye (FFC publishes it; otherwise vote among the team's skill players)
// and zero the defense.
{
  const votes = {};
  for (const p of players) {
    if (!p.team || p.team === '?') continue;
    if (p.bye) { (votes[p.team] ||= {})[p.bye] = ((votes[p.team] || {})[p.bye] || 0) + 100; continue; }
    if (p.pos === 'DST') continue;
    for (let w = 1; w <= 18; w++) {
      if (p.wk[w] === 0 || p.wk[w] == null) (votes[p.team] ||= {})[w] = ((votes[p.team] || {})[w] || 0) + 1;
    }
  }
  const byeByTeam = {};
  for (const [team, ws] of Object.entries(votes)) {
    const [best] = Object.entries(ws).sort((a, b) => b[1] - a[1]);
    if (best && best[1] >= 3) byeByTeam[team] = Number(best[0]);
  }
  let zeroed = 0;
  for (const p of players) {
    const bye = byeByTeam[p.team];
    if (!bye) continue;
    p.bye = bye;
    if (p.pos === 'DST' && p.wk[bye]) { p.wk[bye] = 0; zeroed++; }
  }
  console.log(`byes resolved for ${Object.keys(byeByTeam).length}/32 teams; zeroed ${zeroed} D/ST bye weeks`);
}

// Drop players the overlay zeroed out (season-enders) and never-projected noise.
players = players.filter(p => p.pts > 0);

// Kicker and D/ST projections are near-noise: year-over-year predictive correlation is roughly
// 0.10 and 0.15. Treating a 30-point projected gap between D/ST 1 and D/ST 12 as real buys a
// defense two rounds too early. Regressing both toward the top-24 positional mean keeps the
// ordering (so the board still prefers the better one) while shrinking the gap to something
// honest. Controlled by tuning.noiseRegression; 0 disables it.
{
  const k = cfg.tuning?.noiseRegression ?? 0;
  if (k > 0) for (const pos of ['K', 'DST']) {
    const arr = players.filter(p => p.pos === pos).sort((a, b) => b.pts - a.pts);
    if (arr.length < 12) continue;
    const mean = arr.slice(0, 24).reduce((s, p) => s + p.pts, 0) / Math.min(24, arr.length);
    for (const p of arr) {
      p.rawPts = p.pts;
      p.pts = Math.round((p.pts * (1 - k) + mean * k) * 10) / 10;
      for (const w of Object.keys(p.wk || {})) p.wk[w] = Math.round(p.wk[w] * (p.pts / (p.rawPts || p.pts)) * 10) / 10;
    }
  }
}

const { levels, absorbed, dpReplacementRank } = replacementLevels(players, cfg);
for (const p of players) {
  p.repl = Math.round((levels[p.pos] ?? 0) * 10) / 10;
  p.vorp = Math.round((p.pts - p.repl) * 10) / 10;
}
players.sort((a, b) => b.vorp - a.vorp);
players.forEach((p, i) => { p.vorpRank = i + 1; });

// tiers within each position
const byPos = {};
for (const p of players) (byPos[p.pos] ||= []).push(p);
for (const arr of Object.values(byPos)) {
  arr.sort((a, b) => b.pts - a.pts);
  const k = Math.min(10, Math.max(3, Math.round(arr.length / 6)));
  const tiers = tierize(arr, k);
  arr.forEach((p, i) => { p.posRank = i + 1; p.tier = tiers[i]; });
}

fs.mkdirSync(path.join(root, 'data/cache'), { recursive: true });
fs.writeFileSync(boardPath(cfg.id), JSON.stringify({
  league: cfg.id, replacement: levels, flexAbsorbed: absorbed, dpReplacementRank,
  newsUpdated: newsDoc.updated || null,
  generatedAt: new Date().toISOString(),
  adpSource: ffc ? `ffc(${ffc.matched}) + espn` : 'espn',
  players,
}));

// ---------------- diagnostics ----------------
console.log(`scored ${players.length} players | flex absorbed:`, absorbed, `| DP replacement = IDP #${dpReplacementRank}`);
console.log('REPLACEMENT LEVELS:', Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, Math.round(v)])));
const fmt = p => `${String(p.posRank).padStart(2)} ${p.name.padEnd(24)} ${String(p.pts).padStart(6)}pts vorp${String(p.vorp).padStart(6)} adp${String(p.adp ? p.adp.toFixed(1) : '-').padStart(6)} T${p.tier}${p.news ? '  * ' + p.news.slice(0, 44) : ''}`;
for (const pos of ['QB', 'RB', 'WR', 'TE', 'LB', 'DST', 'K']) {
  console.log(`\n===== ${pos} top 12 =====`);
  (byPos[pos] || []).slice(0, 12).forEach(p => console.log('  ' + fmt(p)));
}
console.log('\n===== OVERALL TOP 40 BY VORP (this league) vs ESPN ADP =====');
players.slice(0, 40).forEach(p => {
  const d = p.adp ? p.adp - p.vorpRank : null;
  const flag = d === null ? '' : d > 14 ? '  <<< VALUE' : d < -14 ? '  >>> reach' : '';
  console.log(`${String(p.vorpRank).padStart(3)}. ${p.name.padEnd(24)} ${p.pos.padEnd(4)} ${String(p.pts).padStart(6)}pts  vorp ${String(p.vorp).padStart(6)}  adp ${String(p.adp ? p.adp.toFixed(0) : '-').padStart(4)}${flag}`);
});
