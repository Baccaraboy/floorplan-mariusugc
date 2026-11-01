// Cron expressions for the Clock (graph.schedules): reading a five-field expression, the minutes of one day it starts
// at (for the 24-hour strip), and the expression in words in the map's language ("every 20 minutes", "daily at
// 02:30", "weekdays at 08:00", "every Sunday at 03:00", "monthly on the 1st at 06:00"). The words come from the
// language table (cron.* keys), never from here; a form these functions don't know is left to the caller, which shows
// the raw expression instead. A timer that cron can't express exactly (n8n's "every 2 days", ofelia's "@every 90m")
// arrives as an interval { every, unit, at? } and is put into words the same way.

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORTCUTS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const MINUTES_OF_DAY = 24 * 60;
// the keys of the language table: the days of the week (Sunday first, as cron counts) and the ordinal forms
const DAY_KEYS = ['cron.day.0', 'cron.day.1', 'cron.day.2', 'cron.day.3', 'cron.day.4', 'cron.day.5', 'cron.day.6'];
const ORDINAL_KEYS = { one: 'cron.ordinal.one', two: 'cron.ordinal.two', few: 'cron.ordinal.few', other: 'cron.ordinal.other' };

/** A month or weekday name to its number, or the number itself; null when it's neither. */
function value(token, i) {
  const s = token.toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return i === 4 && n === 7 ? 0 : n; // 7 is Sunday too
  }
  // "mon" or "monday", "jan" or "january": the first three letters say which
  const names = i === 3 ? MONTHS : i === 4 ? DAYS : null;
  const at = names && /^[a-z]{3,}$/.test(s) ? names.indexOf(s.slice(0, 3)) : -1;
  return at < 0 ? null : at + (i === 3 ? 1 : 0);
}

/** One field of a cron expression as the set of values it names, or null when it isn't valid. */
function parseField(field, i) {
  const [lo, hi] = RANGES[i];
  const out = new Set();
  for (const item of field.split(',')) {
    const m = /^(\*|\?|[A-Za-z]{3,}|\d+)(?:-([A-Za-z]{3,}|\d+))?(?:\/(\d+))?$/.exec(item);
    if (!m) return null;
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (!step) return null;
    let from, to;
    if (m[1] === '*' || m[1] === '?') { from = lo; to = hi; }
    else {
      from = value(m[1], i);
      to = m[2] === undefined ? (m[3] === undefined ? from : hi) : value(m[2], i);
      if (from === null || to === null) return null;
    }
    if (from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/**
 * A five-field cron expression (or @daily, @hourly …) as { expr, fields }, each field the set of values it names,
 * with full[i] true for a field that covers its whole range. Null when the expression isn't one.
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') return null;
  const s = SHORTCUTS[expr.trim().toLowerCase()] || expr.trim();
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map(parseField);
  if (fields.some((f) => !f)) return null;
  return { expr: s, fields, full: fields.map((f, i) => f.size === RANGES[i][1] - RANGES[i][0] + 1) };
}

const sorted = (set) => [...set].sort((a, b) => a - b);
const pad = (n) => String(n).padStart(2, '0');
const clock = (h, m) => `${pad(h)}:${pad(m)}`;
/** The constant step of a series that starts at the range's first value and covers the range (0, 20, 40 → 20); null otherwise. */
function seriesStep(list, size) {
  if (list.length < 2 || list[0] !== 0) return null;
  const step = list[1] - list[0];
  for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] !== step) return null;
  return list[list.length - 1] + step >= size ? step : null;
}

/**
 * The minutes of one day a parsed expression starts at, for the 24-hour strip: only for a plan that runs on any day
 * (any day of the month and the month, and five or more days of the week); a weekly or monthly plan gets none.
 */
export function cronTimes(parsed) {
  if (!parsed) return [];
  const [mi, ho, dom, , dow] = parsed.fields;
  if (!parsed.full[2] || !parsed.full[3] || dow.size < 5) return [];
  const out = [];
  for (const h of sorted(ho)) for (const m of sorted(mi)) out.push(h * 60 + m);
  return out;
}

/**
 * A parsed expression in words, through t(key, vars) from the language table: the usual forms, else null (the caller
 * shows the raw expression). `lang` picks the ordinal rules for "on the 1st" / "am 1.".
 */
export function cronWords(parsed, t, lang = 'en') {
  if (!parsed) return null;
  const [mi, ho, dom, , dow] = parsed.fields;
  const [minutesFull, hoursFull, domFull, monthFull, dowFull] = parsed.full;
  if (!monthFull) return null;
  const minutes = sorted(mi), hours = sorted(ho);
  if (hoursFull && domFull && dowFull) {
    if (minutesFull) return t('cron.everyMinute');
    if (minutes.length === 1) return t('cron.hourly', { mm: pad(minutes[0]) });
    const step = seriesStep(minutes, 60);
    if (step) return t('cron.everyMinutes', { n: step });
    return null;
  }
  if (minutes.length === 1 && domFull && dowFull) {
    const step = seriesStep(hours, 24);
    if (step && step > 1) return t('cron.everyHours', { n: step, mm: pad(minutes[0]) });
  }
  const times = [];
  for (const h of hours) for (const m of minutes) times.push(clock(h, m));
  if (!times.length || times.length > 4) return null;
  const time = times.join(', ');
  if (domFull && dowFull) return t('cron.daily', { time });
  if (domFull) {
    const days = sorted(dow);
    if (days.join() === '1,2,3,4,5') return t('cron.weekdays', { time });
    if (days.join() === '0,6') return t('cron.weekends', { time });
    return t('cron.weekly', { days: days.map((d) => t(DAY_KEYS[d])).join(', '), time });
  }
  if (dowFull && dom.size === 1) return t('cron.monthly', { day: ordinal(sorted(dom)[0], t, lang), time });
  return null;
}

/** "1st", "2nd", "3rd", "4th" in English, "1." in German: cron.ordinal.<category> by the language's ordinal rules. */
function ordinal(n, t, lang) {
  let rules;
  try { rules = new Intl.PluralRules(lang, { type: 'ordinal' }); } catch { rules = new Intl.PluralRules('en', { type: 'ordinal' }); }
  return t(ORDINAL_KEYS[rules.select(n)] || ORDINAL_KEYS.other, { n });
}

const UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months'];
/** True for a timer { every, unit, at? } as the scanner writes one for what cron can't say exactly. */
export const isInterval = (x) => !!x && typeof x === 'object' && Number.isInteger(x.every) && x.every > 0 && UNITS.includes(x.unit) && (x.at === undefined || /^\d{2}:\d{2}$/.test(x.at));

/** A timer in words: "every 30 seconds", "every 2 days at 02:30". */
export function intervalWords(interval, t) {
  if (!isInterval(interval)) return null;
  const { every: n, unit, at } = interval;
  if (unit === 'seconds') return t('cron.everySeconds', { n });
  if (unit === 'minutes') return n === 1 ? t('cron.everyMinute') : t('cron.everyMinutes', { n });
  if (unit === 'hours') return n === 1 ? t('cron.hourly', { mm: (at || '00:00').slice(3) }) : t('cron.everyHours', { n, mm: (at || '00:00').slice(3) });
  const time = at || '00:00';
  if (unit === 'days') return n === 1 ? t('cron.daily', { time }) : t('cron.everyDays', { n, time });
  if (unit === 'weeks') return t('cron.everyWeeks', { n, time });
  return t('cron.everyMonths', { n, time });
}

/** The minutes of one day a timer starts at: the series for seconds, minutes and hours, the time for days, none for weeks and months. */
export function intervalTimes(interval) {
  if (!isInterval(interval)) return [];
  const { every: n, unit, at } = interval;
  const [hh, mm] = (at || '00:00').split(':').map(Number);
  const out = [];
  if (unit === 'seconds') { for (let m = 0; m < MINUTES_OF_DAY; m++) out.push(m); return out; }
  if (unit === 'minutes') { for (let m = 0; m < MINUTES_OF_DAY; m += n) out.push(m); return out; }
  if (unit === 'hours') { for (let h = 0; h < 24; h += n) out.push(h * 60 + mm); return out; }
  if (unit === 'days') return [hh * 60 + mm];
  return [];
}
