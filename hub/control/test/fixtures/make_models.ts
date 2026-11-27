//  The project's sample models (fixtures/models/README.md), made from code
//  with the builder in ../glb.ts. Run it to write them again:
//
//      node test/fixtures/make_models.ts
//
//  The same code gives the same bytes every time, and a test checks the
//  files against it, so a model is changed here and never by hand.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { box, buildGlb, makePng, sphere, tube, turn } from '../glb.ts';
import type { Model, Vec3 } from '../glb.ts';

const Credit = {
    generator: 'Nexus Lounge hub, test/fixtures/make_models.ts',
    copyright: 'The Nexus Lounge project, CC BY 4.0',
};

//  quaternions for a whole turn about an axis, in quarter turns
function wholeTurn(axis: Vec3): number[] {
    return [0, 90, 180, 270, 360].flatMap(degrees => turn(axis, degrees));
}

//  a ball of 288 triangles, coloured by which way each part of it faces
function still(): Model {
    const ball = sphere(1, 16, 10);
    return {
        ...Credit,
        materials: [{ name: 'painted', colour: [1, 1, 1, 1] }],
        meshes: [
            {
                name: 'ball',
                primitives: [{ ...ball, colours: ball.normals!.map(v => 0.5 + 0.5 * v), material: 0 }],
            },
        ],
        nodes: [{ name: 'ball', mesh: 0 }],
    };
}

//  a stand, an arm that swings round on it and a ball at the arm's end:
//  "idle" turns the arm slowly while the ball bobs, "spin" turns it fast
//  while the ball swells
function animated(): Model {
    return {
        ...Credit,
        materials: [
            { name: 'stand', colour: [0.35, 0.35, 0.4, 1] },
            { name: 'arm', colour: [0.85, 0.55, 0.15, 1] },
            { name: 'ball', colour: [0.2, 0.6, 0.9, 1] },
        ],
        meshes: [
            { name: 'stand', primitives: [{ ...box(1.2, 0.3, 1.2), material: 0 }] },
            { name: 'arm', primitives: [{ ...box(1.6, 0.15, 0.2), material: 1 }] },
            { name: 'ball', primitives: [{ ...sphere(0.25, 12, 8), material: 2 }] },
        ],
        nodes: [
            { name: 'stand', mesh: 0, translation: [0, 0.15, 0], children: [1] },
            { name: 'arm', mesh: 1, translation: [0, 0.5, 0], children: [2] },
            { name: 'ball', mesh: 2, translation: [0.8, 0.3, 0] },
        ],
        animations: [
            {
                name: 'idle',
                channels: [
                    { node: 1, path: 'rotation', times: [0, 1.5, 3, 4.5, 6], values: wholeTurn([0, 1, 0]) },
                    {
                        node: 2,
                        path: 'translation',
                        times: [0, 1.5, 3, 4.5, 6],
                        values: [0.8, 0.3, 0, 0.8, 0.5, 0, 0.8, 0.3, 0, 0.8, 0.5, 0, 0.8, 0.3, 0],
                    },
                ],
            },
            {
                name: 'spin',
                channels: [
                    {
                        node: 1,
                        path: 'rotation',
                        times: [0, 0.25, 0.5, 0.75, 1],
                        values: wholeTurn([0, 1, 0]),
                    },
                    { node: 2, path: 'scale', times: [0, 0.5, 1], values: [1, 1, 1, 1.6, 1.6, 1.6, 1, 1, 1] },
                ],
            },
        ],
    };
}

//  a tube of 256 triangles on a chain of four bones, bending one way and
//  then the other
function skinned(): Model {
    const bones = 4;
    const sway = [0, 20, 0, -20, 0];
    return {
        ...Credit,
        materials: [{ name: 'tube', colour: [0.3, 0.75, 0.45, 1], doubleSided: true }],
        meshes: [{ name: 'tube', primitives: [{ ...tube(0.3, 4, 8, 16, bones), material: 0 }] }],
        nodes: [
            { name: 'tube', mesh: 0, skin: 0 },
            { name: 'bone0', children: [2] },
            { name: 'bone1', translation: [0, 1, 0], children: [3] },
            { name: 'bone2', translation: [0, 1, 0], children: [4] },
            { name: 'bone3', translation: [0, 1, 0] },
        ],
        skins: [{ name: 'chain', joints: [1, 2, 3, 4] }],
        animations: [
            {
                name: 'bend',
                channels: [1, 2, 3, 4].map(node => ({
                    node,
                    path: 'rotation' as const,
                    times: [0, 1, 2, 3, 4],
                    values: sway.flatMap(degrees => turn([0, 0, 1], degrees)),
                })),
            },
        ],
    };
}

//  a box with a chequered picture of 64 by 64 pixels on each face
function textured(): Model {
    const chequers = makePng({
        width: 64,
        height: 64,
        pixel: (x, y) => (0 === ((x >> 3) + (y >> 3)) % 2 ? [230, 220, 190] : [150, 50, 60]),
    });
    return {
        ...Credit,
        materials: [{ name: 'chequers', texture: chequers }],
        meshes: [{ name: 'box', primitives: [{ ...box(1.5, 1.5, 1.5), material: 0 }] }],
        nodes: [{ name: 'box', mesh: 0 }],
    };
}

//  A placeholder for a preview: nothing here can draw a model, so it is a
//  plain card in the model's colour with a lighter band across it.
function preview(colour: [number, number, number]): Buffer {
    return makePng({
        width: 256,
        height: 256,
        pixel: (x, y) => {
            const band = Math.abs(x + y - 255) < 28;
            const edge = x < 4 || y < 4 || x > 251 || y > 251;
            return colour.map(v => (edge ? 24 : band ? Math.min(255, v + 70) : v)) as [
                number,
                number,
                number,
            ];
        },
    });
}

//  every file of fixtures/models but its README, by name
export function modelFiles(): Record<string, Buffer> {
    return {
        'still.glb': buildGlb(still()),
        'still.png': preview([150, 90, 160]),
        'animated.glb': buildGlb(animated()),
        'animated.png': preview([200, 130, 40]),
        'skinned.glb': buildGlb(skinned()),
        'skinned.png': preview([60, 150, 90]),
        'textured.glb': buildGlb(textured()),
        'textured.png': preview([150, 50, 60]),
    };
}

if (import.meta.main) {
    const folder = join(import.meta.dirname, 'models');
    mkdirSync(folder, { recursive: true });
    for (const [name, bytes] of Object.entries(modelFiles())) {
        writeFileSync(join(folder, name), bytes);
        console.log(`${name}: ${bytes.length} bytes`);
    }
}
