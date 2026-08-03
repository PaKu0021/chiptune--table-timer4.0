/*alert("app.js 已加载");*/
import { db } from "./firebase.js?v=4.0.64";
import { doc, onSnapshot, getDoc, getDocFromServer } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { setStateBaseline, saveStateSafely, installConnectionGuard, setSyncStatus, loadLocalState, reconcileCloudState, flushPending, getLocalRecord, getLocalRecordSync, saveRecordSafely, emergencySaveRecord, emergencySaveState, atomicStartTable, atomicBatchStartTables, atomicAdjustStartTime, atomicReleaseTable } from "./safe-state.js?v=4.0.64";
/*import { formatTime } from "./common.js?v=4.0.64";*/
import { resetTable, formatTime } from "./common.js?v=4.0.64";
import { allocateGroupId, ensureGroups, getGroup, upsertGroup, syncGroupReferences } from "./group-model.js?v=4.0.64";
import { getBusinessDateKey, jpyToRmb, currencyForPaymentMethod, repairRecordPaymentAmounts } from "./business-day.js?v=4.0.64";
const ref = doc(db, "shop", "main");

const VAPID_KEY = "BN7TodJ52H-wKg54Dj-tFcm21Q5zplpmeFuXYzqtQbkb1LzpTO-pRsGV1fWpUEiDKxBbqN8l2SRtzXuiisRHEPE";


let state = null;
let lastAppliedAppStateKey = "";
let syncBatchActive = false;
let pendingSyncBatchState = null;
let pendingSyncBatchSource = "";
installConnectionGuard();

loadLocalState()
  .then(local=>{
    if(!local || state) return;

    applyIncomingAppState(
      local,
      "本机缓存"
    );
  })
  .catch(error=>{
    console.error(
      "读取本机桌位状态失败",
      error
    );
  });
window.addEventListener("chiptune-online-change",e=>{
  if(e.detail?.online) flushPending({db,ref,quiet:true}).catch(err=>console.warn("自动同步失败",err));
});
window.addEventListener("chiptune-sync-tick",()=>{
  flushPending({db,ref,quiet:true}).catch(err=>console.warn("定时同步失败",err));
});
window.addEventListener("chiptune-sync-batch",event=>{
  if(event.detail?.phase === "start"){
    syncBatchActive = true;
    return;
  }
  if(event.detail?.phase !== "end") return;

  syncBatchActive = false;
  const pending = pendingSyncBatchState;
  const source = pendingSyncBatchSource || "批量同步完成";
  pendingSyncBatchState = null;
  pendingSyncBatchSource = "";
  if(pending){
    applyIncomingAppState(pending,source);
  }
});

// 本机事务写入云端成功后，立即采用服务器最终合并状态。
window.addEventListener(
  "chiptune-cloud-state-saved",
  event=>{
    applyIncomingAppState(
      event.detail?.state,
      "云端保存"
    );
  }
);

window.addEventListener(
  "chiptune-state-broadcast",
  event=>{
    const incoming =
      event.detail?.state;

    if(!incoming) return;

    applyIncomingAppState(
      incoming,
      event.detail?.action
        ? `本机页面同步：${event.detail.action}`
        : "本机页面同步"
    );

    setSyncStatus(
      navigator.onLine
        ? "pending"
        : "offline",
      navigator.onLine
        ? "● 已收到预约操作 · 正在同步云端"
        : "● 已收到预约操作 · 当前离线"
    );
  }
);

window.addEventListener(
  "storage",
  event=>{
    if(
      event.key !== "chiptune_state_shadow_v2" ||
      !event.newValue
    ){
      return;
    }

    try{
      const box =
        JSON.parse(event.newValue);

      if(!box?.state) return;

      applyIncomingAppState(
        box.state,
        "本机状态备份"
      );
    }catch(error){
      console.warn(
        "读取其他页面状态失败",
        error
      );
    }
  }
);
// iPad 桌面网页偶尔会只停留在 Firestore 缓存。实时快照负责正常同步，
// 这里每60秒只做一次安全核对；恢复联网或回到前台时立即核对一次。
// 同一时刻只允许一个服务器请求，避免弱网下请求堆积后连续覆盖界面。
let sharedStateRefreshPromise = null;
let lastSharedStateRefreshAt = 0;
const SHARED_STATE_REFRESH_INTERVAL_MS = 60000;

async function refreshSharedStateFromServer({force=false}={}){
  if(!navigator.onLine) return;
  if(shouldDeferTableRender()) return;
  if(sharedStateRefreshPromise) return sharedStateRefreshPromise;

  const now = Date.now();
  if(!force && now - lastSharedStateRefreshAt < SHARED_STATE_REFRESH_INTERVAL_MS) return;

  sharedStateRefreshPromise = (async()=>{
    try{
      const snap =
        await getDocFromServer(ref);

      lastSharedStateRefreshAt = Date.now();
      if(!snap.exists()) return;

      const incoming =
        await reconcileCloudState(
          snap.data()
        );

      applyIncomingAppState(
        incoming,
        "主动服务器刷新"
      );

    }catch(error){
      console.warn(
        "主动刷新共享桌位状态失败",
        error
      );
    }finally{
      sharedStateRefreshPromise = null;
    }
  })();

  return sharedStateRefreshPromise;
}
setInterval(()=>refreshSharedStateFromServer(),SHARED_STATE_REFRESH_INTERVAL_MS);
window.addEventListener("online",()=>refreshSharedStateFromServer({force:true}));
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) refreshSharedStateFromServer({force:true}); });

let checkoutIndex = null;
let checkoutSubmitting = false;
let forceEndIndex = null;
let forceEndSubmitting = false;
let useRound = false;
let alertLoops = {};
let remindLocks = {};
let searchKeyword = "";
let statusFilter = "";
let typeFilter = "";
let payFilter = "";
let sortDirection = "asc";
let filterPanelOpen = true;
let groupViewMode = false;
let editingGroupId = "";
let autoClosingOldTables = false;
let movingRunningFromIndex = null;
let movingRunningToIndex = null;
let draggingRunningFrom = null;
let runningMoveTempLine = null;
let runningMoveAreaRect = null;
let editingPreMinutesIndex = null;
let pendingRenderAfterInput = false;
const preMinutesDrafts = {};
const expandedTableCards = new Set();
const requestedTableMatch = String(location.hash || "").match(/^#table-(\d+)$/);
const requestedTableIndex = requestedTableMatch ? Number(requestedTableMatch[1]) - 1 : null;
let requestedTableFocused = false;
if(Number.isInteger(requestedTableIndex) && requestedTableIndex >= 0){
  expandedTableCards.add(requestedTableIndex);
}
let tableInteractionHoldUntil = 0;
const locallyProtectedTables = new Map();
const LOCAL_TABLE_PROTECTION_MS = 5 * 60 * 1000;

function protectLocalTable(i,durationMs=12000){
  const index = Number(i);
  if(!Number.isInteger(index) || index < 0) return;
  locallyProtectedTables.set(
    index,
    Date.now() + Math.max(LOCAL_TABLE_PROTECTION_MS,Number(durationMs) || 0)
  );
  tableInteractionHoldUntil = Math.max(tableInteractionHoldUntil,Date.now() + 900);
}

function preserveProtectedTables(incomingState){
  if(!incomingState?.tables || !state?.tables) return incomingState;
  const now = Date.now();
  for(const [index,until] of locallyProtectedTables){
    if(until <= now){
      locallyProtectedTables.delete(index);
      continue;
    }
    const localTable = state.tables[index];
    const incomingTable = incomingState.tables[index];
    if(!localTable) continue;

    const localOperationId = String(
      localTable?._entitySync?.operationId ||
      localTable?.lastOperationId ||
      ""
    );
    const incomingOperationId = String(
      incomingTable?._entitySync?.operationId ||
      incomingTable?.lastOperationId ||
      ""
    );
    const sameVisibleState =
      JSON.stringify(withoutSyncMeta(localTable)) ===
      JSON.stringify(withoutSyncMeta(incomingTable));

    // 云端已经确认了本机这次操作，或内容已经完全一致，才解除保护。
    if(
      sameVisibleState ||
      (
        localOperationId &&
        incomingOperationId === localOperationId
      )
    ){
      locallyProtectedTables.delete(index);
      continue;
    }

    incomingState.tables[index] = structuredClone(localTable);
  }
  return incomingState;
}

function withoutSyncMeta(value){
  if(!value || typeof value !== "object") return value;
  const {
    _entitySync,
    updatedAt,
    localUpdatedAt,
    lastOperationId,
    version,
    ...visible
  } = value;
  return visible;
}


function newTable(i){
  return resetTable(i + "号桌");
}   
 

const defaultState = {
  packages:[
    {name:"1小时", minutes:60, price:1500, extensionPrice:900, unlimited:false},
    {name:"2小时", minutes:120, price:2800, extensionPrice:900, unlimited:false},
    {name:"3小时", minutes:180, price:3300, extensionPrice:900, unlimited:false},
    {name:"6小时／平日不限时", minutes:360, price:5500, extensionPrice:800, unlimited:false},
    {name:"不限时", minutes:0, price:5500, extensionPrice:0, unlimited:true}
  ],
  tables: Array.from({length:12},(_,i)=>newTable(i+1)),
  bookings:[],
  customers:{}
};

function normalizeAppCustomers(customers){
  const result = {};

  if(Array.isArray(customers)){
    customers.forEach(customer=>{
      if(
        !customer ||
        typeof customer !== "object"
      ){
        return;
      }

      const key =
        customer.key ||
        makeCustomerKey(
          customer.name,
          customer.phoneLast4
        );

      if(!key) return;

      result[key] = {
        ...customer,
        key,
        visits:Array.isArray(customer.visits)
          ? customer.visits
          : [],
        visitCount:Array.isArray(customer.visits)
          ? customer.visits.length
          : Number(customer.visitCount || 0)
      };
    });

    return result;
  }

  if(
    customers &&
    typeof customers === "object"
  ){
    Object.entries(customers)
      .forEach(([rawKey,customer])=>{
        if(
          !customer ||
          typeof customer !== "object"
        ){
          return;
        }

        const key =
          customer.key ||
          rawKey ||
          makeCustomerKey(
            customer.name,
            customer.phoneLast4
          );

        if(!key) return;

        const visits =
          Array.isArray(customer.visits)
            ? customer.visits
            : [];

        result[key] = {
          ...customer,
          key,
          visits,
          visitCount:visits.length
        };
      });
  }

  return result;
}

function normalizeAppState(nextState){
  const next =
    nextState && typeof nextState === "object"
      ? nextState
      : structuredClone(defaultState);

  if(
    !Array.isArray(next.tables) ||
    next.tables.length === 0
  ){
    next.tables =
      structuredClone(defaultState.tables);
  }

  if(
    !Array.isArray(next.packages) ||
    next.packages.length === 0
  ){
    next.packages =
      structuredClone(defaultState.packages);
  }
  if(!next.packages.some(p=>!p?.customPricing && Number(p.minutes)===120 && Number(p.price)===2800)){
    next.packages.push({name:"2小时",minutes:120,price:2800,extensionPrice:900,unlimited:false,customPricing:false});
  }

  if(!Array.isArray(next.bookings)){
    next.bookings = [];
  }

  ensureGroups(next);

  next.customers =
    normalizeAppCustomers(next.customers);

  next.tables.forEach((t,i)=>{
    if(!t || typeof t !== "object"){
      next.tables[i] =
        resetTable((i + 1) + "号桌");
      return;
    }

    if(!t.name) t.name = (i + 1) + "号桌";
    if(t.packageIndex === undefined) t.packageIndex = 0;
    if(!t.customer) t.customer = {name:"",phoneLast4:""};
    if(t.currency === undefined) t.currency = "日元";
    if(t.alerted === undefined) t.alerted = false;
    if(t.alerting === undefined) t.alerting = false;
    if(t.extra === undefined) t.extra = 0;
    if(t.pausedAt === undefined) t.pausedAt = null;
    if(t.pay === undefined) t.pay = "";
    if(t.payTiming === undefined) t.payTiming = "prepaid";
    if(t.paidJPY === undefined) t.paidJPY = 0;
    if(t.paidRMB === undefined) t.paidRMB = 0;
    if(t.paidAt === undefined) t.paidAt = null;
    if(t.startedPackageName === undefined) t.startedPackageName = "";
    if(t.startedPackagePrice === undefined) t.startedPackagePrice = null;
    if(t.type === undefined) t.type = "";
    if(t.lastAction === undefined) t.lastAction = "";
    if(t.recordId === undefined) t.recordId = null;
    if(t.startLocked === undefined) t.startLocked = Boolean(t.start);
    if(t.customerKey === undefined) t.customerKey = "";
    if(t.visitId === undefined) t.visitId = null;
    if(t.visitDate === undefined) t.visitDate = "";
    if(t.visitRange === undefined) t.visitRange = "";
    if(t.bookingId === undefined) t.bookingId = null;
    if(t.groupId === undefined) t.groupId = "";
    if(t.groupName === undefined) t.groupName = "";
    if(t.groupColor === undefined) t.groupColor = "";
    if(t.activeColor === undefined) t.activeColor = "";
    if(t.arrivalTimeDraft === undefined) t.arrivalTimeDraft = "";

    if(t.customPackage?.enabled){
      t.customPackage.enabled = false;
    }
  });

  const legacyById = new Map();
  next.tables.forEach((t,index)=>{
    if(!t.groupId) return;
    if(!legacyById.has(String(t.groupId))) legacyById.set(String(t.groupId),[]);
    legacyById.get(String(t.groupId)).push(index);
  });
  legacyById.forEach((indexes,id)=>{
    const first = next.tables[indexes[0]] || {};
    upsertGroup(next,{
      ...(getGroup(next,id) || {}),
      id,
      name:first.groupName || getGroup(next,id)?.name || "未命名组",
      color:first.groupColor || getGroup(next,id)?.color || "#B7E4C7",
      tableIndexes:indexes,
      peopleCount:getGroup(next,id)?.peopleCount || Math.max(1,indexes.length)
    });
  });
  return next;
}

function applyIncomingAppState(
  incoming,
  source="同步"
){
  if(
    !incoming ||
    typeof incoming !== "object"
  ){
    return;
  }

  if(
    syncBatchActive &&
    (
      String(source).startsWith("Firestore") ||
      source === "主动服务器刷新"
    )
  ){
    pendingSyncBatchState = structuredClone(incoming);
    pendingSyncBatchSource = source;
    return;
  }

  if(shouldDeferTableRender()){
    const activePre = getActivePreMinutesEdit();
    if(activePre && state?.tables?.[activePre.index]){
      state.tables[activePre.index].preMinutes = activePre.normalized;
    }
    pendingRenderAfterInput = true;
    console.log(`${source}状态已暂存，等待当前操作结束`);
    return;
  }

  const normalizedIncoming = normalizeAppState(
    structuredClone(incoming)
  );
  const isImmediateLocalState =
    String(source).startsWith("本机页面同步") &&
    !String(source).includes("sync_batch_complete");
  const normalized = isImmediateLocalState
    ? normalizedIncoming
    : preserveProtectedTables(normalizedIncoming);
  const incomingKey = JSON.stringify({
    tables:(normalized.tables || []).map(withoutSyncMeta),
    packages:normalized.packages || [],
    bookings:(normalized.bookings || []).map(withoutSyncMeta),
    groups:(normalized.groups || []).map(withoutSyncMeta)
  });

  if(incomingKey === lastAppliedAppStateKey){
    // 只更新同步版本，不重建桌位 DOM。当前展开位置、输入焦点和下拉框保持不动。
    state = normalized;
    return;
  }

  state = normalized;
  lastAppliedAppStateKey = incomingKey;

  try{
    render();

    /*
     * 不阻塞状态接收和页面刷新。
     */
    Promise.resolve()
      .then(()=>autoCloseOldTables())
      .catch(error=>{
        console.warn(
          "自动检查跨天桌位失败",
          error
        );
      });

    console.log(
      `${source}状态已应用`
    );

  }catch(error){
    console.warn(
      `${source}后刷新计时器失败`,
      error
    );
  }
}

onSnapshot(
  ref,
  {includeMetadataChanges:true},
  async snap=>{
    if(snap.exists()){
      const incoming =
        await reconcileCloudState(
          snap.data()
        );

      /*
       * 这里传原始云端数据，
       * 不要传本机合并后的 state。
       */
      if(!snap.metadata.fromCache && !snap.metadata.hasPendingWrites){
        setStateBaseline(
          snap.data()
        );
      }

      if(snap.metadata.fromCache){
        setSyncStatus("cache");
      }

      applyIncomingAppState(
        incoming,
        snap.metadata.fromCache
          ? "Firestore缓存"
          : "Firestore云端"
      );

    }else{
      /*
       * 缓存尚未加载完成时，onSnapshot 可能暂时报告文档不存在。
       * 这里绝不能把空状态上传，否则实体同步会把全部预约当作删除。
       * 保留本机副本并等待后续云端快照；真正缺失的主文档也必须人工恢复。
       */
      const local = await loadLocalState(defaultState);
      applyIncomingAppState(local,"本机安全副本");
      setSyncStatus(
        snap.metadata.fromCache ? "cache" : "error",
        snap.metadata.fromCache
          ? "● 云端缓存载入中 · 已保留本机数据"
          : "● 云端主数据缺失 · 已停止自动初始化"
      );
      if(!snap.metadata.fromCache){
        console.error("shop/main 不存在，已阻止空状态自动初始化");
      }
    }
  },
  error=>{
    console.error(
      "读取 shop/main 失败",
      error
    );

    alert(
      "桌位数据读取失败：\n\n" +
      (error.code || "") +
      "\n" +
      (error.message || String(error))
    );

    if(!state){
      applyIncomingAppState(
        structuredClone(defaultState),
        "默认数据"
      );
    }
  }
);


async function save(action="state_update"){
  return saveStateSafely({db, ref, getState:()=>state, action});
}


function getPackage(t){
  const idx = Number(t.packageIndex ?? 0);
  return state.packages[idx] || state.packages[0] || {
    name:"1小时",
    minutes:60,
    price:1500,
    extensionPrice:900,
    unlimited:false
  };
}

function isWeekendTable(t){
  let date = new Date(Number(t?.start || t?.paidAt || Date.now()));
  if(!Number.isFinite(date.getTime())) date = new Date();
  const weekday = new Intl.DateTimeFormat(
    "en-US",
    {timeZone:"Asia/Tokyo",weekday:"short"}
  ).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

function regularBaseMinutes(p){
  // 旧的“5500 不限时”套餐在周末按 6 小时起算，之后每小时 800 日元。
  if(p?.unlimited && Number(p?.price || 0) === 5500) return 360;
  return Number(p?.minutes || 0);
}

function regularTotalMinutes(t,p=getPackage(t)){
  return regularBaseMinutes(p) + Math.floor(Number(t?.extra || 0) / 60000);
}

function getLimitMs(t){
  const p = getPackage(t);
  if(p.customPricing){
    if(p.unlimited) return Infinity;
    return Number(p.minutes || 0) * 60 * 1000 + Number(t.extra || 0);
  }
  const totalMinutes = regularTotalMinutes(t,p);
  if(!isWeekendTable(t) && totalMinutes >= 360) return Infinity;
  return totalMinutes * 60 * 1000;
}

function getElapsedMs(t){
  if(!t.start) return 0;
  if(t.pausedAt) return t.pausedAt - t.start;
  return Date.now() - t.start;
}

function getRemainMs(t){
  if(!t.start) return Infinity;

  const limit = getLimitMs(t);
  if(limit === Infinity) return Infinity;

  return limit - getElapsedMs(t);
}

function calcPriceByTotalMinutes(totalMinutes,isWeekend=false){
  const hours = Math.ceil(totalMinutes / 60);

  if(hours <= 1) return 1500;
  if(hours === 2) return 2800;
  if(hours === 3) return 3300;
  if(hours === 4) return 4200;
  if(hours === 5) return 5100;
  if(hours === 6) return 5500;

  return isWeekend ? 5500 + (hours - 6) * 800 : 5500;
}

function getOriginalJPY(t){
  const p = getPackage(t);

  if(p.customPricing && p.unlimited){
    return Number(p.price || 0);
  }

  const extraHours = Math.floor(Number(t.extra || 0) / 3600000);

  // 老板模式新增的独立金额套餐，按套餐金额＋每小时续时金额计算。
  if(p.customPricing){
    return Number(p.price || 0) + extraHours * Number(p.extensionPrice || 0);
  }

  return calcPriceByTotalMinutes(
    regularTotalMinutes(t,p),
    isWeekendTable(t)
  );
}

function canExtendPackage(t){
  const p = getPackage(t);
  if(p.customPricing) return !p.unlimited;
  return isWeekendTable(t) || regularTotalMinutes(t,p) < 360;
}

function getCheckoutAdjustment(t){
  const currentPackage = getPackage(t);
  const initialPrice = t.startedPackagePrice !== null &&
    Number.isFinite(Number(t.startedPackagePrice))
    ? Number(t.startedPackagePrice)
    : Number(t.paidJPY || 0);
  const packageChanged =
    (
      Boolean(t.startedPackageName) &&
      (
      t.startedPackageName !== currentPackage.name ||
      initialPrice !== Number(currentPackage.price || 0)
      )
    ) ||
    (
      !t.startedPackageName &&
      t.payTiming === "prepaid" &&
      Boolean(t.paidAt) &&
      Number(t.extra || 0) === 0 &&
      Number(t.paidJPY || 0) !== Number(currentPackage.price || 0)
    );
  const extended = Number(t.extra || 0) > 0;

  if(packageChanged && extended){
    return {
      label:"本次套餐变更及续费补收",
      paymentLabel:"套餐变更及续费补收付款方式",
      reason:"套餐变更及续费补收",
      note:"按结账时最终套餐及续费时长结清"
    };
  }
  if(packageChanged){
    return {
      label:"本次套餐变更补收",
      paymentLabel:"套餐变更补收付款方式",
      reason:"套餐变更补收",
      note:"按结账时最终选择的套餐结清差额"
    };
  }
  if(extended){
    return {
      label:"本次续费补收",
      paymentLabel:"续费补收付款方式",
      reason:"续时补收",
      note:"离店时结清续时费用"
    };
  }
  return {
    label:"本次待补收",
    paymentLabel:"待补收付款方式",
    reason:"结账补收",
    note:"按结账时最终选择的套餐结清"
  };
}

function roundJPY(jpy){
  jpy = Number(jpy || 0);

  if(jpy < 0){
    return -roundJPY(Math.abs(jpy));
  }

  const base = Math.floor(jpy / 1000) * 1000;
  const rest = jpy - base;

  if(rest <= 500){
    return base;
  }

  return base + 500;
}

function getRMB(jpy){
  return jpyToRmb(jpy);
}

function ensureVisitAndRecordId(t){
  if(!t.visitId){
    t.visitId = `visit_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
  }
  if(!t.recordId){
    t.recordId = `rec_${String(t.visitId).replace(/[^a-zA-Z0-9_-]/g,"_")}`;
  }
  return t.recordId;
}

function makePaymentLine({type="收入", reason="", pay="", amountJPY=0, note=""}){
  return {
    id:`pay_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    operationId:`op_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type,
    reason,
    pay: pay || "未记录",
    currency: currencyForPaymentMethod(pay),
    amountJPY: Number(amountJPY || 0),
    amountRMB: currencyForPaymentMethod(pay) === "人民币" ? getRMB(Number(amountJPY || 0)) : 0,
    note,
    time: new Date().toLocaleString(),
    timestamp: Date.now()
  };
}

function normalizePayments(record){
  if(Array.isArray(record.payments)) return repairRecordPaymentAmounts(record).record.payments;

  if(Number(record.totalJPY || 0) !== 0){
    return [{
      type:"收入",
      reason:record.checkoutMethod || "历史记录",
      pay:record.pay || "未记录",
      amountJPY:Number(record.totalJPY || 0),
      amountRMB:Number(record.totalRMB || 0),
      note:"旧数据自动兼容",
      time:record.time || "",
      timestamp:record.timestamp || Date.now()
    }];
  }

  return [];
}

function consolidatePayment(record, {amountJPY, pay, reason="桌位消费", note=""} = {}){
  const oldPayments = normalizePayments(record);
  const receiptSource = oldPayments.find(p=>p?.receiptImage) || null;
  const first = oldPayments[0] || {};
  const amount = Number(amountJPY ?? sumPaymentsJPY(oldPayments) ?? 0);
  const line = {
    ...first,
    type: amount < 0 ? "退款" : "收入",
    reason,
    pay: pay || first.pay || record.pay || "未记录",
    amountJPY: amount,
    amountRMB: currencyForPaymentMethod(pay || first.pay || record.pay) === "人民币" ? getRMB(amount) : 0,
    note: note || first.note || "",
    time: first.time || new Date().toLocaleString(),
    timestamp: first.timestamp || Date.now(),
    updatedAt: Date.now()
  };
  if(receiptSource){
    line.receiptImage = receiptSource.receiptImage;
    line.receiptFileName = receiptSource.receiptFileName || "";
    line.receiptUploadedAt = receiptSource.receiptUploadedAt || null;
    line.receiptUploadedTime = receiptSource.receiptUploadedTime || "";
  }
  record.payments = amount === 0 ? [] : [line];
  return record.payments;
}

function sumPaymentsJPY(payments){
  return payments.reduce((sum,p)=>sum + Number(p.amountJPY || 0),0);
}

function sumPaymentsRMB(payments){
  return payments.reduce((sum,p)=>sum + Number(p.amountRMB || 0),0);
}

// 在同一张账单内记录套餐预付款与离店补收。不会创建第二张收入记录。
function settleRecordToFinalAmount(record,{finalAmountJPY,pay,reason="续时补收",note=""}={}){
  record.payments = normalizePayments(record);
  const current = sumPaymentsJPY(record.payments);
  const target = Number(finalAmountJPY || 0);
  const diff = target - current;
  // 结账只允许补收，不再根据负差额自动生成退款。
  // 退款必须通过独立的“退款”按钮人工录入。
  if(diff > 0){
    record.payments.push(makePaymentLine({
      type: "收入",
      reason,
      pay: pay || record.pay || "未记录",
      amountJPY: diff,
      note
    }));
  }
  // 差额为 0 或小于 0 时只结束桌位，不修改历史付款，也不自动退款。
  return record.payments;
}

function getPaymentSummary(payments){
  const pays = [...new Set(
    payments
      .filter(p=>Number(p.amountJPY || 0) !== 0)
      .map(p=>p.pay || "未记录")
  )];

  if(pays.length === 0) return "未记录";
  if(pays.length === 1) return pays[0];
  return "混合";
}

function getCurrencySummary(payments){
  const currencies = [...new Set(
    payments
      .filter(p=>Number(p.amountJPY || 0) !== 0)
      .map(p=>p.currency || currencyForPaymentMethod(p.pay))
      .filter(Boolean)
  )];
  if(currencies.length === 0) return "未记录";
  if(currencies.length === 1) return currencies[0];
  return "混合";
}

function getDueJPY(t){
  return Math.max(0, getOriginalJPY(t) - Number(t.paidJPY || 0));
}

async function getTableRecord(t){
  if(!t.recordId) return null;

  const local = await getLocalRecord(t.recordId);
  if(local) return local;

  if(!navigator.onLine) return null;
  try{
    const snap = await getDoc(doc(db, "records", t.recordId));
    return snap.exists() ? {id:snap.id,...snap.data()} : null;
  }catch(err){
    console.warn("读取云端账单失败，继续使用本机数据", err);
    return null;
  }
}

function getBookingIndexes(booking){
  return (Array.isArray(booking?.tableIndexes) ? booking.tableIndexes : [booking?.tableIndex])
    .filter(v=>v !== undefined && v !== null && v !== "")
    .map(Number)
    .filter(Number.isFinite);
}

function markBookingTableStarted(booking, tableIndex, startedAt){
  if(!booking) return;
  const index = Number(tableIndex);
  booking.checkedIn = true;
  booking.completed = false;
  booking.checkedOut = false;
  booking.checkInTime = booking.checkInTime || startedAt;
  booking.checkInTimeText = booking.checkInTimeText || new Date(startedAt).toLocaleString();
  booking.checkedInTableIndexes = Array.from(new Set([
    ...(Array.isArray(booking.checkedInTableIndexes) ? booking.checkedInTableIndexes : []).map(Number),
    index
  ])).filter(Number.isFinite);
  if(Array.isArray(booking.finishedTableIndexes)){
    booking.finishedTableIndexes = booking.finishedTableIndexes.map(Number).filter(i=>i !== index);
  }
  booking.updatedAt = Date.now();
}

function markBookingTableFinished(booking, tableIndex, finishedAt=Date.now()){
  if(!booking) return;
  const index = Number(tableIndex);
  booking.finishedTableIndexes = Array.from(new Set([
    ...(Array.isArray(booking.finishedTableIndexes) ? booking.finishedTableIndexes : []).map(Number),
    index
  ])).filter(Number.isFinite);
  booking.checkedInTableIndexes = (Array.isArray(booking.checkedInTableIndexes) ? booking.checkedInTableIndexes : [])
    .map(Number)
    .filter(i=>i !== index);

  const indexes = getBookingIndexes(booking);
  const finished = new Set(booking.finishedTableIndexes);
  const allFinished = indexes.length > 0 && indexes.every(i=>finished.has(i));
  if(allFinished){
    booking.checkedIn = false;
    booking.completed = true;
    booking.checkedOut = true;
    booking.checkOutTime = finishedAt;
    booking.checkOutTimeText = new Date(finishedAt).toLocaleString();
  }else{
    booking.checkedIn = booking.checkedInTableIndexes.length > 0;
  }
  booking.updatedAt = Date.now();
}

function makeCustomerKey(name, phoneLast4){
  const n = String(name || "").trim();
  const p = String(phoneLast4 || "").trim();

  if(!n || !p) return "";

  return `${n}_${p}`;
}

function getDateText(ts){
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getVisitRangeText(t){
  const start = t.start ? new Date(t.start) : new Date();
  const now = new Date();

  const s = `${String(start.getHours()).padStart(2,"0")}:${String(start.getMinutes()).padStart(2,"0")}`;
  const e = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  return `${s}-${e}`;
}

function createOrUpdateCustomerVisit(t){
  const key = makeCustomerKey(t.customer?.name, t.customer?.phoneLast4);

  if(!key) return null;

  if(!state.customers) state.customers = {};

  if(!state.customers[key]){
    state.customers[key] = {
      key,
      name:t.customer?.name || "",
      phoneLast4:t.customer?.phoneLast4 || "",
      visitCount:0,
      firstVisitAt:Date.now(),
      lastVisitAt:Date.now(),
      visits:[]
    };
  }

  const customer = state.customers[key];

  t.customerKey = key;

  let visit = null;

  if(t.visitId){
    visit = customer.visits.find(v=>v.id === t.visitId);
  }

  if(!visit){
    const id = "visit_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);

    t.visitId = id;

    visit = {
      id,
      date:getDateText(t.start || Date.now()),
      startAt:t.start || Date.now(),
      endAt:null,
      range:"",
      tableName:t.name,
      customerType:t.type || "walkin",
      packageName:"",
      packageMinutes:"",
      extraMinutes:0,
      totalJPY:0,
      pay:"",
      closed:false
    };

    customer.visits.push(visit);
    customer.visitCount = customer.visits.length;
  }

  const p = getPackage(t);

  visit.date = getDateText(t.start || Date.now());
  visit.range = getVisitRangeText(t);
  visit.tableName = t.name;
  visit.customerType = t.type || "walkin";
  visit.packageName = p.name;
  visit.packageMinutes = p.unlimited ? "不限时" : p.minutes;
  visit.extraMinutes = Math.floor(Number(t.extra || 0) / 60000);
  visit.totalJPY = getOriginalJPY(t);
  visit.pay = t.pay || "";
  visit.lastUpdatedAt = Date.now();

  customer.name = t.customer?.name || customer.name;
  customer.phoneLast4 = t.customer?.phoneLast4 || customer.phoneLast4;
  customer.lastVisitAt = Date.now();
  customer.visitCount = customer.visits.length;

  return visit;
}

const tableRecordUpdateQueues = new Map();

function createOrUpdateRecord(t,options = {}){
  const key = String(t?.recordId || t?.visitId || t?.name || "unknown");
  const previous = tableRecordUpdateQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(()=>{})
    .then(()=>performCreateOrUpdateRecord(t,options))
    .finally(()=>{
      if(tableRecordUpdateQueues.get(key) === next){
        tableRecordUpdateQueues.delete(key);
      }
    });
  tableRecordUpdateQueues.set(key,next);
  return next;
}

async function performCreateOrUpdateRecord(t, options = {}){

  const p = getPackage(t);
const originalJPY = getOriginalJPY(t);

let paidJPY = Number(t.paidJPY || 0);

const dueJPY = Math.max(0, originalJPY - paidJPY);

  // 优先使用同步本机影子，避免 iPad 的 IndexedDB/网络卡住时，
  // “开始计时”不能立刻生成账单。
  let record = getLocalRecordSync(t.recordId);
  if(!record && t.recordId){
    try{
      record = await Promise.race([
        getTableRecord(t),
        new Promise(resolve=>setTimeout(()=>resolve(null),1200))
      ]);
    }catch(_err){
      record = null;
    }
  }

  let isNewRecord = false;

  if(!record){
    isNewRecord = true;
    // recordId 一旦分配就必须复用。即使本机账单缓存暂时未读到，
    // 也不能再生成第二个 ID，否则同一桌会出现两张账单。
    const id = ensureVisitAndRecordId(t);
    t.recordId = id;


    const now = Date.now();

record = {
  id,
  timestamp: now,
  businessDate: getBusinessDateKey(now),

  time: new Date(now).toLocaleString(),

  tableName: t.name,

  receiptImage:"",
  receiptFileName:"",
};
  }

  // 入座开始即生成正式账单；结账时只更新同一个 recordId。
  record.startAt = Number(t.start || record.startAt || Date.now());
  if(options.syncStartTime){
    record.timestamp = record.startAt;
    record.startedTime = new Date(record.startAt).toLocaleString();
    record.time = record.startedTime;
    record.businessDate = getBusinessDateKey(record.startAt);
  }else{
    record.startedTime = record.startedTime || new Date(record.startAt).toLocaleString();
  }
  record.closed = false;
  record.status = "进行中";

  record.businessDate =
    record.businessDate ||
    getBusinessDateKey(record.startAt || record.timestamp || Date.now());
  record.tableName = t.name;
  record.groupId = t.groupId || record.groupId || "";
record.groupName = t.groupName || record.groupName || "";
record.groupColor = t.groupColor || t.activeColor || record.groupColor || "";
  record.customerName = t.customer?.name || "";
  record.phoneLast4 = t.customer?.phoneLast4 || "";
  record.customerType = t.type || "walkin";

  record.packageName = p.name;
  record.packageMinutes = p.unlimited ? "不限时" : p.minutes;
  record.packagePrice = p.price;

  record.extraMinutes = Math.floor(Number(t.extra || 0) / 60000);
  record.extensionAmount = Math.max(0, originalJPY - Number(p.price || 0));

  record.originalJPY = originalJPY;


  record.payments = normalizePayments(record);

// 先付款只在入店时收套餐费。续时只提高应收额，离店时再补收；始终沿用同一 recordId。
if(t.payTiming === "prepaid"){
  const prepaidAmount = Number(t.paidJPY || 0);
  if(record.payments.length === 0 && prepaidAmount > 0){
    record.payments = [makePaymentLine({
      reason:"套餐预付款",
      pay:t.pay || record.pay || "未记录",
      amountJPY:prepaidAmount,
      note:"入店时收取"
    })];
  }
}
// 运行中修改付款方式只更新桌位上的“下一笔付款方式”。
// 已完成的 payments[] 属于不可变历史，不在这里回写或覆盖。

const paymentsTotalJPY = sumPaymentsJPY(record.payments);

record.paidJPY = paymentsTotalJPY;
record.dueJPY = Math.max(0, originalJPY - paymentsTotalJPY);

record.totalJPY = paymentsTotalJPY;
record.totalRMB = sumPaymentsRMB(record.payments);

record.pay = getPaymentSummary(record.payments);




  record.currency = getCurrencySummary(record.payments);
  record.payTiming = t.payTiming || "prepaid";
  record.paidStatus = Number(record.dueJPY || 0) > 0 ? "未结清" : "已结清";
  record.recordType = t.payTiming === "postpaid" ? "postpaid" : "prepaid";
  record.checkoutMethod = t.payTiming === "postpaid" ? "后付款" : "先付款";
  record.roundRule = record.roundRule || "不抹零";

  const visit = createOrUpdateCustomerVisit(t);

if(visit){
  record.customerKey = t.customerKey;
  record.visitId = t.visitId;
  record.visitDate = visit.date;
  record.visitRange = visit.range;
}

// 同步写入本机影子，今日账单会立即出现；IndexedDB 与 Firestore 后台同步。
emergencySaveRecord({
  db,
  ref,
  record,
  quietSync:Boolean(options.quietSync),
  prioritySync:Boolean(options.prioritySync)
});
  return record;
}

async function updateRecordOnly(record){
  await saveRecordSafely({db, ref, record});
}

function getStatus(t){
  if(!t.start) return "idle";

  const p = getPackage(t);
  if(p.unlimited) return "using";

  const remain = getLimitMs(t) - getElapsedMs(t);

  if(remain <= 0) return "overtime";
  if(remain <= 10 * 60 * 1000) return "warning";

  return "using";
}

function render(){
  try{

  if(!state) return;
  const box = document.getElementById("tables");
  box.innerHTML = "";

const filteredTables = state.tables
  .map((t,i)=>({t,i}))
  .filter(({t})=>{
    const status = getStatus(t);

    const keyword = searchKeyword.trim().toLowerCase();
    const text = [
      t.name,
      t.customer?.name,
      t.customer?.phoneLast4,
      t.type,
      t.pay
    ].join(" ").toLowerCase();

    if(keyword && !text.includes(keyword)) return false;
    if(statusFilter && statusFilter !== "all" && status !== statusFilter) return false;
    if(typeFilter && typeFilter !== "all" && t.type !== typeFilter) return false;
    if(payFilter && payFilter !== "all" && t.pay !== payFilter) return false;
    return true;
      })


.sort((a,b)=>{
  const sortMode = document.getElementById("sortMode")?.value || "table";

  let va = a.i;
  let vb = b.i;

  if(sortMode === "remain"){
    va = getLimitMs(a.t) - getElapsedMs(a.t);
    vb = getLimitMs(b.t) - getElapsedMs(b.t);
  }

  if(sortMode === "used"){
    va = getElapsedMs(a.t);
    vb = getElapsedMs(b.t);
  }

  if(sortMode === "amount"){
    va = getOriginalJPY(a.t);
    vb = getOriginalJPY(b.t);
  }

  if(groupViewMode){
    const ga = String(a.t.groupId || "~~~~未分组");
    const gb = String(b.t.groupId || "~~~~未分组");
    if(ga !== gb) return ga.localeCompare(gb,"zh-CN");
  }
  return sortDirection === "desc" ? vb - va : va - vb;
});
  


let lastRenderedGroupId = null;
filteredTables.forEach(({t,i})=>{
    if(groupViewMode){
      const currentGroupId = String(t.groupId || "");
      if(currentGroupId !== lastRenderedGroupId){
        const group = getGroup(state,currentGroupId);
        const header = document.createElement("div");
        header.className = "group-section-header";
        header.innerHTML = currentGroupId
          ? `<div><b>👥 ${group?.name || t.groupName || "未命名组"}</b><span>${currentGroupId}</span></div><button class="btn-ghost" onclick="openGroupManager('${currentGroupId.replaceAll("'","\'")}')">管理组</button>`
          : `<div><b>未分组桌位</b><span>可选择后创建新组</span></div><button class="btn-main" onclick="openGroupManager('')">创建组</button>`;
        box.appendChild(header);
        lastRenderedGroupId = currentGroupId;
      }
    }
    const p = getPackage(t);
    const elapsed = getElapsedMs(t);
    const remain = getLimitMs(t) - elapsed;
    const status = getStatus(t);
    const overtime = status === "overtime";

    if(overtime){
      if(!t.alerting){
        t.alerting = true;
        startAlertLoop(i);
        notifyLocal("桌位已超时", t.name + " 已超时，请及时处理");
        save();
      }
    }else{
      if(t.alerting){
        t.alerting = false;
        stopAlertLoop(i);
        save();
      }
    }

    if(status === "warning" && !remindLocks[i]){
      remindLocks[i] = true;
      setTimeout(()=>{ remindLocks[i] = false; },60000);
      notifyLocal("续费提醒", t.name + " 剩余10分钟，建议提醒续费");
    }

    const usedText = t.start ? "已用 " + formatTime(elapsed) : "";
    const timeText = !t.start
      ? "未开始"
      : t.pausedAt
        ? "暂停中 " + formatTime(elapsed)
        : p.unlimited
          ? "已使用 " + formatTime(elapsed)
          : overtime
            ? "超时 " + formatTime(Math.abs(remain))
            : "剩余 " + formatTime(remain);

    const originalJPY = getOriginalJPY(t);
    const roundedJPY = roundJPY(originalJPY);
    const paidJPY = Number(t.paidJPY || 0);
    const dueJPY = getDueJPY(t);
    const preValue = editingPreMinutesIndex === i && preMinutesDrafts[i] !== undefined
      ? preMinutesDrafts[i]
      : Math.max(0,Math.floor(Number(t.preMinutes || 0)));
    const isExpanded = expandedTableCards.has(i);
    const arrivalValue = t.arrivalTimeDraft || (t.start ? formatClockTime(t.start) : "");
    const groupLabel = t.groupId
      ? `${t.groupName || "编组"} · ${t.groupId}`
      : "未编组";

    const div = document.createElement("div");
    div.id = `table-card-${i + 1}`;
    const extensionLayers = Math.min(5,Math.max(0,Math.floor(Number(t.extra || 0) / 3600000)));
    div.className = `card compact-table-card ${status} ${extensionLayers ? `extension-layers-${extensionLayers}` : ""} ${isExpanded ? "expanded" : "collapsed"}`;

    div.innerHTML = `
      <button class="table-card-summary" type="button" onclick="toggleTableCard(${i})" aria-expanded="${isExpanded}">
        <span class="table-card-summary-main">
          <strong>${t.name}</strong>
          <b data-summary-timer="${i}">${timeText}</b>
          <small>${groupLabel}</small>
        </span>
        <span class="table-card-chevron">${isExpanded ? "收起 ▲" : "展开 ▼"}</span>
      </button>

      <div class="table-card-details">
    <select onpointerdown="beginTableInteraction()" onfocus="beginTableInteraction()" onchange="setPackage(${i},this.value);finishTableInteractionSoon()">
  ${state.packages.map((pkg,idx)=>`
    <option value="${idx}" ${idx===t.packageIndex ? "selected" : ""}>
      ${pkg.name} | ${pkg.unlimited ? "不限时" : pkg.minutes + "分钟"} | ¥${pkg.price}
    </option>
  `).join("")}
</select>


${t.start ? `
  <div data-used-timer="${i}" style="font-size:18px;font-weight:800;margin:-4px 0 10px;color:#8a8174;">
    ${usedText}
  </div>
` : ""}
      <div class="info">
        类型：${t.type || "-"}<br>
        客人：${t.customer.name || "-"} ${t.customer.phoneLast4 || ""}<br>
        收款模式：${t.payTiming === "postpaid" ? "后付款" : "先付款"}<br>
        已收金额：¥${paidJPY.toLocaleString()}<br>
        当前应收：¥${originalJPY.toLocaleString()}<br>
        需收/补收：¥${dueJPY.toLocaleString()}<br>
        人民币参考：¥${getRMB(dueJPY).toLocaleString()}<br>
        抹零参考：¥${roundJPY(dueJPY).toLocaleString()}<br>
      </div>

      <div class="row">
        <input placeholder="姓名" id="name-${i}" value="${t.customer.name || ""}" onchange="updateCustomer(${i})">
        <input placeholder="手机后4位" id="phone-${i}" value="${t.customer.phoneLast4 || ""}" onchange="updateCustomer(${i})">
      </div>

<div class="action-row">
<button id="type-walkin-${i}" class="btn-ghost" style="${t.type==="walkin" ? "background:#f2c94c;color:#332d24;border-color:#d8a900;" : ""}" onclick="toggleType(${i},'walkin')">Walk-in</button>
<button id="type-booking-${i}" class="btn-ghost" style="${t.type==="booking" ? "background:#f2c94c;color:#332d24;border-color:#d8a900;" : ""}" onclick="toggleType(${i},'booking')">预约</button>
</div>

<label style="display:block;margin:10px 0 8px;font-weight:700;color:#6f6659;">
  <span style="display:block;margin-bottom:6px;">客人到店时间</span>
  <input type="time" id="arrival-${i}" value="${arrivalValue}" onfocus="beginTableInteraction()" oninput="setArrivalTimeDraft(${i},this.value)" onchange="setArrivalTimeDraft(${i},this.value)" aria-label="客人到店时间">
  <small style="display:block;margin:3px 0 10px;color:#8a8174;font-weight:600;">填写后优先按这个时间开始计算；留空则使用下面的提前分钟数。</small>
  <span style="display:block;margin-bottom:6px;">提前多少分钟</span>
  <input type="number" inputmode="numeric" min="0" max="1440" step="1" placeholder="输入提前分钟数" id="pre-${i}" value="${preValue}" onfocus="beginPreMinutesEdit(${i},this)" oninput="updatePreMinutes(${i},this.value)" onblur="commitPreMinutesEdit(${i},this.value)">
</label>

<div class="action-row" style="grid-template-columns:1fr auto;align-items:stretch;">
  <button class="btn-main"
    style="${t.startLocked ? "background:#c9c6bf;color:#777;border-color:#b8b4ad;box-shadow:none;" : "background:#f2c94c;color:#332d24;border-color:#d8a900;"}"
    onclick="start(${i})"
    ${t.startLocked ? "disabled" : ""}>
    ${t.start ? "重新记录开始" : "开始"}
  </button>
  <button class="btn-ghost" style="min-width:64px;font-size:20px;" onclick="toggleStartLock(${i})" title="开始按钮锁">
    ${t.startLocked ? "🔒" : "🔓"}
  </button>
</div>

<div class="action-row">
  <button class="btn-ghost" style="${t.lastAction==="pause" ? "background:#f2c94c;color:#332d24;border-color:#d8a900;" : ""}" onclick="pause(${i})" ${!t.start || t.pausedAt ? "disabled" : ""}>暂停</button>
  <button class="btn-ghost" style="${t.lastAction==="resume" ? "background:#f2c94c;color:#332d24;border-color:#d8a900;" : ""}" onclick="resume(${i})" ${!t.pausedAt ? "disabled" : ""}>继续</button>
</div>

      ${canExtendPackage(t) ? `
        <div class="action-row">
          <button class="${status==="warning" ? "btn-warn" : "btn-main"}" onclick="addHour(${i})">
            +1小时 → ¥${getOriginalJPY({
              ...t,
              extra:Number(t.extra || 0) + 3600000
            }).toLocaleString()}
          </button>
          <button class="btn-ghost" onclick="undoHour(${i})" ${Number(t.extra || 0) < 3600000 ? "disabled" : ""}>
            撤回1小时
          </button>
        </div>
      ` : ""}
      
      <select id="pay-timing-${i}" onpointerdown="beginTableInteraction(${i})" onfocus="beginTableInteraction(${i})" onchange="setPayTiming(${i},this.value);finishTableInteractionSoon()" ${t.start ? "disabled" : ""}>
       <option value="prepaid" ${t.payTiming==="prepaid"?"selected":""}>先付款</option>
       <option value="postpaid" ${t.payTiming==="postpaid"?"selected":""}>后付款</option>
      </select>
      <select id="pay-method-${i}" onpointerdown="beginTableInteraction(${i})" onfocus="beginTableInteraction(${i})" onchange="setPay(${i},this.value);finishTableInteractionSoon()">
        <option value="">付款方式</option>
        <option value="现金" ${t.pay==="现金"?"selected":""}>现金</option>
        <option value="PayPay" ${t.pay==="PayPay"?"selected":""}>PayPay</option>
        <option value="微信" ${t.pay==="微信"?"selected":""}>微信</option>
        <option value="支付宝" ${t.pay==="支付宝"?"selected":""}>支付宝</option>
      </select>

      <select id="currency-${i}" onpointerdown="beginTableInteraction(${i})" onfocus="beginTableInteraction(${i})" onchange="setCurrency(${i},this.value);finishTableInteractionSoon()">
        <option value="日元" ${t.currency==="日元"?"selected":""}>日元</option>
        <option value="人民币" ${t.currency==="人民币"?"selected":""}>人民币</option>
      </select>

        ${t.start ? `
  <button class="btn-ghost full" onclick="moveRunningTable(${i})">
    移动桌位
  </button>
` : ""}

<button class="btn-success full" onclick="openCheckout(${i})">结账</button>
${t.start ? `
<button class="btn-danger full" onclick="openRefund(${i})">退款</button>
<button class="btn-danger full" onclick="openForceEnd(${i})">
  强制结束桌位
</button>
` : ""}

      </div>
    `;

    box.appendChild(div);
    if(i === requestedTableIndex && !requestedTableFocused){
      requestedTableFocused = true;
      requestAnimationFrame(()=>{
        div.scrollIntoView({behavior:"smooth",block:"start",inline:"nearest"});
      });
    }
    generateQR(i);
  });

  renderAlarmPanel();

  }catch(e){
    alert(
      "render错误:\n" +
      e.message +
      "\n行号:" +
      (e.lineNumber || "")
    );
    console.error(e);
  }

}

async function initPush(){
  if (!("Notification" in window)) {
    alert("当前浏览器不支持系统通知");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    localStorage.setItem("chiptuneNotifyEnabled", "1");
    updateNotifyButton();
    notifyLocal("系统通知已开启", "桌位剩余10分钟或超时时会发送静默通知");
  } else {
    localStorage.removeItem("chiptuneNotifyEnabled");
    updateNotifyButton();
    alert("系统通知没有开启，请在 iPad 设置中允许此网页的通知");
  }
}

function updateNotifyButton(){
  const btn = document.getElementById("notifyBtn");
  if(!btn) return;
  const enabled = localStorage.getItem("chiptuneNotifyEnabled") === "1" && Notification.permission === "granted";
  btn.textContent = enabled ? "系统通知：已开启" : "开启系统通知";
}

function notifyLocal(title, body){
  if (!("Notification" in window)) return;
  if (localStorage.getItem("chiptuneNotifyEnabled") !== "1") return;
  if (Notification.permission !== "granted") return;

  try{
    new Notification(title, {
      body,
      icon:"./icon-192.png",
      badge:"./icon-192.png",
      silent:true,
      tag:"chiptune-" + title + "-" + body
    });
  }catch(err){
    console.warn("系统通知发送失败", err);
  }
}

async function setPackage(i,v){
  const t = state.tables[i];
  const nextIndex = Number(v);
  if(nextIndex === Number(t.packageIndex || 0)) return;
  protectLocalTable(i);

  // 直接重选套餐视为纠正原套餐：计时连续，先付款金额同步改为新套餐基础价。
  // 明确点击“加1小时”产生的 t.extra 不受影响，仍在结账时单独计算。
  t.packageIndex = nextIndex;
  if(t.customPackage) t.customPackage.enabled = false;
  const correctedPackage = getPackage(t);

  if(t.start && t.payTiming === "prepaid"){
    t.startedPackageName = correctedPackage.name;
    t.startedPackagePrice = Number(correctedPackage.price || 0);
    t.paidJPY = Number(correctedPackage.price || 0);
    t.paidRMB = getRMB(t.paidJPY);
    t.paidAt = Date.now();
  }

  render();
  emergencySaveState({db,ref,state,action:"correct_running_package"});

  if(t.start){
    const record = await createOrUpdateRecord(t);
    if(t.payTiming === "prepaid"){
      consolidatePayment(record,{
        amountJPY:Number(correctedPackage.price || 0),
        pay:t.pay || record.pay || "未记录",
        reason:"套餐预付款",
        note:"运行中重选套餐，按新套餐纠正"
      });
      record.packageName = correctedPackage.name;
      record.packageMinutes = correctedPackage.unlimited
        ? "不限时"
        : correctedPackage.minutes;
      record.packagePrice = Number(correctedPackage.price || 0);
      record.originalJPY = getOriginalJPY(t);
      record.paidJPY = sumPaymentsJPY(record.payments);
      record.totalJPY = record.paidJPY;
      record.totalRMB = sumPaymentsRMB(record.payments);
      record.dueJPY = Math.max(0, record.originalJPY - record.paidJPY);
      record.pay = getPaymentSummary(record.payments);
      record.currency = getCurrencySummary(record.payments);
      record.updatedAt = Date.now();
      emergencySaveRecord({db,ref,record});
    }
  }
}

function toggleType(i,type){
  const t = state.tables[i];
  protectLocalTable(i);

  if(t.type === type){
    t.type = "";
  }else{
    t.type = type;
  }

  const nameInput = document.getElementById("name-"+i);
  const phoneInput = document.getElementById("phone-"+i);

  if(nameInput) t.customer.name = nameInput.value;
  if(phoneInput) t.customer.phoneLast4 = phoneInput.value;

  refreshTypeButtons(i);
  save("change_customer_type");
}

function refreshTypeButtons(i){
  const type = state.tables[i]?.type || "";
  for(const value of ["walkin","booking"]){
    const button = document.getElementById(`type-${value}-${i}`);
    if(!button) continue;
    const active = type === value;
    button.style.background = active ? "#f2c94c" : "";
    button.style.color = active ? "#332d24" : "";
    button.style.borderColor = active ? "#d8a900" : "";
  }
}

function setWalkin(i){
  const t = state.tables[i];

  t.type = "walkin";

  t.customer.name =
    document.getElementById("name-"+i).value;

  t.customer.phoneLast4 =
    document.getElementById("phone-"+i).value;

  render();
  save();
}

function setBooking(i){
  const t = state.tables[i];

  t.type = "booking";

  t.customer.name =
    document.getElementById("name-"+i).value;

  t.customer.phoneLast4 =
    document.getElementById("phone-"+i).value;

  render();
  save();
}

function updateCustomer(i,persist=true){
  const t = state.tables[i];
  protectLocalTable(i);

  const nameInput = document.getElementById("name-"+i);
  const phoneInput = document.getElementById("phone-"+i);

  if(nameInput) t.customer.name = nameInput.value;
  if(phoneInput) t.customer.phoneLast4 = phoneInput.value;

  if(persist) save("update_customer");
}

function toggleStartLock(i){
  const t = state.tables[i];

  // 已经计时中的桌位允许显示解锁状态，但开始函数仍有 t.start 防重复保护。
  t.startLocked = !t.startLocked;
  t.lastAction = t.startLocked ? "lock" : "unlock";
  render();
  emergencySaveState({db,ref,state,action:t.startLocked ? "lock_start" : "unlock_start"});
}


function parseBookingDateTime(dateText,timeText){
  const date = String(dateText || "").trim();
  const time = String(timeText || "").trim();
  if(!date || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  const [y,m,d] = date.split("-").map(Number);
  const [hh,mm] = time.split(":").map(Number);
  if(!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return new Date(y,m-1,d,hh,mm,0,0).getTime();
}

function getPlannedTimerEndAt(table,startAt){
  const pkg = getPackage(table);
  if(!pkg?.unlimited){
    return startAt + Math.max(0,Number(pkg?.minutes || 0))*60000 + Math.max(0,Number(table?.extra || 0));
  }

  const startDate = new Date(startAt);
  const day = startDate.getDay();
  const isWeekend = day === 0 || day === 6;
  const hours = state.businessHours || {};
  const closeHour = Number(isWeekend ? (hours.weekendClose ?? 22) : (hours.weekdayClose ?? 22));
  const closeAt = new Date(startDate.getFullYear(),startDate.getMonth(),startDate.getDate(),closeHour,0,0,0).getTime();
  return closeAt > startAt ? closeAt : startAt;
}

function findTimerBookingConflict(tableIndex,startAt,endAt,excludeBookingId=null,sourceState=state){
  const bookings = Array.isArray(sourceState?.bookings) ? sourceState.bookings : [];
  return bookings
    .filter(b=>!b?.cancelled && !b?.checkedIn)
    .filter(b=>Number(b?.id) !== Number(excludeBookingId))
    .filter(b=>{
      const indexes = (Array.isArray(b?.tableIndexes) ? b.tableIndexes : [b?.tableIndex])
        .filter(v=>v !== undefined && v !== null && v !== "")
        .map(Number);
      return indexes.includes(Number(tableIndex));
    })
    .map(b=>({
      booking:b,
      startAt:parseBookingDateTime(b.date,b.startTime),
      endAt:parseBookingDateTime(b.date,b.endTime)
    }))
    .filter(x=>Number.isFinite(x.startAt) && Number.isFinite(x.endAt))
    .find(x=>startAt < x.endAt && endAt > x.startAt) || null;
}

function formatConflictMessage(table,conflict){
  const b = conflict?.booking || {};
  const who = [b.name,b.phone].filter(Boolean).join(" / ");
  return `${table?.name || "该桌"}无法开始：与预约 ${b.date || ""} ${b.startTime || "-"}-${b.endTime || "-"} 冲突${who ? `（${who}）` : ""}。请更换桌位、调整预约或选择不会重叠的套餐。`;
}


function normalizePreMinutes(value){
  const n = Number(value);
  if(!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1440,Math.floor(n));
}

function formatClockTime(timestamp){
  const date = new Date(Number(timestamp));
  if(!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
}

function setArrivalTimeDraft(i,value){
  const t = state?.tables?.[i];
  if(!t) return;
  beginTableInteraction(i);
  protectLocalTable(i);
  t.arrivalTimeDraft = String(value || "");
}

function getRequestedStartTime(i,t){
  const arrivalValue = String(
    document.getElementById("arrival-"+i)?.value ??
    t.arrivalTimeDraft ??
    ""
  ).trim();

  if(arrivalValue){
    const match = arrivalValue.match(/^(\d{1,2}):(\d{2})$/);
    if(!match) throw new Error("到店时间格式不正确，请重新选择时间");
    const now = new Date();
    const startTime = new Date(now);
    startTime.setHours(Number(match[1]),Number(match[2]),0,0);
    if(startTime.getTime() > now.getTime() + 60000){
      // 凌晨营业仍属于前一营业日：例如凌晨 01:00 输入 23:30，
      // 应理解为昨晚 23:30，而不是尚未到来的今晚。
      if(now.getHours() < 6 && Number(match[1]) >= 6){
        startTime.setDate(startTime.getDate() - 1);
      }else{
        throw new Error("到店时间不能晚于当前时间");
      }
    }
    t.arrivalTimeDraft = arrivalValue;
    t.preMinutes = Math.max(0,Math.floor((now.getTime() - startTime.getTime()) / 60000));
    return startTime.getTime();
  }

  const preInput = document.getElementById("pre-"+i)?.value;
  const pre = normalizePreMinutes(preInput ?? t.preMinutes);
  t.preMinutes = pre;
  t.arrivalTimeDraft = "";
  return Date.now() - pre * 60000;
}

function toggleTableCard(i){
  if(expandedTableCards.has(i)) expandedTableCards.delete(i);
  else expandedTableCards.add(i);
  render();
}

function isPreMinutesInput(el=document.activeElement){
  return Boolean(el?.id && /^pre-\d+$/.test(el.id));
}

function getPreMinutesIndexFromInput(el=document.activeElement){
  if(!isPreMinutesInput(el)) return null;
  const index = Number(String(el.id).replace("pre-",""));
  return Number.isFinite(index) ? index : null;
}

function getActivePreMinutesEdit(){
  const index = getPreMinutesIndexFromInput();
  if(index === null) return null;
  const raw = String(document.activeElement?.value ?? preMinutesDrafts[index] ?? "");
  return {index, raw, normalized:normalizePreMinutes(raw)};
}

function beginTableInteraction(i=null){
  tableInteractionHoldUntil = Date.now() + 4000;
  if(i !== null) protectLocalTable(i);
}

function finishTableInteractionSoon(){
  tableInteractionHoldUntil = Date.now() + 500;
  setTimeout(()=>{
    if(Date.now() < tableInteractionHoldUntil) return;
    if(pendingRenderAfterInput && !shouldDeferTableRender()){
      pendingRenderAfterInput = false;
      render();
    }
  },600);
}

function shouldDeferTableRender(){
  if(Date.now() < tableInteractionHoldUntil) return true;
  const active = document.activeElement;
  if(!active) return false;
  if(isPreMinutesInput(active)) return true;
  if(active.tagName === "SELECT"){
    // select 的 change 已经提交值；保护期结束后无需继续因焦点而阻塞同步。
    return false;
  }
  if(active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") return false;
  return /^name-\d+$/.test(active.id || "") ||
    /^phone-\d+$/.test(active.id || "") ||
    /^arrival-\d+$/.test(active.id || "");
}

function beginPreMinutesEdit(i,el){
  beginTableInteraction();
  editingPreMinutesIndex = i;
  preMinutesDrafts[i] = String(el?.value ?? "");
  try{ el?.select?.(); }catch{}
}

function commitPreMinutesEdit(i,value){
  const t = state?.tables?.[i];
  if(t) t.preMinutes = normalizePreMinutes(value);
  delete preMinutesDrafts[i];
  if(editingPreMinutesIndex === i) editingPreMinutesIndex = null;
  finishTableInteractionSoon();
}

function updatePreMinutes(i,value){
  beginTableInteraction(i);
  protectLocalTable(i);
  const t = state?.tables?.[i];
  if(!t) return;
  preMinutesDrafts[i] = String(value ?? "");
  t.preMinutes = normalizePreMinutes(value);
}

async function start(i){
  const t = state.tables[i];
  if(!t || t.startLocked) return;
  protectLocalTable(i,20000);

  // 已开始桌位：解锁后再次点击“开始”，只重新记录开始时间，
  // 不创建新账单、不重复收套餐费。
  if(t.start){
    let newStartTime;
    try{
      newStartTime = getRequestedStartTime(i,t);
    }catch(error){
      alert(error?.message || "到店时间不正确");
      return;
    }
    const plannedEndAt = getPlannedTimerEndAt(t,newStartTime);
    // 实际计时与预约排期完全分离：调整真实开始时间时不修改预约，
    // 即使预计结束时间与后续预约重叠，也允许保存。

    t.start = newStartTime;
    t.startLocked = true;
    t.lastAction = "start_time_adjusted";

    // 若正在暂停，暂停点保持为当前时刻，避免出现负的已用时间。
    if(t.pausedAt && Number(t.pausedAt) < newStartTime){
      t.pausedAt = Date.now();
    }

    render();
    setSyncStatus("pending","● 正在原子同步新的开始时间…");
    try{
      const result = await atomicAdjustStartTime({
        db, ref, tableIndex:i,
        tablePatch:JSON.parse(JSON.stringify(t)),
        recordId:t.recordId,
        recordPatch:{
          timestamp:newStartTime,
          startAt:newStartTime,
          startedTime:new Date(newStartTime).toLocaleString(),
          businessDate:getBusinessDateKey(newStartTime),
          time:new Date(newStartTime).toLocaleString(),
          tableName:t.name,
          updatedAt:Date.now(),
          localUpdatedAt:Date.now()
        }
      });
      state = JSON.parse(JSON.stringify(result.state));
      setSyncStatus("synced","● 开始时间与账单已同时更新");
    }catch(error){
      console.error("原子更新开始时间失败",error);
      setSyncStatus("error","● 开始时间更新失败，未修改云端数据");
      alert(error?.message || "开始时间更新失败，请确认网络后重试");
    }
    render();
    return;
  }

  // 跨设备安全优先：离线时不允许新开桌，避免两台离线设备生成两个账单。
  if(!navigator.onLine){
    alert("当前离线，无法安全开始计时。请恢复网络后再点击开始。");
    return;
  }

  const before = JSON.parse(JSON.stringify(t));
  t.startLocked = true;
  ensureVisitAndRecordId(t);
  let startTime;
  try{
    startTime = getRequestedStartTime(i,t);
  }catch(error){
    t.startLocked = false;
    alert(error?.message || "到店时间不正确");
    return;
  }
  const plannedEndAt = getPlannedTimerEndAt(t,startTime);
  // 点击开始始终以当前真实时间（或店员明确补录的时间）开始。
  // 后续预约只用于提示，不阻止开始，也不会被移动或覆盖。

  stopAlertLoop(i);
  t.start = startTime;
  t.pausedAt = null;
  t.alerted = false;
  t.alerting = false;
  t.lastAction = "start";

  const p = getPackage(t);
  t.startedPackageName = p.name;
  t.startedPackagePrice = Number(p.price || 0);
  t.payTiming = t.payTiming || "prepaid";
  if(t.payTiming === "prepaid"){
    t.paidJPY = Number(p.price || 0);
    t.paidRMB = getRMB(t.paidJPY);
    t.paidAt = Date.now();
  }else{
    t.paidJPY = 0;
    t.paidRMB = 0;
    t.paidAt = null;
  }

  const initialPayments = [];
  if(t.payTiming === "prepaid" && Number(t.paidJPY || 0) > 0){
    initialPayments.push(makePaymentLine({
      reason:"套餐预付款",
      pay:t.pay || "未记录",
      amountJPY:Number(t.paidJPY || 0),
      note:"入店时收取"
    }));
  }
  const initialRecord = {
    id:t.recordId,
    visitId:t.visitId,
    timestamp:startTime,
    startAt:startTime,
    startedTime:new Date(startTime).toLocaleString(),
    businessDate:getBusinessDateKey(startTime),
    time:new Date(startTime).toLocaleString(),
    tableName:t.name,
    customerName:t.customer?.name || "",
    phoneLast4:t.customer?.phoneLast4 || "",
    customerType:t.type || "walkin",
    packageName:p.name,
    packageMinutes:p.unlimited ? "不限时" : p.minutes,
    packagePrice:Number(p.price || 0),
    extraMinutes:0,
    extensionAmount:0,
    originalJPY:Number(p.price || 0),
    payments:initialPayments,
    paidJPY:sumPaymentsJPY(initialPayments),
    dueJPY:Math.max(0,Number(p.price || 0)-sumPaymentsJPY(initialPayments)),
    totalJPY:sumPaymentsJPY(initialPayments),
    totalRMB:initialPayments.reduce((sum,line)=>sum+Number(line.amountRMB || 0),0),
    pay:getPaymentSummary(initialPayments),
    currency:getCurrencySummary(initialPayments),
    payTiming:t.payTiming,
    paidStatus:t.payTiming === "prepaid" ? "已结清" : "未结清",
    status:"进行中",
    closed:false,
    receiptImage:"",
    receiptFileName:"",
    updatedAt:Date.now(),
    localUpdatedAt:Date.now()
  };

  render();
  setSyncStatus("pending","● 本桌已开始 · 正在后台确认云端");

  /*
   * 从这里开始只做云端确认与附加资料同步。界面已经先按本机状态开始计时，
   * 不再让按钮事件等待网络事务结束，因此店员可以立刻展开并开始另一桌。
   */
  void (async()=>{
  let serverStartCommitted = false;
  try{
    const result = await atomicStartTable({
      db,ref,tableIndex:i,
      tablePatch:JSON.parse(JSON.stringify(t)),
      record:initialRecord,
      timerStartAt:startTime,
      timerEndAt:plannedEndAt,
      excludeBookingId:t.bookingId || null
    });

    serverStartCommitted = Boolean(result?.startedByThisDevice);

    if(!result?.startedByThisDevice){
      if(result?.table){
        state.tables[i] = JSON.parse(JSON.stringify(result.table));
      }
      setSyncStatus("synced","● 该桌已由另一台设备开始，已同步最新状态");
      render();
      alert("这张桌已经由另一台设备开始，当前画面已同步。");
      return;
    }

    // 事务返回的服务器状态必须成为当前页面的新基线。
    // 不能继续拿开始前的旧整份 state 做后续保存，否则返回首页时可能被旧快照覆盖。
    const confirmedState = JSON.parse(JSON.stringify(result.state));
    const liveTables = Array.isArray(state?.tables)
      ? state.tables
      : [];
    /*
     * 只采用服务器确认的当前桌，保留页面上其他桌的即时操作。
     * 连续开始两桌时，第一桌较晚返回的网络结果不能把第二桌恢复成未开始。
     */
    confirmedState.tables = confirmedState.tables.map((serverTable,index)=>
      index === i
        ? serverTable
        : JSON.parse(JSON.stringify(liveTables[index] || serverTable))
    );
    state = confirmedState;

    // 服务器成功锁定后再建立组，避免双设备同时生成两组。
    const current = state.tables[i];
    if(current && !current.groupId){
      try{
        const groupId = await allocateGroupId(db,state.groups || []);
        const group = upsertGroup(state,{
          id:groupId,
          name:`${current.name}组`,
          color:current.activeColor || "#B7E4C7",
          tableIndexes:[i],
          peopleCount:1,
          paymentMode:"split"
        });
        syncGroupReferences(state,group);
      }catch(groupError){
        // 桌位和账单已经由服务器原子确认，不能因为辅助编组失败而撤销计时。
        // 保持未编组状态，店员之后可在“创建／重组”中安全补建。
        console.warn("桌位已开始，但云端组编号暂时无法分配",groupError);
        setSyncStatus("pending","● 桌位已安全开始 · 编组未建立，请稍后重试");
      }
    }

    // 预约签到仅由成功开始的一台设备执行。
    if(current?.type === "booking" && Array.isArray(state.bookings)){
      // 优先使用桌位保存的 bookingId 精确定位，避免姓名重复、旧 checkedIn 值
      // 或多桌预约导致签到状态没有写回。
      const booking = state.bookings.find(b=>Number(b.id) === Number(current.bookingId))
        || state.bookings.find(b=>getBookingIndexes(b).includes(i)
          && (!b.name || b.name === current.customer?.name));
      if(booking){
        markBookingTableStarted(booking,i,startTime);
      }
    }

    /*
     * atomicStartTable 已经在同一云端事务中提交了本桌和进行中账单。
     * 这里不能再等待整个历史队列，否则数百项旧账单会让一次单桌开始
     * 长时间停留在“同步中”。组资料、预约签到和账单附加字段先同步写入
     * 本机应急影子，再由后台队列补传；此刻即可安全切换页面。
     */
    emergencySaveState({
      db,
      ref,
      state,
      action:"start_table_post_transaction",
      quietSync:true,
      prioritySync:true
    });
    createOrUpdateRecord(state.tables[i],{quietSync:true,prioritySync:true}).catch(syncError=>{
      console.warn("开始后的账单附加信息将在后台继续同步",syncError);
    });
    setSyncStatus(
      result?.cloudPending ? "pending" : "synced",
      result?.cloudPending
        ? "● 本桌已保存在本机 · 云端等待重试"
        : "● 本桌与账单已同步 · 可切换页面"
    );
    render();

    // 仅提醒实际计时可能与后续预约重叠；不截断计时，也不改预约时间。
    const overlap = findTimerBookingConflict(i,startTime,plannedEndAt,current?.bookingId || null,state);
    if(overlap){
      const b = overlap.booking || {};
      const plannedEndText = new Date(plannedEndAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      alert(`已按真实时间开始计时。\n预计结束 ${plannedEndText}，与后续预约 ${b.startTime || "-"}-${b.endTime || "-"} 重叠。\n预约时间未被修改，请根据现场情况安排。`);
    }
  }catch(error){
    console.error("开始流程失败",error);
    if(!serverStartCommitted){
      state.tables[i] = before;
      render();
      setSyncStatus("error","● 开始失败，未产生账单");
      alert(error?.message || "开始失败，请确认网络后重试");
    }else{
      render();
      setSyncStatus("pending","● 桌位已在云端开始，本机保存失败，将自动重试");
      alert("桌位已经成功开始并产生账单，但本机缓存保存失败。请不要重复点击开始，系统会继续同步。");
    }
  }
  })();
  return;
}

function pause(i){
  const t = state.tables[i];
  protectLocalTable(i);
  t.lastAction = "pause";
  if(!t.start || t.pausedAt) return;

  stopAlertLoop(i);

  t.pausedAt = Date.now();
  t.alerting = false;
  t.lastAction = "pause";
  render();
  save("pause_table");
}

function resume(i){
  const t = state.tables[i];
  protectLocalTable(i);
  t.lastAction = "resume"; 
  if(!t.pausedAt) return;

  const pausedMs = Date.now() - t.pausedAt;
  t.start += pausedMs;
  t.pausedAt = null;
  t.alerted = false;
  t.alerting = false;
  t.lastAction = "resume";

  render();
  save("resume_table");
}

async function addHour(i){
  stopAlertLoop(i);
  protectLocalTable(i,20000);
  const table = state.tables[i];
  const beforeJPY = getOriginalJPY(table);
  table.extra = Number(table.extra || 0) + 60 * 60 * 1000;
  table.alerted = false;
  table.alerting = false;
  table.lastAction = "extend_one_hour";
  table.updatedAt = Date.now();
  const afterJPY = getOriginalJPY(table);
  const deltaJPY = Math.max(0,afterJPY - beforeJPY);
  const actionKey = `extend_${Date.now()}_${Number(table.extra || 0)}`;

  render();
  const saveTask = save("extend_one_hour");
  if(table.start){
    createOrUpdateRecord(table,{
      adjustmentJPY:table.payTiming === "prepaid" ? deltaJPY : 0,
      actionKey,
      note:"续时1小时，开始时已收款"
    }).catch(err=>console.warn("续时账单将在后台重试",err));
  }
  saveTask.catch(err=>{
    console.error("续时保存失败",err);
    setSyncStatus("pending","● 续时已保存在应急副本 · 等待重新同步");
  });
}

async function undoHour(i){
  stopAlertLoop(i);
  protectLocalTable(i,20000);
  const table = state.tables[i];
  if(Number(table.extra || 0) < 60 * 60 * 1000) return;
  const beforeJPY = getOriginalJPY(table);
  table.extra = Math.max(0,Number(table.extra || 0) - 60 * 60 * 1000);
  table.alerted = false;
  table.alerting = false;
  table.lastAction = "undo_one_hour";
  table.updatedAt = Date.now();
  const afterJPY = getOriginalJPY(table);
  const refundJPY = Math.min(0,afterJPY - beforeJPY);
  const actionKey = `undo_${Date.now()}_${Number(table.extra || 0)}`;

  render();
  const saveTask = save("undo_one_hour");
  if(table.start){
    createOrUpdateRecord(table,{
      adjustmentJPY:table.payTiming === "prepaid" ? refundJPY : 0,
      actionKey,
      note:"撤回续时1小时，记录退款差额"
    }).catch(err=>console.warn("撤回续时账单将在后台重试",err));
  }
  saveTask.catch(err=>{
    console.error("撤回续时保存失败",err);
    setSyncStatus("pending","● 撤回续时已保存在应急副本 · 等待重新同步");
  });
}


function setPayTiming(i,v){
  protectLocalTable(i);
  state.tables[i].payTiming = v;
  save("change_payment_timing");
}

async function setPay(i,v){
  protectLocalTable(i,15000);
  updateCustomer(i,false);

  const t = state.tables[i];
  t.pay = v;
  t.currency = currencyForPaymentMethod(v);
  const currencySelect = document.getElementById(`currency-${i}`);
  if(currencySelect) currencySelect.value = t.currency;
  const stateSaved = save("change_payment_method");

  // 运行中修改这里只代表“下一笔补收使用的付款方式”。
  // 已经收过的套餐预付款必须保留原付款方式，不能被微信/支付宝覆盖。
  if(t.start){
    await createOrUpdateRecord(t);
  }

  await stateSaved;
}

async function setCurrency(i,v){
  protectLocalTable(i,15000);
  const t = state.tables[i];
  const expected = currencyForPaymentMethod(t.pay);
  t.currency = t.pay ? expected : v;
  const currencySelect = document.getElementById(`currency-${i}`);
  if(currencySelect && currencySelect.value !== t.currency){
    currencySelect.value = t.currency;
  }
  const stateSaved = save("change_currency");

  if(t.start){
    await createOrUpdateRecord(t);
  }

  await stateSaved;
}

function openCheckout(i){
  checkoutIndex = i;
  useRound = false;

  const btn = document.getElementById("roundButton");
  if(btn){
    btn.classList.remove("active");
    btn.innerText = "抹零";
  }

  updateCheckout();
  document.getElementById("checkoutModalBg").style.display = "block";
}

function toggleRound(){
  useRound = !useRound;

  const btn = document.getElementById("roundButton");
  if(btn){
    btn.classList.toggle("active",useRound);
    btn.innerText = useRound ? "已抹零" : "抹零";
  }

  updateCheckout();
}

function updateCheckout(){
  const t = state.tables[checkoutIndex];
  const p = getPackage(t);
  const adjustment = getCheckoutAdjustment(t);

  const originalJPY = getOriginalJPY(t);
  const dueJPY = Math.max(0, originalJPY - Number(t.paidJPY || 0));
  const finalJPY = useRound ? roundJPY(dueJPY) : dueJPY;
  const totalRMB = getRMB(finalJPY);

  document.getElementById("checkoutInfo").innerHTML = `
    ${t.name}｜${p.name}${p.unlimited ? "（不限时）" : ""}<br>
    客人：${t.customer.name || "-"} ${t.customer.phoneLast4 || ""}<br>
    类型：${t.type === "booking" ? "预约" : "Walk-in"}<br><br>

<label style="font-weight:900;display:block;margin:10px 0 6px;">
  ${finalJPY > 0 ? adjustment.paymentLabel : "本次无需补收"}
</label>

<select id="checkoutPay" ${finalJPY === 0 ? "disabled" : ""}>
  <option value="">${finalJPY === 0 ? "直接结账" : `请选择【${adjustment.label.replace("本次","")}】付款方式`}</option>
  <option value="现金">现金</option>
  <option value="PayPay">PayPay</option>
  <option value="微信">微信</option>
  <option value="支付宝">支付宝</option>
</select>

<div class="pay-tip">
  点击开始时已记录当时的套餐费；结账总价以当前最终选择的套餐为准，并结清套餐变更或续费产生的差额。退款请使用桌位上的独立“退款”按钮。
</div>
<div class="pay-tip">币种按付款方式自动确定：现金/PayPay 为日元，微信/支付宝为人民币。</div>
  `;

  document.getElementById("checkoutAmount").innerHTML = `
    当前应收：¥${originalJPY.toLocaleString()}<br>
    已收净额：¥${Number(t.paidJPY || 0).toLocaleString()}<br><br>
    ${adjustment.label}：<span id="checkoutDiffText">¥${finalJPY.toLocaleString()}</span><br>
    人民币参考：<span id="checkoutRmbText">¥${totalRMB.toLocaleString()}</span><br>
    <label>备注</label>
    <input id="checkoutNote" placeholder="例：续费1小时">
  `;
}

async function confirmCheckout(){
  if(checkoutSubmitting) return;

  const confirmButton = document.querySelector(
    '#checkoutModalBg button.btn-success, #checkoutModalBg .btn-success'
  );

  const originalIndex = checkoutIndex;
  const t = state?.tables?.[originalIndex];
  if(!t){
    alert("找不到这张桌位，请关闭窗口后重试");
    return;
  }

  const pay = document.getElementById("checkoutPay")?.value || "";

  const finalChargeJPY = getOriginalJPY(t);
  const paidBeforeJPY = Number(t.paidJPY || 0);
  const rawDiffJPY = Math.max(0, finalChargeJPY - paidBeforeJPY);
  const finalJPY = useRound ? roundJPY(rawDiffJPY) : rawDiffJPY;
  const finalSettlementJPY = paidBeforeJPY + finalJPY;
  const adjustment = getCheckoutAdjustment(t);

  if(finalJPY > 0 && !pay){
    alert(`${adjustment.label}，请选择付款方式`);
    return;
  }

  checkoutSubmitting = true;
  if(confirmButton){
    confirmButton.disabled = true;
    confirmButton.textContent = "正在保存账单…";
  }

  try{
    stopAlertLoop(originalIndex);
    if(finalJPY > 0){
      t.pay = pay;
      t.currency = currencyForPaymentMethod(pay);
    }

    const note = document.getElementById("checkoutNote")?.value || "";

    t.paidJPY = finalSettlementJPY;
    t.paidRMB = getRMB(t.paidJPY);
    t.paidAt = Date.now();

    // 先尝试读取/构建完整账单，但最多等待2秒。
    // iPad Safari 的 IndexedDB 偶尔会挂起，不能因此阻塞结账。
    let record = null;
    try{
      record = await Promise.race([
        createOrUpdateRecord(t),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("本地账单读取超时")),2000))
      ]);
    }catch(err){
      console.warn("结账时完整账单读取超时，改用紧急本地账单",err);
      record = getLocalRecordSync(t.recordId) || {
        id: ensureVisitAndRecordId(t),
        timestamp: Date.now(),
        businessDate: getBusinessDateKey(Date.now()),
        time: new Date().toLocaleString(),
        tableName: t.name,
        receiptImage:"",
        receiptFileName:"",
        payments:[]
      };
      t.recordId = record.id;
    }

    record.payments = normalizePayments(record);
    settleRecordToFinalAmount(record,{
      finalAmountJPY:finalSettlementJPY,
      pay,
      reason:adjustment.reason,
      note:note || adjustment.note
    });

    const paymentTotalJPY = sumPaymentsJPY(record.payments);
    const p = getPackage(t);
    record.tableName = t.name;
    record.customerName = t.customer?.name || "";
    record.phoneLast4 = t.customer?.phoneLast4 || "";
    record.customerType = t.type || "walkin";
    record.packageName = p.name;
    record.packageMinutes = p.unlimited ? "不限时" : p.minutes;
    record.packagePrice = p.price;
    record.extraMinutes = Math.floor(Number(t.extra || 0) / 60000);
    record.extensionAmount = Math.max(0, finalSettlementJPY - Number(p.price || 0));
    record.originalJPY = finalSettlementJPY;
    record.beforeRoundJPY = finalChargeJPY;
    record.roundDiscountJPY = useRound ? Math.max(0, finalChargeJPY - finalSettlementJPY) : 0;
    record.totalJPY = paymentTotalJPY;
    record.totalRMB = sumPaymentsRMB(record.payments);
    record.paidJPY = paymentTotalJPY;
    record.dueJPY = Math.max(0, finalChargeJPY - paymentTotalJPY);
    record.pay = getPaymentSummary(record.payments);
    record.currency = getCurrencySummary(record.payments);
    record.roundRule = useRound ? "500抹零" : "不抹零";
    record.paidStatus = record.dueJPY > 0 ? "未结清" : "已结清";
    record.checkoutMethod = t.payTiming === "postpaid" ? "后付款一次性结账" : "结账确认";
    record.recordType = t.payTiming === "postpaid" ? "postpaid" : "prepaid";
    record.closed = true;
    record.status = "已结账";
    record.closedAt = Date.now();
    record.closedTime = new Date(record.closedAt).toLocaleString();
    record.businessDate = record.businessDate || getBusinessDateKey(record.startAt || record.timestamp || record.closedAt);

    const visit = createOrUpdateCustomerVisit(t);
    if(visit){
      visit.endAt = Date.now();
      visit.range = getVisitRangeText(t);
      visit.closed = true;
      visit.finalJPY = t.paidJPY;
      visit.closedTime = new Date().toLocaleString();
    }

    if(t.bookingId){
      const b = state.bookings?.find(x=>Number(x.id) === Number(t.bookingId));
      if(b){
        markBookingTableFinished(b,originalIndex,record.closedAt);
      }
    }

    // 核心：先同步写入 localStorage 紧急备份，再立即清空桌位并关闭窗口。
    // IndexedDB 和 Firestore 都放到后台，不再让用户卡在“正在结账”。
    emergencySaveRecord({db,ref,record});
    state.tables[originalIndex] = resetTable(t.name);
    if(navigator.onLine){
      try{
        const released = await atomicReleaseTable({
          db,
          ref,
          tableIndex:originalIndex,
          table:state.tables[originalIndex],
          expectedRecordId:record.id,
          action:"checkout_release_table"
        });
        if(released?.tables?.[originalIndex]){
          state.tables[originalIndex] = released.tables[originalIndex];
        }
      }catch(releaseError){
        console.warn("结账后权威桌位释放失败，保留同步队列继续重试",releaseError);
      }
    }
    emergencySaveState({db,ref,state,action:"checkout_complete"});

    closeCheckout();
    render();
    setSyncStatus(navigator.onLine ? "pending" : "offline",
      navigator.onLine ? "● 结账已保存本机 · 正在后台同步" : "● 结账已保存本机 · 当前离线");

    // 后台补写完整IndexedDB账单；失败不会影响已经完成的结账。
    Promise.resolve().then(()=>saveRecordSafely({db,ref,record})).catch(err=>{
      console.warn("结账账单后台保存失败，已保留紧急备份",err);
    });
  }catch(e){
    console.error(e);
    alert("结账错误：\n" + (e?.message || e));
  }finally{
    checkoutSubmitting = false;
    if(confirmButton){
      confirmButton.disabled = false;
      confirmButton.textContent = "确认结账";
    }
  }
}



function openForceEnd(i){
  const t = state?.tables?.[i];
  if(!t?.start){
    alert("这张桌位当前没有开始计时");
    return;
  }

  forceEndIndex = i;
  forceEndSubmitting = false;

  const p = getPackage(t);
  const originalJPY = getOriginalJPY(t);
  const paidJPY = Number(t.paidJPY || 0);
  const dueJPY = Math.max(0, originalJPY - paidJPY);

  const info = document.getElementById("forceEndInfo");
  if(info){
    info.innerHTML = `
      <div style="font-weight:900;font-size:20px;margin-bottom:10px;">${t.name}｜${p.name}</div>
      <div>当前应收：¥${originalJPY.toLocaleString()}</div>
      <div>已收金额：¥${paidJPY.toLocaleString()}</div>
      <div>尚未收款：¥${dueJPY.toLocaleString()}</div>
      <div style="margin-top:14px;padding:12px;border-radius:12px;background:#fff2f2;color:#9b1c1c;font-weight:800;line-height:1.6;">
        强制结束会先把账单保存到本机，再清空该桌位。<br>
        不会新增收款；如有未收金额，账单会保留为“未结清”。
      </div>
    `;
  }

  const button = document.getElementById("forceEndConfirmButton");
  if(button){
    button.disabled = false;
    button.textContent = "确认强制结束";
  }

  document.getElementById("forceEndModalBg").style.display = "block";
}

function closeForceEnd(){
  if(forceEndSubmitting) return;
  const modal = document.getElementById("forceEndModalBg");
  if(modal) modal.style.display = "none";
  forceEndIndex = null;
}

async function confirmForceEnd(){
  if(forceEndSubmitting) return;

  const i = Number(forceEndIndex);
  const t = state?.tables?.[i];
  if(!Number.isInteger(i) || !t?.start){
    alert("找不到需要结束的桌位，页面将重新显示当前状态");
    closeForceEnd();
    render();
    return;
  }

  const button = document.getElementById("forceEndConfirmButton");
  forceEndSubmitting = true;
  if(button){
    button.disabled = true;
    button.textContent = "正在紧急保存…";
  }

  try{
    stopAlertLoop(i);

    const p = getPackage(t);
    const originalJPY = getOriginalJPY(t);
    const now = Date.now();

    // Emergency mode deliberately avoids awaiting IndexedDB or Firestore.
    // Read the synchronous local shadow when available, otherwise create a record now.
    let record = getLocalRecordSync(t.recordId);
    if(!record){
      const id = ensureVisitAndRecordId(t);
      t.recordId = id;
      record = {
        id,
        timestamp: now,
        businessDate: getBusinessDateKey(now),
        time: new Date(now).toLocaleString(),
        tableName: t.name,
        receiptImage:"",
        receiptFileName:""
      };
    }

    record.tableName = t.name;
    record.customerName = t.customer?.name || "";
    record.phoneLast4 = t.customer?.phoneLast4 || "";
    record.customerType = t.type || "walkin";
    record.packageName = p.name;
    record.packageMinutes = p.unlimited ? "不限时" : p.minutes;
    record.packagePrice = Number(p.price || 0);
    record.extraMinutes = Math.floor(Number(t.extra || 0) / 60000);
    record.extensionAmount = Math.max(0, originalJPY - Number(p.price || 0));
    record.payments = normalizePayments(record);

    // Preserve prepaid amount even when the previous async bill creation never finished.
    if(record.payments.length === 0 && Number(t.paidJPY || 0) > 0){
      record.payments.push(makePaymentLine({
        type:"收入",
        reason:"套餐费",
        pay:t.pay || "未记录",
        amountJPY:Number(t.paidJPY || 0),
        note:"强制结束时从桌位恢复"
      }));
    }

    const paymentTotalJPY = sumPaymentsJPY(record.payments);
    record.originalJPY = originalJPY;
    record.totalJPY = paymentTotalJPY;
    record.totalRMB = sumPaymentsRMB(record.payments);
    record.paidJPY = paymentTotalJPY;
    record.dueJPY = Math.max(0, originalJPY - paymentTotalJPY);
    record.pay = getPaymentSummary(record.payments);
    record.currency = getCurrencySummary(record.payments);
    record.payTiming = t.payTiming || "prepaid";
    record.paidStatus = record.dueJPY > 0 ? "未结清" : "已结清";
    record.recordType = t.payTiming === "postpaid" ? "postpaid" : "prepaid";
    record.checkoutMethod = "本机紧急强制结束";
    record.roundRule = record.roundRule || "不抹零";
    record.closed = true;
    record.closedAt = now;
    record.closedTime = new Date(now).toLocaleString();
    record.businessDate = record.businessDate || getBusinessDateKey(record.startAt || record.timestamp || now);
    record.forceClosed = true;
    record.forceClosedAt = now;

    emergencySaveRecord({db,ref,record});

    const visit = createOrUpdateCustomerVisit(t);
    if(visit){
      visit.endAt = now;
      visit.range = getVisitRangeText(t);
      visit.closed = true;
      visit.finalJPY = paymentTotalJPY;
      visit.closedTime = new Date(now).toLocaleString();
      visit.forceClosed = true;
    }

    if(t.bookingId){
      const b = state.bookings?.find(x=>Number(x.id) === Number(t.bookingId));
      if(b){
        markBookingTableFinished(b,i,now);
      }
    }

    const tableName = t.name;
    state.tables[i] = resetTable(tableName);
    if(navigator.onLine){
      try{
        const released = await atomicReleaseTable({
          db,
          ref,
          tableIndex:i,
          table:state.tables[i],
          expectedRecordId:record.id,
          action:"force_end_release_table"
        });
        if(released?.tables?.[i]){
          state.tables[i] = released.tables[i];
        }
      }catch(releaseError){
        console.warn("强制结束后权威桌位释放失败，保留同步队列继续重试",releaseError);
      }
    }
    emergencySaveState({db,ref,state,action:"emergency_force_end_table"});

    const modal = document.getElementById("forceEndModalBg");
    if(modal) modal.style.display = "none";
    forceEndIndex = null;
    forceEndSubmitting = false;
    render();

    // Non-blocking visual notice; avoid alert/confirm in iPad standalone mode.
    setSyncStatus(navigator.onLine ? "pending" : "offline", navigator.onLine ? "● 桌位已结束 · 本机已保存 · 等待上传" : "● 桌位已结束 · 已保存本机 · 当前离线");
  }catch(err){
    console.error("紧急强制结束失败",err);
    forceEndSubmitting = false;
    if(button){
      button.disabled = false;
      button.textContent = "确认强制结束";
    }
    alert("强制结束失败：\n" + (err?.message || err));
  }
}

async function autoCloseOldTables(){
  if(!state || autoClosingOldTables) return;

  const today = getDateText(Date.now());

  const targets = state.tables
    .map((t,i)=>({t,i}))
    .filter(({t})=>{
      if(!t.start) return false;
      return getDateText(t.start) < today;
    });

  if(!targets.length) return;

  autoClosingOldTables = true;

  try{
    for(const {t,i} of targets){
      stopAlertLoop(i);

      const now = Date.now();

      const record = await createOrUpdateRecord(t);

      record.businessDate =
        record.businessDate ||
        getBusinessDateKey(t.start || record.timestamp || now);

      record.closedAt = now;
      record.closedTime = new Date(now).toLocaleString();

      record.checkoutMethod = "系统自动跨天结账";
      record.roundRule = "自动结账";

      record.payments = normalizePayments(record);

      const paymentTotalJPY = sumPaymentsJPY(record.payments);

      record.originalJPY = getOriginalJPY(t);
      record.totalJPY = paymentTotalJPY;
      record.totalRMB = sumPaymentsRMB(record.payments);
      record.paidJPY = paymentTotalJPY;
      record.dueJPY = Math.max(0, record.originalJPY - paymentTotalJPY);
      record.pay = getPaymentSummary(record.payments);
      record.currency = getCurrencySummary(record.payments);
      record.paidStatus = record.dueJPY > 0 ? "未结清" : "已结清";

      emergencySaveRecord({db,ref,record});
      await updateRecordOnly(record);

      const visit = createOrUpdateCustomerVisit(t);
      if(visit){
        visit.endAt = now;
        visit.range = getVisitRangeText(t);
        visit.closed = true;
        visit.finalJPY = paymentTotalJPY;
        visit.closedTime = new Date(now).toLocaleString();
      }

      if(t.bookingId){
        const b = state.bookings?.find(x=>Number(x.id) === Number(t.bookingId));

        if(b){
          markBookingTableFinished(b,i,now);
        }
      }

      state.tables[i] = resetTable(t.name);
    }

    await save();
    render();

    console.log(`已自动结账 ${targets.length} 桌跨天未结账记录`);
  }catch(e){
    console.error(e);
    alert("自动跨天结账失败：" + e.message);
  }finally{
    autoClosingOldTables = false;
  }
}


function refreshCheckoutDiff(){
  const t = state.tables[checkoutIndex];
  if(!t) return;

  const defaultOriginalJPY = getOriginalJPY(t);
  const finalChargeJPY = Number(
    document.getElementById("checkoutFinalCharge")?.value || defaultOriginalJPY
  );

  const rawDiffJPY = finalChargeJPY - Number(t.paidJPY || 0);
  const finalJPY = useRound ? roundJPY(rawDiffJPY) : rawDiffJPY;

  const diffText = document.getElementById("checkoutDiffText");
  const rmbText = document.getElementById("checkoutRmbText");

  if(diffText){
    diffText.innerText = `¥${finalJPY.toLocaleString()}`;
  }

  if(rmbText){
    rmbText.innerText = `¥${getRMB(finalJPY).toLocaleString()}`;
  }
}

let refundIndex = -1;
let refundSubmitting = false;

function openRefund(i){
  const t = state.tables[i];
  if(!t?.start){
    alert("桌位尚未开始，不能退款");
    return;
  }
  refundIndex = i;
  const modal = document.getElementById("refundModalBg");
  document.getElementById("refundInfo").innerHTML = `
    ${t.name}<br>
    客人：${t.customer?.name || "-"} ${t.customer?.phoneLast4 || ""}<br>
    当前已收净额：¥${Number(t.paidJPY || 0).toLocaleString()}
  `;
  document.getElementById("refundAmount").value = "";
  document.getElementById("refundPay").value = t.pay || "现金";
  document.getElementById("refundNote").value = "";
  modal.style.display = "block";
}

async function confirmRefund(){
  if(refundSubmitting) return;
  const t = state.tables[refundIndex];
  if(!t?.start){
    alert("找不到正在使用的桌位");
    return;
  }
  const amount = Math.round(Number(document.getElementById("refundAmount")?.value || 0));
  const pay = document.getElementById("refundPay")?.value || "";
  const note = document.getElementById("refundNote")?.value?.trim() || "";
  if(!Number.isFinite(amount) || amount <= 0){
    alert("请输入大于0的退款金额");
    return;
  }
  if(!pay){
    alert("请选择退款方式");
    return;
  }
  if(amount > Number(t.paidJPY || 0)){
    if(!confirm(`退款金额 ¥${amount.toLocaleString()} 超过当前已收净额 ¥${Number(t.paidJPY || 0).toLocaleString()}。仍要继续吗？`)) return;
  }
  if(!confirm(`确认退款 ¥${amount.toLocaleString()}？
退款方式：${pay}${note ? `
备注：${note}` : ""}`)) return;

  refundSubmitting = true;
  try{
    let record = await createOrUpdateRecord(t);
    record.payments = normalizePayments(record);
    record.payments.push(makePaymentLine({
      type:"退款",
      reason:"手动退款",
      pay,
      amountJPY:-amount,
      note
    }));
    const paymentTotalJPY = sumPaymentsJPY(record.payments);
    record.totalJPY = paymentTotalJPY;
    record.totalRMB = sumPaymentsRMB(record.payments);
    record.paidJPY = paymentTotalJPY;
    record.pay = getPaymentSummary(record.payments);
    record.currency = getCurrencySummary(record.payments);
    record.dueJPY = Math.max(0, Number(record.originalJPY || getOriginalJPY(t)) - paymentTotalJPY);
    record.paidStatus = record.dueJPY > 0 ? "未结清" : "已结清";
    record.updatedAt = Date.now();

    t.paidJPY = paymentTotalJPY;
    t.paidRMB = record.totalRMB;
    t.paidAt = Date.now();

    await saveRecordSafely({db,ref,record});
    await save("manual_refund");
    render();
    closeRefund();
  }catch(e){
    console.error(e);
    alert("退款记录失败：" + (e?.message || e));
  }finally{
    refundSubmitting = false;
  }
}

function closeRefund(){
  document.getElementById("refundModalBg").style.display = "none";
  refundIndex = -1;
}

function closeCheckout(){
  document.getElementById("checkoutModalBg").style.display = "none";
}

async function moveRunningTable(fromIndex){
  const fromTable = state.tables[fromIndex];

  if(!fromTable || !fromTable.start){
    alert("这张桌没有正在计时，不能移动");
    return;
  }

  movingRunningFromIndex = fromIndex;
  movingRunningToIndex = null;
  draggingRunningFrom = null;

  document.getElementById("moveRunningInfo").innerHTML = `
    当前：${fromTable.name}<br>
    客人：${fromTable.customer?.name || "-"} ${fromTable.customer?.phoneLast4 || ""}
  `;

  document.getElementById("moveRunningFromBox").innerHTML = `
    <button
      class="move-table-btn"
      id="running-from-${fromIndex}"
      onpointerdown="startRunningMoveDrag(event,${fromIndex})"
    >
      ${fromTable.name}<br>
      <small>使用中</small>
    </button>
  `;

  document.getElementById("moveRunningToBox").innerHTML = state.tables.map((t,i)=>{
    const disabled = i === fromIndex || !!t.start;

    return `
      <button
        class="move-table-btn ${disabled ? "disabled" : ""}"
        id="running-to-${i}"
        data-index="${i}"
        ${disabled ? "disabled" : ""}
      >
        ${t.name}<br>
        <small>${disabled ? "不可移动" : "空闲"}</small>
      </button>
    `;
  }).join("");

  document.getElementById("moveRunningModalBg").style.display = "block";
}

function startRunningMoveDrag(e, fromIndex){
  e.preventDefault();

  draggingRunningFrom = fromIndex;

  const area = document.getElementById("moveRunningLineArea");
  const svg = document.getElementById("moveRunningSvg");
  const fromEl = document.getElementById("running-from-" + fromIndex);

  if(!area || !svg || !fromEl) return;

  runningMoveAreaRect = area.getBoundingClientRect();

  const r = fromEl.getBoundingClientRect();
  const x1 = r.left + r.width / 2 - runningMoveAreaRect.left;
  const y1 = r.top + r.height / 2 - runningMoveAreaRect.top;

  const ns = "http://www.w3.org/2000/svg";
  runningMoveTempLine = document.createElementNS(ns,"line");

  runningMoveTempLine.setAttribute("x1",x1);
  runningMoveTempLine.setAttribute("y1",y1);
  runningMoveTempLine.setAttribute("x2",x1);
  runningMoveTempLine.setAttribute("y2",y1);
  runningMoveTempLine.setAttribute("stroke","#d8a900");
  runningMoveTempLine.setAttribute("stroke-width","5");
  runningMoveTempLine.setAttribute("stroke-linecap","round");
  runningMoveTempLine.setAttribute("stroke-dasharray","8 6");

  svg.replaceChildren(runningMoveTempLine);

  window.addEventListener("pointermove", moveRunningDragLine, {passive:false});
  window.addEventListener("pointerup", endRunningMoveDrag);
}

function moveRunningDragLine(e){
  if(draggingRunningFrom === null || !runningMoveTempLine || !runningMoveAreaRect) return;

  e.preventDefault();

  const x = e.clientX - runningMoveAreaRect.left;
  const y = e.clientY - runningMoveAreaRect.top;

  runningMoveTempLine.setAttribute("x2",x);
  runningMoveTempLine.setAttribute("y2",y);
}

function endRunningMoveDrag(e){
  if(draggingRunningFrom === null) return;

  const target = document.elementFromPoint(e.clientX,e.clientY);
  const toBtn = target?.closest?.("[id^='running-to-']");

  if(toBtn && !toBtn.disabled){
    movingRunningToIndex = Number(toBtn.dataset.index);

    document.querySelectorAll("#moveRunningToBox .move-table-btn")
      .forEach(btn=>btn.classList.remove("selected"));

    toBtn.classList.add("selected");

    drawFinalRunningMoveLine();
  }else{
    if(runningMoveTempLine) runningMoveTempLine.remove();
  }

  draggingRunningFrom = null;
  runningMoveTempLine = null;
  runningMoveAreaRect = null;

  window.removeEventListener("pointermove", moveRunningDragLine);
  window.removeEventListener("pointerup", endRunningMoveDrag);
}

function drawFinalRunningMoveLine(){
  const svg = document.getElementById("moveRunningSvg");
  const area = document.getElementById("moveRunningLineArea");
  const fromEl = document.getElementById("running-from-" + movingRunningFromIndex);
  const toEl = document.getElementById("running-to-" + movingRunningToIndex);

  if(!svg || !area || !fromEl || !toEl) return;

  const rect = area.getBoundingClientRect();

  function center(el){
    const r = el.getBoundingClientRect();
    return {
      x:r.left + r.width / 2 - rect.left,
      y:r.top + r.height / 2 - rect.top
    };
  }

  const a = center(fromEl);
  const b = center(toEl);

  const ns = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(ns,"line");

  line.setAttribute("x1",a.x);
  line.setAttribute("y1",a.y);
  line.setAttribute("x2",b.x);
  line.setAttribute("y2",b.y);
  line.setAttribute("stroke","#d8a900");
  line.setAttribute("stroke-width","5");
  line.setAttribute("stroke-linecap","round");

  svg.replaceChildren(line);
}

async function confirmMoveRunningLine(){
  if(movingRunningFromIndex === null || movingRunningToIndex === null){
    alert("请先拖线选择目标桌位");
    return;
  }

  const fromTable = state.tables[movingRunningFromIndex];
  const toTable = state.tables[movingRunningToIndex];

  if(!fromTable || !fromTable.start){
    alert("原桌位不是使用中");
    return;
  }

  if(!toTable || toTable.start){
    alert("目标桌位不是空闲");
    return;
  }

  if(!confirm(`确认把 ${fromTable.name} 移动到 ${toTable.name} 吗？`)){
    return;
  }

  stopAlertLoop(movingRunningFromIndex);
  stopAlertLoop(movingRunningToIndex);

  delete remindLocks[movingRunningFromIndex];
  delete remindLocks[movingRunningToIndex];

  const oldFromName = fromTable.name;
  const oldToName = toTable.name;

  state.tables[movingRunningToIndex] = {
    ...fromTable,
    name:oldToName
  };

  state.tables[movingRunningFromIndex] = resetTable(oldFromName);

  await createOrUpdateRecord(state.tables[movingRunningToIndex]);

  await save();

  closeMoveRunningLineModal();
  render();

  alert(`已移动到 ${oldToName}`);
}

function closeMoveRunningLineModal(){
  document.getElementById("moveRunningModalBg").style.display = "none";

  movingRunningFromIndex = null;
  movingRunningToIndex = null;
  draggingRunningFrom = null;
  runningMoveTempLine = null;
  runningMoveAreaRect = null;

  const svg = document.getElementById("moveRunningSvg");
  if(svg) svg.replaceChildren();
}


function generateQR(i){
  const canvas = document.getElementById("qr-"+i);
  if(!canvas) return;

  const displayUrl = new URL("./display.html",document.baseURI);
  displayUrl.search = "";
  displayUrl.searchParams.set("table",String(i+1));

  import("https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js").then(QR=>{
    QR.toCanvas(canvas,displayUrl.href,{errorCorrectionLevel:"H",margin:2});
  });
}

function playBeep(){
  // 提示音永久关闭；系统通知使用 silent:true，不播放声音。
}

function startAlertLoop(){
  // 超时仅保留页面上的文字/颜色提示，不播放声音、不发通知、不震动。
}

function stopAlertLoop(){
  // 无需停止声音循环。
}

function renderAlarmPanel(){
  const panel = document.getElementById("alarmPanel");
  const list = document.getElementById("alarmList");
  if(!panel || !list || !state) return;

  const overtimeTables = state.tables.filter(t=>{
    if(!t.start || t.pausedAt) return false;

    const p = getPackage(t);
    if(p.unlimited) return false;

    const elapsed = Date.now() - t.start;
    const limit = Number(p.minutes || 0) * 60 * 1000 + Number(t.extra || 0);

    return elapsed > limit;
  });

  if(!overtimeTables.length){
    panel.style.display = "none";
    list.innerHTML = "";
    return;
  }

  panel.style.display = "block";
  list.innerHTML = overtimeTables.map(t=>{
    return `<div class="alarm-item">${t.name} 已超时</div>`;
  }).join("");
}

function refreshVisibleTimerText(){
  if(!state?.tables) return;

  state.tables.forEach((table,index)=>{
    const packageInfo = getPackage(table);
    const elapsed = getElapsedMs(table);
    const remain = getLimitMs(table) - elapsed;
    const status = getStatus(table);
    const summary = !table.start
      ? "未开始"
      : table.pausedAt
        ? "暂停中 " + formatTime(elapsed)
        : packageInfo.unlimited
          ? "已使用 " + formatTime(elapsed)
          : status === "overtime"
            ? "超时 " + formatTime(Math.abs(remain))
            : "剩余 " + formatTime(remain);

    const summaryNode = document.querySelector(`[data-summary-timer="${index}"]`);
    if(summaryNode) summaryNode.textContent = summary;

    const usedNode = document.querySelector(`[data-used-timer="${index}"]`);
    if(usedNode) usedNode.textContent = table.start ? "已用 " + formatTime(elapsed) : "";
  });
}

setInterval(()=>{
  const active = document.activeElement;

  if(
    active &&
    (
      active.tagName === "INPUT" ||
      active.tagName === "SELECT"
    ) &&
    !active.id?.includes("Filter") &&
    active.id !== "sortMode"
  ){
    return;
  }

  // 秒表只更新已有文字，避免每秒销毁并重建所有桌卡和输入框。
  refreshVisibleTimerText();
},1000);

function setSearchKeyword(v){
  searchKeyword = v;
  render();
}

function setStatusFilter(v){
  statusFilter = v;
  document.activeElement.blur();
  render();
}

function setTypeFilter(v){
  typeFilter = v;
  document.activeElement.blur();
  render();
}

function setPayFilter(v){
  payFilter = v;
  document.activeElement.blur();
  render();
}



function openBatchStart(){
  const pkgBox = document.getElementById("batchPackageSelect");
  const tableBox = document.getElementById("batchTableChecks");

  pkgBox.innerHTML = state.packages.map((p,i)=>`
    <option value="${i}">
      ${p.name}｜${p.unlimited ? "不限时" : p.minutes + "分钟"}｜¥${p.price}
    </option>
  `).join("");

  tableBox.innerHTML = state.tables
    .map((t,i)=>({t,i}))
    .filter(({t})=>!t.start)
    .map(({t,i})=>`
      <label class="table-item">
        <input type="checkbox" class="batch-table-check" value="${i}">
        <span class="num">${t.name.replace("号桌","")}</span>
        <span class="sub">可开始</span>
      </label>
    `).join("");

  if(!tableBox.innerHTML){
    tableBox.innerHTML = `<p style="color:#8a8174;">没有可开始的桌位</p>`;
  }

  document.getElementById("batchStartModalBg").style.display = "block";
}

function closeBatchStart(){
  document.getElementById("batchStartModalBg").style.display = "none";
}

async function confirmBatchStart(){
  const packageIndex = Number(document.getElementById("batchPackageSelect").value);
  const pay = document.getElementById("batchPaySelect").value;

  if(!pay){
    alert("请选择付款方式");
    return;
  }
  if(!navigator.onLine){
    alert("当前离线，无法安全批量开始。请恢复网络后再操作。");
    return;
  }

  const indexes = [...document.querySelectorAll(".batch-table-check:checked")]
    .map(el=>Number(el.value));
  if(indexes.length === 0){
    alert("请选择至少一张桌");
    return;
  }

  const now = Date.now();
  let groupId = "";
  try{
    groupId = await allocateGroupId(db,state.groups || []);
  }catch(error){
    console.error("批量开始组编号分配失败",error);
    setSyncStatus("error","● 批量开始未执行 · 无法取得唯一组编号");
    alert(error?.message || "无法取得唯一组编号，请确认网络后重试");
    return;
  }
  const groupName = document.getElementById("batchGroupName")?.value.trim() || `现场组`;
  const paymentMode = document.getElementById("batchGroupPaymentMode")?.value || "split";
  const group = {
    id:groupId,
    name:groupName,
    color:"#B7E4C7",
    tableIndexes:indexes,
    peopleCount:Math.max(1,indexes.length),
    paymentMode,
    createdAt:now,
    updatedAt:now
  };

  const entries = [];
  for(const i of indexes){
    const source = state.tables[i];
    if(!source || source.start){
      alert(`${source?.name || `${i+1}号桌`}已经开始，批量开始已取消。`);
      return;
    }

    const t = JSON.parse(JSON.stringify(source));
    t.packageIndex = packageIndex;
    t.pay = pay;
    t.payTiming = "prepaid";
    t.groupId = groupId;
    t.startLocked = true;
    ensureVisitAndRecordId(t);
    t.start = now;
    t.pausedAt = null;
    t.alerted = false;
    t.alerting = false;
    t.lastAction = "batch_start";

    const pkg = getPackage(t);
    t.paidJPY = Number(pkg.price || 0);
    t.paidRMB = getRMB(t.paidJPY);
    t.paidAt = now;

    const payments = t.paidJPY > 0 ? [makePaymentLine({
      reason:"套餐预付款",
      pay:t.pay || "未记录",
      amountJPY:t.paidJPY,
      note:"批量开始时收取"
    })] : [];

    const record = {
      id:t.recordId, visitId:t.visitId, timestamp:now, startAt:now,
      startedTime:new Date(now).toLocaleString(), businessDate:getBusinessDateKey(now),
      time:new Date(now).toLocaleString(), tableName:t.name,
      customerName:t.customer?.name || "", phoneLast4:t.customer?.phoneLast4 || "",
      customerType:t.type || "walkin", packageName:pkg.name,
      packageMinutes:pkg.unlimited ? "不限时" : pkg.minutes,
      packagePrice:Number(pkg.price || 0), extraMinutes:0, extensionAmount:0,
      originalJPY:Number(pkg.price || 0), payments,
      paidJPY:sumPaymentsJPY(payments),
      dueJPY:Math.max(0,Number(pkg.price || 0)-sumPaymentsJPY(payments)),
      totalJPY:sumPaymentsJPY(payments),
      totalRMB:payments.reduce((sum,line)=>sum+Number(line.amountRMB || 0),0),
      pay:getPaymentSummary(payments), currency:getCurrencySummary(payments),
      payTiming:"prepaid", paidStatus:"已结清", status:"进行中", closed:false,
      receiptImage:"", receiptFileName:"", groupId, updatedAt:now, localUpdatedAt:now
    };
    entries.push({tableIndex:i,tablePatch:t,record});
  }

  setSyncStatus("pending","● 正在由服务器批量锁定桌位…");
  try{
    const result = await atomicBatchStartTables({db,ref,entries,group});
    state = JSON.parse(JSON.stringify(result.state));
    for(const i of indexes){
      const t = state.tables[i];
      if(t?.type === "booking" && Array.isArray(state.bookings)){
        const booking = state.bookings.find(b=>Number(b.id) === Number(t.bookingId))
          || state.bookings.find(b=>getBookingIndexes(b).includes(i) && (!b.name || b.name === t.customer?.name));
        if(booking) markBookingTableStarted(booking,i,now);
      }
    }
    ensureGroups(state);
    const savedGroup = upsertGroup(state,group);
    syncGroupReferences(state,savedGroup);
    await saveStateSafely({db,ref,getState:()=>state,action:"batch_start_finalize"});
    closeBatchStart();
    render();
    setSyncStatus("synced",`● 已安全批量开始 ${indexes.length} 桌`);
  }catch(error){
    console.error("批量开始失败",error);
    setSyncStatus("error","● 批量开始失败，未写入任何桌位");
    alert("批量开始失败：\n" + (error?.message || error));
  }
}




function openBatchCheckout(){
  const box = document.getElementById("batchCheckoutTableChecks");

  box.innerHTML = state.tables
    .map((t,i)=>({t,i}))
    .filter(({t})=>t.start)
    .map(({t,i})=>{
      const p = getPackage(t);
      const amountJPY = getOriginalJPY(t);
      const amountRMB = getRMB(amountJPY);
      const dueJPY = getDueJPY(t);

      return `
        <div class="batch-checkout-card">

          <label class="batch-table-card">
            <input type="checkbox" class="batch-checkout-table" value="${i}">
            <span class="table-name">${t.name}</span>
          </label>

          <div class="batch-info">
            <div><b>套餐：</b>${p.name}</div>
            <div><b>客人：</b>${t.customer?.name || "-"} ${t.customer?.phoneLast4 || ""}</div>
            <div><b>原价：</b>¥${amountJPY.toLocaleString()}</div>
            <div><b>人民币参考：</b>¥${amountRMB.toLocaleString()}</div>
          </div>

          <select id="batch-pay-${i}">
            <option value="">付款方式</option>
            <option value="现金" ${t.pay==="现金"?"selected":""}>现金</option>
            <option value="PayPay" ${t.pay==="PayPay"?"selected":""}>PayPay</option>
            <option value="微信" ${t.pay==="微信"?"selected":""}>微信</option>
            <option value="支付宝" ${t.pay==="支付宝"?"selected":""}>支付宝</option>            
          </select>

          <input
            id="batch-amount-${i}"
            type="number"
            value="${dueJPY}"
            placeholder="本次补收金额"
          >

          <button
            id="round-btn-${i}"
            class="btn-ghost full"
            onclick="roundBatchAmount(${i})"
          >
            抹零
          </button>

        </div>
      `;
    }).join("");

  if(!box.innerHTML){
    box.innerHTML = `<p style="color:#8a8174;">没有正在使用的桌位</p>`;
  }

  document.getElementById("batchCheckoutModalBg").style.display = "block";
}

function roundBatchAmount(i){
  const amountInput = document.getElementById(`batch-amount-${i}`);
  const btn = document.getElementById(`round-btn-${i}`);

  if(!amountInput || !btn || btn.disabled) return;

  const amount = Number(amountInput.value || 0);
  amountInput.value = roundJPY(amount);

  btn.disabled = true;
  btn.innerText = "已抹零";
  btn.classList.add("disabled-round");
}

function toggleGroupPayMode(){
  const checked = document.getElementById("groupPayMode")?.checked;
  const box = document.getElementById("groupPayBox");

  if(box){
    box.style.display = checked ? "block" : "none";
  }
  if(checked && document.getElementById("groupPaymentLines") && !document.getElementById("groupPaymentLines").children.length){
    addGroupPaymentLine();
  }
}


function addGroupPaymentLine(){
  const box = document.getElementById("groupPaymentLines");
  if(!box) return;
  const row = document.createElement("div");
  row.className = "group-payment-line";
  row.innerHTML = `
    <input class="group-line-payer" placeholder="付款人">
    <select class="group-line-method"><option value="">付款方式</option><option>现金</option><option>PayPay</option><option>微信</option><option>支付宝</option></select>
    <input class="group-line-amount" type="number" min="0" placeholder="金额">
    <input class="group-line-people" type="number" min="1" placeholder="代付人数">
    <button type="button" class="btn-danger" onclick="this.parentElement.remove()">删除</button>`;
  box.appendChild(row);
}

function readGroupPaymentLines(){
  return [...document.querySelectorAll(".group-payment-line")].map(row=>({
    payerName:row.querySelector(".group-line-payer")?.value.trim() || "",
    method:row.querySelector(".group-line-method")?.value || "",
    amountJPY:Number(row.querySelector(".group-line-amount")?.value || 0),
    coveredPeople:Number(row.querySelector(".group-line-people")?.value || 0)
  })).filter(line=>line.amountJPY > 0 || line.payerName || line.method || line.coveredPeople);
}

function closeBatchCheckout(){
  document.getElementById("batchCheckoutModalBg").style.display = "none";
}


async function confirmBatchCheckout(){
  const indexes = [...document.querySelectorAll(".batch-checkout-table:checked")]
    .map(el=>Number(el.value));

  if(indexes.length === 0){
    alert("请选择至少一张桌");
    return;
  }

  const isGroupPay = document.getElementById("groupPayMode")?.checked;

  if(isGroupPay){
    const groupPayMethod = document.getElementById("groupPayMethod")?.value || "";
    const groupPayerName = document.getElementById("groupPayerName")?.value.trim() || "";
    const groupPayNote = document.getElementById("groupPayNote")?.value.trim() || "";
    const manualTotal = Number(document.getElementById("groupPayTotal")?.value || 0);
    const paymentLines = readGroupPaymentLines();

    if(paymentLines.length && paymentLines.some(line=>!line.method || line.amountJPY <= 0)){
      alert("请完整填写每一笔付款明细的付款方式和金额");
      return;
    }
    if(!paymentLines.length && !groupPayMethod){
      alert("请选择整组付款方式");
      return;
    }

    const items = indexes.map(i=>{
      const t = state.tables[i];
      return {
        i,
        t,
        dueJPY:getDueJPY(t)
      };
    });

    const defaultTotal = items.reduce((sum,item)=>sum + Number(item.dueJPY || 0),0);
    const lineTotal = paymentLines.reduce((sum,line)=>sum + line.amountJPY,0);
    const groupTotalJPY = lineTotal > 0 ? lineTotal : (manualTotal > 0 ? manualTotal : defaultTotal);

    if(groupTotalJPY <= 0){
      alert("整组没有需要补收的金额");
      return;
    }

    if(!confirm(`确认整组代付结账？\n\n合计：¥${groupTotalJPY.toLocaleString()}`)){
      return;
    }

    const groupPaymentId =
      "group_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);

    const tableNames = indexes
      .map(i=>state.tables[i]?.name)
      .filter(Boolean)
      .join("、");

    let remaining = groupTotalJPY;
    const selectedGroupIds = Array.from(new Set(items.map(item=>String(item.t.groupId || "")).filter(Boolean)));
    const unifiedGroup = selectedGroupIds.length === 1 ? getGroup(state,selectedGroupIds[0]) : null;

    for(let idx=0; idx<items.length; idx++){
      const {i,t,dueJPY} = items[idx];

      stopAlertLoop(i);

      let paidThisTime;

      if(manualTotal > 0 && defaultTotal > 0){
        if(idx === items.length - 1){
          paidThisTime = remaining;
        }else{
          paidThisTime = Math.round(groupTotalJPY * dueJPY / defaultTotal);
          remaining -= paidThisTime;
        }
      }else{
        paidThisTime = dueJPY;
      }

      const effectiveMethod = paymentLines.length
        ? Array.from(new Set(paymentLines.map(line=>line.method))).join("+")
        : groupPayMethod;
      t.pay = effectiveMethod;
      t.currency = "日元";

      const record = await createOrUpdateRecord(t);
      record.payments = normalizePayments(record);

      if(paidThisTime !== 0){
        settleRecordToFinalAmount(record,{
          finalAmountJPY:sumPaymentsJPY(record.payments) + paidThisTime,
          pay:effectiveMethod,
          reason:"整组代付补收",
          note:groupPayNote || `${groupPayerName || paymentLines.map(line=>line.payerName).filter(Boolean).join("、") || "未填写付款人"} 代付：${tableNames}`
        });
      }

      const paymentTotalJPY = sumPaymentsJPY(record.payments);

      t.paidJPY = paymentTotalJPY;
      t.paidRMB = getRMB(paymentTotalJPY);
      t.paidAt = Date.now();

      record.originalJPY = getOriginalJPY(t);
      record.totalJPY = paymentTotalJPY;
      record.totalRMB = sumPaymentsRMB(record.payments);
      record.paidJPY = paymentTotalJPY;
      record.dueJPY = Math.max(0, record.originalJPY - paymentTotalJPY);
      record.pay = getPaymentSummary(record.payments);
      record.currency = "日元";
      record.roundRule = "不抹零";
      record.paidStatus = Number(record.dueJPY || 0) > 0 ? "未结清" : "已结清";
      record.checkoutMethod = "整组代付";
      record.groupPaymentId = groupPaymentId;
      record.groupPayerName = groupPayerName;
      record.groupPaymentMethod = paymentLines.length ? paymentLines.map(line=>line.method).join("+") : groupPayMethod;
      record.groupPaymentLines = paymentLines;
      record.groupPaymentTotalJPY = groupTotalJPY;
      record.groupPaymentTableNames = tableNames;
      record.groupPaymentNote = groupPayNote;
      const now = Date.now();

record.closedAt = now;
record.closedTime = new Date(now).toLocaleString();

record.businessDate =
    record.businessDate ||
    getBusinessDateKey(record.startAt || record.timestamp || now);
      record.closedTime = new Date().toLocaleString();

      await updateRecordOnly(record);

      state.tables[i] = resetTable(t.name);
    }

    if(unifiedGroup){
      const lines = paymentLines.length ? paymentLines : [{
        payerName:groupPayerName,
        method:groupPayMethod,
        amountJPY:groupTotalJPY,
        coveredPeople:unifiedGroup.peopleCount || indexes.length
      }];
      unifiedGroup.paymentMode = lines.length === 1 ? "unified" : "split";
      unifiedGroup.payments = lines.map(line=>({
        id:`pay_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        payerName:line.payerName,
        method:line.method,
        amountJPY:line.amountJPY,
        coveredPeople:line.coveredPeople,
        coveredTableIndexes:indexes,
        note:groupPayNote,
        createdAt:Date.now(),
        referenceOnly:true
      }));
      unifiedGroup.updatedAt = Date.now();
    }
    await save();
    closeBatchCheckout();
    render();

    alert("整组付款结账完成");
    return;
  }

  const noPay = indexes.filter(i=>{
    return !document.getElementById(`batch-pay-${i}`)?.value;
  });

  if(noPay.length){
    alert("以下桌位还没有选择付款方式：\n" + noPay.map(i=>state.tables[i].name).join("、"));
    return;
  }

  if(!confirm(`确认批量结账 ${indexes.length} 桌吗？`)) return;

  for(const i of indexes){
    const t = state.tables[i];

    const pay = document.getElementById(`batch-pay-${i}`).value;
    const currency = currencyForPaymentMethod(pay);
    const manualAmount = Number(document.getElementById(`batch-amount-${i}`).value || 0);

    stopAlertLoop(i);

    t.pay = pay;
    t.currency = currency;

    const finalPaidJPY = manualAmount;

    const record = await createOrUpdateRecord(t);

    record.payments = normalizePayments(record);

    if(finalPaidJPY !== 0){
      settleRecordToFinalAmount(record,{
        finalAmountJPY:sumPaymentsJPY(record.payments) + finalPaidJPY,
        pay,
        reason:"批量续时补收",
        note:"批量结账记录"
      });
    }

    const paymentTotalJPY = sumPaymentsJPY(record.payments);

    t.paidJPY = paymentTotalJPY;
    t.paidRMB = getRMB(paymentTotalJPY);
    t.paidAt = Date.now();

    record.originalJPY = getOriginalJPY(t);
    record.totalJPY = paymentTotalJPY;
    record.totalRMB = sumPaymentsRMB(record.payments);
    record.paidJPY = paymentTotalJPY;
    record.dueJPY = Math.max(0, record.originalJPY - paymentTotalJPY);
    record.pay = getPaymentSummary(record.payments);
    record.currency = currency;
    record.roundRule = "不抹零";
    record.paidStatus = Number(record.dueJPY || 0) > 0 ? "未结清" : "已结清";
    record.checkoutMethod = "批量结账";

    const now = Date.now();

record.closedAt = now;
record.closedTime = new Date(now).toLocaleString();

record.businessDate =
    record.businessDate ||
    getBusinessDateKey(record.startAt || record.timestamp || now);


    await updateRecordOnly(record);

    state.tables[i] = resetTable(t.name);
  }

  await save();
  closeBatchCheckout();
  render();
}

function setGroupViewMode(value){
  groupViewMode = value === true || value === "group";
  render();
}

function openGroupManager(groupId=""){
  editingGroupId = String(groupId || "");
  const group = editingGroupId ? getGroup(state,editingGroupId) : null;
  document.getElementById("groupManagerTitle").innerText = group ? `管理组 ${group.id}` : "创建新组";
  document.getElementById("groupManagerName").value = group?.name || "";
  document.getElementById("groupManagerPaymentMode").value = group?.paymentMode || "split";
  const selected = new Set((group?.tableIndexes || []).map(Number));
  document.getElementById("groupManagerTables").innerHTML = state.tables.map((t,i)=>{
    const other = t.groupId && String(t.groupId)!==editingGroupId;
    return `<label class="table-item"><input type="checkbox" class="group-manager-table" value="${i}" ${selected.has(i)?"checked":""}><span class="num">${i+1}</span><span class="sub">${other ? `当前：${t.groupId}` : (t.start?"使用中":"空闲")}</span></label>`;
  }).join("");
  document.getElementById("groupManagerDelete").style.display = group ? "block" : "none";
  document.getElementById("groupManagerModalBg").style.display = "block";
}

function closeGroupManager(){
  document.getElementById("groupManagerModalBg").style.display = "none";
  editingGroupId = "";
}

async function syncTableRecordGroup(tableIndex){
  const table = state.tables?.[Number(tableIndex)];
  if(!table?.recordId) return;

  let record = getLocalRecordSync(table.recordId);
  if(!record){
    try{
      record = await Promise.race([
        getTableRecord(table),
        new Promise(resolve=>setTimeout(()=>resolve(null),1200))
      ]);
    }catch(_error){
      record = null;
    }
  }
  if(!record) return;

  if(table.groupId){
    record.groupId = String(table.groupId);
    record.groupName = String(table.groupName || "未命名组");
    record.groupColor = String(table.groupColor || table.activeColor || "#B7E4C7");
  }else{
    delete record.groupId;
    delete record.groupName;
    delete record.groupColor;
  }
  record.updatedAt = Date.now();
  await saveRecordSafely({db,ref,record});
}

async function saveGroupManager(){
  const button = document.getElementById("groupManagerSave");
  const originalText = button?.innerText || "保存组";
  try{
    const indexes = [...document.querySelectorAll(".group-manager-table:checked")].map(el=>Number(el.value));
    if(indexes.length < 1){ alert("请至少选择一张桌"); return; }
    if(button){ button.disabled = true; button.innerText = "正在保存…"; }

    const id = editingGroupId || await allocateGroupId(db,state.groups || []);
    if(!id) throw new Error("无法生成组 ID");

    // 保存变更前的成员范围。除了新选中的桌，也要同步从原组移出的桌位账单。
    const affectedIndexes = new Set(indexes);
    ensureGroups(state).forEach(g=>{
      const oldIndexes = (g.tableIndexes || []).map(Number);
      if(g.id === id || oldIndexes.some(i=>indexes.includes(i))){
        oldIndexes.forEach(i=>affectedIndexes.add(i));
      }
    });

    // 从其他组移除被重新分配的桌位，实现拆组与重组。
    ensureGroups(state).forEach(g=>{
      if(g.id === id) return;
      g.tableIndexes = (g.tableIndexes || []).map(Number).filter(i=>!indexes.includes(i));
      g.updatedAt = Date.now();
      syncGroupReferences(state,g);
    });
    const existing = getGroup(state,id);
    const group = upsertGroup(state,{
      ...(existing || {}),
      id,
      name:document.getElementById("groupManagerName").value.trim() || "未命名组",
      peopleCount:Math.max(1,indexes.length),
      paymentMode:document.getElementById("groupManagerPaymentMode").value || "split",
      color:existing?.color || "#B7E4C7",
      tableIndexes:indexes,
      updatedAt:Date.now()
    });
    syncGroupReferences(state,group);

    // 组与桌位状态保存后，将同一批桌位现有账单的 groupId 一并更新。
    // 今日账单读取的是 records 集合，不能只修改 shop/main 中的桌位。
    // 本机立即完成，窗口不再等待每张账单上传。
    emergencySaveState({db,ref,state,action:"manage_group"});
    closeGroupManager();
    render();

    save("manage_group").catch(error=>console.warn("组状态后台同步失败",error));
    Promise.all([...affectedIndexes].map(index=>syncTableRecordGroup(index)))
      .catch(error=>console.warn("组内账单后台同步失败",error));
  }catch(error){
    console.error("保存组失败",error);
    alert(`保存组失败：${error?.message || error}`);
  }finally{
    if(button){ button.disabled = false; button.innerText = originalText; }
  }
}

async function dissolveCurrentGroup(){
  const group = getGroup(state,editingGroupId);
  if(!group || !confirm(`确认拆散 ${group.id}？桌位和账单不会被删除。`)) return;
  (state.tables || []).forEach(t=>{
    if(String(t.groupId || "") === group.id){ t.groupId="";t.groupName="";t.groupColor=""; }
  });
  group.status = "dissolved";
  group.tableIndexes = [];
  group.updatedAt = Date.now();
  await save("dissolve_group");
  closeGroupManager();
  render();
}

function toggleSortDirection(){
  sortDirection = sortDirection === "asc" ? "desc" : "asc";

  const btn = document.getElementById("sortDirectionBtn");
  if(btn){
    btn.innerText = sortDirection === "asc" ? "当前：正序" : "当前：倒序";
  }

  render();
}

function toggleFilterPanel(){
  filterPanelOpen = !filterPanelOpen;

  const body = document.getElementById("filterPanelBody");
  const btn = document.getElementById("filterToggleBtn");

  if(body){
    body.style.display = filterPanelOpen ? "block" : "none";
  }

  if(btn){
    btn.innerText = filterPanelOpen ? "收起" : "展开";
  }
}


window.toggleSortDirection = toggleSortDirection;
window.setGroupViewMode = setGroupViewMode;
window.openGroupManager = openGroupManager;
window.closeGroupManager = closeGroupManager;
window.saveGroupManager = saveGroupManager;
window.dissolveCurrentGroup = dissolveCurrentGroup;
window.toggleFilterPanel = toggleFilterPanel;
window.roundBatchAmount = roundBatchAmount;
window.openBatchCheckout = openBatchCheckout;
window.closeBatchCheckout = closeBatchCheckout;
window.confirmBatchCheckout = confirmBatchCheckout;
window.openBatchStart = openBatchStart;
window.closeBatchStart = closeBatchStart;
window.confirmBatchStart = confirmBatchStart;
window.setSearchKeyword = setSearchKeyword;
window.setStatusFilter = setStatusFilter;
window.setTypeFilter = setTypeFilter;
window.setPayFilter = setPayFilter;
window.setPackage = setPackage;
window.setWalkin = setWalkin;
window.setBooking = setBooking;
window.start = start;
window.toggleTableCard = toggleTableCard;
window.setArrivalTimeDraft = setArrivalTimeDraft;
window.beginTableInteraction = beginTableInteraction;
window.finishTableInteractionSoon = finishTableInteractionSoon;
window.beginPreMinutesEdit = beginPreMinutesEdit;
window.updatePreMinutes = updatePreMinutes;
window.commitPreMinutesEdit = commitPreMinutesEdit;
window.toggleStartLock = toggleStartLock;
window.pause = pause;
window.resume = resume;
window.addHour = addHour;
window.undoHour = undoHour;
window.setPay = setPay;
window.setCurrency = setCurrency;
window.openCheckout = openCheckout;
window.toggleRound = toggleRound;
window.confirmCheckout = confirmCheckout;
window.openForceEnd = openForceEnd;
window.closeForceEnd = closeForceEnd;
window.confirmForceEnd = confirmForceEnd;
window.closeCheckout = closeCheckout;
window.openRefund = openRefund;
window.confirmRefund = confirmRefund;
window.closeRefund = closeRefund;
window.initPush = initPush;
window.updateCustomer = updateCustomer;
window.toggleType = toggleType;
window.roundBatchAmount = roundBatchAmount;
window.render = render;
window.setPayTiming = setPayTiming;
window.moveRunningTable = moveRunningTable;
window.refreshCheckoutDiff = refreshCheckoutDiff;
window.toggleGroupPayMode = toggleGroupPayMode;
window.addGroupPaymentLine = addGroupPaymentLine;
window.startRunningMoveDrag = startRunningMoveDrag;
window.confirmMoveRunningLine = confirmMoveRunningLine;
window.closeMoveRunningLineModal = closeMoveRunningLineModal;
window.addEventListener("DOMContentLoaded", updateNotifyButton);
