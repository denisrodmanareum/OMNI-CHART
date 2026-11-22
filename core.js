/* AngelAreum analysis: closed-bar rules retained from omni_long_short.pine. */
(function(root) {
"use strict";
const H=3600e3, H4=4*H, DAY=24*H, HOLD=72*H, MAX_STOP=10;
function wilderAtr(b, n) {
  const out = new Array(b.length).fill(null);
  const tr = i => Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  let v = null;
  for (let i = 1; i < b.length; i++) {
    if (i === n) { v = 0; for (let k = 1; k <= n; k++) v += tr(k); v /= n; }
    else if (i > n) v = (v * (n - 1) + tr(i)) / n;
    out[i] = v;
  }
  return out;
}
function ema(b, n) { const k = 2 / (n + 1); let v = null; return b.map(x => (v = v == null ? x.c : x.c * k + v * (1 - k))); }
const stopPct = (atr, close) => Math.max(0.7, 2 * atr / close * 100);

function dailySignals(d) {
  const atr = wilderAtr(d, 14), out = [], sides = [];
  let prev = 0;
  for (let i = 0; i < d.length; i++) {
    let s = 0;
    if (i >= 30) {
      const r7 = d[i].c / d[i - 7].c - 1, r30 = d[i].c / d[i - 30].c - 1;
      s = r7 > 0 && r30 > 0 ? 1 : r7 < 0 && r30 < 0 ? -1 : 0;
    }
    sides.push(s);
    if (s && s !== prev && atr[i]) {
      const stop = stopPct(atr[i], d[i].c);
      if (stop <= MAX_STOP) out.push({ t: d[i].t + DAY, dir: s, stop, mod: "일봉" });
    }
    prev = s;
  }
  return { out, sides, stopNow: atr.at(-1) ? stopPct(atr.at(-1), d.at(-1).c) : null };
}

function ichiSignals(h4) {
  const atr = wilderAtr(h4, 14), out = [];
  const mid = (i, n) => { let hi = -Infinity, lo = Infinity; for (let k = i - n + 1; k <= i; k++) { hi = Math.max(hi, h4[k].h); lo = Math.min(lo, h4[k].l); } return (hi + lo) / 2; };
  let prev = 0, side = 0;
  for (let i = 25; i < h4.length; i++) {
    const tk = mid(i, 9), kj = mid(i, 26);
    side = tk > kj ? 1 : tk < kj ? -1 : 0;
    if (side && side !== prev && atr[i]) {
      const stop = stopPct(atr[i], h4[i].c);
      if (stop <= MAX_STOP) out.push({ t: h4[i].t + H4, dir: side, stop, mod: "4H" });
    }
    prev = side;
  }
  return { out, side, stopNow: atr.at(-1) ? stopPct(atr.at(-1), h4.at(-1).c) : null };
}

// 같은 시각에 일봉과 4H가 반대면 둘 다 버린다(WAIT).
function combine(daily, ichi) {
  const byT = new Map();
  for (const s of [...daily, ...ichi]) (byT.get(s.t) || byT.set(s.t, []).get(s.t)).push(s);
  const out = [];
  for (const group of byT.values()) {
    if (group.length === 2 && group[0].dir !== group[1].dir) continue;
    out.push(...group);
  }
  return out.sort((a, b) => a.t - b.t);
}

// 계획 결과: 시가에 만료·교체, 봉 마감에 손절 우선 판정. 손절 -1R, 익절 +2R, 만료·교체는 그 시가 기준 R.
function runPlan(sig, h4, nextT, now) {
  if (!h4.length || sig.t < h4[0].t) return { ...sig, state: "범위 밖" };
  let k = h4.findIndex(b => b.t === sig.t);
  if (k < 0) return { ...sig, state: sig.t > h4.at(-1).t ? "대기" : "범위 밖" };
  const ref = h4[k].o, sl = ref * (1 - sig.dir * sig.stop / 100), tp = ref * (1 + sig.dir * 2 * sig.stop / 100);
  const risk = Math.abs(ref - sl);
  const plan = { ...sig, ref, sl, tp };
  let previousT = null;
  for (; k < h4.length; k++) {
    const b = h4[k];
    if (previousT != null && b.t !== previousT + H4) return { ...sig, state: "범위 밖" };
    previousT = b.t;
    if (b.t >= nextT) return { ...plan, state: "교체", end: b.t, r: sig.dir * (b.o - ref) / risk };
    if (b.t - sig.t >= HOLD) return { ...plan, state: "만료", end: b.t, r: sig.dir * (b.o - ref) / risk };
    if (b.ct >= now) break;
    const hitSl = sig.dir === 1 ? b.l <= sl : b.h >= sl;
    const hitTp = sig.dir === 1 ? b.h >= tp : b.l <= tp;
    if (hitSl) return { ...plan, state: "손절", end: b.t, r: -1 };
    if (hitTp) return { ...plan, state: "익절", end: b.t, r: 2 };
  }
  return now - sig.t >= HOLD ? { ...sig, state: "범위 밖" } : { ...plan, state: "진행" };
}

function squeeze(h4) {
  const atr = wilderAtr(h4, 20), events = [];
  let prevPressed = false, on = false, basis = null, pressed = false;
  for (let i = 19; i < h4.length; i++) {
    let sum = 0; for (let k = i - 19; k <= i; k++) sum += h4[k].c;
    basis = sum / 20;
    let v = 0; for (let k = i - 19; k <= i; k++) v += (h4[k].c - basis) ** 2;
    pressed = atr[i] != null && 2 * Math.sqrt(v / 20) < 1.5 * atr[i];
    const fire = prevPressed && !pressed && h4[i].c > basis;
    if (on && h4[i].c <= basis) { events.push({ t: h4[i].t + H4, type: "exit" }); on = false; }
    if (fire && !on) { events.push({ t: h4[i].t + H4, type: "entry" }); on = true; }
    prevPressed = pressed;
  }
  return { events, on, basis, pressed };
}

// 장기 추세선: 일봉 좌우 len개 피벗, 낮아지는 고점 2개 = 저항, 높아지는 저점 2개 = 지지. 일봉 종가로 이탈 판정.
function longTrend(d, len, falling) {
  let lastP = null, lastT = null, p1 = null, t1 = null, p2 = null, t2 = null, broken = false, breakT = null;
  for (let i = 0; i < d.length; i++) {
    const j = i - len;
    if (j >= len) {
      const v = falling ? d[j].h : d[j].l;
      let pivot = true;
      for (let k = j - len; k <= j + len && pivot; k++) {
        if (k === j) continue;
        const w = falling ? d[k].h : d[k].l;
        if (falling ? w >= v : w <= v) pivot = false;
      }
      if (pivot) {
        if (lastP != null && (falling ? v < lastP : v > lastP)) { p1 = lastP; t1 = lastT; p2 = v; t2 = d[j].t; broken = false; breakT = null; }
        lastP = v; lastT = d[j].t;
      }
    }
    if (p2 != null && !broken) {
      const at = p2 + (p2 - p1) / (t2 - t1) * (d[i].t - t2);
      if (falling ? d[i].c > at : d[i].c < at) { broken = true; breakT = d[i].t; }
    }
  }
  return p2 == null ? null : { p1, t1, p2, t2, broken, breakT, at: t => p2 + (p2 - p1) / (t2 - t1) * (t - t2) };
}

function weekly(d) {
  const out = [];
  for (const b of d) {
    const wk = Math.floor((b.t - 4 * DAY) / (7 * DAY)); // 월요일 00:00 UTC 시작
    const last = out.at(-1);
    if (last && last.wk === wk) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.ct = (wk + 1) * 7 * DAY + 4 * DAY - 1; }
    else out.push({ wk, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, ct: (wk + 1) * 7 * DAY + 4 * DAY - 1 });
  }
  return out;
}

// 마감된 봉의 최근 피벗 2개(좌우 2봉)와 52봉 고저.
function levelsOf(bars, label) {
  const out = [], highs = [], lows = [];
  for (let j = 2; j < bars.length - 2; j++) {
    const b = bars[j];
    if (b.h > bars[j - 1].h && b.h > bars[j - 2].h && b.h >= bars[j + 1].h && b.h >= bars[j + 2].h) highs.push(b.h);
    if (b.l < bars[j - 1].l && b.l < bars[j - 2].l && b.l <= bars[j + 1].l && b.l <= bars[j + 2].l) lows.push(b.l);
  }
  const recent = bars.slice(-52);
  if (!recent.length) return out;
  for (const p of [...highs.slice(-2), ...lows.slice(-2), Math.max(...recent.map(b => b.h)), Math.min(...recent.map(b => b.l))]) out.push({ p, label });
  return out;
}

function nearest(levels, px) {
  let res = null, sup = null;
  for (const lv of levels) {
    if (lv.p > px && (!res || lv.p <= res.p)) res = lv;
    if (lv.p < px && (!sup || lv.p >= sup.p)) sup = lv;
  }
  return { res, sup };
}

function runLength(sides) {
  const runs = { 1: [], "-1": [] };
  let cur = 0, n = 0;
  for (const s of sides) {
    if (s === cur) n++;
    else { if (cur) runs[cur].push(n); cur = s; n = 1; }
  }
  const past = cur ? runs[cur] : [];
  return { cur, n, total: past.length, longer: past.filter(x => x >= n).length };
}

function analyze(h4all, d1all, now) {
  const h4 = h4all.filter(b => b.ct < now), d1 = d1all.filter(b => b.ct < now);
  const ds = dailySignals(d1), is = ichiSignals(h4);
  const signals = combine(ds.out, is.out);
  const plans = signals.map((s, i) => {
    const next = signals.slice(i + 1).find(x => x.mod === s.mod);
    return runPlan(s, h4all, next ? next.t : Infinity, now);
  });
  const last = mod => [...plans].reverse().find(p => p.mod === mod) || null;
  const lv = [...levelsOf(d1, "1D"), ...levelsOf(weekly(d1).filter(w => w.ct < now), "1W")];
  return {
    plans, dailyPlan: last("일봉"), ichiPlan: last("4H"), sq: squeeze(h4),
    trendSup: longTrend(d1, 20, false), trendRes: longTrend(d1, 20, true),
    levels: lv, dailySide: ds.sides.at(-1) || 0, ichiSide: is.side, run: runLength(ds.sides),
    stopDaily: ds.stopNow, stopIchi: is.stopNow,
  };
}

// ---------- 현재 차트 주기의 구조 (Pine과 같은 규칙) ----------
// 지지·저항: 좌우 prd봉 확정 피벗, 0.5 ATR 안이면 평균으로 합치고 최근 4개만 유지.
function localLevels(cb, prd, atr) {
  const levels = [];
  const add = (p, t, tol) => {
    const hit = levels.find(lv => Math.abs(lv.p - p) <= tol);
    if (hit) { hit.p = (hit.p * hit.touches + p) / (hit.touches + 1); hit.touches++; hit.t = Math.min(hit.t, t); }
    else { levels.unshift({ p, touches: 1, t }); if (levels.length > 4) levels.pop(); }
  };
  for (let i = 2 * prd; i < cb.length; i++) {
    const j = i - prd, tol = (atr[i] || 0) * 0.5;
    let isHigh = true, isLow = true;
    for (let k = j - prd; k <= j + prd; k++) {
      if (k === j) continue;
      if (cb[k].h >= cb[j].h) isHigh = false;
      if (cb[k].l <= cb[j].l) isLow = false;
    }
    if (isHigh) add(cb[j].h, cb[i].t, tol);
    if (isLow) add(cb[j].l, cb[i].t, tol);
  }
  return levels;
}

// 피보나치: 좌우 5봉 확정 고점·저점 쌍. 나중에 확정된 쪽이 방향을 정한다.
function fibAnchors(cb, len = 5) {
  let lastHigh = null, lastLow = null, highT = null, lowT = null, anchor = null;
  for (let i = 2 * len; i < cb.length; i++) {
    const j = i - len;
    let isHigh = true, isLow = true;
    for (let k = j - len; k <= j + len; k++) {
      if (k === j) continue;
      if (cb[k].h >= cb[j].h) isHigh = false;
      if (cb[k].l <= cb[j].l) isLow = false;
    }
    if (isHigh) { lastHigh = cb[j].h; highT = cb[j].t; }
    if (isLow) { lastLow = cb[j].l; lowT = cb[j].t; }
    if (isHigh && lowT != null && highT > lowT && lastHigh > lastLow) anchor = { hi: lastHigh, lo: lastLow, up: true, start: lowT };
    if (isLow && highT != null && lowT > highT && lastHigh > lastLow) anchor = { hi: lastHigh, lo: lastLow, up: false, start: highT };
  }
  if (!anchor) return null;
  const at = r => anchor.up ? anchor.hi - (anchor.hi - anchor.lo) * r : anchor.lo + (anchor.hi - anchor.lo) * r;
  return { ...anchor, g50: at(0.5), g618: at(0.618) };
}

// 반등·반락 후보: 서로 다른 근거 2종류 이상이 0.3 ATR 안에서 겹치는 가격. 근거 수 우선, 같으면 가까운 쪽.
function pickZone(cands, px, atr, below) {
  let best = null;
  for (const c of cands) {
    if (!(below ? c.p < px : c.p > px) || Math.abs(px - c.p) > atr * 5) continue;
    const kinds = new Set(cands.filter(q => Math.abs(q.p - c.p) <= atr * 0.3).map(q => q.kind));
    const rank = kinds.size * 10 - Math.abs(px - c.p) / atr;
    if (kinds.size >= 2 && (!best || rank > best.rank)) best = { p: c.p, ev: kinds.size, kinds: [...kinds], rank };
  }
  return best;
}


// ---------- 보조 지표 ----------
function rsi(b, n = 14) {
  const out = new Array(b.length).fill(null);
  let gain = 0, loss = 0;
  const value = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  for (let i = 1; i < b.length; i++) {
    const d = b[i].c - b[i - 1].c, up = Math.max(d, 0), down = Math.max(-d, 0);
    if (i <= n) { gain += up; loss += down; if (i === n) { gain /= n; loss /= n; out[i] = value(); } }
    else { gain = (gain * (n - 1) + up) / n; loss = (loss * (n - 1) + down) / n; out[i] = value(); }
  }
  return out;
}
function bollinger(b, n = 20, k = 2) {
  const out = new Array(b.length).fill(null);
  for (let i = n - 1; i < b.length; i++) {
    let sum = 0; for (let j = i - n + 1; j <= i; j++) sum += b[j].c;
    const mid = sum / n;
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (b[j].c - mid) ** 2;
    const sd = Math.sqrt(v / n);
    out[i] = { mid, upper: mid + k * sd, lower: mid - k * sd };
  }
  return out;
}
function macd(b, fast = 12, slow = 26, signal = 9) {
  const f = ema(b, fast), s = ema(b, slow), line = b.map((_, i) => f[i] - s[i]);
  const k = 2 / (signal + 1);
  let v = null;
  return line.map((x, i) => {
    if (i < slow - 1) return null;
    v = v == null ? x : x * k + v * (1 - k);
    return i < slow + signal - 2 ? null : { macd: x, signal: v, hist: x - v };
  });
}
// 세션 VWAP: UTC 00:00(KST 09:00)에 초기화하는 누적 (고+저+종)/3 × 거래량.
function vwap(b) {
  let day = null, pv = 0, vol = 0;
  return b.map(x => {
    const d = Math.floor(x.t / DAY);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (x.h + x.l + x.c) / 3;
    pv += tp * x.v; vol += x.v;
    return vol > 0 ? pv / vol : tp;
  });
}

// ---------- 급변동(급락·급등)과 되돌림 ----------
// 마감 봉만 사용한다. 직전 봉까지의 ATR 대비 몸통이 k배 이상이거나, 3봉 누적 이동이 k3배 이상이면 급변동.
// 같은 방향이 이어지면 한 구간으로 묶고, 구간 폭의 retrace 이상 종가로 되돌리거나 반대 방향 급변동 봉이 나오면 반등·반락으로 확정한다.
// 방향 신호가 아니라 변동성 경고와 되돌림 기준 가격을 제공한다.
const SHOCK = { n: 14, k: 2.5, k3: 4, window: 12, retrace: 0.5 };
function shockEvents(cb, step, options = {}) {
  const { n, k, k3, window, retrace } = { ...SHOCK, ...options };
  const atr = wilderAtr(cb, n), events = [];
  let leg = null;
  for (let i = n + 1; i < cb.length; i++) {
    const b = cb[i], a = atr[i - 1];
    if (!(a > 0)) continue;
    if (leg && i - leg.last > window) leg = null;
    if (leg) {
      leg.extreme = leg.dir === -1 ? Math.min(leg.extreme, b.l) : Math.max(leg.extreme, b.h);
      const span = Math.abs(leg.origin - leg.extreme), back = leg.dir === -1 ? b.c - leg.extreme : leg.extreme - b.c;
      if (i > leg.last && span > 0 && back >= retrace * span) {
        events.push({ t: b.t + step, type: leg.dir === -1 ? "rebound" : "pullback", dir: -leg.dir, mag: back / a, pct: (b.c / leg.extreme - 1) * 100, origin: leg.origin, extreme: leg.extreme });
        leg = null;
        continue;
      }
    }
    const one = (b.c - b.o) / a, three = i >= n + 3 ? (b.c - cb[i - 2].o) / a : 0;
    let dir = 0, mag = 0, count = 1;
    if (Math.abs(one) >= k) { dir = Math.sign(one); mag = Math.abs(one); }
    else if (Math.abs(three) >= k3 && Math.sign(b.c - b.o) === Math.sign(three)) { dir = Math.sign(three); mag = Math.abs(three); count = 3; }
    if (!dir) continue;
    if (leg && leg.dir === dir) { leg.last = i; leg.mag = Math.max(leg.mag, mag); continue; }
    // 급변동 구간 안에서 반대 방향 급변동이 나오면 50% 되돌림 전이라도 강한 반등·반락으로 확정한다.
    if (leg) {
      events.push({ t: b.t + step, type: dir === 1 ? "rebound" : "pullback", dir, mag, pct: (b.c / leg.extreme - 1) * 100, origin: leg.origin, extreme: leg.extreme, strong: true });
      leg = null;
      continue;
    }
    const span = cb.slice(i - count + 1, i + 1);
    const origin = dir === -1 ? Math.max(...span.map(x => x.h)) : Math.min(...span.map(x => x.l));
    const extreme = dir === -1 ? Math.min(...span.map(x => x.l)) : Math.max(...span.map(x => x.h));
    leg = { dir, origin, extreme, start: span[0].t, last: i, mag };
    events.push({ t: b.t + step, type: dir === -1 ? "drop" : "surge", dir, mag, pct: (b.c / origin - 1) * 100, origin, extreme });
  }
  const last = atr.at(-1);
  if (!leg) return { events, leg: null, atr: last, k };
  const at = r => leg.extreme + (leg.origin - leg.extreme) * r;
  return { events, leg: { dir: leg.dir, origin: leg.origin, extreme: leg.extreme, start: leg.start, mag: leg.mag, since: cb.length - 1 - leg.last, r382: at(0.382), r50: at(0.5), r618: at(0.618) }, atr: last, k };
}
// 진행 중 봉의 몸통을 마감 봉 ATR로 나눈 값. 미확정 참고용.
function liveShock(bar, atr, k = SHOCK.k) {
  if (!bar || !(atr > 0)) return null;
  const mag = (bar.c - bar.o) / atr;
  return { mag, dir: Math.abs(mag) >= k ? Math.sign(mag) : 0 };
}


// A marker outside loaded history must never be attached to the first candle.
function eventBar(bars,t) {
  if (!bars.length || t < bars[0].t || t > bars.at(-1).ct) return null;
  let lo=0, hi=bars.length-1;
  while(lo<=hi) { const m=(lo+hi)>>1; if(bars[m].t<=t) lo=m+1; else hi=m-1; }
  return hi>=0 ? bars[hi].t : null;
}
function candleRange(bars, range) {
  if (!bars.length || !range) return null;
  const visible=bars.slice(Math.max(0,Math.floor(range.from)),Math.min(bars.length,Math.ceil(range.to)+1));
  if(!visible.length) return null;
  const minValue=Math.min(...visible.map(b=>b.l)), maxValue=Math.max(...visible.map(b=>b.h));
  const pad=Math.max((maxValue-minValue)*0.08, maxValue*0.0001);
  return {minValue:minValue-pad,maxValue:maxValue+pad};
}
function candleTimeRange(bars,from,to) {
  const visible=bars.filter(b=>b.t>=from && b.t<=to);
  return candleRange(visible,{from:0,to:visible.length-1});
}
function tickPrecision(tickSize){
  const tick=Number(tickSize);if(!(tick>0))return null;
  const normalized=tick.toFixed(12).replace(/0+$/,'').replace(/\.$/,'');
  return normalized.includes('.')?normalized.split('.')[1].length:0;
}
function roundToTick(value,tickSize){
  const tick=Number(tickSize),precision=tickPrecision(tickSize);
  if(!Number.isFinite(value)||!(tick>0))return value;
  return Number((Math.round((value+Number.EPSILON*Math.abs(value))/tick)*tick).toFixed(precision));
}
function formatPrice(value,tickSize){
  if(!Number.isFinite(value))return '—';
  const precision=tickPrecision(tickSize);
  return roundToTick(value,tickSize).toLocaleString('en-US',precision==null?{maximumFractionDigits:12}:{minimumFractionDigits:precision,maximumFractionDigits:precision});
}
function mergeRefreshBars(fetched,current,since,preserveRange=null){
  const map=new Map(fetched.map(b=>[b.t,b]));
  for(const bar of current){
    if(bar.t>=since)map.set(bar.t,bar);
    else if(preserveRange&&bar.t>=preserveRange.from&&bar.t<=preserveRange.to&&!map.has(bar.t))map.set(bar.t,bar);
  }
  return [...map.values()].sort((a,b)=>a.t-b.t).slice(-5000);
}
function groupAxisLevels(levels,px,tolerance){
  const groups=[];
  for(const level of [...levels].filter(v=>Number.isFinite(v.p)&&v.p>0).sort((a,b)=>a.p-b.p)){
    const side=level.p>=px?'res':'sup',last=groups.at(-1);
    if(last&&last.side===side&&level.p-last.high<=tolerance){last.items.push(level);last.high=level.p;if(side==='sup')last.p=level.p;}
    else groups.push({side,p:level.p,low:level.p,high:level.p,items:[level]});
  }
  return groups;
}
function contiguousTail(bars,step){
  if(!bars.length||!(step>0))return bars;
  let start=bars.length-1;while(start>0&&bars[start].t-bars[start-1].t===step)start--;
  return bars.slice(start);
}
const api={wilderAtr,ema,stopPct,dailySignals,ichiSignals,combine,runPlan,squeeze,longTrend,weekly,levelsOf,nearest,runLength,analyze,localLevels,fibAnchors,pickZone,eventBar,candleRange,candleTimeRange,tickPrecision,roundToTick,formatPrice,mergeRefreshBars,groupAxisLevels,contiguousTail,rsi,bollinger,macd,vwap,shockEvents,liveShock,SHOCK};
if(typeof module!=="undefined" && module.exports) module.exports=api;
else root.AngelCore=api;
})(typeof globalThis!=="undefined" ? globalThis : this);
