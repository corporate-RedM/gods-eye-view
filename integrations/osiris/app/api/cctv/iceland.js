// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { stealthFetch } from '../../../lib/stealthFetch.js';
export async function fetchIcelandCameras() {
    try {
        const res = await stealthFetch('https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1', { signal: AbortSignal.timeout(12000) });
        if (!res.ok)
            return [];
        const data = await res.json();
        const cameras = [];
        for (const cam of data) {
            // Validate coordinates and image URL
            if (!cam.Breidd || !cam.Lengd || !cam.Slod)
                continue;
            // Ensure image URL is absolute
            let feedUrl = cam.Slod;
            if (feedUrl.startsWith('/')) {
                feedUrl = `https://www.vegagerdin.is${feedUrl}`;
            }
            cameras.push({
                id: `is-${cam.Maelist_nr}-${cameras.length}`,
                lat: cam.Breidd,
                lng: cam.Lengd,
                name: `${cam.Myndavel} — ${cam.Skyring}`,
                city: cam.Myndavel,
                country: 'Iceland',
                feed_url: feedUrl,
                source: 'Vegagerðin',
            });
        }
        return cameras;
    }
    catch (e) {
        // Silent fallback — don't crash the aggregator
        return [];
    }
}
