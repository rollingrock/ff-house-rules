// Paired A/B on a draftRules.earliestRound rail. Same slots, same seeds, one knob changed.
//   node scripts/rail-ab.js LB 8 13
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';

const POS = process.argv[2] || 'LB';
const A = Number(process.argv[3]);
const B = Number(process.argv[4]);
const CFG = configPath(loadConfig(process.env.LEAGUE).id);
const original = fs.readFileSync(CFG, 'utf8');

const run = () => {
  const rows = [];
  for (let slot = 1; slot <= 12; slot++) {
    for (const seed of [7, 42, 99]) {
      const out = execFileSync('node', ['scripts/simulate.js', String(slot), String(seed)], { encoding: 'utf8' });
      const my = out.slice(out.indexOf('MY ROSTER'));
      rows.push({
        key: `${slot}/${seed}`,
        total: Number(my.match(/lineup total: (\d+)/)?.[1] || 0),
        finish: Number(my.match(/(\d+)\. team\s+\d+\s+<-- ME/)?.[1] || 0),
        dpRound: (my.match(/R\s?(\d+)\s+(?:START|  ben)\s+.+?\s{2,}(?:LB|DE|DT|CB|S)\s/) || [])[1],
      });
    }
  }
  return rows;
};

const withRail = (r) => {
  const c = JSON.parse(original);
  c.draftRules.earliestRound[POS] = r;
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
  return run();
};

try {
  const a = withRail(A), b = withRail(B);
  let aw = 0, bw = 0, tie = 0, sum = 0;
  console.log(`  slot/seed   ${POS}>=${A}      ${POS}>=${B}     delta`);
  for (let i = 0; i < a.length; i++) {
    const d = b[i].total - a[i].total; sum += d;
    if (d > 0) bw++; else if (d < 0) aw++; else tie++;
    console.log(`  ${a[i].key.padEnd(10)} ${String(a[i].total).padStart(6)}(f${a[i].finish},R${a[i].dpRound||'-'})  ${String(b[i].total).padStart(6)}(f${b[i].finish},R${b[i].dpRound||'-'})  ${(d>=0?'+':'')+d}`);
  }
  const n = a.length;
  console.log(`\n  rail ${A} wins ${aw} | rail ${B} wins ${bw} | tie ${tie}`);
  console.log(`  mean delta (rail ${B} minus rail ${A}): ${(sum / n).toFixed(2)} pts over ${n} paired drafts`);
  console.log(`  avg finish: rail ${A} = ${(a.reduce((s, r) => s + r.finish, 0) / n).toFixed(2)}  |  rail ${B} = ${(b.reduce((s, r) => s + r.finish, 0) / n).toFixed(2)}`);
  console.log(`  1st-place: rail ${A} = ${a.filter(r=>r.finish===1).length}/${n}  |  rail ${B} = ${b.filter(r=>r.finish===1).length}/${n}`);
} finally {
  fs.writeFileSync(CFG, original);
  console.log('\n  config restored');
}
