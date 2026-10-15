import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { eyeApiPlugin } from './eye-api.js';
import { eyeCameraPacks } from './eye-cameras.js';
import { createCctvCatalog } from '../providers/cctv/catalog.js';
import { publicVideoPacks } from '../providers/cctv/publicVideo.js';
import { ibiPublicVideoPacks } from '../providers/cctv/publicIbiVideo.js';
import { driveTexasVideoPack } from '../providers/cctv/driveTexasVideo.js';
import { mississippiVideoPack } from '../providers/cctv/mississippiVideo.js';
import { rhodeIslandVideoPack } from '../providers/cctv/rhodeIslandVideo.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const getSources = createCctvCatalog({
    sourceRoot: root,
    // Prefer publisher adapters that refresh playback tokens over aggregator URLs.
    extraPacks: [
      ...eyeCameraPacks(),
      ...ibiPublicVideoPacks(),
      driveTexasVideoPack(),
      mississippiVideoPack(),
      rhodeIslandVideoPack(),
      ...publicVideoPacks(),
    ],
    fullCatalog: true,
  });
  const config = createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({
        realtime: { tools: standaloneVoiceTools() },
        cctv: {
          getSources,
        },
      }),
      localMcpPlugin(),
      eyeApiPlugin({ getSources }),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
  // Separate worktrees may share installed packages, but not optimizer caches.
  config.cacheDir = fileURLToPath(
    new URL('../../.cache/vite/', import.meta.url),
  );
  config.optimizeDeps.include.push('onnxruntime-web/wasm');
  return config;
});
