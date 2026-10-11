import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.EYE_QA_URL || 'http://127.0.0.1:4180';
const browser=await puppeteer.launch({headless:true,defaultViewport:{width:1440,height:1000},protocolTimeout:240000,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage(), errors=[];
page.on('pageerror',e=>errors.push(e.message));
const result={base};
try {
  const started=performance.now();
  await page.goto(base+'/?welcome=0',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>!!window.__godsEyeView?.workspace,{timeout:120000});
  result.bootMs=Math.round(performance.now()-started);
  console.log('Workspace ready', result.bootMs);
  await page.evaluate(async()=>{await window.__godsEyeView.styleManager?.initialRestorePromise;});
  await new Promise(r=>setTimeout(r,3000));
  const enabled=performance.now();
  await page.evaluate(()=>document.getElementById('cctv-enable-btn').click());
  await page.waitForFunction(()=>window.__godsEyeView.dataManager.layers.get('cctv')?.module.getUIState().enabled,{timeout:240000});
  result.enableMs=Math.round(performance.now()-enabled);
  console.log('CCTV enabled', result.enableMs);
  result.camera=await page.evaluate(async()=>{
    const app=window.__godsEyeView, layer=app.dataManager.layers.get('cctv').module;
    const s=layer.getUIState();
    const first=s.activeCameraId;
    document.getElementById('cctv-nearest-btn').click();
    await new Promise(r=>setTimeout(r,2500));
    return {count:s.cameras.length,first,nearest:layer.getUIState().activeCameraId,options:document.getElementById('cctv-camera-select').options.length};
  });
  assert.ok(result.camera.count>20000);assert.notEqual(result.camera.first,result.camera.nearest);assert.ok(result.camera.options<=251);
  result.search=await page.evaluate(()=>{
    const cams=window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState().cameras;
    const last=cams.at(-1).id;const search=document.getElementById('cctv-camera-search');
    search.value=last;search.dispatchEvent(new Event('input'));
    const found=[...document.getElementById('cctv-camera-select').options].some(o=>o.value===last);
    search.value='';search.dispatchEvent(new Event('input'));return {last,found};
  });
  assert.ok(result.search.found);
  await page.evaluate(()=>window.__godsEyeView.workspace.open('Broadcasts'));
  await page.waitForFunction(()=>document.querySelector('#eye-workspace').textContent.includes('23 channels'));
  assert.equal(await page.$$eval('#eye-workspace .eye-card',n=>n.length),23);
  await page.evaluate(()=>[...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent==='Watch').click());
  assert.equal(await page.$$eval('#eye-workspace iframe',n=>n.length),1);
  await page.evaluate(()=>window.__godsEyeView.workspace.open('Forecast'));
  await page.waitForSelector('#eye-workspace input[type=file]');
  assert.equal(await page.$$eval('#eye-workspace iframe',n=>n.length),0);
  await page.evaluate(()=>window.__godsEyeView.workspace.open('Assistant'));
  await page.waitForFunction(()=>[...document.querySelectorAll('#eye-workspace button')].some(b=>b.textContent==='Send'));
  // Exercise the real conversation UI without billing a model provider.
  await page.setRequestInterception(true);
  let step=0;
  page.on('request',req=>{
    if(req.url().endsWith('/api/eye/assistant'))return req.respond({status:200,contentType:'application/json',body:JSON.stringify(++step===1?{say:'Moving to Toronto.',actions:[{name:'move_globe',args:{lat:43.65,lon:-79.38,height:20000}}],done:false}:{say:'The globe is now in Toronto.',actions:[],done:true})});
    req.continue();
  });
  await page.evaluate(()=>{
    const p=document.querySelector('#eye-workspace');p.querySelector('input[type=password]').value='fixture-key-not-sent';p.querySelector('textarea').value='Show Toronto';
    [...p.querySelectorAll('button')].find(b=>b.textContent==='Send').click();
  });
  await page.waitForFunction(()=>document.querySelector('#eye-workspace').textContent.includes('globe is now in Toronto'));
  await new Promise(r=>setTimeout(r,2000));
  result.assistant=await page.evaluate(()=>{const c=window.__godsEyeView.viewer.camera.positionCartographic;return {lat:c.latitude*180/Math.PI,lon:c.longitude*180/Math.PI};});
  assert.ok(Math.abs(result.assistant.lat-43.65)<0.01);
  assert.ok(Math.abs(result.assistant.lon+79.38)<0.01);
  await fs.mkdir('output/completion',{recursive:true});
  await page.screenshot({path:'output/completion/assistant.png'});
  result.errors=errors;assert.deepEqual(errors,[]);
  await fs.writeFile('output/completion/browser.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
