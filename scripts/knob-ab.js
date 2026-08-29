// Paired A/B on an arbitrary config knob, same slots and seeds, one value changed.
//   node scripts/knob-ab.js draftRules.byeWeights.enabled true false
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const [PATHSPEC, AV, BV] = process.argv.slice(2);
const CFG = configPath(loadConfig(process.env.LEAGUE).id);
const original = fs.readFileSync(CFG, 'utf8');
const parse = v => v === 'true' ? true : v === 'false' ? false : (isNaN(+v) ? v : +v);
const setAt = (o, path, v) => { const k = path.split('.'); let c = o; for (const p of k.slice(0, -1)) c = c[p]; c[k.at(-1)] = v; };

const run = () => {
  const rows = [];
  for (let slot = 1; slot <= 12; slot++) for (const seed of [7, 42, 99]) {
    const out = execFileSync('node', ['scripts/simulate.js', String(slot), String(seed)], { encoding: 'utf8' });
    const my = out.slice(out.indexOf('MY ROSTER'));
    rows.push({ key: `${slot}/${seed}`, total: Number(my.match(/lineup total: (\d+)/)?.[1] || 0),
                finish: Number(my.match(/(\d+)\. team\s+\d+\s+<-- ME/)?.[1] || 0) });
  }
  return rows;
};
const withVal = v => { const c = JSON.parse(original); setAt(c, PATHSPEC, parse(v)); fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); return run(); };

try {
  const a = withVal(AV), b = withVal(BV);
  let aw = 0, bw = 0, tie = 0, sum = 0;
  for (let i = 0; i < a.length; i++) { const d = b[i].total - a[i].total; sum += d; if (d > 0) bw++; else if (d < 0) aw++; else tie++; }
  const n = a.length;
  console.log(`  ${PATHSPEC}`);
  console.log(`  ${AV} wins ${aw} | ${BV} wins ${bw} | tie ${tie}`);
  console.log(`  mean delta (${BV} minus ${AV}): ${(sum / n).toFixed(2)} pts over ${n} paired drafts`);
  console.log(`  1st place: ${AV} = ${a.filter(r=>r.finish===1).length}/${n} | ${BV} = ${b.filter(r=>r.finish===1).length}/${n}`);
} finally { fs.writeFileSync(CFG, original); console.log('  config restored'); }
