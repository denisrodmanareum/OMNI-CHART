const {test}=require('node:test');
const assert=require('node:assert/strict');
const {shockEvents,liveShock,rsi,bollinger}=require('../core.js');
const STEP=3600000;
// 폭 2의 잔잔한 봉 뒤에 원하는 종가 흐름을 붙인다.
function series(closes){
  const out=[];let prev=100;
  for(let i=0;i<30;i++){const c=100+(i%2?0.5:-0.5);out.push({t:i*STEP,o:prev,h:Math.max(prev,c)+0.75,l:Math.min(prev,c)-0.75,c,ct:(i+1)*STEP-1});prev=c;}
  for(const c of closes){const i=out.length;out.push({t:i*STEP,o:prev,h:Math.max(prev,c)+0.25,l:Math.min(prev,c)-0.25,c,ct:(i+1)*STEP-1});prev=c;}
  return out;
}
test('quiet candles produce no shock events',()=>{
  const r=shockEvents(series([100.2,99.9,100.3]),STEP);
  assert.deepEqual(r.events,[]);assert.equal(r.leg,null);
});
test('a single large down candle is a drop with an open leg and retracement levels',()=>{
  const bars=series([90]);const r=shockEvents(bars,STEP);
  assert.equal(r.events.length,1);assert.equal(r.events[0].type,'drop');assert.equal(r.events[0].t,bars.at(-1).t+STEP);
  assert.ok(r.events[0].mag>=2.5);assert.equal(r.leg.dir,-1);
  assert.ok(r.leg.extreme<r.leg.r382&&r.leg.r382<r.leg.r50&&r.leg.r50<r.leg.r618&&r.leg.r618<r.leg.origin);
});
test('consecutive drops stay one leg and a 50% close retrace confirms a rebound',()=>{
  const r=shockEvents(series([90,84,85,93]),STEP);
  assert.deepEqual(r.events.map(e=>e.type),['drop','rebound']);
  assert.equal(r.events[1].dir,1);assert.equal(r.leg,null);
});
test('a small bounce below 50% keeps the drop leg open',()=>{
  const r=shockEvents(series([90,91,92]),STEP);
  assert.deepEqual(r.events.map(e=>e.type),['drop']);assert.equal(r.leg.dir,-1);assert.equal(r.leg.since,2);
});
test('three-bar cumulative move is detected and surge then pullback mirrors the drop case',()=>{
  const r=shockEvents(series([104,108,112,105]),STEP);
  assert.deepEqual(r.events.map(e=>e.type),['surge','pullback']);
});
test('a leg expires after the window without a retrace',()=>{
  const closes=[90,...Array.from({length:14},(_,i)=>90+(i%2?0.2:-0.2))];
  const r=shockEvents(series(closes),STEP);
  assert.deepEqual(r.events.map(e=>e.type),['drop']);assert.equal(r.leg,null);
});
test('live shock flags only moves at or above the threshold',()=>{
  assert.equal(liveShock({o:100,c:99},1).dir,0);
  assert.equal(liveShock({o:100,c:97},1).dir,-1);
  assert.equal(liveShock({o:100,c:103},1).dir,1);
  assert.equal(liveShock({o:100,c:103},0),null);
});
test('rsi and bollinger basics',()=>{
  const up=Array.from({length:20},(_,i)=>({c:100+i}));
  assert.equal(rsi(up,14).at(-1),100);assert.equal(rsi(up,14)[13],null);
  const flat=Array.from({length:25},()=>({c:50}));
  assert.equal(rsi(flat,14).at(-1),50);
  const band=bollinger(flat).at(-1);assert.deepEqual(band,{mid:50,upper:50,lower:50});
  assert.equal(bollinger(flat)[18],null);
});
test('an opposite shock candle inside a drop leg is a strong rebound, not a new surge',()=>{
  const r=shockEvents(series([70,84]),STEP);
  assert.deepEqual(r.events.map(e=>e.type),['drop','rebound']);assert.equal(r.events[1].strong,true);assert.equal(r.leg,null);
});
test('macd waits for slow+signal bars and is zero on a flat series; vwap resets each UTC day',()=>{
  const {macd,vwap}=require('../core.js');
  const flat=Array.from({length:40},()=>({c:50}));
  const m=macd(flat);assert.equal(m[32],null);assert.deepEqual(m[33],{macd:0,signal:0,hist:0});
  const DAY=86400000,bars=[{t:0,h:12,l:8,c:10,v:1},{t:3600000,h:22,l:18,c:20,v:3},{t:DAY,h:32,l:28,c:30,v:2},{t:DAY+3600000,h:31,l:29,c:30,v:0}];
  assert.deepEqual(vwap(bars),[10,17.5,30,30]);
});
