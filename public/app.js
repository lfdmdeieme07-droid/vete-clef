'use strict';

/**
 * Vete Clef — browser frontend.
 *
 * Plain JavaScript: no framework, no build step. The only network calls are the
 * two Worker endpoints. Everything that comes from the owner, from Clef, or from
 * an error is rendered with `textContent`; this file never builds HTML.
 */

/* ---------------------------------------------------------------- constants */

const STORAGE_KEYS = {
  agenda: 'vete-clef:agenda:v1',
  history: 'vete-clef:followup-history:v1',
};

/** The Worker cuts free text at 4000 characters (src/config.js); mirror it here. */
const MAX_FREE_TEXT = 4000;
const MAX_AGE = 60;
const MAX_DAY = 365;
const MAX_HISTORY = 100;
const AGENDA_DAYS = 7;
const AGENDA_SLOTS_SHOWN = 3;

/** Clinic services with the ids the Worker uses, plus their demo agenda hours. */
const SERVICES = [
  {
    id: 'consulta',
    label: 'Consulta',
    hours: ['09:00', '10:30', '12:00', '15:00', '16:30', '18:00'],
    closedOnSunday: false,
  },
  {
    id: 'vacunacion',
    label: 'Vacunación',
    hours: ['09:30', '11:00', '16:00'],
    closedOnSunday: true,
  },
  {
    id: 'castracion',
    label: 'Castración',
    hours: ['10:00', '15:30'],
    closedOnSunday: true,
  },
  {
    id: 'peluqueria',
    label: 'Peluquería',
    hours: ['09:00', '11:30', '17:00'],
    closedOnSunday: true,
  },
  {
    id: 'control',
    label: 'Control',
    hours: ['08:30', '13:00', '17:30'],
    closedOnSunday: false,
  },
];

const SERVICE_LABEL = new Map(SERVICES.map((service) => [service.id, service.label]));

/** `timing.byLevel` is index-keyed: 0 is the farthest slot, 3 is today. */
const TIMING_LEVELS = ['Más de una semana', 'Esta semana', 'En 48 horas', 'Hoy'];

/** The legend labels from the Clef prompt, in case the Worker forwards them. */
const TIMING_LEVELS_BY_LEGEND = new Map([
  ['More than a week can wait', 'Más de una semana'],
  ['This week', 'Esta semana'],
  ['Within 48 hours', 'En 48 horas'],
  ['Today', 'Hoy'],
]);

const FOLLOWUP_ACTION_LABELS = new Map([
  ['seguir_plan', 'Seguir el plan'],
  ['consultar', 'Llamar al veterinario'],
  ['guardia', 'Guardia'],
]);

const FOLLOWUP_ROUTES = {
  guardia: { title: 'Guardia ya', badge: 'Urgente', icon: '⚠', tone: 'danger' },
  consultar: { title: 'Llamá a tu veterinario hoy', badge: 'Hoy', icon: '☎', tone: 'warn' },
  seguir_plan: { title: 'Seguí el plan de tu veterinario', badge: 'Plan', icon: '✓', tone: 'ok' },
};

/** Trigger codes the follow-up rules return, in owner-facing words. */
const TRIGGER_LABELS = new Map([
  ['red_flags', 'Clef vio señales de alerta en el reporte de hoy'],
  ['guardia_probability', 'Clef se inclinó fuerte por la guardia'],
  ['worse', 'Clef cree que tu mascota está empeorando'],
  ['consultar_probability', 'Clef se inclinó por consultar'],
]);

const TRIAGE_BUTTON_LABEL = 'Ver qué decide Clef';
const FOLLOWUP_BUTTON_LABEL = 'Ver qué decide Clef hoy';
const BUSY_LABEL = 'Clef está decidiendo…';

const NEUTRAL_ERROR = 'No pudimos consultar a Clef. Revisá la conexión e intentá de nuevo.';
const INCOMPLETE_ERROR = 'La respuesta de Clef llegó incompleta. Probá de nuevo.';

/* ------------------------------------------------------------ date helpers */

const longDateFormatter = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const shortDateFormatter = new Intl.DateTimeFormat('es-AR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const stampFormatter = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Local calendar date as `YYYY-MM-DD`; never UTC, so "today" matches the owner. */
function localDateISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseLocalDate(dateISO) {
  const [year, month, day] = String(dateISO).split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function capitalize(text) {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function formatLongDate(dateISO) {
  return capitalize(longDateFormatter.format(parseLocalDate(dateISO)));
}

/** Short label for agenda chips: "Hoy 09:00", "Mañana 11:30", "lun 17/11 09:00". */
function describeSlot(dateISO, time) {
  const today = localDateISO(new Date());
  const tomorrow = localDateISO(addDays(startOfDay(new Date()), 1));
  if (dateISO === today) return `Hoy ${time}`;
  if (dateISO === tomorrow) return `Mañana ${time}`;
  return `${capitalize(shortDateFormatter.format(parseLocalDate(dateISO)))} ${time}`;
}

function formatStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return stampFormatter.format(date);
}

/* ----------------------------------------------------------------- storage */

/**
 * A mirror of the keys this app writes. It is the fallback agenda when
 * `localStorage` is unavailable (private mode, quota, disabled storage), so the
 * app keeps working instead of throwing.
 */
const memoryStore = new Map();

function readStorage(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) return raw;
  } catch (error) {
    /* Fall through to the in-memory mirror. */
  }
  return memoryStore.has(key) ? memoryStore.get(key) : null;
}

function writeStorage(key, value) {
  memoryStore.set(key, value);
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

function readJsonStorage(key) {
  const raw = readStorage(key);
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function writeJsonStorage(key, value) {
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch (error) {
    return false;
  }
  return writeStorage(key, raw);
}

/* ------------------------------------------------------------------ agenda */

function isAgenda(value) {
  return Boolean(value) && value.version === 1 && typeof value.weekStart === 'string'
    && value.slots !== null && typeof value.slots === 'object'
    && Array.isArray(value.bookings);
}

/**
 * One week of slots per service, built with fixed rules so the same week always
 * looks the same. `weekStart` is the local date of generation: a stale agenda
 * from yesterday is regenerated instead of offering past slots.
 */
function buildAgenda(now) {
  const start = startOfDay(now ?? new Date());
  const slots = {};

  SERVICES.forEach((service, serviceIndex) => {
    const list = [];
    for (let dayOffset = 0; dayOffset < AGENDA_DAYS; dayOffset += 1) {
      const date = addDays(start, dayOffset);
      if (date.getDay() === 0 && service.closedOnSunday) continue;
      const dateISO = localDateISO(date);
      service.hours.forEach((time, hourIndex) => {
        // Fixed gaps keep the grid from looking artificial without randomness.
        const taken = (dayOffset * 3 + hourIndex * 2 + serviceIndex) % 7 === 0;
        if (taken && service.hours.length > 1) return;
        list.push({ id: `${service.id}@${dateISO}T${time}`, dateISO, time });
      });
    }
    slots[service.id] = list;
  });

  return { version: 1, weekStart: localDateISO(start), slots, bookings: [] };
}

function loadAgenda() {
  const stored = readJsonStorage(STORAGE_KEYS.agenda);
  if (isAgenda(stored) && stored.weekStart === localDateISO(new Date())) return stored;
  // Bookings live with their week: a new week starts with a clean agenda.
  const agenda = buildAgenda();
  writeJsonStorage(STORAGE_KEYS.agenda, agenda);
  return agenda;
}

function saveAgenda(agenda) {
  writeJsonStorage(STORAGE_KEYS.agenda, agenda);
}

function bookedSlotIds(agenda) {
  const ids = new Set();
  for (const booking of agenda.bookings) {
    if (booking !== null && typeof booking === 'object' && typeof booking.id === 'string') {
      ids.add(booking.id);
    }
  }
  return ids;
}

function freeSlots(agenda, serviceId) {
  const slots = Array.isArray(agenda.slots[serviceId]) ? agenda.slots[serviceId] : [];
  const booked = bookedSlotIds(agenda);
  return slots.filter((slot) => slot !== null && typeof slot === 'object' && !booked.has(slot.id));
}

/**
 * The first free slot of a service. By default the clinic starts booking from
 * tomorrow; only `preferToday` (Clef asked for today) moves today's slot first.
 */
function pickSlot(agenda, serviceId, preferToday) {
  const today = localDateISO(new Date());
  const free = freeSlots(agenda, serviceId);
  const todaySlot = free.find((slot) => slot.dateISO === today) ?? null;
  const laterSlot = free.find((slot) => slot.dateISO > today) ?? null;

  if (preferToday && todaySlot !== null) return { slot: todaySlot, offeredToday: true };
  const slot = laterSlot ?? todaySlot;
  return { slot: slot ?? null, offeredToday: false };
}

/** Books the first free slot of a service and persists it. Returns null if full. */
function bookService(serviceId, preferToday) {
  const agenda = loadAgenda();
  const { slot, offeredToday } = pickSlot(agenda, serviceId, preferToday === true);
  if (slot === null) return null;

  const booking = {
    id: slot.id,
    service: serviceId,
    dateISO: slot.dateISO,
    time: slot.time,
    preferToday: offeredToday,
    at: new Date().toISOString(),
  };
  agenda.bookings.push(booking);
  saveAgenda(agenda);
  return booking;
}

/* ----------------------------------------------------------------- history */

function isHistoryEntry(value) {
  return Boolean(value) && typeof value === 'object'
    && Number.isInteger(value.day) && typeof value.plan === 'string'
    && typeof value.report === 'string' && typeof value.route === 'string';
}

function loadHistory() {
  const stored = readJsonStorage(STORAGE_KEYS.history);
  if (!Array.isArray(stored)) return [];
  return stored.filter(isHistoryEntry).slice(-MAX_HISTORY);
}

function saveHistoryEntry(entry) {
  const history = loadHistory();
  history.push(entry);
  const kept = history.slice(-MAX_HISTORY);
  writeJsonStorage(STORAGE_KEYS.history, kept);
  return kept;
}

/* ------------------------------------------------------------ dom building */

function byId(id) {
  return document.getElementById(id);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Replaces a container's content with fresh nodes; never parses markup. */
function fill(container, nodes) {
  if (!container) return;
  container.replaceChildren(...nodes);
}

function detailRow(label, value) {
  const row = element('div', 'detail');
  row.append(element('dt', null, label), element('dd', null, value));
  return row;
}

/** A route panel: tone (colour) plus an icon and a word, so colour is not the only signal. */
function calloutPanel({ tone, icon, badge, title, body }) {
  const panel = element('section', `callout callout-${tone}`);
  panel.append(element('p', 'callout-badge', `${icon} ${badge}`));
  panel.append(element('h2', 'callout-title', title));
  for (const node of body) panel.append(node);
  return panel;
}

function noticeBlock(text) {
  const node = element('p', 'notice notice-inline', text);
  node.setAttribute('role', 'alert');
  return node;
}

function probabilityList(title, rows) {
  const section = element('section', 'probs');
  section.append(element('h3', 'probs-title', title));
  const list = element('ul', 'probs-list');
  for (const row of rows) {
    const item = element('li', 'prob');
    const bar = element('span', 'prob-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fillBar = element('span', 'prob-fill');
    fillBar.style.width = `${row.percent}%`;
    bar.append(fillBar);
    item.append(element('span', 'prob-label', row.label));
    item.append(element('span', 'prob-value', `${row.percent} %`));
    item.append(bar);
    list.append(item);
  }
  section.append(list);
  return section;
}

/* --------------------------------------------------------- payload readers */

/** Clef returns fractions; tolerate a 0-100 payload instead of printing 8700 %. */
function toPercent(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  const fraction = number > 1 ? number / 100 : number;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function payloadProbabilities(payload) {
  return isPlainObject(payload?.probabilities) ? payload.probabilities : {};
}

function serviceRows(byService) {
  const rows = SERVICES.filter((service) => isPlainObject(byService) && byService[service.id] !== undefined)
    .map((service) => ({ label: service.label, percent: toPercent(byService[service.id]) }));
  return rows.sort((a, b) => b.percent - a.percent);
}

function timingRows(byLevel) {
  if (!isPlainObject(byLevel)) return [];
  const rows = [];
  for (const [key, value] of Object.entries(byLevel)) {
    let label;
    let order;
    if (/^\d+$/.test(key)) {
      const index = Number(key);
      label = TIMING_LEVELS[index] ?? `Nivel ${key}`;
      order = index;
    } else {
      label = TIMING_LEVELS_BY_LEGEND.get(key) ?? key;
      order = 99;
    }
    rows.push({ label, percent: toPercent(value), order });
  }
  return rows.sort((a, b) => a.order - b.order);
}

function actionRows(byAction) {
  if (!isPlainObject(byAction)) return [];
  return Object.entries(byAction)
    .map(([id, value]) => ({
      label: FOLLOWUP_ACTION_LABELS.get(id) ?? id,
      percent: toPercent(value),
    }))
    .sort((a, b) => b.percent - a.percent);
}

/** The transparency block: emergency line plus service and timing probabilities. */
function triageProbabilityNodes(probabilities) {
  const nodes = [];
  nodes.push(element('p', 'emergency-line', `Emergencia: ${toPercent(probabilities.emergency)} %`));

  const service = isPlainObject(probabilities.service) ? probabilities.service : {};
  const byService = isPlainObject(service.byService) ? service.byService : service.probabilities;
  const services = serviceRows(byService);
  if (services.length > 0) nodes.push(probabilityList('Servicio que Clef cree que necesitás', services));
  if (typeof service.confidence === 'number') {
    nodes.push(element('p', 'hint', `Confianza con el servicio elegido: ${toPercent(service.confidence)} %`));
  }

  const timing = isPlainObject(probabilities.timing) ? probabilities.timing : {};
  const levels = timingRows(isPlainObject(timing.byLevel) ? timing.byLevel : timing.probabilities);
  if (levels.length > 0) nodes.push(probabilityList('Cuándo conviene el turno', levels));

  return nodes;
}

function followupProbabilityNodes(probabilities) {
  const nodes = [];
  nodes.push(element('p', 'emergency-line', `Señales de alerta: ${toPercent(probabilities.redFlags)} %`));
  nodes.push(element('p', 'hint', `Empeorando: ${toPercent(probabilities.worse)} %`));

  const action = isPlainObject(probabilities.action) ? probabilities.action : {};
  const byAction = isPlainObject(action.byAction) ? action.byAction : action.probabilities;
  const rows = actionRows(byAction);
  if (rows.length > 0) nodes.push(probabilityList('Qué conviene hacer hoy', rows));

  return nodes;
}

/* ---------------------------------------------------------- triage rendering */

function overrideExplanation(overridden) {
  const from = SERVICE_LABEL.get(overridden?.from) ?? 'ese servicio';
  const to = SERVICE_LABEL.get(overridden?.to) ?? 'consulta';
  return element(
    'p',
    'override',
    `Clef cambió el servicio: ${from} → ${to}. Un pedido de peluquería con señales de salud pasa siempre a consulta con el veterinario.`,
  );
}

function bookingNodes({ serviceId, booking, preferToday, overridden, probabilities, chosenByOwner }) {
  const nodes = [];
  if (overridden !== null && overridden !== undefined) nodes.push(overrideExplanation(overridden));

  const details = element('dl', 'details');
  details.append(detailRow('Servicio', SERVICE_LABEL.get(serviceId) ?? serviceId));
  details.append(detailRow('Turno', `${formatLongDate(booking.dateISO)}, ${booking.time}`));

  let todayText;
  if (booking.preferToday) todayText = 'Sí. Clef pidió adelantar el turno a hoy.';
  else if (preferToday) todayText = 'Clef pidió hoy, pero hoy no quedaba turno libre: te damos el primero de la semana.';
  else todayText = 'No. Clef no pidió adelantar el turno: es el primer turno libre de la semana.';
  details.append(detailRow('¿Hoy primero?', todayText));

  if (chosenByOwner) details.append(detailRow('Servicio elegido', 'Lo elegiste vos porque Clef dudaba.'));

  const body = [details];
  body.push(...triageProbabilityNodes(probabilities));

  nodes.push(calloutPanel({
    tone: 'accent',
    icon: '✓',
    badge: 'Turno reservado',
    title: 'Turno reservado',
    body,
  }));
  return nodes;
}

function chooseServiceNodes(options, payload) {
  const nodes = [];
  nodes.push(element('p', 'result-lead', 'Clef duda entre dos servicios. Elegí vos cuál te sirve:'));
  const group = element('div', 'options');
  for (const option of options) {
    const label = SERVICE_LABEL.get(option.id) ?? option.id;
    const button = element('button', 'button button-option', `${label} · ${toPercent(option.probability)} %`);
    button.type = 'button';
    button.addEventListener('click', () => {
      chooseService(option.id, payload);
    });
    group.append(button);
  }
  nodes.push(group);
  nodes.push(...triageProbabilityNodes(payloadProbabilities(payload)));
  return nodes;
}

function renderTriage(payload) {
  const container = byId('triage-result');
  if (!isPlainObject(payload)) {
    fill(container, [noticeBlock(INCOMPLETE_ERROR)]);
    return;
  }

  const probabilities = payloadProbabilities(payload);

  if (payload.route === 'guardia') {
    // S4: the emergency screen books nothing and offers no booking UI at all.
    const body = [element('p', 'callout-note', 'Clef vio riesgo de emergencia. No hay turno para reservar.')];
    body.push(...triageProbabilityNodes(probabilities));
    fill(container, [calloutPanel({
      tone: 'danger',
      icon: '⚠',
      badge: 'Urgente',
      title: 'Andá ya a la guardia veterinaria',
      body,
    })]);
    return;
  }

  if (payload.route === 'booking') {
    const serviceId = typeof payload.service === 'string' ? payload.service : null;
    if (serviceId === null || !SERVICE_LABEL.has(serviceId)) {
      fill(container, [noticeBlock(INCOMPLETE_ERROR)]);
      return;
    }
    const preferToday = payload.preferToday === true;
    const booking = bookService(serviceId, preferToday);
    if (booking === null) {
      fill(container, [noticeBlock('No quedan turnos libres en la agenda de demo para ese servicio.')]);
      return;
    }
    fill(container, bookingNodes({
      serviceId,
      booking,
      preferToday,
      overridden: payload.overridden ?? null,
      probabilities,
      chosenByOwner: false,
    }));
    renderAgenda();
    return;
  }

  if (payload.route === 'choose_service') {
    const options = Array.isArray(payload.options)
      ? payload.options.filter((option) => isPlainObject(option) && typeof option.id === 'string' && SERVICE_LABEL.has(option.id))
      : [];
    if (options.length === 0) {
      fill(container, [noticeBlock(INCOMPLETE_ERROR)]);
      return;
    }
    fill(container, chooseServiceNodes(options.slice(0, 2), payload));
    return;
  }

  fill(container, [noticeBlock(INCOMPLETE_ERROR)]);
}

/** The owner picked one of the two services Clef offered; that pick books it. */
function chooseService(serviceId, payload) {
  if (!SERVICE_LABEL.has(serviceId) || !isPlainObject(payload)) return;
  const container = byId('triage-result');
  const preferToday = payload.preferToday === true;
  const booking = bookService(serviceId, preferToday);
  if (booking === null) {
    fill(container, [noticeBlock('No quedan turnos libres en la agenda de demo para ese servicio.')]);
    return;
  }
  fill(container, bookingNodes({
    serviceId,
    booking,
    preferToday,
    overridden: payload.overridden ?? null,
    probabilities: payloadProbabilities(payload),
    chosenByOwner: true,
  }));
  renderAgenda();
}

/* -------------------------------------------------------- follow-up rendering */

function triggerLine(triggers) {
  if (!Array.isArray(triggers) || triggers.length === 0) return null;
  const words = triggers
    .filter((trigger) => typeof trigger === 'string' && TRIGGER_LABELS.has(trigger))
    .map((trigger) => TRIGGER_LABELS.get(trigger));
  if (words.length === 0) return null;
  return element('p', 'hint', `Clef decidió por: ${words.join('; ')}.`);
}

/**
 * Renders one follow-up decision. Returns true when the route is known, so the
 * caller only stores a history entry for a real decision.
 */
function renderFollowup(payload, entry) {
  const container = byId('followup-result');
  if (!isPlainObject(payload)) {
    fill(container, [noticeBlock(INCOMPLETE_ERROR)]);
    return false;
  }

  const spec = FOLLOWUP_ROUTES[payload.route];
  if (!spec) {
    fill(container, [noticeBlock(INCOMPLETE_ERROR)]);
    return false;
  }

  const probabilities = payloadProbabilities(payload);
  const body = [];

  if (payload.route === 'guardia') {
    body.push(element('p', 'callout-note', 'Clef vio señales de alerta en el reporte de hoy.'));
  } else if (payload.route === 'consultar') {
    body.push(element(
      'p',
      'callout-note',
      'Clef no marcó una urgencia, pero sí algo que conviene hablar hoy con tu veterinario.',
    ));
  } else {
    // S14: echo the vet's plan exactly as the owner wrote it. No advice of ours.
    body.push(element('p', 'callout-note', 'Tu plan, tal como lo escribiste:'));
    body.push(element('blockquote', 'plan-echo', entry.plan));
  }

  const triggers = triggerLine(payload.triggers);
  if (triggers !== null) body.push(triggers);
  body.push(...followupProbabilityNodes(probabilities));

  fill(container, [calloutPanel({
    tone: spec.tone,
    icon: spec.icon,
    badge: spec.badge,
    title: spec.title,
    body,
  })]);
  return true;
}

/* -------------------------------------------------------------- screen bits */

function renderHistory() {
  const list = byId('followup-history');
  if (!list) return;

  const history = loadHistory();
  const nodes = [];
  for (const entry of history) {
    const item = element('li', 'history-entry');
    const stamp = formatStamp(entry.at);
    const routeSpec = FOLLOWUP_ROUTES[entry.route];
    const routeWord = routeSpec ? routeSpec.title : entry.route;
    const head = element('p', 'history-head');
    head.append(element('span', 'history-day', `Día ${entry.day}`));
    if (stamp !== '') head.append(element('span', 'history-stamp', stamp));
    head.append(element('span', 'history-route', routeWord));
    item.append(head);
    item.append(element('p', 'history-report', entry.report));
    nodes.push(item);
  }
  if (nodes.length === 0) nodes.push(element('li', 'hint', 'Todavía no hay días guardados.'));
  fill(list, nodes);
}

function renderAgenda() {
  const container = byId('agenda-list');
  if (!container) return;

  const agenda = loadAgenda();
  const nodes = [];

  const bookings = agenda.bookings.filter((booking) => booking !== null && typeof booking === 'object');
  if (bookings.length > 0) {
    const list = element('ul', 'bookings');
    for (const booking of bookings) {
      const label = SERVICE_LABEL.get(booking.service) ?? booking.service;
      list.append(element(
        'li',
        'booking',
        `${label} · ${formatLongDate(booking.dateISO)}, ${booking.time}`,
      ));
    }
    nodes.push(element('h3', 'agenda-title', 'Tus reservas'));
    nodes.push(list);
  }

  for (const service of SERVICES) {
    const free = freeSlots(agenda, service.id).slice(0, AGENDA_SLOTS_SHOWN);
    const card = element('div', 'agenda-service');
    card.append(element('h3', 'agenda-title', service.label));
    const list = element('ul', 'agenda-slots');
    if (free.length === 0) {
      list.append(element('li', 'hint', 'Sin turnos libres esta semana.'));
    } else {
      for (const slot of free) {
        const item = element('li', 'slot', describeSlot(slot.dateISO, slot.time));
        list.append(item);
      }
    }
    card.append(list);
    nodes.push(card);
  }

  fill(container, nodes);
}

/* ------------------------------------------------------------------ requests */

class ApiError extends Error {
  constructor(message) {
    super(typeof message === 'string' && message.trim() !== '' ? message.trim() : 'api_error');
    this.name = 'ApiError';
    this.userMessage = typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
  }
}

/** Posts JSON and returns the parsed body, or throws an ApiError with the server's message. */
async function postJson(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Offline, blocked, or opened from file://: never surface the raw error.
    throw new ApiError(null);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const message = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error.message : null;
    throw new ApiError(typeof message === 'string' ? message : null);
  }
  if (!isPlainObject(payload)) throw new ApiError(null);
  return payload;
}

/** Only a server-provided message or a neutral Spanish sentence reaches the screen. */
function describeError(error) {
  if (error instanceof ApiError && error.userMessage !== null) return error.userMessage;
  return NEUTRAL_ERROR;
}

/* ------------------------------------------------------------------ notices */

function showNotice(container, text) {
  if (!container) return;
  container.textContent = text;
  container.hidden = false;
}

function hideNotice(container) {
  if (!container) return;
  container.textContent = '';
  container.hidden = true;
}

function setBusy(button, busy, idleLabel) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? BUSY_LABEL : idleLabel;
}

function focusFirst(selector, fallbackId) {
  const matches = document.querySelectorAll(selector);
  for (const match of matches) {
    if (typeof match.focus === 'function') {
      match.focus();
      return;
    }
  }
  const fallback = byId(fallbackId);
  if (fallback && typeof fallback.focus === 'function') fallback.focus();
}

function readSpecies() {
  const inputs = document.querySelectorAll('input[name="species"]');
  for (const input of inputs) {
    if (input.checked) return input.value;
  }
  return null;
}

/* -------------------------------------------------------------- triage flow */

async function handleTriageSubmit(event) {
  event.preventDefault();

  const notice = byId('triage-notice');
  hideNotice(notice);

  const button = byId('triage-submit');
  if (button && button.disabled) return;

  const species = readSpecies();
  const age = byId('triage-age').value.trim().slice(0, MAX_AGE);
  const message = byId('triage-message').value.trim().slice(0, MAX_FREE_TEXT);

  if (species === null) {
    showNotice(notice, 'Elegí la especie de tu mascota.');
    focusFirst('input[name="species"]', 'triage-message');
    return;
  }
  if (message === '') {
    showNotice(notice, 'Contanos qué le pasa antes de pedir el turno.');
    focusFirst('#triage-message', 'triage-message');
    return;
  }

  const container = byId('triage-result');
  setBusy(button, true, TRIAGE_BUTTON_LABEL);
  container.setAttribute('aria-busy', 'true');
  fill(container, [element('p', 'loading', 'Clef está pensando. Puede tardar unos segundos.')]);

  try {
    const payload = await postJson('/api/triage', { species, age, message });
    renderTriage(payload);
  } catch (error) {
    fill(container, [noticeBlock(describeError(error))]);
  } finally {
    container.removeAttribute('aria-busy');
    setBusy(button, false, TRIAGE_BUTTON_LABEL);
  }
}

/* ------------------------------------------------------------ follow-up flow */

async function handleFollowupSubmit(event) {
  event.preventDefault();

  const notice = byId('followup-notice');
  hideNotice(notice);

  const button = byId('followup-submit');
  if (button && button.disabled) return;

  const plan = byId('followup-plan').value.trim().slice(0, MAX_FREE_TEXT);
  const report = byId('followup-report').value.trim().slice(0, MAX_FREE_TEXT);
  const day = Number.parseInt(byId('followup-day').value.trim(), 10);

  if (plan === '') {
    showNotice(notice, 'Escribí el plan que te dio tu veterinario.');
    focusFirst('#followup-plan', 'followup-plan');
    return;
  }
  if (!Number.isInteger(day) || day < 1 || day > MAX_DAY) {
    showNotice(notice, `Escribí el día del plan con un número entre 1 y ${MAX_DAY}.`);
    focusFirst('#followup-day', 'followup-day');
    return;
  }
  if (report === '') {
    showNotice(notice, 'Contanos cómo está hoy antes de consultar.');
    focusFirst('#followup-report', 'followup-report');
    return;
  }

  const container = byId('followup-result');
  setBusy(button, true, FOLLOWUP_BUTTON_LABEL);
  container.setAttribute('aria-busy', 'true');
  fill(container, [element('p', 'loading', 'Clef está pensando. Puede tardar unos segundos.')]);

  try {
    const payload = await postJson('/api/followup', { plan, day, report });
    const rendered = renderFollowup(payload, { plan, day, report });
    if (rendered) {
      // Stored shape is exactly { day, plan, report, route, at }.
      saveHistoryEntry({ day, plan, report, route: payload.route, at: new Date().toISOString() });
      renderHistory();
    }
  } catch (error) {
    fill(container, [noticeBlock(describeError(error))]);
  } finally {
    container.removeAttribute('aria-busy');
    setBusy(button, false, FOLLOWUP_BUTTON_LABEL);
  }
}

/* ---------------------------------------------------------------- tab logic */

function setupTabs() {
  const tablist = byId('tablist');
  const tabs = [
    { tab: byId('tab-triage'), panel: byId('panel-triage') },
    { tab: byId('tab-followup'), panel: byId('panel-followup') },
  ].filter((entry) => entry.tab && entry.panel);

  if (tabs.length === 0) return;

  const select = (index, moveFocus) => {
    tabs.forEach((entry, i) => {
      const selected = i === index;
      entry.tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      entry.tab.tabIndex = selected ? 0 : -1;
      entry.panel.hidden = !selected;
    });
    if (moveFocus && typeof tabs[index].tab.focus === 'function') tabs[index].tab.focus();
  };

  tabs.forEach((entry, index) => {
    entry.tab.addEventListener('click', () => {
      select(index, false);
    });
  });

  if (tablist) {
    tablist.addEventListener('keydown', (event) => {
      const current = tabs.findIndex((entry) => entry.tab.getAttribute('aria-selected') === 'true');
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        select((Math.max(current, 0) + 1) % tabs.length, true);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        select((Math.max(current, 0) - 1 + tabs.length) % tabs.length, true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(0, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        select(tabs.length - 1, true);
      }
    });
  }
}

/* --------------------------------------------------------------------- init */

function init() {
  const triageForm = byId('triage-form');
  if (triageForm) triageForm.addEventListener('submit', handleTriageSubmit);

  const followupForm = byId('followup-form');
  if (followupForm) followupForm.addEventListener('submit', handleFollowupSubmit);

  setupTabs();
  renderAgenda();
  renderHistory();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
