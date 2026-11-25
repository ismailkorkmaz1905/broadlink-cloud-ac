import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, setpoint, nextCommand, rangeCommand, trimRange, boostTarget, MIN_GAP, STEP_GAP, RESEND, TRIM_AFTER, FAN_CHECK, MANUAL_HOLD } from '../cloud/public/policy.js';

const bandFor = target => ({ tMin: target - 1, tMax: target + 1 });

const band = bandFor(25); // 24-26, room target 25
const T0 = 1_000_000_000;
const st = (over = {}) => ({ power: 'on', target: 24, fan: 'quiet', at: T0, source: 'auto', ok: 1, ...over });

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
  assert.deepEqual(nextCommand(band, 25.6, null, T0), { action: 'cool', target: 24, fan: 'quiet' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: null, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'quiet' });
});

test('inside the range the setpoint is trimmed in the trim range; one pulled below the floor comes back up at once', () => {
  assert.deepEqual(nextCommand(band, 25.9, st(), T0 + TRIM_AFTER + 1), { action: 'cool', target: 23, fan: 'quiet' });
  assert.equal(nextCommand(band, 25.4, st({ target: 23 }), T0 + 1000), null);
  assert.deepEqual(nextCommand(band, 25.4, st({ target: 20 }), T0 + 1000), { action: 'cool', target: 22, fan: 'quiet' });
  assert.deepEqual(nextCommand(band, 26.0, st({ target: 18, fan: 'med' }), T0 + 1000), { action: 'cool', target: 22, fan: 'med' });
  assert.deepEqual(nextCommand(band, 24.3, st({ target: 23 }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'quiet' });
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
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 22 }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'quiet' });
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 23 }), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'quiet' });
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 24 }), T0 + STEP_GAP + 1), { action: 'off', target: 24 });
  assert.deepEqual(nextCommand(band, 23.4, st({ target: 22 }), T0 + STEP_GAP + 1), { action: 'off', target: 22 }); // clearly cold
  assert.equal(nextCommand(band, 23.7, st({ target: 22 }), T0 + 1000), null);
  assert.equal(nextCommand(band, 23.7, st({ target: 22 }), T0 + MIN_GAP + 1), null); // 10 minutes is too soon, the AC lags 20-30
});

test('restarts at the trim ceiling, not at the setpoint it was switched off with', () => {
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: 23, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'quiet' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: 18, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'quiet' });
  assert.deepEqual(nextCommand(band, 25.6, st({ power: 'off', target: null, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'quiet' });
});

test('switching off is decided after 10 minutes, the +1 step after 20', () => {
  assert.equal(nextCommand(band, 23.4, st({ target: 22 }), T0 + 1000), null);
  assert.deepEqual(nextCommand(band, 23.4, st({ target: 22 }), T0 + MIN_GAP + 1), { action: 'off', target: 22 }); // clearly cold
  assert.deepEqual(nextCommand(band, 23.7, st({ target: 24 }), T0 + MIN_GAP + 1), { action: 'off', target: 24 }); // already at the ceiling
  assert.equal(nextCommand(band, 23.7, st({ target: 22 }), T0 + MIN_GAP + 1), null); // soft cold: +1 waits 20 minutes
});

test('a hand-set command is left alone for 10 minutes and while the room is above the range, up to an hour', () => {
  const hand = st({ source: 'manual', fan: 'high', target: 20 });
  // above the range: held, not even re-sent (a re-send would restart the hour)
  assert.equal(nextCommand(band, 26.4, hand, T0 + 30 * 60000), null);
  assert.equal(nextCommand(band, 26.4, hand, T0 + RESEND + 1), null);
  assert.equal(nextCommand(band, 28.0, st({ source: 'manual' }), T0 + 1000), null);
  // an hour on, still above the range: the automation takes over (hot room -> hot-room pull-down)
  assert.deepEqual(nextCommand(band, 28.0, st({ source: 'manual' }), T0 + MANUAL_HOLD + 1), { action: 'cool', target: 20, fan: 'high' });
  // a hand-set setting weaker than the trim ceiling is held only 10 minutes (2026-11-25 18:56: 26, room 26.4-27.7 for an hour)
  assert.equal(nextCommand(band, 26.4, st({ source: 'manual', target: 26, fan: 'auto' }), T0 + MIN_GAP - 1), null);
  assert.deepEqual(nextCommand(band, 26.4, st({ source: 'manual', target: 26, fan: 'auto' }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
  // in the range: held for 10 minutes, then back to the trim range and the low fan (2026-11-24 20:11: 23 high -> 20 at once)
  assert.equal(nextCommand(band, 25.8, hand, T0 + MIN_GAP - 1), null);
  assert.deepEqual(nextCommand(band, 25.8, hand, T0 + MIN_GAP + 1), { action: 'cool', target: 22, fan: 'low' });
  // nothing to change: the next re-send is the automation's own
  assert.equal(nextCommand(band, 25.2, st({ source: 'manual' }), T0 + MIN_GAP + 1), null);
  assert.deepEqual(nextCommand(band, 25.2, st({ source: 'manual' }), T0 + RESEND + 1), { action: 'cool', target: 24, fan: 'quiet' });
  // a fan the automation stepped up on a hand-set AC comes back to quiet at the target (2026-11-25: low from 03:01 to morning)
  assert.deepEqual(nextCommand(band, 25.0, st({ fan: 'low', source: 'manual' }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'quiet' });
});

test('a command that failed is retried as it was', () => {
  assert.deepEqual(nextCommand(band, 26.0, st({ ok: 0, target: 24, fan: 'med' }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'med' });
  assert.deepEqual(nextCommand(band, 26.0, st({ ok: 0, source: 'manual' }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'quiet', source: 'manual' });
});

test('a hot room (more than 1 degree above the range) is pulled down hard until it is back at the top of the range', () => {
  assert.equal(boostTarget(band), 20);
  assert.deepEqual(nextCommand(band, 27.1, null, T0), { action: 'cool', target: 20, fan: 'high' });
  assert.deepEqual(nextCommand(band, 28.0, st({ power: 'off', target: 24, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 20, fan: 'high' });
  assert.deepEqual(nextCommand(band, 26.8, st({ power: 'off', target: 24, fan: null }), T0 + MIN_GAP + 1), { action: 'cool', target: 24, fan: 'quiet' });
  assert.deepEqual(plan(band, 30.0), { action: 'cool', target: 20, fan: 'high', over: 5 });
  // a running AC goes to the pull-down at once; one already there (or lower) is kept
  assert.deepEqual(nextCommand(band, 27.5, st(), T0 + 1000), { action: 'cool', target: 20, fan: 'high' });
  assert.equal(nextCommand(band, 27.5, st({ target: 20, fan: 'high' }), T0 + 1000), null);
  assert.equal(nextCommand(band, 27.5, st({ target: 19, fan: 'high' }), T0 + 1000), null);
  // not cooling for 20 minutes: the setpoint still steps down
  assert.deepEqual(nextCommand(band, 27.5, st({ target: 20, fan: 'high', temp: 27.5 }), T0 + STEP_GAP + 1), { action: 'cool', target: 19, fan: 'high' });
  // between the top of the range and 1 degree above it: keeps pulling
  assert.equal(nextCommand(band, 26.5, st({ target: 20, fan: 'high' }), T0 + 1000), null);
  // back at the top of the range (or below it): trim floor, low fan; quiet once at the target
  assert.deepEqual(nextCommand(band, 26.0, st({ target: 20, fan: 'high' }), T0 + 1000), { action: 'cool', target: 22, fan: 'low' });
  assert.deepEqual(nextCommand(band, 23.5, st({ target: 20, fan: 'high' }), T0 + 1000), { action: 'cool', target: 22, fan: 'low' });
  assert.deepEqual(nextCommand(band, 25.0, st({ target: 22, fan: 'low' }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 22, fan: 'quiet' });
});

test('above the comfort range: fan quiet -> auto -> low -> medium, then the setpoint steps down every 20 minutes to 18', () => {
  assert.equal(nextCommand(band, 26.4, st(), T0 + 1000), null);
  assert.deepEqual(nextCommand(band, 26.4, st(), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'auto' });
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'auto' }), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'low' });
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'low' }), T0 + STEP_GAP + 1), { action: 'cool', target: 24, fan: 'med' });
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'med' }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'med' });
  assert.deepEqual(nextCommand(band, 26.2, st({ target: 22, fan: 'med' }), T0 + STEP_GAP + 1), { action: 'cool', target: 21, fan: 'med' });
  assert.equal(nextCommand(band, 26.2, st({ target: 18, fan: 'med' }), T0 + STEP_GAP + 1), null);
  // a setpoint above the trim ceiling (it barely cools there) comes down to the ceiling at once, even right after a command
  assert.deepEqual(nextCommand(band, 26.4, st({ target: 27 }), T0 + 1000), { action: 'cool', target: 24, fan: 'quiet' });
  // still cooling (dropped 0.2 or more since the last command): no fan or setpoint step
  assert.equal(nextCommand(band, 26.4, st({ temp: 26.6 }), T0 + STEP_GAP + 1), null);
  assert.equal(nextCommand(band, 26.4, st({ fan: 'med', temp: 26.7 }), T0 + STEP_GAP + 1), null);
  assert.deepEqual(nextCommand(band, 26.4, st({ fan: 'med', temp: 26.5 }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'med' });
  // back at the target: the fan returns to quiet
  assert.equal(nextCommand(band, 25.3, st({ fan: 'med' }), T0 + TRIM_AFTER + 1), null);
  assert.deepEqual(nextCommand(band, 25.0, st({ fan: 'med' }), T0 + TRIM_AFTER + 1), { action: 'cool', target: 24, fan: 'quiet' });
  // 2026-11-21 21:28: range 24-25.5, room back in at 25.2 with the setpoint at 18 -> trim floor 22, not the normal 25
  assert.deepEqual(nextCommand({ tMin: 24, tMax: 25.5 }, 25.22, st({ target: 18, source: 'manual' }), T0 + MIN_GAP + 1), { action: 'cool', target: 22, fan: 'quiet' });
});

test('a new comfort range is applied to the AC at once', () => {
  const auto = { ...bandFor(23), auto: true }; // target 23, trim 20-22
  // running automatic AC: new setpoint, fan auto
  assert.deepEqual(rangeCommand(auto, 23.8, st()), { action: 'cool', target: 22, fan: 'quiet' });
  assert.deepEqual(rangeCommand(auto, 26.5, st()), { action: 'cool', target: 22, fan: 'quiet' });
  assert.deepEqual(rangeCommand({ ...bandFor(27), auto: true }, 27.2, st({ target: 18, fan: 'high' })), { action: 'cool', target: 26, fan: 'high' });
  // with the old range known, the running setpoint moves by as much as the range did (keeps what the trim learned)
  assert.deepEqual(rangeCommand(auto, 25.0, st({ target: 22 }), bandFor(25)), { action: 'cool', target: 20, fan: 'quiet' });
  assert.deepEqual(rangeCommand({ ...bandFor(26), auto: true }, 25.0, st({ target: 22 }), bandFor(25)), { action: 'cool', target: 23, fan: 'quiet' });
  // a hand-started AC keeps its fan and stays hand-started, even with the automation off
  assert.deepEqual(rangeCommand(bandFor(23), 26.5, st({ source: 'manual', fan: 'low' })), { action: 'cool', target: 22, fan: 'low', source: 'manual' });
  // no reading: still the new setpoint
  assert.deepEqual(rangeCommand(auto, null, st()), { action: 'cool', target: 22, fan: 'quiet' });
  // already there: nothing to send
  assert.equal(rangeCommand(auto, 23.4, st({ target: 22 })), null);
  // off AC: started only with the automation on and a room that needs cooling
  assert.deepEqual(rangeCommand(auto, 24.0, st({ power: 'off', fan: null })), { action: 'cool', target: 22, fan: 'quiet' });
  assert.equal(rangeCommand(auto, 23.4, st({ power: 'off', fan: null })), null);
  assert.equal(rangeCommand(bandFor(23), 26.0, null), null);
});

test('well above the range it drops straight to the trim floor, even right after a command (the 02:20 screenshot)', () => {
  const r = { tMin: 25.5, tMax: 26.5, auto: true }; // target 26, trim floor 23, hot above 27.5
  assert.deepEqual(nextCommand(r, 27.4, st({ target: 25 }), T0 + 1000), { action: 'cool', target: 23, fan: 'quiet' });
  assert.equal(nextCommand(r, 27.4, st({ target: 23 }), T0 + 1000), null); // then 1 degree per 20 minutes
  assert.deepEqual(nextCommand(r, 27.4, st({ target: 23 }), T0 + STEP_GAP + 1), { action: 'cool', target: 23, fan: 'auto' });
  assert.deepEqual(nextCommand(r, 27.6, st({ target: 25 }), T0 + 1000), { action: 'cool', target: 21, fan: 'high' });
});

test('auto fan: 2 minutes after the command, a room that has not dropped 0.1 degree gets the low fan; quiet is not rushed', () => {
  const auto = over => st({ fan: 'auto', temp: 25.8, ...over });
  assert.equal(nextCommand(band, 25.8, auto(), T0 + FAN_CHECK - 1), null);
  assert.deepEqual(nextCommand(band, 25.8, auto(), T0 + FAN_CHECK + 1), { action: 'cool', target: 24, fan: 'low' });
  assert.deepEqual(nextCommand(band, 25.75, auto(), T0 + FAN_CHECK + 1), { action: 'cool', target: 24, fan: 'low' });
  assert.equal(nextCommand(band, 25.7, auto(), T0 + FAN_CHECK + 1), null); // cooling
  assert.equal(nextCommand(band, 25.4, auto({ temp: 25.4 }), T0 + FAN_CHECK + 1), null); // near the target the AC may idle
  assert.equal(nextCommand(band, 25.8, auto({ temp: undefined }), T0 + FAN_CHECK + 1), null); // unknown: 20-minute rule only
  // quiet always blows: only the 20-minute rule above the range steps it (2026-11-25: quiet -> low in 6 minutes)
  assert.equal(nextCommand(band, 25.8, st({ temp: 25.8 }), T0 + FAN_CHECK + 1), null);
  assert.equal(nextCommand(band, 25.8, st({ fan: 'low', temp: 25.8 }), T0 + FAN_CHECK + 1), null);
});
