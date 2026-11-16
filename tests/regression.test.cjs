const {test}=require('node:test');
const assert=require('node:assert/strict');
const {weekly,eventBar,candleRange,candleTimeRange,analyze,runPlan,combine}=require('../core.js');
const {MarketClient,Selection}=require('../market.js');
const DAY=86400000,H4=14400000;
const bar=(t=0,extra={})=>({t,o:100,h:105,l:95,c:101,v:10,ct:t+DAY-1,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('current week is excluded until actual Monday boundary, including one-day partial week',()=>{
  const monday=Date.UTC(2026,10,9), now=monday+3*DAY;
  const days=Array.from({length:10},(_,i)=>bar(monday-7*DAY+i*DAY));
  const weeks=weekly(days);
  assert.equal(weeks.length,2);
  assert.equal(weeks[1].ct,monday+7*DAY-1);
  assert.equal(weeks.filter(w=>w.ct<now).length,1);
  assert.equal(weekly([bar(monday)])[0].ct,monday+7*DAY-1);
});
test('signal markers use containing candle and never attach out-of-history events to first bar',()=>{
  const rows=[bar(10,{ct:19}),bar(20,{ct:29})];
  assert.equal(eventBar(rows,9),null);assert.equal(eventBar(rows,10),10);
  assert.equal(eventBar(rows,15),10);assert.equal(eventBar(rows,20),20);
  assert.equal(eventBar(rows,30),null);
});
test('Auto uses visible wick extrema and excludes off-screen spike',()=>{
  const rows=[bar(0,{h:10000}),bar(1,{l:90,h:110}),bar(2,{l:95,h:120})];
  const range=candleRange(rows,{from:1,to:2});
  assert.ok(range.minValue<90);assert.ok(range.maxValue>120);assert.ok(range.maxValue<130);
  assert.equal(candleRange([],{from:0,to:1}),null);
});
test('Auto uses actual visible timestamps, independent of other series logical indices',()=>{
  const rows=[bar(10,{h:10000}),bar(20,{h:120,l:90}),bar(30,{h:130,l:95})];
  assert.deepEqual(candleTimeRange(rows,20,30),candleRange(rows,{from:1,to:2}));
  assert.equal(candleTimeRange(rows,40,50),null);
});
test('unclosed daily/4H candles cannot create confirmed direction changes',()=>{
  const now=Date.UTC(2026,10,16,10), d1=Array.from({length:80},(_,i)=>bar(now-(80-i)*DAY,{c:100+i,h:200,l:90}));
  const h4=Array.from({length:120},(_,i)=>bar(now-(120-i)*H4,{ct:now-(119-i)*H4-1,c:100+i,h:250,l:90}));
  const before=analyze(h4,d1,now);
  const after=analyze([...h4,bar(now,{ct:now+H4-1,c:1,h:999,l:.5})],[...d1,bar(now,{ct:now+DAY-1,c:1,h:999,l:.5})],now);
  assert.equal(before.dailySide,after.dailySide);assert.equal(before.ichiSide,after.ichiSide);
  assert.deepEqual(before.plans,after.plans);
});
test('same-bar stop/target tie remains conservative and conflicting simultaneous signals remain WAIT',()=>{
  const signal={t:0,dir:1,stop:5,mod:'4H'};
  const plan=runPlan(signal,[bar(0,{h:120,l:90,ct:H4-1})],Infinity,H4+1);
  assert.equal(plan.state,'손절');assert.equal(plan.r,-1);
  assert.deepEqual(combine([signal],[{...signal,dir:-1,mod:'일봉'}]),[]);
});
test('out-of-order REST success is discarded even if old fetch ignores abort',async()=>{
  const requests=[];const selection=new Selection({snapshot:(...args)=>{const d=deferred();requests.push({args,...d});return d.promise;}});
  const old=selection.load('BTCUSDT','4h');const next=selection.load('ETHUSDT','15m');
  assert.equal(requests[0].args[2].aborted,true);
  requests[1].resolve({symbol:'ETHUSDT',timeframe:'15m'});const data=await next;
  requests[0].resolve({symbol:'BTCUSDT',timeframe:'4h'});assert.equal(await old,null);assert.ok(selection.current(data));
});
test('out-of-order REST error cannot replace newer selection with error state',async()=>{
  const a=deferred(),b=deferred();let count=0;
  const selection=new Selection({snapshot:()=>++count===1?a.promise:b.promise});
  const old=selection.load('BADUSDT','4h'),next=selection.load('BTCUSDT','4h');
  b.resolve({symbol:'BTCUSDT'});await next;a.reject(new Error('old error'));assert.equal(await old,null);
});
test('closed/replaced socket and incorrect market identity cannot update current chart',async()=>{
  class Socket {constructor(url){this.url=url;this.close=()=>{};}}
  const selection=new Selection({snapshot:async(symbol,timeframe)=>({symbol,timeframe})});
  const a=await selection.load('BTCUSDT','4h');let updates=0;
  selection.connect(a,{tick:()=>updates++},Socket);const old=selection.socket.onmessage;
  const b=await selection.load('ETHUSDT','15m');selection.connect(b,{tick:()=>updates++},Socket);
  const message=(s,i)=>({data:JSON.stringify({s,k:{i,t:0,T:100,o:100,h:110,l:90,c:101,v:2}})});
  old(message('BTCUSDT','4h'));assert.equal(updates,0);
  selection.socket.onmessage(message('BTCUSDT','15m'));assert.equal(updates,0);
  selection.socket.onmessage(message('ETHUSDT','4h'));assert.equal(updates,0);
  selection.socket.onmessage(message('ETHUSDT','15m'));assert.equal(updates,1);
});
test('futures failure never falls back to spot and snapshot frame requests are deduplicated',async()=>{
  const urls=[];const client=new MarketClient(async url=>{urls.push(url);return {ok:false,status:503};});
  await assert.rejects(client.snapshot('BTCUSDT','4h'),/503/);
  assert.equal(urls.length,2);assert.ok(urls.every(url=>url.startsWith('https://fapi.binance.com/')));
});
test('malformed or unordered candles are rejected',async()=>{
  const client=new MarketClient(async()=>({ok:true,json:async()=>[[2,'100','90','95','100','2',3]]}));
  await assert.rejects(client.klines('BTCUSDT','4h'),/무결성/);
});
test('valid single-letter and Unicode perpetual symbols are encoded and supported',async()=>{
  const urls=[];
  const client=new MarketClient(async url=>{urls.push(url);return {ok:true,json:async()=>[[0,'100','110','90','101','2',100]]};});
  await client.klines('TUSDT','4h');await client.klines('币安人生USDT','4h');
  assert.ok(urls[0].includes('symbol=TUSDT'));assert.ok(urls[1].includes('symbol=%'));
  await assert.rejects(client.klines('<script>USDT','4h'),/심볼/);
});
test('missing candle intervals are surfaced instead of silently drawing a continuous history',async()=>{
  const client=new MarketClient(async()=>({ok:true,json:async()=>[[0,'100','110','90','101','2',100],[H4*2,'100','110','90','101','2',H4*3-1]]}));
  await assert.rejects(client.klines('BTCUSDT','4h'),/누락/);
});
test('independent futures metrics expose partial failures without fabricated zero',async()=>{
  const client=new MarketClient(async url=>url.includes('openInterest')?{ok:false,status:503}:{ok:true,json:async()=>({symbol:'BTCUSDT'})});
  const metrics=await client.futures('BTCUSDT');assert.deepEqual(metrics.errors,['oi']);assert.equal(metrics.oi,undefined);assert.ok(metrics.premium);
});
