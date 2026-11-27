// Durations and times, formatted by hand: Herdr's script runtime ignores toLocaleString's options.

/** "45m", "3h 20m", "2d 4h". */
export function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "3h ago", "just now". */
export function ago(ms, now = Date.now()) {
  const d = now - ms;
  return d < 60_000 ? "just now" : `${duration(d)} ago`;
}

const pad = (n) => String(n).padStart(2, "0");

/** "20261127-1405": for branch names. */
export function stamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** "2026-11-27": for history files. */
export function day(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
