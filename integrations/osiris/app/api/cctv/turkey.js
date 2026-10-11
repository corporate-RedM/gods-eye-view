// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
// Turkey cameras temporarily removed due to Windy.com iframe embed restrictions (X-Frame-Options blocks).
const TURKEY_CAMERAS = [];
export async function fetchTurkeyCameras() {
    return TURKEY_CAMERAS;
}
export default TURKEY_CAMERAS;
