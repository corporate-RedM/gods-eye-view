// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
const DAY = 86_400_000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
/** Daily log returns, read from the adjusted closes where there are any. */
export function logReturns(s) {
    const px = s.adjusted?.length === s.closes.length ? s.adjusted : s.closes;
    const out = [];
    for (let i = 1; i < px.length; i++) {
        const r = Math.log(px[i] / px[i - 1]);
        if (Number.isFinite(r))
            out.push(r);
    }
    return out;
}
/** The returns with their average taken out: the shape of the moves, without assuming the trend goes on. */
export function demean(returns) {
    if (!returns.length)
        return [];
    const mean = returns.reduce((t, r) => t + r, 0) / returns.length;
    return returns.map(r => r - mean);
}
const std = (xs) => {
    if (xs.length < 2)
        return 0;
    const m = xs.reduce((t, x) => t + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1));
};
/** Where the price is and how it has moved. Null for a history too short to say (under 30 days). */
export function seriesStats(s) {
    const n = s.closes.length;
    if (n < 30 || s.dates.length !== n)
        return null;
    const asOf = s.dates[n - 1];
    const price = s.closes[n - 1];
    const span = Math.max(1, daysBetween(s.dates[0], asOf));
    const perYear = Math.round(((n - 1) / span) * 365);
    const yearAgo = Date.parse(asOf) - 365 * DAY;
    let high = -Infinity, low = Infinity, highOn = asOf, lowOn = asOf;
    for (let i = 0; i < n; i++) {
        if (Date.parse(s.dates[i]) < yearAgo)
            continue;
        if (s.closes[i] > high) {
            high = s.closes[i];
            highOn = s.dates[i];
        }
        if (s.closes[i] < low) {
            low = s.closes[i];
            lowOn = s.dates[i];
        }
    }
    const back = (days) => {
        const t = Date.parse(asOf) - days * DAY;
        if (Date.parse(s.dates[0]) > t + 3 * DAY)
            return null;
        // The last close on or before the day.
        let i = n - 1;
        while (i > 0 && Date.parse(s.dates[i]) > t)
            i--;
        return price / s.closes[i] - 1;
    };
    return {
        price, asOf, high, highOn, low, lowOn,
        change30: back(30), change90: back(90), change365: back(365),
        vol: std(logReturns(s)) * Math.sqrt(perYear),
        perYear,
    };
}
/** A small, fast, seeded generator (mulberry32): the same seed, the same draws. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** A seed from text, so an instrument always resamples the same way. */
export function seedOf(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++)
        h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}
/** Trading days in a stretch of calendar days, for an instrument that trades `perYear` days a year. */
export const tradingDays = (calendarDays, perYear) => Math.max(1, Math.round((Math.max(0, calendarDays) * perYear) / 365));
/** `count` paths of `steps` days, each day one of the history's own moves drawn at random. */
export function resample(returns, steps, count, seed) {
    const final = new Float64Array(count), max = new Float64Array(count), min = new Float64Array(count);
    const draw = rng(seed);
    const n = returns.length;
    for (let p = 0; p < count; p++) {
        let x = 0, hi = 0, lo = 0;
        for (let d = 0; d < steps && n; d++) {
            x += returns[Math.floor(draw() * n)];
            if (x > hi)
                hi = x;
            if (x < lo)
                lo = x;
        }
        final[p] = Math.exp(x);
        max[p] = Math.exp(hi);
        min[p] = Math.exp(lo);
    }
    return { final, max, min };
}
const quantile = (sorted, q) => {
    if (!sorted.length)
        return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
/** Whether a path that started at `price` met the measure's level: touched it, or ended beyond it. */
function met(m, price, p, i) {
    const level = m.threshold;
    if (m.direction === 'below')
        return price * (m.touch ? p.min[i] : p.final[i]) <= level;
    return price * (m.touch ? p.max[i] : p.final[i]) >= level;
}
/** The chance a price at `price` meets the measure's level within `steps` trading days, by resampling. */
export function chanceOf(m, price, returns, steps, seed, count = 2000) {
    if (m.threshold === undefined)
        return NaN;
    const already = m.direction === 'below' ? price <= m.threshold : price >= m.threshold;
    if (already && m.touch)
        return 1;
    const p = resample(returns, steps, count, seed);
    let hits = 0;
    for (let i = 0; i < count; i++)
        if (met(m, price, p, i))
            hits++;
    return hits / count;
}
const PATHS = 4000;
/** Levels to draw a touch curve at: a geometric grid from a quarter of the price to four times it, and any levels asked for. */
export function curveLevels(price, extra = [], points = 49) {
    const grid = Array.from({ length: points }, (_, i) => (price * Math.pow(16, i / (points - 1))) / 4);
    return [...new Set([...grid, ...extra.filter(l => l > 0 && Number.isFinite(l))].map(l => +l.toPrecision(6)))].sort((a, b) => a - b);
}
/**
 * The touch curve of paths that started at `price` (`max` and `min` are each
 * path's highest and lowest point, as multiples of it): above the price, the
 * share of paths that rose to the level; below it, the share that fell to it.
 */
export function touchCurve(price, max, min, levels) {
    const n = max.length;
    return levels.map(level => {
        let hits = 0;
        if (level >= price) {
            for (let i = 0; i < n; i++)
                if (price * max[i] >= level)
                    hits++;
        }
        else {
            for (let i = 0; i < n; i++)
                if (price * min[i] <= level)
                    hits++;
        }
        return { level, probability: n ? hits / n : NaN };
    });
}
const money = (n, currency) => {
    const d = n >= 1000 ? 0 : n >= 1 ? 2 : 4;
    return `${currency === 'USD' ? '$' : ''}${n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: n >= 1000 ? 0 : Math.min(d, 2) })}${currency && currency !== 'USD' ? ` ${currency}` : ''}`;
};
/**
 * The statistical baseline for a question about a price: from today to the
 * horizon, how often the resampled paths meet the measure's level (a yes/no
 * question about a level), and where the price ends (its 10th, 50th and 90th
 * percentile). Null when the history is too short or the horizon has passed.
 */
export function baseline(s, m, today, horizon, levels = []) {
    const stats = seriesStats(s);
    const days = daysBetween(today, horizon);
    if (!stats || !(days > 0))
        return null;
    const returns = demean(logReturns(s));
    const steps = tradingDays(days, stats.perYear);
    const p = resample(returns, steps, PATHS, seedOf(`${s.symbol}:${horizon}`));
    const ends = Float64Array.from(p.final).sort();
    let probability;
    if (m.threshold !== undefined) {
        let hits = 0;
        for (let i = 0; i < PATHS; i++)
            if (met(m, stats.price, p, i))
                hits++;
        probability = hits / PATHS;
    }
    const years = Math.max(1, Math.round(daysBetween(s.dates[0], stats.asOf) / 365));
    const level = m.threshold !== undefined
        ? ` ${m.touch ? (m.direction === 'below' ? 'fall to' : 'reach') : (m.direction === 'below' ? 'end below' : 'end above')} ${money(m.threshold, s.currency)}`
        : '';
    return {
        symbol: s.symbol,
        name: s.name,
        currency: s.currency,
        price: stats.price,
        asOf: stats.asOf,
        vol: stats.vol,
        days,
        ...(probability !== undefined ? { probability } : {}),
        p10: stats.price * quantile(ends, 0.1),
        p50: stats.price * quantile(ends, 0.5),
        p90: stats.price * quantile(ends, 0.9),
        curve: touchCurve(stats.price, p.max, p.min, curveLevels(stats.price, [...levels, ...(m.threshold !== undefined ? [m.threshold] : [])])),
        method: `${PATHS.toLocaleString('en-US')} paths to ${horizon}, each day one of ${s.symbol}'s own daily moves from the past ${years === 1 ? 'year' : `${years} years`} drawn at random (volatility ${Math.round(stats.vol * 100)}% a year, average trend removed)${probability !== undefined ? `: ${Math.round(probability * 1000) / 10}% of them${level}` : ''}.`,
    };
}
/**
 * A price course for each world, period by period, before any event pushes
 * it: drawn from many resampled paths and spread evenly across them by where
 * they end, so a handful of worlds still spans what can happen. The first
 * world, which follows the likeliest course, takes the middle of the range;
 * the others alternate below and above it.
 */
export function worldCourses(returns, stepsPerPeriod, worlds, seed, pool = 300) {
    const draw = rng(seed);
    const n = returns.length;
    const candidates = [];
    for (let c = 0; c < pool; c++) {
        let x = 0;
        const course = [];
        for (const steps of stepsPerPeriod) {
            let hi = x, lo = x;
            for (let d = 0; d < steps && n; d++) {
                x += returns[Math.floor(draw() * n)];
                if (x > hi)
                    hi = x;
                if (x < lo)
                    lo = x;
            }
            course.push({ close: Math.exp(x), high: Math.exp(hi), low: Math.exp(lo) });
        }
        candidates.push(course);
    }
    const last = (c) => c[c.length - 1]?.close ?? 1;
    candidates.sort((a, b) => last(a) - last(b));
    // Evenly spaced through the range, then dealt out from the middle: nearest the median first, the lower of a tie first.
    const qs = Array.from({ length: worlds }, (_, w) => (w + 0.5) / worlds)
        .sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5) || a - b);
    return qs.map(q => candidates[Math.min(pool - 1, Math.floor(q * pool))]);
}
/**
 * The cone of what the market's own moves allow, date by date: from today's
 * price through each of `dates`, the middle and the 80% band of the
 * resampled paths. The worlds' courses are drawn inside it.
 */
export function fanOf(s, today, dates, count = 2000) {
    const stats = seriesStats(s);
    if (!stats || !dates.length)
        return [];
    const returns = demean(logReturns(s));
    const marks = dates.map(d => tradingDays(daysBetween(today, d), stats.perYear));
    const last = Math.max(...marks);
    const at = dates.map(() => []);
    const draw = rng(seedOf(`${s.symbol}:fan`));
    const n = returns.length;
    for (let p = 0; p < count; p++) {
        let x = 0, k = 0;
        for (let d = 1; d <= last && n; d++) {
            x += returns[Math.floor(draw() * n)];
            while (k < marks.length && marks[k] === d)
                at[k++].push(Math.exp(x));
        }
        while (k < marks.length)
            at[k++].push(Math.exp(x));
    }
    return dates.map((date, i) => {
        const xs = at[i].sort((a, b) => a - b);
        return { date, p10: stats.price * quantile(xs, 0.1), p50: stats.price * quantile(xs, 0.5), p90: stats.price * quantile(xs, 0.9) };
    });
}
/**
 * The simulation, priced: each world's events, as the push they gave the
 * price period by period (`pushes[world][period]`, a multiple applied as the
 * period opens), run through thousands of the market's own paths. A handful
 * of worlds is too few to count outcomes in; this keeps what each world's
 * story did to the price and lets the market's randomness average out, so
 * the worlds pooled read as a probability, not as a tally of three coin
 * tosses.
 */
export function pricedWorlds(m, price, returns, steps, pushes, seed, perWorld = 2000, levels = []) {
    const draw = rng(seed);
    const n = returns.length;
    const finals = [];
    const highs = [];
    const lows = [];
    let hits = 0;
    const above = m.direction !== 'below';
    const at = (level) => (above ? level >= m.threshold : level <= m.threshold);
    for (const push of pushes.length ? pushes : [[]]) {
        for (let p = 0; p < perWorld; p++) {
            // The path's level as a multiple of the price, its highest and lowest, a world's pushes applied as each period opens.
            let x = 0, lift = 1, hi = 1, lo = 1;
            for (let i = 0; i < steps.length; i++) {
                lift *= push[i] ?? 1;
                let v = Math.exp(x) * lift;
                if (v > hi)
                    hi = v;
                if (v < lo)
                    lo = v;
                for (let d = 0; d < steps[i] && n; d++) {
                    x += returns[Math.floor(draw() * n)];
                    v = Math.exp(x) * lift;
                    if (v > hi)
                        hi = v;
                    if (v < lo)
                        lo = v;
                }
            }
            const end = price * Math.exp(x) * lift;
            finals.push(end);
            highs.push(hi);
            lows.push(lo);
            if (m.threshold !== undefined && (m.touch ? at(price * (above ? hi : lo)) : at(end)))
                hits++;
        }
    }
    const curve = levels.length ? touchCurve(price, highs, lows, levels) : undefined;
    finals.sort((a, b) => a - b);
    return {
        ...(m.threshold !== undefined ? { probability: hits / finals.length } : {}),
        p10: quantile(finals, 0.1), p50: quantile(finals, 0.5), p90: quantile(finals, 0.9),
        ...(curve ? { curve } : {}),
    };
}
/** The last `days` calendar days of a history: the recent past the baseline is read from. */
export function recent(s, days = 730) {
    const n = s.dates.length;
    if (!n)
        return s;
    const from = Date.parse(s.dates[n - 1]) - days * DAY;
    const i = s.dates.findIndex(d => Date.parse(d) >= from);
    if (i <= 0)
        return s;
    return { ...s, dates: s.dates.slice(i), closes: s.closes.slice(i), ...(s.adjusted ? { adjusted: s.adjusted.slice(i) } : {}) };
}
const BINS = [[0, 0.02], [0.02, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.7], [0.7, 1.0001]];
/**
 * The baseline, scored on the instrument's own past. On days spread through
 * the history, it forecasts from the year of prices before that day only (no
 * look-ahead) whether the price would trade at each of a set of levels (10%
 * to 100% above it, 10% to 50% below it) within `days`; then the record says
 * whether it did. The windows overlap, so the forecasts are not independent:
 * a sample of how the method behaves on this instrument, not a proof.
 * Null when the history is too short to test on.
 */
export function backtest(s, days, opts = {}) {
    const stats = seriesStats(s);
    if (!stats || !(days > 0))
        return null;
    const px = s.adjusted?.length === s.closes.length ? s.adjusted : s.closes;
    const r = [];
    for (let i = 1; i < px.length; i++)
        r.push(Math.log(px[i] / px[i - 1]));
    const look = stats.perYear;
    const ahead = tradingDays(days, stats.perYear);
    const every = opts.every ?? Math.max(1, Math.round(ahead / 12));
    const paths = opts.paths ?? 300;
    const ratios = opts.ratios ?? [1.1, 1.2, 1.35, 1.5, 1.75, 2, 0.9, 0.8, 0.7, 0.6, 0.5];
    const draw = rng(seedOf(`${s.symbol}:backtest`));
    const said = ratios.map(() => []);
    const happened = ratios.map(() => []);
    let starts = 0, first = -1, last = -1;
    for (let t = look; t + ahead < px.length; t += every) {
        // What was known on day t: the year of moves before it, demeaned.
        const window = demean(r.slice(t - look, t));
        const hi = new Float64Array(paths), lo = new Float64Array(paths);
        for (let p = 0; p < paths; p++) {
            let x = 0, h = 0, l = 0;
            for (let d = 0; d < ahead; d++) {
                x += window[Math.floor(draw() * window.length)];
                if (x > h)
                    h = x;
                if (x < l)
                    l = x;
            }
            hi[p] = Math.exp(h);
            lo[p] = Math.exp(l);
        }
        // What then happened.
        let top = 1, bottom = 1;
        for (let d = 1; d <= ahead; d++) {
            const m = px[t + d] / px[t];
            if (m > top)
                top = m;
            if (m < bottom)
                bottom = m;
        }
        ratios.forEach((k, j) => {
            let hits = 0;
            for (let p = 0; p < paths; p++)
                if (k >= 1 ? hi[p] >= k : lo[p] <= k)
                    hits++;
            said[j].push(hits / paths);
            happened[j].push((k >= 1 ? top >= k : bottom <= k) ? 1 : 0);
        });
        starts++;
        if (first < 0)
            first = t;
        last = t;
    }
    if (starts < 10)
        return null;
    let brier = 0, reference = 0, n = 0;
    const bins = BINS.map(([lo, hi]) => ({ lo, hi: Math.min(1, hi), saidSum: 0, hitSum: 0, n: 0 }));
    ratios.forEach((_, j) => {
        const rate = happened[j].reduce((t, o) => t + o, 0) / happened[j].length;
        said[j].forEach((p, i) => {
            const o = happened[j][i];
            brier += (p - o) ** 2;
            reference += (rate - o) ** 2;
            n++;
            const b = bins.find(x => p >= x.lo && p < x.hi + (x.hi >= 1 ? 1e-9 : 0)) ?? bins[bins.length - 1];
            b.saidSum += p;
            b.hitSum += o;
            b.n++;
        });
    });
    brier /= n;
    reference /= n;
    return {
        n, starts, from: s.dates[first], to: s.dates[last], days,
        brier, reference, skill: reference > 0 ? 1 - brier / reference : 0,
        gap: bins.reduce((t, b) => t + (b.n ? Math.abs(b.saidSum - b.hitSum) : 0), 0) / n,
        bins: bins.filter(b => b.n > 0).map(b => ({ lo: b.lo, hi: b.hi, said: b.saidSum / b.n, happened: b.hitSum / b.n, n: b.n })),
    };
}
const pctOf = (p) => `${p < 0.1 ? Math.round(p * 1000) / 10 : Math.round(p * 100)}%`;
/**
 * The record in words: how far off it ran on average, and what happened
 * when it said about what it says now (`p`, the baseline's own figure).
 */
export function recordSentence(b, symbol, p) {
    const band = p === undefined ? undefined : b.bins.find(x => p >= x.lo && p <= x.hi);
    const years = `${b.from.slice(0, 4)}–${b.to.slice(0, 4)}`;
    return [
        `Tested on ${b.n.toLocaleString('en-US')} past forecasts of ${symbol} (made on ${b.starts} days, ${years}, each from the year of prices before it, ${b.days} days ahead): what it said was ${Math.round(b.gap * 1000) / 10} points from what happened, on average.`,
        band ? ` When it said ${Math.round(band.lo * 100)}–${Math.round(band.hi * 100)}%, as it does now, it happened ${pctOf(band.happened)} of the time (${band.n} forecasts).` : '',
        ` Brier ${b.brier.toFixed(3)}, against ${b.reference.toFixed(3)} for hindsight (how often each move really happened over the whole period, which no one knew in advance).`,
    ].join('');
}
/** A price as the prompts and the panel say it: "$119.57", "4,512", "1.0842 EUR". */
export const priceText = money;
