//  The common space on one page: the map (map_page.ts) beside the chat
//  (chat_page.ts), with one panel for muting and reporting. Either can be
//  popped out into a window of its own, where it is its own page
//  (/space/map, /space/chat), and comes back when that window closes.
//
//  The chat waits for "Join": everyone in the room sees who is there, so
//  opening the map doesn't put anyone in it.

import { ChatHint, ChatScriptPath } from './chat_page.ts';
import { MapHint, MapScriptPath } from './map_page.ts';

export const SpaceScriptPath = '/space/space.js';
export const MapPagePath = '/space/map';

function pane(name: string, title: string, href: string, body: string): string {
    return `<section class="pane" id="pane-${name}" data-pane="${name}" aria-labelledby="pane-${name}-title">
<div class="pane-head"><h2 id="pane-${name}-title">${title}</h2>
<a class="pop" href="${href}" target="hub-${name}" data-pop="${name}">Pop out</a></div>
<div class="pane-body">
${body}
</div>
<p class="pane-away dim" hidden>The ${title.toLowerCase()} is in its own window.
<button type="button" data-back="${name}">Bring it back</button></p>
</section>`;
}

//  mapHtml and chatHtml: the two panes; panel: muting and reporting
export function spacePageBody(mapHtml: string, chatHtml: string, panel = ''): string {
    return `<style>
main { max-width: 80rem; }
.space { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1.5rem; align-items: start; }
.pane-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
.pane-head h2 { margin: 0 0 .3rem; }
.pane-away button { margin: 0 0 0 .5rem; padding: .2rem .8rem; }
@media (max-width: 60rem) { .space { grid-template-columns: 1fr; } }
</style>
<div class="space">
${pane('map', 'Map', MapPagePath, mapHtml)}
${pane('chat', 'Chat', '/space/chat', chatHtml)}
</div>
${panel}
${MapHint}
${ChatHint}
<p><a href="/me">Your profile</a> · <a href="/">The directory</a></p>
<script src="${MapScriptPath}" defer></script>
<script src="${ChatScriptPath}" defer></script>
<script src="${SpaceScriptPath}" defer></script>`;
}

export const SpaceScript = String.raw`(function () {
    'use strict';
    var panes = window.hubPanes || {};
    //  the windows popped out: name -> window
    var away = {};
    var sizes = { map: 'width=900,height=760', chat: 'width=760,height=640' };

    function section(name) { return document.getElementById('pane-' + name); }
    function show(name, here) {
        var s = section(name);
        s.querySelector('.pane-body').hidden = !here;
        s.querySelector('.pane-away').hidden = here;
        s.querySelector('.pop').hidden = !here;
    }
    function popOut(name, href) {
        var win = window.open(href, 'hub-' + name, 'popup,' + sizes[name]);
        if (!win) { return false; }
        away[name] = win;
        if (panes[name]) { panes[name].stop(); }
        show(name, false);
        return true;
    }
    function bringBack(name) {
        var win = away[name];
        delete away[name];
        if (win && !win.closed) { win.close(); }
        show(name, true);
        if (panes[name]) { panes[name].start(); }
    }
    document.querySelectorAll('a[data-pop]').forEach(function (a) {
        a.addEventListener('click', function (e) {
            //  if the browser won't open a window, the link opens a tab
            if (popOut(a.dataset.pop, a.href)) { e.preventDefault(); }
        });
    });
    document.querySelectorAll('button[data-back]').forEach(function (b) {
        b.addEventListener('click', function () { bringBack(b.dataset.back); });
    });
    //  closing the window brings it back
    setInterval(function () {
        Object.keys(away).forEach(function (name) {
            if (away[name].closed) { bringBack(name); }
        });
    }, 1000);
    //  "Join" by the room on the map: the chat beside it, or its window
    window.hubSpace = {
        joinChat: function () {
            if (away.chat && !away.chat.closed) { away.chat.focus(); return true; }
            if (!panes.chat) { return false; }
            panes.chat.start();
            section('chat').scrollIntoView({ block: 'nearest' });
            panes.chat.focus();
            return true;
        },
    };
})();
`;
