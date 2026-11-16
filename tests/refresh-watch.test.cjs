const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {mergeRefreshBars}=require('../core.js');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const refreshSource=source.slice(source.indexOf('async function refreshCurrent('),source.indexOf('function connectLive('));
const H4=14400000;
function refreshFixture(refresh){
  const calls={range:[],reload:[],status:[],candles:[]};
  const nodes={refreshAnalysis:{disabled:false},analysisAt:{textContent:''}};
  const current={symbol:'BTCUSDT',timeframe:'4h',receivedAt:0,version:1};
  const bars=[{t:10*H4,c:100}];
  const context={state:{data:current,ready:true,refreshing:false,liveRevision:0,lastTick:1,transport:'WS'},bars,analysisController:null,refreshFailures:0,H4,KST:0,
    AbortController,mergeRefreshBars,$:id=>nodes[id],
    chart:{timeScale:()=>({getVisibleRange:()=>({from:0,to:H4/1000}),setVisibleRange:r=>calls.range.push(r),scrollToRealTime(){throw new Error('past view jumped to present');}})},
    selection:{refresh,current:()=>true,socket:{readyState:1}},sec:t=>t/1000,
    analyze:()=>({plans:[]}),result:null,candles:{setData:rows=>calls.candles.push(rows)},volume:{setData(){}},toCandle:b=>b,toVolume:b=>b,applyPriceFormat(){},render(){},connectLive(){throw new Error('healthy socket was replaced');},
    scheduleRefresh:delay=>calls.reload.push(delay),notifyNew(){},loadWatch(){},setStatus:text=>calls.status.push(text),updateSummary(){},fullKst:()=> 'old analysis'};
  vm.createContext(context);vm.runInContext(refreshSource,context);
  return {context,calls,nodes,current,bars};
}
test('periodic refresh failure retains ready chart and live bars, then schedules retry',async()=>{
  const f=refreshFixture(async()=>{throw new Error('network outage');});
  await vm.runInContext('refreshCurrent()',f.context);
  assert.equal(f.context.state.ready,true);assert.equal(f.context.bars,f.bars);assert.equal(f.calls.candles.length,0);
  assert.equal(f.context.state.analysisStale,true);assert.equal(f.context.state.refreshing,false);
  assert.equal(f.nodes.refreshAnalysis.disabled,false);assert.equal(f.calls.reload[0],10000);
});
test('periodic refresh honors rate-limit retry delay without clearing an existing chart',async()=>{
  const f=refreshFixture(async()=>{throw Object.assign(new Error('429'),{retryAfterMs:120000});});
  await vm.runInContext('refreshCurrent()',f.context);
  assert.equal(f.calls.reload[0],120000);assert.equal(f.context.state.ready,true);
});
test('historical view is restored by absolute timestamps after data window shifts',async()=>{
  const f=refreshFixture(async()=>({symbol:'BTCUSDT',timeframe:'4h',receivedAt:Date.now(),version:1,bars:[{t:11*H4,c:105}],h4:[],d1:[]}));
  await vm.runInContext('refreshCurrent()',f.context);
  assert.equal(f.calls.range.length,1);assert.equal(f.calls.range[0].from,0);assert.equal(f.calls.range[0].to,H4/1000);
  assert.equal(f.context.state.analysisStale,false);
});
test('watch analysis fetches once per closed 4H bucket, not on each refresh or tab activation',async()=>{
  const code=source.slice(source.indexOf('const watchAnalysisCache='),source.indexOf('async function loadWatchPrices('));
  let now=100*H4+10000,requests=0;
  const FakeDate=class extends Date{static now(){return now;}};
  const context={Date:FakeDate,H4,watchVersion:0,watchController:null,AbortController,state:{watch:[]},watchList:()=>['BTCUSDT'],renderWatch(){},loadWatchPrices(){},
    client:{cooldownUntil:0,klines:async()=>{requests++;return [{c:100}];}},analyze:()=>({ichiPlan:null,dailyPlan:null,dailySide:1,ichiSide:1})};
  vm.createContext(context);vm.runInContext(code,context);
  await vm.runInContext('loadWatch()',context);await vm.runInContext('loadWatch()',context);await vm.runInContext('loadWatch()',context);
  assert.equal(requests,2);
  now+=H4;await vm.runInContext('loadWatch()',context);assert.equal(requests,4);
});
test('panel reconciliation preserves the actual drawing/input node rather than detach and refocus it',()=>{
  const code=source.slice(source.indexOf('function reconcilePanel('),source.indexOf('function updateLiveUi('));
  const drawing={id:'drawingCard',replaceWith(){throw new Error('focused input card detached');}};
  let replacements=0;
  const panel={children:[{id:'quote',replaceWith(){replacements++;}},drawing]};
  Object.defineProperty(panel,'innerHTML',{set(){throw new Error('panel rebuilt');}});
  const template={content:{children:[{id:'quote'},{id:'drawingCard'}]}};
  const context={$:id=>id==='panel'?panel:drawing,document:{createElement:()=>template}};
  vm.createContext(context);vm.runInContext(code+"\nreconcilePanel('new markup')",context);
  assert.equal(replacements,1);assert.equal(panel.children[1],drawing);
});
test('the 1s heartbeat does not bypass a scheduled analysis retry on every tick',()=>{
  const code=source.slice(source.indexOf('function heartbeat('),source.indexOf('setInterval(heartbeat'));
  let loads=0;
  const state={ready:true,lastTick:Date.now()-120000,transport:'REST',loading:false,refreshing:false,analysisStale:false};
  const context={state,client:{cooldownUntil:0},navigator:{onLine:true},$:id=>id==='lastTick'?{textContent:''}:null,setStatus(){},updateSummary(){},load(){loads++;state.analysisStale=true;}};
  vm.createContext(context);vm.runInContext(code,context);
  for(let i=0;i<10;i++)vm.runInContext('heartbeat()',context);
  assert.equal(loads,1);
});
