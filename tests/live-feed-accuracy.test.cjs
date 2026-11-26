const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ema,macd,dailySignals,ichiSignals}=require('../core.js');
const {MarketClient,Selection,FUTURES_WS}=require('../market.js');
const DAY=86400000,H4=14400000;
const close=v=>({c:v});

test('kline and liquidation streams use the USD-M market path',()=>{
  assert.equal(FUTURES_WS,'wss://fstream.binance.com/market/ws/');
  const urls=[];
  class FakeSocket{constructor(url){urls.push(url);}close(){}}
  const selection=new Selection(new MarketClient(async()=>({ok:true,json:async()=>[]})));
  selection.connect({symbol:'BTCUSDT',timeframe:'4h',version:selection.version},{},FakeSocket);
  assert.deepEqual(urls,['wss://fstream.binance.com/market/ws/btcusdt@kline_4h']);
});

test('EMA starts from the simple average of the first n closes, like Pine ta.ema',()=>{
  const v=ema([1,2,3,4,5].map(close),3);
  assert.deepEqual(v.slice(0,2),[null,null]);
  assert.equal(v[2],2);
  assert.equal(v[3],4*0.5+2*0.5);
  assert.equal(v[4],5*0.5+3*0.5);
});

test('MACD outputs begin once the slow EMA and the signal average both exist',()=>{
  const bars=Array.from({length:60},(_,i)=>close(100+Math.sin(i/3)*5+i*0.2));
  const out=macd(bars);
  const first=out.findIndex(x=>x);
  assert.equal(first,26+9-2);
  const line=out.slice(first,first+1)[0];
  assert.ok(Number.isFinite(line.macd)&&Number.isFinite(line.signal)&&Number.isFinite(line.hist));
});

test('no signal on the first computable bar of a short history (new listing)',()=>{
  // Steady uptrend from the start: the first computable day already reads LONG but is not a direction change.
  const days=Array.from({length:40},(_,i)=>({t:i*DAY,o:100+i,h:101+i,l:99+i,c:100+i,ct:(i+1)*DAY-1}));
  assert.equal(dailySignals(days).out.length,0);
  // A later genuine turn still produces a signal.
  const turn=days.concat(Array.from({length:40},(_,i)=>{const c=140-i*1.5;return {t:(40+i)*DAY,o:c,h:c+1,l:c-1,c,ct:(41+i)*DAY-1};}));
  const out=dailySignals(turn).out;
  assert.ok(out.length>=1 && out[0].dir===-1);

  const h4=Array.from({length:40},(_,i)=>({t:i*H4,o:100+i,h:101+i,l:99+i,c:100+i,ct:(i+1)*H4-1}));
  assert.equal(ichiSignals(h4).out.length,0);
});

test('an old gap keeps the recent contiguous tail; a recent gap is still an error',async()=>{
  const row=t=>[t,'100','110','90','101','2',t+H4-1];
  const make=rows=>new MarketClient(async()=>({ok:true,json:async()=>rows}));
  const longTail=[row(0),...Array.from({length:150},(_,i)=>row((i+2)*H4))];
  const bars=await make(longTail).klines('BTCUSDT','4h');
  assert.equal(bars.length,150);
  assert.equal(bars[0].t,2*H4);
  const shortTail=[...Array.from({length:150},(_,i)=>row(i*H4)),...Array.from({length:5},(_,i)=>row((152+i)*H4))];
  await assert.rejects(make(shortTail).klines('BTCUSDT','4h'),/누락/);
});
