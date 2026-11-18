// ==UserScript==
// @name         HANS RO｜逐件裝備巡檢＋GS前十保護＋Discord完整紀錄
// @namespace    https://ro.hans-webgametw.com/
// @version      2.1.2
// @description  逐件開啟背包詳情，完整記錄名稱/UID/位置/部位/GS/Tier/詞綴/卡片/保護狀態；可發 Discord；各部位前10保護需另行確認。
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
    <div class="hp-title"><strong>HANS｜非 E 裝備逐件巡檢 V2.1</strong><button id="hp-toggle" title="收合/展開">−</button></div>
    <div id="hp-body">
      <div class="hp-sub">主城按 C → 背包 → 全部；僅逐件選取「未穿戴（無 E）」的裝備讀取詳情。E 穿戴品完全跳過，絕不點選。</div>
      <div class="hp-sub">按「掃描＋傳 DC」會記錄全部非 E 裝備，E 只計入跳過件數。成功掃完才傳；每部位非 E 前10保護必須另外按確認。</div>
      <div class="hp-bar"><button id="hp-scan">① 掃描非 E 裝備</button><button id="hp-scan-dc">① 掃描非 E＋傳 DC</button></div>
      <div class="hp-bar"><button id="hp-apply" disabled>② 確認前10保護</button><button id="hp-stop" disabled>停止</button></div>
      <div class="hp-sub"><b>Discord Webhook（只保存在本機 Tampermonkey）：</b></div>
      <div class="hp-bar"><input id="hp-hook" type="password" placeholder="貼入 Webhook URL，不要貼到聊天" autocomplete="off"><button id="hp-save-hook">儲存</button></div>
      <div class="hp-bar"><button id="hp-send" disabled>傳送上次完整掃描</button><button id="hp-export" disabled>匯出 CSV</button><button id="hp-json" disabled>匯出 JSON</button></div>
      <div id="hp-status">等待：請打開背包「全部」。</div>
      <div id="hp-discord">Discord：未傳送</div>
      <div id="hp-report"></div>
    </div>`;
  pane.style.cssText = 'position:fixed;right:12px;bottom:14px;width:365px;max-width:calc(100vw - 24px);max-height:65vh;overflow:auto;z-index:2147482000;background:#f9fbff;color:#263958;border:1px solid #7795c5;border-radius:12px;box-shadow:0 8px 30px #1b325b55;font:12px/1.5 Arial,"Microsoft JhengHei",sans-serif';
  const style = document.createElement('style');
  style.textContent = `
  #${ID} .hp-title{display:flex;justify-content:space-between;align-items:center;background:#31588f;color:white;padding:8px 10px;position:sticky;top:0;z-index:1}
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
  $('hp-toggle').onclick = () => {
    const b = $('hp-body'); b.hidden = !b.hidden;
    $('hp-toggle').textContent = b.hidden ? '+' : '−';
  };
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
    return {uid, name, heading, gs:Number(gs[1]), tier:Number(tier[1]), slot,
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
    const groups = new Map();
    for (const r of records) {
      if (r.equipped) continue; // 防止 E 進入前十名計算
      if (!groups.has(r.slot)) groups.set(r.slot, []);
      groups.get(r.slot).push(r);
    }
    const output = [];
    for (const [slot, arr] of groups) {
      arr.sort((a,b)=> b.gs - a.gs || Number(b.equipped) - Number(a.equipped) ||
        Number(b.protected) - Number(a.protected) || a.order - b.order);
      arr.forEach((r,i)=>{
        r.rank = i + 1;
        r.shouldProtect = i < LIMIT;
        r.action = r.shouldProtect === r.protected ? '保持' : r.shouldProtect ? '保護' : '取消保護';
        output.push(r);
      });
    }
    return output;
  }

  function renderReport() {
    if (!records.length) { $('hp-report').innerHTML=''; return; }
    const bySlot = [...new Set(plan.map(x=>x.slot))];
    let html = `<div><b>非 E 已掃 ${records.length}/${scanMeta.eligible} 件</b>｜E 跳過 ${scanMeta.ignoredE} 件｜背包共 ${scanMeta.total} 件｜待保護 ${plan.filter(x=>x.action==='保護').length} 件｜待取消 ${plan.filter(x=>x.action==='取消保護').length} 件</div>`;
    html += `<div class="hp-sub">${scanSnapshot?.complete ? '✓ 所有非 E UID 已逐件確認；E 沒有點選、沒有讀取詳情' : '非 E 裝備尚未全數掃描，禁止執行保護'}</div>`;
    if (issues.length) html += `<div class="hp-warn">掃描未完整，禁止執行：<br>${issues.map(s=>esc(s)).join('<br>')}</div>`;
    for (const slot of bySlot) {
      const arr = plan.filter(r=>r.slot===slot);
      html += `<details><summary><b>${esc(slot)}</b>（${arr.length} 件；保護 ${arr.filter(x=>x.action==='保護').length}／取消 ${arr.filter(x=>x.action==='取消保護').length}）</summary><table><thead><tr><th>名次</th><th>背包格</th><th>GS</th><th>E</th><th>操作</th></tr></thead><tbody>`;
      for (const r of arr) html += `<tr title="${esc(r.heading||r.name)}"><td>${r.rank}</td><td>#${r.index}</td><td>${r.gs}</td><td>${r.equipped?'E':''}</td><td>${esc(r.action)}</td></tr>`;
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
      scanSnapshot={version:'2.1.0',capturedAt:new Date().toISOString(),gameUrl:location.origin,
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

  const discordTextOf = (r) => {
    const header=`【背包第 ${r.index} 格／第${r.row}列第${r.col}欄】${r.slot}｜GS ${r.gs}｜Tier ${r.tier}｜非 E（未穿戴）｜${r.protected?'已保護':'未保護'}｜該部位第${r.rank||'?'}名`;
    return header+'\nUID: '+r.uid+'\n圖示: '+(r.icon||'未讀取')+'\n其他圖片/卡片: '+JSON.stringify(r.cardImages||[])+'\n'+(r.detailText||'無詳情').trim();
  };
  function chunksOfReport(snapshot){
    const groups=new Map();for(const r of snapshot.items){(groups.get(r.slot)||groups.set(r.slot,[]).get(r.slot)).push(r)}
    const date=nowString();
    const summary=[`🔍 HANS RO 非 E 裝備完整巡檢｜${date}`,
      `背包共 ${snapshot.expectedCount} 件｜E 穿戴已跳過 ${snapshot.skippedEquippedCount} 件（完全未點選或修改）`,
      `非 E 逐件掃描 ${snapshot.scannedCount}/${snapshot.eligibleCount} 件｜非 E 保護中 ${snapshot.items.filter(x=>x.protected).length}`,
      `只有非 E 裝備逐件點開右側詳情。這是「目前非 E 背包快照」，不是掉落歷史。`,
      ...[...groups].map(([slot,a])=>`${slot}: ${a.length} 件｜最高 GS ${Math.max(...a.map(x=>x.gs))}`),
      `共 ${snapshot.items.length} 件，後續訊息逐件含背包位置／UID／屬性／卡片資訊。`].join('\n');
    const messages=[summary];
    let cur='';
    for(let i=0;i<snapshot.items.length;i++){
      const r=snapshot.items[i];
      const piece=`[${i+1}/${snapshot.items.length}]\n`+discordTextOf(r)+'\n';
      // Discord 的 content 上限 2000 字；每件原始詳情較長時拆成多段，絕不遺漏。
      const lines=piece.match(/[\s\S]{1,1600}/g)||[''];
      for(const part of lines){
        if(cur && (cur+'\n\n'+part).length>1770){messages.push(cur);cur='';}
        cur+= (cur?'\n\n':'')+part;
      }
    }
    if(cur)messages.push(cur);
    return messages;
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
      status('掃描已保存在本機。先儲存 Discord Webhook，再按「傳送上次完整掃描」。');
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
      status('Discord 已完成整份紀錄傳送。掃描資料與匯出檔仍保存在本機。');
    }catch(e){
      latestDiscord=`中斷：已傳 ${delivered}/${messages.length} 段；${String(e.message||e)}`;
      $('hp-discord').textContent='Discord：'+latestDiscord;
      status('Discord 未完整送達：'+latestDiscord+'。可重試，但會重送全部訊息。');
    }
  }
  async function apply() {
    if (running || !scannedAt || issues.length || !scanSnapshot?.complete) return;
    const tasks = [...plan.filter(x=>x.action==='保護'),...plan.filter(x=>x.action==='取消保護')];
    if(tasks.some(x=>x.equipped)) {status('安全阻擋：規劃清單混入 E 裝備，請重新掃描。');return;}
    if (!tasks.length) {status('所有非 E 裝備已符合保護規則，不需要修改。');return;}
    if (!confirm(`HANS 裝備保護管理：\n每部位非 E 裝備前 ${LIMIT} 名；E 跳過、不計入排名、完全不動。\n將「保護」${tasks.filter(x=>x.action==='保護').length} 件、「取消保護」${tasks.filter(x=>x.action==='取消保護').length} 件。\n\n這會真正修改裝備保護狀態，但不會販賣或丟棄。是否執行？`))return;
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
        if (cur.error || cur.equipped || cur.gs !== task.gs || cur.slot !== task.slot || cur.tier !== task.tier)
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
    const headers=['掃描時間','背包第幾格','列','欄','裝備部位','該部位GS排名','裝備名稱','GS','Tier','E穿戴中','已保護','前十目標保護','預覽操作','UID','裝備圖示','強化/精煉','屬性','卡片/卡槽','卡片與其他圖片資訊','完整詳情'];
    const rows=records.map(r=>[r.scannedAt,r.index,r.row,r.col,r.slot,r.rank,r.name,r.gs,r.tier,r.equipped?'是':'否',r.protected?'是':'否',r.shouldProtect?'是':'否',r.action,r.uid,r.icon,r.refine,(r.attributes||[]).join('；'),(r.cardLines||[]).join('；'),JSON.stringify(r.cardImages||[]),r.detailText]);
    const csv='\ufeff'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
    download('HANS_RO_全背包逐件裝備紀錄_'+new Date().toISOString().slice(0,10)+'.csv',csv,'text/csv;charset=utf-8');
  }
  function exportJSON(){
    const data=scanSnapshot||{version:'2.1.0',complete:false,expectedCount:scanMeta.total,eligibleCount:scanMeta.eligible,skippedEquippedCount:scanMeta.ignoredE,issues,items:records};
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
  controls();
})();