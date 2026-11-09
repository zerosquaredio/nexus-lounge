import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultReservedNames, isDid, isOddPath, nameProblem } from '../src/rules.ts';

describe('BBS names', () => {
    it('accepts DNS-label names', () => {
        for (const name of ['coolbbs', 'cool-bbs', 'b2', 'x'.repeat(32), '0day']) {
            assert.equal(nameProblem(name, DefaultReservedNames), null, name);
        }
    });

    it('refuses anything else', () => {
        for (const name of [
            '',
            'a',
            'x'.repeat(33),
            'Cool',
            '-cool',
            'cool-',
            'cool--bbs',
            'xn--80ak6aa92e',
            'cool.bbs',
            'cool_bbs',
            'cööl',
            'cool bbs',
        ]) {
            assert.notEqual(nameProblem(name, DefaultReservedNames), null, JSON.stringify(name));
        }
    });

    it('refuses reserved names', () => {
        assert.match(nameProblem('admin', DefaultReservedNames) ?? '', /reserved/);
        assert.match(nameProblem('www', DefaultReservedNames) ?? '', /reserved/);
    });
});

describe('DIDs', () => {
    it('accepts did:plc and did:web', () => {
        assert.ok(isDid('did:plc:h42th5aghumipqjsfrpqrt5b'));
        assert.ok(isDid('did:web:bbs.example.com'));
    });

    it('refuses handles and malformed DIDs', () => {
        for (const value of [
            'alice.bsky.social',
            'did:plc:short',
            'did:plc:UPPERCASEUPPERCASEUPPERC',
            'did:key:z6Mk',
            '',
        ]) {
            assert.equal(isDid(value), false, value);
        }
    });
});

describe('odd paths (refused at the edge)', () => {
    it('catches what the tunnel would pass on unchanged (spike H0.2)', () => {
        for (const path of [
            '/assets/../admin',
            '/assets/x/../y',
            '/assets/..%2fadmin',
            '/assets/%2e%2e/admin',
            '/assets/%2E%2E%5Cadmin',
            '/assets//x',
            '//assets/x',
            '/assets/a\\b',
            '/assets/a%00b',
            '/ws/../admin',
        ]) {
            assert.ok(isOddPath(path), path);
        }
    });

    it('leaves ordinary paths and query strings alone', () => {
        for (const path of [
            '/',
            '/ws',
            '/assets/x.png',
            '/assets/file.name.png?v=1..2',
            '/_enig/atproto/callback?iss=https%3A%2F%2Fbsky.social&state=x',
            '/_enig/handoff/7F3K-9QXM',
        ]) {
            assert.equal(isOddPath(path), false, path);
        }
    });
});
