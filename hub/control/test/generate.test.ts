import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentConfig, caddyfile, frpsConfig } from '../src/generate.ts';
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

    it('puts the odd-path rule first in the edge', () => {
        const text = caddyfile(config);
        const route = text.indexOf('route {');
        const odd = text.indexOf('handle @odd');
        assert.ok(route > 0 && odd > route, 'inside the ordered route block');
        for (const other of ['handle @hub', 'handle @did', 'handle @root', 'handle @bbs']) {
            assert.ok(text.indexOf(other) > odd, other);
        }
        assert.match(text, /ask http:\/\/127\.0\.0\.1:7200\/tls\/allowed/);
        assert.match(text, /header_up -X-Real-IP/);
        assert.match(text, /tls internal/);
    });

    it('uses public on-demand certificates outside development', () => {
        const text = caddyfile({ ...config, edge: { ...config.edge, tls: 'onDemand' } });
        assert.doesNotMatch(text, /internal|skip_install_trust/);
        assert.match(text, /tls \{\n\t\ton_demand/);
    });
});
