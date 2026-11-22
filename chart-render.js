function analyzeChart(now) {
  const cb = contiguousTail(bars.filter(b => b.ct < now),TF_SEC[state.tf]*1000), atr = wilderAtr(cb, 14), a = atr.at(-1);
  const local = localLevels(cb, SR_PRD[state.tf], atr);
  const fib = fibAnchors(cb);
  const fibUseful = fib && a && fib.hi - fib.lo >= a;
  const px = bars.at(-1).c, r = result, tfSec = TF_SEC[state.tf];
  const cands = [];
  for (const lv of r.levels) cands.push({ p: lv.p, kind: "상위 레벨" });
  if (tfSec <= 86400) for (const tl of [r.trendSup, r.trendRes]) if (tl && !tl.broken) cands.push({ p: tl.at(now), kind: "장기 추세선" });
  if (fibUseful) cands.push({ p: fib.g50, kind: "피보나치" }, { p: fib.g618, kind: "피보나치" });
  for (const lv of local) if (lv.touches >= 2) cands.push({ p: lv.p, kind: "지지·저항" });
  const dir = tfSec <= 86400 && r.dailySide ? r.dailySide : tfSec <= 14400 ? r.ichiSide : 0;
  const zone = dir && a ? pickZone(cands, px, a, dir === -1) : null;
  // 단기 추세선: 현재 차트 주기의 좌우 5봉 피벗으로 같은 규칙(낮아지는 고점·높아지는 저점, 종가 이탈)을 쓴다.
  // 지지·저항용 피벗(8~15봉)은 급락·급등 중에 새 쌍이 늦게 생겨 최근 흐름을 놓친다.
  const shortSup = longTrend(cb, 5, false), shortRes = longTrend(cb, 5, true);
  // 급변동: 현재 차트 주기의 마감 봉 기준. 4H 상태는 차트 주기와 무관하게 함께 본다.
  const shock = shockEvents(cb, tfSec * 1000);
  const shock4 = tfSec === 14400 ? shock : shockEvents((state.data?.h4 || []).filter(b => b.ct < now), H4);
  return { local, fib: fibUseful ? fib : null, zone: zone && { ...zone, below: dir === -1, half: a * 0.3 }, atr: a, shortSup, shortRes, shock, shock4, rsi: rsi(cb, 14).at(-1) };
}

// ---------- 차트 ----------
const chart = LightweightCharts.createChart($("chart"), {
  autoSize: true,
  layout: { background: { color: "#090d16" }, textColor: "#c7d6ec", fontFamily: "system-ui, 'Malgun Gothic', sans-serif", fontSize: 12 },
  grid: { vertLines: { color: "rgba(126,150,184,.065)" }, horzLines: { color: "rgba(126,150,184,.065)" } },
  rightPriceScale: { borderColor: "#232838", autoScale: true, scaleMargins: {top: .14, bottom: .15} },
  timeScale: { borderColor: "#232838", timeVisible: true, rightOffset: 12 },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
});
const candles = chart.addCandlestickSeries({ upColor: "#14b8a6", downColor: "#ef4444", borderVisible: false, wickUpColor: "#14b8a6", wickDownColor: "#ef4444" });
const volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
const lineOpts = { autoscaleInfoProvider: () => null, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
const emaSeries = { ema20: ["#f59e0b", 20], ema50: ["#d946ef", 50], ema200: ["#facc15", 200] };
for (const k in emaSeries) emaSeries[k] = { s: chart.addLineSeries({ ...lineOpts, color: emaSeries[k][0], lineWidth: k === "ema200" ? 2 : 1 }), n: emaSeries[k][1] };
const supLine = chart.addLineSeries({ ...lineOpts, color: "#35e0bd", lineWidth: 3 });
const resLine = chart.addLineSeries({ ...lineOpts, color: "#ff7189", lineWidth: 3 });
const stSupLine = chart.addLineSeries({ ...lineOpts, color: "#35e0bd", lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed });
const stResLine = chart.addLineSeries({ ...lineOpts, color: "#ff7189", lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed });
const sqLine = chart.addLineSeries({ ...lineOpts, color: "#a855f7", lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dotted });
const srSeries = [0, 1, 2, 3].map(() => chart.addLineSeries({ ...lineOpts, lineWidth: 2, lastValueVisible: false }));
const fibSeries = [0, 1].map(() => chart.addLineSeries({ ...lineOpts, color: "#f6ce7e", lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, lastValueVisible: true }));
const bbSeries = [0, 1].map(() => chart.addLineSeries({ ...lineOpts, color: "rgba(140,174,255,.7)", lineWidth: 1 }));
const rsiSeries = chart.addLineSeries({ ...lineOpts, priceScaleId: "rsi", color: "#c4a5ff", lineWidth: 2, priceFormat: { type: "price", precision: 1, minMove: 0.1 }, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
const { autoscaleInfoProvider: _fixedScale, ...subLine } = lineOpts;
const macdHist = chart.addHistogramSeries({ priceScaleId: "macd", lastValueVisible: false, priceLineVisible: false });
const macdSeries = [["#8caeff", 2], ["#ffb86c", 1]].map(([color, lineWidth]) => chart.addLineSeries({ ...subLine, priceScaleId: "macd", color, lineWidth }));
const vwapSeries = chart.addLineSeries({ ...lineOpts, color: "#38bdf8", lineWidth: 2, lineStyle: LightweightCharts.LineStyle.LargeDashed });
const trendSeries = [];
let rsiGuides = [];
// 하단 보조 지표는 거래량 위에 20%씩 쌓고, 그만큼 캔들 영역을 줄인다.
function applySubPanes(names) {
  names.forEach((name, i) => chart.priceScale(name).applyOptions({ scaleMargins: { top: 0.86 - 0.2 * (i + 1), bottom: 0.16 + 0.2 * i } }));
  chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.14, bottom: 0.15 + 0.2 * names.length + (names.length ? 0.01 : 0) } });
}
const macdPoint = (b, v) => ({ time: sec(b.t), value: v.hist, color: v.hist >= 0 ? "rgba(37,207,172,.55)" : "rgba(255,101,127,.55)" });
let priceLines = [];
let bars = [], result = null, local = null;
let axisCandidates=[],axisLabels=[],axisFrame=null;
function clearAxisCaptions(){for(const line of axisLabels)candles.removePriceLine(line);axisLabels=[];axisCandidates=[];}
function scheduleAxisCaptions(){if(axisFrame==null)axisFrame=requestAnimationFrame(updateAxisCaptions);}
function updateAxisCaptions(){
  axisFrame=null;for(const line of axisLabels)candles.removePriceLine(line);axisLabels=[];
  if(!state.ready||!bars.length)return;
  const top=candles.coordinateToPrice(0),near=candles.coordinateToPrice(26);
  const tolerance=top!=null&&near!=null?Math.abs(top-near):(local?.atr||bars.at(-1).c*.005);
  const visible=axisCandidates.filter(level=>{const y=candles.priceToCoordinate(level.p);return y!=null&&y>=0&&y<=$('chart').clientHeight;});
  const groups=groupAxisLevels(visible,bars.at(-1).c,tolerance);
  for(const group of groups){
    const text=group.side==='res'?'저항':'지지',count=group.items.length;
    const title=count>1?`${text} ×${count}`:group.items[0].title;
    axisLabels.push(candles.createPriceLine({price:group.p,color:group.side==='res'?'#ff7189':'#35e0bd',lineVisible:false,axisLabelVisible:true,title}));
  }
  if($('axisGroups'))$('axisGroups').textContent=groups.filter(g=>g.items.length>1).map(g=>`${g.side==='res'?'저항':'지지'} ${g.items.length}개 묶음: ${price(g.low)}–${price(g.high)} (${g.items.map(v=>v.title).join(' / ')})`).join(' · ');
}
chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleAxisCaptions);
new ResizeObserver(scheduleAxisCaptions).observe($('chart'));
$('chart').addEventListener('pointerup',scheduleAxisCaptions);
$('chart').addEventListener('wheel',scheduleAxisCaptions,{passive:true});
function applyPriceFormat(meta){
  const precision=tickPrecision(meta?.tickSize)??digits(bars.at(-1).c),minMove=Number(meta?.tickSize)||10**-precision;
  const priceFormat={type:'price',precision,minMove};
  for(const series of [candles,supLine,resLine,stSupLine,stResLine,sqLine,...srSeries,...fibSeries,...bbSeries,vwapSeries,...trendSeries,...Object.values(emaSeries).map(e=>e.s)])series.applyOptions({priceFormat});
}

function toCandle(b) { return { time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c }; }
function toVolume(b) { return { time: sec(b.t), value: b.v, color: b.c >= b.o ? "rgba(20,184,166,.35)" : "rgba(239,68,68,.35)" }; }

function updateLiveIndicators() {
  const last=bars.at(-1);if(!last) return;
  const continuous=contiguousTail(bars,TF_SEC[state.data.timeframe]*1000);
  for(const [key,e] of Object.entries(emaSeries)) {
    if(state.layers[key] && continuous.length>e.n) e.s.update({time:sec(last.t),value:ema(continuous,e.n).at(-1)});
  }
}

// 이벤트 시각 이후 첫 차트 봉에 표시한다.
// 볼린저·RSI는 진행 중 봉을 포함해 마지막 값만 갱신한다.
function updateLiveExtras() {
  const last=bars.at(-1);if(!last||!state.ready) return;
  const L=state.layers;if(!L.bb&&!L.rsi&&!L.macd&&!L.vwap) return;
  const continuous=contiguousTail(bars,TF_SEC[state.data.timeframe]*1000),time=sec(last.t);
  if(L.bb&&continuous.length>=20){const band=bollinger(continuous.slice(-20)).at(-1);bbSeries[0].update({time,value:band.upper});bbSeries[1].update({time,value:band.lower});}
  if(L.rsi&&continuous.length>15){const value=rsi(continuous.slice(-300),14).at(-1);if(value!=null)rsiSeries.update({time,value});}
  if(L.macd){const value=macd(continuous).at(-1);if(value){macdHist.update(macdPoint(last,value));macdSeries[0].update({time,value:value.macd});macdSeries[1].update({time,value:value.signal});}}
  if(L.vwap&&TF_SEC[state.data.timeframe]<=3600)vwapSeries.update({time,value:vwap(continuous.slice(-1500)).at(-1)});
}
function barAt(t) { const at = eventBar(bars, t); return at == null ? null : sec(at); }
const segment = (t1, t2, v1, v2) => t1 >= t2 ? [] : [{ time: sec(t1), value: v1 }, { time: sec(t2), value: v2 }];

function render() {
  if (!state.ready || !result || !bars.length) return;
  const r = result, L = state.layers, tfSec = TF_SEC[state.tf];
  const show4h = tfSec <= 14400, showDaily = tfSec <= 86400;
  const markers = [];
  if (L.signals) for (const p of r.plans) {
    if ((p.mod === "4H" && !show4h) || (p.mod === "일봉" && !showDaily)) continue;
    const time = barAt(p.t); if (time == null) continue;
    const strong = p.mod === "일봉";
    markers.push(p.dir === 1
      ? { time, position: "belowBar", shape: "arrowUp", color: strong ? "#14b8a6" : "#5eead4", text: strong ? "L 일봉" : "L" }
      : { time, position: "aboveBar", shape: "arrowDown", color: strong ? "#ef4444" : "#fca5a5", text: strong ? "S 일봉" : "S" });
  }
  if (L.sq && show4h) for (const e of r.sq.events) {
    const time = barAt(e.t); if (time == null) continue;
    markers.push(e.type === "entry" ? { time, position: "belowBar", shape: "circle", color: "#a855f7", text: "SQ" } : { time, position: "aboveBar", shape: "square", color: "#a855f7", text: "SQ 청산" });
  }
  if (L.trend && showDaily) for (const [tl, text, pos, color] of [[r.trendSup, "장기 지지 이탈", "aboveBar", "#ff657f"], [r.trendRes, "장기 저항 돌파", "belowBar", "#25cfac"]]) {
    if (!tl || !tl.broken) continue;
    const time = barAt(tl.breakT + DAY); if (time != null) markers.push({ time, position: pos, shape: pos === "aboveBar" ? "arrowDown" : "arrowUp", color, text });
  }
  local = analyzeChart(Date.now());
  if (L.shock) for (const e of local.shock.events) {
    const time = barAt(e.t); if (time == null) continue;
    markers.push(e.type === "drop" ? { time, position: "aboveBar", shape: "arrowDown", color: "#ff9f43", text: `급락 ${e.mag.toFixed(1)}ATR` }
      : e.type === "surge" ? { time, position: "belowBar", shape: "arrowUp", color: "#ffd166", text: `급등 ${e.mag.toFixed(1)}ATR` }
      : e.type === "rebound" ? { time, position: "belowBar", shape: "circle", color: "#7dd3fc", text: "반등" }
      : { time, position: "aboveBar", shape: "circle", color: "#fda4af", text: "반락" });
  }
  markers.sort((a, b) => a.time - b.time);
  candles.setMarkers(markers);

  for (const pl of priceLines) candles.removePriceLine(pl);
  priceLines = [];
  const addLine = (price, color, title, style = LightweightCharts.LineStyle.Solid, width = 1, axisLabelVisible=true) =>
    priceLines.push(candles.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible }));
  if (L.plans) for (const p of [r.dailyPlan, r.ichiPlan]) {
    if (!p || p.state !== "진행" || (p.mod === "4H" && !show4h) || (p.mod === "일봉" && !showDaily)) continue;
    addLine(p.sl, p.mod === "일봉" ? "#ef4444" : "#f97316", `${p.mod} 손절`, LightweightCharts.LineStyle.Solid, p.mod === "일봉" ? 2 : 1);
    addLine(p.tp, p.mod === "일봉" ? "#22c55e" : "#84cc16", `${p.mod} 익절`, LightweightCharts.LineStyle.Solid, p.mod === "일봉" ? 2 : 1);
  }
  const px = bars.at(-1).c, near = nearest(r.levels, px), lastT = bars.at(-1).t;
  if (L.levels) {
    if (near.res) addLine(near.res.p, "#ff7189", `${near.res.label} 저항`, LightweightCharts.LineStyle.Dashed, 2,false);
    if (near.sup) addLine(near.sup.p, "#35e0bd", `${near.sup.label} 지지`, LightweightCharts.LineStyle.Dashed, 2,false);
  }
  if (L.mine) for (const p of readDrawings('line')) addLine(p, "#79bfff", "내 선", LightweightCharts.LineStyle.Solid, 2);
  for (const a of readDrawings('alert')) addLine(a.p, "#f4cc79", "알림", LightweightCharts.LineStyle.SparseDotted, 2);

  const trendData = tl => !L.trend || !tl || !showDaily ? [] : segment(Math.max(tl.t1, bars[0].t), tl.broken ? tl.breakT : lastT, tl.at(Math.max(tl.t1, bars[0].t)), tl.at(tl.broken ? tl.breakT : lastT));
  supLine.setData(trendData(r.trendSup));
  resLine.setData(trendData(r.trendRes));
  supLine.applyOptions({ color: r.trendSup && r.trendSup.broken ? "rgba(255,113,137,.55)" : "#35e0bd", lineStyle: r.trendSup?.broken ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid });
  resLine.applyOptions({ color: r.trendRes && r.trendRes.broken ? "rgba(53,224,189,.55)" : "#ff7189", lineStyle: r.trendRes?.broken ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid });
  sqLine.setData(L.sq && r.sq.on && show4h ? segment(lastT - 20 * H4, lastT, r.sq.basis, r.sq.basis) : []);

  const continuous=contiguousTail(bars,tfSec*1000);
  for (const k in emaSeries) {
    const e = emaSeries[k];
    if (!L[k] || continuous.length < e.n) { e.s.setData([]); continue; }
    const v = ema(continuous, e.n);
    e.s.setData(continuous.slice(e.n).map((b, i) => ({ time: sec(b.t), value: v[i + e.n] })));
  }
  volume.applyOptions({ visible: L.volume });

  // 급변동 구간이 진행 중이면 되돌림 기준 가격을 표시한다.
  const leg = L.shock ? local.shock.leg : null;
  if (leg) for (const [value, title] of [[leg.r382, "되돌림 38%"], [leg.r50, "되돌림 50%"], [leg.r618, "되돌림 62%"]])
    addLine(value, "#7dd3fc", title, LightweightCharts.LineStyle.Dotted, 1, false);
  const bands = L.bb && continuous.length >= 20 ? bollinger(continuous) : null;
  bbSeries.forEach((s, k) => s.setData(bands ? continuous.slice(19).map((b, i) => ({ time: sec(b.t), value: k ? bands[i + 19].lower : bands[i + 19].upper })) : []));
  const rsiValues = L.rsi && continuous.length > 15 ? rsi(continuous, 14) : null;
  rsiSeries.setData(rsiValues ? continuous.map((b, i) => ({ time: sec(b.t), value: rsiValues[i] })).filter(p => p.value != null) : []);
  for (const line of rsiGuides) rsiSeries.removePriceLine(line);
  rsiGuides = rsiValues ? [70, 30].map(value => rsiSeries.createPriceLine({ price: value, color: "rgba(196,165,255,.45)", lineStyle: LightweightCharts.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: `RSI ${value}` })) : [];
  const macdValues = L.macd && continuous.length > 40 ? macd(continuous) : null;
  const macdRows = macdValues ? continuous.map((b, i) => [b, macdValues[i]]).filter(row => row[1]) : [];
  macdHist.setData(macdRows.map(([b, v]) => macdPoint(b, v)));
  macdSeries[0].setData(macdRows.map(([b, v]) => ({ time: sec(b.t), value: v.macd })));
  macdSeries[1].setData(macdRows.map(([b, v]) => ({ time: sec(b.t), value: v.signal })));
  applySubPanes([rsiValues && "rsi", macdValues && "macd"].filter(Boolean));
  const vwapValues = L.vwap && tfSec <= 3600 ? vwap(continuous) : null;
  vwapSeries.setData(vwapValues ? continuous.map((b, i) => ({ time: sec(b.t), value: vwapValues[i] })) : []);
  // 내 추세선: 두 점을 지나 최신 봉까지 연장한다.
  const trends = L.mine ? readTrends() : [];
  while (trendSeries.length < trends.length) trendSeries.push(chart.addLineSeries({ ...lineOpts, color: "#79bfff", lineWidth: 2, priceFormat: candles.options().priceFormat }));
  trendSeries.forEach((s, k) => {
    const tr = trends[k], start = tr ? eventBar(bars, Math.max(tr.t1, bars[0].t)) : null;
    s.setData(tr && start != null ? segment(start, lastT, trendAt(tr, start), trendAt(tr, lastT)) : []);
  });
  // 지지·저항: 2회 이상 확인된 강한 레벨은 굵은 실선, 1회 레벨은 옅은 점선으로 모두 그린다.
  const srLevels = L.sr ? local.local : [];
  axisCandidates=[...(L.levels?[near.res,near.sup].filter(Boolean).map(lv=>({p:lv.p,title:`${lv.label} ${lv.p>=px?'저항':'지지'}`})):[]),...srLevels.map(lv=>({p:lv.p,title:`${lv.p>=px?'저항':'지지'} ${lv.touches}회`}))];
  srSeries.forEach((s, k) => {
    const lv = srLevels[k];
    if (!lv) { s.setData([]); return; }
    const res = lv.p > px, strongLv = lv.touches >= 2;
    s.applyOptions({
      color: res ? (strongLv ? "#ff7189" : "rgba(255,113,137,.7)") : (strongLv ? "#35e0bd" : "rgba(53,224,189,.7)"),
      lineWidth: strongLv ? 3 : 2, lineStyle: strongLv ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dotted,
      title: "",
    });
    s.setData(segment(Math.max(lv.t, bars[0].t), lastT, lv.p, lv.p));
  });
  const shortData = t => !L.shortTrend || !t ? [] : segment(Math.max(t.t1, bars[0].t), t.broken ? t.breakT : lastT, t.at(Math.max(t.t1, bars[0].t)), t.at(t.broken ? t.breakT : lastT));
  stSupLine.setData(shortData(local.shortSup));
  stResLine.setData(shortData(local.shortRes));
  stSupLine.applyOptions({ color: local.shortSup && local.shortSup.broken ? "rgba(255,113,137,.5)" : "#35e0bd",lineWidth: local.shortSup?.broken?2:3 });
  stResLine.applyOptions({ color: local.shortRes && local.shortRes.broken ? "rgba(53,224,189,.5)" : "#ff7189",lineWidth: local.shortRes?.broken?2:3 });
  const fib = L.fib ? local.fib : null;
  fibSeries.forEach((s, k) => {
    if (!fib) { s.setData([]); return; }
    const value = k ? fib.g618 : fib.g50;
    s.applyOptions({ title: k ? "Fib .618" : "Fib .5" });
    s.setData(segment(Math.max(fib.start, bars[0].t), lastT, value, value));
  });
  const z = local.zone;
  if (L.zone && z) {
    const c = z.below ? "rgba(20,184,166,.9)" : "rgba(239,68,68,.9)";
    addLine(z.p + z.half, c, z.below ? `반등 후보 ${z.ev}/4` : `반락 후보 ${z.ev}/4`, LightweightCharts.LineStyle.LargeDashed, 2);
    addLine(z.p - z.half, c, "", LightweightCharts.LineStyle.LargeDashed, 2);
  }
  renderPanel(near);
  updateSummary();
  renderLegend(null);
  scheduleAxisCaptions();
}

// ---------- 범례 ----------
function renderLegend(time) {
  if (!state.ready || !bars.length) return;
  const selectedTime = time ?? state.crosshairTime;
  const b = selectedTime == null ? bars.at(-1) : bars.find(x => sec(x.t) === selectedTime) || bars.at(-1);
  if (!b) return;
  const chg = pct(b.c, b.o), cls = b.c >= b.o ? "L" : "S";
  $("legend").innerHTML = `${state.data.symbol} · ${state.data.timeframe} · ${"USDT 무기한"} &nbsp; 시 <b>${price(b.o)}</b> 고 <b>${price(b.h)}</b> 저 <b>${price(b.l)}</b> 종 <b class="${cls}">${price(b.c)}</b> <span class="${cls}">${sgn(chg)}%</span> · ${kst(b.t)}`;
}
chart.subscribeCrosshairMove(p => { state.crosshairTime=p && p.time != null ? p.time : null; renderLegend(state.crosshairTime); });
