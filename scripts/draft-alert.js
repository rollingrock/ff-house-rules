// Draft-night advisor watch. Polls the running server and emits ONE line when you are a few
// picks away, and one when you are on the clock. Selective by design - roughly two events
// per turn across a whole draft, so it can drive a notifier without becoming noise.
//
//   SLOT=8 TEAMS=12 ROUNDS=16 node scripts/draft-alert.js
const http = require('http');
const SLOT = Number(process.env.SLOT || 1);
const TEAMS = Number(process.env.TEAMS || 12);
const ROUNDS = Number(process.env.ROUNDS || 16);
// snake order: odd rounds run 1..N, even rounds run N..1
const MY = Array.from({ length: ROUNDS }, (_, i) =>
  i % 2 === 0 ? i * TEAMS + SLOT : i * TEAMS + (TEAMS - SLOT + 1));
const LEAD = 3;
const fired = new Set();
let fails = 0, warned = false, lastSeen = -1, idleTicks = 0;

const get = () => new Promise(res => {
  const req = http.get({ port: 8777, path: '/api/state', timeout: 4000 }, s => {
    let x = ''; s.on('data', c => x += c);
    s.on('end', () => { try { res(JSON.parse(x)); } catch { res(null); } });
  });
  req.on('error', () => res(null));
  req.on('timeout', () => { req.destroy(); res(null); });
});

const fmt = r => `${r.name} (${r.pos} ${Math.round(r.score)}, ${r.survival ?? '-'}% lasts)`;

(async function loop() {
  for (;;) {
    const s = await get();
    if (!s || !s.recs) {
      if (++fails === 5 && !warned) { warned = true; console.log('WATCH BLIND: app on :8777 not responding'); }
    } else {
      if (warned) { warned = false; fails = 0; console.log('WATCH RECOVERED: app responding again'); }
      fails = 0;
      const made = s.pickNo - 1;
      const next = MY.find(p => p >= s.pickNo);
      if (next) {
        const away = next - s.pickNo;
        const key = 'lead' + next;
        if (away > 0 && away <= LEAD && !fired.has(key)) {
          fired.add(key);
          console.log(`HEADS UP — your pick ${next} is ${away} away (${made} made). Board: `
            + s.recs.slice(0, 4).map(fmt).join(' | '));
        }
        if (away === 0 && !fired.has('clock' + next)) {
          fired.add('clock' + next);
          console.log(`ON THE CLOCK pick ${next}: ` + s.recs.slice(0, 3).map(fmt).join(' | '));
        }
      }
      // Stall detection, but only AFTER the draft has actually started. Before pick 1 a board
      // sitting at zero is simply the pre-draft state, and warning about it cries wolf.
      if (made > 0 && made === lastSeen) { if (++idleTicks % 100 === 0) console.log(`QUIET: still ${made} picks after ~5 min — is the board keeping up?`); }
      else { lastSeen = made; idleTicks = 0; }
      if (s.complete) { console.log('DRAFT COMPLETE'); process.exit(0); }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
})();
