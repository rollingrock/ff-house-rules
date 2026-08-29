// Normalizes the raw ESPN /players kona_player_info payload into app-shaped records.
import { POSITION_BY_ID } from './statmap.js';

export const seasonProjection = (p, season) =>
  (p.stats || []).find(s => s.seasonId === season && s.statSourceId === 1 && !s.scoringPeriodId)?.stats || null;

export const seasonActual = (p, season) =>
  (p.stats || []).find(s => s.seasonId === season && s.statSourceId === 0 && !s.scoringPeriodId)?.stats || null;

/** Week -> raw stat dict, for the given season's PROJECTIONS only. */
export function weeklyProjections(p, season) {
  const out = {};
  for (const s of p.stats || []) {
    if (s.seasonId === season && s.statSourceId === 1 && s.scoringPeriodId > 0 && s.stats) {
      out[s.scoringPeriodId] = s.stats;
    }
  }
  return out;
}

/** Week -> raw stat dict, actuals (populated as the season progresses). */
export function weeklyActuals(p, season) {
  const out = {};
  for (const s of p.stats || []) {
    if (s.seasonId === season && s.statSourceId === 0 && s.scoringPeriodId > 0 && s.stats) {
      out[s.scoringPeriodId] = s.stats;
    }
  }
  return out;
}

export const NFL_TEAM = {
  0:'FA',1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',
  11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',
  21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',
  33:'BAL',34:'HOU',
};

export function normalize(raw, season) {
  const out = [];
  for (const e of raw) {
    const p = e.player || e;
    if (!p.fullName) continue;
    const pos = POSITION_BY_ID[p.defaultPositionId];
    if (!pos || pos === 'P') continue;
    const proj = seasonProjection(p, season);
    if (!proj) continue;
    const own = p.ownership || {};
    out.push({
      id: p.id, name: p.fullName, pos, team: NFL_TEAM[p.proTeamId] || '?',
      proj, prev: seasonActual(p, season - 1), weekly: weeklyProjections(p, season),
      adp: own.averageDraftPosition || null,
      auction: own.auctionValueAverage || null,
      owned: own.percentOwned ?? null,
      espnRank: p.draftRanksByRankType?.PPR?.rank ?? null,
      injury: p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? p.injuryStatus : null,
      slots: p.eligibleSlots || [],
      outlook: p.seasonOutlook || null,
    });
  }
  return out;
}
