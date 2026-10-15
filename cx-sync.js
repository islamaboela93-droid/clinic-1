/* مزامنة العيادة بين الموبايلات عبر Firebase (Firestore + تسجيل دخول بإيميل وباسورد) */
(function(){
"use strict";
var FB="https://www.gstatic.com/firebasejs/10.14.1/";
var KEYS=["patients","cases","payments","expenses","appointments","plans","labJobs"];
var BK="clinic:syncbase",UK="clinic:syncuid";
var st={s:"nocfg",msg:"",email:"",last:""},subs=[];
function set(s,msg){st={s:s,msg:msg||"",email:st.email,last:st.last};subs.slice().forEach(function(f){try{f(st)}catch(e){}})}
function hash(s){var h1=0xdeadbeef,h2=0x41c6ce57,ch;for(var i=0;i<s.length;i++){ch=s.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677)}h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return(4294967296*(2097151&h2)+(h1>>>0)).toString(36)}
function metaOf(d){var m={};Object.keys(d||{}).forEach(function(k){if(KEYS.indexOf(k)<0)m[k]=d[k]});return JSON.stringify(m)}
/* بيحسب إيه اللي اتغيّر محليًا من آخر مزامنة */
function diff(data,base){
 var sets=[],dels=[],nb={},seen={};
 KEYS.forEach(function(k){(data[k]||[]).forEach(function(r){
  if(!r||r.id==null)return;var id=String(r.id),doc=k+"__"+id,j=JSON.stringify(r),h=hash(j);
  seen[doc]=1;nb[doc]=h;if(base[doc]!==h)sets.push({doc:doc,k:k,id:id,d:j})})});
 Object.keys(base).forEach(function(doc){
  if(doc==="__meta"||seen[doc])return;var k=doc.split("__")[0];if(KEYS.indexOf(k)<0)return;
  nb[doc]="x";if(base[doc]!=="x")dels.push({doc:doc,k:k,id:doc.slice(k.length+2)})});
 var mj=metaOf(data),mh=hash(mj);nb.__meta=mh;if(base.__meta!==mh)sets.push({doc:"__meta",k:"__meta",id:"__meta",d:mj});
 return{sets:sets,dels:dels,nb:nb}}
/* بيطبّق تغييرات جاية من موبايل تاني على البيانات المحلية (من غير ما يلمس تعديل محلي لسه ماترفعش) */
function applyRemote(prev,ops,base){
 var next=Object.assign({},prev),nb=Object.assign({},base),chg={},changed=false;
 ops.forEach(function(op){
  if(op.doc==="__meta"){
   var cur0=hash(metaOf(next));if(base.__meta!==undefined&&cur0!==base.__meta)return;
   try{var m=JSON.parse(op.d),diffm=false;Object.keys(m).forEach(function(k){if(KEYS.indexOf(k)<0&&JSON.stringify(next[k])!==JSON.stringify(m[k])){next[k]=m[k];diffm=true}});if(diffm)changed=true;nb.__meta=hash(metaOf(next))}catch(e){}
   return}
  var k=op.k;if(KEYS.indexOf(k)<0)return;
  var arr=chg[k]||(chg[k]=(next[k]||[]).slice());
  var idx=-1;for(var i=0;i<arr.length;i++){if(arr[i]&&String(arr[i].id)===op.id){idx=i;break}}
  var cur=idx>=0?hash(JSON.stringify(arr[idx])):null;
  var dirty=idx>=0&&base[op.doc]!==undefined&&base[op.doc]!=="x"&&cur!==base[op.doc];
  if(dirty)return;
  if(op.del){if(idx>=0){arr.splice(idx,1);changed=true}nb[op.doc]="x";return}
  var rec;try{rec=JSON.parse(op.d)}catch(e){return}
  var rh=hash(JSON.stringify(rec));
  if(idx>=0){if(cur!==rh){arr[idx]=rec;changed=true}}
  else{if(k==="patients")arr.unshift(rec);else arr.push(rec);changed=true}
  nb[op.doc]=rh});
 Object.keys(chg).forEach(function(k){next[k]=chg[k]});
 return{next:changed?next:prev,nb:nb,changed:changed}}
/* ====== الربط مع Firebase ====== */
var api=null,user=null,db=null,auth=null,fs=null,AU=null,unsub=null,ready=false,timer=null,booted=false,booting=false,pend=null;
var base={};try{base=JSON.parse(localStorage.getItem(BK)||"{}")}catch(e){}
function saveBase(){try{localStorage.setItem(BK,JSON.stringify(base))}catch(e){}}
function emsg(e){var c=(e&&e.code)||"";
 if(c==="permission-denied"||c==="firestore/permission-denied")return"الحساب ده مش مسموح له. راجع قواعد Firestore والإيميل المكتوب فيها.";
 if(c==="auth/invalid-credential"||c==="auth/wrong-password"||c==="auth/user-not-found"||c==="auth/invalid-login-credentials")return"الإيميل أو الباسورد غلط.";
 if(c==="auth/invalid-email")return"الإيميل مش مكتوب صح.";
 if(c==="auth/too-many-requests")return"محاولات كتير. استنى شوية وجرّب تاني.";
 if(c==="auth/network-request-failed"||c==="unavailable")return"مفيش نت دلوقتي. التعديلات هتتبعت أول ما النت يرجع.";
 return"حصلت مشكلة: "+((e&&(e.code||e.message))||e)}
function stop(){if(unsub){try{unsub()}catch(e){}unsub=null}ready=false}
function start(){
 if(!user||!api||!db||unsub)return;
 try{if(localStorage.getItem(UK)!==user.uid){base={};saveBase();localStorage.setItem(UK,user.uid)}}catch(e){}
 ready=false;set("busy","بيتزامن...");
 unsub=fs.onSnapshot(fs.collection(db,"records"),function(snap){
  var ops=[];
  snap.docChanges().forEach(function(c){
   if(c.type==="removed"||c.doc.metadata.hasPendingWrites)return;
   var x=c.doc.data();ops.push({doc:c.doc.id,k:x.k,id:String(x.id),del:!!x.del,d:x.d})});
  if(ops.length){
   var b0=Object.assign({},base),r=applyRemote(api.get(),ops,base);
   base=r.nb;saveBase();
   if(r.changed)api.set(function(prev){return applyRemote(prev,ops,b0).next})}
  if(!ready){ready=true;doPush(api.get())}
  else if(!snap.metadata.hasPendingWrites&&st.s!=="err")set("ok")
 },function(err){set("err",emsg(err))})}
function doPush(data){
 if(!user||!db||!ready||!data)return;
 var d=diff(data,base);
 if(!d.sets.length&&!d.dels.length){st.last=new Date().toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"});set("ok");return}
 var ts=Date.now(),ops=d.sets.map(function(o){return{doc:o.doc,v:{k:o.k,id:o.id,d:o.d,del:false,ts:ts}}}).concat(d.dels.map(function(o){return{doc:o.doc,v:{k:o.k,id:o.id,d:"",del:true,ts:ts}}}));
 base=d.nb;saveBase();set("busy","بيرفع التعديلات...");
 var ps=[];
 for(var i=0;i<ops.length;i+=400){var b=fs.writeBatch(db);ops.slice(i,i+400).forEach(function(o){b.set(fs.doc(db,"records",o.doc),o.v)});ps.push(b.commit())}
 Promise.all(ps).then(function(){st.last=new Date().toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"});set("ok")}).catch(function(err){base={};saveBase();set("err",emsg(err))})}
function push(data){pend=data;if(!ready)return;clearTimeout(timer);timer=setTimeout(function(){doPush(pend)},1500)}
function flush(){if(!ready)return;clearTimeout(timer);doPush(api&&api.get?api.get():pend)}
async function boot(){
 if(booted||booting)return;var cfg=window.CX_FB;
 if(!cfg||!cfg.apiKey||!cfg.projectId){set("nocfg");return}
 booting=true;set("load","بيحمّل...");
 try{
  var m=await Promise.all([import(FB+"firebase-app.js"),import(FB+"firebase-auth.js"),import(FB+"firebase-firestore.js")]);
  var app=m[0].initializeApp(cfg);AU=m[1];fs=m[2];auth=AU.getAuth(app);
  try{db=fs.initializeFirestore(app,{localCache:fs.persistentLocalCache({tabManager:fs.persistentMultipleTabManager()})})}catch(e){db=fs.getFirestore(app)}
  booted=true;
  AU.onAuthStateChanged(auth,function(u){user=u;if(u){st.email=u.email||"";set("busy","بيتزامن...");start()}else{st.email="";stop();set("login")}})
 }catch(e){set("err","مقدرتش أحمّل المزامنة (تأكد من النت).")}
 booting=false}
window.addEventListener("cx-api",function(){api=window.__cxApi;boot();start()});
window.addEventListener("online",function(){if(!booted)boot()});
window.CxSync={
 get:function(){return st},
 sub:function(f){subs.push(f);return function(){subs=subs.filter(function(x){return x!==f})}},
 push:push,flush:flush,
 syncNow:function(){flush()},
 login:async function(email,pw){
  if(!AU)throw new Error("المزامنة لسه بتحمّل");
  try{await AU.signInWithEmailAndPassword(auth,String(email||"").trim(),pw)}catch(e){throw new Error(emsg(e))}},
 logout:function(){if(AU&&auth)AU.signOut(auth)},
 _core:{diff:diff,applyRemote:applyRemote,hash:hash,KEYS:KEYS}
};
if(window.__cxApi){api=window.__cxApi}
boot();
})();
