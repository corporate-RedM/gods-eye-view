import { createCctvLayer } from '../../layers/cctv/index.js';
import * as credits from '../../data/dataCredits.js';
import * as sprites from '../../data/spriteOrder.js';
import * as activation from '../../cctvFocusRequest.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as locations from '../../locations.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as render from '../../renderGovernor.js';

/** Camera work starts only after the startup cover has finished fading out. */
export async function waitForCameraGridSurface({ signal } = {}) {
  if (typeof document === 'undefined') return;
  const cover = document.getElementById('loading-screen');
  while (cover?.isConnected) {
    signal?.throwIfAborted();
    const style = getComputedStyle(cover);
    if (style.display === 'none' || Number(style.opacity) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  signal?.throwIfAborted();
}

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationCctv({ surface, source }) {
  const { terrain, groundFloor: ground, meshFloor: mesh } = surface;
  return createCctvLayer({
    source,
    services: {
      credits,
      sprites,
      activation,
      overlays,
      locations,
      picking,
      terrain,
      ground,
      mesh,
      focus,
      render: { ...render, waitForCameraGridSurface },
    },
  });
}
