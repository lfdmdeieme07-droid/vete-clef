import { thresholdsFor } from './config.js';

/**
 * The follow-up decision, as pure data. No copy, no network, no side effects.
 *
 * It never adds advice: the owner's plan is echoed by the screen, not here.
 *
 * @param {{ answers: any, config?: Record<string, number> }} input
 */
export function decideFollowup({ answers, config }) {
  const thresholds = thresholdsFor('followup', config);

  const redFlags = answers?.red_flags?.noul ?? 0;
  const worse = answers?.worse?.noul ?? 0;
  const byAction = answers?.action?.probabilities ?? {};
  const guardia = byAction.guardia ?? 0;
  const consultar = byAction.consultar ?? 0;

  const probabilities = {
    redFlags,
    worse,
    action: { choice: answers?.action?.choice ?? null, byAction },
  };

  // S12: any warning sign, or a loud guardia probability, ends the day at the guardia.
  const guardiaTriggers = [];
  if (redFlags >= thresholds.redFlag) guardiaTriggers.push('red_flags');
  if (guardia >= thresholds.guardiaProbability) guardiaTriggers.push('guardia_probability');
  if (guardiaTriggers.length > 0) {
    return { route: 'guardia', triggers: guardiaTriggers, probabilities };
  }

  // S13: something is off, but not urgent enough for the guardia.
  const consultarTriggers = [];
  if (worse >= thresholds.worse) consultarTriggers.push('worse');
  if (consultar >= thresholds.consultarProbability) consultarTriggers.push('consultar_probability');
  if (consultarTriggers.length > 0) {
    return { route: 'consultar', triggers: consultarTriggers, probabilities };
  }

  // S14: stable or improving — keep following the vet's plan.
  return { route: 'seguir_plan', triggers: [], probabilities };
}
