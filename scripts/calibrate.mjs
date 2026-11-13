#!/usr/bin/env node
/**
 * Calibration against the real Clef (S25).
 *
 * Runs cases/cases.json in series — Clef allows one request in flight per key —
 * and prints each case's probabilities next to the route the thresholds expect.
 * Run it by hand, never from the test suite: it needs NAN_KEY and the network.
 *
 *   NAN_KEY="sk-..." node scripts/calibrate.mjs
 */

import { readFileSync } from 'node:fs';

import { ClefError, createClefClient } from '../src/clef.js';
import {
  TRIAGE_QUESTIONS,
  FOLLOWUP_QUESTIONS,
  questionsPayload,
  buildTriageState,
  buildFollowupState,
} from '../src/worker.js';
import { decideTriage } from '../src/triage.js';
import { decideFollowup } from '../src/followup.js';

const key = process.env.NAN_KEY;
if (!key) {
  console.error('Falta NAN_KEY en el entorno.');
  console.error('Uso: NAN_KEY="sk-..." node scripts/calibrate.mjs');
  process.exit(2);
}

const casesUrl = new URL('../cases/cases.json', import.meta.url);
const { cases } = JSON.parse(readFileSync(casesUrl, 'utf8'));

const percent = (value) => `${Math.round(value * 100)}%`;
const pad = (text, width) => String(text).padEnd(width);

/** The probability line differs by kind, because the questions do. */
function describeProbabilities(kind, decision) {
  const p = decision.probabilities;
  if (kind === 'triage') {
    return `emergencia ${percent(p.emergency)} · servicio ${pad(p.service.choice ?? '-', 10)} ${percent(p.service.confidence)} · urgencia ${p.timing.score.toFixed(1)}/3`;
  }
  return `alarma ${percent(p.redFlags)} · empeora ${percent(p.worse)} · consultar ${percent(p.action.byAction.consultar ?? 0)} · guardia ${percent(p.action.byAction.guardia ?? 0)}`;
}

// One client for the whole run: its queue is what keeps the calls serialized.
const client = createClefClient({ key });

let matched = 0;
let failed = 0;

console.log(`Calibrando ${cases.length} casos contra Clef, en serie.\n`);

for (const testCase of cases) {
  const isTriage = testCase.kind === 'triage';
  const label = pad(testCase.id, 22);

  try {
    const state = isTriage ? buildTriageState(testCase.input) : buildFollowupState(testCase.input);
    const questions = questionsPayload(isTriage ? TRIAGE_QUESTIONS : FOLLOWUP_QUESTIONS);
    const { answers } = await client.ask(state, questions);
    const decision = isTriage ? decideTriage({ answers }) : decideFollowup({ answers });

    const hit = decision.route === testCase.expectedRoute;
    if (hit) matched += 1;
    else failed += 1;

    console.log(`${hit ? 'OK  ' : 'DIFF'} ${label} esperado ${pad(testCase.expectedRoute, 15)} obtuvo ${pad(decision.route, 15)}`);
    console.log(`     ${describeProbabilities(testCase.kind, decision)}`);
    if (!hit) {
      console.log(`     nota: ${testCase.note}`);
      if (decision.overridden) console.log(`     override: ${decision.overridden.from} -> ${decision.overridden.to}`);
    }
  } catch (error) {
    failed += 1;
    const code = error instanceof ClefError ? error.code : 'unexpected';
    console.log(`ERR  ${label} ${code}`);
    if (code === 'clef_no_access') {
      console.log('     La key no tiene acceso al modelo clef. Revisá la key del hackathon.');
      break;
    }
  }
}

console.log(`\n${matched}/${cases.length} coinciden con la ruta esperada.`);
process.exit(failed === 0 ? 0 : 1);
