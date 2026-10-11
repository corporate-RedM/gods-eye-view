import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await puppeteer.launch({headless:true,defaultViewport:{width:1440,height:1000},args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage(), errors=[], requests=[];
page.on('pageerror',e=>errors.push(e.message));
await page.setRequestInterception(true);
const id='00000000-0000-4000-8000-000000000001';
const run={id,status:'done',phase_label:'Fixture scenario',usage:{calls:3,input:200,output:100},worlds:[{world:'A',events:[{title:'Fixture event',detail:'A simulated event for UI validation.',date:'2026-10-15',place:'Toronto',lat:43.65,lng:-79.38}]}],report:{headline:'Fixture forecast',answer:'A test scenario',confidence:'low',summary:'No inference was billed.'},sources:[]};
page.on('request',req=>{
  const url=new URL(req.url());
  if(url.pathname.startsWith('/api/eye/oi/runs')) {
    requests.push({path:url.pathname,method:req.method(),body:req.postData()?JSON.parse(req.postData()):null});
    if(url.pathname.endsWith('/events'))return req.respond({status:200,contentType:'text/event-stream',body:'data: {"t":"end","status":"done"}\n\n'});
    const result=url.pathname.endsWith('/inject')?{queued:true,lands_in_period:2}:url.pathname.endsWith('/ask')?{reply:'Fixture follow-up answer'}:req.method()==='POST'?{id,run_token:'fixture-token'}:run;
    return req.respond({status:200,contentType:'application/json',body:JSON.stringify(result)});
  }
  if(url.pathname==='/api/eye/news')return req.respond({status:200,contentType:'application/json',body:JSON.stringify({news:[{title:'Ukraine attack report fixture',url:'https://example.org/report',published:'2026-10-11'}]})});
  req.continue();
});
try {
  await page.goto('http://127.0.0.1:4180/?welcome=0',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>!!window.__godsEyeView?.workspace,{timeout:120000});
  await page.evaluate(()=>window.__godsEyeView.workspace.open('Forecast'));
  await page.waitForSelector('#eye-workspace input[type=file]');
  await page.evaluate(()=>{
    const p=document.querySelector('#eye-workspace');
    const find=text=>[...p.querySelectorAll('label')].find(l=>l.firstChild.textContent.startsWith(text)).querySelector('input,textarea,select');
    find('API key').value='fixture-key-never-sent';find('Research question').value='Will a local event change Toronto traffic?';
    const input=find('Load context file');const transfer=new DataTransfer();transfer.items.add(new File(['road,closure\nKing,yes'],'traffic.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(()=>[...document.querySelectorAll('#eye-workspace textarea')].some(t=>t.value.includes('King,yes')));
  await page.evaluate(()=>[...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent==='Start research').click());
  await page.waitForFunction(()=>document.querySelector('#eye-workspace').textContent.includes('Fixture forecast'),{timeout:20000});
  await page.evaluate(()=>{
    const p=document.querySelector('#eye-workspace');p.querySelector('input[type=password]').value='fixture-key-never-sent';
    [...p.querySelectorAll('label')].find(l=>l.firstChild.textContent.startsWith('Event to inject')).querySelector('textarea').value='Assume the road reopens tomorrow.';
    [...p.querySelectorAll('button')].find(b=>b.textContent==='Inject into next period').click();
  });
  await page.waitForFunction(()=>document.querySelector('#eye-workspace').textContent.includes('queued: true'));
  await page.evaluate(()=>[...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent.startsWith('Ask about run')).click());
  await page.waitForFunction(()=>document.querySelector('#eye-workspace').textContent.includes('Fixture follow-up answer'));
  await page.evaluate(()=>[...document.querySelectorAll('#eye-workspace button')].find(b=>b.textContent==='Show event').click());
  await new Promise(r=>setTimeout(r,2300));
  const playback=await page.evaluate(()=>{const app=window.__godsEyeView,c=app.viewer.camera.positionCartographic;return {lat:c.latitude*180/Math.PI,lon:c.longitude*180/Math.PI,points:app.viewer.dataSources.getByName('Simulated forecast')[0].entities.values.length};});
  assert.ok(Math.abs(playback.lat-43.65)<0.01);assert.equal(playback.points,1);
  assert.equal(requests.find(r=>r.path==='/api/eye/oi/runs'&&r.method==='POST').body.seed,'road,closure\nKing,yes');
  assert.ok(requests.some(r=>r.path.endsWith('/inject')));assert.ok(requests.some(r=>r.path.endsWith('/ask')));
  await fs.mkdir('output/completion',{recursive:true});await page.screenshot({path:'output/completion/forecast.png'});
  await page.evaluate(()=>window.__godsEyeView.workspace.open('Conflicts'));
  await page.waitForFunction(()=>document.querySelectorAll('#eye-workspace .eye-card').length===15);
  const conflict=await page.evaluate(()=>({points:window.__godsEyeView.viewer.dataSources.getByName('Conflict zones')[0].entities.values.length,forecastLayers:window.__godsEyeView.viewer.dataSources.getByName('Simulated forecast').length}));
  assert.equal(conflict.points,15);assert.equal(conflict.forecastLayers,0);
  await page.screenshot({path:'output/completion/conflicts.png'});
  await page.evaluate(()=>window.__godsEyeView.workspace.close());
  assert.equal(await page.evaluate(()=>window.__godsEyeView.viewer.dataSources.getByName('Conflict zones').length),0);
  assert.deepEqual(errors,[]);
  const result={playback,conflict,requests,errors,inference:'All model endpoints intercepted; no paid calls'};
  await fs.writeFile('output/completion/research.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
