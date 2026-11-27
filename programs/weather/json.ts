//  A small JSON reader for programs: enough to read the input the hub gives
//  a step and the replies of a web service. Anything malformed, or more
//  than MaxValues values, gives null rather than a trap, so a bad reply
//  costs one update, not the program. (A program's memory is small and
//  never freed: see the build spec of the live object slice.)

export const enum Kind {
    Null,
    Bool,
    Num,
    Str,
    Arr,
    Obj,
}

export class Value {
    kind: Kind = Kind.Null;
    bool: bool = false;
    num: f64 = 0;
    str: string = '';
    //  only arrays and objects have these
    items: Value[] | null = null;
    keys: string[] | null = null;

    //  a member of an object, or null
    get(key: string): Value | null {
        const keys = this.keys;
        const items = this.items;
        if (this.kind != Kind.Obj || keys == null || items == null) return null;
        for (let i = keys.length - 1; i >= 0; i--) {
            if (keys[i] == key) return items[i];
        }
        return null;
    }
    //  an item of an array, or null
    at(i: i32): Value | null {
        const items = this.items;
        if (this.kind != Kind.Arr || items == null || i < 0 || i >= items.length) return null;
        return items[i];
    }
    isNum(): bool {
        return this.kind == Kind.Num;
    }
    isStr(): bool {
        return this.kind == Kind.Str;
    }
}

const MaxDepth = 32;
const MaxValues = 4096;

class Parser {
    s: string;
    p: i32 = 0;
    failed: bool = false;
    count: i32 = 0;

    constructor(s: string) {
        this.s = s;
    }

    fail(): Value {
        this.failed = true;
        return new Value();
    }

    space(): void {
        while (this.p < this.s.length) {
            const c = this.s.charCodeAt(this.p);
            if (c != 0x20 && c != 0x09 && c != 0x0a && c != 0x0d) break;
            this.p++;
        }
    }

    value(depth: i32): Value {
        if (depth > MaxDepth || ++this.count > MaxValues) return this.fail();
        this.space();
        if (this.p >= this.s.length) return this.fail();
        const c = this.s.charCodeAt(this.p);
        if (c == 0x7b) return this.object(depth);
        if (c == 0x5b) return this.array(depth);
        if (c == 0x22) {
            const v = new Value();
            v.kind = Kind.Str;
            v.str = this.string();
            return v;
        }
        if (this.word('true')) return this.boolean(true);
        if (this.word('false')) return this.boolean(false);
        if (this.word('null')) return new Value();
        return this.number();
    }

    word(w: string): bool {
        if (this.s.substr(this.p, w.length) == w) {
            this.p += w.length;
            return true;
        }
        return false;
    }

    boolean(b: bool): Value {
        const v = new Value();
        v.kind = Kind.Bool;
        v.bool = b;
        return v;
    }

    number(): Value {
        const start = this.p;
        while (this.p < this.s.length) {
            const c = this.s.charCodeAt(this.p);
            const numeric = (c >= 0x30 && c <= 0x39) || c == 0x2d || c == 0x2b || c == 0x2e || c == 0x65 || c == 0x45;
            if (!numeric) break;
            this.p++;
        }
        if (this.p == start) return this.fail();
        const n = parseFloat(this.s.substring(start, this.p));
        if (isNaN(n) || !isFinite(n)) return this.fail();
        const v = new Value();
        v.kind = Kind.Num;
        v.num = n;
        return v;
    }

    hex(): i32 {
        let n = 0;
        for (let i = 0; i < 4; i++) {
            if (this.p >= this.s.length) {
                this.failed = true;
                return 0;
            }
            const c = this.s.charCodeAt(this.p++);
            let d = -1;
            if (c >= 0x30 && c <= 0x39) d = c - 0x30;
            else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
            else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
            if (d < 0) {
                this.failed = true;
                return 0;
            }
            n = n * 16 + d;
        }
        return n;
    }

    //  Programs built with the stub runtime never free memory, so a string
    //  is put together once, from its pieces, rather than grown by adding
    //  to it, which would use memory in proportion to its length squared
    string(): string {
        this.p++; //  the opening quote
        const parts: string[] = [];
        let start = this.p;
        while (this.p < this.s.length) {
            const c = this.s.charCodeAt(this.p);
            if (c == 0x22) {
                parts.push(this.s.substring(start, this.p));
                this.p++;
                return parts.length == 1 ? parts[0] : parts.join('');
            }
            if (c < 0x20) break;
            if (c == 0x5c) {
                if (this.p > start) parts.push(this.s.substring(start, this.p));
                this.p++;
                if (this.p >= this.s.length) break;
                const e = this.s.charCodeAt(this.p++);
                if (e == 0x22) parts.push('"');
                else if (e == 0x5c) parts.push('\\');
                else if (e == 0x2f) parts.push('/');
                else if (e == 0x62) parts.push('\b');
                else if (e == 0x66) parts.push('\f');
                else if (e == 0x6e) parts.push('\n');
                else if (e == 0x72) parts.push('\r');
                else if (e == 0x74) parts.push('\t');
                else if (e == 0x75) parts.push(String.fromCharCode(this.hex()));
                else break;
                start = this.p;
                continue;
            }
            this.p++;
        }
        this.failed = true;
        return '';
    }

    array(depth: i32): Value {
        this.p++;
        const v = new Value();
        v.kind = Kind.Arr;
        const items: Value[] = [];
        v.items = items;
        this.space();
        if (this.p < this.s.length && this.s.charCodeAt(this.p) == 0x5d) {
            this.p++;
            return v;
        }
        while (!this.failed) {
            items.push(this.value(depth + 1));
            this.space();
            if (this.p >= this.s.length) return this.fail();
            const c = this.s.charCodeAt(this.p++);
            if (c == 0x5d) return v;
            if (c != 0x2c) return this.fail();
        }
        return v;
    }

    object(depth: i32): Value {
        this.p++;
        const v = new Value();
        v.kind = Kind.Obj;
        const keys: string[] = [];
        const items: Value[] = [];
        v.keys = keys;
        v.items = items;
        this.space();
        if (this.p < this.s.length && this.s.charCodeAt(this.p) == 0x7d) {
            this.p++;
            return v;
        }
        while (!this.failed) {
            this.space();
            if (this.p >= this.s.length || this.s.charCodeAt(this.p) != 0x22) return this.fail();
            const key = this.string();
            this.space();
            if (this.p >= this.s.length || this.s.charCodeAt(this.p++) != 0x3a) return this.fail();
            keys.push(key);
            items.push(this.value(depth + 1));
            this.space();
            if (this.p >= this.s.length) return this.fail();
            const c = this.s.charCodeAt(this.p++);
            if (c == 0x7d) return v;
            if (c != 0x2c) return this.fail();
        }
        return v;
    }
}

//  The value the text holds, or null if it isn't JSON
export function parse(s: string): Value | null {
    const parser = new Parser(s);
    const v = parser.value(0);
    parser.space();
    if (parser.failed || parser.p != s.length) return null;
    return v;
}

//  A string as a JSON string, quoted and escaped
export function quote(s: string): string {
    const parts: string[] = ['"'];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c != 0x22 && c != 0x5c && c >= 0x20) continue;
        if (i > start) parts.push(s.substring(start, i));
        if (c == 0x22) parts.push('\\"');
        else if (c == 0x5c) parts.push('\\\\');
        else {
            const h = c.toString(16);
            parts.push('\\u' + (h.length < 2 ? '000' : '00') + h);
        }
        start = i + 1;
    }
    if (s.length > start) parts.push(s.substring(start));
    parts.push('"');
    return parts.join('');
}
