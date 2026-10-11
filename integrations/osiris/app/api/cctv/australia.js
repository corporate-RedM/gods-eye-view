// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { stealthFetch } from '../../../lib/stealthFetch.js';
export async function fetchAustraliaCameras() {
    try {
        const res = await stealthFetch('https://www.livetraffic.com/datajson/all-feeds-web.json', { signal: AbortSignal.timeout(12000) });
        if (!res.ok)
            return [];
        const data = await res.json();
        return (data || []).filter((event) => event.eventType === 'liveCams').map((cam) => {
            return {
                id: cam.path,
                lat: cam.geometry.coordinates[1],
                lng: cam.geometry.coordinates[0],
                name: cam.properties.title || 'Australia Camera',
                city: cam.properties.region || 'Australia',
                country: 'Australia',
                feed_url: cam.properties.href || '',
                source: 'Live Traffic',
            };
        }).filter((c) => c.lat && c.lng);
    }
    catch {
        return [];
    }
}
