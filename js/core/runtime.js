  // ─── BACKEND URL — замени после деплоя ────────────────────────────────────
  const API_BASE='https://api.moneymonkey.live';
  async function readApiJson(response){
    const text=await response.text();
    if(!text) return {};
    try{return JSON.parse(text)}catch(_){
      return {error:text.replace(/\s+/g,' ').trim().slice(0,300)||('HTTP '+response.status)};
    }
  }

  const tg=window.Telegram?.WebApp;
  let firstName='User',userHandle='@user',photoUrl='',tgUserId=null;

  // Лёгкие синтезированные UI-звуки: без загрузки внешних аудиофайлов.
  let appAudioContext=null;
  let appAudioUnlocked=false;
  let appSpinSoundAt=0;
  function getAppAudioContext(){
    if(appAudioContext)return appAudioContext;
    const Context=window.AudioContext||window.webkitAudioContext;
    if(!Context)return null;
    try{appAudioContext=new Context();return appAudioContext;}catch(_){return null;}
  }
  function unlockAppAudio(){
    appAudioUnlocked=true;
    const context=getAppAudioContext();
    if(context?.state==='suspended')context.resume().catch(()=>{});
  }
  function playAppTone(frequency,start,duration,volume=.035,type='sine'){
    const context=getAppAudioContext();
    if(!context||!appAudioUnlocked)return;
    const oscillator=context.createOscillator();
    const gain=context.createGain();
    oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,start);
    gain.gain.setValueAtTime(.0001,start);
    gain.gain.exponentialRampToValueAtTime(volume,start+.008);
    gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
    oscillator.connect(gain);gain.connect(context.destination);
    oscillator.start(start);oscillator.stop(start+duration+.02);
  }
  function playAppSound(kind){
    const context=getAppAudioContext();
    if(!context||!appAudioUnlocked)return;
    if(context.state==='suspended'){context.resume().catch(()=>{});return;}
    const now=context.currentTime;
    if(kind==='tab'){
      playAppTone(520,now,.045,.026,'sine');playAppTone(700,now+.045,.055,.022,'sine');
    }else if(kind==='spin'){
      if(Date.now()-appSpinSoundAt<105)return;
      appSpinSoundAt=Date.now();playAppTone(340,now,.025,.018,'square');
    }else if(kind==='reward'){
      playAppTone(523,now,.08,.04,'sine');playAppTone(659,now+.08,.09,.042,'sine');playAppTone(784,now+.17,.16,.048,'sine');
    }
  }
  document.addEventListener('pointerdown',unlockAppAudio,{once:true,passive:true});

  function applyUserToUI(){
    document.getElementById('usernameTop').textContent=firstName;
    document.getElementById('profileName').textContent=firstName;
    document.getElementById('profileUser').textContent=userHandle;
    document.getElementById('topMyName').textContent=firstName;
    if(photoUrl){
      document.getElementById('avatarSmall').src=photoUrl;
      document.getElementById('profileAvatar').src=photoUrl;
      document.getElementById('topMyAvatar').src=photoUrl;
      document.getElementById('crashPlayerAvatar').src=photoUrl;
    }
  }

  async function initUser(){
    if(!tg)return;
    tg.ready();tg.expand();
    try{if(tg.requestFullscreen)tg.requestFullscreen();}catch(e){}
    try{if(tg.disableVerticalSwipes)tg.disableVerticalSwipes();}catch(e){}
    const u=tg.initDataUnsafe?.user;
    if(u){
      firstName=u.first_name||u.username||'User';
      userHandle=u.username?'@'+u.username:'@user';
      photoUrl=u.photo_url||'';
      tgUserId=u.id;
      const balanceEl=document.getElementById('balanceText');
      if(balanceEl)balanceEl.textContent='…';
      applyUserToUI();
      // Пользовательский кэш показывается только для того же Telegram ID.
      restoreProfileWarmState();
    }
    try{
      const resp=await fetch(API_BASE+'/api/init',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({initData:tg.initData||''}),
      });
      const data=await resp.json();
      if(resp.status===403 && data && data.banned){
        showBannedOverlay(data.reason||'Нарушение правил');
        return;
      }
      if(data?.referralGate?.required){
        // Приглашённый сначала открыл Mini App. Сервер ещё не создал связь:
        // возвращаем его в бот для обязательной подписки и серверной проверки.
        const botUrl=String(data.referralGate.botUrl||'');
        try{
          if(tg?.openTelegramLink&&botUrl)tg.openTelegramLink(botUrl);
          else if(botUrl)window.location.href=botUrl;
        }catch(error){
          console.warn('Referral subscription redirect failed:',error?.message||error);
        }
        return;
      }
      if(data.id){
        firstName=data.first_name||firstName;
        userHandle=data.username?'@'+data.username:userHandle;
        photoUrl=data.photo_url||photoUrl;
        tgUserId=data.id;
        if(data.balance!==undefined&&data.balance!==null&&Number.isFinite(Number(data.balance)))updateBalance(Number(data.balance));
        applyUserToUI();
        // init уже прошёл проверку подписи Telegram и сервер определил роль.
        // Это влияет только на видимость кнопки; все admin API всё равно защищены.
        const adminButton=document.getElementById('adminPanelBtn');
        const adminCases=document.getElementById('adminCasesSection');
        if(adminButton&&data.isAdmin===true)adminButton.style.display='flex';
        if(adminCases&&data.isAdmin===true)adminCases.style.display='block';
        saveProfileWarmState();
      }
    }catch(e){console.warn('Backend init failed:',e.message)}
  }

  // === BAN OVERLAY (v8.13) ===
  function showBannedOverlay(reason){
    if(document.getElementById('bannedOverlay')) return;
    const ov=document.createElement('div');
    ov.id='bannedOverlay';
    ov.style.cssText='position:fixed;inset:0;background:rgba(8,10,18,.96);backdrop-filter:blur(8px);z-index:999999;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,sans-serif;color:#fff;text-align:center;';
    ov.innerHTML=`
      <div style="max-width:380px;background:linear-gradient(180deg,#1a1d2e 0%,#0f1120 100%);border:1px solid rgba(255,80,80,.3);border-radius:20px;padding:32px 24px;box-shadow:0 20px 60px rgba(0,0,0,.6);">
        <div style="font-size:64px;line-height:1;margin-bottom:16px;">🚫</div>
        <div style="font-size:24px;font-weight:700;margin-bottom:8px;color:#ff5b6e;">Вы забанены</div>
        <div style="font-size:14px;opacity:.7;margin-bottom:18px;">Доступ к Gift Pepe закрыт</div>
        <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.45;">
          <div style="font-size:11px;opacity:.5;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Причина</div>
          <div id="bannedReasonText" style="word-break:break-word;"></div>
        </div>
        <div style="margin-top:18px;font-size:12px;opacity:.5;">Если считаешь это ошибкой — <a href="https://t.me/GiftPepeSupport" style="color:#7cc3ff;">поддержка</a></div>
      </div>`;
    document.body.appendChild(ov);
    document.getElementById('bannedReasonText').textContent=String(reason||'Нарушение правил');
  }

  let sessionExpiredShown=false;
  function showSessionExpiredOverlay(){
    if(sessionExpiredShown||document.getElementById('sessionExpiredOverlay'))return;
    sessionExpiredShown=true;
    const isEn=typeof currentLang!=='undefined'&&currentLang==='en';
    const overlay=document.createElement('div');
    overlay.id='sessionExpiredOverlay';
    overlay.style.cssText='position:fixed;inset:0;z-index:999998;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,10,18,.95);backdrop-filter:blur(8px);color:#fff;text-align:center;font-family:system-ui,-apple-system,sans-serif;';
    const title=isEn?'Session updated':'Сессия обновлена';
    const text=isEn?'Telegram session data is no longer valid. Close this Mini App and open it again.':'Данные сессии Telegram устарели. Закрой Mini App и открой его заново.';
    overlay.innerHTML='<div style="max-width:360px;background:#1c1c1e;border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:28px 22px;"><div class="session-expired-title" style="font-size:24px;font-weight:800;margin-bottom:10px;"></div><div class="session-expired-text" style="font-size:15px;line-height:1.5;color:rgba(255,255,255,.78);"></div></div>';
    overlay.querySelector('.session-expired-title').textContent=title;
    overlay.querySelector('.session-expired-text').textContent=text;
    document.body.appendChild(overlay);
  }

  // Глобально различаем бан, истекшую Telegram-сессию и обычный временный сбой API.
  (function(){
    const orig=window.fetch;
    window.fetch=async function(input,init){
      const r=await orig.call(this,input,init);
      const url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.indexOf('/api/')!==-1&&(r.status===401||r.status===403)){
        try{
          const d=await r.clone().json();
          if(r.status===403&&d?.banned)showBannedOverlay(d.reason||'Нарушение правил');
          else if(r.status===401&&/invalid initdata/i.test(String(d?.error||'')))showSessionExpiredOverlay();
        }catch(e){}
      }
      return r;
    };
  })();

  function makeTapToPlayLottie(container,path){
    if(!container||!window.lottie) return null;
    const anim=lottie.loadAnimation({container,renderer:'svg',loop:false,autoplay:false,path});
    const reset=()=>{try{anim.goToAndStop(0,true)}catch(e){}};
    try{anim.addEventListener('DOMLoaded',reset);anim.addEventListener('complete',reset);}catch(e){}
    container.style.cursor='pointer';
    container.addEventListener('click',()=>{
      try{anim.stop();anim.goToAndPlay(0,true);}catch(e){}
    });
    return anim;
  }

  // Анимация профиля не нужна на стартовом Game-экране — создаём её только при входе в профиль.
  let profileLottieAnim=null;
  function ensureProfileLottie(){
    if(!profileLottieAnim){
      profileLottieAnim=makeTapToPlayLottie(document.getElementById('lottieContainer'),'https://cdn.changes.tg/gifts/models/Jolly%20Chimp/lottie/Tired%20Primate.json');
    }
    return profileLottieAnim;
  }

  let sheetLottieLoaded=false;
  let sheetLottieAnim=null;
  let trophyLottieAnim=null;

  const GIFT_CATALOG=[
    {name:'Шампанское',price:50,id:'6028601630662853006',image:'https://cdn.changes.tg/gifts/originals/6028601630662853006/Original.png'},
    {name:'Алмаз',price:100,id:'5170521118301225164',image:'https://cdn.changes.tg/gifts/originals/5170521118301225164/Original.png'},
    {name:'Кольцо',price:100,id:'5170690322832818290',image:'https://cdn.changes.tg/gifts/originals/5170690322832818290/Original.png'},
    {name:'Кубок',price:100,id:'5168043875654172773',image:'https://cdn.changes.tg/gifts/originals/5168043875654172773/Original.png'},
    {name:'Ракета',price:50,id:'5170564780938756245',image:'https://cdn.changes.tg/gifts/originals/5170564780938756245/Original.png'},
    {name:'Букет цветов',price:50,id:'5170314324215857265',image:'https://cdn.changes.tg/gifts/originals/5170314324215857265/Original.png'},
    {name:'Торт',price:50,id:'5170144170496491616',image:'https://cdn.changes.tg/gifts/originals/5170144170496491616/Original.png'},
    {name:'Роза',price:25,id:'5168103777563050263',image:'https://cdn.changes.tg/gifts/originals/5168103777563050263/Original.png'},
    {name:'Подарок',price:25,id:'5170250947678437525',image:'https://cdn.changes.tg/gifts/originals/5170250947678437525/Original.png'},
    {name:'Мишка',price:15,id:'5170233102089322756',image:'https://cdn.changes.tg/gifts/originals/5170233102089322756/Original.png'},
    {name:'Сердце',price:15,id:'5170145012310081615',image:'https://cdn.changes.tg/gifts/originals/5170145012310081615/Original.png'},
    {name:'Футболист мишка',price:50,id:'5974210632977745012',image:'https://cdn.changes.tg/gifts/originals/5974210632977745012/Original.png'},
    {name:'Строитель мишка',price:50,id:'6026193266406327981',image:'https://cdn.changes.tg/gifts/originals/6026193266406327981/Original.png'},
    {name:'Цирковой мишка',price:50,id:'5935895822435615975',image:'https://cdn.changes.tg/gifts/originals/5935895822435615975/Original.png'},
    {name:'Кролик мишка',price:50,id:'5969796561943660080',image:'https://cdn.changes.tg/gifts/originals/5969796561943660080/Original.png'},
    {name:'14 февраля сердце',price:50,id:'5801108895304779062',image:'https://cdn.changes.tg/gifts/originals/5801108895304779062/Original.png'},
    {name:'14 февраля мишка',price:50,id:'5800655655995968830',image:'https://cdn.changes.tg/gifts/originals/5800655655995968830/Original.png'},
    {name:'8 марта мишка',price:50,id:'5866352046986232958',image:'https://cdn.changes.tg/gifts/originals/5866352046986232958/Original.png'},
    {name:'Snake Box',"price":339,"id":"6023679164349940429","image":"https://cdn.changes.tg/gifts/originals/6023679164349940429/Original.png"},{"name":"Big Year","price":340,"id":"6028283532500009446","image":"https://cdn.changes.tg/gifts/originals/6028283532500009446/Original.png"},{"name":"Xmas Stocking","price":340,"id":"6003767644426076664","image":"https://cdn.changes.tg/gifts/originals/6003767644426076664/Original.png"},{"name":"Chill Flame","price":350,"id":"5999277561060787166","image":"https://cdn.changes.tg/gifts/originals/5999277561060787166/Original.png"},{"name":"Instant Ramen","price":350,"id":"6005564615793050414","image":"https://cdn.changes.tg/gifts/originals/6005564615793050414/Original.png"},{"name":"Lunar Snake","price":350,"id":"6028426950047957932","image":"https://cdn.changes.tg/gifts/originals/6028426950047957932/Original.png"},{"name":"Vice Cream","price":350,"id":"5898012527257715797","image":"https://cdn.changes.tg/gifts/originals/5898012527257715797/Original.png"},{"name":"Victory Medal","price":350,"id":"5830340739074097859","image":"https://cdn.changes.tg/gifts/originals/5830340739074097859/Original.png"},{"name":"Winter Wreath","price":350,"id":"5983259145522906006","image":"https://cdn.changes.tg/gifts/originals/5983259145522906006/Original.png"},{"name":"Candy Cane","price":355,"id":"6003373314888696650","image":"https://cdn.changes.tg/gifts/originals/6003373314888696650/Original.png"},{"name":"Fresh Socks","price":360,"id":"5895603153683874485","image":"https://cdn.changes.tg/gifts/originals/5895603153683874485/Original.png"},{"name":"Pet Snake","price":365,"id":"6023917088358269866","image":"https://cdn.changes.tg/gifts/originals/6023917088358269866/Original.png"},{"name":"Santa Hat","price":380,"id":"5983471780763796287","image":"https://cdn.changes.tg/gifts/originals/5983471780763796287/Original.png"},{"name":"Whip Cupcake","price":380,"id":"5933543975653737112","image":"https://cdn.changes.tg/gifts/originals/5933543975653737112/Original.png"},{"name":"Ice Cream","price":389,"id":"5900177027566142759","image":"https://cdn.changes.tg/gifts/originals/5900177027566142759/Original.png"},{"name":"Pool Float","price":395,"id":"5832644211639321671","image":"https://cdn.changes.tg/gifts/originals/5832644211639321671/Original.png"},{"name":"Lol Pop","price":399,"id":"5170594532177215681","image":"https://cdn.changes.tg/gifts/originals/5170594532177215681/Original.png"},{"name":"Holiday Drink","price":400,"id":"6003735372041814769","image":"https://cdn.changes.tg/gifts/originals/6003735372041814769/Original.png"},{"name":"Happy Brownie","price":420,"id":"6006064678835323371","image":"https://cdn.changes.tg/gifts/originals/6006064678835323371/Original.png"},{"name":"Hypno Lollipop","price":420,"id":"5825895989088617224","image":"https://cdn.changes.tg/gifts/originals/5825895989088617224/Original.png"},{"name":"Tama Gadget","price":420,"id":"6023752243218481939","image":"https://cdn.changes.tg/gifts/originals/6023752243218481939/Original.png"},{"name":"Ginger Cookie","price":425,"id":"5983484377902875708","image":"https://cdn.changes.tg/gifts/originals/5983484377902875708/Original.png"},{"name":"Party Sparkler","price":430,"id":"6003643167683903930","image":"https://cdn.changes.tg/gifts/originals/6003643167683903930/Original.png"},{"name":"Spiced Wine","price":430,"id":"5913442287462908725","image":"https://cdn.changes.tg/gifts/originals/5913442287462908725/Original.png"},{"name":"Bow Tie","price":450,"id":"5895544372761461960","image":"https://cdn.changes.tg/gifts/originals/5895544372761461960/Original.png"},{"name":"Jack-in-the-Box","price":450,"id":"6005659564635063386","image":"https://cdn.changes.tg/gifts/originals/6005659564635063386/Original.png"},{"name":"Jester Hat","price":450,"id":"5933590374185435592","image":"https://cdn.changes.tg/gifts/originals/5933590374185435592/Original.png"},{"name":"Stellar Rocket","price":450,"id":"6042113507581755979","image":"https://cdn.changes.tg/gifts/originals/6042113507581755979/Original.png"},{"name":"Mousse Cake","price":460,"id":"5935877878062253519","image":"https://cdn.changes.tg/gifts/originals/5935877878062253519/Original.png"},{"name":"Money Pot","price":465,"id":"5963238670868677492","image":"https://cdn.changes.tg/gifts/originals/5963238670868677492/Original.png"},{"name":"Mood Pack","price":470,"id":"5886756255493523118","image":"https://cdn.changes.tg/gifts/originals/5886756255493523118/Original.png"},{"name":"B-Day Candle","price":498,"id":"5782984811920491178","image":"https://cdn.changes.tg/gifts/originals/5782984811920491178/Original.png"},{"name":"Clover Pin","price":498,"id":"5960747083030856414","image":"https://cdn.changes.tg/gifts/originals/5960747083030856414/Original.png"},{"name":"Hex Pot","price":500,"id":"5825801628657124140","image":"https://cdn.changes.tg/gifts/originals/5825801628657124140/Original.png"},{"name":"Pretty Posy","price":500,"id":"5933737850477478635","image":"https://cdn.changes.tg/gifts/originals/5933737850477478635/Original.png"},{"name":"Restless Jar","price":500,"id":"5870784783948186838","image":"https://cdn.changes.tg/gifts/originals/5870784783948186838/Original.png"},{"name":"Cookie Heart","price":509,"id":"6001538689543439169","image":"https://cdn.changes.tg/gifts/originals/6001538689543439169/Original.png"},{"name":"Swag Bag","price":510,"id":"6012607142387778152","image":"https://cdn.changes.tg/gifts/originals/6012607142387778152/Original.png"},{"name":"Snow Globe","price":530,"id":"5981132629905245483","image":"https://cdn.changes.tg/gifts/originals/5981132629905245483/Original.png"},{"name":"Star Notepad","price":538,"id":"5936017773737018241","image":"https://cdn.changes.tg/gifts/originals/5936017773737018241/Original.png"},{"name":"Homemade Cake","price":542,"id":"5783075783622787539","image":"https://cdn.changes.tg/gifts/originals/5783075783622787539/Original.png"},{"name":"Faith Amulet","price":544,"id":"6003456431095808759","image":"https://cdn.changes.tg/gifts/originals/6003456431095808759/Original.png"},{"name":"Easter Egg","price":550,"id":"5773668482394620318","image":"https://cdn.changes.tg/gifts/originals/5773668482394620318/Original.png"},{"name":"Snoop Dogg","price":550,"id":"6014591077976114307","image":"https://cdn.changes.tg/gifts/originals/6014591077976114307/Original.png"},{"name":"Spring Basket","price":550,"id":"5773725897517433693","image":"https://cdn.changes.tg/gifts/originals/5773725897517433693/Original.png"},{"name":"Moon Pendant","price":555,"id":"5998981470310368313","image":"https://cdn.changes.tg/gifts/originals/5998981470310368313/Original.png"},{"name":"Input Key","price":567,"id":"5870972044522291836","image":"https://cdn.changes.tg/gifts/originals/5870972044522291836/Original.png"},{"name":"Lush Bouquet","price":570,"id":"5871002671934079382","image":"https://cdn.changes.tg/gifts/originals/5871002671934079382/Original.png"},{"name":"Snow Mittens","price":570,"id":"5980789805615678057","image":"https://cdn.changes.tg/gifts/originals/5980789805615678057/Original.png"},{"name":"Witch Hat","price":570,"id":"5821384757304362229","image":"https://cdn.changes.tg/gifts/originals/5821384757304362229/Original.png"},{"name":"Desk Calendar","price":572,"id":"5782988952268964995","image":"https://cdn.changes.tg/gifts/originals/5782988952268964995/Original.png"},{"name":"Bunny Muffin","price":575,"id":"5935936766358847989","image":"https://cdn.changes.tg/gifts/originals/5935936766358847989/Original.png"},{"name":"Eternal Candle","price":575,"id":"5821205665758053411","image":"https://cdn.changes.tg/gifts/originals/5821205665758053411/Original.png"},{"name":"Evil Eye","price":575,"id":"5825480571261813595","image":"https://cdn.changes.tg/gifts/originals/5825480571261813595/Original.png"},{"name":"Jelly Bunny","price":575,"id":"5915502858152706668","image":"https://cdn.changes.tg/gifts/originals/5915502858152706668/Original.png"},{"name":"Jolly Chimp","price":575,"id":"6005880141270483700","image":"https://cdn.changes.tg/gifts/originals/6005880141270483700/Original.png"},{"name":"Light Sword","price":575,"id":"5897581235231785485","image":"https://cdn.changes.tg/gifts/originals/5897581235231785485/Original.png"},{"name":"Spy Agaric","price":575,"id":"5821261908354794038","image":"https://cdn.changes.tg/gifts/originals/5821261908354794038/Original.png"},{"name":"Timeless Book","price":575,"id":"5886387158889005864","image":"https://cdn.changes.tg/gifts/originals/5886387158889005864/Original.png"},{"name":"Joyful Bundle","price":616,"id":"5870862540036113469","image":"https://cdn.changes.tg/gifts/originals/5870862540036113469/Original.png"},{"name":"Sleigh Bell","price":691,"id":"5981026247860290310","image":"https://cdn.changes.tg/gifts/originals/5981026247860290310/Original.png"},{"name":"Hanging Star","price":697,"id":"5915733223018594841","image":"https://cdn.changes.tg/gifts/originals/5915733223018594841/Original.png"},{"name":"Berry Box","price":699,"id":"5882252952218894938","image":"https://cdn.changes.tg/gifts/originals/5882252952218894938/Original.png"},{"name":"Jingle Bells","price":700,"id":"6001473264306619020","image":"https://cdn.changes.tg/gifts/originals/6001473264306619020/Original.png"},{"name":"Sakura Flower","price":800,"id":"5167939598143193218","image":"https://cdn.changes.tg/gifts/originals/5167939598143193218/Original.png"},{"name":"Valentine Box","price":829,"id":"5868595669182186720","image":"https://cdn.changes.tg/gifts/originals/5868595669182186720/Original.png"},{"name":"Skull Flower","price":899,"id":"5839038009193792264","image":"https://cdn.changes.tg/gifts/originals/5839038009193792264/Original.png"},{"name":"Love Candle","price":903,"id":"5915550639663874519","image":"https://cdn.changes.tg/gifts/originals/5915550639663874519/Original.png"},{"name":"Crystal Ball","price":921,"id":"5841336413697606412","image":"https://cdn.changes.tg/gifts/originals/5841336413697606412/Original.png"},{"name":"Top Hat","price":928,"id":"5897593557492957738","image":"https://cdn.changes.tg/gifts/originals/5897593557492957738/Original.png"},{"name":"Snoop Cigar","price":967,"id":"6012435906336654262","image":"https://cdn.changes.tg/gifts/originals/6012435906336654262/Original.png"},{"name":"Flying Broom","price":1068,"id":"5837063436634161765","image":"https://cdn.changes.tg/gifts/originals/5837063436634161765/Original.png"},{"name":"UFC Strike","price":1085,"id":"5882260270843168924","image":"https://cdn.changes.tg/gifts/originals/5882260270843168924/Original.png"},{"name":"Trapped Heart","price":1117,"id":"5841391256135008713","image":"https://cdn.changes.tg/gifts/originals/5841391256135008713/Original.png"},{"name":"Record Player","price":1213,"id":"5856973938650776169","image":"https://cdn.changes.tg/gifts/originals/5856973938650776169/Original.png"},{"name":"Love Potion","price":1221,"id":"5868348541058942091","image":"https://cdn.changes.tg/gifts/originals/5868348541058942091/Original.png"},{"name":"Mad Pumpkin","price":1231,"id":"5841632504448025405","image":"https://cdn.changes.tg/gifts/originals/5841632504448025405/Original.png"},{"name":"Ionic Dryer","price":1362,"id":"5933937398953018107","image":"https://cdn.changes.tg/gifts/originals/5933937398953018107/Original.png"},{"name":"Sky Stilettos","price":1397,"id":"5870947077877400011","image":"https://cdn.changes.tg/gifts/originals/5870947077877400011/Original.png"},{"name":"Cupid Charm","price":1685,"id":"5868561433997870501","image":"https://cdn.changes.tg/gifts/originals/5868561433997870501/Original.png"},{"name":"Khabib’s Papakha","price":1915,"id":"5839094187366024301","image":"https://cdn.changes.tg/gifts/originals/5839094187366024301/Original.png"},{"name":"Rare Bird","price":2096,"id":"5999116401002939514","image":"https://cdn.changes.tg/gifts/originals/5999116401002939514/Original.png"},{"name":"Eternal Rose","price":2301,"id":"5882125812596999035","image":"https://cdn.changes.tg/gifts/originals/5882125812596999035/Original.png"},{"name":"Diamond Ring","price":2384,"id":"5868503709637411929","image":"https://cdn.changes.tg/gifts/originals/5868503709637411929/Original.png"},{"name":"Bling Binky","price":2421,"id":"5902339509239940491","image":"https://cdn.changes.tg/gifts/originals/5902339509239940491/Original.png"},{"name":"Voodoo Doll","price":2653,"id":"5836780359634649414","image":"https://cdn.changes.tg/gifts/originals/5836780359634649414/Original.png"},{"name":"Electric Skull","price":2838,"id":"5846192273657692751","image":"https://cdn.changes.tg/gifts/originals/5846192273657692751/Original.png"},{"name":"Signet Ring","price":2951,"id":"5936085638515261992","image":"https://cdn.changes.tg/gifts/originals/5936085638515261992/Original.png"},{"name":"Vintage Cigar","price":3017,"id":"5857140566201991735","image":"https://cdn.changes.tg/gifts/originals/5857140566201991735/Original.png"},{"name":"Neko Helmet","price":3201,"id":"5933793770951673155","image":"https://cdn.changes.tg/gifts/originals/5933793770951673155/Original.png"},{"name":"Toy Bear","price":3855,"id":"5868220813026526561","image":"https://cdn.changes.tg/gifts/originals/5868220813026526561/Original.png"},{"name":"Bonded Ring","price":3897,"id":"5870661333703197240","image":"https://cdn.changes.tg/gifts/originals/5870661333703197240/Original.png"},{"name":"Genie Lamp","price":3938,"id":"5933531623327795414","image":"https://cdn.changes.tg/gifts/originals/5933531623327795414/Original.png"},{"name":"Sharp Tongue","price":3938,"id":"5841689550203650524","image":"https://cdn.changes.tg/gifts/originals/5841689550203650524/Original.png"},{"name":"Swiss Watch","price":4069,"id":"5936043693864651359","image":"https://cdn.changes.tg/gifts/originals/5936043693864651359/Original.png"},{"name":"Low Rider","price":4641,"id":"6014675319464657779","image":"https://cdn.changes.tg/gifts/originals/6014675319464657779/Original.png"},{"name":"Kissed Frog","price":5060,"id":"5845776576658015084","image":"https://cdn.changes.tg/gifts/originals/5845776576658015084/Original.png"},{"name":"Gem Signet","price":5746,"id":"5859442703032386168","image":"https://cdn.changes.tg/gifts/originals/5859442703032386168/Original.png"},{"name":"Magic Potion","price":6577,"id":"5846226946928673709","image":"https://cdn.changes.tg/gifts/originals/5846226946928673709/Original.png"},{"name":"Artisan Brick","price":7177,"id":"6005797617768858105","image":"https://cdn.changes.tg/gifts/originals/6005797617768858105/Original.png"},{"name":"Mini Oscar","price":7637,"id":"5879737836550226478","image":"https://cdn.changes.tg/gifts/originals/5879737836550226478/Original.png"},{"name":"Ion Gem","price":7793,"id":"5843762284240831056","image":"https://cdn.changes.tg/gifts/originals/5843762284240831056/Original.png"},{"name":"Perfume Bottle","price":8714,"id":"5913517067138499193","image":"https://cdn.changes.tg/gifts/originals/5913517067138499193/Original.png"},{"name":"Westside Sign","price":8796,"id":"6014697240977737490","image":"https://cdn.changes.tg/gifts/originals/6014697240977737490/Original.png"},{"name":"Scared Cat","price":9775,"id":"5837059369300132790","image":"https://cdn.changes.tg/gifts/originals/5837059369300132790/Original.png"},{"name":"Nail Bracelet","price":11229,"id":"5870720080265871962","image":"https://cdn.changes.tg/gifts/originals/5870720080265871962/Original.png"},{"name":"Loot Bag","price":12537,"id":"5868659926187901653","image":"https://cdn.changes.tg/gifts/originals/5868659926187901653/Original.png"},{"name":"Mighty Arm","price":13638,"id":"5895518353849582541","image":"https://cdn.changes.tg/gifts/originals/5895518353849582541/Original.png"},{"name":"Astral Shard","price":14099,"id":"5933629604416717361","image":"https://cdn.changes.tg/gifts/originals/5933629604416717361/Original.png"},{"name":"Heroic Helmet","price":21859,"id":"5895328365971244193","image":"https://cdn.changes.tg/gifts/originals/5895328365971244193/Original.png"},{"name":"Precious Peach","price":35678,"id":"5933671725160989227","image":"https://cdn.changes.tg/gifts/originals/5933671725160989227/Original.png"},{"name":"Durov’s Cap","price":67592,"id":"5915521180483191380","image":"https://cdn.changes.tg/gifts/originals/5915521180483191380/Original.png"},{"name":"Heart Locket","price":172552,"id":"5868455043362980631","image":"https://cdn.changes.tg/gifts/originals/5868455043362980631/Original.png"},{"name":"Plush Pepe","price":780883,"id":"5936013938331222567","image":"https://cdn.changes.tg/gifts/originals/5936013938331222567/Original.png"}];
  const I18N={
    ru:{
      topPlace:'Вы в топе на <b>—</b> месте', waitingDots:'Ожидание...', profile:'Профиль', promocodes:'Промокоды', promoPlaceholder:'Введите промокод', apply:'Применить',
      referralTitle:'РЕФЕРАЛЬНАЯ СИСТЕМА', referralDesc:'Приглашайте людей, чтобы получать бонусы', inventory:'Инвентарь', noGiftsTitle:'Не нашли подарков?',
      noGiftsDesc:'Отправьте подарок <a href="https://t.me/GiftPepeReleyer" target="_blank">@GiftPepeReleyer</a><br>или выиграйте в играх', chooseGift:'Выберите подарок',
      myGifts:'Мои подарки', giftsForUpgrade:'Подарки для апгрейда', makeUpgrade:'Сделать апгрейд', yourGifts:'Ваши подарки', empty:'Пусто', giftCost:'Стоимость подарков',
      waiting:'Ожидание', waitingBets:'Ожидание ставок', placeBet:'Сделать ставку', cashOut:'Забрать',
      giftUnlocked:'Ваш подарок', claim:'Забрать', sell:'Продать', support:'Поддержка', language:'Язык', saveAndExit:'Сохранить и выйти', topup:'Пополнение', stars:'Звезды', ton:'TON',
      topupBtn:'Пополнить', connectWallet:'Подключить кошелек', disconnectWallet:'Отключить кошелек', bet:'Ставка', top:'Топ', crash:'Краш', upgrade:'Апгрейд', profileNav:'Профиль', giftReady:'Подарок', giftOpened:'Подарок открыт',
      sellAll:'Продать все', withdraw:'Вывести', withdrawSoon:'Выводится...', giftWord1:'подарок', giftWord2:'подарка', giftWord5:'подарков', referralBack:'Назад', invited:'Приглашено', earned:'Заработано', invite:'Пригласить', referralLink:'Реферальная ссылка', copied:'Скопировано', addGift:'Добавить подарок', chance:'Шанс', chanceEmpty:'Шанс —', tonLoading:'Подключаем кошелёк...', tonNeedWallet:'Подключи TON кошелёк...', tonNotConnected:'TON кошелёк не подключён', tonOpening:'Открываем TON оплату...', tonConfirm:'Подтверждаем TON пополнение...', loading:'Загрузка...', loadingWait:'Подождите немного', promoUnavailable:'Промокод недоступен', upgradeFailed:'Апгрейд не удался', openTelegramPay:'Открой в Telegram для оплаты', creatingInvoice:'Создаём инвойс...', openingPayment:'Открываем оплату...', checkingPayment:'Проверяем оплату...', paymentDelayed:'Оплата принята, но подтверждение задержалось. Баланс обновится чуть позже.', paymentFailed:'Оплата не прошла. Попробуй снова.', paymentCancelled:'Оплата отменена.', errorPrefix:'Ошибка: ', topPlaceAt:'Вы в топе на <b>{rank}</b> месте', topNotYet:'Вы ещё не в топе', now:'Сейчас', soonPrefix:'Оч'
    },
    en:{
      topPlace:'You are in the top at <b>—</b> place', waitingDots:'Waiting...', profile:'Profile', promocodes:'Promo codes', promoPlaceholder:'Enter promo code', apply:'Apply',
      referralTitle:'REFERRAL SYSTEM', referralDesc:'Invite people to get bonuses', inventory:'Inventory', noGiftsTitle:'No gifts found?',
      noGiftsDesc:'Send a gift to <a href="https://t.me/GiftPepeReleyer" target="_blank">@GiftPepeReleyer</a><br>or win one in games', chooseGift:'Choose a gift',
      myGifts:'My gifts', giftsForUpgrade:'Gifts for upgrade', makeUpgrade:'Make upgrade', yourGifts:'Your gifts', empty:'Empty', giftCost:'Gift value',
      waiting:'Waiting', waitingBets:'Waiting for bets', placeBet:'Place bet', cashOut:'Cash out',
      giftUnlocked:'Your gift', claim:'Claim', sell:'Sell', support:'Support', language:'Language', saveAndExit:'Save and exit', topup:'Top up', stars:'Stars', ton:'TON',
      topupBtn:'Top up', connectWallet:'Connect wallet', disconnectWallet:'Disconnect wallet', bet:'Bet', top:'Top', crash:'Crash', upgrade:'Upgrade', profileNav:'Profile', giftReady:'Gift', giftOpened:'Gift opened',
      sellAll:'Sell all', withdraw:'Withdraw', withdrawSoon:'Withdrawing...', giftWord1:'gift', giftWord2:'gifts', giftWord5:'gifts', referralBack:'Back', invited:'Invited', earned:'Earned', invite:'Invite', referralLink:'Referral link', copied:'Copied', addGift:'Add gift', chance:'Chance', chanceEmpty:'Chance —', tonLoading:'Connecting wallet...', tonNeedWallet:'Connect TON wallet...', tonNotConnected:'TON wallet is not connected', tonOpening:'Opening TON payment...', tonConfirm:'Confirming TON top up...', loading:'Loading...', loadingWait:'Please wait a bit', promoUnavailable:'Promo code unavailable', upgradeFailed:'Upgrade failed', openTelegramPay:'Open in Telegram to pay', creatingInvoice:'Creating invoice...', openingPayment:'Opening payment...', checkingPayment:'Checking payment...', paymentDelayed:'Payment is accepted, but confirmation is delayed. Balance will update a bit later.', paymentFailed:'Payment failed. Try again.', paymentCancelled:'Payment cancelled.', errorPrefix:'Error: ', topPlaceAt:'You are in the top at <b>{rank}</b> place', topNotYet:'You are not in the top yet', now:'Now', soonPrefix:'In'
    }
  };
  // Force the new GiftPep build to start in English once, even if an older build saved RU.
  // Users can still switch language later in settings.
  if(localStorage.getItem('money_default_en_v4')!=='1'){
    localStorage.setItem('miniapp_lang','en');
    localStorage.setItem('money_default_en_v4','1');
  }
  let currentLang=(localStorage.getItem('miniapp_lang')==='ru')?'ru':'en';
  let pendingLang=currentLang;
  function t(key){return I18N[currentLang][key]||I18N.ru[key]||key}
  function setLangIndicator(lang){
    if(lang==='en'){langInd.classList.add('right')}else{langInd.classList.remove('right')}
  }
  const INVENTORY_HOLD_MS=0;
  const MAX_CRASH_HISTORY=10;
  let inventoryItems=[];
  let inventorySnapshotKey='';
  let inventoryRefreshInFlight=null;
  let referralRefreshInFlight=null;
  let lastInventoryRefreshAt=0;
  let lastReferralRefreshAt=0;
  const PROFILE_WARM_STATE_PREFIX='giftpep.profile.warm.v1.';
  const PROFILE_WARM_STATE_MAX_AGE_MS=15*60*1000;

  function profileWarmStateKey(){
    const id=Number(tgUserId||0);
    return id>0?PROFILE_WARM_STATE_PREFIX+id:'';
  }
  function saveProfileWarmState(){
    const key=profileWarmStateKey();
    if(!key)return;
    try{
      localStorage.setItem(key,JSON.stringify({
        savedAt:Date.now(),balance:Number(balance||0),
        items:(inventoryItems||[]).slice(0,100),
        referral:{invited:Number(referralInvited||0),earned:Number(referralEarned||0),code:String(referralCode||'')},
      }));
    }catch(_){ }
  }
  function restoreProfileWarmState(){
    const key=profileWarmStateKey();
    if(!key)return false;
    try{
      const cached=JSON.parse(localStorage.getItem(key)||'null');
      if(!cached||Date.now()-Number(cached.savedAt||0)>PROFILE_WARM_STATE_MAX_AGE_MS){
        localStorage.removeItem(key);return false;
      }
      // Нулевой старый кэш не выдаём за подтверждённый баланс: сервер ответит фактическим значением.
      if(Number(cached.balance)>0)updateBalance(Number(cached.balance));
      if(Array.isArray(cached.items)){
        inventoryItems=cached.items.map(item=>normalizeInventoryGift(item)).filter(Boolean);
        renderInventory();
      }
      if(cached.referral){
        referralInvited=Number(cached.referral.invited||0);
        referralEarned=Number(cached.referral.earned||0);
        referralCode=String(cached.referral.code||'');
        updateReferralUI();
      }
      return true;
    }catch(_){return false;}
  }
  // Рыночные цены нужны только внутри игр и инвентаря; не блокируем ими первый экран Game.
  async function refreshMarketPrices(){
    try{
      const r=await fetch(API_BASE+'/api/market-prices',{cache:'no-store'});
      if(!r.ok) return;
      const d=await r.json().catch(()=>({}));
      const prices=d&&d.prices||{};
      for(const g of GIFT_CATALOG){
        const id=String(g.id||g.giftId||'');
        const mp=Number(prices[id]);
        if(Number.isFinite(mp)&&mp>0) g.price=mp;
      }
    }catch(e){}
  }
  const withdrawingGiftIds=new Set();
  let crashPrizeGift=null;
  let crashPrizePending=false;
  let crashRenderedWinGift=null;
  let crashRenderedWinAmount=0;
  let crashBetSyncPending=false;
  let crashCashoutBusy=false;
  let crashRoundCrashTimeout=null;
  let crashRoundResetTimeout=null;
  const inventoryGrid=document.getElementById('inventoryGrid');
  const inventoryEmpty=document.getElementById('inventoryEmpty');
  const inventoryCountEl=document.querySelector('.inventory-count');
  const sellAllBtn=document.querySelector('.sell-all-btn');
  const sheetGifts=document.getElementById('sheetGifts');
  const sheetEmptyTitle=document.querySelector('#sheet .empty-title');
  const sheetEmptyDesc=document.querySelector('#sheet .empty-desc');
  const sheetLottieEl=document.getElementById('sheetLottie');

  function formatStars(v){
    const n=Math.max(0,Math.floor(Number(v||0)));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  }
  function formatCompactStars(v){
    const num=Math.max(0,Number(v||0));
    if(num>=1000000) return (num/1000000).toFixed(num>=10000000?0:1).replace(/\.0$/,'')+'M';
    if(num>=1000) return (num/1000).toFixed(num>=100000?0:1).replace(/\.0$/,'')+'K';
    return formatStars(num);
  }
  function formatInventoryTime(ms){
    const safe=Math.max(0,ms);
    const total=Math.ceil(safe/1000);
    const d=Math.floor(total/86400);
    const h=Math.floor((total%86400)/3600);
    const m=Math.floor((total%3600)/60);
    const s=total%60;
    if(currentLang==='en'){
      const parts=[];
      if(d>0) parts.push(d+'d');
      if(d>0||h>0) parts.push(h+'h');
      parts.push(m+'m', s+'s');
      return parts.join('');
    }
    const parts=[];
    if(d>0) parts.push(d+'д');
    if(d>0||h>0) parts.push(h+'ч');
    parts.push(m+'м', s+'с');
    return parts.join('');
  }
  function giftCountWord(count){
    if(currentLang==='en') return count===1?t('giftWord1'):t('giftWord2');
    const mod10=count%10,mod100=count%100;
    return (mod10===1&&mod100!==11)?t('giftWord1'):(mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?t('giftWord2'):t('giftWord5'));
  }
  function getBestGiftForStars(stars){
    let result=null;
    for(const gift of GIFT_CATALOG){
      if(gift.price<=stars) result=gift;
      else break;
    }
    return result;
  }
  function updateInventorySummary(){
    const count=inventoryItems.length;
    const total=inventoryItems.reduce((sum,item)=>sum+item.price,0);
    inventoryCountEl.textContent=count ? (count+' '+giftCountWord(count)) : ('0 '+giftCountWord(0));
    sellAllBtn.innerHTML=t('sellAll')+' '+formatStars(total)+' <img src="assets/star.png" alt="star">';
    sellAllBtn.style.opacity=count? '1':'.45';
    sellAllBtn.style.pointerEvents=count? 'auto':'none';
  }
  function getItemWithdrawAt(item){
    const raw=item?.withdrawAt||item?.withdraw_available_at||item?.withdrawAtMs||0;
    const ts=raw?new Date(raw).getTime():0;
    return Number.isFinite(ts)?ts:0;
  }
  function canWithdrawItem(item){
    const ts=getItemWithdrawAt(item);
    return !ts || Date.now()>=ts;
  }
  function getWithdrawButtonState(item){
    const withdrawing=withdrawingGiftIds.has(String(item?.id||''));
    if(withdrawing){
      return {text:t('withdrawSoon'), pill:'', className:'pending', disabled:true};
    }
    if(canWithdrawItem(item)){
      return {text:t('withdraw'), pill:'', className:'', disabled:false};
    }
    return {text:t('withdraw'), pill:formatInventoryTime(getItemWithdrawAt(item)-Date.now()), className:'locked', disabled:true};
  }
  function dismissKeyboard(inputEl=null){
    try{inputEl?.blur?.()}catch(e){}
    try{document.activeElement?.blur?.()}catch(e){}
    try{if(tg?.hideKeyboard) tg.hideKeyboard()}catch(e){}
    try{if(window.Telegram?.WebApp?.hideKeyboard) window.Telegram.WebApp.hideKeyboard()}catch(e){}
  }

  let _inventoryTickTimer=null;
  function ensureInventoryTick(){
    if(_inventoryTickTimer) return;
    _inventoryTickTimer=setInterval(()=>{
      const hasLocked=inventoryItems.some(it=>!canWithdrawItem(it));
      if(!hasLocked){ clearInterval(_inventoryTickTimer); _inventoryTickTimer=null; return; }
      if(document.hidden) return;
      // Точечно обновляем только текст таймера на запертых кнопках, не дёргая весь грид
      document.querySelectorAll('.inventory-card').forEach(card=>{
        const id=card.dataset.id;
        const item=inventoryItems.find(it=>String(it.id)===String(id));
        if(!item) return;
        const btn=card.querySelector('.inventory-withdraw-btn');
        if(!btn) return;
        const state=getWithdrawButtonState(item);
        if(state.className==='' && btn.disabled){
          // Таймер истёк — перерисовать карточку через renderInventory
          renderInventory();
          return;
        }
        const pillEl=btn.querySelector('.inventory-timer-pill');
        if(state.pill && pillEl){
          pillEl.innerHTML=state.pill;
        }
      });
    },20000);
  }
  function makeInventorySnapshot(items=inventoryItems){
    return (items||[]).map(item=>[
      item?.id||'', item?.giftId||'', item?.name||'', Number(item?.price||0),
      item?.withdrawAt||item?.withdraw_available_at||'', item?.tgMsgId||item?.tg_msg_id||'', item?.tgSlug||item?.tg_slug||'',
    ].join(':')).join('|');
  }
  function renderInventory(){
    inventorySnapshotKey=makeInventorySnapshot();
    updateInventorySummary();
    if(upgradeSourceGift && !inventoryItems.some(item=>String(item.id)===String(upgradeSourceGift.id))){
      upgradeSourceGift=null;
      upgradeTargetGift=null;
    }
    if(!inventoryItems.length){
      inventoryGrid.classList.remove('visible');
      inventoryGrid.innerHTML='';
      inventoryEmpty.style.display='flex';
      renderSheetGifts();
      return;
    }
    inventoryEmpty.style.display='none';
    inventoryGrid.classList.add('visible');
    inventoryGrid.innerHTML=inventoryItems.map(item=>{
      const withdrawState=getWithdrawButtonState(item);
      return `
      <div class="inventory-card" data-id="${item.id}">
        <img class="inventory-card-image" src="${resolveGiftImage(item)}" alt="${item.name}">
        <div class="inventory-card-name">${item.name}</div>
        <div class="inventory-actions">
          <button class="inventory-sell-btn" data-action="sell">
            ${t('sell')} ${formatStars(item.price)} <img src="assets/star.png" alt="">
          </button>
          <button class="inventory-withdraw-btn ${withdrawState.className}" data-action="withdraw" ${withdrawState.disabled?'disabled':''}>
            <span>${withdrawState.text}</span>
            ${withdrawState.pill?`<span class="inventory-timer-pill">${withdrawState.pill}</span>`:''}
          </button>
        </div>
      </div>
    `;
    }).join('');
    renderSheetGifts();
    ensureInventoryTick();
  }

  function renderSheetGifts(){
    if(!sheetGifts)return;
    const items=getSheetItems();
    const isUpgradeMode=sheetMode==='upgrade-source'||sheetMode==='upgrade-target';
    if(sheetTitle){
      sheetTitle.textContent=sheetMode==='upgrade-source' ? t('myGifts') : (sheetMode==='upgrade-target' ? t('giftsForUpgrade') : t('myGifts'));
    }
    sheetAddBtn.textContent=t('addGift');
    sheetAddBtn.classList.toggle('visible',!!(isUpgradeMode&&sheetSelectedGiftId));
    if(!items.length){
      sheetGifts.classList.remove('visible');
      sheetGifts.innerHTML='';
      sheetLottieEl.style.display='block';
      sheetEmptyTitle.style.display='block';
      sheetEmptyDesc.style.display='block';
      sheetEmptyTitle.textContent=t('noGiftsTitle');
      sheetEmptyDesc.innerHTML=t('noGiftsDesc');
      return;
    }
    sheetLottieEl.style.display='none';
    sheetEmptyTitle.style.display='none';
    sheetEmptyDesc.style.display='none';
    sheetGifts.classList.add('visible');
    sheetGifts.innerHTML=items.map(item=>{
      const selected=String(item._sheetId)===String(sheetSelectedGiftId);
      return `
      <div class="sheet-gift-card ${selected?'selected':''}" data-id="${item._sheetId}">
        <img src="${resolveGiftImage(item)}" alt="${item.name}">
        <div class="sheet-gift-name">${item.name}</div>
        <div class="sheet-gift-price">${formatStars(item.price)} <img src="assets/star.png" alt=""></div>
      </div>
    `;
    }).join('');
  }

  const sheetTitle=document.querySelector('.sheet-pill');
  const sheetAddBtn=document.getElementById('sheetAddBtn');
  let sheetMode='inventory';
  let sheetSelectedGiftId='';
  let upgradeSourceGift=null;
  let upgradeTargetGift=null;
  let upgradeSpinBusy=false;
  const upgradeBtnEl=document.getElementById('upgradeBtn');
  const upgradeChanceEl=document.getElementById('upgradeChance');
  const slotSourceEl=document.getElementById('slotMyGifts');
  const slotTargetEl=document.getElementById('slotUpgradeGift');
  const upgradeWheelEl=document.getElementById('upgradeWheel');
  const upgradeCircleOuterEl=document.getElementById('upgradeCircleOuter');
  const upgradeRingEl=document.getElementById('upgradeRing');
  const upgradeWheelDisc=document.getElementById('upgradeWheelDisc');
  const upgradeModalOverlay=document.getElementById('upgradeModalOverlay');
  const upgradeModalImage=document.getElementById('upgradeModalImage');
  const upgradeModalName=document.getElementById('upgradeModalName');
  const upgradeModalPrice=document.getElementById('upgradeModalPrice');
  const upgradeModalCloseBtn=document.getElementById('upgradeModalCloseBtn');
  let upgradeWheelRotation=0;
  let upgradeDisplayedBlueDeg=0;
  let upgradeBlueDegAnim=0;

  // Upgrade blue sector is always CENTERED at the bottom (180deg).
  // Its start therefore depends on sector size: 180 - blueDeg/2.
  const UPGRADE_BLUE_CENTER_DEG=180;
  function getUpgradeBlueStartDeg(deg=upgradeDisplayedBlueDeg){
    const value=Math.max(0,Math.min(360,Number(deg||0)));
    return UPGRADE_BLUE_CENTER_DEG-(value/2);
  }
  function setUpgradeArrowRotation(rotation=upgradeWheelRotation){
    upgradeWheelRotation=((Number(rotation||0)%360)+360)%360;
    const arrow=upgradeWheelEl?.querySelector('.circle-arrow');
    if(arrow) arrow.style.transform='translateX(-50%) rotate('+upgradeWheelRotation+'deg)';
  }
  function setUpgradeRingBlue(deg){
    const value=Math.max(0,Math.min(360,Number(deg||0)));
    upgradeDisplayedBlueDeg=value;
    if(upgradeRingEl){
      const startDeg=getUpgradeBlueStartDeg(value);
      upgradeRingEl.style.transform='rotate(0deg)';
      upgradeRingEl.style.background='conic-gradient(from '+startDeg+'deg, #0A84FF 0deg '+value+'deg, rgba(255,255,255,.12) '+value+'deg 360deg)';
    }
  }
  function animateUpgradeFill(targetDeg,duration=420){
    targetDeg=Math.max(0,Math.min(360,Number(targetDeg||0)));
    upgradeBlueDegAnim+=1;
    const token=upgradeBlueDegAnim;
    const startDeg=Number(upgradeDisplayedBlueDeg||0);
    const start=performance.now();
    function step(now){
      if(token!==upgradeBlueDegAnim) return;
      const p=Math.min(1,(now-start)/duration);
      const eased=1-Math.pow(1-p,3);
      setUpgradeRingBlue(startDeg+(targetDeg-startDeg)*eased);
      if(p<1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // TEST MATH MODE: the wheel shows the raw mathematical ratio.
  // Example: 349 -> 350 = 99.7%, 350 -> 700 = 50%.
  // The backend intentionally uses a separate test probability (shown - 15pp, max 85%).
  function getUpgradeChance(source=upgradeSourceGift,target=upgradeTargetGift){
    const from=Number(source?.price||0);
    const to=Number(target?.price||0);
    if(!from||!to||to<=0||from>=to) return 0;
    const raw=(from/to)*100;
    return Math.max(0.1,Math.min(99.9,Math.round(raw*10)/10));
  }
  function formatSlotContent(gift,label){
    if(!gift){
      return '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg><span class="slot-label">'+label+'</span>';
    }
    return '<img src="'+resolveGiftImage(gift)+'" alt="'+gift.name+'"><div class="slot-label">'+gift.name+'</div><div class="slot-price">'+formatStars(gift.price)+' <img src="assets/star.png" alt=""></div>';
  }
  function renderUpgradeWheel(rotation=upgradeWheelRotation,options={}){
    const chance=getUpgradeChance();
    const blueDeg=Math.max(0,Math.min(360,(chance/100)*360));
    if(upgradeRingEl){
      if(options.instant) setUpgradeRingBlue(blueDeg);
      else animateUpgradeFill(blueDeg, options.fillDuration||420);
    }
    if(upgradeWheelDisc){
      upgradeWheelDisc.style.background='transparent';
      upgradeWheelDisc.style.transform='rotate(0deg)';
    }
    setUpgradeArrowRotation(rotation);
  }
  function easeUpgradeSpin(t){
    return t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
  }
  function animateUpgradeRotation(targetRotation,duration=8200){
    const arrow=upgradeWheelEl?.querySelector('.circle-arrow');
    let lastSpinTickAt=0;
    if(!arrow){
      setUpgradeArrowRotation(targetRotation);
      renderUpgradeWheel(upgradeWheelRotation,{instant:true});
      return Promise.resolve();
    }
    arrow.style.transition='none';
    const startRotation=Number(upgradeWheelRotation||0);
    return new Promise(resolve=>{
      const started=performance.now();
      function step(now){
        const p=Math.min(1,(now-started)/duration);
        const eased=easeUpgradeSpin(p);
        const current=startRotation+(targetRotation-startRotation)*eased;
        if(p<.97&&now-lastSpinTickAt>118){lastSpinTickAt=now;playAppSound('spin');}
        arrow.style.transform='translateX(-50%) rotate('+current+'deg)';
        if(p<1){
          requestAnimationFrame(step);
        }else{
          setUpgradeArrowRotation(targetRotation);
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }
  function renderUpgradeUI(){
    slotSourceEl.innerHTML=formatSlotContent(upgradeSourceGift,t('myGifts'));
    slotTargetEl.innerHTML=formatSlotContent(upgradeTargetGift,t('giftsForUpgrade'));
    slotSourceEl.classList.toggle('active',!!upgradeSourceGift);
    slotTargetEl.classList.toggle('active',!!upgradeTargetGift);
    const chance=getUpgradeChance();
    // Прячем строку «Шанс —» — теперь % показываем в центре колеса.
    const _logoEl=document.getElementById('upgradeWheelLogo');
    const _pctEl=document.getElementById('upgradeWheelPercent');
    if(chance){
      if(_pctEl){_pctEl.textContent=chance+'%';_pctEl.classList.add('visible');}
      if(_logoEl) _logoEl.classList.add('hidden');
    } else {
      if(_pctEl){_pctEl.textContent='';_pctEl.classList.remove('visible');}
      if(_logoEl) _logoEl.classList.remove('hidden');
    }
    const canUpgrade=!!(upgradeSourceGift&&upgradeTargetGift&&!upgradeSpinBusy);
    upgradeBtnEl.classList.toggle('active',canUpgrade);
    upgradeBtnEl.classList.toggle('dim',!canUpgrade);
    renderUpgradeWheel(upgradeWheelRotation,{fillDuration:760});
  }
  function getSheetItems(){
    if(sheetMode==='upgrade-source'){
      return inventoryItems.map(item=>({...item, _sheetId:String(item.id)}));
    }
    if(sheetMode==='upgrade-target'){
      const minPrice=Number(upgradeSourceGift?.price||0);
      return GIFT_CATALOG.filter(item=>Number(item.price||0)>minPrice).map(item=>({...item, _sheetId:String(item.id||item.giftId||item.name)}));
    }
    return inventoryItems.map(item=>({...item, _sheetId:String(item.id)}));
  }
  function openSheet(mode='inventory'){
    sheetMode=mode;
    sheetSelectedGiftId='';
    renderSheetGifts();
    sheetOverlay.classList.add('open');sheet.classList.add('open');
    updateLottiePerformance();
    if(!sheetLottieLoaded){
      sheetLottieAnim=makeTapToPlayLottie(document.getElementById('sheetLottie'),'https://cdn.changes.tg/gifts/models/Jolly%20Chimp/lottie/Tired%20Primate.json');
      sheetLottieLoaded=true;
    }
  }
  function closeSheet(){
    sheetOverlay.classList.remove('open');sheet.classList.remove('open');
    sheetSelectedGiftId='';
    sheetAddBtn.classList.remove('visible');
  }
  function addGiftToInventory(gift){
    if(!gift)return;
    inventoryItems.unshift({
      id:'temp_'+String(Date.now()),
      name:gift.name,
      price:gift.price,
      image:resolveGiftImage(gift),
      withdrawAt:INVENTORY_HOLD_MS>0?new Date(Date.now()+INVENTORY_HOLD_MS).toISOString():null
    });
    renderInventory();
  renderUpgradeUI();
  }

  setInterval(()=>{
    if(inventoryItems.length) renderInventory();
  },30000);

  inventoryGrid.addEventListener('click',async e=>{
    const card=e.target.closest('.inventory-card');
    if(!card)return;
    const item=inventoryItems.find(entry=>String(entry.id)===String(card.dataset.id));
    if(!item)return;

    if(e.target.closest('[data-action="sell"]')){
      const prevItems=[...inventoryItems];
      const prevBalance=balance;
      const balanceMutation=beginBalanceMutation();
      inventoryItems=inventoryItems.filter(entry=>String(entry.id)!==String(item.id));
      renderInventory();
      updateBalance(balance+Number(item.price||0));
      try{
        const resp=await fetch(API_BASE+'/api/inventory/sell',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify({giftId:item.id}),
        });
        const data=await resp.json().catch(()=>({}));
        if(!resp.ok) throw new Error(data.error||'Sell failed');
        if(Array.isArray(data.items)) inventoryItems=data.items.map(item=>normalizeInventoryGift(item)).filter(Boolean);
        if(Number.isFinite(Number(data.newBalance))&&canApplyBalanceMutation(balanceMutation)){updateBalance(Number(data.newBalance));saveProfileWarmState();}
        renderInventory();
      }catch(err){
        inventoryItems=prevItems;
        updateBalance(prevBalance);
        renderInventory();
        tg?.showAlert?tg.showAlert(err.message):alert(err.message);
      }finally{
        endBalanceMutation(balanceMutation);
      }
      return;
    }

    if(e.target.closest('[data-action="withdraw"]')){
      if(!canWithdrawItem(item) || withdrawingGiftIds.has(String(item.id))) return;
      dismissKeyboard();
      if(!tg?.openInvoice){
        tg?.showAlert?tg.showAlert(t('openTelegramPay')):alert(t('openTelegramPay'));
        return;
      }
      withdrawingGiftIds.add(String(item.id));
      renderInventory();
      const cleanup=()=>{withdrawingGiftIds.delete(String(item.id));renderInventory();};
      try{
        // Шаг 1: создаём инвойс на комиссию (25⭐ по умолчанию)
        const invResp=await fetch(API_BASE+'/api/inventory/withdraw-invoice',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify({giftId:item.id}),
        });
        const invData=await invResp.json().catch(()=>({}));
        if(!invResp.ok) throw new Error(invData.error||'Invoice failed');
        const finishWithdrawal=async(intentId)=>{
          try{
            const resp=await fetch(API_BASE+'/api/inventory/withdraw',{
              method:'POST',
              headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
              body:JSON.stringify({giftId:item.id,intentId}),
            });
            const data=await resp.json().catch(()=>({}));
            if(!resp.ok) throw new Error(data.error||'Withdraw failed');
            if(Array.isArray(data.items)) inventoryItems=data.items.map(it=>normalizeInventoryGift(it)).filter(Boolean);
            cleanup();
            if(data.message) tg?.showAlert?.(data.message);
          }catch(err){
            cleanup();
            tg?.showAlert?tg.showAlert(err.message):alert(err.message);
          }
        };

        // Если комиссия была оплачена до закрытия Mini App, не запрашиваем её повторно.
        if(invData.alreadyPaid&&invData.intentId){
          await finishWithdrawal(invData.intentId);
          return;
        }

        const {invoiceLink,intentId}=invData;
        if(!invoiceLink||!intentId) throw new Error('Bad invoice response');
        // Шаг 2: открываем оплату. Только status==='paid' → реальный вывод.
        tg.openInvoice(invoiceLink, async(status)=>{
          if(status!=='paid'){
            cleanup();
            if(status==='failed') tg?.showAlert?.(t('paymentFailed'));
            else if(status==='cancelled') tg?.showAlert?.(t('paymentCancelled'));
            return;
          }
          await finishWithdrawal(intentId);
        });
      }catch(err){
        cleanup();
        tg?.showAlert?tg.showAlert(err.message):alert(err.message);
      }
    }
  });

  sellAllBtn.addEventListener('click',async()=>{
    if(!inventoryItems.length)return;
    const prevItems=[...inventoryItems];
    const prevBalance=balance;
    const balanceMutation=beginBalanceMutation();
    const soldTotal=inventoryItems.reduce((sum,item)=>sum+Number(item.price||0),0);
    inventoryItems=[];
    renderInventory();
    updateBalance(balance+soldTotal);
    try{
      const resp=await fetch(API_BASE+'/api/inventory/sell-all',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
      });
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok) throw new Error(data.error||'Sell all failed');
      inventoryItems=Array.isArray(data.items)?data.items.map(item=>normalizeInventoryGift(item)).filter(Boolean):[];
      if(Number.isFinite(Number(data.newBalance))&&canApplyBalanceMutation(balanceMutation)){updateBalance(Number(data.newBalance));saveProfileWarmState();}
      renderInventory();
    }catch(err){
      inventoryItems=prevItems;
      updateBalance(prevBalance);
      renderInventory();
      tg?.showAlert?tg.showAlert(err.message):alert(err.message);
    }finally{
      endBalanceMutation(balanceMutation);
    }
  });

  renderInventory();
  renderUpgradeUI();

  let referralInvited=0;
  let referralEarned=0;
  let referralCode='';
  const referralCard=document.querySelector('.referral-card');
  const referralLinkInput=document.getElementById('referralLinkInput');
  const referralInvitedValue=document.getElementById('referralInvitedValue');
  const referralEarnedValue=document.getElementById('referralEarnedValue');
  const promoInput=document.querySelector('.promo-input');
  const promoBtn=document.querySelector('.promo-btn');
  const REFERRAL_BOT_USERNAME='xpepegiftbot';
  const TON_TO_STARS=90;
  const TON_MANIFEST_URL=(window.location?.origin||'https://moneymonkey.live')+'/tonconnect-manifest.json';
  const TOP_DEPOSIT_REWARD_GIFT_NAMES=['Mighty Arm','Loot Bag','Nail Bracelet'];
  const TOP_REFERRAL_REWARD_GIFT_NAMES=['Khabib’s Papakha','Crystal Ball','Berry Box'];
  const TOP_DEPOSIT_REWARD_GIFTS=TOP_DEPOSIT_REWARD_GIFT_NAMES.map(name=>GIFT_CATALOG.find(gift=>String(gift?.name||'')===name)||null);
  const TOP_REFERRAL_REWARD_GIFTS=TOP_REFERRAL_REWARD_GIFT_NAMES.map(name=>GIFT_CATALOG.find(gift=>String(gift?.name||'')===name)||null);
  let tonConnectUI=null;
  let tonWalletAddress='';
  let tonWalletFriendlyAddress='';

  function crc16Ton(bytes){
    let crc=0;
    for(const b of bytes){
      crc^=(b<<8);
      for(let i=0;i<8;i++) crc=(crc&0x8000)?((crc<<1)^0x1021):(crc<<1);
      crc&=0xffff;
    }
    return crc;
  }
  function bytesToBase64Url(bytes){
    let bin='';
    bytes.forEach(b=>bin+=String.fromCharCode(b));
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function tonRawToFriendly(address){
    const value=String(address||'').trim();
    const m=value.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
    if(!m) return value;
    const wc=Number(m[1]);
    const hash=m[2];
    if(wc!==0 && wc!==-1) return value;
    const body=[0x51,wc===-1?0xff:0x00];
    for(let i=0;i<hash.length;i+=2) body.push(parseInt(hash.slice(i,i+2),16));
    const crc=crc16Ton(body);
    const full=body.concat([(crc>>8)&255,crc&255]);
    return bytesToBase64Url(full);
  }
  function getTonAccountRawAddress(){
    try{return String(tonConnectUI?.account?.address||tonWalletAddress||'').trim();}catch(e){return String(tonWalletAddress||'').trim();}
  }
  function getTonAccountFriendlyAddress(){
    const raw=getTonAccountRawAddress();
    if(!raw) return '';
    return tonRawToFriendly(raw);
  }
  function formatWalletShort(address){
    const value=String(address||'').trim();
    if(value.length<=16) return value;
    return value.slice(0,8)+'…'+value.slice(-8);
  }
  function isTonWalletConnected(){
    return !!getTonAccountRawAddress();
  }
  function syncTopupWalletUI(){
    tonWalletAddress=getTonAccountRawAddress();
    tonWalletFriendlyAddress=getTonAccountFriendlyAddress();
    const row=document.getElementById('topupWalletRow');
    const pill=document.getElementById('topupWalletPill');
    const disconnect=document.getElementById('topupWalletDisconnect');
    const connected=topupMode==='ton' && isTonWalletConnected();
    if(row) row.classList.toggle('visible', connected);
    if(pill) pill.textContent=formatWalletShort(tonWalletFriendlyAddress||tonWalletAddress);
    if(disconnect) disconnect.textContent=t('disconnectWallet');
  }

  async function ensureTonConnect(){
    if(tonConnectUI) return tonConnectUI;
    const ctor=window.TON_CONNECT_UI?.TonConnectUI;
    if(!ctor) throw new Error('TON Connect failed to load');
    tonConnectUI=new ctor({
      manifestUrl: TON_MANIFEST_URL,
    });
    try{
      await tonConnectUI.restoreConnection();
    }catch(e){}
    try{
      tonWalletAddress=String(tonConnectUI?.account?.address||'');
    }catch(e){}
    if(typeof tonConnectUI.onStatusChange==='function'){
      tonConnectUI.onStatusChange((wallet)=>{
        tonWalletAddress=String(wallet?.account?.address||'');
        tonWalletFriendlyAddress=getTonAccountFriendlyAddress();
        syncTopupWalletUI();
        syncTopupSubmitLabel();
      });
    }
    return tonConnectUI;
  }

  async function connectTonWallet(){
    topupSubmit.disabled=true;
    topupSubmit.textContent=t('tonLoading');
    try{
      const tonUi=await ensureTonConnect();
      if(typeof tonUi.openModal==='function') await tonUi.openModal();
      setTimeout(()=>{syncTopupWalletUI();syncTopupSubmitLabel();},350);
    }catch(e){
      console.error('TON connect error:',e);
      tg?.showAlert?tg.showAlert('TON: '+e.message):alert('TON: '+e.message);
    }finally{
      topupSubmit.disabled=false;
      syncTopupWalletUI();
      syncTopupSubmitLabel();
    }
  }

  async function disconnectTonWallet(){
    try{
      const tonUi=await ensureTonConnect();
      if(typeof tonUi.disconnect==='function') await tonUi.disconnect();
    }catch(e){
      console.warn('TON disconnect failed:',e.message);
    }
    tonWalletAddress='';
    syncTopupWalletUI();
    syncTopupSubmitLabel();
  }

  async function sendTonTopup(){
    const tonUi=await ensureTonConnect();
    if(!tonUi?.account?.address){ await connectTonWallet(); return; }
    tonWalletAddress=String(tonUi.account.address||tonWalletAddress||'');
    tonWalletFriendlyAddress=getTonAccountFriendlyAddress();
    const rawTon=getTopupRawValue();
    if(rawTon<=0) return;
    topupSubmit.disabled=true;
    topupSubmit.textContent=t('tonOpening');
    try{
      // 1) Server creates a one-time intent with an exact nanoTON amount.
      const intentResp=await fetch(API_BASE+'/api/ton/topup/intent',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
        body:JSON.stringify({
          amountTon:String(topupAmount.value||rawTon),
          walletAddress:tonWalletFriendlyAddress||tonWalletAddress,
        }),
      });
      const intent=await readApiJson(intentResp);
      if(!intentResp.ok) throw new Error(intent.error||'TON intent failed');

      // 2) Wallet sends exactly the amount generated by the backend.
      await tonUi.sendTransaction({
        validUntil:Math.floor(Date.now()/1000)+360,
        from:String(tonUi.account.address),
        messages:[{ address:String(intent.destination), amount:String(intent.amountNano), payload:String(intent.payload||'') }],
      });

      // 3) Backend independently scans TON blockchain; client never supplies tx amount/hash as truth.
      topupSubmit.textContent=t('tonConfirm');
      let credited=null;
      for(let attempt=0;attempt<20;attempt++){
        const resp=await fetch(API_BASE+'/api/ton/topup/credit',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-init-data':tg?.initData||''},
          body:JSON.stringify({intentId:intent.intentId}),
        });
        const data=await readApiJson(resp);
        if(resp.ok){ credited=data; break; }
        if(resp.status!==409||!data.pending) throw new Error(data.error||'TON top up failed');
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      if(!credited) throw new Error(t('paymentDelayed'));
      if(Number.isFinite(Number(credited.balance))) updateBalance(Number(credited.balance));
      topupAmount.value='';
      closeTopup();
      await Promise.all([refreshBalance(),refreshTop(true),refreshReferral(true)]);
    }catch(e){
      console.error('TON topup error:',e);
      const msg=String(e?.message||'TON transaction failed');
      const friendly=(/not sent|reject|cancel/i.test(msg))
        ? (currentLang==='ru'?'TON: транзакция отменена':'TON: transaction was cancelled')
        : ('TON: '+msg);
      tg?.showAlert?tg.showAlert(friendly):alert(friendly);
    }finally{
      topupSubmit.disabled=false;
      syncTopupWalletUI();
      syncTopupSubmitLabel();
    }
  }


  function buildReferralLink(){
    // v8.21: возвращаемся к ?startapp= — это единственный надёжный путь.
    //   ?start=ref_X у Telegram отправляет /start ТОЛЬКО если юзер впервые видит бота.
    //   Если он уже когда-то открывал чат — клик по ссылке просто откроет окно,
    //   /start не уйдёт, бот молчит, уведомление не приходит.
    //   ?startapp= всегда открывает mini app → /api/init ловит startParam,
    //   applyReferralIfNew пишет связку и notifyReferrer('join') шлёт уведомление.
    const refId=String(referralCode||('ref_'+String(tg?.initDataUnsafe?.user?.id||'guest')));
    return 'https://t.me/'+REFERRAL_BOT_USERNAME+'?startapp='+encodeURIComponent(refId);
  }

  function updateReferralUI(){
    referralInvitedValue.textContent=formatStars(referralInvited);
    referralEarnedValue.innerHTML=formatStars(referralEarned)+' <img src="assets/star.png" alt="">';
    referralLinkInput.value=buildReferralLink();
    referralLinkInput.placeholder=t('referralLink');
  }

  function openReferralPage(){
    referralPage.classList.add('visible');
  }
  function closeReferralPage(){
    referralPage.classList.remove('visible');
  }

  async function copyReferralLink(){
    const link=buildReferralLink();
    try{
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(link);
      }else{
        referralLinkInput.focus();
        referralLinkInput.select();
        document.execCommand('copy');
      }
      if(tg?.showAlert) tg.showAlert(t('copied'));
    }catch(err){
      referralLinkInput.focus();
      referralLinkInput.select();
    }
  }

  function inviteByReferral(){
    const shareUrl='https://t.me/share/url?url='+encodeURIComponent(buildReferralLink());
    if(tg?.openTelegramLink) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl,'_blank');
  }

  async function copyRoundHash(hash, fallbackEl=null){
    const value=String(hash||'').trim();
    if(!value)return;
    try{
      if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else if(fallbackEl){
        const input=document.createElement('textarea');
        input.value=value;input.style.cssText='position:fixed;opacity:0;pointer-events:none';
        document.body.append(input);input.select();document.execCommand('copy');input.remove();
      }
      if(tg?.showAlert) tg.showAlert(currentLang==='en'?'Hash copied':'Hash скопирован');
    }catch(error){
      console.warn('Hash copy failed:',error?.message||error);
    }
  }
