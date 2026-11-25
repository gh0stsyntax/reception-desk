// Appointment logic for a voice agent (Vapi tools check_availability / book_appointment).
// Pure functions, no I/O, no dependencies: the SAME file is embedded into the n8n Code nodes
// (n8n/build_workflow.mjs) and used by the reference server (src/server.mjs).
//
// Conventions
//  * Dates are "YYYY-MM-DD", times "HH:MM", both in the salon's local time. Weekday: 0 = Sunday ... 6 = Saturday.
//  * `busy` is a list of {start, end} local timestamps "YYYY-MM-DDTHH:MM" (all-day events: start = "YYYY-MM-DD").
//  * Relative dates ("morgen", "nächsten Freitag") are resolved HERE from `requested_date_text`, never by the model.

const WEEKDAYS = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
};
const WEEKDAY_NAMES = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const NUMBER_WORDS = { eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12 };

const pad = (n) => String(n).padStart(2, "0");

function isoToUtc(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function utcToIso(dt) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function validIso(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return false;
  return utcToIso(isoToUtc(iso)) === iso;                      // rejects 2026-02-31
}
export function addDays(iso, n) {
  const dt = isoToUtc(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcToIso(dt);
}
export function weekdayOf(iso) {
  return isoToUtc(iso).getUTCDay();
}
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
export function fromMinutes(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

// ── parsing of what a caller said ───────────────────────────────────────────────────────────

/** Resolve a German date phrase against `todayIso`. Returns "YYYY-MM-DD" or null.
 *  A bare weekday ("Freitag") means the next such day from today on (today included);
 *  "nächsten Freitag" means strictly after today; "nächste Woche Freitag" is the Friday of the following Mon-Sun week. */
export function parseGermanDate(text, todayIso) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  let m;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return validIso(m[0]) ? m[0] : null;
  if ((m = t.match(/\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?/))) {
    const year = m[3] ? Number(m[3]) : Number(todayIso.slice(0, 4));
    let iso = `${year}-${pad(m[2])}-${pad(m[1])}`;
    if (!m[3] && iso < todayIso) iso = `${year + 1}-${pad(m[2])}-${pad(m[1])}`;   // "12.1." said in December = next January
    return validIso(iso) ? iso : null;
  }
  if ((m = t.match(/\b(\d{1,2})\.\s?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)(?:\s(\d{4}))?/))) {
    const month = MONTH_NAMES.findIndex((n) => n.toLowerCase().replace("ä", "ae") === m[2].replace("ä", "ae")) + 1;
    const year = m[3] ? Number(m[3]) : Number(todayIso.slice(0, 4));
    let iso = `${year}-${pad(month)}-${pad(m[1])}`;
    if (!m[3] && iso < todayIso) iso = `${year + 1}-${pad(month)}-${pad(m[1])}`;
    return validIso(iso) ? iso : null;
  }
  // JavaScript's \b only knows ASCII letters, so "übermorgen" needs explicit letter boundaries.
  const L = "a-zäöüß";
  if (new RegExp(`(?<![${L}])(übermorgen|uebermorgen)(?![${L}])`).test(t)) return addDays(todayIso, 2);
  if (new RegExp(`(?<![${L}])morgen(?![${L}])`).test(t)) return addDays(todayIso, 1);
  if (/\bheute\b/.test(t)) return todayIso;
  if ((m = t.match(/\bin (\d{1,2}) tagen?\b/))) return addDays(todayIso, Number(m[1]));
  const wd = Object.keys(WEEKDAYS).find((name) => new RegExp(`\\b${name}\\b`).test(t));
  if (wd) {
    const target = WEEKDAYS[wd];
    const today = weekdayOf(todayIso);
    if (/\bnächste[rnms]? woche\b|\bnaechste[rnms]? woche\b/.test(t)) {
      const mondayNextWeek = addDays(todayIso, ((8 - today) % 7) || 7);
      return addDays(mondayNextWeek, (target + 6) % 7);
    }
    let delta = (target - today + 7) % 7;
    if (/\b(nächste[rnms]?|naechste[rnms]?|kommende[rnms]?)\b/.test(t) && delta === 0) delta = 7;
    return addDays(todayIso, delta);
  }
  return null;
}

/** "14:30", "14.30", "14 Uhr", "14 Uhr 30", "halb drei", "um 9". Hours 1-8 without a day part are read as afternoon
 *  (a salon is not open at 3 in the morning). Returns "HH:MM" or null. */
export function parseGermanTime(text) {
  if (text === undefined || text === null) return null;
  const t = String(text).toLowerCase().trim();
  let m;
  const afternoon = (h) => (h >= 1 && h <= 8 ? h + 12 : h);
  const valid = (h, mi) => (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? `${pad(h)}:${pad(mi)}` : null);
  if ((m = t.match(/\bhalb (\d{1,2}|[a-zäöüß]+)\b/))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    if (!n) return null;
    return valid(afternoon(n) - 1, 30);                                  // "halb drei" = 14:30
  }
  if ((m = t.match(/\b(\d{1,2})[:.](\d{2})\b/))) return valid(Number(m[1]), Number(m[2]));
  if ((m = t.match(/\b(\d{1,2})\s?uhr(?:\s?(\d{1,2}))?/))) return valid(Number(m[1]), m[2] ? Number(m[2]) : 0);
  if ((m = t.match(/^\s*(?:um\s+)?(\d{1,2})\s*$/))) return valid(afternoon(Number(m[1])), 0);       // "9", "um 9", "3" (= 15:00)
  return null;
}

/** Date/time of a request. `requested_date_text` (what the caller literally said) wins over `date`. */
export function resolveRequest(args, now) {
  const a = args || {};
  let date = null;
  if (a.requested_date_text) date = parseGermanDate(a.requested_date_text, now.date);
  if (!date && a.date) date = validIso(String(a.date)) ? String(a.date) : parseGermanDate(a.date, now.date);
  if (!date) return { error: "unclear_date", message: "Das Datum ist nicht eindeutig. Bitte nach dem genauen Tag fragen." };
  const time = parseGermanTime(a.time);
  if (!time) return { error: "unclear_time", message: "Die Uhrzeit ist nicht eindeutig. Bitte nach der genauen Uhrzeit fragen." };
  return { date, time };
}

// ── rules ───────────────────────────────────────────────────────────────────────────────────

export function serviceMinutes(service, config) {
  if (!service) return config.defaultServiceMinutes;
  const key = String(service).toLowerCase().trim();
  for (const [name, minutes] of Object.entries(config.services || {})) {
    if (key === name || key.includes(name) || name.includes(key)) return minutes;
  }
  return config.defaultServiceMinutes;
}

function busyRange(entry, date) {
  const s = String(entry.start || ""), e = String(entry.end || "");
  if (s.length === 10) {                                                 // all-day event (end date exclusive in Google Calendar)
    const lastDay = e.length === 10 ? addDays(e, -1) : s;
    return date >= s && date <= (lastDay < s ? s : lastDay) ? [0, 24 * 60] : null;
  }
  if (s.slice(0, 10) > date || e.slice(0, 10) < date) return null;
  const from = s.slice(0, 10) < date ? 0 : toMinutes(s.slice(11, 16));
  const to = e.slice(0, 10) > date ? 24 * 60 : toMinutes(e.slice(11, 16));
  return [from, to];
}

/** Why a slot is NOT possible, or null if it is free. Reasons are stable codes (tested) plus a spoken German text. */
export function slotProblem(date, time, minutes, busy, config, now) {
  if (!validIso(date)) return { code: "invalid_date", text: "Das Datum ist ungültig." };
  const start = toMinutes(time);
  if (start % config.slotMinutes !== 0) {
    return { code: "not_on_grid", text: `Termine gibt es nur im ${config.slotMinutes}-Minuten-Raster.` };
  }
  const nowDate = now.date, nowMin = toMinutes(now.time);
  if (date < nowDate || (date === nowDate && start < nowMin + config.minLeadMinutes)) {
    return { code: "too_soon", text: "Dieser Zeitpunkt liegt in der Vergangenheit oder zu kurzfristig." };
  }
  if (date > addDays(nowDate, config.maxDaysAhead)) {
    return { code: "too_far", text: `Termine werden höchstens ${config.maxDaysAhead} Tage im Voraus vergeben.` };
  }
  const hours = config.openingHours[String(weekdayOf(date))];
  if (!hours) return { code: "closed", text: `Am ${WEEKDAY_NAMES[weekdayOf(date)]} ist der Salon geschlossen.` };
  if (start < toMinutes(hours[0]) || start + minutes > toMinutes(hours[1])) {
    return { code: "outside_hours", text: `An diesem Tag ist von ${hours[0]} bis ${hours[1]} Uhr geöffnet, der Termin muss ganz hineinpassen.` };
  }
  for (const entry of busy || []) {
    const r = busyRange(entry, date);
    if (r && start < r[1] && start + minutes > r[0]) return { code: "busy", text: "Zu dieser Zeit ist bereits ein Termin eingetragen." };
  }
  return null;
}

export function findAlternatives(date, time, minutes, busy, config, now, limit = 3) {
  const out = [];
  const wanted = toMinutes(time);
  for (let dayOffset = 0; dayOffset <= 14 && out.length < limit; dayOffset++) {
    const day = addDays(date, dayOffset);
    const hours = config.openingHours[String(weekdayOf(day))];
    if (!hours) continue;
    const candidates = [];
    for (let t = toMinutes(hours[0]); t + minutes <= toMinutes(hours[1]); t += config.slotMinutes) candidates.push(t);
    candidates.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b);          // nearest to the wish first
    for (const t of dayOffset === 0 ? candidates : candidates.sort((a, b) => a - b)) {
      if (out.length >= limit) break;
      if (dayOffset === 0 && t === wanted) continue;
      if (!slotProblem(day, fromMinutes(t), minutes, busy, config, now)) out.push({ date: day, time: fromMinutes(t), spoken: spoken(day, fromMinutes(t)) });
    }
  }
  return out;
}

export function spoken(date, time) {
  const [, m, d] = date.split("-").map(Number);
  return `${WEEKDAY_NAMES[weekdayOf(date)]}, ${d}. ${MONTH_NAMES[m - 1]} um ${time} Uhr`;
}

// ── the two tools ───────────────────────────────────────────────────────────────────────────

export function checkAvailability(args, ctx) {
  const r = resolveRequest(args, ctx.now);
  if (r.error) return { ok: false, available: null, error: r.error, message: r.message };
  const minutes = serviceMinutes(args.service, ctx.config);
  const problem = slotProblem(r.date, r.time, minutes, ctx.busy, ctx.config, ctx.now);
  if (!problem) {
    return { ok: true, available: true, date: r.date, time: r.time, spoken: spoken(r.date, r.time),
      message: `${spoken(r.date, r.time)} ist frei.` };
  }
  const alternatives = findAlternatives(r.date, r.time, minutes, ctx.busy, ctx.config, ctx.now);
  return { ok: true, available: false, date: r.date, time: r.time, reason: problem.code, message: problem.text, alternatives };
}

export function bookAppointment(args, ctx) {
  const a = args || {};
  if (a.confirmed !== true) {
    return { ok: false, booked: false, error: "not_confirmed", message: "Nicht gebucht: Der Kunde hat nicht ausdrücklich bestätigt." };
  }
  const name = String(a.customer_name || "").trim();
  if (!name) return { ok: false, booked: false, error: "missing_name", message: "Nicht gebucht: Es fehlt der Name des Kunden." };
  const r = resolveRequest(a, ctx.now);
  if (r.error) return { ok: false, booked: false, error: r.error, message: `Nicht gebucht: ${r.message}` };
  const minutes = serviceMinutes(a.service, ctx.config);
  const problem = slotProblem(r.date, r.time, minutes, ctx.busy, ctx.config, ctx.now);        // re-checked: the slot may have been taken meanwhile
  if (problem) {
    return { ok: false, booked: false, error: problem.code, message: `Nicht gebucht: ${problem.text}`,
      alternatives: findAlternatives(r.date, r.time, minutes, ctx.busy, ctx.config, ctx.now) };
  }
  const end = fromMinutes(toMinutes(r.time) + minutes);
  const event = {
    start: `${r.date}T${r.time}`, end: `${r.date}T${end}`,
    summary: `${name}${a.service ? " – " + a.service : ""}`,
    description: `Gebucht per Telefonassistent.${a.phone ? " Telefon: " + a.phone : ""}`,
  };
  return { ok: true, booked: true, date: r.date, time: r.time, until: end, spoken: spoken(r.date, r.time), event,
    message: `Gebucht: ${spoken(r.date, r.time)} für ${name}.` };
}

// ── Vapi envelope ───────────────────────────────────────────────────────────────────────────

/** Tool calls of a Vapi "tool-calls" server message, normalised to [{id, name, args}] (empty list if there are none).
 *  Documented shape (docs.vapi.ai/server-url/events): message.toolCallList[] = {id, type: "function", function: {name, arguments}}.
 *  message.toolWithToolCallList[] (tool definition + nested toolCall) is read as well; a flat {id, name, arguments} and a
 *  message.toolCalls list are tolerated, `arguments` may be an object or a JSON string. */
export function extractToolCalls(body) {
  const msg = (body && body.message) || {};
  const list = msg.toolCallList || msg.toolWithToolCallList || msg.toolCalls || [];
  return list.map((c) => {
    const call = c.toolCall || c;                                     // toolWithToolCallList nests the call
    const fn = call.function || {};
    let args = fn.arguments ?? call.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { __invalid_json: true }; } }
    return { id: call.id, name: fn.name || call.name, args: args && typeof args === "object" ? args : {} };
  });
}

/** Apply one tool call. Never throws; an unknown tool or invalid arguments are reported as a failure, not as success. */
export function runTool(call, ctx) {
  try {
    if (call.args && call.args.__invalid_json) return { ok: false, error: "invalid_arguments", message: "Die Argumente waren kein gültiges JSON." };
    if (call.name === "check_availability") return checkAvailability(call.args, ctx);
    if (call.name === "book_appointment") return bookAppointment(call.args, ctx);
    return { ok: false, error: "unknown_tool", message: `Unbekanntes Werkzeug: ${call.name}` };
  } catch (err) {
    return { ok: false, error: "internal_error", message: "Interner Fehler. Nichts wurde gebucht." };
  }
}

const MAX_REMEMBERED = 200;
/** Vapi can deliver the same tool call twice (retries are configurable). A retried booking must not turn into "slot taken":
 *  the answer is remembered per toolCallId. `memory` is {order: [], answers: {}} and is kept by the caller (RAM, n8n static data).
 *  Returns {outcome, replay}; on replay the caller must NOT repeat side effects (calendar write). */
export function runToolOnce(call, ctx, memory) {
  if (call.id && Object.prototype.hasOwnProperty.call(memory.answers, call.id)) return { outcome: memory.answers[call.id], replay: true };
  const outcome = runTool(call, ctx);
  if (call.id) {
    memory.answers[call.id] = outcome;
    memory.order.push(call.id);
    while (memory.order.length > MAX_REMEMBERED) delete memory.answers[memory.order.shift()];
  }
  return { outcome, replay: false };
}

/** Failures of the tool itself go into Vapi's `error` field; real answers (also "no, that slot is taken") go into `result`.
 *  Both are single-line strings, as the Vapi docs require. */
const TECHNICAL_ERRORS = new Set(["unknown_tool", "invalid_arguments", "internal_error"]);
export function vapiResponse(call, outcome) {
  if (TECHNICAL_ERRORS.has(outcome.error)) {
    return { results: [{ toolCallId: call.id, error: String(outcome.message).replace(/\s+/g, " ").trim() }] };
  }
  return { results: [{ toolCallId: call.id, result: JSON.stringify(outcome) }] };
}

/** Local "now" of a time zone as {date, time}. */
export function nowIn(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const [d, t] = parts.split(" ");
  return { date: d, time: t.slice(0, 5) };
}

/** Calendar events of Google Calendar (n8n node output) -> busy list in salon-local time. */
export function eventsToBusy(events) {
  const out = [];
  for (const ev of events || []) {
    if (!ev || ev.status === "cancelled" || ev.transparency === "transparent") continue;
    const s = ev.start?.dateTime ?? ev.start?.date ?? ev.start;
    const e = ev.end?.dateTime ?? ev.end?.date ?? ev.end;
    if (typeof s !== "string" || typeof e !== "string") continue;
    out.push({ start: s.length > 10 ? s.slice(0, 16) : s, end: e.length > 10 ? e.slice(0, 16) : e });
  }
  return out;
}
