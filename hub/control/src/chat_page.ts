//  The chat page (hub plan H15): a small IRC client for the one room.
//
//  People are shown by the DID freeq attaches to each message, turned into a
//  name by the hub, never by the nick, which a client picks for itself. Text
//  from others only ever reaches the page as text.

import { esc } from './html.ts';

export const ChatScriptPath = '/space/chat.js';
export const MaxLabelLookups = 50;
//  an IRC line has room for about this much text
export const MaxChatMessage = 400;

//  The chat itself, for its own page or beside the map (space_page.ts).
//  wait: join only when asked, not as soon as the page opens
export function chatPane(room: string, wait = false): string {
    return `<style>
.chat { display: grid; grid-template-columns: 1fr 11rem; gap: 1rem; }
.chat-log { height: 26rem; overflow-y: auto; border: 1px solid var(--line); border-radius: 4px; padding: .5rem; overflow-wrap: anywhere; }
.chat-log p { margin: 0 0 .25rem; }
.chat-log time { color: var(--dim); font-size: .8rem; margin-right: .4rem; }
.chat-log strong { color: var(--accent); margin-right: .4rem; }
.chat-log .system { color: var(--dim); font-style: italic; }
.chat-log strong[data-did] { cursor: pointer; }
.chat-people { margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; font-size: .9rem; }
.chat-say { display: flex; gap: .5rem; margin-top: .5rem; }
.chat-say button { margin-top: 0; }
@media (max-width: 40rem) { .chat { grid-template-columns: 1fr; } .chat-log { height: 20rem; } }
.chat-join button { margin-top: 0; }
</style>
<p class="dim"><span id="chat-room">${esc(room)}</span> · <span id="chat-status" role="status">${
        wait ? 'Not in the room' : 'Connecting…'
    }</span></p>
<noscript><p class="error">Chat needs JavaScript.</p></noscript>
${
    wait
        ? `<p id="chat-join" class="chat-join"><button type="button" id="chat-join-button">Join the chat</button>
<span class="hint">Everyone in the room sees who is there.</span></p>`
        : ''
}
<div class="chat" id="chat-pane"${wait ? ' data-wait="1"' : ''}>
<div>
<div id="chat-log" class="chat-log" role="log" aria-label="Messages" tabindex="0"></div>
<form id="chat-say" class="chat-say">
<input type="text" id="chat-text" aria-label="Message" maxlength="${MaxChatMessage}" autocomplete="off" disabled>
<button id="chat-send" disabled>Send</button>
</form>
</div>
<aside aria-label="In the room"><h2>Here now</h2><ul id="chat-people" class="chat-people"></ul></aside>
</div>`;
}

export const ChatHint = `<p class="hint">Messages aren't kept: the room holds only the last few, in memory. Everyone here can see that
you are in the room, whether or not you are shown as around.</p>`;

//  The chat on its own page. panel: muting and reporting someone
//  (moderation_page.ts)
export function chatPageBody(room: string, panel = ''): string {
    return `${chatPane(room)}
${panel}
${ChatHint}
<p><a href="/space">Who's around</a> · <a href="/me">Your profile</a> · <a href="/">The directory</a></p>
<script src="${ChatScriptPath}" defer></script>`;
}

export const ChatScript = String.raw`(function () {
    'use strict';
    var byId = function (id) { return document.getElementById(id); };
    var log = byId('chat-log'), status = byId('chat-status'), people = byId('chat-people');
    var form = byId('chat-say'), input = byId('chat-text'), send = byId('chat-send'), roomName = byId('chat-room');
    var labels = {}, waiting = {}, seen = {}, muted = {}, ticket = null, ws = null, retries = 0, stopped = false;
    var lookupTimer = null, peopleTimer = null, retryTimer = null, MaxLines = 500;
    var pane = byId('chat-pane'), join = byId('chat-join'), joinButton = byId('chat-join-button');
    //  each time the chat is started; what an older start is still doing is dropped
    var run = 0, running = false, ended = false;

    function setStatus(text) { status.textContent = text; }
    function setOpen(open) {
        input.disabled = !open;
        send.disabled = !open;
        if (open) { input.focus(); }
    }
    function clean(text) {
        return text
            .replace(/\x03\d{0,2}(,\d{1,2})?/g, '')
            .replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, '');
    }
    function shortDid(did) { return did.length > 22 ? did.slice(0, 20) + '…' : did; }
    function nameOf(did) { return labels[did] || shortDid(did); }

    function addLine(node) {
        var atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        log.appendChild(node);
        while (log.childNodes.length > MaxLines) { log.removeChild(log.firstChild); }
        if (atEnd) { log.scrollTop = log.scrollHeight; }
    }
    function system(text) {
        var p = document.createElement('p');
        p.className = 'system';
        p.textContent = text;
        addLine(p);
    }
    function message(tags, nick, text) {
        if (tags.msgid) {
            if (seen[tags.msgid]) { return; }
            seen[tags.msgid] = true;
        }
        var action = /^\x01ACTION (.*?)\x01?$/.exec(text);
        if (!action && 1 === text.charCodeAt(0)) { return; }
        var did = tags.account || '';
        //  someone you muted: not shown
        if (did && muted[did]) { return; }
        var p = document.createElement('p');
        var when = tags.time ? new Date(tags.time) : new Date();
        var time = document.createElement('time');
        if (!isNaN(when)) {
            time.dateTime = when.toISOString();
            time.textContent = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        var who = document.createElement('strong');
        if (did) {
            who.dataset.did = did;
            who.textContent = nameOf(did);
            lookUp(did);
        } else {
            who.textContent = clean(nick) + ' (unverified)';
        }
        p.appendChild(time);
        p.appendChild(who);
        p.appendChild(document.createTextNode(clean(action ? '* ' + action[1] : text)));
        addLine(p);
    }

    function lookUp(did) {
        if (labels[did] || waiting[did]) { return; }
        waiting[did] = true;
        if (!lookupTimer) { lookupTimer = setTimeout(refreshPeople, 150); }
    }
    function refreshPeople() {
        lookupTimer = null;
        var query = Object.keys(waiting).slice(0, 50).map(function (d) {
            return 'did=' + encodeURIComponent(d);
        }).join('&');
        fetch('/space/chat/people' + (query ? '?' + query : ''), { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data) { return; }
                Object.keys(waiting).forEach(function (d) { if (d in data.labels) { delete waiting[d]; } });
                Object.keys(data.labels).forEach(function (d) { labels[d] = data.labels[d]; });
                data.here.forEach(function (p) { labels[p.did] = p.label; });
                (data.muted || []).forEach(hide);
                log.querySelectorAll('strong[data-did]').forEach(function (n) {
                    n.textContent = nameOf(n.dataset.did);
                });
                people.textContent = '';
                data.here.forEach(function (p) {
                    var li = document.createElement('li');
                    if (ticket && p.did !== ticket.did && window.hubWho) {
                        var b = document.createElement('button');
                        b.type = 'button';
                        b.className = 'who';
                        b.title = 'Mute or report';
                        b.textContent = p.label;
                        b.addEventListener('click', function () { window.hubWho.show('person:' + p.did, p.label); });
                        li.appendChild(b);
                    } else {
                        li.textContent = p.label;
                    }
                    people.appendChild(li);
                });
            })
            .catch(function () {});
    }
    //  someone muted: their lines go, and so do any later ones
    function hide(did) {
        muted[did] = true;
        log.querySelectorAll('strong[data-did]').forEach(function (n) {
            if (n.dataset.did === did && n.parentNode) { n.parentNode.remove(); }
        });
    }
    log.addEventListener('click', function (e) {
        var n = e.target.closest ? e.target.closest('strong[data-did]') : null;
        if (n && ticket && n.dataset.did !== ticket.did && window.hubWho) {
            window.hubWho.show('person:' + n.dataset.did, nameOf(n.dataset.did));
        }
    });
    if (window.hubWho) {
        window.hubWho.onMute(function (person) {
            if (0 === person.indexOf('person:did:')) { hide(person.slice(7)); }
            refreshPeople();
        });
    }
    function soon() {
        clearTimeout(peopleTimer);
        peopleTimer = setTimeout(refreshPeople, 400);
    }

    function parse(line) {
        var out = { tags: {}, nick: '', command: '', params: [] }, rest = line, at;
        if ('@' === rest[0]) {
            at = rest.indexOf(' ');
            rest.slice(1, at).split(';').forEach(function (pair) {
                var eq = pair.indexOf('=');
                if (eq > 0) {
                    out.tags[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/\\(.)/g, function (_, c) {
                        return { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' }[c] || c;
                    });
                }
            });
            rest = rest.slice(at + 1);
        }
        if (':' === rest[0]) {
            at = rest.indexOf(' ');
            out.nick = rest.slice(1, at).split('!')[0];
            rest = rest.slice(at + 1);
        }
        at = ':' === rest[0] ? 0 : rest.indexOf(' :');
        var words = (at < 0 ? rest : rest.slice(0, at)).split(' ').filter(Boolean);
        if (at >= 0) { words.push(rest.slice(at + (0 === at ? 1 : 2))); }
        out.command = (words.shift() || '').toUpperCase();
        out.params = words;
        return out;
    }
    function raw(line) { if (ws && 1 === ws.readyState) { ws.send(line + '\r\n'); } }
    function sameRoom(name) { return (name || '').toLowerCase() === ticket.room.toLowerCase(); }
    function isMe(nick) { return (nick || '').toLowerCase() === ticket.nick.toLowerCase(); }

    function onLine(line) {
        var m = parse(line), p = m.params, last = p[p.length - 1] || '';
        switch (m.command) {
            case 'PING': return raw('PONG :' + last);
            case 'CAP':
                if ('ACK' === (p[1] || '').toUpperCase()) { raw('AUTHENTICATE ATPROTO-CHALLENGE'); }
                return;
            case 'AUTHENTICATE':
                return raw('AUTHENTICATE ' + btoa(JSON.stringify({
                    did: ticket.did, method: 'web-token', signature: ticket.token
                })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
            case '903': return raw('CAP END');
            case '904': case '905': case '906': return setStatus('Could not sign in to chat.');
            case '001': ticket.nick = p[0] || ticket.nick; return raw('JOIN ' + ticket.room);
            case '433': return raw('NICK ' + ticket.nick + '_');
            case 'JOIN':
                if (sameRoom(p[0]) && isMe(m.nick)) {
                    retries = 0;
                    setStatus('Connected');
                    setOpen(true);
                }
                return soon();
            case 'PART': case 'QUIT': case 'KICK': case 'NICK': return soon();
            case 'PRIVMSG':
                if (sameRoom(p[0])) { message(m.tags, m.nick, last); }
                return;
            case 'NOTICE':
                if (isMe(p[0]) && !m.nick.includes('.')) { system(clean(last)); }
                return;
        }
        //  not "not registered yet", nor "no message of the day"
        if (/^4\d\d$/.test(m.command) && '451' !== m.command && '422' !== m.command) { system(clean(last)); }
    }

    function retry() {
        if (stopped) { return; }
        var delay = Math.min(30, Math.pow(2, retries++));
        setStatus('Reconnecting…');
        retryTimer = setTimeout(connect, delay * 1000);
    }
    function stop(text) {
        stopped = true;
        ended = true;
        setOpen(false);
        setStatus(text);
    }
    function connect() {
        retryTimer = null;
        var mine = run;
        fetch('/space/chat/token', { method: 'POST', credentials: 'same-origin' })
            .then(function (r) {
                if (mine !== run) { return; }
                if (401 === r.status) { return stop('Sign in to chat.'); }
                if (403 === r.status) {
                    return r.json().catch(function () { return {}; }).then(function (body) {
                        stop(body.error || 'You are not able to join this room right now.');
                    });
                }
                if (!r.ok) { return retry(); }
                return r.json().then(function (t) { if (mine === run) { open(t); } });
            })
            .catch(function () { if (mine === run) { retry(); } });
    }
    function open(t) {
        ticket = t;
        roomName.textContent = t.room;
        labels[t.did] = t.label;
        ws = new WebSocket(location.origin.replace(/^http/, 'ws') + t.path);
        ws.onopen = function () {
            raw('CAP LS 302');
            raw('NICK ' + t.nick);
            raw('USER chat 0 * :chat');
            raw('CAP REQ :sasl message-tags server-time echo-message account-tag');
        };
        ws.onmessage = function (e) { String(e.data).split(/\r?\n/).filter(Boolean).forEach(onLine); };
        ws.onclose = function () {
            ws = null;
            setOpen(false);
            people.textContent = '';
            retry();
        };
    }
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = clean(input.value).trim();
        if (!text || !ws) { return; }
        if (new TextEncoder().encode(text).length > 400) { return system('That message is too long.'); }
        raw('PRIVMSG ' + ticket.room + ' :' + text);
        input.value = '';
    });
    //  the room isn't always told at once when someone is cut off
    setInterval(function () { if (ws) { refreshPeople(); } }, 10000);

    //  Joining and leaving, for the page beside the map, which can also pop
    //  the chat out into its own window and back (space_page.ts)
    function start() {
        if (running || ended) { return; }
        running = true;
        stopped = false;
        retries = 0;
        run++;
        if (join) { join.hidden = true; }
        setStatus('Connecting…');
        connect();
    }
    function leave() {
        if (!running) { return; }
        running = false;
        stopped = true;
        run++;
        clearTimeout(retryTimer);
        retryTimer = null;
        if (ws) {
            var old = ws;
            ws = null;
            old.onclose = null;
            old.close();
        }
        setOpen(false);
        people.textContent = '';
        if (!ended) { setStatus('Not in the room'); }
    }
    if (joinButton) { joinButton.addEventListener('click', start); }
    window.hubPanes = window.hubPanes || {};
    window.hubPanes.chat = {
        start: start,
        stop: function () {
            leave();
            if (join && !ended) { join.hidden = false; }
        },
        focus: function () { if (!input.disabled) { input.focus(); } },
    };
    if (!pane || !pane.dataset.wait) { start(); }
})();
`;
