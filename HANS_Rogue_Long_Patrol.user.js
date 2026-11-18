// ==UserScript==
// @name         HANS RO｜流氓長場巡走＋磁鐵｜前3分鐘不停＋Lv120後寶箱自動繼續保存
// @namespace    hunghung-ro-local-tools
// @version      2.3.9
// @description  v2.3.9：Lv120後只抽已保存寶箱；下一箱需求達7000 Z即停止。改從「寶箱 N」分頁直接切換，避免底部(B)被遮住。
// @match        https://ro.hans-webgametw.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Rogue_Long_Patrol.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Rogue_Long_Patrol.user.js
// ==/UserScript==
(() => {
  'use strict';
  const UI_ID = 'hans-rogue-long-patrol-v231';
  if (document.getElementById(UI_ID)) return;

  const ENABLE_KEY='hans_ro_rogue_long_patrol_enabled_v231';
  const LEGACY_KEY='hh_ro_forest_gather_enabled_v19';
  const OPT={
    tickMs:140, clockPollMs:400, firstPatrolUntilS:180, magnetMinutes:[115,175,355],
    repeatStartS:475, repeatEveryS:120, repeatLastS:835, bossMagnetRetryMs:2200,
    finalBossSeconds:15,
    levelSkip:120, treasureCostLimit:7000, magnetSearchMaxMs:35000, pickupConfirmMs:550,
    magnetReach:3.4, homeReach:2.8, magnetRadius:68,
    returnMaxMs:42000, progressTimeoutMs:2800, detourMs:850,
    maxDetours:4, magnetTargetStallMs:3000, patrolStepMs:1050, missedWindowS:10
  };
  const PATROL=['d','s','a','a','w','d','w','s'];
  const timeNow=()=>performance.now();
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const near=(a,b,d)=>dist(a,b)<=d;
  const formatTime=seconds=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
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
  button.dataset.hansScriptVersion='2.3.9';
  button.style.cssText='position:fixed;left:8px;bottom:198px;z-index:2147483647;background:#384455;color:#fff;border:1px solid #eee;border-radius:5px;padding:5px 8px;font:12px system-ui,sans-serif;cursor:pointer;max-width:min(360px,80vw);text-align:left';
  button.title='Shift+8 流氓長場：前3分鐘持續巡走（1:55／2:55照常尋磁鐵），3:00後返點恢復原版站打、磁鐵與安全停靠；Boss最後15秒只找磁鐵、Lv120後寶箱自動繼續保存。';
  button.setAttribute('aria-keyshortcuts','Shift+8');
  document.body?.appendChild(button);
  function status(s){button.textContent='HANS 流氓巡走｜'+s;}

  let enabled=false,interval=null,map=null,restore=null;
  let player=null,lastPlayerAt=0,magnets=[];
  let arc=null,points=[];
  const held=new Set();
  const round={
    started:false,outside:true,seconds:null,prevSeconds:null,rawSeconds:null,bossCountdown:false,bossLastSeekAt:0,home:null,
    mode:'waiting',part:'',partStart:0,completed:new Set(),sixComplete:false,
    patrolStep:0,patrolUntil:0,target:null,bestGap:Infinity,progressAt:0,
    detours:0,detourKey:'',detourUntil:0,seekAt:0,returnAt:0,returnBest:Infinity,
    returnProgressAt:0,returnDetours:0,returnDetourUntil:0,returnDetourKey:'',
    magnetObserved:null,blocked:[],level120Reached:false,savePending:null,chestOpen:{count:null,tries:0,lastAt:0,blocked:false},savedOpen:{count:null,tries:0,lastAt:0,blocked:false,draining:false},failed:false,
    homeFallbacks:0,usingFallbackHome:false,finalPicked:0
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
    if(restore){try{restore();}catch(e){console.warn('[HANS 流氓巡走] 清除小地圖監控失敗',e)}restore=null;}
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
      started:false,seconds:null,prevSeconds:null,rawSeconds:null,bossCountdown:false,bossLastSeekAt:0,home:null,mode:'waiting',part:'',partStart:0,
      completed:new Set(),sixComplete:false,patrolStep:0,patrolUntil:0,target:null,
      bestGap:Infinity,progressAt:0,detours:0,detourKey:'',detourUntil:0,
      seekAt:0,returnAt:0,returnBest:Infinity,returnProgressAt:0,
      returnDetours:0,returnDetourUntil:0,returnDetourKey:'',magnetObserved:null,
      blocked:[],level120Reached:false,savePending:null,chestOpen:{count:null,tries:0,lastAt:0,blocked:false},savedOpen:{count:null,tries:0,lastAt:0,blocked:false,draining:false},failed:false,
      homeFallbacks:0,usingFallbackHome:false,finalPicked:0
    });
  }
  function startRound(seconds){
    // 在本局中途才啟用時，直接使用當前的遊戲計時開始，
    // 不必為了「超過45秒」等下一場。沒有本場出生點座標時，將當前位置當臨時定點。
    resetRound();
    round.started=true;round.outside=false;
    round.seconds=seconds;round.prevSeconds=seconds;round.rawSeconds=seconds;
    round.home=[...player];
    const alreadyInProgress=seconds>=OPT.firstPatrolUntilS;
    round.mode=alreadyInProgress?'park':'patrol';
    if(alreadyInProgress){
      round.usingFallbackHome=true; // 中途接手：這不是本局原本的出生點
      for(const m of magnetSchedule){
        if(m+OPT.missedWindowS<seconds)round.completed.add(m);
      }
      if(seconds>355+OPT.missedWindowS)round.sixComplete=true;
      const next=magnetSchedule.find(m=>!round.completed.has(m));
      status('中途接手 '+formatTime(seconds)+'｜當前位置定點，'+(next===undefined?'等待Boss磁鐵':
          '下次磁鐵 '+formatTime(next)));
    }else{
      status('中途接手 '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+
        '｜繼續巡走，3:00後返目前定點');
    }
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
    // 1:55、2:55 磁鐵結束後，未到3:00不回原點、不定點停留。
    // 若第二次搜尋跨過3:00，則照原版在尋磁鐵完成後安全返點。
    if(round.seconds<OPT.firstPatrolUntilS && (String(reason)==='115'||String(reason)==='175')){
      round.mode='patrol';round.part='';round.target=null;round.magnetObserved=null;
      round.patrolUntil=0;
      status('前三分鐘持續巡走｜'+formatTime(Number(reason))+' 磁鐵搜尋完成，不返點');
      return;
    }
    round.mode='return';round.part=reason;round.returnAt=now;round.returnBest=Infinity;
    round.returnProgressAt=now;round.returnDetours=0;round.returnDetourUntil=0;
    round.target=null;round.magnetObserved=null;move();
  }
  function park(now){
    move();round.mode='park';round.target=null;round.patrolUntil=0;
    if(round.part==='355')round.sixComplete=true;
    round.failed=false;
    status(round.usingFallbackHome?
      '原點路徑受阻｜已改就地定點，後續磁鐵照常執行（安全停靠 '+round.homeFallbacks+' 次）':
      '已返回原點｜原地打怪，六分後每2分鐘尋磁鐵，Boss仍追磁鐵');
  }
  function fallbackPark(now){
    // 不再進入永久 failed 狀態；回家路線走不通就停止按方向鍵並固定此處。
    // 用目前實際可見的玩家座標重設定點，讓下一個磁鐵行程仍能開始及返回。
    move();
    if(!player||!Number.isFinite(player[0])||!Number.isFinite(player[1])){
      status('無法取得玩家座標，停止移動並等待小地圖恢復');return;
    }
    round.home=[...player];
    round.homeFallbacks++;
    round.usingFallbackHome=true;
    park(now);
  }
  function driveHome(now){
    if(!player||!round.home){move();status('等待返點座標');return;}
    const gap=dist(player,round.home);
    if(gap<=OPT.homeReach){park(now);return;}
    if(now-round.returnAt>OPT.returnMaxMs||round.returnDetours>OPT.maxDetours){
      fallbackPark(now);
      return;
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
    if(typeof seconds==='number')round.completed.add(seconds);
    if(!inBossPhase())round.blocked=[];
    else{round.blocked=round.blocked.filter(x=>x.until>now);round.bossLastSeekAt=now;}
    move();status(seconds==='boss'?'Boss戰持續尋磁鐵':formatTime(seconds)+' 尋磁鐵');
  }
  function chooseMagnet(now){
    round.blocked=round.blocked.filter(x=>x.until>now);
    const available=magnets.filter(p=>
      dist(p,round.home)<=OPT.magnetRadius &&
      !round.blocked.some(x=>near(x.pos,p,3)));
    return available.reduce((best,p)=>!best||dist(p,player)<dist(best,player)?p:best,null);
  }
  function seekMagnet(now){
    const finalOnly=round.mode==='final';
    if(!finalOnly&&now-round.seekAt>=OPT.magnetSearchMaxMs){returnHome(round.part,now);return;}
    // 拾取確認：小地圖上的磁鐵要在曾接近後持續消失，不能憑一次消失判定已取得。
    const w=round.magnetObserved;
    if(w){
      const exists=magnets.some(p=>near(p,w.pos,3));
      if(exists)w.missingAt=0;
      else if(!w.missingAt){w.missingAt=now;move();return;}
      else if(now-w.missingAt<OPT.pickupConfirmMs){move();return;}
      else if(now-w.missingAt>=OPT.pickupConfirmMs){
        if(w.minGap<=OPT.magnetReach && player&&dist(player,w.pos)<=OPT.magnetReach+1){
          if(finalOnly){
            // 倒數最後15秒不要花時間返點；繼續等下一顆磁鐵。
            round.finalPicked++;
            round.blocked.push({pos:[...w.pos],until:now+12000});
            round.target=null;round.magnetObserved=null;round.bestGap=Infinity;move();
            status('Boss最後15秒｜已撿磁鐵 '+round.finalPicked+' 顆，繼續尋找');return;
          }
          status('磁鐵接近後消失，暫判已拾取，返回原點');
          returnHome(round.part,now);return;
        }
        round.blocked.push({pos:w.pos,until:now+6000});
        round.magnetObserved=null;round.target=null;
      }
    }
    const chosen=chooseMagnet(now);
    if(!chosen){round.target=null;round.magnetObserved=null;
      if(finalOnly){
        // 只偵測磁鐵：不能執行隨機巡走，也不能重新返點。
        move();status('Boss最後15秒｜只找磁鐵，暫無目標（不巡走／不返點）');return;
      }
      if(inBossPhase()){
        returnHome(round.part,now);status('Boss階段沒有磁鐵，返點打王並繼續偵測');return;
      }
      patrol(now,true);status('磁鐵尚未出現，附近尋找中');return;}
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
  // 每場開局早期，若積存升級卡超過 5 張則開啟(B)。
  // 僅處理「卡片」數量，不把「寶箱」算進門檻，也不碰 Lv120 的保存功能。
  function savedCardsEntry(){
    const buttons=[...document.querySelectorAll('button,[role="button"]')];
    for(const button of buttons){
      if(!visible(button)||button.closest('#'+UI_ID))continue;
      if(!/^(?:開啟|开启|打開|打开)(?:\(?B\)?)?$/i.test(norm(button.textContent||'')))continue;
      let parent=button.parentElement;
      for(let depth=0;parent&&parent!==document.body&&depth<7;parent=parent.parentElement,depth++){
        const text=norm(parent.innerText||parent.textContent||'');
        if(text.length>300)break;
        const m=text.match(/已保存.{0,80}?卡片[:：]?(\d{1,5})(?=\D|$)/);
        if(m){
          const chest=text.match(/已保存.{0,100}?寶箱[:：]?(\d{1,5})(?=\D|$)/);
          return {button,count:Number(m[1]),chests:chest?Number(chest[1]):null};
        }
      }
    }
    return null;
  }
  function maybeOpenSavedCards(seconds){
    if(!round.started||!Number.isFinite(seconds)||seconds<0)return false;
    const state=round.savedOpen;
    // 人物等級達 Lv120 優先於「整批開到0張」，剩餘卡片直接保留。
    if(round.level120Reached || (Number.isFinite(topLeftLevel())&&topLeftLevel()>=OPT.levelSkip)){
      round.level120Reached=true;
      state.draining=false;
      return false;
    }
    if(state.blocked)return false;
    const picker=document.querySelector('#picker');
    if(picker&&visible(picker))return false; // 當前卡片交給獨立選技腳本
    const entry=savedCardsEntry();
    if(!entry)return false;
    // 已保存卡片「超過5張」只決定何時啟動整批；不是只開到剩5張。
    // 前75秒觸發後，超過75秒也會繼續處理，直到確認卡片0張。
    if(!state.draining){
      if(seconds>75||entry.count<=5)return false;
      state.draining=true;
      status('卡片'+entry.count+'張 > 5｜啟動整批開啟，直到0張');
    }
    if(entry.count===0){
      state.draining=false;state.count=0;state.tries=0;state.lastAt=0;
      status('已保存卡片0張｜整批全部開完');
      return false;
    }
    const now=timeNow();
    if(state.count!==entry.count){
      // 卡片數實際變化後，才解鎖下一張。剩5、4、3、2、1張也要開。
      state.count=entry.count;state.tries=0;state.lastAt=0;
    }
    if(state.lastAt&&now-state.lastAt<1500)return false;
    if(state.tries>=2){
      state.blocked=true;
      status('卡片'+entry.count+'張未減少｜停止重試，避免重複點擊');
      return false;
    }
    if(busy())return false;
    state.tries++;state.lastAt=now;
    move();entry.button.click();
    status('整批開卡｜尚有'+entry.count+'張｜開啟(B)第'+state.tries+'次');
    return true;
  }

  // 自動 Lv120 後的寶箱流程：
  // 舊版會在升級畫面按「之後不再翻牌」；新版完全不按那個按鈕。
  // 只有本場已明確確認 >=Lv120，且目前是寶箱頁時才按「繼續保存」。
  function topLeftLevel(){
    for(const el of document.querySelectorAll('span,b,strong,div')){
      if(el.childElementCount>1||!visible(el)||el.closest('#picker,#'+UI_ID))continue;
      const box=el.getBoundingClientRect();
      if(box.left<0||box.left>370||box.top<0||box.top>145)continue;
      const m=norm(el.textContent||'').match(/^Lv\.?(\d{1,3})$/i);
      if(m)return Number(m[1]);
    }
    return null;
  }
  // 認 HUD「寶箱 7774 Z」的下一箱需求金額；不要把「6472 Z」現有錢或
  // 「已保存：寶箱 50」當成開箱成本。未可靠讀到金額，一律不自動開箱。
  function nextTreasureCost(){
    const candidates=document.querySelectorAll('span,small,b,strong,div');
    for(const el of candidates){
      if(el.childElementCount>3||!visible(el)||el.closest('#picker,#'+UI_ID+
         ',#hans-left-control-center-v100,#ro-loot-journal-v05-ui'))continue;
      const rect=el.getBoundingClientRect();
      if(rect.top<0||rect.top>125||rect.left<95||rect.right>innerWidth+5)continue;
      const t=norm(el.textContent||'');
      if(t.length>95)continue;
      const m=t.match(/寶箱[:：]?(?:需要|需求|費用|花費)?([0-9,]{1,9})(?:z|zeny)(?![a-z])/i);
      if(!m)continue;
      const value=Number(m[1].replace(/,/g,''));
      if(Number.isFinite(value)&&value>=0)return value;
    }
    return null;
  }
  function treasureTab(){
    const picker=document.querySelector('#picker');
    if(!picker||!visible(picker))return null;
    const options=[...document.querySelectorAll('button,[role="button"]')];
    return options.find(b=>{
      if(!visible(b)||b.closest('#'+UI_ID))return false;
      const rect=b.getBoundingClientRect();
      if(rect.top<0||rect.top>180)return false;
      const match=norm(b.textContent||'').match(/^(?:寶箱|宝箱)(\d{1,5})$/i);
      return !!match&&Number(match[1])>0;
    })||null;
  }
  function treasureOpenButton(){
    const entry=savedCardsEntry();
    return entry&&Number.isFinite(entry.chests)&&entry.chests>0?entry:null;
  }

  function isTreasurePicker(){
    const panel=document.querySelector('#picker');
    if(!panel||!visible(panel))return false;
    const heading=norm(panel.querySelector('#pk-title')?.textContent||
      panel.querySelector('.pk-title')?.textContent||
      panel.querySelector('h1,h2')?.textContent||'');
    return /^(?:寶箱|宝箱|treasurechest)$/i.test(heading);
  }
  function continueSaveButton(){
    // 只找精確「繼續保存」，絕不誤點「之後不再翻牌」或一般的「繼續」。
    return [...document.querySelectorAll('button,[role="button"]')].find(btn=>
      visible(btn) &&
      /^(?:繼續保存|继续保存|繼續儲存|继续储存)$/.test(norm(btn.textContent||'')))||null;
  }
  function isLevelUpPicker(){
    const panel=document.querySelector('#picker');
    if(!panel||!visible(panel))return false;
    const heading=norm(panel.querySelector('#pk-title')?.textContent||
      panel.querySelector('.pk-title')?.textContent||
      panel.querySelector('h1,h2')?.textContent||'');
    return /^(?:升級|強化技能|levelup|upgradeskill)!?$/i.test(heading)||
      !!levelUpPanel();
  }
  function clickContinueSave(reason,kind){
    const btn=continueSaveButton();
    if(!btn){
      status(reason+'｜找不到繼續保存，暫停選卡');
      return true;
    }
    // 同一個對話框只按一次，等待畫面結束或切換。
    const last=round.savePending;
    if(last&&last.button===btn&&last.kind===kind){
      if(timeNow()-last.at>2100)status(reason+'｜已按繼續保存但仍在此畫面，暫停重複點擊');
      return true;
    }
    round.savePending={button:btn,kind,at:timeNow()};
    move();btn.click();status(reason+'｜已按繼續保存');
    return true;
  }
  function maybeContinueSaving(){
    if(!round.started)return false;
    const lv=levelUpPanel()?.level??topLeftLevel();
    if(Number.isFinite(lv)&&lv>=OPT.levelSkip){
      round.level120Reached=true;
      round.savedOpen.draining=false;
    }
    if(!round.level120Reached)return false;
    const price=nextTreasureCost();
    const costOK=price!==null&&price<OPT.treasureCostLimit;
    const priceLabel=price===null?'價格未辨識':('下一箱'+price+' Z');
    const panel=document.querySelector('#picker');
    const activePicker=!!panel&&visible(panel);
    if(!activePicker)round.savePending=null;

    // 確認已達成本門檻後，本場不再主動打開任何寶箱。
    if(price!==null&&price>=OPT.treasureCostLimit){
      round.chestOpen.blocked=true;
      if(activePicker)return clickContinueSave('寶箱達'+price+' Z，已達7000 Z停止門檻','limit');
      return false;
    }
    // 未確認下一箱需求金額時，不允許試抽（避免把現有金幣誤當成本）。
    if(!costOK){
      if(activePicker)return clickContinueSave('寶箱需求金額未確認，保留卡片與寶箱','unknown-cost');
      status('Lv120後等待讀取寶箱需求金額；暫不開箱');
      return false;
    }
    if(round.chestOpen.blocked){
      if(activePicker)return clickContinueSave('寶箱自動開啟已暫停，保留剩餘獎勵','blocked');
      return false;
    }
    if(activePicker){
      // 只開寶箱：若 B 先開成技能頁，就切換上方「寶箱 n」分頁。
      if(isLevelUpPicker()){
        const tab=treasureTab(),stash=treasureOpenButton();
        if(tab){
          // 防重入：點分頁後至少等待一秒讓選卡畫面換頁。
          const old=round.savePending;
          if(old&&old.button===tab&&old.kind==='treasure-tab'){
            if(timeNow()-old.at>2200){
              round.chestOpen.blocked=true;
              return clickContinueSave('無法切換至寶箱分頁，停止自動開箱','tab-failed');
            }
            return true;
          }
          round.savePending={button:tab,kind:'treasure-tab',at:timeNow()};
          move();tab.click();status('Lv120後只抽寶箱｜切換寶箱分頁｜'+priceLabel);
          return true;
        }
        // 無寶箱或沒找到分頁時，只保存升級卡，不自動選升級技能。
        if(stash&&!tab)round.chestOpen.blocked=true;
        return clickContinueSave(stash?'找不到寶箱分頁，停止自動開箱':'Lv120停止升級卡，保留剩餘卡片', 'level');
      }
      if(isTreasurePicker()){
        round.savePending=null;
        // 成本低於7000，三選一交由原本巫師／流氓選技腳本處理寶箱。
        return false;
      }
      // 未知選卡頁面不自行選卡。
      return true;
    }
    if(round.chestOpen.blocked)return false;
    const entry=treasureOpenButton();
    if(!entry)return false;
    const state=round.chestOpen,now=timeNow();
    if(state.count!==entry.chests){
      state.count=entry.chests;state.tries=0;state.lastAt=0;
    }
    if(state.lastAt&&now-state.lastAt<1600)return false;
    if(state.tries>=2){
      state.blocked=true;
      status('寶箱數量未減少，開啟(B)兩次無效｜停止重試');
      return false;
    }
    state.tries++;state.lastAt=now;
    move();entry.button.click();
    status('Lv120後自動開寶箱｜還有'+entry.chests+'箱｜'+priceLabel+'（低於7000）');
    return true;
  }

  // 正常關卡在14:00後可能把上方計時從13:xx切換為Boss 2:00倒數。
  // 翻回總場次經過時間，避免被誤判回2分鐘、漏掉14:00磁鐵。
  function normalizeCombatSeconds(raw){
    const previous=round.rawSeconds;
    if(!round.bossCountdown && previous!==null && previous>=12*60 &&
       raw<=180 && previous-raw>100){
      round.bossCountdown=true;
      status('已偵測Boss倒數，磁鐵排程繼續');
    }
    round.rawSeconds=raw;
    if(round.bossCountdown && raw<=180)return 14*60+Math.max(0,120-raw);
    return raw;
  }
  function inBossPhase(){
    return round.started && (round.bossCountdown || round.seconds>=14*60);
  }
  function isFinalBossSweep(){
    // 用 Boss 倒數 HUD 原始秒數判斷，不能把正常開局的 0:15 誤當成最後15秒。
    return round.started && round.bossCountdown &&
      Number.isFinite(round.rawSeconds) && round.rawSeconds>=0 &&
      round.rawSeconds<=OPT.finalBossSeconds;
  }
  function startFinalBossSweep(now){
    // 就算原本在返點、一般磁鐵追蹤、或定點打王，最後15秒一律切到只找磁鐵。
    move();round.mode='final';round.part='final';round.seekAt=now;
    round.target=null;round.magnetObserved=null;round.bestGap=Infinity;
    round.progressAt=now;round.detours=0;round.detourUntil=0;
    status('Boss倒數 '+round.rawSeconds+' 秒｜只找磁鐵、不再返點');
  }
  const magnetSchedule=(()=>{
    const times=[...OPT.magnetMinutes];
    for(let t=OPT.repeatStartS;t<=OPT.repeatLastS;t+=OPT.repeatEveryS)times.push(t);
    return times;
  })();

  // 排程共用：前3分鐘巡走模式也要在 1:55、2:55 啟動磁鐵，避免漏撿。
  function beginDueMagnet(now){
    for(const m of magnetSchedule){
      if(round.completed.has(m)||round.seconds<m)continue;
      if(round.seconds-m>OPT.missedWindowS){
        round.completed.add(m);if(m===355)round.sixComplete=true;
        continue;
      }
      beginMagnet(m,now);return true;
    }
    return false;
  }
  // 互斥：關閉原長場巡走，兩支腳本不得同時發方向鍵。
  function disableOriginalLongPatrol(){
    const old=document.getElementById('hans-early-patrol-magnet-v200');
    if(!old)return true;
    let color=old.style.backgroundColor;
    if(color==='#186442'||color==='rgb(24, 100, 66)'){
      old.click();color=old.style.backgroundColor;
      if(color==='#186442'||color==='rgb(24, 100, 66)'){
        status('請先關閉原長場巡走，避免方向鍵衝突');return false;
      }
    }
    return true;
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
    if(!disableOldGather()||!disableOriginalLongPatrol()){move();return;}
    const next=document.querySelector('#minimap canvas');
    if(next!==map)watchMap(next);
    const outside=outsideRun();
    if(outside){
      if(!round.outside){resetRound();round.outside=true;}
      move();status('等待下一場');return;
    }
    // Lv120 優先：即使此時是升級選卡、寶箱畫面、計時或小地圖暫停，
    // 都先按「繼續保存」，保留剩餘卡片，不再開到0張。
    if(round.started&&maybeContinueSaving()){move();return;}
    const secs=readGameTime();
    if(secs===null){move();status('等待遊戲計時／地圖');return;}
    if(!next||!visible(next)||!player||now-lastPlayerAt>950){move();status('等待小地圖座標');return;}
    if(!round.started){
      // 現在不要求前45秒啟動，5:57開啟也能從6:00磁鐵接續。
      startRound(secs);
    }
    // 進場已保存卡片>5即啟動；在Lv120之前逐張處理，
    // 若尚未達Lv120就持續到0張，達Lv120立即保存剩餘卡片。
    if(maybeOpenSavedCards(secs)){move();return;}
    // Boss 結束時 HUD 也可能跳回 0:15，不能把它誤認為下一場開局。
    // 正常重進經過主城／選關時會由 outsideRun 重設，這裡不憑時間跳轉重新開場。
    round.prevSeconds=round.seconds;round.seconds=normalizeCombatSeconds(secs);
    // Lv120 後寶箱「繼續保存」已在小地圖座標檢查之前處理。
    if(busy()||document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]')){
      move();return;
    }
    if(isFinalBossSweep()){
      if(round.mode!=='final')startFinalBossSweep(now);
      seekMagnet(now);return;
    }
    if(round.failed){move();return;}
    if(round.mode==='return'){driveHome(now);return;}
    if(round.mode==='seek'){seekMagnet(now);return;}
    if(round.mode==='patrol'){
      // 3:00 前保持移動，磁鐵 1:55 / 2:55 優先執行；不要提前返點停留。
      if(round.seconds>=OPT.firstPatrolUntilS){returnHome('initial',now);driveHome(now);return;}
      if(beginDueMagnet(now))return;
      patrol(now);status('流氓前三分鐘持續巡走 '+formatTime(round.seconds)+'／3:00');return;
    }
    if(round.mode==='park'){
      if(beginDueMagnet(now))return;
      // 固定時窗以外，Boss 戰鬥期間只要小地圖又出現磁鐵就會再去撿。
      if(inBossPhase() && now-round.bossLastSeekAt>=OPT.bossMagnetRetryMs){
        round.bossLastSeekAt=now;
        const available=chooseMagnet(now);
        if(available){beginMagnet('boss',now);return;}
      }
      move();
      const next=magnetSchedule.find(m=>!round.completed.has(m)&&m>round.seconds);
      status(inBossPhase()?'Boss定點輸出中＋持續監看磁鐵':
        next===undefined?'原地刷怪｜等待Boss磁鐵':
        '原地刷怪｜下次磁鐵 '+formatTime(next));
      return;
    }
    move();
  }
  function stop({remember=true}={}){
    enabled=false;clearInterval(interval);interval=null;move();restoreMap();resetRound();
    if(remember)try{sessionStorage.setItem(ENABLE_KEY,'0');}catch{}
    button.style.background='#384455';status('關（Shift+8 開啟）');
  }
  function start({remember=true}={}){
    if(!disableOldGather()||!disableOriginalLongPatrol())return;
    enabled=true;if(remember)try{sessionStorage.setItem(ENABLE_KEY,'1');}catch{}
    button.style.background='#186442';status('開｜等待下一場開局');
    clearInterval(interval);interval=setInterval(()=>{
      try{loop();}catch(err){move();status('錯誤：已停止移動');console.error('[HANS 流氓巡走 2.3.2]',err);}
    },OPT.tickMs);
  }
  button.onclick=()=>enabled?stop():start();
  window.addEventListener('keydown',event=>{
    if(event.code!=='Digit8'||!event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.repeat||event.isComposing)return;
    if(event.composedPath().some(e=>e?.isContentEditable||e?.matches?.('input,textarea,select,[role="textbox"]')))return;
    event.preventDefault();event.stopImmediatePropagation();button.click();
  },true);
  window.addEventListener('blur',()=>move());
  window.addEventListener('pagehide',()=>{move();clearInterval(interval);restoreMap();});
  let remembered=false;try{remembered=sessionStorage.getItem(ENABLE_KEY)==='1';}catch{}
  if(remembered)start({remember:false});else status('關（Shift+8 開啟）');
})();