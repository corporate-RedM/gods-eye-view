import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
const results=[];
for(const port of [4173,4180]) {
  const browser=await puppeteer.launch({headless:true,defaultViewport:{width:1280,height:900},protocolTimeout:240000,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?welcome=0`,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForFunction(()=>!!window.__godsEyeView?.workspace,{timeout:120000});
    await page.evaluate(async()=>{await window.__godsEyeView.styleManager?.initialRestorePromise;});
    await new Promise(r=>setTimeout(r,3000));
    const t=performance.now();
    await page.evaluate(()=>document.getElementById('cctv-enable-btn').click());
    await page.waitForFunction(()=>window.__godsEyeView.dataManager.layers.get('cctv')?.module.getUIState().enabled,{timeout:240000});
    const enableMs=Math.round(performance.now()-t);
    const state=await page.evaluate(()=>{
      const s=window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState();
      return {count:s.cameras.length,options:document.getElementById('cctv-camera-select').options.length,terrainQueue:s.loading};
    });
    results.push({port,enableMs,...state});console.log(JSON.stringify(results.at(-1)));
  }finally{await browser.close();}
}
await fs.mkdir('output/completion',{recursive:true});
await fs.writeFile('output/completion/camera-timing.json',JSON.stringify({renderer:'Headless Chromium SwiftShader, sequential single-run comparison; not a hardware FPS benchmark',results},null,2));
