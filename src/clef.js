import { THRESHOLDS } from './config.js';

const ENDPOINT = 'https://api.nan.builders/v1/systemone';

/**
 * The messages stay in Spanish because they can reach the owner unchanged.
 * They never include the API key, a request body, response headers or the
 * upstream body: an error is data, not a transcript of the request (S19).
 */
export const CLEF_ERROR_MESSAGES = {
  clef_busy: 'Clef está ocupado. Probá de nuevo en unos segundos.',
  clef_unavailable: 'Clef no está disponible ahora. Probá de nuevo en un momento.',
  clef_no_access: 'La key de NaN no tiene acceso al modelo Clef.',
  clef_failed: 'Clef devolvió un error inesperado.',
};

/** A Clef failure the Worker can translate into a friendly response. */
export class ClefError extends Error {
  /**
   * @param {'clef_busy'|'clef_unavailable'|'clef_no_access'|'clef_failed'} code
   * @param {number} status upstream HTTP status, or 0 when the request never got one
   */
  constructor(code, status = 0) {
    super(CLEF_ERROR_MESSAGES[code] ?? CLEF_ERROR_MESSAGES.clef_failed);
    this.name = 'ClefError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Fail closed: Clef's answers are data, never defaults. A missing or
 * non-numeric field is a malformed upstream response, not a zero — the
 * decision rules refuse to decide on one instead of inventing a route from
 * an omission. Every violation throws ClefError('clef_failed'), which the
 * Worker maps to the same friendly 502 as any other upstream failure.
 *
 * @param {Record<string, any>} answers the Clef `answers` map
 * @param {Record<string, { numbers?: string[], strings?: string[], numberMaps?: string[] }>} shape
 *   per question id: the numeric fields, non-empty string fields and
 *   object-of-finite-numbers fields the rules are about to consume
 */
export function requireAnswerShape(answers, shape) {
  for (const [id, spec] of Object.entries(shape)) {
    const answer = answers?.[id];
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      throw new ClefError('clef_failed');
    }
    for (const field of spec.strings ?? []) {
      if (typeof answer[field] !== 'string' || answer[field] === '') {
        throw new ClefError('clef_failed');
      }
    }
    for (const field of spec.numbers ?? []) {
      if (typeof answer[field] !== 'number' || !Number.isFinite(answer[field])) {
        throw new ClefError('clef_failed');
      }
    }
    for (const field of spec.numberMaps ?? []) {
      const map = answer[field];
      if (typeof map !== 'object' || map === null || Array.isArray(map)) {
        throw new ClefError('clef_failed');
      }
      for (const value of Object.values(map)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new ClefError('clef_failed');
        }
      }
    }
  }
  return answers;
}

/**
 * Same fail-closed rule for individual keys inside a probability map: a
 * missing `guardia` must not read as a 0 % that silences the trigger.
 * @param {Record<string, any>} map
 * @param {string[]} keys
 */
export function requireNumberKeys(map, keys) {
  for (const key of keys) {
    const value = map?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ClefError('clef_failed');
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads a JSON body, returning null instead of throwing when it is not JSON.
 * @param {Response} response
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Builds a client for the NaN systemone endpoint.
 *
 * Clef allows a single request in flight per key, so every call is appended to
 * one promise chain: request n+1 starts only after request n settled (S20).
 * A failed call never poisons the queue for the calls behind it.
 *
 * @param {{
 *   key: string,
 *   fetchImpl?: typeof fetch,
 *   thresholds?: Record<string, number>,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} options
 */
export function createClefClient({
  key,
  fetchImpl = fetch,
  thresholds = THRESHOLDS.limits,
  sleep = defaultSleep,
}) {
  let queue = Promise.resolve();

  /**
   * Sends one request. Only the status code is inspected, so no upstream text
   * can end up in a thrown error.
   */
  async function sendOnce(state, questions) {
    try {
      return await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'clef', state, questions }),
        // A fresh signal per attempt, so a retry gets its own 50 s budget.
        signal: AbortSignal.timeout(thresholds.clefTimeoutMs),
      });
    } catch {
      // Network failure, DNS failure or the aborted timeout signal.
      throw new ClefError('clef_unavailable', 0);
    }
  }

  /** One exchange with Clef, including the single 429 retry. */
  async function askClef(state, questions) {
    let retriesLeft = thresholds.retries;

    for (;;) {
      const response = await sendOnce(state, questions);
      const status = response.status;

      if (status === 429) {
        if (retriesLeft > 0) {
          retriesLeft -= 1;
          await sleep(thresholds.retryDelayMs);
          continue;
        }
        throw new ClefError('clef_busy', status);
      }

      if (status === 502 || status === 504) {
        throw new ClefError('clef_unavailable', status);
      }

      if (status === 404) {
        const body = await readJson(response);
        // The current key has a valid credential but no access to `clef`.
        if (body?.error?.code === 'model_not_found') throw new ClefError('clef_no_access', status);
        throw new ClefError('clef_failed', status);
      }

      if (!response.ok) throw new ClefError('clef_failed', status);

      const body = await readJson(response);
      // A 2xx without answers is not a decision, so it is not trusted.
      if (body === null || typeof body !== 'object' || body.answers === undefined) {
        throw new ClefError('clef_failed', status);
      }
      return body;
    }
  }

  /**
   * Asks Clef the questions about the current state.
   * @param {string} state neutral Spanish description of the case
   * @param {Array<Record<string, unknown>>} questions
   * @returns {Promise<{ answers: Record<string, any> }>}
   */
  function ask(state, questions) {
    const run = queue.then(() => askClef(state, questions));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { ask };
}
