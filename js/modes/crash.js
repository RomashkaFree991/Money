  // Generate stars for crash
  const sky=document.getElementById('crashSky');
  for(let i=0;i<40;i++){
    const s=document.createElement('div');
    s.className='crash-star';
    s.style.left=Math.random()*100+'%';
    s.style.top=Math.random()*80+'%';
    s.style.animationDelay=Math.random()*3+'s';
    s.style.animationDuration=(1.5+Math.random()*2)+'s';
    s.style.width=s.style.height=(1+Math.random()*2.5)+'px';
    sky.appendChild(s);
  }

  // Crash timer + rocket + multiplier
  const crashTimer=document.getElementById('crashTimer');
  const crashRocket=document.getElementById('crashRocket');
  const crashLivePill=document.getElementById('crashLivePill');
  const crashHistory=document.getElementById('crashHistory');
  let crashRocketAnim=null;
  let crashMultiplier=1.0;
  let crashMultInterval=null;
  let crashTickAnimationTimeout=null;
  let crashTickNextTimeout=null;
  let crashRoundToken=0;

  let crashLastCountdownDigit=-1;
  let crashDigitAnimTimeout=null;
  let crashBetActive=false;
  let crashBetAmount=0;
  let crashRoundLive=false;
  let crashRealtimeStarted=false;
  let crashRealtimeTimer=null;
  let crashRealtimeFrame=null;
  let crashRealtimeState=null;
  let crashStateFailCount=0;
  let crashServerOffsetMs=0;
  let crashStateRequestController=null;
  let crashStateRequestToken=0;
  let crashViewSession=0;
  let crashStateRequestInFlight=false;
  let crashRoundLocked=false;
  let crashLocalBetRoundId=0;
  let crashBetSettled=false;
  let crashSettledPayout=0;
  let crashDisplayPhase='countdown';
  let crashCountdownIntroUntil=0;
  let lastCrashDisplayState=null;

  function getPillColor(x){
    if(x<=2)return 'orange';
    if(x<=5)return 'blue';
    return 'purple';
  }
  function getServerNow(){
    return Date.now()+crashServerOffsetMs;
  }
  function resolveGiftImage(gift){
    const image=String(gift?.image||gift?.gift_image||'').trim();
    const explicitGiftId=String(gift?.giftId||gift?.gift_id||'').trim();
    const rawId=String(gift?.id||'').trim();
    const name=String(gift?.name||gift?.gift_name||'').trim().toLowerCase();
    if(image) return image;

    if(explicitGiftId){
      const byGiftId=GIFT_CATALOG.find(entry=>String(entry.id||entry.giftId||'').trim()===explicitGiftId);
      if(byGiftId?.image) return String(byGiftId.image).trim();
      return 'https://cdn.changes.tg/gifts/originals/'+explicitGiftId+'/Original.png';
    }

    if(rawId){
      const byCatalogId=GIFT_CATALOG.find(entry=>String(entry.id||entry.giftId||'').trim()===rawId);
      if(byCatalogId?.image) return String(byCatalogId.image).trim();
    }

    if(name){
      const byName=GIFT_CATALOG.find(entry=>String(entry.name||'').trim().toLowerCase()===name);
      if(byName?.image) return String(byName.image).trim();
    }
    return '';
  }
  function getCrashPreviewGift(stars){
    // If the current value is below the cheapest NFT in the catalog, Crash is
    // a Stars payout. Do not visually pretend that a 10⭐ win is a 339⭐ NFT.
    return getBestGiftForStars(Math.max(0,Math.floor(Number(stars||0))))||null;
  }
  function withCrashGiftValue(gift,amount){
    const safe=gift?{...gift}:null;
    if(!safe) return null;
    const price=Math.max(0,Math.floor(Number(amount||safe.price||0)));
    return {...safe, price};
  }
  function buildCrashGiftBadge(gift){
    const safeGift=gift||null;
    if(!safeGift) return '';
    const src=resolveGiftImage(safeGift);
    const title=(safeGift?.name||'Gift');
    if(src){
      return '<div class="crash-bet-cloud-gift-wrap" title="'+title+'"><img class="crash-bet-cloud-gift" src="'+src+'" alt="'+title+'"></div>';
    }
    return '<div class="crash-bet-cloud-gift-wrap" title="'+title+'"><span class="crash-bet-cloud-gift-fallback">🎁</span></div>';
  }
  function updateCrashGiftBadge(container,gift){
    if(!container)return;
    const safeGift=gift||null;
    let badge=container.querySelector('.crash-bet-cloud-gift-wrap');
    if(!safeGift){
      badge?.remove();
      return;
    }
    const nextImage=String(resolveGiftImage(safeGift)||'');
    const nextName=String(safeGift?.name||'Gift');
    if(!badge){
      container.insertAdjacentHTML('beforeend',buildCrashGiftBadge(safeGift));
      badge=container.querySelector('.crash-bet-cloud-gift-wrap:last-child');
      if(!badge)return;
    }
    const currentImage=badge.dataset.giftImage||'';
    const currentName=badge.dataset.giftName||'';
    if(currentImage===nextImage && currentName===nextName)return;

    badge.dataset.giftImage=nextImage;
    badge.dataset.giftName=nextName;
    badge.setAttribute('title',nextName);
    badge.classList.add('is-changing');

    setTimeout(()=>{
      badge.innerHTML=nextImage
        ? '<img class="crash-bet-cloud-gift" src="'+nextImage+'" alt="'+nextName+'">'
        : '<span class="crash-bet-cloud-gift-fallback">🎁</span>';
      badge.classList.remove('is-changing');
    },120);
  }
  function normalizeInventoryGift(item,fallbackId=''){
    if(!item) return null;
    return {
      id:item.id||fallbackId||('temp_'+Date.now()),
      giftId:String(item.giftId||item.id||''),
      name:String(item.name||'Gift'),
      price:Number(item.price||0),
      image:resolveGiftImage(item),
      withdrawAt:item.withdrawAt||item.withdraw_available_at||null,
      createdAt:item.createdAt||item.created_at||new Date().toISOString(),
    };
  }
  function updateCrashWaitLabel(betsCount=0){
    const hasPlayerCard=crashPlayer.classList.contains('visible');
    const shouldShow=!hasPlayerCard&&!crashPrizePending&&Number(betsCount||0)===0;
    crashWaitText.textContent=shouldShow ? t('waitingBets') : '';
    crashWaitText.style.display=shouldShow ? 'block' : 'none';
  }
  function renderCrashOtherBets(list=[], state=null){
    if(!crashOthers)return;
    const phase=String(state?.phase||'countdown');
    const roundId=Number(state?.roundId||0);
    if(phase==='ended'&&roundId&&roundId===Number(crashResultDismissedRoundId||0)){
      crashOthers.innerHTML='';
      return;
    }
    const others=(Array.isArray(list)?list:[]).filter(player=>String(player.userId)!==String(tgUserId)).slice(0,6);
    const nextIds=new Set(others.map(player=>String(player.userId)));
    Array.from(crashOthers.querySelectorAll('.crash-bet-cloud')).forEach(row=>{
      if(!nextIds.has(String(row.dataset.userId||'')) && !row.classList.contains('fading-out')){
        row.classList.add('fading-out');
        setTimeout(()=>row.remove(),260);
      }
    });
    others.forEach(player=>{
      const userId=String(player.userId||'');
      const betAmount=Number(player.betAmount||player.amount||0);
      const status=String(player.status||'active');
      const payout=Number(player.displayAmount||player.currentPayout||player.payout||player.amount||0);
      // Подарок жёстко привязан к сумме ставки. Не пересчитываем по payout,
      // иначе картинки мигают на каждом тике сервера во время отсчёта.
      const giftAmount=betAmount;
      const gift=withCrashGiftValue(getCrashPreviewGift(giftAmount)||null,giftAmount);
      let row=crashOthers.querySelector('.crash-bet-cloud[data-user-id="'+userId+'"]');
      const isNew=!row;
      if(isNew){
        row=document.createElement('div');
        row.className='crash-bet-cloud';
        row.dataset.userId=userId;
        crashOthers.appendChild(row);
        const avatar=player.photoUrl
          ? '<img class="crash-bet-cloud-avatar" src="'+player.photoUrl+'" alt="">'
          : '<div class="crash-bet-cloud-avatar"></div>';
        row.innerHTML=
          avatar+
          '<div class="crash-bet-cloud-info">'+
            '<div class="crash-bet-cloud-name">'+(player.firstName||'User')+'</div>'+
            '<div class="crash-bet-cloud-bet">'+formatStars(betAmount)+' <img src="assets/star.png" alt=""></div>'+
          '</div>'+
          '<div class="crash-bet-cloud-right">'+
            '<div class="crash-bet-cloud-amount">'+formatStars(payout)+' <img src="assets/star.png" alt=""></div>'+
            buildCrashGiftBadge(gift)+
          '</div>';
        const badge=row.querySelector('.crash-bet-cloud-gift-wrap');
        if(badge){
          badge.dataset.giftImage=String(resolveGiftImage(gift)||'');
          badge.dataset.giftName=String(gift?.name||'Gift');
        }
      }else{
        row.classList.remove('fading-out');
        // Точечно апдейтим только текстовые поля — НЕ трогаем картинку подарка
        const amountEl=row.querySelector('.crash-bet-cloud-amount');
        if(amountEl) amountEl.innerHTML=formatStars(payout)+' <img src="assets/star.png" alt="">';
      }
      row.classList.toggle('win-state',status==='won');
      row.classList.toggle('loss-state',status==='lost');
      row.dataset.betAmount=String(betAmount);
      row.dataset.payout=String(payout);
      row.dataset.status=status;
      row.dataset.settled=(status==='won'||status==='lost')?'1':'0';
      // Обновляем картинку подарка только когда раунд закончился (win/lost),
      // т.к. там сумма уже финальна. Во время countdown/live — оставляем как было.
      if(phase==='ended' || status==='won' || status==='lost'){
        const finalGift=withCrashGiftValue(getCrashPreviewGift(payout)||null,payout);
        const rightEl=row.querySelector('.crash-bet-cloud-right');
        if(rightEl) updateCrashGiftBadge(rightEl,finalGift);
      }
    });
  }
    function updateCrashOtherBetsLive(state){
    const multiplier=computeCrashMultiplier(state);
    const phase=String(state?.phase||'countdown');
    crashOthers.querySelectorAll('.crash-bet-cloud').forEach(row=>{
      if(row.dataset.settled==='1') return;
      const betAmount=Number(row.dataset.betAmount||0);
      let value=betAmount;
      let status='pending';
      if(phase==='live'){
        value=Math.floor(betAmount*multiplier);
        status='active';
      }else if(phase==='ended'){
        value=betAmount;
        status='lost';
      }
      row.dataset.payout=String(value);
      row.dataset.status=status;
      if(status==='lost'){
        row.dataset.settled='1';
        row.classList.add('loss-state');
      }
      const amountEl=row.querySelector('.crash-bet-cloud-amount');
      if(amountEl) amountEl.innerHTML=formatStars(value)+' <img src="assets/star.png" alt="">';
      // Картинку подарка трогаем только в LIVE-фазе (мультипликатор реально растёт),
      // а в countdown — оставляем фиксированную (привязана к ставке).
      if(phase==='live'){
        const gift=withCrashGiftValue(getCrashPreviewGift(value),value);
        row.dataset.giftId=String(gift?.id||gift?.giftId||'');
        row.dataset.giftName=String(gift?.name||'');
        row.dataset.giftImage=String(resolveGiftImage(gift)||'');
        const rightEl=row.querySelector('.crash-bet-cloud-right');
        if(rightEl) updateCrashGiftBadge(rightEl,gift);
      }
    });
  }
  let crashPrevHistoryFirst='';
  let crashHistoryInitialized=false;
  function renderCrashHistoryState(state){
    const liveText=(state&&state.phase==='live')
      ? 'x'+computeCrashMultiplier(state).toFixed(2)
      : t('waiting');
    const historyArr=(state?.history||[]).slice(0,MAX_CRASH_HISTORY);
    const newFirstKey=historyArr.length?(historyArr[0].roundId||'x'+Number(historyArr[0].multiplier).toFixed(2)):'';
    const shouldAnimate=crashHistoryInitialized&&newFirstKey&&newFirstKey!==crashPrevHistoryFirst;
    crashPrevHistoryFirst=newFirstKey;
    crashHistoryInitialized=true;
    crashHistory.innerHTML='';
    crashLivePill.textContent=liveText;
    crashHistory.appendChild(crashLivePill);
    historyArr.forEach((entry,i)=>{
      const pill=document.createElement('div');
      pill.className='crash-history-pill '+getPillColor(entry.multiplier);
      pill.textContent='x'+Number(entry.multiplier).toFixed(2);
      if(i===0&&shouldAnimate){
        pill.style.opacity='0';
        pill.style.maxWidth='0';
        pill.classList.add('slide-in');
      }
      crashHistory.appendChild(pill);
    });
  }
  // CRASH PHASE/CASHOUT FIX: global 5s hold, no stale rows, idempotent cashout UI.
  function computeCrashMultiplier(state,now=getServerNow()){
    if(!state)return 1;
    const snapshot=Math.max(1,Number(state.lastCrashMultiplier||state.liveMultiplier||1));
    if(state.phase!=='live') return snapshot;
    const growth=Math.max(1000,Number(state.growthMs||8000));
    const snapshotAt=Number(state.serverNow||0);
    if(snapshotAt>0 && Number.isFinite(snapshot)){
      // The backend gives us a fresh live snapshot every poll. Extrapolate only a
      // short distance from it. If the API temporarily disappears, freeze instead
      // of letting exp() run for minutes and render x1e+30.
      const ahead=Math.max(0,Math.min(1600,now-snapshotAt));
      return snapshot*Math.exp(ahead/growth);
    }
    const startAt=Number(state.liveStartAt||state.countdownEndsAt||now);
    const elapsed=Math.max(0,Math.min(30000,now-startAt));
    return Math.exp(elapsed/growth);
  }
  function stopCrashRocket(){
    crashRocket.classList.remove('visible');
    crashRocket.innerHTML='';
    if(crashRocketAnim){crashRocketAnim.destroy();crashRocketAnim=null}
  }
  function startCrashRocket(){
    if(crashRocketAnim)return;
    crashRocket.classList.add('visible');
    crashRocket.innerHTML='';
    crashRocketAnim=lottie.loadAnimation({
      container:crashRocket,renderer:'svg',loop:true,autoplay:true,
      path:'assets/crocket.json'
    });
  }

  // CRASH ROUND STATE FIX: spectator sheet + no 1->10 + stale-state guard.
  function deriveCrashDisplayPhase(state, now=getServerNow()){
    if(!state) return 'countdown';
    const phase=String(state.phase||'countdown');
    const countdownEndsAt=Number(state.countdownEndsAt||0);
    // Never synthesize the next countdown from an old ended round. The old
    // countdownEndsAt belongs to the previous round and used to render 1 -> 10.
    // Wait until crash_sync_state returns the real new round with its own timer.
    if(phase==='countdown' && countdownEndsAt && now>=countdownEndsAt) return 'live';
    return phase;
  }

  let crashBoundaryRefreshDueAt=0;
  let crashLastAppliedServerNow=0;
  function isStaleCrashState(state){
    const stamp=Number(state?.serverNow||0);
    return !!(stamp&&crashLastAppliedServerNow&&stamp<crashLastAppliedServerNow);
  }
  function markCrashStateApplied(state){
    const stamp=Number(state?.serverNow||0);
    if(stamp) crashLastAppliedServerNow=Math.max(crashLastAppliedServerNow,stamp);
  }
  function maybeRefreshCrashBoundary(state, now=getServerNow()){
    if(!state) return;
    const candidates=[state.countdownEndsAt,state.nextRoundAt].map(v=>Number(v||0)).filter(Boolean);
    if(!candidates.length) return;
    const future=candidates.filter(v=>v>=now-500);
    if(!future.length) return;
    const nextAt=Math.min(...future);
    if(nextAt-now<=420 && Date.now()>=crashBoundaryRefreshDueAt){
      crashBoundaryRefreshDueAt=Date.now()+120;
      refreshCrashState(true);
    }
  }



  const crashPlayer=document.getElementById('crashPlayer');
  const crashWait=document.getElementById('crashWait');
  const crashWaitText=document.getElementById('crashWaitText');
  const crashOthers=document.getElementById('crashOthers');
  const crashPrizeBlock=document.getElementById('crashPlayerPrize');
  const crashPrizeImage=document.getElementById('crashPrizeImage');
  const crashPrizeName=document.getElementById('crashPrizeName');
  const crashPrizePrice=document.getElementById('crashPrizePrice');
  const crashPrizeSellBtn=document.getElementById('crashPrizeSellBtn');
  const crashPrizeClaimBtn=document.getElementById('crashPrizeClaimBtn');
  const giftModalOverlay=document.getElementById('giftModalOverlay');
  const giftModalImage=document.getElementById('giftModalImage');
  const giftModalName=document.getElementById('giftModalName');
  const giftModalPrice=document.getElementById('giftModalPrice');
  const giftModalSellBtn=document.getElementById('giftModalSellBtn');
  const giftModalClaimBtn=document.getElementById('giftModalClaimBtn');
  const crashResultOverlay=document.getElementById('crashResultOverlay');
  const crashResultTitle=document.getElementById('crashResultTitle');
  const crashResultPrize=document.getElementById('crashResultPrize');
  const crashResultPrizeImage=document.getElementById('crashResultPrizeImage');
  const crashResultPrizeName=document.getElementById('crashResultPrizeName');
  const crashResultPlayers=document.getElementById('crashResultPlayers');
  const crashResultNextLabel=document.getElementById('crashResultNextLabel');
  const crashResultCountdown=document.getElementById('crashResultCountdown');
  const crashResultProgress=document.getElementById('crashResultProgress');
  const crashResultAction=document.getElementById('crashResultAction');
  let crashResultSheetRoundId=0;
  let crashResultSheetDeadline=0;
  let crashResultSheetTicker=null;
  let crashResultSheetWon=false;
  let crashResultSheetBusy=false;
  let crashResultDismissedRoundId=0;
  let crashCashoutRequestedRoundId=0;

  function crashResultText(key){
    const ru={win:'Вы победили',loss:'Вы проиграли',bets:'Ставки',claimed:'Забрал',notClaimed:'Не забрал',next:'До следующей ставки',receive:'Получить',close:'Закрыть',receiving:'Получаем…',you:'Ты'};
    const en={win:'You won',loss:'You lost',bets:'Bets',claimed:'Cashed out',notClaimed:'Did not cash out',next:'Next bet in',receive:'Receive',close:'Close',receiving:'Receiving…',you:'You'};
    return (currentLang==='en'?en:ru)[key]||key;
  }
  function closeCrashResultSheet(){
    if(crashResultSheetTicker){clearInterval(crashResultSheetTicker);crashResultSheetTicker=null;}
    crashResultOverlay?.classList.remove('open');
    crashResultSheetDeadline=0;

    const currentRoundId=Number(crashRealtimeState?.roundId||0);
    if(currentRoundId&&currentRoundId===Number(crashResultSheetRoundId||0)){
      crashResultDismissedRoundId=currentRoundId;
      // During the shared 5-second result hold, the main Crash screen should
      // show only the red crash multiplier. No old own/other bet rows.
      resetCrashPlayer();
      if(crashOthers)crashOthers.innerHTML='';
      crashWaitText.style.display='none';
      crashWait.className='crash-wait empty';
    }
  }
  // CRASH RESULT NAMES FIX: self row is only You/Ты; no cashout/lost text in rows.
  function renderCrashResultPlayers(list=[]){
    if(!crashResultPlayers)return;
    crashResultPlayers.innerHTML='';
    const players=(Array.isArray(list)?list:[]).slice().sort((a,b)=>{
      const am=String(a?.userId||'')===String(tgUserId);
      const bm=String(b?.userId||'')===String(tgUserId);
      if(am!==bm)return am?-1:1;
      return Number(a?.placedAt||0)-Number(b?.placedAt||0);
    });

    players.forEach(player=>{
      const isMe=String(player?.userId||'')===String(tgUserId);
      const won=String(player?.status||'')==='won'||!!player?.cashedOut;
      const betAmount=Math.max(0,Number(player?.amount||player?.betAmount||0));
      const shownAmount=won
        ? Math.max(0,Number(player?.payout||player?.displayAmount||betAmount))
        : betAmount;
      // Same gift badge as the live Crash card. Winners use the final server preview;
      // losers keep the preview that was shown for their bet during the round.
      const gift=normalizeCrashPrizeGift(player?.previewGift||null)
        || withCrashGiftValue(getCrashPreviewGift(shownAmount)||null,shownAmount);

      const row=document.createElement('div');
      row.className='crash-bet-cloud '+(won?'win-state':'loss-state');
      row.dataset.userId=String(player?.userId||'');

      const avatar=document.createElement(player?.photoUrl?'img':'div');
      avatar.className='crash-bet-cloud-avatar';
      if(player?.photoUrl){avatar.src=String(player.photoUrl);avatar.alt='';}

      const info=document.createElement('div');
      info.className='crash-bet-cloud-info';
      const name=document.createElement('div');
      name.className='crash-bet-cloud-name';
      name.textContent=isMe?crashResultText('you'):String(player?.firstName||'User');
      const bet=document.createElement('div');
      bet.className='crash-bet-cloud-bet';
      bet.append(document.createTextNode(formatStars(betAmount)+' '));
      const betStar=document.createElement('img');
      betStar.src='assets/star.png';betStar.alt='';
      bet.appendChild(betStar);
      info.append(name,bet);

      const right=document.createElement('div');
      right.className='crash-bet-cloud-right';
      const amount=document.createElement('div');
      amount.className='crash-bet-cloud-amount';
      amount.append(document.createTextNode(formatStars(shownAmount)+' '));
      const amountStar=document.createElement('img');
      amountStar.src='assets/star.png';amountStar.alt='';
      amount.appendChild(amountStar);
      right.appendChild(amount);
      if(gift){
        right.insertAdjacentHTML('beforeend',buildCrashGiftBadge(gift));
        const badge=right.querySelector('.crash-bet-cloud-gift-wrap:last-child');
        if(badge){
          badge.dataset.giftImage=String(resolveGiftImage(gift)||'');
          badge.dataset.giftName=String(gift?.name||'Gift');
        }
      }

      row.append(avatar,info,right);
      crashResultPlayers.appendChild(row);
    });
  }
  async function claimCrashResultPrizeAndClose(){
    if(crashResultSheetBusy)return;
    if(!crashPrizePending||!crashPrizeGift){closeCrashResultSheet();return;}
    crashResultSheetBusy=true;
    if(crashResultAction){crashResultAction.disabled=true;crashResultAction.textContent=crashResultText('receiving');}
    try{
      const resolved=await resolveCrashPrize('claim');
      if(resolved||!crashPrizePending){
        if(resolved)playAppSound('reward');
        closeCrashResultSheet();
      }else{
        // The backend says that no pending prize exists. This is an old local
        // preview, not a reason to trap the player in a Receive-only sheet.
        crashPrizePending=false;
        crashPrizeGift=null;
        crashPrizeResolveToken='';
        closeCrashResultSheet();
        refreshCrashState(true,true);
      }
    }finally{
      crashResultSheetBusy=false;
      if(crashResultAction){crashResultAction.disabled=false;crashResultAction.textContent=crashResultText('receive');}
    }
  }
  function tickCrashResultSheet(){
    if(!crashResultSheetDeadline)return;
    const left=Math.max(0,crashResultSheetDeadline-Date.now());
    const sec=Math.max(0,Math.ceil(left/1000));
    if(crashResultCountdown)crashResultCountdown.textContent=String(sec);
    if(crashResultProgress){
      const ratio=Math.max(0,Math.min(1,left/5000));
      crashResultProgress.style.width=(ratio*100).toFixed(1)+'%';
      crashResultProgress.style.opacity=String(.28+.72*ratio);
    }
    if(left<=0){
      if(crashResultSheetTicker){clearInterval(crashResultSheetTicker);crashResultSheetTicker=null;}
      // A pending crash prize would block the next bet in the DB. If the player
      // does nothing for 5 seconds, receive it to inventory automatically.
      if(crashResultSheetWon&&crashPrizePending&&crashPrizeGift) claimCrashResultPrizeAndClose(true);
      else closeCrashResultSheet();
    }
  }
  function maybeOpenCrashResultSheet(state){
    if(!state||String(state.phase)!=='ended')return;
    const viewer=state.viewerBet||null;
    const roundId=Number(state.roundId||0);
    if(!roundId||crashResultSheetRoundId===roundId)return;

    const won=!!viewer&&(String(viewer.status||'')==='won'||!!viewer.cashedOut);
    const lost=!!viewer&&String(viewer.status||'')==='lost';
    const spectator=!viewer;
    const resultPlayers=Array.isArray(state.activeBets)?state.activeBets:[];

    // An ended-state poll can beat the cashout HTTP response by a few ms.
    // Never open a loss sheet while that cashout is still unresolved; the
    // cashout response will either confirm the win or re-apply the real loss.
    if(crashCashoutBusy&&lost)return;

    // If nobody bet in this round, there is nothing useful to show to a spectator.
    if(spectator && resultPlayers.length===0){
      crashResultSheetRoundId=roundId;
      return;
    }

    crashResultSheetRoundId=roundId;
    crashResultSheetWon=false;
    crashResultSheetBusy=false;
    giftModalOverlay?.classList.remove('open');
    crashResultTitle.textContent=won
      ? crashResultText('win')
      : (lost?crashResultText('loss'):crashResultText('bets'));
    crashResultNextLabel.textContent=crashResultText('next');
    renderCrashResultPlayers(resultPlayers);

    if(won){
      const gift=normalizeCrashPrizeGift(state.pendingPrize||crashPrizeGift||viewer?.previewGift||null);
      if(gift){
        crashResultSheetWon=true; // only a real pending NFT needs Receive/auto-claim
        const img=resolveGiftImage(gift);
        if(img){crashResultPrizeImage.src=img;crashResultPrizeImage.alt=gift.name||'Gift';}
        else{crashResultPrizeImage.removeAttribute('src');crashResultPrizeImage.alt='';}
        crashResultPrizeName.textContent=String(gift.name||'Gift');
        crashResultPrize.classList.add('visible');
        crashResultAction.textContent=crashResultText('receive');
      }else{
        // Win below minimum NFT price: backend already credited Stars.
        const starWin=Math.max(0,Number(viewer?.payout||viewer?.displayAmount||0));
        crashResultPrizeImage.src='assets/star.png';
        crashResultPrizeImage.alt='Stars';
        crashResultPrizeName.textContent='+'+formatStars(starWin);
        crashResultPrize.classList.add('visible');
        crashResultAction.textContent=crashResultText('close');
      }
    }else{
      crashResultPrize.classList.remove('visible');
      crashResultPrizeImage.removeAttribute('src');
      crashResultPrizeImage.alt='';
      crashResultPrizeName.textContent='';
      crashResultAction.textContent=crashResultText('close');
    }

    crashResultAction.disabled=false;
    crashResultOverlay.classList.add('open');

    // Count down to the real DB nextRoundAt, not five seconds from the moment
    // this device happened to receive the result.
    const serverLeft=Math.max(0,Number(state.nextRoundAt||0)-getServerNow());
    // If network/background recovery discovers an ended round with almost no
    // global cooldown left, don't flash the sheet for a fraction of a second.
    if(serverLeft>0&&serverLeft<1200){
      crashResultDismissedRoundId=roundId;
      resetCrashPlayer();
      if(crashOthers)crashOthers.innerHTML='';
      return;
    }
    const holdMs=Math.max(250,Math.min(5000,serverLeft||5000));
    crashResultSheetDeadline=Date.now()+holdMs;
    tickCrashResultSheet();
    if(crashResultSheetTicker)clearInterval(crashResultSheetTicker);
    crashResultSheetTicker=setInterval(tickCrashResultSheet,100);
  }
  let crashResultState=null;
  let crashPrizeModalAutoKey='';
  let crashPrizeResolveToken='';

  function normalizeCrashPrizeGift(gift){
    if(!gift) return null;
    const rawId=String(gift.id||gift.giftId||gift.gift_id||'').trim();
    const rawName=String(gift.name||gift.gift_name||'').trim();
    const rawPrice=Number(gift.price||gift.gift_price||0);
    const byId=rawId?GIFT_CATALOG.find(entry=>String(entry.id||entry.giftId||'').trim()===rawId):null;
    const byName=rawName?GIFT_CATALOG.find(entry=>String(entry.name||'').trim().toLowerCase()===rawName.toLowerCase()):null;
    const catalogGift=byId||byName||null;
    const giftId=String(gift.giftId||gift.gift_id||rawId||catalogGift?.id||'').trim();
    return {
      id: rawId||giftId,
      giftId,
      name: rawName||String(catalogGift?.name||'Gift'),
      price: rawPrice||Number(catalogGift?.price||0),
      image: String(gift.image||gift.gift_image||catalogGift?.image||resolveGiftImage({...gift,id:rawId||giftId,giftId,name:rawName,price:rawPrice})||'').trim(),
    };
  }

  function setCrashPlayerState(state){
    crashResultState=state||null;
    crashPlayer.classList.remove('win-state','loss-state');
    if(state==='win') crashPlayer.classList.add('win-state');
    if(state==='loss') crashPlayer.classList.add('loss-state');
  }

  function renderCrashPlayerWin(amount,gift=null){
    const explicitGift=gift?normalizeCrashPrizeGift(gift):null;
    // A red/lost card keeps the same preview NFT that was shown during the round.
    // If the value is below the cheapest NFT, getCrashPreviewGift() correctly returns null.
    const sourceGift=explicitGift||(crashPrizePending||crashBetSettled?crashPrizeGift:null)||getCrashPreviewGift(amount);
    const displayGift=withCrashGiftValue(sourceGift,amount);
    crashRenderedWinGift=displayGift?{...displayGift}:null;
    crashRenderedWinAmount=Number(amount||0);
    document.getElementById('crashPlayerWin').innerHTML='<span class="crash-win-value">'+formatStars(amount)+' <img src="assets/star.png" alt=""></span>'+(displayGift?buildCrashGiftBadge(displayGift):'');
  }
  let topupMode='stars';
  function getTopupRawValue(){
    const raw=String(topupAmount.value||'').replace(',', '.');
    const value=topupMode==='ton' ? parseFloat(raw) : parseInt(raw,10);
    return Number.isFinite(value) ? value : 0;
  }
  function getTopupStarsValue(){
    const rawValue=getTopupRawValue();
    if(rawValue<=0) return 0;
    return topupMode==='ton' ? Math.floor(rawValue*TON_TO_STARS) : Math.floor(rawValue);
  }
  function syncTopupModeIndicator(){
    const wrap=document.getElementById('topupModeTabs');
    const indicator=document.getElementById('topupModeIndicator');
    const active=document.querySelector(`.topup-block[data-type="${topupMode}"]`);
    if(!wrap||!indicator||!active) return;
    indicator.style.width=active.offsetWidth+'px';
    indicator.style.transform='translateX('+active.offsetLeft+'px)';
  }
  function syncTopupModeUI(){
    const icon=document.getElementById('topupUnitIcon');
    document.querySelectorAll('.topup-block').forEach(block=>{
      block.classList.toggle('selected', block.dataset.type===topupMode);
    });
    if(topupMode==='ton'){
      topupAmount.step='0.1';
      topupAmount.placeholder='0';
      if(icon){icon.src='assets/ton.webp';icon.alt='ton';}
    }else{
      topupAmount.step='1';
      topupAmount.placeholder='0';
      if(icon){icon.src='assets/star.png';icon.alt='star';}
    }
    syncTopupWalletUI();
    syncTopupSubmitLabel();
    requestAnimationFrame(syncTopupModeIndicator);
  }
  function syncTopupSubmitLabel(){
    const starsValue=getTopupStarsValue();
    if(topupMode==='ton' && !isTonWalletConnected()){
      topupSubmit.textContent=t('connectWallet');
      return;
    }
    if(starsValue>0) topupSubmit.innerHTML=t('topupBtn')+' '+formatStars(starsValue)+' <img src="assets/star.png" alt="">';
    else topupSubmit.textContent=t('topupBtn');
  }
  function syncBetSubmitLabel(){
    document.getElementById('betSubmit').textContent=t('placeBet');
  }
  function updateLangStaticTexts(){
    document.documentElement.lang=currentLang;
    const q=s=>document.querySelector(s);
    q('#topPage .top-place-text').innerHTML=t('topPlace');
    syncTopModeUI();
    document.querySelectorAll('#topPage .top-name').forEach(el=>{if(!el.dataset.locked){el.textContent=t('waitingDots')}});
    q('#profilePage .section-title').textContent=t('profile');
    document.querySelectorAll('#profilePage .section-title')[1].textContent=t('promocodes');
    q('.promo-input').placeholder=t('promoPlaceholder');
    q('.promo-btn').textContent=t('apply');
    q('.referral-text h3').textContent=t('referralTitle');
    q('.referral-text p').textContent=t('referralDesc');
    q('#referralBackText').textContent=t('referralBack');
    q('#referralInvitedLabel').textContent=t('invited');
    q('#referralEarnedLabel').textContent=t('earned');
    q('#referralInviteBtn').textContent=t('invite');
    q('#referralLinkInput').placeholder=t('referralLink');
    q('.inventory-title').textContent=t('inventory');
    q('#inventoryEmpty .empty-title').textContent=t('noGiftsTitle');
    q('#inventoryEmpty .empty-desc').innerHTML=t('noGiftsDesc');
    q('.upgrade-subtitle').textContent=t('chooseGift');
    document.querySelectorAll('.slot-label')[0].textContent=t('myGifts');
    document.querySelectorAll('.slot-label')[1].textContent=t('giftsForUpgrade');
    q('.upgrade-btn').innerHTML=t('makeUpgrade')+'\n        <img src="svg/rise.svg" alt="">';
    q('#sheet .sheet-pill').textContent=t('myGifts');
    q('#sheet .empty-title').textContent=t('noGiftsTitle');
    q('#sheet .empty-desc').innerHTML=t('noGiftsDesc');
    q('#giftModalPill').textContent=t('giftUnlocked');
    giftModalClaimBtn.textContent=t('claim');
    q('#langCloud .modal-cloud-text').textContent=t('language');
    q('#supportRow .modal-cloud-text').textContent=t('support');
    q('#modalSave').textContent=t('saveAndExit');
    q('#topupSheet .topup-pill').textContent=t('topup');
    document.querySelector('.topup-block[data-type="stars"] span').textContent=t('stars');
    document.querySelector('.topup-block[data-type="ton"] span').textContent=t('ton');
    q('#betSheet .bet-pill').textContent=t('bet');
    // Нижняя навигация намеренно всегда остаётся на английском, независимо от языка приложения.
    const navLabels=document.querySelectorAll('.nav-label');
    if(navLabels[0]) navLabels[0].textContent='Top';
    if(navLabels[1]) navLabels[1].textContent='Game';
    if(navLabels[2]) navLabels[2].textContent='Profile';
    updateCrashWaitLabel();
    if(!crashRealtimeState||crashRealtimeState.phase!=='live') crashLivePill.textContent=t('waiting');
    if(crashPrizePending){ crashLivePill.textContent=t('giftReady'); closeBet(); }
    if(!crashBetActive&&!crashPrizePending&&(!crashRealtimeState||crashRealtimeState.phase!=='live')) document.getElementById('crashBetBtn').textContent=t('placeBet');
    if(crashPrizePending&&crashPrizeGift) showCrashPrize(crashPrizeGift);
    crashPrizeBlock.classList.remove('visible');
    syncTopupSubmitLabel();
    syncBetSubmitLabel();
    updateReferralUI();
    renderInventory();
    renderSheetGifts();
    if(crashRealtimeState) renderCrashHistoryState(crashRealtimeState);
  }
  function applyLanguage(lang){
    currentLang=lang;pendingLang=lang;localStorage.setItem('miniapp_lang',lang);setLangIndicator(lang);updateLangStaticTexts();syncTopupModeUI();
  }

  function clearCrashHistoryOverflow(){
    while(crashHistory.children.length>MAX_CRASH_HISTORY+1){
      crashHistory.removeChild(crashHistory.lastElementChild);
    }
  }
  function openGiftModal(){
    // Legacy crash gift popup is intentionally disabled. Crash results are handled
    // only by the round-result bottom sheet.
    return;
  }
  function getCrashPrizeKey(gift){
    if(!gift) return '';
    const normalized=normalizeCrashPrizeGift(gift)||gift;
    return [String(normalized.id||normalized.giftId||''),String(normalized.name||''),String(normalized.price||0)].join('|');
  }
  function maybeAutoOpenGiftModal(gift){
    const key=getCrashPrizeKey(gift);
    if(!key||crashPrizeModalAutoKey===key||crashPrizeResolveBusy)return;
    crashPrizeModalAutoKey=key;
    openGiftModal();
  }
  function enterPendingCrashPrize(gift,payout=0,betAmount=crashBetAmount,options={}){
    const normalizedGift=normalizeCrashPrizeGift(gift);
    if(!normalizedGift)return;
    const currentKey=getCrashPrizeKey(crashPrizeGift);
    const nextKey=getCrashPrizeKey(normalizedGift);
    const hasLockedPrize=!!(crashPrizePending&&currentKey);
    if(hasLockedPrize&&currentKey!==nextKey&&!options.force)return;
    crashPrizeGift=normalizedGift;
    crashPrizePending=true;
    crashCashoutBusy=false;
    crashBetSyncPending=false;
    crashBetActive=false;
    crashBetSettled=true;
    crashSettledPayout=Number(payout||0);
    crashRoundLocked=true;
    crashLocalBetRoundId=Number(crashRealtimeState?.roundId||crashLocalBetRoundId||0);
    crashBetAmount=Number(betAmount||crashBetAmount||0);
    if(crashBetAmount>0){
      renderCrashPlayerCard(crashBetAmount);
      renderCrashPlayerWin(crashSettledPayout||crashBetAmount,normalizedGift);
      setCrashPlayerState('win');
    }
    showCrashPrize(normalizedGift);
    if(options.autoOpen!==false) maybeAutoOpenGiftModal(normalizedGift);
    const betBtn=document.getElementById('crashBetBtn');
    betBtn.classList.add('dim');
    betBtn.textContent=t('giftOpened');
    updateCrashWaitLabel(crashRealtimeState?.betsCount||0);
  }
  function hideCrashPrize(){
    giftModalOverlay.classList.remove('open');
    crashPrizeBlock.classList.remove('visible');
    giftModalImage.removeAttribute('src');
    giftModalName.textContent='';
    giftModalPrice.innerHTML='';
    crashPrizeImage.removeAttribute('src');
    crashPrizeImage.removeAttribute('alt');
    crashPrizeName.textContent='';
    crashPrizePrice.innerHTML='';
    crashPrizeSellBtn.innerHTML='';
    crashPrizeClaimBtn.textContent=t('claim');
  }
  function showCrashPrize(gift){
    const normalizedGift=normalizeCrashPrizeGift(gift);
    if(!normalizedGift)return;
    const giftImage=resolveGiftImage(normalizedGift);

    if(giftImage){
      crashPrizeImage.src=giftImage;
      crashPrizeImage.alt=normalizedGift.name||'Gift';
      giftModalImage.src=giftImage;
      giftModalImage.alt=normalizedGift.name||'Gift';
    }else{
      crashPrizeImage.removeAttribute('src');
      crashPrizeImage.removeAttribute('alt');
      giftModalImage.removeAttribute('src');
      giftModalImage.alt='';
    }
    crashPrizeName.textContent=normalizedGift.name;
    crashPrizePrice.innerHTML=formatStars(normalizedGift.price)+' <img src="assets/star.png" alt="">';
    crashPrizeSellBtn.innerHTML=t('sell')+' '+formatStars(normalizedGift.price)+' <img src="assets/star.png" alt="">';
    crashPrizeClaimBtn.textContent=t('claim');
    crashPrizeBlock.classList.remove('visible');

    giftModalName.textContent=normalizedGift.name;
    giftModalPrice.innerHTML=formatStars(normalizedGift.price)+' <img src="assets/star.png" alt="">';
    giftModalSellBtn.innerHTML=t('sell')+' '+formatStars(normalizedGift.price)+' <img src="assets/star.png" alt="">';
    giftModalClaimBtn.textContent=t('claim');
  }
  // CRASH+TOP FIX 2026-08-07: no stale red bet, Stars below NFT minimum, dual leaderboard.
  function resetCrashPlayer(){
    hideCrashPrize();
    crashPrizeGift=null;
    crashPrizePending=false;
    crashBetSyncPending=false;
    crashCashoutBusy=false;
    crashRoundLocked=false;
    crashLocalBetRoundId=0;
    crashBetActive=false;
    crashBetAmount=0;
    crashCashoutBusy=false;
    crashBetSettled=false;
    crashSettledPayout=0;
    crashRenderedWinGift=null;
    crashRenderedWinAmount=0;
    if(crashPlayer.classList.contains('visible') && !crashPlayer.classList.contains('fading')){
      crashPlayer.classList.add('fading');
      setTimeout(()=>{
        crashPlayer.classList.remove('visible','fading');
        setCrashPlayerState(null);
        document.getElementById('crashPlayerBet').innerHTML='';
        document.getElementById('crashPlayerWin').innerHTML='';
        crashWaitText.style.display='none';
        crashWait.className='crash-wait empty';
        updateCrashWaitLabel(crashRealtimeState?.betsCount||0);
      },220);
      return;
    }
    crashPlayer.classList.remove('visible','fading');
    crashWaitText.style.display='none';
    crashWait.className='crash-wait empty';
    setCrashPlayerState(null);
    document.getElementById('crashPlayerBet').innerHTML='';
    document.getElementById('crashPlayerWin').innerHTML='';
    updateCrashWaitLabel(crashRealtimeState?.betsCount||0);
  }

  function renderCrashPlayerCard(amount,animate){
    crashWaitText.style.display='none';
    crashWait.className='crash-wait has-bet';
    crashPlayer.classList.remove('fading','slide-in');
    crashPlayer.classList.add('visible');
    if(animate){
      void crashPlayer.offsetWidth;
      crashPlayer.classList.add('slide-in');
    }
    document.getElementById('crashPlayerName').textContent=firstName;
    if(photoUrl) document.getElementById('crashPlayerAvatar').src=photoUrl;
    document.getElementById('crashPlayerBet').innerHTML=formatStars(amount)+' <img src="assets/star.png" alt="">';
    if(!crashPrizePending) crashPrizeBlock.classList.remove('visible');
  }

  function syncCrashViewerBet(state){
    const pendingPrize=state?.pendingPrize||null;
    const viewerBet=state?.viewerBet||null;
    const stateRoundId=Number(state?.roundId||0);

    if(stateRoundId&&crashResultDismissedRoundId&&stateRoundId!==crashResultDismissedRoundId){
      crashResultDismissedRoundId=0;
    }
    if(viewerBet&&!pendingPrize&&stateRoundId&&stateRoundId===crashResultDismissedRoundId){
      return;
    }

    if(viewerBet?.roundId) crashLocalBetRoundId=Number(viewerBet.roundId||stateRoundId||0);
    if(!viewerBet&&!pendingPrize&&crashLocalBetRoundId&&stateRoundId&&stateRoundId!==crashLocalBetRoundId&&!crashCashoutBusy&&!crashPrizeResolveBusy){
      resetCrashPlayer();
      return;
    }

    if(crashPrizeResolveBusy){
      if(crashBetAmount>0&&crashBetSettled){
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(crashSettledPayout||crashBetAmount,crashPrizeGift);
        setCrashPlayerState('win');
      }
      return;
    }

    if(pendingPrize){
      enterPendingCrashPrize(
        pendingPrize,
        Number(viewerBet?.displayAmount||viewerBet?.payout||crashSettledPayout||0),
        Number(viewerBet?.amount||crashBetAmount||0),
        { autoOpen:false }
      );
      return;
    }

    if(!viewerBet){
      if(crashBetSyncPending&&crashBetActive&&state?.phase==='countdown'){
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(crashBetAmount,null);
        return;
      }
      if((crashCashoutBusy||crashBetSettled)&&crashBetAmount>0){
        // A cashout request is only a win after the server confirms it.
        // Keep the card neutral while the request is in flight so a last-millisecond
        // rejection can never flash green and then turn into a loss.
        setCrashPlayerState(crashBetSettled?'win':null);
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(crashSettledPayout||crashRenderedWinAmount||crashBetAmount,crashPrizeGift||crashRenderedWinGift);
        return;
      }
      if(crashResultState==='loss'&&crashBetAmount>0&&!crashPrizePending){
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(crashSettledPayout||crashBetAmount,null);
        setCrashPlayerState('loss');
        return;
      }
      if(!crashPrizePending&&!crashBetActive&&!crashBetSettled){
        crashRoundLocked=false;
      }
      return;
    }

    if(crashCashoutBusy && viewerBet){
      if(crashBetAmount>0){
        setCrashPlayerState(null);
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(crashSettledPayout||crashRenderedWinAmount||crashBetAmount,crashPrizeGift||crashRenderedWinGift);
      }
      return;
    }

    const betAmount=Number(viewerBet.amount||0);
    const displayAmount=Number(viewerBet.displayAmount||viewerBet.currentPayout||viewerBet.payout||betAmount||0);
    const previewGift=withCrashGiftValue(viewerBet.previewGift||getCrashPreviewGift(displayAmount)||null,displayAmount);
    crashRoundLocked=true;
    crashBetAmount=betAmount;
    renderCrashPlayerCard(crashBetAmount);

    if(viewerBet.status==='won'||viewerBet.cashedOut){
      crashCashoutBusy=false;
      crashBetSyncPending=false;
      crashBetActive=false;
      crashBetSettled=true;
      crashSettledPayout=displayAmount||Number(viewerBet.payout||0)||crashBetAmount;
      if(previewGift) crashPrizeGift=previewGift;
      setCrashPlayerState('win');
      renderCrashPlayerWin(crashSettledPayout||crashBetAmount,crashPrizeGift);
      return;
    }

    // Бывал баг: своя ставка моргала «проигрышной» в самом конце раунда,
    // когда server.phase уже 'ended', а cashedOut ещё не успел докатиться.
    // Теперь доверяем ТОЛЬКО серверному status==='lost' — он атомарно ставится
    // на финализации раунда. Гонка с локальным «выиграл» больше не возможна.
    if(viewerBet.status==='lost' && !crashBetSettled){
      // A stale poll can arrive after the cashout tap but before the cashout
      // response. Never paint that temporary snapshot red.
      if(crashCashoutBusy){
        // Stale poll while cashout is pending: stay neutral until HTTP confirmation.
        setCrashPlayerState(null);
        renderCrashPlayerWin(crashSettledPayout||crashRenderedWinAmount||crashBetAmount,crashPrizeGift||crashRenderedWinGift);
        return;
      }
      crashCashoutBusy=false;
      crashBetSyncPending=false;
      crashBetActive=false;
      crashBetSettled=false;
      crashSettledPayout=displayAmount||crashBetAmount;
      crashPrizeGift=null;
      setCrashPlayerState('loss');
      renderCrashPlayerWin(crashSettledPayout||crashBetAmount,null);
      return;
    }

    crashBetSettled=false;
    crashSettledPayout=0;
    crashPrizeGift=previewGift;
    crashBetActive=true;
    setCrashPlayerState(null);
    if(state?.phase==='live'){
      const liveWin=Math.floor(crashBetAmount*computeCrashMultiplier(state));
      renderCrashPlayerWin(liveWin,null);
    }else{
      renderCrashPlayerWin(crashBetAmount,null);
    }
  }

  function applyCrashRoundBoundary(prevState,nextState){
    if(!prevState)return;
    if(prevState.roundId===nextState.roundId)return;
    crashCashoutRequestedRoundId=0;
    crashResultDismissedRoundId=0;
    if(!crashPrizePending) crashPrizeModalAutoKey='';
    crashRoundLocked=false;
    crashCountdownIntroUntil=0;
    if(crashDigitAnimTimeout){clearTimeout(crashDigitAnimTimeout);crashDigitAnimTimeout=null}
    crashLastCountdownDigit=-1;
    crashTimer.textContent='';
    crashTimer.className='crash-timer';

    if(crashPrizePending||crashCashoutBusy){
      return;
    }
    if(crashResultState==='loss'&&crashBetAmount>0){
      resetCrashPlayer();
      return;
    }
    if(crashBetSettled&&!crashPrizePending){
      resetCrashPlayer();
      return;
    }
    if(crashBetActive&&!crashPrizePending){
      crashBetActive=false;
      crashSettledPayout=crashBetAmount;
      crashPrizeGift=null;
      setCrashPlayerState('loss');
      renderCrashPlayerCard(crashBetAmount);
      renderCrashPlayerWin(crashBetAmount,null);
      const betBtn=document.getElementById('crashBetBtn');
      betBtn.classList.add('dim');
      betBtn.textContent=t('placeBet');
      return;
    }
    resetCrashPlayer();
  }
  function renderCrashRealtimeFrame(){
    if(document.visibilityState!=='visible'){
      crashRealtimeFrame=null;
      return;
    }
    crashRealtimeFrame=requestAnimationFrame(renderCrashRealtimeFrame);
    const state=crashRealtimeState;
    if(!state)return;
    const now=getServerNow();
    const betBtn=document.getElementById('crashBetBtn');
    const lossEl=document.getElementById('crashLoss');
    const displayPhase=deriveCrashDisplayPhase(state,now);
    maybeRefreshCrashBoundary(state,now);
    crashDisplayPhase=displayPhase;
    crashRoundLive=displayPhase==='live';
    updateCrashOtherBetsLive({...state, phase: displayPhase});

    if(displayPhase==='countdown'){
      const endsAt=Number(state.countdownEndsAt||state.liveStartAt||0);
      const count=Math.min(10,Math.max(1,Math.ceil(Math.max(0,endsAt-now)/1000)));
      crashTimer.style.display='';
      if(count!==crashLastCountdownDigit){
        if(crashDigitAnimTimeout){clearTimeout(crashDigitAnimTimeout);crashDigitAnimTimeout=null}
        crashTimer.textContent=String(count);
        crashTimer.className='crash-timer';
        void crashTimer.offsetWidth;
        crashTimer.className='crash-timer digit-in';
        crashLastCountdownDigit=count;
      }
      stopCrashRocket();
      lossEl.className='crash-loss';
      crashMultiplier=1.0;
      if(crashPrizePending){ crashLivePill.textContent=t('giftReady'); closeBet(); }
      else crashLivePill.textContent=t('waiting');
      if(crashBetActive){
        closeBet();
        betBtn.classList.add('dim');
        betBtn.innerHTML=t('cashOut')+' '+formatStars(crashBetAmount)+' <img src="assets/star.png" alt="">';
      }else if(!crashPrizePending){
        crashRoundLocked=false;
        betBtn.classList.remove('dim');
        betBtn.textContent=t('placeBet');
      }
      return;
    }

    if(displayPhase==='live'){
      crashLastCountdownDigit=-1;
      if(crashDigitAnimTimeout){clearTimeout(crashDigitAnimTimeout);crashDigitAnimTimeout=null}
      closeBet();
      lossEl.className='crash-loss';
      startCrashRocket();
      crashMultiplier=computeCrashMultiplier({...state, phase:'live'},now);
      crashTimer.style.display='none';
      crashLivePill.textContent='x'+crashMultiplier.toFixed(2);
      if(crashCashoutBusy||crashBetSettled){
        betBtn.classList.add('dim');
        betBtn.textContent=crashPrizePending?t('giftOpened'):t('placeBet');
      }else if(crashBetActive){
        const win=Math.floor(crashBetAmount*crashMultiplier);
        renderCrashPlayerWin(win,null);
        betBtn.classList.remove('dim');
        betBtn.innerHTML=t('cashOut')+' '+formatStars(win)+' <img src="assets/star.png" alt="">';
      }else if(!crashPrizePending){
        betBtn.classList.add('dim');
        betBtn.textContent=t('placeBet');
      }
      return;
    }

    closeBet();
    crashTimer.style.display='none';
    crashTimer.textContent='';
    crashTimer.className='crash-timer';
    stopCrashRocket();
    crashMultiplier=Number(state.lastCrashMultiplier||1);
    lossEl.textContent='x'+crashMultiplier.toFixed(2);
    if(lastCrashDisplayState!==state.roundId+':ended'){
      lossEl.className='crash-loss';
      void lossEl.offsetWidth;
      lossEl.className='crash-loss show';
      lastCrashDisplayState=state.roundId+':ended';
    }
    if(Number(state.roundId||0)===Number(crashResultDismissedRoundId||0)){
      resetCrashPlayer();
      if(crashOthers)crashOthers.innerHTML='';
      betBtn.classList.add('dim');
      betBtn.textContent=t('placeBet');
      return;
    }
    if(crashBetActive&&!crashPrizePending&&!crashCashoutBusy){
      crashBetActive=false;
      setCrashPlayerState('loss');
    }
    if(crashCashoutBusy){
      // The round may already be visually ended while the cashout response is
      // still on the wire. Do not claim a win before the backend confirms it.
      setCrashPlayerState(null);
      renderCrashPlayerWin(crashSettledPayout||crashRenderedWinAmount||crashBetAmount,crashPrizeGift||crashRenderedWinGift);
    }else if(crashBetSettled){
      setCrashPlayerState('win');
      renderCrashPlayerWin(crashSettledPayout||crashBetAmount,crashPrizeGift);
    }else if(!crashPrizePending && crashBetAmount>0){
      renderCrashPlayerCard(crashBetAmount);
      renderCrashPlayerWin(crashBetAmount,null);
      setCrashPlayerState('loss');
    }
    if(crashPrizePending){ crashLivePill.textContent=t('giftReady'); closeBet(); }
    else crashLivePill.textContent=t('waiting');
    betBtn.classList.add('dim');
    if(!crashBetActive&&!crashPrizePending) betBtn.textContent=t('placeBet');
  }
  // CRASH BACKGROUND RECOVERY FIX: abortable polling + forced resync after resume.
  async function refreshCrashState(silent=false,force=false,viewSession=crashViewSession,allowBackground=false){
    // During bootstrap this also hydrates the hidden Crash page, so the rocket
    // and history are already rendered before the player opens the game.
    if(!allowBackground&&(currentTab!=='crash'||viewSession!==crashViewSession))return false;
    if(crashStateRequestInFlight&&!force)return false;

    if(force&&crashStateRequestController){
      try{crashStateRequestController.abort()}catch(_){}
    }

    const token=++crashStateRequestToken;
    const controller=new AbortController();
    crashStateRequestController=controller;
    crashStateRequestInFlight=true;
    const timeout=setTimeout(()=>controller.abort(),1200);

    try{
      const resp=await fetch(API_BASE+'/api/crash/state?ts='+Date.now(),{
        headers:{'x-init-data':tg?.initData||''},
        cache:'no-store',
        signal:controller.signal
      });
      const data=await readApiJson(resp);
      if(token!==crashStateRequestToken||(!allowBackground&&(viewSession!==crashViewSession||currentTab!=='crash')))return false;
      if(!resp.ok)throw new Error(data.error||'Crash sync failed');
      if(isStaleCrashState(data))return false;

      markCrashStateApplied(data);
      crashServerOffsetMs=Number(data.serverNow||Date.now())-Date.now();
      crashStateFailCount=0;
      const prevState=crashRealtimeState;
      crashRealtimeState=data;
      applyCrashRoundBoundary(prevState,data);
      syncCrashViewerBet(data);
      if(!allowBackground||currentTab==='crash')maybeOpenCrashResultSheet(data);
      renderCrashHistoryState(data);
      renderCrashOtherBets(data.activeBets||[],data);
      updateCrashWaitLabel(data.betsCount||0);

      if(!crashRealtimeFrame&&document.visibilityState==='visible'){
        crashRealtimeFrame=requestAnimationFrame(renderCrashRealtimeFrame);
      }
      return true;
    }catch(e){
      if(token!==crashStateRequestToken)return false;
      if(e?.name==='AbortError')return false;

      crashStateFailCount+=1;
      console.warn('Crash refresh failed:',e.message);
      if(crashStateFailCount>=5&&!crashRealtimeState){
        crashLivePill.textContent='Ошибка Crash';
        crashTimer.style.display='';
        crashTimer.textContent='!';
        crashTimer.className='crash-timer';
        const btn=document.getElementById('crashBetBtn');
        btn.classList.add('dim');
        btn.textContent='Crash недоступен';
      }
      if(!silent&&tg?.showAlert)tg.showAlert('Crash: '+e.message);
      return false;
    }finally{
      clearTimeout(timeout);
      if(token===crashStateRequestToken){
        crashStateRequestInFlight=false;
        if(crashStateRequestController===controller)crashStateRequestController=null;
      }
    }
  }

  function pauseCrashRound(){
    if(crashRealtimeTimer){
      clearInterval(crashRealtimeTimer);
      crashRealtimeTimer=null;
    }
    if(crashRealtimeFrame){
      cancelAnimationFrame(crashRealtimeFrame);
      crashRealtimeFrame=null;
    }
    if(crashStateRequestController){
      try{crashStateRequestController.abort()}catch(_){}
      crashStateRequestController=null;
    }
    crashStateRequestInFlight=false;
    crashStateRequestToken+=1;
    crashViewSession+=1;
  }

  function runCrashRound(){
    if(currentTab!=='crash') return;
    crashRealtimeStarted=true;
    const viewSession=crashViewSession;
    if(!crashRealtimeTimer){
      crashRealtimeTimer=setInterval(()=>refreshCrashState(true,false,crashViewSession),500);
    }
    if(!crashRealtimeFrame&&document.visibilityState==='visible'){
      crashRealtimeFrame=requestAnimationFrame(renderCrashRealtimeFrame);
    }
    // Не отменяем уже идущий актуальный запрос: это и было источником мигания таймера.
    if(!crashStateRequestInFlight) refreshCrashState(true,false,viewSession);
  }
  let crashStarted=false;

  async function placeBet(amount){
    if(!crashRealtimeState||balance<amount||crashPrizePending)return false;
    if(Number(amount)<1) return false;
    const phase=deriveCrashDisplayPhase(crashRealtimeState);
    if(phase!=='countdown') return false;
    const prevBalance=balance;
    const prevPrizePending=crashPrizePending;
    const prevPrizeGift=crashPrizeGift;
    const prevBetActive=crashBetActive;
    const prevBetAmount=crashBetAmount;
    const prevBetSettled=crashBetSettled;
    const prevSettledPayout=crashSettledPayout;
    const prevRoundLocked=crashRoundLocked;
    const prevLocalBetRoundId=crashLocalBetRoundId;
    const betBtn=document.getElementById('crashBetBtn');

    updateBalance(balance-amount);
    crashRoundLocked=true;
    crashLocalBetRoundId=Number(crashRealtimeState?.roundId||0);
    crashBetSyncPending=true;
    crashCashoutBusy=false;
    crashBetSettled=false;
    crashSettledPayout=0;
    crashBetActive=true;
    crashBetAmount=amount;
    crashPrizeGift=null;
    crashPrizePending=false;
    setCrashPlayerState(null);
    hideCrashPrize();
    if(crashRoundLive){betBtn.classList.remove('dim')}else{betBtn.classList.add('dim')}
    betBtn.innerHTML=t('cashOut')+' '+formatStars(amount)+' <img src="assets/star.png" alt="">';
    renderCrashPlayerCard(amount,true);
    renderCrashPlayerWin(amount,null);

    let data=null;
    try{
      const resp=await fetch(API_BASE+'/api/crash/bet',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({amount, roundId:crashRealtimeState?.roundId||0, clientPhase:phase}),
      });
      data=await resp.json().catch(()=>({}));
      if(!resp.ok) throw new Error(data.error||'Round already started');
      crashPrizeModalAutoKey='';
      crashPrizeResolveToken='';
      if(data.state&&!isStaleCrashState(data.state)){
        markCrashStateApplied(data.state);
        crashServerOffsetMs=Number(data.state.serverNow||Date.now())-Date.now();
        const prevState=crashRealtimeState;
        crashRealtimeState=data.state;
        applyCrashRoundBoundary(prevState,data.state);
        syncCrashViewerBet(data.state);
        maybeOpenCrashResultSheet(data.state);
        renderCrashHistoryState(data.state);
        renderCrashOtherBets(data.state.activeBets||[],data.state);
        updateCrashWaitLabel(data.state.betsCount||0);
      }else{
        await refreshCrashState(true);
      }
      if(Number.isFinite(Number(data?.newBalance))) updateBalance(Number(data.newBalance));
      crashBetSyncPending=false;
      return true;
    }catch(e){
      updateBalance(prevBalance);
      crashPrizePending=prevPrizePending;
      crashPrizeGift=prevPrizeGift;
      crashBetActive=prevBetActive;
      crashBetAmount=prevBetAmount;
      crashBetSettled=prevBetSettled;
      crashSettledPayout=prevSettledPayout;
      crashRoundLocked=prevRoundLocked;
      crashLocalBetRoundId=prevLocalBetRoundId;
      crashBetSyncPending=false;
      crashCashoutBusy=false;
      if(prevPrizePending&&prevPrizeGift) showCrashPrize(prevPrizeGift);
      else hideCrashPrize();
      if(prevBetActive&&prevBetAmount){
        renderCrashPlayerCard(prevBetAmount);
        renderCrashPlayerWin(prevBetSettled?prevSettledPayout:prevBetAmount,prevPrizePending?prevPrizeGift:null);
      }else{
        resetCrashPlayer();
      }
      refreshCrashState(true);
      tg?.showAlert?tg.showAlert(e.message):alert(e.message);
      return false;
    }
  }

  let crashPrizeResolveBusy=false;
  async function resolveCrashPrize(mode){
    if(!crashPrizePending||!crashPrizeGift||crashPrizeResolveBusy)return false;
    crashPrizeResolveBusy=true;
    dismissKeyboard();

    const prize=normalizeInventoryGift(crashPrizeGift,'temp_claim_'+Date.now());
    const prevBalance=balance;
    const prevItems=[...inventoryItems];
    const prevPrizePending=crashPrizePending;
    const prevPrizeGift=crashPrizeGift;
    const prevBetActive=crashBetActive;
    const prevBetAmount=crashBetAmount;
    const prevSettledPayout=crashSettledPayout;

    crashPrizePending=false;
    crashBetActive=false;
    crashPrizeGift=prevPrizeGift;
    crashCashoutBusy=false;
    crashBetSettled=true;
    crashRoundLocked=true;
    crashPrizeResolveToken=getCrashPrizeKey(prevPrizeGift||prize);
    hideCrashPrize();
    giftModalOverlay.classList.remove('open');
    if(crashBetAmount>0){
      renderCrashPlayerCard(crashBetAmount);
      renderCrashPlayerWin(crashSettledPayout||Number(prize.price||0)||crashBetAmount,prize);
      setCrashPlayerState('win');
    }

    if(mode==='sell'){
      updateBalance(balance+Number(prize.price||0));
    }else{
      inventoryItems=[prize,...inventoryItems.filter(item=>String(item.id)!==String(prize.id))];
      renderInventory();
    }

    try{
      const resp=await fetch(API_BASE+'/api/crash/prize/resolve',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({action:mode}),
      });
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) throw new Error(data.error||'Prize resolve failed');

      crashPrizeModalAutoKey='';
      crashPrizeResolveToken='';
      if(mode==='sell'){
        if(Number.isFinite(Number(data.newBalance))) updateBalance(Number(data.newBalance));
      }else{
        const confirmedGift=normalizeInventoryGift({
          ...prize,
          ...(data.claimedGift||{}),
          giftId:data?.claimedGift?.giftId||data?.claimedGift?.gift_id||prize.giftId||prize.id,
          name:data?.claimedGift?.name||prize.name,
          price:Number(data?.claimedGift?.price||prize.price||0),
          image:data?.claimedGift?.image||data?.claimedGift?.gift_image||prize.image||''
        },prize.id);
        if(Array.isArray(data.items) && data.items.length){
          const rest=data.items
            .map(item=>normalizeInventoryGift(item))
            .filter(Boolean)
            .filter(item=>!(String(item.id)===String(confirmedGift.id)|| (String(item.giftId||'')===String(confirmedGift.giftId||'') && Number(item.price||0)===Number(confirmedGift.price||0) && String(item.name||'')===String(confirmedGift.name||''))));
          inventoryItems=[confirmedGift,...rest];
        }else{
          inventoryItems=[confirmedGift,...inventoryItems.filter(item=>String(item.id)!==String(prize.id))];
        }
        renderInventory();
      }

      if(data.state&&!isStaleCrashState(data.state)){
        markCrashStateApplied(data.state);
        crashServerOffsetMs=Number(data.state.serverNow||Date.now())-Date.now();
        const prevState=crashRealtimeState;
        crashRealtimeState=data.state;
        applyCrashRoundBoundary(prevState,data.state);
        syncCrashViewerBet(data.state);
        maybeOpenCrashResultSheet(data.state);
        renderCrashHistoryState(data.state);
        renderCrashOtherBets(data.state.activeBets||[],data.state);
        updateCrashWaitLabel(data.state.betsCount||0);
      }else{
        refreshCrashState(true);
      }

      // Приз подтверждён: помечаем раунд закрытым, чтобы запоздалый state не вернул карточку ставки.
      crashResultDismissedRoundId=Number(data?.state?.roundId||crashRealtimeState?.roundId||0);
      resetCrashPlayer();
      return true;
    }catch(err){
      updateBalance(prevBalance);
      inventoryItems=prevItems;
      renderInventory();
      crashPrizePending=prevPrizePending;
      crashPrizeGift=prevPrizeGift;
      crashBetActive=prevBetActive;
      crashBetAmount=prevBetAmount;
      crashSettledPayout=prevSettledPayout;
      crashBetSettled=true;
      crashRoundLocked=true;
      crashPrizeResolveToken='';
      if(prevPrizePending&&prevPrizeGift){
        showCrashPrize(prevPrizeGift);
        // Keep the result bottom sheet as the only crash-prize UI.
        if(prevBetAmount>0){
          renderCrashPlayerCard(prevBetAmount);
          renderCrashPlayerWin(prevSettledPayout||crashSettledPayout||prevBetAmount,null);
          setCrashPlayerState('win');
        }
      }
      tg?.showAlert?tg.showAlert(err.message):alert(err.message);
      return false;
    }finally{
      crashPrizeResolveBusy=false;
    }
  }

  function crashRenderedGiftForCashout(){
    const payout=Math.max(0,Math.floor(Number(crashBetAmount||0)*computeCrashMultiplier(crashRealtimeState)));
    if(payout>0){
      return withCrashGiftValue(getCrashPreviewGift(payout)||null,payout);
    }
    const fallbackAmount=crashRenderedWinAmount||crashSettledPayout||crashBetAmount||0;
    return withCrashGiftValue(getCrashPreviewGift(fallbackAmount)||null,fallbackAmount);
  }

  async function cashOut(){
    const roundId=Number(crashRealtimeState?.roundId||0);
    // Do not reject a tap locally from an out-of-date frame. The server is the
    // authority and must receive every cashout attempt immediately.
    if(!crashBetActive||crashCashoutBusy||!roundId)return;
    if(Number(crashCashoutRequestedRoundId||0)===roundId)return;

    // IMPORTANT: never block a cashout tap on a pre-flight state refresh.
    // The backend owns round validation. Waiting for /state here used to add up
    // to ~1.2s, which both changed the shown payout and could turn a valid
    // last-second tap into CRASH_TOO_LATE before the cashout request was sent.
    crashCashoutRequestedRoundId=roundId;
    const betBtn=document.getElementById('crashBetBtn');
    const prevBalance=balance;
    const prevPrizePending=crashPrizePending;
    const prevPrizeGift=crashPrizeGift;
    const prevBetActive=crashBetActive;
    const prevBetSettled=crashBetSettled;
    const prevSettledPayout=crashSettledPayout;
    // Freeze exactly what the player saw on the card at tap time. The server
    // validates this requested payout against the maximum payout at HTTP arrival,
    // so the client cannot increase winnings by editing this value.
    const computedPayout=Math.max(0,Math.floor(Number(crashBetAmount||0)*computeCrashMultiplier(crashRealtimeState)));
    const renderedPayout=Math.max(0,Math.floor(Number(crashRenderedWinAmount||0)));
    const livePayout=renderedPayout>=Number(crashBetAmount||0)?renderedPayout:computedPayout;
    const renderedGift=(crashRenderedWinGift&&Math.abs(Number(crashRenderedWinAmount||0)-livePayout)<=Math.max(24,Math.floor(livePayout*0.08))) ? crashRenderedWinGift : null;
    const previewGift=withCrashGiftValue(getCrashPreviewGift(livePayout)||null,livePayout);
    const visualGift=withCrashGiftValue(renderedGift||null,livePayout)||previewGift;
    const optimisticGift=visualGift||null;

    crashCashoutBusy=true;
    crashBetActive=false;
    crashRoundLocked=true;
    crashLocalBetRoundId=Number(crashRealtimeState?.roundId||crashLocalBetRoundId||0);
    crashBetSettled=false;
    crashSettledPayout=livePayout;
    crashPrizeGift=null;
    crashPrizePending=false;
    renderCrashPlayerCard(crashBetAmount);
    renderCrashPlayerWin(livePayout,null);
    setCrashPlayerState(null);
    betBtn.classList.add('dim');
    betBtn.textContent=t('cashOut')+'…';

    try{
      const resp=await fetch(API_BASE+'/api/crash/cashout',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        cache:'no-store',
        keepalive:true,
        priority:'high',
        body:JSON.stringify({ roundId, requestedPayout:livePayout }),
      });
      const data=await readApiJson(resp);
      if(!resp.ok){
        if(data.code==='CRASH_TOO_LATE'){
          crashCashoutBusy=false;
          crashBetActive=false;
          if(data.state&&!isStaleCrashState(data.state)){
            markCrashStateApplied(data.state);
            crashServerOffsetMs=Number(data.state.serverNow||Date.now())-Date.now();
            const prevState=crashRealtimeState;
            crashRealtimeState=data.state;
            applyCrashRoundBoundary(prevState,data.state);
            syncCrashViewerBet(data.state);
            maybeOpenCrashResultSheet(data.state);
            renderCrashHistoryState(data.state);
            renderCrashOtherBets(data.state.activeBets||[],data.state);
            updateCrashWaitLabel(data.state.betsCount||0);
          }else{
            await refreshCrashState(true,true);
          }
          return;
        }
        throw new Error(data.error||'Cash out failed');
      }

      if(data.state&&!isStaleCrashState(data.state)){
        markCrashStateApplied(data.state);
        crashServerOffsetMs=Number(data.state.serverNow||Date.now())-Date.now();
        const prevState=crashRealtimeState;
        crashRealtimeState=data.state;
        applyCrashRoundBoundary(prevState,data.state);
        syncCrashViewerBet(data.state);
        maybeOpenCrashResultSheet(data.state);
        renderCrashHistoryState(data.state);
        renderCrashOtherBets(data.state.activeBets||[],data.state);
        updateCrashWaitLabel(data.state.betsCount||0);
      }

      const win=Number(data.payout||0);

      crashCashoutBusy=false;
      crashBetActive=false;
      crashRoundLocked=true;
      crashBetSettled=true;
      crashSettledPayout=win;
      const finalPrize=data.pendingPrize||data.awardedGift||null;
      if(finalPrize){
        // A gift cashout must NOT visually credit Stars. The balance only changes
        // after the player explicitly chooses Sell in the prize modal.
        enterPendingCrashPrize(finalPrize,win,crashBetAmount,{force:true,autoOpen:false});
        return;
      }

      // Fallback cashout without a gift: use the authoritative server balance.
      if(Number.isFinite(Number(data.newBalance))) updateBalance(Number(data.newBalance));
      else updateBalance(prevBalance);

      crashPrizeGift=null;
      hideCrashPrize();
      renderCrashPlayerWin(win,null);
      setCrashPlayerState('win');
      betBtn.classList.add('dim');
      betBtn.textContent=t('placeBet');
    }catch(e){
      crashCashoutBusy=false;
      if(String(crashRealtimeState?.phase||'')==='live'&&Number(crashRealtimeState?.roundId||0)===roundId){
        crashCashoutRequestedRoundId=0;
      }
      crashPrizePending=prevPrizePending;
      crashPrizeGift=prevPrizeGift;
      crashBetActive=prevBetActive;
      crashBetSettled=prevBetSettled;
      crashSettledPayout=prevSettledPayout;
      if(prevPrizePending&&prevPrizeGift) showCrashPrize(prevPrizeGift);
      else hideCrashPrize();
      if(prevBetActive){
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(crashBetAmount,null);
        setCrashPlayerState(null);
        betBtn.classList.remove('dim');
        betBtn.innerHTML=t('cashOut')+' '+formatStars(crashBetAmount)+' <img src="assets/star.png" alt="">';
      }else if(prevBetSettled){
        renderCrashPlayerCard(crashBetAmount);
        renderCrashPlayerWin(prevSettledPayout,prevPrizeGift);
      }else{
        resetCrashPlayer();
      }
      updateBalance(prevBalance);
      tg?.showAlert?tg.showAlert(e.message):alert(e.message);
    }
  }

  function bindFastTap(node,handler){
    if(!node)return;
    let tapLock=false;
    const wrapped=(e)=>{
      e.preventDefault?.();
      e.stopPropagation?.();
      if(tapLock)return;
      tapLock=true;
      setTimeout(()=>{tapLock=false},260);
      handler(e);
    };
    ['pointerdown','click'].forEach((evt)=>node.addEventListener(evt,wrapped,{passive:false}));
  }
  bindFastTap(crashResultAction,()=>{
    if(crashResultSheetWon) claimCrashResultPrizeAndClose(false);
    else closeCrashResultSheet();
  });
  bindFastTap(crashPrizeSellBtn,()=>resolveCrashPrize('sell'));
  bindFastTap(crashPrizeClaimBtn,()=>resolveCrashPrize('claim'));
  bindFastTap(giftModalSellBtn,()=>resolveCrashPrize('sell'));
  bindFastTap(giftModalClaimBtn,()=>resolveCrashPrize('claim'));
  document.querySelector('.crash-player-prize-card')?.addEventListener('click',()=>{});
  document.getElementById('crashPlayer')?.addEventListener('click',()=>{});
  giftModalOverlay.addEventListener('click',e=>{if(e.target===giftModalOverlay) giftModalOverlay.classList.remove('open')});

  function moveIndicator(el,animate){
    if(!el)return;
    const r=el.getBoundingClientRect(),n=nav.getBoundingClientRect(),bubble=ind.getBoundingClientRect();
    const x=r.left+r.width/2-n.left-bubble.width/2,y=r.top+r.height/2-n.top-bubble.height/2;
    if(!animate)ind.style.transition='none';
    ind.style.transform=`translate(${x}px,${y}px)`;
    if(!animate)requestAnimationFrame(()=>{ind.style.transition=''});
  }
