// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { stealthFetch } from '../../../lib/stealthFetch.js';
import { cachedSource } from '../../../lib/sourceCache.js';
import { buildQuery, parseWkt } from './ibi511.js';
/**
 * OSIRIS — Nevada CCTV Cameras (NDOT / nvroads.com)
 * Source: https://www.nvroads.com — the same IBI 511 stack Utah runs on
 * Data endpoint: /List/GetData/Cameras (DataTables, 100 rows/page)
 * ~600 statewide traffic cameras — NO API KEY NEEDED.
 *
 * Unlike Indiana, nothing here has to be reconstructed: each row carries its
 * own `videoUrl`, already a full HLS playlist address on whichever of NDOT's
 * eight `*.its.nv.gov` edges serves that camera. 587 of the 600 have one, and
 * those streams answer with `Access-Control-Allow-Origin: *`, so they play in
 * a tile as they are. The remaining handful are snapshot-only and fall back to
 * the JPEG at /map/Cctv/{imageId}.
 */
const BASE = 'https://www.nvroads.com';
const PAGE_SIZE = 100; // the server caps a response at 100 rows whatever we ask for
const MAX_PAGES = 20; // safety bound (~2000 cameras) so a bad total can't fan out forever
/** Nevada bounding box — drops any mis-geocoded rows. */
const NV_BOUNDS = { minLat: 34.9, maxLat: 42.1, minLng: -120.1, maxLng: -113.9 };
/** Map a raw record to a CctvCamera, or null if it should be skipped. */
export function mapRecord(rec) {
    if (!rec || typeof rec.id !== 'number')
        return null;
    const img = rec.images?.[0];
    if (!img || img.blocked || img.disabled)
        return null;
    const coords = parseWkt(rec.latLng?.geography?.wellKnownText);
    if (!coords)
        return null;
    const { lat, lng } = coords;
    if (lat < NV_BOUNDS.minLat || lat > NV_BOUNDS.maxLat)
        return null;
    if (lng < NV_BOUNDS.minLng || lng > NV_BOUNDS.maxLng)
        return null;
    /* `location` is "N/A" on a good third of these, and `roadway` repeats the
       camera description, so the picture's own caption is the best label. */
    const name = img.description?.trim() || rec.location?.trim() || rec.roadway?.trim();
    const snapshot = img.imageUrl ? `${BASE}${img.imageUrl}` : undefined;
    const video = img.videoDisabled ? undefined : img.videoUrl?.trim() || undefined;
    if (!snapshot && !video)
        return null;
    return {
        id: `ndot-${rec.id}`,
        lat,
        lng,
        name: name && name !== 'N/A' ? name : `NDOT Camera ${rec.id}`,
        city: 'Nevada',
        country: 'US',
        ...(snapshot ? { feed_url: snapshot } : {}),
        ...(video ? { stream_url: video, stream_type: 'hls' } : {}),
        source: 'NDOT',
    };
}
async function fetchPage(start) {
    const url = `${BASE}/List/GetData/Cameras?query=${buildQuery(start, PAGE_SIZE)}&lang=en-US`;
    const res = await stealthFetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    });
    if (!res.ok)
        return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
}
async function loadNevadaCameras() {
    // The first page also tells us how many there are in total.
    const first = await fetchPageWithTotal(0);
    const seen = new Map();
    const ingest = (rows) => {
        for (const rec of rows) {
            const cam = mapRecord(rec);
            if (cam)
                seen.set(rec.id, cam);
        }
    };
    ingest(first.rows);
    const starts = [];
    for (let s = PAGE_SIZE; s < first.total && s < PAGE_SIZE * MAX_PAGES; s += PAGE_SIZE) {
        starts.push(s);
    }
    const results = await Promise.allSettled(starts.map(fetchPage));
    for (const r of results) {
        if (r.status === 'fulfilled')
            ingest(r.value);
    }
    const cams = [...seen.values()];
    console.log(`[OSIRIS] Nevada cameras — NDOT: ${cams.length}`);
    return cams;
}
async function fetchPageWithTotal(start) {
    const url = `${BASE}/List/GetData/Cameras?query=${buildQuery(start, PAGE_SIZE)}&lang=en-US`;
    const res = await stealthFetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    });
    if (!res.ok)
        throw new Error(`NDOT HTTP ${res.status}`);
    const data = await res.json();
    return {
        rows: Array.isArray(data?.data) ? data.data : [],
        total: Number(data?.recordsTotal) || 0,
    };
}
export const fetchNevadaCameras = cachedSource('nevada', loadNevadaCameras);
