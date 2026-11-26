//  The live model of the common space (hub plan H16, vision §8.3): who is
//  there, where, and who is talking together, streamed to each viewer over a
//  WebSocket. A small core that any view can draw, versioned, under the
//  development names (nsidPrefix + '.space.*'); see docs/development/live_model.md.
//
//  A viewer gets the whole state when they connect, then only what changed.
//  Who appears follows presence (presence.ts): nobody whose own setting is
//  off, nobody a BBS isn't allowed to show. A BBS's unconfirmed word about a
//  DID stays "name via bbs", never linked to the account behind it.
//
//  A viewer may tell the hub one thing: which board they have opened from
//  the hub's page (hub plan H14's first source). That is their own word
//  about themselves, like their presence setting, so it is shown only with
//  that setting on, only at a board that is up, and only while they keep
//  both the board and the stream open.
//
//  A BBS may also open the stream for one of its members, to show the space
//  inside the BBS (F19, the door): see Presence.doorAccess for who.
//
//  What each viewer sees differs only by whom they muted (H18): those people
//  are left out of their state, and nobody else's. Someone the hub's admin
//  blocked is in nobody's, and their own stream is closed, saying so.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Chat } from './chat.ts';
import type { HubConfig } from './config.ts';
import type { Directory } from './directory.ts';
import type { DoorAccess, Presence } from './presence.ts';
import type { Profiles } from './profiles.ts';
import type { Bbs, Registry } from './registry.ts';
import { WebTermPath } from './webterm.ts';
import { acceptWebSocket, isUpgrade, type WsPeer } from './websocket.ts';

export const LivePath = '/space/live';
export const LiveVersion = 1;
const TickMs = 2_000;
const PokeMs = 100;
//  a viewer this far behind is dropped; reconnecting starts afresh
const MaxBacklog = 1024 * 1024;
const MaxViewers = 1000;
//  streams one BBS may hold for its members at once
const MaxPerBbs = 100;
//  what one viewer may tell the hub in a minute; more is ignored
const MaxSaid = 20;
const BbsNameRe = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
//  closed because access ended (a client should not just reconnect)
export const AccessEnded = 4403;

export interface PersonEntity {
    id: string;
    type: 'person';
    label: string;
    //  their own AT account, where the hub knows it is them
    did: string | null;
    //  account: signed in to the hub, or a BBS they confirmed; via: a BBS's
    //  word, unconfirmed; vouched: a BBS member with no AT account
    kind: 'account' | 'via' | 'vouched';
    //  their Bluesky picture, as the hub serves it, for an account whose
    //  owner hasn't turned it off (pictures.ts), or null
    picture: { url: string; width: number; height: number } | null;
}

export interface LeafEntity {
    id: string;
    type: 'leaf';
    name: string;
    title: string | null;
    url: string;
    online: boolean;
    //  the hub's web terminal for it, if the hub serves one
    terminal: string | null;
    //  its emblem, a small picture for the map (F21), if it has one
    emblem: { url: string; width: number; height: number; label: string } | null;
}

export interface RoomEntity {
    id: string;
    type: 'room';
    name: string;
}

export type Entity = PersonEntity | LeafEntity | RoomEntity;

export interface PresenceItem {
    id: string;
    person: string;
    //  a leaf or a room
    place: string;
    since: string | null;
    //  how the hub knows: a BBS's report, the hub's own page, or the chat
    source: 'bbs' | 'hub' | 'chat';
}

export interface Group {
    id: string;
    //  where they are together
    place: string;
    members: string[];
}

export interface Link {
    id: string;
    from: string;
    to: string;
    kind: string;
}

export interface LiveState {
    entities: Entity[];
    presence: PresenceItem[];
    groups: Group[];
    links: Link[];
}

type Collection = keyof LiveState;
const Collections: Collection[] = ['entities', 'presence', 'groups', 'links'];

export interface LiveSources {
    config: HubConfig;
    registry: Registry;
    presence: Presence;
    profiles: Profiles;
    directory?: Directory | null;
    chat?: Chat | null;
    //  whether the hub serves the web terminal
    webterm?: boolean;
    //  a BBS's emblem, if it has one
    emblemOf?: (bbs: Bbs) => LeafEntity['emblem'];
    //  someone's Bluesky picture, if the hub has it and they allow it
    pictureOf?: (did: string) => PersonEntity['picture'];
}

//  Someone the hub's page says has a board open
export interface Visit {
    did: string;
    bbs: string;
    since: string;
}

function short(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

//  How the model names a person: by DID where the hub knows it is them,
//  otherwise by what the BBS calls them, which never reveals a DID
export function personId(p: { kind: string; did: string | null; bbs: string; label: string }): string {
    return 'account' === p.kind && p.did ? `person:${p.did}` : `person:${p.kind}:${p.bbs}:${short(`${p.bbs}\n${p.label}`)}`;
}

export function hubUrl(config: HubConfig, host: string): string {
    return `https://${host}${443 === config.edge.httpsPort ? '' : `:${config.edge.httpsPort}`}`;
}

//  The state as anyone allowed in sees it
export function buildState(s: LiveSources, visits: Visit[] = []): LiveState {
    const people = new Map<string, PersonEntity>();
    const presence: PresenceItem[] = [];
    const leaves: LeafEntity[] = [];
    const rooms: RoomEntity[] = [];
    const groups: Group[] = [];
    //  someone signed in to the hub, as their own account
    const account = (did: string): string => {
        const id = `person:${did}`;
        if (!people.has(id)) {
            const handle = s.profiles.get(did)?.handle;
            people.set(id, {
                id,
                type: 'person',
                label: handle ? `@${handle}` : did,
                did,
                kind: 'account',
                picture: s.pictureOf?.(did) ?? null,
            });
        }
        return id;
    };

    for (const bbs of s.registry.list()) {
        if ('active' !== bbs.state || !s.presence.ratingAllowed(bbs)) {
            continue;
        }
        const entry = s.directory?.forBbs(bbs) ?? null;
        const url = hubUrl(s.config, `${bbs.name}.${s.config.domain}`);
        leaves.push({
            id: `leaf:${bbs.name}`,
            type: 'leaf',
            name: bbs.name,
            title: entry?.listing.name ?? null,
            url,
            online: bbs.connected,
            terminal: s.webterm ? `${url}${WebTermPath}?connect=1` : null,
            emblem: s.emblemOf?.(bbs) ?? null,
        });
    }

    for (const p of s.presence.around()) {
        const id = personId(p);
        if (!people.has(id)) {
            people.set(id, {
                id,
                type: 'person',
                label: p.label,
                did: p.did,
                kind: p.kind,
                picture: 'account' === p.kind && p.did ? (s.pictureOf?.(p.did) ?? null) : null,
            });
        }
        presence.push({
            id: `${id}@leaf:${p.bbs}`,
            person: id,
            place: `leaf:${p.bbs}`,
            since: p.onlineSince,
            source: 'bbs',
        });
    }

    //  boards opened from the hub's page, where the BBS hasn't said so itself
    const up = new Set(leaves.filter(l => l.online).map(l => l.name));
    const said = new Set(presence.map(p => p.id));
    for (const v of [...visits].sort((a, b) => a.since.localeCompare(b.since))) {
        if (!up.has(v.bbs) || !s.profiles.get(v.did)?.presence || !s.presence.mayJoin(v.did)) {
            continue;
        }
        const id = `person:${v.did}`;
        const at = `${id}@leaf:${v.bbs}`;
        if (said.has(at)) {
            continue;
        }
        said.add(at);
        presence.push({ id: at, person: account(v.did), place: `leaf:${v.bbs}`, since: v.since, source: 'hub' });
    }

    //  the room: people in it with their own setting on, as their account
    if (s.chat && s.config.space.chat.enabled) {
        const room = `room:${s.config.space.chat.room}`;
        rooms.push({ id: room, type: 'room', name: s.config.space.chat.room });
        const members: string[] = [];
        for (const { did, since } of s.chat.present()) {
            if (!s.profiles.get(did)?.presence || !s.presence.mayChat(did)) {
                continue;
            }
            const id = account(did);
            presence.push({ id: `${id}@${room}`, person: id, place: room, since, source: 'chat' });
            members.push(id);
        }
        groups.push({ id: `group:${room}`, place: room, members: members.sort() });
    }

    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
        entities: [...leaves.sort(byId), ...rooms, ...[...people.values()].sort(byId)],
        presence: presence.sort(byId),
        groups,
        links: [],
    };
}

//  The state without the people a viewer muted
export function hideMuted(state: LiveState, muted: ReadonlySet<string>): LiveState {
    if (!muted.size) {
        return state;
    }
    return {
        entities: state.entities.filter(e => !muted.has(e.id)),
        presence: state.presence.filter(p => !muted.has(p.person)),
        groups: state.groups.map(g => ({ ...g, members: g.members.filter(m => !muted.has(m)) })),
        links: state.links.filter(l => !muted.has(l.from) && !muted.has(l.to)),
    };
}

export interface LiveChange {
    put: Partial<Record<Collection, unknown[]>>;
    remove: Partial<Record<Collection, string[]>>;
}

//  What changed between two states, by id
export function diffState(before: LiveState, after: LiveState): LiveChange | null {
    const change: LiveChange = { put: {}, remove: {} };
    let any = false;
    for (const c of Collections) {
        const old = new Map((before[c] as { id: string }[]).map(x => [x.id, JSON.stringify(x)]));
        const now = new Map((after[c] as { id: string }[]).map(x => [x.id, x]));
        const put = [...now.values()].filter(x => old.get(x.id) !== JSON.stringify(x));
        const remove = [...old.keys()].filter(id => !now.has(id));
        if (put.length) {
            change.put[c] = put;
            any = true;
        }
        if (remove.length) {
            change.remove[c] = remove;
            any = true;
        }
    }
    return any ? change : null;
}

export interface LiveHooks {
    sessionValid(session: string): boolean;
}

interface Viewer {
    //  who they are in the model, shown or not
    you: string;
    //  a browser on the hub's page (did set), or a BBS's member (bbs set)
    did: string | null;
    bbs: string | null;
    allowed: () => boolean;
    //  why it ended, for the close frame: who blocked them, if someone did
    why: () => string;
    //  whose mutes apply: the viewer's own account, where the hub knows it
    muter: string | null;
    //  what they were last sent
    view: LiveState;
    peer: WsPeer;
    //  the board they say they have open from the hub's page, and since when
    at: string | null;
    atSince: string;
    //  their last action here (connecting, opening a board), for H19
    acted: number;
    said: number[];
}

export class Live {
    sources: LiveSources;
    hooks: LiveHooks;
    log: (line: string) => void;
    viewers = new Set<Viewer>();
    state: LiveState = { entities: [], presence: [], groups: [], links: [] };
    seq = 0;
    timer: NodeJS.Timeout | null = null;
    pokeTimer: NodeJS.Timeout | null = null;
    now: () => number;

    constructor(
        sources: LiveSources,
        hooks: LiveHooks,
        log: (line: string) => void = () => {},
        now: () => number = Date.now
    ) {
        this.sources = sources;
        this.hooks = hooks;
        this.log = log;
        this.now = now;
    }

    get nsid(): string {
        return `${this.sources.config.directory.nsidPrefix}.space`;
    }

    start(): void {
        this.timer = setInterval(() => this.tick(), TickMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        if (this.pokeTimer) {
            clearTimeout(this.pokeTimer);
        }
        this.viewers.forEach(v => v.peer.close(1001, 'going away'));
    }

    //  Something changed: send it soon, without waiting for the next tick
    poke(): void {
        if (!this.pokeTimer) {
            this.pokeTimer = setTimeout(() => {
                this.pokeTimer = null;
                this.tick();
            }, PokeMs);
            this.pokeTimer.unref();
        }
    }

    //  A browser's connection, already checked for its origin and session.
    //  Returns why not, if not
    attach(req: IncomingMessage, socket: Duplex, head: Buffer, viewer: { did: string; session: string }): number | null {
        if (!this.sources.presence.mayJoin(viewer.did)) {
            return 403;
        }
        if (!isUpgrade(req)) {
            return 400;
        }
        const you = `person:${viewer.did}`;
        if (this.full(you)) {
            return 429;
        }
        const session = viewer.session;
        this.open(req, socket, head, {
            you,
            did: viewer.did,
            bbs: null,
            allowed: () => this.hooks.sessionValid(session) && this.sources.presence.mayJoin(viewer.did),
            why: () => this.why(viewer.did),
            muter: viewer.did,
        });
        return null;
    }

    //  The close frame's reason: short, and saying who, for a block
    why(did: string | null, bbs?: string, user?: string | null): string {
        const blocked = bbs ? this.sources.presence.memberBlock(bbs, did, user ?? null) : did ? this.sources.presence.blockOf(did) : null;
        return blocked ? `blocked by the admin of ${this.sources.config.domain}`.slice(0, 120) : 'access ended';
    }

    //  A BBS's connection for one of its members, already checked (site.ts):
    //  the same stream, as that member. `allowed` says whether it still holds
    attachBbs(
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        door: DoorAccess,
        allowed: () => boolean,
        member: { did: string | null; user: string | null } = { did: door.did, user: null }
    ): number | null {
        if (!isUpgrade(req)) {
            return 400;
        }
        const you = personId(door);
        if (this.full(you) || [...this.viewers].filter(v => v.bbs === door.bbs).length >= MaxPerBbs) {
            return 429;
        }
        this.open(req, socket, head, {
            you,
            did: null,
            bbs: door.bbs,
            allowed,
            why: () => this.why(member.did, door.bbs, member.user),
            //  only someone the hub knows as themselves has mutes here
            muter: 'account' === door.kind ? door.did : null,
        });
        return null;
    }

    full(you: string): boolean {
        const mine = [...this.viewers].filter(v => v.you === you).length;
        return mine >= this.sources.config.space.live.maxConnections || this.viewers.size >= MaxViewers;
    }

    open(
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        who: Pick<Viewer, 'you' | 'did' | 'bbs' | 'allowed' | 'why' | 'muter'>
    ): void {
        //  bring everyone else up to date first, so the snapshot and the
        //  changes they have been sent agree
        this.tick();
        if (!this.viewers.size) {
            this.state = buildState(this.sources, this.visits());
        }
        const peer = acceptWebSocket(req, socket, head);
        const view = hideMuted(this.state, this.muted(who.muter));
        const v: Viewer = { ...who, view, peer, at: null, atSince: '', said: [], acted: this.now() };
        this.viewers.add(v);
        peer.onClose(() => {
            this.viewers.delete(v);
            if (v.at) {
                this.poke();
            }
        });
        //  only the hub's own page opens boards; a BBS reports its own
        if (v.did) {
            peer.onText(text => this.hear(v, text));
        }
        peer.send(
            JSON.stringify({
                $type: `${this.nsid}.snapshot`,
                version: LiveVersion,
                seq: this.seq,
                //  their own person, whether or not they are shown now
                you: v.you,
                ...view,
            })
        );
    }

    muted(did: string | null): Set<string> {
        return did ? this.sources.presence.moderation.muted(did) : new Set();
    }

    tick(): void {
        for (const v of [...this.viewers]) {
            if (!v.allowed()) {
                const why = v.why();
                this.log(`live: closed ${v.did ?? `a viewer from ${v.bbs}`}: ${why}`);
                v.peer.close(AccessEnded, why);
            }
        }
        if (!this.viewers.size) {
            return;
        }
        const before = this.state;
        const next = buildState(this.sources, this.visits());
        const shared = diffState(before, next);
        this.state = next;
        const seq = this.seq + 1;
        const message = (change: LiveChange) =>
            JSON.stringify({ $type: `${this.nsid}.change`, version: LiveVersion, seq, ...change });
        const sharedText = shared ? message(shared) : null;
        const mutes = new Map<string, Set<string>>();
        let sent = false;
        for (const v of [...this.viewers]) {
            let muted: Set<string> = new Set();
            if (v.muter) {
                muted = mutes.get(v.muter) ?? this.muted(v.muter);
                mutes.set(v.muter, muted);
            }
            let text: string | null;
            if (!muted.size && v.view === before) {
                text = sharedText;
                v.view = next;
            } else {
                const view = hideMuted(next, muted);
                const change = diffState(v.view, view);
                text = change ? message(change) : null;
                v.view = view;
            }
            if (!text) {
                continue;
            }
            //  a viewer who can't keep up falls behind alone
            if (v.peer.backlog() > MaxBacklog) {
                v.peer.close(1013, 'too far behind');
                continue;
            }
            v.peer.send(text);
            sent = true;
        }
        if (sent) {
            this.seq = seq;
        }
    }

    //  What a viewer tells the hub: { "$type": "<nsid>.at", "place": "leaf:<name>" | null }
    hear(v: Viewer, text: string): void {
        const minute = this.now() - 60_000;
        v.said = v.said.filter(t => t > minute);
        if (v.said.length >= MaxSaid) {
            return;
        }
        v.said.push(this.now());
        let message: { $type?: unknown; place?: unknown };
        try {
            message = JSON.parse(text) as typeof message;
        } catch {
            return;
        }
        if (`${this.nsid}.at` !== message?.$type) {
            return;
        }
        const place = message.place;
        let at: string | null = null;
        if (typeof place === 'string' && place.startsWith('leaf:') && BbsNameRe.test(place.slice(5))) {
            at = place.slice(5);
        } else if (null !== place) {
            return;
        }
        v.acted = this.now();
        if (at !== v.at) {
            v.at = at;
            v.atSince = new Date(this.now()).toISOString();
            this.poke();
        }
    }

    //  When someone with the hub's page open last did something there, or
    //  null if they have none open (H19)
    activeAt(did: string): number | null {
        const mine = [...this.viewers].filter(v => v.did === did);
        return mine.length ? Math.max(...mine.map(v => v.acted)) : null;
    }

    //  Boards people have open from the hub's page, by their own word
    visits(): Visit[] {
        return [...this.viewers].flatMap(v => (v.at && v.did ? [{ did: v.did, bbs: v.at, since: v.atSince }] : []));
    }

    viewing(did: string): number {
        return [...this.viewers].filter(v => v.did === did).length;
    }
}
