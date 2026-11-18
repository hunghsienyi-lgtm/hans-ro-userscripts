// ==UserScript==
// @name         HANS RO｜逐件裝備巡檢＋GS前十保護＋Discord完整紀錄
// @namespace    https://ro.hans-webgametw.com/
// @version      2.5.0
// @description  V2.5.0：固定下9右13去礦石商人、左13上9返程；勾選五品質後按一鍵販賣及確認全部賣掉；獨立控制與安全確認。
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
    <div class="hp-title"><strong title="按住這個藍色標題列就能拖曳">HANS｜傳說裝備前10 V2.5.0</strong><button id="hp-toggle" title="縮小／展開">−</button></div>
    <div id="hp-body">
      <div class="hp-sub">主城按 C → 背包 → 全部；E 穿戴完全跳過。只保留傳說品質：法杖、頭上中下、披肩、飾品、鞋子、盾牌、衣服（鎧甲）。</div>
      <div class="hp-sub">逐件掃描非 E：只對傳說法杖及其餘指定部位傳說裝備排 GS 前10。其他品質與非杖武器不保留；先預覽再手動確認。Discord只傳摘要。</div>
      <div class="hp-bar"><button id="hp-scan">① 掃描非 E 裝備</button><button id="hp-scan-dc">① 掃描非 E＋傳 DC</button></div>
      <div class="hp-bar"><button id="hp-apply" disabled>② 確認前10保護</button><button id="hp-stop" disabled>停止</button></div>
      <div class="hp-sub" style="margin-top:9px;border-top:1px solid #cbd5e1;padding-top:7px"><b>商人路線＋一鍵販賣（可獨立執行）</b></div>
      <div class="hp-sub">固定路線：從原點 ↓9 下 →13 下，回程 ←13 下 ↑9 下；不用錄製。五種品質全勾後依序按「一鍵販賣」和「全部賣掉」，販賣前需確認。</div>
      <div class="hp-bar"><button id="hp-route-go">↓9 →13｜去商人</button><button id="hp-route-return">←13 ↑9｜返回原點</button></div>
      <div class="hp-bar"><button id="hp-route-run">▶ 去商人＋賣光＋返程</button><button id="hp-route-sell">商人已開：販賣</button></div>
      <div class="hp-bar"><label style="flex:1">按鍵方式 <select id="hp-route-keys"><option value="wasd">WASD</option><option value="arrows">方向鍵</option></select></label><label>單次按住 <input id="hp-route-tap-ms" type="number" min="50" max="300" step="10" value="110" style="width:48px"/>ms</label><button id="hp-route-stop">停止</button></div>
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

  // ===== 固定商人路線與販賣兩步確認；可單獨執行，不影響裝備掃描 =====
  function initMerchantRoute() {
    const GRADES=Object.freeze(['普通','優良','稀有','史詩','傳說']);
    const OUTBOUND=Object.freeze([['down',9],['right',13]]);
    const INBOUND=Object.freeze([['left',13],['up',9]]);
    const KEYMAP=Object.freeze({wasd:{down:['s','KeyS'],right:['d','KeyD'],left:['a','KeyA'],up:['w','KeyW']},
      arrows:{down:['ArrowDown','ArrowDown'],right:['ArrowRight','ArrowRight'],left:['ArrowLeft','ArrowLeft'],up:['ArrowUp','ArrowUp']}});
    const $r=id=>pane.querySelector('#'+id);
    const inform=message=>{const el=$r('hp-route-status');if(el)el.textContent=message;};
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const buttons={go:$r('hp-route-go'),back:$r('hp-route-return'),full:$r('hp-route-run'),
      sell:$r('hp-route-sell'),stop:$r('hp-route-stop'),keys:$r('hp-route-keys'),hold:$r('hp-route-tap-ms')};
    let busy=false,stopped=false,pressed=null;
    const isReady=()=>!busy&&!running;
    const refresh=()=>{
      for(const key of ['go','back','full','sell'])buttons[key].disabled=!isReady();
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
        .filter(b=>!pane.contains(b)&&isVisible(b)&&norm(textOf(b))==='一鍵販賣');
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
      const tap=Math.max(50,Math.min(300,Number(buttons.hold.value)||110));
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
    async function openShop(){
      if(shopOpen())return true;
      tryNpc();
      const end=Date.now()+6500;
      let tabClicked=false;
      while(Date.now()<end){
        activeCheck();
        if(shopOpen())return true;
        if(!tabClicked){
          const tab=[...document.querySelectorAll('button,[role="tab"]')]
            .find(b=>!pane.contains(b)&&isVisible(b)&&norm(textOf(b))==='販賣'&&!b.disabled);
          if(tab){tab.click();tabClicked=true;}
        }
        await sleep(160);
      }
      return shopOpen();
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
    function countsFrom(p){
      const content=(p.root.innerText||p.root.textContent||'').replace(/\s+/g,'');
      const start=content.indexOf('一鍵販賣'),part=content.slice(Math.max(0,start),Math.max(0,start)+500);
      const out={};
      for(const g of GRADES){
        const hit=part.match(new RegExp(g+'(\\d+)','u'));
        out[g]=hit?Number(hit[1]):null;
      }
      return out;
    }
    async function setQuality(p){
      for(const g of GRADES){
        activeCheck();
        const cb=checkboxFor(p.root,g,true);
        if(!cb||cb.disabled)throw Error('讀不到品質勾選框：'+g);
        if(!cb.checked){cb.click();await sleep(90);}
        if(!cb.checked)throw Error('無法勾選品質：'+g);
      }
      for(const name of ['包含已插卡','包含已精煉']){
        const cb=checkboxFor(p.root,name);
        if(!cb)throw Error('找不到安全設定：'+name);
        if(cb.checked){cb.click();await sleep(90);}
        if(cb.checked)throw Error('無法關閉安全設定：'+name);
      }
      return countsFrom(p);
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
    async function sellNow(){
      if(scanSnapshot?.complete&&scanSnapshot.version===POLICY_VERSION){
        const unprotected=scanSnapshot.items.filter(x=>x.shouldProtect&&!x.protected);
        if(unprotected.length)throw Error('還有 '+unprotected.length+' 件前十傳說裝備未保護。請先完成裝備保護並重新掃描。');
      }
      const p=panel();
      if(!p)throw Error('找不到商人的「販賣」頁，請先開啟。');
      const counts=await setQuality(p);
      const total=Object.values(counts).every(Number.isFinite)?Object.values(counts).reduce((a,b)=>a+b,0):null;
      const detail=GRADES.map(g=>g+' '+(counts[g]??'?')).join('、');
      if(p.button.disabled||total===0){
        inform('五品質已勾選，但目前沒有可販賣裝備（或按鈕不可用）；未販賣。');
        return {empty:true};
      }
      const accepted=window.confirm('準備實際販賣遊戲裝備：\\n'+detail+
        '\\n\\n將依序按「一鍵販賣」→「全部賣掉」。\\n所有未受遊戲保護的傳說裝備也可能被賣掉，無法復原。確認執行？');
      if(!accepted)throw Error('已取消，未按販賣按鈕');
      activeCheck();
      const current=panel();
      if(!current||current.button!==p.button||p.button.disabled)throw Error('販賣介面已變更，停止');
      for(const g of GRADES){
        if(!checkboxFor(current.root,g,true)?.checked)throw Error('品質設定變動：'+g);
      }
      for(const name of ['包含已插卡','包含已精煉']){
        if(checkboxFor(current.root,name)?.checked!==false)throw Error('安全排除選項狀態異常：'+name);
      }
      inform('已確認販賣，準備按「一鍵販賣」...');
      p.button.click();
      const all=await waitSellAllButton();
      if(!all)throw Error('按下一鍵販賣後，沒有找到「全部賣掉」；請人工查看，不會自動返程。');
      if(all.disabled)throw Error('「全部賣掉」目前不可用，停止。');
      activeCheck();
      // 只按唯一可見且文字完全相符的確認按鈕，不推測或代按其他選項。
      inform('找到確認視窗，按下「全部賣掉」...');
      all.click();
      await sleep(650);
      if(allSellButtons().length)throw Error('按下「全部賣掉」後視窗尚未關閉，請人工確認；不會返程。');
      inform('已操作「全部賣掉」。待確認遊戲結果；若有其他確認視窗請人工處理。');
      return {empty:false};
    }
    async function closeShop(){
      const p=panel();if(!p)return true;
      const btn=[...p.root.querySelectorAll('button')].find(b=>{
        const label=norm(textOf(b)),title=norm(b.getAttribute('title')||b.getAttribute('aria-label')||'');
        return /^(關閉|✕|×|X)$/iu.test(label)||/^(關閉|關閉商人)$/u.test(title);
      });
      if(btn&&!btn.disabled){btn.click();await sleep(500);}
      return !shopOpen();
    }
    async function operate(action){
      if(!isReady())return;
      busy=true;stopped=false;refresh();
      try{
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
          if(!shopOpen()){
            await walk(false);
            if(!await openShop())throw Error('已走到商人附近，但未能開啟販賣頁，請手動開啟後按「商人已開：販賣」。');
          }
          const result=await sellNow();
          if(!await closeShop())throw Error('商人視窗沒有關閉，已停止返程，請手動關閉。');
          await walk(true);
          inform((result.empty?'沒有可賣裝備；':'已按下全部賣掉；')+'已送出 ←13、↑9，請核對返回位置。');
        }
      }catch(e){
        inform('停止：'+String(e?.message||e));
        console.warn('[HANS 礦石商人固定路線]',e);
      }finally{release();busy=false;refresh();}
    }
    buttons.go.onclick=()=>operate('go');
    buttons.back.onclick=()=>operate('back');
    buttons.sell.onclick=()=>operate('sell');
    buttons.full.onclick=()=>operate('full');
    buttons.stop.onclick=()=>{stopped=true;release();inform('已請求停止；鬆開所有方向鍵。');};
    refresh();
  }

  initMerchantRoute();
  controls();
})();