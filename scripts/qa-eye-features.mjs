import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const url = 'http://127.0.0.1:4176/?welcome=0';
const dir = '/tmp/childs-eye-evidence'; await fs.mkdir(dir,{recursive:true});
const browser = await puppeteer.launch({ headless:true, defaultViewport:{width:1920,height:1080}, protocolTimeout:180000,
 args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', msg => { if (msg.type() === 'error') console.log('BROWSER',msg.text()); });
page.on('pageerror', error => console.log('PAGE',error.message));
page.on('requestfailed', request => { if (/vision|onnx|wasm/.test(request.url())) console.log('FAILED',request.url(),request.failure()); });
try {
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForFunction(()=>!!window.__godsEyeView?.workspace,{timeout:120000});
 await page.evaluate(async()=>{await window.__godsEyeView.styleManager.initialRestorePromise;window.__godsEyeView.workspace.open('Cameras');});
 await page.waitForFunction(()=>document.querySelectorAll('#eye-workspace select')[1]?.options.length > 0,{timeout:90000});
 const selected = await page.evaluate(async()=>{
  const all=(await(await fetch('/api/cctv/sources')).json()).sources;
  const selected=['ontario','caltrans','iowa511','osiris-netherlands'].map(pack=>all.find(c=>c.pack===pack)).filter(Boolean);
  const picker=document.querySelectorAll('#eye-workspace select')[1];
  for(const camera of selected){const o=document.createElement('option');o.value=camera.id;o.textContent=camera.name;picker.append(o);picker.value=camera.id;[...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent==='Add to desk').click();}
  return selected.map(c=>({id:c.id,pack:c.pack,type:c.feedType}));
 });
 await new Promise(r=>setTimeout(r,16000));
 const media = await page.evaluate(()=>[...document.querySelectorAll('.eye-camera')].map(c=>{const m=c.querySelector('video,img');return {name:c.querySelector('strong').textContent,ready:m.tagName==='VIDEO'?m.readyState>=2:m.naturalWidth>0,type:m.tagName,caption:c.querySelector('.eye-meta').textContent};}));
 console.log(JSON.stringify({selected,media},null,2));
 const analysis = await page.evaluate(async()=>{
  const image=[...document.querySelectorAll('.eye-camera img')].find(i=>i.naturalWidth>0);
  if(!image) return {unavailable:'No live snapshot answered'};
  const {analyseBitmap}=await import('/integrations/osiris/lib/vision/client.js');
  return analyseBitmap(await createImageBitmap(image),new Date().toISOString(),'qa-real-camera');
 });
 console.log('LOCAL VISION',JSON.stringify(analysis));
 await page.screenshot({path:`${dir}/camera-desk.png`});
 assert.ok(media.some(m=>m.ready),'At least one real camera must load');
 assert.ok(analysis.counts,'The local vision model must execute on a real camera frame');
 const watched = await page.evaluate(()=>{
  const card=[...document.querySelectorAll('.eye-camera')].find(c=>c.querySelector('img')?.naturalWidth>0);
  if(!card) throw new Error('A real snapshot is required for the watch check');
  card.dataset.qaWatch='true';
  [...card.querySelectorAll('button')].find(b=>b.textContent==='Watch 30 s').click();
  return card.querySelector('strong').textContent;
 });
 await page.waitForFunction(()=>{
  const card=document.querySelector('[data-qa-watch]');
  return [...card.querySelectorAll('button')].find(b=>b.textContent==='Watch 30 s').disabled;
 });
 await page.waitForFunction(()=>{
  const card=document.querySelector('[data-qa-watch]');
  return ![...card.querySelectorAll('button')].find(b=>b.textContent==='Watch 30 s').disabled;
 },{timeout:90000});
 const watchSummary=await page.$eval('[data-qa-watch] .eye-meta',el=>el.textContent);
 assert.match(watchSummary,/Observed|seconds|frames|over \d+s/i);
 console.log('WATCH',watched,watchSummary);
 const dns = await page.evaluate(async()=>({status:(await fetch('/api/eye/osint/dns?domain=example.com')).status}));
 assert.equal(dns.status,200);
 const badOrigin=await fetch('http://127.0.0.1:4176/api/eye/oi',{headers:{Origin:'https://example.com'}}); assert.equal(badOrigin.status,403);
 await page.evaluate(()=>window.__godsEyeView.workspace.close());
 assert.equal(await page.$$eval('.eye-camera',els=>els.length),0);
 await fs.writeFile(`${dir}/feature-results.json`,JSON.stringify({selected,media,analysis,watched,watchSummary,dns,foreignOriginStatus:badOrigin.status},null,2));
}finally{await browser.close();}
