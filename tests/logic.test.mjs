import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addDays, weekdayOf, parseGermanDate, parseGermanTime, resolveRequest, slotProblem, findAlternatives,
  checkAvailability, bookAppointment, extractToolCalls, runTool, runToolOnce, vapiResponse, eventsToBusy, serviceMinutes, nowIn,
} from "../src/salon_logic.mjs";

const config = JSON.parse(readFileSync(new URL("../config/salon.json", import.meta.url), "utf8"));
// Wednesday 25 Nov 2026, 10:00 (checked in test 'fixture weekdays')
const NOW = { date: "2026-11-25", time: "10:00" };
const ctx = (busy = [], now = NOW) => ({ config, busy, now });

test("fixture weekdays", () => {
  assert.equal(weekdayOf("2026-11-25"), 3);   // Wednesday
  assert.equal(weekdayOf("2026-11-27"), 5);   // Friday
  assert.equal(weekdayOf("2026-11-29"), 0);   // Sunday
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});

test("German relative and absolute dates", () => {
  const cases = {
    "heute": "2026-11-25", "morgen": "2026-11-26", "übermorgen": "2026-11-27", "uebermorgen": "2026-11-27",
    "Freitag": "2026-11-27", "am Freitag": "2026-11-27", "Mittwoch": "2026-11-25",           // bare weekday: today counts
    "nächsten Mittwoch": "2026-12-02", "nächste Woche Dienstag": "2026-12-01",
    "in 3 Tagen": "2026-11-28", "am 12.12.": "2026-12-12", "12. Dezember": "2026-12-12",
    "2026-12-04": "2026-12-04", "1.12.2026": "2026-12-01", "am 3. März": "2027-03-03",       // already past this year -> next year
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(parseGermanDate(text, NOW.date), want, text);
  for (const text of ["irgendwann", "", "31.02.", "2026-02-31", null]) assert.equal(parseGermanDate(text, NOW.date), null, String(text));
});

test("German times", () => {
  const cases = { "14:30": "14:30", "14.30": "14:30", "14 Uhr": "14:00", "14 Uhr 30": "14:30", "halb drei": "14:30", "halb 10": "09:30",
    "um 9": "09:00", "9": "09:00", "3": "15:00", "um 15 Uhr": "15:00", "10:00": "10:00" };
  for (const [text, want] of Object.entries(cases)) assert.equal(parseGermanTime(text), want, text);
  for (const text of ["25:00", "später", "", "14:75", undefined]) assert.equal(parseGermanTime(text), null, String(text));
});

test("requested_date_text wins over a model-computed date", () => {
  const r = resolveRequest({ date: "2026-01-01", time: "14:00", requested_date_text: "morgen" }, NOW);
  assert.deepEqual(r, { date: "2026-11-26", time: "14:00" });
  assert.equal(resolveRequest({ time: "14:00" }, NOW).error, "unclear_date");
  assert.equal(resolveRequest({ date: "2026-12-04" }, NOW).error, "unclear_time");
});

test("opening hours, closed days, grid, lead time, horizon", () => {
  const p = (date, time, minutes = 30, busy = [], now = NOW) => slotProblem(date, time, minutes, busy, config, now)?.code ?? null;
  assert.equal(p("2026-11-27", "10:00"), null);                      // Friday morning is free
  assert.equal(p("2026-11-29", "10:00"), "closed");                  // Sunday
  assert.equal(p("2026-11-30", "10:00"), "closed");                  // Monday
  assert.equal(p("2026-11-27", "08:30"), "outside_hours");
  assert.equal(p("2026-11-27", "17:30", 60), "outside_hours");       // 60 min would end 18:30 > 18:00
  assert.equal(p("2026-11-27", "17:30", 30), null);                  // fits exactly
  assert.equal(p("2026-11-28", "13:30", 30), null);                  // Saturday closes at 14:00
  assert.equal(p("2026-11-28", "14:00"), "outside_hours");
  assert.equal(p("2026-11-27", "10:15"), "not_on_grid");
  assert.equal(p("2026-11-25", "10:30"), "too_soon");                // only 30 min ahead, 60 required
  assert.equal(p("2026-11-25", "11:00"), null);                      // exactly the lead time
  assert.equal(p("2026-11-20", "10:00"), "too_soon");                // past
  assert.equal(p("2027-03-01", "10:00"), "too_far");
});

test("busy intervals: overlap, touching edges, multi-day and all-day events", () => {
  const busy = [{ start: "2026-11-27T10:00", end: "2026-11-27T11:00" }];
  const p = (time, minutes = 30, b = busy) => slotProblem("2026-11-27", time, minutes, b, config, NOW)?.code ?? null;
  assert.equal(p("10:00"), "busy");
  assert.equal(p("10:30"), "busy");
  assert.equal(p("09:30"), null);                                    // ends exactly when the busy slot starts
  assert.equal(p("11:00"), null);                                    // starts exactly when it ends
  assert.equal(p("09:30", 60), "busy");                              // 60 min from 09:30 runs into 10:00
  assert.equal(p("14:00", 30, [{ start: "2026-11-27", end: "2026-11-28" }]), "busy");     // all-day event (end exclusive)
  assert.equal(slotProblem("2026-11-28", "10:00", 30, [{ start: "2026-11-27", end: "2026-11-28" }], config, NOW), null);
  assert.equal(p("14:00", 30, [{ start: "2026-11-26T22:00", end: "2026-11-28T08:00" }]), "busy");   // spans midnight
});

test("alternatives are free, in the future, nearest first, and never the wish itself", () => {
  const busy = [{ start: "2026-11-27T14:00", end: "2026-11-27T16:00" }];
  const alts = findAlternatives("2026-11-27", "14:30", 30, busy, config, NOW);
  assert.equal(alts.length, 3);
  // distance to the wish 14:30: 13:30 = 60 min, 13:00 = 90, 16:00 = 90 (tie -> earlier first); 14:00-15:30 are busy
  assert.deepEqual(alts.map((a) => a.time), ["13:30", "13:00", "16:00"]);
  for (const a of alts) assert.equal(slotProblem(a.date, a.time, 30, busy, config, NOW), null);
  const sunday = findAlternatives("2026-11-29", "10:00", 30, [], config, NOW);
  assert.ok(sunday.every((a) => a.date > "2026-11-29" && weekdayOf(a.date) >= 2));       // skips closed Sunday/Monday
});

test("check_availability: free, busy with alternatives, unclear input", () => {
  const free = checkAvailability({ time: "10:00", requested_date_text: "Freitag" }, ctx());
  assert.equal(free.available, true);
  assert.match(free.message, /Freitag, 27\. November um 10:00 Uhr ist frei/);
  const busy = checkAvailability({ time: "10:00", requested_date_text: "Freitag" }, ctx([{ start: "2026-11-27T10:00", end: "2026-11-27T10:30" }]));
  assert.equal(busy.available, false);
  assert.equal(busy.reason, "busy");
  assert.ok(busy.alternatives.length >= 1);
  const closed = checkAvailability({ time: "10:00", requested_date_text: "Sonntag" }, ctx());
  assert.equal(closed.reason, "closed");
  const unclear = checkAvailability({ time: "10:00", requested_date_text: "bald" }, ctx());
  assert.equal(unclear.available, null);                              // never claims availability it did not check
  assert.equal(unclear.error, "unclear_date");
});

test("service duration changes what fits", () => {
  assert.equal(serviceMinutes("Herrenschnitt", config), 30);
  assert.equal(serviceMinutes("Färben", config), 120);
  assert.equal(serviceMinutes("unbekannt", config), config.defaultServiceMinutes);
  const busy = [{ start: "2026-11-27T11:00", end: "2026-11-27T12:00" }];
  assert.equal(checkAvailability({ time: "10:00", requested_date_text: "Freitag", service: "Herrenschnitt" }, ctx(busy)).available, true);
  assert.equal(checkAvailability({ time: "10:00", requested_date_text: "Freitag", service: "Färben" }, ctx(busy)).available, false);
});

test("book_appointment: needs explicit confirmation, a name and a still-free slot", () => {
  const base = { time: "10:00", requested_date_text: "Freitag", customer_name: "Max Muster", service: "Herrenschnitt", phone: "0170 1234567" };
  const notConfirmed = bookAppointment({ ...base, confirmed: false }, ctx());
  assert.equal(notConfirmed.booked, false);
  assert.equal(notConfirmed.error, "not_confirmed");
  assert.equal(bookAppointment({ ...base }, ctx()).booked, false);                       // missing flag counts as not confirmed
  assert.equal(bookAppointment({ ...base, confirmed: "true" }, ctx()).booked, false);    // a string is not a confirmation
  assert.equal(bookAppointment({ ...base, confirmed: true, customer_name: "  " }, ctx()).error, "missing_name");
  const ok = bookAppointment({ ...base, confirmed: true }, ctx());
  assert.equal(ok.booked, true);
  assert.deepEqual(ok.event, { start: "2026-11-27T10:00", end: "2026-11-27T10:30", summary: "Max Muster – Herrenschnitt", description: "Gebucht per Telefonassistent. Telefon: 0170 1234567" });
  const taken = bookAppointment({ ...base, confirmed: true }, ctx([{ start: "2026-11-27T10:00", end: "2026-11-27T10:30" }]));
  assert.equal(taken.booked, false);
  assert.equal(taken.error, "busy");
  assert.ok(taken.alternatives.length > 0);
  assert.equal(bookAppointment({ ...base, confirmed: true, requested_date_text: "Sonntag" }, ctx()).error, "closed");
});

test("Vapi envelope: both payload shapes, string arguments, unknown tool, invalid JSON, id passthrough", () => {
  const shapeA = { message: { type: "tool-calls", toolCallList: [{ id: "call_1", name: "check_availability", arguments: { time: "10:00", requested_date_text: "Freitag" } }] } };
  const shapeB = { message: { type: "tool-calls", toolCalls: [{ id: "call_2", type: "function", function: { name: "check_availability", arguments: JSON.stringify({ time: "10:00", requested_date_text: "Freitag" }) } }] } };
  for (const body of [shapeA, shapeB]) {
    const [call] = extractToolCalls(body);
    const res = vapiResponse(call, runTool(call, ctx()));
    assert.equal(res.results[0].toolCallId, call.id);
    assert.equal(typeof res.results[0].result, "string");
    assert.ok(!res.results[0].result.includes("\n"));                                   // single line, as Vapi requires
    assert.equal(JSON.parse(res.results[0].result).available, true);
  }
  assert.equal(runTool({ id: "x", name: "delete_everything", args: {} }, ctx()).error, "unknown_tool");
  const [bad] = extractToolCalls({ message: { toolCalls: [{ id: "y", function: { name: "book_appointment", arguments: "{not json" } }] } });
  assert.equal(runTool(bad, ctx()).error, "invalid_arguments");
  assert.deepEqual(extractToolCalls({}), []);
});

test("Google Calendar events -> busy list (timed, all-day, cancelled, transparent)", () => {
  const events = [
    { start: { dateTime: "2026-11-27T10:00:00+01:00" }, end: { dateTime: "2026-11-27T11:00:00+01:00" } },
    { start: { date: "2026-11-28" }, end: { date: "2026-11-29" } },
    { status: "cancelled", start: { dateTime: "2026-11-27T12:00:00+01:00" }, end: { dateTime: "2026-11-27T13:00:00+01:00" } },
    { transparency: "transparent", start: { dateTime: "2026-11-27T14:00:00+01:00" }, end: { dateTime: "2026-11-27T15:00:00+01:00" } },
    { start: {}, end: {} },
  ];
  assert.deepEqual(eventsToBusy(events), [{ start: "2026-11-27T10:00", end: "2026-11-27T11:00" }, { start: "2026-11-28", end: "2026-11-29" }]);
  assert.deepEqual(eventsToBusy(undefined), []);
});

test("nowIn returns the salon's local wall clock", () => {
  const noon = new Date("2026-07-01T10:00:00Z");                      // summer: Berlin is UTC+2
  assert.deepEqual(nowIn("Europe/Berlin", noon), { date: "2026-07-01", time: "12:00" });
  const late = new Date("2026-12-31T23:30:00Z");                      // winter, crosses midnight: UTC+1
  assert.deepEqual(nowIn("Europe/Berlin", late), { date: "2027-01-01", time: "00:30" });
});


test("documented Vapi shapes (docs.vapi.ai/server-url/events): toolCallList with function.name/arguments, and toolWithToolCallList", () => {
  const documented = { message: { type: "tool-calls", timestamp: 1, toolCallList: [
    { id: "toolu_01A", type: "function", function: { name: "check_availability", arguments: { time: "10:00", requested_date_text: "morgen" } } }] } };
  assert.deepEqual(extractToolCalls(documented), [{ id: "toolu_01A", name: "check_availability", args: { time: "10:00", requested_date_text: "morgen" } }]);
  const nested = { message: { toolWithToolCallList: [{ type: "function", function: { name: "book_appointment", description: "...", parameters: {} },
    server: { url: "https://x" }, toolCall: { id: "toolu_02B", type: "function", function: { name: "book_appointment", arguments: { time: "10:00" } } } }] } };
  assert.deepEqual(extractToolCalls(nested), [{ id: "toolu_02B", name: "book_appointment", args: { time: "10:00" } }]);
  assert.deepEqual(extractToolCalls({ message: { type: "status-update" } }), []);
});

test("responses: result is a single-line string, technical failures use error, exactly one of the two", () => {
  const call = { id: "c1", name: "check_availability", args: { time: "10:00", requested_date_text: "Freitag" } };
  const ok = vapiResponse(call, runTool(call, ctx())).results[0];
  assert.deepEqual(Object.keys(ok).sort(), ["result", "toolCallId"]);
  assert.equal(typeof ok.result, "string");
  assert.ok(!/[\r\n]/.test(ok.result));
  const failed = vapiResponse({ id: "c2" }, { ok: false, error: "internal_error", message: "Interner\nFehler.\n  Nichts gebucht." }).results[0];
  assert.deepEqual(failed, { toolCallId: "c2", error: "Interner Fehler. Nichts gebucht." });
  for (const code of ["unknown_tool", "invalid_arguments"]) assert.ok("error" in vapiResponse({ id: "x" }, { error: code, message: "m" }).results[0]);
  for (const code of ["not_confirmed", "busy", "closed", "unclear_date"]) assert.ok("result" in vapiResponse({ id: "x" }, { ok: false, error: code, message: "m" }).results[0]);   // answers, not tool failures
});

test("runToolOnce: a repeated toolCallId returns the first answer and is flagged as replay; memory stays bounded", () => {
  const mem = { order: [], answers: {} };
  const book = { id: "same", name: "book_appointment", args: { time: "10:00", requested_date_text: "Freitag", customer_name: "A", confirmed: true } };
  const first = runToolOnce(book, ctx(), mem);
  assert.equal(first.replay, false); assert.equal(first.outcome.booked, true);
  const again = runToolOnce(book, ctx([{ start: "2026-11-27T10:00", end: "2026-11-27T10:30" }]), mem);   // slot is busy now (our own booking)
  assert.equal(again.replay, true); assert.deepEqual(again.outcome, first.outcome);
  for (let i = 0; i < 500; i++) runToolOnce({ id: `id${i}`, name: "check_availability", args: { time: "10:00", requested_date_text: "Freitag" } }, ctx(), mem);
  assert.ok(mem.order.length <= 200 && Object.keys(mem.answers).length <= 200);
  const noId = { name: "check_availability", args: { time: "10:00", requested_date_text: "Freitag" } };      // without an id nothing is remembered
  assert.equal(runToolOnce(noId, ctx(), mem).replay, false); assert.equal(runToolOnce(noId, ctx(), mem).replay, false);
});
