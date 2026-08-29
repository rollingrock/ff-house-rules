const $ = s => document.querySelector(s);
const POS_COLOR = { QB:'--QB', RB:'--RB', WR:'--WR', TE:'--TE', K:'--K', DST:'--DST' };
const posColor = p => `var(${POS_COLOR[p] || '--IDP'})`;
const IDP = ['LB','DE','DT','CB','S'];
let S = null, results = [], sel = 0;

const toast = (m, ms=1900) => { const t=$('#toast'); t.textContent=m; t.style.display='block';
  clearTimeout(t._t); t._t=setTimeout(()=>t.style.display='none', ms); };

async function api(path, body) {
  const r = await fetch(path, body ? { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(body) } : undefined);
  return r.json();
}

function render(s) {
  S = s;
  $('#lg').textContent = s.league;
  $('#pick').textContent = `R${s.round} · Pick ${s.pickNo} of ${s.teams * s.rounds}`;
  $('#proj').textContent = `proj ${s.lineupTotal}`;
  $('#lt').textContent = s.lineupTotal;

  const slotEl = $('#slotbtn');
  const provisional = s.slotProvisional && !s.slotStale;
  slotEl.textContent = s.mySlot == null ? 'Set slot'
    : `Slot ${s.mySlot}${s.slotStale ? ' ?' : provisional ? ' (prov)' : ''}`;
  slotEl.className = s.mySlot == null ? 'needslot' : (s.slotStale || provisional) ? 'staleslot' : '';
  slotEl.title = provisional
    ? 'ESPN has not randomised the draft order yet - this slot is a placeholder and will update automatically'
    : '';

  const c = $('#clock');
  if (s.complete) { c.className='wait'; c.textContent='DRAFT COMPLETE'; }
  else if (s.mySlot == null) { c.className='soon'; c.textContent='SET YOUR DRAFT SLOT →'; }
  else if (s.slotStale) { c.className='soon'; c.textContent=`CONFIRM SLOT ${s.mySlot} →`; }
  else if (s.isMyTurn) { c.className='me'; c.textContent='YOU ARE ON THE CLOCK'; }
  else if (s.untilMyTurn == null) { c.className='wait'; c.textContent='NO PICKS LEFT'; }
  else if (s.untilMyTurn <= 3) { c.className='soon'; c.textContent=`${s.untilMyTurn} pick${s.untilMyTurn===1?'':'s'} away`; }
  else { c.className='wait'; c.textContent=`${s.untilMyTurn} picks away · next @ ${s.nextPick}`; }

  // live-feed status: the user must be able to tell at a glance whether picks are
  // arriving on their own or whether they need to type them in.
  const L = s.live || {};
  const badge = $('#livest');
  // The sidecar heartbeats every 2s, so anything older than 10s means it died. Without this
  // the badge stayed green forever on a dead watcher - and the runbook tells the user that
  // the badge going non-green is their ONLY signal to fall back to typing picks.
  const staleSec = L.staleMs == null ? null : Math.round(L.staleMs / 1000);
  const stale = L.staleMs != null && L.staleMs > 10000;
  if (L.running && stale) {
    badge.textContent = `⚠ FEED DEAD ${staleSec}s — TYPE PICKS`; badge.className = 'pill live-off';
  } else if (L.running && L.ws === 'connected') {
    badge.textContent = `● LIVE · ${L.picks} picks`; badge.className = 'pill live-on';
  } else if (L.running) {
    badge.textContent = `◐ watcher up (${L.ws || 'no socket'})`; badge.className = 'pill live-warn';
  } else {
    badge.textContent = '○ manual entry'; badge.className = 'pill live-off';
  }

  // What the teams ahead of me still need - drives whether my target survives.
  const needs = Object.entries(s.upcomingNeeds || {}).sort((a,b)=>b[1]-a[1]).slice(0,4);
  $('#ahead').innerHTML = (s.opponentAware && needs.length)
    ? `<span class="aheadlab">next ${s.upcomingTeamCount} teams need</span> ` + needs
        .map(([p,n])=>`<span class="need" style="border-color:${posColor(p)};color:${posColor(p)}">${p}${n>1?'×'+n:''}</span>`).join('')
    : '';

  $('#runs').innerHTML = Object.entries(s.runs||{}).filter(([,n])=>n>=2)
    .sort((a,b)=>b[1]-a[1]).slice(0,4)
    .map(([p,n])=>`<span class="run ${n>=4?'hot':''}">${p}×${n}</span>`).join('');

  $('#recs').innerHTML = s.recs.map((r,i)=>{
    const sv = r.survival, cls = sv==null?'':sv>=70?'hi':sv>=35?'mid':'lo';
    return `<div class="rec ${i===0?'top':''}" data-id="${r.id}" data-i="${i}">
      <div class="idx">${i<9?i+1:'·'}</div>
      <div>
        <div class="nm">${r.name}</div>
        <div class="meta">
          <span class="pos" style="background:${posColor(r.pos)}">${r.pos}</span>
          <span>${r.team}</span>
          <span class="tier">T${r.tier}</span>
          <span>${r.pts} pts</span>
          <span>${r.adpCensored?'ADP —':'ADP '+Math.round(r.adp)}</span>
          ${r.injury?`<span style="color:var(--hot)">${r.injury}</span>`:''}
        </div>
        ${r.reason?`<div class="why">${r.reason}</div>`:''}
      </div>
      <div class="num">
        <div class="big">${r.score>0?'+':''}${r.score}</div>
        <div class="sub">pick value</div>
        <div class="sub">${r.marginal>0?'+':''}${r.marginal} lineup</div>
        ${sv==null?'':`<div class="sub surv ${cls}">${sv}% lasts</div>`}
      </div>
    </div>`;
  }).join('') || '<div style="padding:20px;color:var(--dim)">No players available.</div>';

  // roster laid out by starting slot
  const need = { QB:1, RB:2, WR:2, TE:1, FLEX:1, DP:1, DST:1, K:1 };
  const starters = s.roster.filter(p=>p.starter), bench = s.roster.filter(p=>!p.starter);
  const used = new Set(); const rows = [];
  for (const [slot,n] of Object.entries(need)) for (let i=0;i<n;i++) {
    let p = null;
    if (slot==='FLEX') p = starters.find(x=>!used.has(x.id) && ['RB','WR','TE'].includes(x.pos));
    else if (slot==='DP') p = starters.find(x=>!used.has(x.id) && IDP.includes(x.pos));
    else p = starters.find(x=>!used.has(x.id) && x.pos===slot);
    if (p) used.add(p.id);
    rows.push(`<div class="slot ${p?'':'empty'}">
      <span class="lb">${slot}</span>
      <span class="nm">${p?p.name:'—'}</span>
      <span class="pts">${p?p.pts:''}</span></div>`);
  }
  if (bench.length) rows.push(`<div class="slot" style="border-top:1px solid var(--line)">
    <span class="lb">BN</span><span class="pts" style="grid-column:2/4">${bench.length} on bench</span></div>`);
  rows.push(...bench.map(p=>`<div class="slot bench"><span class="lb">·</span>
    <span class="nm">${p.name}</span><span class="pts">${p.pts}</span></div>`));
  $('#roster').innerHTML = rows.join('');

  const missing = [];
  const cnt = pos => s.roster.filter(p=>p.pos===pos).length;
  for (const [slot,n] of Object.entries(need)) {
    let have;
    if (slot==='FLEX') have = Math.max(0, cnt('RB')+cnt('WR')+cnt('TE') - 5);
    else if (slot==='DP') have = s.roster.filter(p=>IDP.includes(p.pos)).length;
    else have = cnt(slot);
    if (have < n) missing.push(n-have>1 ? `${slot}×${n-have}` : slot);
  }
  $('#needs').innerHTML = missing.length
    ? `Still need: <b>${missing.join(', ')}</b>`
    : 'All starting slots filled ✓';

  // Show WHY certain positions aren't being recommended yet, so the guardrails read as
  // deliberate rather than as the tool being broken.
  const held = {};
  for (const b of (s.blocked || [])) if (b.reason && !held[b.pos]) held[b.pos] = b.reason;
  const heldTxt = Object.entries(held).slice(0, 3)
    .map(([p, r]) => `<span style="color:${posColor(p)}">${p}</span> ${r.replace(/^too early for \w+ /, '')}`).join(' · ');
  $('#held').innerHTML = [
    heldTxt ? `held back: ${heldTxt}` : '',
    s.unknownPicks ? `<span style="color:var(--warn)">${s.unknownPicks} pick${s.unknownPicks===1?'':'s'} by a player not in the board — slot kept, name unknown</span>` : '',
  ].filter(Boolean).join(' · ');

  $('#teams').innerHTML = Object.entries(s.rosters).map(([t,r])=>{
    const nm = s.teamNames?.[t];
    return `<div class="slot" style="grid-template-columns:22px 1fr" title="${nm||''}">
      <span class="lb" style="color:${+t===s.mySlot?'var(--go)':''}">${t}${+t===s.mySlot?'*':''}</span>
      <span>${nm?`<span style="color:var(--dim2)">${nm.slice(0,13)}</span> `:''}${r.map(p=>`<span style="color:${posColor(p.pos)}">${p.pos}</span>`).join(' ')||'<span style="color:var(--dim2)">—</span>'}</span>
    </div>`;}).join('');

  $('#recent').innerHTML = s.recent.map(p=>
    `<div>${p.pickNo}. <b>${p.name}</b> <span style="color:${posColor(p.pos)}">${p.pos}</span> → tm ${p.team}</div>`).join('');
}

// ---------- pick entry ----------
let timer = null;
$('#q').addEventListener('input', e => {
  clearTimeout(timer);
  const q = e.target.value.trim();
  if (!q) { $('#results').classList.remove('on'); results=[]; return; }
  timer = setTimeout(async () => {
    results = await api('/api/search?q=' + encodeURIComponent(q));
    sel = 0; drawResults();
  }, 60);
});
function drawResults() {
  const el = $('#results');
  if (!results.length) { el.classList.remove('on'); return; }
  el.classList.add('on');
  el.innerHTML = results.map((p,i)=>`<div class="res ${i===sel?'sel':''}" data-i="${i}">
    <span class="pos" style="background:${posColor(p.pos)}">${p.pos}</span>
    <span>${p.name}</span>
    <span class="rr">${p.team} · ${p.pts}pts · ADP ${p.adp?Math.round(p.adp):'—'}</span></div>`).join('');
  el.querySelector('.sel')?.scrollIntoView({block:'nearest'});
}
$('#results').addEventListener('click', e => {
  const d = e.target.closest('.res'); if (d) { sel = +d.dataset.i; confirmPick(); }
});
async function confirmPick() {
  const p = results[sel]; if (!p) return;
  const s = await api('/api/pick', { id: p.id });
  if (s.error) return toast(s.error);
  $('#q').value=''; results=[]; $('#results').classList.remove('on');
  render(s); toast(`${p.name} → team ${s.recent[0]?.team}`);
}
$('#q').addEventListener('keydown', e => {
  if (e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,results.length-1);drawResults();}
  else if (e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);drawResults();}
  else if (e.key==='Enter'){e.preventDefault();confirmPick();}
  else if (e.key==='Escape'){e.target.value='';results=[];$('#results').classList.remove('on');}
});
$('#recs').addEventListener('click', async e => {
  const d = e.target.closest('.rec'); if (!d) return;
  const s = await api('/api/pick', { id:+d.dataset.id });
  if (s.error) return toast(s.error);
  render(s); toast('Drafted.');
});
document.addEventListener('keydown', async e => {
  // Focus rules, learned the hard way twice:
  //  - Checking `e.target.value` was a bug: on the FIRST keystroke the value is still empty,
  //    so typing "Uchenna Nwosu" fired undo.
  //  - But blanket-ignoring every INPUT killed EVERY hotkey, because a 1.5s timer keeps the
  //    search box focused, so focus is essentially always in a field. All the keys the runbook
  //    documents were unreachable.
  // Resolution: digits are unambiguous (no player name starts with one), so they fire whenever
  // the search box is empty. Letters are not (Uchenna, Saquon), so they need focus outside the
  // box. Undo also gets Ctrl+Z, which can never collide with typing a name.
  const q = $('#q');
  const inField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
  const searchIsEmpty = e.target === q && !q.value;

  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    { const u = await api('/api/undo', {}); render(u); toast(u.undone === false ? 'Could not undo — the live ESPN feed still reports that pick.' : 'Undid last pick.', 4000); }
    return;
  }
  // Digits: safe whenever the box is empty, because no player name begins with a digit.
  if (/^[1-9]$/.test(e.key) && (!inField || searchIsEmpty)) {
    if (!S?.recs?.length) return;
    const r = S.recs[+e.key - 1]; if (!r) return;
    e.preventDefault();
    const s = await api('/api/pick', { id: r.id });
    if (!s.error) { render(s); toast(`${r.name} drafted.`); }
    return;
  }
  // Letters would swallow the first keystroke of a name, so they require focus fully
  // outside any field. Undo is still reachable while typing via Ctrl+Z, handled above.
  if (inField) return;
  if (e.key==='u'||e.key==='U') { { const u = await api('/api/undo',{}); render(u); toast(u.undone === false ? 'Could not undo — the live ESPN feed still reports that pick.' : 'Undid last pick.', 4000); } }
  if (e.key==='s'||e.key==='S') doSync();
  if (e.key==='/') { e.preventDefault(); $('#q').focus(); }
});
$('#undo').onclick = async()=>{ { const u = await api('/api/undo',{}); render(u); toast(u.undone === false ? 'Could not undo — the live ESPN feed still reports that pick.' : 'Undid last pick.', 4000); } };
$('#sync').onclick = doSync;
async function doSync(){
  const r = await api('/api/sync',{});
  if (r.error) return toast('ESPN sync: ' + r.error, 4000);
  render(r); toast(`Synced ${r.synced} new pick${r.synced===1?'':'s'} from ESPN.`);
}
$('#slotbtn').onclick = async()=>{
  const v = prompt(`Which draft slot are you? (1-${S?.teams||12})`, S?.mySlot||'');
  if (v) render(await api('/api/slot',{slot:+v}));
};

setInterval(()=>{ if (document.activeElement===document.body) $('#q').focus(); }, 1500);
// Two different clocks, because the two sources cost very different amounts.
//
// /api/state is a local read - the server absorbs whatever draft-watch.py has written to
// data/live/draft_state.json on every call, in ~5ms. Poll it fast so a pick made in the ESPN
// draft room shows up here almost immediately.
let lastPickNo = null;
setInterval(async () => {
  if (!S || S.complete) return;
  const r = await api('/api/state');
  if (r.error) return;
  const gained = lastPickNo != null && r.pickNo > lastPickNo;
  lastPickNo = r.pickNo;
  render(r);
  if (gained && r.isMyTurn) toast("You're on the clock.", 4000);
}, 2000);

// /api/sync hits ESPN over the network. With the websocket sidecar disabled (it evicts you from
// your own draft room) this is now the ONLY automatic path, so it runs at 20s rather than 45s -
// a 30-second pick clock means 45s lagged more than a pick behind. It is still a reconcile, not
// a live feed: if ESPN freezes mDraftDetail during the draft it returns nothing and you type.
setInterval(async () => {
  if (!S || S.complete || !S.espnLinked) return;
  const r = await api('/api/sync', {});
  if (!r.error) { lastPickNo = r.pickNo; render(r); }
}, 20000);

// No .catch here used to mean a single failed first fetch left a permanently blank page - the
// phone opening the LAN URL a second before the laptop's server is up was enough to do it.
api('/api/state')
  .then(r => { if (r && !r.error) { lastPickNo = r.pickNo; render(r); } else { throw new Error(r && r.error || 'no state'); } })
  .catch(() => {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:14px;background:#b03a33;color:#fff;font:600 15px system-ui">' +
      'Could not reach the server. Is <code>node server.js</code> running? ' +
      'Retrying every 2s — this banner clears itself.</div>');
  });
