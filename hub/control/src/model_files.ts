//  The scripts a model's page runs (build_3d_slice.md §5): the hub's own
//  viewer in web/ and its copy of three.js in vendor/three/, served from the
//  hub's own address and nowhere else, by a fixed list: a request names one
//  of these or gets nothing. Each is read once, when first asked for, and
//  carries a tag of its contents, so a browser that has it asks again only
//  to hear it hasn't changed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const control = join(dirname(fileURLToPath(import.meta.url)), '..');

//  the hub's own, in web/
export const ViewerScripts = ['model_page.js', 'model_viewer.js', 'model_file.js'];

//  the copy of three.js, by the paths the viewer and its files import
export const VendoredScripts = [
    'build/three.module.js',
    'build/three.core.js',
    'examples/jsm/loaders/GLTFLoader.js',
    'examples/jsm/controls/OrbitControls.js',
    'examples/jsm/utils/BufferGeometryUtils.js',
    'examples/jsm/utils/SkeletonUtils.js',
];

const Files = new Map<string, string>([
    ...ViewerScripts.map(name => [`/web/${name}`, join(control, 'web', name)] as [string, string]),
    ...VendoredScripts.map(
        path => [`/vendor/three/${path}`, join(control, 'vendor', 'three', ...path.split('/'))] as [string, string]
    ),
]);

export interface ViewerFile {
    body: Buffer;
    etag: string;
}

const read = new Map<string, ViewerFile>();

//  The file served at |path|, if it is one of the viewer's
export function viewerFile(path: string): ViewerFile | null {
    const on = Files.get(path);
    if (!on) {
        return null;
    }
    let file = read.get(path);
    if (!file) {
        const body = readFileSync(on);
        file = { body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` };
        read.set(path, file);
    }
    return file;
}

//  The model page's policy: the hub's pages' own, and besides, its scripts
//  from the hub's address, the one fetch of the model, and the pictures the
//  viewer makes in the page from the model's textures. No WebAssembly, no
//  workers, nothing from any other address.
export function modelPagePolicy(publicUrl: string): string {
    return `default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: ${publicUrl}; font-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`;
}
