// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
/*
 * Hosts whose still images a browser cannot load straight from the source.
 * infobanjirjps.selangor.gov.my — Selangor's flood cameras — serves over
 * plain http, which an https page blocks as mixed content, so the picture is
 * there in development and gone in production. The proxy re-serves it over
 * https. A host added here must also be in the proxy's own allowlist.
 */
const PROXY_IMAGE_HOSTS = ['infobanjirjps.selangor.gov.my'];
/** The URL a browser can actually load this still from. */
export function proxiedImageUrl(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        return url;
    }
    return PROXY_IMAGE_HOSTS.some(h => host === h || host.endsWith('.' + h))
        ? `/api/eye/cctv/proxy?url=${encodeURIComponent(url)}`
        : url;
}
export function normalizeFeedUrl(url) {
    if (url.startsWith('pics/')) {
        return `http://free-webcambg.com/${url.split('?')[0]}`;
    }
    return url.split('?')[0];
}
export function inferStreamType(url) {
    if (/\.m3u8(\?|$)/i.test(url))
        return 'hls';
    if (/youtube\.com\/embed|youtube-nocookie\.com\/embed|rtsp\.me\/embed|ipcamlive\.com\/player|click2stream\.com|windy\.com\/webcams\/\d+\/embed|skylinewebcams\.com|voyage\.aprr\.fr/i.test(url)) {
        return 'iframe';
    }
    return 'jpg';
}
