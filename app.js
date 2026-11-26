"use strict";
const side=s=>s===1?'<span class="L">LONG</span>':s===-1?'<span class="S">SHORT</span>':'<span class="muted">중립</span>';
const countdown=period=>duration(period-Date.now()%period);
const duration=ms=>ms>0?`${Math.floor(ms/H)}:${String(Math.floor(ms%H/60000)).padStart(2,'0')}:${String(Math.floor(ms%60000/1000)).padStart(2,'0')}`:'정산 확인 중';
let reconnectTimer=null, refreshTimer=null, liveUiTimer=null, watchVersion=0,watchController=null, futuresController=null, toastTimer=null;
let pendingJump=null;
let pricePollController=null;
let analysisController=null,refreshFailures=0;
function setStatus(text,cls='') { $('status').textContent=text; $('status').className=cls; }
function toast(message,undo=null) {
  clearTimeout(toastTimer); state.undo=undo;
  $('toastMessage').textContent=message; $('toast').hidden=false; $('undo').hidden=!undo;
  toastTimer=setTimeout(()=>{$('toast').hidden=true;state.undo=null;},undo?15000:6000);
}
$('undo').onclick=()=>{const action=state.undo;state.undo=null;$('toast').hidden=true;action?.();};
$('dismissToast').onclick=()=>{$('toast').hidden=true;state.undo=null;};
function chartState(title,message,error=false) {
  $('chartState').hidden=false; $('chartStateTitle').textContent=title; $('chartStateMessage').textContent=message; $('retry').hidden=!error;
}
function clearChart() {
  bars=[];result=null;local=null;state.crosshairTime=null;$('legend').textContent='';$('hint').textContent='';
  candles.setData([]);volume.setData([]);clearAxisCaptions();
  for(const series of [supLine,resLine,stSupLine,stResLine,sqLine,...srSeries,...fibSeries,...bbSeries,rsiSeries,macdHist,...macdSeries,vwapSeries,...trendSeries,...Object.values(emaSeries).map(e=>e.s)]) series.setData([]);
  for(const line of priceLines) candles.removePriceLine(line);priceLines=[];
}
function syncControls() {
  for(const b of $('tf').querySelectorAll('button')) {const active=b.dataset.tf===state.tf;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  for(const b of $('layers').querySelectorAll('input')) b.checked=!!state.layers[b.dataset.layer];
  const matchPreset=preset=>Object.keys(LAYER_DEFAULT).every(k=>!!state.layers[k]===preset.includes(k));
  const presetKeys={focus:['signals','plans','levels','zone','volume','mine','shock'],structure:['signals','plans','trend','shortTrend','levels','sr','fib','zone','volume','mine','shock'],pro:Object.keys(LAYER_DEFAULT)};
  for(const b of $('presets').querySelectorAll('button')) b.setAttribute('aria-pressed',String(matchPreset(presetKeys[b.dataset.preset])));
  for(const id of ['drawLine','drawTrend','drawAlert','deleteLine']) $(id).disabled=!state.ready;
  $('autoScale').setAttribute('aria-pressed',String(state.auto));
  $('autoScale').title=state.auto?'자동 높이 맞춤 켜짐 · 보이는 캔들 기준 · A':'자동 높이 맞춤 꺼짐 · A로 켜기';
  $('sym').value=state.sym;updateStar();
}
function updateSummary() {
  if(!state.ready || !result) return;
  const active=[result.dailyPlan,result.ichiPlan].filter(p=>p?.state==='진행');
  const conflict=result.dailySide && result.ichiSide && result.dailySide!==result.ichiSide;
  const activeSides=new Set(active.map(p=>p.dir));
  const unsafe=conflict || activeSides.size>1;
  const stale=Date.now()-state.lastTick>30000;
  const px=bars.at(-1).c;
  const stopHit=active.some(p=>p.dir===1?px<=p.sl:px>=p.sl), targetHit=active.some(p=>p.dir===1?px>=p.tp:px<=p.tp);
  const touched=stopHit?'손절 도달 · 마감 확인':targetHit?'목표 도달 · 마감 확인':'';
  const label=stale?'시세 확인':state.analysisStale?'분석 확인':!active.length || unsafe?'WAIT':touched||(active[0].dir===1?'LONG 관찰':'SHORT 관찰');
  $('decisionState').textContent=label;
  $('decisionState').style.color=stale||state.analysisStale||label==='WAIT'||touched?'var(--gold)':active[0].dir===1?'var(--long)':'var(--short)';
  $('decisionReason').textContent=stale?'가격 수신 지연 · 마지막 가격으로 판단하지 마세요':state.analysisStale?'분석 갱신 지연 · 마지막 확정 결과 유지 · 재시도 중':unsafe?'일봉과 4H 방향 충돌 · 신규 진입 대기':touched?'가격이 계획선에 닿음 · 결과는 4H 마감 기준으로 확정 · 신규 진입 판단 금지':!active.length?'진행 중 계획 없음 · 다음 확정 신호를 기다리는 구간':'마감 확정 계획 추적 중 · 현재 가격의 신규 진입 신호가 아닙니다';
  const stopText=value=>value==null?'—':`${value.toFixed(1)}%${value>MAX_STOP?' (10% 상한 초과 · 신호 제외)':''}`;
  const shockNote=shockBanner();
  $('decisionRisk').textContent=(shockNote?shockNote+' · ':'')+(active.length?active.map(p=>`${p.mod} 손절 ${price(p.sl)} · 현재가 대비 ${sgn(pct(p.sl,bars.at(-1).c))}%`).join(' / '):`다음 신호 손절폭 참고 · 일봉 ${stopText(result.stopDaily)} / 4H ${stopText(result.stopIchi)}`);
}
// ---------- 급변동 ----------
const SHOCK_NAME={drop:'급락',surge:'급등',rebound:'반등',pullback:'반락'};
function shockState(shock){
  if(!shock)return '<span class="muted">확인 중</span>';
  if(shock.leg)return `<span class="${shock.leg.dir===-1?'S':'L'}">${shock.leg.dir===-1?'급락':'급등'} 구간</span> · 최대 ${shock.leg.mag.toFixed(1)} ATR · ${shock.leg.since}봉 전 · ${shock.leg.dir===-1?'반등':'반락'} 미확정`;
  return '<span class="muted">급변동 구간 아님</span>';
}
function shockBanner(){
  if(typeof local==='undefined'||!local?.shock)return '';
  const notes=[];
  if(local.shock.leg)notes.push(`${state.tf} ${local.shock.leg.dir===-1?'급락':'급등'} 구간`);
  if(local.shock4?.leg&&local.shock4!==local.shock)notes.push(`4H ${local.shock4.leg.dir===-1?'급락':'급등'} 구간`);
  return notes.length?`⚠ ${notes.join(' / ')} · 변동성 확대`:'';
}
function shockCardHtml(px){
  const s=local.shock,leg=s.leg,tfSec=TF_SEC[state.tf];
  const recent=[...s.events].reverse().slice(0,6);
  const rsiText=local.rsi==null?'—':`${local.rsi.toFixed(1)}${local.rsi>=70?' · <span class="S">과매수권</span>':local.rsi<=30?' · <span class="L">과매도권</span>':''}`;
  return `<section class="card"><h3>급변동 · 변동성 <span class="eyebrow">SHOCK</span></h3><div class="row"><span>${state.tf} 상태</span><span>${shockState(s)}</span></div>${tfSec===14400?'':`<div class="row"><span>4H 상태</span><span>${shockState(local.shock4)}</span></div>`}<div class="row"><span>진행 중 봉</span><span id="shockLive">—</span></div>${leg?`<div class="row"><span>${leg.dir===-1?'반등':'반락'} 확인 기준</span><span>50% ${price(leg.r50)} <span data-distance="${leg.r50}">(${sgn(pct(leg.r50,px))}%)</span><br><span class="muted">38% ${price(leg.r382)} · 62% ${price(leg.r618)}</span><br><span class="muted">구간 ${price(leg.origin)} → ${price(leg.extreme)}</span></span></div>`:''}<div class="row"><span>강제 청산 · 접속 후</span><span id="liqBox" class="muted">수집 중…</span></div><div class="row"><span>ATR 14 · ${state.tf}</span><span>${local.atr?`${price(local.atr)} (${(local.atr/px*100).toFixed(2)}%)`:'—'}</span></div><div class="row"><span>RSI 14 · ${state.tf}</span><span>${rsiText}</span></div><table><thead><tr><th>확정 시각 KST</th><th>유형</th><th>크기</th><th>변화</th></tr></thead><tbody>${recent.map(e=>`<tr><td><button class="pick history-title" data-shock="${e.t}">${fullKst(e.t)}</button></td><td class="${e.dir===1?'L':'S'}">${SHOCK_NAME[e.type]}</td><td>${e.mag.toFixed(1)} ATR</td><td>${sgn(e.pct)}%</td></tr>`).join('')||'<tr><td colspan="4">조회 범위 내 급변동 없음</td></tr>'}</tbody></table><p class="note section-note">마감 봉 몸통이 직전 ATR의 ${s.k}배 이상이거나 3봉 누적 4배 이상이면 급변동으로 표시합니다. 구간 폭의 50%를 종가로 되돌리거나 반대 방향 급변동 봉이 나오면 반등·반락으로 확정합니다. 변동성 경고이며 방향 신호·진입 신호가 아닙니다. 진행 중 봉은 미확정 참고입니다.</p></section>`;
}
function checkLiveShock(){
  const last=bars.at(-1);if(!state.ready||!last||!local?.atr)return;
  const live=liveShock(last,local.atr,local.shock.k);if(!live)return;
  if($('shockLive'))$('shockLive').innerHTML=`<span class="${live.dir?'warn':'muted'}">${sgn(live.mag)} ATR (${sgn(pct(last.c,last.o))}%)${live.dir?` · ${live.dir===-1?'급락':'급등'} 미확정`:''}</span>`;
  const base=`${state.data.symbol}|${state.data.timeframe}|`;
  if(live.dir&&state.shockSeen!==base+last.t+live.dir){
    state.shockSeen=base+last.t+live.dir;
    notify('AngelAreum 급변동 감지',`${state.data.symbol} ${state.data.timeframe} 진행 중 봉 ${live.dir===-1?'급락':'급등'} ${Math.abs(live.mag).toFixed(1)} ATR (${sgn(pct(last.c,last.o))}%) · 현재가 ${price(last.c)} · 미확정 · 자동 주문 없음`);
  }
  const leg=local.shock.leg;
  if(leg){
    const extreme=leg.dir===-1?Math.min(leg.extreme,last.l):Math.max(leg.extreme,last.h),span=Math.abs(leg.origin-extreme);
    const back=leg.dir===-1?last.c-extreme:extreme-last.c,key=base+leg.start+leg.dir;
    if(span>0&&back>=span*.5&&state.reboundSeen!==key){
      state.reboundSeen=key;
      notify(`AngelAreum ${leg.dir===-1?'반등':'반락'} 진행`,`${state.data.symbol} ${state.data.timeframe} ${leg.dir===-1?'급락':'급등'} 구간의 50% 되돌림 도달 · 현재가 ${price(last.c)} · 봉 마감 전 미확정 · 자동 주문 없음`);
    }
  }
}
function notifyShockEvents(){
  if(!local?.shock)return;
  const key=`angel-shock-seen-${state.sym}-${state.tf}`,seen=store.get(key,0),step=TF_SEC[state.tf]*1000;
  const events=local.shock.events;if(!events.length)return;
  const latest=Math.max(...events.map(e=>e.t));if(latest<=seen)return;
  store.set(key,latest);if(!seen)return;
  const fresh=events.filter(e=>e.t>seen&&Date.now()-e.t<2*step);
  if(fresh.length)notify(`AngelAreum 급변동 확정 ${fresh.length}건`,fresh.map(e=>`${state.sym} ${state.tf} ${SHOCK_NAME[e.type]} ${e.mag.toFixed(1)} ATR (${sgn(e.pct)}%)`).join(' / ')+' · 마감 봉 기준 · 자동 주문 없음');
}
function planHtml(p,px,now) {
  if(!p) return '<span class="muted">신호 없음 · WAIT</span>';
  if(p.state!=='진행') return `<span class="muted">${p.state} · WAIT</span>`;
  const stopCrossed=p.dir===1?px<=p.sl:px>=p.sl;
  const targetCrossed=p.dir===1?px>=p.tp:px<=p.tp;
  return `${side(p.dir)} <span class="muted">${Math.floor((now-p.t)/H)}/72h</span><br><span class="risk">손절 ${price(p.sl)} (${sgn(pct(p.sl,px))}%)</span><br><span class="muted">기준 ${price(p.ref)} · 현재 ${sgn(p.dir*(px-p.ref)/Math.abs(p.ref-p.sl))}R</span><br><span class="reward">목표 ${price(p.tp)} (${sgn(pct(p.tp,px))}%)</span>${stopCrossed||targetCrossed?'<br><span class="warn">가격 도달 · 4H 마감 결과 확인 전</span>':''}`;
}
function renderPanel(near) {
  const panelScroll=$('panel').scrollTop,enteredPrice=$('lineIn')?.value;
  const historyOpen=$('historyDetails')?.open;
  const r=result,now=Date.now(),px=bars.at(-1).c,tfSec=TF_SEC[state.tf];
  const run=r.run;
  const runTxt=!run.cur?'일봉 방향 없음':`${run.cur===1?'상승':'하락'} ${run.n}일째 · `+(run.total<10?`표본 ${run.total}회 · 부족`:run.longer===0?`조회 표본 ${run.total}회 중 최장`:`조회 ${run.total}회 중 ${(run.longer/run.total*100).toFixed(1)}%가 이 이상`);
  const tl=(t,name,barMs=DAY)=>!t?'<span class="muted">확정 피벗 대기</span>':t.broken?`<span class="muted">${name} 이탈 · ${kst(t.breakT+barMs)}</span>`:`${price(t.at(now))} <span data-distance="${t.at(now)}">(${sgn(pct(t.at(now),px))}%)</span>`;
  const level=l=>l?`${l.label} ${price(l.p)} <span data-distance="${l.p}">(${sgn(pct(l.p,px))}%)</span>`:'확인된 레벨 없음';
  const history=[...r.plans].reverse().filter(p=>p.ref!=null||p.state==='범위 밖').slice(0,12);
  const stats=mod=>{const a=r.plans.filter(p=>p.mod===mod&&Number.isFinite(p.r)&&p.state!=='범위 밖').slice(-30);return `<div class="row"><span>${mod} 최근 ${a.length}건</span><span>${sgn(a.reduce((s,p)=>s+p.r,0))}R · 수익 ${a.filter(p=>p.r>0).length}건</span></div>`;};
  const panelHtml=`
    <section class="card quote-card"><h3><span>${escapeHtml(state.data.symbol)}</span><span class="badge">USDT PERPETUAL</span></h3><div id="livePrice" class="big">${price(px)}</div><div class="quote-meta"><span id="quoteChange" class="muted">24h 조회 중</span><span class="badge">${state.tf.toUpperCase()} CHART</span></div><div class="note">마지막 체결가 · <span id="priceAt">${clock(state.lastTick)}</span> KST</div></section>
    <section class="card"><h3>선물 시장 <span class="eyebrow">DERIVATIVES</span></h3><div id="futuresContent" aria-busy="true" class="muted">마크가격 · 펀딩 · OI 조회 중…</div></section>
    <section class="card"><h3>방향과 계획 <button id="refreshAnalysis" class="pick" aria-label="분석 새로고침">새로고침</button></h3><div class="row"><span>일봉 / 4H 방향</span><span>${side(r.dailySide)} / ${side(r.ichiSide)}</span></div><div class="row"><span>일봉 추세 지속</span><span>${runTxt}</span></div><div class="row"><span>일봉 계획</span><span id="dailyPlan">${planHtml(r.dailyPlan,px,now)}</span></div><div class="row"><span>4H 계획</span><span id="ichiPlan">${planHtml(r.ichiPlan,px,now)}</span></div><div class="row"><span>다음 4H 판단</span><span id="cd4">${countdown(H4)}</span></div><div class="row"><span>다음 일봉 판단</span><span id="cd1">${countdown(DAY)}</span></div><p class="note" id="analysisAt">분석 ${fullKst(state.data.receivedAt)} KST${state.analysisStale?' · 갱신 지연':''}</p><p class="note section-note">차트 ${state.tf} / 신호 분석 일봉·4H 고정. 신호는 마감 확정, 현재가·거리만 실시간 참고. 손절·목표 도달 결과는 4H 마감에 확정합니다. 가격은 호가 단위 표기, R은 원래 분석값 기준입니다.</p></section>
    ${shockCardHtml(px)}
    <section class="card"><h3>가격 구조 <span class="eyebrow">CONFLUENCE</span></h3><div class="row"><span>가까운 저항</span><span>${level(near.res)}</span></div><div class="row"><span>가까운 지지</span><span>${level(near.sup)}</span></div><div class="row"><span>장기 지지선 · D</span><span>${tl(r.trendSup,'지지')}</span></div><div class="row"><span>장기 저항선 · D</span><span>${tl(r.trendRes,'저항')}</span></div><div class="row"><span>단기 지지선</span><span>${tl(local.shortSup,'지지',tfSec*1000)}</span></div><div class="row"><span>단기 저항선</span><span>${tl(local.shortRes,'저항',tfSec*1000)}</span></div><div class="row"><span>${local.zone&&!local.zone.below?'반락 후보':'반등 후보'}</span><span>${local.zone?`${price(local.zone.p)} · ${local.zone.kinds.join(' / ')}`:'독립 근거 2종류 겹침 없음'}</span></div><div class="row"><span>피보나치</span><span>${local.fib?`0.5 ${price(local.fib.g50)}<br>0.618 ${price(local.fib.g618)}`:'확정 스윙 대기 / 변동폭 부족'}</span></div><div class="row"><span>SQ · 4H</span><span>${r.sq.on?'LONG 추적 중':r.sq.pressed?'압축 중':'대기'}</span></div><p class="note">일봉·주봉 레벨은 마감 봉만 사용. 피벗·추세선은 우측 봉 확정 이후 표시됩니다.</p><p id="axisGroups" class="note"></p></section>
    <section id="drawingCard" class="card"><h3>내 수평선 · 가격 알림 <span class="eyebrow">DRAWINGS</span></h3><div id="drawingList"></div><form id="drawingForm" class="inline"><label class="sr-only" for="lineIn">수평선 또는 알림 가격</label><input id="lineIn" type="number" step="any" min="0" placeholder="가격 입력" required><button type="submit">선 추가</button><button type="button" id="addAlert">알림 추가</button></form><div class="card-actions"><button id="clearLines" class="text-danger">내 선 전체 삭제</button><button id="clearAlerts">가격 알림 전체 삭제</button></div><p class="note section-note">선 삭제 모드에서 차트의 내 수평선·추세선을 눌러 삭제할 수 있습니다. 가격 알림은 이 페이지가 실행 중이고 해당 종목을 보고 있을 때만 감시합니다. 앱 종료·절전 중에는 보장되지 않습니다.</p><details class="notice-history"><summary>알림 기록 <span id="noticeCount">0</span>건</summary><div id="noticeHistory"></div></details></section>
    <section class="card"><h3>관심 종목 <button id="refreshWatch" class="pick" aria-label="관심 종목 새로고침">새로고침</button></h3><div id="watch"></div></section>
    <section class="card"><details class="history-title" id="historyDetails"><summary>신호 기록 <span class="eyebrow">HISTORY</span></summary><table><thead><tr><th>시각 KST</th><th>주기</th><th>방향</th><th>결과</th><th>R</th></tr></thead><tbody>${history.map(p=>`<tr><td><button class="pick history-title" data-jump="${p.t}" data-module="${p.mod}">${fullKst(p.t)}</button></td><td>${p.mod}</td><td>${side(p.dir)}</td><td class="history-status">${p.state}</td><td>${p.r==null?'—':sgn(p.r)+'R'}</td></tr>`).join('')||'<tr><td colspan="5">조회 기간 내 기록 없음</td></tr>'}</tbody></table><p class="note">시각을 누르면 당시 위치로 이동합니다. 현재 주기 범위 밖은 해당 신호의 4H/일봉으로 전환합니다. 과거 위치에서도 판단 패널은 최신 분석입니다.</p>${stats('일봉')}${stats('4H')}<p class="note">범위 밖 ${r.plans.filter(p=>p.state==='범위 밖').length}건은 결과·R 집계에서 제외합니다.</p><p class="note section-note">비용 전 가상 계획 기록 · 수수료·펀딩·슬리피지 제외. 각 모듈은 독립이며 중복 노출을 합산한 계좌 수익률이 아닙니다. 표본 30건 미만은 부족하며 그 이상도 수익성을 보장하지 않습니다.</p></details></section>`;
  reconcilePanel(panelHtml);
  $('panel').setAttribute('aria-busy','false');
  $('refreshAnalysis').onclick=()=>load(true);
  $('refreshAnalysis').disabled=state.refreshing;
  $('drawingForm').onsubmit=e=>{e.preventDefault();addMine('line',+$('lineIn').value);};
  $('addAlert').onclick=()=>addMine('alert',+$('lineIn').value);
  $('clearLines').onclick=()=>deleteAll('line');$('clearAlerts').onclick=()=>deleteAll('alert');
  $('refreshWatch').onclick=()=>loadWatch();
  for(const b of document.querySelectorAll('[data-jump]')) b.onclick=()=>jumpSignal(+b.dataset.jump,b.dataset.module);
  for(const b of document.querySelectorAll('[data-shock]')) b.onclick=()=>focusSignal(+b.dataset.shock);
  checkLiveShock();notifyShockEvents();renderLiquidations();
  renderDrawings();renderWatch();renderFutures();renderNotices();
  if(enteredPrice && $('lineIn') && $('lineIn').value!==enteredPrice) $('lineIn').value=enteredPrice;
  if(historyOpen && $('historyDetails')) $('historyDetails').open=true;
  $('panel').scrollTop=panelScroll;
}
function reconcilePanel(html){
  const panel=$('panel'),old=[...panel.children];
  if(!$('drawingCard')){panel.innerHTML=html;return;}
  const template=document.createElement('template');template.innerHTML=html;
  const next=[...template.content.children];
  if(old.length!==next.length||old.findIndex(c=>c.id==='drawingCard')!==next.findIndex(c=>c.id==='drawingCard')){panel.innerHTML=html;return;}
  next.forEach((card,index)=>{if(card.id!=='drawingCard')old[index].replaceWith(card);});
}
function updateLiveUi() {
  liveUiTimer=null;if(!state.ready || !bars.length) return;
  const px=bars.at(-1).c;
  if($('livePrice')) $('livePrice').textContent=price(px);
  if($('priceAt')) $('priceAt').textContent=clock(state.lastTick);
  if($('dailyPlan')) $('dailyPlan').innerHTML=planHtml(result.dailyPlan,px,Date.now());
  if($('ichiPlan')) $('ichiPlan').innerHTML=planHtml(result.ichiPlan,px,Date.now());
  updateLiveExtras();checkLiveShock();
  for(const node of document.querySelectorAll('[data-distance]')) node.textContent=`(${sgn(pct(+node.dataset.distance,px))}%)`;
  const watch=state.watch.find(w=>w.s===state.data.symbol);if(watch){watch.px=px;watch.priceAt=state.lastTick;}
  const watchPrice=document.querySelector('[data-watchprice="'+state.data.symbol+'"]');
  if(watchPrice){watchPrice.textContent=price(px);watchPrice.title=`가격 수신 ${clock(state.lastTick)} KST`;}
  updateSummary();
}
function queueLiveUi() {if(!liveUiTimer) liveUiTimer=setTimeout(updateLiveUi,300);}
function setAuto(on) {
  state.auto=on;store.set('angel-auto',on);chart.priceScale('right').applyOptions({autoScale:on});syncControls();
}
// Auxiliary indicators cannot flatten the candle range. Only visible candles define Auto.
candles.applyOptions({autoscaleInfoProvider:original=>{
  if(!state.auto) return original();
  const visible=chart.timeScale().getVisibleRange();
  const range=visible?candleTimeRange(bars,(visible.from-KST)*1000,(visible.to-KST)*1000):null;
  return range?{priceRange:range}:original();
}});
$('autoScale').onclick=()=>setAuto(!state.auto);
$('goLive').onclick=()=>{chart.timeScale().scrollToRealTime();setAuto(true);$('analysisTime').textContent='분석 주기 · 일봉 / 4H';};
// Manual price-axis scaling switches Auto off; horizontal chart panning keeps it on.
$('chart').addEventListener('pointerdown',e=>{const rect=$('chart').getBoundingClientRect();if(e.clientX>rect.right-72 && e.clientY<rect.bottom-30) setAuto(false);},{passive:true});
$('chart').addEventListener('dblclick',e=>{const rect=$('chart').getBoundingClientRect();if(e.clientX>rect.right-72) setAuto(true);});
function drawingKey(kind,sym=state.sym) {return `omni-${kind==='line'?'lines':'alerts'}-${sym}`;}
function readDrawings(kind,sym=state.sym) {
  const values=store.get(drawingKey(kind,sym),[]);
  if(!Array.isArray(values)) return [];
  return values.filter(v=>kind==='line'?Number.isFinite(v)&&v>0:v&&Number.isFinite(v.p)&&v.p>0&&(v.dir===1||v.dir===-1));
}
function addMine(kind,price) {
  if(!state.ready) return toast('데이터 연결 후 사용할 수 있습니다');
  if(!Number.isFinite(price)||price<=0) return toast('0보다 큰 유효한 가격을 입력하세요');
  price=roundToTick(price,client.symbolMeta.get(state.sym)?.tickSize);
  if(!(price>0))return toast('거래소 최소 호가 단위 이상의 가격을 입력하세요');
  const key=drawingKey(kind),values=readDrawings(kind);
  if(values.some(v=>Math.abs((kind==='line'?v:v.p)-price)<Math.max(price*1e-9,1e-12))) return toast('같은 가격이 이미 등록되어 있습니다');
  values.push(kind==='line'?price:{p:price,dir:price>=bars.at(-1).c?1:-1});
  if(!store.set(key,values)) return toast('저장 공간에 접근할 수 없어 등록하지 못했습니다');
  render();toast(kind==='line'?'수평선을 추가했습니다':'가격 알림 등록 · 현재 종목을 보고 있을 때만 감시합니다');
}
function renderDrawings() {
  const box=$('drawingList');if(!box) return;
  const lines=readDrawings('line'),alerts=readDrawings('alert');
  const trends=readTrends();
  box.innerHTML=[...trends.map((tr,i)=>`<div class="drawing-row"><span>추세선 <b>${price(tr.p1)} → ${price(tr.p2)}</b><small>${kst(tr.t1)} ~ ${kst(tr.t2)}</small></span><button class="x" data-trend="${i}" aria-label="추세선 삭제">삭제</button></div>`),...lines.map((p,i)=>`<div class="drawing-row"><span>내 선 <b>${price(p)}</b></span><button class="x" data-delete="line" data-index="${i}" aria-label="${price(p)} 수평선 삭제">삭제</button></div>`),...alerts.map((a,i)=>`<div class="drawing-row"><span>알림 <b>${price(a.p)}</b><small>${a.dir===1?'이상':'이하'}</small></span><button class="x" data-delete="alert" data-index="${i}" aria-label="${price(a.p)} 가격 알림 삭제">삭제</button></div>`)].join('')||'<p class="muted note">저장한 선과 가격 알림이 없습니다. 위 도구로 차트를 누르거나 가격을 입력하세요.</p>';
  for(const b of box.querySelectorAll('[data-delete]')) b.onclick=()=>deleteDrawing(b.dataset.delete,+b.dataset.index);
  for(const b of box.querySelectorAll('[data-trend]')) b.onclick=()=>deleteTrend(+b.dataset.trend);
  $('clearLines').disabled=!lines.length;$('clearAlerts').disabled=!alerts.length;
}
function undoDeletion(kind,symbol,removed) {
  const key=drawingKey(kind,symbol),values=readDrawings(kind,symbol);
  for(const v of removed) if(!values.some(x=>kind==='line'?x===v:x.p===v.p&&x.dir===v.dir)) values.push(v);
  if(!store.set(key,values)) return toast('복구 값을 저장하지 못했습니다');
  if(state.ready&&state.sym===symbol) render();toast('삭제한 항목을 복구했습니다');
}
function deleteDrawing(kind,index) {
  const symbol=state.sym,key=drawingKey(kind,symbol),values=readDrawings(kind,symbol);
  if(!values[index]) return;
  const removed=values.splice(index,1);
  if(!store.set(key,values)) return toast('삭제 값을 저장하지 못했습니다');
  render();toast(kind==='line'?'수평선을 삭제했습니다':'가격 알림을 삭제했습니다',()=>undoDeletion(kind,symbol,removed));
}
function deleteAll(kind) {
  const symbol=state.sym,key=drawingKey(kind,symbol),values=readDrawings(kind,symbol);if(!values.length) return;
  if(!store.set(key,[])) return toast('삭제 값을 저장하지 못했습니다');
  render();toast(`${values.length}개를 삭제했습니다`,()=>undoDeletion(kind,symbol,values));
}
// ---------- 내 추세선 ----------
const trendKey=(sym=state.sym)=>`angel-trends-${sym}`;
function readTrends(sym=state.sym){const v=store.get(trendKey(sym),[]);return Array.isArray(v)?v.filter(x=>x&&[x.t1,x.p1,x.t2,x.p2].every(Number.isFinite)&&x.p1>0&&x.p2>0&&x.t2>x.t1):[];}
const trendAt=(tr,t)=>tr.p1+(tr.p2-tr.p1)/(tr.t2-tr.t1)*(t-tr.t1);
let trendStart=null;
function addTrend(a,b){
  if(a.t===b.t)return toast('서로 다른 봉 두 곳을 눌러 주세요');
  const [first,second]=a.t<b.t?[a,b]:[b,a],values=readTrends();
  if(values.length>=20)return toast('추세선은 종목당 최대 20개입니다');
  values.push({t1:first.t,p1:first.p,t2:second.t,p2:second.p});
  if(!store.set(trendKey(),values))return toast('저장 공간에 접근할 수 없어 등록하지 못했습니다');
  render();toast('추세선을 추가했습니다 · 최신 봉까지 연장 표시');
}
function deleteTrend(index){
  const symbol=state.sym,values=readTrends(symbol);if(!values[index])return;
  const [removed]=values.splice(index,1);
  if(!store.set(trendKey(symbol),values))return toast('삭제 값을 저장하지 못했습니다');
  render();toast('추세선을 삭제했습니다',()=>{const now=readTrends(symbol);now.push(removed);if(!store.set(trendKey(symbol),now))return toast('복구 값을 저장하지 못했습니다');if(state.ready&&state.sym===symbol)render();toast('삭제한 추세선을 복구했습니다');});
}
function setMode(mode) {
  state.mode=state.mode===mode?null:mode;trendStart=null;
  for(const [id,m] of [['drawLine','line'],['drawTrend','trend'],['drawAlert','alert'],['deleteLine','delete']]) {$(id).classList.toggle('armed',state.mode===m);$(id).setAttribute('aria-pressed',String(state.mode===m));}
  $('hint').textContent=state.mode==='trend'?'첫 번째 점을 눌러 추세선 시작 · Esc 취소':state.mode==='line'?'차트의 가격을 눌러 수평선 추가 · Esc 취소':state.mode==='alert'?'차트의 가격을 눌러 알림 등록 · Esc 취소':state.mode==='delete'?'내 수평선·추세선을 누르면 삭제 · 자동 분석선은 유지 · Esc 취소':'';
}
$('drawLine').onclick=()=>setMode('line');$('drawTrend').onclick=()=>setMode('trend');$('drawAlert').onclick=()=>setMode('alert');$('deleteLine').onclick=()=>setMode('delete');
chart.subscribeClick(p=>{
  if(!state.ready || !state.mode || !p.point) return;
  if(state.mode==='delete') {
    const list=readDrawings('line');let nearest=-1,dist=14,trend=-1;
    list.forEach((price,i)=>{const y=candles.priceToCoordinate(price);if(y!=null && Math.abs(y-p.point.y)<dist){nearest=i;dist=Math.abs(y-p.point.y);}});
    if(p.time!=null)readTrends().forEach((tr,i)=>{const y=candles.priceToCoordinate(trendAt(tr,(p.time-KST)*1000));if(y!=null && Math.abs(y-p.point.y)<dist){trend=i;nearest=-1;dist=Math.abs(y-p.point.y);}});
    if(trend>=0){deleteTrend(trend);return;}
    if(nearest<0) return toast('가까운 내 수평선·추세선이 없습니다 · 선 목록에서도 삭제할 수 있습니다');
    deleteDrawing('line',nearest);return;
  }
  if(state.mode==='trend') {
    const value=candles.coordinateToPrice(p.point.y);
    if(p.time==null||value==null||value<=0) return toast('캔들이 있는 위치를 눌러 주세요');
    const point={t:(p.time-KST)*1000,p:roundToTick(+value.toPrecision(10),client.symbolMeta.get(state.sym)?.tickSize)};
    if(!trendStart){trendStart=point;$('hint').textContent=`시작 ${formatPrice(point.p,client.symbolMeta.get(state.sym)?.tickSize)} · 두 번째 점을 눌러 완성 · Esc 취소`;return;}
    const first=trendStart;setMode('trend');addTrend(first,point);return;
  }
  const price=candles.coordinateToPrice(p.point.y);if(price==null||price<=0) return;
  const mode=state.mode;setMode(mode);addMine(mode,+price.toPrecision(10));
});
let audio=null;
function beep() {
  try {audio??=new (window.AudioContext||window.webkitAudioContext)();audio.resume();const o=audio.createOscillator(),g=audio.createGain();o.frequency.value=740;g.gain.value=.045;o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+.2);}catch{}
}
function renderNotices(){
  if(!$('noticeHistory'))return;
  $('noticeCount').textContent=String(state.notices.length);
  $('noticeHistory').innerHTML=state.notices.length?[...state.notices].reverse().map(n=>`<div class="notice-entry"><strong>${escapeHtml(n.title)}</strong><small>${fullKst(n.at)} KST</small><p>${escapeHtml(n.body)}</p></div>`).join(''):'<p class="note">이 페이지에서 받은 알림이 없습니다.</p>';
}
function notify(title,body){
  state.notices.push({title,body,at:Date.now()});if(state.notices.length>50)state.notices.shift();
  renderNotices();beep();toast(`${title} · ${body}`);
}
function checkAlerts(currentPrice){
  const values=readDrawings('alert'),hit=values.filter(a=>a.dir===1?currentPrice>=a.p:currentPrice<=a.p);
  if(!hit.length)return;
  if(!store.set(drawingKey('alert'),values.filter(a=>!hit.includes(a))))return;
  const details=hit.map(a=>`${state.data.symbol} ${price(a.p)} ${a.dir===1?'이상':'이하'} 도달`).join(' / ');
  notify(`AngelAreum 가격 알림 ${hit.length}건`,`${details} · 현재가 ${price(currentPrice)}`);render();
}
function notifyNew(){
  const key=`omni-seen-${state.sym}`,seen=store.get(key,0),messages=[];
  const times=[...result.plans.map(p=>p.t),...result.sq.events.map(e=>e.t)];store.set(key,Math.max(seen,...times));if(!seen)return;
  for(const p of result.plans.filter(p=>p.t>seen&&Date.now()-p.t<H4&&p.ref!=null))messages.push(`${state.sym} ${p.mod} ${p.dir===1?'LONG':'SHORT'} · 기준 ${price(p.ref)} · 손절 ${price(p.sl)} · 목표 ${price(p.tp)}`);
  for(const e of result.sq.events.filter(e=>e.t>seen&&Date.now()-e.t<H4))messages.push(`${state.sym} ${e.type==='entry'?'SQ LONG':'SQ 종료'} · 4H 마감 기준`);
  if(messages.length)notify(`AngelAreum 새 신호 ${messages.length}건`,messages.join(' / ')+' · 자동 주문 없음');
}
function watchList() {const v=store.get('omni-watch',WATCH_DEFAULT);return Array.isArray(v)?[...new Set(v.filter(s=>typeof s==='string'&&/^[\p{L}\p{N}]{1,30}USDT$/u.test(s)))].slice(0,30):WATCH_DEFAULT;}
function updateStar() {const watched=watchList().includes(state.sym);$('star').textContent=watched?'★':'☆';$('star').setAttribute('aria-label',watched?'관심 종목에서 제거':'관심 종목에 추가');$('star').setAttribute('aria-pressed',String(watched));}
$('star').onclick=()=>{
  const list=watchList(),index=list.indexOf(state.sym);if(index>=0) list.splice(index,1);else if(list.length<30) list.push(state.sym);else return toast('관심 종목은 최대 30개입니다');
  if(!store.set('omni-watch',list)) return toast('관심 종목을 저장하지 못했습니다');updateStar();loadWatch();
};
const watchAnalysisCache=new Map();
let watchQuotesAt=0,watchQuoteRequest=null,watchQuoteMap=new Map();
async function loadWatch(){
  const version=++watchVersion;watchController?.abort();const controller=watchController=new AbortController();
  const list=watchList(),bucket=Math.floor((Date.now()-5000)/H4);
  state.watchLoaded=false;renderWatch();
  const rows=[];let cursor=0;
  async function worker(){
    while(cursor<list.length&&!controller.signal.aborted){
      const s=list[cursor++],cached=watchAnalysisCache.get(s);
      if(cached&&cached.bucket===bucket&&(!cached.failed||Date.now()<cached.retryAt)){rows.push({...cached.row});continue;}
      if(Date.now()<client.cooldownUntil){rows.push(cached?{...cached.row,analysisStale:true}:{s,err:true});continue;}
      try{
        const [h4,d1]=await Promise.all([client.klines(s,'4h',{limit:400,signal:controller.signal}),client.klines(s,'1d',{limit:500,signal:controller.signal})]);
        const now=Date.now(),r=analyze(h4,d1,now),plan=[r.ichiPlan,r.dailyPlan].filter(p=>p?.state==='진행').sort((a,b)=>b.t-a.t)[0];
        const row={s,px:h4.at(-1).c,d:r.dailySide,i:r.ichiSide,plan,priceAt:now,analysisAt:now};
        watchAnalysisCache.set(s,{bucket,row,failed:false});rows.push({...row});
      }catch(error){
        if(controller.signal.aborted)return;
        const row=cached?{...cached.row,analysisStale:true}:{s,err:true};
        watchAnalysisCache.set(s,{bucket,row,failed:true,retryAt:Date.now()+Math.max(60000,error.retryAfterMs||0)});rows.push(row);
        if(error.status===429||error.status===418)controller.abort();
      }
    }
  }
  await Promise.all([worker(),worker()]);if(version!==watchVersion)return;
  state.watch=list.map(s=>rows.find(r=>r.s===s)||watchAnalysisCache.get(s)?.row||{s,err:true});
  for(const row of state.watch){const quote=watchQuoteMap.get(row.s);if(quote&&!row.err&&quote.time>row.priceAt){row.px=quote.px;row.priceAt=quote.time;}}
  const times=state.watch.map(w=>w.analysisAt).filter(Number.isFinite);
  state.watchAt=times.length?Math.min(...times):0;state.watchLoaded=true;renderWatch();loadWatchPrices();
}
async function loadWatchPrices(){
  if(!watchList().length||Date.now()<client.cooldownUntil)return;
  if(!watchQuoteRequest&&Date.now()-watchQuotesAt>=15000){
    watchQuoteRequest=client.json('/fapi/v2/ticker/price').then(rows=>{
      if(!Array.isArray(rows))throw new Error('관심 종목 가격 응답 오류');
      watchQuoteMap=new Map(rows.filter(r=>Number(r.price)>0).map(r=>[r.symbol,{px:+r.price,time:Date.now()}]));
      watchQuotesAt=Date.now();state.watchPriceStale=false;
    }).catch(()=>{state.watchPriceStale=true;}).finally(()=>{watchQuoteRequest=null;});
  }
  if(watchQuoteRequest)await watchQuoteRequest;
  for(const row of state.watch){const quote=watchQuoteMap.get(row.s);if(quote&&!row.err){row.px=quote.px;row.priceAt=quote.time;}}
  renderWatch();
}
function renderWatch() {
  const box=$('watch');if(!box) return;
  if(!state.watchLoaded && !state.watch.length){box.textContent='관심 종목 분석 중…';return;}
  if(!watchList().length){box.innerHTML='<p class="note">관심 종목이 없습니다. 상단 별 버튼으로 추가하세요.</p>';return;}
  // Selected-symbol snapshots can complete after a newer current-price update.
  const selected=state.watch.find(w=>w?.s===state.data?.symbol);
  if(state.ready&&selected&&bars.length&&!selected.err){selected.px=bars.at(-1).c;selected.priceAt=state.lastTick;}
  box.innerHTML=`<table><thead><tr><th>종목</th><th>가격</th><th>D / 4H</th><th>계획</th></tr></thead><tbody>${state.watch.filter(Boolean).map(w=>`<tr class="${w.s===state.sym?'current':''}"><td><button class="pick" data-sym="${w.s}">${w.s.replace(/USDT$/,'')}</button></td>${w.err?'<td colspan="3" class="warn">조회 실패</td>':`<td data-watchprice="${w.s}" title="가격 조회 ${clock(w.priceAt)} KST">${price(w.px,w.s)}</td><td class="watch-dir">${side(w.d)} / ${side(w.i)}</td><td>${w.plan?side(w.plan.dir):'<span class="muted">WAIT</span>'}</td>`}</tr>`).join('')}</tbody></table><p class="note">${state.watchLoaded?(state.watchAt?'분석 '+fullKst(state.watchAt)+' KST':'분석 시각 없음')+' · 4H 마감 뒤 갱신':'분석 갱신 중…'}<br>가격은 30초 갱신 · 선택 종목은 현재 차트와 동일${state.watchPriceStale?'<br>가격 조회 지연 · 마지막 가격 유지':''}${state.watch.some(w=>w.analysisStale)?'<br>일부 방향 분석 갱신 지연':''}</p>`;
  for(const b of box.querySelectorAll('[data-sym]')) b.onclick=()=>switchSym(b.dataset.sym);
}
async function loadSymbols() {
  try {
    const [info,tickers]=await Promise.all([client.exchangeInfo(),client.json('/fapi/v1/ticker/24hr')]);
    const volume=new Map(tickers.map(t=>[t.symbol,+t.quoteVolume]));
    const symbols=info.symbols.filter(s=>s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT'&&s.status==='TRADING').map(s=>s.symbol).sort((a,b)=>(volume.get(b)||0)-(volume.get(a)||0));
    $('symlist').innerHTML=symbols.filter(s=>/^[\p{L}\p{N}]{1,30}USDT$/u.test(s)).map(s=>`<option value="${s}">${s.replace(/USDT$/,'')} · ${usd(volume.get(s)||0)} USDT</option>`).join('');
    $('sym').title=`바이낸스 USDT 무기한 ${symbols.length}종목 · 거래대금순`;
  } catch {$('sym').title='종목 목록 조회 실패 · USDT 무기한 심볼을 직접 입력할 수 있습니다';}
}
async function loadFutures() {
  if(Date.now()<client.cooldownUntil)return;
  futuresController?.abort();const controller=futuresController=new AbortController();const data=state.data;if(!data) return;
  const value=await client.futures(data.symbol,controller.signal);
  if(!selection.current(data) || controller.signal.aborted) return;
  state.futures=value;renderFutures();
}
// ---------- 강제 청산 스트림 (접속 이후 수신분만 집계) ----------
let liqSocket=null,liqTimer=null;
const liq={symbol:'',since:0,events:[],open:false};
function connectLiquidations(){
  clearTimeout(liqTimer);
  if(liqSocket){liqSocket.onmessage=liqSocket.onclose=liqSocket.onerror=null;liqSocket.close();liqSocket=null;}
  if(!state.ready||!state.data)return;
  const symbol=state.data.symbol;
  if(liq.symbol!==symbol){liq.symbol=symbol;liq.since=Date.now();liq.events=[];}
  try{
    const ws=liqSocket=new WebSocket(`${AngelMarket.FUTURES_WS}${symbol.toLowerCase()}@forceOrder`);
    liq.open=false;
    ws.onopen=()=>{if(liqSocket===ws){liq.open=true;renderLiquidations();}};
    ws.onmessage=event=>{
      try{
        const o=JSON.parse(event.data).o;if(!o||o.s!==liq.symbol)return;
        const amount=(+o.z||+o.q)*(+o.ap||+o.p);if(!(amount>0))return;
        // SELL 강제 주문 = 롱 포지션 청산, BUY = 숏 포지션 청산
        liq.events.push({t:+o.T||Date.now(),side:o.S==='SELL'?'long':'short',usd:amount});
        if(liq.events.length>1000)liq.events.shift();
        renderLiquidations();
      }catch{}
    };
    ws.onclose=()=>{if(liqSocket===ws){liqSocket=null;liq.open=false;renderLiquidations();liqTimer=setTimeout(connectLiquidations,30000);}};
  }catch{}
}
function renderLiquidations(){
  const box=$('liqBox');if(!box||liq.symbol!==state.data?.symbol)return;
  const sum=(side,since=0)=>liq.events.filter(e=>e.side===side&&e.t>=since).reduce((s,e)=>s+e.usd,0),recent=Date.now()-300000;
  if(!liq.events.length){box.className='muted';box.textContent=liq.open?`수신 없음 · ${clock(liq.since)}부터 수집`:'청산 스트림 연결 중 · 집계 안 됨';return;}
  box.className='';
  box.innerHTML=`<span class="S">롱 청산 ${usd(sum('long'))}</span> / <span class="L">숏 청산 ${usd(sum('short'))}</span> USDT<br><span class="muted">최근 5분 롱 ${usd(sum('long',recent))} / 숏 ${usd(sum('short',recent))} · ${clock(liq.since)}부터</span>`;
}
let sentimentController=null;
async function loadSentiment() {
  if(Date.now()<client.cooldownUntil)return;
  const data=state.data;if(!data) return;
  if(state.sentiment?.symbol===data.symbol&&Date.now()-state.sentiment.receivedAt<240000)return;
  sentimentController?.abort();const controller=sentimentController=new AbortController();
  try{
    const value=await client.sentiment(data.symbol,controller.signal);
    if(!selection.current(data) || controller.signal.aborted) return;
    state.sentiment=value;renderFutures();
  }catch{}
}
function sentimentHtml() {
  const s=state.sentiment;if(!s||s.symbol!==state.data?.symbol)return '';
  const account=s.account?.at(-1),taker=s.taker?.at(-1),hist=s.oiHist;
  const rows=[];
  if(account&&+account.longAccount>0)rows.push(`<div class="row"><span>롱 / 숏 계정 비율</span><span>롱 ${(+account.longAccount*100).toFixed(1)}% / 숏 ${(+account.shortAccount*100).toFixed(1)}%<br><span class="muted">비율 ${(+account.longShortRatio).toFixed(2)} · 5분</span></span></div>`);
  if(taker&&+taker.buySellRatio>0)rows.push(`<div class="row"><span>테이커 매수 / 매도</span><span>${(+taker.buySellRatio).toFixed(2)}<br><span class="muted">${+taker.buySellRatio>=1?'시장가 매수 우위':'시장가 매도 우위'} · 5분</span></span></div>`);
  if(hist?.length>1){const first=+hist[0].sumOpenInterest,last=+hist.at(-1).sumOpenInterest,hours=Math.round((hist.at(-1).timestamp-hist[0].timestamp)/H);if(first>0&&last>0)rows.push(`<div class="row"><span>OI ${hours}시간 변화</span><span>${sgn(pct(last,first))}%<br><span class="muted">급락과 함께 줄면 포지션 정리 가능성</span></span></div>`);}
  return rows.length?rows.join('')+'<p class="note">계정 비율·테이커 비율은 분위기 참고 지표이며 방향 신호가 아닙니다. 5분마다 갱신합니다.</p>':'';
}
function renderFutures() {
  const box=$('futuresContent');if(!box) return;
  const f=state.futures;if(!f || f.symbol!==state.data?.symbol) return;
  box.setAttribute('aria-busy','false');
  const premium=f.premium,oi=f.oi,ticker=f.ticker,book=f.book;
  const mark=premium?+premium.markPrice:NaN,index=premium?+premium.indexPrice:NaN;
  const funding=premium?+premium.lastFundingRate*100:NaN;
  const bid=book?+book.bidPrice:NaN,ask=book?+book.askPrice:NaN;
  const spread=bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*10000:NaN;
  const value=v=>Number.isFinite(v)?price(v):'조회 실패';
  const oiQty=oi?+oi.openInterest:NaN;
  box.innerHTML=`<div class="metric-grid"><div class="metric"><span class="label">마크가격</span><span class="value">${value(mark)}</span><small>청산·미실현손익 기준 참고</small></div><div class="metric"><span class="label">지수가격</span><span class="value">${value(index)}</span><small>현물 지수</small></div><div class="metric"><span class="label">펀딩비</span><span class="value ${funding>0?'S':funding<0?'L':''}">${Number.isFinite(funding)?(funding>=0?'+':'')+funding.toFixed(4)+'%':'조회 실패'}</span><small>${funding>0?'양수 · 롱 → 숏 지급':funding<0?'음수 · 숏 → 롱 지급':'정산률 확인'}</small></div><div class="metric"><span class="label">다음 펀딩 정산</span><span class="value" id="fundingCountdown">${premium?duration(+premium.nextFundingTime-Date.now()):'조회 실패'}</span><small>${premium?kst(+premium.nextFundingTime)+' KST':'—'}</small></div></div><div class="row"><span>마크 / 지수 괴리</span><span>${mark>0&&index>0?sgn(pct(mark,index))+'%':'조회 실패'}</span></div><div class="row"><span>미결제약정 OI</span><span>${Number.isFinite(oiQty)?fmt(oiQty):'조회 실패'} ${state.sym.replace(/USDT$/,'')}<br><span class="muted">${Number.isFinite(oiQty)&&mark>0?'≈ '+usd(oiQty*mark)+' USDT':'명목 환산 조회 실패'}</span></span></div><div class="row"><span>24h 거래대금</span><span>${ticker?usd(+ticker.quoteVolume)+' USDT':'조회 실패'}</span></div><div class="row"><span>24h 고가 / 저가</span><span>${ticker?price(+ticker.highPrice)+' / '+price(+ticker.lowPrice):'조회 실패'}</span></div><div class="row"><span>매수 / 매도 최우선 호가</span><span>${value(bid)} / ${value(ask)}</span></div><div class="row"><span>호가 스프레드</span><span>${Number.isFinite(spread)?spread.toFixed(2)+' bps':'조회 실패'}</span></div><p class="note">${clock(f.receivedAt)} KST 조회 · 30초마다 갱신<br>스프레드 1 bps = 0.01% · OI는 방향 신호가 아닙니다. 펀딩비는 정산 전 변동할 수 있습니다.${f.errors.length?'<br><span class="warn">일부 데이터 조회 실패 · 다음 갱신에서 재시도</span>':''}</p>${sentimentHtml()}`;
  if($('quoteChange')&&ticker) {$('quoteChange').textContent=`${sgn(+ticker.priceChangePercent)}% · 24h`;$('quoteChange').className=+ticker.priceChangePercent>=0?'L':'S';} else if($('quoteChange')) {$('quoteChange').textContent='24h 조회 실패';$('quoteChange').className='muted';}
}
async function load(keepView=false) {
  if(keepView&&state.ready&&state.data?.symbol===state.sym&&state.data?.timeframe===state.tf)return refreshCurrent();
  analysisController?.abort();analysisController=null;state.refreshing=false;
  clearTimeout(reconnectTimer);clearTimeout(refreshTimer);clearTimeout(liveUiTimer);liveUiTimer=null;
  pricePollController?.abort();pricePollController=null;
  futuresController?.abort();
  const symbol=state.sym,timeframe=state.tf,view=keepView?chart.timeScale().getVisibleLogicalRange():null;
  const same=state.data?.symbol===symbol&&state.data?.timeframe===timeframe;
  state.ready=false;state.loading=true;setMode(null);syncControls();
  $('panel').setAttribute('aria-busy','true');
  if(!same){clearChart();state.futures=null;state.sentiment=null;$('panel').innerHTML='<section class="card muted">선물 데이터 확인 중…</section>';$('panel').scrollTop=0;$('analysisTime').textContent='분석 주기 · 일봉 / 4H';}
  $('decisionState').textContent='확인 중';$('decisionState').style.color='var(--muted)';$('decisionReason').textContent=`${symbol} · USDT 무기한 데이터 조회 중`;$('decisionRisk').textContent='데이터 확인 전 판단·도구 일시 중지';
  $('lastTick').textContent='바이낸스 USDT 무기한';
  setStatus('선물 데이터 연결 중');chartState('시장 데이터 확인 중',`${symbol} · ${timeframe} / 일봉·4H 마감 데이터`);
  try {
    const data=await selection.load(symbol,timeframe);if(!data) return;
    state.data=data;state.ready=true;state.loading=false;state.lastTick=Date.now();state.lastWsAt=0;state.transport='REST';state.analysisStale=false;refreshFailures=0;bars=data.bars;
    result=analyze(data.h4,data.d1,Date.now());
    applyPriceFormat(data.meta);
    candles.setData(bars.map(toCandle));volume.setData(bars.map(toVolume));
    render();
    if(view&&same) chart.timeScale().setVisibleLogicalRange(view);
    else {const visible=matchMedia('(max-width:540px)').matches?70:130;chart.timeScale().setVisibleLogicalRange({from:Math.max(0,bars.length-visible),to:bars.length+8});}
    chart.priceScale('right').applyOptions({autoScale:state.auto});
    $('chartState').hidden=true;syncControls();setMode(null);notifyNew();
    setStatus('실시간 연결 중');
    connectLive(data);connectLiquidations();
    scheduleRefresh(H4-Date.now()%H4+5000);loadFutures();loadSentiment();
    if(pendingJump!=null){const time=pendingJump;pendingJump=null;focusSignal(time);}
  } catch(error) {
    state.ready=false;state.loading=false;selection.stopSocket();connectLiquidations();clearChart();syncControls();
    const message=error.name==='AbortError'?'선물 서버 응답 시간이 초과되었습니다':error.message;
    setStatus('선물 데이터 연결 실패','err');chartState('선물 데이터를 불러오지 못했습니다',message,true);
    $('panel').setAttribute('aria-busy','false');$('panel').innerHTML=`<section class="card"><h3>연결 오류</h3><p class="warn">${escapeHtml(message)}</p><p class="note">종목 철자와 네트워크를 확인하세요. 현물 데이터로 대체하지 않습니다.</p><button id="backBtc">BTCUSDT 열기</button></section>`;
    $('backBtc').onclick=()=>switchSym('BTCUSDT');$('decisionState').textContent='연결 오류';$('decisionReason').textContent='이전 차트 표시 중지 · 다시 연결하세요';$('decisionRisk').textContent='데이터 확인 전 판단 불가';
  }
}
async function refreshCurrent(){
  if(state.refreshing||!state.ready)return;
  const data=state.data,controller=analysisController=new AbortController();
  const view=chart.timeScale().getVisibleRange();
  const following=!view||view.to>=sec(bars.at(-1).t);
  const revision=state.liveRevision,since=bars.at(-1).t;
  state.refreshing=true;
  if($('refreshAnalysis'))$('refreshAnalysis').disabled=true;
  try{
    const next=await selection.refresh(data,controller.signal);
    if(!next||controller.signal.aborted||!selection.current(data))return;
    const preserve=following?null:{from:(view.from-KST)*1000,to:(view.to-KST)*1000};
    const merged=mergeRefreshBars(next.bars,bars,revision!==state.liveRevision?since:Infinity,preserve);
    state.data=next;bars=merged;state.analysisStale=false;refreshFailures=0;if(revision===state.liveRevision){state.lastTick=next.receivedAt;state.transport='REST';}
    if(next.timeframe==='4h')next.h4=mergeRefreshBars(next.h4,merged,revision!==state.liveRevision?since:Infinity);
    if(next.timeframe==='1d')next.d1=mergeRefreshBars(next.d1,merged,revision!==state.liveRevision?since:Infinity);
    result=analyze(next.h4,next.d1,Date.now());
    candles.setData(bars.map(toCandle));volume.setData(bars.map(toVolume));applyPriceFormat(next.meta);render();
    if(following)chart.timeScale().scrollToRealTime();else chart.timeScale().setVisibleRange(view);
    if(!selection.socket||selection.socket.readyState>1)connectLive(next);
    scheduleRefresh(H4-Date.now()%H4+5000);notifyNew();loadWatch();
    setStatus(state.transport==='WS'?'실시간':'REST 보완 · 5초 갱신',state.transport==='WS'?'live':'');
  }catch(error){
    if(controller.signal.aborted||!selection.current(data))return;
    state.analysisStale=true;refreshFailures++;
    const delay=Math.max(error.retryAfterMs||0,Math.min(120000,10000*2**Math.min(refreshFailures-1,4)));
    setStatus('분석 갱신 지연 · 기존 화면 유지 · 자동 재시도','err');
    if($('analysisAt'))$('analysisAt').textContent=`분석 ${fullKst(data.receivedAt)} KST · 갱신 지연 · 자동 재시도`;
    updateSummary();scheduleRefresh(delay);
  }finally{
    if(analysisController===controller){analysisController=null;state.refreshing=false;if($('refreshAnalysis'))$('refreshAnalysis').disabled=false;}
  }
}
function connectLive(data){
  clearTimeout(reconnectTimer);
  if(!state.ready||!selection.current(data))return;
  selection.connect(data,{
      open:()=>setStatus('소켓 연결 · 시세 확인 중'),
      tick:(bar,closed)=>{
        if(!state.ready || !selection.current(data)) return;
        state.lastWsAt=Date.now();applyLiveBar(bar,closed,'WS');
      },
      close:()=>{if(!state.ready)return;setStatus('소켓 연결 끊김 · REST 보완');reconnectTimer=setTimeout(()=>connectLive(state.data),30000);},
      error:message=>setStatus(message,'err')
    });
}
function applyLiveBar(bar,closed,transport) {
  const last=bars.at(-1);if(!state.ready||!last||bar.t<last.t) return;
  const expected=TF_SEC[state.data.timeframe]*1000;
  if(bar.t>last.t+expected){setStatus('누락 구간 복구 중','err');load(true);return;}
  if(bar.t===last.t) bars[bars.length-1]=bar;else bars.push(bar);
  if(bars.length>5000){bars=bars.slice(-5000);candles.setData(bars.map(toCandle));volume.setData(bars.map(toVolume));}
  else{candles.update(toCandle(bar));volume.update(toVolume(bar));}
  state.lastTick=Date.now();state.transport=transport;state.liveRevision++;
  setStatus(state.analysisStale?'가격 갱신 중 · 분석 재시도':transport==='WS'?'실시간':'REST 보완 · 5초 갱신',state.analysisStale?'err':transport==='WS'?'live':'');
  updateLiveIndicators();renderLegend(null);checkAlerts(bar.c);queueLiveUi();scheduleAxisCaptions();
  if(closed){
    if(expected<H4&&(bar.t+expected)%H4!==0){const data=state.data;requestAnimationFrame(()=>{if(state.ready&&selection.current(data))render();});}
    else scheduleRefresh(3000);
  }
}
async function pollLatestPrice() {
  if(!state.ready||state.loading||document.hidden||!navigator.onLine||pricePollController||Date.now()<client.cooldownUntil||Date.now()-state.lastWsAt<8000) return;
  const data=state.data,controller=pricePollController=new AbortController();
  try {
    const latest=await selection.latest(data,controller.signal);
    if(!latest||controller.signal.aborted||!state.ready||!selection.current(data)) return;
    for(const bar of latest){if(!state.ready||!selection.current(data)) break;applyLiveBar(bar,bar.ct<Date.now(),'REST');}
  } catch(error){if(!controller.signal.aborted&&selection.current(data)) setStatus('가격 조회 지연 · 재시도 중','err');}
  finally{if(pricePollController===controller)pricePollController=null;}
}
function scheduleRefresh(ms) {clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>load(true),ms);}
function focusSignal(time) {
  const at=eventBar(bars,time);if(at==null) return toast('조회 가능한 캔들 범위 밖입니다. 해당 주기로 이동 후 다시 확인하세요');
  const span=40*TF_SEC[state.tf];chart.timeScale().setVisibleRange({from:sec(at)-span,to:sec(at)+span});setAuto(true);
  $('analysisTime').textContent='과거 위치 보기 · 오른쪽 판단은 최신 마감 기준';
}
function jumpSignal(time,module) {
  if(!state.ready) return;
  if(eventBar(bars,time)!=null) return focusSignal(time);
  pendingJump=time;state.tf=module==='일봉'?'1d':'4h';store.set('omni-tf',state.tf);syncControls();toast('기록을 확인할 수 있는 신호 주기로 전환합니다');load();
}
function switchSym(value) {
  const symbol=value.trim().toUpperCase();
  if(!/^[\p{L}\p{N}]{1,30}USDT$/u.test(symbol)) {$('sym').value=state.sym;return toast('USDT 무기한 심볼을 입력하세요 · 예: BTCUSDT');}
  if(symbol===state.sym&&(state.ready||state.loading)) return;
  state.sym=symbol;pendingJump=null;store.set('omni-sym',symbol);syncControls();load();
}
$('symbolForm').onsubmit=e=>{e.preventDefault();switchSym($('sym').value);};
$('sym').onchange=()=>switchSym($('sym').value);
$('tf').onclick=e=>{const tf=e.target.dataset.tf;if(!TF_SEC[tf]||tf===state.tf&&state.ready)return;state.tf=tf;pendingJump=null;store.set('omni-tf',tf);syncControls();load();};
$('layers').onchange=e=>{const key=e.target.dataset.layer;if(!Object.hasOwn(LAYER_DEFAULT,key))return;state.layers[key]=e.target.checked;store.set('angel-layers-v3',state.layers);syncControls();if(state.ready)render();};
$('presets').onclick=e=>{
  const preset=e.target.dataset.preset;if(!preset)return;
  const enabled=preset==='focus'?['signals','plans','levels','zone','volume','mine','shock']:preset==='structure'?['signals','plans','trend','shortTrend','levels','sr','fib','zone','volume','mine','shock']:Object.keys(LAYER_DEFAULT);
  state.layers=Object.fromEntries(Object.keys(LAYER_DEFAULT).map(k=>[k,enabled.includes(k)]));store.set('angel-layers-v3',state.layers);syncControls();if(state.ready)render();toast(`${preset==='focus'?'집중':preset==='structure'?'구조':'전체'} 레이어 적용`);
};
document.addEventListener('click',e=>{if(!$('layerMenu').contains(e.target))$('layerMenu').open=false;});
$('closeLayers').onclick=()=>{$('layerMenu').open=false;document.querySelector('#layerMenu summary').focus();};
function positionLayerMenu(){
  if(!$('layerMenu').open||!matchMedia('(max-width:900px)').matches)return;
  const menu=document.querySelector('#layerMenu .menu'),anchor=document.querySelector('#layerMenu summary').getBoundingClientRect();
  const top=Math.min(anchor.bottom+8,Math.max(8,innerHeight-menu.offsetHeight-12));
  menu.style.setProperty('--menu-top',`${top}px`);
}
$('layerMenu').addEventListener('toggle',positionLayerMenu);
window.addEventListener('resize',positionLayerMenu);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){setMode(null);$('layerMenu').open=false;return;}
  if(e.ctrlKey||e.metaKey||e.altKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)return;
  if(e.key.toLowerCase()==='a')setAuto(!state.auto);
  if(e.key.toLowerCase()==='l')$('goLive').click();
  if(e.key.toLowerCase()==='h'&&state.ready)setMode('line');
  if(e.key.toLowerCase()==='t'&&state.ready)setMode('trend');
});
$('retry').onclick=()=>load();
document.querySelector('.skip').onclick=()=>$('panel').focus({preventScroll:true});
const layoutObserver=new ResizeObserver(()=>document.documentElement.style.setProperty('--chrome-height',`${Math.ceil($('header').getBoundingClientRect().height+document.querySelector('.toolbar').getBoundingClientRect().height+$('decision').getBoundingClientRect().height)}px`));
for(const el of [$('header'),document.querySelector('.toolbar'),$('decision')])layoutObserver.observe(el);
function heartbeat(){
  const now=Date.now();if($('cd4'))$('cd4').textContent=countdown(H4);if($('cd1'))$('cd1').textContent=countdown(DAY);
  if($('fundingCountdown')&&state.futures?.premium)$('fundingCountdown').textContent=duration(+state.futures.premium.nextFundingTime-now);
  if(state.ready){const age=Math.floor((now-state.lastTick)/1000);$('lastTick').textContent=`마지막 수신 ${age}초 전 · ${state.transport==='WS'?'WebSocket':'REST'} · KST`;if(client.cooldownUntil>now)setStatus(`조회 제한 · ${duration(client.cooldownUntil-now)} 후 재시도`,'err');else if(age>30)setStatus('시세 지연 · 마지막 수신 확인','err');if(age>30)updateSummary();if(age>60&&!state.loading&&!state.refreshing&&!state.analysisStale&&navigator.onLine&&now>=client.cooldownUntil)load(true);}
}
setInterval(heartbeat,1000);
setInterval(pollLatestPrice,5000);
setInterval(()=>{if(state.ready&&!document.hidden)loadFutures();},30000);
setInterval(()=>{if(state.ready&&!document.hidden)loadSentiment();},60000);
setInterval(()=>{if(!document.hidden)loadWatch();},60000);
setInterval(()=>{if(!document.hidden)loadWatchPrices();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(state.ready){if(Math.floor((Date.now()-5000)/H4)>Math.floor(state.data.receivedAt/H4))load(true);else pollLatestPrice();}loadWatch();loadFutures();}});
window.addEventListener('online',()=>{if(!state.loading)load(true);});
window.addEventListener('offline',()=>setStatus('오프라인 · 시세 감시 일시 중지','err'));
if(typeof LightweightCharts==='undefined'){chartState('차트 라이브러리 로딩 실패','네트워크 연결을 확인한 뒤 새로고침하세요',true);}else{syncControls();load();loadWatch();loadSymbols();window.angelAreumStarted=true;}
