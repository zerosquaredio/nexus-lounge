//  Models for tests (build spec of the 3D slice, §4 and track C): binary
//  glTF (.glb) files made from code, good ones and damaged ones, and the
//  small PNG and JPEG pictures that go inside them. Nothing here reads a
//  model the way the hub does: it only writes them, so the checker is
//  tested against files it had no hand in.
//
//  What is here, in the order a test usually wants it:
//
//    buildGlb(model)          a Model (below) to the bytes of a valid .glb
//    buildGltf(model)         the same, as { json, bin } before packing
//    packGlb(json, bin?)      a JSON object (or its bytes) and a binary
//                             chunk to a .glb, padded as the format says
//    packChunks(chunks, h?)   any chunks under any header, with no padding
//                             and no checks: for files that are wrong
//    readGlb(glb)             a good .glb back to { version, json, bin }
//    editGlb(glb, edit)       a .glb with its JSON changed by edit(json)
//
//    box, sphere, tube, strip shapes, as a Primitive to put in a Mesh
//    turn(axis, degrees)      a rotation as a quaternion, for nodes and
//                             animations
//    interleavedGlb()         a box as exporters often write one: positions,
//                             normals and uvs side by side in one buffer
//                             view with a stride
//    fullModel()              one small Model with everything in it: two
//                             meshes, a texture, vertex colours, a skin of
//                             three bones and an animation named "idle"
//
//    makePng(options)         a PNG of a given size: plain, drawn or noise,
//    makeJpeg(options)        and a JPEG of one colour; each with optional
//                             metadata (PNG tEXt and eXIf chunks; a JPEG
//                             EXIF segment and comment) and bytes after
//                             the image's end
//    exifBlock(text?)         the EXIF data both put in, naming a camera
//    HiddenText               the camera's name, to look for afterwards
//
//    hostile.<name>(glb?)     a damaged copy of a .glb (of fullModel() if
//                             none is given); each is described where it
//                             is defined, at the end of this file
//    Light                    the budget of class "light" (decision 4)
//    budgetModel(kind, n)     a good model with n of one budget figure
//    overBudget(kind)         the same, just over the budget
//
//  A Model is plain data. Nodes, meshes, materials and skins are named by
//  their place in their array, as glTF does. Each accessor gets a buffer
//  view of its own, on a 4-byte boundary. Nodes that are no one's child
//  become the scene's roots. Everything the builder makes is meant to pass
//  Khronos's validator without errors.

import { crc32, deflateSync } from 'node:zlib';

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
//  parsed glTF JSON, loosely typed: tests and the hostile helpers poke at it
export type Json = Record<string, any>;

//  one draw call: triangles, by indices if given, else three positions each
export interface Primitive {
    positions: number[]; //  x, y, z for each vertex
    indices?: number[];
    normals?: number[]; //  x, y, z for each vertex, unit length
    colours?: number[]; //  r, g, b for each vertex, 0 to 1
    uvs?: number[]; //  u, v for each vertex
    joints?: number[]; //  four places in the skin's joints for each vertex
    weights?: number[]; //  four weights for each vertex, adding up to 1
    material?: number;
}

export interface Mesh {
    name?: string;
    primitives: Primitive[];
}

export interface Material {
    name?: string;
    colour?: Vec4; //  r, g, b, a
    texture?: Buffer; //  a PNG or JPEG, embedded; the primitive needs uvs
    doubleSided?: boolean;
}

export interface Node {
    name?: string;
    mesh?: number;
    skin?: number;
    children?: number[];
    translation?: Vec3;
    rotation?: Vec4; //  a quaternion: x, y, z, w
    scale?: Vec3;
}

export interface Skin {
    name?: string;
    joints: number[]; //  nodes
    //  16 numbers a joint; worked out from the joints' translations if left
    //  out, which needs the joints and their parents to have no rotation
    //  or scale at rest
    inverseBindMatrices?: number[];
}

export interface Channel {
    node: number;
    path: 'translation' | 'rotation' | 'scale';
    times: number[]; //  seconds, rising; the last is the channel's length
    values: number[]; //  three numbers a time, four for a rotation
}

export interface Animation {
    name?: string;
    channels: Channel[];
}

export interface Model {
    meshes?: Mesh[];
    materials?: Material[];
    nodes?: Node[];
    skins?: Skin[];
    animations?: Animation[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
    generator?: string;
    copyright?: string;
}

//  ---- the container ----

export const GlbMagic = 0x46546c67; //  "glTF"
export const ChunkJson = 0x4e4f534a; //  "JSON"
export const ChunkBin = 0x004e4942; //  "BIN\0"

export interface Chunk {
    type: number;
    data: Buffer;
    length?: number; //  the length to declare, if not the data's own
}

function pad4(data: Buffer, fill: number): Buffer {
    const over = data.length % 4;
    return 0 === over ? data : Buffer.concat([data, Buffer.alloc(4 - over, fill)]);
}

//  Chunks under a header, exactly as given: no padding, no checks. The
//  header's fields are right for the bytes unless told otherwise.
export function packChunks(
    chunks: Chunk[],
    header: { magic?: number; version?: number; length?: number } = {}
): Buffer {
    const parts: Buffer[] = [Buffer.alloc(12)];
    for (const chunk of chunks) {
        const head = Buffer.alloc(8);
        head.writeUInt32LE(chunk.length ?? chunk.data.length, 0);
        head.writeUInt32LE(chunk.type, 4);
        parts.push(head, chunk.data);
    }
    const glb = Buffer.concat(parts);
    glb.writeUInt32LE(header.magic ?? GlbMagic, 0);
    glb.writeUInt32LE(header.version ?? 2, 4);
    glb.writeUInt32LE(header.length ?? glb.length, 8);
    return glb;
}

//  A well-formed .glb: the JSON padded with spaces and the binary chunk
//  with zeros, each to four bytes. No binary chunk if bin is empty.
export function packGlb(json: Json | Buffer, bin?: Buffer): Buffer {
    const text = Buffer.isBuffer(json) ? json : Buffer.from(JSON.stringify(json), 'utf8');
    const chunks: Chunk[] = [{ type: ChunkJson, data: pad4(text, 0x20) }];
    if (bin && bin.length > 0) {
        chunks.push({ type: ChunkBin, data: pad4(bin, 0) });
    }
    return packChunks(chunks);
}

//  A good .glb taken apart again. It trusts the file: it is for changing
//  the builder's own output, not for reading anyone else's.
export function readGlb(glb: Buffer): { version: number; json: Json; bin: Buffer } {
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Json;
    const next = 20 + jsonLength;
    const bin =
        next + 8 <= glb.length
            ? Buffer.from(glb.subarray(next + 8, next + 8 + glb.readUInt32LE(next)))
            : Buffer.alloc(0);
    return { version: glb.readUInt32LE(4), json, bin };
}

//  A copy of a .glb with its JSON changed and its binary chunk kept.
export function editGlb(glb: Buffer, edit: (json: Json) => void): Buffer {
    const { json, bin } = readGlb(glb);
    edit(json);
    return packGlb(json, bin);
}

//  ---- the builder ----

const Float = 5126;
const UShort = 5123;
const UInt = 5125;
const ArrayBufferTarget = 34962;
const ElementBufferTarget = 34963;
const Widths: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function encode(values: number[], componentType: number): Buffer {
    if (Float === componentType) {
        const data = Buffer.alloc(values.length * 4);
        values.forEach((v, i) => data.writeFloatLE(v, i * 4));
        return data;
    }
    if (UInt === componentType) {
        const data = Buffer.alloc(values.length * 4);
        values.forEach((v, i) => data.writeUInt32LE(v, i * 4));
        return data;
    }
    const data = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => data.writeUInt16LE(v, i * 2));
    return data;
}

function isPng(image: Buffer): boolean {
    return image.length > 8 && 0x89504e47 === image.readUInt32BE(0);
}

function isJpeg(image: Buffer): boolean {
    return image.length > 2 && 0xffd8 === image.readUInt16BE(0);
}

export function buildGltf(model: Model): { json: Json; bin: Buffer } {
    const parts: Buffer[] = [];
    let size = 0;
    const bufferViews: Json[] = [];
    const accessors: Json[] = [];

    const view = (data: Buffer, target?: number): number => {
        bufferViews.push({
            buffer: 0,
            byteOffset: size,
            byteLength: data.length,
            ...(target ? { target } : {}),
        });
        const padded = pad4(data, 0);
        parts.push(padded);
        size += padded.length;
        return bufferViews.length - 1;
    };

    const accessor = (
        values: number[],
        componentType: number,
        type: string,
        options: { target?: number; bounds?: boolean } = {}
    ): number => {
        const width = Widths[type]!;
        if (0 === values.length || 0 !== values.length % width) {
            throw new Error(`${values.length} numbers do not make a whole number of ${type}`);
        }
        const made: Json = {
            bufferView: view(encode(values, componentType), options.target),
            componentType,
            count: values.length / width,
            type,
        };
        if (options.bounds) {
            const min = new Array<number>(width).fill(Infinity);
            const max = new Array<number>(width).fill(-Infinity);
            values.forEach((v, i) => {
                const stored = Float === componentType ? Math.fround(v) : v;
                min[i % width] = Math.min(min[i % width]!, stored);
                max[i % width] = Math.max(max[i % width]!, stored);
            });
            made.min = min;
            made.max = max;
        }
        accessors.push(made);
        return accessors.length - 1;
    };

    const images: Json[] = [];
    const textures: Json[] = [];
    const materials = (model.materials ?? []).map(material => {
        const pbr: Json = { metallicFactor: 0, roughnessFactor: 0.8 };
        if (material.colour) {
            pbr.baseColorFactor = material.colour;
        }
        if (material.texture) {
            const png = isPng(material.texture);
            if (!png && !isJpeg(material.texture)) {
                throw new Error('a texture must be a PNG or a JPEG');
            }
            images.push({ bufferView: view(material.texture), mimeType: png ? 'image/png' : 'image/jpeg' });
            textures.push({ source: images.length - 1 });
            pbr.baseColorTexture = { index: textures.length - 1 };
        }
        return {
            ...(material.name ? { name: material.name } : {}),
            pbrMetallicRoughness: pbr,
            ...(material.doubleSided ? { doubleSided: true } : {}),
        };
    });

    const meshes = (model.meshes ?? []).map(mesh => ({
        ...(mesh.name ? { name: mesh.name } : {}),
        primitives: mesh.primitives.map(primitive => {
            const vertices = primitive.positions.length / 3;
            const vertex = { target: ArrayBufferTarget };
            const attributes: Json = {
                POSITION: accessor(primitive.positions, Float, 'VEC3', { ...vertex, bounds: true }),
            };
            if (primitive.normals) {
                attributes.NORMAL = accessor(primitive.normals, Float, 'VEC3', vertex);
            }
            if (primitive.uvs) {
                attributes.TEXCOORD_0 = accessor(primitive.uvs, Float, 'VEC2', vertex);
            }
            if (primitive.colours) {
                attributes.COLOR_0 = accessor(primitive.colours, Float, 'VEC3', vertex);
            }
            if (primitive.joints && primitive.weights) {
                attributes.JOINTS_0 = accessor(primitive.joints, UShort, 'VEC4', vertex);
                attributes.WEIGHTS_0 = accessor(primitive.weights, Float, 'VEC4', vertex);
            }
            const made: Json = { attributes };
            if (primitive.indices) {
                made.indices = accessor(primitive.indices, vertices <= 65535 ? UShort : UInt, 'SCALAR', {
                    target: ElementBufferTarget,
                });
            }
            if (undefined !== primitive.material) {
                made.material = primitive.material;
            }
            return made;
        }),
    }));

    const nodes = model.nodes ?? [];
    const parent = new Map<number, number>();
    nodes.forEach((node, at) => (node.children ?? []).forEach(child => parent.set(child, at)));

    const skins = (model.skins ?? []).map(skin => {
        const matrices =
            skin.inverseBindMatrices ??
            skin.joints.flatMap(joint => {
                const place = [0, 0, 0];
                for (let at: number | undefined = joint; undefined !== at; at = parent.get(at)) {
                    const node = nodes[at]!;
                    if (node.rotation || node.scale) {
                        throw new Error(
                            'give inverseBindMatrices for joints that are turned or scaled at rest'
                        );
                    }
                    (node.translation ?? [0, 0, 0]).forEach((v, i) => (place[i]! += v));
                }
                return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -place[0]!, -place[1]!, -place[2]!, 1];
            });
        return {
            ...(skin.name ? { name: skin.name } : {}),
            joints: skin.joints,
            inverseBindMatrices: accessor(matrices, Float, 'MAT4'),
        };
    });

    const animations = (model.animations ?? []).map(animation => ({
        ...(animation.name ? { name: animation.name } : {}),
        samplers: animation.channels.map(channel => ({
            input: accessor(channel.times, Float, 'SCALAR', { bounds: true }),
            output: accessor(channel.values, Float, 'rotation' === channel.path ? 'VEC4' : 'VEC3'),
            interpolation: 'LINEAR',
        })),
        channels: animation.channels.map((channel, at) => ({
            sampler: at,
            target: { node: channel.node, path: channel.path },
        })),
    }));

    const json: Json = {
        asset: {
            version: '2.0',
            generator: model.generator ?? 'Nexus Lounge hub test models',
            ...(model.copyright ? { copyright: model.copyright } : {}),
        },
    };
    if (model.extensionsUsed?.length) {
        json.extensionsUsed = model.extensionsUsed;
    }
    if (model.extensionsRequired?.length) {
        json.extensionsRequired = model.extensionsRequired;
    }
    if (nodes.length > 0) {
        json.scene = 0;
        json.scenes = [{ nodes: nodes.map((_, at) => at).filter(at => !parent.has(at)) }];
        json.nodes = nodes.map(node => ({ ...node }));
    }
    //  glTF allows no empty arrays, so a kind with nothing in it is left out
    const lists: Json = { meshes, materials, textures, images, skins, animations, accessors, bufferViews };
    for (const [name, list] of Object.entries(lists)) {
        if (list.length > 0) {
            json[name] = list;
        }
    }
    if (size > 0) {
        json.buffers = [{ byteLength: size }];
    }
    return { json, bin: Buffer.concat(parts) };
}

export function buildGlb(model: Model): Buffer {
    const { json, bin } = buildGltf(model);
    return packGlb(json, bin);
}

//  ---- shapes ----

//  A box about the origin: 24 vertices and 12 triangles, with normals and
//  uvs (each face shows the whole texture).
export function box(width = 1, height = 1, depth = 1): Primitive {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    //  each face: its normal, and the two directions across it
    const faces: [Vec3, Vec3, Vec3][] = [
        [
            [1, 0, 0],
            [0, 0, -1],
            [0, 1, 0],
        ],
        [
            [-1, 0, 0],
            [0, 0, 1],
            [0, 1, 0],
        ],
        [
            [0, 1, 0],
            [1, 0, 0],
            [0, 0, -1],
        ],
        [
            [0, -1, 0],
            [1, 0, 0],
            [0, 0, 1],
        ],
        [
            [0, 0, 1],
            [1, 0, 0],
            [0, 1, 0],
        ],
        [
            [0, 0, -1],
            [-1, 0, 0],
            [0, 1, 0],
        ],
    ];
    const half = [width / 2, height / 2, depth / 2];
    for (const [normal, across, up] of faces) {
        const first = positions.length / 3;
        for (const [a, b] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
        ] as [number, number][]) {
            for (let i = 0; i < 3; i++) {
                positions.push((normal[i]! + a * across[i]! + b * up[i]!) * half[i]!);
            }
            normals.push(...normal);
            uvs.push((a + 1) / 2, (1 - b) / 2);
        }
        indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    return { positions, normals, uvs, indices };
}

//  A ball about the origin, with normals and uvs: segments around, rings
//  from pole to pole, 2 * segments * (rings - 1) triangles.
export function sphere(radius = 1, segments = 16, rings = 10): Primitive {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let ring = 0; ring <= rings; ring++) {
        const down = (Math.PI * ring) / rings;
        for (let segment = 0; segment <= segments; segment++) {
            const around = (2 * Math.PI * segment) / segments;
            const normal = [
                Math.sin(down) * Math.cos(around),
                Math.cos(down),
                Math.sin(down) * Math.sin(around),
            ];
            const length = Math.hypot(...normal.map(Math.fround));
            positions.push(...normal.map(v => v * radius));
            normals.push(...normal.map(v => v / length));
            uvs.push(segment / segments, ring / rings);
        }
    }
    for (let ring = 0; ring < rings; ring++) {
        for (let segment = 0; segment < segments; segment++) {
            const a = ring * (segments + 1) + segment;
            const b = a + segments + 1;
            if (ring > 0) {
                indices.push(a, a + 1, b);
            }
            if (ring < rings - 1) {
                indices.push(a + 1, b + 1, b);
            }
        }
    }
    return { positions, normals, uvs, indices };
}

//  An open tube standing on the origin, up the y axis, with normals and
//  uvs: 2 * sides * rings triangles. With bones, it is weighted to a chain
//  of that many joints set evenly up it (joint n at height n * height /
//  bones), each vertex shared between the two nearest.
export function tube(radius = 0.25, height = 2, sides = 8, rings = 8, bones = 0): Primitive {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const joints: number[] = [];
    const weights: number[] = [];
    for (let ring = 0; ring <= rings; ring++) {
        for (let side = 0; side <= sides; side++) {
            const around = (2 * Math.PI * side) / sides;
            const normal = [Math.cos(around), 0, Math.sin(around)];
            const length = Math.hypot(...normal.map(Math.fround));
            positions.push(normal[0]! * radius, (height * ring) / rings, normal[2]! * radius);
            normals.push(...normal.map(v => v / length));
            uvs.push(side / sides, 1 - ring / rings);
            if (bones > 0) {
                //  how far up the chain, measured from the middle of the first bone
                const along = Math.min(Math.max((bones * ring) / rings - 0.5, 0), bones - 1);
                const lower = Math.floor(along);
                const share = Math.fround(along - lower);
                joints.push(lower, share > 0 ? lower + 1 : 0, 0, 0);
                weights.push(1 - share, share, 0, 0);
            }
        }
    }
    for (let ring = 0; ring < rings; ring++) {
        for (let side = 0; side < sides; side++) {
            const a = ring * (sides + 1) + side;
            const b = a + sides + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return bones > 0
        ? { positions, normals, uvs, indices, joints, weights }
        : { positions, normals, uvs, indices };
}

//  A flat zigzag ribbon of exactly this many triangles, with indices: the
//  cheapest way to a triangle count.
export function strip(triangles: number): Primitive {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let at = 0; at < triangles + 2; at++) {
        positions.push(at * 0.01, at % 2, 0);
    }
    for (let at = 0; at < triangles; at++) {
        indices.push(at, at + 1, at + 2);
    }
    return { positions, indices };
}

//  A turn about an axis as a quaternion, for rotations and animations.
export function turn(axis: Vec3, degrees: number): Vec4 {
    const half = (degrees * Math.PI) / 360;
    const length = Math.hypot(...axis);
    const s = Math.sin(half) / length;
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

//  One small model with one of everything, for tests that need a whole
//  model and for the hostile helpers to damage. Nodes: 0 the tube (mesh 0,
//  skin 0), 1 to 3 its bones in a chain, 4 a box (mesh 1). Materials: 0
//  with a PNG texture, 1 a plain colour. One animation, "idle", of 2
//  seconds. 152 triangles, 2 primitives, 3 bones.
export function fullModel(): Model {
    const cube = box(0.5, 0.5, 0.5);
    return {
        materials: [
            {
                name: 'painted',
                texture: makePng({ width: 8, height: 8, colour: [200, 120, 40] }),
                doubleSided: true,
            },
            { name: 'plain', colour: [0.8, 0.8, 0.9, 1] },
        ],
        meshes: [
            { name: 'tube', primitives: [{ ...tube(0.2, 1.5, 10, 7, 3), material: 0 }] },
            {
                name: 'box',
                primitives: [{ ...cube, colours: cube.positions.map(v => v + 0.5), material: 1 }],
            },
        ],
        nodes: [
            { name: 'tube', mesh: 0, skin: 0 },
            { name: 'bone0', children: [2] },
            { name: 'bone1', translation: [0, 0.5, 0], children: [3] },
            { name: 'bone2', translation: [0, 0.5, 0] },
            { name: 'box', mesh: 1, translation: [1, 0.25, 0] },
        ],
        skins: [{ name: 'chain', joints: [1, 2, 3] }],
        animations: [
            {
                name: 'idle',
                channels: [
                    {
                        node: 2,
                        path: 'rotation',
                        times: [0, 1, 2],
                        values: [...turn([0, 0, 1], 0), ...turn([0, 0, 1], 30), ...turn([0, 0, 1], 0)],
                    },
                    {
                        node: 4,
                        path: 'translation',
                        times: [0, 1, 2],
                        values: [1, 0.25, 0, 1, 0.5, 0, 1, 0.25, 0],
                    },
                ],
            },
        ],
    };
}

//  A box whose positions, normals and uvs are interleaved: one buffer view
//  of 32 bytes a vertex, with three accessors that start 0, 12 and 24
//  bytes into each, and its indices in a view of their own. A good model.
export function interleavedGlb(): Buffer {
    const shape = box();
    const vertices = shape.positions.length / 3;
    const data = Buffer.alloc(vertices * 32);
    for (let at = 0; at < vertices; at++) {
        const values = [
            ...shape.positions.slice(at * 3, at * 3 + 3),
            ...shape.normals!.slice(at * 3, at * 3 + 3),
            ...shape.uvs!.slice(at * 2, at * 2 + 2),
        ];
        values.forEach((value, n) => data.writeFloatLE(value, at * 32 + n * 4));
    }
    const indices = encode(shape.indices!, UShort);
    const vertex = { bufferView: 0, componentType: Float, count: vertices };
    return packGlb(
        {
            asset: { version: '2.0' },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
            accessors: [
                { ...vertex, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
                { ...vertex, byteOffset: 12, type: 'VEC3' },
                { ...vertex, byteOffset: 24, type: 'VEC2' },
                { bufferView: 1, componentType: UShort, count: shape.indices!.length, type: 'SCALAR' },
            ],
            bufferViews: [
                { buffer: 0, byteLength: data.length, byteStride: 32, target: ArrayBufferTarget },
                { buffer: 0, byteOffset: data.length, byteLength: indices.length, target: ElementBufferTarget },
            ],
            buffers: [{ byteLength: data.length + indices.length }],
        },
        Buffer.concat([data, indices])
    );
}

//  ---- pictures ----

//  what the metadata says, so a test can look for it in what comes out
export const HiddenText = 'SecretCam 9000';

//  EXIF data (a little TIFF file) with one field, the camera's maker.
export function exifBlock(text: string = HiddenText): Buffer {
    const value = Buffer.from(`${text}\0`, 'latin1');
    const head = Buffer.alloc(26);
    head.write('II', 0, 'latin1');
    head.writeUInt16LE(42, 2);
    head.writeUInt32LE(8, 4); //  where the directory is
    head.writeUInt16LE(1, 8); //  one entry
    head.writeUInt16LE(0x010f, 10); //  Make
    head.writeUInt16LE(2, 12); //  text
    head.writeUInt32LE(value.length, 14);
    head.writeUInt32LE(26, 18); //  where the text is
    head.writeUInt32LE(0, 22); //  no further directory
    return Buffer.concat([head, value]);
}

//  numbers that look random and are the same every time
function noiseBytes(length: number, seed: number): Buffer {
    const data = Buffer.alloc(length);
    let state = (seed * 2654435761 + 1) >>> 0 || 1;
    for (let at = 0; at < length; at++) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        data[at] = state & 0xff;
    }
    return data;
}

export interface PngOptions {
    width: number;
    height: number;
    colour?: [number, number, number]; //  r, g, b, 0 to 255; grey if left out
    pixel?: (x: number, y: number) => [number, number, number]; //  or drawn
    noise?: number; //  or noise from this seed, which will not compress
    text?: Record<string, string>; //  tEXt chunks, by keyword
    exif?: Buffer | true; //  an eXIf chunk; true for exifBlock()
    trailing?: Buffer; //  bytes after the image's end
}

function pngChunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const made = Buffer.alloc(body.length + 8);
    made.writeUInt32BE(data.length, 0);
    body.copy(made, 4);
    made.writeUInt32BE(crc32(body), body.length + 4);
    return made;
}

//  A PNG: 8 bits a channel, red green blue, not interlaced. Metadata goes
//  before the pixels, where cameras and editors put it.
export function makePng(options: PngOptions): Buffer {
    const { width, height } = options;
    const row = 1 + width * 3;
    let raw: Buffer;
    if (undefined !== options.noise) {
        raw = noiseBytes(row * height, options.noise);
        for (let y = 0; y < height; y++) {
            raw[y * row] = 0;
        }
    } else {
        raw = Buffer.alloc(row * height);
        const colour = options.colour ?? [128, 128, 128];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const [r, g, b] = options.pixel ? options.pixel(x, y) : colour;
                raw[y * row + 1 + x * 3] = r;
                raw[y * row + 2 + x * 3] = g;
                raw[y * row + 3 + x * 3] = b;
            }
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header)];
    for (const [keyword, value] of Object.entries(options.text ?? {})) {
        parts.push(pngChunk('tEXt', Buffer.from(`${keyword}\0${value}`, 'latin1')));
    }
    if (options.exif) {
        parts.push(pngChunk('eXIf', true === options.exif ? exifBlock() : options.exif));
    }
    parts.push(pngChunk('IDAT', deflateSync(raw, { level: undefined !== options.noise ? 0 : 9 })));
    parts.push(pngChunk('IEND', Buffer.alloc(0)));
    if (options.trailing) {
        parts.push(options.trailing);
    }
    return Buffer.concat(parts);
}

export interface JpegOptions {
    width: number;
    height: number;
    colour?: [number, number, number]; //  r, g, b, 0 to 255; grey if left out
    exif?: Buffer | true; //  an EXIF APP1 segment; true for exifBlock()
    comment?: string; //  a COM segment
    trailing?: Buffer; //  bytes after the image's end
}

function jpegSegment(marker: number, data: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xff00 | marker, 0);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
}

//  A baseline JPEG of one flat colour, which needs no real encoder: every
//  block is its average and nothing else, so the picture is a handful of
//  bits a block. It decodes to within a shade or two of the colour asked.
export function makeJpeg(options: JpegOptions): Buffer {
    const { width, height } = options;
    const [r, g, b] = options.colour ?? [128, 128, 128];
    //  the three components, as differences from mid-grey
    const levels = [
        0.299 * r + 0.587 * g + 0.114 * b - 128,
        -0.168736 * r - 0.331264 * g + 0.5 * b,
        0.5 * r - 0.418688 * g - 0.081312 * b,
    ].map(v => Math.max(-128, Math.min(127, Math.round(v))));

    //  The codes for "how many bits follow" are the standard table's: 2
    //  bits for none, 3 bits for 1 to 5, then one more bit each
    const sizeCode = (bits: number): [number, number] =>
        0 === bits ? [0b00, 2] : bits <= 5 ? [0b010 + bits - 1, 3] : [(1 << (bits - 2)) - 2, bits - 2];

    const out: number[] = [];
    let held = 0;
    let count = 0;
    const put = (value: number, bits: number): void => {
        for (let bit = bits - 1; bit >= 0; bit--) {
            held = (held << 1) | ((value >> bit) & 1);
            if (8 === ++count) {
                out.push(held);
                if (0xff === held) {
                    out.push(0);
                }
                held = 0;
                count = 0;
            }
        }
    };
    const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
    for (let block = 0; block < blocks; block++) {
        for (const level of levels) {
            //  the first block says each level; the rest say "no change"
            const change = 0 === block ? level : 0;
            const bits = 0 === change ? 0 : 32 - Math.clz32(Math.abs(change));
            put(...sizeCode(bits));
            if (bits > 0) {
                put(change > 0 ? change : change + (1 << bits) - 1, bits);
            }
            put(0, 1); //  nothing more in this block
        }
    }
    while (0 !== count) {
        put(1, 1);
    }

    const frame = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
    frame.writeUInt16BE(height, 1);
    frame.writeUInt16BE(width, 3);
    const parts = [
        Buffer.from([0xff, 0xd8]),
        jpegSegment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    ];
    if (options.exif) {
        const exif = true === options.exif ? exifBlock() : options.exif;
        parts.push(jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif])));
    }
    if (undefined !== options.comment) {
        parts.push(jpegSegment(0xfe, Buffer.from(options.comment, 'latin1')));
    }
    parts.push(
        //  one table of steps, all 8: a level is then the colour itself
        jpegSegment(0xdb, Buffer.from([0, ...new Array<number>(64).fill(8)])),
        jpegSegment(0xc0, frame),
        //  the standard table for sizes, and a table of one code, "0", for
        //  "nothing more in this block"
        jpegSegment(
            0xc4,
            Buffer.from([
                0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
            ])
        ),
        jpegSegment(0xc4, Buffer.from([0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
        jpegSegment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0])),
        Buffer.from(out),
        Buffer.from([0xff, 0xd9])
    );
    if (options.trailing) {
        parts.push(options.trailing);
    }
    return Buffer.concat(parts);
}

//  ---- budgets ----

//  The budget of class "light" (build spec, decision 4). The two sizes in
//  megabytes are taken as 1024 * 1024 bytes each, the larger reading, so
//  that a model over them here is over them either way.
export const Light = {
    triangles: 30000,
    primitives: 32, //  draw calls
    bones: 64,
    textureSide: 1024, //  pixels
    textureBytes: 4 * 1024 * 1024, //  all textures together
    animations: 16,
    animationSeconds: 60,
    fileBytes: 8 * 1024 * 1024,
} as const;

export type BudgetKind = keyof typeof Light;

//  A good model with this much of one figure and little of the others:
//
//    triangles         one primitive of exactly that many, by indices
//    primitives        one mesh of that many, a triangle each, no indices
//    bones             a skin of that many joints in a chain
//    textureSide       one PNG texture that many pixels wide, 4 high
//    textureBytes      PNG textures of noise, none over 1024 a side, of AT
//                      LEAST that many bytes together (a few thousand
//                      over: a picture's size cannot be set to the byte)
//    animations        that many, of one second each
//    animationSeconds  one animation of exactly that length
//    fileBytes         fullModel() with unused bytes in its buffer, to
//                      exactly that length (a multiple of 4)
export function budgetModel(kind: BudgetKind, amount: number): Buffer {
    const wobble = (node: number, seconds: number): Channel => ({
        node,
        path: 'rotation',
        times: [0, seconds],
        values: [...turn([0, 1, 0], 0), ...turn([0, 1, 0], 45)],
    });
    switch (kind) {
        case 'triangles':
            return buildGlb({ meshes: [{ primitives: [strip(amount)] }], nodes: [{ mesh: 0 }] });
        case 'primitives': {
            const primitives = Array.from({ length: amount }, (_, at) => ({
                positions: [at, 0, 0, at + 0.5, 1, 0, at + 1, 0, 0],
            }));
            return buildGlb({ meshes: [{ primitives }], nodes: [{ mesh: 0 }] });
        }
        case 'bones': {
            const joints = Array.from({ length: amount }, (_, at) => at + 1);
            const bones: Node[] = joints.map(at => ({
                name: `bone${at - 1}`,
                translation: [0, 0.01, 0],
                ...(at < amount ? { children: [at + 1] } : {}),
            }));
            const triangle: Primitive = {
                positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
                joints: [0, 0, 0, 0, 0, 0, 0, 0, amount - 1, 0, 0, 0],
                weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            };
            return buildGlb({
                meshes: [{ primitives: [triangle] }],
                nodes: [{ mesh: 0, skin: 0 }, ...bones],
                skins: [{ joints }],
            });
        }
        case 'textureSide':
            return buildGlb({
                materials: [{ texture: makePng({ width: amount, height: 4 }) }],
                meshes: [{ primitives: [{ ...box(), material: 0 }] }],
                nodes: [{ mesh: 0 }],
            });
        case 'textureBytes': {
            const materials: Material[] = [];
            for (let left = amount; left > 0; ) {
                const height = Math.min(1024, Math.ceil(left / (3 * 1024 + 1)));
                const texture = makePng({ width: 1024, height, noise: materials.length + 1 });
                materials.push({ texture });
                left -= texture.length;
            }
            return buildGlb({
                materials,
                meshes: [{ primitives: materials.map((_, at) => ({ ...box(), material: at })) }],
                nodes: [{ mesh: 0 }],
            });
        }
        case 'animations':
            return buildGlb({
                meshes: [{ primitives: [box()] }],
                nodes: [{ mesh: 0 }],
                animations: Array.from({ length: amount }, (_, at) => ({
                    name: `move${at}`,
                    channels: [wobble(0, 1)],
                })),
            });
        case 'animationSeconds':
            return buildGlb({
                meshes: [{ primitives: [box()] }],
                nodes: [{ mesh: 0 }],
                animations: [{ name: 'long', channels: [wobble(0, amount)] }],
            });
        case 'fileBytes': {
            const { json, bin } = buildGltf(fullModel());
            if (amount < packGlb(json, bin).length || 0 !== amount % 4) {
                throw new Error(
                    `a file of ${amount} bytes cannot be made: too small, or not a multiple of 4`
                );
            }
            //  a longer buffer is a longer number in the JSON, so the
            //  padding is settled in a few rounds
            for (let extra = 0, round = 0; round < 8; round++) {
                json.buffers[0].byteLength = bin.length + extra;
                const made = packGlb(json, Buffer.concat([bin, Buffer.alloc(extra)]));
                if (made.length === amount) {
                    return made;
                }
                extra += amount - made.length;
            }
            throw new Error(`a file of ${amount} bytes cannot be made`);
        }
    }
}

//  The same, one over the budget (a second over for an animation's length,
//  four bytes over for the file).
export function overBudget(kind: BudgetKind): Buffer {
    return budgetModel(kind, Light[kind] + ('fileBytes' === kind ? 4 : 1));
}

//  ---- hostile models ----

let fullGlb: Buffer | undefined;
function full(): Buffer {
    fullGlb ??= buildGlb(fullModel());
    return fullGlb;
}

//  the chunks of a good .glb, to put back together wrongly
function chunksOf(glb: Buffer): Chunk[] {
    const chunks: Chunk[] = [];
    for (let at = 12; at + 8 <= glb.length; ) {
        const length = glb.readUInt32LE(at);
        chunks.push({ type: glb.readUInt32LE(at + 4), data: glb.subarray(at + 8, at + 8 + length) });
        at += 8 + length;
    }
    return chunks;
}

function firstTexturedMaterial(json: Json): Json {
    const found = (json.materials as Json[] | undefined)?.find(m => m.pbrMetallicRoughness?.baseColorTexture);
    if (!found) {
        throw new Error('this model has no texture to damage');
    }
    return found;
}

//  what an index can point at, and so what can point nowhere
export type IndexKind =
    | 'scene'
    | 'node'
    | 'mesh'
    | 'material'
    | 'texture'
    | 'image'
    | 'skin'
    | 'joint'
    | 'accessor'
    | 'bufferView'
    | 'buffer'
    | 'sampler'
    | 'target';

//  Each takes a good .glb and returns a copy with one thing wrong; with no
//  argument it damages fullModel(). Those that change the JSON need the
//  model to have the thing they change (a texture, a skin, an animation,
//  three nodes in a chain), as fullModel() does. Apart from its one
//  fault, each file is well-formed, so a checker that refuses it has
//  refused it for that fault.
export const hostile = {
    //  ---- something outside the file ----

    //  the buffer is at an address, though the binary chunk is still there
    bufferUri: (glb = full()): Buffer =>
        editGlb(glb, json => {
            json.buffers[0].uri = 'https://example.com/model.bin';
        }),

    //  the buffer is a data: address holding the real bytes, and there is
    //  no binary chunk: a correct glTF, which the hub still refuses
    bufferDataUri: (glb = full()): Buffer => {
        const { json, bin } = readGlb(glb);
        json.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
        return packGlb(json);
    },

    //  the first image is at an address
    imageUri: (glb = full()): Buffer =>
        editGlb(glb, json => {
            json.images[0] = { uri: 'https://example.com/texture.png' };
        }),

    //  the first image is a data: address holding a real PNG
    imageDataUri: (glb = full()): Buffer =>
        editGlb(glb, json => {
            const png = makePng({ width: 2, height: 2 });
            json.images[0] = { uri: `data:image/png;base64,${png.toString('base64')}` };
        }),

    //  ---- the container ----

    //  the header says four bytes more than the file has
    lengthLonger: (glb = full()): Buffer => {
        const made = Buffer.from(glb);
        made.writeUInt32LE(glb.length + 4, 8);
        return made;
    },

    //  the header says eight bytes fewer than the file has, ending inside
    //  the last chunk
    lengthShorter: (glb = full()): Buffer => {
        const made = Buffer.from(glb);
        made.writeUInt32LE(glb.length - 8, 8);
        return made;
    },

    //  the header and chunks agree, and four more bytes follow them
    trailingBytes: (glb = full()): Buffer => Buffer.concat([glb, Buffer.from('JUNK', 'latin1')]),

    //  the last chunk says it runs eight bytes past the end of the file
    chunkPastEnd: (glb = full()): Buffer => {
        const chunks = chunksOf(glb);
        const last = chunks[chunks.length - 1]!;
        last.length = last.data.length + 8;
        return packChunks(chunks);
    },

    //  the JSON chunk is not a multiple of four bytes long, so what follows
    //  it is off the boundary; the lengths all agree
    unpaddedJson: (glb = full()): Buffer => {
        const [json, ...rest] = chunksOf(glb) as [Chunk, ...Chunk[]];
        const text = json.data.toString('utf8').trimEnd();
        const data = Buffer.from(0 === Buffer.byteLength(text) % 4 ? `${text} ` : text, 'utf8');
        return packChunks([{ type: ChunkJson, data }, ...rest]);
    },

    //  the JSON chunk twice, then the binary chunk
    twoJsonChunks: (glb = full()): Buffer => {
        const [json, ...rest] = chunksOf(glb) as [Chunk, ...Chunk[]];
        return packChunks([json, json, ...rest]);
    },

    //  the binary chunk twice
    twoBinChunks: (glb = full()): Buffer => {
        const chunks = chunksOf(glb);
        return packChunks([...chunks, chunks[chunks.length - 1]!]);
    },

    //  the binary chunk before the JSON
    binFirst: (glb = full()): Buffer => packChunks(chunksOf(glb).reverse()),

    //  not "glTF" at the start
    badMagic: (glb = full()): Buffer => {
        const made = Buffer.from(glb);
        made.write('glTG', 0, 'latin1');
        return made;
    },

    //  the header's version: 1 unless another is given
    containerVersion: (glb = full(), version = 1): Buffer => {
        const made = Buffer.from(glb);
        made.writeUInt32LE(version, 4);
        return made;
    },

    //  ---- the JSON ----

    //  asset.version: "1.0" unless another is given
    assetVersion: (glb = full(), version = '1.0'): Buffer =>
        editGlb(glb, json => {
            json.asset.version = version;
        }),

    //  correct JSON of over a megabyte (1024 * 1024 bytes and more)
    jsonOverMegabyte: (glb = full()): Buffer =>
        editGlb(glb, json => {
            json.extras = { padding: 'x'.repeat(1024 * 1024) };
        }),

    //  two bytes that are never UTF-8, inside a string; correct JSON otherwise
    invalidUtf8: (glb = full()): Buffer => {
        const { json, bin } = readGlb(glb);
        json.asset.generator = '@@@@';
        const text = Buffer.from(JSON.stringify(json), 'utf8');
        text.set([0xff, 0xfe], text.indexOf('@@@@') + 1);
        return packGlb(text, bin);
    },

    //  correct UTF-8 that is not JSON: its last brace is a bracket
    invalidJson: (glb = full()): Buffer => {
        const { json, bin } = readGlb(glb);
        const text = Buffer.from(JSON.stringify(json), 'utf8');
        text[text.length - 1] = 0x5d;
        return packGlb(text, bin);
    },

    //  a required extension the hub does not allow: Draco unless another
    //  is given
    requiredExtension: (glb = full(), name = 'KHR_draco_mesh_compression'): Buffer =>
        editGlb(glb, json => {
            json.extensionsUsed = [...(json.extensionsUsed ?? []), name];
            json.extensionsRequired = [...(json.extensionsRequired ?? []), name];
        }),

    //  ---- what points where ----

    //  the buffer says it is longer than the binary chunk
    bufferPastChunk: (glb = full()): Buffer =>
        editGlb(glb, json => {
            json.buffers[0].byteLength += 64;
        }),

    //  the last buffer view runs past the end of the buffer and the chunk
    bufferViewPastEnd: (glb = full()): Buffer =>
        editGlb(glb, json => {
            json.bufferViews[json.bufferViews.length - 1].byteLength += json.buffers[0].byteLength;
        }),

    //  the first accessor has one more element than its buffer view holds
    accessorPastView: (glb = full()): Buffer =>
        editGlb(glb, json => {
            json.accessors[0].count += 1;
        }),

    //  an index that points at nothing (999), of the kind named: the
    //  scene's node, a node's mesh, a primitive's material, a material's
    //  texture, a texture's image, a node's skin, a skin's joint, a
    //  primitive's accessor, an accessor's buffer view, a buffer view's
    //  buffer, an animation channel's sampler or its target node, or the
    //  model's scene
    indexOutOfRange: (kind: IndexKind, glb = full()): Buffer =>
        editGlb(glb, json => {
            const nodes = json.nodes as Json[];
            switch (kind) {
                case 'scene':
                    json.scene = 999;
                    break;
                case 'node':
                    json.scenes[0].nodes.push(999);
                    break;
                case 'mesh':
                    nodes.find(n => undefined !== n.mesh)!.mesh = 999;
                    break;
                case 'material':
                    json.meshes[0].primitives[0].material = 999;
                    break;
                case 'texture':
                    firstTexturedMaterial(json).pbrMetallicRoughness.baseColorTexture.index = 999;
                    break;
                case 'image':
                    json.textures[0].source = 999;
                    break;
                case 'skin':
                    nodes.find(n => undefined !== n.skin)!.skin = 999;
                    break;
                case 'joint':
                    json.skins[0].joints[0] = 999;
                    break;
                case 'accessor':
                    json.meshes[0].primitives[0].attributes.POSITION = 999;
                    break;
                case 'bufferView':
                    json.accessors[0].bufferView = 999;
                    break;
                case 'buffer':
                    json.bufferViews[0].buffer = 999;
                    break;
                case 'sampler':
                    json.animations[0].channels[0].sampler = 999;
                    break;
                case 'target':
                    json.animations[0].channels[0].target.node = 999;
                    break;
            }
        }),

    //  a node that is its own descendant: the last node of the first chain
    //  of three gets the first as its child (or, with self, the first node
    //  with children gets itself)
    nodeCycle: (glb = full(), self = false): Buffer =>
        editGlb(glb, json => {
            const nodes = json.nodes as Json[];
            const top = nodes.findIndex(n => {
                const child = nodes[n.children?.[0]];
                return self ? n.children?.length : child?.children?.length;
            });
            if (top < 0) {
                throw new Error('this model has no chain of nodes to close into a ring');
            }
            if (self) {
                nodes[top]!.children.push(top);
            } else {
                const last = nodes[nodes[nodes[top]!.children[0]]!.children[0]]!;
                last.children = [...(last.children ?? []), top];
            }
        }),

    //  ---- more for the viewer to do than the file's size lets on ----
    //
    //  (A viewer's loader copies or draws again for each of these, where a
    //  count taken once would not show it. Khronos's validator lets most of
    //  them by: they are faults by the hub's rules, not all by glTF's.)

    //  the scene lists its first root again: once more unless told how many
    sceneRepeats: (glb = full(), times = 1): Buffer =>
        editGlb(glb, json => {
            const roots = json.scenes[0].nodes as number[];
            for (let n = 0; n < times; n++) {
                roots.push(roots[0]!);
            }
        }),

    //  the scene lists, with its roots, the first node that is a child
    sceneListsChild: (glb = full()): Buffer =>
        editGlb(glb, json => {
            const child = (json.nodes as Json[]).find(n => n.children?.length)?.children[0];
            if (undefined === child) {
                throw new Error('this model has no node that is a child');
            }
            json.scenes[0].nodes.push(child);
        }),

    //  the one scene, twice in all unless told how many
    scenes: (glb = full(), count = 2): Buffer =>
        editGlb(glb, json => {
            json.scenes = new Array(count).fill(json.scenes[0]);
        }),

    //  more nodes with nothing in them, each a root of the scene: 1,000
    //  more (the whole of class "light") unless told how many
    spareNodes: (glb = full(), count = 1000): Buffer =>
        editGlb(glb, json => {
            for (let n = 0; n < count; n++) {
                json.scenes[0].nodes.push(json.nodes.push({}) - 1);
            }
        }),

    //  morph targets on each primitive of the first mesh, every one of
    //  them the primitive's own positions over again: 9 (one over class
    //  "light") unless told how many
    morphTargets: (glb = full(), count = 9): Buffer =>
        editGlb(glb, json => {
            for (const primitive of json.meshes[0].primitives as Json[]) {
                primitive.targets = new Array(count).fill({ POSITION: primitive.attributes.POSITION });
            }
        }),

    //  one more buffer view (or as many as told) over the same bytes as
    //  the first accessor's, and nothing using it
    sharedViews: (glb = full(), count = 1): Buffer =>
        editGlb(glb, json => {
            const view = json.bufferViews[json.accessors[0].bufferView];
            for (let n = 0; n < count; n++) {
                json.bufferViews.push({
                    buffer: 0,
                    byteOffset: view.byteOffset,
                    byteLength: view.byteLength,
                });
            }
        }),

    //  the first animation's first channel, 65 times in all (one over class
    //  "light") unless told how many
    channels: (glb = full(), count = 65): Buffer =>
        editGlb(glb, json => {
            json.animations[0].channels = new Array(count).fill(json.animations[0].channels[0]);
        }),

    //  the first animation's first sampler, 65 times in all unless told how
    //  many, and the one channel that names it
    samplers: (glb = full(), count = 65): Buffer =>
        editGlb(glb, json => {
            const animation = json.animations[0];
            const first = animation.samplers[animation.channels[0].sampler];
            animation.samplers = new Array(count).fill(first);
            animation.channels = [{ ...animation.channels[0], sampler: 0 }];
        }),

    //  The first animation's first turn (a rotation), with its values kept
    //  as whole numbers of one byte each that stand for fractions (a
    //  normalized accessor), in bytes of their own at the buffer's end.
    //  Correct glTF, which the hub does not take.
    normalizedValues: (glb = full()): Buffer => {
        const { json, bin } = readGlb(glb);
        const animation = json.animations[0];
        const channel = (animation.channels as Json[]).find(c => 'rotation' === c.target.path);
        if (!channel) {
            throw new Error('this model has no rotation to pack');
        }
        const accessor = json.accessors[animation.samplers[channel.sampler].output];
        const from = json.bufferViews[accessor.bufferView].byteOffset ?? 0;
        const packed = Buffer.alloc(accessor.count * 4);
        for (let at = 0; at < packed.length; at++) {
            packed.writeInt8(Math.round(bin.readFloatLE(from + at * 4) * 127), at);
        }
        json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: packed.length });
        accessor.bufferView = json.bufferViews.length - 1;
        accessor.componentType = 5120;
        accessor.normalized = true;
        json.buffers[0].byteLength = bin.length + packed.length;
        return packGlb(json, Buffer.concat([bin, packed]));
    },

    //  The first animation's first times, spread out by a stride of eight
    //  bytes in a buffer view of their own at the buffer's end, with a
    //  number between each and the next that a reader ignoring the stride
    //  would take for a time: |between|, a day unless another is given.
    stridedTimes: (glb = full(), between = 86400): Buffer => {
        const { json, bin } = readGlb(glb);
        const accessor = json.accessors[json.animations[0].samplers[0].input];
        const from = json.bufferViews[accessor.bufferView].byteOffset ?? 0;
        const spread = Buffer.alloc(accessor.count * 8);
        for (let at = 0; at < accessor.count; at++) {
            spread.writeFloatLE(bin.readFloatLE(from + at * 4), at * 8);
            spread.writeFloatLE(between, at * 8 + 4);
        }
        json.bufferViews.push({
            buffer: 0,
            byteOffset: bin.length,
            byteLength: spread.length,
            byteStride: 8,
        });
        accessor.bufferView = json.bufferViews.length - 1;
        json.buffers[0].byteLength = bin.length + spread.length;
        return packGlb(json, Buffer.concat([bin, spread]));
    },

    //  The first animation's first times, changed: each [place, seconds]
    //  is written over the time at that place. Unless told otherwise, the
    //  second time is made nought, the same as the first.
    times: (glb = full(), changes: [number, number][] = [[1, 0]]): Buffer => {
        const { json, bin } = readGlb(glb);
        const accessor = json.accessors[json.animations[0].samplers[0].input];
        const from = json.bufferViews[accessor.bufferView].byteOffset ?? 0;
        for (const [place, seconds] of changes) {
            bin.writeFloatLE(seconds, from + place * 4);
        }
        //  what the accessor says of its times is left out, as it is now wrong
        delete accessor.min;
        delete accessor.max;
        return packGlb(json, bin);
    },

    //  attributes of the application's own on the first primitive, each
    //  its positions again, until it has 17 in all (one over class
    //  "light"), or as many as told
    manyAttributes: (glb = full(), count = 17): Buffer =>
        editGlb(glb, json => {
            const { attributes } = json.meshes[0].primitives[0];
            const more = count - Object.keys(attributes).length;
            for (let n = 0; n < more; n++) {
                attributes[`_EXTRA_${n}`] = attributes.POSITION;
            }
        }),

    //  Eleven more attributes on the first primitive (or as many as told),
    //  each an accessor of its own over the same bytes as its positions:
    //  one buffer view, read many times over. Correct glTF.
    sharedAccessors: (glb = full(), count = 11): Buffer =>
        editGlb(glb, json => {
            const { attributes } = json.meshes[0].primitives[0];
            for (let n = 0; n < count; n++) {
                json.accessors.push({ ...json.accessors[attributes.POSITION] });
                attributes[`_COPY_${n}`] = json.accessors.length - 1;
            }
        }),

    //  A key in the JSON that every object in JavaScript answers to
    //  already: "__proto__" unless another is given, among the attributes
    //  of the first primitive. (Written into the text: set on an object
    //  here, it would change the object and not be a key.)
    protoKey: (glb = full(), key = '__proto__'): Buffer => {
        const { json, bin } = readGlb(glb);
        const text = JSON.stringify(json).replace('"attributes":{', `"attributes":{${JSON.stringify(key)}:0,`);
        return packGlb(Buffer.from(text, 'utf8'), bin);
    },

    //  the first primitive's positions again, as an attribute of a name
    //  glTF does not have: "COLOUR_0" unless another is given
    attributeName: (glb = full(), name = 'COLOUR_0'): Buffer => {
        const { json, bin } = readGlb(glb);
        const text = JSON.stringify(json).replace(
            /"attributes":\{"POSITION":(\d+)/,
            (whole, positions) => `${whole},${JSON.stringify(name)}:${positions}`
        );
        return packGlb(Buffer.from(text, 'utf8'), bin);
    },
};
