// BroadLink IR code (base64: 26 repeat len16 data..) -> signed microsecond timings (mark +, space -),
// the format ESPHome's remote_transmitter.transmit_raw takes. One BroadLink tick is 269/8192 ms (32.84 us).
// Values >= 256 ticks are escaped as 00 hi lo. The trailing gap (the 0x0d05 trailer) is dropped.
export function broadlinkToRaw(b64) {
  const b = Buffer.from(String(b64), 'base64');
  if (b.length < 6 || b[0] !== 0x26) throw new Error('Not a BroadLink IR code');
  const end = Math.min(b.length, 4 + (b[2] | (b[3] << 8)));
  const raw = [];
  for (let i = 4; i < end;) {
    let v = b[i++];
    if (v === 0) {
      if (i + 1 >= end) break;
      v = (b[i] << 8) | b[i + 1];
      i += 2;
    }
    const us = Math.round(v * 269 / 8.192);
    raw.push(raw.length % 2 ? -us : us);
  }
  if (raw.length && raw.length % 2 === 0 && -raw[raw.length - 1] >= 20000) raw.pop();
  return raw;
}
