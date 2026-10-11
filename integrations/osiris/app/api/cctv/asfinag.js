// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
const ASFINAG_WEBCAMS_URL = 'https://odo.asfinag.at/odo/rest/sec/resource/001/json/webcams?language=atDE';
const ASFINAG_CACHE_TTL_MS = 60 * 60 * 1000;
const ASFINAG_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
    'Accept': 'application/json',
    'Accept-Language': 'en,en-US;q=0.9,de;q=0.8',
    'Referer': 'https://www.asfinag.at/',
    'Content-Type': 'application/json; charset=utf-8',
    'Authorization': 'Basic bWFwX3dpZGdldDp0ZWdkaXc=',
    'Origin': 'https://www.asfinag.at',
};
let cachedCameras = null;
let cacheExpiresAt = 0;
let pendingFetch = null;
function toAsfinagCamera(cam) {
    if (!cam.wcs_id || !cam.wgs84_lat || !cam.wgs84_lon || !cam.url_campic) {
        return null;
    }
    // Skip Hungarian road authority (Utinform) cameras — feeds are unavailable
    if (cam.wcs_id.startsWith('Utinform')) {
        return null;
    }
    return {
        id: `asfinag-${cam.wcs_id}`,
        lat: cam.wgs84_lat,
        lng: cam.wgs84_lon,
        name: cam.position_txt || cam.direction_txt || 'ASFINAG Webcam',
        city: 'Austria',
        country: 'Austria',
        feed_url: cam.url_campic,
        source: 'ASFINAG',
    };
}
import { stealthFetch } from '../../../lib/stealthFetch.js';
async function fetchFreshAsfinagCameras() {
    try {
        // 1. Fetch the manifest list for all active webcams
        const res = await stealthFetch(ASFINAG_WEBCAMS_URL, {
            signal: AbortSignal.timeout(12000),
            headers: ASFINAG_HEADERS,
        });
        if (!res.ok)
            return [];
        const data = await res.json();
        if (!Array.isArray(data))
            return [];
        return data
            .map(toAsfinagCamera)
            .filter((cam) => cam !== null);
    }
    catch {
        return [];
    }
}
export async function fetchAsfinagCameras() {
    const now = Date.now();
    if (cachedCameras && now < cacheExpiresAt) {
        return cachedCameras;
    }
    if (!pendingFetch) {
        pendingFetch = fetchFreshAsfinagCameras()
            .then((cameras) => {
            if (cameras.length > 0) {
                cachedCameras = cameras;
                cacheExpiresAt = Date.now() + ASFINAG_CACHE_TTL_MS;
            }
            return cachedCameras ?? cameras;
        })
            .finally(() => {
            pendingFetch = null;
        });
    }
    return pendingFetch;
}
