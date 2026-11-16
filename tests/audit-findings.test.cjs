const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runPlan,formatPrice,tickPrecision,roundToTick,mergeRefreshBars,groupAxisLevels,contiguousTail}=require('../core.js');
const {MarketClient,Selection}=require('../market.js');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const H4=14400000;
const bar=(t,c=100)=>({t,o:100,h:101,l:99,c,v:1,ct:t+H4-1});
test('prehistory daily signals cannot acquire the first loaded candle as a fake entry or R',()=>{
  const rows=Array.from({length:30},(_,i)=>bar((100+i)*H4));
  const p=runPlan({t:H4,dir:1,stop:1,mod:'일봉'},rows,Infinity,140*H4);
  assert.equal(p.state,'범위 밖');assert.equal(p.ref,undefined);assert.equal(p.r,undefined);
});
test('missing exact entry and incomplete expiry histories are excluded instead of fabricating results',()=>{
  const missing=runPlan({t:H4,dir:1,stop:5},[bar(0),bar(2*H4)],Infinity,3*H4);
  assert.equal(missing.state,'범위 밖');assert.equal(missing.r,undefined);
  const expiry=runPlan({t:0,dir:1,stop:5},[bar(0)],Infinity,20*H4);
  assert.equal(expiry.state,'범위 밖');assert.equal(expiry.r,undefined);
});
test('future signals stay pending while a known entry at the first loaded candle is legitimate',()=>{
  assert.equal(runPlan({t:2*H4,dir:1,stop:5},[bar(0)],Infinity,H4).state,'대기');
  const first=runPlan({t:0,dir:1,stop:5},[bar(0)],Infinity,H4);
  assert.equal(first.ref,100);assert.equal(first.state,'진행');
});
test('refreshing analysis does not stop the active socket or invalidate current callbacks on failure',async()=>{
  const error=new Error('temporary server failure');
  const selection=new Selection({snapshot:async()=>{throw error;}});
  const socket={close(){throw new Error('socket was closed');}};selection.socket=socket;
  const data={version:selection.version,symbol:'BTCUSDT',timeframe:'4h'};
  await assert.rejects(selection.refresh(data),/temporary/);
  assert.equal(selection.socket,socket);assert.ok(selection.current(data));
});
test('a completed analysis refresh invalidates older in-flight quote responses without changing selection',async()=>{
  let resolve;
  const selection=new Selection({snapshot:async(symbol,timeframe)=>({symbol,timeframe}),klines:()=>new Promise(r=>resolve=r)});
  const data=await selection.load('BTCUSDT','4h'),poll=selection.latest(data);
  const next=await selection.refresh(data);resolve([bar(0)]);
  assert.equal(await poll,null);assert.ok(selection.current(data));assert.ok(selection.current(next));
});
test('refresh merges only newer live tail while retaining fresh historical data',()=>{
  const fetched=[bar(0,90),bar(H4,100),bar(2*H4,100)],current=[bar(0,80),bar(H4,110),bar(2*H4,120),bar(3*H4,130)];
  const rows=mergeRefreshBars(fetched,current,H4);
  assert.deepEqual(rows.map(b=>b.c),[90,110,120,130]);
});
test('viewed candles are retained when the rolling REST window drops its oldest candle',()=>{
  const rows=mergeRefreshBars([bar(H4,110),bar(2*H4,120)],[bar(0,100),bar(H4,90)],Infinity,{from:0,to:H4});
  assert.deepEqual(rows.map(b=>b.t),[0,H4,2*H4]);assert.equal(rows[1].c,110);
});
test('retained historical viewport candles cannot invent continuity across a missing time span',()=>{
  const rows=[bar(0),bar(H4),bar(10*H4),bar(11*H4)];
  assert.deepEqual(contiguousTail(rows,H4).map(b=>b.t),[10*H4,11*H4]);
});
test('ETH and BTC keep exchange tick precision rather than magnitude-based rounding',()=>{
  assert.equal(formatPrice(3012.37,'0.01000000'),'3,012.37');
  assert.equal(formatPrice(64277.1,'0.10000000'),'64,277.1');
  assert.equal(formatPrice(0.00000371,'0.00000001'),'0.00000371');
  assert.equal(tickPrecision('0.01000000'),2);
});
test('non-power-of-ten ticks use valid multiples and do not alter stored analysis values',()=>{
  assert.equal(formatPrice(100.13,'0.25000000'),'100.25');
  assert.equal(roundToTick(3012.375,'0.01'),3012.38);
  assert.equal(formatPrice(NaN,'0.01'),'—');
});
test('nearby resistance captions combine without averaging away actual level prices',()=>{
  const groups=groupAxisLevels([{p:74810,title:'저항 1회'},{p:74909,title:'1W 저항'},{p:76270,title:'저항 1회'}],64000,1500);
  assert.equal(groups.length,1);assert.equal(groups[0].items.length,3);assert.equal(groups[0].p,74810);
  assert.equal(groups[0].low,74810);assert.equal(groups[0].high,76270);
});
test('caption grouping never mixes support with resistance or merges distant levels',()=>{
  const groups=groupAxisLevels([{p:99},{p:101},{p:200}],100,10);
  assert.equal(groups.length,3);assert.equal(groups[0].side,'sup');assert.equal(groups[1].side,'res');
});
test('429 pauses all REST paths and honors a longer Retry-After without issuing more fetches',async()=>{
  let calls=0;
  const client=new MarketClient(async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '120'}};});
  await assert.rejects(client.json('/first'),error=>error.status===429&&error.retryAfterMs>=119000);
  await assert.rejects(client.json('/second'),/조회 제한/);assert.equal(calls,1);
});
test('418 uses a ban cooldown and cannot trigger an automatic request storm',async()=>{
  let calls=0;const client=new MarketClient(async()=>{calls++;return {ok:false,status:418};});
  await assert.rejects(client.json('/first'),error=>error.status===418&&error.retryAfterMs>=899000);
  await assert.rejects(client.json('/second'),/조회 제한/);assert.equal(calls,1);
});
test('exchange metadata is shared across callers and uses PRICE_FILTER tickSize',async()=>{
  let calls=0;const client=new MarketClient(async()=>{calls++;return {ok:true,json:async()=>({symbols:[{symbol:'ETHUSDT',pricePrecision:3,filters:[{filterType:'PRICE_FILTER',tickSize:'0.01000000'}]}]})};});
  await Promise.all([client.exchangeInfo(),client.exchangeInfo()]);await client.exchangeInfo();
  assert.equal(calls,1);assert.equal(client.symbolMeta.get('ETHUSDT').tickSize,'0.01000000');
});
test('simultaneous price alerts retain every crossed level in one notification',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const code=app.slice(app.indexOf('function checkAlerts(currentPrice)'),app.indexOf('function notifyNew()'));
  const messages=[],saved=[];
  const context={readDrawings:()=>[{p:101,dir:1},{p:102,dir:1}],store:{set:(key,values)=>{saved.push(values);return true;}},drawingKey:()=> 'alerts',state:{data:{symbol:'BTCUSDT'}},price:String,notify:(...args)=>messages.push(args),render(){}};
  vm.createContext(context);vm.runInContext(code+'\ncheckAlerts(103)',context);
  assert.equal(messages.length,1);assert.match(messages[0][0],/2건/);assert.match(messages[0][1],/101/);assert.match(messages[0][1],/102/);assert.equal(saved[0].length,0);
});
test('active plan includes entry reference and current R with risk before reward',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const code=app.slice(app.indexOf('function planHtml('),app.indexOf('function renderPanel('));
  const context={H:3600000,side:()=> 'LONG',price:String,pct:(a,b)=>(a/b-1)*100,sgn:n=>(n>=0?'+':'')+n.toFixed(2)};
  vm.createContext(context);vm.runInContext(code,context);
  const html=vm.runInContext("planHtml({state:'진행',dir:1,ref:100,sl:95,tp:110,t:0},105,3600000)",context);
  assert.match(html,/기준 100/);assert.match(html,/현재 \+1\.00R/);assert.ok(html.indexOf('손절')<html.indexOf('목표'));
});
