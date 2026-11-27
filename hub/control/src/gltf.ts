//  The checker for 3D models (build spec of the 3D slice, §4, decisions 3,
//  4 and 5): a pure function of a binary glTF file's bytes. Every byte
//  comes from outside, so this is the security boundary of the slice: it
//  reads nothing it has not first checked against the real bytes, follows
//  no reference it has not found in range, and refuses with a HubError
//  whatever it does not understand.
//
//  What comes out is not the file that went in. The JSON is read and
//  written again (so the viewer is given exactly what was checked: one
//  reading of repeated keys, no stray spacing), each picture inside is
//  rewritten without its metadata and without anything after its end, and
//  the binary chunk is put together again around the smaller pictures.
//  Extensions the hub does not take are taken out of the JSON wherever
//  they are (decision 3: they are ignored), since the viewer's loader acts
//  on many of them whether a model requires them or not, and nothing here
//  has checked what they say. The rest of the scene is not touched. The
//  cleaned file is checked a second time before it is returned, and must
//  come out of that byte for byte the same, so what the hub serves is
//  always a file it would take.
//
//  The figures are the hub's own, measured here; nothing a record says
//  about a model is believed.
//
//  What it cannot do, short of decoding and encoding every picture again
//  (which decision 5 leaves out of this slice): bytes may still be hidden
//  in a JPEG's compressed scan, in the values of its tables, and in a
//  colour profile's own tags. A PNG's pixels are unpacked and must be
//  exactly the picture's size, so nothing can follow them. Bytes of the
//  binary chunk that no buffer view covers are copied as they are.

import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { HubError } from './errors.ts';

export interface ModelBudget {
    fileBytes: number; //  the whole file
    jsonBytes: number; //  its JSON chunk
    //  triangles, and the points and lines drawn in their place, once for
    //  each node that shows them
    triangles: number;
    drawCalls: number; //  primitives, once for each node that shows them
    textureBytes: number; //  all pictures together, as cleaned
    textureSide: number; //  pixels, the longer side of any picture
    //  Pixels of all pictures together, as the viewer unpacks them: each
    //  image once for every texture that shows it, since a small file can
    //  name one picture many times and each is unpacked on its own
    texturePixels: number;
    bones: number; //  joints
    //  Nodes, whether or not a scene shows them: the viewer makes an object
    //  of each
    nodes: number;
    //  Morph targets of any one primitive. The viewer lays them all out in
    //  one table for each primitive, a row of every vertex for each target,
    //  so all of a model's together are held to as many vertices as its
    //  triangles could have, times this
    morphTargets: number;
    //  Attributes of any one primitive, and of any one of its morph
    //  targets: the viewer hands each to the graphics card
    attributes: number;
    animations: number;
    animationSeconds: number; //  the longest any one may run
    //  Channels of any one animation, and its samplers the same: the
    //  viewer makes a track of each channel
    animationChannels: number;
    extensions: readonly string[]; //  those a model may require
}

//  The material effects a model may use, each with the texture entries
//  its own data names. Those are references by place in the model's list
//  of textures, so each is held in range as a core material's are.
export const EffectTextures: Readonly<Record<string, readonly string[]>> = {
    KHR_materials_clearcoat: ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture'],
    KHR_materials_sheen: ['sheenColorTexture', 'sheenRoughnessTexture'],
    KHR_materials_transmission: ['transmissionTexture'],
    KHR_materials_volume: ['thicknessTexture'],
    KHR_materials_iridescence: ['iridescenceTexture', 'iridescenceThicknessTexture'],
    KHR_materials_specular: ['specularTexture', 'specularColorTexture'],
};

//  Class "light" (decision 4): provisional numbers, set without data and
//  to be tried (trials.md §2). A megabyte here is 1024 * 1024 bytes. A
//  caller overrides any of them with { ...LightBudget, fileBytes: n }.
export const LightBudget: ModelBudget = {
    fileBytes: 8 * 1024 * 1024,
    jsonBytes: 1024 * 1024,
    triangles: 30000,
    drawCalls: 32,
    textureBytes: 4 * 1024 * 1024,
    textureSide: 1024,
    //  eight pictures of the largest size: about 32 MB unpacked. Not in
    //  decision 4; a first guess like the rest
    texturePixels: 8 * 1024 * 1024,
    bones: 64,
    //  these two are not in decision 4 either
    nodes: 1000,
    morphTargets: 8,
    attributes: 16, //  nor this
    animations: 16,
    animationSeconds: 60,
    animationChannels: 64, //  nor this
    //  decision 3: none of the compressed formats, which need a decoder
    //  running in the page
    extensions: [
        'KHR_materials_unlit',
        'KHR_materials_emissive_strength',
        'KHR_texture_transform',
        'KHR_mesh_quantization',
        //  Material effects, allowed 2026-11-26 as safe to take; what they
        //  cost a viewer to draw is still to be tried (trials.md §2), and a
        //  limit on how many one model uses may follow
        ...Object.keys(EffectTextures),
    ],
};

export interface ModelFigures {
    bytes: number; //  of the cleaned file
    triangles: number;
    drawCalls: number;
    bones: number;
    textureBytes: number;
    maxTextureSide: number;
    texturePixels: number;
    //  A name is at most 64 characters, with no control or direction
    //  characters in it. It is still text from outside: whoever shows it
    //  must escape it.
    animations: { name: string; seconds: number }[];
    //  The material effects (EffectTextures) the model's materials use, in
    //  order of name: each makes it dearer to draw
    effects: string[];
}

export interface CheckedModel {
    cleaned: Buffer;
    sha256: string; //  of cleaned, in hex
    measured: ModelFigures;
}

type Json = Record<string, unknown>;

const GlbMagic = 0x46546c67; //  "glTF"
const ChunkJson = 0x4e4f534a; //  "JSON"
const ChunkBin = 0x004e4942; //  "BIN\0"

//  how deep the JSON may nest; a real model's is under ten
const MaxDepth = 64;
//  Names no object in the JSON may have for a key: the ones every object
//  in the viewer's language answers to already, which a page reading the
//  model could take for the model's own
const KeysRefused = new Set(['__proto__', 'constructor', 'prototype']);
//  how long an animation's name may be, in characters
const MaxName = 64;
//  what a name may not have in it: control characters, the invisible ones
//  that turn text round or join it, line breaks, halves of characters and
//  private ones
const NameRefused = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function refuse(reason: string): never {
    throw new HubError('asset', reason);
}

//  a name from the file, made safe to put in a reason
function quoted(value: string): string {
    return value.slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
}

//  ---- the container ----

function readContainer(bytes: Buffer, budget: ModelBudget): { text: Buffer; bin: Buffer | undefined } {
    if (bytes.length > budget.fileBytes) {
        refuse(`a model of ${bytes.length} bytes, over the limit of ${budget.fileBytes}`);
    }
    if (bytes.length < 20) {
        refuse('a file too short to be a model');
    }
    if (GlbMagic !== bytes.readUInt32LE(0)) {
        refuse('a file that is not binary glTF');
    }
    const version = bytes.readUInt32LE(4);
    if (2 !== version) {
        refuse(`binary glTF of version ${version}, where the hub takes version 2`);
    }
    const declared = bytes.readUInt32LE(8);
    if (declared > bytes.length) {
        refuse('a model shorter than the length it declares');
    }
    if (declared < bytes.length) {
        refuse('bytes after the length the model declares');
    }

    const jsonLength = bytes.readUInt32LE(12);
    if (ChunkJson !== bytes.readUInt32LE(16)) {
        refuse('a model whose first chunk is not its JSON');
    }
    if (jsonLength > bytes.length - 20) {
        refuse('a chunk that runs past the end of the file');
    }
    if (0 !== jsonLength % 4) {
        refuse('a chunk not padded to four bytes');
    }
    if (0 === jsonLength) {
        refuse('a model with no JSON');
    }
    if (jsonLength > budget.jsonBytes) {
        refuse(`JSON of ${jsonLength} bytes, over the limit of ${budget.jsonBytes}`);
    }
    const text = bytes.subarray(20, 20 + jsonLength);

    const next = 20 + jsonLength;
    if (next === bytes.length) {
        return { text, bin: undefined };
    }
    if (bytes.length - next < 8) {
        refuse('bytes after the JSON that are not a chunk');
    }
    const binLength = bytes.readUInt32LE(next);
    if (ChunkBin !== bytes.readUInt32LE(next + 4)) {
        refuse('a second chunk that is not the binary one');
    }
    if (binLength > bytes.length - next - 8) {
        refuse('a chunk that runs past the end of the file');
    }
    if (0 !== binLength % 4) {
        refuse('a chunk not padded to four bytes');
    }
    if (next + 8 + binLength !== bytes.length) {
        refuse('more chunks than the JSON and one binary chunk');
    }
    return { text, bin: bytes.subarray(next + 8, next + 8 + binLength) };
}

function pad4(data: Buffer, fill: number): Buffer {
    const over = data.length % 4;
    return 0 === over ? data : Buffer.concat([data, Buffer.alloc(4 - over, fill)]);
}

function packGlb(json: Json, bin: Buffer | undefined): Buffer {
    const parts: Buffer[] = [Buffer.alloc(12)];
    const add = (type: number, data: Buffer): void => {
        const head = Buffer.alloc(8);
        head.writeUInt32LE(data.length, 0);
        head.writeUInt32LE(type, 4);
        parts.push(head, data);
    };
    add(ChunkJson, pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20));
    if (bin) {
        add(ChunkBin, pad4(bin, 0));
    }
    const glb = Buffer.concat(parts);
    glb.writeUInt32LE(GlbMagic, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    return glb;
}

//  ---- the JSON ----

function isObject(value: unknown): value is Json {
    return 'object' === typeof value && null !== value && !Array.isArray(value);
}

function objectOf(value: unknown, what: string): Json {
    if (!isObject(value)) {
        refuse(`${what} that is not an object`);
    }
    return value;
}

//  a list of objects, or none if it is left out
function objectsOf(value: unknown, what: string): Json[] {
    if (undefined === value) {
        return [];
    }
    if (!Array.isArray(value)) {
        refuse(`something other than a list where ${what} is listed`);
    }
    for (const item of value) {
        objectOf(item, what);
    }
    return value as Json[];
}

function listOf(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) {
        refuse(`${what} that is not a list`);
    }
    return value;
}

//  a count, a length or an offset: a whole number, not negative, and small
//  enough to be held exactly
function whole(value: unknown, what: string): number {
    if ('number' !== typeof value || !Number.isSafeInteger(value) || value < 0) {
        refuse(`${what} that is not a whole number`);
    }
    return value;
}

//  a reference: the place of something in a list of |count|
function indexInto(value: unknown, count: number, what: string): number {
    const index = whole(value, what);
    if (index >= count) {
        refuse(`${what} that points at nothing (${index})`);
    }
    return index;
}

function optionalIndex(value: unknown, count: number, what: string): number | undefined {
    return undefined === value ? undefined : indexInto(value, count, what);
}

function readJson(text: Buffer): Json {
    let decoded: string;
    try {
        //  the mark some editors put first is kept, and so refused as JSON
        decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(text);
    } catch {
        refuse('JSON that is not UTF-8');
    }
    let json: unknown;
    try {
        json = JSON.parse(decoded);
    } catch {
        refuse('JSON that cannot be read');
    }
    //  Every value, without recursion: nothing nested deeper than a model
    //  needs, no number too large to hold (1e999 reads as infinity, and
    //  would be written back as null), and no key that is a name objects
    //  have of their own
    const values: unknown[] = [json];
    const depths: number[] = [0];
    while (values.length > 0) {
        const value = values.pop();
        const depth = depths.pop()!;
        if ('number' === typeof value) {
            if (!Number.isFinite(value)) {
                refuse('a number in the JSON too large to hold');
            }
        } else if ('object' === typeof value && null !== value) {
            if (depth >= MaxDepth) {
                refuse('JSON nested too deep');
            }
            if (!Array.isArray(value)) {
                for (const key of Object.keys(value)) {
                    if (KeysRefused.has(key)) {
                        refuse(`a name in the JSON that the hub does not take (${key})`);
                    }
                }
            }
            for (const inner of Array.isArray(value) ? value : Object.values(value)) {
                values.push(inner);
                depths.push(depth + 1);
            }
        }
    }
    return objectOf(json, 'a model');
}

//  ---- pictures ----

interface Picture {
    cleaned: Buffer;
    mediaType: string;
    width: number;
    height: number;
}

//  Called with a picture's size as soon as its header has said it, before
//  anything is unpacked: it refuses a picture over the budget.
type Admit = (width: number, height: number) => void;

//  Whether bytes are a colour profile: one that says its own length and
//  carries the profile's mark. What its tags hold is not read.
function isColourProfile(profile: Buffer): boolean {
    return (
        profile.length >= 128 &&
        profile.readUInt32BE(0) === profile.length &&
        'acsp' === profile.toString('latin1', 36, 40)
    );
}

//  the largest colour profile taken, unpacked
const MaxProfile = 1024 * 1024;
//  And the most that is unpacked in looking for colour profiles, in all
//  the pictures of a model together. A few bytes can unpack to a thousand
//  times as many, and a file can hold thousands of such, so what is spent
//  on them is counted, whether a profile came of it or not.
const MaxProfiles = 4 * MaxProfile;

//  what is left of that for the pictures still to be read
interface ProfileAllowance {
    left: number;
}

//  Packed bytes unpacked, if they are one whole stream of at most |limit|
//  bytes with nothing after it.
function unpack(packed: Buffer, limit: number): Buffer | undefined {
    try {
        //  with info, the result carries how many bytes the stream took
        const result = inflateSync(packed, { info: true, maxOutputLength: limit }) as unknown as {
            buffer: Buffer;
            engine: { bytesWritten: number };
        };
        return result.engine.bytesWritten === packed.length ? result.buffer : undefined;
    } catch {
        return undefined;
    }
}

const PngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
//  What a PNG may keep besides its header, palette, pixels and end: its
//  transparency, and how its colours are to be read. Each at most once,
//  before the pixels, of the shape it should have; one that is not is
//  left out, like every other part a reader may skip.
const PngOptional = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP']);
//  the bit depths each colour type may have, and its channels
const PngColours = new Map<number, { depths: number[]; channels: number }>([
    [0, { depths: [1, 2, 4, 8, 16], channels: 1 }],
    [2, { depths: [8, 16], channels: 3 }],
    [3, { depths: [1, 2, 4, 8], channels: 1 }],
    [4, { depths: [8, 16], channels: 2 }],
    [6, { depths: [8, 16], channels: 4 }],
]);
//  the seven passes of an interlaced PNG: where each starts and its steps
const PngPasses = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
] as const;

//  the rows a PNG's pixels unpack to: how many, and the bytes of each
//  after the one that says how it is filtered
function pngRows(width: number, height: number, bits: number, interlaced: boolean): [number, number][] {
    if (!interlaced) {
        return [[height, Math.ceil((width * bits) / 8)]];
    }
    const rows: [number, number][] = [];
    for (const [x, y, dx, dy] of PngPasses) {
        const across = Math.ceil((width - x) / dx);
        const down = Math.ceil((height - y) / dy);
        if (across > 0 && down > 0) {
            rows.push([down, Math.ceil((across * bits) / 8)]);
        }
    }
    return rows;
}

//  whether an optional part of a PNG is of the shape it should have
function pngPartHolds(
    type: string,
    body: Buffer,
    colour: number,
    palette: number,
    profiles: ProfileAllowance
): boolean {
    switch (type) {
        case 'gAMA':
            return 4 === body.length;
        case 'cHRM':
            return 32 === body.length;
        case 'sRGB':
            return 1 === body.length && body[0]! <= 3;
        case 'tRNS':
            //  one grey, one colour, or a value for each of the palette's
            return 0 === colour
                ? 2 === body.length
                : 2 === colour
                  ? 6 === body.length
                  : 3 === colour && body.length >= 1 && body.length <= palette;
        default: {
            //  iCCP: a name, a nought, how it is packed, and the profile
            const named = body.indexOf(0);
            if (named < 1 || named > 79 || 0 !== body[named + 1]) {
                return false;
            }
            //  one that fails is taken to have cost all it was allowed
            const limit = Math.min(MaxProfile, profiles.left);
            if (limit < 128) {
                return false;
            }
            const profile = unpack(body.subarray(named + 2), limit);
            profiles.left -= profile ? profile.length : limit;
            return undefined !== profile && isColourProfile(profile);
        }
    }
}

//  A PNG without its text, EXIF, times and anything else it can be shown
//  without, and without what follows its end. The parts kept are copied
//  as they are, so the pixels cannot change; but each is held to its
//  check and its shape, and the pixels are unpacked to see that they are
//  exactly the picture the header describes, so that what is served is a
//  picture a browser will show, with nothing riding along in it.
function cleanPng(data: Buffer, admit: Admit, profiles: ProfileAllowance): Picture {
    const parts: Buffer[] = [PngSignature];
    const pixels: Buffer[] = [];
    const seen = new Set<string>();
    let profiled = false; //  whether a colour profile has been unpacked
    let width = 0;
    let height = 0;
    let colour = 0;
    let bits = 0; //  of one pixel
    let interlaced = false;
    let palette = 0; //  how many colours, once there is one
    for (let at = 8, first = true; ; first = false) {
        if (data.length - at < 12) {
            refuse('a PNG that is cut short');
        }
        const length = data.readUInt32BE(at);
        if (length > data.length - at - 12) {
            refuse('a PNG that is cut short');
        }
        const type = data.toString('latin1', at + 4, at + 8);
        if (!/^[A-Za-z]{4}$/.test(type)) {
            refuse('a PNG with a damaged part');
        }
        const end = at + 12 + length;
        const body = data.subarray(at + 8, end - 4);
        const sound = crc32(data.subarray(at + 4, end - 4)) === data.readUInt32BE(end - 4);
        const whole = data.subarray(at, end);
        at = end;
        if (first) {
            if ('IHDR' !== type || 13 !== length) {
                refuse('a PNG without its header');
            }
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            if (0 === width || 0 === height) {
                refuse('a PNG of no size');
            }
            admit(width, height);
            colour = body[9]!;
            const kind = PngColours.get(colour);
            //  no way of packing or filtering but the one there is
            if (
                !sound ||
                !kind?.depths.includes(body[8]!) ||
                0 !== body[10] ||
                0 !== body[11] ||
                body[12]! > 1
            ) {
                refuse('a PNG whose header is damaged');
            }
            bits = body[8]! * kind.channels;
            interlaced = 1 === body[12];
            parts.push(whole);
        } else if ('IHDR' === type) {
            refuse('a PNG with two headers');
        } else if ('IDAT' === type) {
            if (!sound) {
                refuse('a PNG with a damaged part');
            }
            if (3 === colour && 0 === palette) {
                refuse('a PNG without its palette');
            }
            pixels.push(body);
            parts.push(whole);
        } else if ('IEND' === type) {
            if (!sound || 0 !== length) {
                refuse('a PNG with a damaged part');
            }
            parts.push(whole);
            break;
        } else if ('PLTE' === type) {
            if (
                !sound ||
                palette > 0 ||
                pixels.length > 0 ||
                0 === length ||
                0 !== length % 3 ||
                length > 768
            ) {
                refuse('a PNG whose palette is damaged or out of place');
            }
            palette = length / 3;
            //  kept only where the pixels are drawn from it; elsewhere it
            //  is a suggestion no browser needs
            if (3 === colour) {
                if (palette > 2 ** bits) {
                    refuse('a PNG whose palette is damaged or out of place');
                }
                parts.push(whole);
            }
        } else if (PngOptional.has(type)) {
            //  the colour notes come before the palette and transparency
            //  after it; and of a profile and the note that the colours
            //  are the usual ones, only the first is kept
            const kind = 'iCCP' === type ? 'sRGB' : type;
            const placed = 0 === pixels.length && ('tRNS' === type || 0 === palette);
            let wanted = sound && placed && !seen.has(kind);
            //  A profile has to be unpacked to be looked at, so only the
            //  first of a picture ever is: one that fails is not tried
            //  again with the next, however many follow
            if (wanted && 'iCCP' === type) {
                wanted = !profiled;
                profiled = true;
            }
            if (wanted && pngPartHolds(type, body, colour, palette, profiles)) {
                seen.add(kind);
                parts.push(whole);
            }
        } else if (type < 'a') {
            //  a capital first letter: a part no reader may skip
            refuse(`a PNG with a part the hub does not know (${type})`);
        }
    }
    if (0 === pixels.length) {
        refuse('a PNG without a picture in it');
    }
    //  The pixels, unpacked: every row the header promises and not a byte
    //  more, each filtered in a way there is. The size was admitted above,
    //  so this is bounded by the budget.
    const rows = pngRows(width, height, bits, interlaced);
    const expected = rows.reduce((sum, [count, bytes]) => sum + count * (1 + bytes), 0);
    const raw = unpack(Buffer.concat(pixels), expected);
    if (!raw || raw.length !== expected) {
        refuse('a PNG whose pixels are not the picture its header describes');
    }
    let row = 0;
    for (const [count, bytes] of rows) {
        for (let n = 0; n < count; n++, row += 1 + bytes) {
            if (raw[row]! > 4) {
                refuse('a PNG whose pixels are not the picture its header describes');
            }
        }
    }
    return { cleaned: Buffer.concat(parts), mediaType: 'image/png', width, height };
}

function startsWith(data: Buffer, text: string): boolean {
    return data.length >= text.length && text === data.toString('latin1', 0, text.length);
}

function jpegSegment(marker: number, body: Buffer): Buffer {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
}

//  Whether a JPEG's tables are whole tables and nothing more. Quantization
//  tables (|huffman| false) are 64 numbers of one or two bytes each;
//  Huffman tables are sixteen counts and then that many symbols.
function jpegTablesHold(body: Buffer, huffman: boolean): boolean {
    let at = 0;
    while (at < body.length) {
        const head = body[at]!;
        if ((head & 0x0f) > 3 || head >> 4 > 1) {
            return false;
        }
        if (huffman) {
            if (body.length - at < 17) {
                return false;
            }
            let symbols = 0;
            for (let n = 1; n <= 16; n++) {
                symbols += body[at + n]!;
            }
            if (symbols > 256) {
                return false;
            }
            at += 17 + symbols;
        } else {
            at += 0 === head >> 4 ? 65 : 129;
        }
    }
    return at === body.length && body.length > 0;
}

//  A JPEG rewritten with only the parts that are the picture: its tables,
//  its one frame, its scans, and of the application segments three, each
//  cut to the shape it should have: JFIF's header without its thumbnail,
//  a colour profile, and Adobe's note of how the colours are stored. EXIF,
//  XMP, Photoshop's, comments and the rest go, with whatever follows the
//  end marker; a part the hub does not know is refused. The tables, the
//  frame and the scans are copied as they are.
function cleanJpeg(data: Buffer, admit: Admit): Picture {
    const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
    const profile: Buffer[] = []; //  the pieces of a colour profile
    let pieces = 0; //  how many pieces it says it is in
    let width = 0;
    let height = 0;
    let frames = 0;
    let scans = 0;
    let jfif = false;
    let adobe = false;
    for (let at = 2; ;) {
        if (0xff !== data[at]) {
            refuse('a JPEG that is damaged or cut short');
        }
        while (0xff === data[at]) {
            at++;
        }
        const marker = data[at];
        at++;
        if (0xd9 === marker) {
            parts.push(Buffer.from([0xff, 0xd9]));
            break;
        }
        //  markers that stand alone have no place between segments
        if (undefined === marker || marker <= 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            refuse('a JPEG that is damaged or cut short');
        }
        if (data.length - at < 2) {
            refuse('a JPEG that is damaged or cut short');
        }
        const length = data.readUInt16BE(at);
        if (length < 2 || length > data.length - at) {
            refuse('a JPEG that is damaged or cut short');
        }
        const body = data.subarray(at + 2, at + length);
        const whole = jpegSegment(marker, body);
        at += length;

        if (marker >= 0xc0 && marker <= 0xc2) {
            //  a frame header says the size: of the kinds of JPEG, the
            //  three a browser shows
            if (++frames > 1) {
                refuse('a JPEG with more than one picture in it');
            }
            if (body.length < 6) {
                refuse('a JPEG that is damaged or cut short');
            }
            height = body.readUInt16BE(1);
            width = body.readUInt16BE(3);
            if (0 === width || 0 === height) {
                refuse('a JPEG of no size');
            }
            admit(width, height);
            const components = body[5]!;
            if (8 !== body[0] || components < 1 || components > 4 || body.length !== 6 + 3 * components) {
                refuse('a JPEG whose header is damaged');
            }
            parts.push(whole);
        } else if (marker >= 0xc3 && marker <= 0xcf && 0xc4 !== marker) {
            refuse('a JPEG of a kind browsers do not show');
        } else if (0xc4 === marker || 0xdb === marker) {
            if (!jpegTablesHold(body, 0xc4 === marker)) {
                refuse('a JPEG with a damaged table');
            }
            parts.push(whole);
        } else if (0xdd === marker) {
            if (2 !== body.length) {
                refuse('a JPEG that is damaged or cut short');
            }
            parts.push(whole);
        } else if (0xda === marker) {
            const components = body[0] ?? 0;
            if (1 !== frames || components < 1 || components > 4 || body.length !== 4 + 2 * components) {
                refuse('a JPEG whose scan is damaged or comes before its header');
            }
            scans++;
            //  the scan's data runs to the next marker that is not a
            //  stuffed byte or a restart
            const from = at;
            for (;;) {
                const found = data.indexOf(0xff, at);
                const after = found < 0 ? undefined : data[found + 1];
                if (undefined === after) {
                    refuse('a JPEG that does not end');
                }
                if (0 === after || (after >= 0xd0 && after <= 0xd7)) {
                    at = found + 2;
                } else if (0xff === after) {
                    at = found + 1;
                } else {
                    at = found;
                    break;
                }
            }
            parts.push(whole, data.subarray(from, at));
        } else if (0xe0 === marker && startsWith(body, 'JFIF\0')) {
            //  its version and the size of a pixel; a thumbnail is not kept
            if (!jfif && body.length >= 14) {
                jfif = true;
                parts.push(jpegSegment(0xe0, Buffer.concat([body.subarray(0, 12), Buffer.alloc(2)])));
            }
        } else if (0xe2 === marker && startsWith(body, 'ICC_PROFILE\0')) {
            //  a piece of a colour profile: which piece, of how many
            if (body.length < 15 || body[12] !== profile.length + 1 || (pieces > 0 && body[13] !== pieces)) {
                refuse('a JPEG whose colour profile is damaged');
            }
            pieces = body[13]!;
            profile.push(body.subarray(14));
            parts.push(whole);
        } else if (0xee === marker && startsWith(body, 'Adobe')) {
            if (!adobe && body.length >= 12) {
                adobe = true;
                parts.push(jpegSegment(0xee, body.subarray(0, 12)));
            }
        } else if (0xfe !== marker && (marker < 0xe0 || marker > 0xef)) {
            //  not a comment or an application's segment, which are left
            //  out: something the hub cannot tell is safe to leave or keep
            refuse(`a JPEG with a part the hub does not know (${marker.toString(16)})`);
        }
    }
    if (0 === frames || 0 === scans) {
        refuse('a JPEG without a picture in it');
    }
    if (profile.length !== pieces || (pieces > 0 && !isColourProfile(Buffer.concat(profile)))) {
        refuse('a JPEG whose colour profile is damaged');
    }
    return { cleaned: Buffer.concat(parts), mediaType: 'image/jpeg', width, height };
}

//  a picture is what its own bytes say it is, whatever the model calls it
function cleanPicture(data: Buffer, admit: Admit, profiles: ProfileAllowance): Picture {
    if (data.length >= 8 && data.subarray(0, 8).equals(PngSignature)) {
        return cleanPng(data, admit, profiles);
    }
    if (data.length >= 2 && 0xff === data[0] && 0xd8 === data[1]) {
        return cleanJpeg(data, admit);
    }
    refuse('an image that is neither a PNG nor a JPEG');
}

//  ---- the model ----

const ComponentBytes = new Map<unknown, number>([
    [5120, 1],
    [5121, 1],
    [5122, 2],
    [5123, 2],
    [5125, 4],
    [5126, 4],
]);
const Float = 5126;
const TypeWidths = new Map<unknown, number>([
    ['SCALAR', 1],
    ['VEC2', 2],
    ['VEC3', 3],
    ['VEC4', 4],
    ['MAT2', 4],
    ['MAT3', 9],
    ['MAT4', 16],
]);

//  the bytes of one element; the small matrices are padded so that each
//  column starts on a four-byte boundary
function elementBytes(unit: number, type: unknown, width: number): number {
    if ('MAT2' === type && 1 === unit) {
        return 8;
    }
    if ('MAT3' === type && unit < 4) {
        return 12 * unit;
    }
    return unit * width;
}

interface View {
    def: Json;
    offset: number; //  in the binary chunk
    length: number;
    stride: number; //  0 if it has none of its own
}

interface Accessor {
    count: number;
    component: unknown;
    type: unknown;
    start: number; //  of its first element, in the binary chunk
    stride: number;
    strided: boolean; //  whether its buffer view has a stride of its own
    bytes: number; //  of all its elements, without what a stride puts between
    //  whether its whole numbers stand for fractions, or it says anything
    //  on the matter that is not a plain no
    normalized: boolean;
}

//  What a primitive's attribute may be called: the names glTF gives a
//  meaning, and an application's own, which start with an underscore.
const AttributeName =
    /^(?:POSITION|NORMAL|TANGENT|(?:TEXCOORD|COLOR|JOINTS|WEIGHTS)_(?:0|[1-9][0-9]?)|_.+)$/s;

//  Extensions the hub does not take, taken out: every "extensions" entry
//  in the model, wherever it is, keeps only the allowed names, and the
//  list of those used is cut to match. What is left names nothing by its
//  place in a list, except the material effects' textures, which are held
//  in range with the materials'. Free data ("extras") is not looked into.
function withoutExtensions(json: Json, allowed: readonly string[]): void {
    if (Array.isArray(json.extensionsUsed)) {
        const used = json.extensionsUsed.filter(name => allowed.includes(name as string));
        if (used.length > 0) {
            json.extensionsUsed = used;
        } else {
            delete json.extensionsUsed;
        }
    }
    //  without recursion; the depth was held when the JSON was read
    const values: unknown[] = [json];
    while (values.length > 0) {
        const value = values.pop();
        if (Array.isArray(value)) {
            //  one at a time: a list may be longer than a call can take
            for (const inner of value) {
                if ('object' === typeof inner) {
                    values.push(inner);
                }
            }
        } else if (isObject(value)) {
            if (undefined !== value.extensions) {
                const extensions = objectOf(value.extensions, "an object's extensions");
                for (const name of Object.keys(extensions)) {
                    if (!allowed.includes(name)) {
                        delete extensions[name];
                    }
                }
                if (0 === Object.keys(extensions).length) {
                    delete value.extensions;
                }
            }
            for (const [key, inner] of Object.entries(value)) {
                if ('extras' !== key) {
                    values.push(inner);
                }
            }
        }
    }
}

//  No two buffer views may share a byte. The viewer's loader copies each
//  view out of the file, so views laid over one another would cost it the
//  same bytes many times over; apart, they come to no more than the buffer
//  together. A picture's bytes above all must be its own: the binary chunk
//  closes up behind each when it is rewritten, and a picture that many
//  views cover would be unpacked once for each. So this is held before any
//  picture is read, and a picture's sharing is named as that.
function viewsApart(views: View[], pictures: Set<number>): void {
    const order = views.map((view, at) => ({ view, picture: pictures.has(at) }));
    order.sort((a, b) => a.view.offset - b.view.offset);
    let reach = 0; //  where the views so far end
    let pictureReach = 0; //  where the pictures so far end
    for (const { view, picture } of order) {
        if (view.offset < pictureReach || (picture && view.offset < reach)) {
            refuse('an image that shares its bytes with something else');
        }
        reach = Math.max(reach, view.offset + view.length);
        if (picture) {
            pictureReach = view.offset + view.length;
        }
    }
    let end = 0; //  of the view before, which is where they all end so far
    for (const { view } of order) {
        if (view.offset < end) {
            refuse('buffer views that share bytes');
        }
        end = view.offset + view.length;
    }
}

interface Examined {
    figures: Omit<ModelFigures, 'bytes'>;
    views: View[];
    pictures: Map<number, Picture>; //  by buffer view
    buffer: Json | undefined;
    bufferLength: number;
}

function examine(json: Json, chunk: Buffer | undefined, budget: ModelBudget): Examined {
    const asset = objectOf(json.asset, "a model's asset entry");
    if ('2.0' !== asset.version) {
        refuse('a model that is not glTF version 2.0');
    }
    if (undefined !== asset.minVersion && '2.0' !== asset.minVersion) {
        refuse('a model that needs a later glTF than 2.0');
    }

    if (undefined !== json.extensionsUsed) {
        for (const name of listOf(json.extensionsUsed, "a model's extensions")) {
            if ('string' !== typeof name) {
                refuse('an extension whose name is not text');
            }
        }
    }
    if (undefined !== json.extensionsRequired) {
        for (const name of listOf(json.extensionsRequired, "a model's required extensions")) {
            if ('string' !== typeof name) {
                refuse('an extension whose name is not text');
            }
            if (!budget.extensions.includes(name)) {
                refuse(`a model that requires an extension the hub does not take (${quoted(name)})`);
            }
        }
    }
    withoutExtensions(json, budget.extensions);

    //  every list first, so that each reference below has a count to be
    //  held against
    const bufferDefs = objectsOf(json.buffers, 'a buffer');
    const viewDefs = objectsOf(json.bufferViews, 'a buffer view');
    const accessorDefs = objectsOf(json.accessors, 'an accessor');
    const imageDefs = objectsOf(json.images, 'an image');
    const samplerDefs = objectsOf(json.samplers, 'a sampler');
    const textureDefs = objectsOf(json.textures, 'a texture');
    const materialDefs = objectsOf(json.materials, 'a material');
    const meshDefs = objectsOf(json.meshes, 'a mesh');
    const cameraDefs = objectsOf(json.cameras, 'a camera');
    const nodeDefs = objectsOf(json.nodes, 'a node');
    const sceneDefs = objectsOf(json.scenes, 'a scene');
    const skinDefs = objectsOf(json.skins, 'a skin');
    const animationDefs = objectsOf(json.animations, 'an animation');

    //  ---- the bytes: one buffer, which is the binary chunk ----

    if (bufferDefs.length > 1) {
        refuse('a model with more than one buffer');
    }
    const buffer = bufferDefs[0];
    const bin = chunk ?? Buffer.alloc(0);
    let bufferLength = 0;
    if (buffer) {
        if (undefined !== buffer.uri) {
            refuse('a buffer kept outside the file (a uri), where everything must be inside it');
        }
        bufferLength = whole(buffer.byteLength, "a buffer's length");
        if (!chunk) {
            refuse('a buffer with no binary chunk to hold it');
        }
        if (bufferLength > bin.length) {
            refuse('a buffer longer than the binary chunk');
        }
        if (0 === bufferLength) {
            refuse('an empty buffer');
        }
        //  not in the format, but the viewer's loader refuses any other
        if (undefined !== buffer.type && 'arraybuffer' !== buffer.type) {
            refuse('a buffer of an unknown type');
        }
    }

    const views: View[] = viewDefs.map(def => {
        indexInto(def.buffer, bufferDefs.length, "a buffer view's buffer");
        const offset = undefined === def.byteOffset ? 0 : whole(def.byteOffset, "a buffer view's offset");
        const length = whole(def.byteLength, "a buffer view's length");
        if (0 === length) {
            refuse('an empty buffer view');
        }
        if (offset > bufferLength || length > bufferLength - offset) {
            refuse('a buffer view that runs past the end of its buffer');
        }
        let stride = 0;
        if (undefined !== def.byteStride) {
            stride = whole(def.byteStride, "a buffer view's stride");
            if (stride < 4 || stride > 252 || 0 !== stride % 4) {
                refuse(`a buffer view's stride out of range (${stride})`);
            }
        }
        return { def, offset, length, stride };
    });

    const accessors: Accessor[] = accessorDefs.map(def => {
        if (undefined !== def.sparse) {
            refuse('a sparse accessor, which the hub does not take yet');
        }
        if (undefined === def.bufferView) {
            refuse('an accessor with no buffer view');
        }
        const view = views[indexInto(def.bufferView, views.length, "an accessor's buffer view")]!;
        const unit = ComponentBytes.get(def.componentType);
        if (undefined === unit) {
            refuse('an accessor of an unknown component type');
        }
        const width = TypeWidths.get(def.type);
        if (undefined === width) {
            refuse('an accessor of an unknown type');
        }
        const count = whole(def.count, "an accessor's count");
        if (0 === count) {
            refuse('an accessor with nothing in it');
        }
        const offset = undefined === def.byteOffset ? 0 : whole(def.byteOffset, "an accessor's offset");
        const element = elementBytes(unit, def.type, width);
        const stride = view.stride || element;
        if (stride < element) {
            refuse('an accessor whose elements are larger than its stride');
        }
        //  the count is held against the real bytes before it is
        //  multiplied, so the sum cannot grow past what a number holds
        if (
            offset > view.length ||
            count > view.length ||
            offset + (count - 1) * stride + element > view.length
        ) {
            refuse('an accessor that runs past the end of its buffer view');
        }
        if (0 !== offset % unit || 0 !== (view.offset + offset) % unit) {
            refuse('an accessor off the boundary its numbers need');
        }
        //  Where a view's stride is wider than the element, the viewer
        //  reads whole strides: as many as the count, from the stride the
        //  accessor starts in. All of that must be there, and an element
        //  may not run from one stride into the next.
        if (view.stride > element) {
            const into = offset % stride;
            if (into + element > stride) {
                refuse('an accessor whose elements cross from one stride into the next');
            }
            if (offset - into + count * stride > view.length) {
                refuse('an accessor that runs past the end of its buffer view');
            }
        }
        return {
            count,
            component: def.componentType,
            type: def.type,
            start: view.offset + offset,
            stride,
            strided: view.stride > 0,
            bytes: count * element,
            normalized: undefined !== def.normalized && false !== def.normalized,
        };
    });
    const accessor = (value: unknown, what: string): Accessor =>
        accessors[indexInto(value, accessors.length, what)]!;

    //  ---- pictures, textures and materials ----

    const imageViews = imageDefs.map(def => {
        if (undefined !== def.uri) {
            refuse('an image kept outside the file (a uri), where everything must be inside it');
        }
        if (undefined === def.bufferView) {
            refuse('an image with no buffer view');
        }
        const at = indexInto(def.bufferView, views.length, "an image's buffer view");
        //  a stride is for the attributes of vertices, and nothing else
        if (views[at]!.stride > 0) {
            refuse('an image in a buffer view with a stride');
        }
        return at;
    });
    viewsApart(views, new Set(imageViews));

    //  Each picture is cleaned once, however many images name its buffer
    //  view, and held to the budget as it goes: its size before it is
    //  unpacked, its bytes before the next is read
    const pictures = new Map<number, Picture>();
    let textureBytes = 0;
    let maxTextureSide = 0;
    let unpacked = 0; //  pixels, of the pictures read so far
    const profiles: ProfileAllowance = { left: MaxProfiles };
    const admit = (width: number, height: number): void => {
        if (Math.max(width, height) > budget.textureSide) {
            refuse(
                `a texture of ${width} by ${height} pixels, over the limit of ${budget.textureSide} a side`
            );
        }
        unpacked += width * height;
        if (unpacked > budget.texturePixels) {
            refuse(`textures of ${unpacked} pixels together, over the limit of ${budget.texturePixels}`);
        }
    };
    imageDefs.forEach((def, image) => {
        const at = imageViews[image]!;
        let picture = pictures.get(at);
        if (!picture) {
            const view = views[at]!;
            picture = cleanPicture(bin.subarray(view.offset, view.offset + view.length), admit, profiles);
            pictures.set(at, picture);
            textureBytes += picture.cleaned.length;
            if (textureBytes > budget.textureBytes) {
                refuse(
                    `textures of ${textureBytes} bytes together, over the limit of ${budget.textureBytes}`
                );
            }
            maxTextureSide = Math.max(maxTextureSide, picture.width, picture.height);
        }
        if (undefined !== def.mimeType && def.mimeType !== picture.mediaType) {
            refuse('an image that is not of the type the model says');
        }
    });

    //  The viewer unpacks an image for each texture that shows it, so its
    //  pixels count once for each, and once if none does
    const shownBy = new Array<number>(imageDefs.length).fill(0);
    for (const def of textureDefs) {
        //  a texture with no image is one an extension would have given a
        //  picture of another kind; without it, there is nothing to show
        if (undefined === def.source) {
            refuse('a texture with no image');
        }
        shownBy[indexInto(def.source, imageDefs.length, "a texture's image")]!++;
        optionalIndex(def.sampler, samplerDefs.length, "a texture's sampler");
    }
    let texturePixels = 0;
    imageViews.forEach((at, image) => {
        const picture = pictures.get(at)!;
        texturePixels += picture.width * picture.height * Math.max(1, shownBy[image]!);
    });
    if (texturePixels > budget.texturePixels) {
        refuse(`textures of ${texturePixels} pixels together, over the limit of ${budget.texturePixels}`);
    }

    const effects = new Set<string>();
    const textureOf = (value: unknown): void => {
        if (undefined !== value) {
            const info = objectOf(value, "a material's texture entry");
            indexInto(info.index, textureDefs.length, "a material's texture");
        }
    };
    for (const def of materialDefs) {
        if (undefined !== def.pbrMetallicRoughness) {
            const pbr = objectOf(def.pbrMetallicRoughness, "a material's colour entry");
            textureOf(pbr.baseColorTexture);
            textureOf(pbr.metallicRoughnessTexture);
        }
        textureOf(def.normalTexture);
        textureOf(def.occlusionTexture);
        textureOf(def.emissiveTexture);
        //  (only allowed extensions are left by now)
        if (undefined !== def.extensions) {
            const extensions = objectOf(def.extensions, "a material's extensions");
            for (const [name, entries] of Object.entries(EffectTextures)) {
                if (undefined !== extensions[name]) {
                    const effect = objectOf(extensions[name], `a material's ${name} entry`);
                    for (const entry of entries) {
                        textureOf(effect[entry]);
                    }
                    effects.add(name);
                }
            }
        }
    }

    //  ---- meshes ----

    const meshes = meshDefs.map(def => {
        const primitives = objectsOf(def.primitives, 'a primitive');
        if (0 === primitives.length) {
            refuse('a mesh with nothing to draw');
        }
        let triangles = 0;
        let targets = -1; //  morph targets, the same number in each primitive
        let morphed = 0; //  vertices, once for each morph target that moves them
        const used: Accessor[] = []; //  what its primitives draw from
        const within = (named: Json, what: string): void => {
            const count = Object.keys(named).length;
            if (count > budget.attributes) {
                refuse(`${what} of ${count} attributes, over the limit of ${budget.attributes}`);
            }
        };
        const indexed: { indices: Accessor; vertices: number }[] = [];
        for (const primitive of primitives) {
            const attributes = objectOf(primitive.attributes, "a primitive's attributes");
            if (undefined === attributes.POSITION) {
                refuse('a primitive without positions');
            }
            within(attributes, 'a primitive');
            const positions = accessor(attributes.POSITION, "a primitive's accessor");
            if ('VEC3' !== positions.type) {
                refuse('positions that are not three numbers each');
            }
            for (const [name, value] of Object.entries(attributes)) {
                if (!AttributeName.test(name)) {
                    refuse(`a primitive's attribute of a name the hub does not know (${quoted(name)})`);
                }
                const attribute = accessor(value, "a primitive's accessor");
                if (attribute.count !== positions.count) {
                    refuse('a primitive whose attributes differ in length');
                }
                used.push(attribute);
            }
            let drawn = positions.count;
            if (undefined !== primitive.indices) {
                const indices = accessor(primitive.indices, "a primitive's indices");
                const unsigned =
                    5121 === indices.component || 5123 === indices.component || 5125 === indices.component;
                if ('SCALAR' !== indices.type || !unsigned) {
                    refuse('indices that are not whole numbers');
                }
                if (indices.strided) {
                    refuse('indices in a buffer view with a stride');
                }
                drawn = indices.count;
                indexed.push({ indices, vertices: positions.count });
                used.push(indices);
            }
            optionalIndex(primitive.material, materialDefs.length, "a primitive's material");
            const mode = undefined === primitive.mode ? 4 : whole(primitive.mode, "a primitive's mode");
            if (mode > 6) {
                refuse(`a primitive of an unknown mode (${mode})`);
            }
            const morphs =
                undefined === primitive.targets ? [] : objectsOf(primitive.targets, 'a morph target');
            if (morphs.length > budget.morphTargets) {
                refuse(
                    `a primitive of ${morphs.length} morph targets, over the limit of ${budget.morphTargets}`
                );
            }
            for (const target of morphs) {
                within(target, 'a morph target');
                for (const [name, value] of Object.entries(target)) {
                    if (!AttributeName.test(name)) {
                        refuse(
                            `a morph target's attribute of a name the hub does not know (${quoted(name)})`
                        );
                    }
                    const moved = accessor(value, "a morph target's accessor");
                    if (moved.count !== positions.count || ('POSITION' === name && 'VEC3' !== moved.type)) {
                        refuse('a morph target that does not fit its primitive');
                    }
                    used.push(moved);
                }
            }
            if (-1 !== targets && targets !== morphs.length) {
                refuse('a mesh whose primitives differ in their morph targets');
            }
            targets = morphs.length;
            morphed += positions.count * morphs.length;
            //  What is drawn, held to the one figure whatever its kind: a
            //  point each, a line for two (or for each one more, in a
            //  strip or a loop), a triangle for three (or for each one
            //  more, in a strip or a fan)
            triangles += [
                drawn,
                Math.floor(drawn / 2),
                drawn,
                Math.max(0, drawn - 1),
                Math.floor(drawn / 3),
                Math.max(0, drawn - 2),
                Math.max(0, drawn - 2),
            ][mode]!;
        }
        return { triangles, primitives: primitives.length, targets, morphed, indexed, used };
    });

    //  ---- nodes: a forest, each with one parent at most ----

    //  A mesh is counted once for each node that shows it, since that is
    //  what the viewer draws; one no node shows is not counted.
    if (nodeDefs.length > budget.nodes) {
        refuse(`a model of ${nodeDefs.length} nodes, over the limit of ${budget.nodes}`);
    }
    let triangles = 0;
    let drawCalls = 0;
    let morphed = 0;
    const shown = new Set<number>(); //  the meshes some node shows
    const parent = new Int32Array(nodeDefs.length).fill(-1);
    nodeDefs.forEach((def, at) => {
        const mesh = optionalIndex(def.mesh, meshes.length, "a node's mesh");
        if (undefined !== mesh) {
            triangles += meshes[mesh]!.triangles;
            drawCalls += meshes[mesh]!.primitives;
            morphed += meshes[mesh]!.morphed;
            shown.add(mesh);
        }
        optionalIndex(def.skin, skinDefs.length, "a node's skin");
        optionalIndex(def.camera, cameraDefs.length, "a node's camera");
        if (undefined !== def.children) {
            for (const value of listOf(def.children, "a node's children")) {
                const child = indexInto(value, nodeDefs.length, "a node's child");
                if (-1 !== parent[child]) {
                    refuse('a node with two parents');
                }
                parent[child] = at;
            }
        }
    });
    //  up from each node to a root, or to one already known to reach a
    //  root; meeting a node of this same walk is a ring
    const walked = new Uint8Array(nodeDefs.length);
    for (let start = 0; start < nodeDefs.length; start++) {
        const path: number[] = [];
        let at = start;
        while (-1 !== at && 0 === walked[at]) {
            walked[at] = 1;
            path.push(at);
            at = parent[at]!;
        }
        if (-1 !== at && 1 === walked[at]) {
            refuse('a node that is its own ancestor');
        }
        for (const done of path) {
            walked[done] = 2;
        }
    }

    //  these two before anything below reads as much as they allow
    if (triangles > budget.triangles) {
        refuse(`a model of ${triangles} triangles, over the limit of ${budget.triangles}`);
    }
    if (drawCalls > budget.drawCalls) {
        refuse(`a model of ${drawCalls} draw calls, over the limit of ${budget.drawCalls}`);
    }
    //  A primitive's vertices may be many more than its triangles use, and
    //  the viewer keeps a row of them all for each morph target; so those
    //  rows are held to what a model within its triangles could need
    const morphedMost = 3 * budget.triangles * budget.morphTargets;
    if (morphed > morphedMost) {
        refuse(`morph targets that move ${morphed} vertices together, over the limit of ${morphedMost}`);
    }
    //  The viewer hands the graphics card each accessor a shown primitive
    //  draws from, as an attribute, a morph target or indices: once for
    //  each accessor, however many primitives name it, but once again for
    //  every other accessor laid over the same bytes. Accessors that share
    //  nothing come to no more than the bytes of the buffer that are not
    //  pictures, the elements of an interleaved view among them. Twice
    //  that is allowed, for the models whose accessors do share some (a
    //  part of another's elements, or the same ones under two
    //  descriptions); many times over is a file made to cost the viewer
    //  far more than its size.
    const drawnFrom = new Set<Accessor>();
    let vertexBytes = 0;
    for (const mesh of shown) {
        for (const from of meshes[mesh]!.used) {
            if (!drawnFrom.has(from)) {
                drawnFrom.add(from);
                vertexBytes += from.bytes;
            }
        }
    }
    let pictureBytes = 0;
    for (const at of pictures.keys()) {
        pictureBytes += views[at]!.length;
    }
    if (vertexBytes > 2 * (bufferLength - pictureBytes)) {
        refuse(`vertex data of ${vertexBytes} bytes, more than the model holds`);
    }
    //  Each index of a mesh that is shown must name a vertex there is.
    //  The triangles are within the budget by now, so this reads no more
    //  than about three numbers for each of them.
    for (const mesh of shown) {
        for (const { indices, vertices } of meshes[mesh]!.indexed) {
            for (let n = 0, at = indices.start; n < indices.count; n++, at += indices.stride) {
                const index =
                    5121 === indices.component
                        ? bin[at]!
                        : 5123 === indices.component
                          ? bin.readUInt16LE(at)
                          : bin.readUInt32LE(at);
                if (index >= vertices) {
                    refuse(`an index that names a vertex there is not (${index})`);
                }
            }
        }
    }

    //  What is counted above is each node once, so each may be shown once:
    //  the viewer's loader makes a copy of a node, and of all below it,
    //  for every time it is listed again. So there is one scene at most,
    //  and it lists roots only, each once.
    if (sceneDefs.length > 1) {
        refuse(`a model of ${sceneDefs.length} scenes, where the hub takes one at most in this slice`);
    }
    for (const def of sceneDefs) {
        if (undefined !== def.nodes) {
            const roots = new Set<number>();
            for (const value of listOf(def.nodes, "a scene's nodes")) {
                const root = indexInto(value, nodeDefs.length, "a scene's node");
                if (-1 !== parent[root]) {
                    refuse('a scene that lists a node which is the child of another');
                }
                if (roots.has(root)) {
                    refuse('a scene that lists a node twice');
                }
                roots.add(root);
            }
        }
    }
    optionalIndex(json.scene, sceneDefs.length, "the model's scene");

    //  ---- skins ----

    //  bones are the nodes any skin moves, or the joints of the largest
    //  skin if it names some twice
    const joints = new Set<number>();
    let bones = 0;
    for (const def of skinDefs) {
        const named = listOf(def.joints, "a skin's joints");
        if (0 === named.length) {
            refuse('a skin without joints');
        }
        for (const value of named) {
            joints.add(indexInto(value, nodeDefs.length, "a skin's joint"));
        }
        bones = Math.max(bones, named.length, joints.size);
        optionalIndex(def.skeleton, nodeDefs.length, "a skin's root");
        if (undefined !== def.inverseBindMatrices) {
            const matrices = accessor(def.inverseBindMatrices, "a skin's matrices");
            if ('MAT4' !== matrices.type || Float !== matrices.component || matrices.count < named.length) {
                refuse('a skin whose matrices do not fit its joints');
            }
            if (matrices.strided) {
                refuse("a skin's matrices in a buffer view with a stride");
            }
        }
    }

    //  ---- animations ----

    if (animationDefs.length > budget.animations) {
        refuse(`a model of ${animationDefs.length} animations, over the limit of ${budget.animations}`);
    }
    //  How long the times of an accessor run: every one of them is read,
    //  and must be a number of seconds from nought up, each more than the
    //  one before, so the last is the largest and is the length the viewer
    //  will play. If the accessor says its largest is more, that is
    //  believed. Each accessor is read once, however many samplers name
    //  it; and since accessors may lie over the same bytes, all the times
    //  read are held to what the buffer could hold of them side by side,
    //  so the reading stays in proportion to the file.
    const lengths = new Map<number, number>(); //  by accessor
    let timesRead = 0;
    const lengthOf = (index: number): number => {
        const known = lengths.get(index);
        if (undefined !== known) {
            return known;
        }
        const input = accessors[index]!;
        if ('SCALAR' !== input.type || Float !== input.component) {
            refuse('an animation whose times are not numbers of seconds');
        }
        if (input.strided) {
            refuse("an animation's times in a buffer view with a stride");
        }
        timesRead += input.count;
        if (timesRead > bufferLength / 4) {
            refuse('animations with more times than the model has bytes to hold them');
        }
        let last = 0;
        for (let n = 0, at = input.start; n < input.count; n++, at += 4) {
            const time = bin.readFloatLE(at);
            if (!Number.isFinite(time)) {
                refuse('an animation with a time that is not a number');
            }
            if (time < 0) {
                refuse('an animation with a time before its start');
            }
            if (n > 0 && time <= last) {
                refuse('an animation whose times do not rise');
            }
            last = time;
        }
        const max = accessorDefs[index]!.max;
        const said = Array.isArray(max) && 'number' === typeof max[0] ? max[0] : 0;
        const seconds = Math.max(last, said);
        lengths.set(index, seconds);
        return seconds;
    };

    const animations = animationDefs.map(def => {
        if (undefined !== def.name && 'string' !== typeof def.name) {
            refuse('an animation whose name is not text');
        }
        const name = 'string' === typeof def.name ? def.name : '';
        //  the names go out to pages with the figures, so they are held to
        //  something a page can show
        if (name.length > MaxName) {
            refuse(`an animation whose name is over ${MaxName} characters`);
        }
        if (NameRefused.test(name)) {
            refuse('an animation whose name has characters that cannot be shown');
        }
        const samplerDefs = objectsOf(def.samplers, "an animation's sampler");
        const channels = objectsOf(def.channels, "an animation's channel");
        if (samplerDefs.length > budget.animationChannels) {
            refuse(
                `an animation of ${samplerDefs.length} samplers, over the limit of ${budget.animationChannels}`
            );
        }
        if (channels.length > budget.animationChannels) {
            refuse(
                `an animation of ${channels.length} channels, over the limit of ${budget.animationChannels}`
            );
        }
        const samplers = samplerDefs.map(sampler => {
            const index = indexInto(sampler.input, accessors.length, "an animation's accessor");
            const output = accessor(sampler.output, "an animation's accessor");
            const seconds = lengthOf(index);
            const curve = sampler.interpolation ?? 'LINEAR';
            if ('LINEAR' !== curve && 'STEP' !== curve && 'CUBICSPLINE' !== curve) {
                refuse('an animation that moves in a way the hub does not know');
            }
            //  The values are plain numbers: the viewer hands those to
            //  every channel as they lie in the file, where whole numbers,
            //  standing for fractions or not, it would write out again as
            //  plain ones for each channel that names them, four times the
            //  bytes or more each time
            if (Float !== output.component || output.normalized) {
                refuse('an animation whose values are not plain numbers, which the hub does not take yet');
            }
            if (output.strided) {
                refuse("an animation's values in a buffer view with a stride");
            }
            //  a curve has three values for each time: the point and the
            //  slopes into and out of it
            return {
                seconds,
                output,
                values: accessors[index]!.count * ('CUBICSPLINE' === curve ? 3 : 1),
            };
        });
        if (0 === samplers.length || 0 === channels.length) {
            refuse('an animation that moves nothing');
        }
        for (const channel of channels) {
            const sampler =
                samplers[indexInto(channel.sampler, samplers.length, "an animation channel's sampler")]!;
            const target = objectOf(channel.target, "an animation channel's target");
            const node = optionalIndex(target.node, nodeDefs.length, "an animation's target node");
            //  what it moves says the shape of its values: three numbers
            //  for a place or a size, four for a turn, and for the weights
            //  of morph targets one for each target of the node's mesh
            const { output } = sampler;
            let each = 1;
            if ('translation' === target.path || 'scale' === target.path) {
                if ('VEC3' !== output.type) {
                    refuse('an animation whose values do not fit what it moves');
                }
            } else if ('rotation' === target.path) {
                if ('VEC4' !== output.type) {
                    refuse('an animation whose values do not fit what it moves');
                }
            } else if ('weights' === target.path) {
                const mesh = undefined === node ? undefined : nodeDefs[node]!.mesh;
                each = 'number' === typeof mesh ? meshes[mesh]!.targets : 0;
                if ('SCALAR' !== output.type || (undefined !== node && 0 === each)) {
                    refuse('an animation whose values do not fit what it moves');
                }
            } else {
                refuse('an animation that moves something the hub does not know');
            }
            //  a channel with no node moves nothing, and is not counted
            if (undefined !== node && output.count !== sampler.values * each) {
                refuse('an animation with a different number of values from its times');
            }
        }
        return { name, seconds: samplers.reduce((most, sampler) => Math.max(most, sampler.seconds), 0) };
    });

    //  ---- the budget ----

    //  (the rest were held to it above, each before it was read into)
    if (bones > budget.bones) {
        refuse(`a model of ${bones} bones, over the limit of ${budget.bones}`);
    }
    for (const animation of animations) {
        if (animation.seconds > budget.animationSeconds) {
            refuse(
                `an animation of ${animation.seconds} seconds, over the limit of ${budget.animationSeconds}`
            );
        }
    }

    return {
        figures: {
            triangles,
            drawCalls,
            bones,
            textureBytes,
            maxTextureSide,
            texturePixels,
            animations,
            effects: [...effects].sort(),
        },
        views,
        pictures,
        buffer,
        bufferLength,
    };
}

//  ---- writing it again ----

//  The model with its pictures replaced by their cleaned bytes. A picture
//  only gets smaller, so the binary chunk closes up behind each, by whole
//  fours so that everything after keeps its boundary; the buffer views
//  after it move down by as much. Nothing else in the chunk moves or
//  changes. A picture's bytes are its own (picturesApart, above), so
//  closing up behind one moves nothing that overlaps it.
function rebuild(json: Json, bin: Buffer | undefined, examined: Examined): Buffer {
    const { views, pictures, buffer, bufferLength } = examined;
    if (!buffer || !bin) {
        //  nothing refers to a binary chunk, so none is written
        return packGlb(json, undefined);
    }
    const order = views.map((view, at) => ({ view, picture: pictures.get(at) }));
    order.sort((a, b) => a.view.offset - b.view.offset);

    const parts: Buffer[] = [];
    let copied = 0; //  how far into the old chunk has been written out
    let closed = 0; //  how many bytes shorter the new chunk is so far
    for (const { view, picture } of order) {
        const end = view.offset + view.length;
        if (closed > 0) {
            view.def.byteOffset = view.offset - closed;
        }
        if (!picture) {
            continue;
        }
        const saved = view.length - picture.cleaned.length;
        parts.push(bin.subarray(copied, view.offset), picture.cleaned, Buffer.alloc(saved % 4));
        copied = end;
        closed += saved - (saved % 4);
        if (saved > 0) {
            view.def.byteLength = picture.cleaned.length;
        }
    }
    //  what lay past the buffer's stated length was padding, and is left
    parts.push(bin.subarray(copied, bufferLength));
    buffer.byteLength = bufferLength - closed;
    return packGlb(json, Buffer.concat(parts));
}

function pass(bytes: Buffer, budget: ModelBudget): { cleaned: Buffer; figures: Examined['figures'] } {
    const { text, bin } = readContainer(bytes, budget);
    const json = readJson(text);
    const examined = examine(json, bin, budget);
    return { cleaned: rebuild(json, bin, examined), figures: examined.figures };
}

//  A model checked, measured and cleaned, or a HubError saying why not.
//  It throws nothing else, whatever the bytes.
export function checkGlb(bytes: Buffer, budget: ModelBudget = LightBudget): CheckedModel {
    try {
        const first = pass(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), budget);
        //  The cleaned file is what the hub serves, so it is held to the
        //  same rules, and must be a file that cleaning leaves alone
        let second: ReturnType<typeof pass>;
        try {
            second = pass(first.cleaned, budget);
        } catch (err) {
            const reason = err instanceof HubError ? err.message : 'it cannot be read';
            refuse(`a model that does not hold once rewritten: ${reason}`);
        }
        if (!second.cleaned.equals(first.cleaned)) {
            refuse('a model that does not hold once rewritten: it changes again');
        }
        const cleaned = first.cleaned;
        return {
            cleaned,
            sha256: createHash('sha256').update(cleaned).digest('hex'),
            measured: { bytes: cleaned.length, ...second.figures },
        };
    } catch (err) {
        if (err instanceof HubError) {
            throw err;
        }
        //  a fault of the checker's own, or a file that broke the runtime
        //  (a string too long, a stack too deep): refused all the same
        throw new HubError('asset', 'a model the hub could not read');
    }
}

//  A model's preview picture (build spec decision 6): a PNG, as its own
//  bytes say, no larger than |maxBytes| or |maxSide| pixels a side, cleaned
//  as a model's own pictures are and held to it again once cleaned.
export interface CheckedPreview {
    cleaned: Buffer;
    sha256: string; //  of cleaned, in hex
    width: number;
    height: number;
}

export function checkPreviewPng(bytes: Buffer, maxSide: number, maxBytes: number): CheckedPreview {
    try {
        if (bytes.length > maxBytes) {
            refuse(`a preview picture of ${bytes.length} bytes, over the limit of ${maxBytes}`);
        }
        if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PngSignature)) {
            refuse('a preview picture that is not a PNG');
        }
        const admit: Admit = (width, height) => {
            if (Math.max(width, height) > maxSide) {
                refuse(`a preview picture of ${width} by ${height} pixels, over the limit of ${maxSide} a side`);
            }
        };
        const first = cleanPng(bytes, admit, { left: MaxProfiles });
        const second = cleanPng(first.cleaned, admit, { left: MaxProfiles });
        if (!second.cleaned.equals(first.cleaned)) {
            refuse('a preview picture that does not hold once rewritten');
        }
        return {
            cleaned: first.cleaned,
            sha256: createHash('sha256').update(first.cleaned).digest('hex'),
            width: first.width,
            height: first.height,
        };
    } catch (err) {
        if (err instanceof HubError) {
            throw err;
        }
        throw new HubError('asset', 'a preview picture the hub could not read');
    }
}
