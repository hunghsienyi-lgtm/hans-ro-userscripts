// ==UserScript==
// @name         HANS RO 斐揚森林｜磁鐵限量・稀有優先・Boss 戰後採集
// @namespace    ro-local-profiles
// @version      1.9.2
// @description  首次1:00採集以快速取得升級資源；此後每60秒短採35秒返點；磁鐵成功後冷卻60秒；橘>紫>寶箱；Boss戰後5秒
// @match        https://ro.hans-webgametw.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Forest_Magnet_Loot.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Forest_Magnet_Loot.user.js
// ==/UserScript==
(() => {
  'use strict';
  // 建議停用舊版採集腳本；避免同時送出相互衝突的方向鍵。
  if (document.getElementById('ro-forest-camp-v19')) return;
  const find = selector => document.querySelector(selector);
  const KEEP_ENABLED_KEY='hh_ro_forest_gather_enabled_v19';
  const wasEnabled=()=>{try{return sessionStorage.getItem(KEEP_ENABLED_KEY)==='1';}catch(_){return false;}};
  const rememberEnabled=on=>{try{sessionStorage.setItem(KEEP_ENABLED_KEY,on?'1':'0');}catch(_){}};
  const roundState={outside:false,lastExit:''};
  const END_PICKUP_MS=15500;

  const held = new Set();
  // 保留原路線：d、s各兩段；a、w各兩段，理論上會走回出發附近。
  const route = ['d', 's', 'a', 'a', 'w', 'd', 'w', 's']; // 僅在定時採集窗口內短距離巡走
  const SET = Object.freeze({
    interval: 120,
    patrolLegMs: 1100,
    // 只保留原版小地圖掃描與簡易繞路，不讀取伺服器資料。
    targetStallMs: 2500,          // 沒有縮短距離超過2.5秒，判定進度不足
    positionStallMs: 1400,        // 持續按鍵卻未位移超過1.4秒
    maxDetours: 3,               // 同個目標最多嘗試三次繞路
    blockedForMs: 30000,         // 暫時跳過30秒，時間到可重新撿
    blockedRadius: 3.0,          // 小地圖相近座標視為同一件物品
    sameTargetRadius: 3.0,
    progressDelta: 0.12,
    patrolStallMs: 2000
  });

  const CAMP = Object.freeze({
    firstGatherMs: 60000,    // 開局 1:00（早期採集拾取經驗升級資源）
    everyMs: 60000,          // 此後 2:00、3:00、4:00...
    fundsConfirmMs: 400,     // 金幣不足需持續確認，避免誤讀閃爍UI
    initialMagnetSeekMs: 25000, // 先找磁鐵25秒，沒有就撿稀有裝與寶箱
    gatherMaxMs: 35000,      // 每輪硬上限35秒，回程另計
    magnetCooldownMs: 60000, // 一個成功拾取後才開始60秒冷卻
    magnetMissingConfirmMs: 400,
    magnetPickupRadius: 3.4, // 小地圖座標；近距離＋持續消失才暫判成功
    bossMagnetMaxMs: 5000,   // 戰後全部磁鐵共用5秒額度
    bossOrangeStallMs: 3000, // 橘裝連續3秒沒有接近就放棄
    preBossReserveMs: 13*60000, // 13:00 後不主動撿磁鐵
    skipLastGatherMs: 13.5*60000, // 13:30 之後不再出門
    chestNearRadius: 3.0,
    chestFinishMaxMs: 2000,
    gatherRadius: 52,        // 只追原地周圍的小地圖目標
    homeTolerance: 2.8,      // 返回據點的距離容許值
    returnMaxMs: 43000,      // 回程最長 43 秒，失敗停止而非死撞牆
    returnStallMs: 2700,
    returnDetourMs: 850,
    returnMaxDetours: 4,
    missedWindowMs: 9500,   // 返點過久時跳過過期採集，不補刷堆積次數
    clockPollMs: 500
  });
  const camp = {
    mode: 'unbound', home: null, lastCycle: -1,
    insufficientSince: 0, startedReturn: 0,
    bestHomeGap: Infinity, homeProgressAt: 0,
    homeDetours: 0, homeDetourUntil: 0, homeDetourKey: '',
    lastIdleAt: 0, gatherStartedAt: 0, magnetSeekUntil: 0, magnetPriorityComplete: false, magnetSecuredThisCycle: false
  };
  const clock = {
    firstSeenAt: 0, lastReadAt: 0, prevRaw: null, bossCountdown: false,
    elapsedMs: 0, source: '等待遊戲畫面', lastGameSeenAt: 0,
    round: 0, phase: 'normal', bossWasVisible: false,
    bossLastSeenAt: 0, bossConfirmed: false,
    lastTimeBeforeBoss: 0, postBossStartedAt: 0, postBossEndAt: 0,
    postBossExpired: false, postMagnetDeadline: 0, postMagnetFinished: false,
    postRefreshUntil: 0

  };
  function resetCamp() {
    camp.mode = 'unbound'; camp.home = null; camp.lastCycle = -1;
    camp.insufficientSince = 0; camp.startedReturn = 0;
    camp.bestHomeGap = Infinity; camp.homeProgressAt = 0;
    camp.homeDetours = 0; camp.homeDetourUntil = 0; camp.homeDetourKey = '';
    camp.lastIdleAt = 0;camp.gatherStartedAt=0;camp.magnetSeekUntil=0;
    camp.magnetPriorityComplete=false;camp.magnetSecuredThisCycle=false;
    resetTarget(); move();
  }
  function resetRound(now) {
    resetCamp(); blocked = [];
    clock.firstSeenAt = now;
    clock.prevRaw = null; clock.bossCountdown = false;
    clock.elapsedMs = 0; clock.source = '新一場';
    clock.phase='normal';clock.bossWasVisible=false;
    clock.bossLastSeenAt=0;clock.bossConfirmed=false;
    clock.lastTimeBeforeBoss=0;clock.postBossStartedAt=0;
    clock.postBossEndAt=0;clock.postBossExpired=false;
    clock.postMagnetDeadline=0;clock.postMagnetFinished=false;clock.postRefreshUntil=0;

    clock.round++;
    lastMagnetPickedAt = -Infinity; magnetWatch=null; chestLockUntil=0;
  }
  // 只看畫面上方中央的 mm:ss；不要用 16:00 - mm:ss 推算一般關卡時間。
  function readGameHudClock() {
    const elems = document.querySelectorAll('span,b,strong,time,div');
    let best = null;
    for (const e of elems) {
      if (e.children.length > 2) continue;
      const t = (e.textContent || '').trim();
      const match = /^(\d{1,2}):([0-5]\d)$/.exec(t);
      if (!match) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 12 || r.width > 185 || r.height < 8 || r.height > 75) continue;
      const x = r.left + r.width/2, y = r.top + r.height/2;
      if (x < innerWidth * .30 || x > innerWidth * .70 || y > Math.min(150, innerHeight * .24)) continue;
      const secs = Number(match[1]) * 60 + Number(match[2]);
      if (secs > 20*60) continue;
      const score = Math.abs(x - innerWidth / 2) + Math.abs(y-25);
      if (!best || score < best.score) best = {secs,score};
    }
    return best?.secs ?? null;
  }
  // 只有上方中央的 MVP Eddga／虎王文字才算 Boss 在場，不讀取關卡選單的名稱。
  function bossTitleVisible(){
    const els=document.querySelectorAll('span,b,strong,div,[class*="boss" i],[id*="boss" i]');
    for(const el of els){
      if(el.children.length>2)continue;
      const t=(el.textContent||'').trim();
      if(t.length>90 || !/(?:\bEddga\b|裴揚虎王|斐揚虎王|虎王)/i.test(t))continue;
      const r=el.getBoundingClientRect();
      if(!r.width||r.top<30||r.top>innerHeight*.34||r.height>70)continue;
      const x=r.left+r.width/2;
      if(x<innerWidth*.18||x>innerWidth*.9||!el.getClientRects().length)continue;
      return true;
    }
    return false;
  }
  function updateClock(now) {
    if(!clock.firstSeenAt)clock.firstSeenAt=now;
    if(now-clock.lastReadAt<CAMP.clockPollMs)return;
    clock.lastReadAt=now;
    const secs=readGameHudClock();
    const visibleBoss=bossTitleVisible();
    const recentlyGone=clock.bossWasVisible && !visibleBoss &&
      now-clock.bossLastSeenAt<6000;
    if(visibleBoss){clock.bossWasVisible=true;clock.bossLastSeenAt=now;}
    if(secs===null){
      // 禁止憑腳本自己的計時推算Boss／戰後階段。
      if(clock.phase==='postboss'){
        clock.postBossExpired=now>=clock.postBossEndAt;
        clock.source='戰後最後拾取（HUD暫時消失）';
      }else if(clock.lastGameSeenAt && now-clock.lastGameSeenAt<4500){
        clock.source='遊戲HUD短暫消失';
      }else clock.source='遊戲計時無法確認';
      return;
    }
    const previous=clock.prevRaw;
    // 勝利後時間會跳至約15秒；不能把剛開局的0:15當成戰後。
    // 必須先確認曾進入Boss階段，且是倒數跳轉或Boss名稱消失。
    const jumpedToEnding=previous!==null && previous-secs>=17 && secs<=16;
    const postBossNow=clock.phase==='boss' && clock.bossConfirmed &&
      secs<=16 && !visibleBoss && (jumpedToEnding || recentlyGone);
    if(postBossNow){
      clock.phase='postboss';clock.postBossStartedAt=now;
      clock.postBossEndAt=now+secs*1000+850;
      clock.postBossExpired=false;
      camp.mode='final-loot';move();resetTarget();blocked=[];
      magnetWatch=null;chestLockUntil=0;
      clock.postMagnetDeadline=now+CAMP.bossMagnetMaxMs;
      clock.postMagnetFinished=!magnetReady(now);
      clock.postRefreshUntil=0;
    }
    if(clock.phase==='postboss'){
      // 若下一場正計時由0:xx開始，外部場次偵測負責重置；這裡保持戰後直到新場。
      clock.postBossExpired=secs===0||now>=clock.postBossEndAt;
      clock.source='擊敗Boss後最後15秒';
      clock.prevRaw=secs;clock.lastGameSeenAt=now;
      return;
    }
    if(previous!==null){
      // 一般遊戲從約14:00切換成Boss剩餘約2:00。
      const switched=previous>=12*60 && secs<=180 && secs<previous-100;
      if(!clock.bossCountdown && switched){
        clock.bossCountdown=true;clock.bossConfirmed=true;
        clock.phase='boss';
      } else if(!clock.bossCountdown && secs+45<previous){
        resetRound(now);
      } else if(clock.bossCountdown && secs>180 && !visibleBoss){
        resetRound(now);
      }
    }
    if(!clock.bossCountdown && visibleBoss && secs<=180 &&
       (clock.elapsedMs>=13*60*1000 || clock.lastTimeBeforeBoss>=12*60)){
      clock.bossCountdown=true;clock.bossConfirmed=true;clock.phase='boss';
    }
    if(clock.bossCountdown && secs<=180){
      clock.elapsedMs=(14*60+Math.max(0,120-secs))*1000;
      clock.source='Boss倒數';clock.phase='boss';
    } else {
      clock.elapsedMs=secs*1000;
      clock.lastTimeBeforeBoss=Math.max(clock.lastTimeBeforeBoss,secs);
      clock.source='遊戲正計時';clock.phase='normal';
    }
    clock.prevRaw=secs;clock.lastGameSeenAt=now;
  }
  function homePosition() {
    return player && Number.isFinite(player[0]) && Number.isFinite(player[1]) &&
      timeNow()-frame < 900 ? [...player] : null;
  }
  function magnetReady(now){
    return now-lastMagnetPickedAt >= CAMP.magnetCooldownMs;
  }
  function magnetReserved(){
    return clock.phase==='normal' && clock.elapsedMs>=CAMP.preBossReserveMs;
  }
  function magnetCanChase(now, finalLoot=false){
    if (!magnetReady(now)) return false;
    if(finalLoot) return !clock.postMagnetFinished && now<clock.postMagnetDeadline;
    return camp.mode==='gather' && !magnetReserved() &&
      !camp.magnetSecuredThisCycle && now<camp.magnetSeekUntil;
  }
  function beginGather(now, cycle) {
    camp.mode='gather'; camp.lastCycle=cycle;camp.gatherStartedAt=now;
    camp.insufficientSince=0; camp.lastIdleAt=now;
    resetTarget();move(); patrolUntil=0;
    magnetWatch=null;chestLockUntil=0;
    camp.magnetSeekUntil=now+CAMP.initialMagnetSeekMs;
    camp.magnetSecuredThisCycle=false;
    camp.magnetPriorityComplete=false;
    label('森林 v1.9.2｜第'+(cycle+1)+'輪：35秒採集');
  }
  function beginReturn(now) {
    camp.mode='return'; camp.startedReturn=now;
    magnetWatch=null;chestLockUntil=0;
    camp.bestHomeGap=Infinity; camp.homeProgressAt=now;
    camp.homeDetours=0; camp.homeDetourUntil=0;
    resetTarget(); move();
  }
  function returnHome(now) {
    const p=homePosition();
    if (!p || !camp.home) {move();label('森林 v1.9.2｜等待返點座標');return;}
    const gap=distance(p,camp.home);
    if (gap<=CAMP.homeTolerance) {
      move(); camp.mode='parked'; resetTarget();
      // 採集可能跨過多個整分鐘，回來後不補跑已過期的輪次。
      if(clock.elapsedMs>=CAMP.firstGatherMs)
        camp.lastCycle=Math.max(camp.lastCycle,
          Math.floor((clock.elapsedMs-CAMP.firstGatherMs)/CAMP.everyMs));
      label('森林 v1.9.2｜已回原地，待命');return;
    }
    if (now-camp.startedReturn>CAMP.returnMaxMs || camp.homeDetours>CAMP.returnMaxDetours) {
      move();camp.mode='failed';
      label('森林 v1.9.2｜返點失敗，已停止移動');return;
    }
    if (now<camp.homeDetourUntil) {move(camp.homeDetourKey);return;}
    if (camp.homeDetourUntil) {
      camp.homeDetourUntil=0;
      camp.bestHomeGap=gap;camp.homeProgressAt=now;
    }
    if (gap+.14<camp.bestHomeGap) {
      camp.bestHomeGap=gap;camp.homeProgressAt=now;
    }
    if (now-camp.homeProgressAt>CAMP.returnStallMs) {
      const dx=camp.home[0]-p[0],dy=camp.home[1]-p[1];
      const sides=Math.abs(dx)>=Math.abs(dy)?['w','s']:['d','a'];
      camp.homeDetourKey=sides[camp.homeDetours%2];
      camp.homeDetours++;camp.homeDetourUntil=now+CAMP.returnDetourMs;
      camp.homeProgressAt=now;move(camp.homeDetourKey);
      label('森林 v1.9.2｜返點繞路 '+camp.homeDetours+'/'+CAMP.returnMaxDetours);return;
    }
    const dx=camp.home[0]-p[0],dy=camp.home[1]-p[1];
    const margin=.35*Math.max(Math.abs(dx),Math.abs(dy));
    move((Math.abs(dx)>margin?(dx>0?'d':'a'):'')+
         (Math.abs(dy)>margin?(dy>0?'s':'w'):''));
    label('森林 v1.9.2｜返回原地 距離'+gap.toFixed(1));
  }
  function hasValuableTargets(){
    const rare=[...orangeLoot,...purpleLoot].some(pos=>
      !isBlocked(orangeLoot.some(p=>near(p,pos,.25))?'orange':'purple',pos) &&
      (!camp.home||distance(pos,camp.home)<=CAMP.gatherRadius));
    const budget=chestBudget();
    const chest=budget.known&&!budget.insufficient && !!closest('chest',boxes);
    return rare || chest;
  }
  function controlCamp(now) {
    if(clock.phase==='boss'&&clock.bossConfirmed){
      // Boss 存活期間打王，停止採集和移動；戰後才採集。
      move();resetTarget();magnetWatch=null;
      label('森林 v1.9.2｜Boss戰鬥中｜停止採集');return true;
    }
    const p=homePosition();
    if (!p) {move();label('森林 v1.9.2｜等待小地圖位置');return true;}
    if (!camp.home) {
      camp.home=p;camp.mode='parked';
      const dueCycle=Math.floor((clock.elapsedMs-CAMP.firstGatherMs)/CAMP.everyMs);
      const dueAt=CAMP.firstGatherMs+dueCycle*CAMP.everyMs;
      camp.lastCycle=clock.elapsedMs<CAMP.firstGatherMs ? -1 :
        (clock.elapsedMs-dueAt<=CAMP.missedWindowMs ? dueCycle-1 : dueCycle);
      move();label('森林 v1.9.2｜已定位據點，等待採集');return true;
    }
    if(camp.mode==='failed'){
      move();label('森林 v1.9.2｜返點失敗：已停止移動，請手動確認');return true;
    }
    if(camp.mode==='return') {returnHome(now);return true;}
    if(camp.mode==='gather'){
      // 採集 35 秒硬上限，回程另計，不能因磁鐵/寶箱無限延長。
      if(now-camp.gatherStartedAt>=CAMP.gatherMaxMs){
        beginReturn(now);returnHome(now);return true;
      }
      camp.magnetPriorityComplete=!magnetCanChase(now);
      if(magnetReserved() && active?.kind==='magnet'){
        // 13:00 主動停止追逐；不是失敗，不封鎖目標也不扣額度。
        move();resetTarget();
        if(magnetWatch?.minGap>CAMP.magnetPickupRadius)magnetWatch=null;
      }
      // 最後一輪 13:00 以後：沒有橘紫裝或可負擔寶箱，直接提前返點。
      if(magnetReserved() && !hasValuableTargets()){
        beginReturn(now);returnHome(now);return true;
      }
      // 原本的金幣不足提前返點，仍不會忽略可撿的稀有裝備。
      if(camp.magnetPriorityComplete && !hasValuableTargets()){
        const budget=chestBudget();
        if(budget.known && budget.insufficient){
          if(!camp.insufficientSince)camp.insufficientSince=now;
          if(now-camp.insufficientSince>=CAMP.fundsConfirmMs){
            beginReturn(now);returnHome(now);return true;
          }
        }else camp.insufficientSince=0;
      }else camp.insufficientSince=0;
      return false;
    }
    if(camp.mode==='parked'){
      const elapsed=clock.elapsedMs;
      if(elapsed>=CAMP.skipLastGatherMs){
        move();label('森林 v1.9.2｜13:30後原地待王，保留磁鐵');return true;
      }
      const cycle=Math.floor((elapsed-CAMP.firstGatherMs)/CAMP.everyMs);
      if(cycle>camp.lastCycle && elapsed>=CAMP.firstGatherMs){
        const planned=CAMP.firstGatherMs+cycle*CAMP.everyMs;
        if(elapsed-planned<=CAMP.missedWindowMs){beginGather(now,cycle);return false;}
        camp.lastCycle=cycle; // 回程過長就跳過已過時的窗口
      }
      const remain=Math.max(0,CAMP.firstGatherMs+(camp.lastCycle+1)*CAMP.everyMs-elapsed);
      move();label('森林 v1.9.2｜據點刷怪｜下輪 '+Math.ceil(remain/1000)+' 秒');
      return true;
    }
    move();return true;
  }
  const btn = document.createElement('button');
  btn.id = 'ro-forest-camp-v19';
  btn.type = 'button';
  btn.style.cssText = 'position:fixed;bottom:44px;left:8px;z-index:2147483647;color:white;padding:5px 8px;border:1px solid white;border-radius:5px;background:#384455;cursor:pointer;max-width:340px';
  document.body.append(btn);

  let timer = null, canvas = null, restore = null;
  let player = null, frame = 0, boxes = [], magnets = [], loot = [], rareLoot = [], orangeLoot=[],purpleLoot=[];
  let arc = null, path = [], pathFill = null;
  let leg = 0, patrolUntil = 0, lastPatrolSkipAt = 0;
  let active = null, bestGap = Infinity, progressAt = 0, detours = 0;
  let detourKey = '', detourUntil = 0;
  let lastCoordText = '', lastMoveAt = 0, lastCanvasPosition = null;
  let blocked = [];
  let lastMagnetPickedAt = -Infinity; // 每場成功拾取磁鐵時間，使用單調時鐘
  let magnetWatch=null, chestLockUntil=0;
  // 磁鐵只使用小地圖可見座標與玩家接近狀態，不假裝擁有官方拾取事件。

  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const near = (a, b, radius) => distance(a, b) <= radius;
  const timeNow = () => performance.now();

  function label(value) { btn.textContent = value; }
  function move(keys = '') {
    for (const key of [...held]) if (!keys.includes(key)) {
      window.dispatchEvent(new KeyboardEvent('keyup', { key, code: 'Key' + key.toUpperCase(), bubbles: true }));
      held.delete(key);
    }
    for (const key of keys) if (!held.has(key)) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), bubbles: true }));
      held.add(key);
    }
  }
  function resetTarget() {
    active = null; bestGap = Infinity; progressAt = 0; detours = 0;
    detourKey = ''; detourUntil = 0;
  }
  function resetMovementWatch(now) {
    lastCoordText = ''; lastCanvasPosition = null; lastMoveAt = now;
  }

  // 只對菱形物品標記的「橘色／紫色」做辨識，不會追所有橘紫色畫面元素。
  function colorRGB(value) {
    if (typeof value !== 'string') return null;
    let s = value.trim().toLowerCase();
    const named = {orange:'#ffa500', darkorange:'#ff8c00', gold:'#ffd700', purple:'#800080',
      violet:'#ee82ee', magenta:'#ff00ff', fuchsia:'#ff00ff', blueviolet:'#8a2be2',
      darkorchid:'#9932cc', mediumpurple:'#9370db', rebeccapurple:'#663399'};
    s = named[s] || s;
    if (s.startsWith('#')) {
      let h = s.slice(1);
      if (/^[0-9a-f]{3,4}$/.test(h)) h = [...h].map(c => c + c).join('');
      if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return null;
      return [0,2,4].map(i => parseInt(h.slice(i, i + 2), 16));
    }
    const rgb = s.match(/^rgba?\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)/);
    if (rgb) return [1,3,5].map(i => Math.max(0,Math.min(255,Number(rgb[i]) * (rgb[i+1] ? 2.55 : 1))));
    return null;
  }
  function rareColor(value) {
    const rgb=colorRGB(value);
    if(!rgb)return null;
    const [r,g,b]=rgb.map(v=>v/255);
    const high=Math.max(r,g,b),low=Math.min(r,g,b),d=high-low;
    if(high<.32||d<.14||d/high<.34)return null;
    let hue=high===r?60*(((g-b)/d)%6):high===g?60*((b-r)/d+2):60*((r-g)/d+4);
    hue=(hue+360)%360;
    return hue>=15&&hue<=52?'orange':hue>=255&&hue<=327?'purple':null;
  }
  const isOrangePurple=value=>!!rareColor(value);
  function pushUnique(points, position) {
    if (!points.some(p => near(p, position, .15))) points.push(position);
  }
  function diamondCenter(points) {
    if (points?.length !== 4) return null;
    const [top,right,bottom,left] = points;
    const width = right[0]-left[0], height = bottom[1]-top[1];
    if (!(width > .1 && height > .1)) return null;
    const tolerance = Math.max(.12, Math.max(width,height)*.08);
    if (Math.abs(top[0]-bottom[0])>tolerance || Math.abs(right[1]-left[1])>tolerance ||
        Math.abs((top[0]+bottom[0]-right[0]-left[0])/2)>tolerance ||
        Math.abs((top[1]+bottom[1]-right[1]-left[1])/2)>tolerance) return null;
    return [(left[0]+right[0])/2, (top[1]+bottom[1])/2];
  }
  function detectDiamond(ctx, color) {
    if (arc) return;
    const center = diamondCenter(path);
    if (!center) return;
    const rarity=rareColor(color)||rareColor(pathFill);
    if(rarity){
      pushUnique(rareLoot,center);
      pushUnique(rarity==='orange'?orangeLoot:purpleLoot,center);
    }else if(color==='#1d2d57')pushUnique(loot,center);
  }
  function watch(map) {
    restore?.();
    canvas = map;
    resetTarget();
    resetCamp();
    blocked = [];  // 新地圖不沿用舊地圖的「暫時無法到達」標記
    resetMovementWatch(timeNow());
    player = null;
    const ctx = map?.getContext('2d');
    if (!ctx) return;
    const saved = {};
    boxes = []; magnets = []; loot = []; rareLoot = [];orangeLoot=[];purpleLoot=[];
    const hook = (name, observer) => {
      if (typeof ctx[name] !== 'function') return;
      saved[name] = ctx[name];
      ctx[name] = function (...args) {
        observer(...args);
        return saved[name].apply(this, args);
      };
    };
    hook('clearRect', () => { boxes=[];magnets=[];loot=[];rareLoot=[];orangeLoot=[];purpleLoot=[];player=null; });
    hook('fillRect', (x,y,w,h) => {
      if (ctx.fillStyle === '#5a3a12' && w>0 && Math.abs(h/w-1.25)<.02)
        pushUnique(boxes, [x+w/2, y+7*w/12]);
    });
    hook('beginPath', () => { arc=null; path=[]; pathFill=null; });
    hook('moveTo', (x,y) => { path=[[x,y]]; });
    hook('lineTo', (x,y) => { if (path?.length<5) path.push([x,y]); });
    hook('arc', (x,y,r,start,end,reverse) => {
      arc = {x,y,r,horseshoe: reverse && Math.abs(start-Math.PI)<.01 && Math.abs(end)<.01};
    });
    hook('fill', () => {
      pathFill = ctx.fillStyle;
      if (!arc && isOrangePurple(ctx.fillStyle)) detectDiamond(ctx, ctx.fillStyle);
    });
    hook('stroke', () => {
      if (arc && (ctx.strokeStyle === '#ff3b4a' ||
        (arc.horseshoe && path?.length === 3 &&
          Math.abs(path[0][0]-(arc.x-arc.r))<.1 && Math.abs(path[2][0]-(arc.x+arc.r))<.1))) {
        pushUnique(magnets, [arc.x,arc.y]);
      }
      detectDiamond(ctx, ctx.strokeStyle);
    });
    // 保留原版 Canvas 座標取得方式；若遊戲小地圖繪圖方式改版，需再實測驗證。
    hook('translate', (x,y) => { player=[x,y]; frame=timeNow(); });
    restore = () => { Object.assign(ctx,saved); restore=null; };
  }
  function funds(id){
    const pieces=document.getElementById(id)?.textContent.match(/\d+/g);
    return pieces?Number(pieces.join('')):NaN;
  }
  function chestBudget(){
    const gold=funds('zeny-text'), cost=funds('chest-cost');
    const known=Number.isFinite(gold)&&gold>=0&&Number.isFinite(cost)&&cost>0;
    return {gold,cost,known,insufficient:known&&gold<cost};
  }
  function updateMovement(now) {
    const text = find('#minimap-coords')?.textContent?.trim() || '';
    if (text) {
      if (text !== lastCoordText) {lastCoordText=text; lastMoveAt=now;}
    } else if (player && (!lastCanvasPosition || distance(player,lastCanvasPosition)>.12)) {
      lastCanvasPosition=[...player]; lastMoveAt=now;
    }
    return !!held.size && now-lastMoveAt>SET.positionStallMs;
  }
  function cleanBlocked(now) { blocked = blocked.filter(item => item.until > now); }
  function isBlocked(kind, position) {
    return blocked.some(item => item.kind===kind && near(item.position, position, SET.blockedRadius));
  }
  function blockTarget(now) {
    if (!active) return;
    blocked.push({kind:active.kind, position:[...active.position], until:now+SET.blockedForMs});
    if(active.kind==='magnet') magnetWatch=null; // 失敗或卡點不扣60秒冷卻
    label('暫跳卡住的' + active.display + '（30秒後再試）');
    move(); resetTarget();
    resetMovementWatch(now);
  }
  function closest(kind, positions, allMap=false) {
    const available = positions.filter(p => !isBlocked(kind,p) &&
      (allMap || !camp.home || distance(p,camp.home)<=CAMP.gatherRadius));
    return available.reduce((best,p) => !best || distance(p,player)<distance(best,player) ? p : best, null);
  }
  function targetStillVisible(kind,pos){
    const list=kind==='magnet'?magnets:kind==='orange'?orangeLoot:
      kind==='purple'?purpleLoot:kind==='chest'?boxes:loot;
    return list.some(p=>near(p,pos,SET.sameTargetRadius));
  }
  function observeMagnetPickup(now){
    // HANS 無公開拾取事件：必須「曾接近」且「磁鐵圖示持續消失」才暫判成功。
    if(!magnetWatch)return;
    const seen=magnets.some(p=>near(p,magnetWatch.position,SET.sameTargetRadius));
    if(seen){magnetWatch.missingAt=0;return;}
    if(!magnetWatch.missingAt)magnetWatch.missingAt=now;
    if(now-magnetWatch.missingAt<CAMP.magnetMissingConfirmMs)return;
    const position=homePosition();
    const nearEnough=magnetWatch.minGap<=CAMP.magnetPickupRadius &&
      position && distance(position,magnetWatch.position)<=CAMP.magnetPickupRadius+0.8;
    if(nearEnough){
      lastMagnetPickedAt=now;
      camp.magnetSecuredThisCycle=true;camp.magnetPriorityComplete=true;
      if(clock.phase==='postboss'){
        clock.postMagnetFinished=true;
        clock.postRefreshUntil=now+300;
      }
      if(active?.kind==='magnet'){move();resetTarget();}
      label('森林 v1.9.2｜磁鐵已近距離消失，暫判成功｜冷卻60秒');
    }else{
      // 不確定不扣額度；短暫封鎖，避免反覆追同一個消失座標。
      blocked.push({kind:'magnet',position:[...magnetWatch.position],until:now+3500});
      if(active?.kind==='magnet'){move();resetTarget();}
      label('森林 v1.9.2｜磁鐵消失但未確認拾取，不計數');
    }
    magnetWatch=null;
  }
  function chooseTarget(now, finalLoot=false) {
    if(finalLoot){
      if(magnetCanChase(now,true)){
        const mag=closest('magnet',magnets,true);
        if(mag)return {kind:'magnet',display:'戰後磁鐵',position:mag};
      }
      const orange=closest('orange',orangeLoot,true);
      if(orange)return {kind:'orange',display:'戰後橘裝',position:orange};
      const purple=closest('purple',purpleLoot,true);
      if(purple)return {kind:'purple',display:'戰後紫裝',position:purple};
      const budget=chestBudget();
      const chest=budget.known&&!budget.insufficient?closest('chest',boxes,true):null;
      if(chest)return {kind:'chest',display:'戰後寶箱',position:chest};
      return null;
    }
    if(magnetCanChase(now)){
      const magnet=closest('magnet',magnets);
      if(magnet)return {kind:'magnet',display:'優先磁鐵',position:magnet};
      // 只在前25秒搜尋磁鐵；找不到才轉撿裝備、開寶箱。
      return null;
    }
    const orange=closest('orange',orangeLoot);
    if(orange)return {kind:'orange',display:'橘裝',position:orange};
    const purple=closest('purple',purpleLoot);
    if(purple)return {kind:'purple',display:'紫裝',position:purple};
    const budget=chestBudget();
    const chest=budget.known&&!budget.insufficient?closest('chest',boxes):null;
    if(chest)return {kind:'chest',display:'寶箱',position:chest};
    return null;
  }
  function targetKeys(position) {
    const dx=position[0]-player[0],dy=position[1]-player[1];
    const margin=.35*Math.max(Math.abs(dx),Math.abs(dy));
    return (Math.abs(dx)>margin ? dx>0?'d':'a' : '') +
      (Math.abs(dy)>margin ? dy>0?'s':'w' : '');
  }
  function beginDetour(now) {
    if (!active) return;
    if (detours >= SET.maxDetours) { blockTarget(now); return; }
    const dx=active.position[0]-player[0],dy=active.position[1]-player[1];
    const sides = Math.abs(dx)>=Math.abs(dy) ? ['w','s'] : ['d','a'];
    detourKey=sides[detours%2];
    detourUntil=now+Math.min(1800,800+350*detours);
    detours++;
    bestGap=Infinity; progressAt=detourUntil;
    lastMoveAt=detourUntil;
    label('繞路' + detours + '/' + SET.maxDetours + ' → ' + active.display);
    move(detourKey);
  }
  function patrol(now, isStuck) {
    if (!patrolUntil) {leg=0;patrolUntil=now+SET.patrolLegMs;}
    if (now>=patrolUntil) {
      leg=(leg+1)%route.length;
      patrolUntil=now+SET.patrolLegMs;
    }
    // 即使巡走碰到障礙，也不切換成全圖探索；只跳到下一段來回路線。
    if (isStuck && now-lastPatrolSkipAt>SET.patrolStallMs) {
      leg=(leg+1)%route.length;
      patrolUntil=now+SET.patrolLegMs;
      lastPatrolSkipAt=now; lastMoveAt=now;
    }
    label(blocked.length ? '森林 v1.9.2｜定時採集中・巡走（暫跳'+blocked.length+'件）' : '森林 v1.9.2｜定時採集中・附近巡走');
    move(route[leg]);
  }

  function tick() {
    const now=timeNow();
    const map=find('#minimap canvas');
    if(map!==canvas)watch(map);
    if(handleRoundTransition(now,!!map?.getClientRects().length))return;
    if(document.getElementById('ro-forest-camp-v18')){
      move();label('森林 v1.9.2｜偵測到舊版 v1.8！請先停用舊腳本');return;
    }
    if(!map?.getClientRects().length || !player || now-frame>900 ||
       find('#picker:not(.hidden), #drop-reveal:not(.hidden)') ||
       document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')){
      move();resetMovementWatch(now);
      label('森林 v1.9.2｜等待地圖或選卡／掉寶視窗關閉');return;
    }
    updateClock(now);
    // 磁鐵原本就在追逐，但到13:00必須立即取消、不扣冷卻。
    if(magnetReserved() && active?.kind==='magnet'){
      move();resetTarget();
      if(magnetWatch?.minGap>CAMP.magnetPickupRadius)magnetWatch=null;
    }
    observeMagnetPickup(now);
    const finalLootMode=clock.phase==='postboss';
    if(finalLootMode){
      if(clock.postBossExpired||now>=clock.postBossEndAt){
        move();label('森林 v1.9.2｜戰後拾取結束，等待結算');return;
      }
      if(camp.mode!=='final-loot'){
        camp.mode='final-loot';move();resetTarget();blocked=[];
        clock.postMagnetDeadline=now+CAMP.bossMagnetMaxMs;
        clock.postMagnetFinished=!magnetReady(now);
      }
      if(now>=clock.postMagnetDeadline){
        clock.postMagnetFinished=true;
        if(active?.kind==='magnet'){
          move();resetTarget();magnetWatch=null;
          label('森林 v1.9.2｜戰後追磁鐵已滿5秒，改撿裝備');
        }
      }
      if(clock.postRefreshUntil>now){move();return;}
    }else{
      if(clock.source==='遊戲計時無法確認'){
        move();label('森林 v1.9.2｜等待遊戲時間同步');return;
      }
      if(controlCamp(now))return;
    }
    if(magnetWatch?.missingAt && now-magnetWatch.missingAt<CAMP.magnetMissingConfirmMs){
      move();label('森林 v1.9.2｜正在確認磁鐵拾取');return;
    }
    let stuck=updateMovement(now);
    cleanBlocked(now);
    let candidate=chooseTarget(now,finalLootMode);
    // 快到寶箱時短暫保持原目標；超過2秒未完成照常放棄。
    if(active?.kind==='chest' && targetStillVisible('chest',active.position)){
      const d=distance(player,active.position);
      if(d<=CAMP.chestNearRadius && !chestLockUntil)chestLockUntil=now+CAMP.chestFinishMaxMs;
      if(chestLockUntil>now && d<=CAMP.chestNearRadius){
        candidate={...active};
      }
    }else chestLockUntil=0;
    const same=active&&candidate&&active.kind===candidate.kind &&
      near(active.position,candidate.position,SET.sameTargetRadius);
    if(candidate&&!same){
      resetTarget();chestLockUntil=0;
      active={kind:candidate.kind,display:candidate.display,position:[...candidate.position]};
      bestGap=distance(active.position,player);progressAt=now;
      resetMovementWatch(now);stuck=false;
    }else if(!candidate&&active){
      resetTarget();chestLockUntil=0;resetMovementWatch(now);
    }else if(same)active.position=[...candidate.position];
    if(!active){
      if(finalLootMode){move();label('森林 v1.9.2｜戰後監看橘／紫裝與寶箱');return;}
      patrol(now,stuck);
      if(magnetCanChase(now))label('森林 v1.9.2｜尋磁鐵中（最多25秒）');
      return;
    }
    camp.lastIdleAt=now;
    patrolUntil=0;
    const gap=distance(active.position,player);
    if(active.kind==='magnet'){
      if(!magnetWatch||!near(magnetWatch.position,active.position,SET.sameTargetRadius)){
        magnetWatch={position:[...active.position],minGap:gap,missingAt:0};
      }else magnetWatch.minGap=Math.min(magnetWatch.minGap,gap);
    }
    if(now<detourUntil){move(detourKey);return;}
    if(detourUntil>0){detourUntil=0;bestGap=gap;progressAt=now;resetMovementWatch(now);}
    if(gap+SET.progressDelta<bestGap){bestGap=gap;progressAt=now;}
    // 戰後橘裝：不是3秒硬上限，只有連續3秒未接近才封鎖。
    if(finalLootMode&&active.kind==='orange'){
      if(now-progressAt>=CAMP.bossOrangeStallMs){
        blockTarget(now);label('森林 v1.9.2｜橘裝3秒無進展，改找其他橘裝／紫裝');return;
      }
    }else if(stuck||now-progressAt>SET.targetStallMs){
      if(finalLootMode&&detours>=1)blockTarget(now);
      else beginDetour(now);
      return;
    }
    label('森林 v1.9.2｜'+(finalLootMode?'戰後：':'採集：')+active.display+
      (active.kind==='magnet'&&finalLootMode?'｜磁鐵總限5秒':'')+
      '（繞路'+detours+'/'+SET.maxDetours+'）');
    move(gap>.05?targetKeys(active.position):'');
  }

  function visibleAction(re){
    for(const el of document.querySelectorAll('button,[role="button"]')){
      if(!el.getClientRects().length)continue;
      const text=(el.textContent||'').trim().replace(/\s+/g,'');
      if(re.test(text))return true;
    }
    return false;
  }
  function outsideRunReason(){
    if(visibleAction(/^(返回[角腳]色|回到角色|返回人物)$/))return '結算';
    if(visibleAction(/^(與隊長交談|與隊長對話|與隊長談話|和隊長交談)$/))return '主城';
    if(visibleAction(/^(前往野外|出發)$/))return '選關／難度';
    return '';
  }
  function handleRoundTransition(now,mapVisible){
    const reason=outsideRunReason();
    if(reason){
      if(!roundState.outside){
        roundState.outside=true;roundState.lastExit=reason;resetRound(now);
      }
      move();label('森林 v1.9.2｜等待下一場：'+reason);return true;
    }
    if(roundState.outside){
      const secs=mapVisible?readGameHudClock():null;
      if(!mapVisible||secs===null||secs>90){
        move();label('森林 v1.9.2｜等待新副本載入');return true;
      }
      roundState.outside=false;resetRound(now);
      clock.prevRaw=secs;clock.elapsedMs=secs*1000;clock.source='遊戲正計時';
    }
    // 若戰後倒數直接跳到下一場正計時，而沒有顯示主城按鈕，也要重設。
    if(clock.phase==='postboss'&&mapVisible){
      const secs=readGameHudClock();
      if(secs!==null&&secs>16&&secs<=90&&
         !bossTitleVisible()&&clock.postBossExpired){resetRound(now);}
    }
    return false;
  }
  function enable(on, {remember=true}={}) {
    if(remember)rememberEnabled(on);
    clearInterval(timer); timer=null;move();resetTarget();resetCamp();
    patrolUntil=0;leg=0;blocked=[];resetMovementWatch(timeNow());
    clock.firstSeenAt=0;clock.lastReadAt=0;clock.prevRaw=null;
    clock.bossCountdown=false;clock.elapsedMs=0;
    clock.lastGameSeenAt=0;clock.source='等待遊戲畫面';
    clock.phase='normal';clock.bossWasVisible=false;clock.bossConfirmed=false;
    clock.bossLastSeenAt=0;clock.lastTimeBeforeBoss=0;
    clock.postBossStartedAt=0;clock.postBossEndAt=0;clock.postBossExpired=false;
    clock.postMagnetDeadline=0;clock.postMagnetFinished=false;clock.postRefreshUntil=0;
    roundState.outside=false;roundState.lastExit='';
    if(on){
      const now=timeNow();
      lastMagnetPickedAt=-Infinity;magnetWatch=null;chestLockUntil=0;
      timer=setInterval(tick,SET.interval);
      btn.style.background='#186442';label('森林 v1.9.2｜開｜每60秒採35秒｜磁鐵限1個');
    }else{
      restore?.();canvas=null;
      btn.style.background='#384455';label('森林 v1.9.2｜關');
    }
  }
  btn.onclick=()=>enable(!timer);
  window.addEventListener('blur',()=>move());
  window.addEventListener('pagehide',()=>{
    // 保留用戶開關設定；重新進場即使整頁載入也能恢復。
    move();clearInterval(timer);timer=null;restore?.();canvas=null;
  });
  btn.title='Shift + 4 切換採集開關';
  btn.setAttribute('aria-keyshortcuts','Shift+4');
  window.addEventListener('keydown', event => {
    if (event.code!=='Digit4'||!event.shiftKey||event.altKey||event.ctrlKey||
        event.metaKey||event.isComposing) return;
    const editing=event.composedPath().some(el=>el?.isContentEditable ||
      el?.matches?.('input,textarea,select,[role="textbox"]'));
    if (editing) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (!event.repeat) btn.click();
  },true);
  enable(wasEnabled(),{remember:false});
})();