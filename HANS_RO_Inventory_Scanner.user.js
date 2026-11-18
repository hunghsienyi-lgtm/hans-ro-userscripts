// ==UserScript==
// @name         HANS RO｜逐件裝備巡檢＋GS前十保護＋Discord完整紀錄
// @namespace    https://ro.hans-webgametw.com/
// @version      2.4.0
// @description  V2.4.0：內建獨立的商人路線錄製／重播、五品質一鍵販賣與返程控制；傳說前十保護、E排除、Discord摘要不變。
// @match        https://ro.hans-webgametw.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @connect      discordapp.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_RO_Inventory_Scanner.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_RO_Inventory_Scanner.user.js
// ==/UserScript==
(() => {
  'use strict';
  const ID = 'hans-top10-protect-v200'; // 沿用 ID，避免與舊版面板並存
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
    <div class="hp-title"><strong title="按住這個藍色標題列就能拖曳">HANS｜傳說裝備前10 V2.4.0</strong><button id="hp-toggle" title="縮小／展開">−</button></div>
    <div id="hp-body">
      <div class="hp-sub">主城按 C → 背包 → 全部；E 穿戴完全跳過。只保留傳說品質：法杖、頭上中下、披肩、飾品、鞋子、盾牌、衣服（鎧甲）。</div>
      <div class="hp-sub">逐件掃描非 E：只對傳說法杖及其餘指定部位傳說裝備排 GS 前10。其他品質與非杖武器不保留；先預覽再手動確認。Discord只傳摘要。</div>
      <div class="hp-bar"><button id="hp-scan">① 掃描非 E 裝備</button><button id="hp-scan-dc">① 掃描非 E＋傳 DC</button></div>
      <div class="hp-bar"><button id="hp-apply" disabled>② 確認前10保護</button><button id="hp-stop" disabled>停止</button></div>
      <div class="hp-sub" style="margin-top:9px;border-top:1px solid #cbd5e1;padding-top:7px"><b>商人路線＋一鍵販賣（可獨立執行）</b></div>
      <div class="hp-sub">第一次請在指定原點錄製 WASD／方向鍵走到礦石商人的路線，點開商人後儲存；下次可獨立重播。五種品質全選，已插卡／已精煉不勾選，實際販賣需再確認。</div>
      <div class="hp-bar"><button id="hp-route-learn">錄製去商人路線</button><button id="hp-route-save" disabled>完成錄製</button></div>
      <div class="hp-bar"><button id="hp-route-run">▶ 去商人＋販賣＋返回</button><button id="hp-route-sell">商人已開：販賣</button></div>
      <div class="hp-bar"><button id="hp-route-return">↩ 返回原點</button><button id="hp-route-stop">停止移動</button></div>
      <div class="hp-sub" id="hp-route-status">商人流程未啟動；尚未學習路線。</div>
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
  document.body.append(pane);
  const $ = id => pane.querySelector('#' + id);
  const status = message => { $('hp-status').textContent = message; };
  const controls = () => {
    $('hp-scan').disabled = running;
    $('hp-scan-dc').disabled = running;
    $('hp-send').disabled = running || !scanSnapshot?.complete;
    $('hp-json').disabled = !records.length;
    $('hp-save-hook').disabled = running;
    $('hp-apply').disabled = running || issues.length > 0 || !scannedAt || !scanSnapshot?.complete || !plan.length;
    $('hp-stop').disabled = !running;
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
  $('hp-stop').onclick = () => { aborted = true; status('已請求停止；處理完目前這件就中止。'); };
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
      '⚠️ 以上僅為預覽，尚未執行保護調整。'
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
    if(tasks.some(x=>x.equipped)) {status('安全阻擋：規劃清單混入 E 裝備，請重新掃描。');return;}
    if (!tasks.length) {status('所有非 E 裝備已符合保護規則，不需要修改。');return;}
    if (!confirm(`HANS 裝備保護管理：\nE 完全不動。只保留「傳說」品質：法杖、頭上中下、披肩、飾品、鞋子、盾牌、鎧甲各 GS 前 ${LIMIT} 件。\n其他品質及非杖武器不留（已保護的會取消保護）。\n將「保護」${tasks.filter(x=>x.action==='保護').length} 件、「取消保護」${tasks.filter(x=>x.action==='取消保護').length} 件。\n\n只調整保護狀態，不販賣、不丟棄。確定執行？`))return;
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
      status(`執行完成：${completed} 件。E 裝備未點選，未修改；沒有販賣或丟棄。\n建議重新掃描核對保護狀態。`);
    } catch(e) {
      scannedAt=0; scanSnapshot=null;
      $('hp-discord').textContent='Discord：保護操作已嘗試，請重新掃描取得目前狀態。';
      status(`已停止：完成 ${completed}/${tasks.length} 件。\n${String(e.message||e)}\n請重新掃描後才可繼續。`);
      console.warn('[HANS 前十保護]',e);
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

  // ===== 礦石商人：錄製去程、對話、一鍵販賣、逆向返程。完全獨立於裝備掃描流程。 =====
  function initMerchantRoute() {
    const ROUTE_KEY='hans-ro-merchant-route-v1';
    const KEYS=new Set(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright']);
    const NORMALIZE={arrowup:'w',arrowdown:'s',arrowleft:'a',arrowright:'d'};
    const OPPOSITE={w:'s',s:'w',a:'d',d:'a'};
    const GRADES=['普通','優良','稀有','史詩','傳說'];
    const routeStatus=message=>{const el=$('hp-route-status');if(el)el.textContent=message;};
    const merchantPause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    let learning=null,routeBusy=false,routeStop=false,heldKeys=new Set();
    let storedRoute=null;
    try{storedRoute=JSON.parse(GM_getValue(ROUTE_KEY,'null'));}catch{}
    if(!Array.isArray(storedRoute?.segments))storedRoute=null;
    const normalizeKey=e=>{
      const key=String(e.key||'').toLowerCase();
      return NORMALIZE[key]||key;
    };
    const keyCode=k=>'Key'+k.toUpperCase();
    function setKeys(next) {
      const goal=new Set(next);
      for(const k of heldKeys)if(!goal.has(k)){
        window.dispatchEvent(new KeyboardEvent('keyup',{key:k,code:keyCode(k),bubbles:true}));
      }
      for(const k of goal)if(!heldKeys.has(k)){
        window.dispatchEvent(new KeyboardEvent('keydown',{key:k,code:keyCode(k),bubbles:true}));
      }
      heldKeys=goal;
    }
    function stopKeys(){setKeys([]);}
    function onRealKey(ev,down){
      if(!learning||!ev.isTrusted||ev.repeat)return;
      const key=normalizeKey(ev);
      if(!['w','a','s','d'].includes(key))return;
      const at=performance.now()-learning.started;
      learning.events.push({at,down,key});
    }
    window.addEventListener('keydown',ev=>onRealKey(ev,true),true);
    window.addEventListener('keyup',ev=>onRealKey(ev,false),true);
    // 保存最後一次遊戲場景點擊；通常是點擊礦石商人的那一下。
    document.addEventListener('pointerup',ev=>{
      if(!learning||!ev.isTrusted||pane.contains(ev.target))return;
      const target=ev.target?.closest?.('canvas,#stage,.npc,.npc-label');
      if(!target)return;
      const r=target.getBoundingClientRect();
      if(r.width<15||r.height<15)return;
      const id=target.id||'';
      learning.lastClick={
        id:id&&/^[a-zA-Z][\w-]*$/.test(id)?id:'',
        tag:target.tagName.toLowerCase(),
        x:Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width)),
        y:Math.max(0,Math.min(1,(ev.clientY-r.top)/r.height))
      };
    },true);
    function fromEvents(events,totalMs){
      const sorted=events.filter(e=>Number.isFinite(e.at)&&e.at>=0).sort((a,b)=>a.at-b.at);
      const active=new Set(),segments=[];let last=0;
      for(const ev of sorted){
        const at=Math.max(last,Math.min(totalMs,ev.at));
        if(at-last>25&&active.size)segments.push({keys:[...active].sort(),ms:Math.round(at-last)});
        if(ev.down)active.add(ev.key);else active.delete(ev.key);
        last=at;
      }
      if(totalMs-last>25&&active.size)segments.push({keys:[...active].sort(),ms:Math.round(totalMs-last)});
      const compact=[];
      for(const seg of segments){
        const previous=compact[compact.length-1];
        if(previous&&previous.keys.join(',')===seg.keys.join(','))previous.ms+=seg.ms;
        else compact.push(seg);
      }
      return compact;
    }
    function routeCounts(){
      const amount=storedRoute?.segments?.reduce((a,r)=>a+(r.ms||0),0)||0;
      return storedRoute ? storedRoute.segments.length+' 段／移動約 '+Math.round(amount/1000)+' 秒' : '尚未錄製';
    }
    const learn=$('hp-route-learn'),save=$('hp-route-save'),run=$('hp-route-run'),
      sell=$('hp-route-sell'),back=$('hp-route-return'),halt=$('hp-route-stop');
    function buttons(){
      learn.disabled=routeBusy||!!learning||running;
      save.disabled=!learning||routeBusy;
      run.disabled=routeBusy||!!learning||running||!storedRoute;
      sell.disabled=routeBusy||!!learning||running;
      back.disabled=routeBusy||!!learning||running||!storedRoute;
      halt.disabled=!routeBusy&&!learning;
    }
    routeStatus('路線：'+routeCounts()+'。首次使用先從固定原點錄製。');
    buttons();
    learn.onclick=()=>{
      if(routeBusy||running)return;
      learning={started:performance.now(),events:[],lastClick:null};
      routeStatus('錄製中：從你的原點用 WASD 或方向鍵走到礦石商人，點開「販賣」頁，再按「完成錄製」。不記錄滑鼠拖曳移動。');
      buttons();
    };
    save.onclick=()=>{
      if(!learning)return;
      const total=performance.now()-learning.started;
      const segments=fromEvents(learning.events,total);
      const click=learning.lastClick;
      learning=null;
      if(!segments.length){routeStatus('沒有錄到 WASD／方向鍵的有效移動；未覆蓋舊路線。');buttons();return;}
      if(total>180000||segments.length>300){routeStatus('路線超過 3 分鐘或 300 段，請重新錄製。');buttons();return;}
      storedRoute={version:1,createdAt:new Date().toISOString(),segments,click};
      GM_setValue(ROUTE_KEY,JSON.stringify(storedRoute));
      routeStatus('路線已儲存：'+routeCounts()+'。請先關閉商人視窗並走回相同原點，之後可按「▶ 去商人＋販賣＋返回」。');
      buttons();
    };
    function merchantPanel(){
      const buttons=[...document.querySelectorAll('button')].filter(b=>!pane.contains(b)&&/一鍵販賣/.test(b.textContent||''));
      for(const button of buttons){
        let node=button.parentElement;
        for(let i=0;i<10&&node&&node!==document.body;i++,node=node.parentElement){
          const text=(node.innerText||node.textContent||'').replace(/\s+/g,'');
          if(text.length>16000)break;
          if(text.includes('一鍵販賣')&&GRADES.every(x=>text.includes(x))&&text.includes('包含已插卡')&&text.includes('包含已精煉')){
            return {root:node,button};
          }
        }
      }
      return null;
    }
    function gradeInput(root,grade){
      const labels=[...root.querySelectorAll('label')];
      for(const label of labels){
        const content=(label.innerText||label.textContent||'').replace(/\s+/g,'');
        if(!content.startsWith(grade)||content.length>32)continue;
        const checkbox=label.querySelector('input[type=checkbox]')||
          (label.htmlFor?document.getElementById(label.htmlFor):null);
        if(checkbox?.type==='checkbox')return checkbox;
      }
      return null;
    }
    function specialInput(root,name){
      const labels=[...root.querySelectorAll('label')];
      const label=labels.find(x=>(x.textContent||'').includes(name));
      return label?.querySelector('input[type=checkbox]')||null;
    }
    function readCounts(panel){
      const t=(panel.root.innerText||panel.root.textContent||'').replace(/\s+/g,'');
      const start=t.indexOf('一鍵販賣');
      const line=t.slice(Math.max(0,start),Math.max(0,start)+400);
      const values={};
      for(const grade of GRADES){
        const m=line.match(new RegExp(grade+'(\\d+)','u'));
        values[grade]=m?Number(m[1]):null;
      }
      return values;
    }
    function checkAllFive(panel) {
      for(const grade of GRADES){
        const box=gradeInput(panel.root,grade);
        if(!box||box.disabled)throw Error('找不到可操作的品質勾選框：'+grade);
        if(!box.checked)box.click();
        if(!box.checked)throw Error('品質未能勾選：'+grade);
      }
      // 使用者只指定五種品質；「含已插卡／含已精煉」維持關閉，避免擴大售出範圍。
      for(const option of ['包含已插卡','包含已精煉']){
        const box=specialInput(panel.root,option);
        if(!box)throw Error('無法確認「'+option+'」是否關閉，已停止。');
        if(box.checked)box.click();
        if(box.checked)throw Error('無法關閉「'+option+'」，已停止。');
      }
      return readCounts(panel);
    }
    async function merchantSale(){
      const panel=merchantPanel();
      if(!panel)throw Error('尚未找到礦石商人的「販賣／一鍵販賣」頁面。');
      const counts=checkAllFive(panel);
      const detail=GRADES.map(k=>k+' '+(counts[k]??'?')).join('／');
      const total=Object.values(counts).every(Number.isFinite)?
        Object.values(counts).reduce((a,b)=>a+b,0):null;
      if(panel.button.disabled || total===0){
        routeStatus('已勾選五種品質，但目前可一鍵販賣數量為 0（或按鈕不可用）。不執行販賣。');
        return {sold:false,empty:true};
      }
      const accepted=window.confirm('確認執行遊戲「一鍵販賣」？\\n五品質全勾：'+detail+
        '\\n僅排除商人原生保護／穿戴規則，並且不勾「包含已插卡／已精煉」。\\n這會實際出售遊戲裝備且可能無法復原，是否繼續？');
      if(!accepted)throw Error('你已取消販賣；沒有點擊一鍵販賣。');
      const before=panel.button;
      if(!before.isConnected || before.disabled)throw Error('一鍵販賣按鈕狀態改變，已停止。');
      const still=merchantPanel();
      if(!still||still.button!==before)throw Error('商人介面變動，請重新確認。');
      for(const grade of GRADES){
        if(!gradeInput(still.root,grade)?.checked)throw Error('販賣前勾選狀態變動：'+grade);
      }
      before.click();
      await merchantPause(750);
      routeStatus('已按遊戲「一鍵販賣」。若跳出額外確認視窗，請人工確認；未在此代按未知按鈕。');
      return {sold:true,empty:false};
    }
    function shopVisible(){return !!merchantPanel();}
    async function waitMerchant(timeoutMs=6500){
      const until=Date.now()+timeoutMs;
      while(Date.now()<until){
        if(routeStop)throw Error('已停止');
        if(shopVisible())return true;
        await merchantPause(180);
      }
      return false;
    }
    async function replaySegments(segments,reverse=false){
      const sequence=reverse?[...segments].reverse().map(x=>({keys:x.keys.map(k=>OPPOSITE[k]).filter(Boolean),ms:x.ms})):segments;
      for(let i=0;i<sequence.length;i++){
        if(routeStop)throw Error('你已停止商人流程');
        if(document.hidden)throw Error('瀏覽器分頁已切換，移動中止');
        if(shopVisible())throw Error('商人介面尚未關閉，禁止自動移動');
        const seg=sequence[i];
        setKeys(seg.keys);
        routeStatus((reverse?'返回原點':'前往商人')+' '+(i+1)+'/'+sequence.length+' 段');
        let remaining=Math.min(15000,seg.ms);
        if(seg.ms>15000)throw Error('單段移動超過 15 秒，為安全停止');
        while(remaining>0){
          if(routeStop)throw Error('使用者停止');
          const tick=Math.min(180,remaining);
          await merchantPause(tick);remaining-=tick;
        }
      }
      stopKeys();
    }
    function npcClick(){
      const pos=storedRoute?.click;
      if(!pos)return false;
      let node=pos.id?document.getElementById(pos.id):null;
      if(!node||!node.getClientRects().length){
        node=[...document.querySelectorAll(pos.tag==='canvas'?'canvas':'#stage')].find(e=>e.getClientRects().length);
      }
      if(!node||pane.contains(node))return false;
      const r=node.getBoundingClientRect(),x=r.left+r.width*pos.x,y=r.top+r.height*pos.y;
      if(!Number.isFinite(x)||!Number.isFinite(y))return false;
      const target=document.elementFromPoint(x,y)||node;
      if(pane.contains(target)||target.closest?.('button,input,select,textarea'))return false;
      for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){
        const Opt=type.startsWith('pointer')&&typeof PointerEvent==='function'?PointerEvent:MouseEvent;
        target.dispatchEvent(new Opt(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:type.endsWith('down')?1:0}));
      }
      return true;
    }
    function closeMerchant(){
      const panel=merchantPanel();if(!panel)return true;
      // 僅使用明確標示的「關閉」按鈕，不能隨便點按商城的確認／購買操作。
      const candidates=[...panel.root.querySelectorAll('button')];
      const button=candidates.find(b=>{
        const text=(b.textContent||'').trim();
        const title=(b.getAttribute('title')||b.getAttribute('aria-label')||'').trim();
        return /^(關閉|×|✕|X)$/iu.test(text)||/^(關閉|關閉商人)$/u.test(title);
      });
      if(button&&!button.disabled)button.click();
      return !shopVisible();
    }
    async function execute(action){
      if(routeBusy||running||learning)return;
      routeBusy=true;routeStop=false;buttons();
      try{
        if(action==='return'){
          if(!storedRoute)throw Error('尚未錄製去程路線');
          if(!closeMerchant())throw Error('商人視窗尚未關閉，請先手動關閉，再按「返回原點」。');
          await replaySegments(storedRoute.segments,true);
          routeStatus('返程重播完成。請核對角色是否回到原點；障礙物與伺服器延遲可能造成偏差。');
          return;
        }
        if(action==='full'&&!shopVisible()){
          if(!storedRoute)throw Error('尚未學習原點到商人的路線');
          await replaySegments(storedRoute.segments,false);
          if(routeStop)throw Error('已停止');
          npcClick();
          const opened=await waitMerchant(6500);
          if(!opened)throw Error('已重播去程，但未偵測到商人視窗。請自己靠近商人並點開對話，再按「商人已開：販賣」。');
        }
        const result=await merchantSale();
        if(action==='full' && storedRoute){
          if(!closeMerchant()){
            routeStatus('販賣流程結束，但商人視窗未能安全關閉。請關閉後按「↩ 返回原點」。');
            return;
          }
          await replaySegments(storedRoute.segments,true);
          routeStatus((result.empty?'本次無可販賣裝備；':'一鍵販賣已操作；')+
            '返程移動已完成。請確認原點位置，腳本無法保證避障或精確對位。');
        }
      }catch(err){
        routeStatus('已停止：'+String(err?.message||err));
        console.warn('[HANS 商人販賣／移動]',err);
      }finally{stopKeys();routeBusy=false;buttons();}
    }
    run.onclick=()=>execute('full');
    sell.onclick=()=>execute('sell');
    back.onclick=()=>execute('return');
    halt.onclick=()=>{
      if(learning){learning=null;routeStatus('已取消錄製，舊路線維持不變。');}
      routeStop=true;stopKeys();buttons();
    };
  }

  initMerchantRoute();
  controls();
})();