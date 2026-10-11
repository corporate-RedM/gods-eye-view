// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { text } from './parse.js';
import { hit, terms } from './words.js';
import { isSocial } from './newsroom.js';
export { terms };
/** Whether a source shares at least one of the question's words: a headline about something else is no evidence. */
export function onTopic(item, words) {
    const hay = `${item.title} ${item.excerpt ?? ''} ${item.place ?? ''}`.toLowerCase();
    return words.some(w => hit(hay, w));
}
export function scoreNews(item, q) {
    const title = (item.title || '').toLowerCase();
    const body = `${item.summary || ''} ${item.description || ''}`.slice(0, 600).toLowerCase();
    const place = `${item.place?.label || ''} ${item.coords_anchor || ''}`.toLowerCase();
    let score = 0;
    for (const t of q) {
        if (hit(title, t))
            score += 3;
        else if (hit(body, t))
            score += 1;
        if (hit(place, t))
            score += 1;
    }
    return score;
}
/** A link worth showing: http(s) only. */
export function httpUrl(v) {
    return typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v.trim()) ? v.trim() : undefined;
}
function newsItem(n, id) {
    const lat = n.place?.lat ?? n.coords?.[0] ?? null;
    const lng = n.place?.lng ?? n.coords?.[1] ?? null;
    const ok = typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
    const title = text(n.title, 220, 'Untitled');
    // The summary, where it says more than the headline: what an actor can quote besides it.
    const summary = text(n.summary || n.description, 320, '');
    const url = httpUrl(n.link ?? n.url);
    return {
        id,
        kind: url && isSocial(url) ? 'social' : 'news',
        title,
        source: text(n.source_name || n.source, 60),
        published: typeof n.published === 'string' ? n.published : '',
        place: text(n.place?.label || n.place?.name || n.coords_anchor, 80),
        lat: ok ? lat : null,
        lng: ok ? lng : null,
        ...(url ? { url } : {}),
        ...(summary && !title.includes(summary.slice(0, 60)) ? { excerpt: summary } : {}),
    };
}
const QUAKE_WORDS = /quake|seismic|tsunami|volcan|eruption|fault|aftershock|magnitude/i;
export function selectContext(question, seed, limit, data, now = Date.now()) {
    const q = terms(question, seed.slice(0, 2000));
    const recent = data.news.filter(n => {
        const t = Date.parse(n.published || '');
        return !Number.isFinite(t) || now - t < 72 * 3_600_000;
    });
    const scored = recent
        .map(n => ({ n, s: scoreNews(n, q), t: Date.parse(n.published || '') || 0 }))
        .sort((a, b) => b.s - a.s || b.t - a.t);
    // Only the stories about the question: one about something else is no evidence for anything,
    // and the research brings the coverage of the question itself.
    const picked = scored.filter(x => x.s >= 3).slice(0, limit - 1).map(x => x.n);
    const items = picked.map((n, i) => newsItem(n, `c${i + 1}`));
    const quakeAsked = QUAKE_WORDS.test(question) || QUAKE_WORDS.test(seed.slice(0, 2000));
    const quakes = data.quakes
        .filter(e => (e.magnitude || 0) >= 5 && Number.isFinite(e.lat) && Number.isFinite(e.lng))
        // Only when the question is about quakes: one in a country the question names is not evidence about it.
        .filter(() => quakeAsked)
        .sort((a, b) => (b.magnitude || 0) - (a.magnitude || 0))
        .slice(0, 3);
    for (const e of quakes) {
        items.push({
            id: `c${items.length + 1}`,
            kind: 'quake',
            title: text(`M${(e.magnitude || 0).toFixed(1)} earthquake, ${e.place || 'unknown location'}`, 160),
            source: 'USGS',
            published: e.time ? new Date(e.time).toISOString() : '',
            place: text(e.place, 80),
            lat: e.lat,
            lng: e.lng,
        });
    }
    const board = marketLine(data.quotes);
    if (board) {
        items.push({ id: `c${items.length + 1}`, kind: 'market', title: board, source: 'OSIRIS Markets', published: new Date(now).toISOString(), place: '', lat: null, lng: null });
    }
    return items;
}
const BOARD = ['S&P 500', 'Nasdaq 100', 'VIX', 'US 10Y', 'Dollar Index', 'WTI Crude', 'Brent Crude', 'Natural Gas', 'Gold', 'Wheat', 'Bitcoin', 'EUR/USD', 'USD/CNY'];
/** One line of the main prices, the way a desk would read them out. */
export function marketLine(quotes) {
    const by = new Map(quotes.map(q => [q.name, q]));
    const parts = BOARD.flatMap(name => {
        const q = by.get(name);
        if (!q || !Number.isFinite(q.price))
            return [];
        const d = q.price < 10 ? 4 : 2;
        const move = Number.isFinite(q.change_percent) ? ` ${q.change_percent >= 0 ? '+' : ''}${q.change_percent.toFixed(2)}%` : '';
        return [`${name} ${q.price.toLocaleString('en-US', { maximumFractionDigits: d })}${move}`];
    });
    return parts.length ? `Markets now: ${parts.join(' · ')}` : '';
}
const within = (p, ms, fallback) => Promise.race([p.catch(() => fallback), new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);
/** The default sources: the app's own routes, loaded on first use so tests never pull them in. */
export const liveSources = {
    async news() {
        const { GET } = await import('../../app/api/news/route.js');
        const body = await (await GET()).json();
        return Array.isArray(body?.news) ? body.news : [];
    },
    async quakes() {
        const { GET } = await import('../../app/api/earthquakes/route.js');
        const body = await (await GET()).json();
        return Array.isArray(body?.earthquakes) ? body.earthquakes : [];
    },
    async quotes() {
        const { getQuotes } = await import('../../app/api/markets/route.js');
        return getQuotes();
    },
};
/** Live context for a question. Each source has a few seconds; one that is slow or down costs only its own items. */
export async function gatherContext(question, seed, limit, sources = liveSources) {
    const [news, quakes, quotes] = await Promise.all([
        within(sources.news(), 15_000, []),
        within(sources.quakes(), 8_000, []),
        within(sources.quotes(), 8_000, []),
    ]);
    return selectContext(question, seed, limit, { news, quakes, quotes });
}
/**
 * A world brief for an outside caller (the MCP tool): the stories on a topic,
 * or the biggest of the moment when there is none, with the day's large
 * earthquakes and the market line.
 */
export async function briefing(topic, limit, sources = liveSources) {
    const [news, quakes, quotes] = await Promise.all([
        within(sources.news(), 15_000, []),
        within(sources.quakes(), 8_000, []),
        within(sources.quotes(), 8_000, []),
    ]);
    if (topic.trim())
        return selectContext(topic, '', limit, { news, quakes, quotes });
    const now = Date.now();
    const top = news
        .filter(n => { const t = Date.parse(n.published || ''); return !Number.isFinite(t) || now - t < 24 * 3_600_000; })
        .sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0) || Date.parse(b.published || '') - Date.parse(a.published || ''))
        .slice(0, Math.max(1, limit - 1));
    const items = top.map((n, i) => newsItem(n, `c${i + 1}`));
    for (const e of quakes.filter(q => (q.magnitude || 0) >= 6).slice(0, 3)) {
        items.push({
            id: `c${items.length + 1}`, kind: 'quake', title: text(`M${(e.magnitude || 0).toFixed(1)} earthquake, ${e.place || 'unknown location'}`, 160),
            source: 'USGS', published: e.time ? new Date(e.time).toISOString() : '', place: text(e.place, 80), lat: e.lat ?? null, lng: e.lng ?? null,
        });
    }
    const board = marketLine(quotes);
    if (board)
        items.push({ id: `c${items.length + 1}`, kind: 'market', title: board, source: 'OSIRIS Markets', published: new Date(now).toISOString(), place: '', lat: null, lng: null });
    return items;
}
