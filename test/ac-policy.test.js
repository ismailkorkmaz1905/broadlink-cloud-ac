import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, setpoint, bandFor, nextCommand, rangeCommand, trimRange, MIN_GAP, RESEND, TRIM_AFTER } from '../cloud/public/policy.js';

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
  assert.deepEqual(nextCommand(band, 25.9, st({ target: 22 }), T0 + TRIM_AFTER + 1), null);
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

test('a hot room starts at the setpoint, fan auto: no fan high, no jump to 18', () => {
  assert.deepEqual(nextCommand(bandFor(25.6), 30.0, null, T0), { action: 'cool', target: 26, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 28.0, st({ power: 'off', target: 24, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.equal(plan(band, 30.0).fan, 'auto');
});

test('above the comfort range the setpoint steps down every 10 minutes, past the trim floor, down to 18', () => {
  assert.equal(nextCommand(band, 27.0, st(), T0 + 1000), null);
  assert.deepEqual(nextCommand(band, 27.0, st(), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 26.2, st({ target: 22 }), T0 + MIN_GAP + 1), { action: 'cool', target: 21, fan: 'auto' });
  assert.equal(nextCommand(band, 26.2, st({ target: 18 }), T0 + MIN_GAP + 1), null);
  // back inside the range: a setpoint below the trim floor is kept (no jump back up), and only raised once the room is cool
  assert.equal(nextCommand(band, 25.3, st({ target: 20 }), T0 + TRIM_AFTER + 1), null);
  assert.deepEqual(nextCommand(band, 24.4, st({ target: 20 }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 21, fan: 'auto' });
});

test('an automatic AC left at fan high goes back to fan auto at once, keeping its setpoint', () => {
  assert.deepEqual(nextCommand(band, 26.0, st({ target: 18, fan: 'high' }), T0 + 1000), { action: 'cool', target: 18, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.0, st({ target: 22, fan: 'high' }), T0 + 1000), { action: 'cool', target: 22, fan: 'auto' });
  assert.equal(nextCommand(band, 25.0, st({ source: 'manual', target: 18, fan: 'high' }), T0 + 1000), null);
});

test('a new comfort range is applied to the AC at once', () => {
  const auto = { ...bandFor(23), auto: true }; // target 23, trim 20-25
  // running automatic AC: new setpoint, fan auto
  assert.deepEqual(rangeCommand(auto, 23.8, st()), { action: 'cool', target: 23, fan: 'auto' });
  assert.deepEqual(rangeCommand(auto, 26.5, st()), { action: 'cool', target: 23, fan: 'auto' });
  assert.deepEqual(rangeCommand({ ...bandFor(27), auto: true }, 27.2, st({ target: 18, fan: 'high' })), { action: 'cool', target: 27, fan: 'auto' });
  // with the old range known, the running setpoint moves by as much as the range did (keeps what the trim learned)
  assert.deepEqual(rangeCommand(auto, 25.0, st({ target: 22 }), bandFor(25)), { action: 'cool', target: 20, fan: 'auto' });
  assert.deepEqual(rangeCommand({ ...bandFor(26), auto: true }, 25.0, st({ target: 22 }), bandFor(25)), { action: 'cool', target: 23, fan: 'auto' });
  // a hand-started AC keeps its fan and stays hand-started, even with the automation off
  assert.deepEqual(rangeCommand(bandFor(23), 26.5, st({ source: 'manual', fan: 'low' })), { action: 'cool', target: 23, fan: 'low', source: 'manual' });
  // no reading: still the new setpoint
  assert.deepEqual(rangeCommand(auto, null, st()), { action: 'cool', target: 23, fan: 'auto' });
  // already there: nothing to send
  assert.equal(rangeCommand(auto, 23.4, st({ target: 23 })), null);
  // off AC: started only with the automation on and a room that needs cooling
  assert.deepEqual(rangeCommand(auto, 24.0, st({ power: 'off', fan: null })), { action: 'cool', target: 23, fan: 'auto' });
  assert.equal(rangeCommand(auto, 23.4, st({ power: 'off', fan: null })), null);
  assert.equal(rangeCommand(bandFor(23), 26.0, null), null);
});
