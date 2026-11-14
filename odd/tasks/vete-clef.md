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
| T1 | S17, S22, S27 | Config del proyecto y feature doc | `93da05f` + `631aeaf` |
| T2 | S4-S7, S22, S26 | Reglas puras del triage, test-first | `0e64d46` |
| T3 | S12-S14, S22, S26 | Reglas puras del seguimiento, test-first | `c0d1388` |
| T4 | S23 | Los 10 casos de demo con ruta esperada | `11d0449` |
| T5 | S18-S21 | Cliente de Clef: cola, retry 429, timeout | `0486e37` |
| T6 | S17, S21 | Endpoints `/api/triage` y `/api/followup` | `a7fb452` |
| T7 | S1-S3, S8, S16 | Pantallas de turno y seguimiento | `24ea852` |
| T8 | S9, S15 | Agenda e historial en `localStorage` | `24ea852` |
| T9 | S25 | Script de calibración | `51127a1` |
| T10 | S27 | README en español | `d0c5068` |

## Log

L1. Pedido del usuario, textual: «cd ~/proyectos/vete-clef».
L2. `TAREA.md` (commit `790205f`) es el brief vinculante; sus specs se citan arriba textualmente.
L3. Bloqueo detectado y reportado: `POST /v1/systemone` con `model: "clef"` devuelve HTTP 404 `model_not_found`; `GET /v1/models` responde 200 con 5 modelos y **sin `clef`**; `POST /v1/chat/completions` con `deepseek-v4-flash` responde 200. La key es válida: falta el acceso al modelo. **Confirmado por los docs oficiales** (`docs/api.md`, tabla de errores): `404` = «No tienes acceso», y la autenticación es solo `Authorization: Bearer <key>` — «usa la misma key de NaN que ya tienes para los modelos de chat, no necesitas ninguna key nueva». El correo de la cuenta no interviene en la autorización, así que cambiar el email de la suscripción no habilita el modelo: el permiso vive en la cuenta y su plan, no en la dirección. El camino documentado para un 404 es el canal del hackathon en Discord.
L4. Decisión del usuario ante L3: «Sigo con todo lo que no necesita Clef» (opción 1). Los fixtures se marcan explícitamente como sintéticos (forma tomada de `docs/api.md`), nunca como respuestas grabadas.
L5. Decisión de orden de reglas del triage (interpretación propia, el brief no lo fija): emergencia (S4) → override de peluquería (S7) → ambigüedad de servicio (S6) → elección de turno (S5). Seguridad antes que confianza: un pedido de peluquería con señales de salud nunca termina en peluquería, ni siquiera si Clef está poco seguro del servicio.
L6. Riesgo abierto: `docs/api.md` pide verificar con una llamada real las claves de `probabilities` en `score`. Sin acceso, el parser acepta índices (`"0"`, `"1"`) y etiquetas. Verificar primero cuando aparezca el acceso.
L7. Node.js no existía en WSL. Instalado con `nvm` (sin sudo): v26.13.1 en `~/.nvm/versions/node/v26.13.1/bin`. Los shells no interactivos necesitan anteponer ese `bin` al `PATH`.
L8. Bug encontrado al revisar el payload y no por los tests: el Worker mandaba `questions` como lista y `docs/api.md` exige un mapa `id → pregunta`. Corregido con `questionsPayload` y fijado con `test/payload.test.js` (5 tests). Con Clef habilitado, la primera llamada real habría dado 400. Incluido en `a7fb452`.
L9. Verificación local con `wrangler dev` (no deploy): assets 200, los tres 400 de validación, `/api/nope` 404 JSON, y `/api/triage` y `/api/followup` devolviendo 502 `clef_no_access` desde la API real de NaN. Esa llamada prueba el camino completo salvo el modelo: validación, cliente, `AbortSignal` dentro de workerd, y mapeo de error.
L10. Identidad git configurada solo en este repo (decisión del usuario): nombre «Fabi», email `236066976+lfdmdeieme07-droid@users.noreply.github.com`. La configuración global queda sin tocar.
L11. Capturas del README: diferidas por decisión del usuario a después de habilitar Clef, tomadas desde el Chrome de Windows. No se instala navegador en WSL.
L12. Estado de los tests por commit, verificado en worktrees aislados: `0e64d46` 16 verdes, `c0d1388` 27, `a7fb452` 66, y los dos primeros commits son documentación y scaffolding sin tests.
L13. Decisión de producto (14/11/2026), **fuera del alcance del hackathon**: esta versión no está lista para una veterinaria real. Evidencia registrada: (a) los umbrales salen del brief y nunca se calibraron contra Clef real; (b) `localStorage` no es persistencia clínica — se borra, no se comparte, no hay historial del paciente; (c) no hay usuarios, roles ni dueño de los datos; (d) no hay registro de auditoría de lo que decidió el modelo; (e) el veterinario no tiene interfaz y no ve nada de esto; (f) S20 serializa las llamadas, así que el throughput de una clínica queda capado por el modelo: con timeout de 50 s, cinco mensajes encolados son cuatro minutos de espera. Los docs confirman que la concurrencia es **una petición a la vez por persona**, no por key: ni comprando varias keys se resuelve, el límite es de la cuenta.
    Condición para uso real, en este orden: 1) medir falsos negativos en emergencias con 50-100 casos revisados por un veterinario — si ese número no es cero o casi cero, no se despliega; 2) un veterinario responsable que firme el protocolo, más términos, política de datos y contrato con la clínica que declaren **soporte a la decisión, no acto médico**; 3) piloto de una semana en una clínica en modo lectura, donde la app ordena y la recepcionista confirma o ignora.
    Dirección de producto recomendada: no la app para el dueño, sino el **panel para la recepción** — la app lee los mensajes que entran, los ordena por urgencia y arma una cola priorizada; el humano decide siempre. Menor riesgo (el modelo solo resuelve urgencia relativa, no medicina), mayor valor (ataca el «¿a quién atiendo primero?»), y genera datos de corrección del veterinario para calibrar de verdad.
L14. Modo demo local (**workaround, no requisito del brief**): `wrangler.demo.toml` + `dev/worker-demo.js` + `dev/demo-answers.json`, sin tocar una línea de `src/` ni de `public/`. Reemplaza solo el viaje a Clef por las respuestas sintéticas; la validación, las reglas puras y las pantallas son el código real. `run_worker_first = true` con `binding = "ASSETS"` inyecta el cartel «MODO DEMO» en el HTML servido, así `public/` queda byte a byte igual al entregable. Verificado con `npx wrangler dev --config wrangler.demo.toml`: los 10 casos de `cases/cases.json` dan la ruta esperada, 400 en validación, 405 en método incorrecto, `/styles.css` 200, y no necesita `NAN_KEY`. **Borrar los tres archivos antes de entregar**; `name = "vete-clef-demo"` evita que un deploy accidental pise el Worker real. Sirve para destrabar las capturas del README y para ensayar la demo mientras el acceso a `clef` sigue bloqueado (L3).
L15. Repo público creado y pusheado: `https://github.com/lfdmdeieme07-droid/vete-clef`, rama `main`, visibilidad pública. Autorización explícita del usuario: «si todo junto si hace falta push también». Autenticación con el `gh.exe` de Windows que el usuario ya tenía (`gh auth token` + `http.extraheader` con `x-access-token`): el token **no** queda en `.git/config`, en la URL del remoto ni en el historial de comandos. Verificado después del push: `.dev.vars` no está en el repo (`.gitignore` lo cubre junto con `.wrangler/`), y las 5 apariciones de `sk-` en el árbol son placeholders de test y de uso (`sk-...`, `sk-test-DO-NOT-LEAK-1234`), no la key real. Las 5 capturas viven en `docs/capturas/` y el README las referencia con rutas relativas.
L16. Defecto de copy encontrado al revisar la captura 04 y corregido en `5a345b0`: `TRIGGER_LABELS` escribía frases completas que se concatenaban detrás de un «Clef decidió por:», repitiendo lo que ya decía el párrafo de arriba. Ahora son razones cortas, y la nota de la ruta `guardia` ya no afirma una señal de alerta que pudo no haber disparado (la ruta también se alcanza solo por `p(guardia) >= 0.20`). Sin test: `public/` no tiene cobertura automática; se verificó regenerando la captura.
L17. Deploy a la cuenta real del usuario (`lfdm.deieme07@gmail.com`, account `dba6c37754fad618ffadb4ac3a727d79`, subdominio `lfdm-deieme07`): **https://vete-clef.lfdm-deieme07.workers.dev**. Verificado desde internet: assets 200, `/api/nope` 404, validación 400, y los dos endpoints `500 not_configured` porque falta el secret `NAN_KEY` — lo carga el usuario, porque el brief prohíbe que el agente setee secrets. Cero rastro del modo demo en producción. Antes del deploy real se probó el camino completo con `wrangler deploy --temporary` en una cuenta de preview, que se descartó sin reclamar; esa prueba valió: el deploy a la cuenta real no dio ninguna sorpresa y no pidió registrar subdominio, porque el usuario ya lo tenía (`lfdm-deieme07`, de `turnero-demo` y `radar-clientes`).
