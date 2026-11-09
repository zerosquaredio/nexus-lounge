//  Following the AT network's changes to listings and status, live, through
//  a Jetstream (a JSON form of the network's event stream, filtered to our
//  record types). Resumes from where it stopped after a restart; if it was
//  away longer than the stream keeps, main.ts runs a sweep.

import { collections, type Directory } from './directory.ts';

export interface JetstreamEvent {
    did?: unknown;
    time_us?: unknown;
    kind?: unknown;
    commit?: { operation?: unknown; collection?: unknown; rkey?: unknown; cid?: unknown; record?: unknown };
}

//  Apply one event; true if it changed the directory
export function applyEvent(directory: Directory, event: JetstreamEvent): boolean {
    if ('commit' !== event.kind || 'string' !== typeof event.did || !event.commit) {
        return false; //  identity and account events arrive regardless; not ours
    }
    const { operation, collection, rkey, cid, record } = event.commit;
    if ('self' !== rkey) {
        return false;
    }
    const names = collections(directory.config);
    const did = event.did;
    if (names.listing === collection) {
        if ('delete' === operation) {
            directory.deleteListing(did);
            return true;
        }
        return 'string' === typeof cid && directory.putListing(did, cid, record);
    }
    if (names.status === collection && directory.entry(did)) {
        if ('delete' === operation) {
            directory.deleteStatus(did);
        } else if ('string' === typeof cid) {
            directory.putStatus(did, cid, record);
        }
        return true;
    }
    return false;
}

export function streamUrl(directory: Directory, cursor: string | null): string | null {
    const names = collections(directory.config);
    const url = new URL(directory.config.directory.jetstream);
    url.searchParams.append('wantedCollections', names.listing);
    url.searchParams.append('wantedCollections', names.status);
    if ('hub' === directory.config.directory.scope) {
        const dids = directory.registry
            .list()
            .map(b => b.bbsDid)
            .filter((d): d is string => !!d);
        if (!dids.length) {
            return null; //  nothing to follow yet
        }
        //  sent in the address, which keeps it to a few hundred accounts;
        //  a larger hub uses "network" scope
        for (const did of dids.slice(0, 200)) {
            url.searchParams.append('wantedDids', did);
        }
    }
    if (cursor) {
        //  a few seconds back: events seen twice change nothing
        url.searchParams.set('cursor', String(Math.max(0, Number(cursor) - 5_000_000)));
    }
    return url.toString();
}

export function followStream(directory: Directory, log: (line: string) => void): { stop(): void } {
    let socket: WebSocket | null = null;
    let stopped = false;
    let delay = 1_000;
    let lastSaved = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
        if (stopped) {
            return;
        }
        const url = streamUrl(directory, directory.getState('cursor'));
        if (!url) {
            timer = setTimeout(connect, 10 * 60 * 1000);
            return;
        }
        socket = new WebSocket(url);
        socket.onopen = () => {
            delay = 1_000;
            log('directory: following the network');
        };
        socket.onmessage = message => {
            let event: JetstreamEvent;
            try {
                event = JSON.parse(String(message.data)) as JetstreamEvent;
            } catch {
                return;
            }
            if (applyEvent(directory, event)) {
                log(
                    `directory: ${String(event.commit?.operation)} ${String(event.commit?.collection)} from ${String(event.did)}`
                );
            }
            if ('number' === typeof event.time_us && Date.now() - lastSaved > 5_000) {
                directory.setState('cursor', String(event.time_us));
                lastSaved = Date.now();
            }
        };
        socket.onclose = () => {
            socket = null;
            if (!stopped) {
                timer = setTimeout(connect, delay);
                delay = Math.min(delay * 2, 60_000);
            }
        };
        socket.onerror = () => {}; //  onclose follows
    };

    connect();
    //  in "hub" scope the set of accounts changes as sysops register
    const refresh = setInterval(
        () => socket?.close(),
        'hub' === directory.config.directory.scope ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000
    );

    return {
        stop() {
            stopped = true;
            clearInterval(refresh);
            if (timer) {
                clearTimeout(timer);
            }
            socket?.close();
        },
    };
}
