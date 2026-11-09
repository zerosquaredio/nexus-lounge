import { makeConfig } from '../src/config.ts';
import { Registry } from '../src/registry.ts';

export const SysopDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
export const OtherSysopDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
export const BbsDid = 'did:plc:cccccccccccccccccccccccc';

export function testConfig() {
    return makeConfig({ domain: 'hub.test', database: ':memory:' });
}

export function testRegistry(now?: () => Date): Registry {
    const config = testConfig();
    return new Registry(':memory:', { ...config.registration, now });
}
