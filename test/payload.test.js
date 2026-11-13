import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  TRIAGE_QUESTIONS,
  FOLLOWUP_QUESTIONS,
  questionsPayload,
} from '../src/worker.js';

/** Answers shaped like docs/api.md, so the rules can decide. */
const ANSWERS = {
  emergency: { type: 'noul', noul: 0.87 },
  service: {
    type: 'choice',
    choice: 'consulta',
    probabilities: { consulta: 0.9, vacunacion: 0.02, castracion: 0.02, peluqueria: 0.02, control: 0.04 },
    confidence: 0.88,
  },
  timing: {
    type: 'score',
    score: 3.2,
    legend: { 0: 'More than a week can wait', 1: 'This week', 2: 'Within 48 hours', 3: 'Today' },
    probabilities: { 0: 0.01, 1: 0.03, 2: 0.16, 3: 0.8 },
    confidence: 0.7,
  },
};

/** Runs `fn` with `globalThis.fetch` replaced, then always restores it. */
async function withStubbedFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('the payload is an object keyed by question id and the id is not a field', () => {
  const payload = questionsPayload(TRIAGE_QUESTIONS);

  assert.equal(Array.isArray(payload), false);
  assert.deepEqual(Object.keys(payload), ['emergency', 'service', 'timing']);
  assert.equal('id' in payload.emergency, false);
  assert.equal(payload.emergency.type, 'noul');
  assert.equal(payload.service.type, 'choice');
  assert.equal(payload.service.criteria.consulta.length > 0, true);
  assert.equal(payload.timing.criteria.length, 4);
});

test('the follow-up payload is keyed by red_flags, worse and action', () => {
  const payload = questionsPayload(FOLLOWUP_QUESTIONS);

  assert.deepEqual(Object.keys(payload), ['red_flags', 'worse', 'action']);
  assert.equal('id' in payload.action, false);
  assert.deepEqual(Object.keys(payload.action.criteria), ['seguir_plan', 'consultar', 'guardia']);
});

test('POST /api/triage sends the questions as an object, never as a list', async () => {
  let sent;

  const response = await withStubbedFetch(
    async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ answers: ANSWERS }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    () =>
      worker.fetch(
        new Request('https://vete-clef.test/api/triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ species: 'perro', age: '2 años', message: 'se comió chocolate' }),
        }),
        { NAN_KEY: 'sk-test-DO-NOT-LEAK-1234' },
      ),
  );

  assert.equal(response.status, 200);
  assert.equal(sent.model, 'clef');
  assert.equal(Array.isArray(sent.questions), false);
  assert.deepEqual(Object.keys(sent.questions), ['emergency', 'service', 'timing']);
  assert.equal(sent.questions.emergency.type, 'noul');
  assert.equal('id' in sent.questions.service, false);
  // The state carries the owner's words so Clef decides on real context.
  assert.equal(sent.state.includes('se comió chocolate'), true);
});

test('POST /api/followup sends the questions as an object keyed by id', async () => {
  let sent;

  const response = await withStubbedFetch(
    async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          answers: {
            red_flags: { type: 'noul', noul: 0.04 },
            worse: { type: 'noul', noul: 0.1 },
            action: {
              type: 'choice',
              choice: 'seguir_plan',
              probabilities: { seguir_plan: 0.9, consultar: 0.08, guardia: 0.02 },
              confidence: 0.85,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
    () =>
      worker.fetch(
        new Request('https://vete-clef.test/api/followup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 'arroz 3 días', day: 2, report: 'la caca está más firme' }),
        }),
        { NAN_KEY: 'sk-test-DO-NOT-LEAK-1234' },
      ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(sent.questions), ['red_flags', 'worse', 'action']);
  assert.equal(Array.isArray(sent.questions), false);
  const body = await response.json();
  assert.equal(body.route, 'seguir_plan');
});

test('a missing NAN_KEY fails closed before any request is sent', async () => {
  let called = false;

  const response = await withStubbedFetch(
    async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
    () =>
      worker.fetch(
        new Request('https://vete-clef.test/api/triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ species: 'gato', age: '1', message: 'está raro' }),
        }),
        {},
      ),
  );

  assert.equal(response.status, 500);
  assert.equal(called, false);
  const body = await response.json();
  assert.equal(body.error.code, 'not_configured');
});
