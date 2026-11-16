function analyzeChart(now) {
  const cb = bars.filter(b => b.ct < now), atr = wilderAtr(cb, 14), a = atr.at(-1);
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
  return { local, fib: fibUseful ? fib : null, zone: zone && { ...zone, below: dir === -1, half: a * 0.3 }, atr: a, shortSup, shortRes };
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
const srSeries = [0, 1, 2, 3].map(() => chart.addLineSeries({ ...lineOpts, lineWidth: 2, lastValueVisible: true }));
const fibSeries = [0, 1].map(() => chart.addLineSeries({ ...lineOpts, color: "#f6ce7e", lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, lastValueVisible: true }));
let priceLines = [];
let bars = [], result = null, local = null;

function toCandle(b) { return { time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c }; }
function toVolume(b) { return { time: sec(b.t), value: b.v, color: b.c >= b.o ? "rgba(20,184,166,.35)" : "rgba(239,68,68,.35)" }; }

function updateLiveIndicators() {
  const last=bars.at(-1);if(!last) return;
  for(const [key,e] of Object.entries(emaSeries)) {
    if(state.layers[key] && bars.length>e.n) e.s.update({time:sec(last.t),value:ema(bars,e.n).at(-1)});
  }
}

// 이벤트 시각 이후 첫 차트 봉에 표시한다.
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
  if (L.trend && showDaily) for (const [tl, text, pos, color] of [[r.trendSup, "장기 지지 이탈", "aboveBar", "#14b8a6"], [r.trendRes, "장기 저항 돌파", "belowBar", "#ef4444"]]) {
    if (!tl || !tl.broken) continue;
    const time = barAt(tl.breakT + DAY); if (time != null) markers.push({ time, position: pos, shape: pos === "aboveBar" ? "arrowDown" : "arrowUp", color, text });
  }
  markers.sort((a, b) => a.time - b.time);
  candles.setMarkers(markers);

  for (const pl of priceLines) candles.removePriceLine(pl);
  priceLines = [];
  const addLine = (price, color, title, style = LightweightCharts.LineStyle.Solid, width = 1) =>
    priceLines.push(candles.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
  if (L.plans) for (const p of [r.dailyPlan, r.ichiPlan]) {
    if (!p || p.state !== "진행" || (p.mod === "4H" && !show4h) || (p.mod === "일봉" && !showDaily)) continue;
    addLine(p.sl, p.mod === "일봉" ? "#ef4444" : "#f97316", `${p.mod} 손절`, LightweightCharts.LineStyle.Solid, p.mod === "일봉" ? 2 : 1);
    addLine(p.tp, p.mod === "일봉" ? "#22c55e" : "#84cc16", `${p.mod} 익절`, LightweightCharts.LineStyle.Solid, p.mod === "일봉" ? 2 : 1);
  }
  const px = bars.at(-1).c, near = nearest(r.levels, px), lastT = bars.at(-1).t;
  if (L.levels) {
    if (near.res) addLine(near.res.p, "#ff7189", `${near.res.label} 저항`, LightweightCharts.LineStyle.Dashed, 2);
    if (near.sup) addLine(near.sup.p, "#35e0bd", `${near.sup.label} 지지`, LightweightCharts.LineStyle.Dashed, 2);
  }
  if (L.mine) for (const p of readDrawings('line')) addLine(p, "#79bfff", "내 선", LightweightCharts.LineStyle.Solid, 2);
  for (const a of readDrawings('alert')) addLine(a.p, "#f4cc79", "알림", LightweightCharts.LineStyle.SparseDotted, 2);

  const trendData = tl => !L.trend || !tl || !showDaily ? [] : segment(Math.max(tl.t1, bars[0].t), tl.broken ? tl.breakT : lastT, tl.at(Math.max(tl.t1, bars[0].t)), tl.at(tl.broken ? tl.breakT : lastT));
  supLine.setData(trendData(r.trendSup));
  resLine.setData(trendData(r.trendRes));
  supLine.applyOptions({ color: r.trendSup && r.trendSup.broken ? "rgba(53,224,189,.55)" : "#35e0bd", lineStyle: r.trendSup?.broken ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid });
  resLine.applyOptions({ color: r.trendRes && r.trendRes.broken ? "rgba(255,113,137,.55)" : "#ff7189", lineStyle: r.trendRes?.broken ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid });
  sqLine.setData(L.sq && r.sq.on && show4h ? segment(lastT - 20 * H4, lastT, r.sq.basis, r.sq.basis) : []);

  for (const k in emaSeries) {
    const e = emaSeries[k];
    if (!L[k] || bars.length < e.n) { e.s.setData([]); continue; }
    const v = ema(bars, e.n);
    e.s.setData(bars.slice(e.n).map((b, i) => ({ time: sec(b.t), value: v[i + e.n] })));
  }
  volume.applyOptions({ visible: L.volume });

  local = analyzeChart(Date.now());
  // 지지·저항: 2회 이상 확인된 강한 레벨은 굵은 실선, 1회 레벨은 옅은 점선으로 모두 그린다.
  const srLevels = L.sr ? local.local : [];
  srSeries.forEach((s, k) => {
    const lv = srLevels[k];
    if (!lv) { s.setData([]); return; }
    const res = lv.p > px, strongLv = lv.touches >= 2;
    s.applyOptions({
      color: res ? (strongLv ? "#ff7189" : "rgba(255,113,137,.7)") : (strongLv ? "#35e0bd" : "rgba(53,224,189,.7)"),
      lineWidth: strongLv ? 3 : 2, lineStyle: strongLv ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dotted,
      title: `${res ? "저항" : "지지"} ${lv.touches}회`,
    });
    s.setData(segment(Math.max(lv.t, bars[0].t), lastT, lv.p, lv.p));
  });
  const shortData = t => !L.shortTrend || !t ? [] : segment(Math.max(t.t1, bars[0].t), t.broken ? t.breakT : lastT, t.at(Math.max(t.t1, bars[0].t)), t.at(t.broken ? t.breakT : lastT));
  stSupLine.setData(shortData(local.shortSup));
  stResLine.setData(shortData(local.shortRes));
  stSupLine.applyOptions({ color: local.shortSup && local.shortSup.broken ? "rgba(53,224,189,.5)" : "#35e0bd",lineWidth: local.shortSup?.broken?2:3 });
  stResLine.applyOptions({ color: local.shortRes && local.shortRes.broken ? "rgba(255,113,137,.5)" : "#ff7189",lineWidth: local.shortRes?.broken?2:3 });
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
}

// ---------- 범례 ----------
function renderLegend(time) {
  if (!state.ready || !bars.length) return;
  const selectedTime = time ?? state.crosshairTime;
  const b = selectedTime == null ? bars.at(-1) : bars.find(x => sec(x.t) === selectedTime) || bars.at(-1);
  if (!b) return;
  const chg = pct(b.c, b.o), cls = b.c >= b.o ? "L" : "S";
  $("legend").innerHTML = `${state.data.symbol} · ${state.data.timeframe} · ${"USDT 무기한"} &nbsp; 시 <b>${fmt(b.o)}</b> 고 <b>${fmt(b.h)}</b> 저 <b>${fmt(b.l)}</b> 종 <b class="${cls}">${fmt(b.c)}</b> <span class="${cls}">${sgn(chg)}%</span> · ${kst(b.t)}`;
}
chart.subscribeCrosshairMove(p => { state.crosshairTime=p && p.time != null ? p.time : null; renderLegend(state.crosshairTime); });
