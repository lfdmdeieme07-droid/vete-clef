import { THRESHOLDS } from './config.js';
import { ClefError, CLEF_ERROR_MESSAGES, createClefClient } from './clef.js';
import { decideTriage } from './triage.js';
import { decideFollowup } from './followup.js';

const SPECIES = ['perro', 'gato', 'otro'];

/**
 * The three triage questions, verbatim from TAREA.md and S3. Everything Clef
 * sees about the decision is here.
 */
export const TRIAGE_QUESTIONS = [
  {
    id: 'emergency',
    type: 'noul',
    instructions: 'Does this pet need emergency veterinary care right now, within the next hour?',
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
];

/** The three follow-up questions, verbatim from TAREA.md and S11. */
export const FOLLOWUP_QUESTIONS = [
  {
    id: 'red_flags',
    type: 'noul',
    instructions:
      "Does today's report show any warning sign that needs urgent veterinary care (blood, not drinking, lethargy, repeated vomiting, seizures, possible poisoning, breathing trouble)?",
  },
  {
    id: 'worse',
    type: 'noul',
    instructions: 'Compared with the plan and previous days, is the pet getting worse?',
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
];

/** Spanish copy for the input rejections, so the screen never shows a raw error. */
const MESSAGES = {
  invalidBody: 'El cuerpo de la petición no es JSON válido.',
  invalidSpecies: 'La especie debe ser perro, gato u otro.',
  missingMessage: 'El mensaje del dueño es obligatorio.',
  missingPlan: 'El plan del veterinario es obligatorio.',
  missingReport: 'El reporte de hoy es obligatorio.',
  invalidDay: 'El día debe ser un número entero mayor o igual a 1.',
  notConfigured: 'Falta la key de NaN en el Worker.',
};

/** JSON responses only: user text is never turned into HTML (S21). */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status, code, message) {
  return json({ error: message === undefined ? { code } : { code, message } }, status);
}

/**
 * Trims free text and cuts it to maxFreeText characters. Anything that is not
 * text becomes an empty string, so a malformed field cannot smuggle an object
 * into the Clef state (S21).
 */
function freeText(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return text.trim().slice(0, THRESHOLDS.limits.maxFreeText);
}

function isPlainBody(body) {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/**
 * Validates a parsed triage body.
 * @returns {{ ok: true, value: { species: string, age: string, message: string } }
 *   | { ok: false, message: string }}
 */
/**
 * Converts the question list into the object map docs/api.md requires,
 * `{ id: { type, instructions, criteria } }`. The API does not accept a list,
 * and the id travels as the key, not as a field.
 *
 * @param {Array<{ id: string }>} questions
 */
export function questionsPayload(questions) {
  return Object.fromEntries(questions.map(({ id, ...question }) => [id, question]));
}

export function validateTriageInput(body) {
  if (!isPlainBody(body)) return { ok: false, message: MESSAGES.invalidBody };

  const species = typeof body.species === 'string' ? body.species.trim() : '';
  if (!SPECIES.includes(species)) return { ok: false, message: MESSAGES.invalidSpecies };

  const message = freeText(body.message);
  if (message === '') return { ok: false, message: MESSAGES.missingMessage };

  return { ok: true, value: { species, age: freeText(body.age), message } };
}

/**
 * The Spanish state triage sends to Clef.
 * @param {{ species: string, age: string, message: string }} input
 */
export function buildTriageState({ species, age, message }) {
  const parts = [`Especie: ${species}.`];
  if (age !== '') parts.push(`Edad: ${age}.`);
  parts.push(`Mensaje del dueño: «${message}»`);
  return parts.join(' ');
}

/**
 * Validates a parsed follow-up body.
 * @returns {{ ok: true, value: { plan: string, day: number, report: string } }
 *   | { ok: false, message: string }}
 */
export function validateFollowupInput(body) {
  if (!isPlainBody(body)) return { ok: false, message: MESSAGES.invalidBody };

  const plan = freeText(body.plan);
  if (plan === '') return { ok: false, message: MESSAGES.missingPlan };

  const report = freeText(body.report);
  if (report === '') return { ok: false, message: MESSAGES.missingReport };

  if (!Number.isInteger(body.day) || body.day < 1) {
    return { ok: false, message: MESSAGES.invalidDay };
  }

  return { ok: true, value: { plan, day: body.day, report } };
}

/**
 * The Spanish state follow-up sends to Clef.
 * @param {{ plan: string, day: number, report: string }} input
 */
export function buildFollowupState({ plan, day, report }) {
  return `Plan del veterinario: «${plan}». Día ${day}. Reporte de hoy: «${report}»`;
}

/**
 * Maps a Clef failure to the friendly 502 the screens show (S20).
 * @param {unknown} error
 */
export function clefErrorResponse(error) {
  const code =
    error instanceof ClefError && Object.hasOwn(CLEF_ERROR_MESSAGES, error.code)
      ? error.code
      : 'clef_failed';
  return { status: 502, body: { error: { code, message: CLEF_ERROR_MESSAGES[code] } } };
}

/** Parses a request body, returning null when it is not JSON. */
async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** The NAN_KEY secret, or null when the Worker was deployed without it (S19). */
function nanKey(env) {
  const key = env?.NAN_KEY;
  return typeof key === 'string' && key !== '' ? key : null;
}

/**
 * One Clef client per isolate, created on first use and reused. The queue in
 * createClefClient only serializes calls that share the client: a per-request
 * client would let two simultaneous users put two calls in flight, which Clef
 * forbids.
 */
let sharedClient = null;
let sharedClientKey = null;

function sharedClefClient(key) {
  if (sharedClient === null || sharedClientKey !== key) {
    sharedClient = createClefClient({ key });
    sharedClientKey = key;
  }
  return sharedClient;
}

/**
 * One Clef round trip. A Clef failure comes back as a ready JSON response, so
 * both endpoints answer with the same friendly 502 (S20).
 * @returns {Promise<{ ok: true, answers: any } | { ok: false, response: Response }>}
 */
async function askClef(key, state, questions) {
  try {
    const { answers } = await sharedClefClient(key).ask(state, questions);
    return { ok: true, answers };
  } catch (error) {
    if (!(error instanceof ClefError)) throw error;
    const mapped = clefErrorResponse(error);
    return { ok: false, response: json(mapped.body, mapped.status) };
  }
}

/**
 * Runs the pure decision rules on Clef's answers. The rules fail closed on a
 * malformed answer (ClefError clef_failed), which maps to the same friendly
 * 502 as any other upstream failure: an omission never becomes a decision.
 * @param {(input: { answers: any }) => ReturnType<typeof decideTriage>} decide
 * @param {any} answers
 */
function decideResponse(decide, answers) {
  try {
    return json(decide({ answers }));
  } catch (error) {
    if (!(error instanceof ClefError)) throw error;
    const mapped = clefErrorResponse(error);
    return json(mapped.body, mapped.status);
  }
}

async function handleTriage(request, env) {
  const input = validateTriageInput(await parseBody(request));
  if (!input.ok) return errorResponse(400, 'invalid_input', input.message);

  const key = nanKey(env);
  if (key === null) return errorResponse(500, 'not_configured', MESSAGES.notConfigured);

  const asked = await askClef(key, buildTriageState(input.value), questionsPayload(TRIAGE_QUESTIONS));
  if (!asked.ok) return asked.response;
  return decideResponse(decideTriage, asked.answers);
}

async function handleFollowup(request, env) {
  const input = validateFollowupInput(await parseBody(request));
  if (!input.ok) return errorResponse(400, 'invalid_input', input.message);

  const key = nanKey(env);
  if (key === null) return errorResponse(500, 'not_configured', MESSAGES.notConfigured);

  const asked = await askClef(
    key,
    buildFollowupState(input.value),
    questionsPayload(FOLLOWUP_QUESTIONS),
  );
  if (!asked.ok) return asked.response;
  return decideResponse(decideFollowup, asked.answers);
}

/** A Map, so a path such as `/constructor` cannot reach Object.prototype. */
const ROUTES = new Map([
  ['/api/triage', handleTriage],
  ['/api/followup', handleFollowup],
]);

export default {
  /**
   * @param {Request} request
   * @param {{ NAN_KEY?: string }} env Worker secrets, never sent to the browser
   * @param {unknown} ctx execution context, unused by these endpoints
   */
  async fetch(request, env, ctx) {
    const handler = ROUTES.get(new URL(request.url).pathname);
    if (handler === undefined || request.method !== 'POST') {
      return errorResponse(404, 'not_found');
    }
    return handler(request, env, ctx);
  },
};
