import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import * as Cesium from 'cesium';
import { createNavigation } from '../layers/cctv/navigation.js';
import { assistantStep } from '../../server/standalone/eye-assistant.js';
import { scanHost } from '../../server/standalone/eye-scan.js';
import { broadcasts, conflictZones } from './eyeSources.js';
import { nearbyCameras } from '../layers/cctv/nearby.js';
import { cctvProxy } from '../../server/providers/cctv.js';

test('terrain refinement follows the viewed area without trimming the inventory',()=>{
  const cameras=Array.from({length:1000},(_,i)=>({id:String(i),lat:0,lon:-100+i/10}));
  const viewer={camera:{positionCartographic:Cesium.Cartographic.fromDegrees(-2,0)}};
  const local=nearbyCameras(cameras,viewer,16);
  assert.equal(cameras.length,1000);assert.equal(local.length,16);assert.equal(local[0].id,'980');
  viewer.camera.positionCartographic=Cesium.Cartographic.fromDegrees(-80,0);
  assert.equal(nearbyCameras(cameras,viewer,16)[0].id,'200');
});

test('camera media requests reuse the inventory index until the catalogue changes',async()=>{
  let reads=0;
  let rows=Array.from({length:10000},(_,i)=>({get id(){reads++;return String(i);},feedType:'external',externalUrl:'https://example.com'}));
  const plugin=cctvProxy({getSources:async()=>rows});
  let handler;
  plugin.configureServer({middlewares:{use(_route,fn){handler=fn;}}});
  const call=()=>handler({url:'/frame/9000',method:'GET'},{writeHead(){},end(){}});
  await call();const indexed=reads;
  await call();await call();
  assert.ok(reads-indexed<10,'frame requests must not walk all 10,000 IDs');
  rows=[...rows];await call();assert.ok(reads>=indexed+10000);
});

test('nearest uses the viewed area, switches away from the selected camera and respects feed filters', () => {
  const records=[
    {camera:{id:'old',lat:0,lon:0,feedType:'image'}},
    {camera:{id:'area',lat:40,lon:10,feedType:'image'}},
    {camera:{id:'next',lat:40.001,lon:10,feedType:'hls'}},
  ];
  const state={_records:records,_activeCameraId:'area',_viewer:{scene:{canvas:{clientWidth:100,clientHeight:100}},camera:{positionCartographic:Cesium.Cartographic.fromDegrees(0,0),pickEllipsoid:()=>Cesium.Cartesian3.fromDegrees(10,40)}}};
  const nav=createNavigation({state,parts:{model:{isVideoFeedType:t=>t==='hls',haversineKm:(a,b,c,d)=>Math.hypot(a-c,b-d)}}});
  assert.equal(nav.nearestCameraIdToViewer(), 'area');
  assert.equal(nav.nearestCameraIdToViewer('all',true), 'next');
  assert.equal(nav.nearestCameraIdToViewer('snapshot',true), 'old');
  state._viewer.camera.pickEllipsoid=()=>undefined;
  assert.equal(nav.nearestCameraIdToViewer(), 'old');
});

test('assistant returns validated native tool actions and rejects invented tool names', async () => {
  const body={messages:[{role:'user',text:'show news'}],tools:[{name:'eye_news',inputSchema:{type:'object'}}],context:{}};
  const creds={provider:'openai',key:'fixture-secret',model:'fixture'};
  const chat=async request=>{assert.match(request.system,/untrusted evidence/);return {text:JSON.stringify({say:'Checking headlines',actions:[{name:'eye_news',args:{}}],done:false}),input:20,output:10};};
  const result=await assistantStep(body,creds,undefined,chat);
  assert.equal(result.actions[0].name,'eye_news'); assert.equal(result.done,false);
  await assert.rejects(assistantStep(body,creds,undefined,async()=>({text:'{"actions":[{"name":"shell","args":{}}]}'})),/unavailable/);
});

test('TCP investigation reads a local service banner and rejects invalid port sets', async t => {
  const server=net.createServer(s=>s.end('SSH-2.0-owned-fixture\r\n'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const port=server.address().port;
  const result=await scanHost('127.0.0.1',[port]);
  assert.equal(result.ports[0].state,'open'); assert.match(result.ports[0].banner,/owned-fixture/);
  await assert.rejects(scanHost('127.0.0.1',[0]),/TCP ports/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(scanHost('127.0.0.1',[port],abort.signal),{name:'AbortError'});
});

test('all pinned Osiris broadcast channels and conflict anchors are included',()=>{
  assert.equal(broadcasts.length,23); assert.equal(new Set(broadcasts.map(f=>f.name)).size,23);
  assert.equal(conflictZones.length,15);
  for(const p of [...broadcasts,...conflictZones])assert.ok(Number.isFinite(p.lat)&&Number.isFinite(p.lng));
});
