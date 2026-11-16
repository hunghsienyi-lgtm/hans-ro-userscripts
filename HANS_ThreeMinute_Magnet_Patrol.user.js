// ==UserScript==
// @name         HANS RO｜三分鐘刷卡巡走｜0:55磁鐵＋最後15秒只找磁鐵
// @namespace    hunghung-ro-local-tools
// @version      1.0.5
// @description  HANS三分鐘短場：走到Lv30返點站打30秒；0:55起找第一顆磁鐵，2:45起最後15秒只找磁鐵（含2:55），不返點，完成後再捨棄。
// @match        https://ro.hans-webgametw.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_ThreeMinute_Magnet_Patrol.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_ThreeMinute_Magnet_Patrol.user.js
// ==/UserScript==
(() => {
  'use strict';
  const UI_ID='hans-three-minute-magnet-patrol-v1';
  if(document.getElementById(UI_ID))return;
  const KEY_ENABLED='hans_ro_three_min_patrol_enabled_v1';
  const KEY_SYNC='hans_ro_three_min_magnet_sync_v1';
  const KEY_SHORT='hans-ro-stage-loot-short3-v070';
  const OPT={first:55,second:175,finalStart:165,finalEnd:180,skipLevel:31,homePauseSeconds:30,seekMaxMs:35000,confirmMs:550,
    reach:3.4,homeReach:2.8,radius:68,returnMaxMs:40000,stallMs:2900,detourMs:850,maxDetours:4,tickMs:140};
  const PATROL=['d','s','a','a','w','d','w','s'];
  const now=()=>performance.now();
  const d=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const near=(a,b,r)=>d(a,b)<=r;
  const norm=s=>String(s??'').normalize('NFKC').replace(/[\s\u200b-\u200d]/g,'').trim();
  const shown=el=>{
    if(!el||!el.isConnected||!el.getClientRects().length)return false;
    for(let p=el,i=0;p&&i<12;p=p.parentElement,i++){
      const v=getComputedStyle(p);
      if(v.display==='none'||v.visibility==='hidden'||Number(v.opacity)===0||p.hidden)return false;
    }
    return true;
  };
  const button=document.createElement('button');
  button.id=UI_ID;button.type='button';button.setAttribute('aria-keyshortcuts','Shift+7');
  button.style.cssText='position:fixed;left:8px;bottom:158px;z-index:2147483647;background:#384455;color:white;border:1px solid #eaeaea;border-radius:6px;padding:5px 8px;font:12px system-ui;max-width:min(370px,90vw);cursor:pointer;text-align:left';
  button.title='Shift+7 開關；走到Lv30返點、站打30秒，0:55起找第一顆磁鐵；2:45起進入最後15秒只找磁鐵（含2:55），不返點，3:00處理後捨棄重進。';
  (document.body||document.documentElement).append(button);
  const info=s=>{const text='HANS 3分巡走｜'+s;if(button.textContent!==text)button.textContent=text;};
  let enabled=false,timer=null,canvas=null,restore=null,player=null,playerAt=0,magnets=[],arc=null,points=[];
  const held=new Set();
  const run={started:false,wasOutside:true,seconds:null,home:null,mode:'waiting',part:'',
    firstPicked:false,secondPicked:false,secondDone:false,firstStarted:false,secondStarted:false,
    level30Reached:false,holdUntilSeconds:null,finalPicked:0,skipClicked:false,skipAttempts:0,patrolStep:0,patrolUntil:0,seekAt:0,returnAt:0,
    target:null,observed:null,bestDistance:Infinity,progressAt:0,detours:0,detourUntil:0,
    detourKey:'',blocked:[],returnBest:Infinity,returnProgressAt:0,returnDetours:0,
    returnDetourUntil:0,returnDetourKey:''};
  function move(keys=''){
    for(const k of [...held])if(!keys.includes(k)){
      window.dispatchEvent(new KeyboardEvent('keyup',{key:k,code:'Key'+k.toUpperCase(),bubbles:true}));held.delete(k);
    }
    for(const k of keys)if(!held.has(k)){
      window.dispatchEvent(new KeyboardEvent('keydown',{key:k,code:'Key'+k.toUpperCase(),bubbles:true}));held.add(k);
    }
  }
  function sync(phase){
    try{sessionStorage.setItem(KEY_SYNC,JSON.stringify({enabled:true,phase,seconds:run.seconds,
      updatedAt:Date.now(),firstPicked:run.firstPicked,secondPicked:run.secondPicked}));}catch{}
  }
  function clearSync(){try{sessionStorage.removeItem(KEY_SYNC)}catch{}}
  function reset(){
    move();Object.assign(run,{started:false,seconds:null,home:null,mode:'waiting',part:'',
      firstPicked:false,secondPicked:false,secondDone:false,firstStarted:false,secondStarted:false,
      level30Reached:false,holdUntilSeconds:null,finalPicked:0,skipClicked:false,skipAttempts:0,patrolStep:0,patrolUntil:0,seekAt:0,returnAt:0,
      target:null,observed:null,bestDistance:Infinity,progressAt:0,detours:0,detourUntil:0,
      detourKey:'',blocked:[],returnBest:Infinity,returnProgressAt:0,returnDetours:0,
      returnDetourUntil:0,returnDetourKey:''});
    clearSync();
  }
  function unwatch(){
    move();if(restore){try{restore()}catch(e){console.warn('[HANS 三分鐘巡走] 恢復小地圖筆刷失敗',e)}restore=null;}
    canvas=null;player=null;magnets=[];
  }
  function watch(next){
    unwatch();canvas=next;
    const ctx=next?.getContext('2d');if(!ctx)return;
    const original={};
    function hook(method,observe){
      if(typeof ctx[method]!=='function')return;
      original[method]=ctx[method];
      try{ctx[method]=function(...args){observe(...args);return original[method].apply(this,args)}}
      catch(e){console.warn('[HANS 三分鐘巡走] 小地圖掛鉤失敗：'+method,e)}
    }
    const push=(list,p)=>{if(!list.some(x=>near(x,p,.15)))list.push(p)};
    hook('clearRect',()=>{magnets=[];player=null});
    hook('beginPath',()=>{arc=null;points=[]});
    hook('moveTo',(x,y)=>{points=[[x,y]]});
    hook('lineTo',(x,y)=>{if(points.length<5)points.push([x,y])});
    hook('arc',(x,y,r,a,b,ccw)=>{arc={x,y,r,mark:ccw&&Math.abs(a-Math.PI)<.01&&Math.abs(b)<.01}});
    hook('stroke',()=>{
      if(arc&&(ctx.strokeStyle==='#ff3b4a'||(arc.mark&&points.length===3&&
        Math.abs(points[0][0]-(arc.x-arc.r))<.1&&Math.abs(points[2][0]-(arc.x+arc.r))<.1)))
        push(magnets,[arc.x,arc.y]);
    });
    hook('translate',(x,y)=>{player=[x,y];playerAt=now()});
    restore=()=>{for(const [key,originalFn] of Object.entries(original))ctx[key]=originalFn};
    reset();
  }
  function gameClock(){
    let best=null;
    for(const el of document.querySelectorAll('span,b,strong,time,div')){
      if(el.childElementCount>2||!shown(el)||el.closest('#'+UI_ID))continue;
      const m=/^(\d{1,2}):([0-5]\d)$/.exec((el.textContent||'').trim());if(!m)continue;
      const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      if(r.width<12||r.width>185||r.height<8||r.height>75||x<innerWidth*.30||x>innerWidth*.70||y>Math.min(150,innerHeight*.24))continue;
      const seconds=Number(m[1])*60+Number(m[2]);if(seconds>10*60)continue;
      const score=Math.abs(x-innerWidth/2)+Math.abs(y-25);
      if(!best||score<best.score)best={seconds,score};
    }
    return best?.seconds??null;
  }
  function outside(){
    const values=[...document.querySelectorAll('button,[role="button"]')].filter(shown).map(el=>norm(el.textContent));
    return values.some(s=>/^(?:與隊長交談|與隊長對話|和隊長交談|返回角色|回到角色|前往野外|出發|出征|入場)$/.test(s));
  }
  function busy(){
    if(['#picker','#drop-reveal'].some(s=>shown(document.querySelector(s))))return true;
    return [...document.querySelectorAll('button,[role="button"]')].some(el=>shown(el)&&
      /^(?:繼續|回到主選單|回主選單|捨棄)$/.test(norm(el.textContent)));
  }
  function ensureShortMode(){
    try{if(JSON.parse(localStorage.getItem(KEY_SHORT)||'{}')?.enabled===true)return true}catch{}
    const short=document.getElementById('hans-short-run-toggle');
    if(short&&short.isConnected){
      // 右下角面板即使收合，也可用程式的按鈕事件同步刷卡模式。
      short.click();
      try{return JSON.parse(localStorage.getItem(KEY_SHORT)||'{}')?.enabled===true}catch{}
    }
    return false;
  }
  function stopOtherMovers(){
    const buttons=['hans-early-patrol-magnet-v200','ro-forest-camp-v19'];
    for(const id of buttons){
      const other=document.getElementById(id);if(!other)continue;
      const style=other.style.backgroundColor;
      if(style==='#186442'||style==='rgb(24, 100, 66)')other.click();
      if(other.style.backgroundColor==='#186442'||other.style.backgroundColor==='rgb(24, 100, 66)'){
        info('請先關閉另一支巡走／森林採集腳本');return false;
      }
    }
    return true;
  }
  function startRound(seconds){
    reset();run.started=true;run.wasOutside=false;run.home=[...player];run.seconds=seconds;
    run.mode='patrol';sync('active');info('開場持續巡走升級，直到 Lv30 才返點');
  }
  function toward(a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],t=.35*Math.max(Math.abs(dx),Math.abs(dy));
    return (Math.abs(dx)>t?(dx>0?'d':'a'):'')+(Math.abs(dy)>t?(dy>0?'s':'w'):'');
  }
  function patrol(t,fast=false){
    if(!run.patrolUntil){run.patrolStep=0;run.patrolUntil=t+(fast?780:900)}
    if(t>=run.patrolUntil){run.patrolStep=(run.patrolStep+1)%PATROL.length;run.patrolUntil=t+(fast?780:900)}
    move(PATROL[run.patrolStep]);
  }
  function returnHome(reason,t){
    if(reason==='second'){run.secondDone=true;sync('returning-second');}
    run.mode='return';run.part=reason;run.returnAt=t;run.returnBest=Infinity;
    run.returnProgressAt=t;run.returnDetours=0;run.returnDetourUntil=0;
    run.target=null;run.observed=null;move();
  }
  function park(){
    // 按遊戲內計時停留，升級選卡暫停時不偷算站打時間。
    if((run.part==='initial'||run.part==='level30')&&run.holdUntilSeconds===null)
      run.holdUntilSeconds=run.seconds+OPT.homePauseSeconds;
    run.mode='park';run.target=null;run.patrolUntil=0;move();
    if(run.secondDone)sync('done'); // 必須真正返回原點才放行右下角捨棄流程
    info(run.secondDone?'第二次磁鐵已處理且已返點，等待捨棄重進':
      run.holdUntilSeconds!==null&&run.seconds<run.holdUntilSeconds?'已回原點，站打30秒':
      '原地刷怪，等定時磁鐵');
  }
  function driveHome(t){
    if(!player||!run.home){move();return;}
    const gap=d(player,run.home);
    if(gap<=OPT.homeReach){park();return;}
    if(t-run.returnAt>OPT.returnMaxMs||run.returnDetours>OPT.maxDetours){
      move();run.mode='failed';info('返點失敗，停止移動避免亂走');return;
    }
    if(t<run.returnDetourUntil){move(run.returnDetourKey);return;}
    if(run.returnDetourUntil){run.returnDetourUntil=0;run.returnBest=gap;run.returnProgressAt=t;}
    if(gap+.12<run.returnBest){run.returnBest=gap;run.returnProgressAt=t;}
    if(t-run.returnProgressAt>OPT.stallMs){
      const delta=[run.home[0]-player[0],run.home[1]-player[1]];
      run.returnDetourKey=(Math.abs(delta[0])>=Math.abs(delta[1])?['w','s']:['d','a'])[run.returnDetours%2];
      run.returnDetours++;run.returnDetourUntil=t+OPT.detourMs;run.returnProgressAt=t;
      move(run.returnDetourKey);return;
    }
    move(toward(player,run.home));
    info('返回原點中，距離 '+gap.toFixed(1));
  }
  function beginSeek(part,t){
    run.mode='seek';run.part=part;run.seekAt=t;run.target=null;run.observed=null;
    run.blocked=[];run.bestDistance=Infinity;run.progressAt=t;run.detours=0;run.detourUntil=0;run.patrolUntil=0;
    if(part==='first')run.firstStarted=true;
    else {run.secondStarted=true;sync('seeking-second');}
    move();info(part==='first'?'站打30秒完成，開始找第一顆磁鐵':'2:55 第二輪找磁鐵');
  }

  // 3:00前最後15秒 (2:45–3:00) 只追磁鐵。
  // 2:55已位於同一次搜尋期內，不再重置動作或強迫返點。
  function beginFinalSweep(t){
    run.mode='final';run.part='second';run.secondStarted=true;run.seekAt=t;
    run.target=null;run.observed=null;run.bestDistance=Infinity;
    run.progressAt=t;run.detours=0;run.detourUntil=0;run.patrolUntil=0;
    run.blocked=[];move();sync('seeking-second');
    info('2:45起最後15秒｜只找磁鐵、不返點');
  }
  function endFinalSweep(message){
    move();run.secondDone=true;run.mode='final-done';
    run.target=null;run.observed=null;sync('done');
    info(message||'最後磁鐵已處理，允許三分鐘捨棄重進');
  }

  function chooseMagnet(t){
    if(!player||!run.home)return null;
    run.blocked=run.blocked.filter(x=>x.until>t);
    const list=magnets.filter(p=>d(p,run.home)<=OPT.radius&&!run.blocked.some(x=>near(x.pos,p,3)));
    return list.reduce((best,p)=>!best||d(p,player)<d(best,player)?p:best,null);
  }
  function seek(t){
    const finalOnly=run.mode==='final';
    if(t-run.seekAt>OPT.seekMaxMs){
      if(finalOnly)endFinalSweep('最後磁鐵搜尋達35秒上限，允許捨棄重進');
      else returnHome(run.part,t);
      return;
    }
    const observed=run.observed;
    if(observed){
      const exists=magnets.some(p=>near(p,observed.pos,3));
      if(exists)observed.missingAt=0;
      else if(!observed.missingAt){observed.missingAt=t;move();return;}
      else if(t-observed.missingAt<OPT.confirmMs){move();return;}
      else if(observed.minGap<=OPT.reach&&player&&d(player,observed.pos)<=OPT.reach+1){
        if(run.part==='first')run.firstPicked=true;
        else run.secondPicked=true;
        if(finalOnly){
          run.finalPicked++;
          run.blocked.push({pos:[...observed.pos],until:t+12000});
          run.observed=null;run.target=null;run.bestDistance=Infinity;move();
          if(run.seconds>=OPT.finalEnd){
            endFinalSweep('最後磁鐵已撿 '+run.finalPicked+' 顆，允許捨棄重進');
          }else{
            info('最後15秒已撿 '+run.finalPicked+' 顆，繼續找下一顆');
          }
          return;
        }
        info('磁鐵接近後消失，暫判已撿取');returnHome(run.part,t);return;
      }else{
        run.blocked.push({pos:observed.pos,until:t+6000});run.observed=null;run.target=null;
      }
    }
    const target=chooseMagnet(t);
    if(!target){
      run.target=null;run.observed=null;move();
      if(finalOnly && run.seconds>=OPT.finalEnd){
        endFinalSweep('3:00未見其他磁鐵，允許捨棄重進');return;
      }
      info(finalOnly?'3:00前最後15秒：只監看磁鐵，不巡走／不返點':
        '原地等待小地圖出現磁鐵（最多35秒），不隨機亂走');
      return;
    }
    if(!run.target||!near(run.target,target,3)){
      run.target=[...target];run.bestDistance=d(player,target);run.progressAt=t;
      run.detours=0;run.detourUntil=0;
    }
    const gap=d(player,run.target);
    if(!run.observed||!near(run.observed.pos,run.target,3))
      run.observed={pos:[...run.target],minGap:gap,missingAt:0};
    else run.observed.minGap=Math.min(run.observed.minGap,gap);
    if(t<run.detourUntil){move(run.detourKey);return;}
    if(run.detourUntil){run.detourUntil=0;run.bestDistance=gap;run.progressAt=t;}
    if(gap+.12<run.bestDistance){run.bestDistance=gap;run.progressAt=t;}
    if(t-run.progressAt>OPT.stallMs){
      if(run.detours>=3){run.blocked.push({pos:[...run.target],until:t+10000});run.target=null;run.observed=null;move();return;}
      const delta=[run.target[0]-player[0],run.target[1]-player[1]];
      run.detourKey=(Math.abs(delta[0])>=Math.abs(delta[1])?['w','s']:['d','a'])[run.detours%2];
      run.detours++;run.detourUntil=t+OPT.detourMs;run.progressAt=t;
      move(run.detourKey);return;
    }
    move(gap>.45?toward(player,run.target):'');
    info('追磁鐵中，距離 '+gap.toFixed(1));
  }
  function levelPanel(){
    const p=document.querySelector('#picker');if(!shown(p))return null;
    const all=norm(String((p.innerText||p.textContent||'').slice(0,1300))+' '+
      String(document.querySelector('#lu-sockets')?.parentElement?.textContent||'').slice(0,500));
    if(!/LevelUp|強化技能|升級/i.test(all))return null;
    const match=all.match(/Lv\.?\s*(\d{1,3})(?:[:：]|(?:傷害|HP|血量|級))/i);
    return match?{panel:p,level:Number(match[1])}:null;
  }
  function stopCardFlips(t){
    if(!run.started)return;
    const level=levelPanel();
    if(!level)return;
    if(level.level>=30&&!run.level30Reached){
      run.level30Reached=true;
      // Lv30 當下立刻停止隨機巡走；若已出門追磁鐵，也先回原點。
      if(run.mode==='patrol')returnHome('level30',t);
      else if(run.mode==='seek'){
        if(run.part==='second')run.secondDone=true;
        if(run.part==='first')run.firstStarted=true;
        returnHome(run.part==='second'?'second':'level30',t);
      }
      info('已達 Lv30：停止亂走，回原點；最後一張技能仍交給巫師選技');
    }
    // Lv30 本次升級卡仍要讓巫師選技完成；Lv31 的畫面才按停止翻牌。
    if(level.level<OPT.skipLevel||run.skipClicked||run.skipAttempts>=5)return;
    const stop=[...document.querySelectorAll('button,[role="button"]')].find(el=>
      shown(el)&&/^(?:之後不再翻牌|之后不再翻牌)$/.test(norm(el.textContent)));
    if(!stop){info('Lv'+level.level+' 已到，但找不到免翻牌按鈕');return;}
    run.skipAttempts++;
    stop.click();run.skipClicked=true;
    info('Lv'+level.level+'：Lv30 最後技能已可選，後續停止翻牌');
  }
  function loop(){
    if(!enabled||document.hidden)return;
    if(!stopOtherMovers()){move();return;}
    if(!ensureShortMode()){move();info('等待右下角3分鐘刷卡開關');return;}
    const t=now();
    const next=document.querySelector('#minimap canvas');
    if(next!==canvas)watch(next);
    if(outside()){
      if(!run.wasOutside){reset();run.wasOutside=true;}
      move();info('等待下一場出征');return;
    }
    // 升級視窗可能讓小地圖停止更新：優先檢查 Lv30／Lv31，
    // 不能因小地圖座標超過950ms未刷新就漏掉最後一次升級事件。
    if(run.started)stopCardFlips(t);
    const clock=gameClock();
    if(clock===null){move();info('等待遊戲計時');return;}
    if(!next||!shown(next)||!player||t-playerAt>950){move();info('等待小地圖人物座標');return;}
    if(!run.started){
      if(clock>45){move();info('這場已進行到 '+clock+' 秒，下一場開局再開始');return;}
      startRound(clock);
    }
    run.seconds=clock;
    if(!run.secondDone){sync(clock>=180?'seeking-second':'active');}
    stopCardFlips(t);
    if(busy()||document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]')){
      move();return;
    }
    // 最後15秒優先：中斷返點、原地站打或尋第一顆磁鐵。
    // 2:55落在同一搜尋期間，不會額外重跑一次。
    if(clock>=OPT.finalStart&&!run.secondDone&&run.mode!=='final'&&run.mode!=='final-done'){
      beginFinalSweep(t);
    }
    if(run.mode==='final'){seek(t);return;}
    if(run.mode==='final-done'){move();return;}
    if(run.mode==='seek'){seek(t);return;}
    if(run.mode==='return'){driveHome(t);return;}
    if(run.mode==='failed'){move();return;}
    if(run.mode==='patrol'){
      // 不再因開局滿30秒而停。Lv25、Lv28一樣繼續走，只有確認 Lv30 才返點。
      if(run.level30Reached){
        returnHome('level30',t);driveHome(t);return;
      }
      patrol(t);
      info('持續巡走升級直到 Lv30｜目前遊戲時間 '+
        Math.floor(clock/60)+':'+String(clock%60).padStart(2,'0'));
      return;
    }
    if(run.mode==='park'){
      if(run.holdUntilSeconds!==null && clock<run.holdUntilSeconds){
        move();info('原點站打30秒中｜剩餘 '+Math.ceil(run.holdUntilSeconds-clock)+' 秒');return;
      }
      if(!run.firstStarted && clock>=OPT.first && clock<OPT.second){
        beginSeek('first',t);return;
      }
      if(clock>=OPT.second&&!run.secondDone&&!run.secondStarted){
        // 若2:45未能開始，2:55直接補啟動，不要再等整分3:00。
        beginFinalSweep(t);seek(t);return;
      }
      move();info(run.secondDone?'第二顆磁鐵已處理，準備捨棄':'原地刷怪，2:45起只找磁鐵（2:55前已啟動）');
    }
  }
  function stop({remember=true}={}){
    enabled=false;clearInterval(timer);timer=null;move();unwatch();reset();
    if(remember)try{sessionStorage.setItem(KEY_ENABLED,'0')}catch{}
    button.style.background='#384455';info('關閉（Shift+7）');
  }
  function start({remember=true}={}){
    if(!stopOtherMovers())return;
    enabled=true;if(remember)try{sessionStorage.setItem(KEY_ENABLED,'1')}catch{}
    ensureShortMode();
    button.style.background='#186442';info('啟用｜等待下一場開局');
    clearInterval(timer);timer=setInterval(()=>{
      try{loop()}catch(error){move();info('錯誤：暫停移動');console.error('[HANS 三分鐘巡走]',error)}
    },OPT.tickMs);
  }
  button.onclick=()=>enabled?stop():start();
  window.addEventListener('keydown',event=>{
    if(event.code!=='Digit7'||!event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.repeat||event.isComposing)return;
    const path=typeof event.composedPath==='function'?event.composedPath():[];
    if(path.some(el=>el?.isContentEditable||el?.matches?.('input,textarea,select,[role="textbox"]')))return;
    event.preventDefault();event.stopImmediatePropagation();button.click();
  },true);
  window.addEventListener('blur',()=>move());
  window.addEventListener('pagehide',()=>{move();clearInterval(timer);unwatch();clearSync();});
  let remembered=false;try{remembered=sessionStorage.getItem(KEY_ENABLED)==='1'}catch{}
  if(remembered)start({remember:false});else info('關閉（Shift+7）');
})();