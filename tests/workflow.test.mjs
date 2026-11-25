import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildWorkflow } from "../n8n/build_workflow.mjs";
import { createApp, WEBHOOK_PATH, loadConfig } from "../src/server.mjs";

const committed = JSON.parse(readFileSync(new URL("../n8n/workflow.json", import.meta.url), "utf8"));
const node = (name) => committed.nodes.find((n) => n.name === name);
const FIXED_UTC = Date.parse("2026-11-25T09:00:00Z");                    // 10:00 in Berlin (UTC+1 in November)

test("committed workflow.json is up to date with the sources (run: npm run build)", () => {
  assert.deepEqual(committed, buildWorkflow());
});

test("graph is well-formed: one trigger, all links resolve, both IF branches reach the response", () => {
  const names = new Set(committed.nodes.map((n) => n.name));
  assert.equal(names.size, committed.nodes.length);
  assert.equal(committed.nodes.filter((n) => n.type === "n8n-nodes-base.webhook").length, 1);
  for (const [from, outs] of Object.entries(committed.connections)) {
    assert.ok(names.has(from), `source ${from}`);
    for (const branch of outs.main) for (const l of branch) assert.ok(names.has(l.node), `${from} -> ${l.node}`);
  }
  const reach = (start) => { const seen = new Set(); const go = (n) => { if (seen.has(n)) return; seen.add(n); (committed.connections[n]?.main || []).flat().forEach((l) => go(l.node)); }; go(start); return seen; };
  assert.deepEqual([...reach("Vapi webhook")].sort(), [...names].sort());                       // nothing orphaned
  const [yes, no] = committed.connections["Booked?"].main;
  assert.ok(reach(yes[0].node).has("Respond to Vapi") && reach(no[0].node).has("Respond to Vapi"));
  assert.ok(reach(yes[0].node).has("Create event") && !reach(no[0].node).has("Create event"));  // only the YES branch writes to the calendar
});

test("webhook matches the Vapi tool contract and is authenticated", () => {
  const w = node("Vapi webhook").parameters;
  assert.equal(w.httpMethod, "POST");
  assert.equal(`/webhook/${w.path}`, WEBHOOK_PATH);
  assert.equal(w.authentication, "headerAuth");
  assert.equal(w.responseMode, "responseNode");
});

test("no secrets or real identifiers are committed", () => {
  const text = JSON.stringify(committed);
  assert.ok(!/n8n\.cloud|apexagency|sk-[A-Za-z0-9]{10,}|ya29\.|Bearer /i.test(text));
  for (const n of committed.nodes) for (const c of Object.values(n.credentials || {})) assert.equal(c.id, "REPLACE_ME");
});

// Run the embedded Code nodes the way n8n would, with a fixed clock.
function runCodeNode(name, { input, upstream = {}, staticData = {} }) {
  const FakeDate = class extends Date { constructor(...a) { super(...(a.length ? a : [FIXED_UTC])); } static now() { return FIXED_UTC; } };
  const items = (arr) => ({ first: () => ({ json: arr[0] }), all: () => arr.map((json) => ({ json })) });
  const sandbox = { Date: FakeDate, $input: items(input), $: (n) => items(upstream[n]), $getWorkflowStaticData: () => staticData, JSON, Intl, Error, Math, Object, Array, String, Number, Set };
  const script = new vm.Script(`(function(){ ${node(name).parameters.jsCode} })()`);
  return script.runInNewContext(sandbox);
}

function viaWorkflow(body, events = [], staticData = {}) {
  const [prep] = runCodeNode("Prepare", { input: [{ body }] });
  const [decided] = runCodeNode("Decide", { input: events.length ? events : [{}], upstream: { Prepare: [prep.json] }, staticData });
  // objects created inside vm have another Object.prototype; compare plain data, not realms
  return JSON.parse(JSON.stringify({ prep: prep.json, decided: decided.json }));
}

const call = (id, name, args) => ({ message: { type: "tool-calls", toolCallList: [{ id, name, arguments: args }] } });

test("Prepare asks the calendar for the requested day plus margin", () => {
  const { prep } = viaWorkflow(call("p1", "check_availability", { time: "10:00", requested_date_text: "Freitag" }));
  assert.equal(prep.timeMin, "2026-11-26T00:00:00");
  assert.equal(prep.timeMax, "2026-11-29T00:00:00");
  assert.equal(prep.now.date, "2026-11-25");
  assert.equal(prep.now.time, "10:00");
});

test("Prepare rejects a request without a tool call instead of answering something made up", () => {
  assert.throws(() => runCodeNode("Prepare", { input: [{ body: { message: { type: "status-update" } } }] }), /No tool call/);
});

test("Decide: free slot, busy slot (Google event shape), confirmed booking creates exactly one event", () => {
  const free = viaWorkflow(call("d1", "check_availability", { time: "10:00", requested_date_text: "Freitag" }));
  assert.equal(JSON.parse(free.decided.response.results[0].result).available, true);
  assert.equal(free.decided.create, false);
  const googleEvent = { id: "e1", start: { dateTime: "2026-11-27T10:00:00+01:00" }, end: { dateTime: "2026-11-27T11:00:00+01:00" } };
  const busy = viaWorkflow(call("d2", "check_availability", { time: "10:30", requested_date_text: "Freitag" }), [googleEvent]);
  assert.equal(JSON.parse(busy.decided.response.results[0].result).available, false);
  const book = viaWorkflow(call("d3", "book_appointment", { time: "14:00", requested_date_text: "Freitag", customer_name: "Max", confirmed: true, service: "Damenschnitt" }));
  assert.equal(book.decided.create, true);
  assert.deepEqual(book.decided.event, { start: "2026-11-27T14:00", end: "2026-11-27T15:00", summary: "Max – Damenschnitt", description: "Gebucht per Telefonassistent." });
  const unconfirmed = viaWorkflow(call("d4", "book_appointment", { time: "14:00", requested_date_text: "Freitag", customer_name: "Max", confirmed: false }));
  assert.equal(unconfirmed.decided.create, false);                                                // IF branch would not write
});

test("empty calendar (n8n emits one empty item) is handled", () => {
  const r = viaWorkflow(call("e1", "check_availability", { time: "10:00", requested_date_text: "Freitag" }), [{}]);
  assert.equal(JSON.parse(r.decided.response.results[0].result).available, true);
});

test("parity: the n8n Code nodes and the reference server give identical answers", async () => {
  const bodies = [
    call("x1", "check_availability", { time: "10:00", requested_date_text: "Freitag" }),
    call("x2", "check_availability", { time: "10:00", requested_date_text: "Sonntag" }),
    call("x3", "check_availability", { time: "halb drei", requested_date_text: "übermorgen" }),
    call("x4", "check_availability", { time: "10:00", requested_date_text: "irgendwann" }),
    call("x5", "book_appointment", { time: "10:00", requested_date_text: "Freitag", customer_name: "Eva", confirmed: true }),
    call("x6", "book_appointment", { time: "10:00", requested_date_text: "Freitag", customer_name: "Eva", confirmed: false }),
    call("x7", "delete_everything", {}),
  ];
  const { server } = createApp({ secret: "s".repeat(16), config: loadConfig(), calendar: [], clock: () => ({ date: "2026-11-25", time: "10:00" }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    for (const body of bodies) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${WEBHOOK_PATH}`, { method: "POST", headers: { "x-vapi-secret": "s".repeat(16), "content-type": "application/json" }, body: JSON.stringify(body) });
      const fromServer = (await res.json()).results[0];
      // the server keeps bookings in memory; compare outcomes that do not depend on earlier bookings
      const fromWorkflow = viaWorkflow(body).decided.response.results[0];
      if (body.message.toolCallList[0].name === "book_appointment" && body.message.toolCallList[0].arguments.confirmed) {
        assert.equal(JSON.parse(fromServer.result).booked, JSON.parse(fromWorkflow.result).booked);
      } else {
        assert.deepEqual(fromServer, fromWorkflow, JSON.stringify(body.message.toolCallList[0]));
      }
    }
  } finally { await new Promise((r) => server.close(r)); }
});


test("retried delivery of the same toolCallId: same answer, and the calendar is written only once", () => {
  const staticData = {};                                                  // n8n keeps this between executions of the active workflow
  const body = call("retry-1", "book_appointment", { time: "14:00", requested_date_text: "Freitag", customer_name: "Eva", confirmed: true });
  const first = viaWorkflow(body, [], staticData);
  assert.equal(first.decided.create, true);
  const second = viaWorkflow(body, [{ id: "e", start: { dateTime: "2026-11-27T14:00:00+01:00" }, end: { dateTime: "2026-11-27T14:30:00+01:00" } }], staticData);
  assert.equal(second.decided.create, false);                             // no second calendar entry
  assert.deepEqual(second.decided.response, first.decided.response);      // the model still hears "booked", not "slot taken"
  assert.equal(JSON.parse(second.decided.response.results[0].result).booked, true);
  const other = viaWorkflow(call("retry-2", "book_appointment", { time: "14:00", requested_date_text: "Freitag", customer_name: "Zoe", confirmed: true }),
    [{ id: "e", start: { dateTime: "2026-11-27T14:00:00+01:00" }, end: { dateTime: "2026-11-27T14:30:00+01:00" } }], staticData);
  assert.equal(JSON.parse(other.decided.response.results[0].result).booked, false);   // a DIFFERENT call is not a replay
});

test("technical failures use Vapi's error field, business answers use result", () => {
  const unknown = viaWorkflow(call("t1", "delete_everything", {})).decided.response.results[0];
  assert.deepEqual(Object.keys(unknown).sort(), ["error", "toolCallId"]);
  const busy = viaWorkflow(call("t2", "check_availability", { time: "10:00", requested_date_text: "Sonntag" })).decided.response.results[0];
  assert.deepEqual(Object.keys(busy).sort(), ["result", "toolCallId"]);
});
