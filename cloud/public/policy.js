// Shared by the Worker (automation) and the page (rule explanation), so both always agree.
export const FANS = ['auto', 'high', 'med', 'low', 'quiet'];
export const FAN_LABELS = {
  tr: { auto: 'otomatik', high: 'yüksek', med: 'orta', low: 'düşük', quiet: 'sessiz' },
  en: { auto: 'auto', high: 'high', med: 'medium', low: 'low', quiet: 'quiet' },
};
export const FAN_LABEL = FAN_LABELS.tr; // used for push notifications
// The automation runs on the quiet fan (enough for a room near the range, and the AC is silent) and steps up when the room
// does not follow: quiet -> auto -> low -> medium, one step per 20 minutes above the range (the auto fan, which sometimes
// does not blow, is checked after 2 minutes). It goes back to quiet at the target.
export const FAN_STEPS = ['quiet', 'auto', 'low', 'med'];
export const startFan = () => 'quiet';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Room target is the middle of the comfort band, i.e. the target you typed (the band is target -1/+1).
export const roomTarget = cfg => (cfg.tMin + cfg.tMax) / 2;
export const DEAD = 0.5; // degrees around the target where nothing changes

// First AC setpoint when cooling starts: the room target, rounded (the AC only takes whole degrees).
export function setpoint(cfg) {
  return clamp(Math.round(roomTarget(cfg)), 18, 30);
}

// Range the trim loop may move the AC setpoint in: 3 below to 1 below the starting setpoint. The AC's thermostat reads about
// 3 degrees warm, so a setpoint at or above the starting one barely cools: on 2026-11-23 the setpoint crept 23 -> 27 over
// 4 hours while the room sat at the bottom edge of a 1 degree range, and the room then warmed 25.0 -> 26.4 in 40 minutes.
export const trimRange = cfg => [clamp(setpoint(cfg) - 3, 18, 30), clamp(setpoint(cfg) - 1, 18, 30)];

// Hot room (more than HOT above the range, e.g. coming home to 28): pull it down hard, high fan and the setpoint 2 below
// the trim floor, until the room is back at the top of the range. Then trim floor, low fan, and the normal rules.
export const HOT = 1;
export const BOOST_FAN = 'high';
export const boostTarget = cfg => clamp(setpoint(cfg) - 5, 18, 30);
export const isHot = (cfg, temp) => temp > cfg.tMax + HOT;

// What the page shows as the automation's decision for this temperature.
export function plan(cfg, temp) {
  const over = temp - roomTarget(cfg);
  if (temp < cfg.tMin) return { action: 'off', over };
  if (isHot(cfg, temp)) return { action: 'cool', target: boostTarget(cfg), fan: BOOST_FAN, over };
  if (over > DEAD) return { action: 'cool', target: trimRange(cfg)[1], fan: startFan(), over };
  return { action: 'hold', over };
}

export const MIN_GAP = 10 * 60000;
// Between two setpoint or fan steps: the AC takes 20-30 minutes to show a change in the room, so 10-minute steps kept
// swinging the room across the whole range about once an hour (night of 2026-11-23, setpoint 23 <-> 26).
export const STEP_GAP = 20 * 60000;
export const RESEND = 30 * 60000;
// A dip this small below the range (room sensor noise at the edge) does not raise the setpoint or switch the AC off.
export const COLD_DIP = 0.2;
export const TRIM_AFTER = 20 * 60000;
// A hand-set command is a shortcut into the range, not a new range: the automation leaves it alone while the room is above
// the range (for up to an hour) and for 10 minutes after it was sent, then takes over again.
export const MANUAL_HOLD = 60 * 60000;
// The auto fan sometimes does not blow (the AC's own thermostat decides). 2 minutes after a command with the auto fan,
// a room that has not dropped at least 0.1 degree since that command gets the low fan. (The quiet fan always blows, and
// checking it after 2 minutes stepped quiet -> auto -> low within 6 minutes, night of 2026-11-25.)
export const FAN_CHECK = 2 * 60000;
export const MOVED = 0.1;
// Above the range the fan and setpoint are only stepped while the room is not cooling: less than this drop since the
// last command. Lowering the setpoint while the room is already falling overshoots it (cold, then off, then hot).
export const COOLING = 0.2;

// What the automation should send now, or null. `state` is the last AC command ({power, target, fan, at, source, ok}),
// plus `temp`, the room temperature when it was sent.
// Steady-room control: once cooling, the AC stays on and its own inverter holds the room. The AC's thermostat reads about
// 3 degrees warm (logs 2026-11-19..21: setpoint 22-23 holds the room near 25.5-26), so the setpoint lives in the trim range
// (setpoint - 3 .. - 1). Only while the room is above the range and not cooling does it go below that; back in the range
// it comes back up to the trim floor at once. The AC is switched off only when the room falls below the band.
export function nextCommand(cfg, temp, state, now = Date.now()) {
  const age = state ? now - state.at : Infinity;
  const e = temp - roomTarget(cfg);
  const [lo, hi] = trimRange(cfg);
  const hot = isHot(cfg, temp);
  const resend = extra => (age > RESEND ? { action: 'cool', target: state.target, fan: state.fan, ...extra } : null);
  if (state?.power === 'on' && !state.ok) return age > MIN_GAP ? { action: 'cool', target: state.target, fan: state.fan, ...(state.source === 'manual' ? { source: 'manual' } : {}) } : null;
  // Restart at the trim ceiling, not at the setpoint it was switched off with: restarting at the floor (23) with the auto fan
  // pulled the room down 1.7 degrees in 20 minutes, 26.2 -> 24.5, five nights runs in a row (2026-11-24), and it went off again.
  if (state?.power !== 'on') {
    if (!(e > DEAD && age > MIN_GAP)) return null;
    return hot ? { action: 'cool', target: boostTarget(cfg), fan: BOOST_FAN } : { action: 'cool', target: hi, fan: startFan() };
  }
  // A hand-set command (to get into the range faster) is left alone for 10 minutes, and while the room is above the range
  // for up to an hour. After that the automation takes over and its commands are its own (2026-11-24 20:11: a hand-set 23
  // with the high fan moved the range to 22-24 and the AC was pulled to 20, room 22.4 for three hours).
  // (No re-send while it is held: a re-send would restart the hour.)
  if (state.source === 'manual' && (age <= MIN_GAP || (temp > cfg.tMax && age < MANUAL_HOLD))) return null;
  const step = FAN_STEPS.indexOf(state.fan);
  // Hot room: high fan, setpoint 2 below the trim floor (or lower if it has already been stepped down).
  if (hot && (state.fan !== BOOST_FAN || state.target > boostTarget(cfg))) return { action: 'cool', target: Math.min(state.target, boostTarget(cfg)), fan: BOOST_FAN };
  // Back at the top of the range on the high fan (a hot-room pull-down or a hand-set high fan): trim range, low fan.
  if (step < 0 && temp <= cfg.tMax) return { action: 'cool', target: clamp(state.target, lo, hi), fan: 'low' };
  if (temp < cfg.tMin) {
    if (temp >= cfg.tMin - COLD_DIP) return resend();
    // Too cold: ease the AC off by 1 degree every 20 minutes; switch it off at the top of the trim range or when it is
    // clearly cold. (+2 steps overshot: night of 2026-11-22, 24 -> 28 in 10 minutes, room 24.95 -> 26.47 in 75 minutes.)
    // The 20-minute wait is for the +1 step. Switching off is decided after 10 minutes: with the wait it came when the room
    // was already 0.7 degree below the range (2026-11-24 night, 1.7 degrees fall per 20 minutes).
    const off = !(state.target < hi && temp >= cfg.tMin - DEAD);
    if (age <= (off ? MIN_GAP : STEP_GAP)) return null;
    return off ? { action: 'off', target: state.target } : { action: 'cool', target: state.target + 1, fan: state.fan };
  }
  // Well above the range (tMax + 0.5): jump straight to the trim floor (setpoint - 3) instead of waiting.
  if (temp > cfg.tMax + DEAD && state.target > lo) return { action: 'cool', target: lo, fan: state.fan };
  // Above the range with the setpoint above the trim ceiling (it barely cools there): come down to the ceiling at once.
  if (temp > cfg.tMax && state.target > hi) return { action: 'cool', target: hi, fan: state.fan };
  // Auto fan, room still above the target zone and not cooling 2 minutes after the command: the next fan step.
  if (step === 1 && e > DEAD && age > FAN_CHECK && Number.isFinite(state.temp) && temp > state.temp - MOVED) return { action: 'cool', target: state.target, fan: FAN_STEPS[step + 1] };
  // Back inside the range: a setpoint pulled below the trim floor comes back up to it at once. (Going back to the normal
  // setpoint instead let the room warm 0.8 degree in 10 minutes on 2026-11-21, because of the thermostat offset.)
  if (temp <= cfg.tMax && state.target < lo) return { action: 'cool', target: lo, fan: state.fan };
  // Room above the comfort range for 20 minutes and not cooling (unknown counts as not cooling): first try the next fan
  // step (quiet -> auto -> low -> medium), then lower the setpoint.
  const stuck = !Number.isFinite(state.temp) || temp > state.temp - COOLING;
  if (temp > cfg.tMax && age > STEP_GAP && stuck && step >= 0 && step < FAN_STEPS.length - 1) return { action: 'cool', target: state.target, fan: FAN_STEPS[step + 1] };
  // Then step the setpoint down every 20 minutes, as far as 18. The AC's own thermostat can read several degrees off,
  // so the trim floor is not always enough.
  if (temp > cfg.tMax && age > STEP_GAP && stuck && state.target > 18) return { action: 'cool', target: state.target - 1, fan: state.fan };
  // Room back at the target: the fan returns to quiet.
  if (step > 0 && e <= 0 && age > TRIM_AFTER) return { action: 'cool', target: state.target, fan: FAN_STEPS[0] };
  if (age > TRIM_AFTER) {
    // The trim also waits while the room is still cooling, or it piles a step on top of one that is still working.
    if (e > DEAD && stuck && state.target > lo) return { action: 'cool', target: state.target - 1, fan: state.fan };
    if (e < -DEAD && state.target < hi) return { action: 'cool', target: state.target + 1, fan: state.fan };
  }
  return resend();
}

// What to send right after the comfort range is changed, so the AC follows the new range at once (null = nothing).
// A running AC's setpoint moves with the range (a hand-started one keeps its fan and stays hand-started). An off AC is started only when the automation is on and the room needs cooling.
export function rangeCommand(cfg, temp, state, prev) {
  const p = Number.isFinite(temp) ? plan(cfg, temp) : null;
  if (state?.power !== 'on') return cfg.auto === true && p?.action === 'cool' ? { action: 'cool', target: p.target, fan: p.fan } : null;
  const manual = state.source === 'manual';
  // Keep what the trim loop learned: move the running setpoint by as much as the range moved.
  const moved = Number.isFinite(prev?.tMin) && Number.isFinite(prev?.tMax) ? setpoint(cfg) - setpoint(prev) : null;
  const target = moved === null ? trimRange(cfg)[1] : clamp(state.target + moved, 18, 30);
  const cmd = { action: 'cool', target, fan: state.fan, ...(manual ? { source: 'manual' } : {}) };
  return state.ok && cmd.target === state.target && cmd.fan === state.fan ? null : cmd;
}

export function describe(cfg, lang = 'tr') {
  const T = roomTarget(cfg), [lo, hi] = trimRange(cfg), B = boostTarget(cfg), H = cfg.tMax + HOT;
  if (lang === 'en') {
    return `Room target ${T}° (middle of the range). Above ${T + DEAD}° the AC is set to ${hi}° with the quiet fan and stays on. `
      + `If the room goes above ${H}° it cools hard: ${B}°, high fan, until the room is back at ${cfg.tMax}°; then ${lo}° with the low fan. `
      + `If the room is above ${cfg.tMax}° and has not cooled ${COOLING}° in 20 minutes, the fan goes up one step (quiet -> auto -> low -> medium), then the setting goes down 1° every 20 minutes (down to 18°). `
      + `If the room goes above ${cfg.tMax + DEAD}° the AC setting drops straight to ${lo}°. `
      + `Once the room is back in the range, a setting below ${lo}° comes back up to ${lo}° at once; the fan goes back to quiet at the target. `
      + `A setting you send by hand does not change the range: it is left alone for 10 minutes and while the room is above ${cfg.tMax}° (up to an hour), then the automation takes over. `
      + `Changing the range applies the new setting to the AC at once. `
      + `Every 20 minutes, if the room is more than ${DEAD}° above the target the AC setting goes down 1°, if below it goes up 1° (between ${lo}° and ${hi}°). `
      + `Below ${cfg.tMin}° it raises the AC setting by 1° every 20 minutes, and switches off if that is not enough; it restarts at ${hi}°. Commands are re-sent every 30 minutes in case the AC missed one.`;
  }
  return `Oda hedefi ${T}° (aralığın ortası). Oda ${T + DEAD}°'yi geçince klima ${hi}°'ye, sessiz fanla ayarlanıp açılır ve açık kalır. `
    + `Oda ${H}°'yi geçerse sert soğutur: ${B}°, yüksek fan, oda ${cfg.tMax}°'ye inene kadar; sonra ${lo}°, düşük fan. `
    + `Oda ${cfg.tMax}°'nin üstündeyse ve 20 dakikada ${COOLING}° soğumadıysa fan bir basamak artar (sessiz -> otomatik -> düşük -> orta), sonra klima ayarı 20 dakikada bir 1° düşer (18°'ye kadar). `
    + `Oda ${cfg.tMax + DEAD}°'yi geçerse klima ayarı hemen ${lo}°'ye iner. `
    + `Oda aralığa geri girince ${lo}°'nin altındaki ayar hemen ${lo}°'ye çıkar; oda hedefe inince fan sessize döner. `
    + `Elle gönderdiğin ayar aralığı değiştirmez: 10 dakika ve oda ${cfg.tMax}°'nin üstünde kaldıkça (en fazla 1 saat) ona dokunulmaz, sonra otomatik kontrol devralır. `
    + `Aralığı değiştirince yeni ayar klimaya hemen gönderilir. `
    + `20 dakikada bir oda hedefin ${DEAD}°'den fazla üstündeyse klima ayarı 1° düşer, altındaysa 1° artar (${lo}°-${hi}° arası). `
    + `${cfg.tMin}°'nin altına inerse klima ayarı 20 dakikada bir 1° artar, yetmezse kapanır; tekrar ${hi}°'den açılır. Klima bir komutu kaçırırsa diye 30 dakikada bir yeniden gönderilir.`;
}
