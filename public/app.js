(function(){
'use strict';
/* ---------- helpers ---------- */
var $=function(s,el){return (el||document).querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var p2=function(n){return String(n).padStart(2,'0')};
var isoDate=function(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())};
var hhmm=function(d){return p2(d.getHours())+':'+p2(d.getMinutes())};
var DJ=['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
var DJ3=['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
var MO=['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
var parseDate=function(s){var a=s.split('-').map(Number);return new Date(a[0],a[1]-1,a[2])};
var fmtDay=function(s){var d=parseDate(s);return DJ[d.getDay()]+' '+d.getDate()+' '+MO[d.getMonth()]};
var cap=function(s){return s.charAt(0).toUpperCase()+s.slice(1)};
var ls={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
var uid=function(p){return p+Math.random().toString(36).slice(2,9)};
var isObj=function(o){return o&&typeof o==='object'&&!Array.isArray(o)};
function deepMerge(t,p){Object.keys(p).forEach(function(k){if(isObj(p[k])&&isObj(t[k]))deepMerge(t[k],p[k]);else t[k]=isObj(p[k])?JSON.parse(JSON.stringify(p[k])):p[k]})}
var dayLabel=function(date){var t=isoDate(new Date()),tm=isoDate(new Date(Date.now()+864e5));return date===t?"Aujourd'hui":date===tm?'Demain':cap(fmtDay(date))};

var RULES={before:15,late:5,after:15,thresh:0.8,absMax:3,lateWeight:0.5,justifyHours:48,qrSeconds:60}; // écrasé par les règles du serveur
var LAB={P:'Présent',R:'Retard',A:'Absent',J:'Justifiée'};
var METH={signature:'Signature',qr:'Code QR',manual:'Saisie du formateur',auto:'Absence automatique'};
var chip=function(k){return '<span class="chip c-'+k+'">'+(LAB[k]||k)+'</span>'};
var ICON={
 home:'<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
 cal:'<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
 chart:'<path d="M4 4v16h16"/><path d="M7.5 15l4-4.5 3 2.5 4.5-6"/>',
 bell:'<path d="M6 16v-5a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
 menu:'<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
 users:'<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.5 2.8-5.5 6-5.5s6 2 6 5.5"/><path d="M16 5.2a3 3 0 010 5.6M18 14c2 .6 3.5 2.3 3.5 5"/>',
 file:'<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
 down:'<path d="M12 4v11M7.5 11L12 15.5 16.5 11"/><path d="M5 19h14"/>',
 check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
 x:'<path d="M6 6l12 12M18 6L6 18"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 grid:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="5" rx="1.5"/><rect x="13" y="11" width="7" height="9" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>'
};
var ico=function(n){return '<svg viewBox="0 0 24 24" aria-hidden="true">'+ICON[n]+'</svg>'};

/* ---------- couche données : API REST via la passerelle ---------- */
var rafPending=false;
function changed(){if(rafPending)return;rafPending=true;requestAnimationFrame(function(){rafPending=false;render()})}
var D={c:{students:[],trainers:[],sessions:[],justifs:[]},skew:0,sig:''};
var NOW=function(){return Date.now()+D.skew};
var SIGS={};
var QR={sid:null,code:'',payload:'',exp:0,busy:false};
async function api(method,path,body){
 var r,j=null;
 try{r=await fetch('/api'+path,{method:method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Presence':'1'},body:body===undefined?undefined:JSON.stringify(body)})}
 catch(e){var ne=new Error('Connexion au serveur impossible.');ne.status=0;throw ne}
 try{j=await r.json()}catch(e){}
 if(!r.ok){var err=new Error((j&&j.error)||'Erreur '+r.status);err.status=r.status;if(r.status===401&&path!=='/login')sessionLost();throw err}
 return j;
}
function sessionLost(){if(!S.me)return;S.me=null;S.role=null;D.sig='';SIGS={};closeModalSilent();render();toast('Session expirée, reconnectez-vous.')}
async function refresh(force){
 var b=await api('GET','/bootstrap');
 D.skew=b.now-Date.now();
 var sig=JSON.stringify([b.me,b.students,b.trainers,b.sessions,b.justifs]);
 if(sig===D.sig&&!force)return false;
 D.sig=sig;
 Object.assign(RULES,b.rules);
 S.me=b.me;S.role=b.me.role;S.studentId=b.me.id;
 D.c.students=b.students;D.c.trainers=b.trainers;
 D.c.sessions=b.sessions.map(function(s){return Object.assign({},s,{trainer:s.trainerName||''})});
 D.c.justifs=b.justifs;
 return true;
}
async function sync(){await refresh(true);render()}
async function run(fn,ok){try{await fn();if(ok)toast(ok);return true}catch(e){toast(e.message||'Action impossible.');return false}}
async function loadSigs(id){
 if(!id||S.role==='student')return false;
 try{var r=await api('GET','/sessions/'+encodeURIComponent(id)+'/signatures'),old=JSON.stringify(SIGS[id]||{});SIGS[id]=r;return old!==JSON.stringify(r)}catch(e){return false}
}
var polling=false;
async function poll(){
 if(polling||!S.me||modalOpen()||document.hidden)return;
 polling=true;
 try{var ch=await refresh(false);if(S.sessionId&&await loadSigs(S.sessionId))ch=true;if(ch)render()}catch(e){}
 polling=false;
}
setInterval(poll,4000);

/* ---------- state ---------- */
var S={me:null,role:null,studentId:null,tab:'home',sessionId:null,weekOffset:0,day:null,pointSession:null,busy:false,boot:true};
function defaultTab(r){return r==='student'?'home':r==='trainer'?'sessions':'dash'}
var readSet={};try{readSet=JSON.parse(ls.get('presence.read')||'{}')||{}}catch(e){readSet={}}
var ROLE_LAB={student:'Étudiant',trainer:'Formateur',admin:'Administration'};

/* ---------- domain ---------- */
var students=function(){return D.c.students.slice().sort(function(a,b){return String(a.name).localeCompare(String(b.name),'fr')||String(a.first).localeCompare(String(b.first),'fr')})};
var startTs=function(s){return s.startMs};
var endTs=function(s){return s.endMs};
var sessions=function(){return D.c.sessions.slice().sort(function(a,b){return startTs(a)-startTs(b)})};
var stuName=function(x){return x?x.first+' '+String(x.name).toUpperCase():'Étudiant inconnu'};
var stuById=function(id){return D.c.students.find(function(x){return x.id===id})};
var sesById=function(id){return D.c.sessions.find(function(x){return x.id===id})};
function stat(id){
 var st={P:0,R:0,A:0,J:0};
 D.c.sessions.forEach(function(s){var m=s.marks&&s.marks[id];if(m&&st[m.s]!=null)st[m.s]++});
 st.n=st.P+st.R+st.A;st.rate=st.n?(st.P+RULES.lateWeight*st.R)/st.n:null;return st;
}
var inAlert=function(st){return st.n>0&&(st.rate<RULES.thresh||st.A>=RULES.absMax)};
var pct=function(r){return r==null?'–':Math.round(r*100)+' %'};
function pState(s,now){
 if(s.status!=='open')return{ok:false,msg:s.status==='closed'?'Cette session est clôturée.':"Le formateur n'a pas encore ouvert le pointage."};
 var m=(now-startTs(s))/60000;
 if(m<-RULES.before)return{ok:false,msg:'Le pointage ouvre '+RULES.before+' minutes avant le début.'};
 if(m<=RULES.late)return{ok:true,status:'P'};
 if(m<=RULES.after)return{ok:true,status:'R'};
 return{ok:false,msg:'Le délai de pointage est dépassé. Voyez avec votre formateur.'};
}
function qrSvg(text){
 if(typeof qrcode==='undefined')return '';
 try{var q=qrcode(0,'M');q.addData(text);q.make();var n=q.getModuleCount(),d='';
  for(var r=0;r<n;r++)for(var c=0;c<n;c++)if(q.isDark(r,c))d+='M'+c+' '+r+'h1v1h-1z';
  return '<svg viewBox="-1 -1 '+(n+2)+' '+(n+2)+'" shape-rendering="crispEdges" role="img" aria-label="QR code de la session"><path d="'+d+'" fill="#14262E"/></svg>';
 }catch(e){return ''}
}
/* ---------- toast & modal ---------- */
var toastT=0;
function toast(msg){var t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){t.hidden=true},3200)}
function openModal(html){$('#ov').innerHTML='<div class="ov" data-act="ovbg"><div class="sheet" role="dialog" aria-modal="true">'+html+'</div></div>';var f=$('#ov input,#ov select,#ov textarea');if(f&&matchMedia('(pointer:fine)').matches)f.focus()}
function closeModal(){$('#ov').innerHTML='';S.pointSession=null;changed()}
var modalOpen=function(){return !!$('#ov .ov')};

/* ---------- views: shared pieces ---------- */
function donut(st){
 var n=st.P+st.R+st.A,bg='var(--line)';
 if(n){var a=st.P/n*100,b=st.R/n*100;bg='conic-gradient(var(--p-col) 0 '+a+'%,var(--r-col) '+a+'% '+(a+b)+'%,var(--a-col) '+(a+b)+'% 100%)'}
 return '<div class="donut" role="img" aria-label="Taux de présence : '+pct(st.rate)+'" style="background:'+bg+'"><i><b>'+(st.rate==null?'–':Math.round(st.rate*100)+'%')+'</b><small>de présence</small></i></div>';
}
function legend(st){
 return '<ul class="legend"><li><span class="dot" style="background:var(--p-col)"></span>Présences<b>'+st.P+'</b></li>'+
  '<li><span class="dot" style="background:var(--r-col)"></span>Retards<b>'+st.R+'</b></li>'+
  '<li><span class="dot" style="background:var(--a-col)"></span>Absences<b>'+st.A+'</b></li>'+
  (st.J?'<li><span class="dot" style="background:var(--j-bg)"></span>Justifiées (exclues)<b>'+st.J+'</b></li>':'')+'</ul>';
}
function sessMeta(s){return esc(s.room||'')+(s.trainer?' · '+esc(s.trainer):'')}
function sessWhen(s){return dayLabel(s.date)+' · '+s.start+' – '+s.end}
function statusChip(s){return '<span class="chip c-'+s.status+'">'+({planned:'Planifiée',open:'Pointage ouvert',closed:'Clôturée'}[s.status]||s.status)+'</span>'}
function sigThumb(sid,stu){var p=SIGS[sid]&&SIGS[sid][stu];return p?'<svg class="thumb" viewBox="0 0 300 180" aria-label="Signature" role="img"><path d="'+esc(p)+'" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>':''}

function studentSessionCard(s,stuId){
 var m=s.marks&&s.marks[stuId],body='';
 if(m)body='<div class="between">'+chip(m.s)+'<small>'+(m.t?'Pointé à '+hhmm(new Date(m.t))+' · ':'')+(METH[m.m]||'')+'</small></div>';
 else if(s.status==='open'){
  var ps=pState(s,NOW());
  body=ps.ok?'<button class="btn wide" data-act="point" data-id="'+s.id+'">'+ico('check')+'Pointer ma présence</button>':'<p class="note warn">'+esc(ps.msg)+'</p>';
 }else if(s.status==='closed')body='<div class="between">'+chip('A')+'<small>Aucun pointage enregistré</small></div>';
 else body='<small>Le pointage s\'ouvre quand le formateur lance la session.</small>';
 return '<article class="card sess"><div class="t"><small>'+esc(sessWhen(s))+'</small>'+statusChip(s)+'</div><div><h3>'+esc(s.subject)+'</h3><small>'+sessMeta(s)+'</small></div>'+body+'</article>';
}
/* ---------- student views ---------- */
function notifications(stuId){
 var out=[],now=NOW(),ses=sessions();
 ses.forEach(function(s){
  var m=s.marks&&s.marks[stuId];
  if(s.status==='open'&&!m)out.push({id:'open_'+s.id,t:s.openedAt?new Date(s.openedAt).getTime():startTs(s),icon:'clock',title:'Pointage ouvert',text:s.subject+', '+(s.room||'')+'. Pointez pour être noté présent.',act:'tab',tab:'home'});
  if(m&&m.s==='A'){
   var j=D.c.justifs.find(function(x){return x.ses===s.id&&x.stu===stuId});
   if(!j)out.push({id:'abs_'+s.id,t:endTs(s),icon:'x',title:'Absence enregistrée',text:s.subject+', '+fmtDay(s.date)+'. '+(now<startTs(s)+RULES.justifyHours*36e5?'Vous pouvez déposer un justificatif.':'Le délai de justificatif est dépassé.'),act:'tab',tab:'att'});
  }
  if(s.status==='planned'){var d=startTs(s)-now;if(d>0&&d<864e5)out.push({id:'soon_'+s.id,t:startTs(s)-864e5,icon:'cal',title:'Rappel de session',text:s.subject+' commence à '+s.start+', '+(s.room||'')+'.',act:'tab',tab:'plan'})}
 });
 D.c.justifs.filter(function(j){return j.stu===stuId&&j.status!=='pending'}).forEach(function(j){
  var s=sesById(j.ses);out.push({id:'j_'+j.id+'_'+j.status,t:j.decidedAt?new Date(j.decidedAt).getTime():now-1000,icon:j.status==='validated'?'check':'x',
   title:j.status==='validated'?'Justificatif validé':'Justificatif refusé',text:s?(s.subject+', '+fmtDay(s.date)+'.'):'',act:'tab',tab:'att'});
 });
 return out.sort(function(a,b){return b.t-a.t});
}
var unread=function(stuId){return notifications(stuId).filter(function(n){return !readSet[n.id]}).length};

function studentHome(){
 var me=stuById(S.studentId),st=stat(S.studentId),now=NOW();
 var up=sessions().filter(function(s){return endTs(s)>=now&&s.status!=='closed'||(s.status==='open')}).slice(0,4);
 return '<h1>Bonjour '+esc(me.first)+'</h1><h2>Prochaines sessions</h2>'+
  (up.length?up.map(function(s){return studentSessionCard(s,S.studentId)}).join(''):'<div class="card"><p>Aucune session à venir.</p><small>Consultez régulièrement votre application pour rester à jour.</small></div>')+
  '<button class="card between" data-act="tab" data-tab="att" style="text-align:left;cursor:pointer;color:inherit;font:inherit;flex-direction:row;align-items:center">'+donut(st)+'<div class="grow"><h3>Mon assiduité</h3><small>'+(st.n?pct(st.rate)+' de présence sur '+st.n+' session'+(st.n>1?'s':''):'Pas encore de session pointée')+'</small></div></button>';
}
function weekDays(){
 var d=new Date();d.setHours(12,0,0,0);var dow=(d.getDay()+6)%7;d.setDate(d.getDate()-dow+7*S.weekOffset);
 var out=[];for(var i=0;i<7;i++){var x=new Date(d);x.setDate(d.getDate()+i);out.push(x)}return out;
}
function studentPlan(){
 var days=weekDays(),iso=days.map(isoDate);
 if(!S.day||iso.indexOf(S.day)<0)S.day=(iso.indexOf(isoDate(new Date()))>=0?isoDate(new Date()):iso[0]);
 var ses=sessions(),today=isoDate(new Date());
 var list=ses.filter(function(s){return s.date===S.day});
 var first=days[0],last=days[6];
 return '<div class="between"><h1>Planning</h1><div class="between"><button class="btn sec sm" data-act="week" data-d="-1" aria-label="Semaine précédente">←</button><small>'+first.getDate()+' '+MO[first.getMonth()]+' – '+last.getDate()+' '+MO[last.getMonth()]+'</small><button class="btn sec sm" data-act="week" data-d="1" aria-label="Semaine suivante">→</button></div></div>'+
  '<div class="card"><div class="days">'+days.map(function(d,i){var has=ses.some(function(s){return s.date===iso[i]});
   return '<button data-act="day" data-day="'+iso[i]+'" aria-pressed="'+(iso[i]===S.day)+'"><small>'+DJ3[d.getDay()]+'</small><b>'+d.getDate()+'</b><span class="pt'+(has?' on':'')+'"></span></button>'}).join('')+'</div></div>'+
  '<h2>'+esc(cap(fmtDay(S.day)))+(S.day===today?' (aujourd\'hui)':'')+'</h2>'+
  (list.length?list.map(function(s){return studentSessionCard(s,S.studentId)}).join(''):'<div class="card"><p>Aucune session ce jour-là.</p></div>');
}
function studentAtt(){
 var id=S.studentId,st=stat(id),now=NOW();
 var hist=sessions().filter(function(s){return (s.marks&&s.marks[id])||s.status==='closed'}).reverse().slice(0,40);
 var alert=inAlert(st)?'<div class="note warn">Votre assiduité est sous le seuil de '+Math.round(RULES.thresh*100)+' % ou vous avez '+RULES.absMax+' absences non justifiées. Contactez l\'administration.</div>':'';
 return '<h1>Assiduité</h1>'+alert+
  '<div class="card"><div class="between" style="flex-wrap:wrap;gap:20px">'+donut(st)+legend(st)+'</div><small>Un retard compte pour une demi-présence. Les absences justifiées ne comptent pas dans le calcul.</small></div>'+
  '<div class="card"><h2>Historique</h2>'+(hist.length?hist.map(function(s){
   var m=s.marks&&s.marks[id],k=m?m.s:'A',extra='';
   if(k==='A'){var j=D.c.justifs.find(function(x){return x.ses===s.id&&x.stu===id});
    if(j)extra='<span class="chip c-'+j.status+'">Justificatif '+({pending:'en attente',validated:'validé',refused:'refusé'}[j.status])+'</span>';
    else if(now<startTs(s)+RULES.justifyHours*36e5)extra='<button class="btn sec sm" data-act="justify" data-id="'+s.id+'">Justifier</button>';
    else extra='<small>Délai dépassé</small>';}
   var d=parseDate(s.date);
   return '<div class="row"><div class="d"><small>'+DJ3[d.getDay()]+'</small><b>'+d.getDate()+'</b></div><div class="grow"><strong>'+esc(s.subject)+'</strong><br><small>'+(m&&m.t?METH[m.m]+' · '+hhmm(new Date(m.t)):s.start+' – '+s.end)+'</small></div><div style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end">'+chip(k)+extra+'</div></div>';
  }).join(''):'<p class="muted">Aucune session pointée pour le moment.</p>')+'</div>';
}
function studentNotif(){
 var list=notifications(S.studentId);
 return '<div class="between"><h1>Notifications</h1>'+(list.length?'<button class="link" data-act="readall">Tout marquer comme lu</button>':'')+'</div>'+
  '<div class="card">'+(list.length?list.map(function(n){var un=!readSet[n.id];
   return '<div class="notif'+(un?' un':'')+'"><div class="ic">'+ico(n.icon)+'</div><div class="grow"><h3>'+esc(n.title)+'</h3><small>'+esc(n.text)+'</small></div>'+(un?'<button class="link" data-act="read" data-id="'+esc(n.id)+'">Lu</button>':'')+'</div>'}).join(''):'<p class="muted">Rien de nouveau.</p>')+'</div>';
}
function studentMore(){
 var me=stuById(S.studentId);
 return '<h1>Afficher plus</h1><div class="card"><div class="between"><div><h2>'+esc(stuName(me))+'</h2><small>'+esc(me.email||'Étudiant')+'</small></div></div></div>'+
  '<div class="card"><h2>Règles de présence</h2><ul class="stack" style="margin:0;padding-left:18px"><li>Le pointage est possible de '+RULES.before+' minutes avant à '+RULES.after+' minutes après le début.</li><li>Pointé dans les '+RULES.late+' premières minutes : présent. Entre '+RULES.late+' et '+RULES.after+' minutes : retard (demi-présence).</li><li>Un justificatif se dépose jusqu\'à '+RULES.justifyHours+' h après la session.</li><li>Alerte sous '+Math.round(RULES.thresh*100)+' % d\'assiduité ou à partir de '+RULES.absMax+' absences non justifiées.</li></ul></div>'+
  '<div class="card"><button class="btn sec" data-act="export-me">'+ico('down')+'Exporter mon historique (CSV)</button></div>';
}

/* ---------- QR code : le code vient du serveur ---------- */
function qrPanel(s){
 var has=QR.sid===s.id&&QR.code;
 return '<div class="qrbox"><div class="qr" id="qr" data-c="'+(has?QR.code:'')+'">'+(has?qrSvg(QR.payload):'')+'</div><div class="qrmeta"><small>Code de pointage</small><div class="code" id="code">'+(has?QR.code.slice(0,3)+' '+QR.code.slice(3):'…')+'</div><div class="bar"><i id="barfill"></i></div><small id="cd"></small><small>Les étudiants scannent le QR code ou saisissent ce code. Il change toutes les '+RULES.qrSeconds+' secondes.</small></div></div>';
}
function paintQr(){
 var el=$('#qr');if(!el||QR.sid!==S.sessionId||!QR.code)return;
 if(el.dataset.c!==QR.code){el.dataset.c=QR.code;el.innerHTML=qrSvg(QR.payload);var c=$('#code');if(c)c.textContent=QR.code.slice(0,3)+' '+QR.code.slice(3)}
}
async function fetchQr(id){
 QR.busy=true;
 try{var r=await api('GET','/sessions/'+encodeURIComponent(id)+'/code');QR.sid=id;QR.code=r.code;QR.payload=r.payload;QR.exp=Date.now()+r.left*1000;paintQr()}catch(e){QR.exp=Date.now()+3000}
 QR.busy=false;
}
function tick(){
 var s=sesById(S.sessionId);if(!s||s.status!=='open'||!$('#qr'))return;
 if(!QR.busy&&(QR.sid!==s.id||Date.now()>=QR.exp))fetchQr(s.id);
 paintQr();
 var left=Math.max(0,Math.ceil((QR.exp-Date.now())/1000));
 var cd=$('#cd');if(cd)cd.textContent=QR.sid===s.id&&QR.code?'Nouveau code dans 0:'+p2(Math.min(left,59)):'';
 var bf=$('#barfill');if(bf)bf.style.width=(Math.min(left,RULES.qrSeconds)/RULES.qrSeconds*100)+'%';
}
setInterval(tick,1000);
setInterval(function(){if(S.me&&!modalOpen())render()},20000);

/* ---------- session detail ---------- */
function sessionDetail(s){
 var stu=students(),marks=s.marks||{},c={P:0,R:0,A:0,J:0,W:0};
 stu.forEach(function(x){var m=marks[x.id];if(m)c[m.s]++;else c.W++});
 var actions='';
 if(s.status==='planned')actions='<button class="btn" data-act="open-ses" data-id="'+s.id+'">Ouvrir le pointage</button>';
 if(s.status==='open')actions='<button class="btn yel" data-act="close-ses" data-id="'+s.id+'">Clôturer la session</button>';
 if(s.status==='closed')actions='<button class="btn sec" data-act="open-ses" data-id="'+s.id+'">Rouvrir le pointage</button>';
 if(S.role==='admin')actions+=' <button class="btn sec" data-act="del-ses" data-id="'+s.id+'">Supprimer</button>';
 return '<button class="link" data-act="back" style="align-self:flex-start">← Retour aux sessions</button>'+
  '<div class="card"><div class="between"><div><h1>'+esc(s.subject)+'</h1><small>'+esc(sessWhen(s))+' · '+sessMeta(s)+'</small></div>'+statusChip(s)+'</div>'+
  '<div class="between" style="justify-content:flex-start">'+actions+'</div>'+(s.status==='open'?qrPanel(s):'')+'</div>'+
  '<div class="grid4"><div class="kpi"><b>'+c.P+'</b><span>Présents</span></div><div class="kpi"><b>'+c.R+'</b><span>Retards</span></div><div class="kpi"><b>'+c.A+'</b><span>Absents</span></div><div class="kpi"><b>'+c.W+'</b><span>En attente</span></div></div>'+
  '<div class="card"><div class="between"><h2>Appel</h2><small>P présent · R retard · A absent · J justifiée</small></div>'+
  (stu.length?stu.map(function(x){var m=marks[x.id];
   return '<div class="row"><div class="grow"><strong>'+esc(stuName(x))+'</strong><br><small>'+(m?(METH[m.m]||'')+(m.t?' · '+hhmm(new Date(m.t)):''):'En attente')+'</small></div>'+sigThumb(s.id,x.id)+
    '<div class="mks">'+['P','R','A','J'].map(function(k){return '<button class="mk '+k+(m&&m.s===k?' on':'')+'" data-act="mark" data-stu="'+x.id+'" data-k="'+k+'" aria-pressed="'+!!(m&&m.s===k)+'" aria-label="'+LAB[k]+' : '+esc(stuName(x))+'">'+k+'</button>'}).join('')+'</div></div>'}).join(''):'<p class="muted">Aucun étudiant dans la promotion.</p>')+'</div>';
}
/* ---------- trainer views ---------- */
function trainerSessions(){
 if(S.sessionId){var s=sesById(S.sessionId);if(s)return sessionDetail(s);S.sessionId=null}
 var all=sessions().filter(function(s){return s.trainerId===S.me.id}),today=isoDate(new Date());
 var t=all.filter(function(s){return s.date===today}),up=all.filter(function(s){return s.date>today}),past=all.filter(function(s){return s.date<today}).reverse().slice(0,10);
 var n=students().length;
 function card(s){var k=s.marks?Object.keys(s.marks).length:0;
  return '<button class="card" data-act="ses" data-id="'+s.id+'" style="text-align:left;cursor:pointer;color:inherit;font:inherit"><div class="between"><small>'+esc(sessWhen(s))+'</small>'+statusChip(s)+'</div><h3>'+esc(s.subject)+'</h3><div class="between"><small>'+sessMeta(s)+'</small><small>'+k+' / '+n+' pointés</small></div></button>'}
 function block(title,l){return l.length?'<h2>'+title+'</h2>'+l.map(card).join(''):''}
 return '<h1>Mes sessions</h1>'+'<small>'+esc(stuName(S.me))+'</small>'+
  (all.length?block("Aujourd'hui",t)+block('À venir',up)+block('Passées',past):'<div class="card"><p>Aucune session pour le moment.</p></div>');
}
function studentsTable(canEdit){
 var rows=students().map(function(x){return{x:x,st:stat(x.id)}}).sort(function(a,b){return (inAlert(b.st)-inAlert(a.st))||String(a.x.name).localeCompare(String(b.x.name),'fr')});
 if(!rows.length)return '<div class="card empty"><p>Aucun étudiant dans la promotion.</p>'+(canEdit?'<button class="btn" data-act="add-stu">Ajouter un étudiant</button>':'')+'</div>';
 return '<div class="card flat"><div class="tbl"><table><thead><tr><th>Étudiant</th><th>Taux</th><th class="c">Prés.</th><th class="c">Ret.</th><th class="c">Abs.</th><th>Statut</th>'+(canEdit?'<th></th>':'')+'</tr></thead><tbody>'+
  rows.map(function(r){var a=inAlert(r.st);
   return '<tr><td><strong>'+esc(stuName(r.x))+'</strong>'+(canEdit&&r.x.email?'<br><small>'+esc(r.x.email)+'</small>':'')+'</td><td><div class="between" style="flex-wrap:nowrap;gap:8px"><div class="meter'+(a?' low':'')+'" style="width:70px"><i style="width:'+(r.st.rate==null?0:Math.round(r.st.rate*100))+'%"></i></div><span class="num">'+pct(r.st.rate)+'</span></div></td><td class="c num">'+r.st.P+'</td><td class="c num">'+r.st.R+'</td><td class="c num">'+r.st.A+'</td><td>'+(r.st.n?'<span class="chip c-'+(a?'alert':'ok')+'">'+(a?'Alerte':'OK')+'</span>':'<small>Aucune donnée</small>')+'</td>'+(canEdit?'<td style="white-space:nowrap"><button class="link" data-act="reset-pw" data-id="'+r.x.id+'">Réinitialiser le mot de passe</button> <button class="link" data-act="del-user" data-id="'+r.x.id+'">Supprimer</button></td>':'')+'</tr>'}).join('')+'</tbody></table></div></div>';
}
function trainerRoster(){return '<h1>Étudiants</h1><small>Taux calculé sur toutes les sessions. Un retard compte pour une demi-présence.</small>'+studentsTable(false)}
function adminDash(){
 var stu=students(),ses=sessions(),today=isoDate(new Date());
 var stats=stu.map(function(x){return{x:x,st:stat(x.id)}}),withData=stats.filter(function(r){return r.st.n});
 var avg=withData.length?withData.reduce(function(a,r){return a+r.st.rate},0)/withData.length:null;
 var alerts=stats.filter(function(r){return inAlert(r.st)}).sort(function(a,b){return a.st.rate-b.st.rate});
 var pend=D.c.justifs.filter(function(j){return j.status==='pending'}).length;
 var todays=ses.filter(function(s){return s.date===today});
 var empty=(!stu.length&&!ses.length)?'<div class="card empty"><h2>Aucune donnée pour l\'instant</h2><p>Ajoutez vos étudiants, vos formateurs et vos sessions depuis les onglets du menu.</p><div class="between" style="justify-content:flex-start"><button class="btn" data-act="add-stu">Ajouter un étudiant</button></div></div>':'';
 return '<h1>Tableau de bord</h1>'+empty+
  '<div class="grid4"><div class="kpi"><b>'+(avg==null?'–':Math.round(avg*100)+' %')+'</b><span>Assiduité moyenne</span></div><div class="kpi"><b>'+alerts.length+'</b><span>Étudiants en alerte</span></div><div class="kpi"><b>'+todays.length+'</b><span>Sessions aujourd\'hui</span></div><div class="kpi"><b>'+pend+'</b><span>Justificatifs à traiter</span></div></div>'+
  '<div class="card"><h2>À surveiller</h2>'+(alerts.length?alerts.map(function(r){return '<div class="row"><div class="grow"><strong>'+esc(stuName(r.x))+'</strong><br><small>'+r.st.A+' absence'+(r.st.A>1?'s':'')+' non justifiée'+(r.st.A>1?'s':'')+'</small></div><span class="num">'+pct(r.st.rate)+'</span><span class="chip c-alert">Alerte</span></div>'}).join(''):'<p class="muted">Aucun étudiant sous le seuil de '+Math.round(RULES.thresh*100)+' %.</p>')+'</div>'+
  '<div class="card"><h2>Sessions du jour</h2>'+(todays.length?todays.map(function(s){return '<div class="row"><div class="grow"><strong>'+esc(s.subject)+'</strong><br><small>'+s.start+' – '+s.end+' · '+sessMeta(s)+'</small></div>'+statusChip(s)+'<button class="btn sec sm" data-act="ses-admin" data-id="'+s.id+'">Ouvrir</button></div>'}).join(''):'<p class="muted">Aucune session aujourd\'hui.</p>')+'</div>';
}
function adminSessions(){
 if(S.sessionId){var s=sesById(S.sessionId);if(s)return sessionDetail(s);S.sessionId=null}
 var ses=sessions().slice().reverse();
 return '<div class="between"><h1>Sessions</h1><button class="btn" data-act="add-ses">'+ico('plus')+'Nouvelle session</button></div>'+
  (ses.length?'<div class="card flat"><div class="tbl"><table><thead><tr><th>Date</th><th>Horaires</th><th>Matière</th><th>Salle</th><th>Formateur</th><th>Statut</th><th></th></tr></thead><tbody>'+
  ses.map(function(s){return '<tr><td>'+esc(cap(fmtDay(s.date)))+'</td><td class="num">'+s.start+' – '+s.end+'</td><td><strong>'+esc(s.subject)+'</strong></td><td>'+esc(s.room||'')+'</td><td>'+esc(s.trainer||'')+'</td><td>'+statusChip(s)+'</td><td><button class="link" data-act="ses-admin" data-id="'+s.id+'">Ouvrir</button></td></tr>'}).join('')+'</tbody></table></div></div>':'<div class="card empty"><p>Aucune session planifiée.</p></div>');
}
function adminStudents(){return '<div class="between"><h1>Étudiants</h1><button class="btn" data-act="add-stu">'+ico('plus')+'Ajouter un étudiant</button></div>'+studentsTable(true)}
function adminTrainers(){
 var tr=D.c.trainers;
 return '<div class="between"><h1>Formateurs</h1><button class="btn" data-act="add-tr">'+ico('plus')+'Ajouter un formateur</button></div>'+
  (tr.length?'<div class="card flat"><div class="tbl"><table><thead><tr><th>Formateur</th><th>Sessions</th><th></th></tr></thead><tbody>'+tr.map(function(x){var n=D.c.sessions.filter(function(s){return s.trainerId===x.id}).length;
   return '<tr><td><strong>'+esc(stuName(x))+'</strong><br><small>'+esc(x.email||'')+'</small></td><td class="num">'+n+'</td><td style="white-space:nowrap"><button class="link" data-act="reset-pw" data-id="'+x.id+'">Réinitialiser le mot de passe</button> <button class="link" data-act="del-user" data-id="'+x.id+'">Supprimer</button></td></tr>'}).join('')+'</tbody></table></div></div>':'<div class="card empty"><p>Aucun formateur.</p></div>');
}
function adminJustifs(){
 var js=D.c.justifs.slice().sort(function(a,b){return String(b.at).localeCompare(String(a.at))});
 var pend=js.filter(function(j){return j.status==='pending'}),done=js.filter(function(j){return j.status!=='pending'});
 function line(j,act){var s=sesById(j.ses),x=stuById(j.stu);
  return '<div class="row" style="align-items:flex-start"><div class="grow"><strong>'+esc(stuName(x))+'</strong><br><small>'+(s?esc(s.subject)+', '+esc(fmtDay(s.date)):'Session supprimée')+'</small><p style="margin-top:6px">'+esc(j.reason)+'</p></div>'+
   (act?'<div class="stack" style="gap:6px"><button class="btn sm" data-act="jdec" data-id="'+j.id+'" data-v="validated">Valider</button><button class="btn sec sm" data-act="jdec" data-id="'+j.id+'" data-v="refused">Refuser</button></div>':'<span class="chip c-'+j.status+'">'+(j.status==='validated'?'Validé':'Refusé')+'</span>')+'</div>'}
 return '<h1>Justificatifs</h1><div class="card"><h2>À traiter</h2>'+(pend.length?pend.map(function(j){return line(j,true)}).join(''):'<p class="muted">Aucun justificatif en attente.</p>')+'</div>'+
  (done.length?'<div class="card"><h2>Traités</h2>'+done.map(function(j){return line(j,false)}).join('')+'</div>':'');
}
function matrix(){
 var ses=sessions().filter(function(s){return s.marks&&Object.keys(s.marks).length});
 return {ses:ses,stu:students()};
}
function adminExport(){
 var m=matrix(),shown=m.ses.slice(-10);
 return '<div class="between"><h1>Export</h1><button class="btn" data-act="export-all" '+(m.ses.length?'':'disabled')+'>'+ico('down')+'Télécharger le tableau (CSV)</button></div>'+
  '<small>Même structure que le tableau Excel de suivi : une ligne par étudiant, une colonne par session, puis les totaux et le taux d\'assiduité.</small>'+
  (m.ses.length?'<div class="card flat mx"><div class="tbl"><table><thead><tr><th>Étudiant</th>'+shown.map(function(s){return '<th class="c">'+esc(s.date.slice(8)+'/'+s.date.slice(5,7))+'<br>'+s.start+'</th>'}).join('')+'<th class="c">Taux</th></tr></thead><tbody>'+
   m.stu.map(function(x){var st=stat(x.id);return '<tr><td><strong>'+esc(stuName(x))+'</strong></td>'+shown.map(function(s){var k=s.marks[x.id];return '<td class="c">'+(k?'<span class="chip c-'+k.s+'">'+k.s+'</span>':'')+'</td>'}).join('')+'<td class="c num"><strong>'+pct(st.rate)+'</strong></td></tr>'}).join('')+'</tbody></table></div></div>':'<div class="card"><p class="muted">Aucune présence enregistrée pour l\'instant.</p></div>');
}
function csvCell(v){v=String(v==null?'':v);return /[;"\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}
function csvAll(){
 var m=matrix(),head=['Nom','Prénom'].concat(m.ses.map(function(s){return s.date+' '+s.start})).concat(['Présences','Retards','Absences','Justifiées','Sessions comptées',"Taux d'assiduité"]);
 var rows=[head].concat(m.stu.map(function(x){var st=stat(x.id);return [x.name,x.first].concat(m.ses.map(function(s){return s.marks[x.id]?s.marks[x.id].s:''})).concat([st.P,st.R,st.A,st.J,st.n,st.rate==null?'':(st.rate*100).toFixed(1).replace('.',',')+' %'])}));
 return '﻿'+rows.map(function(r){return r.map(csvCell).join(';')}).join('\r\n');
}
function csvMe(){
 var id=S.studentId,rows=[['Date','Début','Fin','Matière','Statut','Mode de pointage','Heure']];
 sessions().forEach(function(s){var m=s.marks&&s.marks[id];if(m)rows.push([s.date,s.start,s.end,s.subject,LAB[m.s],METH[m.m]||'',m.t?hhmm(new Date(m.t)):'']);});
 return '﻿'+rows.map(function(r){return r.map(csvCell).join(';')}).join('\r\n');
}

async function saveCsv(name,data){
 try{var u=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},4000);toast('Fichier téléchargé.')}
 catch(e){toast("Le téléchargement n'est pas disponible ici.")}
}


/* ---------- connexion ---------- */
function loginHtml(){
 return '<section class="login"><div class="card"><div class="brand"><span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'+ICON.check+'</svg></span><div><strong>Suivi de présence</strong></div></div>'+
  '<h1>Connexion</h1><p class="muted">Connectez-vous avec votre adresse e-mail.</p>'+
  '<form id="loginForm" novalidate><label class="fld"><span>E-mail</span><input id="l-email" type="email" autocomplete="username" autocapitalize="none" required></label>'+
  '<label class="fld"><span>Mot de passe</span><input id="l-pass" type="password" autocomplete="current-password" required></label>'+
  '<p class="note warn" id="l-err" hidden></p><button class="btn wide" type="submit">Se connecter</button></form>'+
  '<small>Mot de passe oublié ? Demandez une réinitialisation à l\'administration.</small></div></section>';
}
async function doLogin(){
 var e=$('#l-email').value.trim(),p=$('#l-pass').value,er=$('#l-err');
 if(!e||!p){er.textContent='Saisissez votre e-mail et votre mot de passe.';er.hidden=false;return}
 if(S.busy)return;S.busy=true;
 try{
  await api('POST','/login',{email:e,password:p});
  await refresh(true);S.tab=defaultTab(S.role);S.sessionId=null;render();window.scrollTo(0,0);
 }catch(x){er.textContent=x.message;er.hidden=false;var pw=$('#l-pass');if(pw){pw.value='';pw.focus()}}
 S.busy=false;
}

/* ---------- shell ---------- */
var NAVS={
 student:[['home','home','Accueil'],['plan','cal','Planning'],['att','chart','Assiduité'],['notif','bell','Notifications'],['more','menu','Plus']],
 trainer:[['sessions','cal','Sessions'],['roster','users','Étudiants']],
 admin:[['dash','grid','Tableau de bord'],['sessions','cal','Sessions'],['students','users','Étudiants'],['trainers','users','Formateurs'],['justifs','file','Justificatifs'],['export','down','Export']]
};
function headerHtml(){
 var who=S.me?stuName(S.me)+' · '+ROLE_LAB[S.role]:'';
 return '<header class="top"><div class="brand"><span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'+ICON.check+'</svg></span><div><strong>Suivi de présence</strong>'+(who?'<span class="sub">'+esc(who)+'</span>':'')+'</div></div>'+
  (S.me?'<div class="top-r"><button class="btn sec sm" data-act="pwd">Mot de passe</button><button class="btn sec sm" data-act="logout">Déconnexion</button></div>':'')+'</header>';
}
function navHtml(){
 return '<nav class="nav" aria-label="Navigation principale"><div class="nav-in">'+NAVS[S.role].map(function(n){
  var b=0;if(S.role==='student'&&n[0]==='notif')b=unread(S.studentId);if(S.role==='admin'&&n[0]==='justifs')b=D.c.justifs.filter(function(j){return j.status==='pending'}).length;
  return '<button data-act="tab" data-tab="'+n[0]+'"'+(S.tab===n[0]?' aria-current="page"':'')+'>'+ico(n[1])+'<span>'+n[2]+'</span>'+(b?'<span class="badge">'+b+'</span>':'')+'</button>'}).join('')+'</div></nav>';
}
function viewHtml(){
 if(S.role==='student')return {home:studentHome,plan:studentPlan,att:studentAtt,notif:studentNotif,more:studentMore}[S.tab]();
 if(S.role==='trainer')return (S.tab==='roster'?trainerRoster:trainerSessions)();
 return {dash:adminDash,sessions:adminSessions,students:adminStudents,trainers:adminTrainers,justifs:adminJustifs,export:adminExport}[S.tab]();
}
function render(){
 var app=$('#app');
 if(S.boot){app.innerHTML='<p class="muted loading">Chargement…</p>';return}
 if(!S.me){if(!$('#loginForm')){app.innerHTML=headerHtml()+loginHtml();var f=$('#l-email');if(f&&matchMedia('(pointer:fine)').matches)f.focus()}return}
 var a=document.activeElement;
 if(a&&app.contains(a)&&/^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName))return;
 var valid=NAVS[S.role].some(function(n){return n[0]===S.tab});
 if(!valid)S.tab=defaultTab(S.role);
 app.innerHTML=headerHtml()+navHtml()+'<main class="main">'+viewHtml()+'</main>';
 tick();
}

/* ---------- signature pad ---------- */
var pad={strokes:[],drawing:false,cv:null,ctx:null};
function initPad(){
 var cv=$('#pad');if(!cv)return;pad.cv=cv;pad.strokes=[];
 var r=window.devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;cv.width=w*r;cv.height=h*r;
 var ctx=cv.getContext('2d');ctx.scale(r,r);ctx.lineWidth=3.5;ctx.lineCap='round';ctx.lineJoin='round';
 ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--pad-ink').trim()||'#FDD58A';pad.ctx=ctx;
 function pt(e){var b=cv.getBoundingClientRect();return[e.clientX-b.left,e.clientY-b.top]}
 cv.addEventListener('pointerdown',function(e){e.preventDefault();cv.setPointerCapture(e.pointerId);pad.drawing=true;var p=pt(e);pad.strokes.push([p]);ctx.beginPath();ctx.moveTo(p[0],p[1]);var hnt=$('#padhint');if(hnt)hnt.hidden=true});
 cv.addEventListener('pointermove',function(e){if(!pad.drawing)return;var p=pt(e),s=pad.strokes[pad.strokes.length-1],l=s[s.length-1];if(Math.abs(p[0]-l[0])+Math.abs(p[1]-l[1])<2)return;s.push(p);ctx.lineTo(p[0],p[1]);ctx.stroke()});
 var end=function(){pad.drawing=false};cv.addEventListener('pointerup',end);cv.addEventListener('pointercancel',end);
}
function padClear(){if(!pad.cv)return;pad.ctx.clearRect(0,0,pad.cv.clientWidth,pad.cv.clientHeight);pad.strokes=[];var h=$('#padhint');if(h)h.hidden=false}
function padPath(){
 var w=pad.cv.clientWidth,h=pad.cv.clientHeight,out='';
 pad.strokes.forEach(function(s){s.forEach(function(p,i){out+=(i?'L':'M')+Math.round(p[0]/w*300)+' '+Math.round(p[1]/h*180)});if(s.length===1)out+='l0 0'});
 return out.length>9000?out.slice(0,9000):out;
}
var padPoints=function(){return pad.strokes.reduce(function(a,s){return a+s.length},0)};

/* ---------- modals ---------- */
function pointModal(s){
 var ps=pState(s,NOW());
 return '<h2>Pointer ma présence</h2><p class="muted">'+esc(s.subject)+' · '+esc(sessWhen(s))+(s.room?' · '+esc(s.room):'')+'</p>'+
  (ps.ok?'<p class="note ok">'+(ps.status==='P'?'Vous serez noté présent.':'Vous serez noté en retard (demi-présence).')+'</p>':'<p class="note warn">'+esc(ps.msg)+'</p>')+
  '<div class="seg"><button data-act="ptab" data-t="sig" class="on">Signature</button><button data-act="ptab" data-t="qr">Code QR</button></div>'+
  '<div id="p-sig" class="stack"><div class="padwrap"><canvas id="pad" aria-label="Zone de signature"></canvas><span class="padhint" id="padhint">Signez avec le doigt ou la souris</span></div><div class="between"><small>Votre signature est horodatée et rattachée à cette session.</small><button class="link" data-act="padclear">Effacer</button></div><button class="btn wide" data-act="sig-submit"'+(ps.ok?'':' disabled')+'>Valider ma présence</button></div>'+
  '<div id="p-qr" class="stack" hidden><p class="muted">Scannez le QR code affiché par votre formateur avec l\'appareil photo de votre téléphone. Il contient un code de 6 chiffres, écrit aussi sous le QR code. Saisissez-le ici.</p><label class="fld"><span>Code à 6 chiffres</span><input id="codeIn" inputmode="numeric" autocomplete="off" placeholder="123 456"></label><button class="btn wide" data-act="code-submit"'+(ps.ok?'':' disabled')+'>Valider avec le code</button></div>'+
  '<button class="btn sec wide" data-act="close">Annuler</button>';
}
async function submitPoint(method,payload){
 var s=sesById(S.pointSession);if(!s||S.busy)return;
 S.busy=true;
 try{
  var r=await api('POST','/sessions/'+encodeURIComponent(s.id)+'/point',method==='qr'?{method:'qr',code:payload}:{method:'signature',sig:payload});
  await refresh(true);closeModal();toast(r.status==='P'?'Présence enregistrée.':'Retard enregistré (demi-présence).');
 }catch(e){
  if(e.status===409){try{await refresh(true)}catch(x){}closeModal()}
  toast(e.message);
 }
 S.busy=false;
}
function sessionForm(){
 return '<h2>Nouvelle session</h2><label class="fld"><span>Matière</span><input id="f-subject" placeholder="Développement web"></label>'+
  '<div class="two"><label class="fld"><span>Date</span><input id="f-date" type="date" value="'+isoDate(new Date())+'"></label><label class="fld"><span>Salle</span><input id="f-room" placeholder="B12"></label></div>'+
  '<div class="two"><label class="fld"><span>Début</span><input id="f-start" type="time" value="09:00"></label><label class="fld"><span>Fin</span><input id="f-end" type="time" value="12:00"></label></div>'+
  '<label class="fld"><span>Formateur</span><select id="f-trainer"><option value="">Non attribué</option>'+D.c.trainers.map(function(t){return '<option value="'+esc(t.id)+'">'+esc(stuName(t))+'</option>'}).join('')+'</select></label>'+
  '<p class="note warn" id="f-err" hidden></p><button class="btn wide" data-act="save-ses">Créer la session</button><button class="btn sec wide" data-act="close">Annuler</button>';
}
function userForm(role){
 var tr=role==='trainer';
 return '<h2>'+(tr?'Ajouter un formateur':'Ajouter un étudiant')+'</h2><div class="two"><label class="fld"><span>Prénom</span><input id="f-first"></label><label class="fld"><span>Nom</span><input id="f-name"></label></div>'+
  '<label class="fld"><span>E-mail</span><input id="f-email" type="email" autocapitalize="none"></label><p class="muted">Un mot de passe provisoire sera généré et affiché une seule fois.</p><p class="note warn" id="f-err" hidden></p>'+
  '<button class="btn wide" data-act="save-user" data-role="'+role+'">Créer le compte</button><button class="btn sec wide" data-act="close">Annuler</button>';
}
function tempModal(title,who,pw){
 return '<h2>'+esc(title)+'</h2><p>Communiquez ce mot de passe provisoire à '+esc(who)+'. Il ne sera plus affiché.</p><p class="note ok"><span class="pw">'+esc(pw)+'</span></p><p class="muted">La personne pourra le remplacer via le bouton « Mot de passe ».</p><button class="btn wide" data-act="close">J\'ai noté le mot de passe</button>';
}
function pwdForm(){
 return '<h2>Changer de mot de passe</h2><label class="fld"><span>Mot de passe actuel</span><input id="f-old" type="password" autocomplete="current-password"></label><label class="fld"><span>Nouveau mot de passe (8 caractères minimum)</span><input id="f-new" type="password" autocomplete="new-password"></label><label class="fld"><span>Confirmer</span><input id="f-new2" type="password" autocomplete="new-password"></label><p class="note warn" id="f-err" hidden></p><button class="btn wide" data-act="save-pwd">Enregistrer</button><button class="btn sec wide" data-act="close">Annuler</button>';
}

function confirmModal(title,text,act,id){
 return '<h2>'+esc(title)+'</h2><p>'+esc(text)+'</p><button class="btn wide" data-act="'+act+'" data-id="'+esc(id||'')+'">Confirmer</button><button class="btn sec wide" data-act="close">Annuler</button>';
}
function formErr(m){var e=$('#f-err');e.textContent=m;e.hidden=false}

/* ---------- events ---------- */
function userById(id){return D.c.students.concat(D.c.trainers).find(function(x){return x.id===id})}
function closeModalSilent(){$('#ov').innerHTML='';S.pointSession=null}
var H={
 logout:async function(){try{await api('POST','/logout',{})}catch(e){}S.me=null;S.role=null;D.sig='';SIGS={};QR.sid=null;S.sessionId=null;render();window.scrollTo(0,0)},
 pwd:function(){openModal(pwdForm())},
 'save-pwd':async function(){
  var o=$('#f-old').value,n=$('#f-new').value,n2=$('#f-new2').value;
  if(n.length<8){formErr('Le nouveau mot de passe doit faire au moins 8 caractères.');return}
  if(n!==n2){formErr('Les deux mots de passe ne correspondent pas.');return}
  try{await api('POST','/password',{old:o,new:n});closeModal();toast('Mot de passe modifié.')}catch(e){formErr(e.message)}
 },
 tab:function(t){S.tab=t.dataset.tab;S.sessionId=null;render();window.scrollTo(0,0)},
 week:function(t){S.weekOffset+=Number(t.dataset.d);S.day=null;render()},
 day:function(t){S.day=t.dataset.day;render()},
 point:function(t){var s=sesById(t.dataset.id);if(!s)return;S.pointSession=s.id;openModal(pointModal(s));initPad()},
 ptab:function(t){var sig=t.dataset.t==='sig';$('#p-sig').hidden=!sig;$('#p-qr').hidden=sig;document.querySelectorAll('.seg button').forEach(function(b){b.classList.toggle('on',b===t)});if(!sig){var i=$('#codeIn');if(i)i.focus()}},
 padclear:function(){padClear()},
 'sig-submit':function(){if(padPoints()<12){toast('Signez dans le cadre avant de valider.');return}submitPoint('signature',padPath())},
 'code-submit':function(){var v=$('#codeIn').value.replace(/\D/g,'');if(v.length!==6){toast('Saisissez les 6 chiffres du code.');return}submitPoint('qr',v)},
 close:function(){closeModal()},
 ovbg:function(t,e){if(e.target===t)closeModal()},
 justify:function(t){S.pointSession=t.dataset.id;openModal('<h2>Déposer un justificatif</h2><label class="fld"><span>Motif de l\'absence</span><textarea id="f-reason" placeholder="Expliquez brièvement la raison de votre absence"></textarea></label><p class="note warn" id="f-err" hidden></p><button class="btn wide" data-act="save-justify">Envoyer</button><button class="btn sec wide" data-act="close">Annuler</button>')},
 'save-justify':async function(){
  var r=$('#f-reason').value.trim();if(r.length<5){formErr('Indiquez un motif (5 caractères minimum).');return}
  try{await api('POST','/justifs',{sessionId:S.pointSession,reason:r.slice(0,500)});await refresh(true);closeModal();toast('Justificatif envoyé à l\'administration.')}catch(e){formErr(e.message)}
 },
 read:function(t){readSet[t.dataset.id]=1;ls.set('presence.read',JSON.stringify(readSet));render()},
 readall:function(){notifications(S.studentId).forEach(function(n){readSet[n.id]=1});ls.set('presence.read',JSON.stringify(readSet));render()},
 ses:async function(t){S.sessionId=t.dataset.id;render();window.scrollTo(0,0);if(await loadSigs(S.sessionId))render()},
 'ses-admin':async function(t){S.tab='sessions';S.sessionId=t.dataset.id;render();window.scrollTo(0,0);if(await loadSigs(S.sessionId))render()},
 back:function(){S.sessionId=null;render()},
 'open-ses':async function(t){if(await run(function(){return api('POST','/sessions/'+encodeURIComponent(t.dataset.id)+'/open',{})}))await sync()},
 'close-ses':function(t){openModal(confirmModal('Clôturer la session','Les étudiants sans pointage seront notés absents. Vous pourrez encore corriger l\'appel ensuite.','close-ses-ok',t.dataset.id))},
 'close-ses-ok':async function(t){if(await run(function(){return api('POST','/sessions/'+encodeURIComponent(t.dataset.id)+'/close',{})},'Session clôturée.')){await refresh(true);closeModal()}},
 mark:async function(t){var id=S.sessionId;if(await run(function(){return api('PUT','/sessions/'+encodeURIComponent(id)+'/marks/'+encodeURIComponent(t.dataset.stu),{s:t.dataset.k})}))await sync()},
 'add-ses':function(){openModal(sessionForm())},
 'save-ses':async function(){
  var v=function(id){return $('#'+id).value.trim()},d={date:v('f-date'),start:v('f-start'),end:v('f-end'),subject:v('f-subject'),room:v('f-room'),trainerId:v('f-trainer')||null};
  if(!d.subject||!d.date||!d.start||!d.end){formErr('Renseignez la matière, la date et les horaires.');return}
  if(d.end<=d.start){formErr('L\'heure de fin doit être après l\'heure de début.');return}
  try{await api('POST','/sessions',d);await refresh(true);closeModal();toast('Session créée.')}catch(e){formErr(e.message)}
 },
 'del-ses':function(t){openModal(confirmModal('Supprimer la session','La session et tous ses pointages seront supprimés. Cette action est définitive.','del-ses-ok',t.dataset.id))},
 'del-ses-ok':async function(t){if(await run(function(){return api('DELETE','/sessions/'+encodeURIComponent(t.dataset.id))},'Session supprimée.')){S.sessionId=null;await refresh(true);closeModal()}},
 'add-stu':function(){openModal(userForm('student'))},
 'add-tr':function(){openModal(userForm('trainer'))},
 'save-user':async function(t){
  var v=function(id){return $('#'+id).value.trim()},f=v('f-first'),n=v('f-name'),m=v('f-email'),role=t.dataset.role;
  if(!f||!n){formErr('Renseignez le prénom et le nom.');return}
  if(!m){formErr('Renseignez une adresse e-mail.');return}
  try{var r=await api('POST','/users',{first:f,name:n,email:m,role:role});await refresh(true);openModal(tempModal('Compte créé',f+' '+n,r.tempPassword));render()}catch(e){formErr(e.message)}
 },
 'del-user':function(t){var x=userById(t.dataset.id);openModal(confirmModal('Supprimer '+(x?stuName(x):'ce compte'),'Le compte et les pointages associés seront supprimés. Cette action est définitive.','del-user-ok',t.dataset.id))},
 'del-user-ok':async function(t){if(await run(function(){return api('DELETE','/users/'+encodeURIComponent(t.dataset.id))},'Compte supprimé.')){await refresh(true);closeModal()}},
 'reset-pw':function(t){var x=userById(t.dataset.id);openModal(confirmModal('Réinitialiser le mot de passe','Un nouveau mot de passe provisoire sera généré pour '+(x?stuName(x):'ce compte')+'. L\'ancien ne fonctionnera plus.','reset-pw-ok',t.dataset.id))},
 'reset-pw-ok':async function(t){
  var x=userById(t.dataset.id);
  try{var r=await api('POST','/users/'+encodeURIComponent(t.dataset.id)+'/reset-password',{});openModal(tempModal('Mot de passe réinitialisé',x?stuName(x):'la personne',r.tempPassword))}catch(e){toast(e.message)}
 },
 jdec:async function(t){if(await run(function(){return api('PUT','/justifs/'+encodeURIComponent(t.dataset.id),{status:t.dataset.v})},t.dataset.v==='validated'?'Justificatif validé.':'Justificatif refusé.'))await sync()},
 'export-all':function(){saveCsv('presence-promotion.csv',csvAll())},
 'export-me':function(){saveCsv('mon-historique-presence.csv',csvMe())}
};
document.addEventListener('click',function(e){
 var t=e.target.closest('[data-act]');if(!t)return;
 var h=H[t.dataset.act];if(h){if(t.tagName==='A')e.preventDefault();h(t,e)}
});
document.addEventListener('submit',function(e){if(e.target.id==='loginForm'){e.preventDefault();doLogin()}});
document.addEventListener('focusout',function(){setTimeout(function(){if(!modalOpen())changed()},50)});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&modalOpen())closeModal()});

(async function(){
 try{await refresh(true);S.tab=defaultTab(S.role)}catch(e){if(e.status!==401)toast(e.message)}
 S.boot=false;render();
})();
})();
