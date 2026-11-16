const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {ema,contiguousTail}=require('../core.js');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const renderer=fs.readFileSync(path.join(__dirname,'../chart-render.js'),'utf8');
const apply=app.slice(app.indexOf('function applyLiveBar('),app.indexOf('async function pollLatestPrice('));
const indicators=renderer.slice(renderer.indexOf('function updateLiveIndicators('),renderer.indexOf('// 이벤트 시각'));
const H4=14400000;
function fixture(){
  const calls={candle:[],volume:[],ema:[],reload:[],status:[],closed:[]};
  const rows=Array.from({length:4},(_,i)=>({t:i*H4,o:100,h:120,l:90,c:100,v:1,ct:(i+1)*H4-1}));
  const context={H4,bars:rows,state:{ready:true,data:{timeframe:'4h'},layers:{ema20:true,ema50:false}},TF_SEC:{'4h':14400},
    candles:{update:b=>calls.candle.push(b)},volume:{update:b=>calls.volume.push(b)},
    emaSeries:{ema20:{n:2,s:{update:p=>calls.ema.push(p)}},ema50:{n:2,s:{update(){throw new Error('disabled EMA updated');}}}},
    ema,contiguousTail,sec:t=>t/1000+32400,toCandle:b=>b,toVolume:b=>b,
    setStatus:(...args)=>calls.status.push(args),load:keep=>calls.reload.push(keep),renderLegend(){},checkAlerts(){},queueLiveUi(){},scheduleAxisCaptions(){},scheduleRefresh:ms=>calls.closed.push(ms)};
  vm.createContext(context);vm.runInContext(indicators+'\n'+apply,context);
  return {context,calls};
}
test('live REST update refreshes the candle, volume and enabled EMA without rebuilding the chart',()=>{
  const {context,calls}=fixture();
  context.incoming={...context.bars.at(-1),c:110,v:7};
  vm.runInContext("applyLiveBar(incoming,false,'REST')",context);
  assert.equal(calls.candle.length,1);assert.equal(calls.candle[0].c,110);assert.equal(calls.volume[0].v,7);
  assert.equal(calls.ema.length,1);assert.ok(Math.abs(calls.ema[0].value-(100+20/3))<1e-10);
  assert.equal(context.state.transport,'REST');assert.deepEqual(calls.reload,[]);
});
test('old candle update does not move the displayed price or EMA backwards',()=>{
  const {context,calls}=fixture();context.incoming={...context.bars[0],c:110};
  vm.runInContext("applyLiveBar(incoming,false,'REST')",context);
  assert.equal(context.bars.at(-1).c,100);assert.equal(calls.candle.length,0);assert.equal(calls.ema.length,0);
});
test('a missing candle interval requests recovery without drawing a fabricated candle',()=>{
  const {context,calls}=fixture();context.incoming={...context.bars.at(-1),t:6*H4};
  vm.runInContext("applyLiveBar(incoming,false,'WS')",context);
  assert.deepEqual(calls.reload,[true]);assert.equal(calls.candle.length,0);
});
test('ordinary 15m close recomputes overlays locally without fetching full analysis history',()=>{
  const {context,calls}=fixture();let renders=0;
  context.state.data.timeframe='15m';context.TF_SEC['15m']=900;
  context.bars=context.bars.map((b,i)=>({...b,t:i*900000,ct:(i+1)*900000-1}));
  context.incoming={...context.bars.at(-1),c:110};
  context.requestAnimationFrame=fn=>fn();context.selection={current:()=>true};context.render=()=>renders++;
  vm.runInContext("applyLiveBar(incoming,true,'WS')",context);
  assert.equal(renders,1);assert.equal(calls.closed.length,0);assert.equal(calls.reload.length,0);
});
