import { readCloudSensor, sendIrCommand } from '../../lib/broadlink-app-cloud.js';
import { FANS, FAN_LABEL, nextCommand } from '../public/policy.js';

const headers = { 'Cache-Control': 'no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers });
const ranges = { '6s': 6 * 3600000, '24s': 24 * 3600000, '7g': 7 * 86400000 };

async function equal(a, b) {
  if (!a || !b) return false;
  const e = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async v => new Uint8Array(await crypto.subtle.digest('SHA-256', e.encode(v)))));
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const cookieKey = request => /(?:^|; )k=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1] ?? null;

// Optional push via ntfy.sh. Does nothing unless the NTFY_TOPIC secret is set. Never throws.
async function notify(env, title, message, tags) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, tags }) });
  } catch { /* notifications are best effort */ }
}

async function sendAc(env, action, target, fan, source, temp) {
  const name = action === 'off' ? 'off' : `cool_${target}_${fan}`;
  const row = await env.DB.prepare('SELECT code FROM ir_codes WHERE name = ?').bind(name).first();
  if (!row) return { ok: false, error: 'no_code' };
  let ok = 1;
  try { await sendIrCommand(JSON.parse(env.BROADLINK_SESSION), row.code); } catch { ok = 0; }
  await env.DB.prepare('INSERT OR REPLACE INTO ac_state (id, power, target, fan, at, source, ok) VALUES (1, ?, ?, ?, ?, ?, ?)').bind(action === 'off' ? 'off' : 'on', action === 'off' ? null : target, action === 'off' ? null : fan, Date.now(), source, ok).run();
  if (source === 'auto') {
    const t = Number.isFinite(temp) ? `Oda ${temp.toFixed(1)}°. ` : '';
    if (!ok) await notify(env, 'Klima komutu gitmedi', `${t}Otomatik komut gönderilemedi.`, ['warning']);
    else if (action === 'off') await notify(env, 'Klima kapatıldı', `${t}Alt sınırın altına inildi, otomatik kapatıldı.`, ['snowflake']);
    else await notify(env, 'Klima açıldı', `${t}Hedef ${target}°, fan ${FAN_LABEL[fan]}.`, ['snowflake']);
  }
  return { ok: !!ok };
}

// Flips only profile.auto and keeps the rest of the saved settings.
async function setAuto(env, auto) {
  const row = await env.DB.prepare('SELECT settings FROM profile WHERE id = 1').first();
  const cfg = row ? JSON.parse(row.settings) : {};
  cfg.auto = auto;
  await env.DB.prepare('INSERT OR REPLACE INTO profile (id, settings, updated_at) VALUES (1, ?, ?)').bind(JSON.stringify(cfg), Date.now()).run();
}

// Off by default. Rules are in public/policy.js and explained on the page.
async function control(env, sample) {
  const row = await env.DB.prepare('SELECT settings FROM profile WHERE id = 1').first();
  const cfg = row ? JSON.parse(row.settings) : {};
  if (cfg.auto !== true || !Number.isFinite(cfg.tMin) || !Number.isFinite(cfg.tMax) || Date.now() - sample.at > 180000) return;
  const state = await env.DB.prepare('SELECT power, target, fan, at, source, ok FROM ac_state WHERE id = 1').first();
  const cmd = nextCommand(cfg, sample.temperature, state);
  if (cmd) await sendAc(env, cmd.action, cmd.target ?? null, cmd.fan ?? null, 'auto', sample.temperature);
}

async function poll(env) {
  const now = Date.now();
  const last = await env.DB.prepare('SELECT at FROM samples ORDER BY at DESC LIMIT 1').first();
  if (last && now - last.at < 50000) return { saved: false };
  const prev = await env.DB.prepare('SELECT ok FROM status WHERE id = 1').first();
  try {
    const s = await readCloudSensor(JSON.parse(env.BROADLINK_SESSION));
    await env.DB.prepare('INSERT OR IGNORE INTO samples (at, temperature, humidity) VALUES (?, ?, ?)').bind(s.at, s.temperature, s.humidity).run();
    await env.DB.prepare('INSERT OR REPLACE INTO status (id, at, ok) VALUES (1, ?, 1)').bind(now).run();
    if (prev?.ok === 0) await notify(env, 'Sensör geri geldi', 'BroadLink bulutundan okuma yeniden çalışıyor.', ['white_check_mark']);
    try { await control(env, s); } catch { /* sensor logging must not fail because of control */ }
    return { saved: true };
  } catch {
    await env.DB.prepare('INSERT OR REPLACE INTO status (id, at, ok) VALUES (1, ?, 0)').bind(now).run();
    if (prev?.ok !== 0) await notify(env, 'Sensör okunamıyor', 'BroadLink oturumu dolmuş olabilir. Otomasyon çalışmaz; BROADLINK_SESSION yenilenmeli.', ['rotating_light']);
    return { saved: false, error: 'cloud_unavailable' };
  }
}

async function sensor(url, env) {
  const range = url.searchParams.get('range');
  const format = url.searchParams.get('format');
  const sample = await env.DB.prepare('SELECT temperature, humidity, at FROM samples ORDER BY at DESC LIMIT 1').first();
  if (!range && !format) return json({ sample });
  if (!Object.hasOwn(ranges, range) || (format && !['csv', 'json'].includes(format))) return json({ error: 'invalid_range' }, 400);
  const since = Date.now() - ranges[range];
  if (format) {
    const result = await env.DB.prepare('SELECT at, temperature, humidity FROM samples WHERE at >= ? ORDER BY at ASC LIMIT 20001').bind(since).all();
    const truncated = result.results.length > 20000;
    const rows = result.results.slice(0, 20000);
    if (format === 'csv') {
      const csv = ['time_utc,temperature_c,humidity_percent', ...rows.map(r => `${new Date(r.at).toISOString()},${r.temperature},${r.humidity}`)].join('\r\n');
      return new Response(csv, { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sensor-gecmisi.csv"' } });
    }
    return Response.json({ samples: rows, truncated }, { headers: { ...headers, 'Content-Disposition': 'attachment; filename="sensor-gecmisi.json"' } });
  }
  const bucket = range === '7g' ? 1800000 : 300000;
  const samples = await env.DB.prepare('SELECT CAST(at / ? AS INTEGER) * ? AS at, AVG(temperature) AS temperature, AVG(humidity) AS humidity FROM samples WHERE at >= ? GROUP BY CAST(at / ? AS INTEGER) ORDER BY at ASC LIMIT 3000').bind(bucket, bucket, since, bucket).all();
  const hourly = await env.DB.prepare('SELECT CAST(at / 3600000 AS INTEGER) * 3600000 AS at, MIN(temperature) AS min_temperature, MAX(temperature) AS max_temperature, MIN(humidity) AS min_humidity, MAX(humidity) AS max_humidity FROM samples WHERE at >= ? GROUP BY CAST(at / 3600000 AS INTEGER) ORDER BY at ASC LIMIT 200').bind(since).all();
  return json({ sample, samples: samples.results, hourly: hourly.results });
}

async function profile(request, env, keyed) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT settings FROM profile WHERE id = 1').first();
    return json({ profile: row ? JSON.parse(row.settings) : null });
  }
  if (request.method === 'PUT') {
    if (!keyed && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403);
    const raw = await request.text();
    let data;
    try { data = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
    if (raw.length > 20000 || !data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'invalid_profile' }, 400);
    if ('auto' in data && typeof data.auto !== 'boolean') return json({ error: 'invalid_profile' }, 400);
    await env.DB.prepare('INSERT OR REPLACE INTO profile (id, settings, updated_at) VALUES (1, ?, ?)').bind(raw, Date.now()).run();
    return json({ profile: data });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  scheduled(_event, env, ctx) { ctx.waitUntil(poll(env)); },
  async fetch(request, env) {
    const url = new URL(request.url);
    const supplied = url.searchParams.get('k');
    const key = supplied ?? cookieKey(request) ?? request.headers.get('x-key');
    const authorized = await equal(env.VIEW_KEY, key);
    // Shortcuts and scripts authenticate with the x-key header, which a cross-site page cannot set, so no Origin check is needed.
    const keyed = authorized && await equal(env.VIEW_KEY, request.headers.get('x-key'));
    const withCookie = response => {
      if (!authorized || !supplied) return response;
      const out = new Response(response.body, response);
      out.headers.append('Set-Cookie', `k=${encodeURIComponent(supplied)}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`);
      return out;
    };
    if (url.pathname === '/manifest.webmanifest') {
      const manifest = await (await env.ASSETS.fetch(request)).json();
      if (authorized) manifest.start_url = `/?k=${encodeURIComponent(key)}`;
      return withCookie(Response.json(manifest, { headers: { ...headers, 'Content-Type': 'application/manifest+json' } }));
    }
    if (!url.pathname.startsWith('/api/')) return withCookie(await env.ASSETS.fetch(request));
    if (!authorized) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/sensor') return sensor(url, env);
    if (url.pathname === '/api/profile') return profile(request, env, keyed);
    if (url.pathname === '/api/ac') {
      if (request.method === 'GET') return json({ state: await env.DB.prepare('SELECT power, target, fan, at, source, ok FROM ac_state WHERE id = 1').first() });
      if (request.method === 'POST') {
        if (!keyed && request.headers.get('origin') !== url.origin) return json({ error: 'forbidden' }, 403);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid', field: 'json' }, 400); }
        // Apple Shortcuts sends variables as text ("24"), so accept whole-number strings.
        if (typeof body?.target === 'string' && /^\d{1,2}$/.test(body.target)) body.target = Number(body.target);
        // Optional `auto` (boolean or "true"/"false") switches the automation; alone it sends no AC command.
        let auto = body?.auto;
        if (auto === 'true' || auto === 'false') auto = auto === 'true';
        if (auto !== undefined && typeof auto !== 'boolean') return json({ error: 'invalid', field: 'auto' }, 400);
        if (auto !== undefined) {
          await setAuto(env, auto);
          if (body.action === undefined) return json({ ok: true, auto });
        }
        const bad = !['off', 'cool'].includes(body?.action) ? `action=${JSON.stringify(body?.action)}`
          : body.action === 'cool' && !(Number.isInteger(body.target) && body.target >= 18 && body.target <= 30) ? `target=${JSON.stringify(body.target)}`
          : body.action === 'cool' && !FANS.includes(body.fan) ? `fan=${JSON.stringify(body.fan)}` : null;
        if (bad) return json({ error: 'invalid', field: bad }, 400);
        const result = await sendAc(env, body.action, body.target, body.fan, 'manual');
        return json(result, result.ok ? 200 : 502);
      }
    }
    if (url.pathname === '/api/poll' && request.method === 'POST') return json(await poll(env));
    return json({ error: 'not_found' }, 404);
  },
};
