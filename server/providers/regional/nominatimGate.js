import fs from 'node:fs';
import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';

/**
 * One gate for every request this server sends to a Nominatim instance.
 *
 * Place search and voice outlines share it, so the public instance sees one
 * application: one request at a time, at least 1.1 s apart, a short queue, a
 * daily ceiling per install, and a pause after the server says to stop.
 */

/** The public instance. Only this host is subject to the public-use limits. */
export const PUBLIC_NOMINATIM_SEARCH =
  'https://nominatim.openstreetmap.org/search';

const PUBLIC_NOMINATIM_HOST = 'nominatim.openstreetmap.org';

/**
 * The public usage policy asks for a User-Agent or Referer that identifies the
 * application. The identity is stable: it is never rotated or varied.
 */
export const NOMINATIM_HEADERS = Object.freeze({
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
  Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
});

/** Absolute policy maximum is one request per second; 1.1 s absorbs jitter. */
export const NOMINATIM_MIN_SPACING_MS = 1100;

/** Requests allowed to wait for their turn; past this, refuse at once. */
export const NOMINATIM_MAX_PENDING = 4;

/** A queued request older than this has no reader left; drop it unsent. */
export const NOMINATIM_MAX_WAIT_MS = 10_000;

/** Default public requests per install per UTC day, outlines and search together. */
export const NOMINATIM_DEFAULT_DAILY_CAP = 50;

/**
 * Pause after a refusal without Retry-After. A Retry-After from the server is
 * honoured in full, however long: no local maximum may cause an earlier retry.
 */
const DEFAULT_BACKOFF_MS = 60_000;
/** A 403 from the public instance means this identity is blocked: stop longer. */
const BLOCKED_BACKOFF_MS = 3_600_000;
/** Pause after a server error or a failed retry. */
const OUTAGE_BACKOFF_MS = 30_000;

const DISABLED_VALUES = new Set(['', 'off', 'none', 'disabled', '0']);

/**
 * Read the search endpoint setting.
 *
 * Unset means the public instance under its guards. Set to empty (or `off`)
 * disables every Nominatim request. Any other value must be an http(s) URL
 * without credentials, query or fragment; a bare host gets `/search`. A value
 * that is not usable disables the service rather than falling back to the
 * public instance.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{endpoint: string|null, isPublic: boolean, dailyCap: number, invalid?: boolean}}
 */
export function resolveNominatimSettings(env = process.env) {
  const dailyCap = parseDailyCap(env.NOMINATIM_DAILY_CAP);
  const raw = env.NOMINATIM_URL;
  if (raw === undefined)
    return { endpoint: PUBLIC_NOMINATIM_SEARCH, isPublic: true, dailyCap };
  const value = String(raw).trim();
  if (DISABLED_VALUES.has(value.toLowerCase()))
    return { endpoint: null, isPublic: false, dailyCap };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { endpoint: null, isPublic: false, dailyCap, invalid: true };
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return { endpoint: null, isPublic: false, dailyCap, invalid: true };
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/search';
  return {
    endpoint: url.href.replace(/\/$/, ''),
    // A trailing DNS dot names the same host.
    isPublic:
      url.hostname.toLowerCase().replace(/\.$/, '') === PUBLIC_NOMINATIM_HOST,
    dailyCap,
  };
}

function parseDailyCap(raw) {
  if (raw === undefined || String(raw).trim() === '')
    return NOMINATIM_DEFAULT_DAILY_CAP;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : NOMINATIM_DEFAULT_DAILY_CAP;
}

function gateError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Seconds or an HTTP date → milliseconds from now, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** UTC calendar day, the unit of the daily cap. */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Public-service state shared by every process using the same file: today's
 * request count and any pause the server asked for.
 *
 * Every change is a read-modify-write under an exclusive lock directory, and
 * the file is replaced atomically, so two dev servers sharing a checkout add
 * to one count instead of overwriting each other. Memory keeps the highest
 * values this process has seen, so a failed or unreadable file never lowers
 * the count or shortens a pause; a persistence failure is reported once and
 * in `status()`.
 */
export function createGateStateStore({
  file = null,
  lockStaleMs = 5000,
  lockWaitMs = 500,
  onError = (error) =>
    console.warn(
      `[Nominatim] could not persist usage state: ${error?.message || error}`,
    ),
} = {}) {
  let memory = { day: '', count: 0, pausedUntil: 0 };
  let lastError = null;

  const report = (error) => {
    if (!lastError) onError(error);
    lastError = error;
  };

  const merge = (a, b) => ({
    day: a.day >= b.day ? a.day : b.day,
    count:
      a.day === b.day
        ? Math.max(a.count, b.count)
        : a.day > b.day
          ? a.count
          : b.count,
    pausedUntil: Math.max(a.pausedUntil || 0, b.pausedUntil || 0),
  });

  function readDisk() {
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        day: typeof parsed?.day === 'string' ? parsed.day : '',
        count: Number.isFinite(parsed?.count) ? Math.max(0, parsed.count) : 0,
        pausedUntil: Number.isFinite(parsed?.pausedUntil)
          ? parsed.pausedUntil
          : 0,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') report(error);
      return null;
    }
  }

  function current() {
    const disk = readDisk();
    if (disk) memory = merge(memory, disk);
    return memory;
  }

  function withLock(work) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + lockWaitMs;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > lockStaleMs)
            fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          // Another process released it meanwhile.
        }
        if (Date.now() > deadline)
          throw new Error('usage state is locked by another process');
        sleepSync(5);
      }
    }
    try {
      return work();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  /** Apply `change` to the freshest state and persist it atomically. */
  function update(change) {
    if (!file) {
      memory = merge(memory, change(memory));
      return memory;
    }
    try {
      withLock(() => {
        const next = merge(memory, change(current()));
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(next));
        fs.renameSync(temp, file);
        memory = next;
        lastError = null;
      });
    } catch (error) {
      report(error);
      memory = merge(memory, change(memory));
    }
    return memory;
  }

  return {
    count(day) {
      const state = current();
      return state.day === day ? state.count : 0;
    },
    increment(day) {
      return update((state) => ({
        day,
        count: state.day === day ? state.count + 1 : 1,
        pausedUntil: state.pausedUntil,
      })).count;
    },
    pausedUntil() {
      return current().pausedUntil || 0;
    },
    pauseUntil(at) {
      update((state) => ({ ...state, pausedUntil: at }));
    },
    status: () => ({
      file,
      persisted: Boolean(file) && !lastError,
      error: lastError ? String(lastError.message || lastError) : null,
    }),
  };
}

/** Compatibility name for the state store. */
export const createUsageStore = createGateStateStore;

/**
 * Construct a gate. `settings` may be a function so the environment is read
 * after the dev server loads `.env`.
 *
 * @param {object} [options]
 * @param {(() => object)|object} [options.settings]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {ReturnType<typeof createUsageStore>} [options.usage]
 */
export function createNominatimGate({
  settings = () => resolveNominatimSettings(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  usage = createGateStateStore(),
  minSpacingMs = NOMINATIM_MIN_SPACING_MS,
  maxPending = NOMINATIM_MAX_PENDING,
  maxWaitMs = NOMINATIM_MAX_WAIT_MS,
  timeoutMs = 9000,
} = {}) {
  let queue = Promise.resolve();
  let lastStartedAt = -Infinity;
  let pending = 0;
  let pausedUntil = 0;
  let upstreamRequests = 0;
  let usageStore = usage;

  const current = () =>
    typeof settings === 'function' ? settings() : settings;

  /**
   * Pause until `ms` from now. The public service's pause is also written to
   * the shared state so a restart or a second process honours it.
   */
  function pause(ms, config) {
    const until = now() + Math.max(0, ms);
    if (until > pausedUntil) pausedUntil = until;
    if (config?.isPublic) usageStore.pauseUntil(pausedUntil);
  }

  function pauseEnd(config) {
    return config?.isPublic
      ? Math.max(pausedUntil, usageStore.pausedUntil())
      : pausedUntil;
  }

  function pausedError(config) {
    return gateError('NOMINATIM_PAUSED', 'Place service is pausing', {
      retryAfterMs: Math.max(0, pauseEnd(config) - now()),
    });
  }

  function admissionError(config) {
    if (!config.endpoint)
      return gateError('NOMINATIM_DISABLED', 'Place service is not configured');
    if (now() < pauseEnd(config)) return pausedError(config);
    if (config.isPublic && usageStore.count(utcDay(now())) >= config.dailyCap)
      return gateError(
        'NOMINATIM_DAILY_CAP',
        'Daily place lookup allowance is used',
      );
    return null;
  }

  /** One upstream request; classifies refusals and pauses the gate. */
  async function send(url, config, maxBytes, signal) {
    if (config.isPublic) usageStore.increment(utcDay(now()));
    upstreamRequests += 1;
    lastStartedAt = now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // One deadline covers the headers AND the body: a server that answers its
    // headers and then stalls must not hold the shared queue.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await exchange(url, config, maxBytes, signal, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function exchange(url, config, maxBytes, signal, requestSignal) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: NOMINATIM_HEADERS,
        redirect: 'error',
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw gateError('NOMINATIM_ABANDONED', 'Abandoned');
      throw gateError('NOMINATIM_TRANSPORT', 'Place service unreachable', {
        cause,
        transport: true,
      });
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      const status = response.status;
      const retryAfter = parseRetryAfter(
        response.headers?.get?.('retry-after'),
        now(),
      );
      if (status === 429 || status === 503) {
        pause(retryAfter ?? DEFAULT_BACKOFF_MS, config);
        throw gateError('NOMINATIM_REFUSED', 'Place service asked to wait', {
          status,
          retryAfterMs: Math.max(0, pauseEnd(config) - now()),
        });
      }
      if (status === 403 || status === 418) {
        pause(retryAfter ?? BLOCKED_BACKOFF_MS, config);
        throw gateError('NOMINATIM_REFUSED', 'Place service refused', {
          status,
          retryAfterMs: Math.max(0, pauseEnd(config) - now()),
        });
      }
      if (status >= 500) pause(retryAfter ?? OUTAGE_BACKOFF_MS, config);
      throw gateError('NOMINATIM_UPSTREAM', `Upstream returned ${status}`, {
        status,
      });
    }
    try {
      return await readResponseJsonCapped(response, maxBytes, requestSignal);
    } catch (cause) {
      if (cause?.code === 'RESPONSE_TOO_LARGE')
        throw gateError('NOMINATIM_TOO_LARGE', 'Place answer too large');
      if (signal?.aborted) throw gateError('NOMINATIM_ABANDONED', 'Abandoned');
      throw gateError('NOMINATIM_TRANSPORT', 'Place answer unreadable', {
        cause,
        transport: true,
      });
    }
  }

  /** Wait for the spacing slot, then check the request is still wanted. */
  async function takeTurn(config, queuedAt, signal) {
    const spacing = config.isPublic ? minSpacingMs : 0;
    const waitMs = Math.max(0, spacing - (now() - lastStartedAt));
    if (waitMs) await sleep(waitMs);
    if (signal?.aborted || now() - queuedAt > maxWaitMs)
      throw gateError('NOMINATIM_ABANDONED', 'Place search was abandoned');
    // An outage or refusal that happened while this waited stops it here.
    const refused = admissionError(config);
    if (refused) throw refused;
  }

  /**
   * Queue one JSON request for `buildUrl(endpoint)`. At most one retry, and
   * only after a transport failure; a failed retry pauses the gate.
   *
   * @param {(endpoint: string) => string} buildUrl
   * @param {{signal?: AbortSignal, maxBytes?: number}} [options]
   */
  function requestJson(buildUrl, { signal, maxBytes = 2 * 1024 * 1024 } = {}) {
    const config = current();
    const refused = admissionError(config);
    if (refused) return Promise.reject(refused);
    if (signal?.aborted)
      return Promise.reject(
        gateError('NOMINATIM_ABANDONED', 'Place search was abandoned'),
      );
    if (pending >= maxPending)
      return Promise.reject(
        gateError('NOMINATIM_QUEUE_FULL', 'Place search queue is full'),
      );
    pending += 1;
    const queuedAt = now();
    const url = buildUrl(config.endpoint);
    const task = queue.then(async () => {
      try {
        await takeTurn(config, queuedAt, signal);
        try {
          return await send(url, config, maxBytes, signal);
        } catch (error) {
          if (!error?.transport) throw error;
          await takeTurn(config, now(), signal);
          try {
            return await send(url, config, maxBytes, signal);
          } catch (retryError) {
            if (retryError?.transport) pause(OUTAGE_BACKOFF_MS, config);
            throw retryError;
          }
        }
      } finally {
        pending -= 1;
      }
    });
    queue = task.catch(() => null);
    return task;
  }

  return {
    requestJson,
    settings: current,
    /** Share the daily count and pause through a file (composition chooses it). */
    persistUsage(file) {
      usageStore = createGateStateStore({ file });
    },
    stats: () => ({
      upstreamRequests,
      pending,
      pausedForMs: Math.max(0, pauseEnd(current()) - now()),
      usedToday: usageStore.count(utcDay(now())),
      persistence: usageStore.status?.() || null,
    }),
  };
}

let sharedGate = createNominatimGate();

/** The process-wide gate: search and outlines share one budget and pacer. */
export function sharedNominatimGate() {
  return sharedGate;
}

/** Replace the process-wide gate (tests, embedders with their own transport). */
export function setSharedNominatimGate(gate) {
  sharedGate = gate || createNominatimGate();
  return sharedGate;
}

/** Codes that mean "not now" rather than "no such place". */
export function isNominatimBusy(error) {
  return [
    'NOMINATIM_QUEUE_FULL',
    'NOMINATIM_ABANDONED',
    'NOMINATIM_PAUSED',
    'NOMINATIM_REFUSED',
    'NOMINATIM_DAILY_CAP',
  ].includes(error?.code);
}
