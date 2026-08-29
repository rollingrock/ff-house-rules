// How often does a drafted roster have a starting slot that CANNOT be filled in some week?
// A dead one-deep slot (QB, TE, DP, D/ST, K) scores a guaranteed zero that week, which is the
// thing byeCollisionCost exists to prevent. Counts them with the penalty on and off.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, configPath, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const cfgPath = configPath(loadConfig(process.env.LEAGUE).id);
const orig = fs.readFileSync(cfgPath, 'utf8');
const board = JSON.parse(fs.readFileSync(boardPath(loadConfig(process.env.LEAGUE).id), 'utf8'));
const byName = new Map(board.players.map(p => [p.name, p]));
const cfg0 = JSON.parse(orig);
const ST = cfg0.roster.starters;
const FLEX = cfg0.roster.flexEligible, DPE = cfg0.roster.dpEligible;

function deadSlotWeeks(players) {
  let dead = 0, weeks = 0;
  for (let w = 1; w <= 14; w++) {
    weeks++;
    const up = players.filter(p => p.bye !== w);
    for (const [slot, need] of Object.entries(ST)) {
      const can = up.filter(p => slot === 'FLEX' ? FLEX.includes(p.pos)
        : slot === 'DP' ? DPE.includes(p.pos) : p.pos === slot).length;
      if (can < need) dead += (need - can);
    }
  }
  return { dead, weeks };
}

function run(enabled) {
  const c = JSON.parse(orig);
  c.draftRules.byeWeights.enabled = enabled;
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
  let totalDead = 0, totalWeeks = 0, rostersWithDead = 0, n = 0, pts = 0;
  for (const slot of [1, 3, 5, 8, 10, 12]) for (const seed of [7, 42, 99]) {
    const out = execFileSync('node', [path.join(root, 'scripts/simulate.js'), String(slot), String(seed)], { encoding: 'utf8' });
    const my = out.slice(out.indexOf('MY ROSTER'));
    const names = [...my.matchAll(/R\s?\d+\s+(?:START|  ben)\s+(.+?)\s{2,}[A-Z]{1,4}\s/g)].map(m => m[1]);
    const players = names.map(x => byName.get(x)).filter(Boolean);
    const { dead, weeks } = deadSlotWeeks(players);
    totalDead += dead; totalWeeks += weeks; if (dead) rostersWithDead++;
    pts += Number(my.match(/lineup total: (\d+)/)?.[1] || 0);
    n++;
  }
  return { totalDead, totalWeeks, rostersWithDead, n, pts: Math.round(pts / n) };
}

const off = run(false), on = run(true);
fs.writeFileSync(cfgPath, orig);
console.log('Dead starting slots across 18 drafts (6 slots x 3 seeds), weeks 1-14\n');
console.log('                              penalty OFF   penalty ON');
console.log(`  dead slot-weeks total       ${String(off.totalDead).padStart(11)}${String(on.totalDead).padStart(13)}`);
console.log(`  rosters with any dead slot  ${String(off.rostersWithDead + '/' + off.n).padStart(11)}${String(on.rostersWithDead + '/' + on.n).padStart(13)}`);
console.log(`  projected lineup            ${String(off.pts).padStart(11)}${String(on.pts).padStart(13)}`);
console.log(`\n  a dead one-deep slot is a guaranteed zero in that week's lineup.`);
