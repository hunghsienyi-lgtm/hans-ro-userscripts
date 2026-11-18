// ==UserScript==
// @name         HANS RO｜左側控制中心｜巡走＋選技（模組獨立）
// @namespace    hunghung-ro-local-tools
// @version      1.0.4
// @description  v1.0.4：左側下方新增即時巡走資訊：目前執行動作、實際遊戲時間、下次磁鐵出發時間與倒數、選技狀態；直接讀已載入腳本，模組保持獨立。
// @match        https://ro.hans-webgametw.com/*
// @run-at       document-start
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Control_Center.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Control_Center.user.js
// ==/UserScript==
(() => {
  'use strict';
  const ROOT_ID='hans-left-control-center-v100';
  const CSS_ID='hans-left-control-center-css-v100';
  const HUB_VERSION='1.0.4';
  const SAVED_KEY='hans-ro-left-control-center-v101';
  const PREVIOUS_SAVED_KEY='hans-ro-left-control-center-v100';
  const MODULES=Object.freeze([
    {id:'hans-mage-autoskill-v123',     name:'巫師選技',shortcut:'Shift+1',group:'選技',match:/巫師選技/u},
    {id:'hans-rogue-autoskill-v100',   name:'流氓選技',shortcut:'Shift+2',group:'選技',match:/流氓選技/u},
    {id:'hans-early-patrol-magnet-v200',name:'一般長場巡走',shortcut:'Shift+6',group:'巡走／採集',match:/HANS巡走/u},
    {id:'hans-rogue-long-patrol-v231', name:'流氓長場巡走',shortcut:'Shift+8',group:'巡走／採集',match:/HANS流氓巡走/u},
    {id:'hans-three-minute-magnet-patrol-v1',name:'三分鐘巡走',shortcut:'Shift+7',group:'巡走／採集',match:/HANS3分巡走/u},
    {id:'ro-forest-camp-v19',          name:'森林採集',shortcut:'Shift+4',group:'巡走／採集',match:/森林v1[.]9/u}
  ]);
  if(document.getElementById(ROOT_ID))return;

  const byId=x=>document.getElementById(x);
  const load=()=>{
    try{
      const current=JSON.parse(localStorage.getItem(SAVED_KEY)||'null');
      if(current&&typeof current==='object')return current;
      const old=JSON.parse(localStorage.getItem(PREVIOUS_SAVED_KEY)||'null');
      // 沿用之前拖曳的位置，但第一次升級 v1.0.1 一律預設收合。
      return old&&typeof old==='object'?{x:old.x,y:old.y,expanded:false}:{};
    }catch{return {};}
  };
  const stored=load();
  let expanded=stored.expanded===true;
  let root=null,body=null,foldButton=null,headerText=null,summary=null;
  let liveCurrent=null,liveClock=null,liveNext=null,liveSkill=null,liveMode=null;
  let drag=null;
  const rows=new Map();
  const groups=new Map();
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  // 僅視覺隱藏舊按鈕，不刪除、不搬動它們；原始 onclick、style 與 Shift 快捷鍵完全維持。
  // 也不使用 display:none：原腳本偶爾會檢查自己的按鈕 DOM 與 CSS 狀態。
  // 全部腳本繼續獨立執行；控制中心只顯示六個按鈕代理，原按鈕隱至畫面外。
  const css='#'+ROOT_ID+'{box-sizing:border-box;position:fixed;z-index:2147483647!important;'+
    'font:12px/1.35 system-ui,"Microsoft JhengHei",sans-serif;color:#eef7ff;'+
    'background:rgba(16,31,49,.97);border:1px solid #82b0d9;'+
    'border-radius:9px;box-shadow:0 5px 18px #0009;pointer-events:auto;'+
    'width:190px;min-width:172px;max-width:calc(100vw - 12px);overflow:hidden}'+
    '#'+ROOT_ID+' [hidden]{display:none!important}'+
    '#'+ROOT_ID+' button{font:inherit;cursor:pointer;touch-action:manipulation}'+
    '#'+ROOT_ID+' .hans-hub-bar{display:flex;align-items:center;gap:5px;'+
    'padding:6px;background:#213c59;user-select:none;touch-action:none;cursor:move}'+
    '#'+ROOT_ID+' .hans-hub-fold{background:#345d85;color:white;border:1px solid #658cb0;'+
    'border-radius:5px;padding:2px 5px;min-width:25px;min-height:24px;cursor:pointer}'+
    '#'+ROOT_ID+' .hans-hub-content{padding:5px 6px 6px;max-height:min(490px,75vh);overflow-y:auto;overscroll-behavior:contain}'+
    '#'+ROOT_ID+' .hans-hub-section{border-top:1px solid #40617c;padding-top:3px;margin-top:4px}'+
    '#'+ROOT_ID+' .hans-hub-caption{font-size:10px;color:#aecce7;font-weight:700;margin-bottom:3px}'+
    '#'+ROOT_ID+' .hans-hub-row{display:flex;align-items:center;gap:5px;margin-bottom:3px;min-height:27px}'+
    '#'+ROOT_ID+' .hans-hub-name{display:flex;align-items:center;gap:5px;flex:1;'+
    'min-width:0;font-size:11px;color:#d5e7f7}'+
    '#'+ROOT_ID+' .hans-hub-name strong{flex:1;min-width:0;font-size:11px;font-weight:600;white-space:nowrap;'+
    'overflow:hidden;text-overflow:ellipsis}'+
    '#'+ROOT_ID+' .hans-hub-version{font-size:10px;font-variant-numeric:tabular-nums;color:#a5c9ed;white-space:nowrap;flex-shrink:0}'+
    '#'+ROOT_ID+' .hans-hub-shortcut{font-size:9px;color:#9ebbd5;white-space:nowrap;margin-left:auto}'+
    '#'+ROOT_ID+' .hans-hub-proxy{box-sizing:border-box;min-width:44px;max-width:51px;'+
    'height:25px;text-align:center;white-space:nowrap;'+
    'background:#384455;color:#fff;border:1px solid #849bb2;border-radius:5px;'+
    'padding:3px 5px;font-size:11px!important;line-height:1.1;font-weight:700!important}'+
    '#'+ROOT_ID+' .hans-hub-live{border-top:1px solid #507c9b;margin-top:7px;padding:7px 3px 5px;'+
    'background:rgba(36,60,80,.34);border-radius:0 0 6px 6px}'+
    '#'+ROOT_ID+' .hans-hub-live-title{color:#bde5ff;font-size:11px;font-weight:700;'+
    'display:flex;justify-content:space-between;gap:4px;margin-bottom:5px}'+
    '#'+ROOT_ID+' .hans-hub-live-row{display:flex;align-items:flex-start;gap:7px;'+
    'font-size:10.5px;line-height:1.5;margin:3px 0}'+
    '#'+ROOT_ID+' .hans-hub-live-label{color:#99b5d0;flex:0 0 42px}'+
    '#'+ROOT_ID+' .hans-hub-live-value{min-width:0;flex:1;color:#e4f1fc;overflow-wrap:anywhere}'+
    '#'+ROOT_ID+' .hans-hub-live-highlight{color:#a2ebcf;font-weight:700}'+
    '#'+ROOT_ID+' .hans-hub-footer{font-size:9px;color:#9fbedb;margin-top:5px}'+
    MODULES.map(m=>'#'+m.id+'{'+
      'transform:translate(-400vw,-400vh)!important;pointer-events:none!important;'+
      'opacity:0!important}').join('\n');

  function injectCSS(){
    if(byId(CSS_ID))return;
    if(!document.documentElement){setTimeout(injectCSS,20);return;}
    const style=document.createElement('style');style.id=CSS_ID;style.textContent=css;
    (document.head||document.documentElement).append(style);
  }
  injectCSS();

  function save(){
    if(!root)return;
    try{localStorage.setItem(SAVED_KEY,JSON.stringify({
      x:parseFloat(root.style.left)||8,
      y:parseFloat(root.style.top)||160,
      expanded
    }));}catch{}
  }
  function reposition(x,y){
    if(!root)return;
    const w=root.offsetWidth||194,h=root.offsetHeight||48;
    const maxX=Math.max(6,window.innerWidth-w-6),maxY=Math.max(6,window.innerHeight-h-6);
    root.style.left=clamp(Math.round(Number.isFinite(x)?x:8),6,maxX)+'px';
    root.style.top=clamp(Math.round(Number.isFinite(y)?y:160),6,maxY)+'px';
  }

  // 精確 ID 優先；改版若更換按鈕 ID，再以原快捷鍵及文字驗證，不接管不相關按鈕。
  function sourceFor(spec){
    const exact=byId(spec.id);
    if(exact && exact.tagName==='BUTTON')return exact;
    for(const candidate of document.querySelectorAll('body > button[aria-keyshortcuts]')){
      if(candidate.closest('#'+ROOT_ID))continue;
      if(candidate.getAttribute('aria-keyshortcuts')!==spec.shortcut)continue;
      const label=String(candidate.textContent||'').normalize('NFKC').replace(/\s+/g,'');
      if(spec.match.test(label))return candidate;
    }
    return null;
  }

  // 僅從目前頁面真正載入的原始模組按鈕取版本。
  // data-hans-script-version 由每支腳本在執行時提供；舊版按鈕有版本文字時才回退解析。
  // 此處不查 GitHub 版號，避免誤把遠端最新版當成已安裝版本。
  function runtimeVersion(source){
    if(!source)return null;
    const exact=String(source.dataset?.hansScriptVersion||'').trim();
    if(/^\d+(?:\.\d+){1,3}$/.test(exact))return exact;
    const label=String(source.textContent||'');
    const m=label.match(/(?:^|[\s｜:：])v(\d+(?:\.\d+){1,3})(?=$|[^\d])/i);
    return m?m[1]:null;
  }
  const isEnabled=source=>!!source &&
    /^(?:#186442|rgb\(24,\s*100,\s*66\))$/i.test(source.style.backgroundColor||'');
  const timeStamp=seconds=>{
    const n=Math.max(0,Math.floor(seconds));
    return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
  };
  const setLine=(el,value)=>{
    const text=String(value||'');
    if(el&&el.textContent!==text)el.textContent=text;
  };
  function updateLiveStatus(){
    if(!liveCurrent)return;
    const patrolSpecs=MODULES.filter(m=>m.id==='hans-early-patrol-magnet-v200'||
      m.id==='hans-rogue-long-patrol-v231');
    const patrolling=patrolSpecs.map(spec=>({spec,source:sourceFor(spec)}))
      .filter(x=>isEnabled(x.source));
    const skills=MODULES.filter(m=>m.group==='選技')
      .map(spec=>({spec,source:sourceFor(spec)})).filter(x=>isEnabled(x.source));
    if(skills.length){
      setLine(liveSkill,skills.map(x=>x.spec.name+' '+(runtimeVersion(x.source)?'v'+runtimeVersion(x.source):'v?')).join('／'));
    }else setLine(liveSkill,'目前未開啟選技');
    if(!patrolling.length){
      setLine(liveMode,'巡走未啟用');
      setLine(liveCurrent,skills.length?'選技腳本已開啟，等待選卡畫面':'等待開啟巡走或選技');
      setLine(liveClock,'—');
      setLine(liveNext,'尚未啟用長場巡走');
      return;
    }
    if(patrolling.length>1){
      setLine(liveMode,'多支巡走同時啟用');
      setLine(liveCurrent,'請只保留一支長場巡走，避免操作衝突');
      setLine(liveClock,'—');
      setLine(liveNext,'排程無法確定');
      return;
    }
    const {spec,source}=patrolling[0], data=source.dataset||{};
    setLine(liveMode,spec.name);
    const status=String(data.hansLiveStatus||source.textContent||'')
      .replace(/^HANS(?:流氓)?巡走[｜:：]/u,'').trim();
    setLine(liveCurrent,status.slice(0,165)||'腳本已啟用，等待狀態回報');
    const secondsRaw=String(data.hansGameSeconds??'');
    const reportedAt=Number(data.hansTelemetryAt);
    const clockFresh=/^\d+$/.test(secondsRaw)&&Number.isFinite(reportedAt)&&
      Date.now()-reportedAt>=0&&Date.now()-reportedAt<8000;
    const gameSeconds=clockFresh?Number(secondsRaw):null;
    setLine(liveClock,clockFresh?'本場 '+timeStamp(gameSeconds):'等待遊戲計時');
    if(!clockFresh){
      setLine(liveNext,'遊戲計時尚未更新，暫不顯示倒數');
      return;
    }
    const kind=data.hansNextMagnetKind;
    const nextRaw=String(data.hansNextMagnetSeconds??'');
    if(kind==='schedule'&&/^\d+$/.test(nextRaw)){
      const next=Number(nextRaw),left=next-gameSeconds;
      setLine(liveNext,left>0?
        timeStamp(next)+' 出發｜剩 '+timeStamp(left):
        timeStamp(next)+' 出發｜接近出發時間');
    }else if(kind==='boss'){
      setLine(liveNext,'固定時段結束｜Boss 階段持續偵測磁鐵');
    }else setLine(liveNext,'此巡走版本尚未回報下一次磁鐵時間');
  }

  function updateView(){
    if(!root)return;
    let count=0,active=0;
    for(const spec of MODULES){
      const pair=rows.get(spec.id);
      if(!pair)continue;
      const source=sourceFor(spec);
      const {row,proxy}=pair;
      // v1.0.2：未偵測到的模組仍要顯示，不能讓巫師或森林採集整列消失。
      row.hidden=false;
      if(!source){
        if(proxy.textContent!=='未載入')proxy.textContent='未載入';
        proxy.style.backgroundColor='#6a6574';
        proxy.disabled=true;
        const message=spec.name+'｜'+spec.shortcut+'｜未偵測到原腳本按鈕。'+
          '請在 Tampermonkey 確認原模組已啟用、已安裝且沒有執行錯誤；控制中心不會自行建立功能。';
        proxy.title=message;
        pair.name.title=message;
        pair.version.textContent='—';
        pair.version.title='原模組未載入，無法判斷目前版本';
        continue;
      }
      count++;
      const raw=String(source.textContent||'').trim();
      const liveVersion=runtimeVersion(source);
      pair.version.textContent=liveVersion?'v'+liveVersion:'v?';
      pair.version.title=liveVersion?
        '此版本由目前頁面已執行的原腳本回報：v'+liveVersion:
        '原腳本未提供可確認的版本。請更新該模組後重新整理；不顯示GitHub版號以免誤判。';
      const green=/^(?:#186442|rgb\(24,\s*100,\s*66\))$/i.test(source.style.backgroundColor||'');
      if(green)active++;
      // 主視窗只顯示開／關；原本完整巡走診斷保留在滑鼠提示，不再撐高面板。
      const abnormal=/錯誤|失敗|安全停靠|無法/u.test(raw);
      const brief=abnormal?'異常':green?'開':'關';
      if(proxy.textContent!==brief)proxy.textContent=brief;
      const bg=abnormal?'#92541f':green?'#186442':'#384455';
      if(proxy.style.backgroundColor!==bg)proxy.style.backgroundColor=bg;
      const details=spec.name+'｜'+(liveVersion?'已載入 v'+liveVersion:'版本未確認')+'｜'+spec.shortcut+'｜'+(raw||'尚無狀態')+
        (source.title?'｜'+source.title:'');
      if(proxy.title!==details)proxy.title=details;
      const {name}=pair;
      if(name?.title!==details)name.title=details;
      proxy.disabled=!!source.disabled;
    }
    const brief=count+'/'+MODULES.length+' 已載入 · '+active+' 開';
    if(summary.textContent!==brief)summary.textContent=brief;
    headerText.title=count===MODULES.length?'六個模組已全部偵測到':'目前載入 '+count+' 個模組，另有 '+(MODULES.length-count)+' 個未載入';
    // 不因某個模組尚未啟用或執行失敗而隱藏整個分類。
    for(const section of groups.values())section.hidden=false;
    const blank=byId(ROOT_ID+'-empty');
    if(blank)blank.hidden=count!==0;
    updateLiveStatus();
  }
  function mount(){
    if(root||!document.body){if(!document.body)setTimeout(mount,40);return;}
    root=document.createElement('section');root.id=ROOT_ID;
    root.setAttribute('role','region');root.setAttribute('aria-label','HANS 左側巡走與選技控制中心');

    const bar=document.createElement('div');bar.className='hans-hub-bar';
    const moveLabel=document.createElement('span');moveLabel.textContent='⠿';
    moveLabel.title='按住此列可拖曳面板';moveLabel.style.cssText='cursor:move;color:#c7dfef';
    headerText=document.createElement('strong');headerText.textContent='巡走／選技';
    headerText.style.cssText='flex:1;font-size:12px';
    const hubVersion=document.createElement('span');
    hubVersion.textContent='v'+HUB_VERSION;
    hubVersion.title='左側控制中心本身已載入的版本';
    hubVersion.style.cssText='font-size:10px;color:#a9c9e5;white-space:nowrap;flex-shrink:0';
    summary=document.createElement('span');summary.style.cssText='font-size:10px;color:#a9c9e5;white-space:nowrap';
    foldButton=document.createElement('button');
    foldButton.className='hans-hub-fold';foldButton.type='button';
    foldButton.setAttribute('aria-label','展開或收合 HANS 控制中心');
    foldButton.addEventListener('click',e=>{e.stopPropagation();expanded=!expanded;applyExpanded();save();});
    bar.append(moveLabel,headerText,hubVersion,summary,foldButton);

    body=document.createElement('div');body.className='hans-hub-content';
    for(const group of ['選技','巡走／採集']){
      const section=document.createElement('section');section.className='hans-hub-section';
      const cap=document.createElement('div');cap.className='hans-hub-caption';
      cap.textContent=group;section.append(cap);groups.set(group,section);
      for(const spec of MODULES.filter(x=>x.group===group)){
        const row=document.createElement('div');row.className='hans-hub-row';
        const label=document.createElement('div');label.className='hans-hub-name';
        const name=document.createElement('strong');name.textContent=spec.name;
        const version=document.createElement('span');version.className='hans-hub-version';
        version.textContent='—';
        const shortcut=document.createElement('span');shortcut.className='hans-hub-shortcut';
        // 不在每一行重複顯示「Shift+...」長字串，以數字精簡顯示；完整快捷鍵仍在提示文字。
        shortcut.textContent=spec.shortcut.replace('Shift+','⇧');
        label.append(name,version,shortcut);
        const proxy=document.createElement('button');proxy.type='button';proxy.className='hans-hub-proxy';
        proxy.textContent='關';
        proxy.addEventListener('click',()=>{
          const source=sourceFor(spec);
          if(!source){proxy.textContent='未載入';proxy.title='請先在 Tampermonkey 確認此模組已啟用';return;}
          // 按下原始模組按鈕，不模擬遊戲行為，也不碰模組內部的狀態與快捷鍵。
          source.click();
          setTimeout(updateView,80);
        });
        row.append(label,proxy);section.append(row);rows.set(spec.id,{row,proxy,name,version});
      }
      body.append(section);
    }
    const empty=document.createElement('div');empty.id=ROOT_ID+'-empty';
    empty.style.cssText='padding:8px 0;color:#c6d9eb;font-size:11px';
    empty.textContent='尚未偵測到選技或巡走模組，請確認原始腳本已啟用。';
    body.append(empty);
    const live=document.createElement('section');live.className='hans-hub-live';
    const liveTitle=document.createElement('div');liveTitle.className='hans-hub-live-title';
    const liveHeading=document.createElement('span');liveHeading.textContent='● 即時動態';
    liveMode=document.createElement('span');liveMode.textContent='等待巡走';
    liveMode.style.cssText='color:#a0c2da;font-weight:500;text-align:right;font-size:10px';
    liveTitle.append(liveHeading,liveMode);live.append(liveTitle);
    function addLiveRow(label,highlight=false){
      const row=document.createElement('div');row.className='hans-hub-live-row';
      const key=document.createElement('span');key.className='hans-hub-live-label';key.textContent=label;
      const value=document.createElement('span');value.className='hans-hub-live-value';
      if(highlight)value.classList.add('hans-hub-live-highlight');
      value.textContent='—';row.append(key,value);live.append(row);
      return value;
    }
    liveCurrent=addLiveRow('目前');
    liveClock=addLiveRow('時間');
    liveNext=addLiveRow('磁鐵',true);
    liveSkill=addLiveRow('選技');
    body.append(live);
    const footer=document.createElement('div');footer.className='hans-hub-footer';
    footer.textContent='各腳本獨立更新 · 快捷鍵保留';
    body.append(footer);
    root.append(bar,body);document.body.append(root);
    reposition(Number(stored.x),Number(stored.y));
    applyExpanded();
    updateView();

    // 只允許從標題列拖曳，不攔截按鈕點擊。位置存在同站 localStorage。
    bar.addEventListener('pointerdown',e=>{
      if(e.button!==0||e.target===foldButton||foldButton.contains(e.target))return;
      e.preventDefault();
      drag={id:e.pointerId,clientX:e.clientX,clientY:e.clientY,
        x:parseFloat(root.style.left)||8,y:parseFloat(root.style.top)||160};
      try{bar.setPointerCapture(e.pointerId)}catch{}
    });
    bar.addEventListener('pointermove',e=>{
      if(!drag||drag.id!==e.pointerId)return;
      reposition(drag.x+e.clientX-drag.clientX,drag.y+e.clientY-drag.clientY);
    });
    function finish(e){if(!drag||drag.id!==e.pointerId)return;drag=null;save();}
    bar.addEventListener('pointerup',finish);
    bar.addEventListener('pointercancel',finish);
    window.addEventListener('resize',()=>{reposition(parseFloat(root.style.left),parseFloat(root.style.top));save();});

    // 輪詢只同步六個按鈕的畫面，絕不執行選技、巡走或賣裝動作。
    setInterval(updateView,650);
  }
  function applyExpanded(){
    if(!body||!foldButton)return;
    body.style.display=expanded?'block':'none';
    foldButton.textContent=expanded?'−':'+';
    foldButton.title=expanded?'收合選技／巡走':'展開選技／巡走';
    if(root)root.style.width=expanded?'270px':'230px';
    if(root)reposition(parseFloat(root.style.left),parseFloat(root.style.top));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});
  else mount();
})();