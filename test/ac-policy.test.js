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
