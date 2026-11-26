import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimedHandle } from '../src/atproto.ts';
import { tellSysop } from '../src/cli.ts';
import type { JsonFetcher } from '../src/net.ts';

const Did = 'did:plc:abcdefghijklmnopqrstuvwx';

describe('telling a sysop about their application', () => {
    it("names the handle the account's DID document gives", async () => {
        const urls: string[] = [];
        const fetchJson = (async (url: string) => {
            urls.push(url);
            return { id: Did, alsoKnownAs: ['https://not-a-handle', 'at://alice.example.com'] };
        }) as JsonFetcher;
        assert.equal(await claimedHandle(fetchJson, Did), 'alice.example.com');
        assert.deepEqual(urls, [`https://plc.directory/${Did}`]);
    });

    it('gives null, not an error, when there is none or the lookup fails', async () => {
        const none = (async () => ({ id: Did, alsoKnownAs: [] })) as JsonFetcher;
        const fails = (async () => {
            throw new Error('offline');
        }) as JsonFetcher;
        assert.equal(await claimedHandle(none, Did), null);
        assert.equal(await claimedHandle(fails, Did), null);
        assert.equal(await claimedHandle(none, 'not a did'), null);
    });

    it('reminds the admin, by handle when there is one', async () => {
        assert.match(
            await tellSysop(Did, 'approved', async () => 'alice.example.com'),
            new RegExp(`let @alice\\.example\\.com \\(${Did}\\) know it was approved`)
        );
        assert.match(await tellSysop(Did, 'turned down', async () => null), new RegExp(`let ${Did} know it was turned down`));
    });
});
