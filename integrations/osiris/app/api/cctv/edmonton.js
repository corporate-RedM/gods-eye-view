// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { stealthFetch } from '../../../lib/stealthFetch.js';
import { cachedSource } from '../../../lib/sourceCache.js';
/**
 * OSIRIS — Edmonton traffic cameras (City of Edmonton Traffic Management Centre)
 * Source: https://edmontontrafficcam.com — the city's public camera site.
 * ~57 live HLS streams — NO API KEY NEEDED.
 *
 * The site's own map calls GetCameras, an ASP.NET page method, so it is a POST
 * with a JSON body and the rows come back wrapped in `d`. Each row carries a
 * stream host, a "forge" (the path prefix its stream lives under) and a stream
 * code, which assemble into the playlist:
 *
 *   https://{MMSUrl}/{Forge}/public/hls/{StreamCode}.m3u8
 *
 * The codes rotate — a copy of the list taken in April 2026 had 55 of its 58
 * streams answering 404 by September — so they are read live on every refresh
 * rather than baked in. The stream host echoes the request's Origin in
 * Access-Control-Allow-Origin, so the browser plays them without the proxy.
 */
const API_URL = 'https://edmontontrafficcam.com/Default.aspx/GetCameras';
const SITE_URL = 'https://edmontontrafficcam.com/';
/** The city's streams are all served from here; anything else is not theirs. */
const STREAM_HOST = 'winkcdn.com';
/** Edmonton and its ring road, padded — anything outside is a bad coordinate. */
const YEG_BOUNDS = { minLat: 53.3, maxLat: 53.8, minLng: -114.0, maxLng: -113.2 };
/** Map the GetCameras payload to cameras. Exported for tests. */
export function parseEdmonton(payload) {
    const rows = payload?.d;
    if (!Array.isArray(rows))
        return [];
    const cams = [];
    const seen = new Set();
    for (const row of rows) {
        // The site's own "Online" flag — a camera the city has taken down stays off the map.
        if (String(row?.Status) !== '1')
            continue;
        const code = row.Code != null ? String(row.Code) : '';
        if (!code || seen.has(code))
            continue;
        const host = (row.MMSUrl ?? '').trim().toLowerCase();
        const stream = (row.StreamCode ?? '').trim();
        if (host !== STREAM_HOST && !host.endsWith('.' + STREAM_HOST))
            continue;
        if (!Number.isInteger(row.Forge) || !/^[\w-]+$/.test(stream))
            continue;
        const lat = parseFloat(row.Latitude ?? '');
        const lng = parseFloat(row.Longitude ?? '');
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
            continue;
        if (lat < YEG_BOUNDS.minLat || lat > YEG_BOUNDS.maxLat)
            continue;
        if (lng < YEG_BOUNDS.minLng || lng > YEG_BOUNDS.maxLng)
            continue;
        seen.add(code);
        const roads = [row.PrimaryRoad, row.SecondaryRoad].map(r => (r ?? '').trim()).filter(Boolean);
        cams.push({
            id: `yeg-${code}`,
            lat,
            lng,
            name: roads.join(' & ') || `Edmonton Camera ${code}`,
            city: 'Edmonton',
            country: 'Canada',
            stream_url: `https://${host}/${row.Forge}/public/hls/${stream}.m3u8`,
            stream_type: 'hls',
            external_url: SITE_URL,
            source: 'City of Edmonton',
        });
    }
    return cams;
}
async function loadEdmontonCameras() {
    const res = await stealthFetch(API_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
        body: '{}',
    });
    if (!res.ok)
        throw new Error(`Edmonton GetCameras HTTP ${res.status}`);
    const cams = parseEdmonton(await res.json());
    console.log(`[OSIRIS] Edmonton cameras — City of Edmonton: ${cams.length}`);
    return cams;
}
export const fetchEdmontonCameras = cachedSource('edmonton', loadEdmontonCameras);
