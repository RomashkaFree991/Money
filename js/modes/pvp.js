  const pvpTimerEl=document.getElementById('pvpTimer');
  const pvpWheelEl=document.getElementById('pvpWheel');
  const pvpGameTitleEl=document.getElementById('pvpGameTitle');
  const pvpBankValueEl=document.getElementById('pvpBankValue');
  const pvpEmptyEl=document.getElementById('pvpEmpty');
  const pvpBetsListEl=document.getElementById('pvpBetsList');
  const pvpBetDock=document.getElementById('pvpBetDock');
  const pvpBetBtn=document.getElementById('pvpBetBtn');
  const pvpResultOverlay=document.getElementById('pvpResultOverlay');
  const pvpResultAvatar=document.getElementById('pvpResultAvatar');
  const pvpResultName=document.getElementById('pvpResultName');
  const pvpResultChance=document.getElementById('pvpResultChance');
  const pvpResultPrize=document.getElementById('pvpResultPrize');
  const pvpResultHeading=document.getElementById('pvpResultHeading');
  const pvpResultCountdown=document.getElementById('pvpResultCountdown');
  const pvpResultProgressFill=document.getElementById('pvpResultProgressFill');
  const pvpResultClose=document.getElementById('pvpResultClose');
  const pvpRoundHashEl=document.getElementById('pvpRoundHash');
  const pvpRoundHashValueEl=document.getElementById('pvpRoundHashValue');
  const PVP_COLORS=['#FF9500','#0A84FF','#FF3B87','#34C759','#AF52DE','#5AC8FA','#FFCC00','#64D2FF'];
  let pvpPollTimer=null;
  let pvpClockTimer=null;
  let pvpStateRequest=false;
  let pvpStateRequestToken=0;
  let pvpStateRequestController=null;
  let pvpLastAppliedServerNow=0;
  let pvpCountdownRoundId=0;
  let pvpLastCountdownValue=-1;
  let pvpState=null;
  let pvpPlayers=[];
  let pvpWheelRotation=0;
  let pvpDisplayedResultId=0;
  let pvpResultHideTimer=null;
  let pvpResultRevealTimer=null;
  let pvpResultCountdownTimer=null;
  let pvpResultShowing=false;
  let pvpServerOffsetMs=0;
  const PVP_WARM_STATE_KEY='giftpep.pvp.warm.v1';
  const PVP_WARM_STATE_MAX_AGE_MS=45_000;

  function savePvpWarmState(state){
    try{
      const safeState={...state,lastResult:null};
      localStorage.setItem(PVP_WARM_STATE_KEY,JSON.stringify({savedAt:Date.now(),state:safeState}));
    }catch(_){}
  }
  function restorePvpWarmState(){
    if(pvpState)return true;
    try{
      const stored=JSON.parse(localStorage.getItem(PVP_WARM_STATE_KEY)||'null');
      if(!stored?.state?.round||Date.now()-Number(stored.savedAt||0)>PVP_WARM_STATE_MAX_AGE_MS)return false;
      pvpState=stored.state;
      pvpServerOffsetMs=Number(pvpState.serverNow||Date.now())-Date.now();
      pvpPlayers=Array.isArray(pvpState.bets)?pvpState.bets:[];
      renderPvpRoundHash(pvpState.roundHash);
      if(!pvpState.roundHash)restorePvpRoundHash(pvpState.round);
      renderPvpBet();renderPvpClock();
      return true;
    }catch(_){return false;}
  }

  function renderPvpRoundHash(hash){
    const value=String(hash||'').trim();
    if(pvpRoundHashValueEl)pvpRoundHashValueEl.textContent=value?value.slice(0,17)+'…'+value.slice(-6):'';
    if(pvpRoundHashEl){
      pvpRoundHashEl.dataset.hash=value;
      pvpRoundHashEl.hidden=!value;
    }
  }
  async function restorePvpRoundHash(round){
    const roundId=Number(round?.id||0);
    const anchor=Number(round?.countdownEndsAt||round?.createdAt||round?.created_at||0);
    if(!roundId||!anchor||!window.crypto?.subtle)return;
    try{
      // Формула намеренно совпадает с publicRoundHash() на сервере. Она нужна
      // только для старого localStorage-снимка, в котором ещё нет roundHash.
      const raw='giftpep:pvp:'+roundId+':'+anchor;
      const digest=await window.crypto.subtle.digest('SHA-256',new window.TextEncoder().encode(raw));
      const value=Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if(Number(pvpState?.round?.id||0)===roundId&&!pvpRoundHashEl?.dataset.hash)renderPvpRoundHash(value);
    }catch(_){ }
  }
  pvpRoundHashEl?.addEventListener('click',()=>copyRoundHash(pvpRoundHashEl.dataset.hash,pvpRoundHashEl));

  function pvpTotalBank(){return pvpPlayers.reduce((total,player)=>total+Math.max(0,Number(player.amount||0)),0);}
  function pvpChance(player){const total=pvpTotalBank();return total?Number(player.amount||0)*100/total:0;}
  function pvpChanceLabel(player){const chance=pvpChance(player);return 'Шанс '+(chance>=99.995?'100':chance.toFixed(chance<10?1:0))+'%';}
  function pvpColor(player){return PVP_COLORS[Math.abs(Number(player.colorIndex||0))%PVP_COLORS.length];}
  function renderPvpWheel(){
    if(!pvpWheelEl)return;
    pvpWheelEl.replaceChildren();
    const total=pvpTotalBank();
    if(!total){pvpWheelEl.style.background='repeating-conic-gradient(from -18deg,#46474d 0deg 36deg,#1b1c20 36deg 72deg)';return;}
    let cursor=0;const stops=[];
    const orderedPlayers=[...pvpPlayers].sort((a,b)=>Number(a.colorIndex||0)-Number(b.colorIndex||0));
    for(const player of orderedPlayers){
      const part=Math.max(0,Number(player.amount||0))/total*360;
      stops.push(pvpColor(player)+' '+cursor+'deg '+(cursor+part)+'deg');
      // conic-gradient считает 0° сверху и идёт по часовой стрелке. У CSS
      // координат x/y другая система, поэтому прежние cos/sin сдвигали аватар
      // примерно на четверть колеса — он оказывался на чужом цвете.
      const centerDeg=cursor+part/2-90;
      const radians=centerDeg*Math.PI/180;
      const marker=document.createElement('span');
      marker.className='pvp-wheel-avatar';
      marker.style.left=(50+Math.sin(radians)*33.5)+'%';
      marker.style.top=(50-Math.cos(radians)*33.5)+'%';
      marker.style.background=pvpColor(player);
      if(player.photoUrl){
        const image=document.createElement('img');image.src=player.photoUrl;image.alt='';marker.append(image);
      }else marker.textContent=String(player.firstName||'U').slice(0,1).toUpperCase();
      pvpWheelEl.append(marker);
      cursor+=part;
    }
    pvpWheelEl.style.background='conic-gradient(from -90deg,'+stops.join(',')+')';
  }
  function renderPvpBet(){
    const total=pvpTotalBank();
    if(pvpBankValueEl)pvpBankValueEl.textContent=String(total||0);
    renderPvpWheel();
    if(!pvpBetsListEl||!pvpEmptyEl)return;
    pvpBetsListEl.replaceChildren();
    if(!pvpPlayers.length){pvpEmptyEl.style.display='grid';return;}
    pvpEmptyEl.style.display='none';
    for(const player of pvpPlayers){
      const row=document.createElement('div');row.className='pvp-history-row';
      const avatar=document.createElement('span');avatar.className='pvp-history-avatar';avatar.style.background=pvpColor(player);
      if(player.photoUrl){const image=document.createElement('img');image.src=player.photoUrl;image.alt='';avatar.append(image);}
      else avatar.textContent=String(player.firstName||'U').slice(0,1).toUpperCase();
      const meta=document.createElement('span');meta.className='pvp-player-meta';
      const name=document.createElement('span');name.className='pvp-player-name';name.textContent=player.firstName||'User';
      const chance=document.createElement('span');chance.className='pvp-player-chance';chance.textContent=pvpChanceLabel(player);
      meta.append(name,chance);
      const sum=document.createElement('span');sum.className='pvp-history-sum';sum.append(document.createTextNode(String(player.amount)+' '));
      const star=document.createElement('img');star.src='assets/star.png';star.alt='';sum.append(star);
      row.append(avatar,meta,sum);pvpBetsListEl.append(row);
    }
  }
  function pvpCanAcceptBets(){
    if(pvpResultShowing)return false;
    const round=pvpState?.round;
    if(!round)return false;
    if(String(round.phase||'')==='waiting')return true;
    return String(round.phase||'')==='countdown'
      && Number(round.countdownEndsAt||0)>(Date.now()+pvpServerOffsetMs);
  }
  function syncPvpBetAvailability(){
    if(!pvpBetBtn)return;
    const allowed=pvpCanAcceptBets();
    pvpBetBtn.disabled=!allowed;
    pvpBetBtn.textContent=allowed?'Сделать ставку':'Игра началась';
  }
  function renderPvpClock(){
    if(!pvpTimerEl||!pvpState?.round)return;
    syncPvpBetAvailability();
    const round=pvpState.round;
    const roundId=Number(round.id||0);
    if(roundId!==pvpCountdownRoundId){
      pvpCountdownRoundId=roundId;
      pvpLastCountdownValue=-1;
    }
    if(round.phase!=='countdown'){
      pvpWheelEl?.classList.remove('running');
      pvpLastCountdownValue=-1;
      pvpTimerEl.classList.add('waiting');pvpTimerEl.textContent='Ожидание';
      if(pvpGameTitleEl)pvpGameTitleEl.textContent='Игра #'+round.id;
      return;
    }
    const left=Math.max(0,Number(round.countdownEndsAt||0)-(Date.now()+pvpServerOffsetMs));
    const calculated=Math.ceil(left/1000);
    // Даже если поздний HTTP-ответ пришёл после более нового, цифра в том же
    // серверном раунде не увеличивается и не повторяется назад.
    const shown=pvpLastCountdownValue>=0?Math.min(pvpLastCountdownValue,calculated):calculated;
    pvpLastCountdownValue=shown;
    pvpWheelEl?.classList.add('running');
    pvpTimerEl.classList.remove('waiting');pvpTimerEl.textContent=String(shown);
    if(pvpGameTitleEl)pvpGameTitleEl.textContent='Игра #'+round.id;
  }
  function resetPvpWheel(){
    if(!pvpWheelEl)return;
    pvpWheelEl.classList.remove('running');
    pvpWheelEl.style.removeProperty('transition');
    pvpWheelEl.style.removeProperty('transform');
    pvpWheelRotation=0;
  }
  function spinPvpWheelToWinner(players,winnerId){
    if(!pvpWheelEl)return 0;
    const total=players.reduce((sum,player)=>sum+Math.max(0,Number(player.amount||0)),0);
    if(!total)return 0;
    let cursor=0;let center=null;
    for(const player of players){
      const sector=Math.max(0,Number(player.amount||0))/total*360;
      if(Number(player.userId)===Number(winnerId)){center=cursor+sector/2;break;}
      cursor+=sector;
    }
    if(center===null)return 0;
    // CSS conic-gradient starts at the top; the pointer is also at the top.
    // Наши секторы начинаются с from -90deg, поэтому нужен сдвиг +90°.
    const target=((90-center)%360+360)%360;
    pvpWheelEl.classList.remove('running');
    pvpWheelEl.style.transition='none';
    pvpWheelEl.style.transform='rotate(0deg)';
    void pvpWheelEl.offsetWidth;
    pvpWheelRotation=1440+target;
    pvpWheelEl.style.transition='transform 4.2s cubic-bezier(.12,.75,.12,1)';
    pvpWheelEl.style.transform='rotate('+pvpWheelRotation+'deg)';
    return 4250;
  }
  function closePvpResult(){
    if(pvpResultHideTimer)clearTimeout(pvpResultHideTimer);
    if(pvpResultRevealTimer)clearTimeout(pvpResultRevealTimer);
    if(pvpResultCountdownTimer)clearInterval(pvpResultCountdownTimer);
    pvpResultOverlay?.classList.remove('open');
    pvpResultShowing=false;
    syncPvpBetAvailability();
    resetPvpWheel();
    refreshPvpState();
  }
  function startPvpResultCountdown(){
    const startedAt=Date.now();
    const duration=5000;
    if(pvpResultCountdownTimer)clearInterval(pvpResultCountdownTimer);
    const tick=()=>{
      const elapsed=Math.min(duration,Date.now()-startedAt);
      const left=Math.max(0,Math.ceil((duration-elapsed)/1000));
      if(pvpResultCountdown)pvpResultCountdown.textContent=String(left);
      if(pvpResultProgressFill)pvpResultProgressFill.style.width=(100-(elapsed/duration*100))+'%';
      if(elapsed>=duration){clearInterval(pvpResultCountdownTimer);closePvpResult();}
    };
    tick();pvpResultCountdownTimer=setInterval(tick,80);
  }
  function showPvpResult(result){
    if(!result||!result.roundId||Number(result.roundId)===pvpDisplayedResultId)return;
    const players=Array.isArray(result.bets)?result.bets:[];
    if(!players.length||!Number(result.winnerUserId))return;
    pvpDisplayedResultId=Number(result.roundId);
    pvpResultShowing=true;
    syncPvpBetAvailability();
    pvpPlayers=players;
    renderPvpBet();
    const winner=players.find(player=>Number(player.userId)===Number(result.winnerUserId))||result.winner||{};
    const winnerIsCurrentUser=Number(winner.userId||winner.user_id)===Number(tgUserId);
    if(winnerIsCurrentUser)playAppSound('reward');
    const winnerColor=pvpColor({colorIndex:result.winningColorIndex});
    if(pvpResultAvatar){pvpResultAvatar.style.background=winnerColor;if(winner.photoUrl||winner.photo_url){pvpResultAvatar.src=winner.photoUrl||winner.photo_url;pvpResultAvatar.style.padding='0';}else{pvpResultAvatar.removeAttribute('src');pvpResultAvatar.style.padding='12px';}}
    if(pvpResultHeading)pvpResultHeading.textContent='You won';
    if(pvpResultName)pvpResultName.textContent=winner.firstName||winner.first_name||'Победитель';
    if(pvpResultChance)pvpResultChance.textContent='Шанс '+String(result.winnerChance||0)+'%';
    if(pvpResultPrize)pvpResultPrize.textContent='+'+String(result.prize||0);
    if(pvpResultHideTimer)clearTimeout(pvpResultHideTimer);
    if(pvpResultRevealTimer)clearTimeout(pvpResultRevealTimer);
    const reveal=()=>{pvpResultOverlay?.classList.add('open');startPvpResultCountdown();};
    const spinDuration=spinPvpWheelToWinner(players,result.winnerUserId);
    pvpResultRevealTimer=setTimeout(reveal,spinDuration);
  }
  function applyPvpState(nextState){
    if(!nextState?.round)return;
    const nextRoundId=Number(nextState.round.id||0);
    const previousRoundId=Number(pvpState?.round?.id||0);
    const stamp=Number(nextState.serverNow||0);
    // Не даём старому ответу перезаписать новый раунд или откатить его часы.
    if(previousRoundId&&nextRoundId<previousRoundId)return;
    if(nextRoundId===previousRoundId&&stamp&&pvpLastAppliedServerNow&&stamp<pvpLastAppliedServerNow)return;
    if(stamp){
      pvpLastAppliedServerNow=Math.max(pvpLastAppliedServerNow,stamp);
      pvpServerOffsetMs=stamp-Date.now();
    }
    pvpState=nextState;
    savePvpWarmState(nextState);
    renderPvpRoundHash(nextState.roundHash);
    if(!nextState.roundHash)restorePvpRoundHash(nextState.round);
    if(!pvpResultShowing){
      pvpPlayers=Array.isArray(nextState.bets)?nextState.bets:[];
      if(previousRoundId&&previousRoundId!==Number(nextState.round.id))resetPvpWheel();
      renderPvpBet();
    }
    renderPvpClock();
    if(currentTab==='pvp')showPvpResult(nextState.lastResult);
  }
  async function refreshPvpState(allowBackground=false){
    if(pvpStateRequest||(!allowBackground&&currentTab!=='pvp'))return;
    const token=++pvpStateRequestToken;
    const controller=new AbortController();
    pvpStateRequestController=controller;
    pvpStateRequest=true;
    try{
      const response=await fetch(API_BASE+'/api/pvp/state?ts='+Date.now(),{
        headers:{'x-init-data':tg?.initData||''},cache:'no-store',signal:controller.signal
      });
      const data=await readApiJson(response);
      if(token!==pvpStateRequestToken)return;
      if(!response.ok)throw new Error(data.error||'PVP unavailable');
      applyPvpState(data);
    }catch(error){
      if(error?.name!=='AbortError')console.warn('PVP state error:',error?.message||error);
    }finally{
      if(token===pvpStateRequestToken){
        pvpStateRequest=false;
        if(pvpStateRequestController===controller)pvpStateRequestController=null;
      }
    }
  }
  function startPvpDemo(){
    if(pvpPollTimer)return;
    restorePvpWarmState();
    if(pvpState){
      renderPvpBet();
      renderPvpClock();
      showPvpResult(pvpState.lastResult);
    }
    refreshPvpState();
    pvpPollTimer=setInterval(refreshPvpState,1000);
    pvpClockTimer=setInterval(renderPvpClock,200);
  }
  function stopPvpDemo(){
    if(pvpPollTimer){clearInterval(pvpPollTimer);pvpPollTimer=null;}
    if(pvpClockTimer){clearInterval(pvpClockTimer);pvpClockTimer=null;}
    if(pvpResultRevealTimer)clearTimeout(pvpResultRevealTimer);
    if(pvpResultCountdownTimer)clearInterval(pvpResultCountdownTimer);
    pvpResultOverlay?.classList.remove('open');
    pvpResultShowing=false;
    resetPvpWheel();
    if(pvpStateRequestController){
      try{pvpStateRequestController.abort()}catch(_){}
      pvpStateRequestController=null;
    }
    pvpStateRequestToken+=1;
    pvpStateRequest=false;
  }
