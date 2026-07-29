import {
  runTransaction,
  collection,
  addDoc,
  serverTimestamp,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  getDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  documentId,
  getCountFromServer
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

const DB_NAME = "chiptune_local_first_v1";
const DB_VERSION = 4;
const STATE_KEY = "shop_main";
const RECORDS_KEY = "records";
const STATE_SHADOW = "chiptune_state_shadow_v2";
const RECORDS_SHADOW = "chiptune_records_shadow_v2";
const DELETED_RECORDS_SHADOW = "chiptune_deleted_record_ids_v1";
const RECORD_MIGRATION_KEY = "records_migration_v3";
const RECORD_MIGRATION_SHADOW = "chiptune_records_migration_v3";
const RECORD_HISTORY_SYNC_META = "chiptune_records_history_sync_v2";
const RECORD_DELETES_COLLECTION = "recordDeletes";
const STATE_QUEUE_SHADOW = "chiptune_state_queue_shadow_v4";
const RECORD_QUEUE_SHADOW = "chiptune_record_queue_shadow_v4";
const IDB_STATE_DEGRADED_UNTIL = "chiptune_idb_state_degraded_until_v1";
const IDB_RECORDS_DEGRADED_UNTIL = "chiptune_idb_records_degraded_until_v1";
const IDB_RETRY_AFTER_MS = 30 * 60 * 1000;
const LOCAL_DB_TIMEOUT_MS = 15000;
const CLOUD_SYNC_TIMEOUT_MS = 30000;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

const ENTITY_SYNC_KEY = "_entitySync";

function entityMeta(value){
  const meta = value && typeof value === "object" ? value[ENTITY_SYNC_KEY] : null;
  return {
    version:Number(meta?.version || 0),
    updatedAt:Number(meta?.updatedAt || 0),
    deviceId:String(meta?.deviceId || ""),
    operationId:String(meta?.operationId || "")
  };
}

function compareEntityMeta(a,b){
  const am=entityMeta(a), bm=entityMeta(b);
  if(am.version !== bm.version) return am.version - bm.version;
  if(am.updatedAt !== bm.updatedAt) return am.updatedAt - bm.updatedAt;
  return am.operationId.localeCompare(bm.operationId);
}

function stampEntity(value, baseValue, operationId, now=Date.now()){
  if(!value || typeof value !== "object") return value;
  const next=clone(value);
  const currentVersion=Math.max(entityMeta(value).version,entityMeta(baseValue).version);
  next[ENTITY_SYNC_KEY]={
    version:currentVersion+1,
    updatedAt:now,
    deviceId:getDeviceId(),
    operationId
  };
  return next;
}

function chooseEntity(latestValue, localValue, baseValue){
  const localChanged=!same(localValue,baseValue);
  if(!localChanged) return clone(latestValue);
  const cloudChanged=!same(latestValue,baseValue);
  if(!cloudChanged) return clone(localValue);
  return compareEntityMeta(localValue,latestValue) >= 0 ? clone(localValue) : clone(latestValue);
}

function stampArrayChanges(localValue,baseValue,prefix,operationId,now){
  const local=Array.isArray(localValue)?clone(localValue):[];
  const base=Array.isArray(baseValue)?baseValue:[];
  const baseMap=new Map(base.map((v,i)=>[itemId(v,i,prefix),v]));
  return local.map((value,index)=>{
    const id=itemId(value,index,prefix);
    const baseItem=baseMap.get(id);
    return !same(value,baseItem) ? stampEntity(value,baseItem,operationId,now) : value;
  });
}

function stampLocalState(local,base,changed,operationId,now=Date.now()){
  const next=clone(local || {});
  for(const key of changed || []){
    if(key === "tables" && Array.isArray(next.tables)){
      const baseTables=Array.isArray(base?.tables)?base.tables:[];
      next.tables=next.tables.map((table,index)=>!same(table,baseTables[index]) ? stampEntity(table,baseTables[index],operationId,now) : table);
    }else if(key === "bookings"){
      next.bookings=stampArrayChanges(next.bookings,base?.bookings,"booking",operationId,now);
    }else if(key === "groups"){
      next.groups=stampArrayChanges(next.groups,base?.groups,"group",operationId,now);
    }else if(key === "customers" && next.customers && typeof next.customers === "object"){
      const localCustomers=normalizeCustomersMap(next.customers);
      const baseCustomers=normalizeCustomersMap(base?.customers);
      for(const [id,value] of Object.entries(localCustomers)){
        if(!same(value,baseCustomers[id])) localCustomers[id]=stampEntity(value,baseCustomers[id],operationId,now);
      }
      next.customers=localCustomers;
    }
  }
  return next;
}

function stateRevision(value){
  const n = Number(value?._sync?.revision || 0);
  return Number.isFinite(n) ? n : 0;
}

function stateUpdatedAt(value){
  const n = Number(value?._sync?.updatedAt || 0);
  return Number.isFinite(n) ? n : 0;
}

function hasRunningTable(value){
  return Array.isArray(value?.tables) && value.tables.some(table=>Boolean(table?.start));
}

/*
 * Firestore 持久化缓存有时会在事务成功后再次发出旧快照。
 * revision 必须单调递增；同 revision 下也不能用缺少运行桌位的旧快照
 * 覆盖本机已经确认的运行状态。
 */
function isStateOlder(candidate, reference){
  if(!candidate || !reference) return false;
  const candidateRevision = stateRevision(candidate);
  const referenceRevision = stateRevision(reference);
  if(candidateRevision !== referenceRevision){
    return candidateRevision < referenceRevision;
  }
  const candidateUpdatedAt = stateUpdatedAt(candidate);
  const referenceUpdatedAt = stateUpdatedAt(reference);
  if(candidateUpdatedAt && referenceUpdatedAt && candidateUpdatedAt !== referenceUpdatedAt){
    return candidateUpdatedAt < referenceUpdatedAt;
  }
  if(hasRunningTable(reference) && !hasRunningTable(candidate)) return true;
  return false;
}
function withTimeout(promise, ms=LOCAL_DB_TIMEOUT_MS, label="本地数据库操作"){
  return Promise.race([
    promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(label+"超时")),ms))
  ]);
}
function stripImagesDeep(value){
  if(Array.isArray(value)) return value.map(stripImagesDeep);
  if(value && typeof value === "object"){
    const out={};
    for(const [k,v] of Object.entries(value)){
      if(["receiptImage","imageBase64"].includes(k)) out[k]="";
      else out[k]=stripImagesDeep(v);
    }
    return out;
  }
  return value;
}

let baseline = null;
let saveQueue = Promise.resolve();
let badge = null;
let flushTimer = null;
let lastSyncStatusType = "";
function degradedUntil(key){
  try{ return Number(localStorage.getItem(key) || 0); }catch{ return 0; }
}
function markIdbDegraded(key){
  try{ localStorage.setItem(key,String(Date.now() + IDB_RETRY_AFTER_MS)); }catch{}
}
function clearIdbDegraded(key){
  try{ localStorage.removeItem(key); }catch{}
}

let idbStateDegraded = degradedUntil(IDB_STATE_DEGRADED_UNTIL) > Date.now();
let idbRecordsDegraded = degradedUntil(IDB_RECORDS_DEGRADED_UNTIL) > Date.now();

const stateChannel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("chiptune-state-sync-v1")
    : null;

const recordChannel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("chiptune-record-sync-v1")
    : null;

function broadcastRecord(record, action = "record_update"){
  if(!record?.id) return;
  const detail = {record:clone(record),action,sentAt:Date.now(),deviceId:getDeviceId()};
  window.dispatchEvent(new CustomEvent("chiptune-record-broadcast",{detail}));
  try{ recordChannel?.postMessage(detail); }catch(error){ console.warn("跨页面账单广播失败",error); }
}

recordChannel?.addEventListener("message",event=>{
  if(!event.data?.record?.id) return;
  window.dispatchEvent(new CustomEvent("chiptune-record-broadcast",{detail:event.data}));
});

function broadcastState(state, action = "state_update"){
  const detail = {
    state:clone(state),
    action,
    sentAt:Date.now(),
    deviceId:getDeviceId()
  };

  /*
   * 同一个页面内的监听器。
   */
  window.dispatchEvent(
    new CustomEvent(
      "chiptune-state-broadcast",
      {detail}
    )
  );

  /*
   * 不同标签页、不同窗口、PWA 页面之间同步。
   */
  try{
    stateChannel?.postMessage(detail);
  }catch(error){
    console.warn("跨页面状态广播失败",error);
  }
}

function broadcastSyncBatch(phase, total = 0){
  const detail = {
    syncBatch:true,
    phase,
    total:Number(total || 0),
    sentAt:Date.now(),
    deviceId:getDeviceId()
  };
  window.dispatchEvent(new CustomEvent("chiptune-sync-batch",{detail}));
  try{
    stateChannel?.postMessage(detail);
  }catch(error){
    console.warn("跨页面批量同步状态广播失败",error);
  }
}

stateChannel?.addEventListener(
  "message",
  event=>{
    if(event.data?.syncBatch){
      window.dispatchEvent(
        new CustomEvent(
          "chiptune-sync-batch",
          {detail:event.data}
        )
      );
      return;
    }
    if(!event.data?.state) return;

    window.dispatchEvent(
      new CustomEvent(
        "chiptune-state-broadcast",
        {
          detail:event.data
        }
      )
    );
  }
);




function role(){
  const p = location.pathname.toLowerCase();
  if(p.includes("booking")) return "booking";
  if(p.includes("owner")) return "owner";
  if(p.includes("today-bill") || p.includes("cashier")) return "report";
  if(p.endsWith("/") || p.includes("index.html")) return "home";
  return "timer";
}

function openLocalDb(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event=>{
      const db = req.result;
      if(!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if(!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", {keyPath:"id"});
      if(!db.objectStoreNames.contains("recordQueue")) db.createObjectStore("recordQueue", {keyPath:"id"});
      // v3 不再执行旧版整状态快照队列。上线前必须先在旧版本完成同步。
      if(Number(event.oldVersion||0) > 0 && Number(event.oldVersion||0) < 3){
        try{ event.target.transaction.objectStore("queue").clear(); }catch(_){}
        try{ event.target.transaction.objectStore("recordQueue").clear(); }catch(_){}
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}

async function idbGet(store,key){
  const db = await openLocalDb();
  const task = new Promise((resolve,reject)=>{
    const tx = db.transaction(store,"readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = ()=>resolve(req.result ?? null);
    req.onerror = ()=>reject(req.error);
  });
  return withTimeout(task,LOCAL_DB_TIMEOUT_MS,"读取本地数据");
}

async function idbPut(store,value,key){
  const db = await openLocalDb();
  const task = new Promise((resolve,reject)=>{
    const tx = db.transaction(store,"readwrite");
    const req = key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value,key);
    req.onsuccess = ()=>resolve(value);
    req.onerror = ()=>reject(req.error);
  });
  return withTimeout(task,LOCAL_DB_TIMEOUT_MS,"写入本地数据");
}

async function idbDelete(store,key){
  const db = await openLocalDb();
  const task = new Promise((resolve,reject)=>{
    const tx = db.transaction(store,"readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
  return withTimeout(task,LOCAL_DB_TIMEOUT_MS,"删除本地数据");
}

async function idbAll(store){
  const db = await openLocalDb();
  const task = new Promise((resolve,reject)=>{
    const tx = db.transaction(store,"readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = ()=>resolve(req.result || []);
    req.onerror = ()=>reject(req.error);
  });
  return withTimeout(task,LOCAL_DB_TIMEOUT_MS,"读取本地列表");
}

async function idbClear(store){
  const db = await openLocalDb();
  const task = new Promise((resolve,reject)=>{
    const tx = db.transaction(store,"readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
    tx.onabort = ()=>reject(tx.error || new Error("本地队列清理失败"));
  });
  return withTimeout(task,LOCAL_DB_TIMEOUT_MS,"清理本地队列");
}

function writeShadow(key,value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }catch(err){ console.warn("本地同步备份写入失败",err); }
}
function readShadow(key){
  try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }catch{ return null; }
}

function queueShadowKey(store){
  return store === "recordQueue" ? RECORD_QUEUE_SHADOW : STATE_QUEUE_SHADOW;
}

function readQueueShadow(store){
  const value = readShadow(queueShadowKey(store));
  return Array.isArray(value) ? value : [];
}

function writeQueueShadow(store,items){
  writeShadow(queueShadowKey(store),Array.isArray(items) ? items : []);
}

/*
 * iPad Safari 偶尔会让 IndexedDB 整体不可用。操作队列必须先同步写入
 * localStorage，不能只把状态快照留在那里，否则换页时云端旧状态会被误判
 * 为“没有待上传修改”的最终状态。
 */
async function queuePut(store,item){
  const shadow = readQueueShadow(store);
  const index = shadow.findIndex(value=>String(value?.id) === String(item?.id));
  if(index >= 0) shadow[index] = clone(item); else shadow.push(clone(item));
  writeQueueShadow(store,shadow);
  const degraded = store === "recordQueue" ? idbRecordsDegraded : idbStateDegraded;
  if(degraded) return item;
  try{
    await idbPut(store,item);
  }catch(error){
    console.warn(`${store} IndexedDB队列不可用，继续使用应急队列`,error);
    if(store === "recordQueue"){
      idbRecordsDegraded = true;
      markIdbDegraded(IDB_RECORDS_DEGRADED_UNTIL);
    }else{
      idbStateDegraded = true;
      markIdbDegraded(IDB_STATE_DEGRADED_UNTIL);
    }
  }
  return item;
}

async function queueAll(store){
  const merged = new Map(
    readQueueShadow(store).map(item=>[String(item?.id),clone(item)])
  );
  const degraded = store === "recordQueue" ? idbRecordsDegraded : idbStateDegraded;
  if(degraded) return [...merged.values()];
  try{
    for(const item of await idbAll(store)){
      merged.set(String(item?.id),clone(item));
    }
  }catch(error){
    console.warn(`${store} IndexedDB队列读取失败，使用应急队列`,error);
    if(store === "recordQueue"){
      idbRecordsDegraded = true;
      markIdbDegraded(IDB_RECORDS_DEGRADED_UNTIL);
    }else{
      idbStateDegraded = true;
      markIdbDegraded(IDB_STATE_DEGRADED_UNTIL);
    }
  }
  return [...merged.values()];
}

async function queueDelete(store,id){
  writeQueueShadow(
    store,
    readQueueShadow(store).filter(item=>String(item?.id) !== String(id))
  );
  const degraded = store === "recordQueue" ? idbRecordsDegraded : idbStateDegraded;
  if(degraded) return;
  try{
    await idbDelete(store,id);
  }catch(error){
    console.warn(`${store} IndexedDB队列删除失败，应急队列已完成删除`,error);
  }
}

function getDeletedRecordIds(){
  const list = readShadow(DELETED_RECORDS_SHADOW);
  return new Set(Array.isArray(list) ? list.map(String) : []);
}

function saveDeletedRecordIds(set){
  writeShadow(DELETED_RECORDS_SHADOW, [...set]);
}

function ensureBadge(){
  if(badge) return badge;
  badge = document.createElement("div");
  badge.id = "syncStatusBadge";
  badge.style.cssText = [
    "position:fixed","right:12px","bottom:12px","z-index:99999",
    "padding:8px 12px","border-radius:999px","font-size:13px","font-weight:800",
    "box-shadow:0 2px 10px rgba(0,0,0,.18)"
  ].join(";");
  badge.textContent = "● 正在读取本机数据";
  document.body.appendChild(badge);
  return badge;
}

export function setSyncStatus(type, text){
  if(type === "cache" && ["pending","syncing","offline","error"].includes(lastSyncStatusType)){
    return;
  }
  const el = ensureBadge();
  const map = {
    synced:["#eef7ee","#246b35","● 已保存本机 · 云端已同步"],
    saving:["#fff6df","#8a5b00","● 正在保存到本机"],
    pending:["#fff6df","#8a5b00","● 已保存本机 · 等待上传"],
    offline:["#eef1ff","#3347a8","● 已保存本机 · 当前离线"],
    error:["#ffe8e8","#9b1c1c","● 本机保存失败"],
    cache:["#eef1ff","#3347a8","● 已读取本机数据"],
    syncing:["#fff6df","#8a5b00","● 本机已保存 · 正在同步云端"]
  };
  const [bg,color,label] = map[type] || map.synced;
  el.style.background = bg;
  el.style.color = color;
  el.textContent = text || label;
  lastSyncStatusType = type || "synced";
}

export function getDeviceId(){
  let id = localStorage.getItem("chiptuneDeviceId");
  if(!id){
    id = `device_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    localStorage.setItem("chiptuneDeviceId", id);
  }
  return id;
}

export async function loadLocalState(){
  const shadow = readShadow(STATE_SHADOW);
  if(shadow?.state){
    baseline = clone(shadow.cloudBaseline || shadow.state);
    setSyncStatus(navigator.onLine ? "cache" : "offline");
    return clone(shadow.state);
  }
  try{
    const value = await idbGet("kv",STATE_KEY);
    if(value?.state){
      baseline = clone(value.cloudBaseline || value.state);
      writeShadow(STATE_SHADOW,value);
      setSyncStatus(navigator.onLine ? "cache" : "offline");
      return clone(value.state);
    }
  }catch(err){ console.warn("读取本机数据失败",err); }
  return null;
}

// localStorage 影子在每次操作的同一事件循环内就会写入。
// 预约页可用它立即取得其他页面刚保存的桌位状态，避免等待 IndexedDB。
export function getLocalStateSync(){
  const shadow = readShadow(STATE_SHADOW);
  return shadow?.state ? clone(shadow.state) : null;
}

async function writeLocalState(state, cloudBaseline=baseline){
  const box = {state:clone(state),cloudBaseline:clone(cloudBaseline),savedAt:Date.now(),deviceId:getDeviceId()};
  writeShadow(STATE_SHADOW,box);
  if(idbStateDegraded){
    setSyncStatus("pending","● 本机使用应急缓存 · 正在继续同步云端");
    return;
  }
  let lastError = null;
  for(let attempt=1; attempt<=3; attempt++){
    try{
      await idbPut("kv",box,STATE_KEY);
      idbStateDegraded = false;
      clearIdbDegraded(IDB_STATE_DEGRADED_UNTIL);
      return;
    }catch(error){
      lastError = error;
      console.warn(`IndexedDB状态保存失败，第 ${attempt} 次`,error);
      if(attempt < 3) await new Promise(resolve=>setTimeout(resolve,150 * attempt));
    }
  }
  // localStorage shadow 已经成功写入，因此不丢失当前状态；让调用方继续排队上传云端。
  console.warn("IndexedDB连续失败，已降级使用localStorage应急副本",lastError);
  idbStateDegraded = true;
  markIdbDegraded(IDB_STATE_DEGRADED_UNTIL);
  setSyncStatus("pending","● 本机使用应急缓存 · 正在继续同步云端");
}

export async function loadLocalRecords(){
  const deleted = getDeletedRecordIds();
  const shadow = readShadow(RECORDS_SHADOW);
  if(Array.isArray(shadow)){
    idbGet("kv",RECORDS_KEY)
      .then(value=>{
        if(Array.isArray(value)) writeShadow(RECORDS_SHADOW,value.map(stripImagesDeep));
      })
      .catch(err=>console.warn("IndexedDB账单后台读取失败，继续使用轻量备份",err));
    return clone(shadow.filter(r=>!r?.deleted && !deleted.has(String(r.id))));
  }
  try{
    const value = await idbGet("kv",RECORDS_KEY);
    if(Array.isArray(value)){
      return clone(value.filter(r=>!r?.deleted && !deleted.has(String(r.id))));
    }
  }catch(err){ console.warn("IndexedDB账单读取失败，尝试轻量备份",err); }

  return [];
}

async function writeLocalRecords(records){
  const list = clone(records || []);
  const light = list.map(stripImagesDeep);
  writeShadow(RECORDS_SHADOW,light);
  if(idbRecordsDegraded){
    setSyncStatus("pending","● 本机使用应急缓存 · 正在继续同步云端");
    return;
  }
  try{
    // 完整账单（包括收款截图）只存 IndexedDB；iPad IndexedDB 卡住时降级为轻量备份。
    await idbPut("kv",list,RECORDS_KEY);
    idbRecordsDegraded = false;
    clearIdbDegraded(IDB_RECORDS_DEGRADED_UNTIL);
  }catch(err){
    console.warn("IndexedDB账单保存失败，已保留轻量本机备份并继续云端同步",err);
    idbRecordsDegraded = true;
    markIdbDegraded(IDB_RECORDS_DEGRADED_UNTIL);
    setSyncStatus("pending","● 本机使用应急缓存 · 正在继续同步云端");
  }
}


export async function replaceLocalRecords(records){
  const merged = mergeRecordLists([], records || []);
  await writeLocalRecords(merged);
  return clone(merged);
}

export async function getLocalRecord(recordId){
  if(!recordId) return null;
  const list = await loadLocalRecords();
  return clone(list.find(r=>String(r.id)===String(recordId)) || null);
}

export function mergeRecordLists(cloudRecords=[], localRecords=[]){
  const deleted = getDeletedRecordIds();
  const map = new Map();
  for(const r of cloudRecords || []){
    if(!r?.deleted && !deleted.has(String(r.id))) map.set(String(r.id),clone(r));
  }
  for(const r of localRecords || []){
    const key = String(r.id);
    if(r?.deleted || deleted.has(key)) continue;
    const cloud = map.get(key);
    if(!cloud || Number(r.localUpdatedAt || r.updatedAt || r.timestamp || 0) >= Number(cloud.localUpdatedAt || cloud.updatedAt || cloud.timestamp || 0)) map.set(key,clone(r));
  }
  return [...map.values()].filter(r=>r.id !== "init");
}


function migrationStatus(){
  const shadow = readShadow(RECORD_MIGRATION_SHADOW);
  return shadow && typeof shadow === "object" ? shadow : {};
}

function saveMigrationStatus(status){
  const next = {...status, updatedAt:Date.now()};
  writeShadow(RECORD_MIGRATION_SHADOW,next);
  idbPut("kv",next,RECORD_MIGRATION_KEY).catch(err=>console.warn("迁移状态写入失败",err));
  return next;
}

function looksLikeLegacyRecord(r){
  if(!r || typeof r !== "object" || Array.isArray(r)) return false;
  const hasTime = r.timestamp || r.closedAt || r.paidAt || r.startAt || r.time || r.date || r.businessDate;
  const hasMoney = r.totalJPY !== undefined || r.jpy !== undefined || r.originalJPY !== undefined || Array.isArray(r.payments);
  const hasBillInfo = r.tableName || r.packageName || r.pay || r.checkoutMethod || r.type;
  return Boolean(hasTime && (hasMoney || hasBillInfo));
}

function smallStableHash(value){
  const text = JSON.stringify(value || {});
  let hash = 2166136261;
  for(let i=0;i<text.length;i++){
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash,16777619);
  }
  return (hash >>> 0).toString(36);
}

function legacyRecordId(r,index=0){
  if(r.id) return String(r.id);
  const ts = Number(r.closedAt || r.paidAt || r.timestamp || r.startAt || 0);
  const table = String(r.tableName || r.table || r.tableIndex || "table").replace(/[^a-zA-Z0-9_-]/g,"");
  const amount = Number(r.totalJPY || r.jpy || r.originalJPY || 0);
  return `legacy_${ts || 0}_${table}_${amount}_${smallStableHash(r)}_${index}`;
}

function collectLegacyRecords(value,out,depth=0){
  if(depth > 5 || value == null) return;
  if(Array.isArray(value)){
    value.forEach((item,i)=>{
      if(looksLikeLegacyRecord(item)) out.push({...clone(item),id:legacyRecordId(item,i)});
      else collectLegacyRecords(item,out,depth+1);
    });
    return;
  }
  if(typeof value !== "object") return;
  if(Array.isArray(value.records)) collectLegacyRecords(value.records,out,depth+1);
  if(value.state && typeof value.state === "object") collectLegacyRecords(value.state,out,depth+1);
}


async function queueMigratedRecords(records){
  const db = await openLocalDb();
  return new Promise((resolve,reject)=>{
    const tx = db.transaction("recordQueue","readwrite");
    const store = tx.objectStore("recordQueue");
    for(const r of records){
      store.put({id:`record_${r.id}`,record:clone(r),createdAt:Date.now()});
    }
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
    tx.onabort = ()=>reject(tx.error || new Error("迁移队列写入中止"));
  });
}

/**
 * 一次性账单迁移：
 * 1. 本机旧 state / localStorage 只扫描一次；
 * 2. 云端 records 与旧 shop/main.records 成功读取后只导入一次；
 * 3. 迁移结果统一写入新版本机 records，之后所有页面直接读取它。
 */
export async function migrateLegacyRecordsOnce({db,ref,onProgress}={}){
  const report = msg=>{ try{ onProgress?.(msg); }catch{} };
  let status = migrationStatus();
  const current = await loadLocalRecords().catch(()=>[]);
  let merged = current;
  const recovered = [];
  const notes = [];

  if(!status.localDone){
    report("正在迁移本机旧账单…");
    try{
      const localState = await loadLocalState();
      if(Array.isArray(localState?.records)) collectLegacyRecords(localState.records,recovered);
    }catch(err){ notes.push(`旧本机状态读取失败：${err?.message || err}`); }

    try{
      for(let i=0;i<localStorage.length;i++){
        const key = localStorage.key(i);
        if(!key || key === RECORD_MIGRATION_SHADOW || key === DELETED_RECORDS_SHADOW) continue;
        const raw = localStorage.getItem(key);
        if(!raw || raw.length < 10) continue;
        try{ collectLegacyRecords(JSON.parse(raw),recovered); }catch{}
      }
    }catch(err){ notes.push(`本机备份扫描失败：${err?.message || err}`); }

    merged = mergeRecordLists(merged,recovered);
    await writeLocalRecords(merged);
    status = saveMigrationStatus({...status,localDone:true,localRecovered:recovered.length});
    notes.push(`本机旧数据：发现 ${recovered.length} 条`);
  }

  if(!status.cloudDone && db && ref && navigator.onLine){
    report("正在导入旧云端账单…");
    const cloudFound = [];
    let recordsCollectionSucceeded = false;
    try{
      const snap = await withTimeout(getDocs(collection(db,"records")),CLOUD_SYNC_TIMEOUT_MS,"云端 records 读取");
      cloudFound.push(...snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.id!=="init" && !r.deleted));
      notes.push(`云端 records：${snap.size} 条`);
      recordsCollectionSucceeded = true;
    }catch(err){ notes.push(`云端 records 暂未完成：${err?.message || err}`); }

    let legacyMainSucceeded = false;
    try{
      const snap = await withTimeout(getDoc(ref),CLOUD_SYNC_TIMEOUT_MS,"旧 shop/main 读取");
      if(snap.exists() && Array.isArray(snap.data()?.records)){
        collectLegacyRecords(snap.data().records,cloudFound);
        notes.push(`旧 shop/main.records：${snap.data().records.length} 条`);
      }
      legacyMainSucceeded = true;
    }catch(err){ notes.push(`旧 shop/main.records 暂未完成：${err?.message || err}`); }

    // 两个旧云端来源都完成读取后，才永久标记云端迁移完成，避免弱网时漏账。
    if(recordsCollectionSucceeded && legacyMainSucceeded){
      const beforeIds = new Set(merged.map(r=>String(r.id)));
      merged = mergeRecordLists(merged,cloudFound);
      await writeLocalRecords(merged);
      const newlyAdded = merged.filter(r=>!beforeIds.has(String(r.id)));
      if(newlyAdded.length) await queueMigratedRecords(newlyAdded).catch(err=>notes.push(`云端备份排队失败：${err?.message || err}`));
      status = saveMigrationStatus({...status,cloudDone:true,cloudRecovered:cloudFound.length,completedAt:Date.now()});
    }
  }

  const done = Boolean(status.localDone && status.cloudDone);
  report(done ? "历史账单升级完成" : (navigator.onLine ? "本机迁移完成，云端稍后重试" : "本机迁移完成，联网后自动补全云端旧账单"));
  return {records:clone(merged),done,status,notes};
}

export function resetRecordMigration(){
  try{ localStorage.removeItem(RECORD_MIGRATION_SHADOW); }catch{}
  return idbDelete("kv",RECORD_MIGRATION_KEY).catch(()=>{});
}

function changedKeys(local, base){
  const keys = new Set([...Object.keys(local||{}),...Object.keys(base||{})]);
  return [...keys].filter(k=>k !== "_sync" && !same(local?.[k],base?.[k]));
}

async function pendingKeys(){
  const items = await queueAll("queue");
  return new Set(items.flatMap(x=>x.changed || []));
}

export async function reconcileCloudState(cloud){
  const localBox =
    readShadow(STATE_SHADOW) ||
    await idbGet("kv",STATE_KEY).catch(()=>null);

  const local = localBox?.state;

  /*
   * 本机没有状态时，直接使用云端。
   */
  if(!local){
    baseline = clone(cloud);
    await writeLocalState(cloud,cloud);
    return clone(cloud);
  }

  const queueItems = (
    await queueAll("queue")
  ).sort((a,b)=>
    Number(a.createdAt || 0) -
    Number(b.createdAt || 0)
  );

  /*
   * 只处理最后一个待上传状态。
   * enqueue() 已经保证队列通常只有一个最新状态。
   */
  const pendingItem =
    queueItems.length
      ? queueItems[queueItems.length - 1]
      : null;

  /*
   * 没有本机待上传修改时，云端就是最终状态。
   */
  if(!pendingItem){
    /*
     * 没有待上传项目时也不能盲信快照：Firestore 本地持久化缓存
     * 可能在原子开始成功后重新发出更旧的 shop/main。
     */
    const reference = local || baseline;
    if(reference && isStateOlder(cloud,reference)){
      await writeLocalState(reference,baseline || reference);
      return clone(reference);
    }

    baseline = clone(cloud);

    await writeLocalState(
      cloud,
      cloud
    );

    return clone(cloud);
  }

  const pendingLocal =
    pendingItem.state ||
    local;

  const pendingBase =
    pendingItem.base ||
    localBox?.cloudBaseline ||
    baseline ||
    {};

  const changed =
    Array.isArray(pendingItem.changed)
      ? pendingItem.changed
      : changedKeys(
          pendingLocal,
          pendingBase
        );

  const merged = clone(cloud || {});

  for(const key of changed){
    if(key === "_sync") continue;

    const localValue = pendingLocal?.[key];
    const baseValue = pendingBase?.[key];

    /*
     * tables 必须按桌位逐个合并。
     *
     * 不能因为本机修改了1号桌，
     * 就把其他设备刚修改的5号桌一起覆盖。
     */
    if(
      key === "tables" &&
      Array.isArray(localValue)
    ){
      const cloudTables =
        Array.isArray(merged.tables)
          ? clone(merged.tables)
          : [];

      const baseTables =
        Array.isArray(baseValue)
          ? baseValue
          : [];

      localValue.forEach((table,index)=>{
        const baseTable = baseTables[index];
        const cloudTable = cloudTables[index];

        if(!same(table,baseTable)){
          /*
           * 防止旧页面快照把其他页面刚开始的桌位覆盖回未开始。
           *
           * cloud 已经运行，而 local 和 base 都未运行，说明本机这次操作
           * 并没有显式结束该桌，只是携带了开始前的旧快照，必须保留云端。
           * 真正结账/强制结束时 base 原本是运行状态，因此仍可正常清空。
           */
          const staleStopOverwrite = Boolean(
            cloudTable?.start &&
            !table?.start &&
            !baseTable?.start
          );

          if(!staleStopOverwrite){
            cloudTables[index] = chooseEntity(cloudTable,table,baseTable);
          }
        }
      });

      merged.tables = cloudTables;
      continue;
    }

    /*
     * 预约按预约ID合并。
     */
    if(key === "bookings"){
      merged.bookings = mergeArrayChanges(
        merged.bookings,
        localValue,
        baseValue,
        "booking"
      );
      continue;
    }

    /*
     * 分组按groupId合并。
     */
    if(key === "groups"){
      merged.groups = mergeArrayChanges(
        merged.groups,
        localValue,
        baseValue,
        "group"
      );
      continue;
    }

if(key === "customers"){
  merged.customers = mergeCustomerChanges(
    merged.customers,
    localValue,
    baseValue
  );
  continue;
}
    /*
     * 其他普通字段才直接使用本机值。
     */
    merged[key] = clone(localValue);
  }

  /*
   * baseline 必须记录真实云端状态，
   * 不能记录临时合并后的状态。
   */
  baseline = clone(cloud);

  await writeLocalState(
    merged,
    cloud
  );

  return merged;
}

export function setStateBaseline(nextState){
  if(!nextState) return;
  // 绝不允许缓存或延迟到达的旧快照降低云端基线版本。
  if(baseline && isStateOlder(nextState,baseline)) return;
  baseline = clone(nextState);
  const shadow = readShadow(STATE_SHADOW);
  if(shadow?.state) writeLocalState(shadow.state,nextState).catch(()=>{});
}

function itemId(item,index,prefix="item"){
  if(item && typeof item === "object"){
    return String(item.id ?? item.groupId ?? item.bookingId ?? item.key ?? `${prefix}_${index}`);
  }
  return `${prefix}_${index}`;
}

function mergeArrayChanges(latestValue, localValue, baseValue, prefix){
  const latest = Array.isArray(latestValue) ? clone(latestValue) : [];
  const local = Array.isArray(localValue) ? localValue : [];
  const base = Array.isArray(baseValue) ? baseValue : [];

  const latestMap = new Map(latest.map((v,i)=>[itemId(v,i,prefix),clone(v)]));
  const localMap = new Map(local.map((v,i)=>[itemId(v,i,prefix),v]));
  const baseMap = new Map(base.map((v,i)=>[itemId(v,i,prefix),v]));

  // 本机相对基线删除的项目，也从服务器最新结果中删除。
  for(const id of baseMap.keys()){
    if(!localMap.has(id)) latestMap.delete(id);
  }

  // 同一实体并发修改时使用版本号 + 客户端时间戳决定胜者。
  // Firestore Transaction 会在文档版本变化时自动重试；这里负责重试后的业务实体级合并。
  for(const [id,value] of localMap){
    const baseItem=baseMap.get(id);
    if(!baseMap.has(id) || !same(value,baseItem)){
      latestMap.set(id,chooseEntity(latestMap.get(id),value,baseItem));
    }
  }

  return [...latestMap.values()];
}

function mergeObjectChanges(latestValue, localValue, baseValue){
  const latest = clone(latestValue || {});
  const local = localValue || {};
  const base = baseValue || {};
  for(const key of Object.keys(base)){
    if(!(key in local)) delete latest[key];
  }
  for(const key of Object.keys(local)){
    if(!(key in base) || !same(local[key],base[key])) latest[key]=clone(local[key]);
  }
  return latest;
}

function normalizeCustomersMap(value){
  if(Array.isArray(value)){
    const result = {};

    value.forEach((customer,index)=>{
      if(!customer || typeof customer !== "object") return;

      const key =
        customer.key ||
        (
          customer.name && customer.phoneLast4
            ? `${String(customer.name).trim()}_${String(customer.phoneLast4).slice(-4)}`
            : `customer_${index}`
        );

      result[key] = {
        ...clone(customer),
        key,
        visits:Array.isArray(customer.visits)
          ? clone(customer.visits)
          : []
      };
    });

    return result;
  }

  if(value && typeof value === "object"){
    return clone(value);
  }

  return {};
}

function mergeCustomerChanges(
  latestValue,
  localValue,
  baseValue
){
  const latest =
    normalizeCustomersMap(latestValue);

  const local =
    normalizeCustomersMap(localValue);

  const base =
    normalizeCustomersMap(baseValue);

  /*
   * 本机相对基线删除的客户，
   * 也从云端最新结果中删除。
   */
  for(const key of Object.keys(base)){
    if(!(key in local)){
      delete latest[key];
    }
  }

  /*
   * 只写入本机新增或修改的客户，
   * 保留其他设备新增的客户。
   */
  for(const [key,customer] of Object.entries(local)){
    if(
      !(key in base) ||
      !same(customer,base[key])
    ){
      latest[key] = chooseEntity(latest[key],customer,base[key]);
    }
  }

  return latest;
}

function mergeState(latest, local, base, keys, action=""){
  const merged = clone(latest || {});
  const changed = keys?.length ? keys : changedKeys(local,base);
  for(const key of changed){
    const localValue = local?.[key];
    const baseValue = base?.[key];
    if(key === "tables" && Array.isArray(localValue)){
      const latestTables = Array.isArray(merged.tables) ? clone(merged.tables) : [];
      const baseTables = Array.isArray(baseValue) ? baseValue : [];
      localValue.forEach((table,index)=>{
        const baseTable = baseTables[index];
        const latestTable = latestTables[index];

        if(!same(table,baseTable)){
          const explicitStopActions = new Set([
            "checkout_complete",
            "emergency_force_end_table",
            "force_end_table",
            "checkout_table",
            "batch_checkout",
            "clear_finished_table"
          ]);
          const staleStopOverwrite = Boolean(
            latestTable?.start &&
            !table?.start &&
            !explicitStopActions.has(String(action || ""))
          );

          if(!staleStopOverwrite){
            latestTables[index] = chooseEntity(latestTable,table,baseTable);
          }
        }
      });
      merged.tables = latestTables;
    }else if(key === "bookings"){
      merged.bookings = mergeArrayChanges(merged.bookings,localValue,baseValue,"booking");
    }else if(key === "groups"){
      merged.groups = mergeArrayChanges(merged.groups,localValue,baseValue,"group");
}else if(key === "customers"){
  merged.customers = mergeCustomerChanges(
    merged.customers,
    localValue,
    baseValue
  );      
    }else{
      merged[key] = clone(localValue);
    }
  }
  merged._sync = {revision:Number(latest?._sync?.revision || 0)+1,updatedAt:Date.now(),deviceId:getDeviceId()};
  return {merged,changed};
}



// ===== v4 top-level entity operation sync =====
const OP_COLLECTION = "operationLogs";
const CONFLICT_COLLECTION = "syncConflicts";

function operationRef(db, operationId){ return doc(db,OP_COLLECTION,String(operationId)); }
function entityRef(db,type,id){
  const collectionName=entityCollectionName(type);
  if(!collectionName) throw new Error(`未知实体类型：${type}`);
  return doc(db,collectionName,safeEntityDocId(id));
}
function recordRefV4(db,recordId){ return doc(db,"records",String(recordId)); }
function paymentRefV4(db,recordId,paymentId){ return doc(db,"records",String(recordId),"payments",String(paymentId)); }
function entityCollectionName(type){
  return ({table:"tables",booking:"bookings",group:"groups",customer:"customers",record:"records"})[type] || null;
}
function entityDocId(type,id,index){
  if(type === "table") return `table_${String(Number(index)+1).padStart(2,"0")}`;
  return safeEntityDocId(id);
}
function safeEntityDocId(id){
  const text = String(id || "");
  return text.includes("/") ? encodeURIComponent(text) : text;
}
function shallowPatch(next,base){
  const patch={};
  const keys=new Set([...Object.keys(base||{}),...Object.keys(next||{})]);
  for(const key of keys){
    if(key === ENTITY_SYNC_KEY || key === "_recordSync") continue;
    if(!same(next?.[key],base?.[key])) patch[key]=clone(next?.[key]);
  }
  return patch;
}
function applyPatchObject(base,patch){
  const next=clone(base||{});
  for(const [key,value] of Object.entries(patch||{})){
    if(value === undefined) delete next[key];
    else next[key]=clone(value);
  }
  return next;
}
function arrayMapById(list,prefix){
  const map=new Map();
  (Array.isArray(list)?list:[]).forEach((v,i)=>map.set(itemId(v,i,prefix),v));
  return map;
}
async function pendingForEntity(type,id,items=null){
  const queueItems=Array.isArray(items) ? items : await queueAll("queue");
  return queueItems.filter(x=>(x.syncV4 || x.syncV3)
    && x.entityType===type
    && (
      String(x.logicalId ?? "")===String(id)
      || String(x.entityId)===String(id)
      || (type==="table" && Number(x.tableIndex)===Number(id))
    )
  ).sort((a,b)=>a.createdAt-b.createdAt);
}
async function makeEntityOperation({type,id,index,next,base,action,deleted=false,pendingItems=null}){
  const pending=await pendingForEntity(type,id,pendingItems);
  const previous=pending.length ? pending[pending.length-1] : null;
  /*
   * 同一实体尚未上传时，只保留“最早云端基线 → 最新本机状态”这一项。
   * 例如连续点击套餐、付款方式、开始时间，以前会生成多次 Firestore
   * 事务；现在无论改多少次，最终只需要上传一次。
   */
  const effectiveBase=previous?.baseEntity || base || null;
  const baseVersion=previous
    ? Number(previous.expectedVersion||0)
    : Number(entityMeta(base).version||0);
  const operationId=crypto.randomUUID ? crypto.randomUUID() : `${getDeviceId()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    id:operationId,
    syncV4:true,
    entityType:type,
    entityId:entityDocId(type,id,index),
    logicalId:String(id ?? index ?? ""),
    tableIndex:type==="table"?Number(index):null,
    action,
    command:deleted?"TOMBSTONE":"PATCH",
    expectedVersion:baseVersion,
    baseEntity:clone(effectiveBase),
    nextEntity:deleted?null:clone(next),
    patch:deleted?{}:shallowPatch(next,effectiveBase),
    deleted:Boolean(deleted),
    createdAt:Date.now(),
    deviceId:getDeviceId(),
    retryCount:0,
    supersededOperationIds:pending.map(item=>String(item.id))
  };
}
async function enqueueEntityOperations(local,base,action){
  const ops=[];
  // 一次保存只读一次队列；多桌同时修改时避免反复打开 IndexedDB。
  const pendingItems=await queueAll("queue");
  const changed=changedKeys(local,base);
  if(changed.includes("tables")){
    const max=Math.max(local?.tables?.length||0,base?.tables?.length||0);
    for(let i=0;i<max;i++) if(!same(local?.tables?.[i],base?.tables?.[i])){
      ops.push(await makeEntityOperation({type:"table",id:i,index:i,next:local?.tables?.[i]||{},base:base?.tables?.[i]||{},action,pendingItems}));
    }
  }
  for(const [key,type,prefix] of [["bookings","booking","booking"],["groups","group","group"]]){
    if(!changed.includes(key)) continue;
    const lm=arrayMapById(local?.[key],prefix), bm=arrayMapById(base?.[key],prefix);
    const ids=new Set([...lm.keys(),...bm.keys()]);
    /*
     * Firestore 的离线缓存偶尔会短暂返回“不存在”。旧逻辑随后用空的
     * defaultState 执行 initialize_state，等价于把云端所有预约逐条标记删除。
     * 初始化只能补建数据，绝不能删除任何已经存在的实体。
     */
    if(action==="initialize_state"){
      const removed=[...bm.keys()].filter(id=>!lm.has(id));
      if(removed.length){
        const error=new Error(`已阻止异常初始化：不会删除 ${removed.length} 个${key}`);
        error.code="unsafe-initialize-delete";
        throw error;
      }
    }
    for(const id of ids){
      const lv=lm.get(id), bv=bm.get(id);
      if(same(lv,bv)) continue;
      ops.push(await makeEntityOperation({type,id,next:lv,base:bv,action,deleted:!lv,pendingItems}));
    }
  }
  if(changed.includes("customers")){
    const lm=normalizeCustomersMap(local?.customers), bm=normalizeCustomersMap(base?.customers);
    const ids=new Set([...Object.keys(lm),...Object.keys(bm)]);
    for(const id of ids){
      if(same(lm[id],bm[id])) continue;
      ops.push(await makeEntityOperation({type:"customer",id,next:lm[id],base:bm[id],action,deleted:!lm[id],pendingItems}));
    }
  }
  const entityKeys=new Set(["tables","bookings","groups","customers"]);
  const metaPatch={};
  for(const key of changed){ if(!entityKeys.has(key)) metaPatch[key]=clone(local?.[key]); }
  if(Object.keys(metaPatch).length){
    const operationId=crypto.randomUUID ? crypto.randomUUID() : `${getDeviceId()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    ops.push({id:operationId,syncV4:true,entityType:"shopMeta",entityId:"main",action,command:"PATCH",patch:metaPatch,baseEntity:{},nextEntity:metaPatch,expectedVersion:stateRevision(base),createdAt:Date.now(),deviceId:getDeviceId(),retryCount:0});
  }
  for(const op of ops){
    for(const oldId of op.supersededOperationIds || []){
      await queueDelete("queue",oldId);
    }
    delete op.supersededOperationIds;
    await queuePut("queue",op);
  }
  return ops;
}
function hasPatchConflict(remote,base,patch){
  for(const key of Object.keys(patch||{})){
    if(!same(remote?.[key],base?.[key])) return key;
  }
  return null;
}
function materializeEntityIntoMain(main,item,nextEntity){
  const out=clone(main||{});
  if(item.entityType==="table"){
    const arr=Array.isArray(out.tables)?clone(out.tables):[];
    arr[item.tableIndex]=clone(nextEntity||{}); out.tables=arr;
  }else if(item.entityType==="booking" || item.entityType==="group"){
    const key=item.entityType==="booking"?"bookings":"groups";
    const prefix=item.entityType;
    const arr=Array.isArray(out[key])?clone(out[key]):[];
    const idx=arr.findIndex((v,i)=>itemId(v,i,prefix)===item.logicalId);
    if(item.deleted){ if(idx>=0) arr.splice(idx,1); }
    else if(idx>=0) arr[idx]=clone(nextEntity); else arr.push(clone(nextEntity));
    out[key]=arr;
  }else if(item.entityType==="customer"){
    const map=normalizeCustomersMap(out.customers);
    if(item.deleted) delete map[item.logicalId]; else map[item.logicalId]=clone(nextEntity);
    out.customers=map;
  }
  out._sync={revision:Number(out?._sync?.revision||0)+1,updatedAt:Date.now(),deviceId:getDeviceId(),operationId:item.id,architecture:"entity-v4"};
  return out;
}
async function flushEntityOperation({db,ref},item,{suppressBroadcast=false}={}){
  let materialized=null;
  await runTransaction(db,async tx=>{
    const opRef=operationRef(db,item.id);
    const opSnap=await tx.get(opRef);
    if(opSnap.exists()) return;
    const mainSnap=await tx.get(ref);
    const main=mainSnap.exists()?mainSnap.data():{};
    if(item.entityType==="shopMeta"){
      materialized={...clone(main),...clone(item.patch),_sync:{revision:Number(main?._sync?.revision||0)+1,updatedAt:Date.now(),deviceId:getDeviceId(),operationId:item.id,architecture:"entity-v4"}};
      tx.set(ref,materialized);
      tx.set(opRef,{...item,status:"committed",committedAt:serverTimestamp()});
      return;
    }
    const collectionName=entityCollectionName(item.entityType);
    const targetRef=entityRef(db,item.entityType,item.entityId);
    const targetSnap=await tx.get(targetRef);
    const remote=targetSnap.exists()?targetSnap.data():{};
    const remoteVersion=Number(remote.version||remote?._entitySync?.version||0);
    if(remote.lastOperationId===item.id){ return; }
    if(remoteVersion!==Number(item.expectedVersion||0)){
      const conflict=hasPatchConflict(remote,item.baseEntity,item.patch);
      if(conflict){
        const err=new Error(`同步冲突：${item.entityType}/${item.entityId} 的 ${conflict} 已被其他设备修改`);
        err.code="sync-conflict"; err.conflictField=conflict; throw err;
      }
    }
    const next=item.deleted
      ? {...clone(remote),deleted:true,deletedAt:serverTimestamp(),deletedBy:item.deviceId}
      : {...applyPatchObject(remote,item.patch),deleted:false};
    const version=remoteVersion+1;
    const entityWrite={...next,version,updatedAt:serverTimestamp(),updatedBy:item.deviceId,lastOperationId:item.id,_entitySync:{version,deviceId:item.deviceId,operationId:item.id}};
    tx.set(targetRef,entityWrite,{merge:false});
    const viewEntity=item.deleted?null:{...clone(next),_entitySync:{version,updatedAt:Date.now(),deviceId:item.deviceId,operationId:item.id}};
    materialized=materializeEntityIntoMain(main,item,viewEntity);
    tx.set(ref,materialized);
    tx.set(opRef,{operationId:item.id,entityType:item.entityType,entityId:item.entityId,action:item.action,deviceId:item.deviceId,expectedVersion:item.expectedVersion,committedVersion:version,status:"committed",committedAt:serverTimestamp()});
  });
  await queueDelete("queue",item.id);
  if(materialized){
    baseline=clone(materialized); await writeLocalState(materialized,materialized);
    writeShadow(STATE_SHADOW,{state:clone(materialized),cloudBaseline:clone(materialized),savedAt:Date.now(),deviceId:getDeviceId()});
    if(!suppressBroadcast){
      broadcastState(materialized,item.action||"entity_sync");
    }
  }
  return materialized;
}

async function enqueue(local,base,action){
  return enqueueEntityOperations(local,base,action);
}

async function flushOne({db,ref}, item, options={}){
  if(item?.syncV4 || item?.syncV3) return flushEntityOperation({db,ref},item,options);
  throw new Error("检测到旧版整状态队列，请先执行迁移或清除旧待同步队列");
}


function paymentStableId(payment,index,recordId){
  return String(payment?.id || payment?.paymentId || `${recordId}_payment_${index}_${Number(payment?.createdAt||payment?.localCreatedAt||0)}`);
}
function normalizeRecordPayments(record){
  const next=clone(record||{});
  next.payments=(Array.isArray(next.payments)?next.payments:[]).map((p,i)=>({...clone(p),id:paymentStableId(p,i,next.id),paymentId:paymentStableId(p,i,next.id)}));
  return next;
}
async function enqueueRecordOperations(next,previous){
  const recordId=String(next.id);
  const now=Date.now();
  const deviceId=getDeviceId();
  // 队列只读取一次；iPad 的 IndexedDB 较慢，不能为每条付款重复 getAll()。
  const queuedRecordOperations=await queueAll("recordQueue");
  const prev=normalizeRecordPayments(previous||{id:recordId,payments:[]});
  const normalized=normalizeRecordPayments(next);
  const {payments:_nextPayments,...nextMeta}=normalized;
  const {payments:_prevPayments,...prevMeta}=prev;
  const recordPatch=shallowPatch(nextMeta,prevMeta);
  if(Object.keys(recordPatch).length){
    const pending=queuedRecordOperations
      .filter(item=>item?.type==="record_patch" && String(item.recordId)===recordId)
      .sort((a,b)=>a.createdAt-b.createdAt);
    const first=pending[0] || null;
    const recordOpId=crypto.randomUUID?crypto.randomUUID():`record_${recordId}_${now}`;
    const rawBase=clone(first?.baseRecord || prev);
    const {payments:_basePayments,...baseRecord}=rawBase;
    for(const item of pending) await queueDelete("recordQueue",item.id);
    await queuePut("recordQueue",{
      id:recordOpId,
      syncV4:true,
      type:"record_patch",
      recordId,
      patch:shallowPatch(nextMeta,baseRecord),
      baseRecord,
      expectedVersion:first
        ? Number(first.expectedVersion||0)
        : Number(prev.version||prev?._recordSync?.version||0),
      createdAt:now,
      deviceId
    });
  }
  const pm=new Map(prev.payments.map(x=>[String(x.id),x]));
  const nm=new Map(normalized.payments.map(x=>[String(x.id),x]));
  for(const [id,payment] of nm){
    const old=pm.get(id);
    if(same(payment,old)) continue;
    const pending=queuedRecordOperations
      .filter(item=>item?.type==="payment_upsert"
        && String(item.recordId)===recordId
        && String(item.paymentId)===String(id));
    const opId=crypto.randomUUID?crypto.randomUUID():`payment_${id}_${Date.now()}`;
    for(const item of pending) await queueDelete("recordQueue",item.id);
    await queuePut("recordQueue",{id:opId,syncV4:true,type:"payment_upsert",recordId,paymentId:id,payment:clone(payment),basePayment:clone(old||{}),createdAt:Date.now(),deviceId});
  }
  for(const [id,old] of pm){
    if(nm.has(id)) continue;
    const opId=crypto.randomUUID?crypto.randomUUID():`payment_void_${id}_${Date.now()}`;
    await queuePut("recordQueue",{id:opId,syncV4:true,type:"payment_void",recordId,paymentId:id,basePayment:clone(old),createdAt:Date.now(),deviceId});
  }
  return normalized;
}
async function flushRecordV3({db},item){
  await runTransaction(db,async tx=>{
    const opRef=operationRef(db,item.id);
    const opSnap=await tx.get(opRef); if(opSnap.exists()) return;
    const canonicalRef=recordRefV4(db,item.recordId);
    const legacyRef=canonicalRef;
    const canonicalSnap=await tx.get(canonicalRef);
    const canonical=canonicalSnap.exists()?canonicalSnap.data():{};
    const legacy=canonical;
    let nextRecord={...clone(legacy),...clone(canonical)};
    if(item.type==="record_delete"){
      const version=Number(canonical.version||0)+1;
      nextRecord={...nextRecord,deleted:true,deletedAt:serverTimestamp(),deletedBy:item.deviceId,version,updatedAt:serverTimestamp(),lastOperationId:item.id};
      tx.set(canonicalRef,nextRecord,{merge:false});
      tx.set(canonicalRef,{...nextRecord,payments:Array.isArray(legacy.payments)?legacy.payments:[]},{merge:false});
      tx.set(doc(db,RECORD_DELETES_COLLECTION,String(item.recordId)),{
        recordId:String(item.recordId),
        deleted:true,
        deletedAt:serverTimestamp(),
        deletedBy:item.deviceId,
        operationId:item.id
      },{merge:true});
    }else if(item.type==="record_patch"){
      const remoteVersion=Number(canonical.version||0);
      const conflict=remoteVersion!==Number(item.expectedVersion||0)?hasPatchConflict(nextRecord,item.baseRecord,item.patch):null;
      if(conflict){ const err=new Error(`账单已在其他设备修改：${conflict}`); err.code="sync-conflict"; throw err; }
      const version=remoteVersion+1;
      nextRecord={...applyPatchObject(nextRecord,item.patch),deleted:false,version,updatedAt:serverTimestamp(),updatedBy:item.deviceId,lastOperationId:item.id};
      tx.set(canonicalRef,nextRecord,{merge:false});
      tx.set(canonicalRef,{...nextRecord,payments:Array.isArray(legacy.payments)?legacy.payments:[]},{merge:false});
    }else{
      const paymentRef=paymentRefV4(db,item.recordId,item.paymentId);
      const paymentSnap=await tx.get(paymentRef);
      const remotePayment=paymentSnap.exists()?paymentSnap.data():{};
      let paymentWrite;
      if(item.type==="payment_void") paymentWrite={...remotePayment,status:"void",voidedAt:serverTimestamp(),voidedBy:item.deviceId,lastOperationId:item.id};
      else paymentWrite={...remotePayment,...clone(item.payment),status:item.payment?.status||"active",updatedAt:serverTimestamp(),updatedBy:item.deviceId,lastOperationId:item.id};
      tx.set(paymentRef,paymentWrite,{merge:false});
      const payments=Array.isArray(legacy.payments)?clone(legacy.payments):[];
      const idx=payments.findIndex((p,i)=>paymentStableId(p,i,item.recordId)===String(item.paymentId));
      const viewPayment={...clone(paymentWrite),updatedAt:Date.now()};
      if(idx>=0) payments[idx]=viewPayment; else payments.push(viewPayment);
      const version=Number(canonical.version||0)+1;
      nextRecord={...nextRecord,payments,version,updatedAt:serverTimestamp(),updatedBy:item.deviceId,lastOperationId:item.id};
      const {payments:_materializedPayments,...canonicalMeta}=nextRecord;
      tx.set(canonicalRef,canonicalMeta,{merge:true});
      tx.set(canonicalRef,{...nextRecord,payments},{merge:false});
    }
    tx.set(opRef,{operationId:item.id,type:item.type,recordId:item.recordId,paymentId:item.paymentId||null,deviceId:item.deviceId,status:"committed",committedAt:serverTimestamp()});
  });
  await queueDelete("recordQueue",item.id);
}

async function flushRecordOne({db}, item){
  if(item?.syncV4 || item?.syncV3) return flushRecordV3({db},item);
  throw new Error("检测到旧版账单队列，请先执行迁移或清除旧待同步队列");
}

async function flushRecordQueueConcurrently({db},recordItems,onProgress){
  // 同一账单的修改必须保持原顺序；不同账单互不覆盖，可以安全并发。
  const groups = new Map();
  for(const item of recordItems){
    const key = String(item?.recordId || item?.id || "");
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
  }
  const queues = [...groups.values()];
  let nextQueueIndex = 0;
  let completed = 0;
  let fatalError = null;
  /*
   * 不同账单使用不同 Firestore 文档，不存在互相覆盖，允许更高并发。
   * 同一账单仍严格串行。桌面端使用 10 路，Apple 触屏设备控制在 6 路，
   * 避免 Safari 长轮询连接过多反而变慢。
   */
  const appleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const workerCount = Math.min(appleTouch ? 6 : 10,queues.length);

  const worker = async()=>{
    while(!fatalError && navigator.onLine){
      const queueIndex = nextQueueIndex++;
      if(queueIndex >= queues.length) return;
      for(const item of queues[queueIndex]){
        if(fatalError || !navigator.onLine) return;
        try{
          await withTimeout(flushRecordOne({db},item),CLOUD_SYNC_TIMEOUT_MS,"收银记录同步");
        }catch(error){
          if(error?.code==="sync-conflict"){
            await quarantineConflict(db,item,error,"recordQueue");
            console.warn("账单操作发生并发冲突，已隔离等待人工确认",item,error);
          }else{
            fatalError = error;
            return;
          }
        }
        completed += 1;
        onProgress?.(completed);
      }
    }
  };

  await Promise.all(Array.from({length:workerCount},()=>worker()));
  if(fatalError) throw fatalError;
}

export async function flushPending({db,ref}){
  if(!navigator.onLine) return;

  const run = async()=>{
    const items = (await queueAll("queue")).sort((a,b)=>a.createdAt-b.createdAt);
    const recordItems = (await queueAll("recordQueue")).sort((a,b)=>a.createdAt-b.createdAt);
    const total = items.length + recordItems.length;
    if(!total){
      if(idbStateDegraded || idbRecordsDegraded){
        setSyncStatus("synced","● 云端已同步 · 本机使用应急缓存");
      }else{
        setSyncStatus("synced");
      }
      return;
    }

    setSyncStatus("syncing",`● 本机已保存 · 正在上传 ${total} 项`);
    broadcastSyncBatch("start",total);

    let latestMaterializedState = null;
    try{
      // 同一设备的计时器、预约页、账单页共用一个 IndexedDB 队列。
      // 必须在跨标签页锁内按顺序上传，禁止多个页面同时重放或删除同一操作。
      // 补传期间不逐项广播完整桌位状态，避免每上传一项就重建一次全部桌卡。
      for(const item of items){
        if(!navigator.onLine) break;
        try{
          const materialized = await withTimeout(
            flushOne({db,ref},item,{suppressBroadcast:true}),
            CLOUD_SYNC_TIMEOUT_MS,
            "桌位状态同步"
          );
          if(materialized) latestMaterializedState = materialized;
        }catch(error){
          if(error?.code==="sync-conflict"){
            await quarantineConflict(db,item,error,"queue");
            console.warn("操作发生并发冲突，已隔离等待人工确认",item,error);
            continue;
          }
          setSyncStatus("error",`● 云端同步失败：${error?.code || error?.message || error}`);
          throw error;
        }
      }
      try{
        await flushRecordQueueConcurrently({db},recordItems,completed=>{
          if(completed === recordItems.length || completed % 10 === 0){
            setSyncStatus("syncing",`● 本机已保存 · 已上传 ${items.length + completed}/${total} 项`);
          }
        });
      }catch(error){
        setSyncStatus("error",`● 云端同步失败：${error?.code || error?.message || error}`);
        throw error;
      }

      const left = (await queueAll("queue")).length + (await queueAll("recordQueue")).length;
      if(left){
        setSyncStatus("pending",`● 已保存本机 · ${left} 项等待上传`);
      }else if(idbStateDegraded || idbRecordsDegraded){
        setSyncStatus("synced","● 云端已同步 · 本机使用应急缓存");
      }else{
        setSyncStatus("synced");
      }
    }finally{
      if(latestMaterializedState){
        broadcastState(latestMaterializedState,"sync_batch_complete");
      }
      broadcastSyncBatch("end",total);
    }
  };

  if(navigator.locks?.request){
    return navigator.locks.request("chiptune-cloud-flush-v4",run);
  }
  return run();
}

async function quarantineConflict(db,item,error,storeName){
  const payload={
    operationId:String(item?.id||""),
    entityType:item?.entityType||item?.type||"unknown",
    entityId:item?.entityId||item?.recordId||null,
    paymentId:item?.paymentId||null,
    message:String(error?.message||error||"同步冲突"),
    conflictField:error?.conflictField||null,
    operation:stripImagesDeep(clone(item||{})),
    deviceId:getDeviceId(),
    status:"needs_review",
    createdAt:serverTimestamp()
  };
  await setDoc(doc(db,CONFLICT_COLLECTION,String(item.id)),payload,{merge:true});
  await queueDelete(storeName,String(item.id));
}

async function pendingCount(){
  return (await queueAll("queue")).length + (await queueAll("recordQueue")).length;
}

export function installConnectionGuard(){
  const update = async ()=>{
    const count = await pendingCount();
    if(!navigator.onLine){
      setSyncStatus("offline",`● 已保存本机 · 离线 · ${count} 项待上传`);
    }else if(count){
      setSyncStatus("pending",`● 已保存本机 · ${count} 项等待上传`);
    }else if(idbStateDegraded || idbRecordsDegraded){
      setSyncStatus("synced","● 云端已同步 · 本机使用应急缓存");
    }else{
      setSyncStatus("synced");
    }
    window.dispatchEvent(new CustomEvent("chiptune-online-change",{detail:{online:navigator.onLine}}));
  };
  window.addEventListener("online",update);
  window.addEventListener("offline",update);
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden) update(); });
  // 正常保存会立即触发上传，这里只作为弱网后的安全重试。
  // 旧版每 3 秒扫描一次队列，会让同时打开的多个页面持续争抢 IndexedDB。
  setInterval(()=>{
    if(navigator.onLine){
      window.dispatchEvent(new CustomEvent("chiptune-sync-tick",{detail:{online:true}}));
    }
  },10000);
  update();
}

export function saveStateSafely({
  db,
  ref,
  getState,
  action="state_update"
}){
  const immediate = clone(getState());
  const immediateBase =
    clone(baseline || immediate);

  writeShadow(
    STATE_SHADOW,
    {
      state:immediate,
      cloudBaseline:immediateBase,
      savedAt:Date.now(),
      deviceId:getDeviceId()
    }
  );

  /*
   * 本机一保存，马上通知预约页和计时器页。
   */
  broadcastState(immediate,action);

  saveQueue = saveQueue.catch(()=>{}).then(async()=>{
    const local = clone(getState());
    const base = clone(baseline || immediateBase || local);
    setSyncStatus("saving");
    await writeLocalState(local,base);
    await enqueue(local,base,action);
    const count = await pendingCount();
    if(!navigator.onLine){
      setSyncStatus("offline",`● 已保存本机 · 离线 · ${count} 项待上传`);
    }else if(count){
      setSyncStatus("pending",`● 已保存本机 · ${count} 项等待上传`);
    }else if(idbStateDegraded || idbRecordsDegraded){
      setSyncStatus("synced","● 云端已同步 · 本机使用应急缓存");
    }else{
      setSyncStatus("pending","● 已保存本机 · 正在确认云端同步");
    }
    if(navigator.onLine){
      /*
       * 上传必须脱离 saveQueue。旧实现会 await 整个历史队列，导致前面有
       * 数百条账单时，下一次点击也要排队等待，表现为页面无法操作。
       * 本机影子和操作队列已经保存成功，因此立即返回；云端在后台刷新。
       */
      clearTimeout(flushTimer);
      flushTimer=setTimeout(()=>flushPending({db,ref}).catch(err=>{
        console.warn("云端同步失败，将自动重试",err);
        setSyncStatus("error",`● 云端同步失败：${err?.code || err?.message || err}`);
      }),0);
    }
    return local;
  }).catch(err=>{
    setSyncStatus("error","● 本机保存失败，请立即停止操作");
    console.error(err);
    throw err;
  });
  return saveQueue;
}

export async function saveRecordSafely({db,ref,record}){
  const current=await loadLocalRecords();
  const previous=current.find(r=>String(r.id)===String(record.id)) || {id:String(record.id),payments:[]};
  const next=normalizeRecordPayments({...clone(record),localUpdatedAt:Date.now()});
  const merged=mergeRecordLists(current,[next]);
  writeShadow(RECORDS_SHADOW,merged);
  broadcastRecord(next,"save_record");
  await writeLocalRecords(merged);
  await enqueueRecordOperations(next,previous);
  const count=await pendingCount();
  if(!navigator.onLine){
    setSyncStatus("offline",`● 已保存本机 · 离线 · ${count} 项待上传`);
  }else if(count){
    setSyncStatus("pending",`● 已保存本机 · ${count} 项等待上传`);
  }else if(idbStateDegraded || idbRecordsDegraded){
    setSyncStatus("synced","● 云端已同步 · 本机使用应急缓存");
  }else{
    setSyncStatus("pending","● 已保存本机 · 正在确认云端同步");
  }
  if(navigator.onLine){ clearTimeout(flushTimer); flushTimer=setTimeout(()=>flushPending({db,ref}).catch(err=>{ console.warn("账单同步失败，将自动重试",err); setSyncStatus("error",`● 账单同步失败：${err?.code || err?.message || err}`); }),0); }
  return next;
}



async function mirrorTableEntity(db,tableIndex,table,operationId){
  const id=entityDocId("table",tableIndex,tableIndex);
  const ref=doc(db,"tables",id);
  await runTransaction(db,async tx=>{
    const snap=await tx.get(ref); const remote=snap.exists()?snap.data():{};
    const version=Number(remote.version||0)+1;
    tx.set(ref,{...clone(table),id,tableIndex:Number(tableIndex),version,deleted:false,updatedAt:serverTimestamp(),updatedBy:getDeviceId(),lastOperationId:operationId,_entitySync:{version,deviceId:getDeviceId(),operationId}},{merge:false});
  });
}
async function mirrorRecordEntity(db,record,operationId){
  if(!record?.id) return;
  const normalized=normalizeRecordPayments(record);
  const {payments=[],...meta}=normalized;
  await setDoc(doc(db,"records",String(record.id)),{...meta,deleted:false,updatedAt:serverTimestamp(),updatedBy:getDeviceId(),lastOperationId:operationId},{merge:true});
  for(const payment of payments){
    await setDoc(doc(db,"records",String(record.id),"payments",String(payment.id)),{...payment,status:payment.status||"active",updatedAt:serverTimestamp(),updatedBy:getDeviceId(),lastOperationId:operationId},{merge:true});
  }
}

async function mirrorStartedTableIntoMain(db,ref,index,table,operationId){
  await runTransaction(db,async tx=>{
    const mainSnap=await tx.get(ref);
    const main=mainSnap.exists()?clone(mainSnap.data()):{};
    const tables=Array.isArray(main.tables)?clone(main.tables):[];
    const current=tables[index]||{};
    const currentOperationId=String(
      current?.lastOperationId ||
      current?._entitySync?.operationId ||
      ""
    );

    /*
     * 兼容视图可能在权威桌位提交后才写入。若 shop/main 已经包含更新的
     * 另一轮操作，旧的后台任务不能把它覆盖回去。
     */
    if(
      currentOperationId &&
      currentOperationId!==operationId &&
      Number(current?._entitySync?.version||0)>=Number(table?._entitySync?.version||0)
    ){
      return;
    }

    tables[index]=clone(table);
    tx.set(ref,{
      ...main,
      tables,
      _sync:{
        revision:Number(main?._sync?.revision||0)+1,
        updatedAt:Date.now(),
        deviceId:getDeviceId(),
        action:"atomic_start_table_view",
        operationId,
        architecture:"entity-v4"
      }
    },{merge:false});
  });
}

async function mirrorStartedTableIntoMainWithRetry(db,ref,index,table,operationId){
  let lastError=null;
  for(let attempt=0;attempt<3;attempt++){
    try{
      await mirrorStartedTableIntoMain(db,ref,index,table,operationId);
      return;
    }catch(error){
      lastError=error;
      if(attempt<2){
        await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
      }
    }
  }
  throw lastError;
}

export async function atomicStartTable({db,ref,tableIndex,tablePatch,record,timerStartAt,timerEndAt,excludeBookingId=null}){
  const index = Number(tableIndex);
  const tableId = entityDocId("table",index,index);
  const tableRef = doc(db,"tables",tableId);
  const recordRef = doc(db,"records",String(record.id));
  const localBefore = clone((await loadLocalState().catch(()=>null)) || baseline || {});
  let committedTable = null;
  let startedByThisDevice = false;
  const operationId = `atomic_start_${record?.id || index}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  if(!navigator.onLine){
    throw new Error("当前离线，无法确认桌位是否可用，未开始计时");
  }

  /*
   * 权威事务只读取当前桌位，并原子写入当前桌位与进行中账单。
   * shop/main 是旧页面使用的兼容视图，不能参与桌位锁定，否则任意设备
   * 修改预约或其他桌都会让本事务重试，弱网 iPad 最终会误报超时。
   */
  try{
    await runTransaction(db, async tx=>{
      const tableSnap = await tx.get(tableRef);
      const remote = tableSnap.exists() ? clone(tableSnap.data()) : {};

      if(remote.start && !remote.deleted){
        committedTable = clone(remote);
        startedByThisDevice = false;
        return;
      }

      const version = Number(remote.version || remote?._entitySync?.version || 0) + 1;
      committedTable = {
        ...clone(remote),
        ...clone(tablePatch),
        id:tableId,
        tableIndex:index,
        version,
        deleted:false,
        updatedAt:serverTimestamp(),
        updatedBy:getDeviceId(),
        lastOperationId:operationId,
        _entitySync:{version,deviceId:getDeviceId(),operationId}
      };

      tx.set(tableRef,committedTable,{merge:false});
      tx.set(recordRef,{...clone(record),deleted:false,updatedAt:serverTimestamp(),updatedBy:getDeviceId(),lastOperationId:operationId},{merge:true});
      startedByThisDevice = true;
    });
  }catch(error){
    const lockError = new Error(`服务器未能确认桌位，未开始计时：${error?.message || error}`);
    lockError.code = error?.code || "table-lock-failed";
    throw lockError;
  }

  /*
   * 事务中的 serverTimestamp 不能直接写入本机 JSON。为本机与兼容视图
   * 换成确定的毫秒时间；权威 tables 文档仍保留服务器时间。
   */
  if(committedTable){
    committedTable={
      ...clone(committedTable),
      updatedAt:Date.now(),
      _entitySync:{
        ...clone(committedTable?._entitySync||{}),
        updatedAt:Date.now()
      }
    };
  }

  const local = clone((await loadLocalState().catch(()=>null)) || localBefore || {});
  const tables = Array.isArray(local.tables) ? clone(local.tables) : [];
  if(committedTable) tables[index] = clone(committedTable);
  const nextState = {
    ...local,
    tables,
    _sync:{
      revision:Number(local?._sync?.revision || 0)+1,
      updatedAt:Date.now(),
      deviceId:getDeviceId(),
      action:startedByThisDevice?"atomic_start_table":"atomic_start_table_remote"
    }
  };

  baseline = clone(nextState);
  await writeLocalState(nextState,nextState);
  writeShadow(STATE_SHADOW,{state:clone(nextState),cloudBaseline:clone(nextState),savedAt:Date.now(),deviceId:getDeviceId()});
  window.dispatchEvent(new CustomEvent("chiptune-cloud-state-saved",{detail:{state:clone(nextState)}}));
  broadcastState(nextState,"atomic_start_table");

  if(startedByThisDevice && record){
    const localRecords = await loadLocalRecords().catch(()=>[]);
    const mergedRecords = mergeRecordLists(localRecords,[record]);
    writeShadow(RECORDS_SHADOW,mergedRecords);
    broadcastRecord(record,"atomic_start_record");
    await writeLocalRecords(mergedRecords);
  }

  /*
   * 旧页面仍监听 shop/main，因此立即在后台补写兼容视图。
   * 它失败不会撤销已成功的权威开桌，也不会制造“页面报失败、服务器稍后
   * 又成功”的不确定状态；后续本机队列和页面刷新仍会继续补齐。
   */
  void mirrorStartedTableIntoMainWithRetry(
    db,
    ref,
    index,
    committedTable,
    String(committedTable?.lastOperationId||operationId)
  ).catch(error=>{
    console.warn("桌位已安全开始，兼容视图将在后台重试",error);
    setSyncStatus("pending","● 桌位已安全开始 · 其他页面正在同步");
  });

  return {startedByThisDevice,state:nextState,table:clone(committedTable || {})};
}

export async function deleteRecordSafely({db,ref,recordId}){
  const id = String(recordId || "");
  if(!id) throw new Error("缺少账单ID");

  // Tombstone first: this is synchronous and prevents cloud snapshots from reviving the record.
  const deleted = getDeletedRecordIds();
  deleted.add(id);
  saveDeletedRecordIds(deleted);

  const currentShadow = readShadow(RECORDS_SHADOW);
  const shadowList = (Array.isArray(currentShadow) ? currentShadow : []).filter(r=>String(r.id)!==id);
  writeShadow(RECORDS_SHADOW, shadowList);

  try{
    const current = await loadLocalRecords();
    const next = current.filter(r=>String(r.id)!==id);
    await writeLocalRecords(next);
    await queuePut("recordQueue",{id:(crypto.randomUUID?crypto.randomUUID():`delete_record_${id}_${Date.now()}`),syncV4:true,type:"record_delete",recordId:id,createdAt:Date.now(),deviceId:getDeviceId()});
  }catch(err){
    console.warn("账单本地删除队列写入失败，已保留删除标记",err);
  }

  if(navigator.onLine){
    clearTimeout(flushTimer);
    flushTimer = setTimeout(()=>flushPending({db,ref}).catch(err=>{
      console.warn("账单删除同步失败，将自动重试",err);
      setSyncStatus("pending","● 已从本机删除 · 云端删除等待重试");
    }),50);
  }
  return id;
}

export function clearRecordDeletionMark(recordId){
  const deleted = getDeletedRecordIds();
  deleted.delete(String(recordId));
  saveDeletedRecordIds(deleted);
}

export function getLocalRecordSync(recordId){
  if(!recordId) return null;
  const list = readShadow(RECORDS_SHADOW);
  if(!Array.isArray(list)) return null;
  return clone(list.find(r=>String(r.id)===String(recordId)) || null);
}

export function emergencySaveRecord({db,ref,record}){
  const next = clone(record);
  next.localUpdatedAt = Date.now();
  const current = readShadow(RECORDS_SHADOW);
  const currentRecords = Array.isArray(current) ? current : [];
  const previous = currentRecords.find(r=>String(r.id)===String(next.id)) || {id:String(next.id),payments:[]};
  const merged = mergeRecordLists(currentRecords, [next]);
  // localStorage is synchronous: once this returns, the emergency bill has a durable local shadow.
  writeShadow(RECORDS_SHADOW, merged);
  broadcastRecord(next,"emergency_save_record");

  // IndexedDB and cloud queue run in background and must never block the UI.
  Promise.resolve().then(async()=>{
    try{
      await writeLocalRecords(merged);
      await enqueueRecordOperations(next,previous);
      if(navigator.onLine){
        clearTimeout(flushTimer);
        flushTimer = setTimeout(()=>flushPending({db,ref}).catch(err=>{
          console.warn("紧急账单云端同步失败，将自动重试",err);
          setSyncStatus("error",`● 账单同步失败：${err?.code || err?.message || err}`);
        }),0);
      }
    }catch(err){
      console.warn("紧急账单 IndexedDB 保存失败，已保留 localStorage 备份",err);
      setSyncStatus("pending","● 紧急账单已保存在本机备份");
    }
  });
  return next;
}

export function emergencySaveState({db,ref,state,action="emergency_state_update"}){
  const local = clone(state);
  const base = clone(baseline || local);
  // Synchronous shadow first, so closing the modal/page cannot lose this state.
  writeShadow(STATE_SHADOW,{state:local,cloudBaseline:base,savedAt:Date.now(),deviceId:getDeviceId()});
  broadcastState(local,action);
  setSyncStatus(navigator.onLine ? "pending" : "offline", navigator.onLine ? "● 已紧急保存本机 · 等待上传" : "● 已紧急保存本机 · 当前离线");

  Promise.resolve().then(async()=>{
    try{
      await writeLocalState(local,base);
      await enqueue(local,base,action);
      const count = await pendingCount();
      setSyncStatus(navigator.onLine ? "pending" : "offline", navigator.onLine ? `● 已保存本机 · ${count} 项等待上传` : `● 已保存本机 · 离线 · ${count} 项待上传`);
      if(navigator.onLine){
        clearTimeout(flushTimer);
        flushTimer = setTimeout(()=>flushPending({db,ref}).catch(err=>{
          console.warn("紧急状态云端同步失败，将自动重试",err);
          setSyncStatus("error",`● 云端同步失败：${err?.code || err?.message || err}`);
        }),0);
      }
    }catch(err){
      console.warn("紧急状态 IndexedDB 保存失败，已保留 localStorage 备份",err);
      setSyncStatus("pending","● 状态已保存在本机紧急备份");
    }
  });
  return local;
}

/*
 * 预约到店会同时修改一个预约和多张桌位，不能拆成普通实体队列逐条提交。
 * 否则其中一条冲突时会出现“预约已到店但桌位没进入计时器”或相反的半成功状态。
 */
export async function atomicCheckInBooking({db,ref,state,bookingId,tableIndexes}){
  if(!navigator.onLine) throw new Error("当前离线，无法安全办理预约到店");

  const local = clone(state || {});
  const indexes = Array.from(new Set(
    (tableIndexes || []).map(Number).filter(Number.isFinite)
  ));
  const booking = (local.bookings || []).find(
    item=>Number(item?.id) === Number(bookingId)
  );
  if(!booking) throw new Error("找不到要办理到店的预约");
  if(!indexes.length) throw new Error("没有选择到店桌位");

  const operationId = `booking_checkin_${bookingId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const bookingRef = entityRef(db,"booking",String(booking.id));
  const tableRefs = indexes.map(index=>({
    index,
    ref:entityRef(db,"table",entityDocId("table",index,index))
  }));
  let committedState = null;

  await withTimeout(runTransaction(db,async tx=>{
    // Firestore 事务要求所有读取都发生在写入之前。
    const mainSnap = await tx.get(ref);
    const bookingSnap = await tx.get(bookingRef);
    const tableSnaps = [];
    for(const entry of tableRefs){
      tableSnaps.push({entry,snap:await tx.get(entry.ref)});
    }
    const recordSnaps = new Map();
    for(const {snap} of tableSnaps){
      const remote = snap.exists() ? snap.data() : {};
      const recordId = String(remote?.recordId || "");
      if(remote?.start && recordId && !recordSnaps.has(recordId)){
        recordSnaps.set(recordId,await tx.get(recordRefV4(db,recordId)));
      }
    }

    const main = mainSnap.exists() ? clone(mainSnap.data()) : {};
    const remoteBooking = bookingSnap.exists() ? bookingSnap.data() : {};
    const nextTables = Array.isArray(main.tables) ? clone(main.tables) : [];
    const nextBookings = Array.isArray(main.bookings) ? clone(main.bookings) : [];

    for(const {entry,snap} of tableSnaps){
      const desired = clone(local.tables?.[entry.index] || {});
      const remote = snap.exists() ? snap.data() : {};
      if(remote?.start && Number(remote?.bookingId) !== Number(bookingId)){
        const mainTable = main.tables?.[entry.index] || {};
        const recordId = String(remote?.recordId || "");
        const recordSnap = recordId ? recordSnaps.get(recordId) : null;
        const record = recordSnap?.exists() ? recordSnap.data() : {};
        const recordClosed = Boolean(
          record?.closed ||
          record?.forceClosed ||
          record?.deleted ||
          record?.closedAt ||
          ["已结账","已结束","已关闭"].includes(String(record?.status || ""))
        );
        const remoteStartedAt = typeof remote?.start?.toMillis === "function"
          ? Number(remote.start.toMillis())
          : Number(remote?.start || 0);
        const staleRunningSession = Boolean(
          remoteStartedAt &&
          Date.now() - remoteStartedAt > 18 * 60 * 60 * 1000
        );
        // shop/main 已空闲且原账单已关闭，说明权威桌位是旧版结账遗留的幽灵状态。
        // 旧版本账单可能漏写 closed；超过18小时的运行状态也视为跨营业日幽灵。
        // 原子到店会在同一个事务中直接覆盖并修复它。
        if(mainTable?.start || (!recordClosed && !staleRunningSession)){
          throw new Error(`${desired.name || `${entry.index+1}号桌`} 已由其他客人开始使用`);
        }
      }
      const version = Number(remote.version || remote?._entitySync?.version || 0) + 1;
      const entity = {
        ...desired,
        id:entityDocId("table",entry.index,entry.index),
        tableIndex:entry.index,
        version,
        deleted:false,
        updatedAt:serverTimestamp(),
        updatedBy:getDeviceId(),
        lastOperationId:operationId,
        _entitySync:{version,deviceId:getDeviceId(),operationId}
      };
      tx.set(entry.ref,entity,{merge:false});
      nextTables[entry.index] = {
        ...desired,
        _entitySync:{version,updatedAt:Date.now(),deviceId:getDeviceId(),operationId}
      };
    }

    const bookingVersion = Number(
      remoteBooking.version || remoteBooking?._entitySync?.version || 0
    ) + 1;
    tx.set(bookingRef,{
      ...clone(booking),
      version:bookingVersion,
      deleted:false,
      updatedAt:serverTimestamp(),
      updatedBy:getDeviceId(),
      lastOperationId:operationId,
      _entitySync:{version:bookingVersion,deviceId:getDeviceId(),operationId}
    },{merge:false});

    const bookingIndex = nextBookings.findIndex(
      item=>Number(item?.id) === Number(bookingId)
    );
    const bookingView = {
      ...clone(booking),
      _entitySync:{
        version:bookingVersion,
        updatedAt:Date.now(),
        deviceId:getDeviceId(),
        operationId
      }
    };
    if(bookingIndex >= 0) nextBookings[bookingIndex] = bookingView;
    else nextBookings.push(bookingView);

    committedState = {
      ...main,
      tables:nextTables,
      bookings:nextBookings,
      _sync:{
        revision:Number(main?._sync?.revision || 0)+1,
        updatedAt:Date.now(),
        deviceId:getDeviceId(),
        operationId,
        action:"booking_arrived_to_timer",
        architecture:"entity-v4"
      }
    };
    tx.set(ref,committedState,{merge:false});
    tx.set(operationRef(db,operationId),{
      operationId,
      entityType:"booking_checkin",
      entityId:String(bookingId),
      tableIndexes:indexes,
      action:"booking_arrived_to_timer",
      deviceId:getDeviceId(),
      status:"committed",
      committedAt:serverTimestamp()
    });
  }),CLOUD_SYNC_TIMEOUT_MS,"预约到店服务器事务");

  baseline = clone(committedState);
  await writeLocalState(committedState,committedState);
  writeShadow(STATE_SHADOW,{
    state:clone(committedState),
    cloudBaseline:clone(committedState),
    savedAt:Date.now(),
    deviceId:getDeviceId()
  });
  broadcastState(committedState,"booking_arrived_to_timer");
  setSyncStatus(
    "synced",
    idbStateDegraded ? "● 云端已同步 · 本机使用应急缓存" : "● 到店状态已同步"
  );
  return clone(committedState);
}

/*
 * 结账/强制结束时同步释放权威 tables 文档和 shop/main 兼容视图。
 * expectedRecordId 防止延迟到达的旧结账误清除另一位客人刚开始的新计时。
 */
export async function atomicReleaseTable({
  db,
  ref,
  tableIndex,
  table,
  expectedRecordId="",
  action="release_table"
}){
  if(!navigator.onLine) throw new Error("当前离线，桌位将保留在本机队列等待释放");
  const index = Number(tableIndex);
  const tableId = entityDocId("table",index,index);
  const tableRef = doc(db,"tables",tableId);
  const operationId = `${action}_${index}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  let committedState = null;

  await withTimeout(runTransaction(db,async tx=>{
    const mainSnap = await tx.get(ref);
    const tableSnap = await tx.get(tableRef);
    const main = mainSnap.exists() ? clone(mainSnap.data()) : {};
    const remote = tableSnap.exists() ? tableSnap.data() : {};
    const remoteRecordId = String(remote?.recordId || "");
    const expected = String(expectedRecordId || "");

    if(remote?.start && expected && remoteRecordId && remoteRecordId !== expected){
      throw new Error("桌位已开始新的计时，旧结账不能清除当前客人");
    }

    const version = Number(remote.version || remote?._entitySync?.version || 0) + 1;
    const nextTable = {
      ...clone(table || {}),
      id:tableId,
      tableIndex:index,
      version,
      deleted:false,
      updatedAt:serverTimestamp(),
      updatedBy:getDeviceId(),
      lastOperationId:operationId,
      _entitySync:{version,deviceId:getDeviceId(),operationId}
    };
    tx.set(tableRef,nextTable,{merge:false});

    const tables = Array.isArray(main.tables) ? clone(main.tables) : [];
    tables[index] = {
      ...clone(table || {}),
      _entitySync:{version,updatedAt:Date.now(),deviceId:getDeviceId(),operationId}
    };
    committedState = {
      ...main,
      tables,
      _sync:{
        revision:Number(main?._sync?.revision || 0)+1,
        updatedAt:Date.now(),
        deviceId:getDeviceId(),
        operationId,
        action,
        architecture:"entity-v4"
      }
    };
    tx.set(ref,committedState,{merge:false});
    tx.set(operationRef(db,operationId),{
      operationId,
      entityType:"table",
      entityId:tableId,
      tableIndex:index,
      action,
      deviceId:getDeviceId(),
      status:"committed",
      committedAt:serverTimestamp()
    });
  }),CLOUD_SYNC_TIMEOUT_MS,"释放桌位服务器事务");

  baseline = clone(committedState);
  return clone(committedState);
}


export async function atomicBatchStartTables({db,ref,entries,group=null}){
  if(!navigator.onLine) throw new Error("当前离线，无法执行跨设备安全批量开始");
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if(!list.length) throw new Error("没有可开始的桌位");

  let result = null;
  await runTransaction(db, async tx=>{
    const snap = await tx.get(ref);
    const latest = snap.exists() ? clone(snap.data()) : {};
    const tables = Array.isArray(latest.tables) ? clone(latest.tables) : [];

    for(const entry of list){
      const tableIndex = Number(entry.tableIndex);
      const existing = tables[tableIndex] || {};
      if(existing.start){
        const err = new Error(`${existing.name || `${tableIndex+1}号桌`}已经开始，批量开始已取消。`);
        err.code = "table-already-started";
        throw err;
      }
    }
    for(const entry of list){
      const tableIndex = Number(entry.tableIndex);
      tables[tableIndex] = {...(tables[tableIndex] || {}),...clone(entry.tablePatch)};
    }
    latest.tables = tables;
    if(group){
      const groups = Array.isArray(latest.groups) ? clone(latest.groups) : [];
      const idx = groups.findIndex(g=>String(g?.id) === String(group.id));
      if(idx >= 0) groups[idx] = {...groups[idx],...clone(group)};
      else groups.push(clone(group));
      latest.groups = groups;
    }
    latest._sync = {revision:Number(latest?._sync?.revision || 0)+1,updatedAt:Date.now(),deviceId:getDeviceId(),action:"atomic_batch_start_tables"};
    tx.set(ref,latest);
    for(const entry of list){
      if(entry.record?.id) tx.set(doc(db,"records",String(entry.record.id)),clone(entry.record));
    }
    result = {state:latest,startedIndexes:list.map(x=>Number(x.tableIndex))};
  });

  if(result?.state){
    const opId=`atomic_batch_${Date.now()}`;
    for(const entry of list){ await mirrorTableEntity(db,Number(entry.tableIndex),result.state.tables?.[Number(entry.tableIndex)]||entry.tablePatch,`${opId}_${entry.tableIndex}`); await mirrorRecordEntity(db,entry.record,`${opId}_${entry.tableIndex}`); }
    baseline = clone(result.state);
    await writeLocalState(result.state,result.state);
    writeShadow(STATE_SHADOW,{state:clone(result.state),cloudBaseline:clone(result.state),savedAt:Date.now(),deviceId:getDeviceId()});
    broadcastState(result.state,"atomic_batch_start_tables");
  }
  if(result){
    const records = list.map(x=>x.record).filter(Boolean);
    const localRecords = await loadLocalRecords().catch(()=>[]);
    const mergedRecords = mergeRecordLists(localRecords,records);
    writeShadow(RECORDS_SHADOW,mergedRecords);
    await writeLocalRecords(mergedRecords);
  }
  return result;
}


export async function atomicAdjustStartTime({db,ref,tableIndex,tablePatch,recordId,recordPatch}){
  if(!navigator.onLine) throw new Error("当前离线，无法安全修改开始时间");
  let result = null;
  await runTransaction(db, async tx=>{
    const snap = await tx.get(ref);
    if(!snap.exists()) throw new Error("云端桌位数据不存在");
    const latest = clone(snap.data());
    const tables = Array.isArray(latest.tables) ? clone(latest.tables) : [];
    const index = Number(tableIndex);
    const existing = tables[index];
    if(!existing?.start) throw new Error("该桌当前未开始，无法修改开始时间");
    if(recordId && existing.recordId && String(existing.recordId) !== String(recordId)){
      throw new Error("账单已被其他设备更新，请刷新后重试");
    }
    tables[index] = {...existing,...clone(tablePatch)};
    latest.tables = tables;
    latest._sync = {revision:Number(latest?._sync?.revision || 0)+1,updatedAt:Date.now(),deviceId:getDeviceId(),action:"atomic_adjust_start_time"};
    tx.set(ref,latest);
    if(recordId){
      tx.set(doc(db,"records",String(recordId)),clone(recordPatch || {}),{merge:true});
    }
    result = {state:latest};
  });
  if(result?.state){
    const opId=`adjust_start_${recordId||tableIndex}_${Date.now()}`;
    await mirrorTableEntity(db,Number(tableIndex),result.state.tables?.[Number(tableIndex)]||tablePatch,opId);
    if(recordId){ const legacy=await getDoc(doc(db,"records",String(recordId))); await mirrorRecordEntity(db,legacy.exists()?{id:String(recordId),...legacy.data()}:{id:String(recordId),...(recordPatch||{})},opId); }
    baseline = clone(result.state);
    await writeLocalState(result.state,result.state);
    writeShadow(STATE_SHADOW,{state:clone(result.state),cloudBaseline:clone(result.state),savedAt:Date.now(),deviceId:getDeviceId()});
    broadcastState(result.state,"atomic_adjust_start_time");
  }
  if(recordId && recordPatch){
    const localRecords = await loadLocalRecords().catch(()=>[]);
    const old = localRecords.find(r=>String(r.id)===String(recordId)) || {id:String(recordId)};
    const mergedRecords = mergeRecordLists(localRecords,[{...old,...clone(recordPatch),id:String(recordId)}]);
    writeShadow(RECORDS_SHADOW,mergedRecords);
    await writeLocalRecords(mergedRecords);
  }
  return result;
}

export async function atomicAdjustTableExtra({db,ref,tableIndex,deltaMs,action,getState}){
  const currentState = clone(getState ? getState() : (await loadLocalState()));
  if(!currentState?.tables?.[tableIndex]) throw new Error("找不到该桌位");
  const table = clone(currentState.tables[tableIndex]);
  const current = Number(table.extra || 0);
  if(deltaMs < 0 && current < Math.abs(deltaMs)) throw new Error("没有可以撤回的续时");
  table.extra = Math.max(0,current + Number(deltaMs || 0));
  table.alerted = false;
  table.alerting = false;
  table.lastAction = action || (deltaMs > 0 ? "extend" : "undo_extend");
  table.updatedAt = Date.now();
  currentState.tables[tableIndex] = table;
  await saveStateSafely({db,ref,getState:()=>currentState,action:action || "adjust_extra"});
  return table;
}


/**
 * 统一读取全部收银记录。
 *
 * 设计原则：
 * 1. Firestore records 集合是正式历史账单来源；
 * 2. 本机未上传账单始终合并显示；
 * 3. 云端历史记录按文档 ID 分批读取，避免包含收款截图的大文档一次性下载时卡死；
 * 4. 每读取一批就立刻更新页面，直到完整读完 records 集合。
 */
export function subscribeAllRecords({
  db,
  onChange,
  onStatus,
  fullHistory = false
}={}){
  const recordsRef = collection(db,"records");
  const BATCH_SIZE = 5;
  const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  let cloudRecords = [];
  let fullServerRecords = [];
  let stopped = false;
  let retryTimer = null;
  let loadingAll = false;
  let incrementalUnsubscribe = null;
  let deleteUnsubscribe = null;
  let sharedDeletedIds = new Set();

  // 同一台设备的计时器写入账单后，首页/今日账单/老板模式立即接收，
  // 不等待 Firestore 再回传一次。
  const recordBroadcastHandler = event=>{
    const record = event?.detail?.record;
    if(stopped || !record?.id || sharedDeletedIds.has(String(record.id))) return;
    cloudRecords = mergeRecordLists(cloudRecords,[record]);
    loadLocalRecords().then(local=>{
      if(!stopped) onChange?.(mergeRecordLists(cloudRecords,local));
    }).catch(()=>{
      if(!stopped) onChange?.(mergeRecordLists(cloudRecords,[record]));
    });
  };
  window.addEventListener("chiptune-record-broadcast",recordBroadcastHandler);

  const readMeta = ()=>{
    try{
      return JSON.parse(localStorage.getItem(RECORD_HISTORY_SYNC_META) || "null") || {};
    }catch{
      return {};
    }
  };

  const writeMeta = meta=>{
    try{
      localStorage.setItem(RECORD_HISTORY_SYNC_META,JSON.stringify(meta));
    }catch(err){
      console.warn("历史账单同步进度保存失败",err);
    }
  };

  const recordTime = r=>Number(r?.timestamp || r?.closedAt || r?.paidAt || 0);
  const mergeCloud = list=>{
    cloudRecords = mergeRecordLists(cloudRecords,(list || []).filter(r=>!sharedDeletedIds.has(String(r.id))));
  };

  const applySharedDeletes = async ids=>{
    let changed=false;
    for(const id of ids || []){
      const key=String(id);
      if(!sharedDeletedIds.has(key)) changed=true;
      sharedDeletedIds.add(key);
    }
    if(!changed && !ids?.length) return;
    cloudRecords = cloudRecords.filter(r=>!sharedDeletedIds.has(String(r.id)));
    const local = await loadLocalRecords().catch(()=>[]);
    const filtered = local.filter(r=>!sharedDeletedIds.has(String(r.id)));
    if(filtered.length !== local.length) await writeLocalRecords(filtered).catch(()=>{});
    if(!stopped) onChange?.(mergeRecordLists(cloudRecords,filtered));
  };

  const startDeleteListener = ()=>{
    if(stopped || deleteUnsubscribe) return;
    deleteUnsubscribe = onSnapshot(collection(db,RECORD_DELETES_COLLECTION),snap=>{
      applySharedDeletes(snap.docs.map(d=>d.id)).catch(err=>console.warn("同步账单删除标记失败",err));
    },err=>console.warn("账单删除标记监听失败",err));
  };

  const emit = async({persist=false}={})=>{
    const local = (await loadLocalRecords().catch(()=>[])).filter(r=>!sharedDeletedIds.has(String(r.id)));
    const merged = mergeRecordLists(cloudRecords,local).filter(r=>!sharedDeletedIds.has(String(r.id)));

    if(persist){
      await replaceLocalRecords(merged).catch(err=>{
        console.warn("保存历史账单到本机失败",err);
      });
    }

    if(!stopped) onChange?.(merged);
    return merged;
  };

  const startIncrementalListener = async()=>{
    if(stopped || incrementalUnsubscribe) return;

    const local = await loadLocalRecords().catch(()=>[]);
    const meta = readMeta();
    const localNewest = Math.max(0,...local.map(recordTime));
    const lastTimestamp = Number(meta.lastTimestamp || localNewest || 0);

    // 已有完整历史时，只监听最后时间附近的新记录；从未完整下载过时，
    // 非收银页面只监听最近7天，避免首页启动时下载全部历史和大图。
    const since = lastTimestamp > 0
      ? Math.max(0,lastTimestamp - 60000)
      : Math.max(0,Date.now() - RECENT_WINDOW_MS);

    const q = query(
      recordsRef,
      where("timestamp",">=",since),
      orderBy("timestamp","asc")
    );

    incrementalUnsubscribe = onSnapshot(
      q,
      {includeMetadataChanges:true},
      async snap=>{
        const list = snap.docs
          .map(d=>({id:d.id,...d.data()}))
          .filter(r=>r.id!=="init" && !r.deleted);

        mergeCloud(list);
        const merged = await emit({persist:!snap.metadata.fromCache});

        if(!snap.metadata.fromCache){
          const newest = Math.max(lastTimestamp,...merged.map(recordTime));
          writeMeta({
            ...readMeta(),
            lastTimestamp:newest,
            lastSyncAt:Date.now(),
            count:merged.length
          });
          onStatus?.(`已从本机载入 ${merged.length} 条｜新记录已同步`);
        }
      },
      err=>{
        console.warn("新账单实时监听失败",err);
        onStatus?.("本机账单已载入｜新记录将在联网后同步");
      }
    );
  };

  const scheduleRetry = ()=>{
    clearTimeout(retryTimer);
    if(!stopped){
      retryTimer = setTimeout(loadAllFromServer,3000);
    }
  };

  async function loadAllFromServer(){
    if(stopped || loadingAll || !fullHistory) return;

    if(!navigator.onLine){
      const local = await loadLocalRecords().catch(()=>[]);
      onStatus?.(`已从本机载入 ${local.length} 条｜等待联网继续读取历史账单`);
      scheduleRetry();
      return;
    }

    loadingAll = true;
    const savedMeta = readMeta();
    let total = null;

    try{
      try{
        const countSnap = await withTimeout(
          getCountFromServer(recordsRef),
          15000,
          "历史账单数量读取"
        );
        const rawTotal = Number(countSnap.data().count || 0);
        const initSnap = await withTimeout(
          getDoc(doc(db,"records","init")),
          15000,
          "历史账单占位文档检查"
        );
        total = Math.max(0,rawTotal - (initSnap.exists() ? 1 : 0));
      }catch(err){
        console.warn("无法读取历史账单总数，将仅显示已读取数量",err);
      }

      // 支持中断续传。cursorId 是上次成功保存到本机的最后一个文档ID。
      // 旧版本可能错误地把 complete 写成 true，但本机实际上只有 0 条或少量记录。
      // 因此必须用本机实际条数和云端总数校验，不能只相信 complete 标志。
      const localBefore = await loadLocalRecords().catch(()=>[]);
      const expectedCount = total == null ? Number(savedMeta.count || 0) : total;
      const cacheLooksComplete = Boolean(
        savedMeta.complete &&
        localBefore.length > 0 &&
        (expectedCount <= 0 || localBefore.length >= expectedCount)
      );

      if(savedMeta.complete && !cacheLooksComplete){
        console.warn("历史账单完成标志与本机缓存不一致，自动重新扫描",{
          localCount:localBefore.length,
          expectedCount,
          savedMeta
        });
        writeMeta({
          complete:false,
          cursorId:null,
          loaded:0,
          count:localBefore.length,
          lastTimestamp:Math.max(0,...localBefore.map(recordTime)),
          resetAt:Date.now(),
          resetReason:"stale_complete_flag"
        });
      }

      // 为了保证本机镜像能准确删除云端已经不存在的旧记录，
      // 未完成的完整扫描每次都从头开始。已有页面数据仍从本机立即显示，扫描只在后台重建镜像。
      let cursorId = null;
      let loaded = 0;
      fullServerRecords = [];

      if(cacheLooksComplete){
        onStatus?.(`已从本机载入全部历史账单｜${localBefore.length} 条`);
        await startIncrementalListener();
        return;
      }

      onStatus?.(
        total!=null
          ? `正在读取全部历史账单｜${Math.min(loaded,total)} / ${total}（${total ? Math.min(100,Math.round(loaded/total*100)) : 0}%）`
          : `正在读取全部历史账单｜已读取 ${loaded} 条`
      );

      while(!stopped){
        const pageQuery = cursorId
          ? query(recordsRef,orderBy(documentId()),startAfter(cursorId),limit(BATCH_SIZE))
          : query(recordsRef,orderBy(documentId()),limit(BATCH_SIZE));

        const snap = await withTimeout(
          getDocsFromServer(pageQuery),
          90000,
          "历史账单分批读取"
        );

        if(stopped) return;

        const docs = snap.docs;
        const list = docs
          .map(d=>({id:d.id,...d.data()}))
          .filter(r=>r.id!=="init" && !r.deleted);

        fullServerRecords = mergeRecordLists(fullServerRecords,list);
        mergeCloud(list);
        const merged = await emit({persist:true});

        loaded += list.length;
        cursorId = docs.length ? docs[docs.length-1].id : cursorId;

        const percent = total
          ? Math.min(100,Math.round(Math.min(loaded,total)/total*100))
          : null;

        writeMeta({
          complete:false,
          cursorId,
          loaded,
          count:merged.length,
          lastTimestamp:Math.max(0,...merged.map(recordTime)),
          lastSyncAt:Date.now()
        });

        onStatus?.(
          total!=null
            ? `正在读取全部历史账单｜${Math.min(loaded,total)} / ${total}（${percent}%）`
            : `正在读取全部历史账单｜已读取 ${loaded} 条`
        );

        if(docs.length < BATCH_SIZE){
          // 完整扫描结束后，以云端全集为基础重建本机镜像；仅保留尚未上传的新账单。
          const pendingItems = await queueAll("recordQueue");
          const pendingRecords = pendingItems
            .filter(x=>x.type !== "delete" && x.record)
            .map(x=>x.record);
          const exactMerged = mergeRecordLists(
            fullServerRecords.filter(r=>!sharedDeletedIds.has(String(r.id))),
            pendingRecords.filter(r=>!sharedDeletedIds.has(String(r.id)))
          );
          await writeLocalRecords(exactMerged);
          cloudRecords = clone(exactMerged);
          if(!stopped) onChange?.(clone(exactMerged));
          const newest = Math.max(0,...exactMerged.map(recordTime));
          writeMeta({
            complete:true,
            cursorId:null,
            loaded:exactMerged.length,
            count:exactMerged.length,
            lastTimestamp:newest,
            lastSyncAt:Date.now()
          });
          onStatus?.(`全部历史账单已保存到本机｜共 ${exactMerged.length} 条`);
          await startIncrementalListener();
          return;
        }
      }
    }catch(err){
      console.warn("完整历史账单读取失败",err);
      const local = await loadLocalRecords().catch(()=>[]);
      const reason = String(err?.message || err || "未知错误");
      onStatus?.(`已保存 ${local.length} 条到本机｜读取中断：${reason}｜3秒后继续`);
      scheduleRetry();
    }finally{
      loadingAll = false;
    }
  }

  // 所有页面都监听共享删除标记，保证手机和 iPad 删除结果一致。
  startDeleteListener();

  // 所有页面先立即使用本机数据。只有收银记录页面要求执行一次完整历史下载。
  loadLocalRecords().then(async local=>{
    if(stopped) return;

    cloudRecords = mergeRecordLists(cloudRecords,local);
    onChange?.(cloudRecords);

    const meta = readMeta();
    if(fullHistory && !meta.complete){
      loadAllFromServer();
      return;
    }

    if(meta.complete){
      onStatus?.(`已从本机载入全部历史账单｜${local.length} 条`);
    }else{
      onStatus?.(`已从本机载入 ${local.length} 条`);
    }
    await startIncrementalListener();
  }).catch(err=>{
    console.warn("读取本机账单失败",err);
    onStatus?.("本机账单读取失败｜正在尝试云端同步");
    if(fullHistory) loadAllFromServer();
    else startIncrementalListener();
  });

  const onlineHandler = ()=>{
    const meta = readMeta();
    if(fullHistory && !meta.complete) loadAllFromServer();
    else startIncrementalListener();
  };
  window.addEventListener("online",onlineHandler);

  return ()=>{
    stopped = true;
    clearTimeout(retryTimer);
    incrementalUnsubscribe?.();
    deleteUnsubscribe?.();
    window.removeEventListener("online",onlineHandler);
    window.removeEventListener("chiptune-record-broadcast",recordBroadcastHandler);
  };
}
