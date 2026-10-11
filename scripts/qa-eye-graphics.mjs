import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
const dir='/tmp/childs-eye-evidence';await fs.mkdir(dir,{recursive:true});
const browser=await puppeteer.launch({headless:true,defaultViewport:{width:1920,height:1080},protocolTimeout:180000,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try{
 for(const [label,port] of [['before',4177],['after',4176]]){
  const page=await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/?welcome=0`,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>!!window.__godsEyeView,{timeout:120000});
  await page.evaluate(async()=>{await window.__godsEyeView.styleManager.initialRestorePromise;});
  await new Promise(r=>setTimeout(r,3000));
  for(const [place,lon,lat,height] of [['toronto',-79.3832,43.6532,9000],['manhattan',-73.9857,40.7484,6000],['alps',7.6586,45.9763,15000]]){
   const position=await page.evaluate(async({lon,lat,height,label})=>{
    const g=window.__godsEyeView,c=window.__CESIUM__;
    g.viewer.trackedEntity=undefined;g.viewer.camera.cancelFlight();g.viewer.camera.lookAtTransform(c.Matrix4.IDENTITY);
    if(label==='after') await g.styleManager.applyVisualState({style:'normal',scope:{enabled:false},bloom:{enabled:false},sharpen:{enabled:true,intensity:25},hud:{visible:false}});
    g.viewer.camera.setView({destination:c.Cartesian3.fromDegrees(lon,lat,height),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});
    g.viewer.scene.requestRender();
    const p=g.viewer.camera.positionCartographic;return {lon:c.Math.toDegrees(p.longitude),lat:c.Math.toDegrees(p.latitude),height:p.height};
   },{lon,lat,height,label});
   await new Promise(r=>setTimeout(r,12000));
   const measured=await page.evaluate(async()=>{
    const {holdContinuousRender,releaseContinuousRender}=await import('/src/renderGovernor.js');
    holdContinuousRender('eye-qa');const times=[];const off=window.__godsEyeView.viewer.scene.postRender.addEventListener(()=>times.push(performance.now()));
    await new Promise(r=>setTimeout(r,5000));off();releaseContinuousRender('eye-qa');
    const c=window.__CESIUM__,v=window.__godsEyeView.viewer,p=v.camera.positionCartographic;
    const gl=v.scene.context._gl,ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {fps:times.length>1?(times.length-1)*1000/(times.at(-1)-times[0]):0,frames:times.length,lon:c.Math.toDegrees(p.longitude),lat:c.Math.toDegrees(p.latitude),height:p.height,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown'};
   });
   await page.screenshot({path:`${dir}/${label}-${place}.png`});results.push({label,place,requested:position,measured});console.log(JSON.stringify(results.at(-1)));
  }await page.close();
 }
 await fs.writeFile(`${dir}/graphics-results.json`,JSON.stringify(results,null,2));
}finally{await browser.close();}
