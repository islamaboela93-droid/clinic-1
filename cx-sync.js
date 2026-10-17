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

/* ====== مزامنة الصور والملفات (مضغوطة) ====== */
/* fmeta/{id}: بيانات خفيفة بتتزامن لحظيًا — fblob/{id}: الصورة نفسها بتتنزّل مرة واحدة لكل موبايل */
var FK="clinic:syncfiles",fb={};try{fb=JSON.parse(localStorage.getItem(FK)||"{}")}catch(e){}
function saveFb(){try{localStorage.setItem(FK,JSON.stringify(fb))}catch(e){}}
/* حذف الصور من السحابة بيتم بس للصور اللي المستخدم حذفها بإيده (مش لأي صورة اختفت من المتصفح) */
var DK="clinic:syncdel";
function loadPd(){try{return JSON.parse(localStorage.getItem(DK)||"{}")||{}}catch(e){return{}}}
function savePd(o){try{localStorage.setItem(DK,JSON.stringify(o))}catch(e){}}
function fmeta(r){return{patientId:r.patientId||"",name:r.name||"",date:r.date||"",cat:r.cat||""}}
function fmh(m){return hash(JSON.stringify([m.patientId||"",m.name||"",m.date||"",m.cat||""]))}
var dbp=null;
function idb2(){return dbp||(dbp=new Promise(function(res,rej){var r=indexedDB.open("clinic-files",1);r.onupgradeneeded=function(){if(!r.result.objectStoreNames.contains("files"))r.result.createObjectStore("files",{keyPath:"id"})};r.onsuccess=function(){res(r.result)};r.onerror=function(){rej(r.error)}}))}
function tx(mode,fn){return idb2().then(function(db){return new Promise(function(res,rej){var t=db.transaction("files",mode),r=fn(t.objectStore("files"));t.oncomplete=function(){res(r&&r.result)};t.onerror=function(){rej(t.error)};t.onabort=function(){rej(t.error)}})})}
function iGet(id){return tx("readonly",function(s){return s.get(id)})}
function iPut(rec){return tx("readwrite",function(s){return s.put(rec)})}
function iDel(id){return tx("readwrite",function(s){return s.delete(id)})}
function iKeys(){return tx("readonly",function(s){return s.getAllKeys()})}
function shrinkBlob(b){return new Promise(function(res){
 if(!/^image\//.test(b.type))return res(b.size<=650*1024?b:null);
 var img=new Image(),u=URL.createObjectURL(b);
 img.onload=function(){try{var steps=[[1280,.72],[1100,.6],[900,.5],[720,.45]],i=0;
  (function next(){var m=steps[i],k=Math.min(1,m[0]/Math.max(img.width,img.height)),c=document.createElement("canvas");
   c.width=Math.max(1,Math.round(img.width*k));c.height=Math.max(1,Math.round(img.height*k));
   var g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);
   c.toBlob(function(o){if(o&&(o.size<=300*1024||i>=steps.length-1)){URL.revokeObjectURL(u);res(o.size<=650*1024?o:null)}else if(i>=steps.length-1){URL.revokeObjectURL(u);res(null)}else{i++;next()}},"image/jpeg",m[1])})()
 }catch(e){URL.revokeObjectURL(u);res(null)}};
 img.onerror=function(){URL.revokeObjectURL(u);res(null)};img.src=u})}
var shrinkImpl=shrinkBlob;
function toB64(b){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result).split(",")[1]||"")};r.onerror=function(){rej(r.error)};r.readAsDataURL(b)})}
function fromB64(s,type){var bin=atob(s),n=bin.length,a=new Uint8Array(n);for(var i=0;i<n;i++)a[i]=bin.charCodeAt(i);return new Blob([a],{type:type||"image/jpeg"})}
var fq=[],fRun=false,fready=false,upIn={},scanBusy=false,scanAgain=false,scanT=null,dispT=null,unsubF=null;
function nowStr(){return new Date().toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"})}
function fdisp(){clearTimeout(dispT);dispT=setTimeout(function(){try{window.dispatchEvent(new Event("cx-files"))}catch(e){}},400)}
function fnote(){if(st.s==="err"||st.s==="login"||st.s==="nocfg")return;var n=fq.length+Object.keys(upIn).length;if(n>0)set("busy","بيزامن الصور ("+n+")...");else if(st.s==="busy"&&/الصور/.test(st.msg)){st.last=nowStr();set("ok")}}
async function upFile(rec){
 var m=fmeta(rec),blob=await shrinkImpl(rec.blob);
 if(!blob){fb[rec.id]="s:"+fmh(m);saveFb();return}
 var b=await toB64(blob);
 await fs.setDoc(fs.doc(db,"fblob",rec.id),{b:b});
 await fs.setDoc(fs.doc(db,"fmeta",rec.id),{patientId:m.patientId,name:m.name,date:m.date,cat:m.cat,type:blob.type||rec.type||"",del:false,hasBlob:true,ts:Date.now()});
 fb[rec.id]=fmh(m);saveFb()}
async function procMeta(id,x){
 var local=await iGet(id);
 if(x.del){
  /* مفيش حذف تلقائي للصور على الموبايل ده بسبب علامة جاية من السحابة: الصورة الموجودة هنا بتفضل، والحذف بيتم بس بإيدك */
  fb[id]="x";saveFb();return}
 if(!x.hasBlob)return;
 var mh=fmh(x);
 if(local){
  if(fb[id]!==mh){
   var cur=fb[id],tracked=cur!==undefined&&cur!=="x"&&!/^s:/.test(cur),dirty=tracked&&fmh(fmeta(local))!==cur;
   if(!dirty){if(fmh(fmeta(local))!==mh){local.patientId=x.patientId;local.name=x.name;local.date=x.date;local.cat=x.cat||undefined;await iPut(local);fdisp()}fb[id]=mh;saveFb()}}
  return}
 if(fb[id]!==undefined)return;
 var d=await fs.getDoc(fs.doc(db,"fblob",id));
 if(!d.exists())return;
 await iPut({id:id,patientId:x.patientId,name:x.name,type:x.type,date:x.date,cat:x.cat||undefined,blob:fromB64(d.data().b,x.type)});
 fb[id]=mh;saveFb();fdisp()}
async function runFq(){
 if(fRun)return;fRun=true;
 try{while(fq.length){var it=fq.shift();fnote();try{await procMeta(it.id,it.x)}catch(e){console.warn("file sync",e)}}}
 finally{fRun=false;fnote()}}
function scheduleScan(now){if(!fready)return;clearTimeout(scanT);scanT=setTimeout(scan,now?0:2000)}
async function scan(){
 if(!user||!db||!fready)return;
 if(scanBusy){scanAgain=true;return}
 scanBusy=true;
 try{
  var keys=await iKeys(),have={},ids=Object.keys(fb),tracked=ids.filter(function(k){return fb[k]!=="x"&&!/^s:/.test(fb[k])});
  keys.forEach(function(k){have[k]=1});
  if(!keys.length&&tracked.length>3){fb={};saveFb();scanBusy=false;stopFiles();startFiles();return}
  var pd=loadPd(),lost=false;
  Object.keys(pd).forEach(function(k){if(have[k]||fb[k]===undefined||fb[k]==="x")delete pd[k]});savePd(pd);
  for(var i=0;i<ids.length;i++){var id=ids[i],v=fb[id];if(have[id]||v==="x")continue;
   if(/^s:/.test(v)){delete fb[id];continue}
   if(!pd[id]){delete fb[id];lost=true;continue} /* اختفت من المتصفح من غير حذف مقصود: نرجّعها من السحابة */
   await fs.setDoc(fs.doc(db,"fmeta",id),{del:true,hasBlob:false,ts:Date.now()},{merge:true});
   try{await fs.deleteDoc(fs.doc(db,"fblob",id))}catch(e){}
   delete pd[id];savePd(pd);fb[id]="x";saveFb()}
  if(lost){saveFb();scanBusy=false;stopFiles();startFiles();return}
  for(var j=0;j<keys.length;j++){var k=keys[j];if(fb[k]!==undefined||upIn[k])continue;
   var rec=await iGet(k);if(!rec||!rec.blob)continue;
   upIn[k]=1;fnote();
   try{await upFile(rec)}finally{delete upIn[k]}}
 }catch(e){set("err",emsg(e))}
 scanBusy=false;fnote();
 if(scanAgain){scanAgain=false;scheduleScan()}}
function startFiles(){
 if(unsubF||!db||!fs)return;
 var first=true;
 unsubF=fs.onSnapshot(fs.collection(db,"fmeta"),function(snap){
  snap.docChanges().forEach(function(c){
   if(c.type==="removed"||c.doc.metadata.hasPendingWrites)return;
   fq.push({id:c.doc.id,x:c.doc.data()})});
  var f=first;first=false;
  runFq().then(function(){if(f){fready=true;scheduleScan(true)}})
 },function(err){set("err",emsg(err))})}
function stopFiles(){if(unsubF){try{unsubF()}catch(e){}unsubF=null}fready=false}
function stop(){if(unsub){try{unsub()}catch(e){}unsub=null}ready=false;stopFiles()}
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
 },function(err){set("err",emsg(err))});
 startFiles()}
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
function flush(){if(!ready)return;clearTimeout(timer);doPush(api&&api.get?api.get():pend);scheduleScan(true)}
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
 filePut:function(rec){try{if(!fready||!rec||!rec.id)return;var m=fmeta(rec),cur=fb[rec.id];
  if(cur==="x"){delete fb[rec.id];saveFb();cur=undefined}
  var pd0=loadPd();if(pd0[rec.id]){delete pd0[rec.id];savePd(pd0)}
  if(cur!==undefined&&cur!=="x"&&!/^s:/.test(cur)){var h=fmh(m);if(h!==cur){fb[rec.id]=h;saveFb();fs.setDoc(fs.doc(db,"fmeta",rec.id),{patientId:m.patientId,name:m.name,date:m.date,cat:m.cat,ts:Date.now()},{merge:true}).catch(function(e){set("err",emsg(e))})}return}
  scheduleScan()}catch(e){}},
 fileDel:function(id){try{if(id){var p=loadPd();p[id]=1;savePd(p)}scheduleScan()}catch(e){}},
 syncNow:function(){flush()},
 login:async function(email,pw){
  if(!AU)throw new Error("المزامنة لسه بتحمّل");
  try{await AU.signInWithEmailAndPassword(auth,String(email||"").trim(),pw)}catch(e){throw new Error(emsg(e))}},
 logout:function(){if(AU&&auth)AU.signOut(auth)},
 _core:{diff:diff,applyRemote:applyRemote,hash:hash,KEYS:KEYS},
 _t:{env:function(F,D,U){fs=F;db=D;user=U},setReady:function(v){fready=v},procMeta:procMeta,scan:scan,iGet:iGet,iPut:iPut,iDel:iDel,iKeys:iKeys,fb:function(){return fb},setShrink:function(f){shrinkImpl=f},startFiles:startFiles,stopFiles:stopFiles,flushQ:function(){return runFq()}}
};
if(window.__cxApi){api=window.__cxApi}
boot();
})();
