// Reference webhook for the Vapi tools, without n8n: same path, same logic, in-memory calendar.
// Local-first and secure by default: binds to 127.0.0.1, refuses to start without a shared secret.
//
//   SALON_WEBHOOK_SECRET=<long random string> node src/server.mjs
//   (Vapi: Tool -> Server URL = https://<your tunnel>/webhook/friseur-termine, credential "Bearer Token" or legacy header X-Vapi-Secret)
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractToolCalls, runToolOnce, vapiResponse, nowIn } from "./salon_logic.mjs";

export const WEBHOOK_PATH = "/webhook/friseur-termine";
const MAX_BODY_BYTES = 64 * 1024;

export function loadConfig(path = new URL("../config/salon.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();      // equal length, constant-time compare
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** Vapi custom credentials: "Bearer Token" sends `Authorization: Bearer <secret>`; the legacy option sends `X-Vapi-Secret: <secret>`. */
function authorized(req, secret) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers["authorization"] || ""));
  const candidates = [req.headers["x-vapi-secret"], bearer && bearer[1]].filter(Boolean);
  return candidates.some((c) => safeEqual(c, secret));
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** @param {{secret: string, config?: object, calendar?: Array, clock?: () => {date: string, time: string}}} options */
export function createApp({ secret, config = loadConfig(), calendar = [], clock } = {}) {
  if (!secret) throw new Error("A shared secret is required (set SALON_WEBHOOK_SECRET).");
  const now = clock || (() => nowIn(config.timezone));
  const memory = { order: [], answers: {} };                          // answers per toolCallId (retried deliveries)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== WEBHOOK_PATH) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    if (!authorized(req, secret)) return send(res, 401, { error: "unauthorized" });
    const chunks = []; let size = 0, tooBig = false;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY_BYTES) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on("close", () => { if (tooBig && !res.writableEnded) send(res, 413, { error: "body too large" }); });
    req.on("end", () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
      const calls = extractToolCalls(body);
      const results = [];
      for (const call of calls) {                                      // sequential: a booking changes what the next call sees
        const { outcome, replay } = runToolOnce(call, { config, busy: calendar, now: now() }, memory);
        if (!replay && outcome.booked && outcome.event) calendar.push({ start: outcome.event.start, end: outcome.event.end });
        results.push(vapiResponse(call, outcome).results[0]);
      }
      send(res, 200, { results });
    });
  });
  return { server, calendar };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secret = process.env.SALON_WEBHOOK_SECRET;
  if (!secret) { console.error("Refusing to start without SALON_WEBHOOK_SECRET."); process.exit(1); }
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  createApp({ secret }).server.listen(port, host, () => console.log(`salon webhook on http://${host}:${port}${WEBHOOK_PATH}`));
}
