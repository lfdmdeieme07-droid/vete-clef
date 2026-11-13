import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decideFollowup } from '../src/followup.js';
import { FOLLOWUP_ROUTES } from '../src/config.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL('./fixtures/followup.json', import.meta.url), 'utf8')).cases[name]
    .answers;

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Builds a follow-up answer set with the given probabilities. */
function answersOf({ redFlags, worse, action, probabilities }) {
  return {
    red_flags: { type: 'noul', noul: redFlags },
    worse: { type: 'noul', noul: worse },
    action: {
      type: 'choice',
      choice: action,
      probabilities:
        probabilities ?? { seguir_plan: 0.6, consultar: 0.3, guardia: 0.1 },
      confidence: 0.5,
    },
  };
}

test('S12: a red flag sends the owner to the guardia', () => {
  const result = decideFollowup({ answers: fixture('guardia') });

  assert.equal(result.route, 'guardia');
});

test('S12 boundary: exactly 0.30 on red flags is a guardia', () => {
  const result = decideFollowup({
    answers: answersOf({
      redFlags: 0.3,
      worse: 0.1,
      action: 'seguir_plan',
      probabilities: { seguir_plan: 0.6, consultar: 0.3, guardia: 0.1 },
    }),
  });

  assert.equal(result.route, 'guardia');
});

test('S12: guardia probability at 0.20 is enough even with no red flag', () => {
  const result = decideFollowup({
    answers: answersOf({
      redFlags: 0.05,
      worse: 0.05,
      action: 'consultar',
      probabilities: { seguir_plan: 0.35, consultar: 0.45, guardia: 0.2 },
    }),
  });

  assert.equal(result.route, 'guardia');
});

test('S13: getting worse means calling the vet today', () => {
  const result = decideFollowup({ answers: fixture('consultar') });

  assert.equal(result.route, 'consultar');
});

test('S13 boundary: exactly 0.50 on worse means consultar', () => {
  const result = decideFollowup({
    answers: answersOf({
      redFlags: 0.05,
      worse: 0.5,
      action: 'seguir_plan',
      probabilities: { seguir_plan: 0.55, consultar: 0.4, guardia: 0.05 },
    }),
  });

  assert.equal(result.route, 'consultar');
});

test('S13: consultar probability at 0.35 is enough with nothing else going on', () => {
  const result = decideFollowup({
    answers: answersOf({
      redFlags: 0.02,
      worse: 0.1,
      action: 'seguir_plan',
      probabilities: { seguir_plan: 0.6, consultar: 0.35, guardia: 0.05 },
    }),
  });

  assert.equal(result.route, 'consultar');
});

test('S14: everything calm means keep following the plan', () => {
  const result = decideFollowup({ answers: fixture('seguir') });

  assert.equal(result.route, 'seguir_plan');
});

test('S12 wins over S13 when both fire', () => {
  const result = decideFollowup({
    answers: answersOf({
      redFlags: 0.8,
      worse: 0.9,
      action: 'guardia',
      probabilities: { seguir_plan: 0.02, consultar: 0.38, guardia: 0.6 },
    }),
  });

  assert.equal(result.route, 'guardia');
});

test('S14: the rules never produce medical prose of their own', () => {
  const result = decideFollowup({ answers: fixture('seguir') });

  // Only the three documented fields, and no prose: the plan is echoed by the screen.
  assert.deepEqual(Object.keys(result).sort(), ['probabilities', 'route', 'triggers']);
  assert.ok(FOLLOWUP_ROUTES.includes(result.route));
  assert.notEqual(typeof result.probabilities, 'string');
  assert.ok(Array.isArray(result.triggers));
});

test('S22: the rules are pure — same input gives the same result and nothing is mutated', () => {
  const input = clone(fixture('consultar'));
  const snapshot = clone(input);

  const first = decideFollowup({ answers: input });
  const second = decideFollowup({ answers: input });

  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
});

test('thresholds are one config object: a custom threshold changes the decision', () => {
  const answers = fixture('consultar');

  const strict = decideFollowup({ answers, config: { worse: 0.9, consultarProbability: 0.9 } });
  const lenient = decideFollowup({ answers, config: { worse: 0.8 } });

  assert.equal(strict.route, 'seguir_plan');
  assert.equal(lenient.route, 'consultar');
});
