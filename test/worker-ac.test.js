import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloud/src/index.js';

// Minimal D1 look-alike on top of node:sqlite so the real Worker code runs end to end.
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

const IR = Buffer.concat([Buffer.from([0x26, 0, 0x10, 0]), Buffer.alloc(30, 7)]).toString('base64');
const SESSION = JSON.stringify({
  url: 'https://app-service-usa-test.ibroadlink.com/device/control/v2/sdkcontrol?license=abc',
  headers: { loginsession: 'x', 'content-type': 'application/json' },
  body: JSON.stringify({ directive: { header: {}, payload: { data: 'JAAAAA==' } } }),
});

function setup(profile) {
  const DB = makeDb();
  DB.db.prepare('INSERT INTO ir_codes (name, code) VALUES (?, ?)').run('cool_25_auto', IR);
  DB.db.prepare('INSERT INTO ir_codes (name, code) VALUES (?, ?)').run('off', IR);
  DB.db.prepare('INSERT INTO profile (id, settings, updated_at) VALUES (1, ?, 0)').run(JSON.stringify(profile));
  return { env: { DB, VIEW_KEY: 'k', BROADLINK_SESSION: SESSION, ASSETS: { fetch: async () => new Response('') } }, DB };
}
const post = (env, body) => worker.fetch(new Request('https://x.test/api/ac', { method: 'POST', headers: { 'x-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
const settings = DB => JSON.parse(DB.db.prepare('SELECT settings FROM profile WHERE id = 1').get().settings);

test('a hand-set target moves the comfort range to target -1/+1 and keeps other settings', async () => {
  const { env, DB } = setup({ tMin: 23, tMax: 26, hMin: 40, hMax: 70, auto: false });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ event: {} });
  try {
    const res = await post(env, { action: 'cool', target: '25', fan: 'auto', auto: 'true' });
    assert.equal(res.status, 200);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(settings(DB), { tMin: 24, tMax: 26, hMin: 40, hMax: 70, auto: true });
  const state = DB.db.prepare('SELECT power, target, fan, source, ok FROM ac_state').get();
  assert.deepEqual({ ...state }, { power: 'on', target: 25, fan: 'auto', source: 'manual', ok: 1 });
  const logged = DB.db.prepare('SELECT action, target, fan, source, ok FROM ac_log ORDER BY rowid').all().map(r => ({ ...r }));
  assert.deepEqual(logged, [
    { action: 'auto_on', target: null, fan: null, source: 'manual', ok: 1 },
    { action: 'cool', target: 25, fan: 'auto', source: 'manual', ok: 1 },
  ]);
});

test('the range is left alone when the command could not be sent', async () => {
  const { env, DB } = setup({ tMin: 23, tMax: 26, auto: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 500 });
  try {
    const res = await post(env, { action: 'cool', target: 25, fan: 'auto' });
    assert.equal(res.status, 502);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(settings(DB), { tMin: 23, tMax: 26, auto: true });
});

test('turning off, and {auto:false} alone, do not touch the range', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26, auto: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ event: {} });
  try {
    assert.equal((await post(env, { auto: false })).status, 200);
    assert.deepEqual(settings(DB), { tMin: 24, tMax: 26, auto: false });
    assert.equal((await post(env, { action: 'off' })).status, 200);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(settings(DB), { tMin: 24, tMax: 26, auto: false });
});

test('/api/version reports the version and build, and needs the key', async () => {
  const { env } = setup({ tMin: 24, tMax: 26 });
  env.VERSION = '1.1.0'; env.BUILD = 'abc1234';
  const get = key => worker.fetch(new Request('https://x.test/api/version', { headers: key ? { 'x-key': key } : {} }), env);
  assert.equal((await get(null)).status, 401);
  assert.deepEqual(await (await get('k')).json(), { version: '1.1.0', build: 'abc1234' });
});

// --- sensor outage alerts ---
const SENSOR = Buffer.from([0x24, 0, 0, 0, 25, 50, 60, 0]).toString('base64');
const ZERO = Buffer.from([0x24, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
function net(mode) {
  const pushes = [], messages = [];
  const fn = async (url, init) => {
    if (String(url).includes('ntfy.sh')) { pushes.push(JSON.parse(init.body).title); messages.push(JSON.parse(init.body).message); return new Response('{}'); }
    if (mode.fail) return new Response('down', { status: 500 });
    return Response.json({ event: { payload: { data: mode.zero ? ZERO : SENSOR } } });
  };
  return { fn, pushes, messages };
}
const poll = env => worker.fetch(new Request('https://x.test/api/poll', { method: 'POST', headers: { 'x-key': 'k' } }), env).then(r => r.json());
async function withNet(mode, f) {
  const real = globalThis.fetch, n = net(mode);
  globalThis.fetch = n.fn;
  try { return await f(n); } finally { globalThis.fetch = real; }
}
const addSample = (DB, ageMs) => DB.db.prepare('INSERT INTO samples (at, temperature, humidity) VALUES (?, 25, 60)').run(Date.now() - ageMs);
const statusOk = DB => DB.db.prepare('SELECT ok FROM status WHERE id = 1').get()?.ok;

test('one failed read does not raise an outage alert', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26 });
  env.NTFY_TOPIC = 't';
  addSample(DB, 120000); // last good reading 2 minutes ago
  const mode = { fail: true };
  await withNet(mode, async n => {
    assert.equal((await poll(env)).error, 'cloud_unavailable');
    assert.deepEqual(n.pushes, []);
    assert.equal(statusOk(DB), 1);
  });
});

test('an outage of 4+ minutes alerts once, and recovery is announced once', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26 });
  env.NTFY_TOPIC = 't';
  addSample(DB, 6 * 60000);
  const mode = { fail: true };
  await withNet(mode, async n => {
    await poll(env);
    assert.deepEqual(n.pushes, ['Sensör okunamıyor']);
    assert.equal(statusOk(DB), 0);
    await poll(env);
    assert.deepEqual(n.pushes, ['Sensör okunamıyor']); // no repeat
    mode.fail = false;
    assert.equal((await poll(env)).saved, true);
    assert.deepEqual(n.pushes, ['Sensör okunamıyor', 'Sensör geri geldi']);
    assert.equal(statusOk(DB), 1);
  });
});

test('/api/state returns the reading, profile, AC state, last-hour swing and version in one call', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26, auto: true });
  env.VERSION = '2.0.0'; env.BUILD = 'abc1234';
  const now = Date.now();
  const add = (ago, t) => DB.db.prepare('INSERT INTO samples (at, temperature, humidity) VALUES (?, ?, 60)').run(now - ago, t);
  add(90 * 60000, 29); add(20 * 60000, 25.2); add(10 * 60000, 25.6); add(30000, 25.4);
  DB.db.prepare("INSERT INTO ac_state (id, power, target, fan, at, source, ok) VALUES (1, 'on', 26, 'auto', ?, 'manual', 1)").run(now);
  const d = await (await worker.fetch(new Request('https://x.test/api/state', { headers: { 'x-key': 'k' } }), env)).json();
  assert.equal(d.sample.temperature, 25.4);
  assert.deepEqual(d.profile, { tMin: 24, tMax: 26, auto: true });
  assert.equal(d.state.target, 26);
  assert.deepEqual(d.hour, { min: 25.2, max: 25.6 }); // the 29 from 90 minutes ago is outside the hour
  assert.equal(d.before, 25.2);
  assert.equal(d.version, '2.0.0');
});

test('history carries the AC log for the range plus the entry before it; automation re-sends are logged as auto', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26, auto: true });
  const now = Date.now();
  const logRow = (ago, action, target) => DB.db.prepare("INSERT INTO ac_log (at, action, target, fan, source, ok, temperature) VALUES (?, ?, ?, 'auto', 'manual', 1, 25)").run(now - ago, action, target);
  logRow(9 * 3600000, 'cool', 24); logRow(8 * 3600000, 'cool', 25); logRow(3600000, 'cool', 26);
  DB.db.prepare('INSERT INTO samples (at, temperature, humidity) VALUES (?, 25.5, 60)').run(now - 60000);
  const d = await (await worker.fetch(new Request('https://x.test/api/sensor?range=6s', { headers: { 'x-key': 'k' } }), env)).json();
  assert.deepEqual(d.log.map(l => l.target), [25, 26]); // 24 is older than the entry just before the range
  assert.equal(d.samples.length, 1);
  assert.equal('hourly' in d, false);

  // a hand-started AC that the automation re-sends: state stays manual, the log says auto
  DB.db.prepare("INSERT INTO ac_state (id, power, target, fan, at, source, ok) VALUES (1, 'on', 25, 'auto', ?, 'manual', 1)").run(now - 31 * 60000);
  DB.db.prepare('DELETE FROM samples').run();
  await withNet({ fail: false }, async () => { assert.equal((await poll(env)).saved, true); });
  assert.equal(DB.db.prepare('SELECT source FROM ac_state').get().source, 'manual');
  const last = DB.db.prepare('SELECT action, target, source FROM ac_log ORDER BY at DESC LIMIT 1').get();
  assert.deepEqual({ ...last }, { action: 'cool', target: 25, source: 'auto' });
});

test('stored 0 °C / 0 % rows are dropped so the last real reading shows again', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26 });
  addSample(DB, 10 * 60000);
  const zero = ago => DB.db.prepare('INSERT INTO samples (at, temperature, humidity) VALUES (?, 0, 0)').run(Date.now() - ago);
  zero(5 * 60000); zero(10000);
  await withNet({ fail: true }, async () => { assert.equal((await poll(env)).error, 'cloud_unavailable'); });
  const rows = DB.db.prepare('SELECT temperature FROM samples').all();
  assert.deepEqual(rows.map(r => r.temperature), [25]);
});

test('failed reads are logged with the raw reply, and a run of them is one gap with start, end and count', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26 });
  env.NTFY_TOPIC = 't';
  addSample(DB, 6 * 60000);
  const mode = { zero: true };
  await withNet(mode, async n => {
    assert.equal((await poll(env)).error, 'cloud_unavailable');
    assert.match(n.messages[0], /RM4 cevap veriyor ama sensör 0 °C/);
    mode.zero = false; mode.fail = true;
    await poll(env);
    const errors = DB.db.prepare('SELECT reason, raw, detail FROM sensor_errors ORDER BY rowid').all().map(r => ({ ...r }));
    assert.deepEqual(errors, [{ reason: 'zero', raw: '2400000000000000', detail: null }, { reason: 'http', raw: null, detail: 'HTTP 500' }]);
    const open = DB.db.prepare('SELECT ended, reads, zero_reads, reason FROM sensor_gaps').get();
    assert.deepEqual({ ...open }, { ended: null, reads: 2, zero_reads: 1, reason: 'zero' });
    mode.fail = false;
    assert.equal((await poll(env)).saved, true);
    assert.match(n.messages.at(-1), /0 dk sürdü, 2 başarısız okuma \(1 tanesi 0 °C \/ %0\)/);
  });
  const gap = DB.db.prepare('SELECT started, ended FROM sensor_gaps').get();
  assert.ok(gap.ended >= gap.started);

  const d = await (await worker.fetch(new Request('https://x.test/api/diag', { headers: { 'x-key': 'k' } }), env)).json();
  assert.equal(d.gaps.length, 1);
  assert.equal(d.gaps[0].open, false);
  assert.equal(d.errors.length, 2);
  assert.equal('probe' in d, false);
});

test('/api/diag?probe=1 reads the sensor live without saving, and needs the key', async () => {
  const { env, DB } = setup({ tMin: 24, tMax: 26 });
  const get = key => worker.fetch(new Request('https://x.test/api/diag?probe=1', { headers: key ? { 'x-key': key } : {} }), env);
  assert.equal((await get(null)).status, 401);
  const d = await withNet({ zero: true }, async () => (await get('k')).json());
  assert.equal(d.probe.length, 3);
  assert.deepEqual(d.probe.map(p => [p.ok, p.reason, p.raw]), Array(3).fill([false, 'zero', '2400000000000000']));
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 0);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM sensor_errors').get().n, 0);
});

test('a room that does not cool after 45 minutes of AC raises one "suspect sensor" push', async () => {
  const { env, DB } = setup({ tMin: 17, tMax: 19 });
  env.NTFY_TOPIC = 't';
  const now = Date.now();
  DB.db.prepare("INSERT INTO ac_state (id, power, target, fan, at, source, ok) VALUES (1, 'on', 18, 'high', ?, 'manual', 1)").run(now - 50 * 60000);
  DB.db.prepare("INSERT INTO ac_log (at, action, target, fan, source, ok, temperature) VALUES (?, 'cool', 18, 'high', 'manual', 1, 25)").run(now - 50 * 60000);
  DB.db.prepare('INSERT INTO samples (at, temperature, humidity) VALUES (?, 25.2, 60)').run(now - 48 * 60000);
  await withNet({}, async n => {
    assert.equal((await poll(env)).saved, true); // SENSOR reads 25.5
    assert.deepEqual(n.pushes, ['Sensör şüpheli']);
    DB.db.prepare('DELETE FROM samples WHERE at > ?').run(now - 60000);
    await poll(env);
    assert.deepEqual(n.pushes, ['Sensör şüpheli']); // once per AC run
  });
  assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM sensor_errors WHERE reason = 'suspect'").get().n, 1);
});

test('no "suspect sensor" push when the room is cooling or the AC only just started', async () => {
  for (const [startedAgo, earlier] of [[50, 27], [20, 25.2]]) {
    const { env, DB } = setup({ tMin: 17, tMax: 19 });
    env.NTFY_TOPIC = 't';
    const now = Date.now();
    DB.db.prepare("INSERT INTO ac_state (id, power, target, fan, at, source, ok) VALUES (1, 'on', 18, 'high', ?, 'manual', 1)").run(now - startedAgo * 60000);
    DB.db.prepare("INSERT INTO ac_log (at, action, target, fan, source, ok, temperature) VALUES (?, 'cool', 18, 'high', 'manual', 1, 25)").run(now - startedAgo * 60000);
    DB.db.prepare('INSERT INTO samples (at, temperature, humidity) VALUES (?, ?, 60)').run(now - 48 * 60000, earlier);
    await withNet({}, async n => { await poll(env); assert.deepEqual(n.pushes, []); });
  }
});
