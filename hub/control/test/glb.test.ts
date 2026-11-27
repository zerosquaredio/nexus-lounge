//  The model builder of glb.ts, checked by reading its bytes back with
//  nothing of its own: the reader here is written from the glTF and PNG
//  and JPEG formats, and shares no code with the builder. A good model
//  must read back whole; a hostile one must have the one fault it names.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
    Light,
    box,
    budgetModel,
    buildGlb,
    editGlb,
    exifBlock,
    fullModel,
    HiddenText,
    hostile,
    makeJpeg,
    makePng,
    overBudget,
    packGlb,
    readGlb,
    sphere,
    strip,
    tube,
} from './glb.ts';
import type { BudgetKind, IndexKind, Json } from './glb.ts';
import { modelFiles } from './fixtures/make_models.ts';

const Models = join(import.meta.dirname, 'fixtures', 'models');

//  ---- an independent reading of a .glb ----

interface ReadChunk {
    type: string;
    length: number; //  as declared
    start: number; //  of its data, in the file
    data: Buffer; //  what of it the file has
}

//  the header and chunks as they are declared, right or wrong
function container(glb: Buffer): { magic: string; version: number; length: number; chunks: ReadChunk[] } {
    const chunks: ReadChunk[] = [];
    for (let at = 12; at + 8 <= glb.length; ) {
        const length = glb.readUInt32LE(at);
        const type = glb.toString('latin1', at + 4, at + 8);
        chunks.push({ type, length, start: at + 8, data: glb.subarray(at + 8, at + 8 + length) });
        at += 8 + length;
    }
    return {
        magic: glb.toString('latin1', 0, 4),
        version: glb.readUInt32LE(4),
        length: glb.readUInt32LE(8),
        chunks,
    };
}

function jsonOf(glb: Buffer): Json {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(container(glb).chunks[0]!.data);
    return JSON.parse(text) as Json;
}

const ComponentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TypeWidth: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

//  an accessor's numbers, after checking that it lies inside its view,
//  its view inside the buffer, and the buffer inside the binary chunk
function numbers(json: Json, bin: Buffer, index: number): number[] {
    const accessor = json.accessors?.[index];
    assert.ok(accessor, `accessor ${index} exists`);
    const view = json.bufferViews?.[accessor.bufferView];
    assert.ok(view, `accessor ${index} has a buffer view`);
    assert.equal(view.buffer, 0);
    const buffer = json.buffers[0];
    assert.ok(buffer.byteLength <= bin.length, 'the buffer is within the binary chunk');
    assert.ok(view.byteOffset + view.byteLength <= buffer.byteLength, 'the view is within the buffer');
    const bytes = ComponentBytes[accessor.componentType];
    const width = TypeWidth[accessor.type];
    assert.ok(bytes && width, `accessor ${index} has a known component and type`);
    assert.ok(accessor.count >= 1);
    const offset = accessor.byteOffset ?? 0;
    assert.ok(
        offset + accessor.count * width * bytes <= view.byteLength,
        `accessor ${index} is within its view`
    );
    const start = view.byteOffset + offset;
    assert.equal(start % bytes, 0, 'aligned to its component');
    const out: number[] = [];
    for (let at = 0; at < accessor.count * width; at++) {
        const place = start + at * bytes;
        switch (accessor.componentType) {
            case 5126:
                out.push(bin.readFloatLE(place));
                break;
            case 5125:
                out.push(bin.readUInt32LE(place));
                break;
            case 5123:
                out.push(bin.readUInt16LE(place));
                break;
            case 5121:
                out.push(bin.readUInt8(place));
                break;
            default:
                assert.fail(`component type ${accessor.componentType} is not one the builder writes`);
        }
    }
    assert.ok(out.every(Number.isFinite), 'every number is finite');
    if (accessor.min || accessor.max) {
        for (let part = 0; part < width; part++) {
            const column: number[] = out.filter((_, at) => at % width === part);
            assert.equal(
                accessor.min[part],
                column.reduce((a, b) => Math.min(a, b)),
                'min is the least'
            );
            assert.equal(
                accessor.max[part],
                column.reduce((a, b) => Math.max(a, b)),
                'max is the greatest'
            );
        }
    }
    return out;
}

//  CRC-32 the slow way, so the builder's use of zlib's is checked by
//  something else
function crc(data: Buffer): number {
    let value = 0xffffffff;
    for (const byte of data) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
    }
    return (value ^ 0xffffffff) >>> 0;
}

interface ReadPng {
    width: number;
    height: number;
    chunks: { type: string; data: Buffer }[];
    pixels: Buffer; //  rows of a filter byte and r, g, b
    after: Buffer; //  whatever follows the image's end
}

function readPng(png: Buffer): ReadPng {
    assert.equal(png.toString('latin1', 0, 8), '\x89PNG\r\n\x1a\n');
    const chunks: { type: string; data: Buffer }[] = [];
    let at = 8;
    for (;;) {
        const length = png.readUInt32BE(at);
        const type = png.toString('latin1', at + 4, at + 8);
        const data = png.subarray(at + 8, at + 8 + length);
        assert.equal(
            png.readUInt32BE(at + 8 + length),
            crc(png.subarray(at + 4, at + 8 + length)),
            `${type} checksum`
        );
        chunks.push({ type, data });
        at += 12 + length;
        if ('IEND' === type) {
            break;
        }
    }
    const header = chunks[0]!;
    assert.equal(header.type, 'IHDR');
    const width = header.data.readUInt32BE(0);
    const height = header.data.readUInt32BE(4);
    assert.deepEqual([...header.data.subarray(8)], [8, 2, 0, 0, 0], '8 bits, red green blue, not interlaced');
    const pixels = inflateSync(Buffer.concat(chunks.filter(c => 'IDAT' === c.type).map(c => c.data)));
    assert.equal(pixels.length, height * (1 + width * 3));
    return { width, height, chunks, pixels, after: png.subarray(at) };
}

interface ReadJpeg {
    width: number;
    height: number;
    segments: { marker: number; data: Buffer }[]; //  those before the picture's data
    after: Buffer;
}

function readJpeg(jpeg: Buffer): ReadJpeg {
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    const segments: { marker: number; data: Buffer }[] = [];
    let at = 2;
    for (;;) {
        assert.equal(jpeg[at], 0xff);
        const marker = jpeg[at + 1]!;
        const length = jpeg.readUInt16BE(at + 2);
        segments.push({ marker, data: jpeg.subarray(at + 4, at + 2 + length) });
        at += 2 + length;
        if (0xda === marker) {
            break;
        }
    }
    //  the picture's data runs to the first marker that is not a stuffed FF
    while (!(0xff === jpeg[at] && 0 !== jpeg[at + 1])) {
        at++;
    }
    assert.equal(jpeg.readUInt16BE(at), 0xffd9, 'the picture ends with an end marker');
    const frame = segments.find(s => 0xc0 === s.marker)!.data;
    return {
        width: frame.readUInt16BE(3),
        height: frame.readUInt16BE(1),
        segments,
        after: jpeg.subarray(at + 2),
    };
}

//  every index in the JSON that points at nothing, by the kind of thing
//  it should have pointed at
function dangling(json: Json): string[] {
    const found: string[] = [];
    const check = (kind: string, index: unknown, list: unknown): void => {
        if (undefined === index) {
            return;
        }
        const size = Array.isArray(list) ? list.length : 0;
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= size) {
            found.push(kind);
        }
    };
    const each = (list: unknown): Json[] => (Array.isArray(list) ? (list as Json[]) : []);
    check('scene', json.scene, json.scenes);
    for (const scene of each(json.scenes)) {
        each(scene.nodes).forEach(n => check('node', n, json.nodes));
    }
    for (const node of each(json.nodes)) {
        each(node.children).forEach(n => check('node', n, json.nodes));
        check('mesh', node.mesh, json.meshes);
        check('skin', node.skin, json.skins);
    }
    for (const mesh of each(json.meshes)) {
        for (const primitive of each(mesh.primitives)) {
            Object.values(primitive.attributes as Json).forEach(a => check('accessor', a, json.accessors));
            check('accessor', primitive.indices, json.accessors);
            check('material', primitive.material, json.materials);
        }
    }
    for (const material of each(json.materials)) {
        check('texture', material.pbrMetallicRoughness?.baseColorTexture?.index, json.textures);
    }
    each(json.textures).forEach(t => check('image', t.source, json.images));
    each(json.images).forEach(i => check('bufferView', i.bufferView, json.bufferViews));
    for (const skin of each(json.skins)) {
        each(skin.joints).forEach(j => check('joint', j, json.nodes));
        check('accessor', skin.inverseBindMatrices, json.accessors);
    }
    for (const animation of each(json.animations)) {
        for (const channel of each(animation.channels)) {
            check('sampler', channel.sampler, animation.samplers);
            check('target', channel.target.node, json.nodes);
        }
        for (const sampler of each(animation.samplers)) {
            check('accessor', sampler.input, json.accessors);
            check('accessor', sampler.output, json.accessors);
        }
    }
    each(json.accessors).forEach(a => check('bufferView', a.bufferView, json.bufferViews));
    each(json.bufferViews).forEach(v => check('buffer', v.buffer, json.buffers));
    return found;
}

//  the nodes that are their own descendants
function inCycles(json: Json): number[] {
    const nodes = (json.nodes ?? []) as Json[];
    const reaches = (from: number, to: number, seen = new Set<number>()): boolean =>
        ((nodes[from]?.children ?? []) as number[]).some(child => {
            if (child === to) {
                return true;
            }
            if (seen.has(child)) {
                return false;
            }
            seen.add(child);
            return reaches(child, to, seen);
        });
    return nodes.map((_, at) => at).filter(at => reaches(at, at));
}

interface Figures {
    triangles: number;
    primitives: number;
    bones: number;
    textureSide: number;
    textureBytes: number;
    animations: string[];
    animationSeconds: number;
    images: string[];
    attributes: Set<string>;
}

//  Read a whole model, failing on anything out of place, and measure it.
function wellFormed(glb: Buffer): Figures {
    const { magic, version, length, chunks } = container(glb);
    assert.equal(magic, 'glTF');
    assert.equal(version, 2);
    assert.equal(length, glb.length, 'the declared length is the file’s');
    assert.ok(1 === chunks.length || 2 === chunks.length, 'one or two chunks');
    assert.equal(chunks[0]!.type, 'JSON');
    if (chunks[1]) {
        assert.equal(chunks[1].type, 'BIN\0');
    }
    let end = 12;
    for (const chunk of chunks) {
        assert.equal(chunk.length % 4, 0, 'chunks are padded to four bytes');
        assert.equal(chunk.start, end + 8, 'chunks follow one another');
        end = chunk.start + chunk.length;
    }
    assert.equal(end, glb.length, 'the chunks fill the file');

    const json = jsonOf(glb);
    const bin = chunks[1]?.data ?? Buffer.alloc(0);
    assert.equal(json.asset.version, '2.0');
    assert.deepEqual(dangling(json), []);
    assert.deepEqual(inCycles(json), []);
    for (const [name, list] of Object.entries(json)) {
        assert.ok(!Array.isArray(list) || list.length > 0, `${name} is not an empty list`);
    }
    assert.ok((json.buffers ?? []).length <= 1, 'at most one buffer');
    for (const buffer of json.buffers ?? []) {
        assert.equal(buffer.uri, undefined);
        assert.ok(
            bin.length - buffer.byteLength >= 0 && bin.length - buffer.byteLength < 4,
            'the buffer is the chunk'
        );
    }
    (json.bufferViews ?? []).forEach((view: Json) =>
        assert.equal(view.byteOffset % 4, 0, 'views start on four bytes')
    );
    (json.accessors ?? []).forEach((_: Json, at: number) => numbers(json, bin, at));

    const figures: Figures = {
        triangles: 0,
        primitives: 0,
        bones: 0,
        textureSide: 0,
        textureBytes: 0,
        animations: [],
        animationSeconds: 0,
        images: [],
        attributes: new Set(),
    };

    //  nodes: one parent at most, roots in the scene
    const nodes = (json.nodes ?? []) as Json[];
    const children = nodes.flatMap(node => (node.children ?? []) as number[]);
    assert.equal(new Set(children).size, children.length, 'no node has two parents');
    if (nodes.length > 0) {
        const roots = nodes.map((_, at) => at).filter(at => !children.includes(at));
        assert.deepEqual(json.scenes[json.scene].nodes, roots, 'the scene holds the roots');
    }

    for (const skin of (json.skins ?? []) as Json[]) {
        figures.bones += skin.joints.length;
        assert.equal(new Set(skin.joints).size, skin.joints.length);
        assert.equal(json.accessors[skin.inverseBindMatrices].type, 'MAT4');
        assert.equal(json.accessors[skin.inverseBindMatrices].count, skin.joints.length);
    }

    //  how many joints the skin of each mesh has, from the nodes that use it
    const jointsFor = new Map<number, number>();
    for (const node of nodes) {
        if (undefined !== node.mesh && undefined !== node.skin) {
            jointsFor.set(node.mesh, json.skins[node.skin].joints.length);
        }
    }
    ((json.meshes ?? []) as Json[]).forEach((mesh, meshAt) => {
        for (const primitive of mesh.primitives as Json[]) {
            figures.primitives++;
            assert.ok(undefined === primitive.mode || 4 === primitive.mode, 'triangles');
            const position = json.accessors[primitive.attributes.POSITION];
            assert.deepEqual([position.type, position.componentType], ['VEC3', 5126]);
            assert.ok(position.min && position.max, 'positions carry their bounds');
            for (const [name, at] of Object.entries(primitive.attributes as Record<string, number>)) {
                figures.attributes.add(name);
                assert.equal(json.accessors[at].count, position.count, `${name} has one entry a vertex`);
                assert.equal(json.bufferViews[json.accessors[at].bufferView].target, 34962);
            }
            if (undefined !== primitive.indices) {
                const indices = numbers(json, bin, primitive.indices);
                assert.equal(json.accessors[primitive.indices].type, 'SCALAR');
                assert.equal(json.bufferViews[json.accessors[primitive.indices].bufferView].target, 34963);
                assert.equal(indices.length % 3, 0);
                assert.ok(
                    indices.every(i => i < position.count),
                    'every index is a vertex'
                );
                figures.triangles += indices.length / 3;
            } else {
                assert.equal(position.count % 3, 0);
                figures.triangles += position.count / 3;
            }
            if (undefined !== primitive.attributes.NORMAL) {
                const normals = numbers(json, bin, primitive.attributes.NORMAL);
                for (let at = 0; at < normals.length; at += 3) {
                    const size = Math.hypot(normals[at]!, normals[at + 1]!, normals[at + 2]!);
                    assert.ok(Math.abs(size - 1) < 1e-4, 'normals are of unit length');
                }
            }
            if (undefined !== primitive.attributes.COLOR_0) {
                assert.ok(numbers(json, bin, primitive.attributes.COLOR_0).every(v => v >= 0 && v <= 1));
            }
            if (undefined !== primitive.attributes.JOINTS_0) {
                const joints = numbers(json, bin, primitive.attributes.JOINTS_0);
                const weights = numbers(json, bin, primitive.attributes.WEIGHTS_0);
                const count = jointsFor.get(meshAt);
                assert.ok(undefined !== count, 'a mesh with joints is used with a skin');
                assert.ok(
                    joints.every(j => j < count),
                    'every joint is in the skin'
                );
                for (let at = 0; at < weights.length; at += 4) {
                    const sum = weights[at]! + weights[at + 1]! + weights[at + 2]! + weights[at + 3]!;
                    assert.ok(Math.abs(sum - 1) < 1e-5, 'weights add up to 1');
                }
            }
            const texture = json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorTexture;
            if (texture) {
                assert.ok(undefined !== primitive.attributes.TEXCOORD_0, 'a textured primitive has uvs');
            }
        }
    });

    for (const image of (json.images ?? []) as Json[]) {
        assert.equal(image.uri, undefined);
        const view = json.bufferViews[image.bufferView];
        const bytes = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
        const picture = 'image/png' === image.mimeType ? readPng(bytes) : readJpeg(bytes);
        assert.ok('image/png' === image.mimeType || 'image/jpeg' === image.mimeType);
        figures.images.push(image.mimeType);
        figures.textureBytes += bytes.length;
        figures.textureSide = Math.max(figures.textureSide, picture.width, picture.height);
    }

    for (const animation of (json.animations ?? []) as Json[]) {
        figures.animations.push(animation.name);
        assert.ok(animation.channels.length > 0 && animation.channels.length === animation.samplers.length);
        for (const channel of animation.channels as Json[]) {
            const sampler = animation.samplers[channel.sampler];
            const times = numbers(json, bin, sampler.input);
            assert.ok(json.accessors[sampler.input].min && json.accessors[sampler.input].max);
            assert.ok(times[0]! >= 0 && times.every((t, at) => 0 === at || t > times[at - 1]!), 'times rise');
            const output = json.accessors[sampler.output];
            assert.equal(output.count, times.length, 'a value for each time');
            assert.equal(output.type, 'rotation' === channel.target.path ? 'VEC4' : 'VEC3');
            figures.animationSeconds = Math.max(figures.animationSeconds, times[times.length - 1]!);
        }
    }
    return figures;
}

//  ---- the tests ----

describe('the model builder', () => {
    it('makes a whole model that reads back well-formed, with the figures it was given', () => {
        const figures = wellFormed(buildGlb(fullModel()));
        assert.deepEqual(
            { ...figures, attributes: [...figures.attributes].sort(), textureBytes: 0 },
            {
                triangles: 152,
                primitives: 2,
                bones: 3,
                textureSide: 8,
                textureBytes: 0,
                animations: ['idle'],
                animationSeconds: 2,
                images: ['image/png'],
                attributes: ['COLOR_0', 'JOINTS_0', 'NORMAL', 'POSITION', 'TEXCOORD_0', 'WEIGHTS_0'],
            }
        );
        assert.ok(figures.textureBytes > 0);
    });

    it('makes the smallest models, and leaves out what a model does not have', () => {
        const nothing = buildGlb({});
        assert.equal(container(nothing).chunks.length, 1, 'no binary chunk');
        assert.deepEqual(Object.keys(jsonOf(nothing)), ['asset']);
        wellFormed(nothing);

        const triangle = buildGlb({
            meshes: [{ primitives: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] }],
            nodes: [{ mesh: 0 }],
        });
        const json = jsonOf(triangle);
        assert.deepEqual(Object.keys(json).sort(), [
            'accessors',
            'asset',
            'bufferViews',
            'buffers',
            'meshes',
            'nodes',
            'scene',
            'scenes',
        ]);
        assert.equal(wellFormed(triangle).triangles, 1);
    });

    it('writes what it is told: names, transforms, extensions, the credit, the hierarchy', () => {
        const glb = buildGlb({
            generator: 'a test',
            copyright: 'someone, CC BY 4.0',
            extensionsUsed: ['KHR_materials_unlit', 'KHR_texture_transform'],
            extensionsRequired: ['KHR_materials_unlit'],
            materials: [{ name: 'red', colour: [1, 0, 0, 1], doubleSided: true }],
            meshes: [{ name: 'cube', primitives: [{ ...box(), material: 0 }] }],
            nodes: [
                { name: 'top', children: [1, 2], translation: [1, 2, 3] },
                { name: 'left', mesh: 0, rotation: [0, 1, 0, 0] },
                { name: 'right', mesh: 0, scale: [2, 2, 2] },
                { name: 'alone' },
            ],
        });
        wellFormed(glb);
        const json = jsonOf(glb);
        assert.deepEqual(json.asset, {
            version: '2.0',
            generator: 'a test',
            copyright: 'someone, CC BY 4.0',
        });
        assert.deepEqual(json.extensionsUsed, ['KHR_materials_unlit', 'KHR_texture_transform']);
        assert.deepEqual(json.extensionsRequired, ['KHR_materials_unlit']);
        assert.deepEqual(json.scenes, [{ nodes: [0, 3] }]);
        assert.deepEqual(json.nodes[0], { name: 'top', children: [1, 2], translation: [1, 2, 3] });
        assert.deepEqual(json.nodes[1].rotation, [0, 1, 0, 0]);
        assert.deepEqual(json.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 0, 0, 1]);
        assert.equal(json.materials[0].doubleSided, true);
        assert.equal(json.meshes[0].name, 'cube');
    });

    it('embeds a PNG or a JPEG texture under its own type, and takes nothing else', () => {
        const withTexture = (texture: Buffer): Buffer =>
            buildGlb({
                materials: [{ texture }],
                meshes: [{ primitives: [{ ...box(), material: 0 }] }],
                nodes: [{ mesh: 0 }],
            });
        const jpeg = makeJpeg({ width: 16, height: 8, colour: [10, 200, 30] });
        const figures = wellFormed(withTexture(jpeg));
        assert.deepEqual(
            [figures.images, figures.textureSide, figures.textureBytes],
            [['image/jpeg'], 16, jpeg.length]
        );
        assert.deepEqual(wellFormed(withTexture(makePng({ width: 4, height: 32 }))).images, ['image/png']);
        assert.throws(() => withTexture(Buffer.from('GIF89a, not allowed')), /PNG or a JPEG/);
    });

    it('works out a skin’s bind matrices from its joints’ places, or takes them as given', () => {
        const { json, bin } = readGlb(buildGlb(fullModel()));
        const matrices = numbers(json, bin, json.skins[0].inverseBindMatrices);
        //  the three joints are at heights 0, 0.5 and 1: each matrix moves that far down
        assert.deepEqual([matrices[13], matrices[16 + 13], matrices[32 + 13]], [-0, -0.5, -1]);
        assert.deepEqual(matrices.slice(0, 12), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

        const turned = fullModel();
        turned.nodes![1]!.rotation = [0, 0, 1, 0];
        assert.throws(() => buildGlb(turned), /inverseBindMatrices/);
        const given = new Array<number>(48).fill(0).map((_, at) => (0 === (at % 16) % 5 ? 1 : 0));
        turned.skins![0]!.inverseBindMatrices = given;
        const made = readGlb(buildGlb(turned));
        assert.deepEqual(numbers(made.json, made.bin, made.json.skins[0].inverseBindMatrices), given);
    });

    it('uses 32-bit indices only for a mesh too large for 16', () => {
        const type = (triangles: number): number => {
            const json = jsonOf(buildGlb({ meshes: [{ primitives: [strip(triangles)] }] }));
            return json.accessors[json.meshes[0].primitives[0].indices].componentType;
        };
        assert.deepEqual([type(65533), type(65534)], [5123, 5125]);
    });

    it('refuses numbers that do not make whole vertices', () => {
        assert.throws(
            () => buildGlb({ meshes: [{ primitives: [{ positions: [0, 0, 0, 1] }] }] }),
            /whole number of VEC3/
        );
    });

    it('makes shapes of the sizes they say', () => {
        const triangles = (primitive: { indices?: number[] }): number => primitive.indices!.length / 3;
        assert.equal(triangles(box()), 12);
        assert.equal(triangles(sphere(1, 16, 10)), 288);
        assert.equal(triangles(tube(0.25, 2, 8, 8)), 128);
        assert.equal(triangles(strip(77)), 77);
        const bent = tube(0.25, 2, 6, 4, 2);
        assert.equal(bent.joints!.length, (bent.positions.length / 3) * 4);
        assert.equal(Math.max(...bent.joints!), 1);
        const cube = box(2, 4, 6);
        const reach = [0, 1, 2].map(axis => Math.max(...cube.positions.filter((_, at) => at % 3 === axis)));
        assert.deepEqual(reach, [1, 2, 3]);
    });

    it('packs, reads and edits a .glb without disturbing it', () => {
        const glb = buildGlb(fullModel());
        const { version, json, bin } = readGlb(glb);
        assert.equal(version, 2);
        assert.deepEqual(packGlb(json, bin), glb);
        assert.deepEqual(
            editGlb(glb, () => {}),
            glb
        );
        const renamed = editGlb(glb, edited => {
            edited.nodes[0].name = 'a much longer name than before';
        });
        assert.equal(wellFormed(renamed).triangles, 152);
        assert.equal(jsonOf(renamed).nodes[0].name, 'a much longer name than before');
        assert.deepEqual(readGlb(renamed).bin, bin);
        //  JSON of every length is padded with spaces to four bytes
        for (const name of ['', 'a', 'ab', 'abc']) {
            const made = packGlb({ asset: { version: '2.0', generator: name } });
            assert.equal(made.length % 4, 0);
            assert.match(container(made).chunks[0]!.data.toString('latin1'), /\} *$/);
            wellFormed(made);
        }
    });
});

describe('the pictures', () => {
    it('makes a PNG of the size and colour asked, with nothing extra', () => {
        const png = readPng(makePng({ width: 5, height: 3, colour: [10, 20, 30] }));
        assert.deepEqual([png.width, png.height], [5, 3]);
        assert.deepEqual(
            png.chunks.map(c => c.type),
            ['IHDR', 'IDAT', 'IEND']
        );
        assert.equal(png.after.length, 0);
        assert.deepEqual([...png.pixels.subarray(0, 7)], [0, 10, 20, 30, 10, 20, 30]);
        const drawn = readPng(makePng({ width: 2, height: 2, pixel: (x, y) => [x * 255, y * 255, 7] }));
        assert.deepEqual([...drawn.pixels], [0, 0, 0, 7, 255, 0, 7, 0, 0, 255, 7, 255, 255, 7]);
    });

    it('puts metadata in a PNG and bytes after its end, when asked', () => {
        const tail = Buffer.from('bytes after the end');
        const made = makePng({
            width: 4,
            height: 4,
            text: { Comment: 'taken at home', Author: 'Ana' },
            exif: true,
            trailing: tail,
        });
        const png = readPng(made);
        assert.deepEqual(
            png.chunks.map(c => c.type),
            ['IHDR', 'tEXt', 'tEXt', 'eXIf', 'IDAT', 'IEND']
        );
        assert.equal(png.chunks[1]!.data.toString('latin1'), 'Comment\0taken at home');
        assert.deepEqual(png.chunks[3]!.data, exifBlock());
        assert.ok(made.includes(HiddenText));
        assert.deepEqual(png.after, tail);
        //  the pixels are those of the plain one
        assert.deepEqual(png.pixels, readPng(makePng({ width: 4, height: 4 })).pixels);
        const own = Buffer.from('MM\0*own exif');
        assert.deepEqual(readPng(makePng({ width: 1, height: 1, exif: own })).chunks[1]!.data, own);
    });

    it('makes PNG noise that does not compress, the same every time', () => {
        const noise = makePng({ width: 100, height: 50, noise: 1 });
        assert.ok(noise.length > 100 * 50 * 3);
        assert.deepEqual(makePng({ width: 100, height: 50, noise: 1 }), noise);
        assert.notDeepEqual(
            readPng(makePng({ width: 100, height: 50, noise: 2 })).pixels,
            readPng(noise).pixels
        );
        assert.ok(new Set(readPng(noise).pixels).size > 200);
    });

    it('makes a JPEG of the size asked, with only what a picture needs', () => {
        for (const [width, height] of [
            [1, 1],
            [8, 8],
            [20, 12],
            [1025, 3],
        ] as [number, number][]) {
            const jpeg = readJpeg(makeJpeg({ width, height, colour: [200, 30, 90] }));
            assert.deepEqual([jpeg.width, jpeg.height], [width, height]);
            //  JFIF, steps, frame, two code tables, scan
            assert.deepEqual(
                jpeg.segments.map(s => s.marker),
                [0xe0, 0xdb, 0xc0, 0xc4, 0xc4, 0xda]
            );
            assert.equal(jpeg.after.length, 0);
        }
        //  white drives the levels to their ends, where a data byte of FF must be stuffed
        readJpeg(makeJpeg({ width: 64, height: 64, colour: [255, 255, 255] }));
        readJpeg(makeJpeg({ width: 64, height: 64, colour: [0, 0, 255] }));
    });

    it('puts EXIF, a comment and trailing bytes in a JPEG, when asked', () => {
        const tail = Buffer.from('bytes after the end');
        const made = makeJpeg({
            width: 16,
            height: 16,
            exif: true,
            comment: 'taken at home',
            trailing: tail,
        });
        const jpeg = readJpeg(made);
        assert.deepEqual(
            jpeg.segments.map(s => s.marker),
            [0xe0, 0xe1, 0xfe, 0xdb, 0xc0, 0xc4, 0xc4, 0xda]
        );
        assert.deepEqual(jpeg.segments[1]!.data, Buffer.concat([Buffer.from('Exif\0\0'), exifBlock()]));
        assert.equal(jpeg.segments[2]!.data.toString('latin1'), 'taken at home');
        assert.ok(made.includes(HiddenText));
        assert.deepEqual(jpeg.after, tail);
        //  without them it is the same picture, byte for byte
        const plain = makeJpeg({ width: 16, height: 16 });
        const stripped = Buffer.concat([
            made.subarray(0, 20),
            made.subarray(made.indexOf(Buffer.from([0xff, 0xdb])), made.length - tail.length),
        ]);
        assert.deepEqual(stripped, plain);
    });

    it('names a camera in its EXIF block, as a small TIFF file', () => {
        const exif = exifBlock('Some Camera');
        assert.equal(exif.toString('latin1', 0, 2), 'II');
        assert.equal(exif.readUInt16LE(2), 42);
        const directory = exif.readUInt32LE(4);
        assert.equal(exif.readUInt16LE(directory), 1);
        assert.equal(exif.readUInt16LE(directory + 2), 0x010f);
        const [count, where] = [exif.readUInt32LE(directory + 6), exif.readUInt32LE(directory + 10)];
        assert.equal(exif.toString('latin1', where, where + count), 'Some Camera\0');
        assert.equal(where + count, exif.length);
    });
});

describe('the sample models', () => {
    const made = modelFiles();
    const onDisk = (name: string): Buffer => readFileSync(join(Models, name));

    it('are on disk as the generator makes them', () => {
        assert.deepEqual(Object.keys(made).sort(), [
            'animated.glb',
            'animated.png',
            'skinned.glb',
            'skinned.png',
            'still.glb',
            'still.png',
            'textured.glb',
            'textured.png',
        ]);
        const hint = 'run "node test/fixtures/make_models.ts" and commit what it writes';
        for (const [name, bytes] of Object.entries(made)) {
            assert.ok(existsSync(join(Models, name)), `${name} is missing: ${hint}`);
            const file = onDisk(name);
            if (name.endsWith('.png')) {
                //  by their pixels: the compressed bytes may differ between versions of zlib
                assert.deepEqual(readPng(file).pixels, readPng(bytes).pixels, `${name} is stale: ${hint}`);
            } else if ('textured.glb' === name) {
                const [a, b] = [readGlb(file), readGlb(bytes)];
                for (const part of ['asset', 'nodes', 'meshes', 'materials', 'textures', 'accessors']) {
                    assert.deepEqual(a.json[part], b.json[part], `${name} is stale: ${hint}`);
                }
                const picture = (glb: { json: Json; bin: Buffer }): Buffer => {
                    const view = glb.json.bufferViews[glb.json.images[0].bufferView];
                    return readPng(glb.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength))
                        .pixels;
                };
                assert.deepEqual(picture(a), picture(b), `${name} is stale: ${hint}`);
            } else {
                assert.ok(file.equals(bytes), `${name} is stale: ${hint}`);
            }
        }
    });

    it('say whose they are and how to make them again', () => {
        const readme = readFileSync(join(Models, 'README.md'), 'utf8');
        assert.match(readme, /CC BY 4\.0/);
        assert.match(readme, /make_models\.ts/);
        for (const name of Object.keys(made)) {
            assert.ok(readme.includes(name), `the README lists ${name}`);
            if (name.endsWith('.glb')) {
                assert.match(jsonOf(onDisk(name)).asset.copyright, /CC BY 4\.0/);
            }
        }
    });

    it('still.glb is a coloured solid of a few hundred triangles', () => {
        const figures = wellFormed(onDisk('still.glb'));
        assert.equal(figures.triangles, 288);
        assert.ok(figures.attributes.has('COLOR_0') && figures.attributes.has('NORMAL'));
        assert.deepEqual(
            [figures.primitives, figures.bones, figures.animations, figures.images],
            [1, 0, [], []]
        );
    });

    it('animated.glb has three parts and two named animations, one of them "idle"', () => {
        const file = onDisk('animated.glb');
        const figures = wellFormed(file);
        assert.deepEqual(figures.animations, ['idle', 'spin']);
        assert.deepEqual([figures.primitives, figures.animationSeconds, figures.bones], [3, 6, 0]);
        const json = jsonOf(file);
        assert.deepEqual(
            json.nodes.map((n: Json) => n.name),
            ['stand', 'arm', 'ball']
        );
        //  each animation moves two parts, and "spin" is the shorter
        assert.deepEqual(
            json.animations.map((a: Json) =>
                a.channels.map((c: Json) => `${c.target.node} ${c.target.path}`)
            ),
            [
                ['1 rotation', '2 translation'],
                ['1 rotation', '2 scale'],
            ]
        );
        assert.deepEqual(json.accessors[json.animations[1].samplers[0].input].max, [1]);
    });

    it('skinned.glb is a mesh on a short chain of bones that bend', () => {
        const file = onDisk('skinned.glb');
        const figures = wellFormed(file);
        assert.deepEqual([figures.bones, figures.triangles, figures.animations], [4, 256, ['bend']]);
        assert.ok(figures.attributes.has('JOINTS_0') && figures.attributes.has('WEIGHTS_0'));
        const { json, bin } = readGlb(file);
        assert.deepEqual(json.skins[0].joints, [1, 2, 3, 4]);
        assert.deepEqual(
            [1, 2, 3].map(at => json.nodes[at].children),
            [[2], [3], [4]]
        );
        //  every bone is turned by the animation, and every bone holds some of the mesh
        assert.deepEqual(
            json.animations[0].channels.map((c: Json) => `${c.target.node} ${c.target.path}`),
            ['1 rotation', '2 rotation', '3 rotation', '4 rotation']
        );
        const primitive = json.meshes[0].primitives[0];
        const joints = numbers(json, bin, primitive.attributes.JOINTS_0);
        const weights = numbers(json, bin, primitive.attributes.WEIGHTS_0);
        const held = new Set(joints.filter((_, at) => weights[at]! > 0));
        assert.deepEqual([...held].sort(), [0, 1, 2, 3]);
        assert.ok(
            weights.some(w => w > 0 && w < 1),
            'some vertices are shared between two bones'
        );
    });

    it('textured.glb carries a small PNG inside it, with no metadata', () => {
        const file = onDisk('textured.glb');
        const figures = wellFormed(file);
        assert.deepEqual([figures.images, figures.textureSide, figures.triangles], [['image/png'], 64, 12]);
        assert.ok(figures.attributes.has('TEXCOORD_0'));
        const { json, bin } = readGlb(file);
        const view = json.bufferViews[json.images[0].bufferView];
        const png = readPng(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
        assert.deepEqual(
            png.chunks.map(c => c.type),
            ['IHDR', 'IDAT', 'IEND']
        );
        assert.equal(png.after.length, 0);
        assert.ok(new Set(png.pixels).size > 3, 'a picture, not one flat colour');
    });

    it('each has a preview picture, and all are far inside the budget', () => {
        for (const name of ['still', 'animated', 'skinned', 'textured']) {
            const png = readPng(onDisk(`${name}.png`));
            assert.deepEqual([png.width, png.height, png.after.length], [256, 256, 0]);
            assert.deepEqual(
                png.chunks.map(c => c.type),
                ['IHDR', 'IDAT', 'IEND']
            );
            const file = onDisk(`${name}.glb`);
            const figures = wellFormed(file);
            assert.ok(file.length < 64 * 1024, `${name}.glb is small`);
            assert.ok(figures.triangles <= 1000 && figures.primitives <= 3 && figures.bones <= 4);
        }
    });
});

describe('models at and over the budget', () => {
    const measure: Record<BudgetKind, (glb: Buffer) => number> = {
        triangles: glb => wellFormed(glb).triangles,
        primitives: glb => wellFormed(glb).primitives,
        bones: glb => wellFormed(glb).bones,
        textureSide: glb => wellFormed(glb).textureSide,
        textureBytes: glb => wellFormed(glb).textureBytes,
        animations: glb => wellFormed(glb).animations.length,
        animationSeconds: glb => wellFormed(glb).animationSeconds,
        fileBytes: glb => (wellFormed(glb), glb.length),
    };
    const kinds = Object.keys(Light) as BudgetKind[];

    it('names the budget of class "light" as the build spec has it', () => {
        assert.deepEqual(Light, {
            triangles: 30000,
            primitives: 32,
            bones: 64,
            textureSide: 1024,
            textureBytes: 4 * 1024 * 1024,
            animations: 16,
            animationSeconds: 60,
            fileBytes: 8 * 1024 * 1024,
        });
    });

    for (const kind of kinds) {
        it(`${kind}: a well-formed model exactly at the budget, and one just over it`, () => {
            const at = measure[kind](budgetModel(kind, Light[kind]));
            const over = measure[kind](overBudget(kind));
            if ('textureBytes' === kind) {
                //  pictures cannot be sized to the byte: at least the amount, and not far over
                assert.ok(at >= Light[kind] && at < Light[kind] + 8192, `${at} bytes of textures`);
                assert.ok(over > Light[kind] && over < Light[kind] + 8192);
            } else {
                assert.equal(at, Light[kind]);
                assert.equal(over, Light[kind] + ('fileBytes' === kind ? 4 : 1));
            }
        });
    }

    it('keeps every texture within 1024 pixels a side while going over in bytes', () => {
        const figures = wellFormed(overBudget('textureBytes'));
        assert.equal(figures.textureSide, 1024);
        assert.ok(figures.images.length >= 2);
    });

    it('is over one figure only: the others stay inside the budget', () => {
        for (const kind of kinds) {
            const glb = overBudget(kind);
            const figures = wellFormed(glb);
            const all: Record<BudgetKind, number> = {
                triangles: figures.triangles,
                primitives: figures.primitives,
                bones: figures.bones,
                textureSide: figures.textureSide,
                textureBytes: figures.textureBytes,
                animations: figures.animations.length,
                animationSeconds: figures.animationSeconds,
                fileBytes: glb.length,
            };
            assert.deepEqual(
                kinds.filter(k => all[k] > Light[k]),
                [kind]
            );
        }
    });

    it('makes small ones too, and refuses a file size it cannot reach', () => {
        assert.equal(measure.triangles(budgetModel('triangles', 7)), 7);
        assert.equal(measure.bones(budgetModel('bones', 1)), 1);
        assert.equal(measure.animationSeconds(budgetModel('animationSeconds', 2.5)), 2.5);
        assert.equal(measure.fileBytes(budgetModel('fileBytes', 20000)), 20000);
        assert.throws(() => budgetModel('fileBytes', 20002), /multiple of 4/);
        assert.throws(() => budgetModel('fileBytes', 16), /too small/);
    });
});

describe('the hostile models', () => {
    const good = buildGlb(fullModel());
    const goodJson = jsonOf(good);
    const goodParts = container(good);

    it('start from a model with nothing wrong with it', () => {
        wellFormed(good);
    });

    it('bufferUri and imageUri: an address outside the file', () => {
        const buffer = hostile.bufferUri();
        assert.equal(jsonOf(buffer).buffers[0].uri, 'https://example.com/model.bin');
        assert.equal(container(buffer).chunks.length, 2, 'the binary chunk is still there');
        const image = jsonOf(hostile.imageUri()).images[0];
        assert.deepEqual(image, { uri: 'https://example.com/texture.png' });
    });

    it('bufferDataUri and imageDataUri: a data: address, with real contents', () => {
        const buffer = hostile.bufferDataUri();
        const uri: string = jsonOf(buffer).buffers[0].uri;
        assert.match(uri, /^data:application\/octet-stream;base64,/);
        assert.deepEqual(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'), goodParts.chunks[1]!.data);
        assert.deepEqual(
            container(buffer).chunks.map(c => c.type),
            ['JSON']
        );
        assert.equal(container(buffer).length, buffer.length);

        const image = jsonOf(hostile.imageDataUri()).images[0];
        assert.deepEqual(Object.keys(image), ['uri']);
        assert.match(image.uri, /^data:image\/png;base64,/);
        assert.equal(readPng(Buffer.from(image.uri.slice(image.uri.indexOf(',') + 1), 'base64')).width, 2);
    });

    it('lengthLonger and lengthShorter: a declared length that is not the file’s', () => {
        const longer = hostile.lengthLonger();
        assert.equal(longer.length, good.length);
        assert.equal(container(longer).length, good.length + 4);
        assert.deepEqual(longer.subarray(12), good.subarray(12), 'nothing else is changed');

        const shorter = hostile.lengthShorter();
        const parts = container(shorter);
        assert.equal(shorter.length, good.length);
        assert.equal(parts.length, good.length - 8);
        const last = parts.chunks[parts.chunks.length - 1]!;
        assert.ok(
            last.start < parts.length && parts.length < last.start + last.length,
            'it ends inside the last chunk'
        );
    });

    it('trailingBytes: bytes after a declared length that the chunks agree with', () => {
        const made = hostile.trailingBytes();
        const parts = container(made.subarray(0, good.length));
        assert.equal(made.length, good.length + 4);
        assert.equal(container(made).length, good.length);
        assert.deepEqual(parts, goodParts);
        assert.equal(made.toString('latin1', good.length), 'JUNK');
    });

    it('chunkPastEnd: a chunk longer than the file has room for', () => {
        const made = hostile.chunkPastEnd();
        const parts = container(made);
        const last = parts.chunks[parts.chunks.length - 1]!;
        assert.equal(parts.length, made.length);
        assert.equal(last.start + last.length, made.length + 8);
    });

    it('unpaddedJson: a JSON chunk off the four-byte boundary, with lengths that agree', () => {
        const made = hostile.unpaddedJson();
        const parts = container(made);
        assert.notEqual(parts.chunks[0]!.length % 4, 0);
        assert.equal(parts.length, made.length);
        assert.deepEqual(
            parts.chunks.map(c => c.type),
            ['JSON', 'BIN\0']
        );
        assert.equal(parts.chunks[1]!.start + parts.chunks[1]!.length, made.length);
        assert.deepEqual(jsonOf(made), goodJson);
    });

    it('twoJsonChunks, twoBinChunks and binFirst: the wrong chunks, in lengths that agree', () => {
        for (const [made, types] of [
            [hostile.twoJsonChunks(), ['JSON', 'JSON', 'BIN\0']],
            [hostile.twoBinChunks(), ['JSON', 'BIN\0', 'BIN\0']],
            [hostile.binFirst(), ['BIN\0', 'JSON']],
        ] as [Buffer, string[]][]) {
            const parts = container(made);
            assert.deepEqual(
                parts.chunks.map(c => c.type),
                types
            );
            assert.equal(parts.length, made.length);
            const last = parts.chunks[parts.chunks.length - 1]!;
            assert.equal(last.start + last.length, made.length);
            assert.ok(parts.chunks.every(c => 0 === c.length % 4));
        }
        const twice = container(hostile.twoJsonChunks()).chunks;
        assert.deepEqual(twice[0]!.data, twice[1]!.data);
    });

    it('badMagic and containerVersion: a header that is not glTF 2', () => {
        assert.equal(container(hostile.badMagic()).magic, 'glTG');
        assert.deepEqual(hostile.badMagic().subarray(4), good.subarray(4));
        assert.equal(container(hostile.containerVersion()).version, 1);
        assert.equal(container(hostile.containerVersion(good, 3)).version, 3);
        assert.deepEqual(hostile.containerVersion().subarray(8), good.subarray(8));
    });

    it('assetVersion: JSON that says another version', () => {
        assert.equal(jsonOf(hostile.assetVersion()).asset.version, '1.0');
        assert.equal(jsonOf(hostile.assetVersion(good, '3.0')).asset.version, '3.0');
        assert.equal(container(hostile.assetVersion()).version, 2);
    });

    it('jsonOverMegabyte: correct JSON, too much of it', () => {
        const made = hostile.jsonOverMegabyte();
        assert.ok(container(made).chunks[0]!.length > 1024 * 1024);
        assert.ok(made.length < 2 * 1024 * 1024);
        //  nothing else is wrong with it
        assert.equal(wellFormed(made).triangles, 152);
    });

    it('invalidUtf8: bytes that are not UTF-8, in JSON that is otherwise right', () => {
        const made = hostile.invalidUtf8();
        assert.equal(container(made).length, made.length);
        assert.throws(() => jsonOf(made), TypeError);
        const text = container(made).chunks[0]!.data.toString('latin1');
        assert.equal(JSON.parse(text).asset.generator, '@\xff\xfe@');
    });

    it('invalidJson: UTF-8 that is not JSON', () => {
        const made = hostile.invalidJson();
        assert.equal(container(made).length, made.length);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(container(made).chunks[0]!.data);
        assert.throws(() => JSON.parse(text), SyntaxError);
        assert.deepEqual(JSON.parse(text.trimEnd().replace(/\]$/, '}')), goodJson);
    });

    it('requiredExtension: one the hub does not allow, Draco unless told', () => {
        const json = jsonOf(hostile.requiredExtension());
        assert.deepEqual(json.extensionsRequired, ['KHR_draco_mesh_compression']);
        assert.deepEqual(json.extensionsUsed, ['KHR_draco_mesh_compression']);
        const other = jsonOf(
            hostile.requiredExtension(hostile.requiredExtension(), 'EXT_meshopt_compression')
        );
        assert.deepEqual(other.extensionsRequired, ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']);
        assert.equal(wellFormed(hostile.requiredExtension()).triangles, 152, 'nothing else is wrong with it');
    });

    it('bufferPastChunk, bufferViewPastEnd and accessorPastView: lengths that overrun', () => {
        const buffer = hostile.bufferPastChunk();
        assert.ok(jsonOf(buffer).buffers[0].byteLength > container(buffer).chunks[1]!.data.length);

        const view = jsonOf(hostile.bufferViewPastEnd());
        const overrun = view.bufferViews.filter(
            (v: Json) => v.byteOffset + v.byteLength > view.buffers[0].byteLength
        );
        assert.equal(overrun.length, 1);
        assert.ok(overrun[0].byteOffset + overrun[0].byteLength > goodParts.chunks[1]!.length);

        const made = hostile.accessorPastView();
        const json = jsonOf(made);
        const bin = container(made).chunks[1]!.data;
        assert.equal(json.accessors[0].count, goodJson.accessors[0].count + 1);
        assert.throws(() => numbers(json, bin, 0), /within its view/);
        assert.doesNotThrow(() => numbers(json, bin, 1));
    });

    it('indexOutOfRange: one index of the kind named, pointing at nothing', () => {
        const kinds: IndexKind[] = [
            'scene',
            'node',
            'mesh',
            'material',
            'texture',
            'image',
            'skin',
            'joint',
            'accessor',
            'bufferView',
            'buffer',
            'sampler',
            'target',
        ];
        assert.deepEqual(dangling(goodJson), []);
        for (const kind of kinds) {
            const made = hostile.indexOutOfRange(kind);
            assert.deepEqual(dangling(jsonOf(made)), [kind], kind);
            assert.equal(container(made).length, made.length);
        }
    });

    it('nodeCycle: a node that is its own descendant', () => {
        assert.deepEqual(inCycles(goodJson), []);
        assert.deepEqual(inCycles(jsonOf(hostile.nodeCycle())), [1, 2, 3]);
        assert.deepEqual(inCycles(jsonOf(hostile.nodeCycle(good, true))), [1]);
        assert.deepEqual(dangling(jsonOf(hostile.nodeCycle())), []);
    });

    it('damage a model of the caller’s as well, and say when it has nothing to damage', () => {
        const still = readFileSync(join(Models, 'still.glb'));
        assert.equal(hostile.trailingBytes(still).length, still.length + 4);
        assert.deepEqual(jsonOf(hostile.requiredExtension(still)).extensionsRequired, [
            'KHR_draco_mesh_compression',
        ]);
        assert.deepEqual(dangling(jsonOf(hostile.indexOutOfRange('mesh', still))), ['mesh']);
        assert.throws(() => hostile.indexOutOfRange('texture', still), /no texture/);
        assert.throws(() => hostile.nodeCycle(still), /no chain/);
    });

    it('never change the good model they were given', () => {
        const before = Buffer.from(good);
        for (const [name, make] of Object.entries(hostile)) {
            if ('indexOutOfRange' !== name) {
                (make as (glb: Buffer) => Buffer)(good);
            }
        }
        hostile.indexOutOfRange('node', good);
        assert.deepEqual(good, before);
        assert.deepEqual(buildGlb(fullModel()), before, 'nor the one they make for themselves');
    });
});
