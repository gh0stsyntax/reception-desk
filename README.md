# reception-desk — appointment tools for a Vapi phone agent (n8n + reference webhook)

[![tests](https://github.com/gh0stsyntax/reception-desk/actions/workflows/tests.yml/badge.svg)](https://github.com/gh0stsyntax/reception-desk/actions/workflows/tests.yml)

A phone assistant that books hair-salon appointments needs two server-side tools. This repository contains
the logic behind them, written once, tested, and delivered in two forms:

* an **importable n8n workflow** (`n8n/workflow.json`: webhook → Google Calendar → decision → create event → response), and
* a **dependency-free reference webhook** (`src/server.mjs`) with the same path and the same answers, for local runs.

The salon ("Haarwerk") is a **fictional test salon**; opening hours, services and the calendar are sample data.

> **Honest status.** This is a *reconstruction*. The original n8n cloud workflow of my first prototype no longer exists
> (the instance was deleted); what survived was the Vapi tool contract (`check_availability`, `book_appointment`). I rebuilt the
> behaviour from that contract and tested it. The request/response format was checked against the Vapi documentation (below).
> **Not verified:** a live call through Vapi, and the workflow against a real Google Calendar account
> (it imports into n8n 2.8 and its code nodes are tested, but credentials are placeholders).

## What the tools guarantee

| Rule | Where it is enforced |
|---|---|
| The model never computes dates: `"morgen"`, `"nächsten Freitag"`, `"halb drei"` are resolved by the server | `parseGermanDate`, `parseGermanTime` |
| A booking needs `confirmed === true` (a string `"true"` is not enough), a name, and a slot that is **still free at booking time** | `bookAppointment` |
| Unclear input is reported as unclear, never answered with a guess (`available: null`) | `checkAvailability` |
| Opening hours, closed days, 30-minute grid, minimum lead time, booking horizon, service duration must fit entirely | `slotProblem` |
| Busy times from Google Calendar: timed, all-day, multi-day; cancelled and "free" events are ignored | `eventsToBusy` |
| Failed bookings come with up to three free alternatives (nearest first) | `findAlternatives` |
| **Retries are safe:** a repeated `toolCallId` returns the first answer and writes the calendar only once | `runToolOnce` |
| Tool failures use Vapi's `error` field; real answers (also "that slot is taken") use `result` | `vapiResponse` |
| Webhook secret compared in constant time, 64 KB body limit, binds to 127.0.0.1, refuses to start without a secret | `src/server.mjs` |

## The Vapi contract (checked against docs.vapi.ai on 25 Nov 2026)

| | |
|---|---|
| Request | `POST` with `{"message": {"type": "tool-calls", "toolCallList": [{"id", "type": "function", "function": {"name", "arguments"}}]}}`; `toolWithToolCallList` is read too, `arguments` may be an object or a JSON string |
| Response | `{"results": [{"toolCallId", "result"}]}` or `{"toolCallId", "error"}`; both are **single-line strings**; one entry per call, ids must match |
| Status code | `200` for every answer (also failures, those go into `error`); Vapi ignores any other status |
| Authentication | Custom credential: *Bearer Token* (`Authorization: Bearer …`, default) or the legacy header `X-Vapi-Secret`; both accepted |
| Timeout | default 20 s (`vapi/tools.json` sets 20); sync tools (`async: false`) |
| Retries | off by default, configurable with a backoff plan; a retry can deliver the same call twice, hence the idempotency above |
| Reachability | Vapi refuses localhost and private addresses: a live test needs a public HTTPS URL (tunnel or server) |

## Run it

```bash
npm test                                   # 34 tests, Node >= 20, no dependencies
SALON_WEBHOOK_SECRET=$(openssl rand -hex 24) npm start

curl -s -X POST localhost:8787/webhook/friseur-termine \
  -H "authorization: Bearer $SALON_WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"message":{"type":"tool-calls","toolCallList":[{"id":"c1","type":"function","function":{"name":"check_availability","arguments":{"time":"10:00","requested_date_text":"Freitag"}}}]}}'
```

n8n: import `n8n/workflow.json`, attach a *Header Auth* credential to the webhook (header `Authorization` with value
`Bearer <secret>`, or `x-vapi-secret`) and your Google Calendar credential to the two calendar nodes, activate the workflow
(the retry memory lives in n8n's workflow static data, which is kept for active workflows), then point the Vapi tools
(`vapi/tools.json`) at the production webhook URL. `npm run build` regenerates the workflow from `src/salon_logic.mjs` and
`config/salon.json`; a test fails if the committed file is out of date.

## How it is tested

* **34 tests** (`node --test`): date/time parsing tables, rule boundaries (touching slots, midnight-spanning events, closing time),
  booking safety, the documented Vapi payload shapes, `result` vs `error`, retries, server authentication and double-booking,
  workflow graph and drift.
* **Parity test:** the same requests go through the reference server *and* through the code nodes embedded in `workflow.json`
  (executed in a sandbox with a fixed clock); the answers must be identical.
* **Mutation checks:** I broke the code on purpose in 18 places in two rounds (booking without confirmation, off-by-one at slot
  edges, past dates allowed, missing authentication, swapped IF branches, no retry protection, ignoring the documented
  `toolCallList` ...); every mutation turned at least one test red (18/18). Two real bugs were found on the way:
  `"übermorgen"` was not recognised (JavaScript's `\b` does not know umlauts) and `"um 9"` was rejected. Comparing with the
  Vapi documentation then showed three more gaps that are fixed and tested: technical failures belonged in `error`, a retried
  booking would have reported "slot taken", and Bearer authentication was not accepted.
* The workflow's node types and versions were checked against the installed n8n 2.8 and it imports cleanly into an isolated n8n instance.

## Known limits

* No live call and no real calendar yet (see the status above).
* One tool call per request in the n8n workflow (Vapi sends them one at a time); the reference server handles several in order.
* Time handling assumes the calendar returns local wall-clock times in the salon's time zone.
* The reference server keeps bookings and the retry memory in RAM; it is a stand-in for a calendar, not a persistence layer.
* German only. Times 1–8 without a day part are read as afternoon.

## License

MIT
