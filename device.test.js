import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloud/src/index.js';
import { broadlinkToRaw } from '../lib/ir.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../cloud/schema.sql', import.meta.url), 'utf8'));
  const stmt = sql => {
    let args = [];
    const s = {
      bind: (...a) => { args = a; return s; },
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => { db.prepare(sql).run(...args); return {}; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    };
    return s;
  };
  return { db, prepare: stmt };
}

// 26 00 len16, mark 105, space 56, mark 13, then a 00 0d 05 trailer gap
const IR = Buffer.from([0x26, 0, 0x06, 0, 0x69, 0x38, 0x0d, 0x00, 0x0d, 0x05, 0, 0]).toString('base64');

function setup() {
  const DB = makeDb();
  DB.db.prepare('INSERT INTO ir_codes (name, code) VALUES (?, ?)').run('cool_25_auto', IR);
  DB.db.prepare('INSERT INTO ir_codes (name, code) VALUES (?, ?)').run('off', IR);
  const env = { DB, VIEW_KEY: 'k', DEVICE_KEY: 'd', BROADLINK_SESSION: '{}', ASSETS: { fetch: async () => new Response('') } };
  const call = (path, body, headers = { 'x-key': 'k' }) => worker.fetch(new Request(`https://x.test${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  const report = (body, key = 'd') => call('/api/device', body, { 'x-device-key': key });
  return { env, DB, call, report };
}

test('broadlinkToRaw: ticks to signed microseconds, trailer dropped', () => {
  assert.deepEqual(broadlinkToRaw(IR), [3448, -1839, 427]);
});

test('device endpoint needs its key; VIEW_KEY is the fallback only while DEVICE_KEY is unset', async () => {
  const { env, report } = setup();
  assert.equal((await report({ t: 25, h: 50 }, 'nope')).status, 401);
  assert.equal((await report({ t: 25, h: 50 }, 'k')).status, 401);
  delete env.DEVICE_KEY;
  assert.equal((await report({ t: 25, h: 50 }, 'k')).status, 200);
});

test('while the backend is broadlink a device report is remembered but changes nothing', async () => {
  const { DB, report, call } = setup();
  const res = await (await report({ t: 25.4, h: 61, rssi: -60 })).json();
  assert.deepEqual(res, { ok: true, backend: 'broadlink', cmd: null });
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 0);
  const b = await (await call('/api/backend')).json();
  assert.equal(b.mode, 'broadlink');
  assert.equal(b.device.t, 25.4);
});

test('esp backend: report stores a sample, a manual command is queued, delivered, acked once', async () => {
  const { env, DB, call, report } = setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('BroadLink must not be called'); };
  try {
    assert.equal((await call('/api/backend', { mode: 'esp' })).status, 200);
    const r1 = await (await report({ t: 26.1, h: 55 })).json();
    assert.equal(r1.cmd, null);
    assert.equal(DB.db.prepare('SELECT temperature FROM samples').get().temperature, 26.1);
    assert.equal(DB.db.prepare('SELECT ok FROM status').get().ok, 1);

    const sent = await call('/api/ac', { action: 'cool', target: 25, fan: 'auto' });
    assert.equal(sent.status, 200);
    const r2 = await (await report({ t: 26.0, h: 55 })).json();
    assert.equal(r2.cmd.name, 'cool_25_auto');
    assert.equal(r2.cmd.carrier, 38000);
    assert.deepEqual(r2.cmd.raw, [3448, -1839, 427]);
    // not acked yet: delivered again
    assert.equal((await (await report({ t: 26.0, h: 55 })).json()).cmd.id, r2.cmd.id);
    // acked: gone
    assert.equal((await (await report({ t: 26.0, h: 55, ack: r2.cmd.id })).json()).cmd, null);
    const reasons = DB.db.prepare("SELECT reason FROM sensor_errors WHERE reason LIKE 'ir_%' ORDER BY rowid").all().map(r => r.reason);
    assert.deepEqual(reasons, ['ir_queued', 'ir_sent']);
    // the newest command wins
    await call('/api/ac', { action: 'cool', target: 25, fan: 'auto' });
    await call('/api/ac', { action: 'off' });
    assert.equal((await (await report({ t: 26, h: 55 })).json()).cmd.name, 'off');
  } finally { globalThis.fetch = realFetch; }
  // cron in esp mode never touches BroadLink and expires old commands
  DB.db.exec("UPDATE ir_queue SET at = 1 WHERE status = 'sent'");
  assert.equal((await worker.fetch(new Request('https://x.test/api/poll', { method: 'POST', headers: { 'x-key': 'k' } }), env)).status, 200);
  assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM ir_queue WHERE status = 'expired'").get().n, 1);
});

test('esp backend: bad sensor values are logged, commands still flow', async () => {
  const { DB, call, report } = setup();
  await call('/api/backend', { mode: 'esp' });
  await call('/api/ac', { action: 'off' });
  const r = await (await report({ err: 'sht30 nan' })).json();
  assert.equal(r.cmd.name, 'off');
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 0);
  assert.equal(DB.db.prepare("SELECT reason FROM sensor_errors WHERE reason = 'device_sensor'").get().reason, 'device_sensor');
});

test('backend switch needs the x-key header and a valid mode', async () => {
  const { call } = setup();
  assert.equal((await call('/api/backend', { mode: 'x' })).status, 400);
  assert.equal((await call('/api/backend', { mode: 'esp' }, { 'x-device-key': 'd' })).status, 401);
});

test('the page can switch the backend (same-origin) and /api/state reports it', async () => {
  const { env, call } = setup();
  const page = (mode) => worker.fetch(new Request('https://x.test/api/backend', { method: 'POST', headers: { cookie: 'k=k', origin: 'https://x.test', 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }), env);
  assert.equal((await (await page('esp')).json()).mode, 'esp');
  const st = await (await call('/api/state')).json();
  assert.equal(st.backend, 'esp');
  const cross = await worker.fetch(new Request('https://x.test/api/backend', { method: 'POST', headers: { cookie: 'k=k', origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'broadlink' }) }), env);
  assert.equal(cross.status, 403);
});
