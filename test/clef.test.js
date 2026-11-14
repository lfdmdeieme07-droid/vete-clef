import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClefError, createClefClient } from '../src/clef.js';
import { THRESHOLDS } from '../src/config.js';
import worker, {
  FOLLOWUP_QUESTIONS,
  TRIAGE_QUESTIONS,
  buildFollowupState,
  buildTriageState,
  clefErrorResponse,
  validateFollowupInput,
  validateTriageInput,
} from '../src/worker.js';

// A distinctive key: every assertion below checks it never travels with an error.
const KEY = 'sk-test-DO-NOT-LEAK-1234';
const STATE = 'Especie: perro. Edad: 45 días. Mensaje del dueño: «vomitó dos veces».';
const QUESTIONS = [
  { id: 'emergency', type: 'noul', instructions: 'Does this pet need help right now?' },
];

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const okBody = { model: 'clef', answers: { emergency: { type: 'noul', noul: 0.1 } } };

/**
 * A fake fetch that records the order in which requests start and settle, and
 * how many were in flight at once.
 */
function fakeFetch(handler) {
  const calls = [];
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchImpl = async (url, options) => {
    const index = calls.length + 1;
    calls.push({ url, options, index });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log.push(`start:${index}`);
    try {
      return await handler(index, options);
    } finally {
      inFlight -= 1;
      log.push(`end:${index}`);
    }
  };

  return {
    fetchImpl,
    calls,
    log,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const clientWith = (options) => createClefClient({ key: KEY, ...options });

/** A sleep stand-in that never waits and records the delays it was asked for. */
function fakeSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

const rejects = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the promise to reject');
};

test('S20: a second ask starts only after the first one settles (one request in flight per key)', async () => {
  const fake = fakeFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jsonResponse(okBody);
  });
  const client = clientWith({ fetchImpl: fake.fetchImpl });

  const both = Promise.all([client.ask(STATE, QUESTIONS), client.ask(STATE, QUESTIONS)]);
  await both;

  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.log, ['start:1', 'end:1', 'start:2', 'end:2']);
  assert.equal(fake.maxInFlight, 1);
});

test('S20: a failed ask does not block the next one in the queue', async () => {
  const fake = fakeFetch(async (index) =>
    index === 1 ? jsonResponse({ error: { code: 'model_not_found' } }, 404) : jsonResponse(okBody),
  );
  const client = clientWith({ fetchImpl: fake.fetchImpl });

  const first = await rejects(client.ask(STATE, QUESTIONS));
  const second = await client.ask(STATE, QUESTIONS);

  assert.equal(first.code, 'clef_no_access');
  assert.deepEqual(second, okBody);
  assert.deepEqual(fake.log, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('the client queue serializes concurrent asks: never two calls in flight', async () => {
  // Dos dueños preguntando al mismo tiempo: la cola del cliente debe correrlas
  // una despues de la otra, porque Clef solo permite una peticion en vuelo.
  const fake = fakeFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return jsonResponse(okBody);
  });
  const client = clientWith({ fetchImpl: fake.fetchImpl });

  const [a, b] = await Promise.all([client.ask(STATE, QUESTIONS), client.ask(STATE, QUESTIONS)]);

  assert.deepEqual(a, okBody);
  assert.deepEqual(b, okBody);
  assert.equal(fake.maxInFlight, 1);
  assert.deepEqual(fake.log, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('S20: a 429 retries with jittered backoff and the retry resolves', async () => {
  const fake = fakeFetch(async (index) =>
    index === 1 ? jsonResponse({ error: { code: 'rate_limited' } }, 429) : jsonResponse(okBody),
  );
  const { sleep, delays } = fakeSleep();
  // rng fijo en 0: el jitter siempre cae en el minimo (1000 ms), determinista.
  const client = clientWith({ fetchImpl: fake.fetchImpl, sleep, rng: () => 0 });

  const result = await client.ask(STATE, QUESTIONS);

  assert.equal(fake.calls.length, 2);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(result, okBody);
});

test('S20: 429s past the retry budget throw clef_busy without another call', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 'rate_limited' } }, 429));
  const { sleep, delays } = fakeSleep();
  // rng en 1: cada espera es el maximo (3000 ms). Con presupuesto 5000 ms, la
  // primera espera cabe (3000), la segunda (3000+3000=6000) lo excede: no hay
  // tercera llamada.
  const client = clientWith({
    fetchImpl: fake.fetchImpl,
    sleep,
    rng: () => 1,
    thresholds: { retryBudgetMs: 5000 },
  });

  const error = await rejects(client.ask(STATE, QUESTIONS));

  assert.ok(error instanceof ClefError);
  assert.equal(error.code, 'clef_busy');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(delays, [3000]);
});

test('S20: 429 retries exactly maxRetries times inside the budget, then throws clef_busy', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 'rate_limited' } }, 429));
  const { sleep, delays } = fakeSleep();
  // rng en 0.5: espera de 2000 ms cada vez. Presupuesto por defecto 40000 ms:
  // 4 esperas (8000 ms) caben holgadas, y el maxRetries corta antes que el
  // presupuesto.
  const client = clientWith({ fetchImpl: fake.fetchImpl, sleep, rng: () => 0.5 });

  const error = await rejects(client.ask(STATE, QUESTIONS));

  assert.ok(error instanceof ClefError);
  assert.equal(error.code, 'clef_busy');
  assert.equal(fake.calls.length, 5); // 1 intento + 4 reintentos
  assert.deepEqual(delays, [2000, 2000, 2000, 2000]);
});

test('S20: a 400 response is never retried', async () => {
  const fake = fakeFetch(async () =>
    jsonResponse({ error: { code: 'invalid_request' } }, 400),
  );
  const { sleep, delays } = fakeSleep();
  const client = clientWith({ fetchImpl: fake.fetchImpl, sleep });

  const error = await rejects(client.ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_failed');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(delays, []);
});

test('S20: every 429 backoff delay stays within the 1-3 s window', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 'rate_limited' } }, 429));
  const { sleep, delays } = fakeSleep();
  const client = clientWith({ fetchImpl: fake.fetchImpl, sleep }); // rng real: Math.random

  await rejects(client.ask(STATE, QUESTIONS));

  assert.ok(delays.length > 0);
  for (const delay of delays) {
    assert.ok(delay >= 1000 && delay <= 3000, `delay ${delay} fuera de [1000, 3000]`);
  }
});

test('S18: the request carries the model, the state and the questions untouched', async () => {
  const fake = fakeFetch(async () => jsonResponse(okBody));
  const client = clientWith({ fetchImpl: fake.fetchImpl });
  const questions = JSON.parse(JSON.stringify(QUESTIONS));
  const snapshot = JSON.parse(JSON.stringify(QUESTIONS));

  await client.ask(STATE, questions);

  const [call] = fake.calls;
  assert.equal(call.url, 'https://api.nan.builders/v1/systemone');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.options.body), {
    model: 'clef',
    state: STATE,
    questions: QUESTIONS,
  });
  assert.deepEqual(questions, snapshot);
});

test('S20: the request carries an abort signal for the client timeout', async () => {
  const fake = fakeFetch(async () => jsonResponse(okBody));

  await clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS);

  assert.ok(fake.calls[0].options.signal instanceof AbortSignal);
});

test('S20: 404 model_not_found means the key has no access to the model', async () => {
  const fake = fakeFetch(async () =>
    jsonResponse({ error: { code: 'model_not_found', message: 'no such model' } }, 404),
  );

  const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_no_access');
  assert.equal(error.status, 404);
});

test('S20: 502 becomes clef_unavailable with the upstream status', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 'bad_gateway' } }, 502));

  const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_unavailable');
  assert.equal(error.status, 502);
});

test('S20: 504 becomes clef_unavailable with the upstream status', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 'timeout' } }, 504));

  const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_unavailable');
  assert.equal(error.status, 504);
});

test('S20: any other non-2xx status becomes clef_failed', async () => {
  const fake = fakeFetch(async () => jsonResponse({ error: { code: 'boom' } }, 500));

  const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_failed');
  assert.equal(error.status, 500);
});

test('S20: a 2xx body without answers is not trusted as a Clef decision', async () => {
  const fake = fakeFetch(async () => jsonResponse({ model: 'clef' }));

  const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_failed');
});

test('S20: a timeout or network error becomes clef_unavailable with status 0', async () => {
  const fake = fakeFetch(async () => {
    const aborted = new Error('The operation was aborted due to timeout');
    aborted.name = 'TimeoutError';
    throw aborted;
  });

  const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl }).ask(STATE, QUESTIONS));

  assert.equal(error.code, 'clef_unavailable');
  assert.equal(error.status, 0);
});

test('S19: no failure mode puts the key inside the thrown error', async () => {
  const failures = [
    async () => jsonResponse({ error: { code: 'rate_limited' } }, 429),
    async () => jsonResponse({ error: { code: 'model_not_found' } }, 404),
    // Even a server that echoes the credential back must not leak it.
    async () => jsonResponse({ error: { code: 'boom', message: `bad key ${KEY}` } }, 400),
    async () => {
      throw new TypeError(`network blew up near ${KEY}`);
    },
  ];

  for (const handler of failures) {
    const fake = fakeFetch(handler);
    const { sleep } = fakeSleep();
    const error = await rejects(clientWith({ fetchImpl: fake.fetchImpl, sleep }).ask(STATE, QUESTIONS));

    assert.ok(error instanceof ClefError);
    assert.ok(!String(error.message).includes(KEY), `message leaked the key for ${error.code}`);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    assert.ok(!serialized.includes(KEY), `error leaked the key for ${error.code}`);
  }
});

test('S3: the triage questions carry the exact ids, types, instructions and criteria', () => {
  assert.deepEqual(TRIAGE_QUESTIONS, [
    {
      id: 'emergency',
      type: 'noul',
      instructions:
        'Does this pet need emergency veterinary care right now, within the next hour?',
    },
    {
      id: 'service',
      type: 'choice',
      instructions: 'Which clinic service fits this request?',
      criteria: {
        consulta: 'sick or unwell pet that needs a vet exam',
        vacunacion: 'healthy pet due for vaccines or deworming',
        castracion: 'spay or neuter surgery request',
        peluqueria: 'bath or grooming for a healthy pet',
        control: 'checkup or follow-up of a known treatment',
      },
    },
    {
      id: 'timing',
      type: 'score',
      instructions: 'How soon should the vet see this pet?',
      criteria: ['More than a week can wait', 'This week', 'Within 48 hours', 'Today'],
    },
  ]);
});

test('S11: the follow-up questions carry the exact ids, types, instructions and criteria', () => {
  assert.deepEqual(FOLLOWUP_QUESTIONS, [
    {
      id: 'red_flags',
      type: 'noul',
      instructions:
        "Does today's report show any warning sign that needs urgent veterinary care (blood, not drinking, lethargy, repeated vomiting, seizures, possible poisoning, breathing trouble)?",
    },
    {
      id: 'worse',
      type: 'noul',
      instructions:
        'Compared with the plan and previous days, is the pet getting worse?',
    },
    {
      id: 'action',
      type: 'choice',
      instructions: 'What should the owner do today?',
      criteria: {
        seguir_plan: "keep following the vet's plan, the pet is stable or improving",
        consultar: 'call the vet within 24 hours, something is off but not urgent',
        guardia: 'go to the emergency vet now',
      },
    },
  ]);
});

test('S21: a body that is not JSON is rejected before anything else', () => {
  for (const body of [null, undefined, 'text', 42, ['perro']]) {
    assert.deepEqual(validateTriageInput(body), {
      ok: false,
      message: 'El cuerpo de la petición no es JSON válido.',
    });
  }
});

test('S21: a species outside perro/gato/otro is rejected', () => {
  for (const species of ['conejo', '', 'Perro sano', undefined]) {
    assert.deepEqual(validateTriageInput({ species, message: 'está raro' }), {
      ok: false,
      message: 'La especie debe ser perro, gato u otro.',
    });
  }
});

test('S21: a missing or blank message is rejected', () => {
  for (const message of ['', '   ', undefined, null]) {
    assert.deepEqual(validateTriageInput({ species: 'gato', message }), {
      ok: false,
      message: 'El mensaje del dueño es obligatorio.',
    });
  }
});

test('S21: triage input is trimmed and cut to maxFreeText characters', () => {
  const long = 'a'.repeat(THRESHOLDS.limits.maxFreeText + 25);

  const result = validateTriageInput({
    species: ' gato ',
    age: `  ${long}  `,
    message: `  ${long}  `,
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.species, 'gato');
  assert.equal(result.value.message.length, THRESHOLDS.limits.maxFreeText);
  assert.equal(result.value.age.length, THRESHOLDS.limits.maxFreeText);
  assert.ok(!result.value.message.includes(' '));
});

test('S21: a valid triage body keeps age as written', () => {
  assert.deepEqual(validateTriageInput({ species: 'perro', age: ' 45 días ', message: ' vomitó ' }), {
    ok: true,
    value: { species: 'perro', age: '45 días', message: 'vomitó' },
  });
});

test('S21: the triage state composes species, age and message', () => {
  assert.equal(
    buildTriageState({ species: 'perro', age: '45 días', message: 'vomitó dos veces hoy' }),
    'Especie: perro. Edad: 45 días. Mensaje del dueño: «vomitó dos veces hoy»',
  );
});

test('S21: the triage state skips the age when the owner gave none', () => {
  assert.equal(
    buildTriageState({ species: 'gato', age: '', message: 'no hace pis' }),
    'Especie: gato. Mensaje del dueño: «no hace pis»',
  );
});

test('S21: a follow-up body without a plan is rejected', () => {
  assert.deepEqual(validateFollowupInput({ day: 2, report: 'come poquito' }), {
    ok: false,
    message: 'El plan del veterinario es obligatorio.',
  });
});

test('S21: a follow-up body without a report is rejected', () => {
  assert.deepEqual(validateFollowupInput({ plan: 'arroz 3 días', day: 2, report: '  ' }), {
    ok: false,
    message: 'El reporte de hoy es obligatorio.',
  });
});

test('S21: the follow-up day must be an integer of at least 1', () => {
  for (const day of [0, -1, 1.5, '2', null, undefined]) {
    assert.deepEqual(validateFollowupInput({ plan: 'arroz 3 días', day, report: 'come mejor' }), {
      ok: false,
      message: 'El día debe ser un número entero mayor o igual a 1.',
    });
  }
});

test('S21: follow-up text is trimmed and cut to maxFreeText characters', () => {
  const long = 'b'.repeat(THRESHOLDS.limits.maxFreeText + 25);

  const result = validateFollowupInput({ plan: ` ${long} `, day: 3, report: ` ${long} ` });

  assert.equal(result.ok, true);
  assert.equal(result.value.day, 3);
  assert.equal(result.value.plan.length, THRESHOLDS.limits.maxFreeText);
  assert.equal(result.value.report.length, THRESHOLDS.limits.maxFreeText);
});

test('S21: the follow-up state composes plan, day and report', () => {
  assert.equal(
    buildFollowupState({ plan: 'arroz 3 días, después agregar alimento de a poco', day: 2, report: 'la caca está más firme' }),
    'Plan del veterinario: «arroz 3 días, después agregar alimento de a poco». Día 2. Reporte de hoy: «la caca está más firme»',
  );
});

test('S20: every clef error code maps to a friendly Spanish 502', () => {
  const expected = {
    clef_busy: 'Clef está ocupado. Probá de nuevo en unos segundos.',
    clef_unavailable: 'Clef no está disponible ahora. Probá de nuevo en un momento.',
    clef_no_access: 'La key de NaN no tiene acceso al modelo Clef.',
    clef_failed: 'Clef devolvió un error inesperado.',
  };

  for (const [code, message] of Object.entries(expected)) {
    assert.deepEqual(clefErrorResponse(new ClefError(code, 500)), {
      status: 502,
      body: { error: { code, message } },
    });
  }
});

test('S17: any other path is a JSON 404', async () => {
  for (const path of ['/api/otra-cosa', '/', '/api/triage/', '/constructor', '/toString']) {
    const response = await worker.fetch(new Request(`https://vete.test${path}`), {}, {});

    assert.equal(response.status, 404, `expected 404 for ${path}`);
    assert.deepEqual(await response.json(), { error: { code: 'not_found' } });
  }
});

test('S17: the endpoints only answer POST', async () => {
  await withoutNetwork(async (networkCalls) => {
    const response = await worker.fetch(new Request('https://vete.test/api/triage'), {}, {});

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'not_found' } });
    assert.equal(networkCalls(), 0);
  });
});

test('S21: an invalid triage request is a 400 and never reaches Clef', async () => {
  await withoutNetwork(async (networkCalls) => {
    const request = new Request('https://vete.test/api/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: 'conejo', message: 'está raro' }),
    });

    const response = await worker.fetch(request, { NAN_KEY: KEY }, {});

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: 'invalid_input', message: 'La especie debe ser perro, gato u otro.' },
    });
    assert.equal(networkCalls(), 0);
  });
});

test('S21: a triage body that is not JSON is a 400', async () => {
  await withoutNetwork(async (networkCalls) => {
    const request = new Request('https://vete.test/api/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'no soy json',
    });

    const response = await worker.fetch(request, { NAN_KEY: KEY }, {});

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_input');
    assert.equal(networkCalls(), 0);
  });
});

test('S21: an invalid follow-up request is a 400 and never reaches Clef', async () => {
  await withoutNetwork(async (networkCalls) => {
    const request = new Request('https://vete.test/api/followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'arroz 3 días', day: 0, report: 'come mejor' }),
    });

    const response = await worker.fetch(request, { NAN_KEY: KEY }, {});

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'invalid_input',
        message: 'El día debe ser un número entero mayor o igual a 1.',
      },
    });
    assert.equal(networkCalls(), 0);
  });
});

test('S19: without NAN_KEY both endpoints fail closed and never call Clef', async () => {
  for (const path of ['/api/triage', '/api/followup']) {
    await withoutNetwork(async (networkCalls) => {
      const request = new Request(`https://vete.test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ species: 'perro', message: 'vomitó', plan: 'arroz', day: 1, report: 'bien' }),
      });

      const response = await worker.fetch(request, {}, {});

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: { code: 'not_configured', message: 'Falta la key de NaN en el Worker.' },
      });
      assert.equal(networkCalls(), 0);
    });
  }
});

/**
 * Runs `body` with a global fetch that records any attempt to leave the process
 * and fails it, so a test can never reach the real Clef API.
 */
async function withoutNetwork(body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('tests must never reach the network');
  };
  try {
    return await body(() => calls.length);
  } finally {
    globalThis.fetch = original;
  }
}
