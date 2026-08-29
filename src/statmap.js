// ESPN fantasy stat-id map. Empirically verified 2026-08-28 -- see docs/STATMAP.md.
export const POSITION_BY_ID = {
  1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 7: 'P',
  9: 'DT', 10: 'DE', 11: 'LB', 12: 'CB', 13: 'S', 16: 'DST',
};
// ESPN lineup-slot ids
export const SLOT = {
  QB: 0, RB: 2, RBWR: 3, WR: 4, WRTE: 5, TE: 6, OP: 7,
  DT: 8, DE: 9, LB: 10, DL: 11, CB: 12, S: 13, DB: 14,
  DP: 15, DST: 16, K: 17, P: 18, HC: 19, BE: 20, IR: 21, FLEX: 23,
};
export const STAT = {
  // passing
  passAtt: '0', passComp: '1', passInc: '2', passYds: '3', passTD: '4', int: '20', pass2pt: '19',
  // rushing
  rushAtt: '23', rushYds: '24', rushTD: '25', rush2pt: '26',
  // receiving
  recYds: '42', recTD: '43', rec2pt: '44', receptions: '53', receptionsAlt: '41', targets: '58',
  // misc
  fumbles: '68', fumblesLost: '72', games: '210',
  // kicking  (NOTE: 80 = 0-39, 77 = 40-49, 74 = 50+, 198 = 50-59)
  fg0_39: '80', fg40_49: '77', fg50_59: '198', fg60plus: '201', fg50plusAgg: '74',
  fgMade: '83', fgAtt: '84', fgMiss: '85', patMade: '86', patAtt: '87', patMiss: '88',
  // defense (player + team)
  sacks: '99', defInt: '95', fumRec: '96', fumForced: '106',
  tacklesSolo: '107', tacklesAssist: '108', tacklesTotal: '109',
  tfl: '112', passDef: '113',
  ptsAllowed: '120', ptsAllowedPG: '126', ydsAllowed: '127', ydsAllowedPG: '137',
};
// Ids that are DERIVED from others -- scoring them double-counts. Guard rail.
export const FORBIDDEN = new Set([
  '5','6','7','8','9','10','11','12','13','14',   // passing yard/TD buckets
  '100',                                           // = sacks x 2
  '41',                                            // duplicate of 53 (receptions)
  '22','40','60','61',                             // per-game / per-attempt rates
  '74','75','76',                                  // FG 50+ AGGREGATE (= 198+201) - double-count trap
  '94','105',                                      // defTD aggregates: 94 = 103+104, 105 = 94+93
  '73',                                            // turnovers (= 20 + 72)
  '211','212','213',                               // unidentified aggregates
  '47','48','49','50','51',                        // target/reception distance buckets
  '210',                                           // games played
  '83','84','87',                                  // FG/PAT totals (buckets already counted)
]);
