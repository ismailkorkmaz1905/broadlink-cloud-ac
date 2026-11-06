# Cloudflare Worker

Cloudflare Worker + D1. A cron trigger runs every minute: reads temperature/humidity from the BroadLink cloud, stores it, serves the dashboard, and optionally runs the AC automation (off by default).

## What is and is not in the repo

| In the repo | In your Cloudflare account only |
| --- | --- |
| `src/index.js`, `public/`, `schema.sql`, `wrangler.toml` | Secret `BROADLINK_SESSION` |
| `seed/ir_codes.sql` (replace with your AC's codes) | Secret `VIEW_KEY` (dashboard key) |
| `../lib/broadlink-app-cloud.js`, tests | Secret `NTFY_TOPIC` (optional push) |
|  | D1 contents: samples, profile, AC state |

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
| `GET /api/sensor?range=6s\|24s\|7g` | latest sample and history; add `&format=csv\|json` to download |
| `GET/PUT /api/profile` | comfort band and automation switch |
| `GET /api/ac` / `POST /api/ac` | last AC command / send `{"action":"off"}` or `{"action":"cool","target":24,"fan":"auto"}`; optional `"auto": true\|false` switches the automation |

## Automation

Rules live in `public/policy.js` and are shown on the page. Above the upper bound the AC is set to the lower bound and cooling starts (fan scales with the overshoot); below the lower bound it is switched off; inside the band the last state is kept. Commands are spaced at least 10 minutes apart.

## Push notifications (optional)

Install the ntfy app, subscribe to a long random topic, then `npx wrangler secret put NTFY_TOPIC`. You get a push when the automation switches the AC, when a command fails, and when the sensor goes down or comes back. Without `NTFY_TOPIC` nothing is sent.
