# TAREA: Vete Clef (#2 NaN Hackathon, category «Tema libre»)

## Context

- Hackathon: «#2 NaN Hackathon: Decide con Clef». Official docs: https://github.com/helmcode/nan-hackathon-clef (read `docs/api.md` and `examples/` first).
- Rules: Clef must make the central decision (remove Clef and the app stops making sense). Public repo, public URL, code written during the hackathon (13–15 Nov 2026). Safe deadline: Sunday 15 Nov, 13:00 Argentina time.
- Idea: a veterinary clinic assistant. The owner describes the pet in plain words and Clef decides what happens next. Clef never diagnoses and never prescribes; it only decides where the case goes and when to escalate to a vet.
- Real-life origin (for the README story): a 45-day-old Dogo Argentino puppy with diarrhea. The vet prescribed 3 days of rice, then adding food gradually. The owner needed to know, day by day, whether to keep following the plan or call the vet.

## Product

Two screens, Spanish UI (neutral Spanish, the audience is Spanish-speaking), mobile-first.

### 1. «Pedir turno» (triage)

Input: species (perro / gato / otro), age, free-text message.

One Clef request with three questions:

| id | type | instructions | criteria |
|---|---|---|---|
| `emergency` | noul | Does this pet need emergency veterinary care right now, within the next hour? | — |
| `service` | choice | Which clinic service fits this request? | `consulta`: sick or unwell pet that needs a vet exam; `vacunacion`: healthy pet due for vaccines or deworming; `castracion`: spay or neuter surgery request; `peluqueria`: bath or grooming for a healthy pet; `control`: checkup or follow-up of a known treatment |
| `timing` | score | How soon should the vet see this pet? | ["More than a week can wait", "This week", "Within 48 hours", "Today"] |

Decision rules (thresholds live in one config object, so they can be calibrated):

1. `emergency.noul >= 0.20` → red screen «Andá ya a la guardia veterinaria», no booking. Err on the side of caution.
2. Otherwise book the first free slot of `service.choice`; if `timing.score >= 2.5`, offer today's slot first.
3. If `service.confidence < 0.5` → show the top two services and let the owner pick.
4. A grooming request with health signs must not end in grooming: if `service.choice == "peluqueria"` and `timing.score >= 1.5`, switch to `consulta` and explain why.

Show Clef's probabilities on screen («Emergencia: 87 %»): transparency is part of the demo.

Booking uses a fake in-browser agenda (localStorage, wrapped in try/catch), one week of slots per service. No real personal data.

### 2. «Seguimiento» (daily follow-up)

Input: the vet's plan (free text), day number, today's report (free text).

One Clef request with three questions:

| id | type | instructions | criteria |
|---|---|---|---|
| `red_flags` | noul | Does today's report show any warning sign that needs urgent veterinary care (blood, not drinking, lethargy, repeated vomiting, seizures, possible poisoning, breathing trouble)? | — |
| `worse` | noul | Compared with the plan and previous days, is the pet getting worse? | — |
| `action` | choice | What should the owner do today? | `seguir_plan`: keep following the vet's plan, the pet is stable or improving; `consultar`: call the vet within 24 hours, something is off but not urgent; `guardia`: go to the emergency vet now |

Decision rules:

1. `red_flags.noul >= 0.30` or `action.probabilities.guardia >= 0.20` → «Guardia ya».
2. Else `worse.noul >= 0.50` or `action.probabilities.consultar >= 0.35` → «Llamá a tu veterinario hoy».
3. Else → «Seguí el plan de tu veterinario». Repeat the plan as written by the owner; never add medical advice of our own.

Keep each day's entry in localStorage so the owner sees the history.

### Fixed safety text (always visible)

«Esta herramienta no reemplaza al veterinario. No da diagnósticos ni dosis. Ante la duda, consultá.»

## Architecture

- One Cloudflare Worker with static assets (plain HTML, CSS and JS, no framework) plus two endpoints: `POST /api/triage` and `POST /api/followup`.
- The Worker builds the Clef request (`POST https://api.nan.builders/v1/systemone`, `model: "clef"`) and returns Clef's answers plus the decision.
- The NaN key lives only in the Worker secret `NAN_KEY`. It never reaches the browser, the repo or a log. Local dev reads it from `.dev.vars`, which is in `.gitignore`.
- Clef allows one request in flight per key: serialize calls in the Worker, retry once after 1 s on `429`, timeout 50 s, and return a friendly error on `502`/`504`.
- Validate input length (cut the free text to ~4,000 characters) and escape all user text before rendering it.
- Decision rules are pure functions in their own module, so they are testable without the network.

## Demo cases

Put them in `cases/cases.json` with the expected route:

1. «Mi perro se comió una barra de chocolate hace una hora y está temblando» → guardia.
2. «Quiero bañarlo, pero vomitó dos veces hoy» → consulta, not grooming.
3. «Le toca la segunda vacuna al cachorro» → vacunación.
4. «Quiero castrar a mi gata de 7 meses» → castración.
5. «Mi gato no hace pis hace un día y llora en la piedra» → guardia.
6. «Tiene una pelotita en la piel desde hace un mes, no le molesta» → consulta, not today.
7. Follow-up, day 2: plan «arroz 3 días, después agregar alimento de a poco»; report «toma agua solo, la caca está más firme, come poquito» → seguir el plan.
8. Follow-up, day 3: same plan; report «no quiere tomar agua, está decaído y la caca tiene sangre» → guardia.
9. Follow-up, day 4: same plan; report «sigue con diarrea igual que el primer día, pero toma agua y juega» → consultar.
10. Ambiguous: «Está raro, como triste» → show how Clef doubts.

## Tests

- `node --test` unit tests for the decision rules with recorded Clef responses as fixtures. No network in tests.
- `scripts/calibrate.mjs`: runs `cases/cases.json` against the real Clef, in series, and prints each case's probabilities next to the expected route. It needs `NAN_KEY` in the environment and is run by hand, never in tests.
- Test-first for the decision rules: write the failing test, then the rule.

## Deliverables

- Public-ready repo: README in Spanish whose first line is «Categoría: Tema libre». It covers the story, how Clef decides (questions and thresholds), screenshots, how to run it locally, and the safety note.
- Feature document `odd/tasks/vete-clef.md` with the task list and progress.
- Conventional commits, one per work unit, on branch `main`.

## Do not

- Do not push, deploy, create remote repos or set secrets. Deploying and publishing are done with Fabi.
- Do not put the NaN key anywhere in the repo, the frontend or the logs.
- Do not give medical advice, doses or diagnoses in any text.
- Do not use sudo. If Node.js or another tool is missing, stop and report it.
- Do not copy code from other projects: everything is written during the hackathon.
