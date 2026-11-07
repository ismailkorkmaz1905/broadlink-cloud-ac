import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, setpoint, bandFor, nextCommand, trimRange, MIN_GAP, RESEND, TRIM_AFTER } from '../cloud/public/policy.js';

const band = bandFor(25); // 24-26, room target 25
const T0 = 1_000_000_000;
const st = (over = {}) => ({ power: 'on', target: 25, fan: 'auto', at: T0, source: 'auto', ok: 1, ...over });

test('setpoint is the typed target and stays inside the AC range', () => {
  assert.equal(setpoint(band), 25);
  assert.equal(setpoint({ tMin: 12, tMax: 14 }), 18);
  assert.equal(setpoint({ tMin: 40, tMax: 42 }), 30);
  assert.deepEqual(trimRange(band), [22, 27]);
});

test('plan shown on the page: cool above target + 0.5, off below the band, hold otherwise', () => {
  assert.equal(plan(band, 25.6).action, 'cool');
  assert.equal(plan(band, 25.5).action, 'hold');
  assert.equal(plan(band, 24.0).action, 'hold');
  assert.equal(plan(band, 23.9).action, 'off');
});

test('starts cooling at the target with fan auto once the room is half a degree above it', () => {
  assert.equal(nextCommand(band, 25.5, null, T0), null);
  assert.deepEqual(nextCommand(band, 25.6, null, T0), { action: 'cool', target: 25, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: null, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 25, fan: 'auto' });
});

test('stays on and nudges the setpoint toward the room target every 20 minutes', () => {
  assert.equal(nextCommand(band, 25.9, st(), T0 + TRIM_AFTER - 1), null);
  assert.deepEqual(nextCommand(band, 25.9, st(), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 24.3, st({ target: 23 }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'auto' });
  // within half a degree of the target nothing changes except the 30-minute re-send
  assert.equal(nextCommand(band, 25.4, st({ target: 23 }), T0 + TRIM_AFTER + 1), null);
  assert.deepEqual(nextCommand(band, 25.4, st({ target: 23 }), T0 + RESEND + 1), { action: 'cool', target: 23, fan: 'auto' });
});

test('setpoint nudges stop at the trim range limits', () => {
  assert.deepEqual(nextCommand(band, 27.0, st({ target: 22 }), T0 + TRIM_AFTER + 1), null);
  assert.equal(nextCommand(band, 24.2, st({ target: 27 }), T0 + TRIM_AFTER + 1), null);
});

test('below the band it first raises the setpoint by 2, then switches off', () => {
  assert.equal(nextCommand(band, 24.0, st(), T0 + MIN_GAP + 1), null);
  assert.deepEqual(nextCommand(band, 23.9, st(), T0 + MIN_GAP + 1), { action: 'cool', target: 27, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 23.9, st({ target: 27 }), T0 + MIN_GAP + 1), { action: 'off', target: 27 });
  assert.deepEqual(nextCommand(band, 23.4, st(), T0 + MIN_GAP + 1), { action: 'off', target: 25 }); // clearly cold
  assert.equal(nextCommand(band, 23.9, st(), T0 + 1000), null);
});

test('restarts from the setpoint it had when it switched off', () => {
  const off = st({ power: 'off', target: 23, fan: null });
  assert.deepEqual(nextCommand(band, 25.6, off, T0 + MIN_GAP + 1), { action: 'cool', target: 23, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: 30, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 27, fan: 'auto' }); // clamped
});

test('a hand-started AC keeps its fan and stays marked as hand-started while being nudged', () => {
  const hand = st({ source: 'manual', fan: 'high' });
  assert.deepEqual(nextCommand(band, 26.1, hand, T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'high', source: 'manual' });
  assert.deepEqual(nextCommand(band, 25.2, hand, T0 + RESEND + 1), { action: 'cool', target: 25, fan: 'high', source: 'manual' });
});

test('a command that failed is retried as it was', () => {
  assert.deepEqual(nextCommand(band, 26.0, st({ ok: 0, target: 24, fan: 'med' }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'med' });
});
