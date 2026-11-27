//  The model checker (src/gltf.ts), against models it had no hand in: the
//  sample models on disk and the good, hostile and over-budget ones the
//  builder of glb.ts makes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { checkGlb, EffectTextures, LightBudget } from '../src/gltf.ts';
import type { ModelBudget } from '../src/gltf.ts';
import { HubError } from '../src/errors.ts';
import {
    Light,
    box,
    budgetModel,
    buildGlb,
    buildGltf,
    editGlb,
    fullModel,
    HiddenText,
    hostile,
    interleavedGlb,
    makeJpeg,
    makePng,
    overBudget,
    packChunks,
    packGlb,
    readGlb,
    strip,
    ChunkBin,
    ChunkJson,
} from './glb.ts';
import type { IndexKind, Json, Model } from './glb.ts';

const Models = join(import.meta.dirname, 'fixtures', 'models');

//  refused, as the hub refuses an asset, with a reason that names the fault
function refused(glb: Buffer, reason: RegExp, budget?: ModelBudget): void {
    assert.throws(
        () => checkGlb(glb, budget),
        (err: unknown) => {
            assert.ok(err instanceof HubError, `threw ${String(err)}`);
            assert.equal(err.code, 'asset');
            assert.match(err.message, reason);
            return true;
        }
    );
}

//  a good model with its JSON changed
function edited(edit: (json: Json) => void, glb: Buffer = buildGlb(fullModel())): Buffer {
    return editGlb(glb, edit);
}

//  the bytes each buffer view of a .glb covers
function viewBytes(glb: Buffer): Buffer[] {
    const { json, bin } = readGlb(glb);
    return ((json.bufferViews ?? []) as Json[]).map(view =>
        bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    );
}

//  the bytes of each image inside a .glb
function imageBytes(glb: Buffer): Buffer[] {
    const views = viewBytes(glb);
    return ((readGlb(glb).json.images ?? []) as Json[]).map(image => views[image.bufferView]!);
}

//  a part of a PNG, with its check (or a wrong one)
function pngChunk(type: string, data: Buffer, check?: number): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const made = Buffer.alloc(body.length + 8);
    made.writeUInt32BE(data.length, 0);
    body.copy(made, 4);
    made.writeUInt32BE(check ?? crc32(body), body.length + 4);
    return made;
}

//  a segment of a JPEG
function jpegSegment(marker: number, data: Buffer | string): Buffer {
    const body = 'string' === typeof data ? Buffer.from(data, 'latin1') : data;
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
}

//  the least a colour profile can be: its own length, and its mark
function colourProfile(length = 128): Buffer {
    const profile = Buffer.alloc(length);
    profile.writeUInt32BE(length, 0);
    profile.write('acsp', 36, 'latin1');
    return profile;
}

//  a model that is one image and nothing else: any bytes at all where a
//  picture should be
function pictureModel(bytes: Buffer): Buffer {
    return packGlb(
        {
            asset: { version: '2.0' },
            buffers: [{ byteLength: bytes.length }],
            bufferViews: [{ buffer: 0, byteLength: bytes.length }],
            images: [{ bufferView: 0 }],
        },
        bytes
    );
}

function triangle(at = 0): number[] {
    return [at, 0, 0, at + 1, 0, 0, at, 1, 0];
}

describe('the model checker: good models', () => {
    it('takes each sample model, with the figures it should have', () => {
        const expected: Record<string, object> = {
            'still.glb': {
                triangles: 288,
                drawCalls: 1,
                bones: 0,
                maxTextureSide: 0,
                texturePixels: 0,
                animations: [],
            },
            //  two boxes of 12 and a ball of 168
            'animated.glb': {
                triangles: 192,
                drawCalls: 3,
                bones: 0,
                maxTextureSide: 0,
                texturePixels: 0,
                animations: [
                    { name: 'idle', seconds: 6 },
                    { name: 'spin', seconds: 1 },
                ],
            },
            'skinned.glb': {
                triangles: 256,
                drawCalls: 1,
                bones: 4,
                maxTextureSide: 0,
                texturePixels: 0,
                animations: [{ name: 'bend', seconds: 4 }],
            },
            'textured.glb': {
                triangles: 12,
                drawCalls: 1,
                bones: 0,
                maxTextureSide: 64,
                texturePixels: 64 * 64,
                animations: [],
            },
        };
        for (const [name, figures] of Object.entries(expected)) {
            const glb = readFileSync(join(Models, name));
            const { cleaned, sha256, measured } = checkGlb(glb);
            const textureBytes = imageBytes(glb).reduce((sum, image) => sum + image.length, 0);
            assert.deepEqual(measured, { bytes: glb.length, textureBytes, effects: [], ...figures }, name);
            //  nothing in them to clean, so they come out as they went in
            assert.ok(cleaned.equals(glb), name);
            assert.equal(sha256, createHash('sha256').update(glb).digest('hex'), name);
        }
        assert.ok(imageBytes(readFileSync(join(Models, 'textured.glb')))[0]!.length > 0);
    });

    it('measures a model with one of everything', () => {
        const glb = buildGlb(fullModel());
        const { cleaned, measured } = checkGlb(glb);
        assert.deepEqual(measured, {
            bytes: glb.length,
            triangles: 152,
            drawCalls: 2,
            bones: 3,
            textureBytes: imageBytes(glb)[0]!.length,
            maxTextureSide: 8,
            texturePixels: 64,
            animations: [{ name: 'idle', seconds: 2 }],
            effects: [],
        });
        assert.ok(cleaned.equals(glb));
    });

    it('takes the smallest models: no scene at all, and one triangle', () => {
        assert.deepEqual(checkGlb(buildGlb({})).measured, {
            bytes: buildGlb({}).length,
            triangles: 0,
            drawCalls: 0,
            bones: 0,
            textureBytes: 0,
            maxTextureSide: 0,
            texturePixels: 0,
            animations: [],
            effects: [],
        });
        const one = checkGlb(
            buildGlb({ meshes: [{ primitives: [{ positions: triangle() }] }], nodes: [{ mesh: 0 }] })
        );
        assert.equal(one.measured.triangles, 1);
        assert.equal(one.measured.drawCalls, 1);
    });

    it('counts triangles by how a primitive is drawn', () => {
        const count = (mode: number | undefined, indexed: boolean): number => {
            const shape = strip(10); //  12 vertices, 30 indices
            const glb = edited(
                json => {
                    if (undefined !== mode) {
                        json.meshes[0].primitives[0].mode = mode;
                    }
                },
                buildGlb({
                    meshes: [{ primitives: [indexed ? shape : { positions: shape.positions }] }],
                    nodes: [{ mesh: 0 }],
                })
            );
            return checkGlb(glb).measured.triangles;
        };
        assert.equal(count(undefined, true), 10);
        assert.equal(count(4, true), 10);
        assert.equal(count(4, false), 4); //  12 positions, three each
        assert.equal(count(5, false), 10); //  a strip
        assert.equal(count(6, true), 28); //  a fan of 30 indices
        //  points and lines are held to the same figure: a point each, a
        //  line for two, or for each one more in a loop or a strip
        assert.equal(count(0, false), 12);
        assert.equal(count(0, true), 30);
        assert.equal(count(1, true), 15);
        assert.equal(count(1, false), 6);
        assert.equal(count(2, false), 12);
        assert.equal(count(3, false), 11);
        refused(
            edited(json => (json.meshes[0].primitives[0].mode = 7)),
            /unknown mode/
        );
    });

    it('counts a mesh once for each node that shows it, and not one no node shows', () => {
        const model: Model = {
            meshes: [{ primitives: [box(), box()] }, { primitives: [strip(5)] }],
            nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }],
        };
        const { measured } = checkGlb(buildGlb(model));
        assert.equal(measured.drawCalls, 6);
        assert.equal(measured.triangles, 72);
    });

    it('counts bones as the nodes skins move, or a skin’s joints if it names some twice', () => {
        const glb = budgetModel('bones', 5);
        assert.equal(checkGlb(glb).measured.bones, 5);
        //  a second skin on the same bones adds none
        const shared = edited(json => json.skins.push({ joints: [1, 2, 3] }), glb);
        assert.equal(checkGlb(shared).measured.bones, 5);
        const twice = edited(json => json.skins.push({ joints: [1, 1, 1, 1, 1, 1, 1] }), glb);
        assert.equal(checkGlb(twice).measured.bones, 7);
    });

    it('reads an animation’s length from its times, whatever the accessor says of them', () => {
        const glb = budgetModel('animationSeconds', 12.5);
        assert.deepEqual(checkGlb(glb).measured.animations, [{ name: 'long', seconds: 12.5 }]);
        //  the accessor's own word, if it claims less than is there
        const lying = edited(json => {
            json.accessors[json.animations[0].samplers[0].input].max = [1];
        }, glb);
        assert.equal(checkGlb(lying).measured.animations[0]!.seconds, 12.5);
        //  and if it claims more, the more is believed
        const longer = edited(json => {
            json.accessors[json.animations[0].samplers[0].input].max = [61];
        }, glb);
        refused(longer, /animation of 61 seconds/);
        const unnamed = edited(json => delete json.animations[0].name, glb);
        assert.deepEqual(checkGlb(unnamed).measured.animations, [{ name: '', seconds: 12.5 }]);
    });

    it('takes a required extension from the list, and leaves out any other that is only used', () => {
        for (const name of LightBudget.extensions) {
            const { cleaned } = checkGlb(hostile.requiredExtension(undefined, name));
            assert.ok(readGlb(cleaned).json.extensionsRequired.includes(name));
        }
        //  the viewer's loader would stop at the first of these, required
        //  or not, so the model is served without their names
        const used = checkGlb(
            edited(json => (json.extensionsUsed = ['KHR_draco_mesh_compression', 'VENDOR_thing']))
        );
        assert.equal(readGlb(used.cleaned).json.extensionsUsed, undefined);
        assert.ok(used.cleaned.equals(buildGlb(fullModel())));
        assert.deepEqual(LightBudget.extensions, [
            'KHR_materials_unlit',
            'KHR_materials_emissive_strength',
            'KHR_texture_transform',
            'KHR_mesh_quantization',
            'KHR_materials_clearcoat',
            'KHR_materials_sheen',
            'KHR_materials_transmission',
            'KHR_materials_volume',
            'KHR_materials_iridescence',
            'KHR_materials_specular',
        ]);
    });

    it('takes the material effects, names them, and holds their textures in range', () => {
        const withEffects = (extensions: Record<string, unknown>) =>
            edited(json => {
                json.materials[0].extensions = extensions;
                json.extensionsUsed = Object.keys(extensions);
            });
        const one = checkGlb(withEffects({ KHR_materials_sheen: { sheenColorTexture: { index: 0 } } }));
        assert.deepEqual(one.measured.effects, ['KHR_materials_sheen']);
        assert.deepEqual(readGlb(one.cleaned).json.materials[0].extensions, {
            KHR_materials_sheen: { sheenColorTexture: { index: 0 } },
        });
        const two = checkGlb(
            withEffects({ KHR_materials_transmission: {}, KHR_materials_clearcoat: { clearcoatFactor: 1 } })
        );
        assert.deepEqual(two.measured.effects, ['KHR_materials_clearcoat', 'KHR_materials_transmission']);
        //  every texture entry of every effect is a reference to hold
        for (const [name, entries] of Object.entries(EffectTextures)) {
            for (const entry of entries) {
                refused(withEffects({ [name]: { [entry]: { index: 9 } } }), /a material's texture/);
                refused(withEffects({ [name]: { [entry]: { index: -1 } } }), /a material's texture/);
            }
            refused(withEffects({ [name]: 'clear' }), new RegExp(`${name} entry`));
        }
        //  an effect the hub does not take is still left out, references and all
        const dropped = checkGlb(
            withEffects({ KHR_materials_anisotropy: { anisotropyTexture: { index: 9 } } })
        );
        assert.equal(readGlb(dropped.cleaned).json.materials[0].extensions, undefined);
        assert.deepEqual(dropped.measured.effects, []);
    });

    it('keeps extras, the generator and everything else in the JSON as it was', () => {
        const glb = edited(json => {
            json.extras = { note: 'kept', list: [1, 2, { deep: true }] };
            json.nodes[0].extras = { tag: 'héllo' };
            json.asset.generator = 'Some Exporter 1.2';
            json.asset.copyright = 'Someone';
            json.extensionsUsed = ['KHR_materials_unlit'];
            json.materials[0].extensions = { KHR_materials_unlit: {} };
        });
        const { cleaned } = checkGlb(glb);
        assert.deepEqual(readGlb(cleaned).json, readGlb(glb).json);
        assert.ok(readGlb(cleaned).bin.equals(readGlb(glb).bin));
    });

    it('takes an accessor with a stride of its own, held within its buffer view', () => {
        //  positions spread 16 bytes apart, in a view of 3 * 16 bytes
        const data = Buffer.alloc(48);
        triangle().forEach((v, at) => data.writeFloatLE(v, Math.floor(at / 3) * 16 + (at % 3) * 4));
        const json = (stride: number, count: number, length = 48): Json => ({
            asset: { version: '2.0' },
            buffers: [{ byteLength: 48 }],
            bufferViews: [{ buffer: 0, byteLength: length, byteStride: stride }],
            accessors: [{ bufferView: 0, componentType: 5126, count, type: 'VEC3' }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            nodes: [{ mesh: 0 }],
            scenes: [{ nodes: [0] }],
        });
        assert.equal(checkGlb(packGlb(json(16, 3), data)).measured.triangles, 1);
        //  the last element needs a whole stride, not only its own 12
        //  bytes: the viewer reads as many strides as the count
        refused(packGlb(json(16, 3, 44), data), /accessor that runs past the end of its buffer view/);
        refused(packGlb(json(16, 3, 40), data), /accessor that runs past the end of its buffer view/);
        refused(packGlb(json(16, 4), data), /accessor that runs past the end of its buffer view/);
        refused(packGlb(json(8, 3), data), /larger than its stride/);
        refused(packGlb(json(6, 3), data), /stride out of range/);
        refused(packGlb(json(256, 1), data), /stride out of range/);
    });
});

describe('the model checker: hostile models', () => {
    const cases: [string, () => Buffer, RegExp][] = [
        ['bufferUri', () => hostile.bufferUri(), /buffer kept outside the file/],
        ['bufferDataUri', () => hostile.bufferDataUri(), /buffer kept outside the file/],
        ['imageUri', () => hostile.imageUri(), /image kept outside the file/],
        ['imageDataUri', () => hostile.imageDataUri(), /image kept outside the file/],
        ['lengthLonger', () => hostile.lengthLonger(), /shorter than the length it declares/],
        ['lengthShorter', () => hostile.lengthShorter(), /bytes after the length the model declares/],
        ['trailingBytes', () => hostile.trailingBytes(), /bytes after the length the model declares/],
        ['chunkPastEnd', () => hostile.chunkPastEnd(), /chunk that runs past the end of the file/],
        ['unpaddedJson', () => hostile.unpaddedJson(), /not padded to four bytes/],
        ['twoJsonChunks', () => hostile.twoJsonChunks(), /second chunk that is not the binary one/],
        ['twoBinChunks', () => hostile.twoBinChunks(), /more chunks than/],
        ['binFirst', () => hostile.binFirst(), /first chunk is not its JSON/],
        ['badMagic', () => hostile.badMagic(), /not binary glTF/],
        ['containerVersion', () => hostile.containerVersion(), /binary glTF of version 1/],
        ['assetVersion', () => hostile.assetVersion(), /not glTF version 2\.0/],
        [
            'jsonOverMegabyte',
            () => hostile.jsonOverMegabyte(),
            /JSON of \d+ bytes, over the limit of 1048576/,
        ],
        ['invalidUtf8', () => hostile.invalidUtf8(), /not UTF-8/],
        ['invalidJson', () => hostile.invalidJson(), /JSON that cannot be read/],
        [
            'requiredExtension',
            () => hostile.requiredExtension(),
            /requires an extension .*KHR_draco_mesh_compression/,
        ],
        ['bufferPastChunk', () => hostile.bufferPastChunk(), /buffer longer than the binary chunk/],
        ['bufferViewPastEnd', () => hostile.bufferViewPastEnd(), /buffer view that runs past the end/],
        ['accessorPastView', () => hostile.accessorPastView(), /accessor that runs past the end/],
        ['nodeCycle', () => hostile.nodeCycle(), /its own ancestor/],
        ['nodeCycle, of one', () => hostile.nodeCycle(undefined, true), /its own ancestor/],
    ];
    for (const [name, make, reason] of cases) {
        it(`refuses ${name}`, () => refused(make(), reason));
    }

    it('refuses an index of any kind that points at nothing', () => {
        const kinds: Record<IndexKind, RegExp> = {
            scene: /the model's scene that points at nothing \(999\)/,
            node: /scene's node that points at nothing/,
            mesh: /node's mesh that points at nothing/,
            material: /primitive's material that points at nothing/,
            texture: /material's texture that points at nothing/,
            image: /texture's image that points at nothing/,
            skin: /node's skin that points at nothing/,
            joint: /skin's joint that points at nothing/,
            accessor: /primitive's accessor that points at nothing/,
            bufferView: /accessor's buffer view that points at nothing/,
            buffer: /buffer view's buffer that points at nothing/,
            sampler: /animation channel's sampler that points at nothing/,
            target: /animation's target node that points at nothing/,
        };
        for (const [kind, reason] of Object.entries(kinds)) {
            refused(hostile.indexOutOfRange(kind as IndexKind), reason);
        }
    });

    it('refuses the other references that point at nothing', () => {
        const others: [(json: Json) => void, RegExp][] = [
            [json => (json.nodes[0].camera = 0), /node's camera that points at nothing/],
            [json => (json.nodes[0].children = [999]), /node's child that points at nothing/],
            [json => (json.textures[0].sampler = 0), /texture's sampler that points at nothing/],
            [json => (json.materials[1].normalTexture = { index: 5 }), /material's texture/],
            [json => (json.materials[1].emissiveTexture = { index: 5 }), /material's texture/],
            [json => (json.materials[1].occlusionTexture = { index: 5 }), /material's texture/],
            [
                json => (json.materials[1].pbrMetallicRoughness.metallicRoughnessTexture = { index: 5 }),
                /material's texture/,
            ],
            [
                json => (json.meshes[0].primitives[0].indices = 999),
                /primitive's indices that points at nothing/,
            ],
            [json => (json.meshes[0].primitives[0].targets = [{ POSITION: 999 }]), /morph target's accessor/],
            [json => (json.skins[0].skeleton = 999), /skin's root that points at nothing/],
            [json => (json.skins[0].inverseBindMatrices = 999), /skin's matrices that points at nothing/],
            [
                json => (json.animations[0].samplers[0].input = 999),
                /animation's accessor that points at nothing/,
            ],
            [
                json => (json.animations[0].samplers[1].output = 999),
                /animation's accessor that points at nothing/,
            ],
            [json => (json.images[0].bufferView = 999), /image's buffer view that points at nothing/],
        ];
        for (const [edit, reason] of others) {
            refused(edited(edit), reason);
        }
        //  and takes those that point at something
        checkGlb(
            edited(json => {
                json.cameras = [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }];
                json.samplers = [{}];
                json.nodes[4].camera = 0;
                json.textures[0].sampler = 0;
                json.skins[0].skeleton = 1;
            })
        );
    });

    it('refuses an index that is not a whole number from nought up', () => {
        for (const wrong of [-1, 1.5, '0', null, true, [0], {}, 2 ** 53, 1e300]) {
            refused(
                edited(json => (json.nodes[0].mesh = wrong)),
                /node's mesh that (is not a whole number|points at nothing)/
            );
            refused(
                edited(json => (json.meshes[0].primitives[0].attributes.POSITION = wrong)),
                /primitive's accessor that (is not a whole number|points at nothing)/
            );
            refused(
                edited(json => (json.accessors[0].count = wrong)),
                /accessor's count that is not a whole number|runs past the end/
            );
            refused(
                edited(json => (json.bufferViews[0].byteLength = wrong)),
                /buffer view's length that is not a whole number|runs past the end/
            );
            refused(
                edited(json => (json.bufferViews[1].byteOffset = wrong)),
                /buffer view's offset that is not a whole number|runs past the end/
            );
            refused(
                edited(json => (json.buffers[0].byteLength = wrong)),
                /buffer's length that is not a whole number|longer than the binary chunk/
            );
        }
    });

    it('refuses the wrong kind of thing where an object or a list belongs', () => {
        const wrongs: [(json: Json) => void, RegExp][] = [
            [json => (json.nodes = { length: 3 }), /other than a list where a node is listed/],
            [json => (json.nodes[1] = 7), /a node that is not an object/],
            [json => (json.meshes[0] = null), /a mesh that is not an object/],
            [json => (json.meshes[0].primitives = 'all'), /other than a list where a primitive is listed/],
            [json => (json.meshes[0].primitives[0].attributes = [0]), /attributes that is not an object/],
            [json => (json.nodes[1].children = 2), /node's children that is not a list/],
            [json => (json.scenes[0].nodes = {}), /scene's nodes that is not a list/],
            [json => (json.skins[0].joints = 'all'), /skin's joints that is not a list/],
            [json => (json.skins[0].joints = []), /skin without joints/],
            [json => (json.animations[0].channels[0].target = 4), /target that is not an object/],
            [json => (json.animations[0].name = 5), /animation whose name is not text/],
            [json => (json.asset = 'glTF'), /asset entry that is not an object/],
            [json => delete json.asset, /asset entry that is not an object/],
            [json => (json.asset.version = 2), /not glTF version 2\.0/],
            [json => (json.asset.minVersion = '2.1'), /needs a later glTF/],
            [
                json => (json.extensionsRequired = 'KHR_materials_unlit'),
                /required extensions that is not a list/,
            ],
            [json => (json.extensionsRequired = [7]), /extension whose name is not text/],
            [json => (json.extensionsUsed = [{}]), /extension whose name is not text/],
            [json => (json.materials[0].pbrMetallicRoughness = 1), /colour entry that is not an object/],
            [
                json => (json.materials[0].pbrMetallicRoughness.baseColorTexture = 0),
                /texture entry that is not an object/,
            ],
            [json => (json.buffers = [{ byteLength: 4 }, { byteLength: 4 }]), /more than one buffer/],
        ];
        for (const [edit, reason] of wrongs) {
            refused(edited(edit), reason);
        }
        for (const whole of ['[]', '7', 'null', '"glTF"']) {
            refused(packGlb(Buffer.from(whole)), /a model that is not an object/);
        }
    });

    it('refuses accessors it cannot hold against the bytes', () => {
        const wrongs: [(json: Json) => void, RegExp][] = [
            [json => (json.accessors[0].sparse = { count: 1 }), /sparse accessor/],
            [json => delete json.accessors[0].bufferView, /accessor with no buffer view/],
            [json => (json.accessors[0].componentType = 5124), /unknown component type/],
            [json => (json.accessors[0].componentType = 'constructor'), /unknown component type/],
            [json => (json.accessors[0].type = 'VEC5'), /accessor of an unknown type/],
            [json => (json.accessors[0].type = 'constructor'), /accessor of an unknown type/],
            [json => (json.accessors[0].count = 0), /accessor with nothing in it/],
            [json => (json.accessors[0].count = 2 ** 52), /accessor that runs past the end/],
            [json => (json.accessors[0].byteOffset = 4), /accessor that runs past the end/],
            [json => (json.accessors[0].byteOffset = 2 ** 40), /accessor that runs past the end/],
            [
                json => {
                    json.accessors[0].count -= 1;
                    json.accessors[0].byteOffset = 2;
                },
                /off the boundary/,
            ],
            [json => (json.bufferViews[0].byteLength = 0), /empty buffer view/],
            [json => (json.bufferViews[0].byteOffset = 2 ** 40), /buffer view that runs past the end/],
            [
                json =>
                    (json.meshes[0].primitives[0].attributes.NORMAL =
                        json.meshes[1].primitives[0].attributes.NORMAL),
                /attributes differ in length/,
            ],
            [json => delete json.meshes[0].primitives[0].attributes.POSITION, /without positions/],
            [
                json =>
                    (json.meshes[0].primitives[0].attributes.POSITION = json.meshes[0].primitives[0].indices),
                /positions that are not three numbers/,
            ],
            [
                json =>
                    (json.meshes[0].primitives[0].indices = json.meshes[0].primitives[0].attributes.POSITION),
                /indices that are not whole numbers/,
            ],
            [
                json =>
                    (json.skins[0].inverseBindMatrices = json.meshes[0].primitives[0].attributes.POSITION),
                /matrices do not fit/,
            ],
            [
                json => (json.animations[0].samplers[0].input = json.animations[0].samplers[0].output),
                /times are not numbers of seconds/,
            ],
        ];
        for (const [edit, reason] of wrongs) {
            refused(edited(edit), reason);
        }
    });

    it('refuses an animation whose last time is not a number', () => {
        const { json, bin } = buildGltf(fullModel());
        const view = json.bufferViews[json.accessors[json.animations[0].samplers[0].input].bufferView];
        bin.writeFloatLE(NaN, view.byteOffset + view.byteLength - 4);
        refused(packGlb(json, bin), /time that is not a number/);
        bin.writeFloatLE(Infinity, view.byteOffset + view.byteLength - 4);
        refused(packGlb(json, bin), /time that is not a number/);
    });

    it('refuses a node with two parents, in one list or in two', () => {
        refused(
            edited(json => (json.nodes[4].children = [3])),
            /node with two parents/
        );
        refused(
            edited(json => (json.nodes[1].children = [2, 2])),
            /node with two parents/
        );
    });

    it('refuses a long ring of nodes, and takes a long chain, without recursion', () => {
        const count = 20000;
        const chain = (ring: boolean): Buffer =>
            packGlb({
                asset: { version: '2.0' },
                nodes: Array.from({ length: count }, (_, at) =>
                    at + 1 < count ? { children: [at + 1] } : ring ? { children: [5] } : {}
                ),
            });
        //  (more nodes than class "light" takes, so under a budget that does)
        const roomy = { ...LightBudget, nodes: count };
        checkGlb(chain(false), roomy);
        //  the ring's start has the node before it and the last as parents;
        //  a ring of them all has no such node
        refused(chain(true), /two parents/, roomy);
        refused(
            packGlb({
                asset: { version: '2.0' },
                nodes: Array.from({ length: count }, (_, at) => ({ children: [(at + 1) % count] })),
            }),
            /its own ancestor/,
            roomy
        );
    });

    it('refuses JSON nested too deep, numbers too large, and a mark before the JSON', () => {
        const deep = (depth: number): Buffer =>
            packGlb(
                Buffer.from(`{"asset":{"version":"2.0"},"extras":${'['.repeat(depth)}${']'.repeat(depth)}}`)
            );
        checkGlb(deep(40));
        refused(deep(200), /nested too deep/);
        refused(deep(200000), /nested too deep/);
        refused(
            packGlb(Buffer.from('{"asset":{"version":"2.0"},"extras":{"big":1e999}}')),
            /number in the JSON too large/
        );
        refused(
            packGlb(Buffer.from('{"asset":{"version":"2.0"},"nodes":[{"mesh":-1e999}]}')),
            /number in the JSON too large/
        );
        refused(
            packGlb(
                Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"asset":{"version":"2.0"}}')])
            ),
            /JSON that cannot be read/
        );
        //  names from the object every object inherits from are only names
        //  to the checker, and are refused all the same (see below)
        refused(
            packGlb(
                Buffer.from('{"asset":{"version":"2.0"},"__proto__":{"nodes":[{"mesh":9}]},"constructor":1}')
            ),
            /name in the JSON that the hub does not take/
        );
    });

    it('refuses a model whose JSON would outgrow the limit when written again', () => {
        //  1e20 is four bytes to read and twenty-one to write
        const numbers = new Array<string>(100000).fill('1e20').join(',');
        const glb = packGlb(Buffer.from(`{"asset":{"version":"2.0"},"extras":[${numbers}]}`));
        refused(glb, /does not hold once rewritten: JSON of \d+ bytes, over the limit/);
    });

    it('reads repeated keys one way, and serves that reading', () => {
        const glb = packGlb(
            Buffer.from(
                '{"asset":{"version":"1.0","version":"2.0"},"nodes":[{"mesh":5,"mesh":null,"name":"a"}]}'
            )
        );
        refused(glb, /node's mesh that is not a whole number/);
        const kept = packGlb(Buffer.from('{ "asset" : {"version":"1.0", "version":"2.0"} }'));
        assert.deepEqual(readGlb(checkGlb(kept).cleaned).json, { asset: { version: '2.0' } });
    });

    it('refuses the container’s other faults', () => {
        const json = Buffer.from('{"asset":{"version":"2.0"}} ');
        refused(Buffer.alloc(0), /too short/);
        refused(Buffer.from('glTF'), /too short/);
        refused(packChunks([{ type: ChunkJson, data: Buffer.alloc(0) }]), /no JSON/);
        refused(
            packChunks([{ type: ChunkJson, data: json, length: 0xfffffffc }]),
            /past the end of the file/
        );
        refused(
            packChunks([
                { type: ChunkJson, data: json },
                { type: ChunkBin, data: Buffer.alloc(8), length: 0xfffffff0 },
            ]),
            /past the end of the file/
        );
        refused(
            Buffer.concat([packChunks([{ type: ChunkJson, data: json }], { length: 52 }), Buffer.alloc(4)]),
            /not a chunk/
        );
        refused(
            packChunks([
                { type: ChunkJson, data: json },
                { type: ChunkBin, data: Buffer.alloc(6) },
            ]),
            /not padded to four bytes/
        );
        refused(
            packChunks([
                { type: ChunkJson, data: json },
                { type: 0x12345678, data: Buffer.alloc(8) },
            ]),
            /second chunk that is not the binary one/
        );
        refused(hostile.containerVersion(undefined, 3), /version 3/);
        //  a buffer with no chunk, and a chunk no buffer names (dropped)
        refused(packGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }), /no binary chunk/);
        const spare = checkGlb(packGlb({ asset: { version: '2.0' } }, Buffer.from('hidden text')));
        assert.ok(spare.cleaned.equals(packGlb({ asset: { version: '2.0' } })));
    });
});

describe('the model checker: the budget', () => {
    it('has the limits of class "light"', () => {
        assert.deepEqual(
            { ...LightBudget, extensions: undefined },
            {
                fileBytes: 8 * 1024 * 1024,
                jsonBytes: 1024 * 1024,
                triangles: 30000,
                drawCalls: 32,
                textureBytes: 4 * 1024 * 1024,
                textureSide: 1024,
                texturePixels: 8 * 1024 * 1024,
                bones: 64,
                nodes: 1000,
                morphTargets: 8,
                attributes: 16,
                animations: 16,
                animationSeconds: 60,
                animationChannels: 64,
                extensions: undefined,
            }
        );
        assert.equal(LightBudget.triangles, Light.triangles);
        assert.equal(LightBudget.drawCalls, Light.primitives);
        assert.equal(LightBudget.bones, Light.bones);
        assert.equal(LightBudget.textureSide, Light.textureSide);
        assert.equal(LightBudget.textureBytes, Light.textureBytes);
        assert.equal(LightBudget.animations, Light.animations);
        assert.equal(LightBudget.animationSeconds, Light.animationSeconds);
        assert.equal(LightBudget.fileBytes, Light.fileBytes);
    });

    it('triangles: 30,000 pass and one more is refused', () => {
        assert.equal(checkGlb(budgetModel('triangles', Light.triangles)).measured.triangles, 30000);
        refused(overBudget('triangles'), /30001 triangles, over the limit of 30000/);
    });

    it('draw calls: 32 pass and one more is refused', () => {
        assert.equal(checkGlb(budgetModel('primitives', Light.primitives)).measured.drawCalls, 32);
        refused(overBudget('primitives'), /33 draw calls, over the limit of 32/);
    });

    it('bones: 64 pass and one more is refused', () => {
        assert.equal(checkGlb(budgetModel('bones', Light.bones)).measured.bones, 64);
        refused(overBudget('bones'), /65 bones, over the limit of 64/);
    });

    it('a texture’s side: 1024 pixels pass and one more is refused, either way up', () => {
        assert.equal(checkGlb(budgetModel('textureSide', Light.textureSide)).measured.maxTextureSide, 1024);
        refused(overBudget('textureSide'), /texture of 1025 by 4 pixels, over the limit of 1024 a side/);
        const tall = (height: number, jpeg: boolean): Buffer =>
            buildGlb({
                materials: [
                    { texture: jpeg ? makeJpeg({ width: 8, height }) : makePng({ width: 2, height }) },
                ],
                meshes: [{ primitives: [{ ...box(), material: 0 }] }],
                nodes: [{ mesh: 0 }],
            });
        assert.equal(checkGlb(tall(1024, false)).measured.maxTextureSide, 1024);
        refused(tall(1025, false), /texture of 2 by 1025 pixels/);
        assert.equal(checkGlb(tall(1024, true)).measured.maxTextureSide, 1024);
        refused(tall(1025, true), /texture of 8 by 1025 pixels/);
    });

    it('texture bytes: the limit to the byte passes and one byte over is refused', () => {
        //  pictures cannot be made to a size to the byte, so the limit is
        //  set to what the model has
        const glb = budgetModel('textureBytes', 200000);
        const bytes = imageBytes(glb).reduce((sum, image) => sum + image.length, 0);
        assert.ok(imageBytes(glb).length > 1 || bytes >= 200000);
        assert.equal(checkGlb(glb, { ...LightBudget, textureBytes: bytes }).measured.textureBytes, bytes);
        refused(glb, new RegExp(`textures of ${bytes} bytes together, over the limit of ${bytes - 1}`), {
            ...LightBudget,
            textureBytes: bytes - 1,
        });
        //  and the real limit, with the builder's model a little over it
        refused(overBudget('textureBytes'), /textures of \d+ bytes together, over the limit of 4194304/);
    });

    it('animations: 16 pass and one more is refused', () => {
        assert.equal(checkGlb(budgetModel('animations', Light.animations)).measured.animations.length, 16);
        refused(overBudget('animations'), /17 animations, over the limit of 16/);
    });

    it('an animation’s length: 60 seconds pass and 61 are refused', () => {
        const at = checkGlb(budgetModel('animationSeconds', Light.animationSeconds));
        assert.deepEqual(at.measured.animations, [{ name: 'long', seconds: 60 }]);
        refused(overBudget('animationSeconds'), /animation of 61 seconds, over the limit of 60/);
        refused(budgetModel('animationSeconds', 60.5), /animation of 60\.5 seconds/);
    });

    it('the file: 8 MB to the byte passes and four bytes more are refused', () => {
        const at = budgetModel('fileBytes', Light.fileBytes);
        assert.equal(checkGlb(at).measured.bytes, 8 * 1024 * 1024);
        refused(overBudget('fileBytes'), /model of 8388612 bytes, over the limit of 8388608/);
    });

    it('takes a caller’s own limits in place of these', () => {
        const glb = buildGlb(fullModel());
        refused(glb, /152 triangles, over the limit of 100/, { ...LightBudget, triangles: 100 });
        refused(glb, /2 draw calls, over the limit of 1/, { ...LightBudget, drawCalls: 1 });
        refused(glb, /3 bones, over the limit of 2/, { ...LightBudget, bones: 2 });
        refused(glb, /1 animations, over the limit of 0/, { ...LightBudget, animations: 0 });
        refused(glb, /animation of 2 seconds, over the limit of 1/, { ...LightBudget, animationSeconds: 1 });
        refused(glb, /texture of 8 by 8 pixels, over the limit of 4 a side/, {
            ...LightBudget,
            textureSide: 4,
        });
        refused(glb, new RegExp(`model of ${glb.length} bytes, over the limit of 1000`), {
            ...LightBudget,
            fileBytes: 1000,
        });
        refused(glb, /JSON of \d+ bytes, over the limit of 100/, { ...LightBudget, jsonBytes: 100 });
        refused(hostile.requiredExtension(glb, 'KHR_materials_unlit'), /requires an extension/, {
            ...LightBudget,
            extensions: [],
        });
        checkGlb(hostile.requiredExtension(), { ...LightBudget, extensions: ['KHR_draco_mesh_compression'] });
    });
});

describe('the model checker: pictures and cleaning', () => {
    const plainPng = makePng({ width: 16, height: 8, colour: [10, 200, 90] });
    const loadedPng = makePng({
        width: 16,
        height: 8,
        colour: [10, 200, 90],
        text: { Comment: `taken with a ${HiddenText}`, Author: 'Someone Real' },
        exif: true,
        trailing: Buffer.from('bytes hidden after the end'),
    });
    const plainJpeg = makeJpeg({ width: 24, height: 16, colour: [200, 30, 30] });
    const loadedJpeg = makeJpeg({
        width: 24,
        height: 16,
        colour: [200, 30, 30],
        exif: true,
        comment: 'a comment by Someone Real',
        trailing: Buffer.from('more bytes hidden after the end'),
    });
    const withTextures = (...textures: Buffer[]): Buffer =>
        buildGlb({
            ...fullModel(),
            materials: textures.map(texture => ({ texture })),
            meshes: [
                {
                    primitives: textures.map((_, at) => ({ ...box(), material: at })),
                },
            ],
            nodes: [{ mesh: 0 }, { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
            skins: [],
        });

    it('strips a PNG and a JPEG of metadata and trailing bytes, and leaves the pictures’ data alone', () => {
        const glb = withTextures(loadedPng, loadedJpeg);
        assert.ok(glb.includes(HiddenText) && glb.includes('Someone Real') && glb.includes('hidden after'));
        const { cleaned, sha256, measured } = checkGlb(glb);
        for (const hidden of [HiddenText, 'Someone Real', 'hidden after', 'Exif', 'tEXt', 'eXIf']) {
            assert.ok(!cleaned.includes(hidden), hidden);
        }
        //  what is left of each is, byte for byte, the picture made
        //  without any of it: the same header, pixels and end
        const images = imageBytes(cleaned);
        assert.ok(images[0]!.equals(plainPng));
        assert.ok(images[1]!.equals(plainJpeg));
        assert.equal(measured.textureBytes, plainPng.length + plainJpeg.length);
        assert.equal(measured.maxTextureSide, 24);
        assert.equal(measured.bytes, cleaned.length);
        assert.ok(cleaned.length < glb.length);
        assert.equal(sha256, createHash('sha256').update(cleaned).digest('hex'));
    });

    it('moves everything after a picture down, unchanged and on its boundary', () => {
        const glb = withTextures(loadedPng, loadedJpeg);
        const { cleaned } = checkGlb(glb);
        const before = viewBytes(glb);
        const after = viewBytes(cleaned);
        const was = readGlb(glb).json;
        const now = readGlb(cleaned).json;
        assert.equal(after.length, before.length);
        const pictures = new Set((was.images as Json[]).map(image => image.bufferView));
        assert.equal(pictures.size, 2);
        before.forEach((bytes, at) => {
            if (!pictures.has(at)) {
                assert.ok(after[at]!.equals(bytes), `buffer view ${at}`);
                assert.ok(bytes.length > 0);
            }
            assert.equal((now.bufferViews[at].byteOffset ?? 0) % 4, 0);
        });
        assert.ok(
            now.bufferViews[now.bufferViews.length - 1].byteOffset <
                was.bufferViews[was.bufferViews.length - 1].byteOffset
        );
        //  the buffer and the chunk are as long as what is in them
        const bin = readGlb(cleaned).bin;
        assert.equal(Math.ceil(now.buffers[0].byteLength / 4) * 4, bin.length);
        assert.equal(cleaned.length % 4, 0);
        //  and nothing else in the JSON has changed
        for (const json of [was, now]) {
            for (const view of json.bufferViews as Json[]) {
                delete view.byteOffset;
                delete view.byteLength;
            }
            delete json.buffers[0].byteLength;
        }
        assert.deepEqual(now, was);
    });

    it('is idempotent: a cleaned model passes again, unchanged, with the same figures', () => {
        const goods = [
            buildGlb(fullModel()),
            withTextures(loadedPng, loadedJpeg),
            withTextures(loadedJpeg, loadedPng, loadedPng),
            budgetModel('bones', 9),
            buildGlb({}),
            ...['still', 'animated', 'skinned', 'textured'].map(name =>
                readFileSync(join(Models, `${name}.glb`))
            ),
        ];
        for (const glb of goods) {
            const first = checkGlb(glb);
            const second = checkGlb(first.cleaned);
            assert.ok(second.cleaned.equals(first.cleaned));
            assert.equal(second.sha256, first.sha256);
            assert.deepEqual(second.measured, first.measured);
        }
    });

    it('never hands back the bytes it was given', () => {
        const glb = buildGlb(fullModel());
        const copy = Buffer.from(glb);
        const { cleaned } = checkGlb(glb);
        assert.ok(glb.equals(copy));
        cleaned.fill(0);
        assert.ok(glb.equals(copy));
    });

    it('takes a picture for what its bytes are, not what the model calls it', () => {
        const glb = withTextures(plainPng);
        refused(
            edited(json => (json.images[0].mimeType = 'image/jpeg'), glb),
            /not of the type the model says/
        );
        refused(
            edited(json => (json.images[0].mimeType = 'image/webp'), glb),
            /not of the type the model says/
        );
        checkGlb(edited(json => delete json.images[0].mimeType, glb));
        const other = (bytes: Buffer): Buffer => {
            const { json, bin } = buildGltf({ ...fullModel() });
            const view = json.bufferViews[json.images[0].bufferView];
            bin.fill(0, view.byteOffset, view.byteOffset + view.byteLength);
            bytes.copy(bin, view.byteOffset);
            return packGlb(json, bin);
        };
        refused(other(Buffer.from('GIF89a')), /neither a PNG nor a JPEG/);
        refused(other(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), /neither a PNG nor a JPEG/);
        refused(other(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /neither a PNG nor a JPEG/);
        refused(
            edited(json => delete json.images[0].bufferView),
            /image with no buffer view/
        );
    });

    it('refuses pictures that are cut short or have no picture in them', () => {
        //  any bytes at all where a picture should be
        const png = (bytes: Buffer): Buffer =>
            packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: bytes.length }],
                    bufferViews: [{ buffer: 0, byteLength: bytes.length }],
                    images: [{ bufferView: 0 }],
                },
                bytes
            );
        checkGlb(png(plainPng));
        checkGlb(png(plainJpeg));
        refused(png(plainPng.subarray(0, plainPng.length - 12)), /PNG that is cut short/);
        refused(png(plainPng.subarray(0, 40)), /PNG that is cut short/);
        refused(png(plainPng.subarray(0, 8)), /PNG that is cut short/);
        refused(
            png(Buffer.concat([plainPng.subarray(0, 8), plainPng.subarray(33)])),
            /PNG without its header/
        );
        refused(
            png(Buffer.concat([plainPng.subarray(0, 33), plainPng.subarray(plainPng.length - 12)])),
            /PNG without a picture/
        );
        refused(png(Buffer.concat([plainPng.subarray(0, 33), plainPng.subarray(8)])), /PNG with two headers/);
        const huge = Buffer.from(plainPng);
        huge.writeUInt32BE(0xfffffff0, 33); //  the length of its pixels
        refused(png(huge), /PNG that is cut short/);
        const empty = Buffer.from(plainPng);
        empty.writeUInt32BE(0, 16);
        refused(png(empty), /PNG of no size/);
        const wide = Buffer.from(plainPng);
        wide.writeUInt32BE(0x80000000, 16);
        refused(png(wide), /texture of 2147483648 by 8 pixels/);

        refused(png(plainJpeg.subarray(0, plainJpeg.length - 2)), /JPEG that does not end/);
        refused(png(plainJpeg.subarray(0, 30)), /JPEG that is damaged or cut short/);
        refused(png(plainJpeg.subarray(0, 2)), /JPEG that is damaged or cut short/);
        refused(png(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /JPEG without a picture/);
        refused(png(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9])), /JPEG that is damaged/);
        const frame = plainJpeg.indexOf(Buffer.from([0xff, 0xc0]));
        const twice = Buffer.concat([
            plainJpeg.subarray(0, frame),
            plainJpeg.subarray(frame, frame + 19),
            plainJpeg.subarray(frame),
        ]);
        refused(png(twice), /more than one picture/);
    });

    it('refuses a picture that shares its bytes with anything else', () => {
        const glb = buildGlb(fullModel());
        //  a second view over the picture's bytes, used by nothing
        refused(
            edited(json => json.bufferViews.push({ ...json.bufferViews[json.images[0].bufferView] }), glb),
            /shares its bytes with something else/
        );
        //  another picture over part of them
        refused(
            edited(json => {
                const view = json.bufferViews[json.images[0].bufferView];
                json.bufferViews.push({
                    buffer: 0,
                    byteOffset: view.byteOffset,
                    byteLength: view.byteLength,
                });
                json.images.push({ bufferView: json.bufferViews.length - 1, mimeType: 'image/png' });
            }, glb),
            /shares its bytes with something else/
        );
        //  an accessor's view reaching into them from before
        refused(
            edited(
                json => {
                    const view = json.bufferViews[json.images[0].bufferView];
                    json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: view.byteOffset + 4 });
                },
                withTextures(plainPng, loadedPng)
            ),
            /shares its bytes with something else/
        );
        //  two images of the one view are one picture, counted once
        const twice = edited(json => json.images.push({ ...json.images[0] }), glb);
        assert.equal(checkGlb(twice).measured.textureBytes, checkGlb(glb).measured.textureBytes);
    });
});

describe('the model checker: what the viewer would do with it', () => {
    it('takes out every extension the hub does not take, wherever it is', () => {
        const glb = edited(json => {
            json.extensionsUsed = [
                'EXT_mesh_gpu_instancing',
                'KHR_materials_unlit',
                'KHR_draco_mesh_compression',
                'KHR_lights_punctual',
            ];
            json.extensions = { KHR_lights_punctual: { lights: [{ type: 'point' }, { type: 'spot' }] } };
            //  a thousand copies of the tube, by an accessor that is not there
            json.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 999 } } };
            json.nodes[4].extensions = { KHR_lights_punctual: { light: 77 } };
            json.materials[0].extensions = {
                KHR_materials_unlit: {},
                KHR_materials_anisotropy: { anisotropyStrength: 1, anisotropyTexture: { index: 999 } },
            };
            json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions = {
                KHR_texture_transform: { scale: [2, 2] },
                VENDOR_thing: { index: 999 },
            };
            json.textures[0].extensions = { EXT_texture_webp: { source: 999 } };
            json.meshes[0].primitives[0].extensions = {
                KHR_draco_mesh_compression: { bufferView: 999, attributes: { POSITION: 0 } },
            };
            json.extras = { extensions: { VENDOR_thing: 'free data is left alone' } };
        });
        const { cleaned, measured } = checkGlb(glb);
        const now = readGlb(cleaned).json;
        const text = JSON.stringify({ ...now, extras: undefined });
        for (const gone of ['EXT_', 'KHR_draco', 'KHR_lights', 'anisotropy', 'VENDOR', '999']) {
            assert.ok(!text.includes(gone), gone);
        }
        assert.deepEqual(now.extensionsUsed, ['KHR_materials_unlit']);
        assert.equal(now.extensions, undefined);
        assert.equal(now.nodes[0].extensions, undefined);
        assert.equal(now.textures[0].extensions, undefined);
        assert.deepEqual(now.materials[0].extensions, { KHR_materials_unlit: {} });
        assert.deepEqual(now.materials[0].pbrMetallicRoughness.baseColorTexture.extensions, {
            KHR_texture_transform: { scale: [2, 2] },
        });
        assert.deepEqual(now.extras, { extensions: { VENDOR_thing: 'free data is left alone' } });
        //  so the figures are of what the viewer will draw
        assert.equal(measured.triangles, 152);
        assert.equal(measured.drawCalls, 2);
        //  and a caller that takes more keeps more
        const more = checkGlb(glb, { ...LightBudget, extensions: ['KHR_lights_punctual'] });
        assert.deepEqual(readGlb(more.cleaned).json.extensionsUsed, ['KHR_lights_punctual']);
        assert.deepEqual(readGlb(more.cleaned).json.nodes[4].extensions, {
            KHR_lights_punctual: { light: 77 },
        });
    });

    it('refuses extensions that are not an object, and a texture left with no image', () => {
        //  a list too long to be handed over in one call is only a list
        const long = packGlb(
            Buffer.from(
                `{"asset":{"version":"2.0"},"nodes":[${new Array<string>(300000).fill('{}').join(',')}]}`
            )
        );
        assert.equal(checkGlb(long, { ...LightBudget, nodes: 300000 }).measured.triangles, 0);
        refused(
            edited(json => (json.nodes[0].extensions = 5)),
            /extensions that is not an object/
        );
        refused(
            edited(json => (json.materials[0].extensions = ['KHR_materials_unlit'])),
            /extensions that is not an object/
        );
        refused(
            edited(json => {
                delete json.textures[0].source;
                json.textures[0].extensions = { EXT_texture_webp: { source: 0 } };
            }),
            /texture with no image/
        );
    });

    it('holds points and lines to the triangle budget', () => {
        const drawn = (mode: number, indices: number, nodes = 1): Buffer =>
            editGlb(budgetModel('triangles', indices / 3), json => {
                json.meshes[0].primitives[0].mode = mode;
                for (let more = 1; more < nodes; more++) {
                    json.nodes.push({ mesh: 0 });
                    json.scenes[0].nodes.push(json.nodes.length - 1);
                }
            });
        assert.equal(checkGlb(drawn(0, 30000)).measured.triangles, 30000);
        refused(drawn(0, 30003), /30003 triangles, over the limit of 30000/);
        assert.equal(checkGlb(drawn(1, 60000)).measured.triangles, 30000);
        refused(drawn(1, 60003), /30001 triangles, over the limit/);
        refused(drawn(2, 30003), /30003 triangles, over the limit/);
        refused(drawn(3, 30003), /30002 triangles, over the limit/);
        //  and once for each node that shows them
        assert.equal(checkGlb(drawn(0, 900, 32)).measured.triangles, 28800);
        refused(drawn(0, 939, 32), /30048 triangles, over the limit/);
        refused(drawn(1, 1890, 32), /30240 triangles, over the limit/);
    });

    it('counts a picture’s pixels once for each image and each texture that shows it', () => {
        const glb = buildGlb(fullModel());
        assert.equal(checkGlb(glb).measured.texturePixels, 64);
        const thrice = edited(json => json.textures.push({ source: 0 }, { source: 0 }), glb);
        assert.equal(checkGlb(thrice).measured.texturePixels, 192);
        //  a second image of the same bytes is unpacked again
        const again = edited(json => json.images.push({ ...json.images[0] }), glb);
        assert.equal(checkGlb(again).measured.texturePixels, 128);
        assert.equal(checkGlb(again).measured.textureBytes, checkGlb(glb).measured.textureBytes);
        refused(glb, /textures of 64 pixels together, over the limit of 63/, {
            ...LightBudget,
            texturePixels: 63,
        });
        checkGlb(glb, { ...LightBudget, texturePixels: 64 });
        refused(thrice, /textures of 192 pixels together, over the limit of 191/, {
            ...LightBudget,
            texturePixels: 191,
        });
    });

    it('refuses a small file that names one large picture many times', () => {
        //  a few kilobytes of file, and four megabytes to unpack each time
        const flat = makePng({ width: 1024, height: 1024 });
        assert.ok(flat.length < 20000);
        const many = (images: number, textures: number): Buffer =>
            packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: flat.length }],
                    bufferViews: [{ buffer: 0, byteLength: flat.length }],
                    images: Array.from({ length: images }, () => ({ bufferView: 0 })),
                    textures: Array.from({ length: textures }, () => ({ source: 0 })),
                },
                flat
            );
        assert.equal(checkGlb(many(8, 0)).measured.texturePixels, 8 * 1024 * 1024);
        assert.equal(checkGlb(many(1, 8)).measured.texturePixels, 8 * 1024 * 1024);
        refused(many(9, 0), /textures of 9437184 pixels together, over the limit of 8388608/);
        refused(many(1, 9), /textures of 9437184 pixels together/);
        refused(many(20000, 0), /pixels together, over the limit/);
        //  and as many pictures of their own
        const each = Array.from({ length: 9 }, (_, at) =>
            makePng({ width: 1024, height: 1024, colour: [at, 0, 0] })
        );
        const offsets = each.map((_, at) => each.slice(0, at).reduce((sum, png) => sum + png.length, 0));
        const bin = Buffer.concat(each);
        refused(
            packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: bin.length }],
                    bufferViews: each.map((png, at) => ({
                        buffer: 0,
                        byteOffset: offsets[at],
                        byteLength: png.length,
                    })),
                    images: each.map((_, at) => ({ bufferView: at })),
                },
                bin
            ),
            /textures of 9437184 pixels together, over the limit of 8388608/
        );
    });

    it('refuses many buffer views over one picture before it reads any of them', () => {
        //  three megabytes of picture, which no view may share
        const big = makePng({ width: 1024, height: 1000, noise: 5 });
        assert.ok(big.length > 3000000);
        const glb = packGlb(
            {
                asset: { version: '2.0' },
                buffers: [{ byteLength: big.length }],
                bufferViews: Array.from({ length: 300 }, () => ({ buffer: 0, byteLength: big.length })),
                images: Array.from({ length: 300 }, (_, at) => ({ bufferView: at })),
            },
            big
        );
        const held = (): number => process.memoryUsage().arrayBuffers + process.memoryUsage().external;
        const before = held();
        const started = performance.now();
        refused(glb, /shares its bytes with something else/);
        //  it was near a gigabyte, and seconds, when each was read first
        assert.ok(held() - before < 64 * 1024 * 1024, `${held() - before} bytes held`);
        assert.ok(performance.now() - started < 1000);
    });

    it('refuses a picture that starts inside a buffer view before it', () => {
        const png = makePng({ width: 4, height: 4 });
        const positions = Buffer.alloc(36);
        triangle().forEach((value, at) => positions.writeFloatLE(value, at * 4));
        const model = (reach: number): Buffer =>
            packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: 36 + png.length }],
                    bufferViews: [
                        { buffer: 0, byteLength: 36 + reach },
                        { buffer: 0, byteOffset: 36, byteLength: png.length },
                    ],
                    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
                    images: [{ bufferView: 1 }],
                    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
                    nodes: [{ mesh: 0 }],
                },
                Buffer.concat([positions, png])
            );
        checkGlb(model(0));
        refused(model(1), /shares its bytes with something else/);
        refused(model(png.length), /shares its bytes with something else/);
    });

    it('leaves out what lies in the binary chunk past the buffer’s end', () => {
        const { json, bin } = buildGltf(fullModel());
        const glb = packGlb(json, Buffer.concat([bin, Buffer.from('hidden past the end of it')]));
        assert.ok(glb.includes('hidden past'));
        const { cleaned } = checkGlb(glb);
        assert.ok(!cleaned.includes('hidden past'));
        assert.ok(cleaned.equals(buildGlb(fullModel())));
    });

    it('refuses an index that names no vertex, in a mesh that is shown', () => {
        const model = (index: number, shown = true): Buffer => {
            const { json, bin } = buildGltf(fullModel());
            const view = json.bufferViews[json.accessors[json.meshes[1].primitives[0].indices].bufferView];
            bin.writeUInt16LE(index, view.byteOffset + 2 * 35);
            if (!shown) {
                delete json.nodes[4].mesh;
            }
            return packGlb(json, bin);
        };
        checkGlb(model(23));
        refused(model(24), /index that names a vertex there is not \(24\)/);
        refused(model(65535), /index that names a vertex there is not \(65535\)/);
        //  the viewer never reads one that no node shows
        checkGlb(model(24, false));
        //  indices one byte and four bytes wide
        const wide = (component: number, width: number, index: number): Buffer => {
            const bin = Buffer.alloc(48);
            triangle().forEach((value, at) => bin.writeFloatLE(value, at * 4));
            bin.writeUIntLE(index, 36 + 2 * width, width);
            return packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: 48 }],
                    bufferViews: [
                        { buffer: 0, byteLength: 36 },
                        { buffer: 0, byteOffset: 36, byteLength: 12 },
                    ],
                    accessors: [
                        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
                        { bufferView: 1, componentType: component, count: 3, type: 'SCALAR' },
                    ],
                    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
                    nodes: [{ mesh: 0 }],
                },
                bin
            );
        };
        checkGlb(wide(5121, 1, 2));
        refused(wide(5121, 1, 3), /names a vertex there is not \(3\)/);
        checkGlb(wide(5125, 4, 2));
        refused(wide(5125, 4, 0x80000000), /names a vertex there is not \(2147483648\)/);
        //  and indices may not be spread out by a stride
        refused(
            editGlb(wide(5125, 4, 2), json => (json.bufferViews[1].byteStride = 4)),
            /indices in a buffer view with a stride/
        );
    });

    it('refuses meshes and animations the viewer could not load', () => {
        const wrongs: [(json: Json) => void, RegExp][] = [
            [json => (json.meshes[0].primitives = []), /mesh with nothing to draw/],
            [json => delete json.meshes[1].primitives, /mesh with nothing to draw/],
            [json => (json.animations[0] = {}), /animation that moves nothing/],
            [json => (json.animations[0].channels = []), /animation that moves nothing/],
            [json => delete json.animations[0].samplers, /animation that moves nothing/],
            [
                json => (json.animations[0].channels[0].target.path = 42),
                /moves something the hub does not know/,
            ],
            [
                json => delete json.animations[0].channels[0].target.path,
                /moves something the hub does not know/,
            ],
            [
                json => (json.animations[0].channels[0].target.path = 'colour'),
                /moves something the hub does not know/,
            ],
            //  a turn given the values of a place, and the other way
            [
                json => (json.animations[0].channels[0].target.path = 'scale'),
                /values do not fit what it moves/,
            ],
            [
                json => (json.animations[0].channels[1].target.path = 'rotation'),
                /values do not fit what it moves/,
            ],
            //  three times, and the 88 normals of the tube for values
            [
                json => (json.animations[0].samplers[1].output = 1),
                /different number of values from its times/,
            ],
            [
                json => (json.animations[0].samplers[0].interpolation = 'CUBICSPLINE'),
                /different number of values from its times/,
            ],
            [
                json => (json.animations[0].samplers[0].interpolation = 'BOUNCE'),
                /moves in a way the hub does not know/,
            ],
            [
                json => (json.animations[0].samplers[0].interpolation = 3),
                /moves in a way the hub does not know/,
            ],
            //  morph targets: as long as the positions, and the same number
            //  in each primitive of a mesh
            [
                json => (json.meshes[0].primitives[0].targets = [{ POSITION: 6 }]),
                /morph target that does not fit/,
            ],
            [
                json => (json.meshes[0].primitives[0].targets = [{ POSITION: 2 }]),
                /morph target that does not fit/,
            ],
            [
                json => {
                    json.meshes[1].primitives.push({ ...json.meshes[1].primitives[0] });
                    json.meshes[1].primitives[0].targets = [{ POSITION: 7 }];
                },
                /primitives differ in their morph targets/,
            ],
            //  weights for a node whose mesh has no morph targets
            [
                json => {
                    json.animations[0].channels[0].target = { node: 4, path: 'weights' };
                    json.animations[0].samplers[0].output = 12;
                },
                /values do not fit what it moves/,
            ],
            [json => (json.buffers[0].type = 'text'), /buffer of an unknown type/],
        ];
        for (const [edit, reason] of wrongs) {
            refused(edited(edit), reason);
        }
        //  and takes what is right: morph targets with weights to move
        //  them, a channel that moves nothing, a buffer of the one type
        const { json, bin } = buildGltf(fullModel());
        json.meshes[1].primitives[0].targets = [{ POSITION: 7 }, { POSITION: 7, NORMAL: 7 }];
        //  three times, and two weights for each: six numbers, in bytes of
        //  their own at the end of the buffer
        json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: 24 });
        json.accessors.push({ ...json.accessors[12], count: 6, max: undefined });
        json.accessors[json.accessors.length - 1].bufferView = json.bufferViews.length - 1;
        json.animations[0].samplers.push({ input: 12, output: json.accessors.length - 1 });
        json.animations[0].channels.push({ sampler: 2, target: { node: 4, path: 'weights' } });
        json.animations[0].channels.push({ sampler: 1, target: { path: 'translation' } });
        json.buffers[0] = { byteLength: bin.length + 24, type: 'arraybuffer' };
        checkGlb(packGlb(json, Buffer.concat([bin, Buffer.alloc(24)])));
    });

    it('holds an animation’s name to something a page can show', () => {
        const named = (name: string): Buffer => edited(json => (json.animations[0].name = name));
        for (const good of ['x'.repeat(64), 'Armature|mixamo.com|Layer0', 'héllo wörld 走', '<b>&amp;"\'']) {
            assert.equal(checkGlb(named(good)).measured.animations[0]!.name, good);
        }
        refused(named('x'.repeat(65)), /name is over 64 characters/);
        refused(named('x'.repeat(900000)), /name is over 64 characters/);
        const hidden = ['\u0000', '\u001b[2J', 'two\nlines', '\u0085', '‮evil', '⁦', '‏', ' ', '﻿'];
        for (const bad of hidden) {
            refused(named(`idle${bad}`), /name has characters that cannot be shown/);
        }
        //  half a character, which JSON may carry as an escape
        const { json, bin } = buildGltf(fullModel());
        const half = JSON.stringify(json).replace('"idle"', '"idle\\ud800"');
        assert.ok(half.includes('\\ud800'));
        refused(packGlb(Buffer.from(half), bin), /name has characters that cannot be shown/);
    });

    it('turns a fault of its own, or bytes that are not bytes, into a refusal', () => {
        for (const wrong of [null, undefined, 7, {}, { length: -1 }]) {
            refused(wrong as never, /could not read|too short/);
        }
        //  and takes bytes that are not a Buffer
        const glb = buildGlb(fullModel());
        assert.ok(checkGlb(new Uint8Array(glb) as never).cleaned.equals(glb));
    });
});

describe('the model checker: what a cleaned picture may hold', () => {
    const plainPng = makePng({ width: 16, height: 8, colour: [10, 200, 90] });
    const head = plainPng.subarray(0, 33); //  the signature and IHDR
    const rest = plainPng.subarray(33); //  IDAT and IEND
    const pixels = plainPng.subarray(33, plainPng.length - 12);
    const end = plainPng.subarray(plainPng.length - 12);
    const plainJpeg = makeJpeg({ width: 24, height: 16, colour: [200, 30, 30] });
    const start = plainJpeg.subarray(0, 20); //  the start marker and JFIF
    const after = plainJpeg.subarray(20);
    const Payload = 'where it was taken, and by whom';
    const cleanedOf = (bytes: Buffer): Buffer => imageBytes(checkGlb(pictureModel(bytes)).cleaned)[0]!;

    //  a PNG of any kind: its header's five last bytes, its other parts,
    //  and its pixels as they are before packing
    const png = (width: number, height: number, kind: number[], parts: Buffer[], raw: Buffer): Buffer => {
        const header = Buffer.alloc(13);
        header.writeUInt32BE(width, 0);
        header.writeUInt32BE(height, 4);
        header.set(kind, 8);
        return Buffer.concat([
            plainPng.subarray(0, 8),
            pngChunk('IHDR', header),
            ...parts,
            pngChunk('IDAT', deflateSync(raw)),
            pngChunk('IEND', Buffer.alloc(0)),
        ]);
    };

    it('keeps a PNG’s transparency and colour notes, each of the right shape, and drops the rest', () => {
        const kept = [
            pngChunk('gAMA', Buffer.alloc(4, 1)),
            pngChunk('cHRM', Buffer.alloc(32, 1)),
            pngChunk('sRGB', Buffer.from([0])),
            pngChunk('tRNS', Buffer.alloc(6)),
        ];
        const dropped = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'pHYs', 'bKGD', 'vpAg', 'acTL'].map(type =>
            pngChunk(type, Buffer.from(`<${type}> ${Payload}`))
        );
        const loaded = Buffer.concat([head, ...dropped.slice(0, 4), ...kept, ...dropped.slice(4), rest]);
        assert.ok(cleanedOf(loaded).equals(Buffer.concat([head, ...kept, rest])));
        assert.ok(cleanedOf(plainPng).equals(plainPng));

        //  the same kinds of part, carrying something else: left out
        const carrying: Buffer[] = [
            pngChunk('gAMA', Buffer.from(Payload.slice(0, 13))),
            pngChunk('cHRM', Buffer.from(Payload)),
            pngChunk('sRGB', Buffer.from(Payload)),
            pngChunk('sRGB', Buffer.from([9])),
            pngChunk('tRNS', Buffer.from(Payload)),
            pngChunk('iCCP', Buffer.from(`name\0\0${Payload}`)),
            pngChunk('iCCP', Buffer.concat([Buffer.from('name\0\0'), deflateSync(Buffer.from(Payload))])),
            //  a palette, in a picture not drawn from one
            pngChunk('PLTE', Buffer.from(Payload.slice(0, 30))),
            //  one whose check is wrong
            pngChunk('gAMA', Buffer.alloc(4, 1), 12345),
        ];
        for (const part of carrying) {
            assert.ok(
                cleanedOf(Buffer.concat([head, part, rest])).equals(plainPng),
                part.toString('latin1', 4, 8)
            );
        }
        //  a second of one kept, a colour note after the palette, and
        //  anything at all after the pixels
        assert.ok(
            cleanedOf(Buffer.concat([head, kept[0]!, kept[0]!, rest])).equals(
                Buffer.concat([head, kept[0]!, rest])
            )
        );
        assert.ok(
            cleanedOf(Buffer.concat([head, pngChunk('PLTE', Buffer.alloc(6)), kept[0]!, rest])).equals(
                plainPng
            )
        );
        for (const late of [kept[0]!, kept[3]!, dropped[0]!]) {
            assert.ok(cleanedOf(Buffer.concat([head, pixels, late, end])).equals(plainPng));
        }
        //  of a colour profile and the note that needs none, the first
        const profile = pngChunk(
            'iCCP',
            Buffer.concat([Buffer.from('a profile\0\0'), deflateSync(colourProfile())])
        );
        assert.ok(
            cleanedOf(Buffer.concat([head, profile, rest])).equals(Buffer.concat([head, profile, rest]))
        );
        assert.ok(
            cleanedOf(Buffer.concat([head, profile, kept[2]!, rest])).equals(
                Buffer.concat([head, profile, rest])
            )
        );
        //  a part no reader may skip, which the hub does not know
        refused(
            pictureModel(Buffer.concat([head, pngChunk('ABCD', Buffer.alloc(4)), rest])),
            /part the hub does not know \(ABCD\)/
        );
    });

    it('refuses a PNG a browser would not show, or with anything beyond its pixels', () => {
        const wrong = (edit: (bytes: Buffer) => void): Buffer => {
            const bytes = Buffer.from(plainPng);
            edit(bytes);
            return pictureModel(bytes);
        };
        //  a part whose check is wrong: the pixels, the header, the end
        refused(
            wrong(bytes => bytes.writeUInt32BE(1, bytes.length - 16)),
            /PNG with a damaged part/
        );
        refused(
            wrong(bytes => bytes.writeUInt32BE(1, 29)),
            /PNG whose header is damaged/
        );
        refused(
            wrong(bytes => bytes.writeUInt32BE(1, bytes.length - 4)),
            /PNG with a damaged part/
        );
        refused(
            wrong(bytes => (bytes[44] = bytes[44]! ^ 1)),
            /PNG with a damaged part/
        );
        const raw = (width: number, height: number, bytes: number): Buffer =>
            Buffer.alloc(height * (1 + width * bytes));
        //  a header of no kind there is, with its check right
        for (const kind of [
            [99, 77, 0, 0, 0],
            [8, 1, 0, 0, 0],
            [4, 2, 0, 0, 0],
            [16, 3, 0, 0, 0],
            [8, 2, 1, 0, 0],
            [8, 2, 0, 1, 0],
            [8, 2, 0, 0, 2],
        ]) {
            refused(pictureModel(png(4, 4, kind, [], raw(4, 4, 3))), /PNG whose header is damaged/);
        }
        //  a header that claims more picture than there is, or less
        refused(
            pictureModel(png(1024, 1024, [8, 2, 0, 0, 0], [], raw(4, 4, 3))),
            /pixels are not the picture/
        );
        refused(pictureModel(png(4, 4, [8, 2, 0, 0, 0], [], raw(4, 5, 3))), /pixels are not the picture/);
        refused(pictureModel(png(4, 4, [8, 6, 0, 0, 0], [], raw(4, 4, 3))), /pixels are not the picture/);
        checkGlb(pictureModel(png(4, 4, [8, 6, 0, 0, 0], [], raw(4, 4, 4))));
        checkGlb(pictureModel(png(4, 4, [16, 4, 0, 0, 0], [], raw(4, 4, 4))));
        checkGlb(pictureModel(png(5, 3, [1, 0, 0, 0, 0], [], raw(1, 3, 1))));
        //  a row filtered in a way there is not
        const filtered = raw(4, 4, 3);
        filtered[13] = 5;
        refused(pictureModel(png(4, 4, [8, 2, 0, 0, 0], [], filtered)), /pixels are not the picture/);
        filtered[13] = 4;
        checkGlb(pictureModel(png(4, 4, [8, 2, 0, 0, 0], [], filtered)));
        //  bytes after the pixels' end, inside their part or in a second
        const packed = deflateSync(raw(16, 8, 3));
        const hiding = [
            [pngChunk('IDAT', Buffer.concat([packed, Buffer.from(Payload)]))],
            [pngChunk('IDAT', packed), pngChunk('IDAT', Buffer.from(Payload))],
        ];
        for (const parts of hiding) {
            refused(pictureModel(Buffer.concat([head, ...parts, end])), /pixels are not the picture/);
        }
        //  but pixels split over several parts are one picture
        const split = Buffer.concat([
            head,
            pngChunk('IDAT', packed.subarray(0, 5)),
            pngChunk('tEXt', Buffer.from(Payload)),
            pngChunk('IDAT', Buffer.alloc(0)),
            pngChunk('IDAT', packed.subarray(5)),
            end,
        ]);
        assert.ok(!cleanedOf(split).includes(Payload));
        //  pixels cut short, and an end with something in it
        refused(
            pictureModel(Buffer.concat([head, pngChunk('IDAT', packed.subarray(0, packed.length - 4)), end])),
            /pixels are not the picture/
        );
        refused(
            pictureModel(Buffer.concat([head, pixels, pngChunk('IEND', Buffer.from(Payload))])),
            /PNG with a damaged part/
        );
    });

    it('takes a PNG drawn from a palette, and an interlaced one, to the byte', () => {
        const palette = pngChunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0]));
        const clear = pngChunk('tRNS', Buffer.from([0, 128]));
        const rows = Buffer.from([0, 0, 1, 0, 1, 0, 1, 0, 1, 0]); //  4 by 2
        const drawn = png(4, 2, [8, 3, 0, 0, 0], [palette, clear], rows);
        assert.ok(cleanedOf(drawn).equals(drawn));
        refused(pictureModel(png(4, 2, [8, 3, 0, 0, 0], [], rows)), /PNG without its palette/);
        //  transparency for more colours than the palette has, or before it
        const bare = png(4, 2, [8, 3, 0, 0, 0], [palette], rows);
        assert.ok(
            cleanedOf(png(4, 2, [8, 3, 0, 0, 0], [palette, pngChunk('tRNS', Buffer.alloc(3))], rows)).equals(
                bare
            )
        );
        assert.ok(cleanedOf(png(4, 2, [8, 3, 0, 0, 0], [clear, palette], rows)).equals(bare));
        //  a palette of the wrong length, a second one, one too long for
        //  the picture's depth, and one after the pixels
        for (const parts of [
            [pngChunk('PLTE', Buffer.alloc(7))],
            [pngChunk('PLTE', Buffer.alloc(0))],
            [pngChunk('PLTE', Buffer.alloc(771))],
            [palette, palette],
        ]) {
            refused(
                pictureModel(png(4, 2, [8, 3, 0, 0, 0], parts, rows)),
                /palette is damaged or out of place/
            );
        }
        refused(
            pictureModel(png(4, 2, [1, 3, 0, 0, 0], [pngChunk('PLTE', Buffer.alloc(9))], Buffer.alloc(4))),
            /palette is damaged or out of place/
        );
        refused(
            pictureModel(Buffer.concat([head, pixels, palette, end])),
            /palette is damaged or out of place/
        );

        //  Interlaced, 5 by 3 in three bytes a pixel: six of the seven
        //  passes have rows, of 4, 4, 4, 10, 14 and 16 bytes in all
        const woven = (bytes: number): Buffer => png(5, 3, [8, 2, 0, 0, 1], [], Buffer.alloc(bytes));
        assert.ok(cleanedOf(woven(52)).equals(woven(52)));
        refused(pictureModel(woven(51)), /pixels are not the picture/);
        refused(pictureModel(woven(53)), /pixels are not the picture/);
        refused(pictureModel(woven(3 * 16)), /pixels are not the picture/);
    });

    it('keeps a JPEG’s JFIF, colour profile and Adobe segments, and drops the other application ones', () => {
        const kept = [
            jpegSegment(
                0xe2,
                Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), colourProfile()])
            ),
            jpegSegment(0xee, 'Adobe\0d\0\0\0\0\x01'),
        ];
        const dropped = [
            jpegSegment(0xe1, 'Exif\0\0where it was taken'),
            jpegSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'),
            jpegSegment(0xed, 'Photoshop 3.0\0caption'),
            jpegSegment(0xe2, 'MPF\0another picture'),
            jpegSegment(0xe0, 'JFXX\0a thumbnail'),
            jpegSegment(0xec, 'Ducky'),
            jpegSegment(0xef, 'anything'),
            jpegSegment(0xfe, 'a comment'),
        ];
        const loaded = Buffer.concat([start, dropped[0]!, kept[0]!, ...dropped.slice(1), kept[1]!, after]);
        assert.ok(cleanedOf(loaded).equals(Buffer.concat([start, ...kept, after])));
        assert.ok(cleanedOf(plainJpeg).equals(plainJpeg));
        //  a restart interval, and bytes of filling before a marker
        const interval = jpegSegment(0xdd, Buffer.from([0, 0]));
        assert.ok(
            cleanedOf(Buffer.concat([start, Buffer.alloc(5, 0xff), interval, after])).equals(
                Buffer.concat([start, interval, after])
            )
        );
        //  a colour profile in two pieces
        const whole = colourProfile(200);
        const pieces = [
            jpegSegment(
                0xe2,
                Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x02', 'latin1'), whole.subarray(0, 90)])
            ),
            jpegSegment(
                0xe2,
                Buffer.concat([Buffer.from('ICC_PROFILE\0\x02\x02', 'latin1'), whole.subarray(90)])
            ),
        ];
        assert.ok(
            cleanedOf(Buffer.concat([start, ...pieces, after])).equals(
                Buffer.concat([start, ...pieces, after])
            )
        );
    });

    it('cuts a JPEG’s kept segments to their own shape, with no thumbnail and nothing after', () => {
        //  JFIF with a thumbnail of one pixel and more behind it
        const thumbed = Buffer.concat([
            Buffer.from([0xff, 0xd8]),
            jpegSegment(
                0xe0,
                Buffer.concat([
                    Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 9, 9, 9]),
                    Buffer.from(Payload),
                ])
            ),
            after,
        ]);
        assert.ok(thumbed.includes(Payload));
        assert.ok(cleanedOf(thumbed).equals(plainJpeg));
        //  a second JFIF, and one too short to be one
        assert.ok(cleanedOf(Buffer.concat([start, start.subarray(2), after])).equals(plainJpeg));
        assert.ok(
            cleanedOf(Buffer.concat([start, jpegSegment(0xe0, 'JFIF\0short'), after])).equals(plainJpeg)
        );
        //  Adobe's twelve bytes, and whatever follows them
        const adobe = 'Adobe\0d\0\0\0\0\x01';
        assert.ok(
            cleanedOf(Buffer.concat([start, jpegSegment(0xee, adobe + Payload), after])).equals(
                Buffer.concat([start, jpegSegment(0xee, adobe), after])
            )
        );
        assert.ok(cleanedOf(Buffer.concat([start, jpegSegment(0xee, 'Adobe'), after])).equals(plainJpeg));
        //  a colour profile that is not one, or whose pieces do not add up
        const icc = (piece: number, of: number, data: Buffer): Buffer =>
            jpegSegment(
                0xe2,
                Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([piece, of]), data])
            );
        for (const segments of [
            [icc(1, 1, Buffer.from(Payload))],
            [icc(1, 1, Buffer.concat([colourProfile(), Buffer.from(Payload)]))],
            [icc(2, 2, colourProfile())],
            [icc(1, 2, colourProfile())],
            [icc(1, 1, colourProfile()), icc(2, 1, colourProfile())],
            [icc(1, 2, colourProfile()), icc(2, 3, colourProfile())],
            [icc(1, 1, Buffer.alloc(0))],
        ]) {
            refused(pictureModel(Buffer.concat([start, ...segments, after])), /colour profile is damaged/);
        }
    });

    it('refuses a JPEG with a part it does not know, of a kind not shown, or with more in a part than belongs', () => {
        const exif = `Exif\0\0${Payload}`;
        //  metadata under a marker that is no application's
        for (const marker of [0x02, 0xbf, 0xdc, 0xde, 0xdf, 0xf0, 0xf7, 0xfd]) {
            refused(
                pictureModel(Buffer.concat([start, jpegSegment(marker, exif), after])),
                /JPEG with a part the hub does not know/
            );
        }
        for (const marker of [0xc3, 0xc5, 0xc8, 0xc9, 0xcc, 0xcf]) {
            refused(
                pictureModel(Buffer.concat([start, jpegSegment(marker, exif), after])),
                /JPEG of a kind browsers do not show/
            );
        }
        //  each part of the picture, with something added to its end
        const grown = (marker: number, more = Buffer.from(Payload)): Buffer => {
            const at = plainJpeg.indexOf(Buffer.from([0xff, marker]));
            const length = plainJpeg.readUInt16BE(at + 2);
            const body = Buffer.concat([plainJpeg.subarray(at + 4, at + 2 + length), more]);
            return pictureModel(
                Buffer.concat([
                    plainJpeg.subarray(0, at),
                    jpegSegment(marker, body),
                    plainJpeg.subarray(at + 2 + length),
                ])
            );
        };
        refused(grown(0xdb), /JPEG with a damaged table/);
        refused(grown(0xc4), /JPEG with a damaged table/);
        refused(grown(0xc0), /JPEG whose header is damaged/);
        refused(grown(0xda), /JPEG whose scan is damaged/);
        //  a second whole table in the one segment is still tables
        checkGlb(grown(0xdb, Buffer.from([1, ...new Array<number>(64).fill(8)])));
        refused(grown(0xdb, Buffer.from([4, ...new Array<number>(64).fill(8)])), /JPEG with a damaged table/);
        refused(
            pictureModel(Buffer.concat([start, jpegSegment(0xdd, Buffer.from([0, 0, 0])), after])),
            /JPEG that is damaged/
        );
        //  a frame and no scan, and a scan before its frame
        const frame = plainJpeg.indexOf(Buffer.from([0xff, 0xc0]));
        const scan = plainJpeg.indexOf(Buffer.from([0xff, 0xda]));
        refused(
            pictureModel(
                Buffer.concat([start, plainJpeg.subarray(frame, frame + 19), Buffer.from([0xff, 0xd9])])
            ),
            /JPEG without a picture in it/
        );
        refused(
            pictureModel(Buffer.concat([plainJpeg.subarray(0, frame), plainJpeg.subarray(scan)])),
            /scan is damaged or comes before its header/
        );
        //  a frame of twelve bits a sample
        const deep = Buffer.from(plainJpeg);
        deep[frame + 4] = 12;
        refused(pictureModel(deep), /JPEG whose header is damaged/);
    });
});

describe('the model checker: damaged at random', () => {
    //  numbers that look random and are the same every run
    function generator(seed: number): (below: number) => number {
        let state = seed >>> 0 || 1;
        return below => {
            state ^= state << 13;
            state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5;
            state >>>= 0;
            return state % below;
        };
    }

    //  a HubError or a model that holds, and nothing else, ever
    function survives(glb: Buffer, note: string): boolean {
        let result;
        try {
            result = checkGlb(glb);
        } catch (err) {
            if (err instanceof HubError && 'asset' === err.code && err.message.length > 0) {
                return false;
            }
            assert.fail(`${note}: threw ${err instanceof Error ? err.stack : String(err)}`);
        }
        assert.equal(result.cleaned.length % 4, 0, note);
        assert.equal(result.measured.bytes, result.cleaned.length, note);
        assert.ok(result.cleaned.length <= glb.length + 3, note);
        //  and whatever is still a picture in it carries nothing along
        for (const image of imageBytes(result.cleaned)) {
            for (const hidden of [HiddenText, 'Exif', 'tEXt', 'eXIf', 'a comment left in']) {
                assert.ok(!image.includes(hidden), `${note}: ${hidden}`);
            }
        }
        return true;
    }

    const good = buildGlb({
        ...fullModel(),
        materials: [
            { texture: makePng({ width: 8, height: 8, text: { Comment: 'a comment left in' }, exif: true }) },
            { texture: makeJpeg({ width: 8, height: 8, exif: true, comment: 'a comment left in' }) },
        ],
    });

    it('holds when bytes of a good model are flipped', () => {
        const next = generator(20261126);
        let passed = 0;
        for (let round = 0; round < 3000; round++) {
            const glb = Buffer.from(good);
            for (let flips = 1 + next(4); flips > 0; flips--) {
                //  half of them in the header and the JSON, where one byte matters most
                const at = 0 === next(2) ? next(20 + glb.readUInt32LE(12)) : next(glb.length);
                glb[at] = 0 === next(3) ? next(256) : glb[at]! ^ (1 << next(8));
            }
            passed += survives(glb, `flips, round ${round}`) ? 1 : 0;
        }
        //  some damage is harmless (a vertex moved) and some is not
        assert.ok(passed > 100 && passed < 2900, `${passed} of 3000 passed`);
    });

    it('holds when a good model is cut short, with or without its length put right', () => {
        const next = generator(7);
        assert.ok(survives(good, 'whole'));
        for (let round = 0; round < 1500; round++) {
            const length = next(good.length);
            const cut = Buffer.from(good.subarray(0, length));
            assert.ok(!survives(cut, `cut to ${length}`));
            if (length >= 12) {
                cut.writeUInt32LE(length, 8);
                assert.ok(!survives(cut, `cut to ${length}, length put right`));
            }
        }
        for (let length = 0; length < 64; length++) {
            assert.ok(!survives(Buffer.from(good.subarray(0, length)), `cut to ${length}`));
        }
    });

    it('holds when values in a good model’s JSON are changed for wrong ones', () => {
        const next = generator(99);
        const wrong: unknown[] = [
            -1,
            0,
            1,
            2,
            7,
            999,
            1.5,
            2 ** 31,
            2 ** 53,
            -(2 ** 40),
            1e300,
            '',
            '0',
            'x',
            null,
            true,
            [],
            [0],
            {},
            { index: 0 },
        ];
        const { json: source, bin } = readGlb(good);
        const text = JSON.stringify(source);
        let passed = 0;
        for (let round = 0; round < 3000; round++) {
            const json = JSON.parse(text) as Json;
            for (let changes = 1 + next(3); changes > 0; changes--) {
                //  down to a value somewhere, by a path chosen at random
                let holder: Record<string, unknown> | unknown[] = json;
                for (;;) {
                    const keys = Object.keys(holder);
                    if (0 === keys.length) {
                        break;
                    }
                    const key = keys[next(keys.length)]!;
                    const inner = (holder as Record<string, unknown>)[key];
                    if ('object' === typeof inner && null !== inner && 0 !== next(6)) {
                        holder = inner as Record<string, unknown>;
                        continue;
                    }
                    if (0 === next(8)) {
                        delete (holder as Record<string, unknown>)[key];
                    } else {
                        (holder as Record<string, unknown>)[key] = wrong[next(wrong.length)];
                    }
                    break;
                }
            }
            passed += survives(packGlb(json, bin), `values, round ${round}`) ? 1 : 0;
        }
        assert.ok(passed > 50 && passed < 2950, `${passed} of 3000 passed`);
    });

    it('holds when a picture inside a good model is damaged', () => {
        const next = generator(4242);
        const { json, bin } = readGlb(good);
        for (let round = 0; round < 2000; round++) {
            const damaged = Buffer.from(bin);
            const view = json.bufferViews[json.images[next(2)].bufferView];
            for (let flips = 1 + next(3); flips > 0; flips--) {
                damaged[view.byteOffset + next(view.byteLength)] = next(256);
            }
            survives(packGlb(json, damaged), `pictures, round ${round}`);
        }
    });
});

//  What a second review found: files small enough to pass that gave the
//  viewer many times their size to hold or to draw, or the checker seconds
//  of work, and a few smaller things beside.
describe('the model checker: more for the viewer than the file lets on', () => {
    //  done in well under the seconds it once took
    function quick<T>(run: () => T, within = 1500): T {
        const started = performance.now();
        const result = run();
        const took = performance.now() - started;
        assert.ok(took < within, `took ${took.toFixed(0)} ms`);
        return result;
    }

    it('takes one scene at most, of roots listed once each', () => {
        refused(hostile.sceneRepeats(), /scene that lists a node twice/);
        quick(() => refused(hostile.sceneRepeats(undefined, 50000), /scene that lists a node twice/));
        refused(hostile.sceneListsChild(), /scene that lists a node which is the child of another/);
        refused(hostile.scenes(), /model of 2 scenes, where the hub takes one at most in this slice/);
        quick(() =>
            refused(hostile.scenes(undefined, 20000), /model of 20000 scenes, where the hub takes one/)
        );
        //  a second scene is one too many even with nothing in it
        refused(
            edited(json => json.scenes.push({})),
            /model of 2 scenes/
        );
        //  the mesh of a root listed 20,000 times was drawn 20,000 times,
        //  and counted once
        const ribbon = buildGlb({ meshes: [{ primitives: [strip(9000)] }], nodes: [{ mesh: 0 }] });
        assert.equal(checkGlb(ribbon).measured.triangles, 9000);
        refused(hostile.sceneRepeats(ribbon, 19999), /scene that lists a node twice/);
        //  a scene of nothing, and a model with no scene, are still taken
        checkGlb(edited(json => (json.scenes = [{}])));
        checkGlb(
            edited(json => {
                delete json.scenes;
                delete json.scene;
            })
        );
    });

    it('nodes: 1,000 pass and one more is refused', () => {
        //  the model has five of its own
        const at = hostile.spareNodes(undefined, LightBudget.nodes - 5);
        assert.equal(readGlb(at).json.nodes.length, 1000);
        checkGlb(at);
        refused(hostile.spareNodes(undefined, 996), /model of 1001 nodes, over the limit of 1000/);
        refused(hostile.spareNodes(), /model of 1005 nodes, over the limit of 1000/);
        quick(() =>
            refused(hostile.spareNodes(undefined, 60000), /model of 60005 nodes, over the limit of 1000/)
        );
        //  whether or not a scene shows them
        refused(
            edited(json => {
                for (let n = 0; n < 996; n++) {
                    json.nodes.push({});
                }
            }),
            /model of 1001 nodes, over the limit of 1000/
        );
        refused(buildGlb(fullModel()), /model of 5 nodes, over the limit of 4/, {
            ...LightBudget,
            nodes: 4,
        });
    });

    it('morph targets: 8 to a primitive pass and one more is refused', () => {
        checkGlb(hostile.morphTargets(undefined, LightBudget.morphTargets));
        refused(hostile.morphTargets(), /primitive of 9 morph targets, over the limit of 8/);
        //  each of them the one accessor, so the file is small
        const many = hostile.morphTargets(undefined, 50000);
        assert.ok(many.length < 1024 * 1024);
        quick(() => refused(many, /primitive of 50000 morph targets, over the limit of 8/));
        refused(hostile.morphTargets(undefined, 2), /primitive of 2 morph targets, over the limit of 1/, {
            ...LightBudget,
            morphTargets: 1,
        });
        refused(
            edited(json => (json.meshes[1].primitives[0].targets = [{ SHAPE: 6 }])),
            /morph target's attribute of a name the hub does not know \(SHAPE\)/
        );
    });

    it('holds the vertices morph targets move to what the triangles could need', () => {
        //  one triangle drawn, of a great many vertices, each of which the
        //  viewer keeps once more for every target
        const sparse = (vertices: number, targets: number): Buffer =>
            hostile.morphTargets(
                buildGlb({
                    meshes: [
                        {
                            primitives: [
                                { positions: new Array<number>(vertices * 3).fill(0), indices: [0, 1, 2] },
                            ],
                        },
                    ],
                    nodes: [{ mesh: 0 }],
                }),
                targets
            );
        //  30,000 triangles could have 90,000 vertices, and 8 targets each
        checkGlb(sparse(90000, 8));
        refused(
            sparse(90001, 8),
            /morph targets that move 720008 vertices together, over the limit of 720000/
        );
        checkGlb(sparse(180000, 4));
        //  and without morph targets the vertices are not held to it
        checkGlb(sparse(200000, 0));
        //  once for each node that shows the mesh
        refused(
            editGlb(sparse(90000, 8), json => {
                json.nodes.push({ mesh: 0 });
                json.scenes[0].nodes.push(1);
            }),
            /morph targets that move 1440000 vertices together/
        );
    });

    it('refuses buffer views that share bytes, whatever they hold', () => {
        refused(hostile.sharedViews(), /buffer views that share bytes/);
        quick(() => refused(hostile.sharedViews(undefined, 8000), /buffer views that share bytes/));
        //  one inside another, and one that runs a byte into the next
        refused(
            edited(json => {
                const view = json.bufferViews[json.accessors[0].bufferView];
                json.bufferViews.push({ buffer: 0, byteOffset: view.byteOffset + 8, byteLength: 4 });
            }),
            /buffer views that share bytes/
        );
        refused(
            edited(json => (json.bufferViews[json.accessors[0].bufferView].byteLength += 1)),
            /buffer views that share bytes/
        );
        //  Morph targets, each in a view that is the whole of a buffer of
        //  megabytes: the viewer copied the buffer for each
        const { json, bin } = buildGltf({ meshes: [{ primitives: [strip(2)] }], nodes: [{ mesh: 0 }] });
        const large = Buffer.concat([bin, Buffer.alloc(2 * 1024 * 1024)]);
        json.buffers[0].byteLength = large.length;
        const primitive = json.meshes[0].primitives[0];
        primitive.targets = [];
        for (let n = 0; n < 8; n++) {
            json.bufferViews.push({ buffer: 0, byteLength: large.length });
            json.accessors.push({
                bufferView: json.bufferViews.length - 1,
                componentType: 5126,
                count: json.accessors[primitive.attributes.POSITION].count,
                type: 'VEC3',
            });
            primitive.targets.push({ POSITION: json.accessors.length - 1 });
        }
        refused(packGlb(json, large), /buffer views that share bytes/);
        //  so the views of a model that is taken are no longer than its buffer
        for (const glb of [buildGlb(fullModel()), budgetModel('bones', 9)]) {
            const taken = readGlb(checkGlb(glb).cleaned).json;
            const sum = (taken.bufferViews as Json[]).reduce((all, view) => all + view.byteLength, 0);
            assert.ok(sum <= taken.buffers[0].byteLength);
        }
    });

    it('animation channels: 64 to an animation pass and one more is refused, and samplers the same', () => {
        checkGlb(hostile.channels(undefined, LightBudget.animationChannels));
        refused(hostile.channels(), /animation of 65 channels, over the limit of 64/);
        quick(() =>
            refused(hostile.channels(undefined, 20000), /animation of 20000 channels, over the limit of 64/)
        );
        checkGlb(hostile.samplers(undefined, 64));
        refused(hostile.samplers(), /animation of 65 samplers, over the limit of 64/);
        refused(buildGlb(fullModel()), /animation of 2 samplers, over the limit of 1/, {
            ...LightBudget,
            animationChannels: 1,
        });
        refused(hostile.channels(undefined, 3), /animation of 3 channels, over the limit of 2/, {
            ...LightBudget,
            animationChannels: 2,
        });
    });

    it('refuses an animation whose values are not plain numbers', () => {
        //  the viewer writes these out again as plain ones, four times the
        //  bytes, for every channel that names them
        refused(hostile.normalizedValues(), /animation whose values are not plain numbers/);
        const output = (json: Json): Json => json.accessors[json.animations[0].samplers[0].output];
        //  whole numbers that stand for themselves, the same
        refused(
            editGlb(hostile.normalizedValues(), json => delete output(json).normalized),
            /animation whose values are not plain numbers/
        );
        //  and plain ones said to stand for fractions, which the viewer
        //  cannot load
        refused(
            edited(json => (output(json).normalized = true)),
            /animation whose values are not plain numbers/
        );
        refused(
            edited(json => (output(json).normalized = 1)),
            /animation whose values are not plain numbers/
        );
        checkGlb(edited(json => (output(json).normalized = false)));
    });

    it('refuses a stride on anything but the attributes of vertices', () => {
        //  Times of 0, 1 and 2 seconds with a day between each: the viewer
        //  ignores the stride and plays all six, where the last of three
        //  was two seconds
        refused(hostile.stridedTimes(), /animation's times in a buffer view with a stride/);
        //  a stride of the element's own width is still a stride
        const strided = (accessor: (json: Json) => number, stride: number): Buffer =>
            edited(json => (json.bufferViews[json.accessors[accessor(json)].bufferView].byteStride = stride));
        refused(
            strided(json => json.animations[0].samplers[0].input, 4),
            /animation's times in a buffer view with a stride/
        );
        refused(
            strided(json => json.animations[0].samplers[0].output, 16),
            /animation's values in a buffer view with a stride/
        );
        refused(
            strided(json => json.skins[0].inverseBindMatrices, 64),
            /skin's matrices in a buffer view with a stride/
        );
        refused(
            edited(json => (json.bufferViews[json.images[0].bufferView].byteStride = 4)),
            /image in a buffer view with a stride/
        );
        //  positions and normals may have one
        checkGlb(strided(json => json.meshes[0].primitives[0].attributes.POSITION, 12));
        checkGlb(strided(json => json.meshes[0].primitives[0].attributes.NORMAL, 12));
    });

    it('holds an accessor with a stride to the whole strides the viewer reads', () => {
        //  positions 16 bytes apart; the viewer reads count * 16 bytes
        //  from the start of the stride the accessor begins in
        const data = Buffer.alloc(80);
        const model = (offset: number, count: number, length: number): Buffer =>
            packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: 80 }],
                    bufferViews: [{ buffer: 0, byteLength: length, byteStride: 16 }],
                    accessors: [
                        { bufferView: 0, byteOffset: offset, componentType: 5126, count, type: 'VEC3' },
                    ],
                    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
                    nodes: [{ mesh: 0 }],
                },
                data
            );
        checkGlb(model(0, 3, 48));
        refused(model(0, 3, 47), /accessor that runs past the end of its buffer view/);
        //  begun four bytes into each stride, it still fits each
        checkGlb(model(4, 3, 48));
        //  begun in the second stride, three more are read from there
        checkGlb(model(16, 3, 64));
        checkGlb(model(20, 3, 64));
        refused(model(16, 3, 60), /accessor that runs past the end of its buffer view/);
        //  and an element may not run out of its stride into the next
        refused(model(8, 3, 80), /elements cross from one stride into the next/);
    });

    it('reads every time of an animation, and takes only times that rise from nought', () => {
        //  the model's first times are 0, 1 and 2
        refused(hostile.times(), /animation whose times do not rise/);
        refused(hostile.times(undefined, [[1, 2]]), /animation whose times do not rise/);
        //  the last is no longer the largest: the viewer would play five seconds
        refused(hostile.times(undefined, [[1, 5]]), /animation whose times do not rise/);
        refused(hostile.times(undefined, [[0, -1]]), /animation with a time before its start/);
        refused(hostile.times(undefined, [[1, NaN]]), /time that is not a number/);
        refused(hostile.times(undefined, [[0, -Infinity]]), /time that is not a number/);
        refused(hostile.times(undefined, [[1, 61]]), /animation whose times do not rise/);
        const moved = checkGlb(
            hostile.times(undefined, [
                [1, 1.5],
                [2, 7.25],
            ])
        );
        assert.deepEqual(moved.measured.animations, [{ name: 'idle', seconds: 7.25 }]);
        //  nought with a minus sign is nought all the same
        checkGlb(hostile.times(undefined, [[0, -0]]));
    });

    it('reads no more times than the model has bytes for, however they are named', () => {
        const glb = budgetModel('animationSeconds', 5);
        const room = readGlb(glb).json.buffers[0].byteLength / 4;
        //  accessors of their own over the same two times, for every sampler
        const copies = (animations: number): Buffer =>
            edited(json => {
                const [animation] = json.animations;
                const [sampler] = animation.samplers;
                json.animations = Array.from({ length: animations }, () => ({
                    channels: animation.channels,
                    samplers: Array.from({ length: 64 }, () => {
                        json.accessors.push({ ...json.accessors[sampler.input] });
                        return { ...sampler, input: json.accessors.length - 1 };
                    }),
                }));
            }, glb);
        assert.ok(64 * 2 <= room && 4 * 64 * 2 > room);
        checkGlb(copies(1));
        refused(copies(4), /animations with more times than the model has bytes to hold them/);
        //  the one accessor named by them all is read once
        const shared = edited(json => {
            const [animation] = json.animations;
            json.animations = Array.from({ length: 16 }, () => ({
                channels: animation.channels,
                samplers: new Array(64).fill(animation.samplers[0]),
            }));
        }, glb);
        assert.equal(checkGlb(shared).measured.animations.length, 16);
    });

    it('unpacks one colour profile of a PNG at most, and only so much in a model', () => {
        const plain = makePng({ width: 8, height: 8, colour: [1, 2, 3] });
        const head = plain.subarray(0, 33); //  the signature and IHDR
        const rest = plain.subarray(33);
        const iccp = (unpacked: Buffer): Buffer =>
            pngChunk('iCCP', Buffer.concat([Buffer.from('x\0\0'), deflateSync(unpacked, { level: 9 })]));
        //  a kilobyte that unpacks to more than a profile may be
        const bomb = iccp(Buffer.alloc(1024 * 1024 + 1));
        assert.ok(bomb.length < 1200);
        const good = iccp(colourProfile());
        const cleanedOf = (bytes: Buffer): Buffer => imageBytes(checkGlb(pictureModel(bytes)).cleaned)[0]!;

        //  seven megabytes of them in one picture: seconds, when each was
        //  unpacked in turn
        const bombs = Buffer.concat([head, ...new Array<Buffer>(6500).fill(bomb), rest]);
        assert.ok(bombs.length > 6.5 * 1024 * 1024);
        assert.ok(quick(() => cleanedOf(bombs)).equals(plain));
        //  the first is the one looked at, kept or not
        assert.ok(cleanedOf(Buffer.concat([head, bomb, good, rest])).equals(plain));
        assert.ok(
            cleanedOf(Buffer.concat([head, good, bomb, good, rest])).equals(Buffer.concat([head, good, rest]))
        );

        //  and across the pictures of a model, four megabytes are unpacked
        //  at most in looking: after that, a profile is left out unread
        const model = (pictures: Buffer[]): Buffer => {
            const views: Json[] = [];
            const parts: Buffer[] = [];
            let size = 0;
            for (const picture of pictures) {
                const padding = Buffer.alloc((4 - (picture.length % 4)) % 4);
                views.push({ buffer: 0, byteOffset: size, byteLength: picture.length });
                parts.push(picture, padding);
                size += picture.length + padding.length;
            }
            return packGlb(
                {
                    asset: { version: '2.0' },
                    buffers: [{ byteLength: size }],
                    bufferViews: views,
                    images: views.map((_, at) => ({ bufferView: at })),
                },
                Buffer.concat(parts)
            );
        };
        const bombed = Buffer.concat([head, bomb, rest]);
        const profiled = Buffer.concat([head, good, rest]);
        const last = (before: number): Buffer => {
            const taken = checkGlb(model([...new Array<Buffer>(before).fill(bombed), profiled]));
            return imageBytes(taken.cleaned)[before]!;
        };
        assert.ok(last(0).equals(profiled));
        assert.ok(last(3).equals(profiled));
        assert.ok(last(4).equals(plain));
        const thousands = model(new Array<Buffer>(3000).fill(bombed));
        const cleaned = quick(() => checkGlb(thousands)).cleaned;
        assert.ok(imageBytes(cleaned).every(image => image.equals(plain)));
    });

    it('refuses a key that every object answers to already, wherever it is', () => {
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            const reason = new RegExp(`name in the JSON that the hub does not take \\(${key}\\)`);
            refused(hostile.protoKey(undefined, key), reason);
            //  in free data too, which is served with the rest
            refused(
                packGlb(Buffer.from(`{"asset":{"version":"2.0"},"extras":{"a":[{"b":{"${key}":1}}]}}`)),
                reason
            );
            refused(packGlb(Buffer.from(`{"asset":{"version":"2.0"},"${key}":{}}`)), reason);
        }
        //  they are only words where they are not keys
        checkGlb(
            packGlb(
                Buffer.from(
                    '{"asset":{"version":"2.0","generator":"__proto__"},"extras":["constructor",{"proto":"prototype"}]}'
                )
            )
        );
    });

    it('takes the attribute names glTF has, and an application’s own, and no others', () => {
        for (const name of [
            'TANGENT',
            'TEXCOORD_1',
            'COLOR_0',
            'COLOR_1',
            'JOINTS_1',
            'WEIGHTS_12',
            '_TEMPERATURE',
            '_my own',
        ]) {
            const { cleaned } = checkGlb(hostile.attributeName(undefined, name));
            assert.ok(name in readGlb(cleaned).json.meshes[0].primitives[0].attributes, name);
        }
        for (const name of [
            'COLOUR_0',
            'TEXCOORD',
            'TEXCOORD_',
            'TEXCOORD_01',
            'TEXCOORD_x',
            'TEXCOORD_100',
            'POSITION_0',
            'position',
            'toString',
            'valueOf',
            'hasOwnProperty',
            '',
            '_',
            ' NORMAL',
            'TANGENT\n',
        ]) {
            refused(
                hostile.attributeName(undefined, name),
                /primitive's attribute of a name the hub does not know/
            );
        }
    });

    it('attributes: 16 to a primitive or a morph target pass and one more is refused', () => {
        const at = hostile.manyAttributes(undefined, LightBudget.attributes);
        assert.equal(Object.keys(readGlb(at).json.meshes[0].primitives[0].attributes).length, 16);
        checkGlb(at);
        refused(hostile.manyAttributes(), /primitive of 17 attributes, over the limit of 16/);
        quick(() =>
            refused(
                hostile.manyAttributes(undefined, 30000),
                /primitive of 30000 attributes, over the limit of 16/
            )
        );
        refused(buildGlb(fullModel()), /primitive of 5 attributes, over the limit of 4/, {
            ...LightBudget,
            attributes: 4,
        });
        //  each morph target has as many of its own
        const target = (count: number): Buffer =>
            edited(json => {
                const names = ['POSITION', ...Array.from({ length: count - 1 }, (_, n) => `_EXTRA_${n}`)];
                json.meshes[1].primitives[0].targets = [Object.fromEntries(names.map(name => [name, 6]))];
            });
        checkGlb(target(16));
        refused(target(17), /morph target of 17 attributes, over the limit of 16/);
    });

    it('holds the vertex data primitives draw from to twice what the model holds', () => {
        //  Eleven accessors over the bytes of the positions, each an
        //  attribute the viewer would hand the graphics card on its own:
        //  within the limit on attributes, and many times the file
        refused(hostile.sharedAccessors(), /vertex data of \d+ bytes, more than the model holds/);
        //  what the model holds is its buffer without its picture, and
        //  what is drawn from is each accessor once
        const glb = buildGlb(fullModel());
        const { json } = readGlb(glb);
        const holds = json.buffers[0].byteLength - imageBytes(glb)[0]!.length;
        const positions = 88 * 12;
        const drawn = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce((sum, at) => {
            const view = json.bufferViews[json.accessors[at].bufferView];
            return sum + view.byteLength;
        }, 0);
        const most = Math.floor((2 * holds - drawn) / positions);
        assert.ok(most >= 1 && most < 11);
        checkGlb(hostile.sharedAccessors(undefined, most));
        refused(
            hostile.sharedAccessors(undefined, most + 1),
            new RegExp(`vertex data of ${drawn + (most + 1) * positions} bytes, more than the model holds`)
        );
        //  the one accessor named many times is one, and a mesh no node
        //  shows is not drawn from
        checkGlb(hostile.manyAttributes(undefined, 16));
        checkGlb(
            editGlb(hostile.sharedAccessors(), json => {
                delete json.nodes[0].mesh;
                delete json.nodes[0].skin;
            })
        );
        //  spread over many primitives, and as morph targets, the same
        const spread = edited(json => {
            const [first] = json.meshes[1].primitives;
            json.meshes[1].primitives = Array.from({ length: 30 }, () => {
                json.accessors.push({ ...json.accessors[first.attributes.POSITION] });
                json.accessors.push({ ...json.accessors[first.attributes.POSITION] });
                return {
                    ...first,
                    attributes: { ...first.attributes, POSITION: json.accessors.length - 1 },
                    targets: [{ POSITION: json.accessors.length - 2 }],
                };
            });
        });
        refused(spread, /vertex data of \d+ bytes, more than the model holds/);
    });

    it('takes a model whose attributes are interleaved in one buffer view', () => {
        const glb = interleavedGlb();
        const { cleaned, measured } = checkGlb(glb);
        assert.ok(cleaned.equals(glb));
        assert.equal(measured.triangles, 12);
        assert.equal(measured.drawCalls, 1);
        assert.equal(readGlb(cleaned).json.bufferViews[0].byteStride, 32);
    });

    it('takes again whatever it has taken once, to the byte of its limits', () => {
        //  pictures that get smaller when cleaned, so everything after
        //  them moves and the JSON is written with other numbers in it
        const loaded = buildGlb({
            ...fullModel(),
            materials: [
                {
                    texture: makePng({
                        width: 8,
                        height: 8,
                        text: { Comment: 'x'.repeat(997) },
                        trailing: Buffer.alloc(301, 7),
                    }),
                },
                { texture: makeJpeg({ width: 8, height: 8, exif: true, trailing: Buffer.alloc(77, 9) }) },
            ],
        });
        //  the same with its JSON made up to a length, to the byte
        const withJson = (bytes: number, grows = false): Buffer => {
            const { json, bin } = readGlb(loaded);
            json.extras = { pad: '', number: '@@' };
            const text = (): string => JSON.stringify(json).replace('"@@"', grows ? '1e20' : '1000');
            json.extras.pad = 'x'.repeat(bytes - text().length);
            assert.equal(text().length, bytes);
            return packGlb(Buffer.from(text()), bin);
        };
        const jsonBytes = (glb: Buffer): number => glb.readUInt32LE(12);

        const most = withJson(LightBudget.jsonBytes);
        assert.equal(jsonBytes(most), LightBudget.jsonBytes);
        const first = checkGlb(most);
        assert.ok(first.cleaned.length < most.length);
        assert.ok(jsonBytes(first.cleaned) <= LightBudget.jsonBytes);
        const again = checkGlb(first.cleaned);
        assert.ok(again.cleaned.equals(first.cleaned));
        assert.deepEqual(again.measured, first.measured);
        refused(withJson(LightBudget.jsonBytes + 4), /JSON of 1048580 bytes, over the limit of 1048576/);

        //  under limits that are the file's own sizes, and its cleaned sizes
        for (const glb of [loaded, first.cleaned]) {
            const own = { ...LightBudget, fileBytes: glb.length, jsonBytes: jsonBytes(glb) };
            const taken = checkGlb(glb, own);
            assert.ok(checkGlb(taken.cleaned, own).cleaned.equals(taken.cleaned));
            const tight = {
                ...LightBudget,
                fileBytes: taken.cleaned.length,
                jsonBytes: jsonBytes(taken.cleaned),
            };
            assert.ok(checkGlb(taken.cleaned, tight).cleaned.equals(taken.cleaned));
        }

        //  A file at the limit whose JSON would be longer written again (a
        //  number of four bytes that is written in twenty-one) is not
        //  taken at all, rather than taken and then served as a file the
        //  hub would refuse
        const growing = withJson(LightBudget.jsonBytes, true);
        assert.equal(jsonBytes(growing), LightBudget.jsonBytes);
        refused(growing, /does not hold once rewritten: JSON of \d+ bytes, over the limit of 1048576/);
        //  with room to spare it is taken, and taken again
        const roomy = checkGlb(withJson(LightBudget.jsonBytes - 64, true));
        assert.ok(checkGlb(roomy.cleaned).cleaned.equals(roomy.cleaned));
    });
});
