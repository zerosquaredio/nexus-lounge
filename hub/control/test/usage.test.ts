import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Registry } from '../src/registry.ts';
import { sizeText, Usage } from '../src/usage.ts';
import { OtherSysopDid, SysopDid, testRegistry } from './helpers.ts';

describe('usage trends', () => {
    let clock: Date;
    let registry: Registry;
    let usage: Usage;
    const later = (seconds: number) => {
        clock = new Date(clock.getTime() + seconds * 1000);
    };
    const proxy = (name: string, inBytes: number, outBytes: number, conns = 1) => ({
        name,
        user: name.split('.')[0],
        status: 'online',
        todayTrafficIn: inBytes,
        todayTrafficOut: outBytes,
        curConns: conns,
    });

    beforeEach(() => {
        clock = new Date('2026-11-25T12:00:00Z');
        registry = testRegistry(() => clock);
        registry.add('coolbbs', SysopDid);
        registry.add('other', OtherSysopDid);
        usage = new Usage(registry, () => clock);
    });

    it("adds each BBS's traffic as frps's counters grow, from the first look on", () => {
        usage.traffic([proxy('coolbbs.web', 1000, 5000), proxy('coolbbs.ws', 10, 20)]);
        later(15);
        usage.traffic([proxy('coolbbs.web', 1500, 9000, 3), proxy('coolbbs.ws', 110, 220, 2)]);
        const [day] = usage.days(1).bbses;
        assert.deepEqual(
            [day?.bbs, day?.bytesIn, day?.bytesOut, day?.connsPeak],
            ['coolbbs', 600, 4200, 5],
            'counted from the first look, connections summed over its proxies'
        );
    });

    it('carries on when frps restarts or its day turns, and skips unknown proxies', () => {
        usage.traffic([proxy('coolbbs.web', 1000, 1000)]);
        usage.traffic([proxy('coolbbs.web', 300, 400), proxy('stranger.web', 999, 999)]);
        usage.traffic([proxy('coolbbs.web', 350, 400)]);
        const days = usage.days(1).bbses;
        assert.equal(days.length, 1);
        assert.deepEqual([days[0]?.bytesIn, days[0]?.bytesOut], [350, 400]);
    });

    it("counts each BBS's time connected, and the hub's counts and peaks for the day", () => {
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        usage.sample({ live: 2, chat: 1 });
        later(15);
        usage.sample({ live: 5, chat: 0 });
        later(60 * 60);
        usage.sample({ live: 1, chat: 0 });
        const { hub, bbses } = usage.days(1);
        assert.equal(bbses[0]?.bbs, 'coolbbs');
        assert.equal(bbses[0]?.connectedSeconds, 15 + 120, 'a long gap counts two minutes at most');
        assert.deepEqual(hub, [
            {
                day: '2026-11-25',
                bbsRegistered: 2,
                bbsActive: 2,
                bbsConnectedPeak: 1,
                people: 0,
                presenceOn: 0,
                signedIn: 0,
                livePeak: 5,
                chatPeak: 1,
                reports: 0,
                blocks: 0,
            },
        ]);
    });

    it('keeps days apart, and holds no DIDs', () => {
        usage.sample();
        later(24 * 60 * 60);
        usage.sample();
        assert.deepEqual(
            usage.days(7).hub.map(d => d.day),
            ['2026-11-25', '2026-11-26']
        );
        const rows = JSON.stringify([
            registry.db.prepare('SELECT * FROM usage_day').all(),
            registry.db.prepare('SELECT * FROM usage_bbs_day').all(),
        ]);
        assert.doesNotMatch(rows, /did:/);
    });

    it('shows sizes for people', () => {
        assert.equal(sizeText(512), '512 B');
        assert.equal(sizeText(1536), '1.5 KB');
        assert.equal(sizeText(5 * 1024 * 1024), '5.0 MB');
    });
});
