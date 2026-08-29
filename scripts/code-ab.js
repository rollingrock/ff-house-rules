// Paired A/B between the working-tree version of a source file and its committed version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const FILE = process.argv[2];
const patched = fs.readFileSync(FILE, 'utf8');
const committed = execFileSync('git', ['show', `HEAD:${FILE}`], { encoding: 'utf8' });
const run = () => {
  const rows = [];
  for (let slot = 1; slot <= 12; slot++) for (const seed of [7, 42, 99]) {
    const out = execFileSync('node', ['scripts/simulate.js', String(slot), String(seed)], { encoding: 'utf8' });
    const my = out.slice(out.indexOf('MY ROSTER'));
    const cells = [...my.matchAll(/R\s?\d+\s+(START|  ben)\s+(.+?)\s{2,}([A-Z]{1,4})\s/g)];
    const pos = {}; for (const r of cells) pos[r[3]] = (pos[r[3]] || 0) + 1;
    rows.push({ total: Number(my.match(/lineup total: (\d+)/)?.[1] || 0),
                finish: Number(my.match(/(\d+)\. team\s+\d+\s+<-- ME/)?.[1] || 0), n: cells.length, pos });
  }
  return rows;
};
const withSrc = src => { fs.writeFileSync(FILE, src); return run(); };
try {
  const a = withSrc(committed), b = withSrc(patched);
  let aw=0,bw=0,tie=0,sum=0;
  for (let i=0;i<a.length;i++){ const d=b[i].total-a[i].total; sum+=d; if(d>0)bw++; else if(d<0)aw++; else tie++; }
  const n=a.length;
  console.log(`  committed wins ${aw} | patched wins ${bw} | tie ${tie}`);
  console.log(`  mean delta (patched minus committed): ${(sum/n).toFixed(2)} pts over ${n} paired drafts`);
  console.log(`  1st: committed ${a.filter(r=>r.finish===1).length}/${n} | patched ${b.filter(r=>r.finish===1).length}/${n}`);
  const IDP=['LB','DE','DT','CB','S'];
  const illegal = rows => rows.filter(r => { const p=k=>r.pos[k]||0;
    return p('QB')<1||p('RB')<2||p('WR')<2||p('TE')<1||p('K')<1||p('DST')<1||
           (p('RB')+p('WR')+p('TE')-5)<1||!IDP.some(k=>p(k)); }).length;
  console.log(`  illegal rosters: committed ${illegal(a)} | patched ${illegal(b)}`);
} finally { fs.writeFileSync(FILE, patched); console.log('  working tree restored (patched)'); }
