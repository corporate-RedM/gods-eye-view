// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { stealthFetch } from '../../../lib/stealthFetch.js';
/**
 * OSIRIS — Netherlands CCTV Cameras (Rijkswaterstaat)
 * Source: https://api.rwsverkeersinfo.nl/api/cameras
 * 26 operator-controlled HD motorway cameras — NO API KEY NEEDED.
 *
 * Replaces opendata.ndw.nu/cameras.json. NDW retired that dataset and it has
 * been answering 404 into a silent catch ever since, so the layer carried no
 * Dutch cameras at all rather than reporting a dead source.
 */
const CAMERAS_JSON = 'https://api.rwsverkeersinfo.nl/api/cameras';
/** Netherlands bounding box — RWS publishes mainland motorways only. */
const NL_BOUNDS = { minLat: 50.7, maxLat: 53.7, minLng: 3.3, maxLng: 7.3 };
/**
 * The frames are hotlink-protected: asked without a Referer, stream.inmoves.nl
 * answers 401 with a zero-length PNG, so the browser cannot load `static_url`
 * itself. The proxy sends `Referer: https://<host>/`, which the origin accepts,
 * and returns the real JPEG.
 */
function proxied(url) {
    return `/api/eye/cctv/proxy?url=${encodeURIComponent(url)}`;
}
/** Parse the RWS camera feed. Exported for tests. */
export function parseRwsCameras(payload) {
    if (!Array.isArray(payload))
        return [];
    const cams = [];
    const seen = new Set();
    for (const cam of payload) {
        const id = String(cam?.id ?? '');
        const lat = parseFloat(cam?.latitude ?? '');
        const lng = parseFloat(cam?.longitude ?? '');
        if (!id || seen.has(id))
            continue;
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
            continue;
        if (lat < NL_BOUNDS.minLat || lat > NL_BOUNDS.maxLat)
            continue;
        if (lng < NL_BOUNDS.minLng || lng > NL_BOUNDS.maxLng)
            continue;
        // Without a frame or a page to open, a pin has nothing to show.
        if (!cam.static_url && !cam.stream_url)
            continue;
        seen.add(id);
        const near = cam.near?.trim() || '';
        const road = cam.road?.trim() || '';
        cams.push({
            id: `nl-rws-${id}`,
            lat,
            lng,
            name: [road, near].filter(Boolean).join(' — ') || cam.location_description?.trim() || `RWS Camera ${id}`,
            city: near || 'Netherlands',
            country: 'Netherlands',
            ...(cam.static_url ? { feed_url: proxied(cam.static_url) } : {}),
            ...(cam.stream_url ? { external_url: cam.stream_url } : {}),
            source: 'Rijkswaterstaat',
        });
    }
    return cams;
}
export async function fetchNetherlandsCameras() {
    const res = await stealthFetch(CAMERAS_JSON, {
        signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json' },
    });
    if (!res.ok)
        throw new Error(`RWS HTTP ${res.status}`);
    const cams = parseRwsCameras(await res.json());
    console.log(`[OSIRIS] Netherlands cameras — Rijkswaterstaat: ${cams.length}`);
    return cams;
}
