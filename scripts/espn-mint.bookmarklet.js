/*
 * GET ESPN CREDENTIALS IN 60 SECONDS.
 *
 * Two cookies unlock everything private about the league: `espn_s2` (the
 * account session) and `SWID` (the account id, braces included). MEASURED:
 * neither is HttpOnly - Chrome reports httpOnly=false, sameSite=Lax - so
 * JavaScript running ON an espn.com page can read both. That is why option A
 * below works at all, and why it can only be run FROM an ESPN tab (sameSite
 * =Lax means no other origin's page can ever get them).
 *
 * ------------------------------------------------------------------------
 * OPTION A - CONSOLE PASTE (fastest, ~20 seconds)
 * ------------------------------------------------------------------------
 * 1. In Chrome, open https://fantasy.espn.com/football/team?leagueId=YOUR_LEAGUE_ID
 *    (any ESPN fantasy page you are signed in to will do).
 * 2. Press F12 -> click the "Console" tab.
 * 3. If Chrome shows "Allow pasting", type: allow pasting  then Enter.
 * 4. Paste the ONE LINE at the bottom of this file, press Enter.
 * 5. It prints a JSON object AND copies it to your clipboard.
 * 6. Paste it into  C:\repos\ff-manager\local\espn-auth.json  and save.
 *
 * ------------------------------------------------------------------------
 * OPTION B - CLICK-THROUGH (no typing, use if the console refuses)
 * ------------------------------------------------------------------------
 * 1. On any fantasy.espn.com page, press F12.
 * 2. Click the "Application" tab (may be hidden under the ">>" chevron).
 * 3. Left sidebar -> Storage -> Cookies -> https://fantasy.espn.com
 * 4. Click the filter box, type: espn_s2
 *      -> click the row, copy the whole "Cookie Value" from the panel below
 *         (it is ~300 characters and contains % signs - take ALL of it).
 * 5. Clear the filter, type: SWID
 *      -> copy that value, braces included: {XXXXXXXX-XXXX-...}
 * 6. Put both in C:\repos\ff-manager\local\espn-auth.json:
 *      {"espn_s2": "PASTE_HERE", "swid": "{PASTE-HERE}"}
 *
 * ------------------------------------------------------------------------
 * OPTION C - BOOKMARKLET (if you want it as a one-click button)
 * ------------------------------------------------------------------------
 * Ctrl+Shift+O -> right-click a folder -> Add new bookmark -> paste the same
 * one-liner, prefixed with `javascript:`, into the URL box. Click it while on
 * an ESPN fantasy page.
 *
 * ------------------------------------------------------------------------
 * NOTES
 * ------------------------------------------------------------------------
 * - espn_s2 is a SESSION COOKIE for the whole ESPN account. Keep it in
 *   local/ (gitignored), never in config/ or a commit.
 * - It expires if you sign out of ESPN everywhere. Signing in again on
 *   another device does not invalidate it.
 * - Running this ON the draft-room URL also mints the draft socket token
 *   (`draftSecurity`), but you do not need to: scripts/draft-watch.py mints
 *   its own from these two cookies, and re-mints on every reconnect.
 */

// ---- readable source of the one-liner ------------------------------------
(async () => {
  const s2 = (document.cookie.match(/(?:^|;\s*)espn_s2=([^;]*)/) || [])[1];
  const swidRaw = (document.cookie.match(/(?:^|;\s*)SWID=([^;]*)/) || [])[1];
  if (!s2 || !swidRaw) {
    alert('Not signed in to ESPN in this tab (or this is not an espn.com page).');
    return;
  }
  const out = {
    espn_s2: decodeURIComponent(s2),
    swid: decodeURIComponent(swidRaw),
  };
  // If this is a draft-room URL, mint the socket token too - handy for a
  // manual sanity check that the room is open. Optional; harmless if it fails.
  const league = (location.href.match(/leagueId=(\d+)/) || [])[1];
  const team = (location.href.match(/teamId=(\d+)/) || [])[1];
  if (league && team) {
    try {
      const r = await fetch(
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026` +
        `/segments/0/leagues/${league}/teams/${team}/draftSecurity`,
        { credentials: 'include', headers: { 'x-fantasy-source': 'kona' } });
      if (r.ok) out._draftToken = (await r.text()).trim();
    } catch { /* room not open yet */ }
  }
  const text = JSON.stringify(out, null, 2);
  console.log(text);
  try { copy(text); console.log('^ copied to clipboard'); } catch { /* not devtools */ }
  try { await navigator.clipboard.writeText(text); } catch { /* needs focus */ }
})();

/* ---- PASTE THIS ONE LINE INTO THE CONSOLE -------------------------------

(async()=>{const g=n=>(document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'))||[])[1];const s2=g('espn_s2'),sw=g('SWID');if(!s2||!sw){alert('Sign in to ESPN in this tab first');return}const o={espn_s2:decodeURIComponent(s2),swid:decodeURIComponent(sw)};const t=JSON.stringify(o,null,2);console.log(t);try{copy(t);console.log('copied to clipboard')}catch(e){}try{await navigator.clipboard.writeText(t)}catch(e){}})()

-------------------------------------------------------------------------- */
