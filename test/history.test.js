import test from 'node:test';
import assert from 'node:assert/strict';
import { SPANS, view } from '../cloud/public/history.js';

const H = 3600000, NOW = 1_800_000_000_000;
const every5min = hours => Array.from({ length: hours * 12 }, (_, i) => ({ at: NOW - hours * H + i * 300000, temperature: 25 }));

test('6 hours and 24 hours get different axes even when the data covers only 3 hours', () => {
  const pts = every5min(3);
  const six = view(pts, '6s', NOW), day = view(pts, '24s', NOW);
  assert.deepEqual([six.from, six.to], [NOW - 6 * H, NOW]);
  assert.deepEqual([day.from, day.to], [NOW - 24 * H, NOW]);
  assert.equal(six.points.length, pts.length);
  assert.equal(day.points.length, pts.length);
});

test('points older than the selected window are not drawn (24 hour data left over under the 6 hour tab)', () => {
  const v = view(every5min(24), '6s', NOW);
  assert.equal(v.points.length, 6 * 12);
  assert.ok(v.points.every(p => p.at >= NOW - 6 * H));
});

test('the window ends at the newest point when the browser clock is behind, and handles no data', () => {
  const v = view([{ at: NOW + 5000 }], '7g', NOW);
  assert.deepEqual([v.from, v.to], [NOW + 5000 - SPANS['7g'], NOW + 5000]);
  assert.deepEqual(view([], '6s', NOW), { from: NOW - 6 * H, to: NOW, points: [] });
});
