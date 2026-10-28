  // ═══════════════════════ MINES ═══════════════════════
  // Поле и мины живут на сервере. Клиент только рисует открытые клетки,
  // показывает коэффициенты и отправляет ходы.
  const MINES_CELLS=25;
  const MINES_MIN=3;
  const MINES_MAX=12;
  const MINES_RTP=0.96;
  const MINES_COUNT_KEY='giftpep.mines.count';
  const MINES_BET_KEY='giftpep.mines.bet';
  const minesBoardEl=document.getElementById('minesBoard');
  const minesCoefRowEl=document.getElementById('minesCoefRow');
  const minesStatusEl=document.getElementById('minesStatus');
  const minesBetInput=document.getElementById('minesBetInput');
  const minesCountValueEl=document.getElementById('minesCountValue');
  const minesCountChipsEl=document.getElementById('minesCountChips');
  const minesActionBtn=document.getElementById('minesActionBtn');
  const minesHashBtn=document.getElementById('minesRoundHash');
  const minesHashValueEl=document.getElementById('minesRoundHashValue');
  const minesResultOverlay=document.getElementById('minesResultOverlay');
  const MINES_SAFE_SVG='<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="mhg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a8a"/><stop offset=".55" stop-color="#e3172f"/><stop offset="1" stop-color="#8f0a1d"/></linearGradient></defs><path d="M32 54C18 43 8 35 8 23.5 8 16 13.8 10 21 10c4.8 0 8.6 2.6 11 6.4C34.4 12.6 38.2 10 43 10c7.2 0 13 6 13 13.5C56 35 46 43 32 54z" fill="url(#mhg)" stroke="#ffd0d6" stroke-width="2.5" stroke-linejoin="round"/><ellipse cx="21" cy="21" rx="5" ry="3.2" fill="#fff" opacity=".55" transform="rotate(-30 21 21)"/></svg>';
  const MINES_BOMB_SVG='<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="mbg" cx="38%" cy="35%" r="70%"><stop offset="0" stop-color="#6b6f7d"/><stop offset=".6" stop-color="#22242c"/><stop offset="1" stop-color="#0b0c10"/></radialGradient></defs><path d="M40 14l6-6M44 18l7-2M42 12l1-7" stroke="#ffb23d" stroke-width="3" stroke-linecap="round"/><rect x="33" y="14" width="10" height="8" rx="2" transform="rotate(40 38 18)" fill="#3a3d48"/><circle cx="29" cy="37" r="19" fill="url(#mbg)" stroke="#9aa0b4" stroke-width="2"/><circle cx="22" cy="30" r="4.5" fill="#fff" opacity=".35"/></svg>';

  let minesConfig=null;
  let minesGame=null;
  let minesFinished=null;
  let minesBusy=false;
  let minesCount=Math.min(MINES_MAX,Math.max(MINES_MIN,Number(localStorage.getItem(MINES_COUNT_KEY))||3));
  let minesPendingCell=-1;
  let minesStateLoadedAt=0;
  if(minesBetInput){
    const savedBet=Number(localStorage.getItem(MINES_BET_KEY)||0);
    minesBetInput.value=savedBet>0?String(savedBet):'100';
  }

  function minesMultiplier(count,opened){
    const table=minesConfig?.tables?.[count];
    if(Array.isArray(table)&&opened>0)return Number(table[opened-1]||1);
    let p=1;
    for(let i=0;i<opened;i++)p*=(MINES_CELLS-count-i)/(MINES_CELLS-i);
    return opened>0&&p>0?Math.floor(MINES_RTP/p*100)/100:1;
  }
  function minesFloor(){return Number(minesConfig?.giftFloor||0)||getNftGiftFloorStars();}
  function minesMaxPayout(){return Number(minesConfig?.maxPayout||MAX_GIFT_PRICE_STARS);}
  function minesActiveCount(){return minesGame?Number(minesGame.minesCount):minesCount;}
  function formatMinesMultiplier(value){
    const n=Number(value||1);
    if(n>=1000000)return 'x'+(n/1000000).toFixed(1).replace(/\.0$/,'')+'M';
    if(n>=10000)return 'x'+Math.round(n/1000)+'K';
    if(n>=100)return 'x'+Math.round(n);
    return 'x'+n.toFixed(2);
  }
  function minesBetValue(){return Math.max(0,Math.floor(Number(minesBetInput?.value||0)));}
  function minesGiftForPayout(payout){
    if(payout<minesFloor())return null;
    return getBestGiftForStars(payout,NFT_MIN_PRICE_STARS);
  }
  function minesAlert(message){
    try{tg?.HapticFeedback?.notificationOccurred?.('error');}catch(_){}
    tg?.showAlert?tg.showAlert(message):alert(message);
  }
  function minesHaptic(kind){
    try{
      if(kind==='success'||kind==='error')tg?.HapticFeedback?.notificationOccurred?.(kind);
      else tg?.HapticFeedback?.impactOccurred?.(kind||'light');
    }catch(_){}
  }

  function buildMinesBoard(){
    if(!minesBoardEl||minesBoardEl.children.length)return;
    const frag=document.createDocumentFragment();
    for(let i=0;i<MINES_CELLS;i++){
      const cell=document.createElement('button');
      cell.type='button';cell.className='mines-cell';cell.dataset.cell=String(i);
      cell.innerHTML='<span class="mines-cell-face"></span>';
      frag.appendChild(cell);
    }
    minesBoardEl.appendChild(frag);
  }

  function renderMinesBoard(){
    buildMinesBoard();
    const game=minesGame||minesFinished;
    const opened=new Set((game?.opened||[]).map(Number));
    const mines=new Set((game?.mines||[]).map(Number));
    const finished=!!(game&&game.status!=='active');
    const active=!!minesGame;
    minesBoardEl.classList.toggle('is-active',active);
    minesBoardEl.classList.toggle('is-finished',finished);
    minesBoardEl.querySelectorAll('.mines-cell').forEach(cell=>{
      const index=Number(cell.dataset.cell);
      const face=cell.querySelector('.mines-cell-face');
      let state='hidden';
      if(opened.has(index))state='safe';
      else if(finished&&mines.has(index))state=Number(game.hitCell)===index?'boom':'mine';
      else if(finished)state='dim';
      if(index===minesPendingCell&&state==='hidden')state='pending';
      if(cell.dataset.state!==state){
        cell.dataset.state=state;
        face.innerHTML=state==='safe'||state==='dim'?MINES_SAFE_SVG:(state==='mine'||state==='boom'?MINES_BOMB_SVG:'');
      }
      cell.disabled=!active||state!=='hidden'||minesBusy;
    });
  }

  function renderMinesCoefficients(){
    if(!minesCoefRowEl)return;
    const count=minesActiveCount();
    const safe=MINES_CELLS-count;
    const opened=Number((minesGame||minesFinished)?.opened?.length||0);
    const key=count+':'+safe;
    if(minesCoefRowEl.dataset.key!==key){
      minesCoefRowEl.dataset.key=key;
      minesCoefRowEl.innerHTML=Array.from({length:safe},(_,i)=>'<div class="mines-coef" data-step="'+(i+1)+'"><span class="mines-coef-step">'+(i+1)+'</span><b>'+formatMinesMultiplier(minesMultiplier(count,i+1))+'</b></div>').join('');
    }
    let current=null;
    minesCoefRowEl.querySelectorAll('.mines-coef').forEach(el=>{
      const step=Number(el.dataset.step);
      el.classList.toggle('passed',step<opened);
      el.classList.toggle('current',step===opened&&opened>0);
      el.classList.toggle('next',step===opened+1&&!!minesGame);
      if(step===Math.max(1,opened+(minesGame?1:0)))current=el;
    });
    if(current){
      const left=current.offsetLeft-minesCoefRowEl.clientWidth/2+current.clientWidth/2;
      minesCoefRowEl.scrollTo({left:Math.max(0,left),behavior:'smooth'});
    }
  }

  function renderMinesControls(){
    const locked=!!minesGame||minesBusy;
    if(minesCountValueEl)minesCountValueEl.textContent=String(minesActiveCount());
    document.getElementById('minesCountMinus').disabled=locked||minesCount<=MINES_MIN;
    document.getElementById('minesCountPlus').disabled=locked||minesCount>=MINES_MAX;
    if(minesBetInput)minesBetInput.disabled=locked;
    document.querySelectorAll('[data-mines-bet]').forEach(btn=>{btn.disabled=locked;});
    if(minesCountChipsEl){
      if(!minesCountChipsEl.children.length){
        minesCountChipsEl.innerHTML=Array.from({length:MINES_MAX-MINES_MIN+1},(_,i)=>'<button type="button" class="mines-count-chip" data-mines-count="'+(MINES_MIN+i)+'">'+(MINES_MIN+i)+'</button>').join('');
      }
      minesCountChipsEl.querySelectorAll('.mines-count-chip').forEach(chip=>{
        chip.classList.toggle('active',Number(chip.dataset.minesCount)===minesActiveCount());
        chip.disabled=locked;
      });
    }
    const hash=(minesGame||minesFinished)?.hash||'';
    if(minesHashBtn){minesHashBtn.hidden=!hash;if(minesHashValueEl)minesHashValueEl.textContent=hash?hash.slice(0,10)+'…'+hash.slice(-8):'';}
  }

  function renderMinesAction(){
    if(!minesActionBtn)return;
    minesActionBtn.classList.remove('is-cashout','is-wait','is-gift');
    minesActionBtn.disabled=minesBusy;
    if(!minesGame){
      minesActionBtn.textContent=t('minesPlay');
      return;
    }
    const opened=minesGame.opened.length;
    if(!opened){
      minesActionBtn.classList.add('is-wait');
      minesActionBtn.textContent=t('minesPickCell');
      return;
    }
    const payout=Math.min(minesMaxPayout(),Math.floor(minesGame.bet*minesMultiplier(minesGame.minesCount,opened)));
    const gift=minesGiftForPayout(payout);
    minesActionBtn.classList.add('is-cashout');
    if(gift){
      minesActionBtn.classList.add('is-gift');
      minesActionBtn.innerHTML='<img class="mines-action-gift" src="'+resolveGiftImage(gift)+'" alt=""><span>'+t('minesCashoutGift')+'</span><span class="mines-action-value">'+formatStars(payout)+' <img src="assets/star.png" alt=""></span>';
    }else{
      minesActionBtn.innerHTML='<span>'+t('minesCashout')+'</span><span class="mines-action-value">'+formatStars(payout)+' <img src="assets/star.png" alt=""></span>';
    }
  }

  function renderMinesStatus(){
    if(!minesStatusEl)return;
    if(!minesGame){
      const lost=minesFinished?.status==='lost';
      minesStatusEl.innerHTML=lost?'<span class="mines-status-lost">'+t('minesLoseTitle')+'</span><span class="mines-status-next">'+t('minesLoseText')+'</span>':'';
      minesStatusEl.classList.toggle('visible',lost);
      return;
    }
    const opened=minesGame.opened.length;
    const next=opened<MINES_CELLS-minesGame.minesCount?minesMultiplier(minesGame.minesCount,opened+1):null;
    minesStatusEl.innerHTML='<span>'+formatMinesMultiplier(minesMultiplier(minesGame.minesCount,opened))+'</span>'+(next?'<span class="mines-status-next">'+t('minesNext')+' '+formatMinesMultiplier(next)+'</span>':'');
    minesStatusEl.classList.add('visible');
  }

  function renderMinesUI(){
    if(!minesBoardEl)return;
    renderMinesBoard();
    renderMinesCoefficients();
    renderMinesControls();
    renderMinesAction();
    renderMinesStatus();
  }

  function setMinesCount(value){
    if(minesGame||minesBusy)return;
    minesCount=Math.min(MINES_MAX,Math.max(MINES_MIN,Number(value)||MINES_MIN));
    try{localStorage.setItem(MINES_COUNT_KEY,String(minesCount));}catch(_){}
    minesFinished=null;
    minesHaptic('light');
    renderMinesUI();
  }

  async function minesRequest(path,body){
    const response=await fetch(API_BASE+path,{
      method:body?'POST':'GET',
      headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
      body:body?JSON.stringify(body):undefined,
      cache:'no-store',
    });
    const data=await readApiJson(response);
    return {response,data};
  }

  async function loadMinesState(force=false){
    if(!tg?.initData){renderMinesUI();return;}
    if(!force&&Date.now()-minesStateLoadedAt<1500)return;
    minesStateLoadedAt=Date.now();
    try{
      const {response,data}=await minesRequest('/api/mines/state');
      if(!response.ok)return;
      minesConfig=data.config||minesConfig;
      if(minesBetInput&&minesConfig?.minBet)minesBetInput.min=String(minesConfig.minBet);
      if(data.game&&data.game.status==='active'){minesGame=data.game;minesFinished=null;}
      else if(!minesBusy)minesGame=null;
    }catch(_){}
    renderMinesUI();
  }

  async function startMinesGame(){
    const amount=minesBetValue();
    const minBet=Number(minesConfig?.minBet||10);
    const maxBet=Number(minesConfig?.maxBet||50000);
    if(amount<minBet){minesAlert(t('minBet').replace('{n}',minBet));return;}
    if(amount>maxBet){minesBetInput.value=String(maxBet);return;}
    if(amount>balance){minesAlert(t('notEnoughStars'));return;}
    dismissKeyboard(minesBetInput);
    try{localStorage.setItem(MINES_BET_KEY,String(amount));}catch(_){}
    minesBusy=true;minesFinished=null;
    const mutation=beginBalanceMutation();
    const previousBalance=balance;
    updateBalance(balance-amount);
    renderMinesUI();
    try{
      const {response,data}=await minesRequest('/api/mines/start',{amount,mines:minesCount});
      if(!response.ok){
        if(data.code==='GAME_ACTIVE'&&data.game){minesGame=data.game;updateBalance(previousBalance);refreshBalance().catch(()=>{});return;}
        throw new Error(data.error||t('minesStartFailed'));
      }
      minesGame=data.game;
      if(Number.isFinite(Number(data.newBalance))&&canApplyBalanceMutation(mutation)){updateBalance(Number(data.newBalance));saveProfileWarmState();}
      playAppSound('tab');minesHaptic('medium');
    }catch(error){
      if(canApplyBalanceMutation(mutation))updateBalance(previousBalance);
      minesAlert(error.message||t('minesStartFailed'));
    }finally{
      endBalanceMutation(mutation);
      minesBusy=false;
      renderMinesUI();
    }
  }

  function applyMinesWin(data){
    if(data.kind==='gift'&&data.gift){
      const gift=normalizeInventoryGift(data.gift,data.gift.id);
      if(gift&&!inventoryItems.some(item=>String(item.id)===String(gift.id))){inventoryItems.unshift(gift);renderInventory();}
    }
    if(Number.isFinite(Number(data.newBalance))&&data.newBalance!==null)updateBalance(Number(data.newBalance));
    saveProfileWarmState();
    playAppSound('reward');minesHaptic('success');
    openMinesResult(data);
  }

  async function revealMinesCell(index){
    if(!minesGame||minesBusy)return;
    if(minesGame.opened.includes(index))return;
    minesBusy=true;minesPendingCell=index;
    minesHaptic('light');
    renderMinesBoard();
    try{
      const {response,data}=await minesRequest('/api/mines/reveal',{cell:index});
      if(!response.ok){
        if(data.code==='NO_GAME'){minesGame=null;loadMinesState(true);}
        throw new Error(data.error||'Error');
      }
      const game=data.game;
      if(game.status==='active'){
        minesGame=game;
        playAppSound('spin');
      }else{
        minesGame=null;minesFinished=game;
        if(game.status==='lost'){
          // Без всплывающего окна: поле само показывает мины, под ним — короткая надпись.
          minesHaptic('error');
        }else applyMinesWin(data);
      }
    }catch(error){
      if(error.message&&error.message!=='Error')minesAlert(error.message);
    }finally{
      minesBusy=false;minesPendingCell=-1;
      renderMinesUI();
    }
  }

  async function cashoutMines(){
    if(!minesGame||minesBusy||!minesGame.opened.length)return;
    minesBusy=true;
    renderMinesUI();
    try{
      const {response,data}=await minesRequest('/api/mines/cashout',{});
      if(!response.ok){
        if(data.code==='NO_GAME'){minesGame=null;loadMinesState(true);}
        throw new Error(data.error||'Error');
      }
      minesGame=null;minesFinished=data.game||null;
      applyMinesWin(data);
    }catch(error){
      minesAlert(error.message||'Error');
    }finally{
      minesBusy=false;
      renderMinesUI();
    }
  }

  let minesResultGift=null;
  function openMinesResult(data){
    const title=document.getElementById('minesResultTitle');
    const image=document.getElementById('minesResultImage');
    const name=document.getElementById('minesResultName');
    const value=document.getElementById('minesResultValue');
    const sellBtn=document.getElementById('minesResultSell');
    const closeBtn=document.getElementById('minesResultClose');
    minesResultGift=data.kind==='gift'&&data.gift?data.gift:null;
    if(sellBtn){
      sellBtn.hidden=!minesResultGift;
      sellBtn.disabled=false;
      document.getElementById('minesResultSellValue').textContent=formatStars(minesResultGift?.price||data.payout||0);
    }
    if(data.kind==='lost'){
      title.textContent=t('minesLoseTitle');
      image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(MINES_BOMB_SVG.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" '));
      name.textContent=t('minesLoseText');
      value.textContent='';
      closeBtn.textContent='OK';
    }else{
      title.textContent=minesResultGift?t('giftUnlocked'):t('minesWinTitle');
      image.src=minesResultGift?resolveGiftImage(minesResultGift):'assets/star.png';
      name.textContent=minesResultGift?minesResultGift.name:t('minesStarsAdded');
      value.innerHTML=formatStars(data.payout)+' <img src="assets/star.png" alt="">';
      closeBtn.textContent=minesResultGift?t('claim'):'OK';
    }
    minesResultOverlay?.classList.add('open');
  }
  async function sellMinesResultGift(){
    const gift=minesResultGift;
    const sellBtn=document.getElementById('minesResultSell');
    if(!gift?.id||!sellBtn||sellBtn.disabled)return;
    sellBtn.disabled=true;
    try{
      const {response,data}=await minesRequest('/api/inventory/sell',{giftId:gift.id});
      if(!response.ok)throw new Error(data.error||t('sellFailed'));
      inventoryItems=Array.isArray(data.items)?data.items.map(item=>normalizeInventoryGift(item)).filter(Boolean):inventoryItems.filter(item=>String(item.id)!==String(gift.id));
      renderInventory();
      if(Number.isFinite(Number(data.newBalance)))updateBalance(Number(data.newBalance));
      saveProfileWarmState();
      closeMinesResult();
    }catch(error){
      sellBtn.disabled=false;
      minesAlert(error.message||t('sellFailed'));
    }
  }
  function closeMinesResult(){minesResultOverlay?.classList.remove('open');}

  minesBoardEl?.addEventListener('click',event=>{
    const cell=event.target.closest('.mines-cell');
    if(!cell||cell.disabled)return;
    revealMinesCell(Number(cell.dataset.cell));
  });
  minesActionBtn?.addEventListener('click',()=>{
    if(minesBusy)return;
    if(!minesGame)startMinesGame();
    else if(minesGame.opened.length)cashoutMines();
  });
  document.getElementById('minesCountMinus')?.addEventListener('click',()=>setMinesCount(minesCount-1));
  document.getElementById('minesCountPlus')?.addEventListener('click',()=>setMinesCount(minesCount+1));
  minesCountChipsEl?.addEventListener('click',event=>{
    const chip=event.target.closest('[data-mines-count]');
    if(chip)setMinesCount(Number(chip.dataset.minesCount));
  });
  document.querySelectorAll('[data-mines-bet]').forEach(btn=>btn.addEventListener('click',()=>{
    const action=btn.dataset.minesBet;
    const current=minesBetValue();
    const maxBet=Number(minesConfig?.maxBet||50000);
    let next=current;
    if(action==='half')next=Math.floor(current/2);
    else if(action==='double')next=current*2;
    else if(action==='max')next=Math.floor(balance);
    else next=current+Number(action||0);
    minesBetInput.value=String(Math.max(0,Math.min(maxBet,next)));
    minesHaptic('light');
  }));
  minesHashBtn?.addEventListener('click',()=>copyRoundHash((minesGame||minesFinished)?.hash,minesHashBtn));
  document.getElementById('minesResultClose')?.addEventListener('click',closeMinesResult);
  document.getElementById('minesResultSell')?.addEventListener('click',sellMinesResultGift);
  minesResultOverlay?.addEventListener('click',event=>{if(event.target===minesResultOverlay)closeMinesResult();});
  renderMinesUI();
