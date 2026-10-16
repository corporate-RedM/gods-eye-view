import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { encodeLayerStateParams } from '../src/data/layerState.js';

const base = process.env.PICKER_QA_BASE || 'http://127.0.0.1:4174';
const out = process.env.PICKER_QA_OUT || '/tmp/childs-eye-search-evidence';
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9227',
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 180000,
});
const page = await browser.newPage();
const errors = [];
// Compare the UI against the real response it loaded. A later independent
// fetch can have a different provider/health snapshot during a background refresh.
await page.evaluateOnNewDocument(() => {
  const originalFetch = window.fetch;
  window.cameraCatalogueReads = [];
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = new URL(response.url);
    if (
      url.pathname === '/api/cctv/sources' &&
      !url.searchParams.has('status')
    ) {
      const copy = response.clone();
      window.cameraCatalogueReads.push(
        (async () => {
          if (!copy.ok || !copy.headers.get('content-type')?.includes('json'))
            throw new Error(`Catalogue HTTP ${copy.status}`);
          const payload = await copy.json();
          return { ids: payload.sources.map((camera) => camera.id) };
        })().catch((error) => ({ error: error.message })),
      );
    }
    return response;
  };
});
page.on('pageerror', (error) => errors.push(error.message));
const result = { base, scrollChecks: [], selections: [], errors };
try {
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
  await page.goto(`${base}/?welcome=0#${params}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(
    () => {
      const state = window.__godsEyeView?.dataManager.layers
        .get('cctv')
        ?.module.getUIState();
      return (
        state?.count > 0 &&
        state.catalogueLoading?.phase === 'ready' &&
        !document.getElementById('cctv-camera-search')?.disabled
      );
    },
    { timeout: 360000 },
  );
  result.englishLabels = await page.evaluate(() => {
    const cameras = window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getUIState().cameras;
    const foreign =
      /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Thai}\p{Script=Arabic}\p{Script=Georgian}\p{Script=Devanagari}]/u;
    return {
      checked: cameras.length,
      untranslated: cameras.filter((c) =>
        foreign.test(`${c.name} ${c.city} ${c.provider} ${c.code}`),
      ).length,
      displayLabelsChanged: cameras.filter(
        (c) => c.originalName !== c.name || c.originalCity !== c.city,
      ).length,
      taiwan: cameras.filter((c) => c.id.startsWith('osiris-taiwan')).length,
    };
  });
  assert.equal(result.englishLabels.untranslated, 0);
  console.log('ENGLISH LABEL AUDIT', JSON.stringify(result.englishLabels));
  const captured = await page.evaluate(() =>
    Promise.all(window.cameraCatalogueReads),
  );
  for (const entry of captured) assert.ok(!entry.error, entry.error);
  const loadedPages = captured.map((entry) => entry.ids);
  assert.ok(loadedPages.length > 0, 'Capture the real app catalogue response');
  const records = await page.evaluate((loadedPages) => {
    const ids = new Set(loadedPages.flat());
    const cameras = window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getUIState().cameras;
    const uiIds = new Set(cameras.map((camera) => camera.id));
    return {
      ids: [...uiIds],
      provider: cameras[Math.floor(cameras.length / 2)].provider,
      pages: loadedPages.length,
      serverCount: ids.size,
      missingInUi: [...ids].filter((id) => !uiIds.has(id)),
    };
  }, loadedPages);
  assert.equal(
    records.missingInUi.length,
    0,
    'Every server camera must be in the UI catalogue',
  );
  assert.equal(new Set(records.ids).size, records.serverCount);
  result.total = records.serverCount;
  result.pages = records.pages;
  const search = '#cctv-camera-search';
  await page.click(search);
  await page.type(search, 'Taiwan Provincial Highway');
  await page.waitForFunction(() =>
    document
      .querySelector('.cctv-catalogue-picker-row strong')
      ?.textContent.includes('Provincial Highway'),
  );
  await page.screenshot({ path: `${out}/taiwan-english.png` });
  await page.$eval(search, (input) => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    (total) =>
      Number(
        document
          .querySelector('.cctv-catalogue-picker-row')
          ?.getAttribute('aria-setsize'),
      ) === total,
    {},
    result.total,
  );
  // Exercise the actual dropdown opener; its pointer event bubbles to document.
  await page.click('#cctv-camera-select');
  await page.waitForSelector('.cctv-catalogue-picker:not([hidden])');
  assert.equal(
    await page.$eval('.cctv-catalogue-picker-row', (row) =>
      Number(row.getAttribute('aria-setsize')),
    ),
    result.total,
  );
  await page.screenshot({ path: `${out}/full-list.png` });
  // Scroll through the entire range, checking actual row IDs against UI data.
  const rendered = new Set();
  for (let index = 0; index < records.ids.length; index += 8) {
    const rows = await page.$eval(
      '.cctv-catalogue-picker-viewport',
      (viewport, index) => {
        viewport.scrollTop = index * 68;
        viewport.dispatchEvent(new Event('scroll'));
        return [...viewport.querySelectorAll('[role=option]')].map((row) => ({
          index: Number(row.getAttribute('aria-posinset')) - 1,
          id: row.dataset.cameraId,
          total: Number(row.getAttribute('aria-setsize')),
        }));
      },
      index,
    );
    assert.ok(rows.length > 0 && rows.length < 30);
    for (const row of rows) {
      assert.equal(row.id, records.ids[row.index]);
      assert.equal(row.total, result.total);
      rendered.add(row.id);
    }
    if (index % 4000 === 0) {
      result.scrollChecks.push({
        target: index + 1,
        first: rows[0].index + 1,
        last: rows.at(-1).index + 1,
      });
      console.log(
        `Rendered and checked ${rendered.size} / ${records.ids.length} real camera rows`,
      );
    }
  }
  assert.equal(
    rendered.size,
    records.ids.length,
    'Every catalogue entry must actually render in the list',
  );
  result.individualRowsVerified = rendered.size;
  await page.evaluate(() => {
    window.pickerScrollEvents = [];
    for (const type of ['pointerdown', 'focusin', 'focusout', 'click'])
      document.addEventListener(
        type,
        (event) =>
          window.pickerScrollEvents.push({
            type,
            target: event.target.tagName,
            id: event.target.id,
            x: event.clientX,
            y: event.clientY,
            hidden: document.querySelector('.cctv-catalogue-picker').hidden,
          }),
        true,
      );
  });
  const protocolBounds = await (
    await page.$('.cctv-catalogue-picker-viewport')
  ).boundingBox();
  const bounds = await page.$eval(
    '.cctv-catalogue-picker-viewport',
    (viewport) => viewport.getBoundingClientRect().toJSON(),
  );
  console.log(
    'SCROLLBAR COORDINATES',
    JSON.stringify({ protocolBounds, bounds }),
  );
  await page.screenshot({ path: `${out}/before-scrollbar.png` });
  await page.mouse.click(
    bounds.x + bounds.width - 4,
    bounds.y + bounds.height - 15,
  );
  result.scrollbar = await page.evaluate(() => ({
    events: window.pickerScrollEvents,
    hidden: document.querySelector('.cctv-catalogue-picker').hidden,
  }));
  console.log(
    'SCROLLBAR CHECK',
    JSON.stringify({ bounds, ...result.scrollbar }),
  );
  await page.waitForSelector('.cctv-catalogue-picker:not([hidden])');
  await page.focus(search);
  await page.keyboard.press('End');
  assert.equal(
    await page.$eval('[role=option][aria-selected=true]', (row) =>
      Number(row.getAttribute('aria-posinset')),
    ),
    result.total,
  );
  await page.screenshot({ path: `${out}/final-row.png` });
  // Select the final row by keyboard, then middle and first by mouse search.
  for (const [n, index] of [
    records.ids.length - 1,
    Math.floor(records.ids.length / 2),
    0,
  ].entries()) {
    const id = records.ids[index];
    if (n) {
      await page.click(search);
      await page.$eval(
        search,
        (input, value) => {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        id,
      );
      await page.waitForFunction(
        (id) => {
          const rows = [
            ...document.querySelectorAll('.cctv-catalogue-picker-row'),
          ];
          return rows.length === 1 && rows[0].dataset.cameraId === id;
        },
        {},
        id,
      );
      await page.click('.cctv-catalogue-picker-row');
    } else await page.keyboard.press('Enter');
    await page.waitForFunction(
      (id) =>
        window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
          .activeCameraId === id,
      { timeout: 30000 },
      id,
    );
    result.selections.push({ position: index + 1, id, selected: true });
  }
  await page.click(search);
  await page.$eval(
    search,
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    records.provider,
  );
  const expected = await page.evaluate((provider) => {
    const cameras = window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getUIState().cameras;
    const words = provider.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return cameras.filter((c) =>
      words.every((w) =>
        `${c.name} ${c.city} ${c.provider} ${c.id} ${c.code || ''}`
          .toLocaleLowerCase()
          .includes(w),
      ),
    ).length;
  }, records.provider);
  await page.waitForFunction(
    (expected) =>
      Number(
        document
          .querySelector('.cctv-catalogue-picker-row')
          ?.getAttribute('aria-setsize'),
      ) === expected,
    {},
    expected,
  );
  assert.ok(expected > 128, 'Broad query must exercise more than 128 matches');
  await page.keyboard.press('End');
  assert.equal(
    await page.$eval('[role=option][aria-selected=true]', (row) =>
      Number(row.getAttribute('aria-posinset')),
    ),
    expected,
  );
  result.broadSearch = {
    query: records.provider,
    matches: expected,
    finalMatchReached: true,
  };
  await page.screenshot({ path: `${out}/broad-search-last.png` });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  await fs.writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  if (!page.isClosed()) await page.close();
  await browser.disconnect();
}
