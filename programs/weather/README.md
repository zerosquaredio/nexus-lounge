# Weather (Open-Meteo)

The current weather for a place, from [Open-Meteo](https://open-meteo.com/):
the framework's first live object program
([build spec](../../docs/development/build_live_object_slice.md)).

**Input** (in the object's record): a place by name, `{ "name": "Berlin" }`,
or by coordinates, `{ "latitude": 52.52, "longitude": 13.41, "label": "Berlin" }`.

**Values** (the shared `weather` type): `place`, `temperature` (°C),
`precipitation` (mm), `code` (WMO), `cloudCover` (%), `windSpeed` (km/h),
`windDirection` (°), `isDay`, `observedAt`.

**How it works:** each update is two steps. The first asks the hub to fetch
the weather (or first to look a name up, once); the next, run as soon as the
replies are in, turns the reply into values. It reaches only
`api.open-meteo.com` and `geocoding-api.open-meteo.com`, and only where the
hub running it allows them too.

**Build** (reproducible: the same source and compiler give the same bytes):

```
npm ci --ignore-scripts
npm run build
```

AssemblyScript 0.28.20 with `--runtime stub --use abort= --maximumMemory 16
--exportStart _initialize`. The build of this source has SHA-256
`a37a816ebddd31c0a301c58a8e2531c3097ef0cd4e8468e3bb4f6a2c6530869e`, which
the hub's tests check (`hub/control/test/weather_program.test.ts`).

**Credit:** weather data by [Open-Meteo.com](https://open-meteo.com/)
(CC BY 4.0), place names from [GeoNames](https://www.geonames.org/)
(CC BY 4.0). Open-Meteo's free service is for non-commercial use.

**Licence:** BSD 2-Clause, as the rest of this repository.
