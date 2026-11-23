import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, setpoint, bandFor, nextCommand, rangeCommand, trimRange, MIN_GAP, STEP_GAP, RESEND, TRIM_AFTER, FAN_CHECK } from '../cloud/public/policy.js';

const band = bandFor(25); // 24-26, room target 25
const T0 = 1_000_000_000;
const st = (over = {}) => ({ power: 'on', target: 24, fan: 'auto', at: T0, source: 'auto', ok: 1, ...over });

test('setpoint is the typed target and stays inside the AC range', () => {
  assert.equal(setpoint(band), 25);
  assert.equal(setpoint({ tMin: 12, tMax: 14 }), 18);
  assert.equal(setpoint({ tMin: 40, tMax: 42 }), 30);
  assert.deepEqual(trimRange(band), [22, 24]);
});

test('plan shown on the page: cool above target + 0.5, off below the band, hold otherwise', () => {
  assert.equal(plan(band, 25.6).action, 'cool');
  assert.equal(plan(band, 25.5).action, 'hold');
  assert.equal(plan(band, 24.0).action, 'hold');
  assert.equal(plan(band, 23.9).action, 'off');
});

test('starts cooling at the target with fan auto once the room is half a degree above it', () => {
  assert.equal(nextCommand(band, 25.5, null, T0), null);
  assert.deepEqual(nextCommand(band, 25.6, null, T0), { action: 'cool', target: 24, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: null, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
});

test('inside the range the setpoint is trimmed in the trim range; one pulled below the floor comes back up at once', () => {
  assert.deepEqual(nextCommand(band, 25.9, st(), T0 + TRIM_AFTER + 1), { action: 'cool', target: 23, fan: 'auto' });
  assert.equal(nextCommand(band, 25.4, st({ target: 23 }), T0 + 1000), null);
  assert.deepEqual(nextCommand(band, 25.4, st({ target: 20 }), T0 + 1000), { action: 'cool', target: 22, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 26.0, st({ target: 18, fan: 'med' }), T0 + 1000), { action: 'cool', target: 22, fan: 'med' });
  assert.deepEqual(nextCommand(band, 24.3, st({ target: 23 }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.equal(nextCommand(band, 24.3, st(), T0 + TRIM_AFTER + 1), null); // already at the trim ceiling
  assert.equal(nextCommand(band, 25.4, st(), T0 + TRIM_AFTER + 1), null);
});

test('setpoint nudges stop at the trim range limits', () => {
  assert.equal(nextCommand(band, 25.9, st({ target: 22 }), T0 + TRIM_AFTER + 1), null);
  assert.equal(nextCommand(band, 24.2, st({ target: 27 }), T0 + TRIM_AFTER + 1), null);
});

test('below the band it raises the setpoint by 1 every 20 minutes, then switches off; a dip under 0.2 degree is ignored', () => {
  assert.equal(nextCommand(band, 24.0, st(), T0 + STEP_GAP + 1), null);
  assert.equal(nextCommand(band, 23.9, st({ target: 22 }), T0 + STEP_GAP + 1), null); // sensor noise at the edge (2026-11-23: 23 -> 27 in 4 hours)
  assert.equal(nextCommand(band, 23.9, st({ target: 22 }), T0 + RESEND - 1), null);
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 22 }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 23 }), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 24 }), T0 + STEP_GAP + 1), { action: 'off', target: 24 });
  assert.deepEqual(nextCommand(band, 23.4, st({ target: 22 }), T0 + STEP_GAP + 1), { action: 'off', target: 22 }); // clearly cold
  assert.equal(nextCommand(band, 23.7, st({ target: 22 }), T0 + 1000), null);
  assert.equal(nextCommand(band, 23.7, st({ target: 22 }), T0 + MIN_GAP + 1), null); // 10 minutes is too soon, the AC lags 20-30
});

test('restarts from the setpoint it had when it switched off, inside the trim range', () => {
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: 23, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 23, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: 18, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 22, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: 30, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
});

test('a hand-started AC keeps its fan and stays marked as hand-started while being nudged', () => {
  const hand = st({ source: 'manual', fan: 'high' });
  assert.deepEqual(nextCommand(band, 26.1, hand, T0 + TRIM_AFTER + 1), { action: 'cool', target: 23, fan: 'high', source: 'manual' });
  assert.deepEqual(nextCommand(band, 25.2, hand, T0 + RESEND + 1), { action: 'cool', target: 24, fan: 'high', source: 'manual' });
});

test('a command that failed is retried as it was', () => {
  assert.deepEqual(nextCommand(band, 26.0, st({ ok: 0, target: 24, fan: 'med' }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'med' });
});

test('a hot room starts at the setpoint, fan auto: no fan high, no jump to 18', () => {
  assert.deepEqual(nextCommand(bandFor(25.6), 30.0, null, T0), { action: 'cool', target: 25, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 28.0, st({ power: 'off', target: 24, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.equal(plan(band, 30.0).fan, 'auto');
});

test('above the comfort range: fan auto -> low -> medium, then the setpoint steps down every 20 minutes to 18', () => {
  assert.equal(nextCommand(band, 26.4, st(), T0 + 1000), null);
  assert.deepEqual(nextCommand(band, 26.4, st(), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'low' });
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'low' }), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'med' });
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'med' }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'med' });
  assert.deepEqual(nextCommand(band, 26.2, st({ target: 22, fan: 'med' }), T0 + STEP_GAP + 1), { action: 'cool', target: 21, fan: 'med' });
  assert.equal(nextCommand(band, 26.2, st({ target: 18, fan: 'med' }), T0 + STEP_GAP + 1), null);
  // a setpoint above the trim ceiling (it barely cools there) comes down to the ceiling at once, even right after a command
  assert.deepEqual(nextCommand(band, 26.4, st({ target: 27 }), T0 + 1000), { action: 'cool', target: 24, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 26.4, st({ target: 27, source: 'manual' }), T0 + 1000), { action: 'cool', target: 24, fan: 'auto', source: 'manual' });
  // a hand-picked high or quiet fan is not touched
  assert.deepEqual(nextCommand(band, 26.4, st({ source: 'manual', fan: 'high' }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'high', source: 'manual' });
  // still cooling (dropped 0.2 or more since the last command): no fan or setpoint step
  assert.equal(nextCommand(band, 26.4, st({ temp: 26.6 }), T0 + STEP_GAP + 1), null);
  assert.equal(nextCommand(band, 26.4, st({ fan: 'med', temp: 26.7 }), T0 + STEP_GAP + 1), null);
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'med', temp: 26.5 }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'med' });
  // back at the target: an automatic AC returns to the auto fan, a hand-started one keeps its fan
  assert.equal(nextCommand(band, 25.3, st({ fan: 'med' }), T0 + TRIM_AFTER + 1), null);
  assert.deepEqual(nextCommand(band, 25.0, st({ fan: 'med' }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'auto' });
  // 2026-11-21 21:28: range 24-25.5, room back in at 25.2 with the setpoint at 18 -> trim floor 22, not the normal 25
  assert.deepEqual(nextCommand({ tMin: 24, tMax: 25.5 }, 25.22, st({ target: 18, source: 'manual' }), T0 + 1000), { action: 'cool', target: 22, fan: 'auto', source: 'manual' });
  assert.equal(nextCommand(band, 25.0, st({ fan: 'med', source: 'manual' }), T0 + TRIM_AFTER + 1), null);
});

test('an automatic AC left at fan high goes back to fan auto at once, keeping its setpoint', () => {
  assert.deepEqual(nextCommand(band, 26.0, st({ target: 18, fan: 'high' }), T0 + 1000), { action: 'cool', target: 18, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.0, st({ target: 22, fan: 'high' }), T0 + 1000), { action: 'cool', target: 22, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 25.0, st({ source: 'manual', target: 18, fan: 'high' }), T0 + 1000), { action: 'cool', target: 22, fan: 'high', source: 'manual' });
  assert.equal(nextCommand(band, 25.0, st({ source: 'manual', fan: 'high' }), T0 + 1000), null);
});

test('a new comfort range is applied to the AC at once', () => {
  const auto = { ...bandFor(23), auto: true }; // target 23, trim 20-22
  // running automatic AC: new setpoint, fan auto
  assert.deepEqual(rangeCommand(auto, 23.8, st()), { action: 'cool', target: 22, fan: 'auto' });
  assert.deepEqual(rangeCommand(auto, 26.5, st()), { action: 'cool', target: 22, fan: 'auto' });
  assert.deepEqual(rangeCommand({ ...bandFor(27), auto: true }, 27.2, st({ target: 18, fan: 'high' })), { action: 'cool', target: 26, fan: 'auto' });
  // with the old range known, the running setpoint moves by as much as the range did (keeps what the trim learned)
  assert.deepEqual(rangeCommand(auto, 25.0, st({ target: 22 }), bandFor(25)), { action: 'cool', target: 20, fan: 'auto' });
  assert.deepEqual(rangeCommand({ ...bandFor(26), auto: true }, 25.0, st({ target: 22 }), bandFor(25)), { action: 'cool', target: 23, fan: 'auto' });
  // a hand-started AC keeps its fan and stays hand-started, even with the automation off
  assert.deepEqual(rangeCommand(bandFor(23), 26.5, st({ source: 'manual', fan: 'low' })), { action: 'cool', target: 22, fan: 'low', source: 'manual' });
  // no reading: still the new setpoint
  assert.deepEqual(rangeCommand(auto, null, st()), { action: 'cool', target: 22, fan: 'auto' });
  // already there: nothing to send
  assert.equal(rangeCommand(auto, 23.4, st({ target: 22 })), null);
  // off AC: started only with the automation on and a room that needs cooling
  assert.deepEqual(rangeCommand(auto, 24.0, st({ power: 'off', fan: null })), { action: 'cool', target: 22, fan: 'auto' });
  assert.equal(rangeCommand(auto, 23.4, st({ power: 'off', fan: null })), null);
  assert.equal(rangeCommand(bandFor(23), 26.0, null), null);
});

test('well above the range it drops straight to the trim floor, even right after a command (the 02:20 screenshot)', () => {
  const r = { tMin: 25.5, tMax: 26.5, auto: true }; // target 26, trim floor 23
  assert.deepEqual(nextCommand(r, 27.6, st({ source: 'manual' }), T0 + 1000), { action: 'cool', target: 23, fan: 'auto', source: 'manual' });
  assert.deepEqual(nextCommand(r, 27.6, st({ target: 25 }), T0 + 1000), { action: 'cool', target: 23, fan: 'auto' });
  assert.equal(nextCommand(r, 27.6, st({ target: 23 }), T0 + 1000), null); // then 1 degree per 20 minutes
  assert.deepEqual(nextCommand(r, 27.6, st({ target: 23 }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'low' });
});

test('auto fan: 2 minutes after the command, a room that has not dropped 0.1 degree gets the low fan', () => {
  // room above target + 0.5, unchanged since the command
  assert.equal(nextCommand(band, 25.8, st({ temp: 25.8 }), T0 + FAN_CHECK - 1), null);
  assert.deepEqual(nextCommand(band, 25.8, st({ temp: 25.8 }), T0 + FAN_CHECK + 1), { action: 'cool', target: 24, fan: 'low' });
  assert.deepEqual(nextCommand(band, 25.75, st({ temp: 25.8 }), T0 + FAN_CHECK + 1), { action: 'cool', target: 24, fan: 'low' });
  // cooling: keep auto
  assert.equal(nextCommand(band, 25.7, st({ temp: 25.8 }), T0 + FAN_CHECK + 1), null);
  // near the target the AC may idle on purpose: keep auto
  assert.equal(nextCommand(band, 25.4, st({ temp: 25.4 }), T0 + FAN_CHECK + 1), null);
  // only from auto; low -> medium still waits 10 minutes above the range
  assert.equal(nextCommand(band, 25.8, st({ fan: 'low', temp: 25.8 }), T0 + FAN_CHECK + 1), null);
  // hand-started AC stays hand-started
  assert.deepEqual(nextCommand(band, 25.8, st({ source: 'manual', temp: 25.9 }), T0 + FAN_CHECK + 1), { action: 'cool', target: 24, fan: 'low', source: 'manual' });
  // no temperature known for the command: old 10-minute rule only
  assert.equal(nextCommand(band, 25.8, st(), T0 + FAN_CHECK + 1), null);
});
