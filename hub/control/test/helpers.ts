import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

//  A made-up PSF2 font, 8 by 16, written into dir: the full block (219) all
//  set, everything else empty but for its top row
export function testFont(dir: string): string {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x864ab572, 0);
    header.writeUInt32LE(32, 8);
    header.writeUInt32LE(256, 16);
    header.writeUInt32LE(16, 20);
    header.writeUInt32LE(16, 24);
    header.writeUInt32LE(8, 28);
    const glyphs = Buffer.alloc(256 * 16);
    glyphs.fill(0xff, 219 * 16, 220 * 16);
    for (let g = 0; g < 256; g++) {
        if (32 !== g && 219 !== g) {
            glyphs[g * 16] = 0xff;
        }
    }
    const path = join(dir, 'font.psf');
    writeFileSync(path, Buffer.concat([header, glyphs]));
    return path;
}
