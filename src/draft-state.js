// Snake-draft state machine. Single source of truth for "who has been taken and whose turn is it".
import fs from 'node:fs';

export function snakeOrder(teams, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++)
    for (let t = 0; t < teams; t++) order.push(r % 2 === 0 ? t + 1 : teams - t);
  return order;
}

export class DraftState {
  constructor(cfg, file) {
    this.cfg = cfg;
    this.file = file;
    this.order = snakeOrder(cfg.teams, cfg.draft.rounds);
    this.picks = [];                       // [{pickNo, team, playerId, name, pos, auto}]
    this.mySlot = cfg.draft.myPickSlot || null;
    this.slotSetAt = null;                 // so a slot left over from an earlier session is visible
    this.teamNames = {};
    this.load();
  }
  get totalPicks() { return this.order.length; }
  get onTheClock() { return this.order[this.picks.length] ?? null; }
  get currentPickNo() { return this.picks.length + 1; }
  get currentRound() { return Math.floor(this.picks.length / this.cfg.teams) + 1; }
  get isMyTurn() { return this.mySlot != null && this.onTheClock === this.mySlot; }
  get takenIds() { return new Set(this.picks.map(p => p.playerId)); }

  /** Pick numbers belonging to me, and how many picks until my next one. */
  myPickNumbers() {
    if (this.mySlot == null) return [];
    return this.order.map((t, i) => (t === this.mySlot ? i + 1 : null)).filter(Boolean);
  }
  nextMyPick(after = this.currentPickNo - 1) {
    return this.myPickNumbers().find(p => p > after) ?? null;
  }
  picksUntilMyTurn() {
    const n = this.mySlot == null ? null : this.myPickNumbers().find(p => p >= this.currentPickNo);
    return n == null ? null : n - this.currentPickNo;
  }
  rosterOf(team) { return this.picks.filter(p => p.team === team); }
  myRoster() { return this.mySlot == null ? [] : this.rosterOf(this.mySlot); }

  addPick(player, team = null) {
    if (this.picks.length >= this.totalPicks) throw new Error('draft complete');
    if (this.takenIds.has(player.id)) throw new Error(`${player.name} already drafted`);
    const pick = {
      pickNo: this.currentPickNo, round: this.currentRound,
      team: team ?? this.onTheClock,
      playerId: player.id, name: player.name, pos: player.pos, pts: player.pts,
    };
    this.picks.push(pick);
    this.save();
    return pick;
  }
  undo() { const p = this.picks.pop(); this.save(); return p; }
  reset() { this.picks = []; this.save(); }

  /**
   * Reconcile against an authoritative pick list (websocket sidecar or ESPN REST). Idempotent.
   *
   * A player id we do not have in the board cache (rookie added after the board was built, an id
   * that drifted) must STILL occupy its pick slot. Dropping it used to shrink picks.length, which
   * shifted every later pick onto the wrong team and silently corrupted whose-turn-is-it for the
   * rest of the draft. Record a placeholder instead and surface the count.
   */
  syncFrom(remotePicks, playersById) {
    let added = 0;
    this.unknownPicks = 0;
    let overflow = 0;
    for (const rp of remotePicks) {
      if (this.picks.some(p => p.playerId === rp.playerId)) continue;
      // addPick refuses to run past the end of the draft; syncFrom used to push unconditionally.
      // That is how a saved draft file once ended up holding 232 picks in a 192-pick draft,
      // which flips `complete` and permanently stops the UI's two polling loops. Refuse the same
      // way, and surface the count rather than dropping it silently.
      if (this.picks.length >= this.totalPicks) { overflow++; continue; }
      const pl = playersById.get(rp.playerId);
      this.picks.push(pl
        ? {
          pickNo: rp.pickNo ?? this.currentPickNo, round: rp.round ?? this.currentRound,
          team: rp.team ?? this.onTheClock, playerId: pl.id,
          name: pl.name, pos: pl.pos, pts: pl.pts, src: rp.src || 'espn',
        }
        : {
          pickNo: rp.pickNo ?? this.currentPickNo, round: rp.round ?? this.currentRound,
          team: rp.team ?? this.onTheClock, playerId: rp.playerId,
          name: `unknown #${rp.playerId}`, pos: '?', pts: 0, src: rp.src || 'espn', unknown: true,
        });
      added++;
    }
    this.picks.sort((a, b) => a.pickNo - b.pickNo);
    this.picks.forEach((p, i) => { p.pickNo = i + 1; p.round = Math.floor(i / this.cfg.teams) + 1; });
    this.unknownPicks = this.picks.filter(p => p.unknown).length;
    this.overflowPicks = overflow;
    if (added) this.save();
    return added;
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        mySlot: this.mySlot, slotSetAt: this.slotSetAt,
        picks: this.picks, teamNames: this.teamNames,
      }, null, 1));
    } catch {}
  }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.picks = d.picks || [];
      this.mySlot = d.mySlot ?? this.mySlot;
      this.slotSetAt = d.slotSetAt ?? null;
      this.teamNames = d.teamNames || {};
    } catch {}
  }
}
