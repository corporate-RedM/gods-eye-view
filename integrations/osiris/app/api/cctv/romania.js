// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
const ROMANIA_CAMERAS = [
    {
        id: 'ro-bucharest',
        lat: 44.426, lng: 26.102,
        name: 'Bucharest Panorama', city: 'Bucharest', country: 'Romania',
        feed_url: 'https://home-solutions.bg/cams/bukor.jpg',
        source: 'home-solutions.bg',
    },
];
export async function fetchRomaniaCameras() {
    return ROMANIA_CAMERAS.filter((cam) => cam.feed_url || cam.stream_url || cam.external_url);
}
