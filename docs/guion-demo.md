# Guion de demo — 3 minutos

Para el jurado del hackathon y para la reunión con el veterinario. Los dos
públicos son distintos: al jurado hay que mostrarle **que Clef decide**; al
veterinario, **que la consulta deja rastro**.

## Antes de empezar

- La app en pantalla, tamaño teléfono. Nada de escritorio: es mobile-first.
- Si Clef todavía no está habilitado, decirlo en la primera frase, sin vueltas:
  «Clef no está disponible en nuestra cuenta todavía, así que esto corre con
  respuestas de ejemplo. La lógica de decisión, la validación y las pantallas
  son el código real; lo único reemplazado es la llamada al modelo.» Decirlo
  primero te da credibilidad; que lo descubran ellos te la quita.

## 1. El problema (15 s)

> «Un cachorro de 45 días con diarrea. El veterinario indicó arroz tres días y
> después ir agregando alimento. El plan estaba bien. El problema era otro: el
> dueño, día por día, no sabía si seguir con el plan o llamar. Dudar de más
> también es un riesgo.»

No expliques la app todavía. Que el problema quede claro primero.

## 2. Qué es Clef (20 s)

> «Clef no escribe texto. Le das un estado y preguntas tipadas, y devuelve
> probabilidades. Tres tipos: sí o no, elegir entre opciones, y puntuar en una
> escala. Nosotros le hacemos tres preguntas en una sola llamada y la app decide
> con esas probabilidades.»

Si te preguntan por qué eso importa: **la decisión es un número, no una frase**.
Se puede mostrar, auditar y discutir. Un chat no.

## 3. Caso 1 — el chocolate (30 s)

Escribir: `Mi perro se comió una barra de chocolate hace una hora y está temblando`

Pantalla roja: **«Andá ya a la guardia veterinaria»**, Emergencia 87 %.

> «El umbral está en 0.20 y no en 0.80 a propósito: ante la duda, que vaya. No se
> reserva ningún turno. Si nos equivocamos acá, el costo es una espera en la
> guardia; si nos equivocamos al revés, el costo es el perro.»

## 4. Caso 2 — la app contradice al modelo (40 s) ← el momento fuerte

Escribir: `Quiero bañarlo, pero vomitó dos veces hoy`

Clef dice peluquería con 72 %. **La app lo cambia a consulta y explica por qué.**

> «Acá está la parte que más nos importa. Clef dijo peluquería. Nosotros no le
> creemos, porque hay señales de salud. La regla de seguridad corre antes que la
> confianza del modelo: si alguien pide baño y hay vómitos, el caso va a consulta.
> El orden de las reglas es una decisión de producto, está documentada y tiene
> sus tests: seguridad antes que confianza.»

Este es el beat que separa «envoltorio de un modelo» de «producto».

## 5. Caso 3 — el seguimiento (40 s)

Plan: `arroz 3 días, después agregar alimento de a poco`

- Día 2, `toma agua solo, la caca está más firme, come poquito` → **Seguí el plan**
- Día 3, `no quiere tomar agua, está decaído y la caca tiene sangre` → **Guardia ya**
- Día 4, `sigue con diarrea igual que el primer día, pero toma agua y juega` → **Llamá a tu veterinario hoy**

> «El plan lo repite tal como lo escribió el dueño. La app no agrega consejo
> médico propio: nunca. Solo decide si el plan alcanza o no. Y cada día queda
> guardado, que es justo lo que hoy se pierde.»

## 6. Cierre (20 s)

> «Dos pantallas, un Worker, HTML y CSS planos. Las reglas de decisión son
> funciones puras: 66 tests, sin red, sin el modelo. El modelo es la única pieza
> que puede fallar, así que está aislada y la app degrada con un mensaje claro en
> vez de romperse. Y las probabilidades se muestran siempre: el dueño ve cuánto
> se está jugando Clef.»

Terminá con lo que falta, no con una promesa:

> «Falta el acceso al modelo en nuestra cuenta de NaN. En cuanto esté, corremos
> la calibración con los diez casos y ajustamos los umbrales con datos.»

## Preguntas que te van a hacer

**«¿Esto reemplaza al veterinario?»** No. No diagnostica, no receta, no da dosis.
Decide a dónde va el caso y cuándo escalar. La regla más conservadora del sistema
es justamente mandar a la guardia ante la duda.

**«¿Y si el modelo se equivoca?»** Por eso las reglas son deterministas y están
testeadas aparte del modelo: el modelo aporta probabilidades, la app decide con
umbrales explícitos. Y por eso falta la calibración: hoy los umbrales salen del
brief, no de datos.

**«¿Por qué no usaron un LLM?»** Porque necesitábamos una probabilidad, no una
redacción. Un texto no se audita; un 0.87 sí.

## Para el veterinario (otra conversación, otro orden)

1. Mostrale el **seguimiento**, no el triage. Es lo que hoy se le pierde.
2. Preguntale qué anota y qué se queda en el aire.
3. Preguntale qué frase exacta quiere que la app le diga a un dueño.
4. No le ofrezcas la app del hackathon como producto: es un prototipo. Lo que hay
   para ofrecer es el historial clínico, que todavía no está construido.
