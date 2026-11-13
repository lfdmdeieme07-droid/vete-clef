/**
 * Every threshold the product depends on, in one place, so they can be
 * calibrated against real Clef responses (see scripts/calibrate.mjs).
 */

export const THRESHOLDS = {
  triage: {
    /** emergency.noul at or above this books nothing and shows the guardia screen. */
    emergency: 0.2,
    /** timing.score at or above this offers today's slot first. */
    preferTodayScore: 2.5,
    /** service.confidence below this asks the owner to pick between two services. */
    serviceConfidence: 0.5,
    /** timing.score at or above this turns a grooming request into a consulta. */
    groomingHealthScore: 1.5,
  },
  followup: {
    /** red_flags.noul at or above this is a guardia. */
    redFlag: 0.3,
    /** action.probabilities.guardia at or above this is a guardia. */
    guardiaProbability: 0.2,
    /** worse.noul at or above this means calling the vet today. */
    worse: 0.5,
    /** action.probabilities.consultar at or above this means calling the vet today. */
    consultarProbability: 0.35,
  },
  limits: {
    /** Free text is cut to this many characters before it reaches Clef. */
    maxFreeText: 4000,
    /** docs/api.md asks for a client timeout of at least 50 s. */
    clefTimeoutMs: 50000,
    /** On 429, wait this long and retry exactly once. */
    retryDelayMs: 1000,
    retries: 1,
  },
};

/** Clinic services, in the order docs/api.md and TAREA.md describe them. */
export const SERVICES = ['consulta', 'vacunacion', 'castracion', 'peluqueria', 'control'];

/** The only routes the triage rules can return. */
export const TRIAGE_ROUTES = ['guardia', 'booking', 'choose_service'];

/** The only routes the follow-up rules can return. */
export const FOLLOWUP_ROUTES = ['guardia', 'consultar', 'seguir_plan'];

/**
 * Merges a partial override into one threshold section.
 * @param {'triage'|'followup'|'limits'} section
 * @param {Record<string, number>} [overrides]
 */
export function thresholdsFor(section, overrides) {
  return { ...THRESHOLDS[section], ...(overrides ?? {}) };
}
