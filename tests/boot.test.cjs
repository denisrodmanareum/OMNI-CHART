const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../boot.js'),'utf8');
function setup(started=false){
  const nodes=new Map(),events={};let reloads=0;
  const get=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:true,disabled:false,setAttribute(k,v){this[k]=v;}});return nodes.get(id);};
  const buttons=[get('drawLine'),get('retry')];
  const window={angelAreumStarted:started,location:{reload(){reloads++;}},addEventListener(name,handler){events[name]=handler;}};
  vm.runInNewContext(source,{window,document:{getElementById:get,querySelectorAll:()=>buttons}});
  return {get,events,reloads:()=>reloads};
}
test('missing script shows a reachable retry and disables unfinished tools',()=>{
  const app=setup();app.events.error({target:{tagName:'SCRIPT'}});
  assert.equal(app.get('chartState').hidden,false);
  assert.equal(app.get('retry').hidden,false);assert.equal(app.get('retry').disabled,false);
  assert.equal(app.get('drawLine').disabled,true);
  app.get('retry').onclick();assert.equal(app.reloads(),1);
});
test('startup exceptions and incomplete startup cannot leave an endless loading screen',()=>{
  const app=setup();app.events.error({error:new Error('initialization failed')});
  assert.match(app.get('status').textContent,/실패/);
  const missing=setup();missing.events.load();assert.equal(missing.get('retry').hidden,false);
});
test('an already started application is not replaced by the startup fallback',()=>{
  const app=setup(true);app.events.error({error:new Error('later error')});app.events.load();
  assert.equal(app.get('status').textContent,'');assert.equal(app.get('retry').onclick,undefined);
});
