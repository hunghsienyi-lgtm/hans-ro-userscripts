// ==UserScript==
// @name         HANS RO 盜賊→流氓｜六核心自動選技＋優先放逐＋尋寶寶箱
// @namespace    ro-local-profiles
// @version      1.1.8
// @description  流氓v1.1.8：技能5/5後連續用完三次放逐，只排除刀扇，確認扣次數後才繼續；未用完不選卡。
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
  const version = '1.1.8';
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
    {id:'basic',label:'普攻第一招',tier:2,re:/普攻第一招|普通攻擊|基本攻擊|^普攻$|^攻擊\s*[:：・·]|basic\s*attack/i,slot:/普通攻擊|基本攻擊|basic[-_]?attack|atk_/i},
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
    // 5/5 可能位於 #lu-sockets 的父層或選卡面板標頭，而非圖示容器本身。
    // 使用「技能 5/5」明確文字，避免被不同版本的 DOM 結構卡死。
    const headerTexts=[
      sockets?.textContent,
      sockets?.parentElement?.textContent,
      panel.querySelector('#lu-sockets')?.parentElement?.textContent,
      panel.querySelector('#pk-bar')?.textContent,
      panel.textContent
    ].filter(Boolean).map(normalize);
    let m=headerTexts.map(t=>t.match(/(?:技能|skills?)\s*(\d+)\s*\/\s*(\d+)/i))
      .find(Boolean)||null;
    if(!m&&document.body){
      // 5/5 標題有時位於 picker 外層，從可見文字節點尋找。
      // 排除腳本自己的診斷面板，避免自行觸發。
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      let node,i=0;
      while((node=walker.nextNode())&&i++<3500){
        const p=node.parentElement;
        if(!p||p.closest('#hans-rogue-live-status,#hans-left-control-center-v100,#ro-loot-journal-v05-ui'))continue;
        const match=normalize(node.nodeValue).match(/(?:技能|skills?)\s*(\d+)\s*\/\s*(\d+)/i);
        if(match&&shown(p)){m=match;break;}
      }
    }
    const txt=headerTexts[0]||'';
    const slots=[...(sockets?.querySelectorAll('.skill-slot')||[])];
    const empty=!!sockets?.querySelector('.skill-slot.empty,.skill-slot[data-skill=""],.skill-slot:not([data-skill])');
    const full=m?Number(m[1])>=Number(m[2]):slots.length>=5&&!empty;
    // 以遊戲明確的「技能 5/5」作為權威完成訊號。
    // 舊版強制辨識每格圖示名稱及本場是否由腳本點過普攻，
    // 造成畫面已有 5/5、放逐還有 3 次時也完全不放逐。
    const explicitFiveOfFive=!!m&&Number(m[1])===5&&Number(m[2])===5;
    const owned=new Set();
    let unrecognized=0,occupied=0;
    // v1.1.2 僅信任「實際已裝備技能格」的個別資料。
    // 舊版掃描全部 [data-skill]（含非持有的卡片）可能把未學技能誤認成已擁有。
    for(const el of slots){
      if(el.classList.contains('empty')||el.getAttribute('data-skill')==='')continue;
      const im=el.querySelector('img');
      const data=normalize([
        el.getAttribute('data-skill'),el.getAttribute('title'),
        el.getAttribute('aria-label'),el.dataset?.skillName,
        im?.getAttribute('alt'),im?.getAttribute('title'),
        im?.getAttribute('src'),el.textContent
      ].filter(Boolean).join(' '));
      if(!data)continue;
      occupied++;
      const hits=skills.filter(skill=>skill.re.test(data)||skill.slot.test(data));
      if(hits.length===1)owned.add(hits[0].id);
      else unrecognized++;
    }
    // 防止錯把虛擬卡片/武器圖示也當成主動技能：需要五個不同核心逐格辨識。
    const coreSlotsVerified=slots.length>=5 && skills.every(skill=>owned.has(skill.id));
    const known=!!sockets||!!m||slots.length>0;
    if(lastOwnedCount!==null && lastOwnedCount>=2 && occupied===0 && !full){
      basicLearned=false;
      diagnostic('已偵測到新場次技能欄重置；重新取得普攻第一招');
    }
    if(known)lastOwnedCount=occupied;
    // 只採明確技能5/5作為放逐門檻；未滿5/5絕不放逐。
    // 不再依靠不穩定的圖示ID或本場普攻是否由腳本親自選過。
    const ready=explicitFiveOfFive;
    return {full,known,owned,unrecognized,occupied,coreSlotsVerified,basicLearned,
      explicitFiveOfFive,ready};
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
    const skill=coreOf(card);
    // v1.1.2：核心未齊前「絕對不可」保底選非核心／不認得的技能，
    // 否則五個主動欄被佔滿，後續無法再取得刀扇等核心。
    if(!info.ready && !skill)return -Infinity;
    if(isNew(card)&&info.full&&skill?.id!=='basic')return -Infinity;
    if(skill)return 100000+scoreCard(card,info);
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
  // 每張選卡必須對應自己的「放逐」按鈕，不使用全頁模糊匹配。
  // 放逐的「3/2/1/0」可能在按鈕的徽章或旁邊，不以技能等級代替次數。
  function exileButtons(panel){
    return [...panel.querySelectorAll('button.pk-act,button,[role="button"]')].filter(btn=>
      shown(btn)&&!String(btn.dataset?.act||'').startsWith('bar:')&&
      banishPattern.test(actText(btn)+' '+String(btn.dataset?.act||'')));
  }
  function remainingExiles(panel){
    for(const btn of exileButtons(panel)){
      const bits=[
        btn.getAttribute('aria-label'),btn.getAttribute('title'),btn.textContent,
        btn.dataset?.remaining,btn.dataset?.count,btn.dataset?.uses,
        btn.querySelector('.pk-count,.pk-badge,.pk-act-count,[class*="count"],[class*="badge"]')?.textContent,
        btn.nextElementSibling?.textContent,
        btn.parentElement?.querySelector('.pk-count,.pk-badge,.pk-act-count,[class*="count"],[class*="badge"]')?.textContent
      ];
      for(const raw of bits){
        const t=normalize(raw||'');
        const labelled=t.match(/(?:放逐|banish|exile)\s*[:：]?\s*([0-3])(?:\D|$)/i);
        if(labelled)return Number(labelled[1]);
        if(/^[0-3]$/.test(t))return Number(t);
      }
    }
    return null;
  }
  function exileSignature(cards,panel){
    return cards.map(c=>cardName(c)+'/'+cardText(c)).join('||')+'|'+
      exileButtons(panel).map(b=>normalize(b.textContent)+':'+normalize(b.title)).join(';');
  }
  let exileState={pending:null,done:0,blocked:false};
  function resetExile(){exileState={pending:null,done:0,blocked:false};}
  function banishBtn(card){
    const slot=card.closest('.pk-slot');
    if(!slot||slot.classList.contains('asking'))return null;
    return [...slot.querySelectorAll('button.pk-act,button,[role="button"]')].find(btn=>
      btn!==card&&!btn.contains(card)&&shown(btn)&&
      !String(btn.dataset?.act||'').startsWith('bar:')&&
      banishPattern.test(actText(btn)+' '+String(btn.dataset?.act||'')))||null;
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
  let statusBox=null;
  const attempts=new WeakMap();
  function diagnostic(s){
    if(s===lastMsg)return;
    lastMsg=s;
    if(button){
      button.title='Shift+2 切換｜'+s;
      button.dataset.hansScriptStatus=s;
    }
    if(statusBox)statusBox.textContent='流氓 v'+version+'｜'+s;
    console.info('[HANS 流氓 v'+version+'] '+s);
  }
  function statusVisible(on){
    if(statusBox)statusBox.hidden=!on;
  }
  function tryBanish(cards,info,panel){
    if(!info.explicitFiveOfFive){resetExile();return false;}
    const rem=remainingExiles(panel),signature=exileSignature(cards,panel);
    if(exileState.pending){
      const old=exileState.pending;
      const success=(rem!==null&&old.count!==null&&rem<old.count)||
        (rem===null&&signature!==old.signature);
      if(success){
        exileState.done++;exileState.pending=null;
        diagnostic('已確認放逐 '+exileState.done+' 次，剩餘 '+(rem??'未知'));
      }else if(performance.now()-old.at>1700){
        exileState.blocked=true;exileState.pending=null;
        diagnostic('已按放逐但未確認扣次數｜停止選卡，不能假裝已用完');
      }else{
        diagnostic('等待放逐扣次數｜'+(rem??'?')+' 次');
        return true;
      }
    }
    if(exileState.blocked)return true;
    if(rem===0){diagnostic('放逐次數歸零，繼續選技');return false;}
    if(rem===null&&exileState.done>=3){diagnostic('已確認放逐三次，繼續選技');return false;}
    // 不比較強度：左到右第一張不是刀扇的卡直接放逐。
    const targets=cards.filter(card=>!core[0].re.test(cardName(card))&&coreOf(card)?.id!=='knife');
    if(!targets.length){diagnostic('技能已5/5，但畫面全是刀扇，禁止放逐刀扇');return true;}
    const picked=targets.map(card=>({card,btn:banishBtn(card)})).find(x=>x.btn);
    if(!picked){
      diagnostic('滿5/5，還有 '+(rem??'?')+' 次放逐；找不到非刀扇卡的放逐按鈕');
      return true;
    }
    exileState.pending={at:performance.now(),count:rem,signature};
    nextActionAt=performance.now()+650;
    diagnostic('滿5/5：放逐 '+cardName(picked.card)+'｜剩 '+(rem??'?')+' 次');
    picked.btn.click();return true;
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
      statusVisible(false);
      const result=shown(reveal.querySelector('.dr-result'));
      const get=result?reveal.querySelector('button.dr-get'):
        reveal.matches('.roll')&&reveal.querySelector('button[data-c="greed"]');
      if(shown(get)){diagnostic('領取戰利品');get.click();}return;
    }
    const panel=document.querySelector('#picker:not(.hidden):not(.closing)');
    if(!shown(panel)){
      statusVisible(false);
      if(exileState.pending||exileState.done||exileState.blocked)resetExile();
      // 選卡後面板已關閉（沒有二次確認的遊戲版本）：視為選取成功。
      if(pending)recordSelected(pending);
      pending=null;lastChoiceKey='';choiceTries=0;tick.prevHand='';diagnostic('等待升級／寶箱畫面');return;
    }
    statusVisible(true);
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
    if(!cards.length){diagnostic('選卡畫面開啟，但找不到任何 .pk-card');return;}
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
    // 優先順序：六招未齊時刀扇優先並補招、不放逐；
    // 六招已齊時「先放逐所有可放逐的非刀扇卡」，最後才選刀扇。
    const info=slotInfo(panel);
    // 例：遊戲顯示「技能 5/5」卻仍缺刀扇；這一局不可用放逐補救已佔用的技能欄。
    if(info.full && !info.ready){
      diagnostic('技能欄滿格但沒有讀到「技能5/5」｜暫停選卡，避免誤動作');
      return;
    }
    if(info.ready){
      // 已辨識 5/5，逐張對應卡片下的放逐按鈕，刀扇只能最後選。
      // 每次成功點擊放逐都結束這輪 tick；等待遊戲更新畫面後再重新判斷。
      // 因此不會在同一輪同時觸發「放逐」與「選刀扇」。
      if(tryBanish(cards,info,panel))return;
      const {choice}=chooseSkill(cards,info);
      if(choice){chooseCard(choice.card,'六招已齊｜非刀扇放逐優先，最後選刀扇');return;}
      if(tryReroll(panel,'六招已齊且沒有刀扇，尋找刀扇'))return;
    }else{
      // 未齊前絕不消耗放逐，刀扇及其他缺少的核心才有選取權。
      const {choice}=chooseSkill(cards,info);
      if(choice){chooseCard(choice.card,'刀扇優先／補六招');return;}
      if(tryReroll(panel,'六招未齊（缺 '+missingCoreText(info)+'），禁止放逐'))return;
    }
    // 重抽耗盡／放逐用完後保底：絕不能選影步、背刺。
    // 六招未齊：只能選已認得的核心卡，沒有就等待人工處理，絕不填入雜技。
    const pool=cards.map(card=>({card,score:fallbackScore(card,info)}))
      .filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score);
    if(pool.length){
      const x=pool[0];
      chooseCard(x.card,coreOf(x.card)?'資源耗盡：核心安全保底':'資源耗盡：非禁招保底');
      return;
    }
    diagnostic(!info.ready?
      '六核心未齊，沒有安全核心卡可選；重抽已用完／不可用，停止自動選技，絕不浪費放逐':
      '只有影步／背刺或無效卡，且放逐／重抽不可用：停止，請手動處理');
  }
  function safeTick(){try{tick();}catch(e){diagnostic('腳本錯誤：'+(e?.message||e));console.error('[HANS 流氓]',e);}}
  function enable(on){
    clearInterval(timer);timer=on?setInterval(safeTick,400):null;
    if(!on)statusVisible(false);
    if(button){button.textContent=label+'選技：'+(on?'開':'關')+' v'+version;
      button.style.background=on?'#186442':'#384455';}
    diagnostic(on?'已啟動（滿5/5先用完三次放逐，刀扇除外）':'已停用，Shift+2 可啟動');
  }
  function mount(){
    if(!document.body){setTimeout(mount,100);return;}
    if(document.getElementById(id))return;
    button=document.createElement('button');button.type='button';button.id=id;
    button.dataset.hansScriptVersion=version;
    statusBox=document.createElement('div');
    statusBox.id='hans-rogue-live-status';
    statusBox.hidden=true;
    statusBox.style.cssText='position:fixed;bottom:4px;right:8px;z-index:2147483646;'+
      'background:#102d47eF;color:#eef7ff;border:1px solid #87aacc;border-radius:6px;'+
      'font:11px/1.3 system-ui,sans-serif;padding:4px 7px;max-width:min(410px,82vw);'+
      'pointer-events:none;overflow-wrap:anywhere';
    statusBox.textContent='流氓 v'+version+'｜等待選卡';
    document.body.append(statusBox);
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
