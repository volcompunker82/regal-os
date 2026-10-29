(function () {
  'use strict';
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(window.location.search);
  if (path !== '/mobile' && params.get('view') !== 'mobile') return;
  document.body.classList.add('mobile-mode');

  const $ = selector => document.querySelector(selector);
  const clean = (value, max = 240) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const make = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node; };
  function start() {
    const top = $('#top'), calendarPage = $('#calendar-page'), callsPage = $('#calls-page'), settingsPage = $('#settings-page');
    if (!top) return;
    let currentView = 'today', quoteStep = 0, todaysRefreshId = 0, receiptWasOpen = false, receiptReturn = null, pendingNewJobReset = false;
    const shellHeader = make('header', 'mobile-header');
    const brand = make('a', 'mobile-brand'); brand.href = '#mobile-today'; brand.setAttribute('aria-label','Regal home');
    const logo=make('span','regal-logo regal-logo-app mobile-real-logo');logo.setAttribute('role','img');logo.setAttribute('aria-label','Regal Carpet Cleaning logo');brand.append(logo);
    const more = make('details','mobile-more'), moreSummary = make('summary','','More'); more.append(moreSummary);
    const openCalls = $('#open-calls'), openSettings = $('#open-settings');
    if (openCalls) more.append(openCalls);
    if (openSettings) more.append(openSettings);
    shellHeader.append(brand,more);
    const todayMain = make('main','mobile-today'); todayMain.id='mobile-today'; todayMain.hidden=true;
    const todayHeading = make('h1','','Today'); todayMain.append(todayHeading);
    const todayDate = make('p','mobile-today-date'); todayMain.append(todayDate);
    const summary = make('div','mobile-today-summary'); todayMain.append(summary);
    const appointmentHeading=make('h2','','Appointments');todayMain.append(appointmentHeading);
    const appointmentList=make('div','mobile-today-appointments');appointmentList.setAttribute('aria-live','polite');todayMain.append(appointmentList);
    const quickActions=make('div','mobile-today-actions');const continueQuote=make('button','mobile-primary','Continue quote');continueQuote.type='button';const openTodayCalls=make('button','mobile-secondary','Open Calls & Leads');openTodayCalls.type='button';const openTodayCalendar=make('button','mobile-secondary','Open Calendar');openTodayCalendar.type='button';quickActions.append(continueQuote,openTodayCalls,openTodayCalendar);todayMain.append(quickActions);
    const quoteActions=make('div','mobile-quote-actions');
    const mobileMainName=make('p','mobile-current-view');
    shellHeader.insertBefore(mobileMainName,more);
    const mobileNav=make('nav','mobile-bottom-nav');mobileNav.setAttribute('aria-label','Mobile navigation');
    const views=[['today','Today','⌂'],['customers','Customers','♧'],['quote','Quote','＋'],['calendar','Calendar','▦']];
    for(const [key,label,icon] of views){const button=make('button','mobile-nav-button');button.type='button';button.dataset.mobileView=key;button.append(make('span','mobile-nav-icon',icon),make('span','',label));button.addEventListener('click',()=>key==='quote'?showQuoteStep(0):setView(key));mobileNav.append(button);}
    document.body.prepend(shellHeader);
    document.body.append(todayMain,quoteActions,mobileNav);

    function hideDesktopMains(active) {
      for (const node of document.querySelectorAll('body > main')) node.hidden = node !== active;
    }
    function setView(view) {
      currentView=view;document.body.dataset.mobileView=view;more.open=false;quoteActions.replaceChildren();
      const targets={today:todayMain,customers:top,quote:top,calendar:calendarPage,calls:callsPage,pricing:settingsPage};
      const target=targets[view];
      if(target)hideDesktopMains(target);
      for(const button of mobileNav.querySelectorAll('button')){const active=button.dataset.mobileView===view;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
      mobileMainName.textContent=view==='customers'?'Customers':view==='quote'?'Quote':view==='calendar'?'Calendar':view==='calls'?'Calls & Leads':view==='pricing'?'Pricing':'Today';
      const savedPanel=top.querySelector('.saved-panel');
      if(view==='customers'){top.dataset.mobileView='customers';if(savedPanel)savedPanel.hidden=false;}
      else if(view==='quote'){top.dataset.mobileView='quote';if(savedPanel)savedPanel.hidden=true;renderQuoteStep();}
      else {delete top.dataset.mobileView;}
      if(view==='today')refreshToday();
      if(view==='calendar')window.RegalCalendarController?.refresh?.();
      window.scrollTo({top:0,behavior:'instant'});
    }
    function navButton(label, cls, onClick) {const button=make('button',cls,label);button.type='button';button.addEventListener('click',onClick);return button;}
    function renderQuoteStep() {
      const panels=[...top.querySelectorAll('.layout .column > .panel')].slice(0,5);
      for(let i=0;i<panels.length;i++)panels[i].dataset.mobileStepHidden=String(i<2?i!==quoteStep:quoteStep!==2);
      const saved=top.querySelector('.saved-panel');if(saved)saved.hidden=true;
      const column=top.querySelector('.layout .column');if(column)column.hidden=false;
      const actions=top.querySelector('.actions-workflow');if(actions)actions.hidden=true;
      quoteActions.replaceChildren();quoteActions.dataset.step=String(quoteStep);
      if(quoteStep===0){quoteActions.append(navButton('Review quote','mobile-primary',()=>showQuoteStep(1)));}
      else if(quoteStep===1){quoteActions.append(navButton('Back to customer & rooms','mobile-secondary',()=>showQuoteStep(0)),navButton('Finish quote','mobile-primary',()=>showQuoteStep(2)));}
      else {quoteActions.append(navButton('Back to review','mobile-secondary',()=>showQuoteStep(1)),navButton('Save quote','mobile-primary',()=>$('#save-quote')?.click()),navButton('Complete job','mobile-secondary',()=>$('#save-job')?.click()),navButton('Start a new job','mobile-secondary',()=>$('#new-job')?.click()));}
      window.dispatchEvent(new Event('resize'));
    }
    function showQuoteStep(step) {quoteStep=Math.max(0,Math.min(2,step));setView('quote');}
    async function refreshToday() {
      const revision=++todaysRefreshId;todayDate.textContent=window.RegalCalendar?.businessDate?.()?new Date(`${window.RegalCalendar.businessDate()}T12:00:00Z`).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}):'';
      appointmentList.replaceChildren();summary.replaceChildren();
      let records=[],appointments=[],leads=[];
      try{records=await window.RegalStore?.all?.()||[];}catch(_){records=[];}
      try{appointments=window.RegalCalendar?.createStore?.().load?.()||[];}catch(error){if(revision===todaysRefreshId)appointmentList.append(make('p','mobile-error',error.message));}
      try{leads=window.RegalCalls?.createStore?.().load?.()||[];}catch(_){leads=[];}
      if(revision!==todaysRefreshId)return;
      const today=window.RegalCalendar?.businessDate?.()||'';
      const due=window.RegalCalls?.listCallbacks?.(leads,new Date()).filter(item=>item.state==='due').length||0;
      const quoteCount=records.filter(record=>record.recordType==='quote').length;
      summary.append(make('div','mobile-summary-card',`${appointments.filter(item=>item.date===today&&item.status!=='cancelled').length} appointments today`),make('div','mobile-summary-card',`${quoteCount} saved quotes`),make('div','mobile-summary-card',`${due} callbacks due`));
      const list=appointments.filter(item=>item.date===today&&item.status!=='cancelled').sort((a,b)=>String(a.startTime).localeCompare(String(b.startTime)));
      if(!list.length)appointmentList.append(make('p','mobile-empty','No appointments scheduled for today.'));
      for(const appointment of list){
        const card=make('article','mobile-appointment-card');card.append(make('h3','',clean(appointment.name,160)),make('p','mobile-appointment-time',`${clean(appointment.startTime,5)}–${clean(appointment.endTime,5)} · ${clean(appointment.status,30)}`));
        if(appointment.technician)card.append(make('p','',`Technician: ${clean(appointment.technician,100)}`));
        card.append(make('p','',clean(appointment.address,240)));
        if(appointment.address&&window.RegalCalendar?.appleMapsURL){const directions=make('a','mobile-directions','Apple Maps directions');directions.href=window.RegalCalendar.appleMapsURL(appointment.address);directions.target='_blank';directions.rel='noopener noreferrer';card.append(directions);}
        appointmentList.append(card);
      }
    }
    function openExisting(buttonId,view) {$(buttonId)?.click();setTimeout(()=>setView(view),0);}
    continueQuote.addEventListener('click',()=>showQuoteStep(0));openTodayCalls.addEventListener('click',()=>openExisting('#open-calls','calls'));openTodayCalendar.addEventListener('click',()=>setView('calendar'));
    openCalls?.addEventListener('click',()=>setTimeout(()=>setView('calls'),0));openSettings?.addEventListener('click',()=>setTimeout(()=>setView('pricing'),0));
    $('#back-to-work')?.addEventListener('click',()=>setTimeout(()=>showQuoteStep(0),0));
    $('#open-work')?.addEventListener('click',()=>setTimeout(()=>showQuoteStep(0),0));
    const receipt=$('#receipt-view');
    if(receipt&&window.MutationObserver){new MutationObserver(()=>{const isOpen=!receipt.hidden;if(isOpen&&!receiptWasOpen){receiptWasOpen=true;receiptReturn={view:currentView,step:quoteStep};}else if(!isOpen&&receiptWasOpen){receiptWasOpen=false;const restore=receiptReturn;receiptReturn=null;if(restore)setTimeout(()=>restore.view==='quote'?showQuoteStep(restore.step):setView(restore.view),0);}}).observe(receipt,{attributes:true,attributeFilter:['hidden']});}
    $('#new-job')?.addEventListener('click',()=>setTimeout(()=>{const confirmation=$('#confirmation');if(confirmation&&!confirmation.hidden)pendingNewJobReset=true;else showQuoteStep(0);},0));
    $('#confirm-accept')?.addEventListener('click',()=>setTimeout(()=>{if(pendingNewJobReset){pendingNewJobReset=false;showQuoteStep(0);}},0));
    $('#confirm-cancel')?.addEventListener('click',()=>{pendingNewJobReset=false;});
    document.addEventListener('click',event=>{
      const target=event.target;
      if(target.closest('#saved-jobs .saved-job, #customer-history .customer-history-open'))setTimeout(()=>showQuoteStep(0),0);
      const button=target.closest('#saved-jobs button');
      const book=target.closest('#saved-jobs [data-book-appointment], #saved-jobs .book-appointment, #saved-jobs button[data-action="book-appointment"]')||(button&&/book appointment/i.test(button.textContent)?button:null);
      if(book)setTimeout(()=>setView('calendar'),0);
      const linkedRecord=target.closest('#calendar-page .calendar-record-link');
      const startQuote=target.closest('#calls-page button');
      if(linkedRecord||(startQuote&&/start quote/i.test(startQuote.textContent)))setTimeout(()=>showQuoteStep(0),0);
    });
    window.addEventListener('focus',()=>{if(currentView==='today')refreshToday();});
    document.body.dataset.mobileView='today';hideDesktopMains(todayMain);refreshToday();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
