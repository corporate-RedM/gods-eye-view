import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.EYE_QA_URL || 'http://127.0.0.1:4176';
const dir = '/tmp/childs-eye-evidence';
await fs.mkdir(dir, { recursive:true });
const browser = await puppeteer.launch({ headless:true, defaultViewport:{ width:1920,height:1080 }, protocolTimeout:180000,
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage(); const errors=[];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(base + '?welcome=0', { waitUntil:'domcontentloaded', timeout:90000 });
  await page.waitForFunction(() => !!window.__godsEyeView?.workspace, { timeout:120000 });
  await page.evaluate(async () => {
    await window.__godsEyeView.styleManager.initialRestorePromise;
    const {viewer} = window.__godsEyeView;
    viewer.camera.cancelFlight();
    viewer.camera.lookAtTransform(window.__CESIUM__.Matrix4.IDENTITY);
    await window.__godsEyeView.styleManager.applyVisualState({style:'normal',scope:{enabled:false},bloom:{enabled:false},hud:{visible:false}});
    viewer.camera.setView({ destination:window.__CESIUM__.Cartesian3.fromDegrees(-79.3832,43.6532,9000), orientation:{ heading:0,pitch:-Math.PI/2,roll:0 } });
  });
  await new Promise(r => setTimeout(r, 6000));
  await page.screenshot({ path:`${dir}/toronto-globe.png` });
  for (const tab of ['Overview','Cameras','Areas','Investigate','Forecast','Tools']) {
    await page.evaluate(tab => window.__godsEyeView.workspace.open(tab), tab);
    await new Promise(r => setTimeout(r, tab === 'Cameras' ? 20000 : 1200));
    await page.screenshot({ path:`${dir}/${tab.toLowerCase()}.png` });
    console.log(tab, await page.$eval('#eye-workspace', el => el.innerText.slice(0,700)));
  }
  const check = await page.evaluate(async () => {
    const options = await (await fetch('/api/eye/oi')).json();
    const disabled = await fetch('/api/eye/oi/runs', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({question:'Will this test start without a key?'}) });
    return { providers:options.providers.length, keylessStatus:disabled.status,
      watch:await (await fetch('/api/cctv/watch/state')).json(), title:document.title };
  });
  assert.ok(check.providers > 0); assert.ok(check.keylessStatus >= 400); assert.equal(check.title,"Child's Eye");
  console.log(JSON.stringify({ check, errors },null,2));
  await fs.writeFile(`${dir}/ui-results.json`, JSON.stringify({check,errors},null,2));
  assert.equal(errors.length,0,errors.join('\n'));
} finally { await browser.close(); }
