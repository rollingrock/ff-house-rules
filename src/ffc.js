// FantasyFootballCalculator consensus ADP.
//
// Why bother when ESPN already gives an ADP: ESPN's is CENSORED past ~pick 158 (757 of 1232
// players parked at ~170.0), so it carries no ordering information exactly where the late-round
// decisions happen. FFC publishes real ADP from 8,104 twelve-team PPR mock drafts run in the last
// week, with a per-player standard deviation, high, low, and bye week.
//
// Caveat worth knowing: FFC is STANDARD PPR, so its ADP does not price this league's QB premium.
// That is fine, and arguably ideal - it models what the ROOM will do, not what is optimal.
import fs from 'node:fs';

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
export const normName = s => String(s).toLowerCase()
  .replace(/[.'`’-]/g, '')
  .replace(SUFFIX, '')
  .replace(/[^a-z ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// FFC writes team defenses as "Seattle Defense"; our board has "Seahawks D/ST" keyed by abbrev.
const CITY_TO_ABBR = {
  arizona: 'ARI', atlanta: 'ATL', baltimore: 'BAL', buffalo: 'BUF', carolina: 'CAR',
  chicago: 'CHI', cincinnati: 'CIN', cleveland: 'CLE', dallas: 'DAL', denver: 'DEN',
  detroit: 'DET', 'green bay': 'GB', houston: 'HOU', indianapolis: 'IND', jacksonville: 'JAX',
  'kansas city': 'KC', 'la chargers': 'LAC', 'los angeles chargers': 'LAC',
  'la rams': 'LAR', 'los angeles rams': 'LAR', 'las vegas': 'LV', miami: 'MIA',
  minnesota: 'MIN', 'new england': 'NE', 'new orleans': 'NO', 'ny giants': 'NYG',
  'new york giants': 'NYG', 'ny jets': 'NYJ', 'new york jets': 'NYJ', philadelphia: 'PHI',
  pittsburgh: 'PIT', 'san francisco': 'SF', seattle: 'SEA', tampa: 'TB', 'tampa bay': 'TB',
  tennessee: 'TEN', washington: 'WSH',
};

/** Returns { byId: Map(playerId -> {adp, stdev, high, low, bye, timesDrafted}), matched, total }. */
export function loadFfc(file, players) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const rows = doc.players || [];
  if (!rows.length) return null;

  // index the board a few ways so near-misses still resolve
  const byName = new Map(), byLastFirst = new Map(), dstByTeam = new Map();
  for (const p of players) {
    const n = normName(p.name);
    if (!byName.has(n)) byName.set(n, p);
    const parts = n.split(' ');
    if (parts.length >= 2) {
      const key = `${parts[0][0]}|${parts[parts.length - 1]}|${p.pos}`;
      if (!byLastFirst.has(key)) byLastFirst.set(key, p);
    }
    if (p.pos === 'DST') dstByTeam.set(p.team, p);
  }

  const byId = new Map();
  let matched = 0;
  for (const r of rows) {
    const n = normName(r.name);
    let hit = null;
    if (r.position === 'DEF') {
      const city = n.replace(/ defense$/, '');
      hit = dstByTeam.get(CITY_TO_ABBR[city]);
    } else {
      hit = byName.get(n);
      if (!hit) {
        const parts = n.split(' ');
        const pos = r.position === 'PK' ? 'K' : r.position;
        if (parts.length >= 2) hit = byLastFirst.get(`${parts[0][0]}|${parts[parts.length - 1]}|${pos}`);
      }
    }
    if (!hit) continue;
    matched++;
    byId.set(hit.id, {
      adp: r.adp, stdev: r.stdev, high: r.high, low: r.low,
      bye: r.bye, timesDrafted: r.times_drafted,
    });
  }
  return { byId, matched, total: rows.length, meta: doc.meta || null };
}
