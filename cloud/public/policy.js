// Shared by the Worker (automation) and the page (rule explanation), so both always agree.
export const FANS = ['auto', 'high', 'med', 'low', 'quiet'];
export const FAN_LABELS = {
  tr: { auto: 'otomatik', high: 'yüksek', med: 'orta', low: 'düşük', quiet: 'sessiz' },
  en: { auto: 'auto', high: 'high', med: 'medium', low: 'low', quiet: 'quiet' },
};
export const FAN_LABEL = FAN_LABELS.tr; // used for push notifications
// The automation starts with the AC's own auto fan. Auto sometimes does not blow at all, so while the room stays above
// the range the fan is stepped auto -> low -> medium (one step per 10 minutes), and goes back to auto at the target.
export const FAN_STEPS = ['auto', 'low', 'med'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Room target is the middle of the comfort band, i.e. the target you typed (the band is target -1/+1).
export const roomTarget = cfg => (cfg.tMin + cfg.tMax) / 2;
export const DEAD = 0.5; // degrees around the target where nothing changes

// First AC setpoint when cooling starts: the room target, rounded (the AC only takes whole degrees).
export function setpoint(cfg) {
  return clamp(Math.round(roomTarget(cfg)), 18, 30);
}

// Range the trim loop may move the AC setpoint in: 3 below to 2 above the starting setpoint.
export const trimRange = cfg => [clamp(setpoint(cfg) - 3, 18, 30), clamp(setpoint(cfg) + 2, 18, 30)];

// What the page shows as the automation's decision for this temperature.
export function plan(cfg, temp) {
  const over = temp - roomTarget(cfg);
  if (temp < cfg.tMin) return { action: 'off', over };
  if (over > DEAD) return { action: 'cool', target: setpoint(cfg), fan: 'auto', over };
  return { action: 'hold', over };
}

// Comfort range that follows a hand-set target: one degree either side of it.
export const bandFor = target => ({ tMin: target - 1, tMax: target + 1 });

export const MIN_GAP = 10 * 60000;
export const RESEND = 30 * 60000;
export const TRIM_AFTER = 20 * 60000;

// What the automation should send now, or null. `state` is the last AC command ({power, target, fan, at, source, ok}).
// Steady-room control: once cooling, the AC stays on and its own inverter holds the room. Every 20 minutes the setpoint
// is nudged 1 degree toward the room target using the room sensor, because the AC's thermostat reads differently.
// The AC is switched off only when the room falls below the band.
export function nextCommand(cfg, temp, state, now = Date.now()) {
  const age = state ? now - state.at : Infinity;
  const e = temp - roomTarget(cfg);
  const [lo, hi] = trimRange(cfg);
  if (state?.power === 'on' && !state.ok) return age > MIN_GAP ? { action: 'cool', target: state.target, fan: state.fan, ...(state.source === 'manual' ? { source: 'manual' } : {}) } : null;
  // Restart from the setpoint learned last time (kept on the off state), so the same overshoot is not repeated.
  if (state?.power !== 'on') return e > DEAD && age > MIN_GAP ? { action: 'cool', target: clamp(state?.target ?? setpoint(cfg), lo, hi), fan: 'auto' } : null;
  const keep = state.source === 'manual' ? { source: 'manual' } : {}; // a hand-started AC stays marked as hand-started
  const step = FAN_STEPS.indexOf(state.fan);
  // An automatic AC left at a fan outside the steps (e.g. the old fan-high pull-down) goes back to auto at once.
  if (!keep.source && step < 0) return { action: 'cool', target: Math.min(state.target, hi), fan: 'auto' };
  if (temp < cfg.tMin) {
    // Too cold: first ease the AC off by 2 degrees; switch it off if that was already done or it is clearly cold.
    if (age <= MIN_GAP) return null;
    return state.target < hi && temp >= cfg.tMin - DEAD ? { action: 'cool', target: Math.min(hi, state.target + 2), fan: state.fan, ...keep } : { action: 'off', target: state.target };
  }
  // Well above the range (tMax + 0.5): jump straight to the trim floor (setpoint - 3) instead of waiting.
  if (temp > cfg.tMax + DEAD && state.target > lo) return { action: 'cool', target: lo, fan: state.fan, ...keep };
  // Room above the comfort range for 10 minutes: first try the next fan step (auto -> low -> medium), then lower the
  // setpoint. A hand-picked fan other than these (quiet, high) is left alone.
  if (temp > cfg.tMax && age > MIN_GAP && step >= 0 && step < FAN_STEPS.length - 1) return { action: 'cool', target: state.target, fan: FAN_STEPS[step + 1], ...keep };
  // Then step the setpoint down every 10 minutes, as far as 18, until it is back inside. The AC's own
  // thermostat can read several degrees off, so the normal trim floor is not always enough.
  if (temp > cfg.tMax && age > MIN_GAP && state.target > 18) return { action: 'cool', target: state.target - 1, fan: state.fan, ...keep };
  // Room back at the target: an automatic AC returns to the auto fan.
  if (!keep.source && step > 0 && e <= 0 && age > TRIM_AFTER) return { action: 'cool', target: state.target, fan: 'auto' };
  if (age > TRIM_AFTER) {
    if (e > DEAD && state.target > lo) return { action: 'cool', target: state.target - 1, fan: state.fan, ...keep };
    if (e < -DEAD && state.target < hi) return { action: 'cool', target: state.target + 1, fan: state.fan, ...keep };
  }
  return age > RESEND ? { action: 'cool', target: state.target, fan: state.fan, ...keep } : null;
}

// What to send right after the comfort range is changed, so the AC follows the new range at once (null = nothing).
// A running AC's setpoint moves with the range (a hand-started one keeps its fan and stays hand-started). An off AC is started only when the automation is on and the room needs cooling.
export function rangeCommand(cfg, temp, state, prev) {
  const p = Number.isFinite(temp) ? plan(cfg, temp) : null;
  if (state?.power !== 'on') return cfg.auto === true && p?.action === 'cool' ? { action: 'cool', target: p.target, fan: p.fan } : null;
  const manual = state.source === 'manual';
  // Keep what the trim loop learned: move the running setpoint by as much as the range moved.
  const moved = Number.isFinite(prev?.tMin) && Number.isFinite(prev?.tMax) ? setpoint(cfg) - setpoint(prev) : null;
  const target = moved === null ? setpoint(cfg) : clamp(state.target + moved, 18, 30);
  const cmd = { action: 'cool', target, fan: manual || FAN_STEPS.includes(state.fan) ? state.fan : 'auto', ...(manual ? { source: 'manual' } : {}) };
  return state.ok && cmd.target === state.target && cmd.fan === state.fan ? null : cmd;
}

export function describe(cfg, lang = 'tr') {
  const T = roomTarget(cfg), s = setpoint(cfg), [lo, hi] = trimRange(cfg);
  if (lang === 'en') {
    return `Room target ${T}° (middle of the range). Above ${T + DEAD}° the AC is set to ${s}°, fan auto, and stays on. `
      + `If the room stays above ${cfg.tMax}° for 10 minutes the fan goes auto -> low -> medium, then the setting goes down 1° every 10 minutes (down to 18°); the fan goes back to auto at the target. `
      + `Changing the range applies the new setting to the AC at once. `
      + `If the room goes above ${cfg.tMax + DEAD}° the AC setting drops straight to ${lo}°. `
      + `Every 20 minutes, if the room is more than ${DEAD}° above the target the AC setting goes down 1°, if below it goes up 1° (between ${lo}° and ${hi}°). `
      + `Below ${cfg.tMin}° it first raises the AC setting by 2°, and switches off if that is not enough. Commands are re-sent every 30 minutes in case the AC missed one.`;
  }
  return `Oda hedefi ${T}° (aralığın ortası). Oda ${T + DEAD}°'yi geçince klima ${s}°'ye, fan otomatiğe ayarlanıp açılır ve açık kalır. `
    + `Oda 10 dakika ${cfg.tMax}°'nin üstünde kalırsa fan otomatik -> düşük -> orta denenir, sonra klima ayarı 10 dakikada bir 1° düşer (18°'ye kadar); oda hedefe inince fan otomatiğe döner. `
    + `Aralığı değiştirince yeni ayar klimaya hemen gönderilir. `
    + `Oda ${cfg.tMax + DEAD}°'yi geçerse klima ayarı hemen ${lo}°'ye iner. `
    + `20 dakikada bir oda hedefin ${DEAD}°'den fazla üstündeyse klima ayarı 1° düşer, altındaysa 1° artar (${lo}°-${hi}° arası). `
    + `${cfg.tMin}°'nin altına inerse önce klima ayarı 2° artar, yetmezse kapanır. Klima bir komutu kaçırırsa diye 30 dakikada bir yeniden gönderilir.`;
}
