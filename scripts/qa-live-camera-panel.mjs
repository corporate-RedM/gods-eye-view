import puppeteer from 'puppeteer';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.EYE_QA_URL || 'http://127.0.0.1:4173';
const shard = Number(process.env.EYE_SAMPLE_SHARD || 0);
const shards = Number(process.env.EYE_SAMPLE_SHARDS || 1);
const output = process.env.EYE_QA_OUTPUT || 'output/live-camera-review';
const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 120000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const result = {
  at: new Date().toISOString(),
  requests: [],
  samples: [],
  errors: [],
};
if (process.env.EYE_RESUME === '1') {
  const previous = JSON.parse(
    await fs.readFile(output + '/verification.json', 'utf8'),
  );
  result.samples = previous.samples;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const page = await browser.newPage();
  const responseTasks = [];
  page.on('pageerror', (error) => result.errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname !== '/api/cctv/sources') return;
    responseTasks.push(
      (async () => {
        const bytes = await response.buffer();
        const data = JSON.parse(bytes.toString());
        const statusOnly = url.searchParams.has('status');
        if (statusOnly) assert.equal(data.sources, undefined);
        else
          assert.ok(
            data.sources.every((s) =>
              ['hls', 'mjpeg', 'mp4', 'webm', 'iframe'].includes(s.feedType),
            ),
          );
        result.requests.push({
          statusOnly,
          bytes: bytes.length,
          count: data.count ?? data.sources.length,
        });
      })(),
    );
  });
  await page.goto(base + '/?welcome=0', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.__godsEyeView?.workspace, {
    timeout: 120000,
  });
  await page.evaluate(() => {
    const state = window.__godsEyeView.dataManager.layers
      .get('cctv')
      ?.module.getUIState();
    if (!state?.enabled && !state?.catalogueLoading?.active)
      document.getElementById('cctv-enable-btn').click();
  });
  for (let i = 0; i < 90; i++) {
    const status = await (
      await fetch(base + '/api/cctv/sources?status=1')
    ).json();
    console.log('Collection', JSON.stringify(status));
    if (status.coverage.snapshotReady) break;
    await sleep(10000);
  }
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv')?.module.getUIState()
        .enabled,
    { timeout: 120000 },
  );
  const response = await fetch(base + '/api/cctv/sources');
  const text = await response.text();
  const { sources, coverage } = JSON.parse(text);
  result.bytes = Buffer.byteLength(text);
  result.count = sources.length;
  result.coverage = coverage;
  result.byType = {};
  result.byPack = {};
  result.byProvider = {};
  for (const source of sources) {
    result.byType[source.feedType] = (result.byType[source.feedType] || 0) + 1;
    for (const [group, key] of [
      [result.byPack, source.pack],
      [result.byProvider, source.provider],
    ]) {
      const row = (group[key] ??= {});
      row[source.feedType] = (row[source.feedType] || 0) + 1;
    }
  }
  result.ui = await page.evaluate(() => {
    const s = window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getUIState();
    return {
      count: s.count,
      cameraCount: s.cameras.length,
      types: [...new Set(s.cameras.map((c) => c.feedType))],
      counter: document.getElementById('cctv-sync-progress').textContent,
      watch: document.getElementById('ai-watch-status')?.textContent,
    };
  });
  assert.equal(result.ui.count, sources.length);
  assert.equal(result.ui.cameraCount, sources.length);
  assert.ok(
    result.ui.types.every((type) =>
      ['hls', 'mjpeg', 'mp4', 'webm', 'iframe'].includes(type),
    ),
  );
  console.log(
    'Catalogue ready',
    JSON.stringify({
      count: result.count,
      bytes: result.bytes,
      byType: result.byType,
      ui: result.ui,
    }),
  );
  // These checks measure the camera panel. Stop only this headless browser's
  // globe render loop after checking the catalogue, to avoid GPU contention.
  await page.evaluate(() => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = false;
  });
  await fs.mkdir(output, { recursive: true });
  // Keep only aggregate counts and diagnostic sample evidence, never an inventory.
  const groups = new Map();
  for (const s of sources) {
    const key = `${s.provider} / ${s.feedType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const ordered = [...groups].sort(
    (a, b) =>
      (a[1][0].feedType === 'mjpeg' ? -1 : 0) -
      (b[1][0].feedType === 'mjpeg' ? -1 : 0),
  );
  const limit = Number(process.env.EYE_SAMPLE_GROUPS) || Infinity;
  for (const [group, cameras] of ordered
    .slice(0, limit)
    .filter((_, i) => i % shards === shard)) {
    const picks =
      process.env.EYE_ONE_SAMPLE === '1'
        ? [cameras[0]]
        : cameras.length > 1
          ? [cameras[0], cameras[Math.floor(cameras.length / 2)]]
          : [cameras[0]];
    for (const camera of picks) {
      if (result.samples.some((sample) => sample.id === camera.id)) continue;
      const sample = {
        group,
        id: camera.id,
        feedType: camera.feedType,
        name: camera.name,
      };
      // Stop on server loss instead of mislabelling every following source.
      const health = await fetch(base + '/api/cctv/watch/state', {
        signal: AbortSignal.timeout(5000),
      });
      assert.ok(health.ok, 'Development server unavailable');
      try {
        await page.evaluate(
          (id) =>
            window.__godsEyeView.dataManager.layers
              .get('cctv')
              .module.selectCamera(id),
          camera.id,
        );
        await sleep(500);
        let surface;
        if (camera.feedType === 'iframe') {
          surface = await page.waitForSelector('#cctv-frame-wrap iframe', {
            visible: true,
            timeout: 12000,
          });
          await sleep(6000);
        } else {
          await page.waitForFunction(
            (type) => {
              if (type === 'mjpeg') {
                const img = document.getElementById('cctv-frame');
                return !img.hidden && img.naturalWidth > 0;
              }
              const video = window.__godsEyeView.dataManager.layers
                .get('cctv')
                .module.getActiveVideoElement();
              return (
                video?.readyState >= 2 && video.videoWidth > 0 && !video.paused
              );
            },
            { timeout: 20000 },
            camera.feedType,
          );
          surface = await page.$(
            camera.feedType === 'mjpeg' ? '#cctv-frame' : '#cctv-video',
          );
        }
        const playback = async () => {
          if (camera.feedType === 'mjpeg') return null;
          if (camera.feedType !== 'iframe')
            return page.evaluate(() => {
              const v = window.__godsEyeView.dataManager.layers
                .get('cctv')
                .module.getActiveVideoElement();
              return v
                ? { time: v.currentTime, ready: v.readyState, paused: v.paused }
                : null;
            });
          const frame = await surface.contentFrame();
          for (const f of [frame, ...(frame?.childFrames() || [])]) {
            if (!f) continue;
            const v = await f
              .evaluate(() => {
                const v = document.querySelector('video');
                return v
                  ? {
                      time: v.currentTime,
                      ready: v.readyState,
                      paused: v.paused,
                    }
                  : null;
              })
              .catch(() => null);
            if (v) return v;
          }
          return null;
        };
        const firstTime = await playback();
        const first = await surface.screenshot();
        await sleep(3500);
        const secondTime = await playback();
        const second = await surface.screenshot();
        const pixels = async (png) =>
          sharp(png)
            .resize(160, 90, { fit: 'fill' })
            .removeAlpha()
            .raw()
            .toBuffer();
        const a = await pixels(first),
          b = await pixels(second);
        let changed = 0,
          sum = 0;
        for (let i = 0; i < a.length; i++) {
          const delta = Math.abs(a[i] - b[i]);
          sum += delta;
          if (delta > 8) changed++;
        }
        sample.changedFraction = changed / a.length;
        sample.meanPixelChange = sum / a.length;
        sample.timeAdvance =
          firstTime && secondTime ? secondTime.time - firstTime.time : null;
        sample.moving =
          sample.changedFraction > 0.005 &&
          (camera.feedType === 'mjpeg' || sample.timeAdvance > 1);
        sample.result = sample.moving
          ? 'moving frames confirmed'
          : 'moving video not confirmed';
        const name = `sample-${result.samples.length + 1}`;
        await fs.writeFile(`${output}/${name}-a.png`, first);
        await fs.writeFile(`${output}/${name}-b.png`, second);
        sample.evidence = [name + '-a.png', name + '-b.png'];
      } catch (error) {
        // Browser/session failures are harness failures, not camera failures.
        if (/detached Frame|Target closed|Session closed/.test(error.message))
          throw error;
        sample.result = 'playback not verified';
        sample.error = error.message.slice(0, 240);
      }
      result.samples.push(sample);
      console.log('Sample', JSON.stringify(sample));
      await fs.writeFile(
        output + '/verification.json',
        JSON.stringify(result, null, 2),
      );
    }
  }
  await Promise.all(responseTasks);
  result.completedAt = new Date().toISOString();
  await fs.writeFile(
    output + '/verification.json',
    JSON.stringify(result, null, 2),
  );
  console.log(
    'Finished',
    JSON.stringify({
      groups: Math.min(groups.size, limit),
      samples: result.samples.length,
      moving: result.samples.filter((s) => s.moving).length,
    }),
  );
} finally {
  await browser.close();
}
