//  What the model viewer reads of a model's file by itself, before the 3D
//  library is given it: the file's own description of itself, and whether
//  that names anything kept outside the file. Also the words put on an
//  animation's button. No imports and nothing of the browser's page, so the
//  tests run these as they are (test/viewer_files.test.ts).
//
//  A model on the hub is one file with everything inside it. The hub's
//  checker refuses a model that names an address before it is ever kept;
//  the viewer holds the same rule again in the page, twice over: here, from
//  the file's bytes, and in the loader, which is let open only the blob:
//  addresses it makes itself. This one does not lean on how the loader is
//  written.

//  "glTF", as the four bytes are read little end first
const Magic = 0x46546c67;
//  the two kinds of chunk a binary glTF file has: "JSON" and "BIN\0"
const JsonChunk = 0x4e4f534a;
//  the 12-byte header, and the 8 bytes before each chunk's contents
const HeaderLength = 12;
const ChunkHeadLength = 8;
//  an animation's button shows no more than this many characters of its name
const MaxNameLength = 48;

//  The description (the JSON) inside a binary glTF file, parsed. Throws for
//  anything that is not one such file, whole, with one description placed
//  first. The loader would take a later description over an earlier one, so
//  a file with two is refused: what is checked must be what is shown.
export function modelJson(data) {
    const view = new DataView(data);
    if (view.byteLength < HeaderLength + ChunkHeadLength || view.getUint32(0, true) !== Magic) {
        throw new Error('the file is not a binary glTF model');
    }
    if (view.getUint32(4, true) !== 2) {
        throw new Error('the model is not glTF version 2');
    }
    const total = view.getUint32(8, true);
    if (total > view.byteLength) {
        throw new Error('the model says it is longer than its file');
    }
    let json = null;
    let offset = HeaderLength;
    let first = true;
    while (offset < total) {
        if (offset + ChunkHeadLength > total) {
            throw new Error('the model ends part-way through a chunk');
        }
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        offset += ChunkHeadLength;
        if (length > total - offset) {
            throw new Error('the model ends part-way through a chunk');
        }
        if (first !== (type === JsonChunk)) {
            throw new Error(
                first ? "the model's first chunk is not its description" : 'the model has two descriptions'
            );
        }
        if (first) {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(
                new Uint8Array(data, offset, length)
            );
            json = JSON.parse(text);
        }
        first = false;
        offset += length;
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error("the model's description is not an object");
    }
    return json;
}

//  Where a model's description names an address: every buffer and image
//  that has a uri at all, whatever it holds (another site, the hub's own
//  paths, data:, blob:, even nothing). Each is given as its place, such as
//  "images[0]". An empty list means everything is inside the file.
export function addressesNamed(json) {
    const found = [];
    for (const key of ['buffers', 'images']) {
        const list = json[key];
        if (list === undefined) {
            continue;
        }
        if (list === null || typeof list !== 'object') {
            found.push(key);
            continue;
        }
        //  not only a list: the loader reads these by number, which an
        //  object with numbers for keys would answer as well
        for (const [place, entry] of Object.entries(list)) {
            if (entry !== null && typeof entry === 'object' && 'uri' in entry) {
                found.push(`${key}[${place}]`);
            }
        }
    }
    return found;
}

//  The words on an animation's button. The name is the model maker's own:
//  its spaces are tidied, a long one is cut short, and one with nothing to
//  see or say in it (empty, all spaces, only characters that do not show)
//  gives "Animation 3" by its place.
export function animationLabel(name, index) {
    const tidy = (typeof name === 'string' ? name : '').replace(/\s+/gu, ' ').trim();
    if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(tidy)) {
        return `Animation ${index + 1}`;
    }
    const characters = [...tidy];
    if (characters.length <= MaxNameLength) {
        return tidy;
    }
    return `${characters.slice(0, MaxNameLength).join('').trimEnd()}…`;
}
