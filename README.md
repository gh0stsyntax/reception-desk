# salon-voice-agent — appointment tools for a Vapi phone agent (n8n + reference webhook)

[![tests](https://github.com/gh0stsyntax/reception-desk/actions/workflows/tests.yml/badge.svg)](https://github.com/gh0stsyntax/reception-desk/actions/workflows/tests.yml)

A phone assistant that books hair-salon appointments needs two server-side tools. This repository contains
the logic behind them, written once, tested, and delivered in two forms:

* an **importable n8n workflow** (`n8n/workflow.json`: webhook → Google Calendar → decision → create event → response), and
* a **dependency-free reference webhook** (`src/server.mjs`) with the same path and the same answers, for local runs.

The salon ("Haarwerk") is a **fictional test salon**; opening hours, services and the calendar are sample data.

> **Honest status.** This is a *reconstruction*. The original n8n cloud workflow of my first prototype no longer exists
> (the instance was deleted); what survived was the Vapi tool contract (`check_availability`, `book_appointment`). I rebuilt the
> behaviour from that contract and tested it. **Not verified:** a live call through Vapi, and the workflow against a real
> Google Calendar account (it imports into n8n 2.8 and its code nodes are tested, but credentials are placeholders).

## What the tools guarantee

| Rule | Where it is enforced |
|---|---|
| The model never computes dates: `"morgen"`, `"nächsten Freitag"`, `"halb drei"` are resolved by the server | `parseGermanDate`, `parseGermanTime` |
| A booking needs `confirmed === true` (a string `"true"` is not enough), a name, and a slot that is **still free at booking time** | `bookAppointment` |
| Unclear input is reported as unclear, never answered with a guess ("available: null") | `checkAvailability` |
| Opening hours, closed days, 30-minute grid, minimum lead time, booking horizon, service duration must fit entirely | `slotProblem` |
| Busy times from Google Calendar: timed, all-day, multi-day; cancelled and "free" events are ignored | `eventsToBusy` |
| Failed bookings come with up to three free alternatives (nearest first) | `findAlternatives` |
| Tool errors never look like success; unknown tools and invalid JSON are answered with a clear failure | `runTool` |
| Webhook secret compared in constant time, 64 KB body limit, binds to 127.0.0.1, refuses to start without a secret | `src/server.mjs` |

## Run it

```bash
npm test                                   # 27 tests, Node >= 20, no dependencies
SALON_WEBHOOK_SECRET=$(openssl rand -hex 24) npm start

curl -s -X POST localhost:8787/webhook/friseur-termine \
  -H "x-vapi-secret: $SALON_WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"message":{"type":"tool-calls","toolCallList":[{"id":"c1","name":"check_availability","arguments":{"time":"10:00","requested_date_text":"Freitag"}}]}}'
```

n8n: import `n8n/workflow.json`, attach a *Header Auth* credential (header `x-vapi-secret`) to the webhook and your Google
Calendar credential to the two calendar nodes, then point the Vapi tools (`vapi/tools.json`) at the production webhook URL.
`npm run build` regenerates the workflow from `src/salon_logic.mjs` and `config/salon.json`; a test fails if the committed file is out of date.

## How it is tested

* **27 tests** (`node --test`): date/time parsing tables, rule boundaries (touching slots, midnight-spanning events, closing time),
  booking safety, Vapi payload shapes, server authentication and double-booking, workflow graph and drift.
* **Parity test:** the same requests go through the reference server *and* through the code nodes embedded in `workflow.json`
  (executed in a sandbox with a fixed clock); the answers must be identical.
* **Mutation check:** I broke the code on purpose in 10 places (booking without confirmation, off-by-one at slot edges,
  past dates allowed, missing authentication, swapped IF branches ...); every mutation turned at least one test red (10/10).
  The first run also found two real bugs before they reached a test: `"übermorgen"` was not recognised (JavaScript's `\b`
  does not know umlauts) and `"um 9"` was rejected.
* The workflow's node types and versions were checked against the installed n8n 2.8 and it imports cleanly into an isolated n8n instance.

## Known limits

* One tool call per request in the n8n workflow (Vapi sends them one at a time); the reference server handles several in order.
* Time handling assumes the calendar returns local wall-clock times in the salon's time zone.
* The reference server keeps bookings in memory; it is a stand-in for a calendar, not a persistence layer.
* German only. Times 1–8 without a day part are read as afternoon.

## License

MIT
