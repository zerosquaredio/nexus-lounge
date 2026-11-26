import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentConfig, caddyfile, CookieDomainRe2, frpsConfig, ViewCookieRe2 } from '../src/generate.ts';
import { ViewCookie } from '../src/views.ts';
import { makeConfig } from '../src/config.ts';
import { AllowedLocations } from '../src/rules.ts';
import { testConfig } from './helpers.ts';

describe('generated configs', () => {
    const config = testConfig();

    it('gives the agent its token, its own subdomain, and only allowed paths', () => {
        const text = agentConfig(config, { name: 'coolbbs', token: 'hub_secret' });
        assert.match(text, /^user = "coolbbs"$/m);
        assert.match(text, /^metadatas\.token = "hub_secret"$/m);
        assert.match(text, /^transport\.tls\.enable = true$/m);
        const subdomains = [...text.matchAll(/^subdomain = "(.*)"$/gm)].map(m => m[1]);
        assert.deepEqual(subdomains, ['coolbbs', 'coolbbs']);
        for (const m of text.matchAll(/^locations = \[(.*)\]$/gm)) {
            for (const location of JSON.parse(`[${m[1]}]`)) {
                assert.ok(AllowedLocations.includes(location), location);
            }
        }
        //  every proxy tells the BBS the visitor came over https
        assert.equal([...text.matchAll(/x-forwarded-proto = "https"/g)].length, 2);
    });

    it("names the hub's site and the board's address, for the board's setup", () => {
        const text = agentConfig(config, { name: 'coolbbs', token: 't' });
        assert.match(text, new RegExp(`^#  hub: ${config.site.publicUrl.replace(/[.]/g, '\\.')}$`, 'm'));
        assert.match(text, /^#  address: https:\/\/coolbbs\.hub\.test$/m);
    });

    it('uses the given local ports', () => {
        const text = agentConfig(config, { name: 'coolbbs', token: 't', webPort: 9080, wsPort: 9810 });
        assert.match(text, /localPort = 9810/);
        assert.match(text, /localPort = 9080/);
    });

    it('points the tunnel server at the hook, and forces TLS', () => {
        const text = frpsConfig(config);
        assert.match(text, /^subDomainHost = "hub\.test"$/m);
        assert.match(text, /^addr = "127\.0\.0\.1:7200"$/m);
        assert.match(text, /^path = "\/frp\/handler"$/m);
        assert.match(text, /^transport\.tls\.force = true$/m);
        assert.match(text, /^proxyBindAddr = "127\.0\.0\.1"$/m);
    });

    it('has agents send heartbeats, and the tunnel server close a tunnel with none accepted', () => {
        const agent = agentConfig(config, { name: 'coolbbs', token: 't' });
        assert.match(agent, /^transport\.heartbeatInterval = 20$/m);
        assert.match(agent, /^transport\.heartbeatTimeout = 60$/m);
        assert.match(frpsConfig(config), /^transport\.heartbeatTimeout = 60$/m);
        const quick = makeConfig({ tunnel: { heartbeatSeconds: 5 } });
        assert.match(agentConfig(quick, { name: 'coolbbs', token: 't' }), /heartbeatInterval = 5$/m);
        assert.match(frpsConfig(quick), /^transport\.heartbeatTimeout = 15$/m);
        assert.throws(() => makeConfig({ tunnel: { heartbeatSeconds: 0 } }), /heartbeatSeconds/);
    });

    it("takes a bandwidth limit in frp's terms, or none", () => {
        assert.equal(makeConfig({}).tunnel.bandwidthLimit, '1MB');
        assert.equal(makeConfig({ tunnel: { bandwidthLimit: '' } }).tunnel.bandwidthLimit, '');
        assert.equal(makeConfig({ tunnel: { bandwidthLimit: '750KB' } }).tunnel.bandwidthLimit, '750KB');
        for (const bad of ['1GB', '1 mb', 'lots', '0MB']) {
            assert.throws(() => makeConfig({ tunnel: { bandwidthLimit: bad } }), /bandwidthLimit/, bad);
        }
    });

    it('opens the admin API on this machine only, its password from the environment', () => {
        const text = frpsConfig(config);
        assert.match(text, /^webServer\.addr = "127\.0\.0\.1"$/m);
        assert.match(text, /^webServer\.port = 7400$/m);
        assert.match(text, /^webServer\.password = "\{\{ \.Envs\.HUB_FRPS_ADMIN_PASSWORD \}\}"$/m);
    });

    it('puts the odd-path rule first in the edge', () => {
        const text = caddyfile(config);
        const route = text.indexOf('route {');
        const odd = text.indexOf('handle @odd');
        assert.ok(route > 0 && odd > route, 'inside the ordered route block');
        for (const other of ['handle @hub', 'handle @did', 'handle @hubpage', 'handle @bbs']) {
            assert.ok(text.indexOf(other) > odd, other);
        }
        assert.match(text, /ask http:\/\/127\.0\.0\.1:7200\/tls\/allowed/);
        assert.match(text, /header_up -X-Real-IP/);
        assert.match(text, /handle @hub \{\n\t+reverse_proxy 127\.0\.0\.1:7210/);
        assert.match(text, /tls internal/);
        //  a BBS's page at its own address uses the hub's VGA font
        assert.match(text, /@hubpage path \/ \/fonts\/vga-8x16\.woff \/_enig\/ws-term /);
    });

    it("keeps the hub's view cookie from BBSes, and passes their own on", () => {
        const text = caddyfile(config);
        const bbs = text.slice(text.indexOf('handle @bbs'), text.indexOf('handle {', text.indexOf('handle @bbs')));
        assert.ok(bbs.includes(`header_up Cookie ${ViewCookieRe2} ""`));
        assert.ok(ViewCookieRe2.includes(`${ViewCookie}=`), 'the cookie the site sets');
        const re = new RegExp(ViewCookieRe2.slice(1, -1), 'g');
        //  Caddy's replacement, then what a server reads: names and values
        const seen = (cookie: string) =>
            cookie
                .replace(re, '')
                .split(';')
                .map(c => c.trim())
                .filter(Boolean);
        assert.deepEqual(seen('hub_view=bbs'), []);
        assert.deepEqual(seen('hub_view=bbs; enig_session=abc'), ['enig_session=abc']);
        assert.deepEqual(seen('enig_session=abc; hub_view=pink; other=1'), ['enig_session=abc', 'other=1']);
        assert.deepEqual(seen('enig_session=abc; hub_view=bbs'), ['enig_session=abc']);
        //  a BBS's own cookie that only ends in the name is left alone
        assert.deepEqual(seen('my_hub_view=1; a=b'), ['my_hub_view=1', 'a=b']);
    });

    it("strips the Domain from a BBS's cookies, and only a BBS's", () => {
        const text = caddyfile(config);
        const bbs = text.slice(text.indexOf('handle @bbs'), text.indexOf('handle {', text.indexOf('handle @bbs')));
        assert.ok(bbs.includes(`header_down Set-Cookie ${CookieDomainRe2} ""`));
        assert.equal(text.split('header_down').length, 2, 'not on the hub\'s own site');
        //  the rule, as Caddy's RE2 would apply it to each Set-Cookie
        const re = new RegExp(CookieDomainRe2.slice(5, -1), 'gi');
        const strip = (cookie: string) => cookie.replace(re, '');
        assert.equal(strip('s=1; Domain=hub.test; Path=/; Secure'), 's=1; Path=/; Secure');
        assert.equal(strip('s=1; Path=/; domain = .hub.test'), 's=1; Path=/');
        assert.equal(strip('s=1; HttpOnly; DOMAIN=hub.test; SameSite=Lax'), 's=1; HttpOnly; SameSite=Lax');
        assert.equal(strip('s=1; Path=/; HttpOnly'), 's=1; Path=/; HttpOnly');
        //  a value that only mentions domain is left alone
        assert.equal(strip('domain=x; Path=/'), 'domain=x; Path=/');
    });

    it('has agents check the hub\'s certificate when it has a public one', () => {
        const plain = agentConfig(config, { name: 'coolbbs', token: 't' });
        assert.doesNotMatch(plain, /useSystemCa|serverName/);
        assert.match(plain, /no certificate for agents to check/);
        assert.doesNotMatch(frpsConfig(config), /certFile/);

        const real = makeConfig({
            domain: 'hub.example',
            tunnel: { publicAddr: 'hub.example', tlsCertFile: '/etc/hub/tunnel.crt', tlsKeyFile: '/etc/hub/tunnel.key' },
        });
        const agent = agentConfig(real, { name: 'coolbbs', token: 't' });
        assert.match(agent, /^transport\.tls\.serverName = "hub\.example"$/m);
        assert.match(agent, /^transport\.tls\.useSystemCa = true$/m);
        assert.ok(agent.indexOf('useSystemCa') < agent.indexOf('[[proxies]]'), 'a top-level setting');
        const frps = frpsConfig(real);
        assert.match(frps, /^transport\.tls\.certFile = "\/etc\/hub\/tunnel\.crt"$/m);
        assert.match(frps, /^transport\.tls\.keyFile = "\/etc\/hub\/tunnel\.key"$/m);

        //  agents given an IP address still expect the hub's name
        const byIp = makeConfig({ ...real, tunnel: { ...real.tunnel, publicAddr: '203.0.113.7' } });
        assert.match(agentConfig(byIp, { name: 'coolbbs', token: 't' }), /serverName = "hub\.example"/);
        assert.throws(() => makeConfig({ tunnel: { tlsCertFile: '/x.crt' } }), /both or neither/);
    });

    it('uses public on-demand certificates outside development', () => {
        const text = caddyfile({ ...config, edge: { ...config.edge, tls: 'onDemand' } });
        assert.doesNotMatch(text, /internal|skip_install_trust/);
        assert.match(text, /tls \{\n\t\ton_demand/);
    });
});
