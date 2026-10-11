// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { ASIA_SKYLINE_CAMERAS } from './asia-skyline.generated.js';
/**
 * OSIRIS — Asia live public webcams.
 *
 * Complements the traffic-authority feeds already wired up for the region
 * (HK Transport Dept, Taiwan THB, Japan MLIT, LTA Singapore) with open public
 * webcams in countries that publish no machine-readable CCTV feed of their own.
 */
export async function fetchAsiaLiveCameras() {
    return ASIA_SKYLINE_CAMERAS;
}
