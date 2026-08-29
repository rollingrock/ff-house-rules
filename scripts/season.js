// In-season CLI:  node scripts/season.js lineup <week> | waivers <week> | byes
import fs from 'node:fs'; import path from 'node:path';
import { optimizeLineup, waiverTargets, byeReport, weekPoints, isBye } from '../src/season.js';
import { loadConfig, boardPath, draftPath } from '../src/league.js';
const root = path.resolve(import.meta.dirname, '..');
const cfg = loadConfig(process.env.LEAGUE);
const LEAGUE = cfg.id;
const board = JSON.parse(fs.readFileSync(boardPath(LEAGUE), 'utf8'));
const byId = new Map(board.players.map(p => [p.id, p]));
const draftFile = draftPath(LEAGUE);
const draft = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf8')) : { picks: [], mySlot: null };
const myRoster = draft.picks.filter(p => p.team === draft.mySlot).map(p => byId.get(p.playerId)).filter(Boolean);

const [cmd, arg] = process.argv.slice(2);
const week = Number(arg) || 1;
if (!myRoster.length) { console.log('No drafted roster yet — run the draft first (or sync from ESPN).'); process.exit(0); }

if (cmd === 'lineup') {
  const { lineup, bench, total } = optimizeLineup(myRoster, week, cfg);
  console.log(`\n  OPTIMAL LINEUP — week ${week}   (projected ${total})\n`);
  for (const l of lineup) console.log(`   ${String(l.slot).padEnd(5)} ${l.empty ? '— EMPTY —' : `${l.name.padEnd(24)} ${l.pos.padEnd(4)} ${l.wpts}`}`);
  console.log('\n   bench:');
  for (const b of bench) console.log(`         ${b.name.padEnd(24)} ${b.pos.padEnd(4)} ${b.wpts}${isBye(b, week) ? '  (BYE)' : ''}`);
} else if (cmd === 'waivers') {
  const taken = new Set(draft.picks.map(p => p.playerId));
  const avail = board.players.filter(p => !taken.has(p.id) && (p.owned ?? 0) < 60);
  const { targets, drops, baseline } = waiverTargets({ roster: myRoster, available: avail.slice(0, 400), cfg, fromWeek: week });
  console.log(`\n  WAIVER TARGETS from week ${week} (rest-of-season starting-lineup gain; baseline ${baseline})\n`);
  targets.filter(t => t.restOfSeasonGain > 0).slice(0, 15)
    .forEach((t, i) => console.log(`   ${String(i + 1).padStart(2)}. ${t.name.padEnd(24)} ${t.pos.padEnd(4)} +${t.restOfSeasonGain}  (${Math.round(t.owned ?? 0)}% rostered)`));
  console.log('\n  CHEAPEST DROPS:');
  drops.slice(0, 5).forEach(d => console.log(`      ${d.name.padEnd(24)} ${d.pos.padEnd(4)} costs ${d.costToDrop}`));
} else if (cmd === 'byes') {
  console.log('\n  BYE-WEEK COLLISIONS\n');
  for (const b of byeReport(myRoster, cfg)) console.log(`   week ${String(b.week).padStart(2)}: ${b.count} out — ${b.players.join(', ')}`);
} else {
  console.log('usage: node scripts/season.js lineup <week> | waivers <week> | byes');
}
