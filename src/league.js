// Where configuration and data live, and which league is active.
//
// The engine is public and forkable; a user's league configs, draft history and research are
// private. Those two things therefore live in different places, and nothing in this repo may
// hardcode a league id or assume the data sits beside the code.
//
// Resolution order for the data root:
//   1. $FF_DATA                       explicit, wins always
//   2. ../<repo-name>-data            a sibling private repo, the recommended layout
//   3. the repo itself                so a fresh clone works with no setup at all
//
// Resolution order for the active league:
//   1. an explicit argument passed by the caller
//   2. $LEAGUE
//   3. the only config present, if there is exactly one
//   4. otherwise: fail loudly and list what IS available

import fs from 'node:fs';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..');

let _warned = false;

export function dataRoot() {
  if (process.env.FF_DATA) return path.resolve(process.env.FF_DATA);
  const sibling = path.resolve(repoRoot, '..', `${path.basename(repoRoot)}-data`);
  if (fs.existsSync(path.join(sibling, 'config'))) return sibling;
  return repoRoot;
}

export const configDir = () => path.join(dataRoot(), 'config');
export const dataDir = () => path.join(dataRoot(), 'data');

/** Every league config available, by id. Ignores helpers like news-overrides.json. */
export function listLeagues() {
  const dir = configDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('_')
      && !f.endsWith('.example.json')          // templates, not leagues
      && !/^(news-overrides|espn-cookies)\./.test(f))
    .map(f => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return c && c.id ? { id: c.id, name: c.name || c.id, file: path.join(dir, f) } : null;
      } catch { return null; }
    })
    .filter(Boolean);
}

/** Which league are we operating on? */
export function activeLeagueId(explicit) {
  const want = explicit || process.env.LEAGUE;
  const leagues = listLeagues();
  if (want) {
    const hit = leagues.find(l => l.id === want);
    if (hit) return hit.id;
    throw new Error(
      `Unknown league "${want}". Available: ${leagues.map(l => l.id).join(', ') || '(none)'}\n` +
      `Configs are read from ${configDir()}\n` +
      `Create one with:  node scripts/make-league-config.js <espnLeagueId>`);
  }
  if (leagues.length === 1) return leagues[0].id;
  if (leagues.length === 0) {
    throw new Error(
      `No league configs found in ${configDir()}\n` +
      `Create one with:  node scripts/make-league-config.js <espnLeagueId>\n` +
      `Or point FF_DATA at the directory that holds your config/ folder.`);
  }
  throw new Error(
    `Several leagues available - choose one with LEAGUE=<id> or an argument.\n` +
    leagues.map(l => `  ${l.id.padEnd(20)} ${l.name}`).join('\n'));
}

export function loadConfig(explicit) {
  const id = activeLeagueId(explicit);
  const cfg = JSON.parse(fs.readFileSync(path.join(configDir(), `${id}.json`), 'utf8'));
  if (!_warned && Array.isArray(cfg._warnings) && cfg._warnings.length) {
    _warned = true;
    for (const w of cfg._warnings) console.warn(`  [config warning] ${w}`);
  }
  return cfg;
}

/** Optional shared overlay of injury/role news. Absent is fine. */
export function loadNewsOverrides() {
  const p = path.join(configDir(), 'news-overrides.json');
  if (!fs.existsSync(p)) return { players: {} };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { players: {} }; }
}

export const configPath = id => path.join(configDir(), `${id}.json`);
export const boardPath = id => path.join(dataDir(), 'cache', `board-${id}.json`);
export const draftPath = id => path.join(dataDir(), 'drafts', `${id}.json`);
export const rawPath = f => path.join(dataDir(), 'raw', f);
export const historyPath = f => path.join(dataDir(), 'history', f);
export const livePath = () => path.join(dataDir(), 'live', 'draft_state.json');

/** Create the writable directories the tools assume exist. */
export function ensureDirs() {
  for (const d of ['cache', 'drafts', 'raw', 'live', 'history']) {
    fs.mkdirSync(path.join(dataDir(), d), { recursive: true });
  }
}
