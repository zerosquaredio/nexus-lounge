//  People signed in to the hub (hub plan H13): a small profile per DID,
//  in the registry's database. Made at sign-in while the common space is
//  on; nothing else about the person is kept. Presence (whether they are
//  shown in the common space, H14) is off until they turn it on.

import type { DatabaseSync } from 'node:sqlite';

export interface Profile {
    did: string;
    handle: string | null;
    createdAt: string;
    signedInAt: string;
    presence: boolean;
    //  whether the map shows their Bluesky picture (pictures.ts)
    picture: boolean;
}

interface ProfileRow {
    did: string;
    handle: string | null;
    created_at: string;
    signed_in_at: string;
    presence: number;
    picture: number;
}

function toProfile(row: ProfileRow): Profile {
    return {
        did: row.did,
        handle: row.handle,
        createdAt: row.created_at,
        signedInAt: row.signed_in_at,
        presence: 1 === row.presence,
        picture: 0 !== row.picture,
    };
}

export class Profiles {
    db: DatabaseSync;
    now: () => Date;

    constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
        this.db = db;
        this.now = now;
    }

    //  Someone signed in: their profile, made the first time. The handle
    //  is the one they signed in with, kept only to show it
    signedIn(identity: { did: string; handle: string | null }): Profile {
        const at = this.now().toISOString();
        this.db
            .prepare(
                `INSERT INTO profile (did, handle, created_at, signed_in_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, signed_in_at = excluded.signed_in_at`
            )
            .run(identity.did, identity.handle, at, at);
        return this.get(identity.did) as Profile;
    }

    get(did: string): Profile | null {
        const row = this.db.prepare('SELECT * FROM profile WHERE did = ?').get(did) as ProfileRow | undefined;
        return row ? toProfile(row) : null;
    }

    setPresence(did: string, on: boolean): Profile | null {
        this.db.prepare('UPDATE profile SET presence = ? WHERE did = ?').run(on ? 1 : 0, did);
        return this.get(did);
    }

    setPicture(did: string, on: boolean): Profile | null {
        this.db.prepare('UPDATE profile SET picture = ? WHERE did = ?').run(on ? 1 : 0, did);
        return this.get(did);
    }

    //  Forget them: the profile, their answers about BBSes, and every browser
    //  session they have
    remove(did: string): void {
        this.db.prepare('DELETE FROM profile WHERE did = ?').run(did);
        this.db.prepare('DELETE FROM profile_bbs WHERE did = ?').run(did);
        this.db.prepare('DELETE FROM web_session WHERE did = ?').run(did);
    }
}
