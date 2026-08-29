// Sanity sweep: run the recommender from every draft slot across several seeds and
// report roster shape + finish. Catches pathologies a single mock would miss.
import { execFileSync } from 'node:child_process';
const results = [];
for (let slot = 1; slot <= 12; slot++) {
  for (const seed of [7, 42, 99]) {
    const out = execFileSync('node', ['scripts/simulate.js', String(slot), String(seed)], { encoding: 'utf8' });
    const my = out.slice(out.indexOf('MY ROSTER'));
    const rows = [...my.matchAll(/R\s?\d+\s+(START|  ben)\s+(.+?)\s{2,}([A-Z]{1,4})\s/g)];
    const pos = {};
    for (const r of rows) pos[r[3]] = (pos[r[3]] || 0) + 1;
    const total = Number(my.match(/lineup total: (\d+)/)?.[1] || 0);
    const finish = my.match(/(\d+)\. team\s+\d+\s+<-- ME/)?.[1];
    const rounds = {};
    for (const [i, r] of rows.entries()) rounds[r[3]] ??= i + 1;   // first round each position taken
    results.push({ slot, seed, total, finish: Number(finish), pos, rounds, n: rows.length });
  }
}
const agg = k => results.map(r => r.pos[k] || 0);
const stat = a => `${Math.min(...a)}-${Math.max(...a)} (avg ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)})`;
console.log('runs:', results.length, '| roster size range:', stat(results.map(r => r.n)));
console.log('finish position     :', stat(results.map(r => r.finish)));
console.log('projected lineup    :', stat(results.map(r => r.total)));
console.log('\nplayers drafted by position:');
for (const p of ['QB','RB','WR','TE','K','DST','LB']) console.log(`  ${p.padEnd(4)} ${stat(agg(p))}`);
console.log('\nFIRST round each position is taken (want: QB>=5, K>=14, DST>=12, LB>=11):');
for (const p of ['QB','RB','WR','TE','LB','DST','K']) {
  const a = results.map(r => r.rounds[p]).filter(Boolean);
  console.log(`  ${p.padEnd(4)} ${stat(a)}`);
}
// Legal = can actually field QB1 RB2 WR2 TE1 FLEX1 DP1 DST1 K1, not an arbitrary count.
const IDP = ['LB', 'DE', 'DT', 'CB', 'S'];
const illegal = results.filter(r => {
  const p = k => r.pos[k] || 0;
  const flexSpare = p('RB') + p('WR') + p('TE') - 5;      // anything beyond RB2 + WR2 + TE1
  return p('QB') < 1 || p('RB') < 2 || p('WR') < 2 || p('TE') < 1 ||
         p('K') < 1 || p('DST') < 1 || flexSpare < 1 || !IDP.some(k => p(k));
});
console.log('\nrosters that cannot field a legal starting lineup:',
  illegal.length ? illegal.map(b => `slot${b.slot}/seed${b.seed}`).join(' ') : 'NONE');
const wins = results.filter(r => r.finish === 1).length;
console.log(`finished 1st in ${wins}/${results.length} sims; top-3 in ${results.filter(r=>r.finish<=3).length}`);
