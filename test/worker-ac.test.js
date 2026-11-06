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
