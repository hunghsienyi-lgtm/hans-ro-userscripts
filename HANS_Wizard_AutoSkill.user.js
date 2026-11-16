// ==UserScript==
// @name         HANS RO 二轉巫師｜五核心自動選技＋尋寶寶箱
// @namespace    ro-local-profiles
// @version      1.20
// @description  先學齊暴風雪、霜凍之術與三箭，再優先 +目標／+衝擊；衝擊限兩個冰系核心；寶箱尋寶率優先。
// @match        https://ro.hans-webgametw.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Wizard_AutoSkill.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Wizard_AutoSkill.user.js
// ==/UserScript==
(() => {
  'use strict';
  if (document.getElementById('hans-mage-autoskill-v120')) return;
  const potion = [/傷害藥水|damage potion|potion of damage/i, /範圍藥水|area potion|potion of area/i];
  const label = '巫師';
  const shown = el => {
    if (!el || !el.isConnected || el.disabled || !el.getClientRects().length) return false;
    for (let n=el, i=0; n && i<12; n=n.parentElement, i++) {
      const css=getComputedStyle(n);
      if (css.display==='none' || css.visibility==='hidden' || Number(css.opacity)===0 || n.hidden) return false;
    }
    return el.getAttribute('aria-disabled')!=='true';
  };
  const read = (card, selector) => card.querySelector(selector)?.textContent.trim() || '';

  const targetPatterns = [
    /(?:\+|增加|多(?:命中|攻擊|擊中)|額外(?:命中|攻擊|擊中)?)\s*([\d一兩二三]+)\s*(?:個|名|隻)?\s*(?:額外的?|不同的?)?\s*(?:目標|敵人)/gi,
    /(?:目標|敵人)(?:數量|數|量)?\s*[:：]?\s*(?:增加|\+)\s*([\d一兩二三]+)(?![\d.%])/gi,
    /\+\s*(\d+)\s*(?:(?:extra|additional|more)\s+)?(?:targets?|enemies)\b/gi,
    /\btargets?(?:\s+count)?\s*:?\s*\+\s*(\d+)(?![\d.%])/gi,
    /\b(\d+)\s+(?:extra|additional|more)\s+targets?\b/gi
  ];
  function targetGain(card) {
    let gain = 0;
    const nodes = [...card.querySelectorAll('.pk-lines li')];
    if (!nodes.length) nodes.push(card.querySelector('.pk-lines'));
    for (const node of nodes) {
      if (!node) continue;
      const text = node.textContent.normalize('NFKC');
      for (const pattern of targetPatterns) {
        for (const match of text.matchAll(pattern)) {
          const amount = Number(match[1]) || ({一:1,兩:2,二:2,三:3})[match[1]];
          if (amount) gain = Math.max(gain, amount);
        }
      }
      const change = text.match(/(?:目標(?:數量|數|量)?|targets?)\s*:?\s*(\d+)\s*(?:→|->)\s*(\d+)/i);
      if (change) gain = Math.max(gain, Number(change[2]) - Number(change[1]));
      if (/^\s*\+\s*(?:目標(?:數量|數)?|targets?)\s*$/i.test(text)) gain = Math.max(gain, 1);
    }
    return gain;
  }


  // HANS 二轉冰系技能的額外命中叫「衝擊」，不是「目標」。
  // 僅暴風雪與霜凍之術適用；忽略「衝擊傷害 +30%」等百分比。
  const impactPatterns = [
    /(?:衝擊|冲击)(?:次數|次|數量|數)?\s*[:：]?\s*(?:\+|增加|提升|提高|額外(?:增加)?)\s*([\d一兩二三四五六七八九]+)(?![\d.%％])/gi,
    /(?:\+|增加|多|額外(?:增加)?)\s*([\d一兩二三四五六七八九]+)(?![\d.%％])\s*(?:次|個|道|發)?\s*(?:衝擊|冲击)/gi
  ];
  function impactGain(card){
    let best=0;
    const nodes=[...card.querySelectorAll('.pk-lines li')];
    if(!nodes.length)nodes.push(card.querySelector('.pk-lines'));
    const parseAmount=s=>Number(s)||({一:1,兩:2,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9})[s]||0;
    for(const node of nodes){
      if(!node)continue;
      const line=node.textContent.normalize('NFKC');
      for(const re of impactPatterns){
        for(const match of line.matchAll(re)){
          const count=parseAmount(match[1]);
          if(count>0)best=Math.max(best,count);
        }
      }
      const change=line.match(/(?:衝擊|冲击)(?:次數|數量|數)?\s*[:：]?\s*(\d+)\s*(?:→|->|➜)\s*(\d+)/i);
      if(change)best=Math.max(best,Number(change[2])-Number(change[1]));
      if(/^\s*\+\s*(?:衝擊|冲击)\s*$/.test(line))best=Math.max(best,1);
    }
    return Math.max(0,best);
  }
  function extraHitGain(card,core){
    const target=targetGain(card);
    const impact=core&&(core.id==='storm'||core.id==='frost')?impactGain(card):0;
    return {amount:Math.max(target,impact),kind:impact>target?'衝擊':'目標'};
  }

  // v1.20：二轉五核心；暴風雪 > 霜凍之術 > 三箭；「冰凍術」不是「霜凍之術」。
  const coreSkills = [
    {id:'storm', label:'暴風雪', name:/暴風雪|storm\s*gust|\bblizzard\b/i,
      slot:/blizzard|storm[-_]?gust|(?:^|[_.-])storm(?:gust)?$|^stormgust$|^wizardstorm$/i},
    {id:'frost', label:'霜凍之術', name:/霜凍之術|霜凍術|frost\s*(?:nova|spell)/i,
      slot:/frost(?:nova|spell)?|freezingspell|frostbite/i},
    {id:'firebolt', label:'火箭術', name:/火箭術|fire\s*bolt/i,
      slot:/fire[-_]?bolt/i},
    {id:'lightning', label:'雷擊術', name:/雷擊術|lightning\s*bolt/i,
      slot:/lightning(?:[-_]?bolt)?/i},
    {id:'coldbolt', label:'冰箭術', name:/冰箭術|(?:cold|ice)\s*bolt/i,
      slot:/(?:cold|ice)[-_]?bolt/i}
  ];
  const cardName = card => read(card,'.pk-name').normalize('NFKC');
  function coreOf(card) {
    const name=cardName(card);
    return coreSkills.find(s=>s.name.test(name)) || null;
  }
  function isNew(card) {
    return !!card.querySelector('.pk-ribbon, .pk-badge-new, [data-new="true"]');
  }
  function skillSlots(panel) {
    return panel.querySelector('#lu-sockets') || document.querySelector('#lu-sockets');
  }
  function slotInfo(panel) {
    const sockets=skillSlots(panel);
    const text=sockets?.textContent?.normalize('NFKC')||'';
    const m=text.match(/(?:技能|skills?)\s*(\d+)\s*\/\s*(\d+)/i);
    const slots=[...(sockets?.querySelectorAll('.skill-slot')||[])];
    const hasOpen=!!sockets?.querySelector('.skill-slot.empty, .skill-slot[data-skill=""], .skill-slot:not([data-skill])');
    // 若沒有技能格元素及明確 x/y 計數，不能僅因 #lu-sockets 存在就誤判「滿格」。
    const full=m ? Number(m[1]) >= Number(m[2]) : slots.length>0 && !hasOpen;
    const owned=new Set();
    for(const el of (sockets?.querySelectorAll('[data-skill],.skill-slot')||[])){
      const raw=[el.getAttribute('data-skill'),el.getAttribute('title'),el.getAttribute('aria-label'),
        el.dataset?.skillName,el.textContent].filter(Boolean).join(' ').normalize('NFKC');
      for(const s of coreSkills){
        if(s.slot.test(raw)||s.name.test(raw)) owned.add(s.id);
      }
    }
    return {full,known:!!sockets && (!!m || slots.length>0),owned,
      open:m?Math.max(0,Number(m[2])-Number(m[1])):(hasOpen?1:0)};
  }
  function coreOrder(core) {return core ? coreSkills.findIndex(s=>s.id===core.id) : 99;}
  function numericStat(text, kind) {
    const terms=kind==='haste'?'(?:急速|冷卻(?:縮減|減少)?|cooldown|haste)'
      :kind==='damage'?'(?:傷害|damage|dmg)' : '(?:詠唱(?:速度)?|cast(?:ing)?\s*speed)';
    const a=text.match(new RegExp(terms+'\\s*(?:增加|提升|提高|[:：]|\\+)?\\s*([+\\-]?\\d+(?:[.,]\\d+)?)\\s*%?','i'));
    const b=text.match(new RegExp('\\+\\s*(\\d+(?:[.,]\\d+)?)\\s*%?\\s*'+terms,'i'));
    const match=a||b;
    return match ? (Number(match[1].replace(',','.'))||0) : 0;
  }
  function scoreSkill(card,info){
    const core=coreOf(card), newSkill=isNew(card), text=read(card,'.pk-lines').normalize('NFKC');
    // v1.20：先拿缺少的五大核心技能；五核心齊全後才把 +目標／+衝擊列為第一優先。
    // 即使卡片上同時寫有 +目標，只要它屬於「新技能」，仍按補技能處理。
    if(newSkill && info.full) return {score:-Infinity,reason:'技能格已滿'};
    if(newSkill){
      if(core && (!info.known || !info.owned.has(core.id)))
        return {score:120000+(5-coreOrder(core))*100,reason:`先補核心：${core.label}`};
      return {score:-Infinity,reason:'非核心或重複新技能：僅保底'};
    }
    const extra=core ? extraHitGain(card,core) : {amount:0,kind:'目標'};
    if(core && extra.amount>0) return {score:100000+extra.amount*1000+(5-coreOrder(core)),
      reason:`核心 +${extra.kind} ${extra.amount}：${core.label}`};
    if(core){
      const haste=/(?:急速|冷卻|cooldown|haste)/i.test(text);
      const damage=/(?:傷害|damage|dmg)/i.test(text);
      const cast=/(?:詠唱|cast(?:ing)?)/i.test(text);
      if(!haste && !damage && !cast) return {score:-Infinity,backup:700,reason:'核心低收益強化保底'};
      const category=haste?3000:damage?2000:1000;
      const type=haste?'haste':damage?'damage':'cast';
      // 同類強化看實際數字；不同類型仍採保守固定優先順序，不假裝直接換算 DPS。
      const amount=numericStat(text,type);
      return {score:50000+category+Math.min(amount,900)*0.1+(5-coreOrder(core)),reason:`核心強化：${core.label}`};
    }
    // 已持有的非核心技能強化：僅在沒有核心合格選項時保底，避免佔用新格。
    if(/(?:急速|冷卻|傷害|詠唱|haste|cooldown|damage|cast)/i.test(text)){
      return {score:-Infinity,backup:400+Math.min(numericStat(text,'damage'),200)*0.1,
        reason:'既有非核心強化保底'};
    }
    return {score:-Infinity,backup:100,reason:'其他強化保底'};
  }
  // 補技能階段：技能格尚有空位，而且能讀到仍缺少的五核心技能。
  // 這時即使候選有核心 +目標／+衝擊，也先尋找「新技能卡」；找不到就先重抽整組。
  // 滿格（含被保底非核心佔滿）即結束補技能階段，避免追求不可能再取得的技能。
  function collectingCoreSkills(info){
    return info.known && !info.full && coreSkills.some(s=>!info.owned.has(s.id));
  }
  function bestSkillChoice(cards,info){
    const collecting=collectingCoreSkills(info);
    const scored=cards.map(card=>({card,...scoreSkill(card,info)}));
    const candidates=collecting ? scored.filter(x=>{
      const core=coreOf(x.card);
      return isNew(x.card) && core && !info.owned.has(core.id);
    }) : scored;
    const chosen=candidates.filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score)[0];
    return {collecting,chosen};
  }
  function fallbackSkillScore(card,info){
    const core=coreOf(card), fresh=isNew(card);
    if(fresh && info.full) return -Infinity;
    if(!fresh){
      const main=scoreSkill(card,info).score;
      return Number.isFinite(main) ? 200000+main : 10000+(scoreSkill(card,info).backup||0);
    }
    if(core) return 5000+(5-coreOrder(core));
    const name=cardName(card);
    // 無核心、無可用重抽時，優先能清怪／控場的二轉候選，其次普通非核心；不能阻塞選卡。
    // 即使新技能標記未正常顯示，也不把「冰凍術」當成二轉主力。
    if(/暴風雪|blizzard|storm\s*gust/i.test(name)) return 3500;
    if(/雷爆|火焰之壁|火牆|thunderstorm|fire\s*wall/i.test(name)) return 2000;
    if(/冰凍術/i.test(name)) return 900;
    return 1000;
  }
  // v1.14：辨識寶箱卡片上的「尋寶率正增益」，包括神祇。
  // 只比對尋寶率自身的數值，避免誤把其他屬性（例如傷害 +80%）當成尋寶率。
  const discoveryName = '(?:尋寶率|\u5bfb\u5b9d率|\u6389寶率|\u6389\u5b9d率|寶物發現率|\u5b9d物\u53d1现率|發現率|\u53d1现率|discovery(?:\\s+rate)?|treasure\\s+(?:find(?:ing)?|discovery|drop)\\s+rate)';
  const discoveryNameRegex = new RegExp(discoveryName, 'i');
  const discoveryPatterns = [
    // 尋寶率 +35%、尋寶率提升 35%、Discovery Rate: +35%
    new RegExp(`${discoveryName}\\s*(?:(?:增加|提升|提高|加成|增幅|獲得|\u83b7得|increase(?:d)?|boost(?:ed)?|gain(?:ed)?|by|:|：|=)\\s*){0,2}([+-]?\\s*\\d+(?:[.,]\\d+)?)\\s*%?`, 'gi'),
    // +35% 尋寶率、35% Discovery Rate
    new RegExp(`([+-]?\\s*\\d+(?:[.,]\\d+)?)\\s*%\\s*(?:的|之)?\\s*${discoveryName}`, 'gi'),
    // 增加 35% 的尋寶率、Gain 35% Discovery Rate
    new RegExp(`(?:增加|提升|提高|獲得|\u83b7得|increase|gain|boost)\\s*([+-]?\\s*\\d+(?:[.,]\\d+)?)\\s*%?\\s*(?:的|之|in|to|of)?\\s*${discoveryName}`, 'gi')
  ];
  function discoveryGain(card) {
    const nodes = [...card.querySelectorAll('.pk-lines li')];
    if (!nodes.length) {
      const whole = card.querySelector('.pk-lines');
      if (whole) nodes.push(whole);
    }
    // 有些卡片可能把數值放在副標；分段解析可避免跨段串接不同屬性數字。
    const segments = [read(card, '.pk-name'), read(card, '.pk-sub'),
      ...nodes.map(node => node.textContent)].map(s => s.normalize('NFKC'));
    let best = null;
    for (const text of segments) {
      if (!discoveryNameRegex.test(text)) continue;
      for (const pattern of discoveryPatterns) {
        for (const match of text.matchAll(pattern)) {
          const value = Number(match[1].replace(/\s/g, '').replace(',', '.'));
          // 排除負數、0；「降低尋寶率 20%」不能當作正加成。
          const before = text.slice(Math.max(0, match.index - 10), match.index);
          const matchedText = match[0];
          if (/降低|減少|\u51cf少|下降|削減|削\u51cf|reduce|decrease|lower|penalty/i.test(before + matchedText)) continue;
          if (Number.isFinite(value) && value > 0) best = Math.max(best ?? 0, value);
        }
      }
    }
    return best; // 未解析到實際正加成時回傳 null，不猜數字。
  }
  function discoveryTieRank(card) {
    const name = read(card, '.pk-name');
    const sub = read(card, '.pk-sub');
    if (/豐饒祝福|blessing of (plenty|abundance)|(?:plenty|abundance) blessing/i.test(name)) return 3;
    if (/神祇|神祗|之神|deity/i.test(name + ' ' + sub)) return 2;
    if (/尋寶率|\u5bfb\u5b9d率|驚奇秘藥|discovery|surprise elixir|elixir of surprise/i.test(name)) return 1;
    return 0;
  }
  function chestRank(card) {
    const name = read(card, '.pk-name');
    const slot = read(card, '.pk-sub');
    const lines = read(card, '.pk-lines').normalize('NFKC');
    const item = name + ' ' + slot + ' ' + lines;
    const discovery = discoveryGain(card);
    // 任何寶箱卡片只要實際增加尋寶率，先比較正加成數字；神祇也適用。
    if (discovery !== null) return 1000 + discovery;

    // 尚無法解析數值時，保留原本豐饒／尋寶相關物品的高優先，但低於任何已解析正增益。
    if (/豐饒祝福|blessing of (plenty|abundance)|(?:plenty|abundance) blessing/i.test(name)) return 141;
    const deity = /神祇|神祗|之神|deity/i.test(name + ' ' + slot);
    if (deity) {
      if (discoveryNameRegex.test(item) && !/(?:尋寶率|\u5bfb\u5b9d率|discovery)\s*[-−]\s*\d/.test(item)) return 140;
      return /火箭術|fire bolt/i.test(name) ? 100 : -Infinity;
    }
    if (/尋寶率|\u5bfb\u5b9d率|驚奇秘藥|discovery|surprise elixir|elixir of surprise/i.test(item)) return 140;
    if (/詠唱速度|詠唱(?:藥水|秘藥|祝福)|cast(?:ing)? speed|cast(?:ing)? (?:potion|elixir|blessing)|(?:potion|elixir|blessing) of cast(?:ing)?/i.test(item)) {
      const match = lines.match(/\+\s*(\d+(?:[.,]\d+)?)\s*%?\s*(?:詠唱速度|cast(?:ing)? speed)/i);
      const value = match ? Number(match[1].replace(',', '.')) : 0;
      return 130 + value / (value + 1);
    }
    if (/冷卻|急速|haste|cooldown/i.test(item)) return 120;
    if (/雙重(?:施法|詠唱)|二重(?:施法|詠唱)|double[ -]?cast/i.test(item)) return 110;
    const priority = potion.findIndex(rule => rule.test(name));
    if (priority >= 0) return 85 - priority * 5;
    if (/傷害祝福|damage blessing|blessing of damage/i.test(name)) return 62;
    if (/傷害秘藥|damage elixir|elixir of damage/i.test(name)) return 58;
    if (/INT\s*(?:料理|dish)|(?:dish|plato)\s+(?:of\s+)?INT/i.test(name)) return 1;
    return -Infinity;
  }
  function betterChestCard(a, b) {
    const scoreA = chestRank(a);
    const scoreB = chestRank(b);
    if (scoreA !== scoreB) return scoreA > scoreB;
    // 尋寶率相同，才按原本的豐饒 > 神祇 > 一般尋寶道具選。
    if (scoreA >= 1000) return discoveryTieRank(a) > discoveryTieRank(b);
    return false;
  }

  let lastDiagnostic = '等待遊戲畫面';
  let button = null, timer = null;
  function diagnostic(message) {
    if (message===lastDiagnostic) return;
    lastDiagnostic=message;
    if (button) button.title='Shift+1 切換；目前：'+message;
    console.info('[HANS 巫師 v1.20]',message);
  }
  let nextRerollAt=0, pending=null, lastChoiceAt=0, lastChoiceKey='',choiceTries=0;
  const attempts=new WeakMap();
  function rerollButton(panel, selector, match) {
    return [...panel.querySelectorAll(selector)].find(control=>{
      const txt=(control.textContent||'').normalize('NFKC');
      const cleaned=txt.replace(/[\d()（）\s]/g,'');
      const use=txt.match(/(?:^|\s)(\d+)\s*(?:次|$|[()（）])/);
      const prior=attempts.get(control);
      return shown(control) && (use?.[1]!== '0') && match.test(cleaned) &&
        !(prior?.text===txt && prior.count>=2);
    });
  }
  function normalizeTitle(raw) {
    return String(raw||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  }
  function chooseCard(card,why) {
    const id=[cardName(card),read(card,'.pk-lines'),isNew(card)].join('|');
    if(id===lastChoiceKey && performance.now()-lastChoiceAt<900) return;
    if(id===lastChoiceKey) choiceTries++;
    else {lastChoiceKey=id;choiceTries=1;}
    if(choiceTries>3){diagnostic('選卡沒有反應，停止重複點擊：'+cardName(card));return;}
    pending={card,name:cardName(card),reason:why,at:performance.now()};
    lastChoiceAt=performance.now();
    diagnostic('選擇：'+cardName(card)+'｜'+why);
    card.click();
  }
  function tick(){
    const reveal=document.querySelector('#drop-reveal:not(.hidden)');
    if(shown(reveal)){
      const result=shown(reveal.querySelector('.dr-result'));
      const get=result ? reveal.querySelector('button.dr-get') :
        reveal.matches('.roll') && reveal.querySelector('button[data-c="greed"]');
      if(shown(get)){diagnostic('\u6389寶視窗：領取\u6389落');get.click();}
      return;
    }
    const panel=document.querySelector('#picker:not(.hidden):not(.closing)');
    if(!shown(panel)){
      pending=null;lastChoiceKey='';choiceTries=0;
      diagnostic('等待升級／寶箱畫面');return;
    }
    const title=normalizeTitle(read(panel,'#pk-title')||document.querySelector('#pk-title')?.textContent||
      read(panel,'.pk-title')||read(panel,'h1'));
    const chest=/^(?:寶箱|寶箱選擇|treasure\s*chest)\s*!?$/i.test(title);
    const level=/^(?:升\s*級|強化\s*技能|level\s*up|upgrade\s*(?:a\s*)?skill)\s*!?$/i.test(title);
    const byLayout=!chest&&!level&&shown(document.querySelector('#lu-sockets'))&&!!panel.querySelector('button.pk-card');
    if(!chest&&!level&&!byLayout){diagnostic('未知選卡標題：'+title.slice(0,60));return;}
    const asking=panel.querySelector('.pk-slot.asking');
    if(asking){
      const card=asking.querySelector('button.pk-card');
      // 僅確認本腳本主動點擊的卡片；使用者手動點選的不代為接受或取消。
      const isOurs=!!pending && !!card &&
        (pending.card===card || (cardName(card)===pending.name && performance.now()-pending.at<4500));
      if(isOurs){
        const yes=asking.querySelector('[data-yes]');
        if(shown(yes)){diagnostic('確認選卡：'+pending.name);yes.click();pending=null;
          lastChoiceKey='';choiceTries=0;}
      }else diagnostic('發現手動確認畫面，不自動干預');
      return;
    }
    const cards=[...new Set(panel.querySelectorAll('button.pk-card, [role="button"].pk-card, .pk-card'))].filter(shown);
    if(!cards.length){diagnostic('選卡視窗沒有可見的卡片');return;}
    // 一旦卡片集合改變，重置過去「點了沒反應」的保護次數。
    const hand=cards.map(c=>cardName(c)+'|'+read(c,'.pk-lines')+'|'+isNew(c)).join('||');
    if(hand!==tick.lastHand){tick.lastHand=hand;lastChoiceKey='';choiceTries=0;pending=null;}
    if(chest){
      // 同分寶箱延續原版第二張優先的習慣；實際正加成仍優先比較數值。
      const ordered=[...cards];if(ordered.length>1) [ordered[0],ordered[1]]=[ordered[1],ordered[0]];
      const best=ordered.reduce((a,b)=>!a||betterChestCard(b,a)?b:a,null);
      if(best && Number.isFinite(chestRank(best))){chooseCard(best,'寶箱：尋寶率／增益排序');return;}
      if(performance.now()<nextRerollAt)return;
      const btn=rerollButton(panel,'#pk-bar button,.pk-acts button,.pk-actions button',
        /^(重抽整組|重抽全部|重抽卡組|rerolldeck|rerollall|重抽|重抽卡片|reroll|rerollcard)$/i);
      if(btn){
        const t=btn.textContent.normalize('NFKC'),old=attempts.get(btn);
        attempts.set(btn,{text:t,count:old?.text===t?old.count+1:1});
        nextRerollAt=performance.now()+1500;diagnostic('寶箱重抽：'+t.trim());btn.click();return;
      }
      // 無合格寶箱也不中斷，以原本的保底規則選一張。
      const backup=cards.reduce((a,b)=>!a||fallbackChestRank(b)>fallbackChestRank(a)?b:a,null);
      if(backup)chooseCard(backup,'寶箱無可用重抽：保底');return;
    }
    const info=slotInfo(panel);
    const {collecting,chosen}=bestSkillChoice(cards,info);
    if(chosen){chooseCard(chosen.card,chosen.reason);return;}
    // 尚缺核心且有空位：優先重抽尋找新技能，不能提前拿目標／衝擊／傷害強化。
    // 五格已滿：停止追缺少的技能，改按核心 +目標／+衝擊／增益排序。
    if(performance.now()<nextRerollAt)return;
    const deck=rerollButton(panel,'#pk-bar button,.pk-acts button,.pk-actions button,#picker button',
      /^(重抽整組|重抽全部|重抽卡組|rerolldeck|rerollall)$/i);
    if(deck){
      const t=deck.textContent.normalize('NFKC'),old=attempts.get(deck);
      attempts.set(deck,{text:t,count:old?.text===t?old.count+1:1});
      nextRerollAt=performance.now()+1500;
      diagnostic((collecting?'五核心未齊，尋找缺少的新技能：':'沒有合格核心卡：')+'重抽整組 '+t.trim());deck.click();return;
    }
    // B 方案：耗盡重抽後優先已學技能強化，才選非核心新技能；永不僵住。
    const best=cards.reduce((a,b)=>!a||fallbackSkillScore(b,info)>fallbackSkillScore(a,info)?b:a,null);
    if(best && Number.isFinite(fallbackSkillScore(best,info)))
      chooseCard(best,collecting?'核心尚未齊、重抽耗盡：保底不中斷':'無可用重抽：保底不中斷');
    else diagnostic('技能欄位不可用／候選全失效；等待手動確認');
  }
  function fallbackChestRank(card) {
    const name=cardName(card)+' '+read(card,'.pk-sub');
    if(/神祇|神祗|之神|deity/i.test(name)) return -2;
    if(/生命|護甲|減傷|armor|life|health/i.test(name)) return -1;
    return 0;
  }
  const safeTick=()=>{try{tick();}catch(error){
    diagnostic('腳本錯誤：'+String(error?.message||error));
    console.error('[HANS 巫師 v1.20]',error);
  }};
  function enable(on){
    clearInterval(timer);
    timer=on?setInterval(safeTick,400):null;
    button.textContent=label+'選技：'+(on?'開':'關')+' v1.20';
    button.style.background=on?'#186442':'#384455';
    diagnostic(on?'已開啟，等待選卡畫面':'已關閉；按鈕或 Shift+1 開啟');
  }
  function mount(){
    if(!document.body){setTimeout(mount,100);return;}
    if(document.getElementById('hans-mage-autoskill-v120'))return;
    button=document.createElement('button');button.type='button';
    button.id='hans-mage-autoskill-v120';
    button.style.cssText='position:fixed;left:8px;bottom:84px;z-index:2147483647;color:white;border:1px solid white;border-radius:5px;padding:5px 8px;cursor:pointer';
    button.onclick=()=>{
      const on=timer===null;
      if(on)document.dispatchEvent(new Event('ro-profile-selected'));
      enable(on);
    };
    button.setAttribute('aria-keyshortcuts','Shift+1');
    document.addEventListener('ro-profile-selected',()=>enable(false));
    document.body.append(button);
    window.addEventListener('keydown',event=>{
      if(event.code!=='Digit1'||!event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
      const path=typeof event.composedPath==='function'?event.composedPath():[];
      if(path.some(el=>el?.isContentEditable||el?.matches?.('input,textarea,select,[role="textbox"]')))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat)button.click();
    },true);
    enable(false);
  }
  mount();
})();