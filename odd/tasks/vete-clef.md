# Vete Clef — asistente de triage veterinario donde Clef decide

Hackathon #2 NaN «Decide con Clef», categoría «Tema libre». Brief vinculante: `TAREA.md`.
Deadline seguro: domingo 15 de noviembre de 2026, 13:00 (hora Argentina).

## Specs

S1. Dos pantallas, UI en español neutro, mobile-first: «Pedir turno» (triage) y «Seguimiento».
S2. Entrada del triage: especie (`perro` / `gato` / `otro`), edad, mensaje libre del dueño.
S3. Una sola petición a Clef con tres preguntas: `emergency` (`noul`), `service` (`choice`), `timing` (`score`).
    Criterios exactos de `service`: `consulta` = «sick or unwell pet that needs a vet exam»; `vacunacion` = «healthy pet due for vaccines or deworming»; `castracion` = «spay or neuter surgery request»; `peluqueria` = «bath or grooming for a healthy pet»; `control` = «checkup or follow-up of a known treatment».
    Criterios exactos de `timing`: `["More than a week can wait", "This week", "Within 48 hours", "Today"]`.
S4. Regla 1 del triage: `emergency.noul >= 0.20` → pantalla roja «Andá ya a la guardia veterinaria», sin reserva. *«Err on the side of caution.»*
S5. Regla 2: si no hay emergencia, reservar el primer turno libre de `service.choice`; si `timing.score >= 2.5`, ofrecer primero el turno de hoy.
S6. Regla 3: si `service.confidence < 0.5` → mostrar los dos servicios más probables y que el dueño elija.
S7. Regla 4: si `service.choice == "peluqueria"` y `timing.score >= 1.5` → cambiar a `consulta` y explicar por qué.
S8. Mostrar las probabilidades de Clef en pantalla, formato «Emergencia: 87 %».
S9. Agenda falsa en el navegador (`localStorage`, envuelto en `try/catch`), una semana de turnos por servicio, sin datos personales reales.
S10. Entrada del seguimiento: plan del veterinario (texto libre), número de día, reporte de hoy (texto libre).
S11. Petición de seguimiento a Clef con tres preguntas: `red_flags` (`noul`), `worse` (`noul`), `action` (`choice` con `seguir_plan`, `consultar`, `guardia`).
S12. Regla 1 del seguimiento: `red_flags.noul >= 0.30` o `action.probabilities.guardia >= 0.20` → «Guardia ya».
S13. Regla 2: si no, `worse.noul >= 0.50` o `action.probabilities.consultar >= 0.35` → «Llamá a tu veterinario hoy».
S14. Regla 3: si no → «Seguí el plan de tu veterinario». Repetir el plan tal como lo escribió el dueño; nunca agregar consejo médico propio.
S15. Guardar cada día en `localStorage` para que el dueño vea el historial.
S16. Texto fijo de seguridad, siempre visible: «Esta herramienta no reemplaza al veterinario. No da diagnósticos ni dosis. Ante la duda, consultá.»
S17. Un solo Cloudflare Worker con assets estáticos (HTML, CSS y JS planos, sin framework) más dos endpoints: `POST /api/triage` y `POST /api/followup`.
S18. El Worker arma la petición a `POST https://api.nan.builders/v1/systemone` con `model: "clef"`.
S19. La key de NaN vive solo en el secret `NAN_KEY` del Worker. Nunca al navegador, al repo ni a un log. En local se lee de `.dev.vars`, que está en `.gitignore`.
S20. Clef permite una sola petición en vuelo por key: serializar las llamadas en el Worker, reintentar una vez a los 1 s ante `429`, timeout de 50 s, y devolver un error amable ante `502`/`504`.
S21. Validar longitud de entrada (recortar el texto libre a ~4000 caracteres) y escapar todo texto del usuario antes de renderizarlo.
S22. Las reglas de decisión son funciones puras en su propio módulo, testeables sin red.
S23. Casos de demo en `cases/cases.json` con la ruta esperada, los 10 del brief (el último ambiguo).
S24. Tests unitarios con `node --test` sobre las reglas, con fixtures de respuestas de Clef. Sin red.
S25. `scripts/calibrate.mjs` corre `cases/cases.json` contra el Clef real, en serie, y muestra las probabilidades al lado de la ruta esperada. Necesita `NAN_KEY` en el entorno y se corre a mano, nunca en tests.
S26. Test-first para las reglas de decisión.
S27. Entregables: README en español cuya primera línea es «Categoría: Tema libre»; este documento; commits convencionales, uno por unidad, en `main`.
S28. Prohibido: pushear, deployar, crear repos remotos o setear secrets; poner la key en el repo, el frontend o los logs; dar diagnósticos, dosis o consejo médico; usar `sudo`; copiar código de otros proyectos.

## Tasks

| ID | Specs | Ruta | Commit |
| -- | ----- | ---- | ------ |
| T1 | S17, S22, S27 | Config del proyecto y feature doc | `docs: add ODD plan for vete clef` |
| T2 | S4-S7, S22, S26 | Reglas puras del triage, test-first | `feat(rules): pure triage decision rules` |
| T3 | S12-S14, S22, S26 | Reglas puras del seguimiento, test-first | `feat(rules): pure follow-up decision rules` |
| T4 | S23 | Los 10 casos de demo con ruta esperada | `test(cases): add ten demo cases` |
| T5 | S18-S21 | Cliente de Clef: cola, retry 429, timeout | `feat(worker): serialized clef client` |
| T6 | S17, S21 | Endpoints `/api/triage` y `/api/followup` | `feat(worker): triage and follow-up endpoints` |
| T7 | S1-S3, S8, S16 | Pantallas de turno y seguimiento | `feat(ui): triage and follow-up screens` |
| T8 | S9, S15 | Agenda e historial en `localStorage` | `feat(ui): local agenda and history` |
| T9 | S25 | Script de calibración | `chore(scripts): calibration against real clef` |
| T10 | S27 | README en español | `docs: add spanish README` |

## Log

L1. Pedido del usuario, textual: «cd ~/proyectos/vete-clef».
L2. `TAREA.md` (commit `790205f`) es el brief vinculante; sus specs se citan arriba textualmente.
L3. Bloqueo detectado y reportado: `POST /v1/systemone` con `model: "clef"` devuelve HTTP 404 `model_not_found`; `GET /v1/models` responde 200 con 5 modelos y **sin `clef`**; `POST /v1/chat/completions` con `deepseek-v4-flash` responde 200. La key es válida: falta el acceso al modelo.
L4. Decisión del usuario ante L3: «Sigo con todo lo que no necesita Clef» (opción 1). Los fixtures se marcan explícitamente como sintéticos (forma tomada de `docs/api.md`), nunca como respuestas grabadas.
L5. Decisión de orden de reglas del triage (interpretación propia, el brief no lo fija): emergencia (S4) → override de peluquería (S7) → ambigüedad de servicio (S6) → elección de turno (S5). Seguridad antes que confianza: un pedido de peluquería con señales de salud nunca termina en peluquería, ni siquiera si Clef está poco seguro del servicio.
L6. Riesgo abierto: `docs/api.md` pide verificar con una llamada real las claves de `probabilities` en `score`. Sin acceso, el parser acepta índices (`"0"`, `"1"`) y etiquetas. Verificar primero cuando aparezca el acceso.
L7. Node.js no existía en WSL. Instalado con `nvm` (sin sudo): v26.13.1 en `~/.nvm/versions/node/v26.13.1/bin`. Los shells no interactivos necesitan anteponer ese `bin` al `PATH`.
