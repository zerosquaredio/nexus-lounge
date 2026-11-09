import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Decision } from '../src/frp_plugin.ts';
import type { Registry } from '../src/registry.ts';
import { OtherSysopDid, SysopDid, testRegistry } from './helpers.ts';

let registry: Registry;
let token: string;
let otherToken: string;

const user = (name = 'coolbbs', t = token) => ({ user: name, metas: { token: t }, run_id: 'run1' });

//  what frps sends for a well-behaved agent (as captured in spike H0.2)
const honest = (overrides: Record<string, unknown> = {}) => ({
    user: user(),
    proxy_name: 'coolbbs.web',
    proxy_type: 'http',
    subdomain: 'coolbbs',
    locations: ['/_enig/atproto/', '/_enig/handoff/', '/_enig/signin', '/_enig/signout'],
    headers: { 'x-forwarded-proto': 'https' },
    ...overrides,
});

const run = (op: string, content: unknown): Decision => decide(op, content, { registry });
const refused = (d: Decision, reason: RegExp) => {
    assert.equal(d.reject, true);
    assert.match((d as { reject_reason: string }).reject_reason, reason);
};

beforeEach(() => {
    registry = testRegistry();
    token = registry.add('coolbbs', SysopDid).token;
    otherToken = registry.add('other', OtherSysopDid).token;
});

describe('the tunnel approval hook', () => {
    describe('Login', () => {
        it('lets a registered BBS in with its token', () => {
            assert.deepEqual(run('Login', { user: 'coolbbs', metas: { token }, run_id: '' }), {
                reject: false,
                unchange: true,
            });
        });

        it('refuses a wrong token, no token, an unknown name, and a suspended BBS', () => {
            refused(run('Login', { user: 'coolbbs', metas: { token: 'wrong' } }), /wrong token/);
            refused(run('Login', { user: 'coolbbs' }), /wrong token/);
            refused(run('Login', { user: 'nobody', metas: { token } }), /Unknown BBS/);
            refused(run('Login', { user: 'other', metas: { token } }), /wrong token/);
            registry.setState('coolbbs', 'suspended');
            refused(run('Login', { user: 'coolbbs', metas: { token } }), /suspended/);
        });
    });

    describe('NewProxy', () => {
        it('opens an honest proxy and records it', () => {
            assert.equal(run('NewProxy', honest()).reject, false);
            assert.equal(registry.mustGet('coolbbs').connected, true);
        });

        it("refuses another BBS's subdomain", () => {
            refused(
                run('NewProxy', honest({ user: user('other', otherToken), subdomain: 'coolbbs' })),
                /not this BBS's/
            );
        });

        it('refuses the root path, no paths, and paths off the list', () => {
            refused(run('NewProxy', honest({ locations: ['/'] })), /Path \/ is not/);
            refused(run('NewProxy', honest({ locations: [] })), /must list the paths/);
            refused(run('NewProxy', honest({ locations: undefined })), /must list the paths/);
            refused(run('NewProxy', honest({ locations: ['/_enig/'] })), /not one a BBS may serve/);
            refused(run('NewProxy', honest({ locations: ['/assets'] })), /not one a BBS may serve/);
            refused(run('NewProxy', honest({ locations: ['/ws', '/admin'] })), /\/admin/);
            refused(run('NewProxy', honest({ locations: ['/assets/../admin'] })), /not one a BBS may serve/);
            refused(run('NewProxy', honest({ locations: [42] })), /not one a BBS may serve/);
        });

        it('refuses TCP and other proxy types', () => {
            refused(
                run(
                    'NewProxy',
                    honest({
                        proxy_type: 'tcp',
                        subdomain: undefined,
                        locations: undefined,
                        remote_port: 7022,
                    })
                ),
                /remote_port|type tcp/
            );
            refused(run('NewProxy', honest({ proxy_type: 'tcp' })), /type tcp/);
            refused(run('NewProxy', honest({ proxy_type: 'https' })), /type https/);
        });

        it('refuses custom domains and other routing options', () => {
            refused(run('NewProxy', honest({ custom_domains: ['coolbbs.hub.test'] })), /custom_domains/);
            refused(run('NewProxy', honest({ group: 'g', group_key: 'k' })), /group/);
            refused(run('NewProxy', honest({ http_user: 'u', http_pwd: 'p' })), /http_user/);
            refused(
                run('NewProxy', honest({ host_header_rewrite: 'other.hub.test' })),
                /host_header_rewrite/
            );
            refused(run('NewProxy', honest({ route_by_http_user: 'u' })), /route_by_http_user/);
            refused(
                run('NewProxy', honest({ response_headers: { 'set-cookie': 'x=1' } })),
                /response_headers/
            );
            refused(run('NewProxy', honest({ some_future_option: 'on' })), /some_future_option/);
        });

        it('ignores options left empty', () => {
            assert.equal(
                run(
                    'NewProxy',
                    honest({ custom_domains: [], group: '', use_encryption: false, remote_port: 0 })
                ).reject,
                false
            );
        });

        it('checks the token again: rotation and suspension stop new proxies at once', () => {
            registry.rotateToken('coolbbs');
            refused(run('NewProxy', honest()), /wrong token/);
            assert.equal(registry.mustGet('coolbbs').connected, false);
        });
    });

    describe('CloseProxy and Ping', () => {
        it('records a closed proxy', () => {
            run('NewProxy', honest());
            assert.equal(run('CloseProxy', { user: user(), proxy_name: 'coolbbs.web' }).reject, false);
            assert.equal(registry.mustGet('coolbbs').connected, false);
        });

        it('ignores closes for unknown BBSes', () => {
            assert.equal(run('CloseProxy', { user: user('nobody'), proxy_name: 'nobody.web' }).reject, false);
        });

        it('a ping from a suspended BBS is refused', () => {
            assert.equal(run('Ping', { user: user() }).reject, false);
            registry.setState('coolbbs', 'suspended');
            refused(run('Ping', { user: user() }), /suspended/);
        });
    });

    it('refuses operations it does not handle, and junk', () => {
        refused(run('NewWorkConn', { user: user() }), /not handled/);
        refused(run('NewProxy', null), /Unknown BBS/);
        refused(run('NewProxy', 'junk'), /Unknown BBS/);
        refused(run('Login', []), /Unknown BBS/);
    });
});
