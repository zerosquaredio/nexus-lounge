import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AbuseReports } from '../src/abuse.ts';
import { Moderation } from '../src/moderation.ts';
import { makeConfig } from '../src/config.ts';
import { OtherSysopDid, testRegistry } from './helpers.ts';

describe('the abuse report store', () => {
    it('keeps a report until closed, then lets go of what it said, how to reply and who sent it', () => {
        const registry = testRegistry();
        const reports = new AbuseReports(registry.db);
        const filed = reports.file({
            bbs: 'coolbbs',
            kind: 'privacy',
            details: '  My address\nis posted \u0007there  ',
            contact: 'me@example.com',
            reporter: OtherSysopDid,
        });
        assert.equal(filed.details, 'My address\nis posted  there', 'control characters out, newlines kept');
        assert.equal(reports.list().length, 1);

        const closed = reports.close(filed.id, 'Removed by the sysop');
        assert.deepEqual(
            [closed.details, closed.contact, closed.reporter, closed.outcome, closed.bbs, closed.kind],
            [null, null, null, 'Removed by the sysop', 'coolbbs', 'privacy']
        );
        assert.equal(reports.list().length, 0);
        assert.equal(reports.list(true).length, 1);
        assert.throws(() => reports.close(filed.id), { code: 'closed' });

        const raw = JSON.stringify(registry.db.prepare('SELECT * FROM abuse_report').all());
        assert.doesNotMatch(raw, /address|me@example|did:/);
        const log = new Moderation(registry.db).history().map(e => `${e.action} ${e.subject} ${e.detail}`);
        assert.deepEqual(log, [
            'abuse-report coolbbs abuse report 1: privacy',
            'close-abuse coolbbs abuse report 1: Removed by the sysop',
        ]);
    });

    it('refuses a report with no kind, no details, or too much', () => {
        const reports = new AbuseReports(testRegistry().db);
        const base = { bbs: null, kind: 'spam', details: 'x', contact: '', reporter: null };
        assert.throws(() => reports.file({ ...base, kind: 'bad' }), { code: 'bad-report' });
        assert.throws(() => reports.file({ ...base, details: ' \n ' }), { code: 'bad-report' });
        assert.throws(() => reports.file({ ...base, details: 'x'.repeat(4001) }), { code: 'bad-report' });
        assert.throws(() => reports.file({ ...base, contact: 'x'.repeat(201) }), { code: 'bad-report' });
        assert.throws(() => reports.mustGet(99), { code: 'not-found' });
    });

    it('takes an abuse address in the config, or none', () => {
        assert.equal(makeConfig({}).contact.abuse, '');
        assert.equal(
            makeConfig({ contact: { abuse: 'abuse@hub.example' } }).contact.abuse,
            'abuse@hub.example'
        );
        for (const bad of ['nope', 'a b@c.d', '<x@y.z>']) {
            assert.throws(() => makeConfig({ contact: { abuse: bad } }), /contact\.abuse/, bad);
        }
    });
});
