// ==UserScript==
// @name         HANS RO 盜賊→流氓｜六核心自動選技＋優先放逐＋尋寶寶箱
// @namespace    ro-local-profiles
// @version      1.1.1
// @description  流氓v1.1.1：刀扇有就點；六招未齊只補技／重抽且嚴禁放逐；六招齊後才放逐非刀扇。加強普攻取得追蹤及跨場次重置；寶箱維持尋寶率優先。
// @match        https://ro.hans-webgametw.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Rogue_AutoSkill.user.js
// @downloadURL  https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Rogue_AutoSkill.user.js
// ==/UserScript==
(() => {
  'use strict';
  const id = 'hans-rogue-autoskill-v100';
  if (document.getElementById(id)) return;
  const label = '流氓';
  const version = '1.1.1';
  const potion = [/傷害藥水|damage potion|potion of damage/i, /範圍藥水|area potion|potion of area/i];
  const normalize = s => String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const read = (el,selector) => normalize(el?.querySelector(selector)?.textContent||'');
  function shown(el){
    if(!el||!el.isConnected||el.disabled||!el.getClientRects().length) return false;
    for(let n=el,i=0;n&&i<12;n=n.parentElement,i++){
      const css=getComputedStyle(n);
      if(css.display==='none'||css.visibility==='hidden'||Number(css.opacity)===0||n.hidden) return false;
    }
    return el.getAttribute('aria-disabled')!=='true';
  }
  const cardName=card=>read(card,'.pk-name');
  const cardText=card=>read(card,'.pk-lines');
  const isNew=card=>!!card.querySelector('.pk-ribbon,.pk-badge-new,[data-new="true"]');

  // 禁止學習/升級；「放逐」不同於「選取」。
  const hardBans = [
    {label:'影步',re:/影步|shadow\s*step/i},
    {label:'背刺',re:/背刺|back\s*stab/i}
  ];
  const isHardBan=card=>hardBans.some(x=>x.re.test(cardName(card)));

  // 五個主動技能 + 一個普攻升級；普攻不占新技能欄位。
  const core = [
    {id:'knife',label:'刀扇',tier:1,re:/刀扇|飛刀扇|knife\s*fan/i,slot:/刀扇|飛刀扇|knife[-_]?fan/i},
    {id:'basic',label:'普攻第一招',tier:2,re:/普攻第一招|普通攻擊|基本攻擊|^普攻$|basic\s*attack/i,slot:/普通攻擊|基本攻擊|basic[-_]?attack|atk_/i},
    {id:'stone',label:'投擲石頭',tier:2,re:/投擲石頭|stone\s*(?:throw|fling)/i,slot:/投擲石頭|stone[-_]?(?:throw|fling)/i},
    {id:'poison',label:'施毒',tier:2,re:/施毒|envenom/i,slot:/施毒|envenom/i},
    {id:'raid',label:'潛擊',tier:2,re:/潛擊|\braid\b/i,slot:/潛擊|\braid\b/i},
    {id:'caltrops',label:'鐵蒺藜',tier:2,re:/鐵蒺藜|caltrops?/i,slot:/鐵蒺藜|caltrops?/i}
  ];
  const skills=core.filter(s=>s.id!=='basic');
  function isBasicAttack(card){
    const name=cardName(card),sub=read(card,'.pk-sub');
    const image=card.querySelector('.pk-art img,img');
    const src=normalize(image?.getAttribute('src')||image?.src||'');
    const cardId=normalize(card.dataset.skill||card.getAttribute('data-skill')||'');
    return core[1].re.test(name) || /^atk[_-]/i.test(cardId) ||
      /\/icons\/atk[_-]/i.test(src) || /basic\s*attack|普攻第一招/i.test(name+' '+sub);
  }
  function coreOf(card){
    if(isHardBan(card)) return null;
    if(isBasicAttack(card)) return core[1];
    const name=cardName(card);
    return core.find(s=>s.id!=='basic'&&s.re.test(name))||null;
  }
  // 普攻第一招是被動／普通攻擊卡，不會可靠地出現在五格主動技能欄。
  // 只在本次運行中確認選取成功後記錄，不沿用前一場；避免錯誤提前放逐。
  let basicLearned=false, lastOwnedCount=null;
  function recordSelected(picked){
    if(picked?.skillId==='basic' && !basicLearned){
      basicLearned=true;
      diagnostic('已取得普攻第一招；納入六招完成判斷');
    }
  }
  function slotInfo(panel){
    const sockets=panel.querySelector('#lu-sockets')||document.querySelector('#lu-sockets');
    const txt=normalize(sockets?.textContent);
    const m=txt.match(/(?:技能|skills?)?\s*(\d+)\s*\/\s*(\d+)/i);
    const slots=[...(sockets?.querySelectorAll('.skill-slot')||[])];
    const empty=!!sockets?.querySelector('.skill-slot.empty,.skill-slot[data-skill=""],.skill-slot:not([data-skill])');
    const full=m?Number(m[1])>=Number(m[2]):slots.length>0&&!empty;
    const owned=new Set();
    for(const el of (sockets?.querySelectorAll('[data-skill],.skill-slot')||[])){
      const data=normalize([el.getAttribute('data-skill'),el.getAttribute('title'),el.getAttribute('aria-label'),el.dataset?.skillName,el.textContent].filter(Boolean).join(' '));
      for(const s of skills) if(s.re.test(data)||s.slot.test(data)) owned.add(s.id);
    }
    // 觀測到從已取得多招回到全空格，可視為新場次，清除上場的普攻紀錄。
    if(lastOwnedCount!==null && lastOwnedCount>=2 && owned.size===0){
      basicLearned=false;
      diagnostic('偵測到新場次空技能欄，重置普攻紀錄；重新湊六招');
    }
    if(!!sockets&&(!!m||slots.length>0))lastOwnedCount=owned.size;
    const ready=!!sockets&&(!!m||slots.length>0) &&
      skills.every(skill=>owned.has(skill.id)) && basicLearned;
    return {full,known:!!sockets&&(!!m||slots.length>0),owned,basicLearned,ready};
  }
  const order=skill=>core.findIndex(s=>s.id===skill.id);
  function collecting(info){return !info.ready;}
  function missingCoreText(info){
    const missing=skills.filter(x=>!info.owned.has(x.id)).map(x=>x.label);
    if(!info.basicLearned)missing.push('普攻第一招');
    return missing.join('、') || '待核對技能欄';
  }
  function numericStat(t){
    const all=[...t.matchAll(/(?:\+|增加|提升|提高)\s*(\d+(?:[.,]\d+)?)/g)]
      .map(m=>Number(m[1].replace(',','.'))).filter(Number.isFinite);
    return Math.max(0,...all);
  }
  function upgradeScore(card){
    const t=cardText(card);
    // 套用巫師版同類增益排序：新增目標／攻擊次數 > 急速冷卻 > 傷害 > 其他。
    const extra=/(?:額外|增加|\+)\s*\d+\s*(?:個|名|隻|次|發|道)?\s*(?:目標|敵人|攻擊|投擲|刀扇|飛刀)|(?:目標|攻擊次數|投擲數量|數量)\s*\+\s*\d+/i.test(t);
    const haste=/(?:急速|冷卻|cooldown|haste)/i.test(t);
    const damage=/(?:傷害|damage|dmg)/i.test(t);
    return (extra?5000:haste?3000:damage?2000:1000)+Math.min(numericStat(t),1000)/100;
  }
  function scoreCard(card,info){
    if(isHardBan(card))return -Infinity;
    const skill=coreOf(card),fresh=isNew(card);
    if(fresh&&info.full&&skill?.id!=='basic')return -Infinity;
    if(!skill)return -Infinity;
    if(fresh&&skill.id!=='basic'){
      if(info.known&&info.owned.has(skill.id))return -Infinity;
      return 120000+(skill.tier===1?3000:100)-(order(skill));
    }
    if(fresh&&skill.id==='basic')return info.basicLearned?-Infinity:51000;
    return (skill.tier===1?100000:50000)+upgradeScore(card)-(order(skill));
  }
  function chooseSkill(cards,info){
    // 刀扇絕對最高優先：升級卡只會出現一張，不比較詞條，看到合法的就點。
    const knives=cards.map(card=>({card,score:scoreCard(card,info)}))
      .filter(x=>coreOf(x.card)?.id==='knife' && Number.isFinite(x.score));
    if(knives.length)return {phase:!info.ready,choice:knives[0]};
    if(!info.ready){
      // 六招未齊前只拿缺少的招：主動新招 + 普攻第一招首次卡。
      // 若暫無缺招卡，先重抽，重抽耗盡才保底升級已學核心。
      const missing=cards.map(card=>({card,skill:coreOf(card)}))
        .filter(x=>x.skill &&
          (x.skill.id==='basic' ? !info.basicLearned : isNew(x.card)&&!info.full&&!info.owned.has(x.skill.id)));
      const ordered=missing.map(x=>({card:x.card,score:scoreCard(x.card,info)}))
        .filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score);
      return {phase:true,choice:ordered[0]||null};
    }
    // 六招已齊且沒有刀扇：應先放逐／重抽，不直接升其他五招。
    return {phase:false,choice:null};
  }
  // 保底只允許先選六核心；影步/背刺即使耗盡放逐和重抽也絕不選。
  function fallbackScore(card,info){
    if(isHardBan(card))return -Infinity;
    if(isNew(card)&&info.full&&coreOf(card)?.id!=='basic')return -Infinity;
    const s=coreOf(card);
    if(s)return 100000+scoreCard(card,info);
    return isNew(card)?100:1000+upgradeScore(card);
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

  function discoveryTieRank(card){
    const name=cardName(card),sub=read(card,'.pk-sub');
    if(/豐饒祝福|blessing of (plenty|abundance)/i.test(name))return 3;
    if(/神祇|神祗|之神|deity/i.test(name+' '+sub))return 2;
    if(/尋寶率|驚奇秘藥|discovery|surprise elixir/i.test(name))return 1;
    return 0;
  }
  function chestRank(card){
    const name=cardName(card),sub=read(card,'.pk-sub'),t=cardText(card);
    const item=name+' '+sub+' '+t,rate=discoveryGain(card);
    if(rate!==null)return 1000+rate;
    if(/豐饒祝福|blessing of (plenty|abundance)/i.test(name))return 141;
    if(/神祇|神祗|之神|deity/i.test(item))return /尋寶率|discovery/i.test(item)?140:-Infinity;
    if(/尋寶率|驚奇秘藥|discovery|surprise elixir/i.test(item))return 140;
    if(/急速|冷卻|haste|cooldown/i.test(item))return 120;
    const idx=potion.findIndex(re=>re.test(name));if(idx>=0)return 85-idx*5;
    if(/傷害祝福|damage blessing|blessing of damage/i.test(name))return 62;
    if(/傷害秘藥|damage elixir|elixir of damage/i.test(name))return 58;
    if(/STR\s*(?:料理|dish)|(?:dish|plato)\s+(?:of\s+)?STR/i.test(name))return 1;
    return -Infinity;
  }
  function fallbackChestRank(card){
    const name=cardName(card)+' '+read(card,'.pk-sub');
    if(/神祇|神祗|之神|deity/i.test(name))return -2;
    if(/生命|護甲|減傷|armor|life|health/i.test(name))return -1;
    return 0;
  }
  function bestChest(cards){
    const ordered=[...cards];if(ordered.length>1)[ordered[0],ordered[1]]=[ordered[1],ordered[0]];
    return ordered.reduce((best,card)=>{
      if(!best)return card;
      const a=chestRank(card),b=chestRank(best);
      return a>b||(a===b&&a>=1000&&discoveryTieRank(card)>discoveryTieRank(best))?card:best;
    },null);
  }
  function actText(btn){return normalize([btn.getAttribute('title'),btn.getAttribute('aria-label'),btn.textContent].filter(Boolean).join(' '));}
  const banishPattern=/放逐|排除|banish|exile|desterrar|banir/i;
  function banishBtn(card){
    const slot=card.closest('.pk-slot');
    if(!slot||slot.classList.contains('asking'))return null;
    return [...slot.querySelectorAll('button.pk-act')].find(btn=>shown(btn) &&
      !String(btn.dataset.act||'').startsWith('bar:') && banishPattern.test(actText(btn)))||null;
  }
  function rerollAllBtn(panel){
    const buttons=[...panel.querySelectorAll('#pk-bar button,.pk-acts button,.pk-actions button,#picker button')];
    return buttons.find(btn=>{
      if(!shown(btn)||btn.closest('.pk-slot'))return false;
      const txt=actText(btn);
      const remaining=txt.match(/(?:重抽全部|重抽整組|重抽卡組|Reroll\s*(?:deck|all))[^\d]{0,10}(\d+)\s*(?:次|回|uses?)?/i);
      if(remaining&&Number(remaining[1])===0)return false;
      return /重抽全部|重抽整組|重抽卡組|重新抽選|reroll\s*(?:deck|all)/i.test(txt);
    })||null;
  }
  let timer=null,button=null,lastMsg='',nextActionAt=0,pending=null,lastChoiceKey='',choiceTries=0;
  const attempts=new WeakMap();
  function diagnostic(s){
    if(s===lastMsg)return;
    lastMsg=s;
    if(button)button.title='Shift+2 切換｜'+s;
    console.info('[HANS 流氓 v'+version+'] '+s);
  }
  function tryBanish(cards,info){
    // 絕對門檻：未確認六招全部取得（含普攻第一招），不能按任何放逐。
    if(!info.ready)return false;
    // 刀扇永不放逐；影步、背刺第一優先，其次其他非核心，再來其餘五核心。
    const ranked=cards.map(card=>{
      const skill=coreOf(card),name=cardName(card);
      const banIndex=hardBans.findIndex(b=>b.re.test(name));
      return {card,name,skill,banIndex};
    }).filter(x=>x.skill?.id!=='knife')
      .sort((a,b)=>{
        const rank=x=>x.banIndex>=0?x.banIndex:(x.skill?4:2);
        return rank(a)-rank(b);
      });
    for(const x of ranked){
      const btn=banishBtn(x.card);
      if(!btn)continue;
      const marker=normalize(btn.textContent)+'|'+normalize(btn.title)+'|'+x.name;
      const before=attempts.get(btn);
      if(before?.marker===marker&&before.count>=2)continue;
      attempts.set(btn,{marker,count:before?.marker===marker?before.count+1:1});
      nextActionAt=performance.now()+900;
      diagnostic('六招已齊，放逐：'+x.name+(x.banIndex>=0?'｜禁招':'｜刀扇以外'));
      btn.click();return true;
    }
    return false;
  }
  function tryReroll(panel,why){
    const btn=rerollAllBtn(panel);
    if(!btn)return false;
    const marker=actText(btn);
    const old=attempts.get(btn);
    if(old?.marker===marker&&old.count>=2)return false;
    attempts.set(btn,{marker,count:old?.marker===marker?old.count+1:1});
    nextActionAt=performance.now()+1500;
    diagnostic(why+'：重抽全部');btn.click();return true;
  }
  function chooseCard(card,reason){
    if(isHardBan(card)){diagnostic('阻止選取禁招：'+cardName(card));return;}
    const key=[cardName(card),cardText(card),isNew(card)].join('|');
    if(key===lastChoiceKey)choiceTries++;else{lastChoiceKey=key;choiceTries=1;}
    if(choiceTries>3){diagnostic('相同卡片點擊未生效，等待人工處理：'+cardName(card));return;}
    pending={card,name:cardName(card),skillId:coreOf(card)?.id||null,
      at:performance.now()};
    nextActionAt=performance.now()+900;
    diagnostic('自動選擇：'+cardName(card)+'｜'+reason);
    card.click();
  }
  function tick(){
    const reveal=document.querySelector('#drop-reveal:not(.hidden)');
    if(shown(reveal)){
      const result=shown(reveal.querySelector('.dr-result'));
      const get=result?reveal.querySelector('button.dr-get'):
        reveal.matches('.roll')&&reveal.querySelector('button[data-c="greed"]');
      if(shown(get)){diagnostic('領取戰利品');get.click();}return;
    }
    const panel=document.querySelector('#picker:not(.hidden):not(.closing)');
    if(!shown(panel)){
      // 選卡後面板已關閉（沒有二次確認的遊戲版本）：視為選取成功。
      if(pending)recordSelected(pending);
      pending=null;lastChoiceKey='';choiceTries=0;tick.prevHand='';diagnostic('等待升級／寶箱畫面');return;
    }
    const title=normalize(read(panel,'#pk-title')||document.querySelector('#pk-title')?.textContent||read(panel,'.pk-title')||read(panel,'h1'));
    const chest=/^(?:寶箱|寶箱選擇|treasure\s*chest)\s*!?$/i.test(title);
    const level=/^(?:升\s*級|強化\s*技能|level\s*up|upgrade\s*(?:a\s*)?skill)\s*!?$/i.test(title);
    const byLayout=!chest&&!level&&shown(document.querySelector('#lu-sockets'))&&!!panel.querySelector('button.pk-card');
    if(!chest&&!level&&!byLayout){diagnostic('未知選卡標題：'+title.slice(0,70));return;}
    const asking=panel.querySelector('.pk-slot.asking');
    if(asking){
      const card=asking.querySelector('button.pk-card');
      const ours=!!pending&&!!card&&(pending.card===card||
        (cardName(card)===pending.name&&performance.now()-pending.at<4500));
      if(ours){
        if(isHardBan(card)){diagnostic('禁招確認畫面：停止，不按確認');return;}
        const yes=asking.querySelector('[data-yes]');
        if(shown(yes)){diagnostic('確認選卡：'+pending.name);yes.click();recordSelected(pending);pending=null;lastChoiceKey='';choiceTries=0;}
      }else diagnostic('手動選卡確認畫面：不干預');
      return;
    }
    if(performance.now()<nextActionAt)return;
    const cards=[...new Set(panel.querySelectorAll('button.pk-card,[role="button"].pk-card,.pk-card'))].filter(shown);
    if(!cards.length){diagnostic('沒有可見選卡');return;}
    const hand=cards.map(c=>cardName(c)+'|'+cardText(c)+'|'+isNew(c)).join('||');
    if(hand!==tick.prevHand){
      // 上一輪點選後換了一手，代表選取已完成；避免沒二次確認時遺漏普攻。
      if(pending)recordSelected(pending);
      tick.prevHand=hand;lastChoiceKey='';choiceTries=0;pending=null;
    }
    if(chest){
      const chosen=bestChest(cards);
      if(chosen&&Number.isFinite(chestRank(chosen))){chooseCard(chosen,'寶箱尋寶率優先');return;}
      if(tryReroll(panel,'寶箱'))return;
      const backup=cards.reduce((a,b)=>!a||fallbackChestRank(b)>fallbackChestRank(a)?b:a,null);
      if(backup)chooseCard(backup,'寶箱保底');return;
    }
    // 優先順序固定：刀扇有就點；缺招先補；六招齊後才可放逐。
    const info=slotInfo(panel),{phase,choice}=chooseSkill(cards,info);
    if(choice){chooseCard(choice.card,phase?'刀扇優先／補六招':'刀扇最高優先');return;}
    if(!info.ready){
      // 前期絕不動用放逐，包括影步與背刺；改用重抽。
      if(tryReroll(panel,'六招未齊（缺 '+missingCoreText(info)+'），禁止放逐'))return;
    }else{
      // 後期才用放逐排除非刀扇，再用重抽尋找刀扇。
      if(tryBanish(cards,info))return;
      if(tryReroll(panel,'六招已齊，尋找刀扇'))return;
    }
    // 重抽耗盡／放逐用完後保底：絕不能選影步、背刺。
    // 六招未齊：保底優先核心。六招已齊：優先其他五核心升級，盡量不學新雜技。
    const pool=cards.map(card=>({card,score:fallbackScore(card,info)}))
      .filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score);
    if(pool.length){
      const x=pool[0];
      chooseCard(x.card,coreOf(x.card)?'資源耗盡：核心安全保底':'資源耗盡：非禁招保底');
      return;
    }
    diagnostic('只有影步／背刺或無效卡，且放逐／重抽不可用：停止，請手動處理');
  }
  function safeTick(){try{tick();}catch(e){diagnostic('腳本錯誤：'+(e?.message||e));console.error('[HANS 流氓]',e);}}
  function enable(on){
    clearInterval(timer);timer=on?setInterval(safeTick,400):null;
    if(button){button.textContent=label+'選技：'+(on?'開':'關')+' v'+version;
      button.style.background=on?'#186442':'#384455';}
    diagnostic(on?'已啟動（刀扇有就點；湊六招前禁止放逐）':'已停用，Shift+2 可啟動');
  }
  function mount(){
    if(!document.body){setTimeout(mount,100);return;}
    if(document.getElementById(id))return;
    button=document.createElement('button');button.type='button';button.id=id;
    button.style.cssText='position:fixed;left:8px;bottom:126px;z-index:2147483647;color:white;border:1px solid white;border-radius:5px;padding:5px 8px;cursor:pointer';
    button.onclick=()=>{const on=timer===null;if(on)document.dispatchEvent(new Event('ro-profile-selected'));enable(on);};
    button.setAttribute('aria-keyshortcuts','Shift+2');
    document.addEventListener('ro-profile-selected',()=>enable(false));
    document.body.append(button);
    window.addEventListener('keydown',event=>{
      if(event.code!=='Digit2'||!event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
      const path=typeof event.composedPath==='function'?event.composedPath():[];
      if(path.some(el=>el?.isContentEditable||el?.matches?.('input,textarea,select,[role="textbox"]')))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat)button.click();
    },true);
    enable(false);
  }
  mount();
})();
