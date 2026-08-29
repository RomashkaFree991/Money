  let currentTab='game';
  const embeddedGameTabs=new Set(['crash','pvp','upgrade','case']);
  function handleTelegramBack(){
    if(embeddedGameTabs.has(currentTab))activateTab('game',false);
  }
  function syncTelegramBackButton(){
    const back=tg?.BackButton;
    if(!back)return;
    try{
      back.offClick(handleTelegramBack);
      if(embeddedGameTabs.has(currentTab)){
        back.onClick(handleTelegramBack);
        back.show();
      }else back.hide();
    }catch(e){}
  }
  function showTab(tab){
    const previousTab=currentTab;
    closeReferralPage();
    if(previousTab==='crash'&&tab!=='crash') pauseCrashRound();
    if(previousTab==='pvp'&&tab!=='pvp') stopPvpDemo();
    Object.values(pages).forEach(p=>p.classList.remove('visible'));
    if(pages[tab]){
      void pages[tab].offsetWidth;
      pages[tab].classList.add('visible');
      currentTab=tab;
    }
    pvpBetDock?.classList.toggle('open',tab==='pvp');
    syncTelegramBackButton();
    if(tab==='crash'){
      // Каждый вход получает собственную сессию; устаревшие ответы предыдущего входа игнорируются.
      crashViewSession+=1;
      crashStarted=true;
      runCrashRound();
    }else if(tab==='pvp'){
      startPvpDemo();
    }else if(tab==='top'){
      ensureTrophyLottie();
      refreshTop();
    }else if(tab==='upgrade'){
      ensureUpgradeRedo();
    }else if(tab==='case'){
      if(typeof renderCaseOpening==='function' && !caseStripEl?.children.length)renderCaseOpening();
    }else if(tab==='profile'){
      ensureProfileLottie();
      // Последний профиль уже показан из кэша при initUser. Не ждём второй
      // balance SELECT и не заменяем видимый интерфейс пустым состоянием.
      restoreProfileWarmState();
      Promise.all([refreshReferral(),refreshInventory()]).catch(()=>{});
    }
  }
  requestAnimationFrame(()=>{
    moveIndicator(document.querySelector('.nav-item.active'),false);
  });
  function activateTab(targetTab,animate=true){
    if(!pages[targetTab]) return;
    if(targetTab===currentTab && !referralPage.classList.contains('visible')) return;
    // Внутренние игры открываются из Game и сохраняют Game активным в нижней панели.
    const navTarget=document.querySelector(`.nav-item[data-tab="${embeddedGameTabs.has(targetTab)?'game':targetTab}"]`);
    document.querySelector('.nav-item.active')?.classList.remove('active');
    if(navTarget){
      navTarget.classList.add('active');
      moveIndicator(navTarget,animate);
    }
    showTab(targetTab);
  }
  items.forEach(item=>item.addEventListener('click',()=>{playAppSound('tab');activateTab(item.dataset.tab,true)}));
  document.querySelectorAll('[data-game-target]').forEach(banner=>{
    banner.addEventListener('click',()=>{playAppSound('tab');activateTab(banner.dataset.gameTarget,true)});
  });

  // Бесплатные кейсы пока работают как визуальный прототип: призы берутся из общего каталога,
  // а стоимость каждой карточки намеренно показывается как 0.
  const caseGifts=[...(typeof GIFT_CATALOG!=='undefined'?GIFT_CATALOG:[])].sort((a,b)=>Number(b?.price||0)-Number(a?.price||0)).slice(0,6);
  const caseTitleEl=document.getElementById('caseTitle');
  const caseNicknameEl=document.getElementById('caseNickname');
  const caseStripEl=document.getElementById('caseStrip');
  const caseGiftsGridEl=document.getElementById('caseGiftsGrid');
  const caseBackBtn=document.getElementById('caseBackBtn');
  const caseOpenBtn=document.getElementById('caseOpenBtn');
  function renderCaseOpening(card){
    const name=card?.querySelector('.admin-case-name')?.textContent?.trim()||'Кейс';
    if(caseTitleEl)caseTitleEl.textContent=name;
    if(caseNicknameEl)caseNicknameEl.textContent=typeof userHandle!=='undefined'?userHandle:'@user';
    const gifts=caseGifts.length?caseGifts:Array.from({length:6},(_,i)=>({name:'Подарок '+(i+1),image:'assets/star.png'}));
    if(caseStripEl)caseStripEl.innerHTML=gifts.map((gift,index)=>`<div class="case-strip-cell${index===2?' is-center':''}"><img src="${gift.image||'assets/star.png'}" alt="${gift.name||'Подарок'}"></div>`).join('');
    if(caseGiftsGridEl)caseGiftsGridEl.innerHTML=gifts.map(gift=>`<article class="case-gift-card"><img class="case-gift-image" src="${gift.image||'assets/star.png'}" alt="${gift.name||'Подарок'}" loading="lazy"><div class="case-gift-name">${gift.name||'Подарок'}</div><div class="case-gift-price"><span>${formatStars(gift.price||0)}</span><img src="assets/star.png" alt="Stars"></div></article>`).join('');
  }
  document.querySelectorAll('[data-case-open="true"]').forEach(card=>{
    const open=()=>{playAppSound('tab');renderCaseOpening(card);activateTab('case',true);};
    card.addEventListener('click',open);
    card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
  caseBackBtn?.addEventListener('click',()=>activateTab('game',true));
  caseOpenBtn?.addEventListener('click',()=>{
    caseOpenBtn.classList.remove('is-opening');
    void caseOpenBtn.offsetWidth;
    caseOpenBtn.classList.add('is-opening');
    caseOpenBtn.textContent='Открыто';
    setTimeout(()=>{if(caseOpenBtn)caseOpenBtn.textContent='Открыть';},900);
  });
  pvpBetBtn?.addEventListener('click',()=>{
    if(!pvpCanAcceptBets()){showBetError('Ставки закрыты: таймер уже закончился');return;}
    openBet('pvp');
  });
  pvpResultClose?.addEventListener('click',closePvpResult);
  const pvpHistoryOverlay=document.getElementById('pvpHistoryOverlay');
  const pvpHistoryList=document.getElementById('pvpHistoryModalList');
  const pvpHistoryCacheKey='giftpep:pvp-history:v1';
  let pvpHistoryCache=null;
  try{const saved=JSON.parse(localStorage.getItem(pvpHistoryCacheKey)||'null');if(Array.isArray(saved))pvpHistoryCache=saved;}catch(_){ }
  function renderPvpHistoryRows(rounds){
    if(!pvpHistoryList)return;
    pvpHistoryList.replaceChildren();
    if(!rounds?.length){const empty=document.createElement('div');empty.className='admin-muted';empty.textContent='История пока пуста';pvpHistoryList.append(empty);return;}
    for(const round of rounds){
      const card=document.createElement('div');card.className='pvp-history-modal-round';
      const title=document.createElement('div');title.className='pvp-history-modal-round-title';
      const label=document.createElement('span');label.textContent='Игра #'+round.roundId;
      const bank=document.createElement('span');bank.className='history-bank-value';bank.textContent='Банк +'+Number(round.totalBank||0);const bankStar=document.createElement('img');bankStar.src='assets/star.png';bankStar.alt='Stars';bank.append(bankStar);title.append(label,bank);card.append(title);
      for(const bet of (round.bets||[])){
        const row=document.createElement('div');row.className='pvp-history-modal-row';
        const avatar=document.createElement('img');avatar.alt='';avatar.src=bet.photoUrl||'assets/avatar_placeholder.png';
        const name=document.createElement('span');name.className='name';name.textContent=bet.firstName||'User';
        const total=Number(round.totalBank||0);const chance=total?Number(bet.amount||0)*100/total:0;
        const info=document.createElement('span');info.className='bet';info.textContent=Number(bet.amount||0)+' · '+chance.toFixed(2)+'%';const infoStar=document.createElement('img');infoStar.src='assets/star.png';infoStar.alt='Stars';info.append(infoStar);
        const win=document.createElement('span');win.className='bank';if(Number(bet.userId)===Number(round.winnerUserId)){win.textContent='+'+Number(round.totalBank||0);const winStar=document.createElement('img');winStar.src='assets/star.png';winStar.alt='Stars';win.append(winStar);}
        row.append(avatar,name,info,win);card.append(row);
      }
      pvpHistoryList.append(card);
    }
  }
  async function refreshPvpHistory(){
    try{const r=await fetch(API_BASE+'/api/pvp/history',{headers:{'x-init-data':tg?.initData||''}});const data=await r.json();if(!r.ok)throw new Error(data.error||'History failed');pvpHistoryCache=data.rounds||[];try{localStorage.setItem(pvpHistoryCacheKey,JSON.stringify(pvpHistoryCache));}catch(_){ }if(pvpHistoryOverlay?.classList.contains('open'))renderPvpHistoryRows(pvpHistoryCache);}catch(_){ }
  }
  function openPvpHistory(){
    pvpHistoryOverlay?.classList.add('open');
    if(pvpHistoryCache)renderPvpHistoryRows(pvpHistoryCache);
    else if(pvpHistoryList){pvpHistoryList.replaceChildren();pvpHistoryList.style.minHeight='210px';}
    refreshPvpHistory();
  }
  refreshPvpHistory();
  document.getElementById('pvpHistoryOpen')?.addEventListener('click',openPvpHistory);
  document.getElementById('pvpHistoryClose')?.addEventListener('click',()=>pvpHistoryOverlay?.classList.remove('open'));
  pvpHistoryOverlay?.addEventListener('click',e=>{if(e.target===pvpHistoryOverlay)pvpHistoryOverlay.classList.remove('open');});

  const appRoot=document.querySelector('.app');
  const bootScreen=document.getElementById('bootScreen');
  const bootTitle=document.getElementById('bootTitle');
  const bootSubtitle=document.getElementById('bootSubtitle');
  const bootRetryBtn=document.getElementById('bootRetryBtn');

  function showBootState(title,subtitle,{retry=false}={}){
    if(bootTitle) bootTitle.textContent=title||t('loading');
    if(bootSubtitle) bootSubtitle.textContent=subtitle||t('loadingWait');
    if(bootRetryBtn) bootRetryBtn.style.display=retry?'inline-flex':'none';
    bootScreen.classList.remove('hidden');
    appRoot.classList.add('boot-hidden');
  }
  function hideBootState(){
    appRoot.classList.remove('boot-hidden');
    bootScreen.classList.add('hidden');
  }
  function preloadImage(src,timeoutMs=3500){
    return new Promise(resolve=>{
      const img=new Image();
      const done=()=>resolve();
      const timer=setTimeout(done,timeoutMs);
      img.onload=()=>{clearTimeout(timer);done();};
      img.onerror=()=>{clearTimeout(timer);done();};
      img.src=src;
      if(img.complete){clearTimeout(timer);done();}
    });
  }
  function runAfterFirstPaint(task){
    const run=()=>Promise.resolve().then(task).catch(()=>{});
    if('requestIdleCallback' in window) window.requestIdleCallback(run,{timeout:1800});
    else setTimeout(run,700);
  }
  function bootTask(task,timeoutMs=7000){
    return Promise.race([
      Promise.resolve().then(task),
      new Promise(resolve=>setTimeout(resolve,timeoutMs)),
    ]);
  }
  async function bootstrapApp(){
    showBootState(
      t('loading'),
      currentLang==='en'?'Loading your game data':'Загружаем данные игры'
    );
    try{
      // Сначала показываем user-scoped warm-кэш. Для первого входа подождём
      // первичные данные в стартовом экране: профиль не должен открываться с
      // нулевым балансом и пустым инвентарём, которые через секунды «прыгают».
      await bootTask(()=>initUser());
      // Баланс и профиль уже применены внутри initUser()/warm-cache.
      // Не блокируем первый экран тяжёлыми игровыми запросами и загрузкой баннеров.
      hideBootState();
      Promise.allSettled([
        bootTask(()=>refreshCrashState(true,false,crashViewSession,true),6500),
        bootTask(()=>refreshPvpState(true),6500),
        bootTask(()=>refreshInventory(true),6500),
        bootTask(()=>refreshReferral(true),6500),
        preloadImage('assets/Crash_banner.png'),
        preloadImage('assets/PVP_Arena_banner.png'),
        preloadImage('assets/Upgrade_banner.png'),
      ]);
      if(!tg?.initData){
        const testGifts=GIFT_CATALOG.slice().sort((a,b)=>b.price-a.price).slice(0,5);
        inventoryItems=testGifts.map((g,i)=>normalizeInventoryGift({...g,id:'test_'+i,giftId:g.id},'test_'+i));
        renderInventory();
      }
      hideBootState();

      // Top и цены не должны задерживать первый экран. Профиль уже подготовлен выше.
      runAfterFirstPaint(()=>Promise.allSettled([
        refreshTop(true),
        refreshMarketPrices(),
      ]));
      runAfterFirstPaint(()=>ensureTonConnect().then(()=>{syncTopupWalletUI();syncTopupSubmitLabel();}));
      runAfterFirstPaint(()=>initAdmin());
    }catch(e){
      console.error('Bootstrap failed:',e);
      hideBootState();
    }
  }

  if(bootRetryBtn){
    bootRetryBtn.addEventListener('click',bootstrapApp);
  }

  referralCard.addEventListener('click',openReferralPage);
  document.getElementById('referralBackBtn').addEventListener('click',closeReferralPage);
  document.getElementById('referralCopyBtn').addEventListener('click',copyReferralLink);
  document.getElementById('referralInviteBtn').addEventListener('click',inviteByReferral);

  promoBtn?.addEventListener('click',async()=>{
    const code=String(promoInput?.value||'').trim();
    if(!code)return;
    try{
      promoBtn.disabled=true;
      const resp=await fetch(API_BASE+'/api/promo/redeem',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({code}),
      });
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) throw new Error(data.error||t('promoUnavailable')); 
      if(Number.isFinite(Number(data.balance))) updateBalance(Number(data.balance));
      if(data.referral){
        referralInvited=Number(data.referral.invitedCount||referralInvited||0);
        referralEarned=Number(data.referral.earned||referralEarned||0);
        updateReferralUI();
      }
      promoInput.value='';
      await Promise.all([refreshTop(),refreshReferral()]);
      tg?.showAlert?tg.showAlert(data.message||('+'+formatStars(data.reward)+' ⭐')):alert(data.message||('+'+formatStars(data.reward)+' ⭐'));
    }catch(err){
      tg?.showAlert?tg.showAlert(err.message):alert(err.message);
    }finally{
      promoBtn.disabled=false;
    }
  });

  // Bottom sheet (gifts)
  const sheetOverlay=document.getElementById('sheetOverlay');
  const sheet=document.getElementById('sheet');
  document.getElementById('slotMyGifts').addEventListener('click',()=>{
    if(upgradeSourceGift){
      upgradeSourceGift=null;
      upgradeTargetGift=null;
      renderUpgradeUI();
      return;
    }
    openSheet('upgrade-source');
  });
  document.getElementById('slotUpgradeGift').addEventListener('click',()=>{
    if(upgradeTargetGift){
      upgradeTargetGift=null;
      renderUpgradeUI();
      return;
    }
    if(!upgradeSourceGift) return;
    openSheet('upgrade-target');
  });
  document.getElementById('sheetClose').addEventListener('click',closeSheet);
  sheetOverlay.addEventListener('click',closeSheet);
  sheetGifts.addEventListener('click',e=>{
    const card=e.target.closest('.sheet-gift-card');
    if(!card || sheetMode==='inventory') return;
    sheetSelectedGiftId=String(card.dataset.id||'');
    renderSheetGifts();
  });
  sheetAddBtn.addEventListener('click',()=>{
    if(!sheetSelectedGiftId) return;
    const items=getSheetItems();
    const selected=items.find(item=>String(item._sheetId)===String(sheetSelectedGiftId));
    if(!selected) return;
    if(sheetMode==='upgrade-source'){
      upgradeSourceGift=normalizeInventoryGift(selected,selected.id||selected._sheetId);
      upgradeTargetGift=null;
    }else if(sheetMode==='upgrade-target'){
      upgradeTargetGift=normalizeCrashPrizeGift(selected)||selected;
      closeSheet();
      renderUpgradeUI();
      return;
    }
    closeSheet();
    renderUpgradeUI();
  });

  function openUpgradeResultModal(gift){
    if(!gift) return;
    playAppSound('reward');
    const normalized=normalizeCrashPrizeGift(gift);
    const image=resolveGiftImage(normalized);
    document.getElementById('upgradeModalPill').textContent=t('giftUnlocked');
    if(image){
      upgradeModalImage.src=image;
      upgradeModalImage.alt=normalized.name||'Gift';
    }else{
      upgradeModalImage.removeAttribute('src');
      upgradeModalImage.alt='';
    }
    upgradeModalName.textContent=normalized.name||'Gift';
    upgradeModalPrice.innerHTML=formatStars(normalized.price||0)+' <img src="assets/star.png" alt="">';
    upgradeModalOverlay.classList.add('open');
  }
  upgradeModalCloseBtn.addEventListener('click',()=>upgradeModalOverlay.classList.remove('open'));
  upgradeModalOverlay.addEventListener('click',e=>{if(e.target===upgradeModalOverlay) upgradeModalOverlay.classList.remove('open')});

  upgradeBtnEl.addEventListener('click',async()=>{
    if(upgradeSpinBusy||!upgradeSourceGift||!upgradeTargetGift) return;
    const chance=getUpgradeChance();
    if(!chance) return;
    upgradeSpinBusy=true;
    // Lock the visible sector BEFORE the request. During the spin it must never shrink/grow.
    upgradeBlueDegAnim+=1;
    setUpgradeRingBlue(Math.max(0.36,Math.min(359.64,(chance/100)*360)));
    renderUpgradeUI();
    // renderUpgradeUI may start a same-target fill animation; cancel it and lock again.
    upgradeBlueDegAnim+=1;
    setUpgradeRingBlue(Math.max(0.36,Math.min(359.64,(chance/100)*360)));
    playUpgradeRedo();
    try{
      const resp=await fetch(API_BASE+'/api/upgrade/spin',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({
          sourceGiftId:upgradeSourceGift.id,
          targetGiftId:upgradeTargetGift.giftId||upgradeTargetGift.id||'',
        }),
      });
      const data=await readApiJson(resp);
      if(!resp.ok) throw new Error(data.error||'Upgrade failed');
      const serverDisplayChance=Number(data.chance||chance);
      const isWin=!!data.isWin;
      // Инвентарь обновляем сразу после атомарного ответа, а не после 8-секундной анимации.
      const sourceId=String(upgradeSourceGift.id);
      inventoryItems=inventoryItems.filter(item=>String(item.id)!==sourceId);
      if(isWin&&data.wonGift){const won=normalizeInventoryGift(data.wonGift,data.wonGift.id||('upgrade_'+Date.now()));if(won)inventoryItems.unshift(won);}
      renderInventory();
      const landingAngle=((Number(data.landingAngle)||0)%360+360)%360;
      // TEST MATH MODE: keep the VISIBLE mathematical sector unchanged while spinning.
      // data.actualChance is server-only test probability and must not resize the wheel.
      const serverBlueDeg=Math.max(0.36,Math.min(359.64,Number(data.blueDeg||((serverDisplayChance/100)*360))));
      upgradeBlueDegAnim+=1;
      setUpgradeRingBlue(serverBlueDeg);
      const targetAbs=((getUpgradeBlueStartDeg(serverBlueDeg)+landingAngle)%360+360)%360;
      const currentMod=((upgradeWheelRotation%360)+360)%360;
      const delta=((targetAbs-currentMod)%360+360)%360;
      const finalRotation=upgradeWheelRotation + 360*8 + delta;
      await animateUpgradeRotation(finalRotation,8200);
      if(isWin && data.wonGift){
        openUpgradeResultModal(normalizeInventoryGift(data.wonGift,data.wonGift?.id||('upgrade_'+Date.now())));
      } else {
        tg?.showAlert?tg.showAlert(t('upgradeFailed')):alert(t('upgradeFailed')); 
      }
      renderInventory();
      upgradeSourceGift=null;
      upgradeTargetGift=null;
      upgradeSpinBusy=false;
      renderUpgradeUI();
    }catch(err){
      upgradeSpinBusy=false;
      renderUpgradeUI();
      tg?.showAlert?tg.showAlert(err.message):alert(err.message);
    }
  });

  // Bet sheet
  const betOverlay=document.getElementById('betOverlay');
  const betSheet=document.getElementById('betSheet');
  const betAmountInput=document.getElementById('betAmount');
  let activeBetMode='crash';
  function openBet(mode='crash'){
    if(mode==='pvp'&&!pvpCanAcceptBets())return;
    activeBetMode=mode;
    betSheetOpenedAt=Date.now();
    betAmountInput.value='';
    betOverlay.classList.add('open');betSheet.classList.add('open');
  }
  function closeBet(){betOverlay.classList.remove('open');betSheet.classList.remove('open')}
  let crashBetPressLockUntil=0;
  let crashBetLastPointerDownAt=0;
  let betSheetOpenedAt=0;
  function handleCrashBetPress(ev){
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    const now=Date.now();
    const phase=deriveCrashDisplayPhase(crashRealtimeState);

    if(ev?.type==='pointerdown'){
      crashBetLastPointerDownAt=now;
      if(crashBetActive){
        if(now<crashBetPressLockUntil)return;
        crashBetPressLockUntil=now+320;
        cashOut();
      }
      return;
    }
    if(now<crashBetPressLockUntil)return;
    crashBetPressLockUntil=now+320;
    if(crashBetActive){cashOut();return}
    if(crashPrizePending){return;}
    if(phase!=='countdown'){
      if(crashRealtimeState) refreshCrashState(true);
      return;
    }
    betSheetOpenedAt=Date.now();
    openBet();
  }
  const crashBetBtnEl=document.getElementById('crashBetBtn');
  crashBetBtnEl.addEventListener('pointerdown',handleCrashBetPress,{passive:false});
  crashBetBtnEl.addEventListener('click',handleCrashBetPress,{passive:false});
  document.getElementById('betClose').addEventListener('click',closeBet);
  betOverlay.addEventListener('click',e=>{ if(Date.now()-betSheetOpenedAt<250) return; closeBet(); });
  let crashBetSubmitLockUntil=0;
  function showBetError(message){
    try{tg?.HapticFeedback?.notificationOccurred?.('error');}catch(_){}
    try{tg?.showAlert?.(message);}catch(_){alert(message);}
  }
  let pvpBetSubmitBusy=false;
  async function submitPvpBet(amount){
    if(!pvpCanAcceptBets()){
      closeBet();
      showBetError('Ставки закрыты: таймер уже закончился');
      refreshPvpState();
      return;
    }
    if(amount<10){showBetError('Минимальная ставка 10⭐');return;}
    if(amount>balance){showBetError('Недостаточно Stars');return;}
    if(pvpBetSubmitBusy)return;
    pvpBetSubmitBusy=true;
    const balanceMutation=beginBalanceMutation();
    try{
      const response=await fetch(API_BASE+'/api/pvp/bet',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({amount}),
      });
      const data=await readApiJson(response);
      if(!response.ok)throw new Error(data.error||'PVP bet failed');
      if(Number.isFinite(Number(data.newBalance))&&canApplyBalanceMutation(balanceMutation)){updateBalance(Number(data.newBalance));saveProfileWarmState();}
      applyPvpState(data);
      dismissKeyboard(betAmountInput);
      closeBet();
      try{tg?.HapticFeedback?.notificationOccurred?.('success');}catch(_){}
    }catch(error){showBetError(error?.message||'PVP bet failed');}
    finally{pvpBetSubmitBusy=false;endBalanceMutation(balanceMutation);}
  }
  async function submitCrashBet(ev){
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    const now=Date.now();
    if(now<crashBetSubmitLockUntil)return;
    crashBetSubmitLockUntil=now+240;
    const v=parseInt(betAmountInput.value)||0;
    if(activeBetMode==='pvp'){submitPvpBet(v);return;}
    if(v<10){showBetError('Минимальная ставка 10⭐');return;}
    if(v>balance){showBetError('Недостаточно Stars');return;}
    dismissKeyboard(betAmountInput);
    closeBet();
    const prevValue=betAmountInput.value;
    betAmountInput.value='';
    const ok=await placeBet(v);
    if(!ok) betAmountInput.value=prevValue;
  }
  document.querySelectorAll('[data-bet-add]').forEach(button=>button.addEventListener('click',()=>{
    const add=Number(button.dataset.betAdd||0);
    betAmountInput.value=String(Math.max(0,Number(betAmountInput.value||0))+add);
  }));
  const betSubmitEl=document.getElementById('betSubmit');
  ['pointerdown','click'].forEach(evt=>betSubmitEl.addEventListener(evt,submitCrashBet,{passive:false}));

  // Settings modal
  const modalOverlay=document.getElementById('modalOverlay');
  function openModal(){modalOverlay.classList.add('open')}
  function closeModal(){modalOverlay.classList.remove('open')}
  document.getElementById('settingsBtn').addEventListener('click',openModal);
  modalOverlay.addEventListener('click',e=>{if(e.target===modalOverlay)closeModal()});

  document.getElementById('langCloud').addEventListener('click',()=>{
    document.getElementById('langWrap').classList.toggle('open');
    document.getElementById('langArrow').classList.toggle('down');
  });
  const langInd=document.getElementById('langIndicator');
  setLangIndicator(pendingLang);
  document.querySelectorAll('.lang-option').forEach(btn=>{
    btn.addEventListener('click',()=>{
      pendingLang=btn.dataset.lang;
      setLangIndicator(pendingLang);
    });
  });
  document.getElementById('supportRow').addEventListener('click',()=>{
    window.open('https://t.me/GiftPepeSupport','_blank');
  });
  document.getElementById('modalSave').addEventListener('click',()=>{applyLanguage(pendingLang);closeModal();});

  // Topup sheet
  const topupOverlay=document.getElementById('topupOverlay');
  const topupSheet=document.getElementById('topupSheet');
  const topupAmount=document.getElementById('topupAmount');
  const topupSubmit=document.getElementById('topupSubmit');
  const topupWalletDisconnect=document.getElementById('topupWalletDisconnect');

  function openTopup(){
    syncTopupModeUI();
    topupOverlay.classList.add('open');
    topupSheet.classList.add('open');
    if(topupMode==='ton'){
      ensureTonConnect().then(()=>{syncTopupWalletUI();syncTopupSubmitLabel();}).catch(()=>{});
    }
    setTimeout(()=>{syncTopupWalletUI();syncTopupSubmitLabel();syncTopupModeIndicator();},80);
  }
  function closeTopup(){topupOverlay.classList.remove('open');topupSheet.classList.remove('open')}

  document.getElementById('addBtn').addEventListener('click',openTopup);
  document.getElementById('topupClose').addEventListener('click',closeTopup);
  topupOverlay.addEventListener('click',closeTopup);

  document.querySelectorAll('.topup-block').forEach(block=>{
    block.addEventListener('click',()=>{
      topupMode=block.dataset.type==='ton' ? 'ton' : 'stars';
      syncTopupModeUI();
    });
  });

  window.addEventListener('resize',()=>{try{syncTopupModeIndicator();}catch(e){}});
  topupAmount.addEventListener('input',syncTopupSubmitLabel);
  topupWalletDisconnect?.addEventListener('click',async(e)=>{e.preventDefault();await disconnectTonWallet();});

  topupSubmit.addEventListener('click',async()=>{
    if(topupMode==='ton'){
      await sendTonTopup();
      return;
    }
    const starsValue=getTopupStarsValue();
    if(starsValue<=0)return;
    if(!tg?.openInvoice){
      tg?.showAlert?tg.showAlert(t('openTelegramPay')):alert(t('openTelegramPay')); 
      return;
    }
    topupSubmit.disabled=true;
    topupSubmit.innerHTML=t('creatingInvoice');
    try{
      const resp=await fetch(API_BASE+'/api/invoice',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({initData:tg.initData||'',amount:starsValue}),
      });
      const {invoiceLink,invoiceId,error}=await resp.json();
      if(error)throw new Error(error);
      const balanceBefore=balance;
      topupSubmit.innerHTML=t('openingPayment');
      tg.openInvoice(invoiceLink,async(status)=>{
        if(status==='paid'){
          applyOptimisticDeposit(starsValue);
          topupAmount.value='';
          syncTopupModeUI();
          closeTopup();
          topupSubmit.innerHTML=t('checkingPayment');
          const applied=await waitForPaymentApply(invoiceId,balanceBefore,starsValue,10000);
          if(applied){
            topupAmount.value='';
            syncTopupModeUI();
            closeTopup();
          }else{
            tg?.showAlert?tg.showAlert(t('paymentDelayed')):alert(t('paymentDelayed')); 
          }
          topupSubmit.disabled=false;
          syncTopupSubmitLabel();
        }else if(status==='failed'){
          topupSubmit.disabled=false;
          syncTopupSubmitLabel();
          tg.showAlert?.(t('paymentFailed')); 
        }else if(status==='cancelled'){
          topupSubmit.disabled=false;
          syncTopupSubmitLabel();
          tg.showAlert?.(t('paymentCancelled')); 
        }
      });
    }catch(e){
      console.error('Invoice error:',e);
      topupSubmit.disabled=false;
      syncTopupSubmitLabel();
      tg?.showAlert?tg.showAlert(t('errorPrefix')+e.message):alert(t('errorPrefix')+e.message); 
    }
  });

  syncTopupModeUI();
  applyLanguage(currentLang);
  bootstrapApp();
  updateLottiePerformance();

  // Не опрашиваем сервер каждые 5 секунд на любой вкладке. Инвентарь и рефералы
  // нужны только в профиле; каждые 30 секунд достаточно для фоновой синхронизации.
  setInterval(()=>{
    if(!tg?.initData||document.hidden||currentTab!=='profile') return;
    refreshReferral();
    refreshInventory();
  },30000);

  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState!=='visible'){
      closeSheet();
      closeCrashResultSheet();
      pauseCrashRound();

      if(!crashPrizePending&&!crashCashoutBusy&&(crashResultState==='loss'||crashBetSettled)){
        resetCrashPlayer();
      }
      return;
    }

    // Android/Telegram may suspend fetch/timers. Возобновляем только данные
    // активной вкладки, чтобы возвращение в приложение не запускало лишние запросы.
    refreshBalance();
    if(currentTab==='crash'){
      crashStarted=true;
      runCrashRound();
    }else if(currentTab==='top'){
      refreshTop(true);
    }else if(currentTab==='profile'){
      refreshReferral(true);
      setTimeout(()=>refreshInventory(true),180);
    }
  });

  // ─── BACKEND HELPERS ─────────────────────────────────────────────────────────
  async function refreshBalance(){
    if(!tg?.initData)return null;
    // Снимок версии берётся до запроса. Если за время сети прошла продажа,
    // ставка или выплата, ответ относится к старому балансу и отбрасывается.
    const requestRevision=getBalanceRefreshRevision();
    try{
      const resp=await fetch(API_BASE+'/api/balance?ts='+Date.now(),{headers:{'x-init-data':tg.initData}});
      const data=await resp.json();
      if(data.balance!==undefined&&canApplyBalanceRefresh(requestRevision)){
        updateBalance(data.balance);
        saveProfileWarmState();
        return data;
      }
    }catch(e){console.warn('Balance refresh failed:',e.message)}
    return null;
  }

  async function waitForPaymentApply(invoiceId,previousBalance,starsValue,timeoutMs=10000){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      try{
        const resp=await fetch(API_BASE+'/api/payment-status?invoiceId='+encodeURIComponent(invoiceId),{
          headers:{'x-init-data':tg?.initData||''}
        });
        const data=await resp.json();
        if(resp.ok&&data.applied){
          if(Number.isFinite(Number(data.balance))) updateBalance(Number(data.balance));
          if(data.referral){
            referralInvited=Number(data.referral.invitedCount||referralInvited||0);
            referralEarned=Number(data.referral.earned||referralEarned||0);
            updateReferralUI();
          }
          await Promise.all([refreshBalance(),refreshTop(true),refreshReferral(true)]);
          return true;
        }
      }catch(e){}
      await new Promise(r=>setTimeout(r,500));
    }
    await Promise.all([refreshBalance(),refreshTop(true),refreshReferral(true)]);
    return Number(balance)>=Number(previousBalance)+Number(starsValue||0);
  }

  async function refreshInventory(force=false){
    if(!tg?.initData)return null;
    if(upgradeSpinBusy)return {items:inventoryItems};
    if(inventoryRefreshInFlight)return inventoryRefreshInFlight;
    if(!force&&(currentTab!=='profile'||Date.now()-lastInventoryRefreshAt<25000)) return {items:inventoryItems,cached:true};

    inventoryRefreshInFlight=(async()=>{
      try{
        const prevCount=Array.isArray(inventoryItems)?inventoryItems.length:0;
        const resp=await fetch(API_BASE+'/api/inventory',{headers:{'x-init-data':tg.initData}});
        const data=await resp.json();
        if(resp.ok){
          const nextItems=Array.isArray(data.items)?data.items.map(item=>normalizeInventoryGift(item)).filter(Boolean):[];
          const changed=makeInventorySnapshot(nextItems)!==inventorySnapshotKey;
          inventoryItems=nextItems;
          lastInventoryRefreshAt=Date.now();
          if(changed) renderInventory();
          // Если в инвентаре появились новые подарки, обновляем связанные данные один раз.
          if(nextItems.length>prevCount){
            refreshTop(true).catch(()=>{});
            refreshBalance().catch(()=>{});
          }
          saveProfileWarmState();
          if(data.pendingPrize&&!crashPrizeResolveBusy){
            enterPendingCrashPrize(data.pendingPrize,crashSettledPayout,crashBetAmount,{autoOpen:false});
          }else if(crashPrizePending&&!crashBetActive&&!crashPrizeResolveBusy){
            hideCrashPrize();
            crashPrizePending=false;
            crashPrizeGift=null;
            crashPrizeModalAutoKey='';
          }
          return data;
        }
      }catch(e){console.warn('Inventory refresh failed:',e.message)}
      return null;
    })().finally(()=>{inventoryRefreshInFlight=null;});
    return inventoryRefreshInFlight;
  }

  async function refreshReferral(force=false){
    if(!tg?.initData)return null;
    if(referralRefreshInFlight)return referralRefreshInFlight;
    if(!force&&(currentTab!=='profile'||Date.now()-lastReferralRefreshAt<25000)) return null;

    referralRefreshInFlight=(async()=>{
      try{
        const resp=await fetch(API_BASE+'/api/referral',{headers:{'x-init-data':tg.initData}});
        const data=await resp.json();
        if(resp.ok){
          referralInvited=Number(data.invitedCount||0);
          referralEarned=Number(data.earned||0);
          referralCode=String(data.referrerLink||referralCode||'');
          lastReferralRefreshAt=Date.now();
          updateReferralUI();
          saveProfileWarmState();
          return data;
        }
      }catch(e){console.warn('Referral refresh failed:',e.message)}
      return null;
    })().finally(()=>{referralRefreshInFlight=null;});
    return referralRefreshInFlight;
  }

  async function refreshTop(force=false){
    const mode=topMode==='referrals'?'referrals':'deposits';
    if(topRefreshInFlight[mode]) return topRefreshInFlight[mode];
    if(!force&&Date.now()-Number(topRefreshedAt[mode]||0)<10000){
      return mode==='referrals'?referralTopCache:topCache;
    }

    topRefreshInFlight[mode]=(async()=>{
      try{
        const params=new URLSearchParams({mode,ts:String(Date.now())});
        if(tgUserId)params.set('userId',String(tgUserId));
        const resp=await fetch(API_BASE+'/api/top?'+params.toString(),{cache:'no-store'});
        const data=await readApiJson(resp);
        if(!resp.ok)throw new Error(data.error||'Top failed');
        const leaders=Array.isArray(data.leaders)?data.leaders:[];
        const myRank=data.myRank??null;
        const myScore=Number(data.myScore||0);
        if(mode==='referrals')referralTopCache={leaders,myRank,myScore};
        else topCache={leaders,myRank,myScore};
        topRefreshedAt[mode]=Date.now();
        if(mode===topMode)renderTop(leaders,myRank,myScore);
        return {leaders,myRank,myScore};
      }catch(e){
        console.warn('Top refresh failed:',e.message);
        return null;
      }finally{
        topRefreshInFlight[mode]=null;
      }
    })();
    return topRefreshInFlight[mode];
  }

  function syncTopModeUI(){
    const cloud=document.getElementById('topModeCloud');
    cloud?.classList.toggle('referrals',topMode==='referrals');
    document.querySelectorAll('[data-top-mode]').forEach(btn=>{
      btn.classList.toggle('active',btn.dataset.topMode===topMode);
    });
    const dep=document.getElementById('topModeDeposits');
    const ref=document.getElementById('topModeReferrals');
    if(dep)dep.textContent=currentLang==='en'?'Deposits':'Депозиты';
    if(ref)ref.textContent=currentLang==='en'?'Referrals':'Рефералы';
  }

  function setTopMode(mode){
    const next=mode==='referrals'?'referrals':'deposits';
    if(topMode===next){refreshTop();return;}
    topMode=next;
    syncTopModeUI();
    const cache=topMode==='referrals'?referralTopCache:topCache;
    renderTop(cache.leaders||[],cache.myRank??null,Number(cache.myScore||0));
    refreshTop(true);
  }

  document.querySelectorAll('[data-top-mode]').forEach(btn=>{
    btn.addEventListener('click',()=>setTopMode(btn.dataset.topMode));
  });
  syncTopModeUI();

  // === Цикл топа: 7 дней, синее облако с обратным отсчётом ===
  let topCycleEndsAt=0;
  let topCycleTimer=null;
  function fmtCycleTime(ms){
    const total=Math.max(0,Math.ceil(ms/1000));
    const d=Math.floor(total/86400);
    const h=Math.floor((total%86400)/3600);
    const m=Math.floor((total%3600)/60);
    const s=total%60;
    return d+'д'+h+'ч'+m+'м'+s+'с';
  }
  async function refreshTopCycle(){
    try{
      const r=await fetch(API_BASE+'/api/top/cycle?ts='+Date.now(),{cache:'no-store'});
      const d=await r.json().catch(()=>({}));
      const ends=Number(d&&d.endsAt||0);
      if(Number.isFinite(ends)&&ends>0) topCycleEndsAt=ends;
    }catch(e){}
  }
  function startTopCycleTicker(){
    const el=document.getElementById('topTimerText');
    if(!el) return;
    if(topCycleTimer) return;
    let prevWasPositive=true;
    topCycleTimer=setInterval(()=>{
      if(document.hidden) return;
      const left=topCycleEndsAt-Date.now();
      el.textContent=fmtCycleTime(left);
      if(left<=0 && prevWasPositive){
        prevWasPositive=false;
        // Цикл закончился — обновляем endsAt с сервера и перерисовываем топ.
        refreshTopCycle().then(()=>{ prevWasPositive=true; refreshTop(); });
      }
    },1000);
  }
  refreshTopCycle().then(startTopCycleTicker);

  function renderTop(leaders,myRank,myScore=0){
    leaders=Array.isArray(leaders)?leaders:[];
    const isRefs=topMode==='referrals';
    const placeText=document.querySelector('#topPage .top-place-text');
    if(placeText) placeText.innerHTML=myRank ? t('topPlaceAt').replace('{rank}',myRank) : t('topNotYet');

    const scoreOf=(entry)=>isRefs?Number(entry?.invited_count||0):Number(entry?.total_deposited||0);
    const scoreHtml=(value)=>{
      if(isRefs)return '<span class="top-score-value">'+formatStars(value)+' <span aria-hidden="true">👥</span></span>';
      return '<span class="top-score-value">'+formatStars(value)+' <img src="assets/star.png" alt=""></span>';
    };
    const rewards=isRefs?TOP_REFERRAL_REWARD_GIFTS:TOP_DEPOSIT_REWARD_GIFTS;

    const myEntry=leaders.find(l=>String(l.id)===String(tgUserId));
    document.querySelector('.top-my-rank').textContent=myRank||'—';
    document.querySelector('.top-my-score').innerHTML=scoreHtml(myEntry?scoreOf(myEntry):Number(myScore||0));

    const rankClasses=['gold','silver','bronze'];
    const rows=document.querySelectorAll('#topPage .top-row');
    rows.forEach((row,i)=>{
      const leader=leaders[i];
      const rankEl=row.querySelector('.top-rank');
      rankEl.textContent=leader?i+1:'—';
      rankEl.className='top-rank'+(leader&&rankClasses[i]?' '+rankClasses[i]:'');
      const nameEl=row.querySelector('.top-name');
      row.querySelector('.top-gift-badge-wrap')?.remove();

      if(!leader){
        nameEl.textContent='—';
        nameEl.dataset.locked='false';
        row.querySelector('.top-score').innerHTML=scoreHtml(0);
        const avatar=row.querySelector('.top-avatar');
        if(avatar?.tagName==='IMG')avatar.removeAttribute('src');
        return;
      }

      nameEl.textContent=leader.first_name||'User';
      nameEl.dataset.locked='true';
      row.querySelector('.top-score').innerHTML=scoreHtml(scoreOf(leader));

      const rewardGift=rewards[i]||null;
      if(rewardGift?.image){
        const wrap=document.createElement('div');
        wrap.className='top-gift-badge-wrap';
        wrap.title=rewardGift.name||'Gift';
        const badge=document.createElement('img');
        badge.className='top-gift-badge';
        badge.src=rewardGift.image;
        badge.alt=rewardGift.name||'Gift';
        wrap.appendChild(badge);
        row.appendChild(wrap);
      }

      let avatarEl=row.querySelector('.top-avatar');
      if(leader.photo_url){
        if(avatarEl.tagName==='DIV'){
          const img=document.createElement('img');
          img.className='top-avatar';img.alt='';
          avatarEl.replaceWith(img);avatarEl=img;
        }
        avatarEl.src=leader.photo_url;
      }else if(avatarEl?.tagName==='IMG'){
        avatarEl.removeAttribute('src');
      }
    });
  }



  // ════════════════════ АДМИНКА ════════════════════
  let adminAccessCheckInFlight=false;
  let adminAccessRetryTimer=null;
  let adminAccessRetryMs=5000;

  function verifyAdminAccess(btn){
    if(!btn||adminAccessCheckInFlight)return;
    adminAccessCheckInFlight=true;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),5000);
    fetch(API_BASE+'/api/admin/me',{headers:{'x-init-data':tg?.initData||''},signal:controller.signal})
      .then(async r=>{
        const body=await readApiJson(r);
        if(!r.ok)throw new Error(body.error||'Admin check failed');
        return body;
      })
      .then(j=>{
        if(j?.isAdmin){
          btn.style.display='flex';
          adminAccessRetryMs=5000;
        }else{
          // Сервер ответил успешно: пользователь действительно не администратор.
          btn.style.display='none';
          if(adminAccessRetryTimer){clearTimeout(adminAccessRetryTimer);adminAccessRetryTimer=null;}
        }
      })
      .catch(()=>{
        // При 5xx/сетевом сбое не считаем администратора обычным пользователем.
        // Повторная проверка вернёт панель сразу после восстановления API.
        if(!tg?.initData||document.visibilityState!=='visible')return;
        if(adminAccessRetryTimer)clearTimeout(adminAccessRetryTimer);
        const delay=adminAccessRetryMs;
        adminAccessRetryMs=Math.min(adminAccessRetryMs*2,45000);
        adminAccessRetryTimer=setTimeout(()=>{
          adminAccessRetryTimer=null;
          verifyAdminAccess(btn);
        },delay);
      })
      .finally(()=>{clearTimeout(timeout);adminAccessCheckInFlight=false;});
  }

  function initAdmin(){
    const btn=document.getElementById('adminPanelBtn');
    if(!btn) return;
    const overlay=document.getElementById('adminOverlay');
    if(!overlay){
      // DOM ещё не готов (overlay объявлен ниже в HTML) — повторим чуть позже.
      setTimeout(initAdmin, 50);
      return;
    }
    const tabs=overlay?.querySelectorAll('.admin-tab')||[];
    const sections=overlay?.querySelectorAll('.admin-section')||[];
    verifyAdminAccess(btn);

    // initAdmin вызывается после первого экрана bootstrapApp; обработчики вешаем строго один раз.
    if(btn.dataset.adminBound==='1')return;
    btn.dataset.adminBound='1';

    btn.addEventListener('click',()=>{
      overlay.classList.add('open');
      loadPolicy();
      buildGiftSelect();
      loadAdminPromos();
      loadAdminStats();
    });
    overlay?.querySelector('.admin-close')?.addEventListener('click',()=>overlay.classList.remove('open'));
    overlay?.addEventListener('click',e=>{ if(e.target===overlay) overlay.classList.remove('open'); });

    tabs.forEach(t=>t.addEventListener('click',()=>{
      tabs.forEach(x=>x.classList.remove('active'));
      sections.forEach(s=>s.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('adminSec_'+t.dataset.tab)?.classList.add('active');
    }));

    // ───── PROMO ─────
    const promoCode=document.getElementById('adm_promoCode');
    const promoMax=document.getElementById('adm_promoMax');
    const promoStars=document.getElementById('adm_promoReward');
    const promoGift=document.getElementById('adm_promoGift');
    const promoTypeBtns=overlay?.querySelectorAll('[data-promotype]')||[];
    const promoStarsBlock=document.getElementById('adm_promoStarsBlock');
    const promoGiftBlock=document.getElementById('adm_promoGiftBlock');
    const promoMsg=document.getElementById('adm_promoMsg');

    let promoType='stars';
    function setPromoType(t){
      promoType=t;
      promoTypeBtns.forEach(b=>b.classList.toggle('active',b.dataset.promotype===t));
      promoStarsBlock.style.display = t==='stars'?'block':'none';
      promoGiftBlock.style.display  = t==='gift' ?'block':'none';
    }
    promoTypeBtns.forEach(b=>b.addEventListener('click',()=>setPromoType(b.dataset.promotype)));
    setPromoType('stars');

    function buildGiftSelect(){
      if(!promoGift||promoGift.options.length>0) return;
      const sorted=[...GIFT_CATALOG].sort((a,b)=>(a.price||0)-(b.price||0));
      const frag=document.createDocumentFragment();
      for(const g of sorted){
        const opt=document.createElement('option');
        opt.value=String(g.id||'');
        opt.textContent=`${g.name} — ${g.price}⭐`;
        frag.appendChild(opt);
      }
      promoGift.appendChild(frag);
    }

    document.getElementById('adm_promoCreate').addEventListener('click',async()=>{
      promoMsg.classList.remove('err'); promoMsg.textContent='Создаём…';
      const body={
        code:(promoCode.value||'').trim(),
        maxUses:Number(promoMax.value||1),
      };
      if(promoType==='gift') body.giftId=promoGift.value;
      else body.reward=Number(promoStars.value||0);
      try{
        const r=await fetch(API_BASE+'/api/admin/promo/create',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify(body),
        });
        const j=await r.json();
        if(!r.ok) throw new Error(j.error||'fail');
        promoMsg.textContent=`✅ Создан промокод ${j.code}` + (j.gift?` (подарок «${j.gift.name}»)`:` (+${j.reward}⭐)`) + `, использований: ${j.maxUses}`;
        promoCode.value=''; promoStars.value=''; loadAdminPromos();
      }catch(e){
        promoMsg.classList.add('err'); promoMsg.textContent='❌ '+(e.message||'Ошибка');
      }
    });

    // ───── ANALYTICS / PEOPLE ─────
    const promoTable=document.getElementById('adm_promoTable');
    const promoSummary=document.getElementById('adm_promoSummary');
    const promoRefresh=document.getElementById('adm_promoRefresh');
    const statsCards=document.getElementById('adm_statsCards');
    const statsMsg=document.getElementById('adm_statsMsg');
    const statsRefresh=document.getElementById('adm_statsRefresh');
    const peopleExport=document.getElementById('adm_peopleExport');
    const peopleMsg=document.getElementById('adm_peopleMsg');
    const sendGiftUserId=document.getElementById('adm_sendGiftUserId');
    const sendGiftId=document.getElementById('adm_sendGiftId');
    const sendGiftText=document.getElementById('adm_sendGiftText');
    const sendGiftBtn=document.getElementById('adm_sendGiftBtn');
    const sendGiftMsg=document.getElementById('adm_sendGiftMsg');
    let statsDays=30;

    async function adminJson(url, options={}){
      const response=await fetch(API_BASE+url, { ...options, headers:{'Content-Type':'application/json','x-init-data':tg?.initData||'',...(options.headers||{})} });
      const data=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error||'Ошибка запроса');
      return data;
    }
    function formatAdminDate(value){
      if(!value)return '—';
      const d=new Date(value); return Number.isNaN(d.getTime())?'—':d.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'});
    }
    function loadAdminPromos(){
      if(!promoTable)return;
      adminJson('/api/admin/promo/list').then(data=>{
        promoTable.textContent='';
        const items=Array.isArray(data.items)?data.items:[];
        let activations=0,totalReward=0;
        items.forEach(item=>{
          activations+=Number(item.activations||0); totalReward+=Number(item.totalReward||0);
          const tr=document.createElement('tr');
          const cells=[
            String(item.code||'—'),
            item.rewardKind==='gift' ? `🎁 ${item.gift?.name||item.reward_gift_id||'подарок'}` : `⭐ ${Number(item.reward||0)}`,
            `${Number(item.activations||0)} / ${Number(item.max_uses_per_user||0)} всего`,
            `${Number(item.totalReward||0)}⭐`,
            formatAdminDate(item.lastActivatedAt),
          ];
          cells.forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.appendChild(td)});
          const action=document.createElement('td');
          const del=document.createElement('button');del.type='button';del.textContent='Удалить';
          del.addEventListener('click',async()=>{
            if(!confirm(`Удалить промокод ${item.code}?`))return;
            try{await adminJson('/api/admin/promo/delete',{method:'POST',body:JSON.stringify({code:item.code})});loadAdminPromos();}
            catch(e){promoSummary.textContent='❌ '+e.message}
          });
          action.appendChild(del);tr.appendChild(action);promoTable.appendChild(tr);
        });
        promoSummary.textContent=`Всего кодов: ${items.length} · активаций: ${activations} · выдано по аналитике: ${totalReward}⭐`;
      }).catch(e=>{promoSummary.textContent='❌ '+e.message});
    }
    function drawAdminChart(rows){
      const canvas=document.getElementById('adm_activityChart'); if(!canvas)return;
      const ctx=canvas.getContext('2d'), width=canvas.width, height=canvas.height;
      ctx.clearRect(0,0,width,height); ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1;
      for(let i=1;i<4;i++){const y=(height-20)*i/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke()}
      if(!rows.length)return;
      const max=Math.max(1,...rows.map(x=>Number(x.activity||0))), pad=12, plotH=height-30, step=rows.length>1?(width-pad*2)/(rows.length-1):width;
      ctx.beginPath(); rows.forEach((row,i)=>{const x=pad+i*step,y=height-12-(Number(row.activity||0)/max)*plotH;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle='#0A84FF';ctx.lineWidth=3;ctx.stroke();
      rows.forEach((row,i)=>{const x=pad+i*step,y=height-12-(Number(row.activity||0)/max)*plotH;ctx.fillStyle='#34C759';ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill()});
      document.getElementById('adm_chartFrom').textContent=rows[0].date||'—';document.getElementById('adm_chartTo').textContent=rows[rows.length-1].date||'—';
    }
    function loadAdminStats(){
      if(!statsCards)return;
      statsMsg.textContent='Загружаем…';
      adminJson(`/api/admin/stats/overview?days=${statsDays}`).then(data=>{
        const t=data.totals||{};
        const cards=[['Люди всего',t.users||0],['Подарки в инв.',t.gifts||0],['Депозиты за период',t.deposits||0],['Звёзды за период',`${t.depositStars||0}⭐`],['Crash-игры',t.crashBets||0],['Рефералы',t.referrals||0],['Баланс пользователей',`${t.allTimeBalance||0}⭐`],['Депозиты всего в TOP',`${t.allTimeDeposits||0}⭐`]];
        statsCards.textContent='';cards.forEach(([label,value])=>{const box=document.createElement('div');box.className='admin-stat-card';box.innerHTML=`<div class="admin-stat-label"></div><div class="admin-stat-value"></div>`;box.querySelector('.admin-stat-label').textContent=label;box.querySelector('.admin-stat-value').textContent=String(value);statsCards.appendChild(box)});
        drawAdminChart(Array.isArray(data.daily)?data.daily:[]);statsMsg.textContent=`Период: ${statsDays} дней. График строится по регистрациям, депозитам, Crash-играм и рефералам.`;
      }).catch(e=>{statsMsg.textContent='❌ '+e.message});
    }
    document.querySelectorAll('[data-statsdays]').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('[data-statsdays]').forEach(x=>x.classList.remove('active'));btn.classList.add('active');statsDays=Number(btn.dataset.statsdays||30);loadAdminStats()}));
    promoRefresh?.addEventListener('click',loadAdminPromos);statsRefresh?.addEventListener('click',loadAdminStats);
    peopleExport?.addEventListener('click',async()=>{peopleMsg.classList.remove('err');peopleMsg.textContent='Формируем и отправляем TXT…';peopleExport.disabled=true;try{const result=await adminJson('/api/admin/users/export',{method:'POST',body:'{}'});peopleMsg.textContent=`✅ Файл ${result.filename} отправлен в Telegram-бота.`}catch(e){peopleMsg.classList.add('err');peopleMsg.textContent='❌ '+e.message}finally{peopleExport.disabled=false}});
    sendGiftBtn?.addEventListener('click',async()=>{
      sendGiftMsg.classList.remove('err');
      const userId=Number(sendGiftUserId.value||0), giftId=(sendGiftId.value||'').trim(), text=(sendGiftText.value||'').trim();
      if(!userId){sendGiftMsg.classList.add('err');sendGiftMsg.textContent='❌ Введите Telegram User ID';return}
      if(!giftId){sendGiftMsg.classList.add('err');sendGiftMsg.textContent='❌ Введите Telegram Gift ID';return}
      if(text.length>128){sendGiftMsg.classList.add('err');sendGiftMsg.textContent='❌ Описание не длиннее 128 символов';return}
      sendGiftBtn.disabled=true;sendGiftMsg.textContent='Отправляем подарок…';
      try{
        const result=await adminJson('/api/admin/gift/send',{method:'POST',body:JSON.stringify({userId,giftId,text})});
        sendGiftMsg.textContent=`✅ Подарок ${result.giftId} отправлен пользователю ${result.recipient||result.userId}`;
        sendGiftId.value='';sendGiftText.value='';
      }catch(e){sendGiftMsg.classList.add('err');sendGiftMsg.textContent='❌ '+e.message}
      finally{sendGiftBtn.disabled=false}
    });

    // ───── BALANCE ─────
    const balUid=document.getElementById('adm_balUid');
    const balAmt=document.getElementById('adm_balAmt');
    const balMsg=document.getElementById('adm_balMsg');
    document.getElementById('adm_balGrant').addEventListener('click',async()=>{
      balMsg.classList.remove('err'); balMsg.textContent='Зачисляем…';
      try{
        const r=await fetch(API_BASE+'/api/admin/balance/grant',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify({userId:Number(balUid.value||0),amount:Number(balAmt.value||0)}),
        });
        const j=await r.json();
        if(!r.ok) throw new Error(j.error||'fail');
        balMsg.textContent=`✅ Юзер ${j.userId}: ${j.granted>0?'+':''}${j.granted}⭐ → баланс ${j.balance}⭐`;
        balAmt.value='';
      }catch(e){
        balMsg.classList.add('err'); balMsg.textContent='❌ '+(e.message||'Ошибка');
      }
    });

    // ───── TOP ─────
    const topChoices=overlay?.querySelectorAll('[data-topmode]')||[];
    const topUid=document.getElementById('adm_topUid');
    const topAmt=document.getElementById('adm_topAmount');
    const topMsg=document.getElementById('adm_topMsg');
    const topAmountLabel=document.getElementById('adm_topAmountLabel');
    const topHint=document.getElementById('adm_topHint');
    let topMode='deposits';

    function setTopMode(mode){
      topMode=mode==='referrals'?'referrals':'deposits';
      topChoices.forEach(c=>c.classList.toggle('active',c.dataset.topmode===topMode));
      if(topAmountLabel){
        topAmountLabel.textContent=topMode==='referrals'
          ? 'Сколько рефералов добавить в топ'
          : 'Сколько добавить в депозитный топ';
      }
      if(topHint){
        topHint.textContent=topMode==='referrals'
          ? 'Рефералы: очки прибавятся к реальным приглашениям в основном TOP и будут учитываться при выдаче наград.'
          : 'Депозит: значение прибавится прямо к total_deposited пользователя и сразу изменит основной TOP.';
      }
      if(topAmt) topAmt.placeholder=topMode==='referrals'?'5':'1000';
    }
    topChoices.forEach(c=>c.addEventListener('click',()=>setTopMode(c.dataset.topmode)));
    setTopMode('deposits');

    document.getElementById('adm_topAdd').addEventListener('click',async()=>{
      topMsg.classList.remove('err');
      const userId=Number(topUid.value||0);
      const amount=Math.floor(Number(topAmt.value||0));
      if(!userId){ topMsg.classList.add('err'); topMsg.textContent='❌ Введите Telegram User ID'; return; }
      if(!amount||amount<1){ topMsg.classList.add('err'); topMsg.textContent='❌ Введите количество больше 0'; return; }
      topMsg.textContent='Добавляем…';
      try{
        const r=await fetch(API_BASE+'/api/admin/top/add',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify({userId,mode:topMode,amount}),
        });
        const j=await r.json();
        if(!r.ok) throw new Error(j.error||'fail');
        const unit=topMode==='referrals'?'реф.':'⭐';
        const rank=j.rank?` · место #${j.rank}`:'';
        topMsg.textContent=`✅ ID ${j.userId}: +${j.added} ${unit} → ${j.score} ${unit}${rank}`;
        topAmt.value='';
        // Если TOP уже открыт на экране, обновим его без перезапуска Mini App.
        try{ refreshTop(); }catch{}
      }catch(e){
        topMsg.classList.add('err'); topMsg.textContent='❌ '+(e.message||'Ошибка');
      }
    });

    // ───── WITHDRAW POLICY ─────
    const polChoices=overlay?.querySelectorAll('[data-pol]')||[];
    const polUidRow=document.getElementById('adm_polUidRow');
    const polUid=document.getElementById('adm_polUid');
    const polMsg=document.getElementById('adm_polMsg');
    let polMode='none';

    function setPolMode(m){
      polMode=m;
      polChoices.forEach(c=>c.classList.toggle('active',c.dataset.pol===m));
      polUidRow.style.display = m==='user' ? 'block' : 'none';
    }
    polChoices.forEach(c=>c.addEventListener('click',()=>setPolMode(c.dataset.pol)));

    async function loadPolicy(){
      polMsg.textContent='';
      try{
        const r=await fetch(API_BASE+'/api/admin/withdraw-policy',{headers:{'x-init-data':tg?.initData||''}});
        if(!r.ok) return;
        const j=await r.json();
        setPolMode(j.mode||'none');
        polUid.value=(j.userIds||[]).join(',');
      }catch{}
    }
    document.getElementById('adm_polSave').addEventListener('click',async()=>{
      polMsg.classList.remove('err'); polMsg.textContent='Сохраняем…';
      const body={mode:polMode};
      if(polMode==='user'){
        body.userIds=(polUid.value||'').split(',').map(s=>Number(String(s).trim())).filter(Boolean);
      }
      try{
        const r=await fetch(API_BASE+'/api/admin/withdraw-policy',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify(body),
        });
        const j=await r.json();
        if(!r.ok) throw new Error(j.error||'fail');
        const txt=({all:'🚫 Запрещён ВСЕМ',user:`🚫 Запрещён юзерам: ${(j.policy.userIds||[]).join(', ')}`,none:'✅ Вывод разрешён всем'})[j.policy.mode];
        polMsg.textContent=txt;
      }catch(e){
        polMsg.classList.add('err'); polMsg.textContent='❌ '+(e.message||'Ошибка');
      }
    });
    // ───── NFT MANAGEMENT ─────
    const giftUid=document.getElementById('adm_giftUserId');
    const giftsLoad=document.getElementById('adm_giftsLoad');
    const giftsTable=document.getElementById('adm_giftsTable');
    const giftsMsg=document.getElementById('adm_giftsMsg');
    async function loadAdminUserGifts(){
      const userId=Number(giftUid?.value||0); if(!userId){giftsMsg.textContent='Введите User ID';return;}
      giftsMsg.textContent='Загрузка…';giftsTable.replaceChildren();
      try{const r=await fetch(API_BASE+'/api/admin/user-gifts?userId='+encodeURIComponent(userId),{headers:{'x-init-data':tg?.initData||''}});const data=await r.json();if(!r.ok)throw new Error(data.error||'Не удалось загрузить NFT');
        for(const gift of (data.items||[])){const tr=document.createElement('tr');
          for(const value of [gift.id,gift.gift_name||gift.gift_id,Number(gift.gift_price||0)+' ⭐']){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}
          const td=document.createElement('td');const btn=document.createElement('button');btn.textContent='Удалить';btn.addEventListener('click',async()=>{if(userId===8411885533){giftsMsg.textContent='Защищённый пользователь';return;}if(!confirm('Удалить этот NFT?'))return;btn.disabled=true;try{const rr=await fetch(API_BASE+'/api/admin/gift/delete',{method:'POST',headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},body:JSON.stringify({userId,giftId:Number(gift.id)})});const jj=await rr.json();if(!rr.ok)throw new Error(jj.error||'Удаление не удалось');await loadAdminUserGifts();}catch(e){giftsMsg.textContent='❌ '+e.message;btn.disabled=false;}});td.append(btn);tr.append(td);giftsTable.append(tr);
        }
        giftsMsg.textContent=(data.items||[]).length?'':'У пользователя NFT нет';
      }catch(e){giftsMsg.textContent='❌ '+e.message;}
    }
    giftsLoad?.addEventListener('click',loadAdminUserGifts);
  }
  // Админская проверка запускается bootstrapApp только после первого отображения UI.
  // Не добавляем её в очередь запуска Crash/PVP.
