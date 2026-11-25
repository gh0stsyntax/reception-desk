import test from "node:test";
import assert from "node:assert/strict";
import { createApp, WEBHOOK_PATH, loadConfig } from "../src/server.mjs";

const SECRET = "test-secret-" + "x".repeat(24);
const NOW = { date: "2026-11-25", time: "10:00" };

async function withServer(fn, calendar = []) {
  const { server, calendar: cal } = createApp({ secret: SECRET, config: loadConfig(), calendar, clock: () => NOW });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, cal); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, body, headers = { "x-vapi-secret": SECRET }, path = WEBHOOK_PATH) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const toolCall = (id, name, args) => ({ message: { type: "tool-calls", toolCallList: [{ id, name, arguments: args }] } });
const outcome = async (res) => JSON.parse((await res.json()).results[0].result);

test("refuses to be created without a secret", () => {
  assert.throws(() => createApp({ secret: "" }), /secret/i);
});

test("authentication, method, path, size and JSON errors", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, {}, {})).status, 401);                                             // no secret
    assert.equal((await post(base, {}, { "x-vapi-secret": "wrong" })).status, 401);
    assert.equal((await post(base, {}, { "x-vapi-secret": SECRET + "x" })).status, 401);              // prefix/extension must not pass
    assert.equal((await fetch(base + WEBHOOK_PATH, { headers: { "x-vapi-secret": SECRET } })).status, 405);   // GET
    assert.equal((await post(base, {}, undefined, "/other")).status, 404);
    assert.equal((await post(base, "{not json")).status, 400);
    const big = await post(base, JSON.stringify({ pad: "x".repeat(70 * 1024) })).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal((await post(base, {})).status, 200);                                                 // authenticated, empty -> no results
  });
});

test("check, book, then the same slot is gone", async () => {
  await withServer(async (base, cal) => {
    const args = { time: "10:00", requested_date_text: "Freitag" };
    assert.equal((await outcome(await post(base, toolCall("c1", "check_availability", args)))).available, true);
    const booked = await outcome(await post(base, toolCall("c2", "book_appointment", { ...args, date: "2026-11-27", customer_name: "Anna Beispiel", confirmed: true, service: "Herrenschnitt" })));
    assert.equal(booked.booked, true);
    assert.deepEqual(cal, [{ start: "2026-11-27T10:00", end: "2026-11-27T10:30" }]);
    const again = await outcome(await post(base, toolCall("c3", "check_availability", args)));
    assert.equal(again.available, false);
    assert.equal(again.reason, "busy");
    const double = await outcome(await post(base, toolCall("c4", "book_appointment", { ...args, customer_name: "Zweiter Kunde", confirmed: true })));
    assert.equal(double.booked, false);                                                               // no double booking
    assert.equal(cal.length, 1);
  });
});

test("an unconfirmed booking never touches the calendar", async () => {
  await withServer(async (base, cal) => {
    const out = await outcome(await post(base, toolCall("u1", "book_appointment", { time: "10:00", requested_date_text: "Freitag", customer_name: "Nur Frage", confirmed: false })));
    assert.equal(out.booked, false);
    assert.equal(cal.length, 0);
  });
});

test("several calls in one request are applied in order and keep their ids", async () => {
  await withServer(async (base) => {
    const body = { message: { toolCallList: [
      { id: "a", name: "book_appointment", arguments: { time: "10:00", requested_date_text: "Freitag", customer_name: "A", confirmed: true } },
      { id: "b", name: "book_appointment", arguments: { time: "10:00", requested_date_text: "Freitag", customer_name: "B", confirmed: true } },
    ] } };
    const { results } = await (await post(base, body)).json();
    assert.deepEqual(results.map((r) => r.toolCallId), ["a", "b"]);
    assert.equal(JSON.parse(results[0].result).booked, true);
    assert.equal(JSON.parse(results[1].result).booked, false);
  });
});


test("Bearer token (Vapi default) and legacy X-Vapi-Secret are both accepted, wrong ones are not", async () => {
  await withServer(async (base) => {
    const body = { message: { toolCallList: [{ id: "a1", type: "function", function: { name: "check_availability", arguments: { time: "10:00", requested_date_text: "Freitag" } } }] } };
    assert.equal((await post(base, body, { authorization: `Bearer ${SECRET}` })).status, 200);
    assert.equal((await post(base, body, { authorization: `bearer ${SECRET}` })).status, 200);       // scheme is case-insensitive
    assert.equal((await post(base, body, { "x-vapi-secret": SECRET })).status, 200);
    assert.equal((await post(base, body, { authorization: SECRET })).status, 401);                    // no "Bearer" prefix
    assert.equal((await post(base, body, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(base, body, { authorization: "Basic " + SECRET })).status, 401);
  });
});

test("retried delivery: same toolCallId books once and answers the same; technical failure uses error", async () => {
  await withServer(async (base, cal) => {
    const book = { message: { toolCallList: [{ id: "toolu_X", type: "function", function: { name: "book_appointment",
      arguments: { time: "10:00", requested_date_text: "Freitag", customer_name: "Eva", confirmed: true } } }] } };
    const first = await (await post(base, book)).json();
    const second = await (await post(base, book)).json();                                              // Vapi retry
    assert.deepEqual(second, first);
    assert.equal(JSON.parse(first.results[0].result).booked, true);
    assert.equal(cal.length, 1);
    const unknown = await (await post(base, { message: { toolCallList: [{ id: "u", type: "function", function: { name: "nope", arguments: {} } }] } })).json();
    assert.deepEqual(Object.keys(unknown.results[0]).sort(), ["error", "toolCallId"]);
  });
});
