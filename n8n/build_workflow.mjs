// Generates n8n/workflow.json from src/salon_logic.mjs + config/salon.json (single source of truth).
// Run: node n8n/build_workflow.mjs        (tests fail if the committed workflow.json is out of date)
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const logicSource = readFileSync(new URL("src/salon_logic.mjs", root), "utf8")
  .replace(/^export /gm, "")                                   // n8n Code nodes have no module system
  .replace(/^\/\/.*$/gm, "")                                   // drop comment lines to keep the node readable
  .replace(/\n{3,}/g, "\n\n")
  .trim();
const config = JSON.parse(readFileSync(new URL("config/salon.json", root), "utf8"));

const id = (name) => {                                          // stable ids so the file diffs cleanly
  const h = crypto.createHash("sha1").update("salon-voice-agent:" + name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const PREPARE_TAIL = `
const CONFIG = ${JSON.stringify(config)};
const body = $input.first().json.body ?? $input.first().json;
const calls = extractToolCalls(body);
if (calls.length === 0) {
  throw new Error("No tool call in the request (expected a Vapi 'tool-calls' message).");
}
const call = calls[0];                       // one tool call per request; Vapi calls tools one at a time
const now = nowIn(CONFIG.timezone);
const wanted = resolveRequest(call.args, now);
const day = wanted.date || now.date;         // unclear dates are answered by the Decide node, the calendar query is harmless
return [{ json: { call, now, timeMin: addDays(day, -1) + "T00:00:00", timeMax: addDays(day, 2) + "T00:00:00" } }];
`;

export const DECIDE_TAIL = `
const CONFIG = ${JSON.stringify(config)};
const prep = $('Prepare').first().json;
const events = $input.all().map((i) => i.json).filter((e) => e && (e.start || e.id));   // empty calendar -> one empty item
const outcome = runTool(prep.call, { config: CONFIG, busy: eventsToBusy(events), now: prep.now });
return [{ json: { response: vapiResponse(prep.call, outcome), create: outcome.booked === true, event: outcome.event || null } }];
`;

const calendarRef = { __rl: true, value: "primary", mode: "id" };

export function buildWorkflow() {
  const nodes = [
    { name: "Vapi webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0],
      parameters: { httpMethod: "POST", path: "friseur-termine", authentication: "headerAuth", responseMode: "responseNode", options: {} },
      credentials: { httpHeaderAuth: { id: "REPLACE_ME", name: "Vapi shared secret (header x-vapi-secret)" } }, webhookId: id("webhook") },
    { name: "Prepare", type: "n8n-nodes-base.code", typeVersion: 2, position: [240, 0],
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: logicSource + "\n\n" + PREPARE_TAIL.trim() } },
    { name: "Get busy times", type: "n8n-nodes-base.googleCalendar", typeVersion: 1.3, position: [480, 0], alwaysOutputData: true,
      parameters: { operation: "getAll", calendar: calendarRef, returnAll: true,
        timeMin: "={{ $json.timeMin }}", timeMax: "={{ $json.timeMax }}", options: { singleEvents: true, timeZone: config.timezone } },
      credentials: { googleCalendarOAuth2Api: { id: "REPLACE_ME", name: "Google Calendar account" } } },
    { name: "Decide", type: "n8n-nodes-base.code", typeVersion: 2, position: [720, 0],
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: logicSource + "\n\n" + DECIDE_TAIL.trim() } },
    { name: "Booked?", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [960, 0],
      parameters: { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
        conditions: [{ id: id("cond"), leftValue: "={{ $json.create }}", rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, options: {} } },
    { name: "Create event", type: "n8n-nodes-base.googleCalendar", typeVersion: 1.3, position: [1200, -120],
      parameters: { operation: "create", calendar: calendarRef, start: "={{ $json.event.start }}", end: "={{ $json.event.end }}",
        additionalFields: { summary: "={{ $json.event.summary }}", description: "={{ $json.event.description }}" } },
      credentials: { googleCalendarOAuth2Api: { id: "REPLACE_ME", name: "Google Calendar account" } } },
    { name: "Respond to Vapi", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.4, position: [1440, 0],
      parameters: { respondWith: "json", responseBody: "={{ $('Decide').first().json.response }}", options: {} } },
  ].map((n) => ({ id: id(n.name), ...n }));

  const link = (to, index = 0) => ({ node: to, type: "main", index });
  return {
    name: "Salon voice agent – appointment tools",
    nodes,
    connections: {
      "Vapi webhook": { main: [[link("Prepare")]] },
      "Prepare": { main: [[link("Get busy times")]] },
      "Get busy times": { main: [[link("Decide")]] },
      "Decide": { main: [[link("Booked?")]] },
      "Booked?": { main: [[link("Create event")], [link("Respond to Vapi")]] },
      "Create event": { main: [[link("Respond to Vapi")]] },
    },
    active: false,
    settings: { executionOrder: "v1" },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("workflow.json", import.meta.url), JSON.stringify(buildWorkflow(), null, 2) + "\n");
  console.log("n8n/workflow.json written");
}
