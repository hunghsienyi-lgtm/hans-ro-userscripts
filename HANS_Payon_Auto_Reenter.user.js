// ==UserScript==
// @name         RO Survivors｜斐揚森林／斐揚洞穴｜文字重進＋進圖延遲下滾10次 v1.8
// @namespace    hunghung-ro-local-tools
// @version      1.8.0
// @description  返回角色 → 與隊長交談 → 選擇斐揚森林或斐揚洞穴 → 出發 → 前往野外；每次進圖穩定3秒後，間隔400毫秒下滾10次調整視角；不更改難度設定。
// @match        https://ro.hans-webgametw.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Payon_Auto_Reenter.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Payon_Auto_Reenter.user.js
// ==/UserScript==
(() => {
  'use strict';
  if (window.__HH_PAYON_TEXT_V18__) return;
  window.__HH_PAYON_TEXT_V18__ = true;

  const W = {
    back: /^(?:返回[角腳]色|回到角色|返回人物|returntocharacter|backtocharacter)$/i,
    talk: /^(?:與|和|跟)?(?:遠征)?隊長(?:交談|談話|對話|說話)(?:(?:空格|space)|[（(](?:空格|space)[）)])?$/i,
    forest: /^(?:斐[揚楊扬]森林|斐[揚楊扬]樹林|payonforest)$/i,
    cave: /^(?:斐[揚楊扬](?:洞穴|洞窟)|payoncave)$/i,
    depart: /^(?:出發|出发|出征|depart|startexpedition)$/i,
    wilderness: /^(?:前往野外|前往野外！|前往野外!|go(?:tothe)?field|enterthefield)$/i,
    difficulty: /^(?:難度|难度|difficulty)$/i,
    enemyCount: /^(?:敵人數量|敌人数量|enemycount|enemyamount)$/i,
    expedition: /^(?:遠征|远征|expedition)$/i,
    score: /(?:裝備分數|装备分数|equipment score)/i,
    story: /^(?:劇情|剧情|story)$/i,
    otherStage: /^(?:普隆德拉(?:原野|地下水道|城)|失事輪|失事轮|柏伊亞[嵐島嶼屿島]+|prontera(?:fields?|sewers?|castle)|shipwreck|byalan\w*|payoncave)$/i
  };
  const norm = s => String(s ?? '').normalize('NFKC').replace(/[\s\u00a0\u200b-\u200d]/g,'').trim();
  // 新增第二個關卡：保留斐揚森林，預設改成斐揚洞穴。
  const STAGES = {
    forest: {name:'斐揚森林',re:W.forest},
    cave:   {name:'斐揚洞穴',re:W.cave}
  };
  const rct = el => el.getBoundingClientRect();
  function shown(el,allowOffscreen=false) {
    if (!el || !el.isConnected || el.disabled || !el.getClientRects().length) return false;
    const r = rct(el);
    if (r.width < 1 || r.height < 1) return false;
    if(!allowOffscreen&&(r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight))return false;
    for (let p=el, n=0; p && n<14; p=p.parentElement, n++) {
      const s = getComputedStyle(p);
      if (s.display==='none' || s.visibility==='hidden' || Number(s.opacity)===0) return false;
    }
    return true;
  }
  const hud = document.createElement('section');
  hud.id = 'hh-payon-v18';
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#23334bee;color:#fff;border:1px solid #a7c7ed;border-radius:7px;padding:6px 8px;font:12px/1.5 sans-serif;max-width:290px;box-shadow:0 3px 9px #0006';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'font:bold 12px sans-serif;padding:4px 8px;color:#fff;background:#5c6b82;border:1px solid #c9dbed;border-radius:5px;cursor:pointer';
  const msg = document.createElement('div');
  msg.style.cssText='margin-top:4px;max-width:270px;overflow-wrap:anywhere';
  const picker = document.createElement('select');
  picker.title = '選擇要自動進入的副本';
  picker.setAttribute('aria-label','自動進入的副本');
  picker.style.cssText='margin-left:6px;color:#18283b;background:#fff;border-radius:4px;padding:4px;font:12px sans-serif;max-width:120px';
  for(const [value,stage] of Object.entries(STAGES)){
    const option=document.createElement('option');
    option.value=value;option.textContent=stage.name;picker.append(option);
  }
  try{picker.value=localStorage.getItem('hh-ro-dungeon-v16')||'cave';}catch{picker.value='cave';}
  if(!STAGES[picker.value])picker.value='cave';
  hud.append(btn,picker,msg);
  document.body.append(hud);
  let active = false, timer = null, state = '', lastAt=0, attempts={};
  let stageClickedAt=0, beforeStageWasStory=false, departAt=0, wildernessAt=0;
  const targetStage=()=>STAGES[picker.value]||STAGES.cave;
  // 進圖後自動下滾：不改遊戲縮放 CSS，只送出與滑鼠滾輪方向相同的事件。
  // +deltaY = 向下滾；遊戲本身決定是放大還是縮小視角。
  const ZOOM_PENDING_KEY = 'hh-ro-expedition-enter-field-zoom-v18';
  const ZOOM_STEPS = 10;
  const ZOOM_DELTA = 160;
  const ZOOM_STEP_INTERVAL = 400;
  const ZOOM_READY_DELAY = 3000; // 真正顯示遊戲畫面後，再等 3 秒才滾
  const ZOOM_MAX_WAIT = 60000;
  let pendingZoomAt = 0, zoomInProgress = false, zoomMapReadyAt = 0;
  function readZoomPending() {
    try {
      const ts=Number(sessionStorage.getItem(ZOOM_PENDING_KEY));
      if(Number.isFinite(ts) && ts>0 && Date.now()-ts < ZOOM_MAX_WAIT) return ts;
      sessionStorage.removeItem(ZOOM_PENDING_KEY);
    } catch {}
    return 0;
  }
  pendingZoomAt=readZoomPending();
  function queueZoom() {
    pendingZoomAt=Date.now();
    zoomMapReadyAt=0;
    try{sessionStorage.setItem(ZOOM_PENDING_KEY,String(pendingZoomAt));}catch{}
  }
  function clearZoomPending() {
    pendingZoomAt=0;
    zoomMapReadyAt=0;
    try{sessionStorage.removeItem(ZOOM_PENDING_KEY);}catch{}
  }
  function mapReadyForZoom() {
    // 難度 / 遠征仍顯示時絕不能滾輪；須等副本小地圖真的出現。
    if(difficultyOpen() || expeditionOpen() || findControl(W.back) || findControl(W.talk))return false;
    const mini=document.querySelector('#minimap');
    const miniCanvas=mini?.querySelector('canvas');
    const miniCoords=document.querySelector('#minimap-coords');
    return !!((mini && shown(mini) && (miniCanvas ? shown(miniCanvas) : false)) ||
      (miniCoords && shown(miniCoords)));
  }
  function zoomCanvas() {
    // 優先投遞至畫面中心實際最上層的遊戲元素，更接近使用者在遊戲中滾輪的事件路徑。
    const centerElement=document.elementFromPoint(Math.floor(innerWidth*.50),Math.floor(innerHeight*.50));
    if(centerElement && !hud.contains(centerElement) && !centerElement.closest('#minimap'))return centerElement;
    // 若中心位置被小地圖或 HUD 遮住，才退回主畫布。
    const choices=[...document.querySelectorAll('canvas')].filter(el =>
      !el.closest('#minimap') && !hud.contains(el) && shown(el));
    choices.sort((a,b)=>{
      const ar=rct(a),br=rct(b);return br.width*br.height-ar.width*ar.height;
    });
    if(choices.length)return choices[0];
    // 2D / DOM 遊戲備援：事件會往上冒泡至 document/window。
    for(const selector of ['#game-canvas','#game-container','#game','#world','#game-view']){
      const el=document.querySelector(selector);
      if(el && shown(el))return el;
    }
    const el=document.elementFromPoint(Math.floor(innerWidth*.50),Math.floor(innerHeight*.55));
    return el && !hud.contains(el) ? el : document.body;
  }
  function emitDownWheel(target){
    const r=rct(target);
    const x=Math.max(1,Math.min(innerWidth-2,Math.round(r.left+r.width/2)));
    const y=Math.max(1,Math.min(innerHeight-2,Math.round(r.top+r.height/2)));
    target.dispatchEvent(new WheelEvent('wheel', {
      bubbles:true,cancelable:true,composed:true,view:window,
      deltaX:0,deltaY:ZOOM_DELTA,deltaZ:0,deltaMode:0,clientX:x,clientY:y
    }));
  }
  function checkEntryZoom() {
    if(!pendingZoomAt || zoomInProgress)return;
    if(Date.now()-pendingZoomAt>ZOOM_MAX_WAIT){
      clearZoomPending();tell('進圖逾時，未執行滾輪');return;
    }
    // 務必等地圖連續保持可見 3 秒，避免地圖剛載入時遊戲尚未註冊滾輪事件。
    if(document.hidden || !mapReadyForZoom()) {zoomMapReadyAt=0;return;}
    if(!zoomMapReadyAt)zoomMapReadyAt=Date.now();
    if(Date.now()-zoomMapReadyAt<ZOOM_READY_DELAY || Date.now()-pendingZoomAt<ZOOM_READY_DELAY)return;
    zoomInProgress=true;
    clearZoomPending(); // 先消耗此次任務，避免一局重複縮放。
    let count=0;
    tell(`已進地圖，開始向下滾輪 ${ZOOM_STEPS} 次`);
    function step(){
      if(document.hidden || !mapReadyForZoom()){
        zoomInProgress=false;
        tell('滾輪中止：遊戲地圖暫時不可見');return;
      }
      const target=zoomCanvas();
      try{emitDownWheel(target);}catch(e){
        console.warn('[斐揚 v1.8] 滾輪事件發送失敗',e);
        zoomInProgress=false;tell('滾輪事件發送失敗');return;
      }
      count++;
      tell(`進圖下滾：${count}/${ZOOM_STEPS}（需遊戲實測確認視角變化）`);
      if(count < ZOOM_STEPS){setTimeout(step,ZOOM_STEP_INTERVAL);}
      else{zoomInProgress=false;tell(`已送出 ${ZOOM_STEPS} 次下滾事件，等待下一場結算`);}
    }
    step();
  }
  // 即使出發後整頁重新載入，也能以 sessionStorage 恢復這一次的視角調整。
  setInterval(checkEntryZoom,350);
  function tell(s) {if (msg.textContent!==s) {msg.textContent=s;console.info('[斐揚 v1.8]',s);}}
  function phase(p) {
    if (state===p) return;
    state=p; attempts={}; lastAt=0;stageClickedAt=0;beforeStageWasStory=false;departAt=0;wildernessAt=0;
  }
  function enable(value) {
    active=value;clearInterval(timer);phase('');
    btn.textContent=`重進：${active?'開':'關'}（Shift+5）`;
    btn.style.background=active?'#146f4c':'#5c6b82';
    tell(active?`已開啟，目標：${targetStage().name}`:'已關閉');
    if(active){timer=setInterval(tick,450);tick();}
  }
  btn.addEventListener('click',()=>enable(!active));
  picker.addEventListener('change',()=>{
    if(!STAGES[picker.value])return;
    try{localStorage.setItem('hh-ro-dungeon-v16',picker.value);}catch{}
    phase('');tell(`目標已切換：${targetStage().name}（${active?'自動重進中':'尚未開啟'}）`);
  });
  window.addEventListener('keydown',e=>{
    if(e.code!=='Digit5'||!e.shiftKey||e.altKey||e.ctrlKey||e.metaKey||e.repeat||e.isComposing)return;
    if(e.composedPath().some(x=>x?.isContentEditable||x?.matches?.('input,textarea,select,[role="textbox"]')))return;
    e.preventDefault();e.stopImmediatePropagation();enable(!active);
  },true);

  // The text may be a plain text node inside a clickable card (not a <button>).
  // Collect actual visible text rects rather than matching an entire panel's text.
  function hits(re,allowOffscreen=false) {
    const out=[];
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walker.nextNode())) {
      const t=norm(node.nodeValue);
      if(!t||t.length>100||!re.test(t))continue;
      const el=node.parentElement;
      if(!el||hud.contains(el)||el.closest('script,style,noscript')||!shown(el,allowOffscreen))continue;
      const rng=document.createRange();rng.selectNodeContents(node);
      const r=rng.getBoundingClientRect();
      if(r.width>0 && r.height>0)out.push({el,r,t});
    }
    return out;
  }
  function findControl(re) {
    const nodes=document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a');
    for(const el of nodes) {
      if(hud.contains(el)||!shown(el))continue;
      if([el.getAttribute('aria-label'),el.getAttribute('title'),el.value,el.textContent]
          .some(t=>t&&re.test(norm(t))))return el;
    }
    // Some controls use a <div> with a text node; use the smallest clickable ancestor.
    for(const h of hits(re)) {
      const candidate=h.el.closest('button,[role="button"],a,[onclick],[tabindex]')||h.el;
      if(shown(candidate))return candidate;
    }
    return null;
  }
  function action(key,el,label,max=3,wait=1100,allowOffscreen=false) {
    if(!el||!shown(el,allowOffscreen)||Date.now()-lastAt<wait)return false;
    if((attempts[key]||0)>=max){tell(`「${label}」已嘗試 ${max} 次，停止重試`);return false;}
    attempts[key]=(attempts[key]||0)+1;
    lastAt=Date.now();
    el.click();
    tell(`已按「${label}」第 ${attempts[key]} 次`);
    return true;
  }
  function left(h) {return h.r.left+h.r.width/2<innerWidth*.34;}
  function rightPreview(h) {
    return h.r.left+h.r.width/2>innerWidth*.35 && h.r.top<innerHeight*.63;
  }
  function storyTextIsVisible() {
    // The story button in this screen is disabled; a clickable-button lookup
    // would intentionally exclude it. Still read its visible text.
    return hits(W.story).length > 0 || [...document.querySelectorAll('button,[role="button"]')]
      .some(el => el.getClientRects().length > 0 && W.story.test(norm(el.textContent)));
  }
  function expeditionOpen() {
    // CRITICAL: detect the stage LIST, not the "出發" button. On 普隆德拉城
    // the button is labelled "劇情", so there may be no 出發 at all.
    const payonLeft=[...hits(W.forest),...hits(W.cave)].filter(left);
    const otherLeft=hits(W.otherStage).filter(left);
    const title=hits(W.expedition).some(h=>h.r.top<innerHeight*.25 && left(h));
    const score=hits(W.score).length>0 || [...document.querySelectorAll('body *')]
      .some(el=>el.children.length===0 && shown(el) && /裝備分數/.test(el.textContent||'') && (el.textContent||'').length<70);
    return payonLeft.length>0 && (otherLeft.length>0 || title || score);
  }
  function stageTarget() {
    // 選單可能要捲動，允許先找到位於捲動容器可視範圍外的洞穴項目。
    const hit=hits(targetStage().re,true).filter(left).sort((a,b)=>a.r.top-b.r.top)[0];
    if(!hit)return null;
    // Choose a whole stage row by visible size, regardless of CSS class names.
    let best=hit.el, score=-1;
    for(let p=hit.el,i=0;p&&p!==document.body&&i<9;p=p.parentElement,i++){
      if(!shown(p,true))continue;
      const r=rct(p), cx=r.left+r.width/2;
      if(cx>=innerWidth*.47 || r.width>innerWidth*.48 || r.height>160)break;
      let value=0;
      if(r.width>=140&&r.width<=innerWidth*.46&&r.height>=42&&r.height<=140)value=5+r.width/100;
      if(p.matches('button,[role="button"],a,[data-stage],[data-expedition],li'))value+=7;
      if(value>score){score=value;best=p;}
    }
    return best;
  }
  function selectedStage(row){
    for(let p=row,i=0;p&&i<4;p=p.parentElement,i++) {
      const cls=typeof p.className==='string'?p.className:'';
      if(p.getAttribute('aria-selected')==='true'||p.getAttribute('data-selected')==='true'||
        /(?:^|[\s_-])(?:selected|active|current|chosen)(?:$|[\s_-])/i.test(cls))return true;
    }
    return false;
  }
  function handleExpedition(){
    phase('expedition');
    const stage=targetStage();
    const row=stageTarget();
    if(!row){tell(`遠征已開，但找不到「${stage.name}」項目`);return;}
    const previewMatch=hits(stage.re).some(rightPreview);
    const otherPreview=Object.entries(STAGES).some(([id,s])=>id!==picker.value && hits(s.re).some(rightPreview));
    // 如果右邊明顯顯示另一個副本，即使左邊的卡片有「已選」樣式也不信任。
    const confirmed=previewMatch || (!otherPreview && selectedStage(row));
    const depart=findControl(W.depart);
    if(confirmed && depart){
      if(departAt && Date.now()-departAt<10000){tell('已按出發，等待難度視窗');return;}
      if(action('depart',depart,'出發',2,1100))departAt=Date.now();
      return;
    }
    if(confirmed&&!depart){tell(`已選${stage.name}，等待「出發」按鈕`);return;}
    if(stageClickedAt && Date.now()-stageClickedAt<1700){tell(`已按${stage.name}，等待右側切換`);return;}
    // 只有看不到任何其他目標副本的預覽時，才容許「劇情」變成「出發」當作輔助確認。
    if(stageClickedAt && beforeStageWasStory && depart && !otherPreview){
      if(action('depart',depart,'出發（劇情已變更）',1,1100))departAt=Date.now();
      return;
    }
    if((attempts.stage||0)>=3){tell(`選了${stage.name}仍無法確認切換；停止重試，避免按錯副本`);return;}
    beforeStageWasStory=beforeStageWasStory||storyTextIsVisible();
    // 左邊清單若尚未捲到洞穴，先讓項目進入可視範圍。
    try{row.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});}catch{}
    if(action('stage',row,stage.name,3,1350,true))stageClickedAt=Date.now();
  }
  // The difficulty dialog is a *new* stage after 出發. Its confirm button is
  // 「前往野外」. Detect it BEFORE the expedition list (which may remain in DOM
  // behind the modal); never move the sliders or click 「取消」.
  function difficultyOpen() {
    return !!findControl(W.wilderness) ||
      (hits(W.difficulty).length > 0 && hits(W.enemyCount).length > 0);
  }
  function handleDifficulty() {
    phase('difficulty');
    const go=findControl(W.wilderness);
    if(!go) {tell('難度視窗已開，等待「前往野外」按鈕');return;}
    if(wildernessAt && Date.now()-wildernessAt < 8000) {
      tell('已按「前往野外」，等待副本載入');
      return;
    }
    if((attempts.wilderness||0)>=2) {
      tell('「前往野外」兩次仍未關閉視窗，已停止重試');
      return;
    }
    // 點擊前建立待縮放旗標，避免點擊觸發整頁跳轉而丟失訊號。
    if(go && shown(go) && Date.now()-lastAt>=1200 && (attempts.wilderness||0)<2) {
      queueZoom();
      if(action('wilderness',go,'前往野外',2,1200))wildernessAt=Date.now();
      else clearZoomPending();
    }
  }
  function tick() {
    if(!active||document.hidden)return;
    try {
      if(difficultyOpen()){handleDifficulty();return;}
      if(expeditionOpen()){handleExpedition();return;}
      const back=findControl(W.back);
      if(back){phase('result');action('back',back,'返回角色',3,1500);return;}
      const talk=findControl(W.talk);
      if(talk){phase('town');action('talk',talk,'與隊長交談',4,1800);return;}
      phase('waiting');tell(`等待結算／主城／遠征／難度視窗（目標：${targetStage().name}）`);
    } catch(e) {tell('偵測錯誤：請截圖並回報');console.error('[斐揚 v1.8]',e);}
  }
  window.addEventListener('pagehide',()=>clearInterval(timer));
  enable(false);
})();