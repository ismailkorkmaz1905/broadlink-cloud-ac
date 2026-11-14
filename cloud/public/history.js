// Time window each history tab covers. The Worker's `ranges` uses the same keys and lengths.
export const SPANS = { '6s': 6 * 3600000, '24s': 24 * 3600000, '7g': 7 * 86400000 };

// The chart's x axis is the selected window ending now, not the extent of the data. Fitting the axis to the data
// made 6 hours and 24 hours draw the same picture whenever the stored samples covered less than 6 hours.
export function view(points, range, now) {
  const to = Math.max(now, points.length ? points[points.length - 1].at : 0);
  const from = to - SPANS[range];
  return { from, to, points: points.filter(p => p.at >= from) };
}
