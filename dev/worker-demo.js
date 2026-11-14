/**
 * LOCAL DEMO WORKER — not part of the deliverable.
 *
 * It replaces exactly one thing: the Clef round trip. Validation, the pure
 * decision rules in src/ and the static screens are the real code, imported
 * unchanged. So the demo exercises the same decision logic the deployed Worker
 * runs, only fed with the synthetic answers in dev/demo-answers.json.
 *
 * Why it exists: `model: "clef"` returns 404 model_not_found on this account
 * (odd/tasks/vete-clef.md, L3), so the real Worker answers 502 on every
 * request and the full flow cannot be walked through or screenshotted.
 *
 * src/ and public/ are untouched by design: delete this file, the answers file
 * and wrangler.demo.toml before delivery and nothing of the demo remains.
 */

import { decideTriage } from '../src/triage.js';
import { decideFollowup } from '../src/followup.js';
import { buildFollowupState, buildTriageState, validateFollowupInput, validateTriageInput } from '../src/worker.js';
import demo from './demo-answers.json';

/**
 * Lowercase and strip diacritics, so «vomitó» matches «vomito» (S1: the UI is
 * Spanish, users type accents inconsistently).
 * @param {string} text
 */
function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Picks the demo case whose keywords appear most often in the probe text, and
 * falls back to the deliberately ambiguous case, so unmatched input shows how
 * Clef doubts instead of inventing a confident answer.
 *
 * @param {Array<{ id: string, match: string[], answers: any }>} cases
 * @param {string} probe
 * @param {string} fallbackId
 */
export function pickAnswers(cases, probe, fallbackId) {
  const haystack = normalize(probe);
  let best = null;
  let bestScore = 0;

  for (const entry of cases) {
    const score = entry.match.filter((keyword) => haystack.includes(normalize(keyword))).length;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  const chosen = best ?? cases.find((entry) => entry.id === fallbackId) ?? cases[0];
  return chosen.answers;
}

/** The banner injected into the served HTML, so a screenshot is never mistaken for a real Clef run. */
const BANNER = [
  '<div role="note" style="position:fixed;left:0;right:0;bottom:0;z-index:9999;',
  'padding:10px 14px;background:#7c2d12;color:#fff;font:600 13px/1.4 system-ui,sans-serif;',
  'text-align:center;box-shadow:0 -2px 12px rgba(0,0,0,.35)">',
  'MODO DEMO · respuestas de ejemplo, sin Clef. No es una decisión real del modelo.',
  '</div>',
].join('');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status, code, message) {
  return json({ error: message === undefined ? { code } : { code, message } }, status);
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleTriage(request) {
  const input = validateTriageInput(await parseBody(request));
  if (!input.ok) return errorResponse(400, 'invalid_input', input.message);

  const answers = pickAnswers(demo.triage, buildTriageState(input.value), demo.fallback.triage);
  return json(decideTriage({ answers }));
}

async function handleFollowup(request) {
  const input = validateFollowupInput(await parseBody(request));
  if (!input.ok) return errorResponse(400, 'invalid_input', input.message);

  const answers = pickAnswers(demo.followup, buildFollowupState(input.value), demo.fallback.followup);
  return json(decideFollowup({ answers }));
}

const ROUTES = new Map([
  ['/api/triage', handleTriage],
  ['/api/followup', handleFollowup],
]);

/**
 * Serves the static screens through the assets binding and injects the demo
 * banner into the HTML. public/ itself stays byte-identical to the deliverable.
 * @param {Request} request
 * @param {{ ASSETS: { fetch: (request: Request) => Promise<Response> } }} env
 */
async function assetsWithBanner(request, env) {
  const response = await env.ASSETS.fetch(request);

  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;

  const html = await response.text();
  const body = html.includes('</body>') ? html.replace('</body>', `${BANNER}</body>`) : `${html}${BANNER}`;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');

  return new Response(body, { status: response.status, headers });
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (request: Request) => Promise<Response> } }} env
   */
  async fetch(request, env) {
    const handler = ROUTES.get(new URL(request.url).pathname);

    if (handler !== undefined && request.method === 'POST') {
      return handler(request);
    }

    if (handler !== undefined) {
      return errorResponse(405, 'method_not_allowed');
    }

    return assetsWithBanner(request, env);
  },
};
