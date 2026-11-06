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

export async function readCloudSensor(session, fetchImpl = fetch, now = Date.now()) {
  if (!validSession(session)) throw new Error('Invalid cloud session');
  const stamp = String(Math.floor(now / 1000));
  const headers = {};
  for (const [name, value] of Object.entries(session.headers)) {
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(name.toLowerCase())) continue;
    headers[name] = name.toLowerCase() === 'timestamp' ? stamp : value;
  }
  const body = JSON.parse(session.body);
  if (body.directive.header) body.directive.header.timstamp = stamp;
  const response = await fetchImpl(session.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Cloud request failed');
  const data = (await response.json())?.event?.payload?.data;
  if (!data) throw new Error('Cloud reply has no sensor data');
  const sample = decodeSensorReply(data);
  if (!(sample.temperature > -40 && sample.temperature < 80 && sample.humidity >= 0 && sample.humidity <= 100)) throw new Error('Sensor value out of range');
  return { ...sample, at: now };
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
