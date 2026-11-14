# Cloudflare Worker

Cloudflare Worker + D1. A cron trigger runs every minute: reads temperature/humidity from the BroadLink cloud, stores it, serves the dashboard, and optionally runs the AC automation (off by default).

## What is and is not in the repo

| In the repo | In your Cloudflare account only |
| --- | --- |
| `src/index.js`, `public/`, `schema.sql`, `wrangler.toml` | Secret `BROADLINK_SESSION` |
| `seed/ir_codes.sql` (replace with your AC's codes) | Secret `VIEW_KEY` (dashboard key) |
| `../lib/broadlink-app-cloud.js`, tests | Secret `NTFY_TOPIC` (optional push) |
|  | D1 contents: samples, profile, AC state, command log (`ac_log`) |

## Setup

```bash
cd cloud
npx wrangler login
npx wrangler d1 create klima-sensor        # put the database_id into wrangler.toml
npx wrangler d1 execute klima-sensor --remote --file=schema.sql
npx wrangler d1 execute klima-sensor --remote --file=seed/ir_codes.sql
npx wrangler secret put VIEW_KEY            # a long random key
npx wrangler secret put BROADLINK_SESSION   # JSON, see below
npx wrangler deploy
```

`npm run deploy` (from the repo root) stamps the version from `package.json` and the short commit hash into the Worker; the dashboard shows both at the bottom, so you can tell which build is live.

Dashboard: `https://<worker>.<subdomain>.workers.dev/?k=<VIEW_KEY>` (the key is stored in a cookie). Scripts can send the key as an `x-key` header.

## BroadLink session

The app calls `POST https://app-service-*.ibroadlink.com/device/control/v2/sdkcontrol?license=...`. The sensor-read request (`directive.payload.data` = `JAAAAA==`, i.e. bytes `24 00 00 00`) is stored as:

```json
{ "url": "...", "headers": { "...": "..." }, "body": "<request body as text>" }
```

Capture it once with an HTTPS proxy app on your phone while opening the AC/sensor screen. If the session expires, the dashboard shows it as stale; capture again.

## API (all need the key)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sensor?range=6s\|24s\|7g` | history and the AC command log for the range; add `&format=csv\|json` to download |
| `GET /api/state` | latest reading, profile, AC state, last-hour swing and version in one call (what the dashboard polls) |
| `GET /api/version` | version and build shown in the dashboard footer |
| `GET/PUT /api/profile` | comfort band and automation switch |
| `GET /api/diag` | recent sensor gaps and failed reads with the raw RM4 reply; `?probe=1` also reads the sensor 3 times live without saving |
| `GET /api/ac` / `POST /api/ac` | last AC command / send `{"action":"off"}` or `{"action":"cool","target":24,"fan":"auto"}`; optional `"auto": true\|false` switches the automation |

## Automation

Rules live in `public/policy.js` and are shown on the page. The room target is the middle of the comfort range (the target you type; the range is target -1/+1). The aim is a steady room rather than on/off cycling: once the room is 0.5 C above the target the AC is set to the target with fan auto and stays on; every 20 minutes the AC setpoint moves 1 C toward the room target using the room sensor (deadband 0.5 C, between target -3 and +2), because the AC's own thermostat reads differently. Below the range the setpoint first goes up 2 C and the AC is switched off only if that is not enough; the next start uses the setpoint learned last time. Commands are re-sent every 30 minutes and every command is logged in `ac_log`. Choosing a target by hand (dashboard button or `POST /api/ac`) also moves the range to that target -1/+1.

## Push notifications (optional)

Install the ntfy app, subscribe to a long random topic, then `npx wrangler secret put NTFY_TOPIC`. You get a push when the automation switches the AC, when a command fails, and when the sensor goes down or comes back. Without `NTFY_TOPIC` nothing is sent.

## Sensor diagnostics

Every failed read goes to the `sensor_errors` table (time, reason, the RM4's raw reply as hex, detail) and to the worker log (`npx wrangler tail`); rows older than 30 days are dropped. A run of failed reads is one `sensor_gaps` row: `started`, `ended` (empty while it lasts), `reads`, `zero_reads` (how many were 0 °C / 0 %) and the first `reason`. The worker creates both tables itself. The recovery push says how long the gap lasted.

| Reason | Meaning |
| --- | --- |
| `zero` | the RM4 answered `24 00 00 00 00 00 00 00` (0 °C / 0 %): the HTS2 gives no value |
| `no_data` | the cloud answered without device data (RM4 may be offline); `detail` holds the start of the reply |
| `http` / `network` | the BroadLink cloud failed or did not answer within 15 s |
| `bad_reply` / `range` | unexpected reply or out-of-range value; see `raw` |
| `session` | `BROADLINK_SESSION` is invalid |

There is no retry or reconnect: the cron sends one request a minute and waits for the next minute on failure. The worker never talks to the RM4 directly, so there is nothing to reconnect; the BroadLink cloud reaches the device over its own link.

### Frozen RM4 or sensor?

While a gap is open:

1. Call `/api/diag?probe=1`. Three `zero` reads mean the RM4 answers and the HTS2 side gives no value; `no_data` / `network` mean the RM4 does not reach the cloud.
2. Send an IR command from the dashboard (if the AC is on, resend the same setting). If the AC reacts, the RM4 is not frozen.
3. Unplug and replug the HTS2 cable, probe again a minute later. If it recovers, it was the cable or sensor.
4. Otherwise cut the RM4's power for 10 s. If the next read closes the gap, the RM4 was frozen; `sensor_gaps.ended` lines up with the power cut.
