import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base = process.env.EYE_QA_URL || 'http://127.0.0.1:4180';
const browser = await puppeteer.launch({headless:true, defaultViewport:{width:1440,height:1000}, protocolTimeout:240000,
 args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page = await browser.newPage(), errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(base+'/?welcome=0',{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForFunction(()=>!!window.__godsEyeView?.workspace,{timeout:120000});
 await page.evaluate(()=>window.__godsEyeView.workspace.open('Cameras'));
 await page.waitForFunction(()=>document.querySelectorAll('#eye-workspace select')[1]?.options.length>0,{timeout:360000});
 const result=await page.evaluate(async()=>{
   const payload=await(await fetch('/api/cctv/sources')).json();
   const picker=document.querySelectorAll('#eye-workspace select')[1];
   const first=picker.options[0].value;
   [...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent==='Next cameras').click();
   const next=picker.options[0].value;
   const embedded=payload.sources.find(c=>c.feedType==='iframe'&&c.embedUrl.includes('youtube'));
   const external=payload.sources.find(c=>c.feedType==='external');
   for(const c of [embedded,external]) {
     const opt=document.createElement('option');opt.value=c.id;opt.textContent=c.name;picker.append(opt);picker.value=c.id;
     [...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent==='Add to desk').click();
   }
   const frame=await fetch('/api/cctv/frame/'+encodeURIComponent(external.id));
   return {total:payload.sources.length,first,next,embedded:embedded.id,external:external.id,
      frames:document.querySelectorAll('.eye-camera iframe').length,links:document.querySelectorAll('.eye-camera a').length,
      externalFrameStatus:frame.status,coverageMode:payload.coverage.mode};
 });
 assert.ok(result.total>20000);assert.notEqual(result.first,result.next);
 assert.equal(result.frames,1);assert.equal(result.links,2);assert.equal(result.externalFrameStatus,422);
 await fs.mkdir('output/camera-coverage',{recursive:true});
 await page.screenshot({path:'output/camera-coverage/embedded-players.png'});
 await page.evaluate(()=>window.__godsEyeView.workspace.close());
 assert.equal(await page.$$eval('.eye-camera iframe',els=>els.length),0);
 // Test actual globe ingestion, not just the server catalogue and dropdown.
 await page.evaluate(()=>document.getElementById('cctv-enable-btn').click());
 await page.waitForFunction(()=>window.__godsEyeView.dataManager.layers.get('cctv')?.module?.getUIState?.().cameras?.length>20000,{timeout:240000});
 const globe=await page.evaluate(()=>{
   const state=window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState();
   return {count:state.cameras.length,external:state.cameras.filter(c=>['iframe','external'].includes(c.feedType)).length};
 });
 assert.ok(globe.count>=result.total); assert.ok(globe.external>0);
 assert.equal(errors.length,0,errors.join('\n'));
 await fs.writeFile('output/camera-coverage/browser.json',JSON.stringify({result,globe,errors},null,2));
 console.log(JSON.stringify({result,globe,errors},null,2));
} finally {await browser.close();}
