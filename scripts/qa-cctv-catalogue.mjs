import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.EYE_QA_URL || 'http://127.0.0.1:4173';
const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => document.addEventListener('DOMContentLoaded', () => {
    const chip = document.getElementById('cctv-sync-chip');
    window.catalogueEvidence = [];
    const capture = () => {
      const state = window.__godsEyeView?.dataManager.layers.get('cctv')?.module?.getUIState?.();
      window.catalogueEvidence.push({
        time: performance.now(),
        label: document.getElementById('cctv-sync-label').textContent,
        counter: document.getElementById('cctv-sync-progress').textContent,
        visible: chip.classList.contains('visible'),
        progress: state?.catalogueLoading,
        count: state?.count,
        published: state?.cameras.length,
      });
    };
    window.catalogueObserver = new MutationObserver(capture);
    window.catalogueObserver.observe(chip, { childList: true, subtree: true, attributes: true });
  }));
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!window.__godsEyeView?.workspace, { timeout: 120000 });
  console.log('App ready; observing camera catalogue registration');
  await page.evaluate(() => {
    const state = window.__godsEyeView.dataManager.layers.get('cctv')?.module.getUIState();
    if (!state?.enabled && !state?.catalogueLoading?.active) document.getElementById('cctv-enable-btn').click();
  });
  const started = performance.now();
  await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('cctv')?.module.getUIState().enabled, { timeout: 240000 });
  const enableMs = Math.round(performance.now() - started);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const result = await page.evaluate(() => {
    window.catalogueObserver.disconnect();
    const s = window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState();
    return {
      count: s.count, published: s.cameras.length, progress: s.catalogueLoading,
      counter: document.getElementById('cctv-sync-progress').textContent,
      detail: document.getElementById('cctv-sync-detail')?.textContent ?? null,
      visible: document.getElementById('cctv-sync-chip').classList.contains('visible'),
      samples: window.catalogueEvidence,
    };
  });
  result.enableMs = enableMs;
  result.errors = errors;
  assert.ok(result.count > 70000);
  assert.equal(result.published, result.count);
  assert.equal(result.progress.loaded, result.count);
  assert.equal(result.progress.total, result.count);
  assert.equal(result.counter, `${result.count.toLocaleString('en-US')} / ${result.count.toLocaleString('en-US')} cameras`);
  assert.ok(result.visible);
  const batches = result.samples.filter((s) => s.progress?.phase === 'registering' && s.progress.loaded > 0 && s.progress.loaded < s.progress.total);
  assert.ok(batches.length > 1, 'the real browser paints intermediate catalogue progress');
  for (let i = 0; i < batches.length; i++) {
    const sample = batches[i];
    assert.ok(sample.visible);
    assert.equal(sample.count, sample.progress.loaded);
    assert.equal(sample.published, 0, 'partial lists must not be rebuilt for every progress event');
    assert.ok(!i || sample.progress.loaded >= batches[i - 1].progress.loaded);
  }
  assert.equal(result.detail, null, 'terrain positioning stays in the background');
  assert.deepEqual(errors, []);
  await fs.mkdir('output/completion', { recursive: true });
  await page.screenshot({ path: 'output/completion/camera-catalogue-progress.png' });
  await fs.writeFile('output/completion/camera-catalogue-progress.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ count: result.count, counter: result.counter, detail: result.detail, intermediateSamples: batches.length, enableMs, errors }, null, 2));
} finally {
  await browser.close();
}
