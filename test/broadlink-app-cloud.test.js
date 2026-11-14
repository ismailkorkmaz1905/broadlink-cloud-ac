import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSensorReply, readCloudSensor, sendIrCommand, validSession } from '../lib/broadlink-app-cloud.js';

const reply = Buffer.from('240000001857495a0500', 'hex').toString('base64');
const session = () => ({
  url: 'https://app-service-usa-test.ibroadlink.com/device/control/v2/sdkcontrol',
  headers: { Host: 'x', timestamp: '1', loginsession: 'test-session' },
  body: JSON.stringify({ directive: { header: { timstamp: '1' }, payload: { data: 'JAAAAA==' } } }),
});

test('decodes the observed RM4 reply', () => {
  assert.deepEqual(decodeSensorReply(reply), { temperature: 24.87, humidity: 73.9 });
  assert.throws(() => decodeSensorReply(Buffer.alloc(10).toString('base64')));
});

test('rejects sessions that are not the sensor query on a BroadLink host', () => {
  assert.equal(validSession(session()), true);
  assert.equal(validSession({ ...session(), url: 'https://evil.example/device/control/v2/sdkcontrol' }), false);
  assert.equal(validSession({ ...session(), url: 'http://app-service-usa-test.ibroadlink.com/device/control/v2/sdkcontrol' }), false);
  assert.equal(validSession({ ...session(), url: 'https://app-service-usa-test.ibroadlink.com/device/control/v2/querystate' }), false);
  assert.equal(validSession({ ...session(), body: JSON.stringify({ directive: { payload: { data: 'AAAA' } } }) }), false);
});

test('reads a fresh sample and refreshes timestamps', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ event: { payload: { data: reply } } }) }; };
  const sample = await readCloudSensor(session(), fetchImpl, 1_700_000_000_000);
  assert.deepEqual(sample, { temperature: 24.87, humidity: 73.9, at: 1_700_000_000_000, raw: '240000001857495a0500' });
  assert.equal(sent.init.headers.timestamp, '1700000000');
  assert.equal('Host' in sent.init.headers, false);
  assert.equal(JSON.parse(sent.init.body).directive.header.timstamp, '1700000000');
});

test('fails on upstream errors and out-of-range values', async () => {
  await assert.rejects(readCloudSensor(session(), async () => ({ ok: false })));
  const bad = Buffer.from('240000006400' + '0000', 'hex').toString('base64');
  await assert.rejects(readCloudSensor(session(), async () => ({ ok: true, json: async () => ({ event: { payload: { data: bad } } }) })));
  const empty = Buffer.from('2400000000000000', 'hex').toString('base64');
  await assert.rejects(readCloudSensor(session(), async () => ({ ok: true, json: async () => ({ event: { payload: { data: empty } } }) })), /no reading/);
});

test('failed reads say why, and carry the raw RM4 reply when there was one', async () => {
  const reason = async (fetchImpl) => { try { await readCloudSensor(session(), fetchImpl); } catch (e) { return { reason: e.reason, raw: e.raw, detail: e.detail }; } };
  const answer = (hex) => async () => ({ ok: true, json: async () => ({ event: { payload: { data: Buffer.from(hex, 'hex').toString('base64') } } }) });
  assert.deepEqual(await reason(answer('2400000000000000')), { reason: 'zero', raw: '2400000000000000', detail: undefined });
  assert.equal((await reason(answer('2600000000000000'))).reason, 'bad_reply');
  assert.deepEqual(await reason(async () => ({ ok: false, status: 503 })), { reason: 'http', raw: undefined, detail: 'HTTP 503' });
  assert.deepEqual(await reason(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), { reason: 'network', raw: undefined, detail: 'TimeoutError' });
  assert.deepEqual(await reason(async () => ({ ok: true, json: async () => ({ status: -4000, msg: 'device offline' }) })), { reason: 'no_data', raw: undefined, detail: '{"status":-4000,"msg":"device offline"}' });
});

test('allows only the license query on the session URL', () => {
  const base = 'https://app-service-usa-test.ibroadlink.com/device/control/v2/sdkcontrol';
  assert.equal(validSession({ ...session(), url: base + '?license=abc%2B123' }), true);
  assert.equal(validSession({ ...session(), url: base + '?license=abc&x=1' }), false);
  assert.equal(validSession({ ...session(), url: base + '?x=1' }), false);
});

test('sends an IR packet with the 02 00 00 00 prefix and rejects other data', async () => {
  const ir = Buffer.concat([Buffer.from([0x26, 0]), Buffer.alloc(40, 1)]);
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ event: {} }) }; };
  await sendIrCommand(session(), ir.toString('base64'), fetchImpl, 1_700_000_000_000);
  assert.deepEqual([...Buffer.from(sent.directive.payload.data, 'base64')].slice(0, 6), [2, 0, 0, 0, 0x26, 0]);
  assert.equal(sent.directive.header.timstamp, '1700000000');
  await assert.rejects(sendIrCommand(session(), Buffer.alloc(40).toString('base64'), fetchImpl));
  await assert.rejects(sendIrCommand(session(), ir.toString('base64'), async () => ({ ok: false })));
});
