//  The live model of the common space (hub plan H16, vision §8.3): who is
//  there, where, and who is talking together, streamed to each viewer over a
//  WebSocket. A small core that any view can draw, versioned, under the
//  development names (nsidPrefix + '.space.*'); see docs/live_model.md.
//
//  A viewer gets the whole state when they connect, then only what changed.
//  Who appears follows presence (presence.ts): nobody whose own setting is
//  off, nobody a BBS isn't allowed to show. A BBS's unconfirmed word about a
//  DID stays "name via bbs", never linked to the account behind it.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Chat } from './chat.ts';
import type { HubConfig } from './config.ts';
import type { Directory } from './directory.ts';
import type { Presence } from './presence.ts';
import type { Profiles } from './profiles.ts';
import type { Registry } from './registry.ts';
import { acceptWebSocket, isUpgrade, type WsPeer } from './websocket.ts';

export const LivePath = '/space/live';
export const LiveVersion = 1;
const TickMs = 2_000;
const PokeMs = 100;
//  a viewer this far behind is dropped; reconnecting starts afresh
const MaxBacklog = 1024 * 1024;
const MaxViewers = 1000;
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
}

export interface LeafEntity {
    id: string;
    type: 'leaf';
    name: string;
    title: string | null;
    url: string;
    online: boolean;
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
}

function short(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function hubUrl(config: HubConfig, host: string): string {
    return `https://${host}${443 === config.edge.httpsPort ? '' : `:${config.edge.httpsPort}`}`;
}

//  The state as anyone allowed in sees it
export function buildState(s: LiveSources): LiveState {
    const people = new Map<string, PersonEntity>();
    const presence: PresenceItem[] = [];
    const leaves: LeafEntity[] = [];
    const rooms: RoomEntity[] = [];
    const groups: Group[] = [];

    for (const bbs of s.registry.list()) {
        if ('active' !== bbs.state || !s.presence.ratingAllowed(bbs)) {
            continue;
        }
        const entry = s.directory?.forBbs(bbs) ?? null;
        leaves.push({
            id: `leaf:${bbs.name}`,
            type: 'leaf',
            name: bbs.name,
            title: entry?.listing.name ?? null,
            url: hubUrl(s.config, `${bbs.name}.${s.config.domain}`),
            online: bbs.connected,
        });
    }

    for (const p of s.presence.around()) {
        const id =
            'account' === p.kind && p.did
                ? `person:${p.did}`
                : `person:${p.kind}:${p.bbs}:${short(`${p.bbs}\n${p.label}`)}`;
        if (!people.has(id)) {
            people.set(id, { id, type: 'person', label: p.label, did: p.did, kind: p.kind });
        }
        presence.push({ id: `${id}@leaf:${p.bbs}`, person: id, place: `leaf:${p.bbs}`, since: p.onlineSince });
    }

    //  the room: people in it with their own setting on, as their account
    if (s.chat && s.config.space.chat.enabled) {
        const room = `room:${s.config.space.chat.room}`;
        rooms.push({ id: room, type: 'room', name: s.config.space.chat.room });
        const members: string[] = [];
        for (const { did, since } of s.chat.present()) {
            const profile = s.profiles.get(did);
            if (!profile?.presence || !s.presence.mayJoin(did)) {
                continue;
            }
            const id = `person:${did}`;
            if (!people.has(id)) {
                people.set(id, {
                    id,
                    type: 'person',
                    label: profile.handle ? `@${profile.handle}` : did,
                    did,
                    kind: 'account',
                });
            }
            presence.push({ id: `${id}@${room}`, person: id, place: room, since });
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
    did: string;
    session: string;
    peer: WsPeer;
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

    constructor(sources: LiveSources, hooks: LiveHooks, log: (line: string) => void = () => {}) {
        this.sources = sources;
        this.hooks = hooks;
        this.log = log;
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
        const mine = [...this.viewers].filter(v => v.did === viewer.did).length;
        if (mine >= this.sources.config.space.live.maxConnections || this.viewers.size >= MaxViewers) {
            return 429;
        }
        //  bring everyone else up to date first, so the snapshot and the
        //  changes they have been sent agree
        this.tick();
        if (!this.viewers.size) {
            this.state = buildState(this.sources);
        }
        const peer = acceptWebSocket(req, socket, head);
        const v: Viewer = { ...viewer, peer };
        this.viewers.add(v);
        peer.onClose(() => this.viewers.delete(v));
        peer.send(
            JSON.stringify({
                $type: `${this.nsid}.snapshot`,
                version: LiveVersion,
                seq: this.seq,
                you: this.state.entities.some(e => e.id === `person:${viewer.did}`) ? `person:${viewer.did}` : null,
                ...this.state,
            })
        );
        return null;
    }

    tick(): void {
        for (const v of [...this.viewers]) {
            if (!this.hooks.sessionValid(v.session) || !this.sources.presence.mayJoin(v.did)) {
                this.log(`live: closed ${v.did}: access ended`);
                v.peer.close(AccessEnded, 'access ended');
            }
        }
        if (!this.viewers.size) {
            return;
        }
        const next = buildState(this.sources);
        const change = diffState(this.state, next);
        this.state = next;
        if (!change) {
            return;
        }
        this.seq++;
        const text = JSON.stringify({ $type: `${this.nsid}.change`, version: LiveVersion, seq: this.seq, ...change });
        for (const v of [...this.viewers]) {
            //  a viewer who can't keep up falls behind alone
            if (v.peer.backlog() > MaxBacklog) {
                v.peer.close(1013, 'too far behind');
                continue;
            }
            v.peer.send(text);
        }
    }

    viewing(did: string): number {
        return [...this.viewers].filter(v => v.did === did).length;
    }
}
