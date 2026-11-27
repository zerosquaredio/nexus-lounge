//  Shared value types for live objects (compute spec §1.1; build spec of the
//  live object slice, §3 "the weather type"). Every value a program sets is
//  checked here against its type before anyone sees it: a value outside its
//  limits is dropped alone, and names the type doesn't have are ignored.

export type ValueSpec =
    | { kind: 'number'; min: number; max: number; unit?: string }
    | { kind: 'boolean' }
    //  a time, ISO 8601, not in the future and not older than maxAgeMs
    | { kind: 'time'; maxAgeMs: number }
    //  a label shown to everyone: plain text, cut short
    | { kind: 'label'; maxLength: number };

export const ValueTypes: Record<string, Record<string, ValueSpec>> = {
    weather: {
        temperature: { kind: 'number', min: -90, max: 60, unit: '°C' },
        precipitation: { kind: 'number', min: 0, max: 500, unit: 'mm' },
        code: { kind: 'number', min: 0, max: 99, unit: 'WMO code' },
        cloudCover: { kind: 'number', min: 0, max: 100, unit: '%' },
        windSpeed: { kind: 'number', min: 0, max: 500, unit: 'km/h' },
        windDirection: { kind: 'number', min: 0, max: 360, unit: '°' },
        isDay: { kind: 'boolean' },
        observedAt: { kind: 'time', maxAgeMs: 24 * 60 * 60 * 1000 },
        place: { kind: 'label', maxLength: 60 },
    },
};

export type Values = Record<string, number | boolean | string>;

//  A clock a little ahead of the hub's is no reason to drop a reading
const FutureSlackMs = 5 * 60 * 1000;

//  The values of |type| that hold, from what a program set
export function checkValues(type: string, given: Record<string, unknown>, now: number): Values {
    const specs = ValueTypes[type];
    const out: Values = {};
    if (!specs) {
        return out;
    }
    for (const [name, spec] of Object.entries(specs)) {
        if (!Object.hasOwn(given, name)) {
            continue;
        }
        const v = given[name];
        switch (spec.kind) {
            case 'number':
                if ('number' === typeof v && Number.isFinite(v) && v >= spec.min && v <= spec.max) {
                    out[name] = v;
                }
                break;
            case 'boolean':
                if ('boolean' === typeof v) {
                    out[name] = v;
                }
                break;
            case 'time': {
                const t =
                    'string' === typeof v && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/.test(v)
                        ? Date.parse(v)
                        : NaN;
                if (Number.isFinite(t) && t <= now + FutureSlackMs && now - t <= spec.maxAgeMs) {
                    out[name] = new Date(t).toISOString();
                }
                break;
            }
            case 'label': {
                if ('string' === typeof v) {
                    //  as chat is: no control or direction characters
                    const plain = v
                        .replace(/(?!‍)[\p{Cc}\p{Cf}]/gu, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    const cut = Array.from(plain).slice(0, spec.maxLength).join('').trim();
                    if (cut) {
                        out[name] = cut;
                    }
                }
                break;
            }
        }
    }
    return out;
}
