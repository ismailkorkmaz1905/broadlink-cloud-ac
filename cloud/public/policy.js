// Shared by the Worker (automation) and the page (rule explanation), so both always agree.
export const FANS = ['auto', 'high', 'med', 'low', 'quiet'];
export const FAN_LABELS = {
  tr: { auto: 'otomatik', high: 'yüksek', med: 'orta', low: 'düşük', quiet: 'sessiz' },
  en: { auto: 'auto', high: 'high', med: 'medium', low: 'low', quiet: 'quiet' },
};
export const FAN_LABEL = FAN_LABELS.tr; // used for push notifications

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Cooling setpoint is the lower comfort bound, so the AC's own thermostat settles inside the band.
export function setpoint(cfg) {
  return clamp(Math.round(cfg.tMin), 18, 30);
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

export function describe(cfg, lang = 'tr') {
  const t = setpoint(cfg);
  if (lang === 'en') {
    return `Above ${cfg.tMax}° the AC is set to ${t}° and cooling starts. Power (fan): below 1° over - low, 1-2° - medium, 2° and above - high. `
      + `It switches off below ${cfg.tMin}°. Inside the band the last state is kept. At least 10 minutes between commands.`;
  }
  return `${cfg.tMax}° üstünde klima ${t}°'ye ayarlanıp soğutma açılır. Güç (fan): aşım 1°'den azsa düşük, 1-2° orta, 2° ve üstü yüksek. `
    + `${cfg.tMin}° altına inince kapanır. Aralıktayken son durum korunur. Komutlar arasında en az 10 dakika beklenir.`;
}
