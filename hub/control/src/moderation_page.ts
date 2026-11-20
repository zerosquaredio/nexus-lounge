//  Muting and reporting from the hub's pages (hub plan H18): a small panel
//  for one person, opened from the map or the chat. Muting hides them from
//  you alone; a report goes to the hub's admin with what was said in the
//  room in the last few minutes. Names only ever reach the page as text.

export const WhoScriptPath = '/space/who.js';

export function whoPanel(reportMinutes: number): string {
    return `<style>
.who-panel { border: 1px solid var(--line); border-radius: 4px; padding: .5rem .75rem; margin: .75rem 0; }
.who-panel p { margin: .3rem 0; }
.who-panel textarea { width: 100%; box-sizing: border-box; }
button.who { background: none; border: 0; padding: 0; margin: 0; color: inherit; font: inherit; cursor: pointer;
  text-decoration: underline dotted; }
</style>
<div id="who-panel" class="who-panel" role="dialog" aria-labelledby="who-name" hidden>
<p><strong id="who-name"></strong> <button type="button" id="who-mute">Mute</button>
<button type="button" id="who-close">Close</button></p>
<form id="who-report"><label for="who-note">Report them to this hub's admin:</label>
<textarea id="who-note" maxlength="1000" rows="3" required></textarea>
<button>Send report</button></form>
<p id="who-said" role="status"></p>
<p class="hint">Muting hides them from you only, here and in BBS doors; they aren't told. Unmute them
from your profile. A report goes to this hub's admin, with what was said in the chat room in the last
${reportMinutes} minutes.</p>
</div>
<script src="${WhoScriptPath}" defer></script>`;
}

export const WhoScript = String.raw`(function () {
    'use strict';
    var byId = function (id) { return document.getElementById(id); };
    var panel = byId('who-panel'), name = byId('who-name'), muteButton = byId('who-mute');
    var form = byId('who-report'), note = byId('who-note'), said = byId('who-said');
    var current = null, listeners = [];
    if (!panel) { return; }

    function post(path, fields) {
        return fetch(path, { method: 'POST', credentials: 'same-origin', body: new URLSearchParams(fields) })
            .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (body) { return { ok: r.ok, body: body }; });
            });
    }
    function show(person, label) {
        current = { person: person, label: label };
        name.textContent = label;
        said.textContent = '';
        note.value = '';
        muteButton.disabled = false;
        panel.hidden = false;
        muteButton.focus();
    }
    muteButton.addEventListener('click', function () {
        if (!current) { return; }
        var who = current;
        muteButton.disabled = true;
        post('/space/mute', { person: who.person, mute: 'on' }).then(function (r) {
            said.textContent = r.ok ? 'Muted: they are hidden from you.' : (r.body.error || 'That did not work.');
            if (r.ok) { listeners.forEach(function (fn) { fn(who.person); }); }
            else { muteButton.disabled = false; }
        }).catch(function () { said.textContent = 'That did not work.'; muteButton.disabled = false; });
    });
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!current) { return; }
        post('/space/report', { person: current.person, note: note.value }).then(function (r) {
            said.textContent = r.ok ? "Sent to this hub's admin. Thank you." : (r.body.error || 'That did not work.');
            if (r.ok) { note.value = ''; }
        }).catch(function () { said.textContent = 'That did not work.'; });
    });
    byId('who-close').addEventListener('click', function () { panel.hidden = true; current = null; });
    window.hubWho = { show: show, onMute: function (fn) { listeners.push(fn); } };
})();
`;
