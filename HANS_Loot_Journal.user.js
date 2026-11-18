// ==UserScript==
// @name         HANS RO 選關＋戰利品｜每場結束統一匯報
// @namespace    ro-local-loot-journal
// @version      0.9.19
// @description  v0.9.19：每場離線玩後全自動清背包再重進；停止重進時同步中止巡檢與商人，並防止舊版賣裝模擬干擾。
// @match        *://ro.hans-webgametw.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      discord.com
// @connect      discordapp.com
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
  const VERSION = '0.9.19';
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
    talk: /^(?:與|和|跟)?(?:(?:遠征)?隊長|船長)(?:交談|談話|對話|說話)(?:(?:空格|空白鍵|space)|[（(](?:空格|空白鍵|space)[）)])?$/i,
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
  const namePattern=name=>{
    const raw=norm(name);
    const escaped=[...raw].map(ch=>/[\p{L}\p{N}]/u.test(ch)?ch:'\\'+ch).join('');
    const flexible=escaped;
    return new RegExp('^'+flexible+'$','i');
  };
  // 2026 HANS 遠征周目：一周目原名；二至五周目依次為「・改」「・改²」「・改³」「・改⁴」。
  // norm 採 NFKC：上標²、³、⁴ 正規化成 2、3、4，顯示與比對分開處理。
  // 舊版 seed 候選時可能把「・改3」當新地名再加「・改³」，造成「・改3・改³」。
  // 移除所有連續的改版尾碼，再依真正周目補回正確的一個尾碼。
  const REFORM_MARK=/(?:[・･·‧•∙．]改(?:[2345])?)+$/u;
  function stageNameWorld(name){
    const n=norm(name);
    if(/[・･·‧•∙．]改5$/u.test(n))return 6;
    if(/[・･·‧•∙．]改4$/u.test(n))return 5;
    if(/[・･·‧•∙．]改3$/u.test(n))return 4;
    if(/[・･·‧•∙．]改2$/u.test(n))return 3;
    if(/[・･·‧•∙．]改$/u.test(n))return 2;
    return 1;
  }
  function baseStageName(name){return norm(name).replace(REFORM_MARK,'');}
  function stageFitsWorld(name,world){return stageNameWorld(name)===Number(world);}
  function stageLabelForWorld(base,world){
    const clean=baseStageName(base);
    return clean+(world===2?'・改':world===3?'・改²':world===4?'・改³':world===5?'・改⁴':world===6?'・改⁵':'');
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
    // 節慶關卡初始沒有 Lv 範圍，舊版一律被排到選單底部，容易誤以為不存在。
    // 把這兩個關卡固定放在每一周目的最上方，其他關卡沿用原本 Lv 順序。
    const seasonalOrder=v=>{
      const base=baseStageName(v.name);
      if(base==='聖誕節')return 0;
      if(base==='元宵燈會')return 1;
      return 2;
    };
    entries.sort((a,b)=>seasonalOrder(a[1])-seasonalOrder(b[1])||
      lvl(a[1])-lvl(b[1])||a[1].name.localeCompare(b[1].name));
    picker.replaceChildren();
    const blank=document.createElement('option');blank.value='';
    blank.textContent=entries.length?'選擇'+WORLD_NAMES[world]+'關卡':'目前無可選關卡';
    picker.append(blank);
    for(const [key,st] of entries){
      const opt=document.createElement('option');opt.value=key;opt.disabled=st.unlocked===false;
      const seasonalBase=baseStageName(st.name);
      const prefix=seasonalBase==='聖誕節'?'🎄 ':seasonalBase==='元宵燈會'?'🏮 ':'';
      opt.textContent=prefix+st.name+(st.level?' · Lv '+st.level:'')+
        (st.unlocked===false?'（未解鎖）':st.unlocked===null?'（待確認）':'');
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
        const title=possibleTitles.find(x=>/[・･·‧•∙．]改(?:[2345])?$/u.test(norm(x)))||possibleTitles[0];
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
    // 已有指定目標且右側預覽吻合時，直接出發，不先捲動關卡清單。
    if(active&&tab.world===chosenWorld()){
      const target=targetStage(),row=target&&stageTarget();
      if(target&&row&&hits(target.re).some(h=>rightPreview(h)&&stageFitsWorld(h.t,tab.world))){
        catalog.running=false;readStageCatalog(tab.world);return;
      }
    }
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
    const proper=stageLabelForWorld(name,6);
    if(Object.values(STAGES).some(x=>x.world===6&&norm(x.name)===norm(proper)))continue;
    STAGES['hans:w6:'+norm(proper)]={name:proper,re:namePattern(proper),unlocked:null,level,world:6,verified:false};
  }
  // 節慶特殊關卡：2026-11-18 截圖核對五周目有
  // 「聖誕節・改⁴」、「元宵燈會・改⁴」；其餘周目依既有命名規則建立候選。
  // 六周目沿用原名，與一周目分別使用不同的周目鍵值，不能混用。
  // 候選不代表已解鎖，出發前仍須從當前周目畫面重新驗證。
  const SEASONAL_STAGE_NAMES=['聖誕節','元宵燈會'];
  for(const base of SEASONAL_STAGE_NAMES){
    for(const world of [1,2,3,4,5,6]){
      const name=stageLabelForWorld(base,world);
      const existing=Object.values(STAGES).find(stage=>stage.world===world&&norm(stage.name)===norm(name));
      if(existing)continue; // 不覆寫先前掃描的解鎖、關卡等級與驗證狀態。
      const key='hans:w'+world+':'+norm(name);
      STAGES[key]={name,re:namePattern(name),unlocked:null,level:'',world,verified:false};
    }
  }
  seedKnownStageCandidates();
  // 自動轉換 0.9.14–16 的舊周目目標鍵，不需使用者重新選關。
  for(const [wKey,oldKey] of Object.entries(worldSelections)){
    const world=Number(wKey),m=String(oldKey||'').match(/^hans:w\d+:(.+)$/u);
    if(!WORLD_NAMES[world]||!m)continue;
    const newKey='hans:w'+world+':'+norm(stageLabelForWorld(m[1],world));
    if(STAGES[newKey])worldSelections[wKey]=newKey;
  }
  redrawStageChoices();

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

  // 只在本場按完「離線玩」後觸發，每次成功一次；失敗則鎖住重進避免誤賣。
  const INV_CLEAN_KEY='hans-ro-stage-inventory-clean-enabled-v1';
  const INV_JOB_KEY='hans-ro-stage-inventory-clean-job-v1';
  let invCleanEnabled=true,invCleanerReady=false,invCooldown=0,invJob=null;
  try{invCleanEnabled=localStorage.getItem(INV_CLEAN_KEY)!=='0'}catch{}
  try{invJob=JSON.parse(sessionStorage.getItem(INV_JOB_KEY)||'null')}catch{}
  if(invJob&&!['armed','running','failed'].includes(invJob.status))invJob=null;
  if(invJob?.status==='running'){invJob.status='failed';invJob.error='重新整理中斷清背包；請人工核對販賣與位置後再重啟';}
  const saveInvJob=()=>{try{
    if(invJob)sessionStorage.setItem(INV_JOB_KEY,JSON.stringify(invJob));
    else sessionStorage.removeItem(INV_JOB_KEY);
  }catch{}};
  saveInvJob();
  function invFail(message){
    if(!invJob)return;
    invJob.status='failed';invJob.error=String(message||'未知錯誤');
    saveInvJob();tell('⛔ 清背包中斷，暫停重進：'+invJob.error.slice(0,115));
  }
  function armInvAfterOffline(){
    if(!invCleanEnabled||invJob)return false;
    invJob={id:'round-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),status:'armed',at:Date.now()};
    saveInvJob();return true;
  }
  document.addEventListener('hans-ro-stage-inventory-ready',()=>{invCleanerReady=true;});
  document.addEventListener('hans-ro-stage-inventory-progress',e=>{
    if(invJob?.status==='running'&&e.detail?.id===invJob.id)
      tell('每場清背包｜'+String(e.detail?.message||'').slice(0,105));
  });
  document.addEventListener('hans-ro-stage-inventory-result',e=>{
    if(!invJob||invJob.status!=='running'||e.detail?.id!==invJob.id)return;
    if(e.detail.ok){
      invJob=null;saveInvJob();invCooldown=Date.now()+1400;
      tell('✅ 本場保護／販賣／返程完成，準備重進 '+targetLabel());
    }else invFail(e.detail.error||'巡檢或販賣未完成');
  });
  const invToggle=document.createElement('button');
  invToggle.id='hans-stage-inventory-clean-toggle';invToggle.type='button';
  invToggle.title='每場結束按「離線玩」之後：自動掃描非E、設定傳說GS前十保護、去商人賣裝並返回；完成才重進';
  invToggle.style.cssText='margin:4px 0 0;padding:4px 7px;border:1px solid #9abed5;border-radius:5px;color:white;cursor:pointer;font:bold 11px sans-serif';
  function updateInvToggle(){
    invToggle.textContent='每場自動清背包：'+(invCleanEnabled?'開':'關');
    invToggle.style.background=invCleanEnabled?'#176b51':'#596577';
  }
  updateInvToggle();
  invToggle.addEventListener('click',()=>{
    if(invJob?.status==='running'){tell('清背包執行中，請先關閉「重進」以停止');return;}
    invCleanEnabled=!invCleanEnabled;
    try{localStorage.setItem(INV_CLEAN_KEY,invCleanEnabled?'1':'0')}catch{}
    if(!invCleanEnabled&&invJob?.status==='armed'){invJob=null;saveInvJob();}
    updateInvToggle();
    if(invCleanEnabled&&sellDryEnabled){
      sellDryEnabled=false;sellDryPending=false;saveSellDryPending();
      try{localStorage.setItem(SELL_DRY_ENABLED_KEY,'0')}catch{}
      updateSellDryControls();
    }
  });
  function handleInvCleanGate(){
    if(Date.now()<invCooldown)return true;
    if(!invJob)return false;
    if(invJob.status==='failed'){
      tell('⛔ 上一場清背包失敗，重進已暫停；請先檢查遊戲，再關閉重進以重設');return true;
    }
    if(invJob.status==='running')return true;
    if(Date.now()-invJob.at>120000){invFail('離線玩後120秒內未確認主城');return true;}
    if(chooseLobbyOfflineButton())return true;
    const townTalk=findControl(W.talk);
    if(!townTalk||!shown(townTalk)){tell('等待離線玩返回主城後清背包');return true;}
    if(!invCleanerReady){tell('等待內建清背包模組載入');return true;}
    invJob.status='running';saveInvJob();
    tell('主城已就緒：正在清背包，完成後才重新選關');
    document.dispatchEvent(new CustomEvent('hans-ro-stage-inventory-request',{detail:{id:invJob.id}}));
    return true;
  }

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
    if(invCleanEnabled){
      sellDryEnabled=false;sellDryPending=false;saveSellDryPending();
      updateSellDryControls();tell('已開啟每場自動清背包，不需要舊版只讀賣裝模擬');return;
    }
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
  // 真正清背包與舊版只讀模擬互斥。
  if(invCleanEnabled&&sellDryEnabled){
    sellDryEnabled=false;sellDryPending=false;saveSellDryPending();
    try{localStorage.setItem(SELL_DRY_ENABLED_KEY,'0')}catch{}
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
  hud.append(btn,worldPicker,picker,shortGroup,shortHelp,invToggle,sellPanel,msg);
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
      if(chooseLobbyOfflineButton()||findControl(W.talk)||expeditionOpen()||difficultyOpen()){
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
    if(!active){
      resetShortExit();
      if(invJob?.status==='running'){
        document.dispatchEvent(new Event('hans-ro-stage-inventory-stop'));
        document.dispatchEvent(new Event('hans-merchant-stop'));
      }
      invJob=null;saveInvJob();
    }
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
      if(name.length<3||name.length>65||!/[・･·‧•∙．]改(?:[2345])?$/u.test(name))continue;
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
    // 「改⁵」代表六周目；周目分頁與清單暫時不同時不猜測。
    const discrepancy=byTabs!==null&&byStages!==null&&byTabs!==byStages;
    const world=discrepancy?null:(byStages!==null?byStages:byTabs);
    return {tabs,available:!!tabs,world:world??(tabs?null:1),
      source:discrepancy?'tabs-changing':byStages!==null?'visible-stage-label':byTabs!==null?'tab':'unknown'};
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
      attempts.world=0;
      return true;
    }
    if(Date.now()-worldClickAt<1100)return false;
    if(state.world===null&&state.source==='tabs-changing'){
      tell('等待分頁和關卡清單同步，不重複按周目');return false;
    }
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
    const row=rows.find(x=>stageFitsWorld(x.name,chosenWorld())&&
      norm(canonicalStageName(x.name,chosenWorld()))===
      norm(canonicalStageName(target,chosenWorld())));
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
    // 當目標和右側預覽都已證實一致，不讓背景掃描阻止出發。
    if([4,5,6].includes(chosenWorld()) && catalog.running){
      const wanted=targetStage(),row=wanted&&stageTarget();
      const previewOK=wanted&&row&&hits(wanted.re).some(h=>
        rightPreview(h)&&stageFitsWorld(h.t,chosenWorld()));
      if(!previewOK){
        tell('正在收錄'+WORLD_NAMES[chosenWorld()]+'完整關卡清單：'+catalog.observed.size+' 關');return;
      }
      catalog.running=false;
      tell('關卡及預覽已核對｜不等待完整掃描');
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
    // 新版藍框選中不一定提供 selected/active class；右側精確預覽可作獨立證據。
    const confirmed=!otherPreview&&(
      previewMatch||(previewHits.length===0&&selectedStage(row.el)));
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
  // 結算返回角色後，新版遊戲可能多一層「選擇大廳」視窗。
  // 必須確認同一對話框內同時存在標題、說明文字與「離線玩」按鈕，
  // 不能只找到頁面上任何含離線兩字的按鈕就誤點。
  function chooseLobbyOfflineButton(){
    for(const button of document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')){
      if(hud.contains(button)||!shown(button)||button.disabled)continue;
      const label=norm(button.innerText||button.textContent||button.value||
        button.getAttribute('aria-label')||'');
      if(!/^(?:離線玩|离线玩)$/.test(label))continue;
      for(let root=button.parentElement,depth=0;root&&depth<9;root=root.parentElement,depth++){
        if(root===document.body)break;
        const text=norm(root.innerText||root.textContent||'');
        if(text.length>2400)continue;
        if(text.includes('選擇大廳')&&
           (text.includes('每個大廳')||text.includes('好友和無盡之塔')||
            text.includes('阿斯嘉特')||text.includes('米德加德'))){
          return {button,root};
        }
      }
    }
    return null;
  }
  function handleLobbyOffline(dialog){
    phase('lobby-selection');
    // 「離線玩」通常會造成畫面切換；同一視窗避免短時間連點。
    if(Date.now()-lastAt<1800){
      tell('已找到選擇大廳，等待「離線玩」按鈕可操作');return;
    }
    if((attempts.offlineLobby||0)>=3){
      tell('離線玩已嘗試3次仍未離開選擇大廳，停止重點以避免誤操作');
      return;
    }
    const marked=armInvAfterOffline();
    if(!action('offlineLobby',dialog.button,'選擇大廳 → 離線玩',3,1800)&&marked){
      invJob=null;saveInvJob();
    }
  }

  function tick() {
    if(!active||document.hidden)return;
    try {
      if(handleInvCleanGate())return;
      // 新版 HANS 的高難度確認可能蓋住仍存在 DOM 的難度視窗，必須先處理它。
      const highPrompt=highDifficultyPrompt();
      if(highPrompt){handleHighDifficulty(highPrompt);return;}
      // 三分鐘捨棄確認優先於一般遠征重進；未完成局不可由普通選關誤點過去。
      if(handleShortRun())return;
      if(incompleteDialog()){tell('未完成的一局請手動確認或啟用3分鐘刷卡模式');return;}
      // 必須在遠征/難度視窗判斷之前處理，避免背景尚未卸載的介面蓋過選大廳。
      const lobby=chooseLobbyOfflineButton();
      if(lobby){handleLobbyOffline(lobby);return;}
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
        action('talk',talk,'和船長／遠征隊長說話',4,1800);return;
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


// === 每場選關重進內建自動清背包模組（勿另外安裝） ===
(() => {
  'use strict';
  const ID = 'hans-stage-auto-inventory-embedded-v1'; // 獨立於原本浮窗
  if (document.getElementById(ID)) return;
  const LIMIT = 10;
  const POLICY_VERSION = '2.3.0';
  const TARGET_RARITY = '傳說';
  const QUALITY_NAMES = Object.freeze(['普通','優良','稀有','史詩','傳說']);
  // 只看 Tier 行起首的品質，不能用附加屬性中 ★ 稀有 等文字判斷。
  function qualityFromTierLine(tierLine) {
    const match=String(tierLine||'').normalize('NFKC').trim().match(/^(普通|優良|稀有|史詩|傳說)\s*[·•]\s*Tier\s*\d+\b/iu);
    return match ? match[1] : '';
  }
  const ALLOWED_SLOTS = Object.freeze(['武器','頭部（上）','頭部（中）','頭部（下）','披肩','飾品','鞋子','盾牌','鎧甲']);
  // 只有名稱明確符合「杖」型且未標記為職業無法使用的武器才能參與武器前十。
  function isStaffWeapon(r) {
    if (!r || r.slot !== '武器') return false;
    const name = String(r.name || '').normalize('NFKC');
    const staff = /杖/u.test(name) || /\b(?:staff|rod|wand)\b/i.test(name);
    const unusable = /你的職業無法使用這個道具|your (?:job|class) cannot (?:use|equip)/iu.test(String(r.detailText || ''));
    return staff && !unusable;
  }
  const WAIT_MS = 220;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const textOf = el => (el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const isVisible = el => Boolean(el?.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const inv = () => document.querySelector('#cp-inventory');
  let records = [], plan = [], issues = [], running = false, aborted = false, scannedAt = 0;
  let stageId=null;
  let autoRunning=false, autoAbort=false;
  let runMerchant=async()=>{throw Error('商人模組尚未初始化');};
  let scanSnapshot = null, latestDiscord = '尚未傳送';
  let scanMeta = {total:0, eligible:0, ignoredE:0};
  const HOOK_KEY = 'hans-ro-v2-discord-webhook';
  const SCAN_KEY = 'hans-ro-v2-last-full-inventory-scan';
  const PANEL_POS_KEY = 'hans-ro-inventory-panel-position-v1';
  const PANEL_MIN_KEY = 'hans-ro-inventory-panel-minimized-v1';
  const savedHook = () => String(GM_getValue(HOOK_KEY, '') || GM_getValue('hans_ro_discord_webhook_private', '') || '').trim();
  const validHook = s => /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+(?:\?.*)?$/.test(s);
  const nowString = () => new Date().toLocaleString('zh-TW', {hour12:false});
  const positionOf = (cells) => {
    const tops=[]; const result=new Map();
    cells.forEach((el,i) => {
      const r=el.getBoundingClientRect();
      let row=tops.findIndex(n=>Math.abs(n-r.top)<8);
      if (row<0){ tops.push(r.top); row=tops.length-1; }
      const col=cells.slice(0,i).filter(other=>Math.abs(other.getBoundingClientRect().top-r.top)<8).length+1;
      result.set(el.dataset.uid,{index:i+1,row:row+1,col});
    });
    return result;
  };

  const pane = document.createElement('section');
  pane.id = ID;
  pane.innerHTML = `
    <div class="hp-title"><strong title="按住這個藍色標題列就能拖曳">HANS｜一鍵清背包 V2.6.5</strong><button id="hp-toggle" title="縮小／展開">−</button></div>
    <div id="hp-body">
      <div class="hp-sub">主城按 C → 背包 → 全部；E 穿戴完全跳過。只保留傳說品質：法杖、頭上中下、披肩、飾品、鞋子、盾牌、衣服（鎧甲）。</div>
      <div class="hp-sub">一鍵流程：非 E 掃描→保護前十→複掃→回普隆德拉→商人勾五品質→一鍵販賣→全部賣掉→關閉商人視窗→原路返回。異常停止。</div>
      <div class="hp-bar"><button id="hp-full-cycle" style="background:#1b775a;color:white;font-weight:700;font-size:13px">▶ 一鍵全部｜掃描・保護・販賣・返程</button></div>
      <div class="hp-sub">從主城固定原點啟動；不詢問保護／販賣同意。出現異常會停止後續操作。</div>
      <div class="hp-bar"><button id="hp-scan">單獨掃描非 E</button><button id="hp-scan-dc">掃描＋傳 DC</button></div>
      <div class="hp-bar"><button id="hp-apply" disabled>單獨執行保護</button><button id="hp-stop" disabled>停止</button></div>
      <div class="hp-sub" style="margin-top:9px;border-top:1px solid #cbd5e1;padding-top:7px"><b>商人路線＋一鍵販賣（可獨立執行）</b></div>
      <div class="hp-sub">先在角色背包畫面按「回到普隆德拉」才能移動。回城後 ↓9 →13／返程 ←13 ↑9，單次固定200ms；保護驗證失敗不會販賣。</div>
      <div class="hp-bar"><button id="hp-route-go">↓9 →13｜去商人</button><button id="hp-route-talk">💬 只開商人對話</button></div>
      <div class="hp-bar"><button id="hp-route-return">←13 ↑9｜返回原點</button><button id="hp-route-stop">停止</button></div>
      <div class="hp-bar"><button id="hp-route-run">▶ 去商人＋賣光＋返程</button><button id="hp-route-sell">商人已開：販賣</button></div>
      <div class="hp-bar"><label style="flex:1">按鍵方式 <select id="hp-route-keys"><option value="wasd">WASD</option><option value="arrows">方向鍵</option></select></label><span style="align-self:center">固定每下 200ms</span></div>
      <div class="hp-sub" id="hp-route-status">固定路線：↓9 →13｜返程 ←13 ↑9。從原點使用。</div>
      <div class="hp-sub"><b>Discord Webhook（只保存在本機 Tampermonkey）：</b></div>
      <div class="hp-bar"><input id="hp-hook" type="password" placeholder="貼入 Webhook URL，不要貼到聊天" autocomplete="off"><button id="hp-save-hook">儲存</button></div>
      <div class="hp-bar"><button id="hp-send" disabled>傳送掃描摘要</button><button id="hp-export" disabled>匯出 CSV</button><button id="hp-json" disabled>匯出 JSON</button></div>
      <div id="hp-status">等待：請打開背包「全部」。</div>
      <div id="hp-discord">Discord：未傳送</div>
      <div id="hp-report"></div>
    </div>`;
  pane.style.cssText = 'position:fixed;right:12px;bottom:14px;width:365px;max-width:calc(100vw - 24px);max-height:65vh;overflow:auto;z-index:2147482000;background:#f9fbff;color:#263958;border:1px solid #7795c5;border-radius:12px;box-shadow:0 8px 30px #1b325b55;font:12px/1.5 Arial,"Microsoft JhengHei",sans-serif';
  const style = document.createElement('style');
  style.textContent = `
  #${ID} .hp-title{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#31588f;color:white;padding:8px 10px;position:sticky;top:0;z-index:1;cursor:grab;touch-action:none;user-select:none} #${ID} .hp-title:active{cursor:grabbing} #${ID} .hp-title strong{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0} #${ID}.hp-collapsed{width:230px!important;max-height:none!important;overflow:visible!important} #${ID}.hp-collapsed #hp-body{display:none!important} #${ID} #hp-toggle{flex:none;min-width:27px;cursor:pointer}
  #${ID} #hp-body{padding:9px} #${ID} .hp-sub{color:#64718b;font-size:11px;margin-bottom:5px}
  #${ID} .hp-bar{display:flex;gap:6px;margin:7px 0} #${ID} button{cursor:pointer;background:#eaf1fd;border:1px solid #aabedc;border-radius:6px;color:#203b67;font-size:12px;padding:5px 7px}
  #${ID} .hp-bar button{flex:1} #${ID} .hp-bar input{flex:2;min-width:0;border:1px solid #afbfdb;padding:5px;border-radius:5px} #${ID} #hp-apply{background:#dbebd9} #${ID} button:disabled{opacity:.45;cursor:not-allowed}
  #${ID} #hp-status{background:#edf3fb;border-radius:6px;white-space:pre-wrap;padding:7px;margin:6px 0;font-size:11px} #${ID} #hp-discord{color:#385f84;font-size:11px;white-space:pre-wrap}
  #${ID} table{width:100%;border-collapse:collapse;font-size:11px;margin-top:7px} #${ID} td,#${ID} th{padding:3px;border-bottom:1px solid #dbe5f4;text-align:left}
  #${ID} .hp-warn{color:#ac4c12} #${ID} .hp-ok{color:#26703e} #${ID} details{margin-top:5px}`;
  document.documentElement.append(style);
  pane.style.display='none'; // 藏在選關整合腳本，勿另外增加浮動面板
  document.body.append(pane);
  const $ = id => pane.querySelector('#' + id);
  const status = message => {
    $('hp-status').textContent=message;
    if(stageId)document.dispatchEvent(new CustomEvent('hans-ro-stage-inventory-progress',{detail:{id:stageId,message:String(message)}}));
  };
  const controls = () => {
    $('hp-full-cycle').disabled = running||autoRunning;
    $('hp-scan').disabled = running||autoRunning;
    $('hp-scan-dc').disabled = running||autoRunning;
    $('hp-send').disabled = running || !scanSnapshot?.complete;
    $('hp-json').disabled = !records.length;
    $('hp-save-hook').disabled = running;
    $('hp-apply').disabled = running||autoRunning||issues.length>0||!scannedAt||!scanSnapshot?.complete||!plan.length;
    $('hp-stop').disabled = !running&&!autoRunning;
    $('hp-export').disabled = !records.length;
  };
  // 面板可拖曳：按住藍色標題列即可搬移。位置與縮小狀態只存本機。
  const titleBar=pane.querySelector('.hp-title');
  const clampPosition=(x,y)=>{
    const width=pane.getBoundingClientRect().width || 230;
    const height=pane.getBoundingClientRect().height || 34;
    return {x:Math.max(0,Math.min(Math.round(x),Math.max(0,innerWidth-width))),
      y:Math.max(0,Math.min(Math.round(y),Math.max(0,innerHeight-height)))};
  };
  const placePanel=(x,y)=>{
    const p=clampPosition(x,y);
    pane.style.right='auto';pane.style.bottom='auto';
    pane.style.left=p.x+'px';pane.style.top=p.y+'px';
    return p;
  };
  const rememberPosition=()=>{
    const b=pane.getBoundingClientRect();
    GM_setValue(PANEL_POS_KEY,JSON.stringify({x:Math.round(b.left),y:Math.round(b.top)}));
  };
  const savedPosition=()=>{
    try{
      const p=JSON.parse(GM_getValue(PANEL_POS_KEY,'null'));
      return Number.isFinite(p?.x)&&Number.isFinite(p?.y)?p:null;
    }catch{return null;}
  };
  const setCollapsed=(value)=>{
    const collapsed=Boolean(value);
    $('hp-body').hidden=collapsed;
    pane.classList.toggle('hp-collapsed',collapsed);
    $('hp-toggle').textContent=collapsed?'+':'−';
    $('hp-toggle').title=collapsed?'展開巡檢面板':'縮小巡檢面板';
    GM_setValue(PANEL_MIN_KEY,collapsed);
    const b=pane.getBoundingClientRect();
    if(pane.style.left)placePanel(b.left,b.top);
  };
  setCollapsed(Boolean(GM_getValue(PANEL_MIN_KEY,false)));
  const initialPos=savedPosition();
  if(initialPos)placePanel(initialPos.x,initialPos.y);
  $('hp-toggle').onclick=()=>{setCollapsed(!$('hp-body').hidden);rememberPosition();};
  let dragging=null;
  titleBar.addEventListener('pointerdown',ev=>{
    if(ev.button!==0||ev.target.closest('button,input,a'))return;
    const bounds=pane.getBoundingClientRect();
    dragging={id:ev.pointerId,offsetX:ev.clientX-bounds.left,offsetY:ev.clientY-bounds.top};
    try{titleBar.setPointerCapture(ev.pointerId);}catch{}
    ev.preventDefault();
  });
  titleBar.addEventListener('pointermove',ev=>{
    if(!dragging||dragging.id!==ev.pointerId)return;
    placePanel(ev.clientX-dragging.offsetX,ev.clientY-dragging.offsetY);
    ev.preventDefault();
  });
  const finishDragging=ev=>{
    if(!dragging||dragging.id!==ev.pointerId)return;
    dragging=null;
    try{if(titleBar.hasPointerCapture(ev.pointerId))titleBar.releasePointerCapture(ev.pointerId);}catch{}
    rememberPosition();
  };
  titleBar.addEventListener('pointerup',finishDragging);
  titleBar.addEventListener('pointercancel',finishDragging);
  window.addEventListener('resize',()=>{
    if(!pane.style.left)return;
    const rect=pane.getBoundingClientRect();
    placePanel(rect.left,rect.top);
    rememberPosition();
  });
  $('hp-stop').onclick = () => { aborted=true;autoAbort=true;document.dispatchEvent(new Event('hans-merchant-stop'));status('已請求停止。'); };
  $('hp-save-hook').onclick = () => {
    const hook=$('hp-hook').value.trim();
    if (!validHook(hook)) { status('Webhook 格式不正確，必須是 discord.com/api/webhooks/...'); return; }
    GM_setValue(HOOK_KEY,hook); $('hp-hook').value='';
    $('hp-hook').placeholder='已在本機保存 Webhook（可貼新網址覆蓋）';
    status('Discord Webhook 已存到此腳本的本機設定；可按「掃描＋傳 DC」。');
  };
  if(savedHook()) $('hp-hook').placeholder='已在本機保存 Webhook（可貼新網址覆蓋）';

  const allCells = () => [...(inv()?.querySelectorAll('.item-cell[data-uid]') || [])]
    .filter(el => Boolean(el.dataset.uid));
  const itemCell = uid => allCells().find(el => el.dataset.uid === uid);
  // E 標記：優先以遊戲 DOM 的 equipped class 判斷；其次辨認圖示上的 E 徽章。
  // 不從整張裝備卡任意匹配 E，避免英文屬性文字中的 E 誤判。
  const equipped = el => el.classList.contains('equipped') ||
    [...el.children].some(c => norm(textOf(c)) === 'E' || c.getAttribute('title') === '已裝備') ||
    [...el.querySelectorAll('[class*=equip], [class*=badge], [title], [aria-label]')]
      .some(c => norm(textOf(c)) === 'E' || /^(?:已裝備|穿戴中)$/u.test(norm(c.getAttribute('title')||c.getAttribute('aria-label')||'')));

  const inventoryState = () => {
    const cells = allCells();
    return {
      total: cells.length,
      uids: cells.map(el=>el.dataset.uid),
      ignoredE: cells.filter(equipped).map(el=>el.dataset.uid),
      eligible: cells.filter(el=>!equipped(el)).map(el=>el.dataset.uid)
    };
  };
  function assertInventoryStable(baseline) {
    const state = inventoryState();
    const same = (a,b) => a.length === b.length && a.every((x,i)=>x===b[i]);
    if (!same(state.uids,baseline.uids) || !same(state.ignoredE,baseline.ignoredE) || !same(state.eligible,baseline.eligible))
      throw Error('背包內容或 E 穿戴標記已變動；立即停止，請重新掃描。');
  }

  function validateInventory() {
    const root = inv();
    if (!root || !isVisible(root)) throw Error('找不到背包。請先在主城按 C，切到「背包」。');
    const box = root.closest('.inv-box') || root.parentElement;
    const surrounding = box?.parentElement || box;
    const buttons = [...(surrounding?.querySelectorAll('button') || [])];
    const all = buttons.find(b => /^全部\s*\d+$/u.test(norm(textOf(b))));
    if (!all) throw Error('找不到「全部 N」的背包分類按鈕；無法證實資料完整，請切到「背包 → 全部」。');
    const expected = Number(norm(textOf(all)).match(/\d+/)?.[0]);
    if (!Number.isSafeInteger(expected) || expected<=0) throw Error('無法讀取「全部」的裝備總數，停止完整掃描。');
    const cells = allCells();
    if (!cells.length) throw Error('目前沒有可讀取的裝備格。請選「全部」，並確認不是材料頁。');
    if (expected && cells.length !== expected) throw Error(`畫面找到 ${cells.length} 件，但「全部」顯示 ${expected} 件。請選「全部」分類並重新掃描，避免誤判前10名。`);
    // 一律依實測GS排序，不依DOM排列；戰力排序僅便於玩家肉眼核對。
    return {cells, expected};
  }

  function detailPanel() {
    const candidates = [...document.querySelectorAll('button')]
      .filter(b => !pane.contains(b) && /^(保護|取消保護)$/u.test(norm(textOf(b))) && isVisible(b));
    const found = [];
    for (const b of candidates) {
      for (let parent = b.parentElement, depth = 0; parent && depth < 9; parent = parent.parentElement, depth++) {
        if (parent.contains(inv()) || pane.contains(parent)) break;
        const s = textOf(parent);
        if (s.length > 3600) break;
        if (/\bGS\s*\d+/i.test(s) && /Tier\s*\d+/i.test(s)) {
          found.push({el:parent, length:s.length, hasDetail:/(?:^|\n)詳情(?:\n|$)/u.test(s)});
          break;
        }
      }
    }
    if (!found.length) return null;
    found.sort((a,b) => Number(b.hasDetail) - Number(a.hasDetail) || a.length - b.length);
    return found[0].el;
  }

  function slotOf(s) {
    const m = s.match(/(?:頭部|頭飾)\s*[（(]\s*(上|中|下)\s*[)）]/u);
    if (m) return '頭部（' + m[1] + '）';
    const types = [
      [/武器/u,'武器'],[/鎧甲|護甲|盔甲/u,'鎧甲'],[/盾牌/u,'盾牌'],
      [/披肩|披風/u,'披肩'],[/鞋子|靴子|鞋類/u,'鞋子'],[/飾品|裝飾品/u,'飾品']
    ];
    for (const [re,name] of types) if (re.test(s)) return name;
    return '';
  }

  function readSelected(uid) {
    const cell = itemCell(uid);
    if (cell && equipped(cell)) return {error:'E 穿戴裝備禁止讀取詳情'};
    const panel = detailPanel();
    if (!cell || !panel || !cell.classList.contains('sel')) return {error:'裝備選取尚未同步'};
    const s = textOf(panel);
    const gs = s.match(/\bGS\s*[:：]?\s*(\d+)/i);
    const tier = s.match(/\bTier\s*[:：]?\s*(\d+)/i);
    if (!gs || !tier) return {error:'詳情缺少 GS 或 Tier'};
    // 僅從 Tier 那一行判斷裝備部位，不從詞綴內的「武器傷害」等文字猜測。
    const lines = s.split(/\n+/).map(norm).filter(Boolean);
    const tierLine = lines.find(line => /\bTier\s*\d+/i.test(line)) || '';
    const slot = slotOf(tierLine);
    if (!slot) return {error:'無法從 Tier 行辨識部位：' + tierLine.slice(0,100)};
    const rarity=qualityFromTierLine(tierLine);
    if (!rarity) return {error:'裝備品質無法辨識；為避免誤取消保護，停止：'+tierLine.slice(0,100)};
    const buttons = [...panel.querySelectorAll('button')].filter(isVisible);
    const cancel = buttons.find(b => norm(textOf(b)) === '取消保護');
    const protect = buttons.find(b => norm(textOf(b)) === '保護');
    if (!cancel && !protect) return {error:'沒有確認到「保護／取消保護」按鈕'};
    const titleLine = lines.findIndex(line => line === '詳情');
    const name = titleLine >= 0 ? lines[titleLine+1] || '' : (lines.find(x => x.includes('改') || x.includes('+')) || '');
    const img = cell.querySelector('img')?.getAttribute('src') || '';
    const panelImgs = [...panel.querySelectorAll('img')].map(e=>e.getAttribute('src') || '');
    const imageDetails=[...panel.querySelectorAll('img')].map(e=>({src:e.getAttribute('src')||'',alt:e.getAttribute('alt')||'',title:e.getAttribute('title')||''}));
    // 避免讀到上一件裝備的詳情：道具圖片通常會出現在右側詳情。
    if (img && panelImgs.length && !panelImgs.some(src=>src.split('/').pop() === img.split('/').pop()))
      return {error:'裝備圖示與右側詳情不一致，略過'};
    // 保存完整右側文字，避免只留下 GS，丟失難以解析的特殊詞綴或卡片資訊。
    const titleIx=lines.findIndex(line=>line==='詳情');
    const heading=titleIx>=0?lines.slice(titleIx+1,titleIx+4).join(' ') : lines.slice(0,3).join(' ');
    const allCardLines=lines.filter(line=>/卡片|卡槽|插卡|slot|card/i.test(line));
    const attributeLines=lines.filter(line=>/^[•●▪★+\-−]|\b(?:HP|SP|STR|INT|AGI|DEX|LUK|VIT|ATK|MATK|DEF|MDEF)\b|%/i.test(line));
    const refine=(heading.match(/(?:\+\s*\d+|\b(?:精煉|强化|強化)\s*[+＋]?\d+)/u)||[])[0]||'';
    return {uid, name, heading, gs:Number(gs[1]), tier:Number(tier[1]), slot, rarity,
      equipped:equipped(cell), protected:Boolean(cancel), icon:img,
      cardLines:allCardLines, cardImages:imageDetails.filter(x=>x.src&&x.src!==img), attributes:attributeLines, refine,
      detailText:s, detailLines:lines, scannedAt:nowString(), error:''};
  }

  async function select(uid) {
    const el = itemCell(uid);
    if (!el) throw Error('背包項目已改變（UID 不見了）：' + uid);
    if (equipped(el)) throw Error('E 穿戴裝備禁止點選：' + uid);
    el.click();
    await pause(WAIT_MS);
    if (aborted) throw Error('使用者已停止');
    for (let tries=0; tries<8; tries++) {
      const c = itemCell(uid);
      if (c && equipped(c)) throw Error('剛才的裝備變成 E 穿戴狀態，停止：' + uid);
      if (c?.classList.contains('sel')) return;
      await pause(100);
    }
    throw Error('無法選取裝備（可能已切換介面）：' + uid);
  }

  function buildPlan() {
    const groups=new Map(ALLOWED_SLOTS.map(slot=>[slot,[]]));
    const output=[];
    for(const r of records){
      if(r.equipped) continue;
      if(!QUALITY_NAMES.includes(r.rarity)) throw Error('未知品質：'+r.uid);
      const allowed=ALLOWED_SLOTS.includes(r.slot);
      const staff=isStaffWeapon(r);
      const isLegendary=r.rarity===TARGET_RARITY;
      r.weaponKind=r.slot==='武器'?(staff?'法杖':'非杖武器'):'';
      r.reason=!allowed?'非指定部位':!isLegendary?'非傳說品質：'+r.rarity:r.slot==='武器'&&!staff?'非杖武器':'';
      r.groupLabel=r.reason?(r.slot==='武器'&&!staff?'武器／非杖（排除）':!isLegendary?'非傳說（排除）':'其他（排除）'):(r.slot==='武器'?'武器／傳說法杖':r.slot);
      r.rank=null;
      r.shouldProtect=false;
      r.action=r.protected?'取消保護':'保持';
      if(r.reason){output.push(r);continue;}
      groups.get(r.slot).push(r);
    }
    for(const [slot,arr] of groups){
      arr.sort((a,b)=>b.gs-a.gs||Number(b.protected)-Number(a.protected)||a.order-b.order);
      arr.forEach((r,i)=>{r.rank=i+1;r.shouldProtect=i<LIMIT;r.action=r.shouldProtect===r.protected?'保持':r.shouldProtect?'保護':'取消保護';output.push(r);});
    }
    return output.sort((a,b)=>a.index-b.index);
  }
  function renderReport() {
    if (!records.length) { $('hp-report').innerHTML=''; return; }
    const nonStaff = plan.filter(r=>r.slot==='武器'&&r.weaponKind==='非杖武器').length;
    const staffCount = plan.filter(r=>r.slot==='武器'&&!r.reason).length;
    const nonLegendary = plan.filter(r=>r.rarity!==TARGET_RARITY).length;
    const order=[...ALLOWED_SLOTS.map(x=>x==='武器'?'武器／傳說法杖':x),'非傳說（排除）','武器／非杖（排除）','其他（排除）'];
    const keys=order.filter(x=>plan.some(r=>r.groupLabel===x));
    let html = `<div><b>非 E 已掃 ${records.length}/${scanMeta.eligible} 件</b>｜E 跳過 ${scanMeta.ignoredE} 件｜背包共 ${scanMeta.total} 件</div>`;
    html += `<div><b>傳說法杖 ${staffCount} 件</b>｜非傳說 ${nonLegendary} 件｜非杖武器 ${nonStaff} 件｜待保護 ${plan.filter(x=>x.action==='保護').length} 件｜待取消 ${plan.filter(x=>x.action==='取消保護').length} 件</div>`;
    html += `<div class="hp-sub">${scanSnapshot?.complete ? '✓ 每件非 E 均已讀取；E 完全沒選取。以下為預覽，尚未更動保護。' : '非 E 尚未完整掃描，禁止執行保護。'}</div>`;
    if (issues.length) html += `<div class="hp-warn">掃描未完整，禁止執行：<br>${issues.map(x=>esc(x)).join('<br>')}</div>`;
    for (const key of keys) {
      const arr=plan.filter(r=>r.groupLabel===key).sort((a,b)=>(a.rank??999999)-(b.rank??999999)||b.gs-a.gs);
      html += `<details><summary><b>${esc(key)}</b>（${arr.length} 件｜保護 ${arr.filter(x=>x.action==='保護').length}／取消 ${arr.filter(x=>x.action==='取消保護').length}）</summary><table><thead><tr><th>名次</th><th>背包格</th><th>名稱</th><th>品質</th><th>GS</th><th>操作</th></tr></thead><tbody>`;
      for (const r of arr) html += `<tr title="${esc(r.reason || r.heading || r.name)}"><td>${r.rank ?? '排除'}</td><td>#${r.index}</td><td>${esc(r.name)}</td><td>${esc(r.rarity)}</td><td>${r.gs}</td><td>${esc(r.action)}</td></tr>`;
      html += '</tbody></table></details>';
    }
    $('hp-report').innerHTML=html;
  }
  async function scan(sendAfter=false) {
    if (running) return;
    running=true; aborted=false; records=[]; plan=[]; issues=[]; scannedAt=0; scanSnapshot=null;
    scanMeta={total:0,eligible:0,ignoredE:0}; controls();
    // 若原本選中 E，不能為了恢復畫面再點它；非 E 的選取狀態才可恢復。
    const originalCell=inv()?.querySelector('.item-cell.sel');
    const original=originalCell && !equipped(originalCell) ? originalCell.dataset.uid : null;
    try {
      const {cells,expected}=validateInventory();
      const baseline=inventoryState();
      if (baseline.total !== expected) throw Error(`背包格 ${baseline.total} 件，全部分類卻是 ${expected} 件；請重新整理。`);
      scanMeta={total:expected,eligible:baseline.eligible.length,ignoredE:baseline.ignoredE.length};
      const positions=positionOf(cells);
      if(new Set(baseline.uids).size !== baseline.uids.length) throw Error('發現重複 UID，停止掃描。');
      // 最重要的排除規則：已穿戴的 E 在點選前就從目標清單排除。
      const uids=baseline.eligible;
      for(let i=0;i<uids.length;i++) {
        if(aborted) throw Error('使用者已停止');
        assertInventoryStable(baseline);
        if(equipped(itemCell(uids[i]))) throw Error('遇到 E 穿戴裝備，禁止點選：'+uids[i]);
        status(`非 E 掃描中 ${i+1}/${uids.length}｜E 略過 ${baseline.ignoredE.length}｜總數 ${expected}。\n只會點開非 E 裝備詳情；不更動保護狀態。`);
        await select(uids[i]);
        let data=readSelected(uids[i]);
        for(let retry=0;retry<4 && data.error;retry++){
          await pause(130); data=readSelected(uids[i]);
        }
        if(data.error) issues.push(`${i+1}. ${data.error}（UID ${uids[i].slice(0,8)}…）`);
        else records.push({...data,...positions.get(uids[i]),order:i});
      }
      assertInventoryStable(baseline);
      if(records.length!==uids.length) issues.push(`只成功讀取 ${records.length}/${uids.length} 件非 E 裝備，不能安全排名。`);
      plan=buildPlan();
      if(!issues.length) scannedAt=Date.now();
      scanSnapshot={version:POLICY_VERSION,policy:'非 E 只保留傳說：武器限法杖，另八部位各保留 GS 前10；非傳說或非杖已保護者可取消；E完全不動',capturedAt:new Date().toISOString(),gameUrl:location.origin,
        expectedCount:expected,discoveredCount:baseline.total,eligibleCount:uids.length,
        skippedEquippedCount:baseline.ignoredE.length,skippedEquippedUIDs:[...baseline.ignoredE],
        scannedCount:records.length,
        complete:!issues.length && records.length===uids.length && baseline.total===uids.length+baseline.ignoredE.length,
        issues:[...issues],items:records.map(x=>({...x}))};
      GM_setValue(SCAN_KEY,JSON.stringify(scanSnapshot));
      status(issues.length
        ? `非 E 已掃 ${records.length}/${uids.length} 件，有辨識失敗；E ${baseline.ignoredE.length} 件已跳過。\n只允許匯出，不能傳送完整報告。\n${issues.slice(0,3).join('\n')}`
        : `成功：非 E 已掃 ${records.length}/${uids.length} 件｜E ${baseline.ignoredE.length} 件跳過｜總數 ${expected}。\n已記錄每件非 E 裝備的背包格、部位、GS、Tier、詞綴及卡片資訊。`);
      if(sendAfter && scanSnapshot.complete) await sendDiscord(scanSnapshot);
      else if(sendAfter && !scanSnapshot.complete) latestDiscord='未傳：非 E 掃描不完整';
    } catch(e) {
      issues.push(String(e.message||e));
      status('掃描中止：'+String(e.message||e));
    } finally {
      if(original && itemCell(original) && !equipped(itemCell(original))) {
        try{itemCell(original).click();}catch{}
      }
      running=false;renderReport();controls();
    }
  }

  // Discord 僅傳一則輕量摘要；逐件完整紀錄仍留在掃描快照／CSV／JSON。
  function chunksOfReport(snapshot){
    const items=snapshot.items || [];
    const countSlot=slot=>items.filter(r=>r.slot===slot).length;
    const staff=items.filter(r=>r.slot==='武器'&&!r.reason).length;
    const otherWeapons=items.filter(r=>r.slot==='武器'&&r.weaponKind==='非杖武器').length;
    const legendary=items.filter(r=>r.rarity===TARGET_RARITY).length;
    const nonLegendary=items.length-legendary;
    const actions={protect:items.filter(r=>r.action==='保護').length,
      unprotect:items.filter(r=>r.action==='取消保護').length,
      unchanged:items.filter(r=>r.action==='保持').length};
    const lines=[
      '🔎 HANS RO 裝備掃描｜'+nowString(),
      '背包 '+snapshot.expectedCount+' 件｜E 跳過 '+snapshot.skippedEquippedCount+' 件｜掃描 '+snapshot.scannedCount+'/'+snapshot.eligibleCount+' 件',
      '傳說 '+legendary+'｜非傳說 '+nonLegendary+'（不保留）',
      '武器：傳說法杖 '+staff+'｜其他武器 '+otherWeapons+'（不保留）',
      '頭上 '+countSlot('頭部（上）')+'｜頭中 '+countSlot('頭部（中）')+'｜頭下 '+countSlot('頭部（下）'),
      '披肩 '+countSlot('披肩')+'｜飾品 '+countSlot('飾品')+'｜鞋子 '+countSlot('鞋子'),
      '盾牌 '+countSlot('盾牌')+'｜衣服 '+countSlot('鎧甲'),
      '傳說指定部位 GS 各前10｜預計保護 '+actions.protect+'｜取消保護 '+actions.unprotect+'｜保持 '+actions.unchanged,
      snapshot.cycleResult ? ('✅ 一鍵流程：'+(snapshot.cycleResult.sale?.empty?'沒有可賣裝備':'已按全部賣掉')+'；已送出返回原點的22下按鍵') : '掃描與保護狀態摘要。'
    ];
    const summary=lines.join('\n');
    if(summary.length>1900)throw Error('摘要長度異常，為避免過長已停止傳送。');
    return [summary];
  }
  function postWebhook(url, content){
    return new Promise((resolve,reject)=>{
      GM_xmlhttpRequest({method:'POST',url,headers:{'Content-Type':'application/json'},
        data:JSON.stringify({content,allowed_mentions:{parse:[]}}), timeout:25000,
        onload:r=>{
          if(r.status>=200&&r.status<300)return resolve({ok:true});
          if(r.status===429){let wait=2000;try{wait=Math.max(1000,Math.ceil((JSON.parse(r.responseText||'{}').retry_after||2)*1000))}catch{};return resolve({ok:false,retry:wait});}
          reject(Error('Discord HTTP '+r.status+'；請確認 Webhook 有效且具備發訊息權限。'));
        },
        onerror:()=>reject(Error('Discord 網路連線失敗')),
        ontimeout:()=>reject(Error('Discord 連線逾時'))
      });
    });
  }
  async function sendDiscord(snapshot){
    if(!snapshot?.complete || snapshot.items?.length!==snapshot.eligibleCount ||
       snapshot.eligibleCount+snapshot.skippedEquippedCount!==snapshot.expectedCount ||
       snapshot.items.some(r=>r.equipped)){
      status('拒絕傳送：非 E 掃描不完整或 E 排除計數異常。');return;
    }
    const hook=savedHook();
    if(!validHook(hook)){
      latestDiscord='尚未傳送：請先在面板儲存 Discord Webhook。';
      $('hp-discord').textContent='Discord：'+latestDiscord;
      status('掃描已保存在本機。先儲存 Discord Webhook，再按「傳送掃描摘要」。');
      return;
    }
    const messages=chunksOfReport(snapshot);let delivered=0;
    latestDiscord=`準備發送 ${messages.length} 段`;
    $('hp-discord').textContent='Discord：'+latestDiscord;
    try{
      for(let i=0;i<messages.length;i++){
        if(aborted)throw Error('使用者已停止傳送');
        status(`Discord 傳送中 ${i+1}/${messages.length}；非 E 已掃 ${snapshot.items.length}，E 略過 ${snapshot.skippedEquippedCount}。`);
        let ok=false;
        for(let retry=0;retry<6;retry++){
          const r=await postWebhook(hook,messages[i]);
          if(r.ok){ok=true;break;}
          await pause(r.retry+200);
          if(aborted)throw Error('使用者已停止傳送');
        }
        if(!ok)throw Error('Discord 限流重試仍失敗，在第'+(i+1)+'段停止。');
        delivered++;
        $('hp-discord').textContent=`Discord：已傳 ${delivered}/${messages.length} 段`;
        if(i<messages.length-1)await pause(1150);
      }
      latestDiscord=`完成：非 E ${snapshot.items.length} 件，E 略過 ${snapshot.skippedEquippedCount} 件，合計 ${delivered} 段（${nowString()}）。`;
      $('hp-discord').textContent='Discord：'+latestDiscord;
      status('Discord 已傳送簡短掃描摘要；完整逐件資料仍可在本機匯出 CSV／JSON。');
    }catch(e){
      latestDiscord=`中斷：已傳 ${delivered}/${messages.length} 段；${String(e.message||e)}`;
      $('hp-discord').textContent='Discord：'+latestDiscord;
      status('Discord 未完整送達：'+latestDiscord+'。可重試，但會重送全部訊息。');
    }
  }
  async function apply() {
    if (running || !scannedAt || issues.length || !scanSnapshot?.complete || scanSnapshot.version !== POLICY_VERSION) return;
    const tasks = [...plan.filter(x=>x.action==='保護'),...plan.filter(x=>x.action==='取消保護')];
    if(tasks.some(x=>x.equipped)) {status('安全阻擋：規劃清單混入 E 裝備，請重新掃描。');return false;}
    if (!tasks.length) {status('所有非 E 裝備已符合保護規則，不需要修改。');return true;}
    // 使用者已授權：免確認；每件裝備仍逐件驗證 ID/GS/Tier/品質/E。
    running=true;aborted=false;controls();
    let completed=0;
    const oldSelected = inv()?.querySelector('.item-cell.sel');
    const original = oldSelected && !equipped(oldSelected) ? oldSelected.dataset.uid : null;
    try {
      validateInventory();
      const base={uids:[...scanSnapshot.items.map(r=>r.uid),...scanSnapshot.skippedEquippedUIDs]};
      const curr=inventoryState();
      const current = new Set(curr.uids);
      if (curr.total !== scanSnapshot.expectedCount ||
          curr.ignoredE.length !== scanSnapshot.skippedEquippedCount ||
          scanSnapshot.skippedEquippedUIDs.some(uid => !curr.ignoredE.includes(uid)) ||
          curr.eligible.length !== records.length ||
          records.some(r=>!current.has(r.uid) || !curr.eligible.includes(r.uid)))
        throw Error('背包或 E 穿戴狀態與掃描時不同，請重新掃描。');
      for (const task of tasks) {
        if (aborted) throw Error('使用者已停止');
        status(`執行 ${completed+1}/${tasks.length}：${task.slot} GS ${task.gs} → ${task.action}`);
        if(equipped(itemCell(task.uid))) throw Error('安全阻擋：目標已穿戴 E，立即停止。');
        await select(task.uid);
        const cur = readSelected(task.uid);
        if (cur.error || cur.equipped || cur.gs !== task.gs || cur.slot !== task.slot || cur.tier !== task.tier || cur.rarity !== task.rarity || cur.name !== task.name || isStaffWeapon(cur) !== isStaffWeapon(task))
          throw Error('裝備狀態、分數或部位變更，已停止（' + task.slot + ' GS ' + task.gs + '）。');
        if(cur.protected === task.shouldProtect){completed++;continue;}
        const panel=detailPanel();
        const label = task.shouldProtect ? '保護' : '取消保護';
        const button=[...(panel?.querySelectorAll('button')||[])].find(b=>norm(textOf(b))===label && isVisible(b));
        if(!button) throw Error('找不到「'+label+'」按鈕，停止。');
        // 明確禁用任何丟棄、賣裝、穿戴類型操作。
        button.click();
        await pause(260);
        let after=readSelected(task.uid);
        for(let n=0;n<8 && (after.error || after.protected!==task.shouldProtect);n++){
          await pause(150);
          after=readSelected(task.uid);
        }
        if(after.error || after.protected!==task.shouldProtect)
          throw Error('按「'+label+'」後沒有驗證到預期結果，已停止，請檢查遊戲。');
        task.protected=after.protected;task.action='已完成：'+label;
        completed++;renderReport();
      }
      scannedAt=0; scanSnapshot=null;
      $('hp-discord').textContent='Discord：保護狀態剛修改，舊快照已失效；請重新掃描再傳送。';
      status(`保護狀態調整完成：${completed} 件；E 穿戴裝備完全不動。`);
      return true;
    } catch(e) {
      scannedAt=0; scanSnapshot=null;
      $('hp-discord').textContent='Discord：保護操作已嘗試，請重新掃描取得目前狀態。';
      status(`已停止：完成 ${completed}/${tasks.length} 件。\n${String(e.message||e)}\n請重新掃描後才可繼續。`);
      console.warn('[HANS 前十保護]',e);
      return false;
    } finally {
      if(original && itemCell(original) && !equipped(itemCell(original))) {try{itemCell(original).click();}catch{}}
      running=false;controls();
    }
  }

  const csvCell = v => {
    let s=String(v??''); if (/^\s*[=+@-]/.test(s))s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  };
  function download(filename, body, type){
    const blob=new Blob([body],{type});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=filename;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
  }
  function exportCSV(){
    const headers=['掃描時間','背包第幾格','列','欄','裝備部位','法師保留分類','排除原因','該部位GS排名','裝備名稱','品質','GS','Tier','E穿戴中','已保護','前十目標保護','預覽操作','UID','裝備圖示','強化/精煉','屬性','卡片/卡槽','卡片與其他圖片資訊','完整詳情'];
    const rows=records.map(r=>[r.scannedAt,r.index,r.row,r.col,r.slot,r.groupLabel||r.slot,r.reason||'',r.rank??'',r.name,r.rarity,r.gs,r.tier,r.equipped?'是':'否',r.protected?'是':'否',r.shouldProtect?'是':'否',r.action,r.uid,r.icon,r.refine,(r.attributes||[]).join('；'),(r.cardLines||[]).join('；'),JSON.stringify(r.cardImages||[]),r.detailText]);
    const csv='\ufeff'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
    download('HANS_RO_全背包逐件裝備紀錄_'+new Date().toISOString().slice(0,10)+'.csv',csv,'text/csv;charset=utf-8');
  }
  function exportJSON(){
    const data=scanSnapshot||{version:POLICY_VERSION,complete:false,expectedCount:scanMeta.total,eligibleCount:scanMeta.eligible,skippedEquippedCount:scanMeta.ignoredE,issues,items:records};
    download('HANS_RO_全背包逐件裝備紀錄_'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');
  }
  $('hp-scan').onclick=()=>scan(false);
  $('hp-scan-dc').onclick=()=>scan(true);
  $('hp-apply').onclick=apply;
  $('hp-export').onclick=exportCSV;
  $('hp-json').onclick=exportJSON;
  $('hp-send').onclick=async()=>{
    if(running||!scanSnapshot?.complete)return;
    running=true;aborted=false;controls();
    try{await sendDiscord(scanSnapshot)}finally{running=false;controls()}
  };

  // ===== 固定商人路線與販賣兩步確認；可單獨執行，不影響裝備掃描 =====
  function initMerchantRoute() {
    const GRADES=Object.freeze(['普通','優良','稀有','史詩','傳說']);
    const OUTBOUND=Object.freeze([['down',9],['right',13]]);
    const INBOUND=Object.freeze([['left',13],['up',9]]);
    const KEYMAP=Object.freeze({wasd:{down:['s','KeyS'],right:['d','KeyD'],left:['a','KeyA'],up:['w','KeyW']},
      arrows:{down:['ArrowDown','ArrowDown'],right:['ArrowRight','ArrowRight'],left:['ArrowLeft','ArrowLeft'],up:['ArrowUp','ArrowUp']}});
    const $r=id=>pane.querySelector('#'+id);
    const inform=message=>{
      const el=$r('hp-route-status');if(el)el.textContent=message;
      if(stageId)document.dispatchEvent(new CustomEvent('hans-ro-stage-inventory-progress',{detail:{id:stageId,message:String(message)}}));
    };
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const buttons={go:$r('hp-route-go'),talk:$r('hp-route-talk'),back:$r('hp-route-return'),full:$r('hp-route-run'),
      sell:$r('hp-route-sell'),stop:$r('hp-route-stop'),keys:$r('hp-route-keys')};
    let busy=false,stopped=false,pressed=null;
    const isReady=()=>!busy&&!running&&!autoRunning;
    const refresh=()=>{
      for(const key of ['go','talk','back','full','sell'])buttons[key].disabled=!isReady();
      buttons.stop.disabled=!busy;
    };
    const keyEntry=dir=>{
      const mode=buttons.keys.value==='arrows'?'arrows':'wasd';
      return KEYMAP[mode][dir];
    };
    const emit=(entry,down)=>{
      window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',
        {key:entry[0],code:entry[1],bubbles:true,cancelable:true}));
    };
    const release=()=>{if(pressed){emit(pressed,false);pressed=null;}};
    function activeCheck(){
      if(stopped)throw Error('你已停止移動／販賣');
      if(document.hidden)throw Error('切換分頁時停止，以免走位偏移');
    }
    function panel(){
      const matches=[...document.querySelectorAll('button')]
        .filter(b=>!pane.contains(b)&&isVisible(b)&&/^一鍵販賣(?:[（(]|$)/u.test(norm(textOf(b))));
      for(const button of matches){
        for(let node=button.parentElement,n=0;node&&n<10&&node!==document.body;node=node.parentElement,n++){
          const content=(node.innerText||node.textContent||'').replace(/\s+/g,'');
          if(content.length>16000)break;
          if(GRADES.every(g=>content.includes(g))&&content.includes('一鍵販賣')&&
            content.includes('包含已插卡')&&content.includes('包含已精煉')){
            return {root:node,button};
          }
        }
      }
      return null;
    }
    const shopOpen=()=>Boolean(panel());
    async function walk(reverse){
      const seq=reverse?INBOUND:OUTBOUND;
      const tap=200; // 使用者實測：每次方向按鍵固定 200ms
      const gap=115;
      let completed=0;
      if(shopOpen())throw Error('商人視窗尚未關閉，不能移動');
      for(const [direction,count] of seq){
        for(let n=1;n<=count;n++){
          activeCheck();
          if(shopOpen())throw Error('移動中商人視窗被開啟，已停止');
          const entry=keyEntry(direction);
          inform((reverse?'回原點':'往商人')+'：'+({down:'下',right:'右',left:'左',up:'上'}[direction])+
            ' '+n+'/'+count+' 下｜總進度 '+(++completed)+'/22');
          pressed=entry;emit(entry,true);
          try{await sleep(tap);}finally{release();}
          activeCheck();
          await sleep(gap);
        }
      }
      inform((reverse?'回程':'去程')+'已送出 22 下按鍵，請依角色實際位置核對。');
    }
    function npcLabel(){
      const candidates=[...document.querySelectorAll('span,div,b,strong,small,button,[role="button"]')]
        .filter(el=>!pane.contains(el)&&isVisible(el)&&norm(textOf(el))==='礦石商人');
      candidates.sort((a,b)=>a.children.length-b.children.length);
      return candidates[0]||null;
    }
    function tryNpc(){
      const label=npcLabel();
      if(!label)return false;
      const clickable=label.closest('button,[role="button"],[data-npc],.npc')||label;
      if(pane.contains(clickable)||!isVisible(clickable))return false;
      clickable.click();
      return true;
    }
    async function pressSpace(){
      activeCheck();
      const eventOptions={key:' ',code:'Space',keyCode:32,which:32,bubbles:true,cancelable:true};
      // 由 document 送出並冒泡至 window，兼容遊戲掛在 document/window 的互動監聽器。
      inform('已抵達礦石商人附近：按空白鍵互動...');
      document.dispatchEvent(new KeyboardEvent('keydown',eventOptions));
      await sleep(200);
      document.dispatchEvent(new KeyboardEvent('keyup',eventOptions));
      activeCheck();
    }
    function findSellTab(){
      const tabs=[...document.querySelectorAll('button,[role="tab"]')]
        .filter(b=>!pane.contains(b)&&isVisible(b)&&norm(textOf(b))==='販賣'&&!b.disabled);
      // 若同時有多個「販賣」控制項，為避免誤按，不自行猜哪個屬於商人。
      return tabs.length===1?tabs[0]:null;
    }
    async function waitForSellPage(ms){
      const until=Date.now()+ms;
      let tabClicked=false;
      while(Date.now()<until){
        activeCheck();
        if(shopOpen())return true;
        if(!tabClicked){
          const tab=findSellTab();
          if(tab){
            inform('商人互動已開啟，切換「販賣」分頁...');
            tab.click();
            tabClicked=true;
          }
        }
        await sleep(160);
      }
      return shopOpen();
    }
    async function openShop(){
      if(shopOpen())return true;
      // 館長／遠征隊長同樣用空白鍵 NPC 互動，先用真正的互動鍵而不是點文字標籤。
      await pressSpace();
      if(await waitForSellPage(2400))return true;
      activeCheck();
      // 若該 NPC 必須點擊名稱才能觸發，才補做一次點選，不盲目點地圖座標。
      if(tryNpc()){
        inform('空白鍵後尚未開啟，正在嘗試點擊「礦石商人」...');
        if(await waitForSellPage(1600))return true;
      }
      // 最後只再補一次空白鍵，不連續狂按以免開錯 NPC。
      await pressSpace();
      if(await waitForSellPage(2500))return true;
      return false;
    }
    const checkboxFor=(root,labelText,exact=false)=>{
      const labels=[...root.querySelectorAll('label')];
      const label=labels.find(x=>{
        const txt=norm(textOf(x));
        return exact?new RegExp('^'+labelText+'(?:\\s*\\d+)?$','u').test(txt):txt.includes(labelText);
      });
      if(!label)return null;
      const checkbox=label.querySelector('input[type="checkbox"]')||
        (label.htmlFor?document.getElementById(label.htmlFor):null);
      return checkbox?.type==='checkbox'?checkbox:null;
    };
    // 遊戲的五種品質與數量顯示在「一鍵販賣」上方，不能從按鈕文字後面截取。
    // 以品質 label 和「一鍵販賣（N 件・點數）」分別驗證數量，避免掃不到就跳過販賣。
    function countsFrom(p){
      const labels=[...p.root.querySelectorAll('label')];
      const counts={};
      for(const grade of GRADES){
        const re=new RegExp('^'+grade+'\\s*([\\d,]+)\\s*$','u');
        const found=labels.map(x=>norm(textOf(x))).map(x=>x.match(re)).find(Boolean);
        counts[grade]=found?Number(found[1].replace(/,/g,'')):null;
      }
      const caption=norm(textOf(p.button));
      const m=caption.match(/^一鍵販賣\s*[\(（]\s*([\d,]+)\s*件/u);
      const buttonTotal=m?Number(m[1].replace(/,/g,'')):null;
      const qualityTotal=Object.values(counts).every(Number.isFinite)?
        Object.values(counts).reduce((a,b)=>a+b,0):null;
      if(buttonTotal!==null&&qualityTotal!==null&&buttonTotal!==qualityTotal)
        throw Error('品質數量與「一鍵販賣」總件數不同，暫停以避免誤賣：'+qualityTotal+' / '+buttonTotal);
      const total=buttonTotal??qualityTotal;
      if(total===null||!Number.isSafeInteger(total)||total<0)
        throw Error('讀不到「一鍵販賣（N 件）」或品質合計，停止操作。');
      return {counts,total,buttonTotal,qualityTotal};
    }
    async function setQuality(p){
      for(const g of GRADES){
        activeCheck();
        const cb=checkboxFor(p.root,g,true);
        if(!cb||cb.disabled)throw Error('讀不到品質勾選框：'+g);
        inform('正在勾選 '+g+' 品質...');
        if(!cb.checked){cb.click();await sleep(380);}
        if(!cb.checked)throw Error('無法勾選品質：'+g);
        await sleep(270);
      }
      for(const name of ['包含已插卡','包含已精煉']){
        const cb=checkboxFor(p.root,name);
        if(!cb)throw Error('找不到安全設定：'+name);
        if(cb.checked){cb.click();await sleep(380);}
        if(cb.checked)throw Error('無法關閉安全設定：'+name);
      }
      inform('五種品質已勾選，等待遊戲更新待售件數...');
      await sleep(1000);
      const latest=panel();
      if(!latest)throw Error('品質勾選後商人介面消失，停止操作。');
      for(const g of GRADES){if(checkboxFor(latest.root,g,true)?.checked!==true)throw Error('品質狀態未同步：'+g);}
      return countsFrom(latest);
    }
    function allSellButtons(){
      return [...document.querySelectorAll('button')].filter(b=>
        !pane.contains(b)&&isVisible(b)&&norm(textOf(b))==='全部賣掉');
    }
    async function waitSellAllButton(){
      const until=Date.now()+6500;
      while(Date.now()<until){
        activeCheck();
        const found=allSellButtons();
        if(found.length===1)return found[0];
        if(found.length>1)throw Error('畫面出現多個「全部賣掉」按鈕，停止以免誤點');
        await sleep(160);
      }
      return null;
    }
    function verifyProtectionForSale(){
      if(!scanSnapshot?.complete || scanSnapshot.version!==POLICY_VERSION ||
        scanSnapshot.items.length!==scanSnapshot.eligibleCount ||
        scanSnapshot.eligibleCount+scanSnapshot.skippedEquippedCount!==scanSnapshot.expectedCount ||
        scanSnapshot.items.some(r=>r.equipped)){
        throw Error('掃描資料不完整，禁止販賣。請先完成逐件掃描及自動保護。');
      }
      const invalid=plan.filter(r=>r.action!=='保持');
      if(invalid.length)throw Error('有 '+invalid.length+' 件保護狀態未符合規則，禁止販賣。');
      if(scanSnapshot.items.some(r=>r.shouldProtect&&!r.protected))
        throw Error('有傳說前十名裝備尚未保護，禁止販賣。');
    }
    async function sellNow(){
      verifyProtectionForSale();
      const p=panel();
      if(!p)throw Error('找不到商人的「販賣」頁，請先開啟。');
      const summary=await setQuality(p);
      const {total,counts}=summary;
      if(total===0){
        inform('五品質已勾選，但目前沒有可販賣裝備（或按鈕不可用）；未販賣。');
        return {empty:true};
      }
      // 已明確授權免確認：完整掃描／保護驗證成功才操作一鍵販賣。
      activeCheck();
      const current=panel();
      if(!current||current.button.disabled)throw Error('商人販賣按鈕不存在或無法操作，停止');
      if(countsFrom(current).total!==total)throw Error('勾選後待售總數改變，暫停販賣');
      for(const g of GRADES){
        if(!checkboxFor(current.root,g,true)?.checked)throw Error('品質設定變動：'+g);
      }
      for(const name of ['包含已插卡','包含已精煉']){
        if(checkboxFor(current.root,name)?.checked!==false)throw Error('安全排除選項狀態異常：'+name);
      }
      inform('已勾選五品質｜待售 '+total+' 件。稍後按「一鍵販賣」...');
      await sleep(1000);
      activeCheck();
      const ready=panel();
      if(!ready||ready.button.disabled)throw Error('等待後「一鍵販賣」仍不可用，停止販賣。');
      const currentCount=countsFrom(ready);
      if(currentCount.total!==total)throw Error('等待後待售件數變動，停止販賣。');
      for(const g of GRADES){if(checkboxFor(ready.root,g,true)?.checked!==true)throw Error('點販賣前品質未保持勾選：'+g);}
      inform('按下「一鍵販賣」，等待確認視窗...');
      ready.button.click();
      await sleep(950);
      const all=await waitSellAllButton();
      if(!all)throw Error('按下一鍵販賣後，沒有找到「全部賣掉」；請人工查看，不會自動返程。');
      if(all.disabled)throw Error('「全部賣掉」目前不可用，停止。');
      activeCheck();
      // 只按唯一可見且文字完全相符的確認按鈕，不推測或代按其他選項。
      inform('已找到「全部賣掉」，稍後確認出售 '+total+' 件...');
      await sleep(1100);
      activeCheck();
      if(!all.isConnected||all.disabled||allSellButtons().length!==1)throw Error('販賣確認視窗狀態已變更，停止。');
      inform('按下「全部賣掉」，等待遊戲完成...');
      all.click();
      await sleep(900);
      // 等遊戲消除「全部賣掉」確認框；不能用固定 650ms 誤判動畫延遲。
      const confirmedBy=Date.now()+5000;
      while(allSellButtons().length && Date.now()<confirmedBy){
        activeCheck();
        await sleep(160);
      }
      if(allSellButtons().length)throw Error('按「全部賣掉」後確認視窗仍在，停止後續關閉與返程。');
      inform('「全部賣掉」確認框已消失，稍後關閉礦石商人視窗...');
      await sleep(1000);
      return {empty:false};
    }
    // 「關閉」在商人視窗底部，往往不在一鍵販賣設定區 p.root 的子節點內。
    // 從設定區逐層往外找同時包含「礦石商人」標題和唯一「關閉」按鈕的最小商人視窗。
    function merchantCloseButton(p){
      const buttons=[...document.querySelectorAll('button,[role="button"],input[type="button"]')]
        .filter(b=>!pane.contains(b)&&isVisible(b)&&!b.disabled);
      const closers=buttons.filter(b=>{
        const label=norm(b.value||textOf(b));
        const title=norm(b.getAttribute('title')||b.getAttribute('aria-label')||'');
        return /^(關閉|×|✕|X)$/iu.test(label)||/^(關閉|關閉商人)$/u.test(title);
      });
      for(let ancestor=p.root;ancestor&&ancestor!==document.body;ancestor=ancestor.parentElement){
        if(!ancestor.contains(p.button))continue;
        const text=textOf(ancestor);
        if(text.length>30000)break;
        if(!text.includes('礦石商人'))continue;
        const local=closers.filter(b=>ancestor.contains(b));
        if(local.length===1)return local[0];
        if(local.length>1){
          const explicit=local.filter(b=>norm(b.value||textOf(b))==='關閉');
          if(explicit.length===1)return explicit[0];
          throw Error('商人視窗出現多個關閉按鈕，停止以免誤關其他介面。');
        }
      }
      return null;
    }
    async function closeShop(){
      activeCheck();
      if(allSellButtons().length)throw Error('確認賣裝的視窗還在，不能關閉商人。');
      const p=panel();
      if(!p)return true; // 商人已自行消失
      const btn=merchantCloseButton(p);
      if(!btn)throw Error('找不到礦石商人視窗底部的「關閉」按鈕，禁止返程。');
      inform('稍候關閉礦石商人視窗...');
      await sleep(850);
      activeCheck();
      if(!btn.isConnected||btn.disabled)throw Error('商人關閉按鈕狀態已改變，停止。');
      inform('正在按商人視窗底部「關閉」...');
      btn.click();
      const until=Date.now()+5000;
      while(Date.now()<until){
        activeCheck();
        if(!shopOpen()){
          inform('商人視窗已關閉，準備左13下、上9下原路返回...');
          await sleep(1100);
          activeCheck();
          return true;
        }
        await sleep(140);
      }
      throw Error('已按「關閉」，但仍看到商人視窗，禁止移動。');
    }
    async function operate(action,internal=false){
      if((!internal&&!isReady())||busy||running)return null;
      busy=true;stopped=false;refresh();
      try{
        if(action==='talk'){
          if(!await openShop())throw Error('空白鍵已嘗試，但礦石商人仍未開啟。請確認角色貼近 NPC 並截圖，目前不會自動販賣。');
          inform('商人「販賣」頁已成功開啟，可按「商人已開：販賣」。');
          return;
        }
        if(action==='go'){
          await walk(false);
          if(!await openShop())throw Error('已走到商人附近，但未能開啟「販賣」頁；請手動點礦石商人。');
          inform('已抵達並開啟商人「販賣」頁，可按「商人已開：販賣」。');
          return;
        }
        if(action==='back'){
          if(!await closeShop())throw Error('商人頁還開著，請先關閉再返程。');
          await walk(true);
          inform('已送出 ←13、↑9；請核對是否回到原點。');
          return;
        }
        if(action==='sell'){
          await sellNow();
          return;
        }
        if(action==='full'){
          verifyProtectionForSale();
          if(!shopOpen()){
            await walk(false);
            if(!await openShop())throw Error('已走到商人附近，但未能開啟販賣頁，請手動開啟後按「商人已開：販賣」。');
          }
          const result=await sellNow();
          if(!await closeShop())throw Error('商人視窗沒有關閉，已停止返程，請手動關閉。');
          await walk(true);
          inform((result.empty?'沒有可賣裝備；':'已按下全部賣掉；')+'已送出 ←13、↑9，請核對返回位置。');
          return {done:true,sale:result,returned:true};
        }
      }catch(e){
        inform('停止：'+String(e?.message||e));
        console.warn('[HANS 礦石商人固定路線]',e);
        if(internal)throw e;
        return null;
      }finally{release();busy=false;refresh();}
    }
    buttons.go.onclick=()=>operate('go');
    buttons.talk.onclick=()=>operate('talk');
    buttons.back.onclick=()=>operate('back');
    buttons.sell.onclick=()=>operate('sell');
    buttons.full.onclick=()=>operate('full');
    buttons.stop.onclick=()=>{stopped=true;autoAbort=true;aborted=true;release();inform('已請求停止；鬆開所有方向鍵。');};
    document.addEventListener('hans-merchant-stop',()=>{stopped=true;release();});
    runMerchant=operate;
    refresh();
  }

  // 一鍵執行：若任何階段資料不完整，後續販賣立即中斷。
  async function keyC(){
    const opt={key:'c',code:'KeyC',bubbles:true,cancelable:true};
    document.dispatchEvent(new KeyboardEvent('keydown',opt));
    await pause(180);
    document.dispatchEvent(new KeyboardEvent('keyup',opt));
    await pause(350);
  }
  async function openBag(){
    try{validateInventory();return;}catch{}
    if(!inv()||!isVisible(inv()))await keyC();
    let opts=[...document.querySelectorAll('button,[role="tab"]')].filter(isVisible);
    const bag=opts.find(el=>norm(textOf(el))==='背包');
    if(bag){bag.click();await pause(300);}
    opts=[...document.querySelectorAll('button')].filter(isVisible);
    const all=opts.find(el=>/^全部\s*\d+$/u.test(norm(textOf(el))));
    if(all){all.click();await pause(300);}
    validateInventory();
  }
  // 背包屬於角色畫面；必須點「回到普隆德拉」才會回到可行走的城鎮。
  // 只操作明確唯一的回城按鈕，不使用 C 來猜測視窗是否關閉。
  function findPronteraReturn(){
    const candidates=[...document.querySelectorAll('button,[role="button"],input[type="button"]')]
      .filter(el=>!pane.contains(el)&&isVisible(el)&&
        norm(el.value||textOf(el)).replace(/\s+/g,'')==='回到普隆德拉'&&!el.disabled);
    if(candidates.length>1)throw Error('找到多個「回到普隆德拉」按鈕，已停止，避免誤點。');
    return candidates[0]||null;
  }
  function townSceneVisible(){
    // 城鎮中的 NPC 名牌是可以核對的畫面訊號，避免單憑按鍵完成就認定回城。
    const labels=new Set(['遠征隊長','礦石商人','裝備商人','坐騎管理員','卡片回收員','寵物飼育員']);
    return [...document.querySelectorAll('span,div,b,strong,small,button')]
      .some(el=>el.childElementCount<=1&&!pane.contains(el)&&isVisible(el)&&labels.has(norm(textOf(el))));
  }
  async function returnToProntera(){
    checkAutoStop();
    const button=findPronteraReturn();
    if(!button)throw Error('掃描結束，但找不到「回到普隆德拉」按鈕；為避免走位錯誤，已停止。');
    status('④ 點擊「回到普隆德拉」，等待城鎮場景載入...');
    button.click();
    const timeout=Date.now()+12000;
    while(Date.now()<timeout){
      checkAutoStop();
      await pause(250);
      const noBag=!inv()||!isVisible(inv());
      const noReturn=!findPronteraReturn();
      if(noBag&&noReturn&&townSceneVisible()){
        await pause(500);
        checkAutoStop();
        return;
      }
    }
    throw Error('已點「回到普隆德拉」，但未確認已回到可移動的主城。已停止販賣與走位，請檢查畫面。');
  }
  const checkAutoStop=()=>{if(autoAbort||aborted)throw Error('使用者已停止');};
  async function runOneTouch(requestId=null){
    if(autoRunning||running){
      if(requestId)document.dispatchEvent(new CustomEvent('hans-ro-stage-inventory-result',{detail:{id:requestId,ok:false,error:'巡檢功能忙碌中'}}));
      return;
    }
    stageId=requestId;
    let succeeded=false,failedReason='';
    autoRunning=true;autoAbort=false;aborted=false;controls();
    try {
      status('① 開背包並掃描非 E 裝備...');
      await openBag();checkAutoStop();
      await scan(false);
      if(!scanSnapshot?.complete||issues.length)throw Error('首次掃描不完整，已停止。');
      checkAutoStop();
      status('② 正在自動保護傳說前十...');
      const didApply=await apply();
      if(!didApply)throw Error('保護執行失敗，禁止販賣。');
      checkAutoStop();
      status('③ 第二次掃描，逐件確認保護結果...');
      await scan(false);
      if(!scanSnapshot?.complete||issues.length||scanSnapshot.version!==POLICY_VERSION||
        scanSnapshot.items.length!==scanSnapshot.eligibleCount)throw Error('複掃驗證失敗，禁止販賣。');
      if(plan.some(x=>x.action!=='保持'))throw Error('仍有保護狀態不符的裝備，禁止販賣。');
      checkAutoStop();
      const verified=JSON.parse(JSON.stringify(scanSnapshot));
      status('④ 回到普隆德拉，確定切換主城畫面後再去商人...');
      await returnToProntera();checkAutoStop();
      status('⑤ 主城已確認，正在前往礦石商人、販賣並返回...');
      const result=await runMerchant('full',true);
      if(!result?.done)throw Error('商人販賣或回程未完成。');
      if(validHook(savedHook()))await sendDiscord({...verified,cycleResult:result});
      status(result.sale?.empty?'✅ 完成：已保護並驗證；商人無可售裝備，已送出返程。':
        '✅ 完成：已保護並驗證；已按全部賣掉，已送出返程。');
      succeeded=true;
    }catch(e){
      failedReason=String(e?.message||e);
      status('⛔ 一鍵流程停止：'+failedReason);
      console.warn('[HANS 一鍵流程]',e);
    }finally{
      autoRunning=false;controls();
      if(requestId)document.dispatchEvent(new CustomEvent('hans-ro-stage-inventory-result',
        {detail:{id:requestId,ok:succeeded,error:failedReason}}));
      stageId=null;
    }
  }
  $('hp-full-cycle').onclick=()=>runOneTouch(null);
  document.addEventListener('hans-ro-stage-inventory-stop',()=>{
    aborted=true;autoAbort=true;
    document.dispatchEvent(new Event('hans-merchant-stop'));
  });
  document.addEventListener('hans-ro-stage-inventory-request',evt=>{
    const id=evt.detail?.id;
    if(typeof id==='string'&&/^round-[0-9]+-[a-z0-9]+$/.test(id))runOneTouch(id);
  });
  initMerchantRoute();
  controls();
  document.dispatchEvent(new CustomEvent('hans-ro-stage-inventory-ready',{detail:{source:'embedded',version:'2.6.5'}}));
})();
