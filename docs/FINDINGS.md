# Findings: reading a BroadLink RM4 Mini + HTS2 and driving an IR AC from the cloud

Notes from getting the sensor and IR blaster to work without an always-on computer. Everything here comes from one account, one RM4 Mini with an HTS2 sensor, one iPhone and one split AC, tested in November 2026. Treat it as evidence from one setup, not a spec.

## What works

**Reading the sensor over HTTPS.** The BroadLink iPhone app reads the sensor with a plain HTTPS call, not a WebSocket:

```
POST https://app-service-<region>-*.ibroadlink.com/device/control/v2/sdkcontrol?license=...
directive.payload.data = base64(24 00 00 00)
```

`24 00 00 00` is the same "check sensors" command python-broadlink sends over UDP. The cloud returns the device's raw reply, unencrypted, in `event.payload.data`:

```
24 00 00 00 TT tt HH hh ...
temperature = TT + tt/100   humidity = HH + hh/100
```

Checks done: replayed responses matched a python-broadlink reading taken on the LAN at the same minute (for example 24.60 C / 73.67 % and 24.77 C / 74.55 % on both), `timeOfSample` was the request time (fresh, not cached), and the same request returned correct values when sent from a Cloudflare Worker, so there was no obvious IP or country block.

**Sending IR the same way.** The app's IR send uses the same endpoint with `directive.payload.data = base64(02 00 00 00 + <IR packet starting 0x26>)`. Off and cool commands sent this way operated the AC.

**Request authenticity.** The request carries the app's session headers (`loginsession`, `userid`, `licenseid`, `familyid`) plus a body copied from a captured call. Old and fresh timestamps were both accepted and no signature header was seen. The session headers are credentials.

**IR code sanity.** The AC used here speaks a Fujitsu-style frame. All 65 cool codes from SmartIR device 1287 follow one checksum rule, one temperature encoding and one fan order, which gives byte-level confidence in the code table. The physical effect of the fan codes was not tested.

## What did not work

| Route | Result |
| --- | --- |
| Google Home (unofficial HomeGraph client) | Sensors were discovered, but `states` came back empty for both temperature and humidity. |
| Alexa (unofficial client, GraphQL and the older endpoint) | Values were returned but stale: the same `timeOfSample` and the same humidity for hours. Latency-tolerance options did not help, and the endpoint rate-limited quickly. |
| Magic Home / cloud-to-cloud OAuth | The standard BroadLink app showed no authorization code. BroadLink support said individual developers do not get cloud-to-cloud API access. |
| WebSocket sniffing | The BroadLink traffic captured contained no WebSocket; the only one was Alexa's login. HAR export does not include WebSocket messages anyway. |

## Things to know

- With the app's "local network" permission off, the sensor reading disappeared on Wi-Fi but reappeared on mobile data. On Wi-Fi the app reads locally; away from home it uses the cloud path above.
- IR is one-way. The AC's real state is unknown; track only what you last sent.
- Capturing your own session needs an HTTPS proxy app on the phone and its certificate trusted while you capture. Remove the profile afterwards.

## Unknown

- How long the `loginsession` lives and whether it can be refreshed. A long-running Worker will hit errors when it expires and you capture again.
- Whether other regions, accounts or firmware behave the same.
- Whether BroadLink will change or block this.
