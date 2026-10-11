// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { LATAM_SKYLINE_CAMERAS, AFRICA_SKYLINE_CAMERAS, EUROPE_SKYLINE_CAMERAS, } from './world-skyline.generated.js';
/**
 * OSIRIS — public live webcams outside Asia.
 *
 * Fills the regions OSIRIS had no CCTV coverage for at all: Latin America, the
 * Caribbean, Africa, and the European countries with no traffic-authority feed
 * of their own. Split by continent so viewport-scoped queries stay meaningful.
 */
export async function fetchLatamLiveCameras() {
    return LATAM_SKYLINE_CAMERAS;
}
export async function fetchAfricaLiveCameras() {
    return AFRICA_SKYLINE_CAMERAS;
}
export async function fetchEuropeLiveCameras() {
    return EUROPE_SKYLINE_CAMERAS;
}
