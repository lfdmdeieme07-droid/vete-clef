import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideTriage } from '../src/triage.js';
import { decideFollowup } from '../src/followup.js';
import { ClefError } from '../src/clef.js';

/**
 * A complete, valid answer set, in the shape real Clef returns. Every test
 * mutates or deletes one field and expects the rule to refuse to decide.
 */
function validTriage() {
  return {
    emergency: { type: 'noul', noul: 0.05 },
    service: {
      type: 'choice',
      choice: 'consulta',
      probabilities: { consulta: 0.9, vacunacion: 0.02, castracion: 0.01, peluqueria: 0.02, control: 0.05 },
      confidence: 0.9,
    },
    timing: {
      type: 'score',
      score: 1.2,
      legend: { 0: 'More than a week can wait', 1: 'This week', 2: 'Within 48 hours', 3: 'Today' },
      probabilities: { 0: 0.2, 1: 0.55, 2: 0.2, 3: 0.05 },
      confidence: 0.44,
    },
  };
}

function validFollowup() {
  return {
    red_flags: { type: 'noul', noul: 0.04 },
    worse: { type: 'noul', noul: 0.18 },
    action: {
      type: 'choice',
      choice: 'seguir_plan',
      probabilities: { seguir_plan: 0.9, consultar: 0.08, guardia: 0.02 },
      confidence: 0.85,
    },
  };
}

function assertFailsClosed(run) {
  assert.throws(run, (error) => error instanceof ClefError && error.code === 'clef_failed');
}

test('triage: answers {} fails closed instead of reading every field as 0', () => {
  assertFailsClosed(() => decideTriage({ answers: {} }));
});

test('triage: a missing timing.score fails closed', () => {
  const answers = validTriage();
  delete answers.timing.score;
  assertFailsClosed(() => decideTriage({ answers }));
});

test('triage: a string noul is not a number and fails closed', () => {
  const answers = validTriage();
  answers.emergency.noul = '0.9';
  assertFailsClosed(() => decideTriage({ answers }));
});

test('triage: a non-finite noul (NaN through a rehydrated payload) fails closed', () => {
  const answers = validTriage();
  answers.emergency.noul = Number.NaN;
  assertFailsClosed(() => decideTriage({ answers }));
});

test('triage: a missing service.probabilities map fails closed', () => {
  const answers = validTriage();
  delete answers.service.probabilities;
  assertFailsClosed(() => decideTriage({ answers }));
});

test('triage: a probability map with a non-number value fails closed', () => {
  const answers = validTriage();
  answers.service.probabilities.consulta = null;
  assertFailsClosed(() => decideTriage({ answers }));
});

test('triage: a missing service.choice fails closed', () => {
  const answers = validTriage();
  delete answers.service.choice;
  assertFailsClosed(() => decideTriage({ answers }));
});

test('followup: answers {} fails closed instead of landing on seguir_plan', () => {
  assertFailsClosed(() => decideFollowup({ answers: {} }));
});

test('followup: a missing action.probabilities.guardia fails closed', () => {
  const answers = validFollowup();
  delete answers.action.probabilities.guardia;
  assertFailsClosed(() => decideFollowup({ answers }));
});

test('followup: a missing red_flags.noul fails closed', () => {
  const answers = validFollowup();
  delete answers.red_flags.noul;
  assertFailsClosed(() => decideFollowup({ answers }));
});

test('a complete answer set still decides (the guard does not over-block)', () => {
  const triage = decideTriage({ answers: validTriage() });
  assert.equal(triage.route, 'booking');

  const followup = decideFollowup({ answers: validFollowup() });
  assert.equal(followup.route, 'seguir_plan');
});
