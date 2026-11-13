import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decideTriage } from '../src/triage.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL('./fixtures/triage.json', import.meta.url), 'utf8')).cases[name]
    .answers;

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Builds a triage answer set with the given probabilities. */
function answersOf({ emergency, choice, confidence, score, probabilities }) {
  return {
    emergency: { type: 'noul', noul: emergency },
    service: {
      type: 'choice',
      choice,
      probabilities:
        probabilities ??
        { consulta: 0.9, vacunacion: 0.02, castracion: 0.01, peluqueria: 0.02, control: 0.05 },
      confidence: confidence ?? 0.9,
    },
    timing: {
      type: 'score',
      score,
      legend: { 0: 'More than a week can wait', 1: 'This week', 2: 'Within 48 hours', 3: 'Today' },
      probabilities: { 0: 0.02, 1: 0.08, 2: 0.3, 3: 0.6 },
      confidence: 0.6,
    },
  };
}

test('S4: an emergency goes straight to the guardia screen and books nothing', () => {
  const result = decideTriage({ answers: fixture('emergency') });

  assert.equal(result.route, 'guardia');
  assert.equal(result.service, null);
  assert.equal(result.preferToday, false);
  assert.equal(result.options, null);
});

test('S4 boundary: exactly 0.20 is an emergency', () => {
  const result = decideTriage({
    answers: answersOf({ emergency: 0.2, choice: 'consulta', confidence: 0.9, score: 2 }),
  });

  assert.equal(result.route, 'guardia');
  assert.equal(result.service, null);
});

test('S4 boundary: 0.19 is not an emergency and still books', () => {
  const result = decideTriage({
    answers: answersOf({ emergency: 0.19, choice: 'consulta', confidence: 0.9, score: 2 }),
  });

  assert.equal(result.route, 'booking');
  assert.equal(result.service, 'consulta');
});

test('S5: books the chosen service and prefers today when the score is 2.5 or more', () => {
  const result = decideTriage({ answers: fixture('today') });

  assert.equal(result.route, 'booking');
  assert.equal(result.service, 'consulta');
  assert.equal(result.preferToday, true);
});

test('S5 boundary: exactly 2.5 prefers today', () => {
  const result = decideTriage({
    answers: answersOf({ emergency: 0.03, choice: 'consulta', confidence: 0.9, score: 2.5 }),
  });

  assert.equal(result.route, 'booking');
  assert.equal(result.preferToday, true);
});

test('S5: a score below 2.5 does not prefer today', () => {
  const result = decideTriage({ answers: fixture('routine') });

  assert.equal(result.route, 'booking');
  assert.equal(result.service, 'vacunacion');
  assert.equal(result.preferToday, false);
});

test('S6: low service confidence offers the two most likely services instead of booking', () => {
  const result = decideTriage({ answers: fixture('ambiguous') });

  assert.equal(result.route, 'choose_service');
  assert.equal(result.service, null);
  assert.equal(result.preferToday, false);
  assert.deepEqual(result.options.map((option) => option.id), ['consulta', 'control']);
  assert.ok(result.options[0].probability > result.options[1].probability);
});

test('S6 boundary: exactly 0.5 confidence books directly', () => {
  const result = decideTriage({
    answers: answersOf({ emergency: 0.03, choice: 'consulta', confidence: 0.5, score: 2 }),
  });

  assert.equal(result.route, 'booking');
  assert.equal(result.options, null);
});

test('S7: grooming with a health signal becomes consulta and records why', () => {
  const result = decideTriage({ answers: fixture('grooming') });

  assert.equal(result.route, 'booking');
  assert.equal(result.service, 'consulta');
  assert.deepEqual(result.overridden, { from: 'peluqueria', to: 'consulta' });
});

test('S7 boundary: exactly 1.5 overrides grooming', () => {
  const result = decideTriage({
    answers: answersOf({ emergency: 0.04, choice: 'peluqueria', confidence: 0.7, score: 1.5 }),
  });

  assert.equal(result.service, 'consulta');
  assert.notEqual(result.overridden, null);
});

test('S7: grooming below 1.5 stays grooming', () => {
  const result = decideTriage({
    answers: answersOf({ emergency: 0.04, choice: 'peluqueria', confidence: 0.7, score: 1.4 }),
  });

  assert.equal(result.route, 'booking');
  assert.equal(result.service, 'peluqueria');
  assert.equal(result.overridden, null);
});

test('L5: the grooming override wins over low confidence and grooming is never offered', () => {
  const result = decideTriage({
    answers: answersOf({
      emergency: 0.05,
      choice: 'peluqueria',
      confidence: 0.35,
      score: 2,
      probabilities: { consulta: 0.3, vacunacion: 0.02, castracion: 0.03, peluqueria: 0.5, control: 0.15 },
    }),
  });

  assert.equal(result.route, 'choose_service');
  assert.equal(result.service, 'consulta');
  assert.equal(result.options.length, 2);
  assert.ok(!result.options.some((option) => option.id === 'peluqueria'));
  assert.deepEqual(result.overridden, { from: 'peluqueria', to: 'consulta' });
});

test('S8: the probabilities shown on screen come from Clef', () => {
  const result = decideTriage({ answers: fixture('emergency') });

  assert.equal(result.probabilities.emergency, 0.87);
  assert.equal(result.probabilities.service.confidence, 0.86);
  assert.equal(result.probabilities.timing.score, 3.4);
});

test('S22: the rules are pure — same input gives the same result and nothing is mutated', () => {
  const input = clone(fixture('ambiguous'));
  const snapshot = clone(input);

  const first = decideTriage({ answers: input });
  const second = decideTriage({ answers: input });

  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
});

test('thresholds are one config object: a custom threshold changes the decision', () => {
  const answers = fixture('emergency');

  const strict = decideTriage({ answers, config: { emergency: 0.9 } });
  const lenient = decideTriage({ answers, config: { emergency: 0.5 } });

  assert.equal(strict.route, 'booking');
  assert.equal(lenient.route, 'guardia');
});

test('L6: score probabilities keyed by label are accepted as well as index-keyed ones', () => {
  const result = decideTriage({ answers: fixture('labeledScoreProbabilities') });

  assert.equal(result.probabilities.timing.score, 1.7);
  assert.equal(result.probabilities.timing.byLevel[1], 0.4);
});
