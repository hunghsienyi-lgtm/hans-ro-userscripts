// ==UserScript==
// @name         HANS RO｜左側控制中心｜巡走＋選技（模組獨立）
// @namespace    hunghung-ro-local-tools
// @version      1.0.0
// @description  將左側六支已安裝的巡走、採集、選技按鈕收納成可拖曳/收合面板。原本六支腳本各自執行、各自從GitHub更新；不改遊戲流程。
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
  const SAVED_KEY='hans-ro-left-control-center-v100';
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
      const v=JSON.parse(localStorage.getItem(SAVED_KEY)||'null');
      return v&&typeof v==='object'?v:{};
    }catch{return {};}
  };
  const stored=load();
  let expanded=stored.expanded===true;
  let root=null,body=null,foldButton=null,headerText=null,summary=null;
  let drag=null;
  const rows=new Map();
  const groups=new Map();
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  // 僅視覺隱藏舊按鈕，不刪除、不搬動它們；原始 onclick、style 與 Shift 快捷鍵完全維持。
  // 也不使用 display:none：原腳本偶爾會檢查自己的按鈕 DOM 與 CSS 狀態。
  const css='#'+ROOT_ID+'{box-sizing:border-box;position:fixed;z-index:2147483647!important;'+
    'font:12px/1.4 system-ui,"Microsoft JhengHei",sans-serif;color:#eef7ff;'+
    'background:rgba(16,31,49,.97);border:1px solid #82b0d9;'+
    'border-radius:10px;box-shadow:0 5px 18px #0009;pointer-events:auto;'+
    'width:194px;min-width:170px;max-width:calc(100vw - 12px);overflow:hidden}'+
    '#'+ROOT_ID+' button{font:inherit;cursor:pointer;touch-action:manipulation}'+
    '#'+ROOT_ID+' .hans-hub-bar{display:flex;align-items:center;gap:5px;'+
    'padding:7px;background:#213c59;user-select:none;touch-action:none;cursor:move}'+
    '#'+ROOT_ID+' .hans-hub-fold{background:#345d85;color:white;border:1px solid #658cb0;'+
    'border-radius:5px;padding:3px 5px;min-width:25px;min-height:26px;cursor:pointer}'+
    '#'+ROOT_ID+' .hans-hub-content{padding:5px 7px 8px;max-height:min(420px,60vh);overflow:auto}'+
    '#'+ROOT_ID+' .hans-hub-section{border-top:1px solid #40617c;padding-top:5px;margin-top:6px}'+
    '#'+ROOT_ID+' .hans-hub-caption{font-size:11px;color:#aecce7;font-weight:700;margin-bottom:5px}'+
    '#'+ROOT_ID+' .hans-hub-row{display:flex;align-items:flex-start;flex-direction:column;gap:3px;margin-bottom:7px}'+
    '#'+ROOT_ID+' .hans-hub-name{display:flex;align-items:center;justify-content:space-between;'+
    'width:100%;font-size:10px;color:#cde2f5}'+
    '#'+ROOT_ID+' .hans-hub-proxy{width:100%;box-sizing:border-box;text-align:left;'+
    'background:#384455;color:#fff;border:1px solid #849bb2;border-radius:6px;'+
    'padding:6px;white-space:normal;overflow-wrap:anywhere;min-height:31px;'+
    'font-size:11px!important;line-height:1.25}'+
    '#'+ROOT_ID+' .hans-hub-footer{font-size:10px;color:#9fbedb;margin-top:4px}'+
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

  function updateView(){
    if(!root)return;
    let count=0,active=0;
    for(const spec of MODULES){
      const pair=rows.get(spec.id);
      if(!pair)continue;
      const source=sourceFor(spec);
      const {row,proxy}=pair;
      row.hidden=!source;
      if(!source)continue;
      count++;
      const raw=String(source.textContent||'').trim();
      const green=/^(?:#186442|rgb\(24,\s*100,\s*66\))$/i.test(source.style.backgroundColor||'');
      if(green)active++;
      const line=raw||spec.name+'（等待腳本狀態）';
      if(proxy.textContent!==line)proxy.textContent=line;
      const bg=green?'#186442':(source.style.backgroundColor||'#384455');
      if(proxy.style.backgroundColor!==bg)proxy.style.backgroundColor=bg;
      const details=spec.name+'｜'+spec.shortcut+(source.title?'｜'+source.title:'');
      if(proxy.title!==details)proxy.title=details;
      proxy.disabled=!!source.disabled;
    }
    const brief=count+' 個模組'+(active?' · '+active+' 開':'');
    if(summary.textContent!==brief)summary.textContent=brief;
    if(count===0)headerText.title='尚未載入任何巡走／選技模組，請先確認它們已在 Tampermonkey 啟用';
    for(const [name,section] of groups){
      const has=MODULES.some(spec=>spec.group===name && !!sourceFor(spec));
      section.hidden=!has;
    }
    const blank=byId(ROOT_ID+'-empty');
    if(blank)blank.hidden=count!==0;
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
    summary=document.createElement('span');summary.style.cssText='font-size:10px;color:#a9c9e5;white-space:nowrap';
    foldButton=document.createElement('button');
    foldButton.className='hans-hub-fold';foldButton.type='button';
    foldButton.setAttribute('aria-label','展開或收合 HANS 控制中心');
    foldButton.addEventListener('click',e=>{e.stopPropagation();expanded=!expanded;applyExpanded();save();});
    bar.append(moveLabel,headerText,summary,foldButton);

    body=document.createElement('div');body.className='hans-hub-content';
    for(const group of ['選技','巡走／採集']){
      const section=document.createElement('section');section.className='hans-hub-section';
      const cap=document.createElement('div');cap.className='hans-hub-caption';
      cap.textContent=group;section.append(cap);groups.set(group,section);
      for(const spec of MODULES.filter(x=>x.group===group)){
        const row=document.createElement('div');row.className='hans-hub-row';
        const label=document.createElement('div');label.className='hans-hub-name';
        const name=document.createElement('strong');name.textContent=spec.name;
        const shortcut=document.createElement('span');shortcut.textContent=spec.shortcut;
        label.append(name,shortcut);
        const proxy=document.createElement('button');proxy.type='button';proxy.className='hans-hub-proxy';
        proxy.textContent='等待腳本載入';
        proxy.addEventListener('click',()=>{
          const source=sourceFor(spec);
          if(!source){proxy.textContent='找不到腳本按鈕';return;}
          // 按下原始模組按鈕，不模擬遊戲行為，也不碰模組內部的狀態與快捷鍵。
          source.click();
          setTimeout(updateView,80);
        });
        row.append(label,proxy);section.append(row);rows.set(spec.id,{row,proxy});
      }
      body.append(section);
    }
    const empty=document.createElement('div');empty.id=ROOT_ID+'-empty';
    empty.style.cssText='padding:8px 0;color:#c6d9eb;font-size:11px';
    empty.textContent='尚未偵測到選技或巡走模組，請確認原始腳本已啟用。';
    body.append(empty);
    const footer=document.createElement('div');footer.className='hans-hub-footer';
    footer.textContent='各模組獨立更新｜原快捷鍵仍可使用';
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
    if(root)root.style.width=expanded?'252px':'194px';
    if(root)reposition(parseFloat(root.style.left),parseFloat(root.style.top));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});
  else mount();
})();