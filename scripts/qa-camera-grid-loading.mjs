import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { encodeLayerStateParams } from '../src/data/layerState.js';

const out = process.env.GRID_QA_OUT || 'output/camera-grid-loading';
await fs.mkdir(out, { recursive: true });
const params = new URLSearchParams({
  v: '2',
  lat: '30.27',
  lon: '-97.74',
  alt: '10000000',
  heading: '0',
  pitch: '-90',
  style: 'normal',
  map: 'satellite',
});
encodeLayerStateParams(params, {
  enabledLayerIds: ['cctv'],
  options: {
    cctv: { coverageMode: 'off', showProjection: false, autoHop: false },
  },
});
const browser = process.env.GRID_QA_BROWSER_URL
  ? await puppeteer.connect({
      browserURL: process.env.GRID_QA_BROWSER_URL,
      defaultViewport: { width: 1440, height: 1000 },
      protocolTimeout: 180000,
    })
  : await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1440, height: 1000 },
      protocolTimeout: 180000,
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
      ],
    });
const page = await browser.newPage();
const profileOnly = !!process.env.GRID_QA_PROFILE;
const client = await page.createCDPSession();
await client.send('Profiler.enable');
await client.send('Profiler.start');
const errors = [];
const sourceStatus = [];
const screenshots = [];
const responseSizes = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', async (response) => {
  if (response.url().includes('/api/cctv/sources')) {
    try {
      responseSizes.push({
        bytes: (await response.buffer()).length,
        status: response.status(),
        statusOnly: response.url().includes('status=1'),
      });
    } catch {}
  }
  if (response.url().includes('/api/cctv/sources?status=1')) {
    try {
      sourceStatus.push(await response.json());
    } catch {}
  }
});
try {
  await page.evaluateOnNewDocument(() => {
    window.gridSamples = [];
    window.gridLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.gridLongTasks.push({
          at: entry.startTime,
          duration: entry.duration,
        });
    }).observe({ type: 'longtask', buffered: true });
    setInterval(() => {
      const app = window.__godsEyeView;
      const primitives = app?.viewer?.scene?.primitives;
      let markers = 0,
        shown = 0,
        inViewport = 0;
      if (primitives)
        for (let i = 0; i < primitives.length; i++) {
          const p = primitives.get(i);
          // CCTV's billboard image is a camera SVG, distinct from other layers.
          if (
            !p?._billboards?.length ||
            !String(p._billboards[0]?.image).includes('svg')
          )
            continue;
          if (p._billboards[0]?.width !== 24 || p._billboards[0]?.height !== 24)
            continue;
          markers += p.length;
          if (p.show) shown += p._billboards.filter((b) => b.show).length;
          // Count actual registered/shown billboards. Projecting every marker
          // to screen solely for this observer stalls the app being measured.
        }
      const cover = document.getElementById('loading-screen');
      const style = cover && getComputedStyle(cover);
      const stats = app?.dataManager?.layers.get('cctv')?.module.getStats();
      window.gridSamples.push({
        ms: Math.round(performance.now()),
        cover: !!cover && style.display !== 'none' && Number(style.opacity) > 0,
        label: document.getElementById('cctv-sync-label')?.textContent,
        counter: document.getElementById('cctv-sync-progress')?.textContent,
        markers,
        shown,
        inViewport,
        view: app?.viewer?.camera?.positionCartographic && {
          lat:
            (app.viewer.camera.positionCartographic.latitude * 180) / Math.PI,
          lon:
            (app.viewer.camera.positionCartographic.longitude * 180) / Math.PI,
        },
        stats,
      });
    }, 250);
  });
  await page.goto(
    `${process.env.GRID_QA_BASE || 'http://127.0.0.1:4173'}/?welcome=0#${params}`,
    {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    },
  );
  for (const fraction of [0.1, 0.4, 0.7]) {
    await page.waitForFunction(
      (fraction) => {
        const s = window.gridSamples?.at(-1);
        return (
          s && !s.cover && s.markers > (s.stats?.count || Infinity) * fraction
        );
      },
      { timeout: 180000 },
      fraction,
    );
    if (!profileOnly) {
      const before = await page.evaluate(() => window.gridSamples.at(-1));
      assert.ok(Math.abs(before.view.lat - 30.27) < 0.01);
      assert.ok(Math.abs(before.view.lon + 97.74) < 0.01);
      await page.screenshot({ path: `${out}/progress-${fraction}.png` });
      screenshots.push({
        file: `progress-${fraction}.png`,
        before,
        after: await page.evaluate(() => window.gridSamples.at(-1)),
      });
    }
    console.log(
      'progress',
      fraction,
      await page.evaluate(() => window.gridSamples.at(-1)),
    );
  }
  await page.waitForFunction(
    () => {
      const s = window.gridSamples?.at(-1);
      return (
        s?.stats?.count > 0 && s.markers === s.stats.count && !s.stats.loading
      );
    },
    { timeout: 180000 },
  );
  if (!profileOnly) await page.screenshot({ path: `${out}/ready.png` });
  await page.waitForFunction(
    () => {
      const s = window.gridSamples?.at(-1);
      const picker = document.getElementById('cctv-camera-select');
      return picker && !picker.disabled && picker.options.length <= 129;
    },
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const input = document.getElementById('cctv-camera-search');
    input.focus();
    input.click();
  });
  await page.waitForSelector('.cctv-catalogue-picker:not([hidden])');
  const total = await page.evaluate(
    () => window.gridSamples.at(-1).stats.count,
  );
  assert.equal(
    await page.$eval('.cctv-catalogue-picker-row', (row) =>
      Number(row.getAttribute('aria-setsize')),
    ),
    total,
  );
  await page.screenshot({ path: `${out}/catalogue-first.png` });
  await page.keyboard.press('End');
  const last = await page.$eval(
    '.cctv-catalogue-picker-row[aria-selected="true"]',
    (row) => ({
      id: row.dataset.cameraId,
      index: Number(row.getAttribute('aria-posinset')),
      text: row.textContent,
    }),
  );
  assert.equal(last.index, total, 'The last catalogue entry must be reachable');
  await page.screenshot({ path: `${out}/catalogue-last.png` });
  await page.$eval(
    '#cctv-camera-search',
    (input, id) => {
      input.value = id;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    last.id,
  );
  await page.waitForFunction(
    (id) => {
      const rows = [...document.querySelectorAll('.cctv-catalogue-picker-row')];
      return rows.length === 1 && rows[0].dataset.cameraId === id;
    },
    {},
    last.id,
  );
  await page.screenshot({ path: `${out}/catalogue-search.png` });
  console.log('FULL CATALOGUE SEARCH', { total, last });
  await page.keyboard.press('Escape');
} finally {
  const { profile } = await client.send('Profiler.stop');
  await fs.writeFile(`${out}/cpu-profile.json`, JSON.stringify(profile));
  const result = await page.evaluate(() => {
    const scene = window.__godsEyeView?.viewer.scene;
    const gl = scene?.context?._gl;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      samples: window.gridSamples,
      longTasks: window.gridLongTasks,
      url: location.href,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    };
  });
  result.errors = errors;
  result.sourceStatus = sourceStatus;
  result.responseSizes = responseSizes;
  result.screenshots = screenshots;
  await fs.writeFile(`${out}/recording.json`, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      last: result.samples?.at(-1),
      longTasks: result.longTasks,
      errors,
    }),
  );
  await page.close();
  if (process.env.GRID_QA_BROWSER_URL) await browser.disconnect();
  else await browser.close();
  assert.ok(
    sourceStatus[0]?.coverage?.snapshotReady,
    'Must exercise a warm server catalogue',
  );
  assert.ok(
    result.samples.filter(
      (s) => !s.cover && s.markers > 0 && s.markers < s.stats.count,
    ).length >= 4,
    'Must record progressive real markers',
  );
  assert.ok(
    result.samples.every((s) => !s.cover || s.markers === 0),
    'No camera marker may load behind the cover',
  );
  assert.equal(
    result.samples.at(-1).markers,
    result.samples.at(-1).stats.count,
  );
  assert.equal(errors.length, 0, errors.join('\n'));
}
