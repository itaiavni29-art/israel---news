// Normalize feed timestamps to UTC milliseconds.
// Some feeds (Walla, JPost) label Israel local time as "GMT"; for those we re-interpret
// the wall-clock value as Asia/Jerusalem time.

const TZ = 'Asia/Jerusalem';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Offset (ms) of Asia/Jerusalem from UTC at a given UTC instant.
function jerusalemOffset(utcMs) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

// Treat the UTC fields of `wallMs` as a Jerusalem wall-clock time and return the true UTC instant.
export function jerusalemWallToUtc(wallMs) {
  let utc = wallMs - jerusalemOffset(wallMs);
  utc = wallMs - jerusalemOffset(utc); // second pass handles DST boundaries
  return utc;
}

/**
 * @param {string} raw pubDate string from the feed
 * @param {{labelIsLocalTime?: boolean, now?: number}} opts
 * @returns {number|null} UTC ms, clamped so it is never in the future
 */
export function normalizeDate(raw, { labelIsLocalTime = false, now = Date.now() } = {}) {
  if (!raw) return null;
  let ms = Date.parse(String(raw).trim());
  if (Number.isNaN(ms)) return null;
  if (labelIsLocalTime) ms = jerusalemWallToUtc(ms);
  // A few items carry future timestamps (scheduled posts / wrong zone); never trust the future.
  if (ms > now + 5 * 60_000) ms = now;
  return ms;
}
