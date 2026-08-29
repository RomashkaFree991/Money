  // Balance
  let balance=0;
  // Каждое локальное или серверное изменение увеличивает версию. Ответ
  // /api/balance, начатый раньше, нельзя применять поверх этой новой версии.
  let balanceRevision=0;
  let balanceMutationDepth=0;
  let balanceMutationSerial=0;
  function beginBalanceMutation(){
    balanceMutationDepth+=1;
    return ++balanceMutationSerial;
  }
  function endBalanceMutation(){balanceMutationDepth=Math.max(0,balanceMutationDepth-1);}
  function getBalanceRefreshRevision(){return balanceRevision;}
  function canApplyBalanceRefresh(revision){return balanceMutationDepth===0&&Number(revision)===balanceRevision;}
  function canApplyBalanceMutation(token){return Number(token)===balanceMutationSerial;}
  let topMode='deposits';
  let topCache={leaders:[],myRank:null,myScore:0};
  let referralTopCache={leaders:[],myRank:null,myScore:0};
  const topRefreshInFlight={deposits:null,referrals:null};
  const topRefreshedAt={deposits:0,referrals:0};
  function updateBalance(v){
    balance=Number(v||0);
    balanceRevision+=1;
    document.getElementById('balanceText').textContent=formatStars(balance);
    updateInventorySummary();
  }

  function applyOptimisticDeposit(starsValue){
    const amount=Number(starsValue||0);
    if(amount<=0)return;
    updateBalance(balance+amount);
    const leaders=Array.isArray(topCache.leaders)?topCache.leaders.map(item=>({...item})):[]; 
    let me=leaders.find(item=>String(item.id)===String(tgUserId));
    if(!me){
      me={id:tgUserId,first_name:firstName||'User',photo_url:photoUrl||'',total_deposited:0};
      leaders.push(me);
    }
    me.total_deposited=Number(me.total_deposited||0)+amount;
    leaders.sort((a,b)=>Number(b.total_deposited||0)-Number(a.total_deposited||0));
    const topLeaders=leaders.slice(0,10);
    const myTopIndex=leaders.findIndex(item=>String(item.id)===String(tgUserId));
    topCache={leaders:topLeaders,myRank:myTopIndex>=0?myTopIndex+1:topCache.myRank,myScore:Number(me.total_deposited||0)};
    if(topMode==='deposits') renderTop(topCache.leaders,topCache.myRank,topCache.myScore);
  }

  // Nav
  const nav=document.getElementById('bottomNav');
  const ind=document.getElementById('indicator');
  const items=document.querySelectorAll('.nav-item');
  const pages={top:document.getElementById('topPage'),game:document.getElementById('gamePage'),profile:document.getElementById('profilePage'),pvp:document.getElementById('pvpPage'),upgrade:document.getElementById('upgradePage'),crash:document.getElementById('crashPage'),case:document.getElementById('casePage')};
  const referralPage=document.getElementById('referralPage');

  function updateLottiePerformance(){
    try{
      const activePage=document.querySelector('.page.visible')?.id||'';
      if(profileLottieAnim && activePage!=='profilePage') profileLottieAnim.goToAndStop(0,true);
      if(trophyLottieAnim && activePage!=='topPage') trophyLottieAnim.goToAndStop(0,true);
      if(sheetLottieAnim && !sheet.classList.contains('open')) sheetLottieAnim.goToAndStop(0,true);
    }catch(e){}
  }

  // Не загружаем Lottie неактивных экранов до тех пор, пока пользователь их не откроет.
  function ensureTrophyLottie(){
    if(!trophyLottieAnim){
      trophyLottieAnim=makeTapToPlayLottie(document.getElementById('trophyLottie'),'assets/trophy.json');
    }
    return trophyLottieAnim;
  }

  let upgradeRedoAnim=null;
  function ensureUpgradeRedo(){
    if(upgradeRedoAnim) return upgradeRedoAnim;
    try{
      const redoEl=document.getElementById('upgradeWheelLogo');
      if(redoEl&&window.lottie){
        upgradeRedoAnim=lottie.loadAnimation({container:redoEl,renderer:'svg',loop:false,autoplay:false,path:'assets/redo.json'});
        const resetRedo=()=>{try{upgradeRedoAnim.goToAndStop(0,true)}catch(e){}};
        try{upgradeRedoAnim.addEventListener('DOMLoaded',resetRedo);upgradeRedoAnim.addEventListener('complete',resetRedo);}catch(e){}
      }
    }catch(e){console.warn('redo lottie init failed:',e)}
    return upgradeRedoAnim;
  }
  function playUpgradeRedo(){try{ensureUpgradeRedo()?.stop?.();upgradeRedoAnim?.goToAndPlay?.(0,true);}catch(e){}}
