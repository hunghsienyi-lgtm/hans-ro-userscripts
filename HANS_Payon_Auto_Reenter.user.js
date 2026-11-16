// ==UserScript==
// @name         HANS RO｜開局巡走＋2／3／6分鐘磁鐵＋Lv120免翻牌
// @namespace    hunghung-ro-local-tools
// @version      2.0.1
// @description  HANS 專用：開局前60秒巡走練級，回開場點定點輸出，2:00/3:00/6:00各找一次磁鐵並返點，六分鐘採集結束且Lv120起點「之後不再翻牌」。原選關重進由戰利品整合版負責。
// @match        https://ro.hans-webgametw.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Payon_Auto_Reenter.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Payon_Auto_Reenter.user.js
// ==/UserScript==
(() => {
  'use strict';
  const UI_ID = 'hans-early-patrol-magnet-v200';
  if (document.getElementById(UI_ID)) return;

  const ENABLE_KEY='hans_ro_early_patrol_magnet_enabled_v200';
  const LEGACY_KEY='hh_ro_forest_gather_enabled_v19';
  const OPT={
    tickMs:140, clockPollMs:400, firstMinute:60, magnetMinutes:[120,180,360],
    levelSkip:120, magnetSearchMaxMs:35000, pickupConfirmMs:550,
    magnetReach:3.4, homeReach:2.8, magnetRadius:68,
    returnMaxMs:42000, progressTimeoutMs:2800, detourMs:850,
    maxDetours:4, magnetTargetStallMs:3000, patrolStepMs:1050, missedWindowS:10
  };
  const PATROL=['d','s','a','a','w','d','w','s'];
  const timeNow=()=>performance.now();
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const near=(a,b,d)=>dist(a,b)<=d;
  const norm=s=>String(s??'').normalize('NFKC').replace(/[\s\u200b-\u200d]/g,'').trim();
  const visible=e=>{
    if(!e||!e.isConnected||!e.getClientRects().length)return false;
    for(let p=e,i=0;p&&i<12;p=p.parentElement,i++){
      const st=getComputedStyle(p);
      if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity)===0||p.hidden)return false;
    }
    return true;
  };
  const button=document.createElement('button');
  button.id=UI_ID;button.type='button';
  button.style.cssText='position:fixed;left:8px;bottom:120px;z-index:2147483647;background:#384455;color:#fff;border:1px solid #eee;border-radius:5px;padding:5px 8px;font:12px system-ui,sans-serif;cursor:pointer;max-width:min(360px,80vw);text-align:left';
  button.title='Shift+6 開關；開場 0–1 分巡走、1–2 定點、2/3/6 分找磁鐵後返點；達 Lv120 且 6 分磁鐵流程完成才停翻牌。';
  button.setAttribute('aria-keyshortcuts','Shift+6');
  document.body?.appendChild(button);
  function status(s){button.textContent='HANS 巡走｜'+s;}

  let enabled=false,interval=null,map=null,restore=null;
  let player=null,lastPlayerAt=0,magnets=[];
  let arc=null,points=[];
  const held=new Set();
  const round={
    started:false,outside:true,seconds:null,prevSeconds:null,home:null,
    mode:'waiting',part:'',partStart:0,completed:new Set(),sixComplete:false,
    patrolStep:0,patrolUntil:0,target:null,bestGap:Infinity,progressAt:0,
    detours:0,detourKey:'',detourUntil:0,seekAt:0,returnAt:0,returnBest:Infinity,
    returnProgressAt:0,returnDetours:0,returnDetourUntil:0,returnDetourKey:'',
    magnetObserved:null,blocked:[],skipClicked:false,skipTries:0,failed:false
  };
  function move(keys=''){
    for(const key of [...held])if(!keys.includes(key)){
      window.dispatchEvent(new KeyboardEvent('keyup',{key,code:'Key'+key.toUpperCase(),bubbles:true}));held.delete(key);
    }
    for(const key of keys)if(!held.has(key)){
      window.dispatchEvent(new KeyboardEvent('keydown',{key,code:'Key'+key.toUpperCase(),bubbles:true}));held.add(key);
    }
  }
  function restoreMap(){
    move();
    if(restore){try{restore();}catch(e){console.warn('[HANS 巡走] 清除小地圖監控失敗',e)}restore=null;}
    map=null;player=null;magnets=[];
  }
  function pushUnique(list,p){if(!list.some(x=>near(x,p,.15)))list.push(p);}
  // 只監看玩家本機小地圖 Canvas 的座標，不讀取伺服器隱藏狀態。
  function watchMap(nextMap){
    restoreMap();map=nextMap;
    const ctx=map?.getContext('2d');if(!ctx)return;
    const original={};
    function hook(method,after){
      if(typeof ctx[method]!=='function')return;
      original[method]=ctx[method];
      ctx[method]=function(...args){after(...args);return original[method].apply(this,args);};
    }
    hook('clearRect',()=>{magnets=[];player=null;});
    hook('beginPath',()=>{arc=null;points=[];});
    hook('moveTo',(x,y)=>{points=[[x,y]];});
    hook('lineTo',(x,y)=>{if(points.length<5)points.push([x,y]);});
    hook('arc',(x,y,r,start,end,ccw)=>{arc={x,y,r,horseshoe:ccw&&Math.abs(start-Math.PI)<.01&&Math.abs(end)<.01};});
    hook('stroke',()=>{
      if(arc&&(ctx.strokeStyle==='#ff3b4a'||
        (arc.horseshoe&&points.length===3&&
         Math.abs(points[0][0]-(arc.x-arc.r))<.1&&
         Math.abs(points[2][0]-(arc.x+arc.r))<.1)))pushUnique(magnets,[arc.x,arc.y]);
    });
    hook('translate',(x,y)=>{player=[x,y];lastPlayerAt=timeNow();});
    restore=()=>{for(const [k,v] of Object.entries(original))ctx[k]=v;};
    resetRound();
  }
  function readGameTime(){
    let best=null;
    for(const e of document.querySelectorAll('span,b,strong,time,div')){
      if(e.childElementCount>2||!visible(e)||e.closest('#'+UI_ID))continue;
      const m=/^(\d{1,2}):([0-5]\d)$/.exec((e.textContent||'').trim());if(!m)continue;
      const r=e.getBoundingClientRect();
      if(r.width<12||r.width>185||r.height<8||r.height>75)continue;
      const x=r.left+r.width/2,y=r.top+r.height/2;
      if(x<innerWidth*.30||x>innerWidth*.70||y>Math.min(150,innerHeight*.24))continue;
      const secs=Number(m[1])*60+Number(m[2]);if(secs>1200)continue;
      const score=Math.abs(x-innerWidth/2)+Math.abs(y-25);
      if(!best||score<best.score)best={secs,score};
    }
    return best?.secs??null;
  }
  function outsideRun(){
    const labels=[...document.querySelectorAll('button,[role="button"]')]
      .filter(visible).map(x=>norm(x.textContent||''));
    return labels.some(x=>/^(?:與隊長交談|與隊長對話|和隊長交談|返回角色|回到角色|前往野外|出發)$/.test(x));
  }
  function busy(){
    const choose=document.querySelector('#picker');
    const drop=document.querySelector('#drop-reveal');
    if((choose&&visible(choose))||(drop&&visible(drop)))return true;
    const pause=[...document.querySelectorAll('button,[role="button"]')].find(e=>
      visible(e)&&/^(?:回到主選單|回主選單|繼續|返回主選單|捨棄)$/.test(norm(e.textContent||'')));
    return !!pause;
  }
  function resetRound(){
    move();
    Object.assign(round,{
      started:false,seconds:null,prevSeconds:null,home:null,mode:'waiting',part:'',partStart:0,
      completed:new Set(),sixComplete:false,patrolStep:0,patrolUntil:0,target:null,
      bestGap:Infinity,progressAt:0,detours:0,detourKey:'',detourUntil:0,
      seekAt:0,returnAt:0,returnBest:Infinity,returnProgressAt:0,
      returnDetours:0,returnDetourUntil:0,returnDetourKey:'',magnetObserved:null,
      blocked:[],skipClicked:false,skipTries:0,failed:false
    });
  }
  function startRound(seconds){
    resetRound();round.started=true;round.outside=false;round.seconds=seconds;
    round.prevSeconds=seconds;round.home=[...player];round.mode='patrol';
    status('開場巡走，1:00 回原點');
  }
  function keysToward(a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],threshold=.35*Math.max(Math.abs(dx),Math.abs(dy));
    return (Math.abs(dx)>threshold?(dx>0?'d':'a'):'')+
      (Math.abs(dy)>threshold?(dy>0?'s':'w'):'');
  }
  function patrol(now,short=false){
    if(!round.patrolUntil){round.patrolStep=0;round.patrolUntil=now+(short?800:OPT.patrolStepMs);}
    if(now>=round.patrolUntil){
      round.patrolStep=(round.patrolStep+1)%PATROL.length;
      round.patrolUntil=now+(short?800:OPT.patrolStepMs);
    }
    move(PATROL[round.patrolStep]);
  }
  function returnHome(reason,now){
    round.mode='return';round.part=reason;round.returnAt=now;round.returnBest=Infinity;
    round.returnProgressAt=now;round.returnDetours=0;round.returnDetourUntil=0;
    round.target=null;round.magnetObserved=null;move();
  }
  function park(now){
    move();round.mode='park';round.target=null;round.patrolUntil=0;
    if(round.part==='360')round.sixComplete=true;
    status('原地刷怪｜已返點，磁鐵 2:00／3:00／6:00');
  }
  function driveHome(now){
    if(!player||!round.home){move();status('等待返點座標');return;}
    const gap=dist(player,round.home);
    if(gap<=OPT.homeReach){park(now);return;}
    if(now-round.returnAt>OPT.returnMaxMs||round.returnDetours>OPT.maxDetours){
      move();round.mode='failed';round.failed=true;
      status('返點超時，暫停移動避免撞牆');return;
    }
    if(now<round.returnDetourUntil){move(round.returnDetourKey);return;}
    if(round.returnDetourUntil){round.returnDetourUntil=0;round.returnBest=gap;round.returnProgressAt=now;}
    if(gap+.12<round.returnBest){round.returnBest=gap;round.returnProgressAt=now;}
    if(now-round.returnProgressAt>OPT.progressTimeoutMs){
      const dx=round.home[0]-player[0],dy=round.home[1]-player[1];
      round.returnDetourKey=(Math.abs(dx)>=Math.abs(dy)?['w','s']:['d','a'])[round.returnDetours%2];
      round.returnDetours++;round.returnDetourUntil=now+OPT.detourMs;
      round.returnProgressAt=now;move(round.returnDetourKey);return;
    }
    move(keysToward(player,round.home));
    status('返原點中｜距離 '+gap.toFixed(1));
  }
  function beginMagnet(seconds,now){
    round.mode='seek';round.part=String(seconds);round.seekAt=now;
    round.target=null;round.magnetObserved=null;round.bestGap=Infinity;
    round.progressAt=now;round.detours=0;round.detourUntil=0;round.patrolUntil=0;
    round.completed.add(seconds);round.blocked=[];
    move();status(Math.floor(seconds/60)+':00 尋磁鐵');
  }
  function chooseMagnet(now){
    round.blocked=round.blocked.filter(x=>x.until>now);
    const available=magnets.filter(p=>
      dist(p,round.home)<=OPT.magnetRadius &&
      !round.blocked.some(x=>near(x.pos,p,3)));
    return available.reduce((best,p)=>!best||dist(p,player)<dist(best,player)?p:best,null);
  }
  function seekMagnet(now){
    if(now-round.seekAt>=OPT.magnetSearchMaxMs){returnHome(round.part,now);return;}
    // 拾取確認：小地圖上的磁鐵要在曾接近後持續消失，不能憑一次消失判定已取得。
    const w=round.magnetObserved;
    if(w){
      const exists=magnets.some(p=>near(p,w.pos,3));
      if(exists)w.missingAt=0;
      else if(!w.missingAt){w.missingAt=now;move();return;}
      else if(now-w.missingAt<OPT.pickupConfirmMs){move();return;}
      else if(now-w.missingAt>=OPT.pickupConfirmMs){
        if(w.minGap<=OPT.magnetReach && player&&dist(player,w.pos)<=OPT.magnetReach+1){
          status('磁鐵接近後消失，暫判已拾取，返回原點');
          returnHome(round.part,now);return;
        }
        round.blocked.push({pos:w.pos,until:now+6000});
        round.magnetObserved=null;round.target=null;
      }
    }
    const chosen=chooseMagnet(now);
    if(!chosen){round.target=null;round.magnetObserved=null;patrol(now,true);status('磁鐵尚未出現，附近尋找中');return;}
    if(!round.target||!near(round.target,chosen,3)){
      round.target=[...chosen];round.bestGap=dist(player,chosen);round.progressAt=now;
      round.detours=0;round.detourUntil=0;
    }
    const gap=dist(player,round.target);
    if(!round.magnetObserved||!near(round.magnetObserved.pos,round.target,3))
      round.magnetObserved={pos:[...round.target],minGap:gap,missingAt:0};
    else round.magnetObserved.minGap=Math.min(round.magnetObserved.minGap,gap);
    if(now<round.detourUntil){move(round.detourKey);return;}
    if(round.detourUntil){round.detourUntil=0;round.bestGap=gap;round.progressAt=now;}
    if(gap+.12<round.bestGap){round.bestGap=gap;round.progressAt=now;}
    if(now-round.progressAt>OPT.magnetTargetStallMs){
      if(round.detours>=3){
        round.blocked.push({pos:[...round.target],until:now+10000});
        round.target=null;round.magnetObserved=null;move();return;
      }
      const dx=round.target[0]-player[0],dy=round.target[1]-player[1];
      round.detourKey=(Math.abs(dx)>=Math.abs(dy)?['w','s']:['d','a'])[round.detours%2];
      round.detours++;round.detourUntil=now+OPT.detourMs;
      round.progressAt=now;move(round.detourKey);return;
    }
    move(gap>.45?keysToward(player,round.target):'');
    status('追磁鐵中 '+Math.floor(round.seconds/60)+':'+String(round.seconds%60).padStart(2,'0')+'｜距離 '+gap.toFixed(1));
  }
  function disableOldGather(){
    // 既有 v1.9.2 森林腳本若也開著，會搶方向鍵。只在能確定它啟動時透過其原本開關關閉。
    const old=document.getElementById('ro-forest-camp-v19');
    if(!old)return true;
    const c=old.style.backgroundColor||'';
    if(c==='#186442'||c==='rgb(24, 100, 66)'){
      old.click();
      if(sessionStorage.getItem(LEGACY_KEY)==='1'){
        status('請先關閉舊森林採集，避免方向鍵衝突');return false;
      }
    }
    return true;
  }
  function levelUpPanel(){
    const p=document.querySelector('#picker');
    if(!p||!visible(p))return null;
    const head=norm((p.innerText||p.textContent||'').slice(0,500));
    if(!/LevelUp|升級|強化技能/i.test(head))return null;
    const m=head.match(/Lv\.?\s*(\d{1,3})[:：]/i);
    if(!m)return null;
    return {panel:p,level:Number(m[1])};
  }
  function maybeDisableCards(){
    // 必須 6 分鐘採集已經返回原地，且本局 Level Up 達到 Lv120。
    if(!round.started||!round.sixComplete||round.skipClicked||round.skipTries>=3)return;
    const info=levelUpPanel();
    if(!info||info.level<OPT.levelSkip)return;
    // 按鈕可能在選卡容器外的右上角，因此在確定是 Lv120 升級畫面後允許全頁尋找。
    const stop=[...info.panel.querySelectorAll('button,[role="button"]'),
      ...document.querySelectorAll('button,[role="button"]')]
      .find(b=>visible(b)&&/^(?:之後不再翻牌|之后不再翻牌)$/.test(norm(b.textContent||'')));
    if(!stop){status('Lv'+info.level+' 已達標，但尚未找到「之後不再翻牌」按鈕');return;}
    round.skipTries++;
    stop.click();round.skipClicked=true;
    status('Lv'+info.level+'｜已按之後不再翻牌');
  }
  function shortThreeMinuteModeEnabled(){
    try{return JSON.parse(localStorage.getItem('hans-ro-stage-loot-short3-v070')||'{}')?.enabled===true;}
    catch{return false;}
  }
  function loop(){
    if(!enabled||document.hidden)return;
    if(shortThreeMinuteModeEnabled()){
      move();status('右下「3分鐘刷卡」仍開：請先關閉，否則無法完成6分鐘磁鐵行程');return;
    }
    const now=timeNow();
    if(!disableOldGather()){move();return;}
    const next=document.querySelector('#minimap canvas');
    if(next!==map)watchMap(next);
    const outside=outsideRun();
    if(outside){
      if(!round.outside){resetRound();round.outside=true;}
      move();status('等待下一場');return;
    }
    const secs=readGameTime();
    if(secs===null){move();status('等待遊戲計時／地圖');return;}
    if(!next||!visible(next)||!player||now-lastPlayerAt>950){move();status('等待小地圖座標');return;}
    if(!round.started){
      if(secs>45){move();status('已進行 '+Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0')+'，下一場開局再執行');return;}
      startRound(secs);
    }
    // Boss 結束時 HUD 也可能跳回 0:15，不能把它誤認為下一場開局。
    // 正常重進經過主城／選關時會由 outsideRun 重設，這裡不憑時間跳轉重新開場。
    round.prevSeconds=secs;round.seconds=secs;
    // 選卡視窗優先只處理「不再翻牌」；平常不搶巫師選技腳本。
    maybeDisableCards();
    if(busy()||document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]')){
      move();return;
    }
    if(round.failed){move();return;}
    if(round.mode==='return'){driveHome(now);return;}
    if(round.mode==='seek'){seekMagnet(now);return;}
    if(round.mode==='patrol'){
      if(secs>=OPT.firstMinute){returnHome('initial',now);driveHome(now);return;}
      patrol(now);status('開局巡走＋自動打怪 '+String(secs)+'／60 秒');return;
    }
    if(round.mode==='park'){
      for(const m of OPT.magnetMinutes){
        if(round.completed.has(m)||secs<m)continue;
        // 過時的採集不補做，以免長時間追磁鐵後錯過下一個指定窗口。
        if(secs-m>OPT.missedWindowS){round.completed.add(m);if(m===360)round.sixComplete=true;continue;}
        beginMagnet(m,now);return;
      }
      move();
      const next=OPT.magnetMinutes.find(m=>!round.completed.has(m)&&m>secs);
      status(next===undefined?'原地刷怪｜三次磁鐵行程已結束':
        '原地刷怪｜下次磁鐵 '+Math.floor(next/60)+':'+String(next%60).padStart(2,'0'));
      return;
    }
    move();
  }
  function stop({remember=true}={}){
    enabled=false;clearInterval(interval);interval=null;move();restoreMap();resetRound();
    if(remember)try{sessionStorage.setItem(ENABLE_KEY,'0');}catch{}
    button.style.background='#384455';status('關（Shift+6 開啟）');
  }
  function start({remember=true}={}){
    if(!disableOldGather())return;
    enabled=true;if(remember)try{sessionStorage.setItem(ENABLE_KEY,'1');}catch{}
    button.style.background='#186442';status('開｜等待下一場開局');
    clearInterval(interval);interval=setInterval(()=>{
      try{loop();}catch(err){move();status('錯誤：已停止移動');console.error('[HANS 巡走 2.0.1]',err);}
    },OPT.tickMs);
  }
  button.onclick=()=>enabled?stop():start();
  window.addEventListener('keydown',event=>{
    if(event.code!=='Digit6'||!event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.repeat||event.isComposing)return;
    if(event.composedPath().some(e=>e?.isContentEditable||e?.matches?.('input,textarea,select,[role="textbox"]')))return;
    event.preventDefault();event.stopImmediatePropagation();button.click();
  },true);
  window.addEventListener('blur',()=>move());
  window.addEventListener('pagehide',()=>{move();clearInterval(interval);restoreMap();});
  let remembered=false;try{remembered=sessionStorage.getItem(ENABLE_KEY)==='1';}catch{}
  if(remembered)start({remember:false});else status('關（Shift+6 開啟）');
})();