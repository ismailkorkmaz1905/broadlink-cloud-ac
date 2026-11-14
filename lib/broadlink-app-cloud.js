// Reads RM4 temperature/humidity through the BroadLink app cloud (/device/control/v2/sdkcontrol).
// The app sends data=base64(24 00 00 00), the same check-sensors command python-broadlink uses,
// and the cloud returns the device's raw reply in event.payload.data.

export function decodeSensorReply(b64) {
  const raw = Buffer.from(String(b64), 'base64');
  if (raw.length < 8 || raw[0] !== 0x24 || raw[1] || raw[2] || raw[3]) throw new Error('Not a sensor reply');
  return { temperature: raw[4] + raw[5] / 100, humidity: raw[6] + raw[7] / 100 };
}

export function validSession(session) {
  if (!session || typeof session !== 'object' || typeof session.body !== 'string' || !session.headers || typeof session.headers !== 'object') return false;
  let url;
  try { url = new URL(session.url); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (url.search && !/^\?license=[A-Za-z0-9%._~-]+$/.test(url.search))) return false;
  if (!/^[a-z0-9-]+\.ibroadlink\.com$/.test(url.hostname) || url.pathname !== '/device/control/v2/sdkcontrol') return false;
  try {
    const directive = JSON.parse(session.body).directive;
    if (directive?.payload?.data !== 'JAAAAA==') return false;
  } catch { return false; }
  return Object.values(session.headers).every(value => typeof value === 'string');
}

// Failed reads carry `reason` (session, network, http, no_data, bad_reply, zero, range) and, when the RM4 answered, its reply as `raw` hex,
// so the worker can log what actually came back.
function fail(reason, message, extra = {}) {
  return Object.assign(new Error(message), { reason, ...extra });
}

export async function readCloudSensor(session, fetchImpl = fetch, now = Date.now()) {
  if (!validSession(session)) throw fail('session', 'Invalid cloud session');
  const stamp = String(Math.floor(now / 1000));
  const headers = {};
  for (const [name, value] of Object.entries(session.headers)) {
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(name.toLowerCase())) continue;
    headers[name] = name.toLowerCase() === 'timestamp' ? stamp : value;
  }
  const body = JSON.parse(session.body);
  if (body.directive.header) body.directive.header.timstamp = stamp;
  let response;
  try {
    response = await fetchImpl(session.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) { throw fail('network', 'Cloud request failed', { detail: e?.name ?? String(e) }); }
  if (!response.ok) throw fail('http', 'Cloud request failed', { detail: `HTTP ${response.status ?? '?'}` });
  const reply = await response.json().catch(() => null);
  const data = reply?.event?.payload?.data;
  // No data usually means the cloud could not reach the RM4; keep the start of the reply, it holds the cloud's status code.
  if (!data) throw fail('no_data', 'Cloud reply has no sensor data', { detail: JSON.stringify(reply)?.slice(0, 300) ?? null });
  const raw = Buffer.from(String(data), 'base64').toString('hex');
  let sample;
  try { sample = decodeSensorReply(data); } catch { throw fail('bad_reply', 'Not a sensor reply', { raw }); }
  // The RM4 answers 0.00 °C / 0.00 % when it has no reading (HTS2 cable loose, sensor not ready); that is a failed read, not a sample.
  if (sample.temperature === 0 && sample.humidity === 0) throw fail('zero', 'Sensor returned no reading', { raw });
  if (!(sample.temperature > -40 && sample.temperature < 80 && sample.humidity >= 0 && sample.humidity <= 100)) throw fail('range', 'Sensor value out of range', { raw });
  return { ...sample, at: now, raw };
}

// Sends a Broadlink IR packet (base64, starts with 0x26) through the same cloud endpoint the app uses.
export async function sendIrCommand(session, irBase64, fetchImpl = fetch, now = Date.now()) {
  if (!validSession(session)) throw new Error('Invalid cloud session');
  const ir = Buffer.from(String(irBase64), 'base64');
  if (ir.length < 20 || ir.length > 2000 || ir[0] !== 0x26) throw new Error('Not an IR packet');
  const stamp = String(Math.floor(now / 1000));
  const headers = {};
  for (const [name, value] of Object.entries(session.headers)) {
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(name.toLowerCase())) continue;
    headers[name] = name.toLowerCase() === 'timestamp' ? stamp : value;
  }
  const body = JSON.parse(session.body);
  if (body.directive.header) body.directive.header.timstamp = stamp;
  body.directive.payload.data = Buffer.concat([Buffer.from([2, 0, 0, 0]), ir]).toString('base64');
  const response = await fetchImpl(session.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Cloud request failed');
  if (!(await response.json())?.event) throw new Error('Cloud reply invalid');
  return { at: now };
}
