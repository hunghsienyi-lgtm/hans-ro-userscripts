// ==UserScript==
// @name         HANS RO 戰利品全紀錄｜金色通知＋每場總表
// @namespace    ro-local-loot-journal
// @version      0.5.2
// @description  HANS 專用：記錄可辨識掉落；傳說（金色）即時通知；每場結算推送總表；不操作遊戲。
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
  const UI_ID = 'ro-loot-journal-v05-ui';
  const VERSION = '0.5.2';
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
  let currentRun=jsonRead(RUN_KEY,null);
  if (!currentRun || typeof currentRun!=='object' || !currentRun.id || !['active','settled'].includes(currentRun.phase)) currentRun=null;
  let resultSeenAt=0;
  let lastSummaryText='';
  let sending=false, nextAllowedAt=0, lastStatus='等待掉寶', lastDiagnostic='尚未掃描',lastPopupText='',lastRecord=null;
  let popupWasVisible=false, previousPopupRoot=null, episodeSeen=new Set(), lastCaptureKey='';
  let summaryWasVisible=false, summarySeen=new Set(), scanQueued=false, userInitiatedTest=false;
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
      startedAt:nowISO(),phase:'active',summaryQueued:false,reason};
    resultSeenAt=0;saveRun();updateUI();return currentRun;
  }
  function ensureRun(){
    if(!currentRun || currentRun.phase==='settled')return beginRun('首次取得／下一局');
    return currentRun;
  }
  function updateUI(){
    if(countEl)countEl.textContent=`共 ${records.length}｜本場 ${runRecords().length}`;
    if(recentEl)recentEl.textContent=`最近：${lastRecord?`${lastRecord.name}（${typeName(lastRecord)}）`:'尚無'}`;
    if(discordEl)discordEl.textContent=`Discord：${settings.notify?'開':'關'}｜金色即時＋結算總表｜待送 ${outbox.length}${sending?'（發送中）':''}`;
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
    if(settings.notify && isGold(rec))queueDiscordPayload(discordPayload(rec),`金色｜${rec.name}`);
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
  // 結算畫面：卡片若只顯示圖示，嘗試讀取 alt/title；取不到名稱只標記未辨識，不造假。
  function scanSummaryCards(){
    if(!settings.running)return;
    const allText=String(document.body?.innerText||'');
    const resultVisible=/你存活下來了|You survived|Run Results|獲得的戰利品/i.test(allText) && /獲得的卡片|Cards obtained|Obtained cards/i.test(allText);
    if(!resultVisible){summaryWasVisible=false;summarySeen.clear();return;}
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
        const popupCount=runRecords().filter(x=>typeName(x)==='卡片'&&x.name===name&&x.origin==='掉落彈窗').length;
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
    return /你存活下來了|你倒下了|You survived|You died|Run Results|Game Over|戰鬥結算|本局傷害/i.test(t)
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
          `開局／開始記錄：${startTime}`,part,
          '※ 此表統計本場由畫面成功辨識的掉落；若道具未顯示文字或腳本未運作，無法補回。'
        ].join('\n\n').slice(0,3900),
        footer:{text:`RO Survivors · ${run.id} · 共 ${parts.length} 段`},timestamp:run.settledAt||nowISO()}]
    }));
  }
  function finishRun(reason){
    if(!settings.running || !currentRun || currentRun.phase!=='active'||currentRun.summaryQueued)return;
    // 最後再掃一次結算卡片，先收齊卡片縮圖再封存本場。
    scanSummaryCards();
    currentRun.phase='settled';currentRun.settledAt=nowISO();currentRun.summaryQueued=true;
    saveRun();
    const payloads=runSummaryPayloads(currentRun);
    if(settings.notify)payloads.forEach((payload,i)=>queueDiscordPayload(payload,`本場總表 ${i+1}/${payloads.length}`));
    lastSummaryText=`已結算 ${runRecords().length} 件（${reason}）`;
    status(settings.notify?`${lastSummaryText}，已加入 DC 待送`:`${lastSummaryText}，Discord 已關閉`);
    updateUI();
  }
  function checkResult(){
    if(!settings.running)return;
    if(!resultVisible()){resultSeenAt=0;return;}
    scanSummaryCards();
    if(!resultSeenAt)resultSeenAt=Date.now();
    if(Date.now()-resultSeenAt>900)finishRun('偵測結算畫面');
  }
  function beforeTransition(evt){
    const btn=evt.target?.closest?.('button,[role="button"]');
    if(!btn || !visible(btn))return;
    const name=label(btn).replace(/\s/g,'');
    if(/^(?:前往野外[！!]?|GoToField|EnterTheField)$/i.test(name)&&evt.type==='click'&&settings.running){
      // 只在確認重新進場時開始新局；不影響原有選關腳本。
      beginRun('前往野外');
    }
    if(/^(?:返回[角腳]色|回到角色|ReturnToCharacter|BackToCharacter)$/i.test(name)&&resultVisible()){
      scanSummaryCards();finishRun('按下返回角色');
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
    ui.innerHTML=`<button type="button" id="roj4-open" style="border:0;background:transparent;color:white;cursor:pointer;font-weight:700" title="HANS 戰利品腳本 v0.5.2 已載入">📦 HANS 戰利品 <span id="roj4-count">共 0</span> ▾</button>
      <div id="roj4-menu" hidden style="width:265px;max-width:80vw;padding-top:6px">
        <div style="font-size:10px;opacity:.78">HANS 腳本 v0.5.2 已載入｜${location.hostname}</div><div id="roj4-state">等待掉寶</div><div id="roj4-recent" style="overflow-wrap:anywhere">最近：尚無</div>
        <div id="roj4-discord">Discord：開｜待送 0</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
          <button id="roj4-toggle">暫停紀錄</button><button id="roj4-notify">關閉 DC</button>
          <button id="roj4-webhook">設定 DC Webhook</button><button id="roj4-test">傳送 DC 測試</button><button id="roj4-retry">重試待送</button>
          <button id="roj4-csv">匯出 CSV</button><button id="roj4-json">匯出 JSON</button>
          <button id="roj4-scan">立即掃描</button><button id="roj4-diag">複製診斷</button>
        </div>
        <div style="opacity:.8;font-size:10px;padding-top:5px">僅「傳說（金色）」逐件推播；每場結算後推送本場已辨識全部戰利品。請定期匯出備份。</div>
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
    ui.querySelector('#roj4-json').onclick=()=>exportData('json');
    ui.querySelector('#roj4-scan').onclick=()=>{scanPopup('手動掃描');scanSummaryCards();status(lastDiagnostic);};
    ui.querySelector('#roj4-diag').onclick=diagnostics;
    ui.querySelector('#roj4-toggle').textContent=settings.running?'暫停紀錄':'啟動紀錄';
    ui.querySelector('#roj4-notify').textContent=settings.notify?'關閉 DC':'啟用 DC';
    updateUI();
  }
  function init(){
    if(!document.documentElement){setTimeout(init,40);return;}
    new MutationObserver(changes=>{
      if(!ui&&document.body)makeUI();
      if(changes.every(ch=>{const el=ch.target instanceof Element?ch.target:ch.target?.parentElement;return !!el?.closest?.(`#${UI_ID}`);}))return;
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
})();