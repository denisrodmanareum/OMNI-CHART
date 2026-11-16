/* Keep a broken/missing application asset from leaving an endless loading screen. */
(function(){
  'use strict';
  let failed=false;
  function showFailure(){
    if(failed||window.angelAreumStarted)return;
    failed=true;
    const byId=id=>document.getElementById(id);
    byId('chartState').hidden=false;
    byId('chartStateTitle').textContent='화면을 불러오지 못했습니다';
    byId('chartStateMessage').textContent='구성 파일 연결을 확인한 뒤 새로고침하세요. 저장한 선과 관심 종목은 유지됩니다.';
    byId('status').textContent='화면 로딩 실패';byId('status').className='err';
    byId('decisionState').textContent='연결 확인';
    byId('decisionReason').textContent='화면 로딩 오류 · 새로고침이 필요합니다';
    byId('decisionRisk').textContent='데이터 확인 전 판단 불가';
    byId('panel').textContent='분석 화면을 불러오지 못했습니다. 다시 연결을 누르세요.';
    byId('panel').setAttribute('aria-busy','false');
    for(const button of document.querySelectorAll('button'))button.disabled=true;
    const retry=byId('retry');retry.hidden=false;retry.disabled=false;retry.onclick=()=>window.location.reload();
  }
  window.addEventListener('error',event=>{if(event.target?.tagName==='SCRIPT'||event.error)showFailure();},true);
  window.addEventListener('load',()=>{if(!window.angelAreumStarted)showFailure();});
})();
