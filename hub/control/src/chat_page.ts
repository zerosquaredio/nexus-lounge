//  The chat page (hub plan H15): a small IRC client for the one room.
//
//  People are shown by the DID freeq attaches to each message, turned into a
//  name by the hub, never by the nick, which a client picks for itself. Text
//  from others only ever reaches the page as text.

import { Cp437 } from './ansi.ts';
import { AnsiColours, VgaFontPath } from './art_html.ts';
import { esc } from './html.ts';

export { VgaFontPath };

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
.chat-log figure { margin: .2rem 0 .5rem; }
.chat-log figure img { display: block; max-width: 100%; max-height: 14rem; width: auto; height: auto; image-rendering: pixelated; border: 1px solid var(--line); background: #000; }
.chat-log figcaption { color: var(--dim); font-size: .8rem; }
.art-pick { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; max-height: 16rem; overflow-y: auto; }
.art-pick[hidden] { display: none; }
.art-pick button { margin: 0; padding: .2rem; border-color: var(--line); }
.art-pick img { display: block; width: 8rem; height: auto; image-rendering: pixelated; }
.chat-view label { display: inline; margin: 0; }
.chat-view select { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; }
.chat-log pre { margin: 0; overflow-x: auto; max-width: 100%; }
@font-face { font-family: "Hub VGA"; src: url("${VgaFontPath}") format("woff"); font-display: swap; }
.chat-log pre.ansi { display: inline-block; padding: 2px; background: #000; color: #aaa; border: 1px solid var(--line);
  font: 8px/1 "Hub VGA", ui-monospace, Consolas, monospace; }
.chat-log pre.text { font: 8px/1.15 ui-monospace, Consolas, monospace; }
.chat-log details summary { cursor: pointer; color: var(--accent); font-size: .85rem; }
${AnsiColours}
</style>
<p class="dim"><span id="chat-room">${esc(room)}</span> · <span id="chat-status" role="status">${
        wait ? 'Not in the room' : 'Connecting…'
    }</span><span id="chat-view-wrap" class="chat-view" hidden> · <label>Art as <select id="chat-view">
<option value="pictures">pictures</option><option value="ansi">ANSI</option><option value="text">text</option>
</select></label></span></p>
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
<button type="button" id="chat-art" aria-expanded="false" aria-controls="chat-art-pick" hidden>Art</button>
</form>
<div id="chat-art-pick" class="art-pick" role="group" aria-label="Share a piece of art" hidden></div>
<p id="chat-art-credit" class="hint" hidden>Art as ANSI is drawn in the IBM VGA font from VileR's
<a href="https://int10h.org/oldschool-pc-fonts/" rel="noopener">Ultimate Oldschool PC Font Pack</a> (CC BY-SA 4.0).
<a href="/art">All the art</a></p>
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
        //  a piece from the hub's art, named by its id: drawn, never fetched
        //  from anywhere else; anything else stays text
        var shared = /^\[art:([0-9a-f]{12})\]/.exec(text), piece = shared && artById[shared[1]];
        if (piece) {
            p.appendChild(document.createTextNode('shares ' + piece.name));
            addLine(p);
            addLine(artFigure(piece));
            return;
        }
        p.appendChild(document.createTextNode(clean(action ? '* ' + action[1] : text)));
        addLine(p);
    }

    //  The hub's art (/art.json), if it offers any
    var artById = {}, artItems = [], artButton = byId('chat-art'), artPick = byId('chat-art-pick');

    //  How each person sees it, their own choice, remembered in this browser:
    //  pictures, ANSI drawn as characters, or text. Each is made from one of
    //  the versions the baker makes; nobody else is affected.
    //  the page's view (views.ts) says how art is drawn unless they chose
    //  otherwise, which is remembered for each view
    var page = document.documentElement.dataset;
    var CP437 = __CP437__, ViewKey = 'hub.chat.artView.' + (page.view || 'hub');
    var view = /^(pictures|ansi|text)$/.test(page.art || '') ? page.art : 'pictures';
    var viewSelect = byId('chat-view'), viewWrap = byId('chat-view-wrap'), fetched = {};
    try {
        var saved = localStorage.getItem(ViewKey);
        if (/^(pictures|ansi|text)$/.test(saved || '')) { view = saved; }
    } catch (e) {}
    viewSelect.value = view;
    viewSelect.addEventListener('change', function () {
        view = viewSelect.value;
        try { localStorage.setItem(ViewKey, view); } catch (e) {}
        log.querySelectorAll('figure[data-art]').forEach(function (fig) {
            if (artById[fig.dataset.art]) { fillArt(fig, artById[fig.dataset.art]); }
        });
    });
    function fetchOnce(url, as) {
        if (!fetched[url]) {
            fetched[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
                if (!r.ok) { throw new Error(String(r.status)); }
                return 'text' === as ? r.text() : r.arrayBuffer();
            });
        }
        return fetched[url];
    }
    //  The hub's cleaned ANSI holds nothing but characters, colours (SGR) and
    //  line ends (ansi.ts), so this is all it takes to draw it
    function drawAnsi(bytes, label) {
        var pre = document.createElement('pre');
        pre.className = 'ansi';
        pre.setAttribute('role', 'img');
        pre.setAttribute('aria-label', label);
        var fg = 7, bg = 0, bold = false, blink = false, run = '';
        function flush() {
            if (!run) { return; }
            var span = document.createElement('span');
            span.className = 'f' + (fg + (bold ? 8 : 0)) + ' b' + (bg + (blink ? 8 : 0));
            span.textContent = run;
            pre.appendChild(span);
            run = '';
        }
        for (var i = 0; i < bytes.length; i++) {
            var c = bytes[i];
            if (0x1a === c) { break; }
            if (0x1b === c && 0x5b === bytes[i + 1]) {
                var j = i + 2;
                while (j < bytes.length && bytes[j] < 0x40) { j++; }
                if (0x6d === bytes[j]) {
                    flush();
                    String.fromCharCode.apply(null, bytes.subarray(i + 2, j)).split(';').forEach(function (v) {
                        var p = Number(v || 0);
                        if (0 === p) { fg = 7; bg = 0; bold = blink = false; }
                        else if (1 === p) { bold = true; }
                        else if (5 === p) { blink = true; }
                        else if (p >= 30 && p <= 37) { fg = p - 30; }
                        else if (p >= 40 && p <= 47) { bg = p - 40; }
                    });
                }
                i = j;
            } else if (0x0a === c) {
                flush();
                pre.appendChild(document.createTextNode('\n'));
            } else if (0x0d !== c) {
                run += c ? CP437[c] : ' ';
            }
        }
        flush();
        return pre;
    }
    function fillArt(fig, piece) {
        fig.textContent = '';
        if ('ansi' === view) {
            var wait = document.createElement('p');
            wait.className = 'system';
            wait.textContent = 'Drawing ' + piece.name + '…';
            fig.appendChild(wait);
            fetchOnce(piece.ansi, 'bytes').then(function (buf) {
                if ('ansi' === view && wait.parentNode === fig) {
                    fig.replaceChild(drawAnsi(new Uint8Array(buf), piece.short), wait);
                }
            }, function () { wait.textContent = "Couldn't load " + piece.name + '.'; });
        } else if ('text' === view) {
            var more = document.createElement('details');
            var summary = document.createElement('summary');
            summary.textContent = 'Show it as text';
            more.appendChild(summary);
            more.addEventListener('toggle', function () {
                if (!more.open || more.querySelector('pre') || !piece.text) { return; }
                fetchOnce(piece.text, 'text').then(function (t) {
                    var pre = document.createElement('pre');
                    pre.className = 'text';
                    pre.textContent = t;
                    more.appendChild(pre);
                }, function () {});
            });
            fig.appendChild(more);
        } else {
            var link = document.createElement('a');
            link.href = piece.image.url;
            link.target = '_blank';
            link.rel = 'noopener';
            var img = document.createElement('img');
            img.src = piece.thumb.url;
            img.width = piece.thumb.width;
            img.height = piece.thumb.height;
            img.alt = piece.short;
            link.appendChild(img);
            fig.appendChild(link);
        }
        var cap = document.createElement('figcaption');
        cap.textContent = 'text' === view ? piece.short : piece.name + ' · by ' + piece.credit;
        fig.appendChild(cap);
    }
    function artFigure(piece) {
        var fig = document.createElement('figure');
        fig.dataset.art = piece.id.slice(0, 12);
        fillArt(fig, piece);
        return fig;
    }
    function shareArt(piece) {
        if (!ws || input.disabled) { return; }
        raw('PRIVMSG ' + ticket.room + ' :[art:' + piece.id.slice(0, 12) + '] ' + piece.name);
        artPick.hidden = true;
        artButton.setAttribute('aria-expanded', 'false');
        input.focus();
    }
    function findArt(name) {
        name = name.toLowerCase();
        return artItems.filter(function (a) { return a.name.toLowerCase() === name; })[0]
            || artItems.filter(function (a) { return 0 === a.name.toLowerCase().indexOf(name); })[0];
    }
    fetch('/art.json', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (lib) {
            if (!lib || !lib.items || !lib.items.length) { return; }
            artItems = lib.items;
            artItems.forEach(function (a) {
                artById[a.id.slice(0, 12)] = a;
                var b = document.createElement('button');
                b.type = 'button';
                b.title = a.name + ', by ' + a.credit;
                var img = document.createElement('img');
                img.src = a.thumb.url;
                img.alt = a.short;
                b.appendChild(img);
                b.addEventListener('click', function () { shareArt(a); });
                artPick.appendChild(b);
            });
            artButton.hidden = false;
            viewWrap.hidden = false;
            byId('chat-art-credit').hidden = false;
        })
        .catch(function () {});
    artButton.addEventListener('click', function () {
        artPick.hidden = !artPick.hidden;
        artButton.setAttribute('aria-expanded', String(!artPick.hidden));
    });

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
        //  /art NAME shares a piece; /art alone lists them
        var command = /^\/art(?:\s+(.+))?$/i.exec(text);
        if (command) {
            input.value = '';
            if (!artItems.length) { return system('This hub offers no art.'); }
            if (!command[1]) {
                return system('Art: ' + artItems.map(function (a) { return a.name; }).join(', '));
            }
            var piece = findArt(command[1].trim());
            return piece ? shareArt(piece) : system('No art called ' + command[1].trim() + '.');
        }
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
`.replace('__CP437__', JSON.stringify(Cp437.join('')));
