/* Public Binance USD-M data only. No credentials and no order endpoints. */
(function(root) {
"use strict";
class MarketClient {
  constructor(fetcher = (...args) => fetch(...args)) { this.fetcher = fetcher; this.cooldownUntil=0; this.throttleStrikes=0; this.symbolMeta=new Map(); this.info=null; this.infoAt=0; this.infoPromise=null; }
  cooldownError(status=429) {
    const error=new Error('거래소 조회 제한 · 잠시 후 자동 재시도');
    error.status=status;error.retryAfterMs=Math.max(0,this.cooldownUntil-Date.now());error.retryAt=this.cooldownUntil;
    return error;
  }
  async json(path, signal) {
    if(Date.now()<this.cooldownUntil)throw this.cooldownError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, {once:true});
    const timeout = setTimeout(abort, 12000);
    try {
      const response = await this.fetcher('https://fapi.binance.com' + path, {signal:controller.signal});
      if(response.status===429||response.status===418){
        const header=response.headers?.get?.('retry-after');
        const parsed=header?Number(header):NaN;
        const server=Number.isFinite(parsed)?parsed*1000:header?Math.max(0,Date.parse(header)-Date.now()):0;
        const wait=Math.max(server||0,response.status===418?900000:Math.min(900000,60000*2**this.throttleStrikes++));
        this.cooldownUntil=Math.max(this.cooldownUntil,Date.now()+wait);
        throw this.cooldownError(response.status);
      }
      if (!response.ok) throw new Error(response.status === 429 || response.status === 418 ? '조회 제한 · 잠시 후 다시 시도하세요' : response.status === 400 ? '지원하지 않는 USDT 무기한 종목이거나 요청이 유효하지 않습니다' : `선물 데이터 응답 오류 (${response.status})`);
      const data = await response.json();
      if (data?.code < 0) throw new Error('지원하지 않는 USDT 무기한 종목입니다');
      if(this.cooldownUntil&&Date.now()>=this.cooldownUntil)this.throttleStrikes=0;
      return data;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
  }
  async exchangeInfo(){
    if(this.info&&Date.now()-this.infoAt<3600000)return this.info;
    if(this.infoPromise)return this.infoPromise;
    this.infoPromise=this.json('/fapi/v1/exchangeInfo').then(info=>{
      if(!Array.isArray(info.symbols))throw new Error('거래소 호가 단위 정보를 읽지 못했습니다');
      this.info=info;this.infoAt=Date.now();
      for(const item of info.symbols){const tick=item.filters?.find(f=>f.filterType==='PRICE_FILTER')?.tickSize;if(Number(tick)>0)this.symbolMeta.set(item.symbol,{tickSize:tick,pricePrecision:item.pricePrecision});}
      return info;
    }).finally(()=>{this.infoPromise=null;});
    return this.infoPromise;
  }
  async klines(symbol, interval, {limit=1500, signal, startTime, endTime}={}) {
    if (!/^[\p{L}\p{N}]{1,30}USDT$/u.test(symbol)) throw new Error('USDT 무기한 심볼을 확인하세요');
    const query = new URLSearchParams({symbol, interval, limit:String(limit)});
    if(startTime!=null) query.set('startTime',String(startTime));
    if(endTime!=null) query.set('endTime',String(endTime));
    const rows = await this.json('/fapi/v1/klines?' + query, signal);
    if (!Array.isArray(rows) || !rows.length) throw new Error('선물 캔들 데이터가 없습니다');
    const bars = rows.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],ct:k[6]}));
    if(bars.some((b,i)=>![b.t,b.o,b.h,b.l,b.c,b.v,b.ct].every(Number.isFinite) || b.l<=0 || b.v<0 || b.ct<b.t || b.h<Math.max(b.o,b.c,b.l) || b.l>Math.min(b.o,b.c) || (i>0 && b.t<=bars[i-1].t))) throw new Error('선물 캔들 무결성 오류');
    const step={'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000,'1w':604800000}[interval];
    if(step && bars.some((b,i)=>i>0 && b.t-bars[i-1].t!==step)) throw new Error('선물 캔들에 누락 구간이 있습니다 · 다시 조회하세요');
    return bars;
  }
  async snapshot(symbol,timeframe,signal) {
    const frames=[...new Set([timeframe,'4h','1d'])];
    const [rows]=await Promise.all([Promise.all(frames.map(tf=>this.klines(symbol,tf,{signal}))),this.exchangeInfo()]);
    const map=new Map(frames.map((tf,i)=>[tf,rows[i]]));
    const meta=this.symbolMeta.get(symbol);if(!meta)throw new Error('해당 종목의 거래소 호가 단위를 확인하지 못했습니다');
    return {symbol,timeframe,market:'USDT-PERP',bars:map.get(timeframe),h4:map.get('4h'),d1:map.get('1d'),receivedAt:Date.now(),meta};
  }
  async futures(symbol,signal) {
    const query='?symbol='+encodeURIComponent(symbol);
    const names=['premium','oi','ticker','book'];
    const paths=['/fapi/v1/premiumIndex','/fapi/v1/openInterest','/fapi/v1/ticker/24hr','/fapi/v1/ticker/bookTicker'];
    const values=await Promise.allSettled(paths.map(path=>this.json(path+query,signal)));
    const out={symbol,receivedAt:Date.now(),errors:[]};
    values.forEach((value,i)=>{ if(value.status==='fulfilled') out[names[i]]=value.value; else out.errors.push(names[i]); });
    return out;
  }
}
// A newer selection invalidates all older REST and socket callbacks, including errors.
class Selection {
  constructor(client) { this.client=client; this.version=0; this.tickVersion=0; this.controller=null; this.socket=null; }
  stopSocket() {
    if(this.socket) { this.socket.onopen=this.socket.onmessage=this.socket.onclose=this.socket.onerror=null; this.socket.close(); this.socket=null; }
  }
  async load(symbol,timeframe) {
    this.controller?.abort(); this.stopSocket();
    const version=++this.version;
    const controller=this.controller=new AbortController();
    try {
      const data=await this.client.snapshot(symbol,timeframe,controller.signal);
      return version===this.version ? {...data,version} : null;
    } catch(error) { if(version!==this.version) return null; throw error; }
  }
  current(data) { return data && data.version===this.version; }
  async refresh(data,signal){
    if(!this.current(data))return null;
    try{const next=await this.client.snapshot(data.symbol,data.timeframe,signal);if(!this.current(data))return null;this.tickVersion++;return {...next,version:data.version};}
    catch(error){if(!this.current(data))return null;throw error;}
  }
  async latest(data,signal) {
    if(!this.current(data)) return null;
    const ticks=this.tickVersion;
    try {
      const bars=await this.client.klines(data.symbol,data.timeframe,{limit:2,signal});
      // A REST response started before a newer socket tick must not roll it back.
      return this.current(data)&&ticks===this.tickVersion?bars:null;
    } catch(error) { if(!this.current(data)) return null; throw error; }
  }
  connect(data,callbacks,Socket=WebSocket) {
    if(!this.current(data)) return;
    this.stopSocket();
    const ws=this.socket=new Socket(`wss://fstream.binance.com/ws/${data.symbol.toLowerCase()}@kline_${data.timeframe}`);
    const active=()=>this.current(data) && this.socket===ws;
    ws.onopen=()=>{if(active()) callbacks.open?.();};
    ws.onmessage=event=>{
      if(!active()) return;
      try {
        const message=JSON.parse(event.data), k=message.k;
        if(message.s!==data.symbol || !k || k.i!==data.timeframe) return;
        const bar={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v,ct:k.T};
        if(![bar.t,bar.o,bar.h,bar.l,bar.c,bar.v,bar.ct].every(Number.isFinite) || bar.l<=0 || bar.h<Math.max(bar.o,bar.c,bar.l) || bar.l>Math.min(bar.o,bar.c)) return;
        this.tickVersion++;
        callbacks.tick?.(bar,!!k.x);
      } catch { callbacks.error?.('실시간 데이터 해석 실패'); }
    };
    ws.onclose=()=>{if(active()) callbacks.close?.();};
    ws.onerror=()=>{if(active()) callbacks.error?.('실시간 연결 확인 중');};
  }
}
const api={MarketClient,Selection};
if(typeof module!=='undefined' && module.exports) module.exports=api; else root.AngelMarket=api;
})(typeof globalThis!=='undefined' ? globalThis : this);
