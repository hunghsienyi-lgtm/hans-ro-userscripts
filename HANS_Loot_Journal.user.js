// ==UserScript==
// @name         HANS RO 選關＋戰利品｜每場結束統一匯報
// @namespace    ro-local-loot-journal
// @version      0.9.7
// @description  v0.9.7：新增六周目完整選關及分頁辨識，依實際畫面採用無改版後綴的地圖名稱，掃描完整關卡並驗證解鎖狀態。
// @match        *://ro.hans-webgametw.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      discord.com
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Loot_Journal.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Loot_Journal.user.js
// ==/UserScript==
(() => {
  'use strict';
  // 此公開腳本不包含私人 Webhook；Webhook 僅保存在使用者本機，請勿公開分享設定值。
  const WEBHOOK_KEY = 'hans_ro_discord_webhook_private';
  const readWebhook = () => String(GM_getValue(WEBHOOK_KEY, '') || '').trim();
  const DATA_KEY = 'ro-loot-journal-v02'; // 沿用 v0.3 的資料，避免升級時遺失。
  const OLD_KEY = 'ro-loot-journal-v01';
  const SETTINGS_KEY = 'ro-loot-journal-v04-settings';
  const OUTBOX_KEY = 'ro-loot-journal-discord-v05-outbox'; // 不繼承 v0.4 尚未寄出的逐件推播。
  const RUN_KEY = 'ro-loot-journal-v05-current-run';
  const HISTORY_KEY = 'hans-stage-loot-run-history-v06';
  const DIFFICULTY_KEY = 'hans-stage-loot-pending-difficulty-v06';
  const RESULT_MIN_MS = 5200, RESULT_STABLE_MS = 1800, RESULT_MAX_MS = 15500;
  const UI_ID = 'ro-loot-journal-v05-ui';
  const VERSION = '0.9.6';
  const norm = x => String(x ?? '').normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g,'').replace(/\u00a0/g,' ').replace(/[\t ]+/g,' ').trim();
  const label = el => norm(el?.innerText || el?.textContent || '');
  const jsonRead = (key, def) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? def; } catch { return def; } };
  const saveJSON = (key, x) => { try { localStorage.setItem(key,JSON.stringify(x));return true; } catch (e) { status('本機儲存失敗，請立即匯出 JSON');return false; } };
  const visible = el => {
    if (!(el instanceof Element) || !el.isConnected || !el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.display!=='none' && st.visibility!=='hidden' && Number(st.opacity)>0 && !el.closest('[hidden],[aria-hidden="true"]');
  };
  let records = jsonRead(DATA_KEY,[]);
  if (!Array.isArray(records)) records=[];
  if (!records.length) {
    const old=jsonRead(OLD_KEY,[]);
    if(Array.isArray(old)&&old.length) records=old.map(x=>({
      time:x.time||new Date().toISOString(),localTime:'',type:'裝備',name:x.name||'舊紀錄待核對',
      rarity:x.rarity||'',tier:x.tier||null,baseStats:[],attributes:Array.isArray(x.attributes)?x.attributes:[],
      rawText:x.rawText||'',origin:'v0.1歷史匯入（待核對）'
    }));
  }
  let settings = {...{running:true,notify:true},...jsonRead(SETTINGS_KEY,{})};
  let outbox=jsonRead(OUTBOX_KEY,[]);
  if (!Array.isArray(outbox)) outbox=[];
  // 升級前可能仍留有尚未發送的「金色逐件通知」。
  // 只移除這一類待送通知；保留已排隊的每場總表及使用者手動測試訊息。
  const previousOutboxLength=outbox.length;
  outbox=outbox.filter(entry=>!/^金色[｜|]/.test(String(entry?.name||'')));
  if(outbox.length!==previousOutboxLength)
    saveJSON(OUTBOX_KEY,outbox);
  let currentRun=jsonRead(RUN_KEY,null);
  if (!currentRun || typeof currentRun!=='object' || !currentRun.id || !['active','settled'].includes(currentRun.phase)) currentRun=null;
  let resultSeenAt=0, resultStableSince=0, resultFingerprint='';
  let runHistory=jsonRead(HISTORY_KEY,[]);
  if(!Array.isArray(runHistory))runHistory=[];
  let pendingDifficulty=jsonRead(DIFFICULTY_KEY,null);
  let lastSummaryText='';
  let sending=false, nextAllowedAt=0, lastStatus='等待掉寶', lastDiagnostic='尚未掃描',lastPopupText='',lastRecord=null;
  let popupWasVisible=false, previousPopupRoot=null, episodeSeen=new Set(), lastCaptureKey='';
  let summaryWasVisible=false, summarySeen=new Set(), summaryDropSeen=new Set(), scanQueued=false, userInitiatedTest=false;
  let ui, countEl, stateEl, recentEl, discordEl, menuEl;

  const rarityWords = '(?:優良|精良|優秀|高級|普通|稀有|史詩|傳說|神話|uncommon|common|rare|epic|legendary|mythic|fine|good)';
  const qualityRe=new RegExp(rarityWords,'i');
  const tierRe=/\bTIER\s*[:：]?\s*(\d+)\b|(?:階級|階層)\s*[:：]?\s*(\d+)/i;
  const cardRe=/(?:\bcard\b|卡片|卡牌|卡(?!普拉))/i;
  const getRe=/^(?:取得|領取|獲得|Get|Collect|Claim|Pick\s*up)$/i;
  const baseStatRe=/^(?:DEF|MDEF|ATK|MATK|HP|SP|防禦|魔防|攻擊力|魔攻)\s*[:：]?\s*[+\-−]?\d/i;
  const statRe=/^(?:(?:[★⭐✦✧]\s*)?[+\-−]\s*\d+(?:[.,]\d+)?\s*%?\s*\S+|(?:STR|AGI|VIT|INT|DEX|LUK|DEF|MDEF|ATK|MATK|HP|SP)\s*[:：]?\s*[+\-−]?\d+)/i;
  const unknownStatRe=/(?:未鑑定|尚未鑑定|未知屬性|未定的屬性|unidentified|unknown\s+attribute)/i;
  const noise=/^(?:道具|掉落|寶箱|戰利品|裝備|卡片|獲得的卡片|稀有|普通|傳說|優良|史詩|神話|取得|領取|獲得|Get|Claim|Collect|繼續|取消|關閉|確定|回到角色|返回角色|Damage|Lv\.?\s*\d+|TIER\s*\d+)$/i;
  const nowISO=()=>new Date().toISOString();
  function typeName(r){return r.type||'裝備';}
  function status(s){lastStatus=s;if(stateEl)stateEl.textContent=s;}
  function recordCount(t){return records.filter(r=>typeName(r)===t).length;}
  function runRecords(){return currentRun ? records.filter(r=>r.runId===currentRun.id):[];}
  function isGold(rec){return rec?.rarity==='傳說';} // 截圖中金色品質=「傳說」；其他稀有度只進總表。
  function saveRun(){saveJSON(RUN_KEY,currentRun);}
  function beginRun(reason){
    currentRun={id:`run-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      startedAt:nowISO(),phase:'active',summaryQueued:false,reason,
      difficulty:pendingDifficulty&&typeof pendingDifficulty==='object'?{...pendingDifficulty}:null};
    resultSeenAt=0;resultStableSince=0;resultFingerprint='';saveRun();updateUI();return currentRun;
  }
  function ensureRun(){
    if(!currentRun || currentRun.phase==='settled')return beginRun('首次取得／下一局');
    return currentRun;
  }
  function updateUI(){
    if(countEl)countEl.textContent=`共 ${records.length}｜本場 ${runRecords().length}｜精簡 ${runRecords().filter(r=>/精簡掉落提示/.test(r.origin||'')).length}`;
    if(recentEl)recentEl.textContent=`最近：${lastRecord?`${lastRecord.name}（${typeName(lastRecord)}）`:'尚無'}`;
    if(discordEl)discordEl.textContent=`Discord：${settings.notify?'開':'關'}｜僅每場結束總表｜待送 ${outbox.length}${sending?'（發送中）':''}`;
    if(stateEl)stateEl.textContent=lastStatus;
  }
  function linesFrom(root){
    const raw=String(root?.innerText||'').replace(/\r/g,'\n').split(/\n+/).map(norm).filter(Boolean);
    const leaves=[];
    if(root){
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let node;
      while((node=walker.nextNode()) && leaves.length<220){
        if(!node.parentElement||!visible(node.parentElement)||node.parentElement.closest(`#${UI_ID},script,style,textarea`))continue;
        const s=norm(node.nodeValue);if(s&&s.length<=200)leaves.push(s);
      }
    }
    return [...new Set([...raw,...leaves])].slice(0,180);
  }
  function findItemName(root,arr,qIndex){
    const namedSelectors=['.dr-name','.dr-item-name','.dr-title','.loot-name','.item-name','.reward-name','.dr-result h1','.dr-result h2','.dr-result h3','h1','h2','h3'];
    for(const sel of namedSelectors){for(const el of root.querySelectorAll(sel)){
      if(!visible(el))continue;const s=label(el);
      if(s && s.length>=3 && s.length<125&&!noise.test(s)&&!tierRe.test(s)&&!qualityRe.test(s)&&!statRe.test(s))return s;
    }}
    const before=arr.slice(0,qIndex>=0?qIndex:arr.length).filter(s=>s.length>=3&&s.length<110&&!noise.test(s)&&!tierRe.test(s)&&!qualityRe.test(s)&&!baseStatRe.test(s)&&!statRe.test(s)&&!unknownStatRe.test(s)&&!/^\d+(?:[.:/]\d+|%|\s*[zZ])/.test(s));
    return before.at(-1)||'';
  }
  function classify(name,lines,root){
    const more=norm(name+' '+lines.slice(0,7).join(' '));
    if(cardRe.test(name)||(/(?:卡片|Card)/i.test(more)&&!tierRe.test(more))) return '卡片';
    if(tierRe.test(more)||lines.some(s=>baseStatRe.test(s)))return '裝備';
    const cls=(root.className||'').toString();
    if(/card/.test(cls)&&!tierRe.test(more))return '卡片';
    return '其他';
  }
  function parsePopup(root){
    const arr=linesFrom(root),qi=arr.findIndex(s=>tierRe.test(s)&&qualityRe.test(s));
    const qLine=qi>=0?arr[qi]:'';
    const rawAll=arr.join(' | ').slice(0,3500);
    const getButton=[...root.querySelectorAll('button,[role="button"]')].some(el=>visible(el)&&getRe.test(label(el)));
    if(!getButton && !root.querySelector('.dr-result'))return {error:'掉寶尚未顯示完整',data:null};
    let name=findItemName(root,arr,qi);
    // 沒有 TIER 的卡片，名稱通常是 Get 按鈕前面的唯一英文/中文名。
    if(qi<0){
      const candidates=arr.filter(s=>s.length>=3&&s.length<=115&&!noise.test(s)&&!tierRe.test(s)&&!baseStatRe.test(s)&&!statRe.test(s)&&!unknownStatRe.test(s)&&!/^\d+(?:[.:/]\d+|%)/.test(s));
      const matched=candidates.find(x=>/(?:\bCard\b|卡片)/i.test(x));
      name=matched||name||candidates[0]||'';
    }
    if(!name || /^(?:你存活下來了|寶箱|掉落|Reward|Item)$/i.test(name))return {error:'找不到掉落物名稱',data:null};
    const after=qi>=0?arr.slice(qi+1):arr.slice(Math.max(0,arr.indexOf(name)+1));
    const attrs=[];
    for(const s0 of after){
      const s=norm(s0.replace(/^[•●▪‣·]\s*/,''));
      if(getRe.test(s))break;
      if(s.length>160)continue;
      if(baseStatRe.test(s)||statRe.test(s)||unknownStatRe.test(s)||/^(?:效果|Effect|Slot|插卡|賦予|屬性)/i.test(s)){
        if(!attrs.includes(s))attrs.push(s);
      }
    }
    const qualityLine=qLine||arr.find(s=>qualityRe.test(s)&&s.length<90)||'';
    const quality=/傳說|legendary/i.test(qualityLine)?'傳說':/神話|mythic/i.test(qualityLine)?'神話':
      /史詩|epic/i.test(qualityLine)?'史詩':/稀有|\brare\b/i.test(qualityLine)?'稀有':
      /優良|精良|優秀|高級|uncommon|fine|good/i.test(qualityLine)?'優良':
      /普通|common/i.test(qualityLine)?'普通':'';
    const mt=qLine.match(tierRe),tier=mt?Number(mt[1]||mt[2]):null;
    const type=classify(name,arr,root);
    if(type==='其他'&&qi<0&&!getButton)return {error:'不是確定的掉寶彈窗',data:null};
    const baseStats=attrs.filter(s=>baseStatRe.test(s));
    const attributes=attrs.filter(s=>!baseStats.includes(s));
    return {error:'',data:{type,name,rarity:quality,tier,baseStats,attributes,rawText:rawAll,origin:'掉落彈窗'}};
  }
  function popupRoot(){
    const main=document.querySelector('#drop-reveal');
    if(main && visible(main)){
      const res=main.querySelector('.dr-result');
      const hasGet=[...main.querySelectorAll('button,[role="button"]')].some(b=>visible(b)&&getRe.test(label(b)));
      if((res && visible(res))||hasGet)return main;
    }
    for(const c of document.querySelectorAll('.loot-reveal,.drop-result,[role="dialog"]')){
      if(!visible(c))continue;
      if([...c.querySelectorAll('button,[role="button"]')].some(b=>visible(b)&&getRe.test(label(b))))return c;
    }
    for(const btn of document.querySelectorAll('button,[role="button"]')){
      if(!visible(btn)||!getRe.test(label(btn)))continue;
      for(let n=btn.parentElement,i=0;n&&n!==document.body&&i<8;i++,n=n.parentElement){
        if(n.closest(`#${UI_ID}`))break;
        if(tierRe.test(label(n))||cardRe.test(label(n)))return n;
      }
    }
    return null;
  }
  const signature=x=>JSON.stringify([x.type,x.name,x.rarity,x.tier,x.baseStats,x.attributes]);
  function addRecord(raw){
    if(currentRun?.phase==='settled' && resultVisible())return null; // 結算封存後不再補出跨局紀錄。
    const run=ensureRun(),d=new Date();
    const rec={id:`${d.getTime()}-${Math.random().toString(36).slice(2,10)}`,
      time:d.toISOString(),localTime:d.toLocaleString('zh-TW',{hour12:false}),runId:run.id,...raw};
    records.push(rec);lastRecord=rec;
    if(!saveJSON(DATA_KEY,records))status('記錄暫存在記憶體；請匯出備份');
    else status(`已記錄 ${rec.type}：${rec.name}`);
    // 全部品質（含傳說金色）只寫入本機清單；不在掉落當下發 Discord。
    // 正常通關、死亡結算或三分鐘主動捨棄時由 finishRun／settleShortRun 統一報告。
    updateUI();return rec;
  }
  function scanPopup(tag='畫面掃描'){
    if(!settings.running)return;
    const root=popupRoot();
    if(!root){
      popupWasVisible=false;previousPopupRoot=null;episodeSeen.clear();lastCaptureKey='';
      lastDiagnostic=`${tag}：未找到可見的掉寶詳情視窗`;
      return;
    }
    if(!popupWasVisible||root!==previousPopupRoot){episodeSeen.clear();previousPopupRoot=root;popupWasVisible=true;}
    const {data,error}=parsePopup(root);
    lastPopupText=linesFrom(root).join('\n').slice(0,3000);
    lastDiagnostic=`${tag}：${error||`${data.type}解析成功`}，文字行數 ${linesFrom(root).length}，有取得按鈕`;
    if(!data){return;}
    const key=signature(data);
    if(episodeSeen.has(key))return;
    episodeSeen.add(key);lastCaptureKey=key;
    addRecord(data);
  }

  // 專門偵測小地圖下的精簡掉落提示，避免完整掉寶彈窗不存在而漏記。
  // 這裡只讀取瀏覽器 DOM 中真正出現的文字；如果是純 Canvas 繪圖則無法直接讀取。
  const compactState={seen:new WeakMap(),recent:new Map(),count:0,lastText:'',lastAt:0};
  const compactQuality=/^(?:[✦★⭐◆]?\s*)?(?:(?:拾取|撿到|撿起|獲得|取得|掉落)\s*[:：]?\s*)?(傳說|神話|史詩|稀有|優良|精良|優秀|高級|普通)\s*(?:裝備\s*)?[:：\s·|•\-—]*(.+)$/i;
  function parseCompactToast(text){
    const raw=norm(String(text||'').replace(/[\r\n\t]+/g,' '));
    if(raw.length<4||raw.length>120)return null;
    const m=raw.match(compactQuality);
    if(!m)return null;
    let name=norm(m[2].replace(/^[✓✔⭐★◆🗡️⚔️🛡️🎁📦\s:：·|•\-—]+/u,''));
    name=name.replace(/\s*(?:已獲得|已取得|獲得成功)\s*$/,'').trim();
    if(name.length<2||name.length>72||noise.test(name)||/^(?:裝備|道具|掉落|卡片|TIER\s*\d+|\d+[\d+\-%.]*)$/i.test(name))return null;
    if(/(?:掉寶|裝備)\s*[×x]\s*\d/.test(name)||/^(?:設定|顯示|精簡|完整)/.test(name))return null;
    const rarity=/優良|精良|優秀|高級/i.test(m[1])?'優良':m[1];
    return {type:cardRe.test(name)?'卡片':'裝備',name,rarity,tier:null,
      baseStats:[],attributes:[],rawText:'精簡掉落提示：'+raw,origin:'精簡掉落提示'};
  }
  function compactNearMinimap(el){
    if(!(el instanceof Element)||!el.isConnected||!el.getClientRects().length)return false;
    if(el.closest('#'+UI_ID+',#hh-payon-integrated-v06,#minimap,script,style,noscript'))return false;
    const mini=document.querySelector('#minimap');
    if(!mini||!mini.getClientRects().length)return false;
    const mr=mini.getBoundingClientRect(),r=el.getBoundingClientRect();
    if(mr.width<60||mr.height<60||r.width<24||r.width>420||r.height<12||r.height>105)return false;
    const mid=r.left+r.width/2;
    return r.top>=mr.bottom-32&&r.top<=mr.bottom+175 &&
      mid>=mr.left-80&&mid<=mr.right+145;
  }
  function captureCompactCandidate(node){
    if(!settings.running)return false;
    let el=node?.nodeType===3?node.parentElement:node;
    if(!(el instanceof Element))return false;
    for(let depth=0;el&&depth<6;el=el.parentElement,depth++){
      if(!compactNearMinimap(el))continue;
      const text=String(el.innerText||el.textContent||'');
      const parsed=parseCompactToast(text);
      if(!parsed)continue;
      const sig=[parsed.type,parsed.rarity,parsed.name].join('|');
      if(compactState.seen.get(el)===sig)return false;
      const now=Date.now();
      compactState.seen.set(el,sig);
      const last=compactState.recent.get(sig)||0;
      if(now-last<450)return false;
      compactState.recent.set(sig,now);
      if(compactState.recent.size>120)
        for(const [key,t] of compactState.recent)if(now-t>20000)compactState.recent.delete(key);
      const rec=addRecord(parsed);
      compactState.lastText=norm(text).slice(0,150);
      compactState.lastAt=now;
      if(rec){compactState.count++;lastDiagnostic='精簡掉落即時讀取：'+parsed.rarity+' '+parsed.name;}
      return !!rec;
    }
    return false;
  }
  function captureCompactMutations(changes){
    if(!settings.running)return;
    const visited=new Set();
    for(const ch of changes){
      for(const node of [ch.target,...ch.addedNodes]){
        const el=node?.nodeType===3?node.parentElement:node;
        if(!(el instanceof Element)||visited.has(el))continue;
        visited.add(el);captureCompactCandidate(el);
      }
      const target=ch.target?.nodeType===3?ch.target.parentElement:ch.target;
      if(target instanceof Element&&compactState.seen.has(target)){
        if(!parseCompactToast(String(target.innerText||target.textContent||''))||!visible(target))
          compactState.seen.delete(target);
      }
      for(const node of ch.removedNodes||[])
        if(node instanceof Element)compactState.seen.delete(node);
    }
  }

  // 精簡掉落可能沒有彈窗；結算縮圖記錄「看得到的數量」，無文字時不臆測品質或名稱。
  // 取最小包含合理數量圖片的區塊，避免將整頁商店／人物畫像一起計算。
  function resultSection(headingRe){
    const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p')].filter(el=>
      visible(el)&&el.childElementCount===0&&headingRe.test(label(el)));
    const heading=headings[0];
    if(!heading)return {found:false,icons:[],names:[],qualities:[]};
    for(let box=heading.parentElement,depth=0;box&&depth<5;box=box.parentElement,depth++){
      let icons=[...box.querySelectorAll('img')].filter(el=>visible(el)&&!el.closest('#'+UI_ID));
      if(!icons.length){
        // 有些 HANS 圖示以 background-image 而非 img 呈現。
        icons=[...box.querySelectorAll('[style*="background-image"],[data-item-id],[data-card-id]')]
          .filter(el=>visible(el)&&!el.closest('#'+UI_ID));
      }
      if(icons.length>0&&icons.length<=50){
        return {found:true,
          icons:icons.map(el=>el.getAttribute('src')||el.getAttribute('style')||el.getAttribute('data-item-id')||el.outerHTML.slice(0,120)),
          names:icons.map(el=>norm(el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('aria-label')||el.closest('[title]')?.getAttribute('title')||
            el.dataset?.itemName||el.dataset?.cardName||el.closest('[data-item-name]')?.getAttribute('data-item-name')||'')),
          qualities:icons.map(el=>norm(el.getAttribute('data-rarity')||el.closest('[data-rarity]')?.getAttribute('data-rarity')||''))};
      }
    }
    return {found:true,icons:[],names:[],qualities:[]};
  }
  function scanSummaryDrops(){
    if(!settings.running||!resultVisible())return;
    const section=resultSection(/^(?:獲得的掉落|獲得的戰利品|Obtained drops|Obtained loot)$/i);
    if(!section.found)return;
    if(!summaryDropSeen)summaryDropSeen=new Set();
    for(let i=0;i<section.icons.length;i++){
      const name=section.names[i];
      if(!name||/^(?:icon|item|loot|reward|img|sprite|圖示|掉落|裝備)$/i.test(name))continue;
      // 圖片上有「明確名稱」才記為獨立戰利品；避免把未知圖示記成假金裝。
      const uniq=`${i}:${section.icons[i]}:${name}`;
      if(summaryDropSeen.has(uniq))continue;
      summaryDropSeen.add(uniq);
      const previous=runRecords().filter(x=>x.name===name&&/掉落彈窗|精簡掉落提示/.test(x.origin||'')).length;
      const nowInSummary=[...summaryDropSeen].filter(x=>x.endsWith(':'+name)).length;
      if(nowInSummary<=previous)continue;
      const rawQuality=section.qualities[i]||'';
      const rarity=/傳說|legendary/i.test(rawQuality)?'傳說':/史詩|epic/i.test(rawQuality)?'史詩':
        /稀有|rare/i.test(rawQuality)?'稀有':'';
      addRecord({type:'其他',name,rarity,tier:null,baseStats:[],attributes:[],
        rawText:`結算掉落縮圖 ${i+1}：${name}；品質 ${rawQuality||'未顯示'}`,
        origin:'結算掉落縮圖（具名稱但種類未確認）'});
    }
  }
  function extractRunStats(){
    if(!resultVisible())return {};
    const text=norm(String(document.body?.innerText||'').slice(0,12000));
    const number=re=>{const m=text.match(re);return m?Number(m[1].replace(/,/g,'')):null;};
    return {
      duration:(text.match(/(?:時間|存活時間)\s*(\d{1,2}:\d{2})/)||[])[1]||null,
      level:number(/本局等級\s*(\d+)/),kills:number(/怪物\s*([\d,]+)/),
      bosses:number(/頭目\s*(\d+)/),baseExp:number(/Base\s*EXP\s*:\s*\+?([\d,]+)/i),
      jobExp:number(/Job\s*EXP\s*:\s*\+?([\d,]+)/i),
      survived:/你活下來了|你存活下來了|You survived/i.test(text)?true:
        /你死了|你倒下了|You died|Game Over/i.test(text)?false:null
    };
  }
  function summarySnapshot(){
    const drops=resultSection(/^(?:獲得的掉落|獲得的戰利品|Obtained drops|Obtained loot)$/i);
    const cards=resultSection(/^(?:獲得的卡片|Cards obtained|Obtained cards)$/i);
    const stats=extractRunStats();
    return {hasDropSection:drops.found,hasCardSection:cards.found,
      dropIcons:drops.icons.length,cardIcons:cards.icons.length,
      dropNames:drops.names,cardNames:cards.names,stats,
      fingerprint:JSON.stringify([drops.icons,drops.names,cards.icons,cards.names,stats])};
  }
  function captureDifficulty(stageId){
    const go=[...document.querySelectorAll('button,[role="button"]')].find(el=>visible(el)&&
      /^(?:前往野外[！!]?|GoToField|EnterTheField)$/i.test(label(el).replace(/\s/g,'')));
    if(!go)return null;
    let modal=null;
    for(let p=go.parentElement,i=0;p&&i<10;p=p.parentElement,i++){
      const t=String(p.innerText||'');
      if(/敵人數量/.test(t)&&/敵人傷害/.test(t)&&/裝備/.test(t)){modal=p;break;}
    }
    if(!modal)return null;
    const text=norm(modal.innerText);
    const pct=x=>{const m=text.match(new RegExp(x+'\\s*([\\d.,]+)\\s*%','i'));return m?Number(m[1].replace(',','.')):null;};
    const num=x=>{const m=text.match(new RegExp(x+'\\s*(?:×|x)?\\s*([\\d.,]+)','i'));return m?Number(m[1].replace(',','.')):null;};
    const d={capturedAt:nowISO(),stage:stageId==='forest'?'斐揚森林':stageId==='cave'?'斐揚洞穴':
      (typeof stageId==='string'&&stageId.includes('／')?stageId:pendingDifficulty?.stage||null),
      enemyCount:pct('敵人數量'),enemyDamage:pct('敵人傷害'),enemyHp:pct('敵人\\s*HP'),
      enemySpeed:pct('敵人速度'),eventCount:pct('事件數量'),stageLevel:num('關卡等級\\s*Lv\\.?'),
      dropMultiplier:num('掉寶'),equipmentMultiplier:num('裝備'),legendaryPct:pct('傳說率')};
    pendingDifficulty=d;saveJSON(DIFFICULTY_KEY,d);
    return d;
  }
  function summarizeResultsForExport(run){
    const items=records.filter(r=>r.runId===run.id);
    return {...run,recorded:items.length,goldRecorded:items.filter(isGold).length,
      compactRecorded:items.filter(r=>/精簡掉落提示/.test(r.origin||'')).length,
      equipmentRecorded:items.filter(r=>r.type==='裝備').length,
      cardsRecorded:items.filter(r=>r.type==='卡片').length};
  }
  function exportRuns(){
    const headers=['場次','開始時間','結算時間','地圖','敵人數量%','敵人傷害%','敵人HP%','敵人速度%','事件數量%',
      '關卡Lv','掉寶倍率','裝備倍率','傳說率%','存活時間','擊殺怪物','頭目','局內等級',
      '結算掉落圖示','結算卡片圖示','紀錄裝備','紀錄卡片','已辨識金裝','精簡提示筆數','總紀錄','警告'];
    const f=v=>{let s=String(v??'');if(/^\s*[=+@\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    const rows=runHistory.map(r=>[r.id,r.startedAt,r.settledAt,r.difficulty?.stage,
      r.difficulty?.enemyCount,r.difficulty?.enemyDamage,r.difficulty?.enemyHp,r.difficulty?.enemySpeed,
      r.difficulty?.eventCount,r.difficulty?.stageLevel,r.difficulty?.dropMultiplier,
      r.difficulty?.equipmentMultiplier,r.difficulty?.legendaryPct,
      r.summaryObserved?.stats?.duration,r.summaryObserved?.stats?.kills,r.summaryObserved?.stats?.bosses,
      r.summaryObserved?.stats?.level,r.summaryObserved?.dropIcons,r.summaryObserved?.cardIcons,
      r.equipmentRecorded,r.cardsRecorded,r.goldRecorded,r.compactRecorded,r.recorded,r.captureWarning]);
    const body='\ufeff'+[headers,...rows].map(row=>row.map(f).join(',')).join('\r\n');
    const a=document.createElement('a'),u=URL.createObjectURL(new Blob([body],{type:'text/csv;charset=utf-8'}));
    a.href=u;a.download='HANS_關卡強度與戰利品_場次統計_'+new Date().toISOString().slice(0,10)+'.csv';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),5000);
    status('已匯出 '+runHistory.length+' 場關卡與戰利品統計');
  }

  // 結算畫面：卡片若只顯示圖示，嘗試讀取 alt/title；取不到名稱只標記未辨識，不造假。
  function scanSummaryCards(){
    if(!settings.running)return;
    const allText=String(document.body?.innerText||'');
    const resultVisible=/你活下來了|你存活下來了|你死了|你倒下了|You survived|You died|Run Results|獲得的掉落|獲得的戰利品/i.test(allText) && /獲得的卡片|Cards obtained|Obtained cards/i.test(allText);
    if(!resultVisible){summaryWasVisible=false;summarySeen.clear();summaryDropSeen.clear();return;}
    if(!summaryWasVisible){summaryWasVisible=true;summarySeen.clear();}
    const labels=[...document.querySelectorAll('h1,h2,h3,h4,div,span,p')]
      .filter(el=>visible(el)&&/^(?:獲得的卡片|Cards obtained|Obtained cards)$/i.test(label(el)));
    const heading=labels.find(el=>el.children.length===0)||labels[0];
    if(!heading)return;
    let box=heading.parentElement;
    for(let tries=0;tries<3&&box;tries++,box=box.parentElement){
      const imgs=[...box.querySelectorAll('img')].filter(visible);
      if(!imgs.length||imgs.length>16)continue;
      for(const [i,img] of imgs.entries()){
        let name=norm(img.getAttribute('alt')||img.getAttribute('title')||img.getAttribute('aria-label')||img.dataset?.cardName||img.closest('[data-card-name]')?.getAttribute('data-card-name')||'');
        const src=img.getAttribute('src')||'';
        const srcName=src.split(/[?#]/)[0].split('/').at(-1)||'';
        if(!name){
          const cleaned=srcName.replace(/\.[A-Za-z0-9]+$/,'').replace(/[_-]/g,' ');
          const usable=/[a-zA-Z\u4e00-\u9fff]{3,}/.test(cleaned) && !/^(?:card|icon|img|sprite|thumb|asset|\d+)$/i.test(cleaned);
          name=usable?`卡片圖片代碼：${cleaned}`:`未辨識卡片 #${i+1}`;
        }
        if(/^(?:卡片|card|card icon)$/i.test(name))name=`未辨識卡片 #${i+1}`;
        const uniq=`${i}:${src}:${name}`;
        if(summarySeen.has(uniq))continue;
        summarySeen.add(uniq);
        // 只比對「本場」的同名卡片，不會拿其他場的卡片來去重。
        const popupCount=runRecords().filter(x=>typeName(x)==='卡片'&&x.name===name&&/掉落彈窗|精簡掉落提示/.test(x.origin||'')).length;
        const seenInSummary=[...summarySeen].filter(v=>v.includes(`:${src}:${name}`)).length;
        if(seenInSummary>popupCount)addRecord({type:'卡片',name,rarity:'',tier:null,baseStats:[],attributes:[],
          imageHint:srcName,rawText:`結算畫面：獲得的卡片 #${i+1}；${name}`,origin:'結算卡片縮圖（名稱可能未辨識）'});
      }
      return;
    }
  }
  // 以「你存活下來了」+「返回角色」辨識結算（含常見英文字樣），不會因主城出現背包而誤判。
  function resultVisible(){
    const t=String(document.body?.innerText||'');
    return /你活下來了|你存活下來了|你死了|你倒下了|You survived|You died|Run Results|Game Over|戰鬥結算|本局傷害/i.test(t)
      && /返回[角腳]色|回到角色|Back to character|Return to character/i.test(t);
  }
  function recordLine(rec,index){
    const q=rec.rarity||'品質未顯示';
    const head=`${index+1}. ${rec.type==='卡片'?'🃏':rec.type==='裝備'?'🛡️':'🎁'} ${rec.name}｜${q}${rec.tier!=null?' · TIER '+rec.tier:''}`;
    const attributes=[...(rec.baseStats||[]),...(rec.attributes||[])].filter(Boolean);
    return (head+(attributes.length?'\n   '+attributes.join('；'):'')).slice(0,1850);
  }
  function runSummaryPayloads(run){
    const items=records.filter(r=>r.runId===run.id);
    const gold=items.filter(isGold).length;
    const parts=[];
    const lines=items.map(recordLine);
    let chunk='';
    for(const line of lines){
      if(chunk && (chunk.length+line.length+1)>3000){parts.push(chunk);chunk='';}
      chunk+=(chunk?'\n':'')+line;
    }
    if(chunk || !parts.length)parts.push(chunk||'（本場沒有成功辨識的戰利品）');
    const startTime=new Date(run.startedAt).toLocaleString('zh-TW',{hour12:false});
    const count=(type)=>items.filter(r=>r.type===type).length;
    return parts.map((part,index)=>({
      username:'RO Survivors 戰利品紀錄',allowed_mentions:{parse:[]},
      embeds:[{title:`📋 本場戰利品總表${parts.length>1?`（${index+1}/${parts.length}）`:''}`,
        color:0x4974bb,
        description:[`**總計 ${items.length} 件｜傳說金色 ${gold}｜裝備 ${count('裝備')}｜卡片 ${count('卡片')}｜其他 ${count('其他')}**`,
          `開局／開始記錄：${startTime}`,
          `關卡：${run.difficulty?.stage||'未確認'}｜敵量 ${run.difficulty?.enemyCount??'?'}%｜HP ${run.difficulty?.enemyHp??'?'}%｜掉寶 ×${run.difficulty?.dropMultiplier??'?'}｜裝備 ×${run.difficulty?.equipmentMultiplier??'?'}｜傳說率 ${run.difficulty?.legendaryPct??'?'}%`,
          `結算縮圖：掉落 ${run.summaryObserved?.dropIcons??'?'}｜卡片 ${run.summaryObserved?.cardIcons??'?'}（非完整名稱／品質清單）`,
           `精簡掉落提示：${items.filter(r=>/精簡掉落提示/.test(r.origin||'')).length} 筆`,
          run.captureWarning?`⚠️ ${run.captureWarning}`:'',part,
          '※ 此表統計本場由畫面成功辨識的掉落；若道具未顯示文字或腳本未運作，無法補回。'
        ].join('\n\n').slice(0,3900),
        footer:{text:`RO Survivors · ${run.id} · 共 ${parts.length} 段`},timestamp:run.settledAt||nowISO()}]
    }));
  }
  function finishRun(reason){
    if(!settings.running || !currentRun || currentRun.phase!=='active'||currentRun.summaryQueued)return;
    // 封存前再掃一遍結算縮圖；未明確顯示品質時不猜是金裝。
    scanSummaryCards();scanSummaryDrops();
    currentRun.summaryObserved={...summarySnapshot(),fingerprint:undefined};
    currentRun.phase='settled';currentRun.settledAt=nowISO();currentRun.summaryQueued=true;
    saveRun();
    runHistory.push(summarizeResultsForExport(currentRun));saveJSON(HISTORY_KEY,runHistory);
    const payloads=runSummaryPayloads(currentRun);
    if(settings.notify)payloads.forEach((payload,i)=>queueDiscordPayload(payload,`本場總表 ${i+1}/${payloads.length}`));
    lastSummaryText=`已結算：可讀紀錄 ${runRecords().length} 件，掉落縮圖 ${currentRun.summaryObserved?.dropIcons??'?'}、卡片縮圖 ${currentRun.summaryObserved?.cardIcons??'?'}（${reason}）`;
    status(settings.notify?`${lastSummaryText}，已加入 DC 待送`:`${lastSummaryText}，Discord 已關閉`);
    updateUI();
  }
  function checkResult(){
    if(!settings.running)return;
    if(!resultVisible()){
      resultSeenAt=0;resultStableSince=0;resultFingerprint='';return;
    }
    if(!currentRun)ensureRun();
    if(currentRun?.phase==='settled')return;
    const now=Date.now();
    if(!resultSeenAt)resultSeenAt=now;
    scanSummaryCards();scanSummaryDrops();
    const snap=summarySnapshot();
    lastDiagnostic=`結算辨識：掉落縮圖 ${snap.dropIcons}、卡片縮圖 ${snap.cardIcons}；掉落區 ${snap.hasDropSection?'有':'無'}、卡片區 ${snap.hasCardSection?'有':'無'}；${now-resultSeenAt}ms`;
    if(snap.fingerprint!==resultFingerprint){resultFingerprint=snap.fingerprint;resultStableSince=now;}
    if(currentRun)currentRun.summaryObserved={...snap,fingerprint:undefined};
    const both=snap.hasDropSection&&snap.hasCardSection;
    // 死亡結算常只有「獲得的卡片」而沒有「獲得的掉落」；
    // 只要卡片區和戰績已穩定，不能硬等不存在的掉落區，否則不會自動重進。
    const died=snap.stats?.survived===false;
    const enough=both||(died&&snap.hasCardSection);
    if(now-resultSeenAt>=RESULT_MIN_MS&&enough&&now-resultStableSince>=RESULT_STABLE_MS){
      if(currentRun&&(!snap.hasDropSection||(!snap.dropIcons&&snap.hasDropSection)))
        currentRun.captureWarning=died?'死亡結算未顯示掉落區，已依卡片與戰績封存':'掉落縮圖未讀取到，請核對';
      finishRun(died?'死亡結算卡片與戰績穩定':'結算縮圖與戰績已穩定');
    }else if(now-resultSeenAt>=RESULT_MAX_MS){
      if(currentRun)currentRun.captureWarning=enough?'結算內容持續變動，逾時保底封存':'結算區塊未完整辨識，逾時保底封存';
      finishRun(died?'死亡結算等待逾時':'結算等待逾時');
    }else status(died?'等待死亡結算／卡片穩定，暫不返回角色':'等待結算資料穩定，暫不返回角色');
  }

  // 主動離場沒有正常戰利品結算；不得把未顯示的卡片誤認為已取得。
  function settleShortRun(seconds,stageName){
    if(!settings.running)return true;
    if(!currentRun)ensureRun();
    if(!currentRun||currentRun.phase!=='active'||currentRun.summaryQueued)return true;
    const secs=Math.max(0,Math.floor(Number(seconds)||0));
    currentRun.summaryObserved={
      dropIcons:null,cardIcons:null,hasDropSection:false,hasCardSection:false,
      stats:{duration:String(Math.floor(secs/60)).padStart(2,'0')+':'+String(secs%60).padStart(2,'0'),
        survived:null},abandoned:true
    };
    currentRun.captureWarning='3分鐘刷卡模式主動捨棄未完成的一局；沒有正常戰鬥結算。'
      +'只記錄離場前可辨識的掉落，無法證實卡片在捨棄後是否保留。';
    currentRun.abortReason='3分鐘刷卡模式主動離場';
    currentRun.difficulty=currentRun.difficulty||{stage:stageName||'未確認'};
    currentRun.phase='settled';currentRun.settledAt=nowISO();currentRun.summaryQueued=true;
    saveRun();runHistory.push(summarizeResultsForExport(currentRun));saveJSON(HISTORY_KEY,runHistory);
    if(settings.notify){
      const msgs=runSummaryPayloads(currentRun);
      msgs.forEach((msg,i)=>queueDiscordPayload(msg,'3分鐘主動離場 '+(i+1)+'/'+msgs.length));
    }
    lastSummaryText='主動離場：可讀紀錄 '+runRecords().length+' 筆（無正常結算）';
    status(lastSummaryText);updateUI();
    return true;
  }

  // 「選關」與「戰利品」現在位於同一使用者腳本，共用可離場旗標。
  const stageLootBridge={
    captureDifficulty(stageId){return captureDifficulty(stageId);},
    settleShortRun(seconds,stageName){return settleShortRun(seconds,stageName);},
    readyToLeave(){
      if(!settings.running){status('紀錄功能已暫停，為防漏記不自動返回角色');return false;}
      if(!resultVisible())return false;
      checkResult();
      return currentRun?.phase==='settled'&&currentRun.summaryQueued===true;
    }
  };
  function beforeTransition(evt){
    const btn=evt.target?.closest?.('button,[role="button"]');
    if(!btn || !visible(btn))return;
    const name=label(btn).replace(/\s/g,'');
    if(/^(?:前往野外[！!]?|GoToField|EnterTheField)$/i.test(name)&&evt.type==='click'&&settings.running){
      // 只在確認重新進場時開始新局；不影響原有選關腳本。
      captureDifficulty(null);
      beginRun('前往野外');
    }
    if(/^(?:返回[角腳]色|回到角色|ReturnToCharacter|BackToCharacter)$/i.test(name)&&resultVisible()){
      checkResult();
    }
  }
  function queueScan(){if(scanQueued||!settings.running)return;scanQueued=true;queueMicrotask(()=>{
    scanQueued=false;scanPopup('DOM 更新');scanSummaryCards();checkResult();
  });}
  function beforeGet(evt){
    if(!settings.running)return;
    const btn=evt.target?.closest?.('button,[role="button"]');
    if(btn && visible(btn) && getRe.test(label(btn)))scanPopup('按取得之前');
  }
  function colorOf(rec){return ({傳說:0xf59e0b,史詩:0xa855f7,稀有:0x3b82f6,優良:0x10b981,普通:0x8b95a5})[rec.rarity]||0x567cc1;}
  function discordPayload(rec){
    const attr=[...(rec.baseStats||[]),...(rec.attributes||[])];
    const details=attr.length?attr.join('\n'):'（本畫面沒有可讀取的額外屬性）';
    return {
      username:'RO Survivors 戰利品紀錄',allowed_mentions:{parse:[]},
      embeds:[{title:`${rec.type==='卡片'?'🃏':rec.type==='裝備'?'🛡️':'🎁'} ${rec.type}｜${rec.name}`.slice(0,256),
        color:colorOf(rec),description:[
          `**品質：** ${rec.rarity||'未顯示'}　**TIER：** ${rec.tier??'未顯示'}`,
          `**屬性／效果**\n${details}`,
          `**來源：** ${rec.origin||'掉寶紀錄'}`
        ].join('\n\n').slice(0,3800),
        footer:{text:`RO Survivors · 本機畫面辨識 · ${rec.id.slice(0,18)}`},timestamp:rec.time}]
    };
  }
  function queueDiscordPayload(payload,name){
    outbox.push({id:`msg-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,payload,name,attempts:0,nextTry:0});
    saveJSON(OUTBOX_KEY,outbox);updateUI();sendNext();
  }
  function sendNext(){
    if(sending||!settings.notify||!outbox.length)return;
    if(!readWebhook()){status('尚未設定 Discord Webhook：請從戰利品面板設定');return;}
    if(typeof GM_xmlhttpRequest!=='function'){status('Discord 無法送出：需要 Tampermonkey 的跨網域權限');return;}
    const now=Date.now(),first=outbox[0];
    if(first.nextTry>now||nextAllowedAt>now)return;
    sending=true;updateUI();
    GM_xmlhttpRequest({
      method:'POST',url:readWebhook(),headers:{'Content-Type':'application/json'},
      data:JSON.stringify(first.payload),timeout:12000,
      onload:r=>{
        sending=false;
        if(r.status===204||r.status===200){
          outbox.shift();saveJSON(OUTBOX_KEY,outbox);nextAllowedAt=Date.now()+1500;
          status(`Discord 已送達：${first.name}`);
        }else{
          first.attempts++;
          let retry=5000*Math.min(12,first.attempts);
          if(r.status===429){try{const j=JSON.parse(r.responseText||'{}');retry=Math.max(retry,Number(j.retry_after||0)*1000+1000);}catch{}}
          if([401,403,404].includes(r.status)){
            settings.notify=false;saveJSON(SETTINGS_KEY,settings);
            status(`Discord ${r.status}：Webhook 無效或無權限，已暫停推播（本機資料仍保留）`);
          }else status(`Discord ${r.status} 暫時失敗，保留待送並將重試`);
          first.nextTry=Date.now()+Math.min(300000,retry);saveJSON(OUTBOX_KEY,outbox);
        }
        updateUI();
      },
      ontimeout:()=>failSend('逾時'),onerror:()=>failSend('網路錯誤')
    });
    function failSend(reason){
      sending=false;first.attempts++;first.nextTry=Date.now()+Math.min(300000,4000*first.attempts);
      saveJSON(OUTBOX_KEY,outbox);status(`Discord ${reason}，保留待送`);updateUI();
    }
  }
  function exportData(kind){
    const day=new Date().toISOString().slice(0,10),csvSafe=v=>{
      let s=String(v??'');if(/^\s*[=+@\-]/.test(s))s="'"+s;
      return '"'+s.replace(/"/g,'""')+'"';
    };
    let body,type,filename;
    if(kind==='csv'){
      const head=['時間','本場編號','類型','名稱','品質','TIER','基礎屬性',...Array.from({length:14},(_,i)=>`屬性${i+1}`),'來源','原文'];
      const rows=records.map(r=>[r.localTime||r.time,r.runId||'',typeName(r),r.name,r.rarity||'',r.tier??'',(r.baseStats||[]).join('；'),
        ...Array.from({length:14},(_,i)=>r.attributes?.[i]||''),r.origin||'',r.rawText||'']);
      body='\ufeff'+[head,...rows].map(row=>row.map(csvSafe).join(',')).join('\r\n');
      type='text/csv;charset=utf-8';filename=`RO_Survivors_裝備卡片全紀錄_${day}.csv`;
    }else{
      body=JSON.stringify({exportedAt:nowISO(),version:VERSION,total:records.length,items:records},null,2);
      type='application/json;charset=utf-8';filename=`RO_Survivors_裝備卡片全紀錄_${day}.json`;
    }
    const url=URL.createObjectURL(new Blob([body],{type}));
    const a=document.createElement('a');a.download=filename;a.href=url;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);status(`已匯出 ${filename}`);
  }
  function diagnostics(){
    const d=`RO Survivors v${VERSION} 辨識診斷\n時間 ${new Date().toLocaleString('zh-TW')}\n紀錄 ${records.length} 筆｜卡片 ${recordCount('卡片')}｜待送 ${outbox.length}\n`+
      `本場 ${currentRun?.id||'(尚未開始)'}｜狀態 ${currentRun?.phase||'-'}｜${lastSummaryText||'-'}\n`+
      `${lastDiagnostic}\n--- 最近掉寶視窗文字（不含帳密） ---\n${lastPopupText||'(尚未抓到)'}\n`;
    if(navigator.clipboard?.writeText){navigator.clipboard.writeText(d).then(()=>status('已複製診斷')).catch(()=>fallbackCopy(d));}
    else fallbackCopy(d);
  }
  function fallbackCopy(s){const t=document.createElement('textarea');t.value=s;t.style.position='fixed';t.style.left='-9999px';document.body.append(t);t.select();
    try{document.execCommand('copy');status('已複製診斷');}catch{status('複製失敗');}t.remove();}
  function makeUI(){
    if(!document.body||document.getElementById(UI_ID))return;
    ui=document.createElement('div');ui.id=UI_ID;
    ui.style.cssText='position:fixed;right:7px;bottom:8px;z-index:2147483647;max-width:calc(100vw - 14px);'+
      'font:12px/1.45 system-ui,sans-serif;color:#fff;background:#203452f0;border:1px solid #98b5db;'+
      'border-radius:8px;padding:6px;box-shadow:0 3px 12px #0007';
    ui.innerHTML=`<button type="button" id="roj4-open" style="border:0;background:transparent;color:white;cursor:pointer;font-weight:700" title="HANS 選關＋戰利品 v${VERSION} 已載入">📦 HANS 選關＋戰利品 <span style="font-size:10px;color:#bcd8fb;font-weight:600;white-space:nowrap">v${VERSION}</span> <span id="roj4-count">共 0</span> <span id="roj4-stage-mini" style="font-size:10px;opacity:.83">重進：關</span> ▾</button>
      <div id="roj4-menu" hidden style="width:265px;max-width:80vw;max-height:60vh;overflow-y:auto;padding-top:6px">
        <div style="font-size:10px;opacity:.78">HANS 整合 v${VERSION} 已載入｜${location.hostname}</div><div id="roj4-state">等待掉寶</div><div id="roj4-recent" style="overflow-wrap:anywhere">最近：尚無</div>
        <div id="roj4-discord">Discord：開｜待送 0</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
          <button id="roj4-toggle">暫停紀錄</button><button id="roj4-notify">關閉 DC</button>
          <button id="roj4-webhook">設定 DC Webhook</button><button id="roj4-test">傳送 DC 測試</button><button id="roj4-retry">重試待送</button>
          <button id="roj4-csv">匯出 CSV</button><button id="roj4-runs">場次 CSV</button><button id="roj4-json">匯出 JSON</button>
          <button id="roj4-scan">立即掃描</button><button id="roj4-diag">複製診斷</button>
        </div>
        <div style="opacity:.8;font-size:10px;padding-top:5px">所有品質（含傳說金色）都先存本機；每場結束才發 Discord 戰利品總表，不再逐件通知。請定期匯出備份。</div>
      </div>`;
    ui.querySelectorAll('button:not(#roj4-open)').forEach(b=>{b.style.cssText='background:#365d96;color:white;border:1px solid #83a7d8;border-radius:4px;padding:4px 6px;cursor:pointer';});
    document.body.append(ui);
    countEl=ui.querySelector('#roj4-count');stateEl=ui.querySelector('#roj4-state');recentEl=ui.querySelector('#roj4-recent');
    discordEl=ui.querySelector('#roj4-discord');menuEl=ui.querySelector('#roj4-menu');
    ui.querySelector('#roj4-open').onclick=()=>menuEl.hidden=!menuEl.hidden;
    ui.querySelector('#roj4-toggle').onclick=e=>{settings.running=!settings.running;saveJSON(SETTINGS_KEY,settings);
      e.target.textContent=settings.running?'暫停紀錄':'啟動紀錄';status(settings.running?'開始監看':'紀錄已暫停');};
    ui.querySelector('#roj4-notify').onclick=e=>{settings.notify=!settings.notify;saveJSON(SETTINGS_KEY,settings);
      e.target.textContent=settings.notify?'關閉 DC':'啟用 DC';status(settings.notify?'Discord 推播已開啟':'Discord 推播已關閉');if(settings.notify)sendNext();updateUI();};
    ui.querySelector('#roj4-webhook').onclick=()=>{
      const next=prompt('請貼上 Discord Webhook（僅存於 Tampermonkey 本機設定，不會寫入公開程式）','');
      if(next===null)return;
      const value=next.trim();
      if(!/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(value)){
        status('Webhook 格式不正確，未儲存');return;
      }
      GM_setValue(WEBHOOK_KEY,value);
      status('Webhook 已儲存於本機，沒有寫進公開腳本');
      if(settings.notify)sendNext();
    };
    ui.querySelector('#roj4-test').onclick=()=>{
      if(!settings.notify){status('請先啟用 DC 推播');return;}
      const d=new Date(),test={id:`test-${Date.now()}`,time:d.toISOString(),type:'測試',name:'連線測試（非實際掉寶）',
        rarity:'',tier:null,baseStats:[],attributes:['這則訊息用來檢查 Discord Webhook 是否正常'],origin:'手動測試'};
      queueDiscordPayload(discordPayload(test),'連線測試');status('Discord 測試訊息已加入待送');
    };
    ui.querySelector('#roj4-retry').onclick=()=>{for(const v of outbox)v.nextTry=0;saveJSON(OUTBOX_KEY,outbox);sendNext();status('已要求重試待送訊息');};
    ui.querySelector('#roj4-csv').onclick=()=>exportData('csv');
    ui.querySelector('#roj4-runs').onclick=exportRuns;
    ui.querySelector('#roj4-json').onclick=()=>exportData('json');
    ui.querySelector('#roj4-scan').onclick=()=>{scanPopup('手動掃描');scanSummaryCards();scanSummaryDrops();checkResult();status(lastDiagnostic);};
    ui.querySelector('#roj4-diag').onclick=diagnostics;
    ui.querySelector('#roj4-toggle').textContent=settings.running?'暫停紀錄':'啟動紀錄';
    ui.querySelector('#roj4-notify').textContent=settings.notify?'關閉 DC':'啟用 DC';
    updateUI();
  }
  function init(){
    if(!document.documentElement){setTimeout(init,40);return;}
    new MutationObserver(changes=>{
      captureCompactMutations(changes); // 在排入微任務之前即時捕捉短暫提示
      if(!ui&&document.body)makeUI();
      if(changes.every(ch=>{const el=ch.target instanceof Element?ch.target:ch.target?.parentElement;return !!el?.closest?.(`#${UI_ID},#hh-payon-integrated-v06`);}))return;
      queueScan();
    }).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
    document.addEventListener('click',beforeGet,true);
    document.addEventListener('pointerdown',beforeGet,true);
    document.addEventListener('pointerdown',beforeTransition,true);
    document.addEventListener('click',beforeTransition,true);
    makeUI();
    setInterval(()=>{if(!ui&&document.body)makeUI();if(settings.running){scanPopup('定時掃描');scanSummaryCards();checkResult();}sendNext();},450);
    queueScan();
  }
  // 預先輸出啟動標記，方便排除『腳本未注入』與『偵測不到掉寶』兩種不同問題。
  console.info('[HANS 戰利品] 腳本 v' + VERSION + ' 已載入：' + location.href);
  init();
  // 原本自動重進功能已整合在此：同一腳本、同一封存流程。
  try {
  (() => {
  'use strict';
  if (document.getElementById('hh-payon-integrated-v06')) return;

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
  // 遠征清單以目前遊戲畫面為準；不硬編碼未見過的關卡名稱。
  const STAGES={
    forest:{name:'斐揚森林',re:W.forest,unlocked:true,world:1},
    cave:{name:'斐揚洞穴',re:W.cave,unlocked:true,world:1}
  };
  const CATALOG_KEY='hh-ro-stage-catalog-v062', SELECT_KEY='hh-ro-dungeon-v16';
  const WORLD_KEY='hh-ro-expedition-world-v080', WORLD_TARGETS_KEY='hh-ro-world-targets-v080';
  const WORLD_NAMES={1:'一周目',2:'二周目',3:'三周目',4:'四周目',5:'五周目',6:'六周目'};
  const worldSelections=(()=>{try{const v=JSON.parse(localStorage.getItem(WORLD_TARGETS_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch{return {}}})();
  if(!worldSelections['1'])try{worldSelections['1']=localStorage.getItem(SELECT_KEY)||'cave'}catch{worldSelections['1']='cave'}
  let initialWorld=1;try{const w=Number(localStorage.getItem(WORLD_KEY));if(WORLD_NAMES[w])initialWorld=w}catch{}

  const savedCatalog=(()=>{
    try{const v=JSON.parse(localStorage.getItem(CATALOG_KEY)||'[]');return Array.isArray(v)?v:[]}
    catch{return []}
  })();
  const namePattern=name=>new RegExp('^'+[...norm(name)].map(ch=>
    /[\p{L}\p{N}]/u.test(ch)?ch:'\\'+ch).join('')+'$','i');
  // 2026 HANS 遠征周目：一周目原名；二至五周目依次為「・改」「・改²」「・改³」「・改⁴」。
  // norm 採 NFKC：上標²、³、⁴ 正規化成 2、3、4，顯示與比對分開處理。
  // 舊版 seed 候選時可能把「・改3」當新地名再加「・改³」，造成「・改3・改³」。
  // 移除所有連續的改版尾碼，再依真正周目補回正確的一個尾碼。
  const REFORM_MARK=/(?:[・･·‧•∙．]改(?:[234])?)+$/u;
  function stageNameWorld(name){
    const n=norm(name);
    if(/[・･·‧•∙．]改4$/u.test(n))return 5;
    if(/[・･·‧•∙．]改3$/u.test(n))return 4;
    if(/[・･·‧•∙．]改2$/u.test(n))return 3;
    if(/[・･·‧•∙．]改$/u.test(n))return 2;
    return 1;
  }
  function baseStageName(name){return norm(name).replace(REFORM_MARK,'');}
  function stageFitsWorld(name,world){return Number(world)===6?stageNameWorld(name)===1:stageNameWorld(name)===Number(world);}
  function stageLabelForWorld(base,world){
    const clean=baseStageName(base);
    return clean+(world===2?'・改':world===3?'・改²':world===4?'・改³':world===5?'・改⁴':'');
  }
  function canonicalStageName(name,world){
    // 只處理「後綴重複」；未知地圖仍保留從遊戲畫面取得的原名。
    return stageLabelForWorld(baseStageName(name),Number(world));
  }

  const chosenWorld=()=>Number(worldPicker.value)||1;
  function redrawStageChoices(){
    const world=chosenWorld(),before=picker.value;
    const entries=Object.entries(STAGES).filter(([,v])=>v.world===world);
    const lvl=v=>Number((String(v.level||'').match(/^(\d+)/)||[])[1]||99999);
    entries.sort((a,b)=>lvl(a[1])-lvl(b[1])||a[1].name.localeCompare(b[1].name));
    picker.replaceChildren();
    const blank=document.createElement('option');blank.value='';
    blank.textContent=entries.length?'選擇'+WORLD_NAMES[world]+'關卡':'目前無可選關卡';
    picker.append(blank);
    for(const [key,st] of entries){
      const opt=document.createElement('option');opt.value=key;opt.disabled=st.unlocked===false;
      opt.textContent=st.name+(st.level?' · Lv '+st.level:'')+(st.unlocked===false?'（未解鎖）':st.unlocked===null?'（待確認）':'');
      picker.append(opt);
    }
    const preferred=(STAGES[before]?.world===world?before:'')||worldSelections[String(world)]||'';
    picker.value=STAGES[preferred]?.world===world&&STAGES[preferred].unlocked!==false?preferred:'';
  }
  function rememberStage(name,unlocked,level='',world=1){
    name=String(name||'').trim().replace(/[\r\n]+/g,' ');
    if(name.length<2||name.length>65||!WORLD_NAMES[world])return null;
    if(!stageFitsWorld(name,world))return null; // 不以別周目的同名關卡覆蓋本周目
    name=canonicalStageName(name,world); // 不讓歷史「改3・改³」污染新的選關清單
    const found=Object.entries(STAGES).find(([,v])=>v.world===world&&norm(v.name)===norm(name));
    const key=found?.[0]||'hans:w'+world+':'+norm(name);
    if(!STAGES[key])STAGES[key]={name,re:namePattern(name),unlocked,level,world};
    else{STAGES[key].unlocked=unlocked;STAGES[key].verified=true;if(level)STAGES[key].level=level;}
    STAGES[key].verified=true;
    redrawStageChoices();return key;
  }
  // 用已知地圖的原名推導一至五周目選關候選，無須先人工捲完清單。
  // 候選本身不代表已解鎖；真正出征前仍須在該周目看到相同名稱、Lv 與可挑戰。
  function seedKnownStageCandidates(){
    const bases=new Set(Object.values(STAGES).map(x=>baseStageName(x.name)));
    for(const base of bases){
      if(!base||base.length<2||base.length>40)continue;
      for(const world of [1,2,3,4,5,6]){
        const name=stageLabelForWorld(base,world),key='hans:w'+world+':'+norm(name);
        if(Object.values(STAGES).some(x=>x.world===world&&norm(x.name)===norm(name)))continue;
        STAGES[key]={name,re:namePattern(name),unlocked:null,level:'',world,verified:false};
      }
    }
    redrawStageChoices();
  }
  const levelPattern=/\bLv\.?\s*(\d+)\s*[-–—~～]\s*(\d+)\b/i;
  // 對照實際畫面：左側每張關卡卡片有 Lv 31-40 等範圍及關卡名稱。
  function stageRows(){
    const out=[],used=new Set(),walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    let node,count=0;
    while((node=walk.nextNode())&&count++<14000){
      const leafText=String(node.nodeValue||'').normalize('NFKC').trim();
      if(leafText.length>60||!levelPattern.test(leafText))continue;
      const el=node.parentElement;
      if(!el||hud.contains(el)||el.closest('#'+UI_ID+',script,style,noscript')||!shown(el,true))continue;
      for(let p=el,depth=0;p&&p!==document.body&&depth<10;p=p.parentElement,depth++){
        const rect=rct(p),cx=rect.left+rect.width/2,text=String(p.textContent||'');
        if(cx>innerWidth*.48||rect.width>innerWidth*.55)break;
        if(rect.width<115||rect.height<48||rect.height>175||text.length>350||!levelPattern.test(text))continue;
        // 顯示保留三／四／五周目上標「²／³／⁴」，內部比對再採 NFKC 正規化。
        const leaves=[...p.querySelectorAll('*')].filter(x=>x.childElementCount===0)
          .map(x=>String(x.textContent||'').trim()).filter(Boolean);
        const possibleTitles=leaves.filter(x=>x.length>=2&&x.length<=65&&/[\p{L}]/u.test(x)
          && !/^(?:Lv\.?\s*\d+[-–—~～]\d+|MVP.*|已通關|未解鎖|可挑戰|已選擇|劇情|出發|頭目.*)$/i.test(x)
          && !/^\d+(?:[:：]\d+)?$/.test(x));
        // 優先讀取改／改²／改³／改⁴結尾的標題，避免錯抓 MVP 或狀態文字。
        const title=possibleTitles.find(x=>/[・･·‧•∙．]改(?:[234])?$/u.test(norm(x)))||possibleTitles[0];
        if(!title)continue;
        const key=norm(title);
        if(!used.has(key)){
          const level=(leafText.match(levelPattern)||[]).slice(1,3).join('-');
          out.push({el:p,name:title,level,unlocked:!/未解鎖|尚未解鎖|未開放/i.test(text)});
          used.add(key);
        }
        break;
      }
    }
    return out;
  }
  const catalog={running:false,complete:false,scroll:null,steps:0,observed:new Set(),
    searchName:'',searchSteps:0,searchAt:0,topReadyAt:0,topConfirmed:false,world:null,worldAt:0};
  // 四周目及五周目首次切換時各自從清單頂端完整掃描，避免只收錄畫面可見的幾關。
  const completedWorldScans=new Set();
  function resetCatalog(){
    Object.assign(catalog,{running:false,complete:false,scroll:null,steps:0,observed:new Set(),
      searchName:'',searchSteps:0,searchAt:0,topReadyAt:0,topConfirmed:false});
  }
  function findListScroll(rows){
    for(let p=rows[0]?.el,i=0;p&&i<14;p=p.parentElement,i++){
      const r=rct(p);
      if(p.clientHeight>=110&&p.scrollHeight>p.clientHeight+25&&
         p.clientWidth>=110&&p.clientWidth<innerWidth*.55&&r.left<innerWidth*.48)return p;
    }
    return null;
  }
  function readStageCatalog(world){
    const rows=stageRows();let change=false;
    for(const row of rows){
      if(!stageFitsWorld(row.name,world))continue;
      const k=rememberStage(row.name,row.unlocked,row.level,world);
      if(k&&!catalog.observed.has(k)){catalog.observed.add(k);change=true}
    }
    if(change)try{
      localStorage.setItem(CATALOG_KEY,JSON.stringify(
        Object.values(STAGES).map(v=>({name:v.name,unlocked:v.unlocked,level:v.level||'',world:v.world}))));
    }catch{}
    if(!catalog.scroll)catalog.scroll=findListScroll(rows);
    return rows;
  }
  function scanAllStages(world){
    if(!catalog.complete&&!catalog.running){
      catalog.running=true;catalog.steps=0;catalog.observed=new Set();
      catalog.topConfirmed=false;catalog.topReadyAt=Date.now()+550;
      // 掃描目前遊戲所顯示的完整關卡清單；不限制五關，也不捏造未出現的關卡。
      catalog.scroll=findListScroll(stageRows());
      if(catalog.scroll)catalog.scroll.scrollTop=0;
    }
    if(!catalog.running)return;
    const el=catalog.scroll;
    if(!el || !el.isConnected){
      catalog.running=false;catalog.complete=false;
      tell(WORLD_NAMES[world]+'清單尚未找到可捲動區，稍後重試；不會誤判掃描完成');return;
    }
    // 從頂端開始，等待虛擬清單渲染，不在同一個 tick 立即往下跳。
    if(!catalog.topConfirmed){
      if(el.scrollTop>2){el.scrollTop=0;catalog.topReadyAt=Date.now()+550;return;}
      if(Date.now()<catalog.topReadyAt)return;
      catalog.topConfirmed=true;
    }
    readStageCatalog(world);
    const bottom=Math.max(0,el.scrollHeight-el.clientHeight);
    if(el.scrollTop>=bottom-3){
      catalog.running=false;catalog.complete=true;completedWorldScans.add(world);
      el.scrollTop=0;
      tell(WORLD_NAMES[world]+'已完整掃描 '+catalog.observed.size+' 個關卡；可選擇清單中的任何關卡');
      return;
    }
    if(catalog.steps>=140){
      // 超過捲動上限屬於不完整掃描，保留既有候選但不宣稱已完成。
      catalog.running=false;catalog.complete=false;completedWorldScans.add(world);
      el.scrollTop=0;
      tell(WORLD_NAMES[world]+'掃描超過上限，已發現 '+catalog.observed.size+' 關；未宣稱全部掃完');
      return;
    }
    const before=el.scrollTop;
    el.scrollTop=Math.min(bottom,before+Math.max(110,el.clientHeight*.66));
    if(el.scrollTop<=before+1){
      // 捲動已停止，可能內容尚未刷新；不要將清單猜成只有五關。
      catalog.running=false;catalog.complete=false;
      tell('關卡列表無法繼續捲動，保留已發現的 '+catalog.observed.size+' 關，稍後可重試');
      return;
    }
    catalog.steps++;
    tell('正在掃描'+WORLD_NAMES[world]+'所有關卡：目前 '+catalog.observed.size+' 關（'+catalog.steps+'段）');
  }
  function stageExplorerTick(){
    if(!expeditionOpen()){resetCatalog();catalog.world=null;return;}
    if(worldClickAt&&Date.now()-worldClickAt<700)return; // 等周目切換動畫與列表更新
    const tab=currentWorldState();
    if(tab.world===null){
      tell('關卡周目尚未辨識，等待畫面載入');return;
    }
    if(catalog.world!==tab.world){
      resetCatalog();catalog.world=tab.world;catalog.worldAt=Date.now();
    }
    // 四、五周目在首次進入時分開掃描全部關卡；未解鎖項目保留，但不會自動出征。
    if([4,5,6].includes(tab.world) && !completedWorldScans.has(tab.world)){
      scanAllStages(tab.world);
      return;
    }
    if(!catalog.running)readStageCatalog(tab.world);
  }

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
  hud.id = 'hh-payon-integrated-v06';
  // 與右下角戰利品共用同一面板，不再另行顯示右上固定 HUD（避免遮住小地圖）。
  hud.style.cssText = 'position:relative;display:block;box-sizing:border-box;width:100%;margin:0 0 8px;'+
    'background:#23334b;color:#fff;border:1px solid #a7c7ed;border-radius:6px;padding:7px;'+
    'font:12px/1.5 sans-serif;overflow-wrap:anywhere';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'font:bold 12px sans-serif;padding:4px 8px;color:#fff;background:#5c6b82;border:1px solid #c9dbed;border-radius:5px;cursor:pointer';
  const msg = document.createElement('div');
  msg.style.cssText='margin-top:4px;max-width:270px;overflow-wrap:anywhere';
  const worldPicker=document.createElement('select');
  worldPicker.title='選擇自動重進的周目';worldPicker.setAttribute('aria-label','遠征周目');
  worldPicker.style.cssText='margin-left:5px;color:#18283b;background:white;border-radius:4px;padding:4px;font:12px sans-serif;max-width:86px';
  for(const [key,label] of Object.entries(WORLD_NAMES)){
    const op=document.createElement('option');op.value=key;op.textContent=label;worldPicker.append(op);
  }
  worldPicker.value=String(initialWorld);
  const picker=document.createElement('select');
  picker.title='選擇此周目關卡';picker.setAttribute('aria-label','自動進入的副本');
  picker.style.cssText='margin-left:5px;color:#18283b;background:white;border-radius:4px;padding:4px;font:12px sans-serif;max-width:150px';
  for(const item of savedCatalog){
    if(item&&typeof item.name==='string')rememberStage(item.name,item.unlocked===false?false:item.unlocked===null?null:true,item.level||'',Number(item.world)||1);
  }
  // 將舊版錯誤選取鍵（例如 hans:w4:斐揚森林・改3・改3）搬到乾淨鍵。
  // 不刪除歷史選擇，只修正字串後綴；會在下一次切換時保存回 localStorage。
  for(const [w,value] of Object.entries(worldSelections)){
    const world=Number(w),match=String(value||'').match(/^hans:w(\d+):(.+)$/u);
    if(!WORLD_NAMES[world]||!match||Number(match[1])!==world)continue;
    const desired='hans:w'+world+':'+norm(canonicalStageName(match[2],world));
    if(STAGES[desired])worldSelections[w]=desired;
  }
  const oldTarget=worldSelections['1'];
  if(oldTarget&&!STAGES[oldTarget]&&oldTarget.startsWith('hans:')&&!/^hans:w[123456]:/.test(oldTarget)){
    rememberStage(oldTarget.slice(5),true,'',1);
    worldSelections['1']='hans:w1:'+norm(oldTarget.slice(5));
  }
  // 四周目：依使用者 2026-11-17 截圖列入五個關卡選項。
  // 初始標示為待確認，不把截圖時間的已通關狀態當作當前頁面可出征證據。
  // 真正進場前仍要掃到四周目相同名稱與當下的解鎖狀態才可按出發。
  for(const [name,level] of [
    ['普隆德拉地下水道・改³','9-12'],
    ['失事輪・改³','13-15'],
    ['柏伊亞嵐島・改³','16-20'],
    ['斐揚森林・改³','21-25'],
    ['斐揚洞穴・改³','26-30']
  ]){
    if(Object.values(STAGES).some(x=>x.world===4&&norm(x.name)===norm(name)))continue;
    STAGES['hans:w4:'+norm(name)]={name,re:namePattern(name),unlocked:null,level,world:4,verified:false};
  }
  // 六周目目前畫面已核實前五張地圖名稱和等級；解鎖狀態仍需入場前動態確認。
  // 只建立六周目候選，不讓它與一周目同名關卡互相覆蓋。
  for(const [name,level] of [
    ['普隆德拉原野','1-8'],
    ['普隆德拉地下水道','9-12'],
    ['失事輪','13-15'],
    ['柏伊亞嵐島','16-20'],
    ['斐揚森林','21-25']
  ]){
    if(Object.values(STAGES).some(x=>x.world===6&&norm(x.name)===norm(name)))continue;
    STAGES['hans:w6:'+norm(name)]={name,re:namePattern(name),unlocked:null,level,world:6,verified:false};
  }
  seedKnownStageCandidates();

  // 控制元件必須等 shortGroup / shortHelp 都宣告後才掛載；原 v0.7.0 會因 TDZ 初始化失敗。
  // 選關與戰利品共用右下原本面板。若主面板尚未生成，重試掛載，不開第二個浮窗。
  function mountStageIntoLootPanel(){
    if(!document.body){setTimeout(mountStageIntoLootPanel,200);return;}
    if(!document.getElementById(UI_ID))makeUI();
    const menu=document.getElementById('roj4-menu');
    if(!menu){setTimeout(mountStageIntoLootPanel,200);return;}
    if(hud.parentElement!==menu)menu.prepend(hud);
  }
  // 實際掛載移至 shortGroup、shortHelp 建立完成後。
  let active = false, timer = null, state = '', lastAt=0, attempts={};
  let stageClickedAt=0, beforeStageWasStory=false, departAt=0, wildernessAt=0;
  const targetStage=()=>STAGES[picker.value]?.world===chosenWorld()?STAGES[picker.value]:null;
  const targetLabel=()=>WORLD_NAMES[chosenWorld()]+'／'+(targetStage()?.name||'尚未選關');

  // 可選 3 分鐘短刷模式；只在本腳本的自動重進開啟時執行。
  const SHORT_PREF_KEY='hans-ro-stage-loot-short3-v070';
  const SHORT_PHASE_KEY='hans-ro-stage-loot-shortphase-v070';
  const REENTRY_KEY='hans-ro-stage-loot-auto-reentry-v070';
  const shortPrefs=(()=>{
    try{
      const x=JSON.parse(localStorage.getItem(SHORT_PREF_KEY)||'{}');
      return {enabled:x?.enabled===true,grace:[0,10,20,30,45,60].includes(Number(x?.grace))?Number(x.grace):20};
    }catch{return {enabled:false,grace:20};}
  })();
  const saveShortPrefs=()=>{try{localStorage.setItem(SHORT_PREF_KEY,JSON.stringify(shortPrefs));}catch{}};
  const shortExit=(()=>{
    try{
      const x=JSON.parse(sessionStorage.getItem(SHORT_PHASE_KEY)||'null');
      if(x&&Date.now()-Number(x.at)<120000 &&
        ['idle','escape','menu','discard','done'].includes(x.phase))return x;
    }catch{}
    return {phase:'idle',at:0,tries:0,lastAction:0,armed:false};
  })();
  const saveShortExit=()=>{try{
    if(shortExit.phase==='idle'&&!shortExit.armed)sessionStorage.removeItem(SHORT_PHASE_KEY);
    else sessionStorage.setItem(SHORT_PHASE_KEY,JSON.stringify(shortExit));
  }catch{}};
  const resetShortExit=()=>{
    Object.assign(shortExit,{phase:'idle',at:0,tries:0,lastAction:0,armed:false});
    saveShortExit();
  };
  const shortToggle=document.createElement('button');
  shortToggle.type='button';
  shortToggle.title='3:00 到點後再等待小王緩衝秒數，接著按 ESC → 回到主選單 → 捨棄，再自動重進';
  shortToggle.style.cssText='font:bold 11px sans-serif;padding:4px 7px;border:1px solid #c9dbed;border-radius:5px;cursor:pointer;color:white';
  const shortGrace=document.createElement('select');
  shortGrace.title='3:00 後多留幾秒打小王／撿卡。0 秒即 3:00 捨棄';
  shortGrace.style.cssText='color:#18283b;background:white;padding:3px;border-radius:4px;font:11px sans-serif;max-width:125px';
  for(const n of [0,10,20,30,45,60]){
    const op=document.createElement('option');op.value=String(n);
    op.textContent=n===0?'0秒（3:00）':'小王 +'+n+'秒';shortGrace.append(op);
  }
  shortGrace.value=String(shortPrefs.grace);
  const shortGroup=document.createElement('div');
  shortGroup.style.cssText='display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:6px';
  shortGroup.append(shortToggle,shortGrace);
  const shortHelp=document.createElement('div');
  shortHelp.style.cssText='font:10px/1.35 sans-serif;color:#e9e0c6;margin:3px 0 0';
  shortHelp.textContent='只在自動重進開啟時執行；捨棄可能影響未結算獎勵，卡片是否保留尚未確認';

  // 倍速獨立於選關、重進與三分鐘刷卡，預設每場自動啟用。
  const SPEED_AUTO_KEY='hans-ro-auto-2x-v092';
  let speedAutoEnabled=true;
  try{speedAutoEnabled=localStorage.getItem(SPEED_AUTO_KEY)!=='0'}catch{}
  const speedToggle=document.createElement('button');
  speedToggle.type='button';speedToggle.id='hans-auto-speed-2x-toggle';
  speedToggle.style.cssText='font:bold 11px sans-serif;padding:4px 7px;border:1px solid #c9dbed;border-radius:5px;cursor:pointer;color:white';
  speedToggle.title='自動將每場的1×切換為2×；已是2×時不點擊';
  const speedStatus=document.createElement('span');
  speedStatus.id='hans-auto-speed-2x-status';
  speedStatus.style.cssText='font:10px/1.3 sans-serif;color:#cce6fa;max-width:190px;overflow-wrap:anywhere';
  speedStatus.textContent='倍速：等待戰鬥';
  function speedNote(t){const v='倍速：'+t;if(speedStatus.textContent!==v)speedStatus.textContent=v;}
  function updateSpeedToggle(){
    speedToggle.textContent='每場2×：'+(speedAutoEnabled?'開':'關');
    speedToggle.style.background=speedAutoEnabled?'#146f4c':'#5c6b82';
  }
  speedToggle.addEventListener('click',()=>{
    speedAutoEnabled=!speedAutoEnabled;
    try{localStorage.setItem(SPEED_AUTO_KEY,speedAutoEnabled?'1':'0')}catch{}
    updateSpeedToggle();speedNote(speedAutoEnabled?'等待戰鬥':'已停用');
  });
  shortGroup.append(speedToggle,speedStatus);
  updateSpeedToggle();

  function updateShortControls(){
    shortToggle.textContent='3分鐘刷卡：'+(shortPrefs.enabled?'開':'關')+
      (shortPrefs.enabled?'（3:'+String(shortPrefs.grace).padStart(2,'0')+'）':'');
    shortToggle.style.background=shortPrefs.enabled?'#965420':'#5c6b82';
    shortGrace.disabled=!shortPrefs.enabled;
  }
  shortToggle.addEventListener('click',()=>{
    shortPrefs.enabled=!shortPrefs.enabled;saveShortPrefs();
    if(!shortPrefs.enabled)resetShortExit();
    updateShortControls();
    tell(shortPrefs.enabled?'三分鐘刷卡已開：下一局從開場計時':'三分鐘刷卡已關閉');
  });
  shortGrace.addEventListener('change',()=>{
    shortPrefs.grace=Number(shortGrace.value)||0;saveShortPrefs();updateShortControls();
    tell('三分鐘刷卡調整為 3:00 +'+shortPrefs.grace+'秒');
  });
  updateShortControls();

  // 自動清背包賣裝 v0.9.5：只讀模擬。
  // 嚴禁點擊商人的「一鍵販賣」、商品、勾選框或確認按鈕；
  // 此版只允許讀取已開啟的商人介面、顯示預估數量和記錄待處理狀態。
  const SELL_DRY_ENABLED_KEY='hans-ro-sell-dry-enabled-v094';
  const SELL_DRY_PENDING_KEY='hans-ro-sell-dry-pending-v094';
  const SELL_DRY_RARITIES=Object.freeze(['普通','優良','稀有','史詩','傳說']);
  const SELL_DRY_EXCLUSIONS=Object.freeze(['已裝備','已鎖定','已插卡','已精煉','卡片']);
  let sellDryEnabled=false; // 全新功能預設關閉，不繼承其他腳本的任何售賣設定
  try{sellDryEnabled=localStorage.getItem(SELL_DRY_ENABLED_KEY)==='1'}catch{}
  let sellDryPending=false,sellResultSeen=false,sellLastReport=null;
  try{
    const record=JSON.parse(sessionStorage.getItem(SELL_DRY_PENDING_KEY)||'null');
    sellDryPending=!!(sellDryEnabled&&record?.pending&&Date.now()-Number(record.time||0)<1800000);
  }catch{}
  const sellPanel=document.createElement('section');
  sellPanel.id='hans-sell-dry-panel';
  sellPanel.style.cssText='margin-top:6px;border-top:1px solid #8ca6c0;padding-top:6px;font:11px/1.45 sans-serif;color:#eef5ff';
  const sellControls=document.createElement('div');
  sellControls.style.cssText='display:flex;flex-wrap:wrap;align-items:center;gap:4px';
  const sellToggle=document.createElement('button');
  sellToggle.type='button';sellToggle.id='hans-sell-dry-toggle';
  sellToggle.style.cssText='padding:4px 7px;border:1px solid #c9dbed;border-radius:5px;font:bold 11px sans-serif;color:#fff;cursor:pointer';
  sellToggle.title='預設關閉。開啟後每場結束會暫停自動重進並等待手動打開商人介面，僅產生模擬報告，不販賣。';
  const sellPreviewButton=document.createElement('button');
  sellPreviewButton.type='button';sellPreviewButton.id='hans-sell-dry-preview';
  sellPreviewButton.textContent='預覽商人清單';
  sellPreviewButton.style.cssText='padding:4px 7px;background:#416a90;border:1px solid #c9dbed;border-radius:5px;color:white;font:11px sans-serif;cursor:pointer';
  const sellSkipButton=document.createElement('button');
  sellSkipButton.type='button';sellSkipButton.id='hans-sell-dry-skip';
  sellSkipButton.textContent='跳過本場';
  sellSkipButton.style.cssText='padding:4px 7px;background:#665866;border:1px solid #c9dbed;border-radius:5px;color:white;font:11px sans-serif;cursor:pointer';
  sellSkipButton.hidden=true;
  const sellInfo=document.createElement('div');
  sellInfo.id='hans-sell-dry-info';
  sellInfo.style.cssText='margin-top:4px;overflow-wrap:anywhere';
  const sellDetails=document.createElement('details');
  const sellSummary=document.createElement('summary');
  sellSummary.textContent='模擬規則與保護條件';
  sellDetails.append(sellSummary);
  const sellRules=document.createElement('div');
  sellRules.style.cssText='font:10px/1.4 sans-serif;margin-top:3px;color:#d5e6f4';
  sellRules.textContent='觸發：每場正常結束｜允許品質：'+SELL_DRY_RARITIES.join('、')+
    '｜一律排除：'+SELL_DRY_EXCLUSIONS.join('、')+
    '｜只讀模式：不移動、不選取、不賣出。未取得逐件保護狀態時，安全可賣數量維持「未確認」。';
  sellDetails.append(sellRules);
  sellControls.append(sellToggle,sellPreviewButton,sellSkipButton);
  sellPanel.append(sellControls,sellInfo,sellDetails);

  function saveSellDryPending(){
    try{
      if(sellDryPending)sessionStorage.setItem(SELL_DRY_PENDING_KEY,JSON.stringify({pending:true,time:Date.now()}));
      else sessionStorage.removeItem(SELL_DRY_PENDING_KEY);
    }catch{}
  }
  function sellNote(message){const text='賣裝模擬：'+message;if(sellInfo.textContent!==text)sellInfo.textContent=text;}
  function updateSellDryControls(){
    sellToggle.textContent='清背包：'+(sellDryEnabled?'開':'關')+'（模擬）';
    sellToggle.style.background=sellDryEnabled?'#165e54':'#5c6b82';
    sellSkipButton.hidden=!sellDryPending;
    if(!sellDryEnabled&&!sellLastReport)sellNote('功能關閉，無販賣操作');
    else if(sellDryPending&&!sellLastReport)sellNote('本場待模擬：回城後手動開啟商人「販賣」頁');
    else if(!sellLastReport)sellNote('每場結束觸發；僅讀取已開啟的商人頁');
  }
  sellToggle.addEventListener('click',()=>{
    sellDryEnabled=!sellDryEnabled;
    try{localStorage.setItem(SELL_DRY_ENABLED_KEY,sellDryEnabled?'1':'0')}catch{}
    if(!sellDryEnabled){sellDryPending=false;saveSellDryPending();}
    sellLastReport=null;updateSellDryControls();
  });
  sellSkipButton.addEventListener('click',()=>{
    sellDryPending=false;saveSellDryPending();sellLastReport=null;
    updateSellDryControls();sellNote('已跳過本場，未販賣任何裝備');
  });

  // 只讀尋找商人的「一鍵販賣」設定區。其他遊戲商店或腳本的按鈕不符合條件。
  function findSellDryMerchantPanel(){
    const labels=document.querySelectorAll('div,span,label,b,strong');
    for(const leaf of labels){
      if(leaf.childElementCount>1||!shown(leaf)||hud.contains(leaf)||
        leaf.closest('#'+UI_ID+',#hans-independent-zoom-panel'))continue;
      const heading=norm(leaf.textContent||'');
      if(heading.length>24||!heading.includes('一鍵販賣'))continue;
      for(let root=leaf,depth=0;root&&depth<8;root=root.parentElement,depth++){
        if(root===document.body)break;
        const text=String(root.innerText||root.textContent||'');
        if(text.length>9000)break;
        if(text.includes('一鍵販賣') && text.includes('普通')&&text.includes('優良') &&
          text.includes('傳說') && /包含已插卡|已插卡/u.test(text) &&
          /包含已精煉|已精煉/u.test(text))return root;
      }
    }
    return null;
  }

  // 由商人介面的「一鍵販賣」列讀品質計數，不讀取卡片數、不勾選任何東西。
  // 品質計數只是遊戲 UI 的候選摘要，不代表每件都已驗證裝備/鎖定/插卡/精煉屬性。
  function readSellDryQualityCounts(merchant){
    const text=String(merchant.innerText||merchant.textContent||'').normalize('NFKC');
    const pos=text.indexOf('一鍵販賣');
    const area=(pos>=0?text.slice(pos,pos+550):'').replace(/\s+/g,'');
    const counts={},missing=[];
    for(const grade of SELL_DRY_RARITIES){
      const match=area.match(new RegExp(grade+'(\\d+)','u'));
      if(match)counts[grade]=Number(match[1]);
      else missing.push(grade);
    }
    return {counts,missing,source:area.slice(0,200)};
  }
  function readSellDryCheck(merchant,keyword){
    const labels=merchant.querySelectorAll('label');
    for(const el of labels){
      if(!norm(el.textContent||'').includes(keyword))continue;
      let checkbox=el.querySelector('input[type="checkbox"]');
      if(!checkbox&&el.htmlFor){
        const linked=document.getElementById(el.htmlFor);
        if(linked?.type==='checkbox')checkbox=linked;
      }
      if(checkbox)return checkbox.checked===true;
    }
    return null; // 未能證明開關關閉時，不將物品列為可安全售出
  }
  function previewSellDryMerchant(auto=false){
    const merchant=findSellDryMerchantPanel();
    if(!merchant){
      sellNote('找不到商人「販賣」頁；請手動開啟，再按「預覽商人清單」');
      return false;
    }
    const data=readSellDryQualityCounts(merchant);
    const carded=readSellDryCheck(merchant,'包含已插卡');
    const refined=readSellDryCheck(merchant,'包含已精煉');
    const summary=SELL_DRY_RARITIES.map(g=>g+' '+(Number.isFinite(data.counts[g])?data.counts[g]:'?')).join('｜');
    const observed=Object.values(data.counts).reduce((a,n)=>a+n,0);
    // 不以品質合計值冒充「安全可賣」：缺少逐件的裝備/保護/插卡/精煉判斷。
    const warnings=[];
    if(data.missing.length)warnings.push('缺少品質數量：'+data.missing.join('、'));
    if(carded!==false)warnings.push(carded===true?'商人含已插卡已勾選':'無法確認排除插卡狀態');
    if(refined!==false)warnings.push(refined===true?'商人含已精煉已勾選':'無法確認排除精煉狀態');
    const report={at:new Date().toISOString(),type:'dry-run',trigger:auto?'每場結束':'手動預覽',
      allowed:[...SELL_DRY_RARITIES],excluded:[...SELL_DRY_EXCLUSIONS],
      counts:data.counts,qualitySum:data.missing.length?null:observed,
      safeToSell:'未確認（逐件保護資訊不足）',
      warnings,actualSold:0};
    sellLastReport=report;
    sellNote((auto?'每場結束':'手動')+'模擬完成｜'+summary+'｜品質候選合計：'+
      (report.qualitySum??'不完整')+'｜安全可賣：未確認｜實際販賣 0'+
      (warnings.length?'｜注意：'+warnings.join('、'):''));
    console.info('[HANS 清背包／只讀模擬] 未操作商人與商品；報告',report);
    if(auto||sellDryPending){sellDryPending=false;saveSellDryPending();}
    updateSellDryControls();
    return true;
  }
  sellPreviewButton.addEventListener('click',()=>previewSellDryMerchant(false));
  function markSellDryAtResult(){
    if(!sellDryEnabled||sellDryPending)return;
    sellDryPending=true;sellLastReport=null;
    saveSellDryPending();updateSellDryControls();
    sellNote('本場已結束；等待回城手動開啟商人頁，僅模擬不販賣');
  }
  let sellDryPollLast=0;
  function sellDryTick(){
    if(document.hidden||!sellDryEnabled)return;
    const now=Date.now();
    // 結算畫面觸發一次，進下一場時再解除同局旗標。
    if(resultVisible()){
      if(!sellResultSeen){sellResultSeen=true;markSellDryAtResult();}
    }else{
      const mini=document.querySelector('#minimap');
      if(mini&&shown(mini))sellResultSeen=false;
    }
    if(sellDryPending && now-sellDryPollLast>1100){
      sellDryPollLast=now;
      if(findSellDryMerchantPanel())previewSellDryMerchant(true);
    }
  }
  updateSellDryControls();
  setInterval(()=>{
    try{sellDryTick()}catch(e){console.warn('[HANS 清背包模擬] 掃描失敗',e);}
  },850);

  // 所有元件完成初始化後才顯示：選關、重進與 3 分鐘模式必須同時在右下角出現。
  btn.id='hans-auto-reentry-toggle';
  picker.id='hans-auto-stage-picker';
  shortToggle.id='hans-short-run-toggle';
  shortGrace.id='hans-short-run-grace';
  const zoomStatus=document.createElement('div');
  zoomStatus.id='hans-entry-wheel-status';
  zoomStatus.style.cssText='margin-top:5px;color:#c7e9ff;font:11px/1.35 sans-serif';
  zoomStatus.textContent='入場滾輪：等待進場（下滾10次）';
  const zoomTestButton=document.createElement('button');
  zoomTestButton.type='button';
  zoomTestButton.id='hans-test-wheel';
  zoomTestButton.textContent='測試下滾10次';
  zoomTestButton.title='請先在戰鬥畫面親自向下滾一次校準落點；此按鈕測試送出10次合成滾輪，若無視角變化可能是遊戲不接受非可信事件';
  zoomTestButton.style.cssText='margin:5px 0 0;color:white;background:#496f98;padding:5px 8px;border:1px solid #a7c7ed;border-radius:5px;font:12px sans-serif;cursor:pointer';
  // 視角功能獨立於選關、戰利品、三分鐘刷卡；關閉後只停用自動縮遠，仍可手動測試。
  const ZOOM_TOGGLE_KEY='hans-ro-auto-zoom-v086';
  let zoomAutoEnabled=true;
  try{zoomAutoEnabled=localStorage.getItem(ZOOM_TOGGLE_KEY)!=='0';}catch{}
  const zoomPanel=document.createElement('section');
  zoomPanel.id='hans-independent-zoom-panel';
  // 原本左下角 z-index 比其他腳本低，導致開關被蓋住、無法點擊。
  // 此版在右上角以最高層級顯示；整個面板可以拖曳到任何不擋遊戲的位置。
  zoomPanel.style.cssText='position:fixed;top:88px;left:8px;right:auto;bottom:auto;z-index:2147483647 !important;box-sizing:border-box;width:184px;max-width:calc(100vw - 16px);background:#172a3bf5;color:#fff;border:1px solid #88c1e4;border-radius:8px;padding:7px 8px;box-shadow:0 4px 14px #0009;font:12px/1.4 sans-serif;pointer-events:auto;user-select:none';
  const zoomHandle=document.createElement('div');
  zoomHandle.textContent='⠿ 視角縮遠工具・拖曳移動';
  zoomHandle.title='按住這一行可拖曳，避開其他腳本按鈕';
  zoomHandle.style.cssText='padding:3px 2px 7px;cursor:move;color:#e0f3ff;font:bold 11px/1.3 sans-serif;touch-action:none';
  const zoomToggleButton=document.createElement('button');
  zoomToggleButton.type='button';zoomToggleButton.id='hans-independent-zoom-toggle';
  zoomToggleButton.style.cssText='display:block;width:100%;box-sizing:border-box;min-height:33px;padding:6px 7px;border-radius:6px;color:white;border:1px solid #9abacf;cursor:pointer;font:bold 12px sans-serif;pointer-events:auto;touch-action:manipulation';
  zoomTestButton.textContent='立即縮遠 10 次';
  zoomTestButton.style.cssText='display:block;width:100%;box-sizing:border-box;margin:5px 0 0;min-height:33px;color:white;background:#496f98;padding:6px 7px;border:1px solid #a7c7ed;border-radius:5px;font:12px sans-serif;cursor:pointer;pointer-events:auto;touch-action:manipulation';
  zoomStatus.style.cssText='display:block;margin-top:5px;color:#c7e9ff;font:10px/1.3 sans-serif;overflow-wrap:anywhere;max-height:42px;overflow:hidden;user-select:text';
  zoomPanel.append(zoomHandle,zoomToggleButton,zoomTestButton,zoomStatus);
  document.body.append(zoomPanel);

  const ZOOM_PANEL_POSITION_KEY='hans-ro-zoom-panel-position-v087';
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  function placeZoomPanel(x,y){
    const w=zoomPanel.offsetWidth||184,h=zoomPanel.offsetHeight||130;
    zoomPanel.style.left=clamp(Math.round(x),6,Math.max(6,innerWidth-w-6))+'px';
    zoomPanel.style.top=clamp(Math.round(y),6,Math.max(6,innerHeight-h-6))+'px';
  }
  let savedZoomPosition=null;
  try{savedZoomPosition=JSON.parse(localStorage.getItem(ZOOM_PANEL_POSITION_KEY)||'null')}catch{}
  placeZoomPanel(
    Number.isFinite(savedZoomPosition?.x)?savedZoomPosition.x:innerWidth-196,
    Number.isFinite(savedZoomPosition?.y)?savedZoomPosition.y:88
  );
  function saveZoomPanelPosition(){
    try{localStorage.setItem(ZOOM_PANEL_POSITION_KEY,JSON.stringify({
      x:parseFloat(zoomPanel.style.left)||6,y:parseFloat(zoomPanel.style.top)||6
    }))}catch{}
  }
  let dragZoom=null;
  zoomHandle.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    e.preventDefault();e.stopPropagation();
    dragZoom={id:e.pointerId,x:e.clientX,y:e.clientY,
      left:parseFloat(zoomPanel.style.left)||0,top:parseFloat(zoomPanel.style.top)||0};
    zoomHandle.setPointerCapture(e.pointerId);
  });
  zoomHandle.addEventListener('pointermove',e=>{
    if(!dragZoom||dragZoom.id!==e.pointerId)return;
    e.preventDefault();e.stopPropagation();
    placeZoomPanel(dragZoom.left+e.clientX-dragZoom.x,dragZoom.top+e.clientY-dragZoom.y);
  });
  function stopZoomDrag(e){
    if(!dragZoom||dragZoom.id!==e.pointerId)return;
    e.stopPropagation();dragZoom=null;saveZoomPanelPosition();
  }
  zoomHandle.addEventListener('pointerup',stopZoomDrag);
  zoomHandle.addEventListener('pointercancel',stopZoomDrag);
  zoomPanel.addEventListener('click',e=>e.stopPropagation());
  zoomPanel.addEventListener('pointerdown',e=>e.stopPropagation());
  zoomPanel.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
  window.addEventListener('resize',()=>{
    placeZoomPanel(parseFloat(zoomPanel.style.left)||6,parseFloat(zoomPanel.style.top)||6);
    saveZoomPanelPosition();
  });
  function updateZoomToggle(){
    zoomToggleButton.textContent='自動縮遠：'+(zoomAutoEnabled?'開':'關');
    zoomToggleButton.style.background=zoomAutoEnabled?'#176b51':'#6c4750';
  }
  updateZoomToggle();
  zoomToggleButton.addEventListener('click',()=>{
    zoomAutoEnabled=!zoomAutoEnabled;
    try{localStorage.setItem(ZOOM_TOGGLE_KEY,zoomAutoEnabled?'1':'0');}catch{}
    updateZoomToggle();
    if(!zoomAutoEnabled){
      zoomInProgress=false;
      clearZoomPending();
      zoomNote('已關閉自動縮遠；仍可手動測試');
    } else {
      zoomNote('已開啟自動縮遠，下次進場執行');
      if(mapReadyForZoom())queueZoom();
    }
  });
  hud.append(btn,worldPicker,picker,shortGroup,shortHelp,sellPanel,msg);
  mountStageIntoLootPanel();
  const uiElements=[btn,worldPicker,picker,shortToggle,shortGrace,sellToggle,sellPreviewButton];
  if(uiElements.some(el=>!hud.contains(el)) || hud.parentElement?.id!=='roj4-menu'){
    throw new Error('右下角選關／3分鐘刷卡元件未能正常掛載');
  }
  console.info('[HANS 選關＋戰利品] 已掛載右下角選關、重進、3分鐘刷卡四項控制');
  // 從上方中央的遊戲計時 HUD 取值，不能把主城的 00:xx、選卡或現實時間當戰鬥時間。
  function readCombatSeconds(){
    const mini=document.querySelector('#minimap'),coords=document.querySelector('#minimap-coords');
    if(!((mini&&shown(mini))||(coords&&shown(coords))))return null;
    let best=null;
    for(const e of document.querySelectorAll('span,b,strong,time,div')){
      if(e.children.length>2||hud.contains(e)||e.closest('#'+UI_ID))continue;
      const m=/^(\d{1,2}):([0-5]\d)$/.exec(String(e.textContent||'').trim());
      if(!m||!shown(e))continue;
      const r=rct(e),x=r.left+r.width/2,y=r.top+r.height/2;
      if(r.width<12||r.width>185||r.height<8||r.height>75)continue;
      if(x<innerWidth*.30||x>innerWidth*.70||y>Math.min(150,innerHeight*.24))continue;
      const secs=Number(m[1])*60+Number(m[2]);
      if(secs>20*60)continue;
      const score=Math.abs(x-innerWidth/2)+Math.abs(y-25);
      if(!best||score<best.score)best={secs,score};
    }
    return best?.secs??null;
  }
  function textHeadingVisible(re){
    return [...document.querySelectorAll('h1,h2,h3,h4,header,div,span')].some(e=>
      shown(e)&&!hud.contains(e)&&e.children.length<2&&
      (e.textContent||'').length<80&&re.test(norm(e.textContent||'')));
  }
  function incompleteDialog(){
    return !!findControl(/^(?:捨棄|舍弃)$/i)&&textHeadingVisible(/未完成的一局/);
  }
  function pauseDialog(){
    return !!findControl(/^(?:回到主選單|回主選單|返回主選單)$/i)&&
      textHeadingVisible(/暫停/);
  }
  function sendEsc(){
    const evt={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
    document.dispatchEvent(new KeyboardEvent('keydown',evt));
    document.dispatchEvent(new KeyboardEvent('keyup',evt));
  }
  function shortPhase(phase){
    shortExit.phase=phase;shortExit.at=Date.now();shortExit.lastAction=0;shortExit.tries=0;
    saveShortExit();
  }
  function shortFail(reason){
    tell(reason+'，已停止自動重進避免誤按');
    enable(false);
  }
  function handleShortRun(){
    if(!shortPrefs.enabled||!active)return false;
    const now=Date.now(),incomplete=incompleteDialog(),paused=pauseDialog();
    if(shortExit.phase==='done'){
      if(incomplete){tell('已點捨棄，等待確認視窗關閉');return true;}
      if(now-shortExit.at>18000){shortFail('捨棄後沒有返回主城');return true;}
      if(findControl(W.talk)||expeditionOpen()||difficultyOpen()){
        resetShortExit();return false;
      }
      tell('等待主城載入');return true;
    }
    if(shortExit.phase==='discard'){
      if(incomplete){
        const discard=findControl(/^(?:捨棄|舍弃)$/i);
        if(discard&&shown(discard)&&now-shortExit.lastAction>1000&&shortExit.tries<3){
          shortExit.tries++;shortExit.lastAction=now;saveShortExit();
          discard.click();shortPhase('done');
          tell('已按捨棄，準備重進同一關');return true;
        }
      }else if(paused){shortPhase('menu');return true;}
      if(now-shortExit.at>20000)shortFail('未完成的一局沒有顯示捨棄按鈕');
      else tell('等待未完成的一局 → 捨棄');
      return true;
    }
    if(shortExit.phase==='menu'){
      if(incomplete){shortPhase('discard');return true;}
      const toMain=findControl(/^(?:回到主選單|回主選單|返回主選單)$/i);
      if(paused&&toMain&&now-shortExit.lastAction>1200&&shortExit.tries<3){
        shortExit.tries++;shortExit.lastAction=now;saveShortExit();
        stageLootBridge.settleShortRun(shortExit.gameSeconds||180,targetLabel());
        toMain.click();shortPhase('discard');
        tell('已按回到主選單，等待捨棄');return true;
      }
      if(now-shortExit.at>20000)shortFail('回到主選單沒有反應');
      return true;
    }
    if(shortExit.phase==='escape'){
      if(paused){shortPhase('menu');return true;}
      if(now-shortExit.lastAction>1600&&shortExit.tries<4&&readCombatSeconds()!==null){
        shortExit.tries++;shortExit.lastAction=now;saveShortExit();sendEsc();
        tell('已送 ESC '+shortExit.tries+'/4，等待暫停畫面');
      }
      if(now-shortExit.at>12000)shortFail('ESC 未開啟暫停選單');
      return true;
    }
    // 其他視窗、正常結算和玩家手動暫停時都不應退出副本。
    if(incomplete){tell('偵測到手動未完成的一局，等待玩家處理');return true;}
    if(paused)return true;
    if(resultVisible()||difficultyOpen()||expeditionOpen()||findControl(W.back)||
       findControl(W.talk)||document.hidden)return false;
    const pickerPopup=document.querySelector('#picker');
    if(pickerPopup&&shown(pickerPopup))return false;
    const secs=readCombatSeconds();
    if(secs===null)return false;
    if(secs<=45&&!shortExit.armed){shortExit.armed=true;shortExit.at=Date.now();saveShortExit();}
    if(!shortExit.armed){tell('3分鐘刷卡待命：下一場開局才開始');return false;}
    if(secs<180+shortPrefs.grace)return false;
    // 3分鐘巡走若正在尋找第二顆磁鐵，最多等到3:55才捨棄，
    // 避免原本的3:20定時捨棄在撿磁鐵前發生。超時或回報中斷則恢復原流程。
    let magnetStatus=null;
    try{magnetStatus=JSON.parse(sessionStorage.getItem('hans_ro_three_min_magnet_sync_v1')||'null');}catch{}
    if(secs>=180 && secs<235 && magnetStatus?.enabled===true &&
       magnetStatus.phase!=='done' && Date.now()-Number(magnetStatus.updatedAt)<6000){
      tell('3分鐘巡走正在處理第二顆磁鐵，暫緩捨棄（最晚3:55）');
      return false;
    }
    shortExit.gameSeconds=secs;shortPhase('escape');
    shortExit.tries=1;shortExit.lastAction=Date.now();saveShortExit();
    sendEsc();
    tell('已達 '+Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0')+'，送 ESC 準備捨棄');
    return true;
  }

  // 進圖後自動下滾：不改遊戲縮放 CSS，只送出與滑鼠滾輪方向相同的事件。
  // +deltaY = 向下滾；遊戲本身決定是放大還是縮小視角。
  const ZOOM_PENDING_KEY = 'hh-ro-expedition-enter-field-zoom-v18';
  const ZOOM_STEPS = 10;
  const ZOOM_DELTA = 160;
  const ZOOM_STEP_INTERVAL = 400;
  const ZOOM_READY_DELAY = 3000; // 真正顯示戰鬥地圖連續3秒後才送出
  const ZOOM_MAX_WAIT = 90000;
  let pendingZoomAt = 0, zoomInProgress = false, zoomMapReadyAt = 0;
  let zoomSent=0,zoomSessionId=0,zoomMapState='',forceZoom=false;
  function zoomNote(message){
    const text='入場滾輪：'+message;
    if(zoomStatus.textContent!==text)zoomStatus.textContent=text;
  }
  // 重進後不一定會經過舊版「前往野外」按鈕：監測新一局戰鬥計時作第二道觸發。
  let combatSeen=false, combatLastSeconds=null, combatZoomQueued=false, zoomMapWasVisible=false;
  function readZoomPending() {
    try {
      const ts=Number(sessionStorage.getItem(ZOOM_PENDING_KEY));
      if(Number.isFinite(ts) && ts>0 && Date.now()-ts < ZOOM_MAX_WAIT) return ts;
      sessionStorage.removeItem(ZOOM_PENDING_KEY);
    } catch {}
    return 0;
  }
  pendingZoomAt=readZoomPending();
  if(pendingZoomAt)zoomNote('已保留前次入場排程，等待地圖');
  function queueZoom(force=false) {
    if(!zoomAutoEnabled && !force)return;
    if(zoomInProgress){zoomNote('已在下滾中，不重複執行');return;}
    if(!force&&pendingZoomAt && Date.now()-pendingZoomAt < ZOOM_MAX_WAIT)return;
    pendingZoomAt=Date.now();
    zoomMapReadyAt=0;zoomSent=0;zoomSessionId++;forceZoom=!!force;
    zoomNote((force?'手動測試：':'新局：')+'排程下滾 '+ZOOM_STEPS+' 次');
    try{sessionStorage.setItem(ZOOM_PENDING_KEY,String(pendingZoomAt));}catch{}
  }
  zoomTestButton.addEventListener('click',()=>{
    if(!mapReadyForZoom()){
      zoomNote('測試失敗：須在無選卡／暫停的戰鬥畫面');
      return;
    }
    combatSeen=true;combatZoomQueued=true;
    queueZoom(true);
    zoomMapReadyAt=Date.now()-ZOOM_READY_DELAY-50; // 手動測試仍尊重排程最低等待
    checkEntryZoom();
  });
  function clearZoomPending() {
    pendingZoomAt=0;
    zoomMapReadyAt=0;
    try{sessionStorage.removeItem(ZOOM_PENDING_KEY);}catch{}
  }
  function mapReadyForZoom() {
    // 獨立模組不依賴選關按鈕／計時器，主要以戰鬥小地圖為準；
    // 仍避開已知結算、暫停與升級選卡視窗，避免誤縮放。
    if(document.hidden || resultVisible() || pauseDialog() ||
      highDifficultyPrompt() || incompleteDialog() ||
      difficultyOpen() || expeditionOpen() ||
      shown(document.querySelector('#picker')))return false;
    const mini=document.querySelector('#minimap'),coords=document.querySelector('#minimap-coords');
    if(mini&&shown(mini)){
      const r=rct(mini);
      if(r.width>=60 && r.height>=55)return true;
    }
    return !!(coords&&shown(coords));
  }
  function monitorNewRoundZoom() {
    if(!zoomAutoEnabled)return;
    // 不把 HUD 計時器視為唯一的進場證據：有些載入畫面計時文字會缺失。
    const leftCombat=resultVisible() || difficultyOpen() || expeditionOpen() ||
      highDifficultyPrompt() || incompleteDialog() ||
      !!findControl(W.back) || !!findControl(W.talk);
    if(leftCombat){
      combatSeen=false;combatZoomQueued=false;combatLastSeconds=null;zoomMapWasVisible=false;
      return;
    }
    const mini=document.querySelector('#minimap'), coords=document.querySelector('#minimap-coords');
    const hasMap=!!((mini&&shown(mini))||(coords&&shown(coords)));
    // 短暫選卡/暫停時不要把同一局誤認為新局。
    if(!hasMap){
      zoomMapWasVisible=false;combatSeen=false;combatZoomQueued=false;combatLastSeconds=null;
      return;
    }
    if(!mapReadyForZoom())return;
    const seconds=readCombatSeconds();
    const timerRestarted=seconds!==null && combatLastSeconds!==null &&
      seconds<=20 && seconds+20<combatLastSeconds;
    const newRound=!zoomMapWasVisible || !combatSeen || timerRestarted;
    zoomMapWasVisible=true;combatSeen=true;
    if(seconds!==null)combatLastSeconds=seconds;
    if(newRound)combatZoomQueued=false;
    if(!combatZoomQueued){
      combatZoomQueued=true;
      if(!pendingZoomAt&&!zoomInProgress){
        queueZoom();
        zoomNote('偵測到戰鬥畫面'+(seconds!==null?' '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'（未讀到計時器）')+'，等待下滾');
      }
    }
  }
  // 只記錄使用者真正滾輪時的畫面位置，不攔截、不改變原始滾輪行為。
  // 合成 WheelEvent 的 isTrusted 為 false，若遊戲拒絕非可信事件，腳本不能偽造實體滑鼠。
  const ZOOM_POINT_KEY='hans-ro-zoom-calibrated-point-v085';
  let zoomPoint=null;
  try{
    const v=JSON.parse(localStorage.getItem(ZOOM_POINT_KEY)||'null');
    if(v && Number.isFinite(v.x)&&Number.isFinite(v.y)&&v.x>=0&&v.x<=1&&v.y>=0&&v.y<=1)zoomPoint=v;
  }catch{}
  window.addEventListener('wheel',e=>{
    if(!e.isTrusted || e.deltaY<=0 || !mapReadyForZoom())return;
    const x=Math.max(0,Math.min(innerWidth-1,e.clientX));
    const y=Math.max(0,Math.min(innerHeight-1,e.clientY));
    const el=document.elementFromPoint(x,y);
    if(!el || hud.contains(el) || el.closest('#minimap,#picker,#roj4-menu'))return;
    zoomPoint={x:x/innerWidth,y:y/innerHeight};
    try{localStorage.setItem(ZOOM_POINT_KEY,JSON.stringify(zoomPoint));}catch{}
    zoomNote('已記錄真實向下滾輪位置；下次將使用相同落點');
  },{capture:true,passive:true});
  function zoomCanvas() {
    // 優先使用使用者真實滾輪的落點；沒有校準才使用畫面中心。
    // HANS 使用 Three.js，滑鼠滾輪可能繫結在畫面上的 DOM 事件路徑，而非 canvas 本身。
    const centerElement=document.elementFromPoint(Math.floor(innerWidth*.50),Math.floor(innerHeight*.50));
    if(centerElement && !hud.contains(centerElement) &&
      !centerElement.closest('#minimap,#picker,#roj4-menu'))return centerElement;
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
  // 若遊戲公開了 OrbitControls 物件，直接呼叫控制器（不用偽造滑鼠事件）。
  // 不掃描私有閉包、不竄改遊戲狀態；找不到公開控制器即退回 WheelEvent。
  // HANS 為瀏覽器遊戲；合成事件不能偽裝成真實滑鼠（isTrusted 永遠是 false）。
  // 避免將沙盒 window 物件傳入 WheelEvent 的 view，某些 Tampermonkey 隔離環境會直接拋 TypeError。
  function directCameraZoomOut() {
    try{
      const roots=[window.hansGame,window.roGame,window.game,window.gameEngine,
        window.__HANS_GAME__,window.__RO_GAME__];
      for(const root of roots){
        try{
          if(!root || typeof root!=='object')continue;
          const c=root.orbitControls||root.cameraControls||root.controls;
          if(!c || !c.object || !(c.object.isCamera || c.object.isPerspectiveCamera || c.object.isOrthographicCamera)
             || c.enabled===false || c.enableZoom===false || typeof c.dollyOut!=='function')continue;
          c.dollyOut(1.12);if(typeof c.update==='function')c.update();
          return true;
        }catch(e){console.debug('[HANS Zoom] 公開鏡頭 API 不適用，使用滾輪備援',e);}
      }
    }catch(e){console.debug('[HANS Zoom] 讀取公開鏡頭失敗，使用滾輪備援',e);}
    return false;
  }
  let directZoomUsed=false,zoomEventMode='尚未發送';
  function emitDownWheel(target) {
    if(directCameraZoomOut()){directZoomUsed=true;zoomEventMode='公開鏡頭控制器';return;}
    const r=rct(target);
    const fallbackX=Math.round(r.left+r.width/2),fallbackY=Math.round(r.top+r.height/2);
    const x=Math.max(1,Math.min(innerWidth-2,zoomPoint?Math.round(zoomPoint.x*innerWidth):fallbackX));
    const y=Math.max(1,Math.min(innerHeight-2,zoomPoint?Math.round(zoomPoint.y*innerHeight):fallbackY));
    const hit=document.elementFromPoint(x,y);
    const dest=hit && !hud.contains(hit) && !hit.closest('#minimap,#picker,#roj4-menu,#hans-independent-zoom-panel')?hit:target;
    const init={bubbles:true,cancelable:true,composed:true,
      deltaX:0,deltaY:ZOOM_DELTA,deltaZ:0,deltaMode:0,clientX:x,clientY:y};
    let event=null,constructedBy='';
    const errs=[];
    // 正常路徑：用 DOM 所屬 window 的建構子，完全不帶 view（防跨 realm TypeError）。
    const constructors=[document.defaultView?.WheelEvent,window.WheelEvent].filter(Boolean);
    for(const Ctor of [...new Set(constructors)]){
      try{event=new Ctor('wheel',init);constructedBy='WheelEvent';break;}
      catch(e){errs.push(String(e?.message||e));}
    }
    // 次要路徑：若 isolated world 不支援 WheelEvent，就用 Event 附上標準 delta 屬性。
    if(!event){
      try{
        const Ctor=document.defaultView?.Event||window.Event;
        event=new Ctor('wheel',{bubbles:true,cancelable:true,composed:true});
        Object.defineProperties(event,{
          deltaX:{value:0},deltaY:{value:ZOOM_DELTA},deltaZ:{value:0},
          deltaMode:{value:0},clientX:{value:x},clientY:{value:y}
        });
        constructedBy='Event 備援';
      }catch(e){errs.push(String(e?.message||e));}
    }
    if(!event)throw new Error('無法建立 wheel 事件：'+errs.join(' / ').slice(0,140));
    try{
      dest.dispatchEvent(event);
      zoomEventMode=constructedBy;
    }catch(e){throw new Error('dispatchEvent：'+String(e?.message||e));}
  }
  function checkEntryZoom() {
    if(!pendingZoomAt || zoomInProgress)return;
    if(!zoomAutoEnabled && !forceZoom){clearZoomPending();return;}
    if(Date.now()-pendingZoomAt>ZOOM_MAX_WAIT){
      clearZoomPending();zoomNote('逾時，未找到可操作戰鬥畫面');tell('進圖逾時，未執行滾輪');return;
    }
    // 等地圖連續保持可見3秒，避免初次載入時尚未註冊滾輪事件。
    if(document.hidden || !mapReadyForZoom()) {
      zoomMapReadyAt=0;
      zoomNote('等待戰鬥地圖或升級畫面關閉');
      return;
    }
    if(!zoomMapReadyAt){zoomMapReadyAt=Date.now();zoomNote('偵測到戰鬥地圖，準備下滾');}
    if(Date.now()-zoomMapReadyAt<ZOOM_READY_DELAY || Date.now()-pendingZoomAt<ZOOM_READY_DELAY)return;
    zoomInProgress=true;directZoomUsed=false;zoomEventMode='尚未發送';
    // 縮放完成後才清除排程；若升級翻牌短暫蓋住遊戲，繼續等待再滾，不直接丟失。
    let count=0, startedAt=Date.now();
    tell(`已進地圖，開始向下滾輪 ${ZOOM_STEPS} 次`);
    function step(){
      if(!zoomAutoEnabled && !forceZoom){zoomInProgress=false;clearZoomPending();zoomNote('自動縮遠已關閉');return;}
      if(document.hidden || !mapReadyForZoom()){
        if(Date.now()-startedAt<25000){setTimeout(step,ZOOM_STEP_INTERVAL);return;}
        zoomInProgress=false;
        clearZoomPending();
        zoomNote('中止：戰鬥畫面超過25秒不可操作');
        tell('下滾中止：25秒內無法持續操作遊戲畫面');return;
      }
      try{
        const target=zoomCanvas();
        emitDownWheel(target);
      }catch(e){
        console.warn('[HANS v0.8.8] 滾輪事件發送失敗',e);
        zoomInProgress=false;clearZoomPending();
        const problem=String(e?.name||'Error')+': '+String(e?.message||e);
        zoomNote('失敗：'+problem.slice(0,115));
        zoomStatus.title=problem;
        tell('滾輪失敗：'+problem.slice(0,95));return;
      }
      count++;zoomSent=count;
      zoomNote('縮遠 '+count+'/'+ZOOM_STEPS+' 次｜'+zoomEventMode+(zoomPoint?'｜已校準':'')+'（視角待實測）');
      tell(`進圖下滾：${count}/${ZOOM_STEPS}（實際視角需遊戲確認）`);
      if(count < ZOOM_STEPS){setTimeout(step,ZOOM_STEP_INTERVAL);}
      else{zoomInProgress=false;clearZoomPending();
        zoomNote((forceZoom?'手動測試':'本局')+'發送 '+ZOOM_STEPS+' 次｜'+zoomEventMode+'（視角待確認）');
        directZoomUsed=false;
        forceZoom=false;
        tell(`本局已送出 ${ZOOM_STEPS} 次下滾事件`);}
    }
    step();
  }
  // 即使出發後整頁重新載入，也能以 sessionStorage 恢復這一次的視角調整。
  setInterval(()=>{
    try{monitorNewRoundZoom();checkEntryZoom();}
    catch(e){console.warn('[HANS 整合選關] 重進滾輪偵測失敗',e);}
  },350);
  function tell(s) {if (msg.textContent!==s) {msg.textContent=s;console.info('[HANS 整合選關]',s);}}
  function phase(p) {
    if (state===p) return;
    state=p; attempts={}; lastAt=0;stageClickedAt=0;beforeStageWasStory=false;departAt=0;wildernessAt=0;
  }
  function enable(value,{remember=true}={}) {
    active=value;clearInterval(timer);phase('');
    if(remember)try{sessionStorage.setItem(REENTRY_KEY,value?'1':'0');}catch{}
    if(!active)resetShortExit();
    btn.textContent=`重進：${active?'開':'關'}（Shift+5）`;
    btn.style.background=active?'#146f4c':'#5c6b82';
    const mini=document.getElementById('roj4-stage-mini');
    if(mini)mini.textContent=`重進：${active?'開':'關'}`;
    tell(active?'已開啟，目標：'+targetLabel():'已關閉');
    if(active){timer=setInterval(tick,450);tick();}
  }
  btn.addEventListener('click',()=>enable(!active));
  worldPicker.addEventListener('change',()=>{
    try{localStorage.setItem(WORLD_KEY,worldPicker.value)}catch{}
    redrawStageChoices();resetCatalog();catalog.world=null;phase('');
    tell('已切換'+WORLD_NAMES[chosenWorld()]+'，直接選關；未驗證地圖會在出征前確認');
  });
  picker.addEventListener('change',()=>{
    const stage=targetStage();if(!stage||stage.unlocked===false)return;
    worldSelections[String(chosenWorld())]=picker.value;
    try{
      localStorage.setItem(WORLD_TARGETS_KEY,JSON.stringify(worldSelections));
      if(chosenWorld()===1)localStorage.setItem(SELECT_KEY,picker.value);
    }catch{}
    phase('');tell('目標已切換：'+targetLabel());
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

  // 遠征左上角的一至五周目按鈕。必須驗證選中狀態，才可自動出征。
  function worldTabs(){
    const tabs={};
    for(const el of document.querySelectorAll('button,[role="button"]')){
      if(hud.contains(el)||!shown(el))continue;
      const m=norm(el.textContent||'').match(/^([一二三四五六123456])[周週]目$/);
      if(!m)continue;
      const id={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6}[m[1]];
      if(id&&!tabs[id])tabs[id]=el;
    }
    // 尚未開放高周目的帳號仍保留前面周目；五周目按鈕不存在就不會誤點。
    return tabs[1]&&tabs[2]&&tabs[3]?tabs:null;
  }
  function selectedWorldFromTabs(tabs){
    if(!tabs)return 1;
    const yes=Object.entries(tabs).filter(([,el])=>
      el.getAttribute('aria-selected')==='true'||el.getAttribute('aria-pressed')==='true'||
      el.getAttribute('data-selected')==='true'||el.getAttribute('data-active')==='true'||
      /(?:^|[\s_-])(?:active|selected|current)(?:$|[\s_-])/i.test(String(el.className||'')));
    if(yes.length===1)return Number(yes[0][0]);
    // HANS 截圖裡選取按鈕為深藍色，其他為淡藍；若無差異則停止而不猜。
    const colors=Object.entries(tabs).map(([id,el])=>{
      const raw=getComputedStyle(el).backgroundColor||'';
      const rgb=raw.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if(!rgb)return {id:Number(id),b:null};
      const [r,g,b]=rgb.slice(1,4).map(Number);
      return {id:Number(id),b:.2126*r+.7152*g+.0722*b};
    });
    if(colors.some(v=>v.b===null))return null;
    colors.sort((a,b)=>a.b-b.b);
    return colors[1].b-colors[0].b>35?colors[0].id:null;
  }
  function visibleWorldFromStages(){
    const rows=stageRows();
    if(rows.length>=2){
      const worlds=rows.map(x=>stageNameWorld(x.name));
      if(worlds.every(x=>x===worlds[0]))return worlds[0];
    }
    // 部分 HANS 卡片以獨立 DOM 標題/等級徽章繪製，stageRows 可能拿不到 Lv 文字。
    // 僅採左側遠征清單中「至少兩個不同的可見關卡標題」作為周目證據。
    // 每張標題須帶改/改²/改³/改⁴，不能拿腳本的下拉選單或右側預覽推測。
    const distinct=new Map();
    for(const el of document.querySelectorAll('span,div,p,strong,b,h3,h4')){
      if(el.childElementCount!==0||!shown(el)||hud.contains(el)||
         el.closest('#'+UI_ID+',#hans-independent-zoom-panel,script,style,noscript'))continue;
      const name=norm(el.textContent||'');
      if(name.length<3||name.length>65||!/[・･·‧•∙．]改(?:[234])?$/u.test(name))continue;
      const rect=rct(el),mid=rect.left+rect.width/2;
      if(mid>=innerWidth*.34 || rect.width>innerWidth*.34)continue;
      // 排除沒有 Lv 卡片環境的無關標籤。
      let card=null;
      for(let p=el.parentElement,depth=0;p&&depth<5;p=p.parentElement,depth++){
        if(levelPattern.test(String(p.textContent||''))){card=p;break;}
      }
      if(card)distinct.set(name,stageNameWorld(name));
    }
    if(distinct.size<2)return null;
    const values=[...distinct.values()];
    return values.every(x=>x===values[0])?values[0]:null;
  }
  function currentWorldState(){
    const tabs=worldTabs(),byStages=visibleWorldFromStages();
    const byTabs=tabs?selectedWorldFromTabs(tabs):null;
    // 清單中>=2張同周目的實際關卡名稱，比漸層按鈕背景色可靠。
    // 切換周目仍有 700ms 緩衝，避免沿用上一周目的卡片。
    // 六周目目前關卡沒有「改」後綴，所以名字會被舊邏輯認作一周目。
    // 僅當六周目分頁確實選中，且清單呈現原名，才用分頁作為權威證據。
    const sixthPlain=byTabs===6&&(byStages===1||byStages===null);
    const world=sixthPlain?6:(byStages!==null?byStages:byTabs);
    return {tabs,available:!!tabs,world:world??(tabs?null:1),
      source:sixthPlain?'sixth-world-selected-tab':byStages!==null?'visible-stage-label':byTabs!==null?'tab':'unknown'};
  }
  let worldClickAt=0;
  function ensureWorldTab(){
    const state=currentWorldState(),wanted=chosenWorld();
    if(!state.available){
      if(wanted===1)return true;
      tell('找不到目標周目切換鈕，暫不出征');return false;
    }
    if(state.world===wanted){
      if(worldClickAt&&Date.now()-worldClickAt<650){tell('等待周目切換完成');return false;}
      return true;
    }
    if(Date.now()-worldClickAt<1100)return false;
    if(state.world===null&&(attempts.world||0)>0){
      // 不因先前一次切換未辨識就永久卡死：讓玩家手動切好周目後，
      // 再以「兩個同周目關卡標題」獨立確認；證據不足時仍不誤出征。
      tell('正在確認周目：需看到左側至少兩個同周目關卡標題');return false;
    }
    if(!state.tabs?.[wanted]){tell(WORLD_NAMES[wanted]+'尚未出現在遠征周目按鈕，停止自動進場');return false;}
    if(action('world',state.tabs[wanted],WORLD_NAMES[wanted],2,1200)){
      worldClickAt=Date.now();
      resetCatalog();catalog.world=null;
      stageClickedAt=0;departAt=0;
      tell('已切換'+WORLD_NAMES[wanted]+'，等待確認');
    }
    return false;
  }

  function expeditionOpen(){
    // 往下捲後斐揚可能不在畫面，依左側關卡卡片判定，不再只找兩張斐揚卡。
    if(findControl(W.wilderness))return false;
    const rows=stageRows();
    if(rows.length<2)return false;
    const depart=findControl(W.depart);
    const title=hits(W.expedition).some(h=>h.r.top<innerHeight*.3&&left(h));
    return !!(depart||title||storyTextIsVisible()||rows.length>=3);
  }
  function stageTarget(){
    const target=norm(canonicalStageName(targetStage()?.name||'',chosenWorld()));
    return target?stageRows().find(x=>stageFitsWorld(x.name,chosenWorld())&&norm(canonicalStageName(x.name,chosenWorld()))===target)||null:null;
  }
  function seekStage(){
    const target=targetStage()?.name||'';
    const key=chosenWorld()+'|'+target;
    if(catalog.searchName!==key){
      catalog.searchName=key;catalog.searchSteps=0;catalog.searchAt=0;
      if(catalog.scroll)catalog.scroll.scrollTop=0;
    }
    const rows=readStageCatalog(chosenWorld());
    const row=rows.find(x=>stageFitsWorld(x.name,chosenWorld())&&norm(x.name)===norm(target));
    if(row)return row;
    const el=catalog.scroll;
    if(el&&Date.now()-catalog.searchAt<450)return null; // 等列表更新才往下捲下一段
    if(!el||catalog.searchSteps>65||el.scrollTop>=el.scrollHeight-el.clientHeight-3){
      tell('找不到遠征關卡：'+target+'，為避免誤點已停止選擇');return null;
    }
    el.scrollTop=Math.min(el.scrollHeight-el.clientHeight,
      el.scrollTop+Math.max(110,el.clientHeight*.72));
    catalog.searchSteps++;catalog.searchAt=Date.now();
    tell('正在尋找 '+target+'（只搜尋指定關卡，不掃描全部）');
    return null;
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
    if(!ensureWorldTab())return;
    if(catalog.world!==chosenWorld()){stageExplorerTick();return;}
    // 四、五周目首次進入先掃描完整關卡；不要與 seekStage 同時捲動。
    if([4,5,6].includes(chosenWorld()) && catalog.running){
      tell('正在收錄'+WORLD_NAMES[chosenWorld()]+'完整關卡清單：'+catalog.observed.size+' 關');return;
    }
    // 掃描後才針對使用者選定關卡進行定向搜尋和出征確認。
    const stage=targetStage();
    if(!stage){tell('請先選擇'+WORLD_NAMES[chosenWorld()]+'的關卡，暫不出征');return;}
    if(stage.unlocked===false){tell('尚未解鎖：'+stage.name);return;}
    const row=stageTarget()||seekStage();
    if(!row)return;
    // 候選關卡只有命名規則，沒有保證解鎖；使用現場資料覆核名稱、解鎖狀態。
    rememberStage(row.name,row.unlocked,row.level,chosenWorld());
    if(!row.unlocked){tell('關卡未解鎖，停止選擇：'+stage.name);return;}
    if(!stageFitsWorld(row.name,chosenWorld())||!stageFitsWorld(stage.name,chosenWorld())){
      tell('周目與關卡名稱不符，暫不出征：'+WORLD_NAMES[chosenWorld()]+'／'+stage.name);return;
    }
    // 掃描右側預覽一次，避免新關卡增加後反覆遍歷整個畫面。
    const anyStageRe=new RegExp(Object.values(STAGES).map(x=>'(?:'+x.re.source+')').join('|'),'i');
    const previewHits=hits(anyStageRe).filter(rightPreview);
    const previewMatch=previewHits.some(h=>stage.re.test(h.t)&&stageFitsWorld(h.t,chosenWorld()));
    const otherPreview=previewHits.some(h=>!stage.re.test(h.t)||!stageFitsWorld(h.t,chosenWorld()));
    // 如果右邊明顯顯示另一個副本，即使左邊的卡片有「已選」樣式也不信任。
    const confirmed=(selectedStage(row.el)||stageClickedAt>0)&&
      (previewMatch||(!otherPreview&&selectedStage(row.el)));
    const depart=findControl(W.depart);
    if(stageClickedAt&&Date.now()-stageClickedAt<1500){tell('已按關卡，等待右側預覽更新');return;}
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
    try{row.el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});}catch{}
    if(action('stage',row.el,stage.name,3,1350,true))stageClickedAt=Date.now();
  }
  // The difficulty dialog is a *new* stage after 出發. Its confirm button is
  // 「前往野外」. Detect it BEFORE the expedition list (which may remain in DOM
  // behind the modal); never move the sliders or click 「取消」.
  function difficultyOpen() {
    return !!findControl(W.wilderness) ||
      (hits(W.difficulty).length > 0 && hits(W.enemyCount).length > 0);
  }
  // 高難度時 HANS 會在「出征／前往野外」後多彈出一道確認：
  // 「◆ 高難度提醒」→「✓ 入場」。先辨識整個提醒對話框再點，
  // 絕不只靠「入場」二字點擊其他頁面的按鈕，也不改動難度滑桿。
  function highDifficultyPrompt(){
    const controls=document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]');
    for(const button of controls){
      if(!shown(button)||hud.contains(button)||button.disabled)continue;
      const values=[button.innerText,button.textContent,button.getAttribute('aria-label'),button.value]
        .filter(Boolean).map(norm);
      if(!values.some(value=>/^[✓✔☑✅√]?入場$/.test(value)))continue;
      for(let root=button.parentElement,depth=0;root&&depth<9;root=root.parentElement,depth++){
        if(root===document.body)break;
        const text=norm(root.innerText||root.textContent||'');
        if(text.length>1600)continue;
        if(/高難度提醒/.test(text) && /此難度可能造成|預估同時在場|效能模式/.test(text)){
          return {button,root};
        }
      }
    }
    return null;
  }
  function handleHighDifficulty(prompt){
    phase('high-difficulty-confirmation');
    if((attempts.highEnter||0)>=2){
      tell('高難度提醒：已嘗試入場2次，停止重複點擊以免誤操作');
      return;
    }
    if(Date.now()-lastAt<1500){
      tell('高難度提醒：等待入場確認視窗反應');
      return;
    }
    // 先保存入圖縮放待辦，再點可能造成頁面跳轉的「入場」。
    queueZoom();
    if(!action('highEnter',prompt.button,'高難度提醒 → 入場',2,1500)){
      clearZoomPending();
    }
  }

  function handleDifficulty() {
    phase('difficulty');
    stageLootBridge.captureDifficulty(targetLabel());
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
      // 新版 HANS 的高難度確認可能蓋住仍存在 DOM 的難度視窗，必須先處理它。
      const highPrompt=highDifficultyPrompt();
      if(highPrompt){handleHighDifficulty(highPrompt);return;}
      // 三分鐘捨棄確認優先於一般遠征重進；未完成局不可由普通選關誤點過去。
      if(handleShortRun())return;
      if(incompleteDialog()){tell('未完成的一局請手動確認或啟用3分鐘刷卡模式');return;}
      if(difficultyOpen()){handleDifficulty();return;}
      if(expeditionOpen()){stageExplorerTick();handleExpedition();return;}
      const back=findControl(W.back);
      if(back){phase('result');
        if(!stageLootBridge.readyToLeave()){tell('結算辨識與封存中，暫不返回角色');return;}
        if(sellDryEnabled)markSellDryAtResult(); // 已完成封存，標記這場待模擬；不在結算頁販賣
        action('back',back,'返回角色',3,1500);return;}
      const talk=findControl(W.talk);
      if(talk){
        phase('town');
        if(sellDryEnabled && sellDryPending){
          tell('清背包模擬待執行：請手動開啟商人「販賣」頁（不會真的賣裝）；或按「跳過本場」');
          return;
        }
        if(sellDryEnabled && findSellDryMerchantPanel()){
          tell('商人視窗仍開啟，請手動關閉後再自動重進');return;
        }
        action('talk',talk,'與隊長交談',4,1800);return;
      }
      phase('waiting');tell('等待結算／主城／遠征／難度視窗（目標：'+targetLabel()+'）');
    } catch(e) {tell('偵測錯誤：請截圖並回報');console.error('[HANS 整合選關]',e);}
  }
  // 每場速度：辨認遊戲頂部 1×/2× 按鈕。僅在觀察到 1× 時觸發，
  // 必須後續真的顯示 2× 才算成功，避免一直點已開啟的 2× 而切回 1×。
  let speedLastSeenAt=0,speedLastClickAt=0,speedAttempts=0,speedOneSince=0;
  function speedNumber(value){
    const t=norm(value||'').replace(/^[⚡★✦]/u,'').toLowerCase();
    const m=t.match(/^(?:戰鬥)?(?:速度|倍速)?([12])(?:x|×)(?:速)?$/u);
    return m?Number(m[1]):null;
  }
  function validSpeedElement(el){
    if(!el || !shown(el) || hud.contains(el) || zoomPanel.contains(el) ||
       el.closest('#roj4-menu,#picker,#hans-independent-zoom-panel'))return false;
    const r=rct(el),centerX=r.left+r.width/2;
    return r.top>=-6 && r.top<Math.min(120,innerHeight*.23) &&
      r.width>=14 && r.width<=110 && r.height>=12 && r.height<=70 &&
      centerX>innerWidth*.35 && centerX<innerWidth*.94;
  }
  function findBattleSpeed(){
    for(const el of document.querySelectorAll('button,[role="button"],[data-speed]')){
      if(!validSpeedElement(el))continue;
      const values=[el.textContent,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-speed')];
      const rate=values.map(speedNumber).find(v=>v===1||v===2);
      if(rate)return {el,rate};
    }
    // 後備：遊戲若用可點擊 div/span 包住倍率文字，仍可辨識。
    for(const leaf of document.querySelectorAll('span,div')){
      if(leaf.childElementCount!==0||!validSpeedElement(leaf))continue;
      const rate=speedNumber(leaf.textContent);if(!rate)continue;
      let control=leaf.closest('button,[role="button"],[tabindex]');
      if(!control){
        for(let p=leaf.parentElement,depth=0;p&&depth<3;p=p.parentElement,depth++){
          if(!validSpeedElement(p))break;
          if(getComputedStyle(p).cursor==='pointer'||p.hasAttribute('onclick')){control=p;break;}
        }
      }
      if(control&&validSpeedElement(control)&&typeof control.click==='function')return {el:control,rate};
    }
    return null;
  }
  function autoTwoTimesTick(){
    if(document.hidden||!speedAutoEnabled)return;
    const now=Date.now(),found=findBattleSpeed();
    if(!found){
      if(speedLastSeenAt && now-speedLastSeenAt>1800){
        speedAttempts=0;speedOneSince=0;speedLastClickAt=0;speedLastSeenAt=0;
        speedNote('等待下一場');
      }
      return;
    }
    speedLastSeenAt=now;
    if(found.rate===2){
      speedAttempts=0;speedOneSince=0;
      speedNote('已確認 2×');return;
    }
    if(!speedOneSince)speedOneSince=now;
    if(now-speedOneSince<400 || now-speedLastClickAt<1400)return;
    if(speedAttempts>=3){speedNote('仍為 1×（本場已重試3次）');return;}
    try{
      speedAttempts++;speedLastClickAt=now;
      found.el.click();
      speedNote('已點 1×，等待確認 2×（'+speedAttempts+'/3）');
    }catch(e){
      speedNote('切換失敗：'+String(e?.message||e).slice(0,55));
      console.warn('[HANS 自動2倍速] 點擊失敗',e);
    }
  }
  setInterval(()=>{
    try{autoTwoTimesTick()}catch(e){console.warn('[HANS 自動2倍速] 監測失敗',e)}
  },550);

  // 沒有開啟自動重進時，進遠征列表也會掃描；讓玩家先挑選新關卡。
  setInterval(()=>{
    if(document.hidden)return;
    try{
      if(expeditionOpen())stageExplorerTick();
      else if(catalog.complete||catalog.running)stageExplorerTick();
    }catch(e){console.warn('[HANS 關卡清單]',e)}
  },850);
  window.addEventListener('pagehide',()=>clearInterval(timer));
  let restoreReentry=false;
  try{restoreReentry=sessionStorage.getItem(REENTRY_KEY)==='1';}catch{}
  enable(restoreReentry,{remember:false});
})();
  } catch(error) {
    // 以前此處發生執行期錯誤時，右下角只剩戰利品按鈕，沒有任何錯誤提示。
    const state=document.getElementById('roj4-state');
    if(state) state.textContent='選關控制初始化失敗：'+String(error?.message||error);
    console.error('[HANS 選關＋戰利品] 控制面板初始化失敗',error);
  }

})();