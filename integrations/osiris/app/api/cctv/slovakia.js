// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
const SLOVAKIA_CAMERAS = [
    {
        id: 'sk-bratislava-1',
        lat: 48.1486, lng: 17.1077,
        name: 'Bratislava - Old Town', city: 'Bratislava', country: 'Slovakia',
        stream_url: 'https://www.youtube.com/embed/kYDIwCLGKL0?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
        stream_type: 'iframe',
        source: 'YouTube Live',
    },
    {
        id: 'sk-bratislava-3',
        lat: 48.1450, lng: 17.1000,
        name: 'Bratislava - Danube River', city: 'Bratislava', country: 'Slovakia',
        stream_url: 'https://www.youtube.com/embed/xFdvZ4eGzPg?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
        stream_type: 'iframe',
        source: 'YouTube Live',
    }
];
export async function fetchSlovakiaCameras() {
    return SLOVAKIA_CAMERAS;
}
