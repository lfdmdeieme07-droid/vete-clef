import { SERVICES, thresholdsFor } from './config.js';
import { requireAnswerShape } from './clef.js';

/**
 * Normalizes `timing.probabilities` to an index-keyed map.
 *
 * docs/api.md asks to verify with a real call whether the keys are indices
 * ("0", "1") or the legend labels; until then both are accepted.
 *
 * @param {any} timingAnswer
 * @returns {Record<number, number>}
 */
function levelsByIndex(timingAnswer) {
  const legend = timingAnswer?.legend ?? {};
  const probabilities = timingAnswer?.probabilities ?? {};
  const indexByLabel = new Map(
    Object.entries(legend).map(([index, label]) => [label, Number(index)]),
  );

  const out = {};
  for (const [key, value] of Object.entries(probabilities)) {
    if (/^\d+$/.test(key)) {
      out[Number(key)] = value;
    } else if (indexByLabel.has(key)) {
      out[indexByLabel.get(key)] = value;
    }
  }
  return out;
}

/**
 * The services with the highest probability, strongest first.
 *
 * @param {Record<string, number>} probabilities
 * @param {string | null} exclude service that must never be offered
 * @param {number} count
 */
function topServices(probabilities, exclude, count) {
  return SERVICES.filter((id) => id !== exclude && typeof probabilities[id] === 'number')
    .map((id) => ({ id, probability: probabilities[id] }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, count);
}

/**
 * The triage decision, as pure data. No copy, no network, no side effects.
 *
 * Order (odd/tasks/vete-clef.md, L5): emergency, then the grooming health
 * override, then service doubt, then slot preference. Safety before confidence.
 *
 * @param {{ answers: any, config?: Record<string, number> }} input
 */
export function decideTriage({ answers, config }) {
  const thresholds = thresholdsFor('triage', config);

  // Fail closed: a malformed or partial Clef answer is an error, not a zero.
  // Without this, answers {} would read every field as 0 and land on booking.
  requireAnswerShape(answers, {
    emergency: { numbers: ['noul'] },
    service: { strings: ['choice'], numbers: ['confidence'], numberMaps: ['probabilities'] },
    timing: { numbers: ['score'], numberMaps: ['probabilities'] },
  });

  const emergency = answers?.emergency?.noul ?? 0;
  const chosen = answers?.service?.choice ?? null;
  const confidence = answers?.service?.confidence ?? 0;
  const byService = answers?.service?.probabilities ?? {};
  const timingScore = answers?.timing?.score ?? 0;

  const probabilities = {
    emergency,
    service: { choice: chosen, confidence, byService },
    timing: { score: timingScore, byLevel: levelsByIndex(answers?.timing) },
  };

  // S4: err on the side of caution.
  if (emergency >= thresholds.emergency) {
    return {
      route: 'guardia',
      service: null,
      preferToday: false,
      options: null,
      overridden: null,
      probabilities,
    };
  }

  // S7: a grooming request with a health signal is never grooming.
  let service = chosen;
  let overridden = null;
  if (chosen === 'peluqueria' && timingScore >= thresholds.groomingHealthScore) {
    service = 'consulta';
    overridden = { from: 'peluqueria', to: 'consulta' };
  }

  // S6: when Clef doubts the service, the owner picks between the two likeliest.
  // `service` carries only the forced result of the grooming override; otherwise
  // the owner has to choose, so there is no service yet.
  if (confidence < thresholds.serviceConfidence) {
    return {
      route: 'choose_service',
      service: overridden ? service : null,
      preferToday: false,
      options: topServices(byService, overridden ? 'peluqueria' : null, 2),
      overridden,
      probabilities,
    };
  }

  // S5: book the service, and put today first when the score asks for it.
  return {
    route: 'booking',
    service,
    preferToday: timingScore >= thresholds.preferTodayScore,
    options: null,
    overridden,
    probabilities,
  };
}
