// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const parse = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN);
/** "3 Oct" */
export function dayLabel(date) {
    const t = parse(date.slice(0, 10));
    if (!Number.isFinite(t))
        return date;
    const d = new Date(t);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
/** "3 Oct – 2 Nov 2026", or "3 Dec 2026 – 1 Jan 2027" across a new year. */
export function rangeLabel(start, end) {
    const a = new Date(parse(start));
    const b = new Date(parse(end));
    if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()))
        return `${start} – ${end}`;
    const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    return `${dayLabel(start)}${sameYear ? '' : ` ${a.getUTCFullYear()}`} – ${dayLabel(end)} ${b.getUTCFullYear()}`;
}
/**
 * The periods from today to the horizon: as many as asked, of equal length,
 * at least a week each. A horizon that is missing, unreadable or under a
 * fortnight away gives way to six months.
 */
export function simulationClock(today, horizon, count) {
    const start = parse(today);
    if (!Number.isFinite(start))
        return [];
    let end = parse(horizon);
    if (!Number.isFinite(end) || end - start < 14 * DAY)
        end = start + 182 * DAY;
    // Beyond five years a period says too little about when anything happens.
    end = Math.min(end, start + 5 * 365 * DAY);
    const n = Math.max(1, Math.min(count, Math.floor((end - start) / (7 * DAY)) || 1));
    const span = (end - start) / n;
    return Array.from({ length: n }, (_, i) => {
        const from = iso(start + Math.round((i * span) / DAY) * DAY);
        const to = iso(start + (Math.round(((i + 1) * span) / DAY) - (i === n - 1 ? 0 : 1)) * DAY);
        return { index: i + 1, label: rangeLabel(from, to), start: from, end: to };
    });
}
/** A date the model gave, kept inside its period; the period's middle when it gave none. */
export function dateIn(v, p) {
    const t = parse(typeof v === 'string' ? v.slice(0, 10) : '');
    const lo = parse(p.start);
    const hi = parse(p.end);
    if (Number.isFinite(t))
        return iso(Math.min(hi, Math.max(lo, t)));
    return iso(lo + Math.round((hi - lo) / 2 / DAY) * DAY);
}
