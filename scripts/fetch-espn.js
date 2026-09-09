// Refresh the cached ESPN player snapshot (public endpoint, no auth needed).
//   node scripts/fetch-espn.js [season]
// Writes <data root>/raw/espn-players-<season>.json, keeping a timestamped backup of the previous.
//
// The path MUST come from rawPath(). When the private data repo lives beside this one, writing
// to `<repo>/data/raw` instead puts the fresh dump somewhere build-board never reads - so every
// board silently rebuilds on the old snapshot and "refresh the projections" becomes a no-op.
import fs from 'node:fs';
import path from 'node:path';
import { rawPath, ensureDirs, dataRoot } from '../src/league.js';

const season = Number(process.argv[2] || 2026);
const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players`
  + `?scoringPeriodId=0&view=kona_player_info`;

// Ask for the season projection, last season's actuals, and every weekly projection.
const filter = {
  players: {
    filterStatsForTopScoringPeriodIds: {
      value: 2,
      additionalValue: [`00${season}`, `10${season}`, `00${season - 1}`, `10${season - 1}`],
    },
  },
};

const out = rawPath(`espn-players-${season}.json`);
const canonical = rawPath('espn-players-2026.json');

console.log(`fetching ${season} player universe from ESPN...`);
const t0 = Date.now();
const res = await fetch(url, {
  headers: { 'x-fantasy-filter': JSON.stringify(filter), accept: 'application/json' },
  signal: AbortSignal.timeout(120000),
});
if (!res.ok) {
  console.error(`ESPN returned ${res.status} ${res.statusText}`);
  process.exit(1);
}
const body = await res.text();
let parsed;
try {
  parsed = JSON.parse(body);
} catch {
  console.error('ESPN returned something that is not JSON — keeping the existing snapshot.');
  process.exit(1);
}
if (!Array.isArray(parsed) || parsed.length < 1000) {
  console.error(`Suspicious payload (${Array.isArray(parsed) ? parsed.length : typeof parsed}) — keeping the existing snapshot.`);
  process.exit(1);
}

ensureDirs();
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(canonical)) {
  const stamp = fs.statSync(canonical).mtime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(canonical, rawPath(`espn-players-${season}.${stamp}.bak.json`));
}
fs.writeFileSync(out, body);
if (out !== canonical) fs.copyFileSync(out, canonical);

const withProj = parsed.filter(p => (p.player || p).stats?.some(
  s => s.seasonId === season && s.statSourceId === 1 && !s.scoringPeriodId)).length;
console.log(`  ${parsed.length} players, ${withProj} with ${season} projections`);
console.log(`  ${(body.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
console.log(`  data root: ${dataRoot()}`);
console.log('\nnow run:  node scripts/build-board.js');
