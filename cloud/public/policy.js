// Shared by the Worker (automation) and the page (rule explanation), so both always agree.
export const FANS = ['auto', 'high', 'med', 'low', 'quiet'];
export const FAN_LABELS = {
  tr: { auto: 'otomatik', high: 'yüksek', med: 'orta', low: 'düşük', quiet: 'sessiz' },
  en: { auto: 'auto', high: 'high', med: 'medium', low: 'low', quiet: 'quiet' },
};
export const FAN_LABEL = FAN_LABELS.tr; // used for push notifications

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Cooling setpoint is the middle of the comfort band, which is the target you typed (the band is target -1/+1).
// Pushing the AC to the lower bound made it pull down at full power and overshoot by about half a degree.
export function setpoint(cfg) {
  return clamp(Math.round((cfg.tMin + cfg.tMax) / 2), 18, 30);
}

// How hard to cool depends on how far the room is above the upper bound.
export function fanFor(over) {
  return over >= 2 ? 'high' : over >= 1 ? 'med' : 'low';
}

export function plan(cfg, temp) {
  const over = temp - cfg.tMax;
  if (over > 0) return { action: 'cool', target: setpoint(cfg), fan: fanFor(over), over };
  if (temp < cfg.tMin) return { action: 'off', over };
  return { action: 'hold', over };
}

// Comfort range that follows a hand-set target: one degree either side of it.
export const bandFor = target => ({ tMin: target - 1, tMax: target + 1 });

export const MIN_GAP = 10 * 60000;
export const RESEND = 30 * 60000;
export const STEP_AFTER = 15 * 60000;

// What the automation should send now, or null. `state` is the last AC command ({power, target, fan, at, source, ok}).
// Cooling starts gently at the band's middle. If the room is still above the band 15 minutes after the last command,
// the setpoint steps down one degree (not below tMin - 1): the AC's own thermostat can read cooler than the room sensor.
export function nextCommand(cfg, temp, state, now = Date.now()) {
  const age = state ? now - state.at : Infinity;
  const p = plan(cfg, temp);
  const on = state?.power === 'on' && !!state.ok;
  if (p.action === 'cool') {
    if (!on) return age > MIN_GAP ? { action: 'cool', target: p.target, fan: p.fan } : null;
    // A hand-set target and fan are kept, but re-sent every 30 minutes in case the AC missed the command or stopped.
    if (state.source === 'manual') return age > RESEND ? { action: 'cool', target: state.target, fan: state.fan, source: 'manual' } : null;
    const floor = Math.max(18, Math.round(cfg.tMin) - 1);
    if (age > STEP_AFTER && state.target > floor) return { action: 'cool', target: state.target - 1, fan: p.fan };
    if (state.fan !== p.fan && age > MIN_GAP) return { action: 'cool', target: state.target, fan: p.fan };
    return age > RESEND ? { action: 'cool', target: state.target, fan: p.fan } : null;
  }
  if (p.action === 'off' && state?.power === 'on' && age > MIN_GAP) return { action: 'off' };
  return null;
}

export function describe(cfg, lang = 'tr') {
  const t = setpoint(cfg);
  if (lang === 'en') {
    return `Above ${cfg.tMax}° the AC is set to ${t}° (the middle of the range) and cooling starts. Power (fan): below 1° over - low, 1-2° - medium, 2° and above - high. `
      + `It switches off below ${cfg.tMin}°. Inside the band the last state is kept. If the room is still above the range 15 minutes later, the setpoint steps down 1° (not below the lower bound -1). A target and fan you set by hand are kept (re-sent every 30 minutes) until it switches off, and the comfort range moves to that target -1/+1 (you can still edit it afterwards). At least 10 minutes between commands.`;
  }
  return `${cfg.tMax}° üstünde klima ${t}°'ye (aralığın ortası) ayarlanıp soğutma açılır. Güç (fan): aşım 1°'den azsa düşük, 1-2° orta, 2° ve üstü yüksek. `
    + `${cfg.tMin}° altına inince kapanır. Aralıktayken son durum korunur. 15 dakika sonra oda hâlâ aralığın üstündeyse hedef 1° düşürülür (alt sınırın 1° altına kadar). Elle verdiğin hedef ve fan klima kapanana kadar korunur (30 dakikada bir yeniden gönderilir); konfor aralığı da hedef -1/+1 olur (sonra elle değiştirebilirsin). Komutlar arasında en az 10 dakika beklenir.`;
}
