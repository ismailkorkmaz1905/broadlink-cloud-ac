import test from 'node:test';
import assert from 'node:assert/strict';
import { fanFor, plan, setpoint } from '../cloud/public/policy.js';

const cfg = { tMin: 23, tMax: 26 };

test('cools above the upper bound with fan strength by overshoot', () => {
  assert.deepEqual(plan(cfg, 26.4), { action: 'cool', target: 23, fan: 'low', over: 26.4 - 26 });
  assert.equal(plan(cfg, 27.2).fan, 'med');
  assert.equal(plan(cfg, 28.5).fan, 'high');
  assert.equal(fanFor(1), 'med');
  assert.equal(fanFor(2), 'high');
});

test('turns off below the lower bound and holds inside the band', () => {
  assert.equal(plan(cfg, 22.9).action, 'off');
  assert.equal(plan(cfg, 23).action, 'hold');
  assert.equal(plan(cfg, 26).action, 'hold');
});

test('setpoint stays inside the AC range', () => {
  assert.equal(setpoint({ tMin: 12 }), 18);
  assert.equal(setpoint({ tMin: 40 }), 30);
  assert.equal(setpoint({ tMin: 22.6 }), 23);
});

import { nextCommand, MIN_GAP, RESEND } from '../cloud/public/policy.js';

const band = { tMin: 24.5, tMax: 25.5 };
const T0 = 1_000_000_000;
const st = (over = {}) => ({ power: 'on', target: 22, fan: 'high', at: T0, source: 'manual', ok: 1, ...over });

test('a hand-set target and fan are not overridden while the room is still warm', () => {
  assert.equal(nextCommand(band, 26.5, st(), T0 + MIN_GAP + 1), null);
  assert.equal(nextCommand(band, 26.5, st(), T0 + RESEND + 1), null);
});

test('automation still switches a hand-started AC off once the room is cool', () => {
  assert.deepEqual(nextCommand(band, 24.0, st(), T0 + MIN_GAP + 1), { action: 'off' });
  assert.equal(nextCommand(band, 24.0, st(), T0 + 1000), null);
});

test('automation starts and adjusts cooling on its own when nothing was set by hand', () => {
  assert.deepEqual(nextCommand(band, 26.0, null, T0), { action: 'cool', target: 25, fan: 'low' });
  const auto = st({ source: 'auto', target: 25, fan: 'low' });
  assert.deepEqual(nextCommand(band, 27.9, auto, T0 + MIN_GAP + 1), { action: 'cool', target: 25, fan: 'high' });
  assert.equal(nextCommand(band, 26.0, auto, T0 + MIN_GAP + 1), null);
});

test('a failed hand command is retried by the automation', () => {
  assert.deepEqual(nextCommand(band, 26.0, st({ ok: 0 }), T0 + MIN_GAP + 1), { action: 'cool', target: 25, fan: 'low' });
});

import { bandFor } from '../cloud/public/policy.js';

test('a hand-set target moves the comfort range to target -1/+1', () => {
  assert.deepEqual(bandFor(25), { tMin: 24, tMax: 26 });
  assert.deepEqual(bandFor(22), { tMin: 21, tMax: 23 });
});
