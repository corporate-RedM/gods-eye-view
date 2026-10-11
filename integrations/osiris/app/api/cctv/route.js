// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { stealthFetch } from '../../../lib/stealthFetch.js';
export const maxDuration = 60;
import { fetchAsfinagCameras } from './asfinag.js';
import { fetchNetherlandsCameras } from './netherlands.js';
import { fetchBulgariaCameras } from './bulgaria.js';
import { fetchGreeceCameras } from './greece.js';
import { fetchSerbiaCameras } from './serbia.js';
import { fetchMacedoniaCameras } from './macedonia.js';
import { fetchTurkeyCameras } from './turkey.js';
import { fetchRomaniaCameras } from './romania.js';
import { fetchAustraliaCameras } from './australia.js';
import { fetchItalyCameras } from './italy.js';
import { fetchCzechiaCameras } from './czechia.js';
import { fetchSlovakiaCameras } from './slovakia.js';
import { fetchGermanyCameras } from './germany.js';
import { fetchFranceCameras } from './france.js';
import { fetchSpainCameras } from './spain.js';
import { fetchPolandCameras } from './poland.js';
import { fetchJapanCameras } from './japan.js';
import { fetchSwitzerlandCameras } from './switzerland.js';
import { fetchFinlandCameras } from './finland.js';
import { fetchSwedenCameras } from './sweden.js';
import { fetchHongKongCameras } from './hongkong.js';
import { fetchUtahCameras } from './utah.js';
import { fetchIcelandCameras } from './iceland.js';
import { fetchTaiwanCameras } from './taiwan.js';
import { fetchThailandCameras } from './thailand.js';
import { fetchAsiaLiveCameras } from './asia-live.js';
import { fetchNewZealandCameras } from './newzealand.js';
import { fetchLithuaniaCameras } from './lithuania.js';
import { fetchEdmontonCameras } from './edmonton.js';
import { fetchOregonCameras } from './oregon.js';
import { fetchMichiganCameras } from './michigan.js';
import { fetchIndianaCameras } from './indiana.js';
import { fetchNevadaCameras } from './nevada.js';
import { fetchLouisianaCameras } from './louisiana.js';
import { fetchFloridaCameras } from './florida.js';
import { fetchGeorgiaCameras } from './georgia.js';
import { fetchNorthCarolinaCameras } from './northcarolina.js';
import { fetchArizonaCameras } from './arizona.js';
import { fetchTexasCameras } from './texas.js';
import { fetchEastAsiaCameras, fetchSeAsiaCameras, fetchWestAsiaCameras } from './opencctv.js';
import { fetchLatamLiveCameras, fetchAfricaLiveCameras, fetchEuropeLiveCameras, } from './world-live.js';
import { fetchNlPublicWebcams, fetchEuropePublicWebcams, fetchAmericasPublicWebcams, fetchRestPublicWebcams, } from './public-webcams.js';
/**
 * OSIRIS — Worldwide CCTV Camera API v2
 * Viewport-aware: pass ?region=xx to load cameras for specific regions
 * Supports: uk, us-east, us-west, us-central, canada, europe, asia
 * Or pass ?lat=x&lng=y&radius=5 for proximity-based loading
 */
// ═══ CAMERA SOURCE DEFINITIONS ═══
// ── UK: Transport for London JamCams (~900) ──
async function fetchTfLCameras() {
    try {
        const res = await stealthFetch('https://api.tfl.gov.uk/Place/Type/JamCam', { signal: AbortSignal.timeout(12000) });
        if (!res.ok)
            return [];
        const data = await res.json();
        return (data || []).map((cam) => {
            const imgProp = cam.additionalProperties?.find((p) => p.key === 'imageUrl');
            const camId = cam.id?.replace('JamCams_', '') || '';
            return {
                id: `tfl-${cam.id}`, lat: cam.lat, lng: cam.lon,
                name: cam.commonName || 'London JamCam', city: 'London', country: 'UK',
                feed_url: imgProp?.value || `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${camId}.jpg`,
                source: 'TfL',
            };
        }).filter((c) => c.lat && c.lng);
    }
    catch (e) {
        return [];
    }
}
// ── US-WEST: WSDOT Washington State (~500) ──
async function fetchWSDOTCameras() {
    try {
        const res = await stealthFetch('https://data.wsdot.wa.gov/log/public/cameras.json', { signal: AbortSignal.timeout(12000) });
        if (!res.ok)
            return [];
        const data = await res.json();
        return (data || []).map((cam) => ({
            id: `wsdot-${cam.CameraID}`, lat: cam.CameraLocation?.Latitude, lng: cam.CameraLocation?.Longitude,
            name: cam.Title || 'WSDOT Camera', city: 'Washington', country: 'US',
            feed_url: cam.ImageURL || '', source: 'WSDOT',
        })).filter((c) => c.lat && c.lng && c.feed_url);
    }
    catch (e) {
        return [];
    }
}
// ── US-WEST: Caltrans California ──
async function fetchCaltransCameras() {
    try {
        const res = await stealthFetch('https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0/query?where=1%3D1&outFields=*&f=json', { signal: AbortSignal.timeout(12000) });
        if (!res.ok)
            return [];
        const data = await res.json();
        const cams = [];
        for (const feature of (data?.features || [])) {
            const p = feature.attributes;
            const lat = p.latitude;
            const lng = p.longitude;
            const url = p.currentImageURL;
            if (!lat || !lng || !url)
                continue;
            cams.push({
                id: `cal-${p.OBJECTID}`,
                lat,
                lng,
                name: p.locationName || 'Caltrans',
                city: p.nearbyPlace || p.county || 'California',
                country: 'US',
                feed_url: url,
                source: 'Caltrans'
            });
        }
        return cams;
    }
    catch (e) {
        return [];
    }
}
/**
 * One sub-source of a multi-source region, fetched with a single retry.
 *
 * These blocks swallowed every failure. A region returns whatever it managed
 * to collect, and sourceCache stores a non-empty result as a success — so one
 * blip on one source cached the region without it for the full TTL, with
 * nothing in the log to say which one went missing. Quebec disappeared from
 * Canada that way for half an hour while its own endpoint was answering in
 * 300ms. The retry catches the blip; the warning means a real outage is
 * visible instead of silent.
 */
async function subSource(label, url, timeoutMs) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await stealthFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok)
                return await res.json();
            /* A 4xx is a decision, not a blip: a retired endpoint answers 404 just
               as fast the second time. Retrying them only spent the region's budget
               — Montreal (403) and Alberta (400) between them pushed Canada past
               12s, so the whole country came back empty on a cold cache. */
            if (res.status >= 400 && res.status < 500) {
                console.warn(`[OSIRIS] ${label} returned ${res.status} — absent from this refresh, not retried`);
                return null;
            }
            if (attempt === 2)
                console.warn(`[OSIRIS] ${label} returned ${res.status} — absent from this refresh`);
        }
        catch (e) {
            if (attempt === 2)
                console.warn(`[OSIRIS] ${label} failed — absent from this refresh:`, e instanceof Error ? e.message : e);
        }
    }
    return null;
}
// ── CANADA: Ottawa, Toronto, Montreal, Quebec ──
async function fetchCanadaCameras() {
    const cams = [];
    /* All seven run at once. Awaited one after another their timeouts summed
       to well over the 12s the route allows a region, so Canada kept coming
       back empty and only filled in on a later poll — the whole country
       looked like it was failing to load. They share nothing, so there was
       never a reason to queue them. */
    const [ottawa, quebec, ontario, montreal, alberta, toronto, drivebc] = await Promise.all([
        subSource('City of Ottawa', 'https://traffic.ottawa.ca/beta/camera_list', 12000),
        subSource('Quebec 511', 'https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:infos_cameras&outfile=Camera&srsname=EPSG:4326&outputformat=geojson', 10000),
        subSource('511 Ontario', 'https://511on.ca/api/v2/get/cameras', 10000),
        subSource('Ville MTL', 'https://ville.montreal.qc.ca/circulation/sites/ville.montreal.qc.ca.circulation/files/cameras.json', 8000),
        subSource('511 Alberta', 'https://511.alberta.ca/api/v2/get/cameras', 10000),
        subSource('City of Toronto', 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson', 10000),
        subSource('DriveBC', 'https://drivebc.ca/api/webcams', 10000),
    ]);
    // Ottawa Municipal Cameras (Comprehensive)
    {
        const data = ottawa;
        if (data) {
            for (const cam of (data || [])) {
                if (!cam.latitude || !cam.longitude)
                    continue;
                cams.push({
                    id: `ottawa-muni-${cam.id}`, lat: cam.latitude, lng: cam.longitude,
                    name: cam.description || 'Ottawa Traffic Camera', city: 'Ottawa', country: 'Canada',
                    feed_url: `https://traffic.ottawa.ca/map/camera?id=${cam.number || cam.id}`, source: 'City of Ottawa',
                });
            }
        }
    }
    // Quebec 511 (Comprehensive - covers Montreal, Quebec City, highways)
    {
        const data = quebec;
        if (data) {
            for (const feature of (data.features || [])) {
                const coords = feature.geometry?.coordinates;
                const p = feature.properties;
                if (!coords || !p || !p.IDEcamera)
                    continue;
                cams.push({
                    id: `quebec511-${p.IDEcamera}`, lat: coords[1], lng: coords[0],
                    name: p.DescriptionLocalisationEn || p.DescriptionLocalisationFr || 'Quebec 511 Camera', city: p.NomRegionDiffusion || 'Quebec', country: 'Canada',
                    stream_url: p.URL_FLUX_DONNEE ? p.URL_FLUX_DONNEE.replace('FenetreVideo.html', 'camera.ashx') + '&format=mp4' : `https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=${p.IDEcamera}&format=mp4`,
                    stream_type: 'mp4',
                    source: 'Quebec 511',
                });
            }
        }
    }
    // Ontario 511 (MTO Highway Cameras)
    {
        const data = ontario;
        if (data) {
            /* MTO capitalises its field names. Reading `cam.latitude` skipped all
               944 rows, so the only Ontario markers on the map were the three
               curated Toronto ones below — the province has been empty this whole
               time. A view's Url serves the JPEG itself, no rewriting needed. */
            for (const cam of (data || [])) {
                const view = cam.Views?.find((v) => v.Status === 'Enabled') ?? cam.Views?.[0];
                if (!cam.Latitude || !cam.Longitude || !view?.Url)
                    continue;
                cams.push({
                    id: `on-${cam.Id}`, lat: cam.Latitude, lng: cam.Longitude,
                    name: cam.Location || cam.Roadway || 'Ontario Camera', city: 'Ontario', country: 'Canada',
                    feed_url: view.Url, source: '511 Ontario',
                });
            }
        }
    }
    // Ville de Montréal municipal cameras
    {
        const data = montreal;
        if (data) {
            for (const cam of (data || [])) {
                cams.push({
                    id: `mtl-muni-${cams.length}`, lat: cam.latitude || cam.lat, lng: cam.longitude || cam.lng,
                    name: cam.description || cam.name || 'Montréal Camera', city: 'Montréal', country: 'Canada',
                    feed_url: cam.url || cam.imageUrl || '', source: 'Ville MTL',
                });
            }
        }
    }
    // Curated Toronto cameras (fallback if 511ON fails)
    const curated = [
        { id: 'tor-1', lat: 43.6532, lng: -79.3832, name: 'Yonge / Dundas Square', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
        { id: 'tor-2', lat: 43.6426, lng: -79.3871, name: 'CN Tower / Lakeshore', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
        { id: 'tor-3', lat: 43.6711, lng: -79.3868, name: 'Bloor / Yonge', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
    ];
    cams.push(...curated);
    // Alberta 511
    {
        const data = alberta;
        if (data) {
            for (const cam of (data || [])) {
                if (!cam.Latitude || !cam.Longitude || !cam.Views?.[0]?.Url)
                    continue;
                cams.push({
                    id: `ab-${cam.Id || cams.length}`, lat: cam.Latitude, lng: cam.Longitude,
                    name: cam.Location || 'Alberta Camera', city: 'Alberta', country: 'Canada',
                    feed_url: cam.Views[0].Url, source: 'Alberta 511',
                });
            }
        }
    }
    // Toronto Open Data Municipal Traffic Cameras
    {
        const data = toronto;
        if (data) {
            for (const feature of (data.features || [])) {
                let coords = feature.geometry?.coordinates;
                if (Array.isArray(coords) && Array.isArray(coords[0]))
                    coords = coords[0];
                const p = feature.properties;
                if (!coords || !p || !p.IMAGEURL)
                    continue;
                cams.push({
                    id: `tor-open-${p.REC_ID}`, lat: coords[1], lng: coords[0],
                    name: `${p.MAINROAD} / ${p.CROSSROAD}`, city: 'Toronto', country: 'Canada',
                    feed_url: p.IMAGEURL, source: 'City of Toronto',
                });
            }
        }
    }
    // British Columbia HighwayCams (Live JSON API)
    {
        const data = drivebc;
        if (data) {
            for (const cam of (data || [])) {
                if (!cam.location?.coordinates || !cam.links?.imageDisplay)
                    continue;
                const [lng, lat] = cam.location.coordinates;
                cams.push({
                    id: `bc-cam-${cam.id}`, lat, lng,
                    name: cam.name || cam.caption || 'BC Highway Camera', city: 'British Columbia', country: 'Canada',
                    feed_url: `https://drivebc.ca${cam.links.imageDisplay}`, source: 'DriveBC',
                });
            }
        }
    }
    return cams.filter((c) => c.lat && c.lng);
}
// ── US-CENTRAL: Chicago, Houston, Dallas, Denver ──
async function fetchUSCentralCameras() {
    const cams = [];
    // Illinois DOT
    {
        const data = await subSource('IDOT', 'https://www.travelmidwest.com/lmiga/cameraReport.json', 8000);
        if (data) {
            /* travelmidwest answers 200 with {updatedMessage, noDataMessage} and no
               cameras at all — an object, not the array this assumed. That threw a
               TypeError the old silent catch quietly absorbed; now it would take
               us-central down with it, so the shape is checked. */
            const rows = Array.isArray(data?.cameraReports) ? data.cameraReports : Array.isArray(data) ? data : [];
            for (const cam of rows) {
                if (!cam.latitude || !cam.longitude)
                    continue;
                cams.push({
                    id: `ildot-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
                    name: cam.cameraName || cam.description || 'IDOT Camera', city: 'Illinois', country: 'US',
                    feed_url: cam.imageUrl || cam.url || '', source: 'IDOT',
                });
            }
        }
    }
    return cams.filter((c) => c.lat && c.lng);
}
// ── US-EAST: OH, DC, Florida, Georgia ──
async function fetchUSEastCameras() {
    const cams = [];
    // Butler County, OH (from redhunt45 fork)
    cams.push({
        id: 'butler-oh-hamilton', lat: 39.3988617, lng: -84.5595353,
        name: 'Hamilton, OH', city: 'Hamilton', country: 'US',
        feed_url: 'https://gsccam.butlersheriff.org/axis-cgi/jpg/image.cgi',
        external_url: 'https://gsccam.butlersheriff.org/camera/index.html#/video',
        source: 'Butler County, OH',
    }, {
        id: 'butler-oh-129-747', lat: 39.381435, lng: -84.438423,
        name: 'OH-129 at 747', city: 'Butler County', country: 'US',
        feed_url: 'https://towercam.butlersheriff.org/axis-cgi/jpg/image.cgi',
        external_url: 'https://towercam.butlersheriff.org/aca/index.html#view',
        source: 'Butler County, OH',
    });
    // Cincinnati, OH (from redhunt45 fork)
    cams.push({
        id: 'cincinnati-cincyvision-yt', lat: 39.089101, lng: -84.527943,
        name: 'CincyVision YT', city: 'Cincinnati', country: 'US',
        external_url: 'https://www.youtube.com/@AaronPreslin/live',
        source: 'Cincinnati, OH',
    }, {
        id: 'cincinnati-covington-earthcam', lat: 39.090510, lng: -84.510413,
        name: 'Cincinnati-Covington EarthCam', city: 'Covington', country: 'US',
        external_url: 'https://www.earthcam.com/usa/kentucky/covington/?cam=covington',
        source: 'Cincinnati, OH',
    });
    /* Florida used to be fetched here from fl511.com/api/v2/cameras. That
       endpoint has returned 404 for some time — and because the block tested
       `res.ok` before doing anything, it failed without even reaching a catch.
       ./florida now serves the state from the working IBI index; this is left
       out rather than kept as a source that can only ever contribute nothing. */
    return cams.filter((c) => c.lat && c.lng);
}
// ── EUROPE: Netherlands, Germany, France ──
async function fetchEuropeCameras() {
    const cams = [];
    /* The Netherlands used to be fetched here from opendata.ndw.nu/cameras.json.
       NDW retired that dataset and it 404s; ./netherlands now serves the country
       from the Rijkswaterstaat feed, which is still published. */
    try {
        cams.push(...await fetchNetherlandsCameras());
    }
    catch (e) {
        console.warn('[OSIRIS] Netherlands cameras failed — absent from this refresh:', e instanceof Error ? e.message : e);
    }
    cams.push(...await fetchAsfinagCameras());
    return cams.filter((c) => c.lat && c.lng);
}
// ── ASIA/PACIFIC ──
async function fetchAsiaCameras() {
    const cams = [];
    // Singapore Live Traffic Images
    {
        const data = await subSource('LTA Singapore', 'https://api.data.gov.sg/v1/transport/traffic-images', 10000);
        if (data) {
            const items = data.items?.[0]?.cameras || [];
            for (const cam of items) {
                if (!cam.location?.latitude || !cam.location?.longitude || !cam.image)
                    continue;
                cams.push({
                    id: `sin-${cam.camera_id}`,
                    lat: cam.location.latitude,
                    lng: cam.location.longitude,
                    name: `Camera ${cam.camera_id}`,
                    city: 'Singapore',
                    country: 'Singapore',
                    feed_url: cam.image,
                    source: 'LTA Singapore'
                });
            }
        }
    }
    return cams;
}
// ── MIDDLE EAST: Israel, Lebanon ──
async function fetchMiddleEastCameras() {
    const cams = [];
    // Israel Curated (Embedded)
    cams.push({
        id: 'il-israel-multicam', lat: 32.0853, lng: 34.7818,
        name: 'Israel Multi-Cam (Live)', city: 'Tel Aviv', country: 'Israel',
        stream_url: 'https://www.youtube.com/embed/gmtlJ_m2r5A?autoplay=1&mute=1',
        stream_type: 'iframe',
        source: 'YouTube Live',
    }, {
        id: 'il-jerusalem-live', lat: 31.7767, lng: 35.2345,
        name: 'Jerusalem Western Wall', city: 'Jerusalem', country: 'Israel',
        stream_url: 'https://www.youtube.com/embed/77akujLn4k8?autoplay=1&mute=1',
        stream_type: 'iframe',
        source: 'YouTube Live',
    });
    // Lebanon Curated (Embedded)
    cams.push({
        id: 'lb-beirut-skyline', lat: 33.8938, lng: 35.5018,
        name: 'Beirut Skyline Live', city: 'Beirut', country: 'Lebanon',
        stream_url: 'https://www.youtube.com/embed/qJf4NqPKLjI?autoplay=1&mute=1',
        stream_type: 'iframe',
        source: 'YouTube Live',
    }, {
        id: 'lb-me-multicam', lat: 33.2721, lng: 35.2033,
        name: 'Middle East Multi-Cam (Live)', city: 'Regional', country: 'Middle East',
        stream_url: 'https://www.youtube.com/embed/oxT5R6I0N6E?autoplay=1&mute=1',
        stream_type: 'iframe',
        source: 'YouTube Live',
    });
    return cams;
}
const RAW_REGION_FETCHERS = {
    'middle-east': fetchMiddleEastCameras,
    'uk': fetchTfLCameras,
    'us-west': async () => { const [w, c] = await Promise.all([fetchWSDOTCameras(), fetchCaltransCameras()]); return [...w, ...c]; },
    'us-east': fetchUSEastCameras,
    'us-central': fetchUSCentralCameras,
    'canada': fetchCanadaCameras,
    'europe': fetchEuropeCameras,
    'netherlands': fetchNetherlandsCameras,
    'asia': fetchAsiaCameras,
    'bulgaria': fetchBulgariaCameras,
    'greece': fetchGreeceCameras,
    'serbia': fetchSerbiaCameras,
    'macedonia': fetchMacedoniaCameras,
    'turkey': fetchTurkeyCameras,
    'romania': fetchRomaniaCameras,
    'australia': fetchAustraliaCameras,
    'italy': fetchItalyCameras,
    'czechia': fetchCzechiaCameras,
    'slovakia': fetchSlovakiaCameras,
    'germany': fetchGermanyCameras,
    'france': fetchFranceCameras,
    'spain': fetchSpainCameras,
    'poland': fetchPolandCameras,
    'japan': fetchJapanCameras,
    'switzerland': fetchSwitzerlandCameras,
    'finland': fetchFinlandCameras,
    'sweden': fetchSwedenCameras,
    'hongkong': fetchHongKongCameras,
    'utah': fetchUtahCameras,
    'iceland': fetchIcelandCameras,
    'taiwan': fetchTaiwanCameras,
    'thailand': fetchThailandCameras,
    'asia-live': fetchAsiaLiveCameras,
    'newzealand': fetchNewZealandCameras,
    'lithuania': fetchLithuaniaCameras,
    'edmonton': fetchEdmontonCameras,
    'oregon': fetchOregonCameras,
    'michigan': fetchMichiganCameras,
    'indiana': fetchIndianaCameras,
    'nevada': fetchNevadaCameras,
    'louisiana': fetchLouisianaCameras,
    'florida': fetchFloridaCameras,
    'georgia': fetchGeorgiaCameras,
    'northcarolina': fetchNorthCarolinaCameras,
    'arizona': fetchArizonaCameras,
    'texas': fetchTexasCameras,
    'eastasia': fetchEastAsiaCameras,
    'seasia': fetchSeAsiaCameras,
    'westasia': fetchWestAsiaCameras,
    'latam-live': fetchLatamLiveCameras,
    'africa-live': fetchAfricaLiveCameras,
    'europe-live': fetchEuropeLiveCameras,
    /* Webcams their operators broadcast publicly. Registered here
       only — fetchEuropeCameras must not call these too, or every one of them
       lands on the map twice (GET concatenates regions without deduping on id). */
    'public-webcams-nl': fetchNlPublicWebcams,
    'public-webcams-europe': fetchEuropePublicWebcams,
    'public-webcams-americas': fetchAmericasPublicWebcams,
    'public-webcams-rest': fetchRestPublicWebcams,
};
export const osirisCameraRegions = RAW_REGION_FETCHERS;
