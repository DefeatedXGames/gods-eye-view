// THE GUARDED NOMINATIM GATE AND OUTLINE ROUTE.
//
// Search and voice outlines share one gate to the public instance: 1.1 s
// spacing, a short queue, a daily cap per install, a pause when the server
// says stop, one retry only after a transport failure, and caches that never
// record a failure as "no such place". Outline answers are accepted only when
// the result's class suits the ask.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNominatimGate,
  createUsageStore,
  parseRetryAfter,
  resolveNominatimSettings,
  PUBLIC_NOMINATIM_SEARCH,
} from '../../server/providers/regional/nominatimGate.js';
import {
  createNominatimCache,
  normalizePlaceName,
  NOMINATIM_CACHE_TTL_MS,
} from '../../server/providers/regional/nominatimCache.js';
import {
  acceptsOutlineClass,
  capOutlineVertices,
  outlineBias,
  selectOutlineResult,
} from '../../server/providers/regional/outlineSelect.js';
import {
  createNominatimOutlineProvider,
  createNominatimSearchProvider,
  geocodeProxy,
} from '../../server/providers/regional/place.js';

const PUBLIC = {
  endpoint: PUBLIC_NOMINATIM_SEARCH,
  isPublic: true,
  dailyCap: 50,
};
const OPERATOR = {
  endpoint: 'https://geo.example.test/search',
  isPublic: false,
  dailyCap: 50,
};

const square = (lon, lat, d = 0.001) => [
  [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ],
];

const row = (overrides) => ({
  lat: '30.27',
  lon: '-97.74',
  display_name: 'Somewhere',
  osm_type: 'relation',
  osm_id: 1,
  geojson: { type: 'Polygon', coordinates: square(-97.74, 30.27) },
  ...overrides,
});

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

/** A fake clock whose sleeps advance time instantly and are recorded. */
function clock(start = Date.UTC(2026, 8, 28, 12)) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    return await respond(String(url), options, calls.length);
  };
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------- settings

test('endpoint settings: unset is public, empty disables, operator URLs are not public', () => {
  assert.deepEqual(resolveNominatimSettings({}), {
    endpoint: PUBLIC_NOMINATIM_SEARCH,
    isPublic: true,
    dailyCap: 50,
  });
  for (const off of ['', ' ', 'off', 'none', 'disabled'])
    assert.equal(resolveNominatimSettings({ NOMINATIM_URL: off }).endpoint, null);
  const own = resolveNominatimSettings({
    NOMINATIM_URL: 'https://geo.example.test',
  });
  assert.equal(own.endpoint, 'https://geo.example.test/search');
  assert.equal(own.isPublic, false);
  assert.equal(
    resolveNominatimSettings({
      NOMINATIM_URL: 'http://localhost:8080/search',
    }).endpoint,
    'http://localhost:8080/search',
  );
  // A mistyped value disables rather than silently falling back to public.
  for (const bad of ['not a url', 'ftp://x.test', 'https://u:p@x.test', 'https://x.test/search?q=1'])
    assert.equal(resolveNominatimSettings({ NOMINATIM_URL: bad }).endpoint, null, bad);
  assert.equal(
    resolveNominatimSettings({ NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search' }).isPublic,
    true,
  );
  assert.equal(resolveNominatimSettings({ NOMINATIM_DAILY_CAP: '7' }).dailyCap, 7);
  assert.equal(resolveNominatimSettings({ NOMINATIM_DAILY_CAP: '0' }).dailyCap, 0);
  assert.equal(resolveNominatimSettings({ NOMINATIM_DAILY_CAP: 'x' }).dailyCap, 50);
});

test('Retry-After reads seconds and HTTP dates', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfter('120', now), 120_000);
  assert.equal(parseRetryAfter(new Date(now + 30_000).toUTCString(), now), 30_000);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});

// ---------------------------------------------------------------- the gate

test('search and outlines share one pacer: requests start at least 1.1 s apart', async () => {
  const time = clock();
  const { calls, fetchImpl } = stubFetch(async (url) =>
    json(url.includes('polygon_geojson') ? [row({ category: 'boundary', type: 'administrative', addresstype: 'city', name: 'Austin' })] : []),
  );
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time });
  const search = createNominatimSearchProvider({ gate });
  const outline = createNominatimOutlineProvider({ gate });
  await Promise.all([
    search('austin', null),
    outline({ query: 'Austin', kind: 'city' }),
    search('dallas', null),
  ]);
  assert.equal(calls.length, 3);
  // The first starts at once; each later one waits out the full spacing.
  assert.deepEqual(time.sleeps, [1100, 1100]);
  assert.equal(gate.stats().usedToday, 3, 'one daily count for both kinds');
});

test('the daily cap stops public requests and is shared by search and outlines', async () => {
  const time = clock();
  const { calls, fetchImpl } = stubFetch(async () => json([]));
  const gate = createNominatimGate({
    settings: { ...PUBLIC, dailyCap: 2 },
    fetchImpl,
    ...time,
  });
  const search = createNominatimSearchProvider({ gate });
  const outline = createNominatimOutlineProvider({ gate });
  await search('one', null);
  await outline({ query: 'two', kind: 'landmark' });
  await assert.rejects(search('three', null), { code: 'NOMINATIM_DAILY_CAP' });
  await assert.rejects(outline({ query: 'four', kind: 'city' }), {
    code: 'NOMINATIM_DAILY_CAP',
  });
  assert.equal(calls.length, 2);
  // Cached answers still work after the cap.
  assert.equal((await search('one', null)).cached, true);
  // A new UTC day restores the allowance.
  time.advance(86_400_000);
  await search('five', null);
  assert.equal(calls.length, 3);
});

test('an operator endpoint is not subject to the public cap or spacing', async () => {
  const time = clock();
  const { calls, fetchImpl } = stubFetch(async () => json([]));
  const gate = createNominatimGate({
    settings: { ...OPERATOR, dailyCap: 1 },
    fetchImpl,
    ...time,
  });
  const search = createNominatimSearchProvider({ gate });
  await Promise.all([search('a', null), search('b', null), search('c', null)]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => url.startsWith('https://geo.example.test/search?')));
  assert.deepEqual(time.sleeps, []);
});

test('a disabled endpoint sends nothing', async () => {
  const { calls, fetchImpl } = stubFetch(async () => json([]));
  const gate = createNominatimGate({
    settings: { endpoint: null, isPublic: false, dailyCap: 50 },
    fetchImpl,
  });
  await assert.rejects(createNominatimSearchProvider({ gate })('x', null), {
    code: 'NOMINATIM_DISABLED',
  });
  assert.equal(calls.length, 0);
});

test('429 with Retry-After pauses the gate and stops queued requests', async () => {
  const time = clock();
  const { calls, fetchImpl } = stubFetch(async (_url, _o, n) =>
    n === 1
      ? new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } })
      : json([]),
  );
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time });
  const search = createNominatimSearchProvider({ gate });
  const [first, queued] = await Promise.allSettled([
    search('first', null),
    search('queued', null),
  ]);
  assert.equal(first.reason.code, 'NOMINATIM_REFUSED');
  assert.equal(first.reason.retryAfterMs, 120_000);
  assert.equal(queued.reason.code, 'NOMINATIM_PAUSED', 'the queued request is not sent');
  assert.equal(calls.length, 1);
  await assert.rejects(search('later', null), { code: 'NOMINATIM_PAUSED' });
  assert.equal(calls.length, 1);
  time.advance(121_000);
  await search('after', null);
  assert.equal(calls.length, 2, 'requests resume once the pause has passed');
  // The refusal was not remembered as "no such place".
  await search('first', null);
  assert.equal(calls.length, 3);
});

test('an outage stops queued requests; a server error is never cached as not found', async () => {
  const time = clock();
  let down = true;
  const { calls, fetchImpl } = stubFetch(async () =>
    down ? new Response('bad gateway', { status: 502 }) : json([row({ category: 'leisure', type: 'park', name: 'Zilker Park' })]),
  );
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time });
  const outline = createNominatimOutlineProvider({ gate });
  const results = await Promise.allSettled([
    outline({ query: 'Zilker Park', kind: 'landmark' }),
    outline({ query: 'Barton Springs', kind: 'landmark' }),
  ]);
  assert.equal(results[0].reason.code, 'NOMINATIM_UPSTREAM');
  assert.equal(results[1].reason.code, 'NOMINATIM_PAUSED');
  assert.equal(calls.length, 1);
  down = false;
  time.advance(31_000);
  const answer = await outline({ query: 'Zilker Park', kind: 'landmark' });
  assert.equal(answer.status, 'OK');
  assert.equal(calls.length, 2);
});

test('a transport failure is retried once, then pauses and is not cached', async () => {
  const time = clock();
  let failures = 1;
  const { calls, fetchImpl } = stubFetch(async () => {
    if (failures-- > 0) throw new TypeError('fetch failed');
    return json([]);
  });
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time });
  const search = createNominatimSearchProvider({ gate });
  assert.equal((await search('retry', null)).status, 'ZERO_RESULTS');
  assert.equal(calls.length, 2, 'one retry after a transport failure');

  failures = 2;
  await assert.rejects(search('twice', null), { code: 'NOMINATIM_TRANSPORT' });
  assert.equal(calls.length, 4, 'never more than one retry');
  await assert.rejects(search('twice', null), { code: 'NOMINATIM_PAUSED' });
  time.advance(31_000);
  assert.equal((await search('twice', null)).cached, undefined, 'the failure was not cached');
  assert.equal(calls.length, 5);
});

test('a 403 block pauses for an hour', async () => {
  const time = clock();
  const { fetchImpl } = stubFetch(async () => new Response('', { status: 403 }));
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time });
  await assert.rejects(createNominatimSearchProvider({ gate })('x', null), {
    code: 'NOMINATIM_REFUSED',
  });
  assert.ok(gate.stats().pausedForMs >= 3_599_000);
});

test('the queue is bounded', async () => {
  const time = clock();
  const { fetchImpl } = stubFetch(async () => json([]));
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time, maxPending: 2 });
  const search = createNominatimSearchProvider({ gate });
  const results = await Promise.allSettled(
    ['a', 'b', 'c', 'd'].map((q) => search(q, null)),
  );
  assert.deepEqual(
    results.map((r) => r.status === 'fulfilled' || r.reason.code),
    [true, true, 'NOMINATIM_QUEUE_FULL', 'NOMINATIM_QUEUE_FULL'],
  );
});

test('the daily count survives a restart when persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-nominatim-usage-'));
  const file = path.join(dir, 'usage.json');
  createUsageStore({ file }).increment('2026-09-28');
  createUsageStore({ file }).increment('2026-09-28');
  assert.equal(createUsageStore({ file }).count('2026-09-28'), 2);
  assert.equal(createUsageStore({ file }).count('2026-09-29'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- caches

test('cache lifetimes: 90 days for outlines, 30 for places, 24 hours for no result', async () => {
  const time = clock();
  const cache = createNominatimCache({ now: time.now });
  await cache.set('o', 1, NOMINATIM_CACHE_TTL_MS.outline);
  await cache.set('p', 2, NOMINATIM_CACHE_TTL_MS.place);
  await cache.set('n', 3, NOMINATIM_CACHE_TTL_MS.notFound);
  time.advance(23 * 3_600_000);
  assert.ok(await cache.get('n'));
  time.advance(2 * 3_600_000);
  assert.equal(await cache.get('n'), null);
  time.advance(28 * 86_400_000);
  assert.ok(await cache.get('p'));
  time.advance(2 * 86_400_000);
  assert.equal(await cache.get('p'), null);
  assert.ok(await cache.get('o'));
  time.advance(60 * 86_400_000);
  assert.equal(await cache.get('o'), null);
});

test('the disk cache survives a restart and stays within its bounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-nominatim-cache-'));
  const time = clock();
  const first = createNominatimCache({ dir, now: time.now, maxDiskEntries: 3, sweepEvery: 1000 });
  for (let i = 0; i < 5; i++) {
    time.advance(1000);
    await first.set(`k${i}`, { i }, i === 0 ? 10 : NOMINATIM_CACHE_TTL_MS.outline);
  }
  const second = createNominatimCache({ dir, now: time.now, maxDiskEntries: 3 });
  assert.deepEqual((await second.get('k4')).payload, { i: 4 });
  await second.sweep();
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 3, 'expired entry removed, then oldest trimmed');
  assert.equal(await createNominatimCache({ dir, now: time.now }).get('k0'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('names are normalized Unicode-aware so small differences share an entry', () => {
  assert.equal(normalizePlaceName('São Paulo'), normalizePlaceName('SAO  paulo!'));
  assert.equal(normalizePlaceName('The Pentagon'), 'pentagon');
  assert.equal(normalizePlaceName('Zürich'), 'zurich');
  assert.equal(normalizePlaceName('東京都'), '東京都', 'non-Latin names survive');
  assert.equal(normalizePlaceName('Ｃｅｎｔｒａｌ　Ｐａｒｋ'), 'central park');
});

test('small view changes reuse one cached outline', async () => {
  const time = clock();
  const { calls, fetchImpl } = stubFetch(async () =>
    json([row({ category: 'leisure', type: 'park', name: 'Central Park' })]),
  );
  const gate = createNominatimGate({ settings: PUBLIC, fetchImpl, ...time });
  const outline = createNominatimOutlineProvider({ gate });
  await outline({ query: 'Central Park', kind: 'landmark', lat: 40.781, lon: -73.966 });
  const again = await outline({ query: ' Central  Park ', kind: 'landmark', lat: 40.7822, lon: -73.9651 });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /viewbox=/);
  assert.equal(outlineBias('city', 48.85, 2.35).key, '49,2');
  assert.equal(outlineBias('landmark', 30.2747, -97.7404).key, '30.25,-97.75');
});

// ---------------------------------------------------------------- selection

test('wrong types are rejected: charging station for Mission District, station for Bandra', () => {
  const charging = row({
    category: 'amenity',
    type: 'charging_station',
    name: 'Revel - Mission District',
  });
  for (const kind of ['neighborhood', 'landmark', 'city'])
    assert.equal(
      selectOutlineResult([charging], { kind, query: 'Mission District, San Francisco' }).outline,
      null,
      kind,
    );
  const station = row({ category: 'railway', type: 'station', name: 'Bandra' });
  for (const kind of ['neighborhood', 'landmark', 'building', 'city'])
    assert.equal(selectOutlineResult([station], { kind, query: 'Bandra' }).outline, null, kind);
  assert.equal(acceptsOutlineClass('landmark', 'highway', 'primary'), false);
  assert.equal(acceptsOutlineClass('city', 'leisure', 'park'), false);
  assert.equal(acceptsOutlineClass('landmark', 'office', 'government'), true);
  assert.equal(acceptsOutlineClass('landmark', 'man_made', 'tower'), true);
  assert.equal(acceptsOutlineClass('landmark', 'water', 'reservoir'), true);
});

test('the first polygon-bearing result of the right class is taken (Mumbai)', () => {
  const node = row({
    category: 'place',
    type: 'city',
    name: 'Mumbai',
    geojson: { type: 'Point', coordinates: [72.8, 19.0] },
  });
  const wrong = row({ category: 'railway', type: 'station', name: 'Mumbai Central' });
  const boundary = row({
    category: 'boundary',
    type: 'administrative', addresstype: 'city',
    name: 'Mumbai',
    osm_id: 7888990,
    geojson: {
      type: 'MultiPolygon',
      coordinates: [square(72.8, 19.0, 0.01), square(72.9, 19.1, 0.2)],
    },
  });
  const { outline, skipped } = selectOutlineResult([node, wrong, boundary], {
    kind: 'city',
    query: 'Mumbai',
  });
  assert.equal(outline.osm, 'relation/7888990');
  assert.equal(outline.polygons.length, 2);
  assert.equal(outline.polygons[0][0][1][0], 72.9 + 0.2, 'largest part first');
  assert.deepEqual(skipped, ['place=city: no polygon', 'railway=station: wrong type']);
});

test('a result whose name does not answer the ask is passed over', () => {
  const other = row({ category: 'leisure', type: 'park', name: 'Pease Park' });
  assert.equal(selectOutlineResult([other], { kind: 'landmark', query: 'Zilker Park' }).outline, null);
  const english = row({
    category: 'boundary',
    type: 'administrative', addresstype: 'city',
    name: '東京都',
    namedetails: { name: '東京都', 'name:en': 'Tokyo' },
  });
  assert.ok(selectOutlineResult([english], { kind: 'city', query: 'Tokyo' }).outline);
  const capitol = row({ category: 'office', type: 'government', name: 'Texas State Capitol' });
  assert.ok(selectOutlineResult([capitol], { kind: 'landmark', query: 'Texas Capitol' }).outline);
});

test('outlines are held to a vertex cap', () => {
  const ring = [];
  for (let i = 0; i < 20_000; i++) {
    const a = (i / 20_000) * Math.PI * 2;
    ring.push([Math.cos(a) + Math.sin(a * 40) * 0.001, Math.sin(a)]);
  }
  ring.push([...ring[0]]);
  const capped = capOutlineVertices([[ring]], 6000);
  const total = capped.flat().reduce((n, r) => n + r.length, 0);
  assert.ok(total <= 6000, `${total} vertices`);
  const first = capped[0][0];
  assert.deepEqual(first[0], first.at(-1), 'rings stay closed');
});

// ---------------------------------------------------------------- the route

function mount(options) {
  let handler;
  geocodeProxy(options).configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  return (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const res = {
        writableEnded: false,
        on() {},
        writeHead(status, sent) {
          res.status = status;
          res.headers = sent;
        },
        end(body) {
          res.writableEnded = true;
          resolve({ status: res.status, headers: res.headers, body: JSON.parse(body) });
        },
      };
      Promise.resolve(
        handler(
          { method: 'GET', url, headers, socket: { remoteAddress: `10.1.${Math.random()}` }, on() {} },
          res,
          () => resolve({ status: 'next' }),
        ),
      ).catch(reject);
    });
}

test('the outline route answers OK with polygons and validates its input', async () => {
  const time = clock();
  const { calls, fetchImpl } = stubFetch(async () =>
    json([row({ category: 'boundary', type: 'administrative', addresstype: 'city', name: 'Paris' })]),
  );
  const request = mount({ gate: createNominatimGate({ settings: PUBLIC, fetchImpl, ...time }) });
  const ok = await request('/outline?q=Paris&kind=city&lat=48.85&lon=2.35');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'OK');
  assert.equal(ok.body.outline.polygons[0][0].length, 5);
  assert.match(calls[0], /polygon_geojson=1/);
  assert.match(calls[0], /polygon_threshold=0\.0005/);
  assert.match(calls[0], /limit=3/);
  for (const bad of ['/outline?q=Paris', '/outline?kind=city', '/outline?q=Paris&kind=planet'])
    assert.equal((await request(bad)).status, 400, bad);
  const cross = await request('/outline?q=Paris&kind=city', { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.equal(calls.length, 1);
  assert.equal((await request('/elsewhere')).status, 'next');
});

test('the outline route reports disabled and capped as permanent, busy as retryable', async () => {
  const disabled = mount({
    gate: createNominatimGate({ settings: { endpoint: null, isPublic: false, dailyCap: 50 } }),
  });
  const off = await disabled('/outline?q=Paris&kind=city');
  assert.equal(off.status, 503);
  assert.equal(off.body.code, 'NOMINATIM_DISABLED');
  assert.equal(off.body.retryable, false);

  const capped = mount({
    gate: createNominatimGate({ settings: { ...PUBLIC, dailyCap: 0 } }),
  });
  const cap = await capped('/outline?q=Paris&kind=city');
  assert.equal(cap.status, 429);
  assert.equal(cap.body.retryable, false);

  const time = clock();
  const paused = createNominatimGate({
    settings: PUBLIC,
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '90' } }),
    ...time,
  });
  const busy = mount({ gate: paused });
  const refused = await busy('/outline?q=Paris&kind=city');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers['Retry-After'], '90');
});
