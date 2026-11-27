//  The weather for a place, from Open-Meteo: the framework's first live
//  object program (build spec of the live object slice).
//
//  Its input is a place, by name ({ "name": "Berlin" }) or by coordinates
//  ({ "latitude": 52.52, "longitude": 13.41, "label": "Berlin" }). Each
//  update takes two steps. The first asks the hub to fetch the current
//  weather there (or first to look the name up, once, keeping what it
//  found); the next, which the hub runs as soon as the replies are in,
//  turns the reply into the object's `weather` values.
//
//  Weather data by Open-Meteo.com (CC BY 4.0); place names from GeoNames.

import { parse, quote, Value } from './json';

@external('cyberspace', 'input_len')
declare function input_len(): i32;
@external('cyberspace', 'input_read')
declare function input_read(ptr: usize): void;
@external('cyberspace', 'fetch')
declare function host_fetch(ptr: usize, len: i32): i32;
@external('cyberspace', 'values')
declare function host_values(ptr: usize, len: i32): void;
@external('cyberspace', 'keep')
declare function host_keep(ptr: usize, len: i32): void;
@external('cyberspace', 'log')
declare function host_log(ptr: usize, len: i32): void;

const Forecast = 'https://api.open-meteo.com/v1/forecast';
const Geocode = 'https://geocoding-api.open-meteo.com/v1/search';
const Current = 'temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day';

function fetch(url: string): i32 {
    const b = String.UTF8.encode(url);
    return host_fetch(changetype<usize>(b), b.byteLength);
}
function setValues(json: string): void {
    const b = String.UTF8.encode(json);
    host_values(changetype<usize>(b), b.byteLength);
}
function keep(json: string): void {
    const b = String.UTF8.encode(json);
    host_keep(changetype<usize>(b), b.byteLength);
}
function log(line: string): void {
    const b = String.UTF8.encode(line);
    host_log(changetype<usize>(b), b.byteLength);
}

function num(v: Value | null): f64 {
    return v != null && v.isNum() ? v.num : NaN;
}
function str(v: Value | null): string {
    return v != null && v.isStr() ? v.str : '';
}
function validLat(n: f64): bool {
    return !isNaN(n) && n >= -90 && n <= 90;
}
function validLon(n: f64): bool {
    return !isNaN(n) && n >= -180 && n <= 180;
}

//  What the program remembers between steps
class State {
    name: string = ''; //    the name it looked up
    lat: f64 = NaN;
    lon: f64 = NaN;
    place: string = ''; //   the label shown
    pending: string = ''; // 'geo' or 'wx': what the last step asked for

    static from(v: Value | null): State {
        const s = new State();
        if (v == null) return s;
        s.name = str(v.get('name'));
        s.lat = num(v.get('lat'));
        s.lon = num(v.get('lon'));
        s.place = str(v.get('place'));
        s.pending = str(v.get('pending'));
        return s;
    }

    json(): string {
        let out = '{"name":' + quote(this.name) + ',"place":' + quote(this.place) + ',"pending":' + quote(this.pending);
        if (validLat(this.lat) && validLon(this.lon)) out += ',"lat":' + this.lat.toString() + ',"lon":' + this.lon.toString();
        return out + '}';
    }
}

function askWeather(s: State): void {
    const url = Forecast + '?latitude=' + s.lat.toString() + '&longitude=' + s.lon.toString() + '&current=' + Current + '&timezone=GMT';
    s.pending = fetch(url) >= 0 ? 'wx' : '';
    if (s.pending == '') log('the hub refused the weather request');
}

function askPlace(s: State, name: string): void {
    s.name = name;
    s.lat = NaN;
    s.lon = NaN;
    s.place = '';
    const url = Geocode + '?name=' + encodeURIComponent(name) + '&count=1&language=en&format=json';
    s.pending = fetch(url) >= 0 ? 'geo' : '';
    if (s.pending == '') log('the hub refused the place request');
}

//  The reply's body as JSON, if the fetch succeeded
function replyBody(reply: Value | null, what: string): Value | null {
    if (reply == null) return null;
    const status = num(reply.get('status'));
    const body = parse(str(reply.get('body')));
    if (status != 200) {
        let reason = '';
        if (body != null) reason = str(body.get('reason'));
        log(what + ' failed (' + (isNaN(status) ? '?' : (<i32>status).toString()) + ')' + (reason.length ? ': ' + reason : ''));
        return null;
    }
    if (body == null) log(what + ': the reply is not JSON');
    return body;
}

//  A value as a JSON member, if it is a number
function member(name: string, v: f64): string {
    return isNaN(v) || !isFinite(v) ? '' : ',' + quote(name) + ':' + v.toString();
}

function weatherValues(body: Value, s: State): string | null {
    const c = body.get('current');
    if (c == null) {
        log('the weather reply has no current conditions');
        return null;
    }
    let out = '{"place":' + quote(s.place);
    out += member('temperature', num(c.get('temperature_2m')));
    out += member('precipitation', num(c.get('precipitation')));
    out += member('code', num(c.get('weather_code')));
    out += member('cloudCover', num(c.get('cloud_cover')));
    out += member('windSpeed', num(c.get('wind_speed_10m')));
    out += member('windDirection', num(c.get('wind_direction_10m')));
    const day = num(c.get('is_day'));
    if (!isNaN(day)) out += ',"isDay":' + (day != 0 ? 'true' : 'false');
    //  times come in GMT, to the minute: "2026-11-27T17:00"
    const time = str(c.get('time'));
    if (time.length == 16) out += ',"observedAt":' + quote(time + ':00Z');
    return out + '}';
}

export function step(): void {
    const len = input_len();
    const buf = new ArrayBuffer(len);
    input_read(changetype<usize>(buf));
    const all = parse(String.UTF8.decode(buf));
    if (all == null) {
        log('the input is not JSON');
        return;
    }
    const input = all.get('input');
    const s = State.from(all.get('state'));
    const replies = all.get('replies');
    const reply = replies != null ? replies.at(0) : null;

    //  the place asked for: coordinates first, else a name
    let lat: f64 = NaN, lon: f64 = NaN;
    let name = '', label = '';
    if (input != null) {
        lat = num(input.get('latitude'));
        lon = num(input.get('longitude'));
        name = str(input.get('name')).trim();
        label = str(input.get('label')).trim();
    }
    const byCoordinates = validLat(lat) && validLon(lon);
    if (!byCoordinates && (name.length == 0 || name.length > 100)) {
        log('the input names no place: give a name, or a latitude and longitude');
        return;
    }

    //  replies to what the last step asked for
    if (s.pending == 'geo' && reply != null) {
        s.pending = '';
        const body = replyBody(reply, 'looking up the place');
        const results = body != null ? body.get('results') : null;
        const first = results != null ? results.at(0) : null;
        if (body != null && first == null) log('no place is called ' + quote(name));
        if (first == null || !validLat(num(first.get('latitude'))) || !validLon(num(first.get('longitude')))) {
            keep(s.json());
            return;
        }
        s.lat = num(first.get('latitude'));
        s.lon = num(first.get('longitude'));
        const country = str(first.get('country'));
        s.place = str(first.get('name')) + (country.length ? ', ' + country : '');
        //  and now the weather there, in this same step
        askWeather(s);
        keep(s.json());
        return;
    }
    if (s.pending == 'wx' && reply != null) {
        s.pending = '';
        const body = replyBody(reply, 'the weather');
        if (body != null) {
            const values = weatherValues(body, s);
            if (values != null) setValues(values);
        }
        keep(s.json());
        return;
    }

    //  a new update: ask for the weather, looking the name up first if it
    //  is new
    s.pending = '';
    if (byCoordinates) {
        s.name = '';
        s.lat = lat;
        s.lon = lon;
        s.place = label.length ? label : lat.toString() + ', ' + lon.toString();
        askWeather(s);
    } else if (s.name == name && validLat(s.lat) && validLon(s.lon)) {
        askWeather(s);
    } else {
        askPlace(s, name);
    }
    keep(s.json());
}
