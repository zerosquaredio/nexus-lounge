//  The map of the common space (hub plan H17): the hub's BBSes around the
//  chat room, and who is at each, drawn from the live model (live.ts).
//
//  Opening a board from here tells the hub which one, for as long as its
//  window and this page stay open: that is how someone who uses a board in
//  the browser appears there (H14's first source). Names only ever reach
//  the page as text.

export const MapScriptPath = '/space/map.js';

//  The map itself, for its own page or beside the chat (space_page.ts).
//  listHtml: who is around, from the server, for when the script can't run
export function mapPane(listHtml: string): string {
    return `<style>
.map { width: 100%; height: auto; display: block; border: 1px solid var(--line); border-radius: 4px; }
.map text { fill: var(--fg); font: 13px ui-monospace, Consolas, monospace; }
.map .place rect, .map .place circle.hub { fill: var(--bg); stroke: var(--accent); stroke-width: 1.5; }
.map .place.off rect { stroke: var(--line); stroke-dasharray: 4 3; }
.map .place.off text { fill: var(--dim); }
.map .place.go { cursor: pointer; }
.map .place.go:hover rect, .map .place.go:focus rect { stroke-width: 3; }
.map .place:focus { outline: none; }
.map .names text { fill: var(--dim); font-size: 12px; }
.map .names text.you { fill: var(--accent); font-weight: bold; }
.map circle.dot { fill: var(--accent); }
.map circle.dot.you { stroke: var(--fg); stroke-width: 2; }
.map image.face { clip-path: circle(50%); }
.map circle.ring { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.map circle.ring.you { stroke: var(--fg); stroke-width: 2.5; }
.map line.link { stroke: var(--accent); stroke-opacity: .35; stroke-dasharray: 3 4; }
.map image.emblem { image-rendering: pixelated; }
.map .place.off image.emblem { opacity: .5; }
.map .badge rect { fill: var(--bg); stroke: var(--accent); stroke-width: 1; }
.map .badge text { font-size: 16px; }
.map .badge.stale rect { stroke: var(--line); stroke-dasharray: 2 2; }
.map .badge.stale text { fill: var(--dim); }
.map .badge:hover rect, .map .badge:focus rect { stroke-width: 2; }
.space-list .objects { margin: -.4rem 0 .6rem; }
.space-units { margin: .3rem 0; }
.space-list h3 { margin: .2rem 0; font-size: 1rem; }
.space-list h3 button { margin: 0 0 0 .5rem; padding: .1rem .6rem; font-size: .85rem; }
.space-list p { margin: .2rem 0 .6rem; }
</style>
<p class="dim"><span id="map-status" role="status">Connecting…</span></p>
<svg id="map" class="map" viewBox="0 0 800 520" role="img" aria-label="Map of the common space" hidden></svg>
<div id="space-list" class="space-list" aria-live="polite">${listHtml}</div>
<p class="space-units dim" id="space-units" hidden><label>Temperatures in <select id="units"><option value="c">°C</option><option value="f">°F</option></select></label></p>`;
}

export const MapHint = `<p class="hint">Only people who chose to be shown appear here. Open a board from this page and, with being
shown on, others see you there while its window and this page stay open.</p>`;

//  The map on its own page. panel: muting and reporting someone
//  (moderation_page.ts); chat: whether there is a chat to link to
export function mapPageBody(listHtml: string, chat: boolean, panel = ''): string {
    return `${mapPane(listHtml)}
${panel}
${MapHint}
<p>${chat ? '<a href="/space">The whole space</a> · <a href="/space/chat">Chat</a> · ' : ''}<a href="/me">Your profile</a> · <a href="/">The directory</a></p>
<script src="${MapScriptPath}" defer></script>`;
}

export const MapScript = String.raw`(function () {
    'use strict';
    var NS = 'http://www.w3.org/2000/svg';
    var W = 800, H = 520, MaxNames = 3;
    var byId = function (id) { return document.getElementById(id); };
    var svg = byId('map'), list = byId('space-list'), status = byId('map-status');
    var state = null, you = null, base = null, ws = null, retries = 0, stopped = false, ended = false, retryTimer = null;
    //  boards opened from this page: { name, win }, the latest last
    var opened = [];

    function setStatus(text) { status.textContent = text; }
    function el(name, attrs, text) {
        var e = document.createElementNS(NS, name);
        for (var k in attrs) { e.setAttribute(k, String(attrs[k])); }
        if (text !== undefined) { e.textContent = text; }
        return e;
    }
    function html(name, text, cls) {
        var e = document.createElement(name);
        if (text !== undefined) { e.textContent = text; }
        if (cls) { e.className = cls; }
        return e;
    }
    function clip(text, n) { return text.length > n ? text.slice(0, n - 1) + '…' : text; }

    //  Live objects' values, as words and a symbol: the weather type's WMO
    //  codes, by the lowest code of each kind
    var Skies = [
        [0, 'clear', '☀', '☾'], [1, 'mainly clear', '\u{1F324}', '☾'], [2, 'partly cloudy', '⛅', '☁'],
        [3, 'overcast', '☁', '☁'], [45, 'fog', '\u{1F32B}', '\u{1F32B}'], [51, 'drizzle', '\u{1F326}', '\u{1F327}'],
        [61, 'rain', '\u{1F327}', '\u{1F327}'], [71, 'snow', '❄', '❄'], [80, 'showers', '\u{1F326}', '\u{1F327}'],
        [85, 'snow showers', '\u{1F328}', '\u{1F328}'], [95, 'thunderstorm', '⛈', '⛈']
    ];
    function sky(v) {
        if ('number' !== typeof v.code) { return null; }
        var found = null;
        Skies.forEach(function (s) { if (v.code >= s[0]) { found = s; } });
        return found && { words: found[1], symbol: false === v.isDay ? found[3] : found[2] };
    }
    var units = 'c';
    try { units = 'f' === localStorage.getItem('hub-units') ? 'f' : 'c'; } catch (e) { /* none kept */ }
    function temperature(v, rounded) {
        if ('number' !== typeof v.temperature) { return ''; }
        var t = 'f' === units ? v.temperature * 9 / 5 + 32 : v.temperature;
        return (rounded ? Math.round(t) : Math.round(t * 10) / 10) + ('f' === units ? '°F' : '°C');
    }
    //  An object's values as a sentence, for its badge's title and the list
    function describe(o) {
        var v = o.values || {}, parts = [];
        if ('weather' === o.kind) {
            var s = sky(v);
            if (s) { parts.push(s.words); }
            if (temperature(v)) { parts.push(temperature(v)); }
        }
        var text = o.title + (parts.length ? ': ' + parts.join(', ') : ': no reading yet');
        if (o.stale && o.updatedAt) { text += ' (not updated since ' + new Date(o.updatedAt).toLocaleString() + ')'; }
        var credit = (o.look && o.look.credit || []).map(function (c) { return c.text; }).join('; ');
        return credit ? text + '. ' + credit : text;
    }
    function badgeText(o) {
        var v = o.values || {};
        if ('weather' !== o.kind) { return clip(o.title, 8); }
        var s = sky(v);
        return ((s ? s.symbol + ' ' : '') + temperature(v, true)) || '…';
    }
    //  an object's page, only one on this hub
    function pageOf(o) { return /^\/objects\/[a-z0-9-]+\/[A-Za-z0-9._:~%-]+$/.test(o.page) ? o.page : null; }

    //  What this page has open, told to the hub
    function tell() {
        if (!ws || 1 !== ws.readyState || !base) { return; }
        var last = opened.length ? opened[opened.length - 1] : null;
        ws.send(JSON.stringify({ $type: base + '.at', place: last ? 'leaf:' + last.name : null }));
    }
    function openBoard(leaf) {
        for (var i = 0; i < opened.length; i++) {
            if (opened[i].name === leaf.name && !opened[i].win.closed) { opened[i].win.focus(); return; }
        }
        var win = window.open(leaf.terminal, 'bbs-' + leaf.name);
        if (!win) { setStatus('Your browser stopped the board opening in a new window.'); return; }
        opened = opened.filter(function (o) { return o.name !== leaf.name; });
        opened.push({ name: leaf.name, win: win });
        tell();
    }
    setInterval(function () {
        var before = opened.length;
        opened = opened.filter(function (o) { return !o.win.closed; });
        if (opened.length !== before) { tell(); }
    }, 2000);

    function apply(message) {
        var kinds = ['entities', 'presence', 'groups', 'links'];
        if (/\.snapshot$/.test(message.$type)) {
            base = message.$type.replace(/\.snapshot$/, '');
            you = message.you;
            state = {};
            kinds.forEach(function (k) {
                state[k] = new Map();
                (message[k] || []).forEach(function (x) { state[k].set(x.id, x); });
            });
            tell();
        } else if (state && /\.change$/.test(message.$type)) {
            kinds.forEach(function (k) {
                ((message.put || {})[k] || []).forEach(function (x) { state[k].set(x.id, x); });
                ((message.remove || {})[k] || []).forEach(function (id) { state[k].delete(id); });
            });
        } else {
            return;
        }
        draw();
    }

    function places() {
        var rooms = [], leaves = [];
        state.entities.forEach(function (e) {
            if ('room' === e.type) { rooms.push(e); }
            if ('leaf' === e.type) { leaves.push(e); }
        });
        byId('space-units').hidden = !objectsOf(null).length;
        leaves.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
        return { rooms: rooms, leaves: leaves };
    }
    function peopleAt(placeId) {
        var out = [];
        state.presence.forEach(function (p) {
            var person = state.entities.get(p.person);
            if (p.place === placeId && person) { out.push(person); }
        });
        out.sort(function (a, b) { return (b.id === you) - (a.id === you) || (a.label < b.label ? -1 : 1); });
        return out;
    }
    //  the live objects of a place (all of them, for null)
    function objectsOf(placeId) {
        var out = [];
        state.entities.forEach(function (e) {
            if ('object' === e.type && (null === placeId || e.owner === placeId)) { out.push(e); }
        });
        out.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        return out;
    }
    function nameOf(place) { return 'leaf' === place.type ? place.title || place.name : place.name; }
    //  a board's emblem (F21), as the hub drew it, unless the view shows art
    //  as text; only a picture the hub serves itself
    var EmblemMax = { width: 64, height: 32 };
    function emblemOf(place) {
        var e = 'leaf' === place.type && place.emblem;
        if (!e || 'text' === document.documentElement.getAttribute('data-art') ||
            !/^\/assets\/[0-9a-f]{64}$/.test(e.url) || !(e.width > 0 && e.height > 0)) { return null; }
        var s = Math.min(1, EmblemMax.width / e.width, EmblemMax.height / e.height);
        return { url: e.url, width: Math.round(e.width * s), height: Math.round(e.height * s), label: e.label };
    }
    function canOpen(place) { return 'leaf' === place.type && place.online && place.terminal; }

    function draw() {
        var p = places(), all = p.rooms.concat(p.leaves), at = {};
        while (svg.firstChild) { svg.removeChild(svg.firstChild); }
        svg.hidden = !all.length;
        //  the room in the middle, boards around it
        p.rooms.forEach(function (r, i) { at[r.id] = { x: W / 2 + i * 140, y: H / 2 }; });
        var ring = p.rooms.length ? 1 : 0;
        p.leaves.forEach(function (l, i) {
            //  an even number of boards starts beside the room, not above it
            var n = p.leaves.length, a = -Math.PI / 2 + (n % 2 ? 0 : Math.PI / n) + (2 * Math.PI * i) / Math.max(n, 1);
            var rx = ring || n > 1 ? 300 : 0, ry = ring || n > 1 ? 180 : 0;
            at[l.id] = { x: W / 2 + rx * Math.cos(a), y: H / 2 - 20 + ry * Math.sin(a) };
        });
        //  someone in two places at once: a line between them
        var where = {};
        state.presence.forEach(function (x) { (where[x.person] = where[x.person] || []).push(x.place); });
        var links = el('g');
        Object.keys(where).forEach(function (person) {
            var list = where[person].filter(function (id) { return at[id]; });
            for (var i = 1; i < list.length; i++) {
                links.appendChild(el('line', { class: 'link', x1: at[list[0]].x, y1: at[list[0]].y, x2: at[list[i]].x, y2: at[list[i]].y }));
            }
        });
        svg.appendChild(links);
        all.forEach(function (place) {
            var c = at[place.id], people = peopleAt(place.id), room = 'room' === place.type;
            var g = el('g', { class: 'place' + ('leaf' === place.type && !place.online ? ' off' : '') + (canOpen(place) ? ' go' : '') });
            var emblem = emblemOf(place), half = emblem ? 90 : 70;
            var label = clip(nameOf(place), emblem ? 13 : 16);
            var title = nameOf(place) + ('leaf' === place.type ? (place.online ? ', online' : ', offline') : ', chat') +
                ', ' + people.length + (1 === people.length ? ' person' : ' people');
            g.appendChild(el('title', {}, title));
            if (room) {
                g.appendChild(el('circle', { class: 'hub', cx: c.x, cy: c.y, r: 46 }));
            } else {
                g.appendChild(el('rect', { x: c.x - half, y: c.y - 20, width: 2 * half, height: 40, rx: 6 }));
            }
            var textX = c.x;
            if (emblem) {
                //  the emblem at the left of the box, the name in the rest
                var left = c.x - half + 6, image = el('image', {
                    class: 'emblem', href: emblem.url, x: left, y: c.y - emblem.height / 2,
                    width: emblem.width, height: emblem.height, preserveAspectRatio: 'xMidYMid meet'
                });
                image.appendChild(el('title', {}, emblem.label));
                g.appendChild(image);
                textX = (left + emblem.width + 4 + c.x + half) / 2;
            }
            g.appendChild(el('text', { x: textX, y: c.y + 5, 'text-anchor': 'middle' }, label));
            //  a dot for each person, around the place
            people.forEach(function (person, i) {
                var a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(people.length, 6);
                var rx = room ? 58 : half + 16, ry = room ? 58 : 32;
                var px = c.x + rx * Math.cos(a), py = c.y + ry * Math.sin(a);
                var mine = person.id === you ? ' you' : '';
                //  their Bluesky picture (pictures.ts), round, else a dot
                if (person.picture && /^\/pictures\/[0-9a-f]{64}$/.test(person.picture.url)) {
                    var face = el('image', { class: 'face', href: person.picture.url, x: px - 9, y: py - 9, width: 18, height: 18, preserveAspectRatio: 'xMidYMid slice' });
                    face.appendChild(el('title', {}, person.label));
                    g.appendChild(face);
                    g.appendChild(el('circle', { class: 'ring' + mine, cx: px, cy: py, r: 9 }));
                } else {
                    var dot = el('circle', { class: 'dot' + mine, cx: px, cy: py, r: 5 });
                    dot.appendChild(el('title', {}, person.label));
                    g.appendChild(dot);
                }
            });
            var names = el('g', { class: 'names' });
            people.slice(0, MaxNames).forEach(function (person, i) {
                names.appendChild(el('text', { class: person.id === you ? 'you' : '', x: c.x, y: c.y + (room ? 72 : 52) + i * 15, 'text-anchor': 'middle' }, clip(person.label, 22)));
            });
            if (people.length > MaxNames) {
                names.appendChild(el('text', { x: c.x, y: c.y + (room ? 72 : 52) + MaxNames * 15, 'text-anchor': 'middle' }, '+' + (people.length - MaxNames) + ' more'));
            }
            g.appendChild(names);
            //  its live objects: a badge each, along the top of its box
            objectsOf(place.id).slice(0, 3).forEach(function (o, i) {
                var page = pageOf(o), bw = 76, bx = c.x + half - bw - i * (bw + 4), by = c.y - 20 - 32;
                var badge = el(page ? 'a' : 'g', { class: 'badge' + (o.stale ? ' stale' : '') });
                if (page) {
                    badge.setAttribute('href', page);
                    badge.setAttribute('aria-label', describe(o));
                    badge.addEventListener('click', function (e) { e.stopPropagation(); });
                    badge.addEventListener('keydown', function (e) { e.stopPropagation(); });
                }
                badge.appendChild(el('title', {}, describe(o)));
                badge.appendChild(el('rect', { x: bx, y: by, width: bw, height: 28, rx: 14 }));
                badge.appendChild(el('text', { x: bx + bw / 2, y: by + 20, 'text-anchor': 'middle' }, badgeText(o)));
                g.appendChild(badge);
            });
            if (canOpen(place)) {
                g.setAttribute('tabindex', '0');
                g.setAttribute('role', 'button');
                g.setAttribute('aria-label', 'Open ' + nameOf(place));
                g.addEventListener('click', function () { openBoard(place); });
                g.addEventListener('keydown', function (e) {
                    if ('Enter' === e.key || ' ' === e.key) { e.preventDefault(); openBoard(place); }
                });
            }
            svg.appendChild(g);
        });
        drawList(p);
    }

    //  The same as text
    function drawList(p) {
        while (list.firstChild) { list.removeChild(list.firstChild); }
        var all = p.rooms.concat(p.leaves.filter(function (l) { return l.online; }), p.leaves.filter(function (l) { return !l.online; }));
        if (!all.length) { list.appendChild(html('p', 'No boards on this hub yet.', 'dim')); }
        all.forEach(function (place) {
            var people = peopleAt(place.id);
            var h = html('h3', nameOf(place) + ' ');
            h.appendChild(html('span', 'room' === place.type ? 'chat' : place.online ? 'online' : 'offline', 'dim'));
            if (canOpen(place)) {
                var b = html('button', 'Open');
                b.type = 'button';
                b.addEventListener('click', function () { openBoard(place); });
                h.appendChild(b);
            } else if ('room' === place.type) {
                var a = html('a', 'Join');
                a.href = '/space/chat';
                //  beside the chat, joining is done there
                a.addEventListener('click', function (e) {
                    if (window.hubSpace && window.hubSpace.joinChat()) { e.preventDefault(); }
                });
                h.appendChild(document.createTextNode(' · '));
                h.appendChild(a);
            }
            list.appendChild(h);
            var line = html('p', people.length ? '' : 'Nobody here.', people.length ? '' : 'dim');
            people.forEach(function (x, i) {
                if (i) { line.appendChild(document.createTextNode(', ')); }
                if (x.id === you || !window.hubWho) { line.appendChild(document.createTextNode(x.label)); return; }
                var b = html('button', x.label, 'who');
                b.type = 'button';
                b.title = 'Mute or report';
                b.addEventListener('click', function () { window.hubWho.show(x.id, x.label); });
                line.appendChild(b);
            });
            list.appendChild(line);
            var objects = objectsOf(place.id);
            if (objects.length) {
                var ol = html('p', '', 'objects');
                objects.forEach(function (o, i) {
                    if (i) { ol.appendChild(document.createTextNode(' · ')); }
                    var page = pageOf(o);
                    var a = html(page ? 'a' : 'span', describe(o), o.stale ? 'dim' : '');
                    if (page) { a.href = page; }
                    ol.appendChild(a);
                });
                list.appendChild(ol);
            }
        });
    }
    byId('units').value = units;
    byId('units').addEventListener('change', function (e) {
        units = 'f' === e.target.value ? 'f' : 'c';
        try { localStorage.setItem('hub-units', units); } catch (err) { /* kept for this page only */ }
        if (state) { draw(); }
    });

    function connect() {
        retryTimer = null;
        if (stopped) { return; }
        var started = false;
        ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/space/live');
        ws.onmessage = function (e) {
            var message;
            try { message = JSON.parse(e.data); } catch (err) { return; }
            if (!message || 1 !== message.version) { return; }
            if (!started) { setStatus('Live'); }
            started = true;
            retries = 0;
            apply(message);
        };
        ws.onclose = function (e) {
            ws = null;
            if (4403 === e.code) {
                stopped = true;
                ended = true;
                setStatus(/^blocked by /.test(e.reason || '')
                    ? 'You were ' + e.reason + '. Reload the page to see why.'
                    : 'You are no longer in the common space. Reload the page to try again.');
                return;
            }
            retries = started ? 1 : retries + 1;
            var wait = Math.min(30, Math.pow(2, retries));
            setStatus('Reconnecting in ' + wait + ' s…');
            retryTimer = setTimeout(connect, wait * 1000);
        };
    }
    //  for the page beside the chat, which can pop the map out into its own
    //  window and back (space_page.ts)
    function stop() {
        stopped = true;
        clearTimeout(retryTimer);
        retryTimer = null;
        if (ws) {
            var old = ws;
            ws = null;
            old.onclose = null;
            old.close();
        }
        setStatus('Stopped');
    }
    function start() {
        if (!stopped || ended) { return; }
        stopped = false;
        retries = 0;
        setStatus('Connecting…');
        connect();
    }
    window.hubPanes = window.hubPanes || {};
    window.hubPanes.map = { start: start, stop: stop };
    connect();
})();
`;
