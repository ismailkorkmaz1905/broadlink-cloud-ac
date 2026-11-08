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
function net(mode) {
  const pushes = [];
  const fn = async (url, init) => {
    if (String(url).includes('ntfy.sh')) { pushes.push(JSON.parse(init.body).title); return new Response('{}'); }
    if (mode.fail) return new Response('down', { status: 500 });
    return Response.json({ event: { payload: { data: SENSOR } } });
  };
  return { fn, pushes };
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
