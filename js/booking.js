import { db } from "./firebase.js?v=4.0.63";
import { doc, onSnapshot, getDoc } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { setStateBaseline, saveStateSafely, installConnectionGuard, setSyncStatus, loadLocalState, getLocalStateSync, reconcileCloudState, flushPending, saveRecordSafely, atomicCheckInBooking } from "./safe-state.js?v=4.0.63";
import { resetTable } from "./common.js?v=4.0.63";
import { allocateGroupId, ensureGroups, getGroup, upsertGroup } from "./group-model.js?v=4.0.63";
import { jpyToRmb, currencyForPaymentMethod, repairRecordPaymentAmounts } from "./business-day.js?v=4.0.63";

const ref = doc(db, "shop", "main");
let state = null;
let lastBookingRenderKey = "";

function withoutBookingSyncMeta(value){
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

function getBookingRenderKey(candidate){
  return JSON.stringify({
    bookings:(candidate?.bookings || []).map(withoutBookingSyncMeta),
    tables:(candidate?.tables || []).map(table=>({
      name:table.name,
      start:table.start,
      pausedAt:table.pausedAt,
      extra:table.extra,
      packageIndex:table.packageIndex,
      bookingId:table.bookingId,
      groupId:table.groupId,
      groupName:table.groupName,
      groupColor:table.groupColor,
      activeColor:table.activeColor,
      customer:table.customer,
      type:table.type
    })),
    packages:candidate?.packages || []
  });
}

function shouldRenderBookingState(candidate){
  const key = getBookingRenderKey(candidate);
  if(key === lastBookingRenderKey) return false;
  lastBookingRenderKey = key;
  return true;
}

installConnectionGuard();
loadLocalState().then(local=>{
  if(local && !state){
    state = local;
    shouldRenderBookingState(state);
    try{ renderList(); renderBookingGrid(); startBookingAutoRefresh(); }catch(err){ console.warn("本机预约缓存显示失败",err); }
  }
});
window.addEventListener("chiptune-online-change",e=>{
  if(e.detail?.online) flushPending({db,ref}).catch(err=>console.warn("自动同步失败",err));
});

// 预约页必须立即接收计时器、账单页等同一设备页面的本地状态变化。
// 即使 Firestore 暂时同步失败，也不需要再靠“锁定/解锁”触发重绘。
window.addEventListener("chiptune-state-broadcast", event=>{
  const incoming = event.detail?.state;
  if(!incoming) return;

  state = incoming;
  if(!Array.isArray(state.bookings)) state.bookings = [];
  if(!Array.isArray(state.customers)) state.customers = [];
  if(!Array.isArray(state.tables)) state.tables = [];
  ensureGroups(state);

  if(!shouldRenderBookingState(state)) return;

  try{
    renderBookingGridPreservingScroll();
    renderList();
  }catch(error){
    console.warn("预约页即时刷新失败", error);
  }
});

window.addEventListener("storage", event=>{
  if(event.key !== "chiptune_state_shadow_v2" || !event.newValue) return;
  try{
    const box = JSON.parse(event.newValue);
    if(!box?.state) return;
    state = box.state;
    ensureGroups(state);
    if(!shouldRenderBookingState(state)) return;
    renderBookingGridPreservingScroll();
    renderList();
  }catch(error){
    console.warn("预约页读取跨页面备份失败", error);
  }
});

let activeBookingId = null;
let bookingDetailInitialSnapshot = null;
let bookingDetailClosing = false;
let checkInSubmitting = false;
let bookingLocked = true;
let currentBookingDate = getTodayDate();
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedCalendarDate = currentBookingDate;
let bookingListOpen = false;
let moveBookingId = null;
let assignBookingId = null;
let movePairs = [];
let moveMode = "booking";
let moveRunningFromIndex = null;
let draggingMoveFrom = null;
let moveLineRAF = null;
let lastMovePointer = null;
let runningPayTableIndex = null;
let dragTempLine = null;
let moveAreaRect = null;
let dragFromCenter = null;
let bookingAutoRefreshTimer = null;
let runningTimeTextTimer = null;
let lastBookingSafetyRefreshKey = "";
let quickBookingInitialized = false;
let quickBookingOpen = false;
const repairingTableRecords = new Set();


const MOVE_LINE_COLORS = [
  "#e85d5d",
  "#2b6fc9",
  "#54a66b",
  "#ff9800",
  "#8e44ad",
  "#00a6a6"
];

const BOOKING_COLORS = [
  "#B7E4C7",
  "#A9DEF9",
  "#FFD6A5",
  "#D8B4FE",
  "#FFCAD4",
  "#FDFFB6",
  "#C7F9CC",
  "#FEC5BB",
  "#BDE0FE",
  "#E9C46A",
  "#CDEAC0",
  "#F1C0E8"
];

function getNextBookingColor(){
  const count = Array.isArray(state?.bookings)
    ? state.bookings.length
    : 0;

  return BOOKING_COLORS[
    count % BOOKING_COLORS.length
  ];
}

async function makeGroupId(){
  return allocateGroupId(db, state?.groups || []);
}

function makeFastBookingGroupId(bookingId = Date.now()){
  const d = new Date();
  const dateKey = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
  const suffix = `${Number(bookingId).toString(36)}_${Math.random().toString(36).slice(2,7)}`;
  return `${dateKey}_BK_${suffix}`;
}

function getGroupById(groupId){
  return getGroup(state, groupId);
}

function createOrUpdateGroup({
  groupId,
  groupName,
  groupColor,
  tableIndexes = [],
  bookingId = null,
  peopleCount = null,
  paymentMode = null
}){
  const existing = getGroupById(groupId);
  const group = upsertGroup(state, {
    ...(existing || {}),
    id:groupId,
    name:groupName || existing?.name || "未命名组",
    color:groupColor || existing?.color || getNextBookingColor(),
    tableIndexes:Array.from(new Set([...(existing?.tableIndexes || []),...tableIndexes].map(Number).filter(Number.isFinite))),
    bookingIds:Array.from(new Set([...(existing?.bookingIds || []),...(bookingId === null || bookingId === undefined ? [] : [String(bookingId)])])),
    peopleCount:peopleCount || existing?.peopleCount || Math.max(1,tableIndexes.length),
    paymentMode:paymentMode || existing?.paymentMode || "split",
    updatedAt:Date.now()
  });
  return group;
}


function darkenColor(hex, amount = 28){
  hex = String(hex || "#B7E4C7").replace("#","");
  const num = parseInt(hex,16);

  let r = (num >> 16) - amount;
  let g = ((num >> 8) & 255) - amount;
  let b = (num & 255) - amount;

  r = Math.max(0,r);
  g = Math.max(0,g);
  b = Math.max(0,b);

  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b)
    .toString(16)
    .slice(1);
}

function getRunningColor(t){
  return t.activeColor || "#B7E4C7";
}

onSnapshot(ref, { includeMetadataChanges:true }, async snap=>{
  if(!snap.exists()) return;

  state = await reconcileCloudState(snap.data());
  if(!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) setStateBaseline(snap.data());
  if(snap.metadata.fromCache) setSyncStatus("cache");

  if(!state.bookings) state.bookings = [];
  if(!state.customers) state.customers = [];
  ensureGroups(state);
  state.bookings.forEach(b=>{
  if(!b.groupId) b.groupId = `legacy_${b.id}`;
  if(!b.groupColor) b.groupColor = b.color || getNextBookingColor();
  if(!b.groupName) b.groupName = "预约组";
  if(!b.color) b.color = b.groupColor;
  createOrUpdateGroup({
    groupId:b.groupId,
    groupName:b.groupName,
    groupColor:b.groupColor,
    tableIndexes:b.tableIndexes || [],
    bookingId:b.id,
    peopleCount:b.peopleCount || b.partySize || Math.max(1,(b.tableIndexes || []).length)
  });
});
  if(!Array.isArray(state.tables) || state.tables.length === 0){
    state.tables = Array.from({length:12},(_,i)=>({
      name:(i+1)+"号桌"
    }));
  }
  /*
   * 只有服务器已经确认的快照才能触发缺失账单修复。
   * 缓存快照和本机待写入快照可能暂时没有 recordId，旧实现会把这种
   * 正常同步延迟误判成账单丢失，从而为同一次到店反复创建随机ID账单。
   */
  if(!snap.metadata.fromCache && !snap.metadata.hasPendingWrites){
    repairMissingRunningTableRecords().catch(error=>{
      console.warn("检查缺失计时账单失败",error);
    });
  }


if(!shouldRenderBookingState(state)){
  startBookingAutoRefresh();
  return;
}

try{
  renderList();
  renderBookingGrid();
  startBookingAutoRefresh();
}catch(error){
  console.error("预约页面渲染失败",error);

  alert(
    "预约页面渲染失败：\n" +
    (error?.message || String(error))
  );
}

}, error => {
  console.error("预约数据监听失败",error);

  alert(
    "预约数据读取失败：\n\n" +
    (error?.code || error?.name || "未知错误") +
    "\n" +
    (error?.message || String(error))
  );

  /*
   * 云端失败时，已有本地状态仍然可以显示。
   */
  if(state){
    try{
      renderList();
      renderBookingGrid();
      startBookingAutoRefresh();
    }catch(renderError){
      console.error(
        "本机预约状态显示失败",
        renderError
      );
    }
  }
});


async function save(action="booking_update"){
  /*
   * 创建/编辑预约只允许修改预约相关数据。
   *
   * 预约页可能在计时器刚开始后的极短时间内仍持有旧桌台快照。
   * 如果直接保存整份 state，旧快照会把已经开始的桌位覆盖成“未开始”。
   * 因此预约资料类操作保存前，先读取本机最新状态，并仅把预约、分组、
   * 客户数据覆盖进去；桌台运行状态始终采用计时器写入的最新版本。
   */
  if(action === "create_booking" || action === "booking_detail_update"){
    const latest = getLocalStateSync();

    if(latest){
      const bookingData = Array.isArray(state?.bookings) ? state.bookings : [];
      const groupData = Array.isArray(state?.groups) ? state.groups : [];
      const customerData = state?.customers || {};

      state = {
        ...latest,
        bookings:bookingData,
        groups:groupData,
        customers:customerData
      };
    }
  }

  return saveStateSafely({db, ref, getState:()=>state, action});
}


function getCustomerKey(name, phone){
  name = String(name || "").trim();
  phone = String(phone || "").slice(-4);

  if(!name || !phone) return "";

  return `${name}_${phone}`;
}

function addCustomerVisit({
  name,
  phone,
  packageIndex,
  tableIndexes,
  startTime,
  endTime
}){
  const key =
    getCustomerKey(name,phone);

  if(!key) return;

  if(
    !state.customers ||
    Array.isArray(state.customers) ||
    typeof state.customers !== "object"
  ){
    const oldCustomers =
      Array.isArray(state.customers)
        ? state.customers
        : [];

    state.customers = {};

    oldCustomers.forEach(customer=>{
      if(!customer) return;

      const oldKey =
        customer.key ||
        getCustomerKey(
          customer.name,
          customer.phoneLast4
        );

      if(!oldKey) return;

      state.customers[oldKey] = {
        ...customer,
        key:oldKey,
        visits:Array.isArray(customer.visits)
          ? customer.visits
          : []
      };
    });
  }

  let customer =
    state.customers[key];

  if(!customer){
    customer = {
      key,
      name,
      phoneLast4:String(phone || "").slice(-4),
      visitCount:0,
      firstVisitAt:Date.now(),
      lastVisitAt:Date.now(),
      visits:[]
    };

    state.customers[key] = customer;
  }

  if(!Array.isArray(customer.visits)){
    customer.visits = [];
  }

  const p =
    state.packages?.[Number(packageIndex)] || {};

  const tableNames = tableIndexes
    .map(i=>state.tables[i]?.name)
    .filter(Boolean)
    .join("、");

  const now = Date.now();

  customer.visits.push({
    id:
      "visit_" +
      now +
      "_" +
      Math.random().toString(36).slice(2,8),

    date:currentBookingDate,
    startAt:now,
    endAt:null,
    range:`${startTime || "-"}-${endTime || "-"}`,
    tableName:tableNames,
    tableNames,
    customerType:"booking",
    packageName:p.name || "",
    packageMinutes:p.unlimited
      ? "不限时"
      : Number(p.minutes || 0),
    extraMinutes:0,
    totalJPY:Number(p.price || 0),
    pay:"",
    closed:false,
    createdAt:now
  });

  customer.name =
    name || customer.name || "";

  customer.phoneLast4 =
    String(phone || customer.phoneLast4 || "")
      .slice(-4);

  customer.visitCount =
    customer.visits.length;

  customer.lastVisitAt = now;
}


function normalizeBookingPayments(record){
  if(Array.isArray(record?.payments)) return repairRecordPaymentAmounts(record).record.payments;
  if(Number(record?.totalJPY || 0) > 0){
    return [{
      type:"收入",
      reason:"历史套餐付款",
      pay:record.pay || "未记录",
      currency:currencyForPaymentMethod(record.pay),
      amountJPY:Number(record.totalJPY || 0),
      amountRMB:jpyToRmb(record.totalJPY || 0),
      timestamp:Number(record.timestamp || Date.now()),
      time:record.time || new Date().toLocaleString()
    }];
  }
  return [];
}

function sumBookingPayments(payments){
  return (payments || []).reduce((sum,p)=>sum + Number(p?.amountJPY || 0),0);
}

function allocateGroupPrepayments(group, tableIndexes, fallbackPackageIndex = 0){
  const result = new Map(tableIndexes.map(i=>[Number(i),[]]));
  const remainingCapacity = new Map();
  tableIndexes.forEach(i=>{
    const t = state.tables[Number(i)] || {};
    const p = state.packages?.[Number(t.start ? (t.packageIndex || 0) : fallbackPackageIndex)] || {};
    remainingCapacity.set(Number(i), Number(p.price || 0));
  });

  for(const payment of (group?.payments || []).filter(p=>p && p.referenceOnly)){
    let remaining = Number(payment.amountJPY || 0);
    if(remaining <= 0) continue;
    for(const rawIndex of tableIndexes){
      const index = Number(rawIndex);
      const capacity = Number(remainingCapacity.get(index) || 0);
      if(capacity <= 0) continue;
      const amount = Math.min(capacity, remaining);
      if(amount > 0){
        result.get(index).push({
          type:"收入",
          reason:"整组套餐预付款",
          pay:payment.pay || payment.method || "未记录",
          currency:currencyForPaymentMethod(payment.pay || payment.method),
          amountJPY:amount,
          amountRMB:jpyToRmb(amount),
          note:payment.note || "同组统一收款",
          timestamp:Number(payment.createdAt || Date.now()),
          time:payment.createdTime || new Date(payment.createdAt || Date.now()).toLocaleString(),
          source:"group-prepayment",
          groupPaymentId:payment.id
        });
        remainingCapacity.set(index, capacity - amount);
        remaining -= amount;
      }
      if(remaining <= 0) break;
    }
  }
  return result;
}

async function syncGroupPrepaymentsToRunningTables(booking, group){
  const allIndexes = (booking.tableIndexes || [booking.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);
  const allocations = allocateGroupPrepayments(group, allIndexes, booking.packageIndex || 0);

  for(const index of allIndexes){
    const t = state.tables[index];
    if(!t?.start || !t.recordId) continue;
    let record = null;
    try{
      const snap = await getDoc(doc(db,"records",t.recordId));
      if(snap.exists()) record = {id:snap.id,...snap.data()};
    }catch(err){
      console.warn("读取组内账单失败",err);
    }
    if(!record) continue;
    const existing = normalizeBookingPayments(record)
      .filter(p=>p?.source !== "group-prepayment" && p?.reason !== "整组套餐预付款");
    // 一旦使用整组收款，移除自动生成但没有付款依据的套餐行，避免重复。
    const preserved = existing.filter(p=>
      p?.reason !== "套餐预付款" &&
      p?.reason !== "整组套餐预付款"
    );
    record.payments = [...(allocations.get(index) || []), ...preserved];
    const paid = sumBookingPayments(record.payments);
    const p = state.packages?.[Number(t.packageIndex || 0)] || {};
    const original = Number(record.originalJPY || p.price || 0);
    record.paidJPY = paid;
    record.totalJPY = paid;
    record.totalRMB = jpyToRmb(paid);
    record.dueJPY = Math.max(0, original - paid);
    record.paidStatus = record.dueJPY > 0 ? "未结清" : "已结清";
    record.pay = [...new Set(record.payments.filter(x=>Number(x.amountJPY||0)!==0).map(x=>x.pay||"未记录"))].join("+") || "未记录";
    t.paidJPY = paid;
    t.paidRMB = jpyToRmb(paid);
    await saveRecordSafely({db,ref,record});
  }
}

async function createOrUpdateTableRecord(t, {
  customerType = "walkin",
  checkoutMethod = "开始计时",
  prepaidLines = null,
  deterministicRecordId = ""
} = {}){

  const p = state.packages?.[Number(t.packageIndex || 0)] || {};
  const packagePrice = Number(p.price || 0);
  const now = Date.now();

  let record = null;

  if(t.recordId){
    const snap = await getDoc(doc(db, "records", t.recordId));
    if(snap.exists()){
      record = {id:snap.id,...snap.data()};
    }
  }

  if(!record){
    const nextRecordId = deterministicRecordId ||
      "rec_" + now + "_" + Math.random().toString(36).slice(2,8);
    record = {
      id:nextRecordId,
      timestamp:now,
      time:new Date(now).toLocaleString(),
      receiptImage:"",
      receiptFileName:""
    };

    t.recordId = record.id;
  }

  record.timestamp = record.timestamp || now;
  record.time = record.time || new Date(now).toLocaleString();


  record.groupId = t.groupId || "";
  record.groupColor = t.groupColor || t.activeColor || "";
  record.groupName = t.groupName || "";
  record.tableName = t.name;
  record.customerName = t.customer?.name || "";
  record.phoneLast4 = t.customer?.phoneLast4 || "";
  record.customerType = customerType;

  record.packageName = p.name || "";
  record.packageMinutes = p.unlimited ? "不限时" : p.minutes;
  record.packagePrice = packagePrice;

  record.extraMinutes = Math.floor(Number(t.extra || 0) / 60000);
  record.extensionAmount = 0;
  record.originalJPY = packagePrice;

  if(Array.isArray(prepaidLines)){
    record.payments = prepaidLines;
  }else if(!Array.isArray(record.payments) || record.payments.length === 0){
    record.payments = t.pay ? [{
      type:"收入",
      reason:"套餐预付款",
      pay:t.pay,
      currency:currencyForPaymentMethod(t.pay),
      amountJPY:packagePrice,
      amountRMB:jpyToRmb(packagePrice),
      note:"预约到店时已确认收款",
      timestamp:now,
      time:new Date(now).toLocaleString(),
      source:"manual"
    }] : [];
  }

  const paidJPY = sumBookingPayments(record.payments);
  record.paidJPY = paidJPY;
  record.dueJPY = Math.max(0, packagePrice - paidJPY);
  record.totalJPY = paidJPY;
  record.totalRMB = jpyToRmb(paidJPY);

  record.pay = [...new Set(record.payments.filter(x=>Number(x.amountJPY||0)!==0).map(x=>x.pay||"未记录"))].join("+") || "未记录";
  record.currency = t.pay ? currencyForPaymentMethod(t.pay) : "日元";
  record.payTiming = "prepaid";

  record.paidStatus = record.dueJPY > 0 ? "未结清" : "已结清";
  record.recordType = "prepaid";
  record.checkoutMethod = checkoutMethod;
  record.roundRule = "不抹零";

  t.paidJPY = paidJPY;
  t.paidRMB = jpyToRmb(paidJPY);
  t.paidAt = paidJPY > 0 ? now : null;

  await saveRecordSafely({db,ref,record});

  return record;
}

function repairedRecordIdForTable(table, tableIndex){
  const stableVisitKey =
    table?.visitId ||
    table?.recordId ||
    `${table?.bookingId || table?.groupId || "table"}_${Number(table?.start || 0)}`;
  const safeKey = String(stableVisitKey).replace(/[^a-zA-Z0-9_-]/g,"_");
  return `rec_repair_${String(Number(tableIndex) + 1).padStart(2,"0")}_${safeKey}`;
}

async function repairMissingRunningTableRecords(){
  if(!state?.tables?.length) return;
  let needSave = false;

  await Promise.all(state.tables.map(async (table,tableIndex)=>{
    if(!table?.start || table.recordId) return;

    const repairKey = `${tableIndex}:${table.visitId || table.bookingId || table.groupId || table.start}`;
    if(repairingTableRecords.has(repairKey)) return;
    repairingTableRecords.add(repairKey);

    try{
      const deterministicRecordId = repairedRecordIdForTable(table,tableIndex);
      table.recordId = deterministicRecordId;
      await createOrUpdateTableRecord(table,{
        customerType:table.type === "booking" ? "booking" : "walkin",
        checkoutMethod:"补写开始计时账单",
        deterministicRecordId
      });
      needSave = true;
    }finally{
      repairingTableRecords.delete(repairKey);
    }
  }));

  if(needSave){
    await save("repair_missing_table_record");
  }
}


function getTodayDate(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

let selecting = false;
let selection = null;

const DEFAULT_BUSINESS_HOURS = {
  weekdayOpen: 12,
  weekdayClose: 22,
  weekendOpen: 10,
  weekendClose: 22
};

const SLOT_MINUTES = 30;

function getBusinessHours(){
  const hours = state.businessHours || DEFAULT_BUSINESS_HOURS;
  const d = new Date(currentBookingDate);
  const day = d.getDay();
  const isWeekend = day === 0 || day === 6;

  return {
    open: isWeekend ? Number(hours.weekendOpen || 10) : Number(hours.weekdayOpen || 12),
    close: isWeekend ? Number(hours.weekendClose || 22) : Number(hours.weekdayClose || 22)
  };
}

function getSlots(){
  const {open, close} = getBusinessHours();
  const slots = [];

  for(let h = open; h < close; h++){
    slots.push(`${String(h).padStart(2,"0")}:00`);
    slots.push(`${String(h).padStart(2,"0")}:30`);
  }

  slots.push(`${String(close).padStart(2,"0")}:00`);

  return slots;
}



function timeToMinutes(time){
  const [h,m] = String(time || "00:00").split(":").map(Number);
  return h * 60 + m;
}

function findPackageIndexByDuration(startTime,endTime){
  const minutes =
    timeToMinutes(endTime) - timeToMinutes(startTime);

  const packages = state.packages || [];

  const d = new Date(currentBookingDate);
  const day = d.getDay();
  const isWeekend = day === 0 || day === 6;

  const exactIndex = packages.findIndex(p=>{
    return !p.unlimited &&
           Number(p.minutes || 0) === minutes;
  });

  if(exactIndex >= 0){
    return exactIndex;
  }

  if(!isWeekend){
    const unlimitedIndex = packages.findIndex(p=>{
      return p.unlimited;
    });

    if(unlimitedIndex >= 0){
      return unlimitedIndex;
    }
  }

  return 0;
}

function isTableBusyAtSlot(t, rowIndex){
  // 只有查看“今天”时，才需要让正在使用中的桌位占用时间表
  // 查看明天/后天预约时，不应该被今天的计时占住
  if(currentBookingDate !== getTodayDate()){
    return false;
  }

  if(!t.start) return false;
  const slots = getSlots();
  const slotTime = slots[rowIndex];
  if(!slotTime) return false;

  const [hh, mm] = slotTime.split(":").map(Number);

  const slotDate = new Date(currentBookingDate);
  slotDate.setHours(hh, mm, 0, 0);

  const slotStart = slotDate.getTime();
  const slotEnd = slotStart + SLOT_MINUTES * 60000;

  const p = state.packages?.[t.packageIndex] || {};
  const busyStart = Number(t.start);

  let busyEnd;

  if(p.unlimited || Number(p.minutes || 0) === 0){
    const closeDate = new Date(currentBookingDate);
    closeDate.setHours(getBusinessHours().close, 0, 0, 0);
    busyEnd = closeDate.getTime();
  }else{
    const baseMinutes = Number(p.minutes || 0);
    const extraMinutes = Number(t.extra || 0) / 60000;
    busyEnd = busyStart + (baseMinutes + extraMinutes) * 60000;
  }

  return slotStart < busyEnd && slotEnd > busyStart;
}

function formatShortTime(ms){
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}` : `${m}分`;
}

function getTableStatusText(t){
  if(!t.start) return "";

  const p = state.packages?.[t.packageIndex] || {};
  const elapsed = Date.now() - Number(t.start);

  if(p.unlimited || Number(p.minutes || 0) === 0){
    return {
      text:`已用 ${formatShortTime(elapsed)}`,
      className:"slot-running"
    };
  }

  const limit = Number(p.minutes || 0) * 60000 + Number(t.extra || 0);
  const remain = limit - elapsed;

  if(remain <= 0){
    return {
      text:`超时 ${formatShortTime(Math.abs(remain))}`,
      className:"slot-overtime"
    };
  }

  if(remain <= 10 * 60000){
    return {
      text:`剩 ${formatShortTime(remain)}`,
      className:"slot-warning"
    };
  }

  return {
    text:`剩 ${formatShortTime(remain)}`,
    className:"slot-normal"
  };
}


function isTableUsedAtSlot(t,rowIndex){
  if(!t.start) return false;

  const slots = getSlots();
  const slotTime = slots[rowIndex];
  if(!slotTime) return false;

  const [hh,mm] = slotTime.split(":").map(Number);

  const slotDate = new Date(currentBookingDate);
  slotDate.setHours(hh,mm,0,0);

  const slotStart = slotDate.getTime();
  const slotEnd = slotStart + SLOT_MINUTES * 60000;

  const usedStart = Number(t.start);
  const usedEnd = Number(t.pausedAt || Date.now());

  return slotStart < usedEnd && slotEnd > usedStart;
}

function isPastTimeSlot(rowIndex){
  const slots = getSlots();
  const slotTime = slots[rowIndex];
  if(!slotTime) return false;

  const [hh, mm] = slotTime.split(":").map(Number);

  const slotDate = new Date(currentBookingDate);
  slotDate.setHours(hh, mm + SLOT_MINUTES, 0, 0);

  return slotDate.getTime() <= Date.now();
}

function renderBookingGrid(){
  if(!state) return;

  const box = document.getElementById("bookingGrid");
  if(!box){
    alert("找不到 bookingGrid");
    return;
  }

  if(!Array.isArray(state.tables) || state.tables.length === 0){
    alert("没有桌位数据");
    return;
  }

  const slots = getSlots();

  const title = document.getElementById("bookingDateTitle");
  if(title){
    title.innerText =
      currentBookingDate === getTodayDate()
        ? "今日预约时间表"
        : currentBookingDate + " 预约时间表";
  }

  box.innerHTML = `
    <div class="booking-grid" style="grid-template-columns:80px repeat(${state.tables.length}, 1fr);">
      <div class="grid-head time-head">时间</div>

      ${state.tables.map((t,tableIndex)=>{
  const usingToday = slots.some((_,rowIndex)=>{
    return isTableBusyAtSlot(t,rowIndex);
  });

  return `
    <div class="grid-head ${usingToday ? "table-using" : ""}">
      ${t.name}${usingToday ? " 使用中" : ""}
    </div>
  `;
}).join("")}

${slots.slice(0,-1).map((time,rowIndex)=>`
        <div class="time-cell ${isPastTimeSlot(rowIndex) ? "past-time-cell" : ""}">
          ${time}
        </div>
        ${state.tables.map((t,tableIndex)=>{

          const busy = isTableBusyAtSlot(t,rowIndex);
          const used = isTableUsedAtSlot(t,rowIndex);
          const statusInfo = busy ? getTableStatusText(t) : null;
return `
  <div
      class="slot-cell ${isPastTimeSlot(rowIndex) ? "past-slot" : ""} ${busy ? "disabled-slot" : ""} ${used ? "used-slot" : ""} ${statusInfo?.className || ""}"
      data-table="${tableIndex}"
      data-row="${rowIndex}"

      ${busy || bookingLocked ? "" : `
  onpointerdown="startSelectSlot(event,${tableIndex},${rowIndex})"
  onpointermove="moveSelectByPoint(event)"
  onpointerup="endSelectSlot(event)"
  onpointercancel="endSelectSlot(event)"
`}

    >
</div>
  `;
}).join("")}
`).join("")}
    </div>
  `;

drawExistingBookings();
  drawRunningTables();
  updateBookingLockUI();
  renderQuickBookingForm();
  startRunningTimeTextTimer();
}

function renderBookingGridPreservingScroll(){
  const scroller =
    document.querySelector(".booking-grid-wrap") ||
    document.getElementById("bookingGrid");
  const left = scroller ? scroller.scrollLeft : 0;
  const top = scroller ? scroller.scrollTop : 0;

  renderBookingGrid();

  requestAnimationFrame(()=>{
    const current =
      document.querySelector(".booking-grid-wrap") ||
      document.getElementById("bookingGrid");
    if(current){
      current.scrollLeft = left;
      current.scrollTop = top;
    }
  });
}

function startBookingAutoRefresh(){
  if(bookingAutoRefreshTimer) return;

  bookingAutoRefreshTimer = setInterval(()=>{
    if(!state) return;
    if(selecting) return;
    if(draggingMoveFrom !== null) return;

    const openedModal = [...document.querySelectorAll(".modal-bg")]
      .some(el=>el.style.display === "block");

    if(openedModal) return;

    loadLocalState().then(local=>{
      if(!local) return;

      const key = getBookingRenderKey(local);

      // BroadcastChannel、storage 和 Firestore 监听已经负责即时刷新。
      // 这里只在确实漏掉事件且本机数据发生变化时才重建时间表。
      if(key === lastBookingSafetyRefreshKey) return;
      lastBookingSafetyRefreshKey = key;
      if(!shouldRenderBookingState(local)) return;
      state = local;
      renderBookingGridPreservingScroll();
      renderList();
    }).catch(error=>console.warn("预约自动刷新读取本机状态失败", error));

  },10000);
}

document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState === "visible" && state){
    renderBookingGrid();
    renderList();
  }
});

function updateBookingLockUI(){
  const btn = document.getElementById("bookingLockBtn");
  const hint = document.getElementById("bookingLockHint");
  const grid = document.getElementById("bookingGrid");

  if(btn){
    btn.innerText = bookingLocked ? "🔒 已锁定" : "🔓 已解锁";
    btn.className = bookingLocked ? "btn-danger" : "btn-success";
  }

  if(hint){
    hint.innerText = bookingLocked
      ? "当前为锁定状态，只能查看，不能创建/修改预约"
      : "当前为解锁状态，可以创建/修改预约，操作完成后请重新锁定";

    hint.className = bookingLocked
      ? "booking-lock-hint locked"
      : "booking-lock-hint unlocked";
  }

  if(grid){
    grid.classList.toggle("locked-grid", bookingLocked);
    grid.classList.toggle("unlocked-grid", !bookingLocked);
  }

}

function toggleBookingLock(){
  bookingLocked = !bookingLocked;
  updateBookingLockUI();
  renderBookingGrid();
}

function getBookingTableIndexes(booking){
  return (Array.isArray(booking?.tableIndexes) ? booking.tableIndexes : [booking?.tableIndex])
    .filter(v=>v !== undefined && v !== null && v !== "")
    .map(Number)
    .filter(Number.isFinite);
}

// 预约状态不能只依赖 checkedIn 布尔值。
// 计时器、结账和旧版本数据可能只更新了桌位或 finishedTableIndexes，
// 因此预约页每次渲染都根据当前桌位状态重新推导“未到店 / 已到店 / 已离店”。
function getBookingVisitStatus(booking){
  const indexes = getBookingTableIndexes(booking);
  const runningIndexes = indexes.filter(index=>{
    const table = state.tables?.[index];
    if(!table?.start) return false;
    if(table.bookingId !== undefined && table.bookingId !== null && table.bookingId !== ""){
      return Number(table.bookingId) === Number(booking.id);
    }
    return table.type === "booking"
      && (!booking.name || table.customer?.name === booking.name)
      && (!booking.phone || String(table.customer?.phoneLast4 || "") === String(booking.phone || "").slice(-4));
  });

  const finished = new Set(
    (Array.isArray(booking.finishedTableIndexes) ? booking.finishedTableIndexes : [])
      .map(Number)
      .filter(Number.isFinite)
  );

  if(runningIndexes.length > 0){
    booking.checkedIn = true;
    booking.completed = false;
    booking.checkedOut = false;
    booking.checkedInTableIndexes = Array.from(new Set([
      ...(Array.isArray(booking.checkedInTableIndexes) ? booking.checkedInTableIndexes : []).map(Number),
      ...runningIndexes
    ])).filter(Number.isFinite);
    return {key:"arrived", text:"已到店", className:"booking-list-done"};
  }

  const allFinished = indexes.length > 0 && indexes.every(index=>finished.has(index));
  if(booking.completed || booking.checkedOut || allFinished){
    booking.checkedIn = false;
    booking.completed = true;
    booking.checkedOut = true;
    return {key:"finished", text:"已离店", className:"booking-list-finished"};
  }

  return {key:"waiting", text:"未到店", className:"booking-list-wait"};
}

function renderList(){
  const box = document.getElementById("list");
  const summary = document.getElementById("bookingSummary");
  const btn = document.getElementById("bookingListToggleBtn");

  if(!box) return;

  const bookings = (state.bookings || [])
    .filter(b=>!b?.cancelled && (b.date || getTodayDate()) === currentBookingDate)
    .sort((a,b)=>String(a.startTime || "99:99").localeCompare(String(b.startTime || "99:99")));

  const visitStatuses = new Map(bookings.map(b=>[String(b.id), getBookingVisitStatus(b)]));
  const checked = bookings.filter(b=>visitStatuses.get(String(b.id))?.key === "arrived").length;
  const finished = bookings.filter(b=>visitStatuses.get(String(b.id))?.key === "finished").length;
  const waiting = bookings.filter(b=>visitStatuses.get(String(b.id))?.key === "waiting").length;

  const tableTotal = bookings.reduce((sum,b)=>{
    return sum + (b.tableIndexes || [b.tableIndex])
      .filter(v=>v !== undefined && v !== null)
      .length;
  },0);

  if(summary){
    summary.innerHTML =
      `未到店：${waiting}组｜已到店：${checked}组｜已离店：${finished}组｜预约桌数：${tableTotal}桌`;
  }

  if(btn){
    btn.innerText = bookingListOpen ? "收起" : "展开";
  }

  box.style.display = bookingListOpen ? "block" : "none";

  if(bookings.length === 0){
    box.innerHTML = `<p style="color:#8a8174;">这一天暂无预约</p>`;
    return;
  }

  box.innerHTML = bookings.map(b=>{
    const visitStatus = visitStatuses.get(String(b.id)) || getBookingVisitStatus(b);
    const tables = (b.tableIndexes || [b.tableIndex])
      .filter(v=>v !== undefined && v !== null)
      .map(idx=>state.tables[Number(idx)]?.name)
      .filter(Boolean)
      .join("、");

    return `
      <div class="booking-list-item ${visitStatus.className}">
        <div class="booking-list-time">
          ${b.startTime || "-"} - ${b.endTime || "-"}
        </div>

        <div class="booking-list-main">
  <strong>${b.name || "-"}</strong>
  <span>${String(b.phone || "").slice(-4) || "-"}</span>

  ${
    b.source === "官网"
      ? `<span class="booking-source">官网</span>`
      : ""
  }
</div>

        <div class="booking-list-sub">

桌位：

${
tables || "<span style='color:red'>未分配</span>"
}

｜

${visitStatus.text}

</div>
        ${bookingLocked ? "" : `
         <div class="action-row">

${
(b.tableIndexes || []).length === 0

?

`<button class="btn-main"
onclick="openAssignTableModal(${b.id})">
分配桌位
</button>`

:

`<button class="btn-success"
onclick="openCheckInSelectModal(${b.id})">
进入计时器
</button>`
}

<button class="btn-main"
onclick="openBookingAction(${b.id})">
修改
</button>

<button class="btn-ghost"
onclick="openMoveTableModal(${b.id})">
移动桌位
</button>

<button class="btn-danger"
onclick="cancelBookingById(${b.id})">
取消
</button>

</div>

        `}
      </div>
    `;
  }).join("");
}

function toggleBookingList(){
  bookingListOpen = !bookingListOpen;
  renderList();
}

function checkInBookingById(id){
  activeBookingId = id;
  checkInBooking();
}

function cancelBookingById(id){
  activeBookingId = id;
  cancelBooking();
}

function hasBookingConflict(targetIndex, booking, excludeBookingId){
  const target = Number(targetIndex);
  const targetDate = booking?.date || currentBookingDate;
  const startA = timeToMinutes(booking?.startTime);
  const endA = timeToMinutes(booking?.endTime);

  return (state.bookings || []).some(b=>{
    if(Number(b.id) === Number(excludeBookingId)) return false;
    if(b?.cancelled) return false;
    if((b.date || currentBookingDate) !== targetDate) return false;

    const indexes = (b.tableIndexes || [b.tableIndex])
      .filter(v=>v !== undefined && v !== null)
      .map(Number);

    if(!indexes.includes(target)) return false;

    const startB = timeToMinutes(b.startTime);
    const endB = timeToMinutes(b.endTime);

    // 首尾刚好相接不算重叠，例如 12:00-13:00 与 13:00-14:00 可以连续预约。
    return startA < endB && endA > startB;
  });
}

function findBookingConflicts({date, tableIndexes, startTime, endTime, excludeBookingId = null}){
  const targets = new Set((tableIndexes || []).map(Number));
  const startA = timeToMinutes(startTime);
  const endA = timeToMinutes(endTime);

  return (state.bookings || []).filter(b=>{
    if(Number(b.id) === Number(excludeBookingId)) return false;
    if(b?.cancelled) return false;
    if((b.date || currentBookingDate) !== date) return false;

    const indexes = (b.tableIndexes || [b.tableIndex])
      .filter(v=>v !== undefined && v !== null)
      .map(Number);

    if(!indexes.some(index=>targets.has(index))) return false;

    const startB = timeToMinutes(b.startTime);
    const endB = timeToMinutes(b.endTime);
    return startA < endB && endA > startB;
  });
}

const QUICK_BOOKING_TABLE_ZONES = [
  [0,1,2,3],
  [4,5,6,7],
  [8,9],
  [10,11],
  [12,13]
];

function quickBookingEndTime(startTime, packageIndex){
  const startMinutes = timeToMinutes(startTime);
  const noPackage = Number(packageIndex) < 0;
  const bookingPackage = noPackage ? {} : (state.packages?.[Number(packageIndex)] || {});
  const closeMinutes = getBusinessHours().close * 60;
  const duration = noPackage
    ? 180
    : bookingPackage.unlimited
    ? Math.max(0, closeMinutes - startMinutes)
    : Math.max(SLOT_MINUTES, Number(bookingPackage.minutes || SLOT_MINUTES));
  const endMinutes = Math.min(closeMinutes, startMinutes + duration);
  return `${String(Math.floor(endMinutes / 60)).padStart(2,"0")}:${String(endMinutes % 60).padStart(2,"0")}`;
}

function getQuickBookingValues(){
  const startTime = document.getElementById("quickBookingTime")?.value || "";
  const rawPackageIndex = document.getElementById("quickBookingPackage")?.value;
  const packageIndex = rawPackageIndex === "" || rawPackageIndex === "-1"
    ? -1
    : Number(rawPackageIndex || 0);
  return {
    startTime,
    endTime:startTime ? quickBookingEndTime(startTime, packageIndex) : "",
    packageIndex,
    peopleCount:Math.max(1, Math.min(state.tables?.length || 14, Number(document.getElementById("quickBookingPeople")?.value || 1)))
  };
}

function isQuickTableAvailable(tableIndex, startTime, endTime){
  if(!startTime || !endTime) return true;
  if(currentBookingDate === getTodayDate() && state.tables?.[tableIndex]?.start) return false;
  return !hasBookingConflict(tableIndex, {
    date:currentBookingDate,
    startTime,
    endTime
  });
}

function quickTableCapacity(tableIndex){
  return Number(tableIndex) >= 12 ? 1 : 2;
}

function getDefaultBookingPackageIndex(){
  const threeHourIndex = (state.packages || []).findIndex(bookingPackage=>
    !bookingPackage?.unlimited && Number(bookingPackage?.minutes || 0) === 180
  );
  return threeHourIndex >= 0 ? threeHourIndex : 0;
}

function renderQuickBookingForm(force = false){
  const packageSelect = document.getElementById("quickBookingPackage");
  const tableBox = document.getElementById("quickBookingTables");
  const timeInput = document.getElementById("quickBookingTime");
  if(!packageSelect || !tableBox || !timeInput || !state) return;

  if(force || !quickBookingInitialized){
    packageSelect.innerHTML = `
      <option value="-1">不选择套餐｜默认预留3小时</option>
    ` + (state.packages || []).map((bookingPackage,index)=>`
      <option value="${index}">
        ${bookingPackage.name || "套餐"}｜${bookingPackage.unlimited ? "不限时" : `${bookingPackage.minutes || 0}分钟`}｜¥${Number(bookingPackage.price || 0).toLocaleString()}
      </option>
    `).join("");
    const defaultPackageIndex = getDefaultBookingPackageIndex();
    packageSelect.value = String((state.packages || []).length ? defaultPackageIndex : -1);
    const firstSlot = getSlots()[0] || "12:00";
    if(!timeInput.value) timeInput.value = firstSlot;
    quickBookingInitialized = true;
  }

  const selected = new Set(
    [...tableBox.querySelectorAll("input:checked")].map(input=>Number(input.value))
  );
  const {startTime,endTime} = getQuickBookingValues();

  tableBox.innerHTML = (state.tables || []).map((table,index)=>{
    const available = isQuickTableAvailable(index,startTime,endTime);
    const checked = available && selected.has(index);
    return `
      <label class="quick-table-choice ${checked ? "selected" : ""} ${available ? "" : "unavailable"}">
        <input type="checkbox" value="${index}" ${checked ? "checked" : ""} ${available ? "" : "disabled"} onchange="updateQuickBookingSelection()">
        ${table.name || `${index + 1}号桌`}
      </label>
    `;
  }).join("");

  updateQuickBookingSelection();
  updateBookingLockUI();
}

function toggleQuickBookingPanel(){
  quickBookingOpen = !quickBookingOpen;
  const body = document.getElementById("quickBookingBody");
  const button = document.getElementById("quickBookingToggleBtn");
  const help = document.getElementById("quickBookingHelp");
  if(body) body.style.display = quickBookingOpen ? "block" : "none";
  if(button) button.innerText = quickBookingOpen ? "收起 ▲" : "展开 ▼";
  if(help){
    help.innerText = quickBookingOpen
      ? "无需解锁时间表；选择到店时间和套餐后，系统会优先推荐相邻桌位，也可以手动选择桌号。"
      : "无需解锁时间表，需要录入预约时点开填写";
  }
}

function refreshQuickBookingAvailability(){
  renderQuickBookingForm();
}

function updateQuickBookingSelection(){
  const checked = [...document.querySelectorAll("#quickBookingTables input:checked")];
  document.querySelectorAll(".quick-table-choice").forEach(label=>{
    label.classList.toggle("selected", Boolean(label.querySelector("input:checked")));
  });
  const {startTime,endTime} = getQuickBookingValues();
  const range = document.getElementById("quickBookingRange");
  if(range){
    range.innerText = startTime && endTime ? `${startTime} - ${endTime}｜已选 ${checked.length}桌` : `已选 ${checked.length}桌`;
  }
}

function findQuickBookingRecommendation(peopleCount, startTime, endTime){
  const available = new Set(
    (state.tables || [])
      .map((_,index)=>index)
      .filter(index=>isQuickTableAvailable(index,startTime,endTime))
  );

  // 单人优先使用 13、14 号单人桌，避免占用可坐两人的普通桌。
  if(peopleCount === 1){
    const single = QUICK_BOOKING_TABLE_ZONES[4].find(index=>available.has(index));
    if(single !== undefined) return [single];
  }

  const preferredZones = peopleCount > 1
    ? QUICK_BOOKING_TABLE_ZONES.slice(0,4)
    : QUICK_BOOKING_TABLE_ZONES;

  for(const zone of preferredZones){
    for(let length = 1; length <= zone.length; length++){
      for(let start = 0; start <= zone.length - length; start++){
        const candidate = zone.slice(start,start + length);
        const capacity = candidate.reduce((sum,index)=>sum + quickTableCapacity(index),0);
        if(capacity >= peopleCount && candidate.every(index=>available.has(index))){
          return candidate;
        }
      }
    }
  }

  const selected = [];
  let capacity = 0;
  for(const zone of QUICK_BOOKING_TABLE_ZONES){
    for(const index of zone){
      if(available.has(index)){
        selected.push(index);
        capacity += quickTableCapacity(index);
      }
      if(capacity >= peopleCount) return selected;
    }
  }
  return [];
}

function recommendQuickBookingTables(){
  const {peopleCount,startTime,endTime} = getQuickBookingValues();
  if(!startTime) return alert("请先输入到店时间");

  renderQuickBookingForm();
  const recommendation = findQuickBookingRecommendation(peopleCount,startTime,endTime);
  document.querySelectorAll("#quickBookingTables input").forEach(input=>{
    input.checked = recommendation.includes(Number(input.value));
  });
  updateQuickBookingSelection();

  const hint = document.getElementById("quickBookingHint");
  const recommendedCapacity = recommendation.reduce((sum,index)=>sum + quickTableCapacity(index),0);
  if(hint){
    hint.innerText = recommendedCapacity >= peopleCount
      ? `已按 ${peopleCount} 人推荐：${recommendation.map(index=>state.tables[index]?.name).join("、")}`
      : `当前时段没有足够容纳 ${peopleCount} 人的空闲桌位，请调整时间或手动选择。`;
  }
}

async function confirmQuickBooking(){
  const button = document.getElementById("quickBookingConfirm");
  if(button?.disabled) return;

  const name = document.getElementById("quickBookingName")?.value.trim() || "";
  const phone = String(document.getElementById("quickBookingPhone")?.value || "").replace(/\D/g,"").slice(-4);
  const {startTime,endTime,packageIndex,peopleCount} = getQuickBookingValues();
  const tableIndexes = [...document.querySelectorAll("#quickBookingTables input:checked")]
    .map(input=>Number(input.value))
    .filter(Number.isFinite);

  if(!name) return alert("请输入客人姓名");
  if(phone.length !== 4) return alert("请输入手机尾号后四位");
  if(!startTime || !endTime || timeToMinutes(endTime) <= timeToMinutes(startTime)){
    return alert("到店时间或套餐时长不正确");
  }
  if(tableIndexes.length === 0) return alert("请选择桌号，或点击“推荐邻近桌位”");
  const selectedCapacity = tableIndexes.reduce((sum,index)=>sum + quickTableCapacity(index),0);
  if(selectedCapacity < peopleCount){
    return alert(`当前人数是 ${peopleCount} 人，所选桌位最多容纳 ${selectedCapacity} 人`);
  }

  const conflicts = findBookingConflicts({
    date:currentBookingDate,
    tableIndexes,
    startTime,
    endTime
  });
  if(conflicts.length){
    renderQuickBookingForm();
    return alert("所选桌位在这个时段已被占用，请重新选择桌号");
  }

  button.disabled = true;
  button.innerText = "正在加入预约时间表…";
  try{
    const bookingId = Date.now();
    const groupId = makeFastBookingGroupId(bookingId);
    const groupColor = getNextBookingColor();
    const booking = {
      id:bookingId,
      groupId,
      groupColor,
      groupName:"预约组",
      date:currentBookingDate,
      color:groupColor,
      name,
      phone,
      peopleCount,
      partySize:peopleCount,
      tableIndexes,
      startTime,
      endTime,
      packageIndex:packageIndex >= 0 ? packageIndex : null,
      noPackage:packageIndex < 0,
      checkedIn:false,
      checkInTime:null,
      checkInTimeText:"",
      cancelled:false,
      source:"店内输入",
      createdAt:Date.now()
    };

    createOrUpdateGroup({
      groupId,
      groupName:booking.groupName,
      groupColor,
      tableIndexes,
      bookingId,
      peopleCount
    });
    if(!Array.isArray(state.bookings)) state.bookings = [];
    state.bookings.push(booking);

    const saveTask = save("create_booking");
    renderBookingGrid();
    renderList();
    document.getElementById("quickBookingName").value = "";
    document.getElementById("quickBookingPhone").value = "";
    document.querySelectorAll("#quickBookingTables input").forEach(input=>{ input.checked = false; });
    updateQuickBookingSelection();
    document.getElementById("quickBookingHint").innerText = "预约已加入时间表，并已保存在本机。";

    saveTask.catch(error=>{
      console.error("快速预约后台同步失败，将由本地队列继续重试",error);
      setSyncStatus("pending","● 预约已保存在本机 · 云端上传将自动重试");
    });
  }catch(error){
    console.error("快速输入预约失败",error);
    alert("预约保存失败：" + (error?.message || String(error)));
  }finally{
    button.disabled = false;
    button.innerText = "确认并加入预约时间表";
  }
}

function openMoveRunningTableModal(tableIndex){
  const t = state.tables[tableIndex];
  if(!t || !t.start) return;

  moveMode = "running";
  moveRunningFromIndex = tableIndex;
  moveBookingId = null;
  movePairs = [];
  draggingMoveFrom = null;

  document.getElementById("moveTableInfo").innerHTML = `
    当前：${t.name}<br>
    类型：Walk-in<br>
    客人：${t.customer?.name || "-"} ${t.customer?.phoneLast4 || ""}
  `;

  document.getElementById("moveLineArea").innerHTML = `
    <svg id="moveSvg"></svg>

    <div class="move-row-title">按住当前桌位，拖到下面目标桌位</div>
    <div id="moveFromTableBox" class="move-drag-grid">
      <button
        class="move-table-btn move-from-btn"
        data-index="${tableIndex}"
        id="move-from-${tableIndex}"
        onpointerdown="startMoveDrag(event,${tableIndex})"
      >
        ${t.name}<br>
        <small>使用中</small>
      </button>
    </div>

    <div class="move-row-title">拖到这里选择目标桌位</div>
    <div id="moveToTableBox" class="move-drag-grid">
      ${state.tables.map((table,i)=>{
        const disabled = !!table.start || i === tableIndex;
        const sub = i === tableIndex
          ? "当前桌"
          : table.start
            ? "使用中"
            : "可移动";

        return `
          <button
            class="move-table-btn move-to-btn ${disabled ? "disabled" : ""}"
            data-index="${i}"
            id="move-to-${i}"
            ${disabled ? "disabled" : ""}
          >
            ${table.name}<br>
            <small>${sub}</small>
          </button>
        `;
      }).join("")}
    </div>
  `;

  document.getElementById("moveTableModalBg").style.display = "block";
  setTimeout(drawMoveLines,50);
}


function openMoveTableModal(id){
  moveMode = "booking";
moveRunningFromIndex = null;
  if(!id) id = activeBookingId;

  const b = getBookingById(id);
  if(!b) return;

  moveBookingId = id;
  movePairs = [];
  draggingMoveFrom = null;

  const bookingIndexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);
  const bookingVisitStatus = getBookingVisitStatus(b);
  const reservationOnly = bookingVisitStatus.key === "waiting";

  document.getElementById("moveTableInfo").innerHTML = `
    客人：${b.name || "-"} ${String(b.phone || "").slice(-4) || ""}<br>
    预约时间：${b.startTime || "-"} - ${b.endTime || "-"}<br>
    当前桌位：${bookingIndexes.map(i=>state.tables[i]?.name).filter(Boolean).join("、")}
  `;

  document.getElementById("moveLineArea").innerHTML = `
    <svg id="moveSvg"></svg>

    <div class="move-row-title">按住要移动的桌位，拖到下面目标桌位</div>
    <div id="moveFromTableBox" class="move-drag-grid">
      ${bookingIndexes.map(i=>{
        const running = reservationOnly
          ? (state.tables[i]?.start ? "当前桌使用中（不随预约移动）" : "预约桌位")
          : (state.tables[i]?.start ? "已开始" : "未开始");

        return `
          <button
            class="move-table-btn move-from-btn"
            data-index="${i}"
            id="move-from-${i}"
            onpointerdown="startMoveDrag(event,${i})"
          >
            ${state.tables[i]?.name || (i+1)+"号桌"}<br>
            <small>${running}</small>
          </button>
        `;
      }).join("")}
    </div>

    <div class="move-row-title">拖到这里选择目标桌位</div>
    <div id="moveToTableBox" class="move-drag-grid">
      ${state.tables.map((t,i)=>{
        const isSameBookingTable = bookingIndexes.includes(i);
        const conflictBooking = (state.bookings || []).find(other=>{
          if(Number(other?.id) === Number(b.id) || other?.cancelled) return false;
          if((other.date || currentBookingDate) !== (b.date || currentBookingDate)) return false;
          const indexes = (other.tableIndexes || [other.tableIndex]).map(Number);
          if(!indexes.includes(i)) return false;
          return timeToMinutes(b.startTime) < timeToMinutes(other.endTime) && timeToMinutes(b.endTime) > timeToMinutes(other.startTime);
        });
        // 未到店预约只调整预约表，不移动当前正在使用的客人。
        // 因此目标桌当前是否使用中，不影响未来预约的移动或交换。
        const runningName = !reservationOnly && t.start ? (t.customer?.name || "使用中") : "";
        const swapName = conflictBooking?.name || runningName || "";
        const disabled = isSameBookingTable;
        let sub = reservationOnly ? "可调整预约" : "可移动";
        if(isSameBookingTable) sub = "当前预约桌";
        else if(swapName) sub = `交换预约：${swapName}`;
        else if(reservationOnly && t.start) sub = "可调整（当前有人使用）";

        return `
          <button
            class="move-table-btn move-to-btn ${disabled ? "disabled" : ""} ${swapName ? "swap-target" : ""}"
            data-index="${i}"
            id="move-to-${i}"
            ${disabled ? "disabled" : ""}
          >
            ${t.name}<br>
            <small>${sub}</small>
          </button>
        `;
      }).join("")}
    </div>
  `;

  document.getElementById("moveTableModalBg").style.display = "block";
  setTimeout(drawMoveLines, 50);
}

function startMoveDrag(e, fromIndex){
  e.preventDefault();

  draggingMoveFrom = Number(fromIndex);

  document.querySelectorAll(".move-from-btn")
    .forEach(btn=>btn.classList.remove("dragging"));

  const fromEl = document.getElementById("move-from-" + fromIndex);
  fromEl?.classList.add("dragging");

  const area = document.getElementById("moveLineArea");
  const svg = document.getElementById("moveSvg");
  if(!area || !svg || !fromEl) return;

  moveAreaRect = area.getBoundingClientRect();

  const r = fromEl.getBoundingClientRect();
  dragFromCenter = {
    x: r.left + r.width / 2 - moveAreaRect.left,
    y: r.top + r.height / 2 - moveAreaRect.top
  };

  const ns = "http://www.w3.org/2000/svg";
  dragTempLine = document.createElementNS(ns, "line");

  const color = MOVE_LINE_COLORS[movePairs.length % MOVE_LINE_COLORS.length];

  dragTempLine.setAttribute("x1", dragFromCenter.x);
  dragTempLine.setAttribute("y1", dragFromCenter.y);
  dragTempLine.setAttribute("x2", dragFromCenter.x);
  dragTempLine.setAttribute("y2", dragFromCenter.y);
  dragTempLine.setAttribute("stroke", color);
  dragTempLine.setAttribute("stroke-width", "5");
  dragTempLine.setAttribute("stroke-linecap", "round");
  dragTempLine.setAttribute("stroke-dasharray", "8 6");

  svg.appendChild(dragTempLine);

  window.addEventListener("pointermove", moveDragLine, {passive:false});
  window.addEventListener("pointerup", endMoveDrag);
}


function moveDragLine(e){
  if(draggingMoveFrom === null) return;
  if(!dragTempLine || !moveAreaRect) return;

  e.preventDefault();

  const x = e.clientX - moveAreaRect.left;
  const y = e.clientY - moveAreaRect.top;

  dragTempLine.setAttribute("x2", x);
  dragTempLine.setAttribute("y2", y);
}


function endMoveDrag(e){
  if(draggingMoveFrom === null) return;

  const target = document.elementFromPoint(e.clientX, e.clientY);
  const toBtn = target?.closest?.(".move-to-btn");

  if(toBtn && !toBtn.disabled){
    const toIndex = Number(toBtn.dataset.index);

    if(draggingMoveFrom === toIndex){
      alert("新桌位不能和原桌位一样");
    }else{
      movePairs = movePairs.filter(p=>{
        return p.from !== draggingMoveFrom && p.to !== toIndex;
      });

      movePairs.push({
        from: draggingMoveFrom,
        to: toIndex
      });
    }
  }

  document.querySelectorAll(".move-from-btn")
    .forEach(btn=>btn.classList.remove("dragging"));

  draggingMoveFrom = null;

  window.removeEventListener("pointermove", moveDragLine);
window.removeEventListener("pointerup", endMoveDrag);

lastMovePointer = null;

if(moveLineRAF){
  cancelAnimationFrame(moveLineRAF);
  moveLineRAF = null;
}

if(dragTempLine){
  dragTempLine.remove();
  dragTempLine = null;
}

moveAreaRect = null;
dragFromCenter = null;

drawMoveLines();


}

function drawMoveLines(pointerX = null, pointerY = null){
  const svg = document.getElementById("moveSvg");
  const area = document.getElementById("moveLineArea");
  if(!svg || !area) return;

  const rect = area.getBoundingClientRect();
  const ns = "http://www.w3.org/2000/svg";

  const nodes = [];

  function centerOf(el){
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2 - rect.left,
      y: r.top + r.height / 2 - rect.top
    };
  }

  document.querySelectorAll(".move-table-btn.selected")
    .forEach(btn=>btn.classList.remove("selected"));

  movePairs.forEach((pair,idx)=>{
    const fromEl = document.getElementById("move-from-" + pair.from);
    const toEl = document.getElementById("move-to-" + pair.to);
    if(!fromEl || !toEl) return;

    fromEl.classList.add("selected");
    toEl.classList.add("selected");

    const a = centerOf(fromEl);
    const b = centerOf(toEl);
    const color = MOVE_LINE_COLORS[idx % MOVE_LINE_COLORS.length];

    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "5");
    line.setAttribute("stroke-linecap", "round");

    nodes.push(line);
  });

  if(draggingMoveFrom !== null && pointerX !== null && pointerY !== null){
    const fromEl = document.getElementById("move-from-" + draggingMoveFrom);

    if(fromEl){
      const a = centerOf(fromEl);
      const color = MOVE_LINE_COLORS[movePairs.length % MOVE_LINE_COLORS.length];

      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", a.x);
      line.setAttribute("y1", a.y);
      line.setAttribute("x2", pointerX - rect.left);
      line.setAttribute("y2", pointerY - rect.top);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "5");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-dasharray", "8 6");

      nodes.push(line);
    }
  }

  svg.replaceChildren(...nodes);
}

async function confirmMoveTable(){
  if(moveMode === "running"){
    await confirmMoveRunningTable();
    return;
  }

  const b = getBookingById(moveBookingId);
  if(!b) return;
  if(movePairs.length === 0){
    alert("请先拖线选择要调整的桌位");
    return;
  }

  const bookingIndexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null).map(Number);
  const fromSet = new Set();
  const toSet = new Set();
  for(const pair of movePairs){
    pair.from = Number(pair.from); pair.to = Number(pair.to);
    if(!bookingIndexes.includes(pair.from)) return alert("有原桌位不属于这个预约");
    if(pair.from === pair.to) return alert("新桌位不能和原桌位一样");
    if(fromSet.has(pair.from) || toSet.has(pair.to)) return alert("同一张桌不能重复连接");
    fromSet.add(pair.from); toSet.add(pair.to);
  }

  const affectedBookings = new Map();
  const selectedStart = timeToMinutes(b.startTime);
  const selectedEnd = timeToMinutes(b.endTime);
  for(const pair of movePairs){
    const targetTable = state.tables[pair.to];
    let other = null;
    if(targetTable?.bookingId){
      other = (state.bookings || []).find(x=>Number(x.id) === Number(targetTable.bookingId));
    }
    if(!other){
      other = (state.bookings || []).find(x=>{
        if(Number(x?.id) === Number(b.id) || x?.cancelled) return false;
        if((x.date || currentBookingDate) !== (b.date || currentBookingDate)) return false;
        const indexes = (x.tableIndexes || [x.tableIndex]).map(Number);
        return indexes.includes(pair.to) && selectedStart < timeToMinutes(x.endTime) && selectedEnd > timeToMinutes(x.startTime);
      });
    }
    if(other) affectedBookings.set(String(other.id),other);
  }

  const visitStatus = getBookingVisitStatus(b);
  const reservationOnly = visitStatus.key === "waiting";

  // 未到店预约的桌位调整，只修改预约安排。
  // 当前正在使用的桌位、计时、账单和付款全部留在原物理桌位。
  if(reservationOnly){
    const hasReservationSwap = affectedBookings.size > 0;
    const summary = movePairs.map(p=>`${state.tables[p.from]?.name || p.from+1} → ${state.tables[p.to]?.name || p.to+1}`).join("、");
    const confirmText = hasReservationSwap
      ? `确认交换预约桌位？\n${summary}\n\n只交换预约表中的桌位，不会移动当前正在使用的客人、计时或账单。`
      : `确认调整预约桌位？\n${summary}\n\n只修改预约表，不会影响当前正在使用的客人。`;
    if(!confirm(confirmText)) return;

    const oneWaySelected = new Map(movePairs.map(({from,to})=>[from,to]));
    const bidirectional = new Map();
    movePairs.forEach(({from,to})=>{ bidirectional.set(from,to); bidirectional.set(to,from); });
    const remapArray = (arr,map)=>Array.from(new Set((arr || []).map(Number).map(i=>map.has(i)?map.get(i):i)));

    b.tableIndexes = remapArray(bookingIndexes,oneWaySelected);
    delete b.tableIndex;
    b.updatedAt = Date.now();

    // 与目标桌同时间段的另一条预约反向换回原桌位。
    for(const other of affectedBookings.values()){
      other.tableIndexes = remapArray(other.tableIndexes || [other.tableIndex],bidirectional);
      delete other.tableIndex;
      other.updatedAt = Date.now();
    }

    // 若预约已建立分组，仅同步预约分组的桌位编号；不碰运行桌位对象。
    const bookingGroupIds = new Set([b,...affectedBookings.values()]
      .map(x=>x?.groupId).filter(Boolean).map(String));
    for(const group of state.groups || []){
      if(bookingGroupIds.has(String(group?.id)) && !group?.startedAt){
        group.tableIndexes = remapArray(group.tableIndexes,bidirectional);
        group.updatedAt = Date.now();
      }
    }

    await save(hasReservationSwap ? "swap_future_booking_tables" : "move_future_booking_tables");
    closeMoveTableModal();
    renderBookingGrid();
    renderList();
    alert(hasReservationSwap ? "预约桌位已交换" : "预约桌位已调整");
    return;
  }

  const hasSwap = movePairs.some(pair=>{
    const t = state.tables[pair.to];
    if(t?.start) return true;
    return [...affectedBookings.values()].some(x=>(x.tableIndexes || [x.tableIndex]).map(Number).includes(pair.to));
  });
  const summary = movePairs.map(p=>`${state.tables[p.from]?.name || p.from+1} → ${state.tables[p.to]?.name || p.to+1}`).join("、");
  if(!confirm(`${hasSwap ? "确认交换/调整桌位" : "确认移动桌位"}？\n${summary}\n\n计时、账单、预约和分组会一起跟随客人移动。`)) return;

  const oldTables = state.tables.map(t=>JSON.parse(JSON.stringify(t)));
  const bidirectional = new Map();
  movePairs.forEach(({from,to})=>{ bidirectional.set(from,to); bidirectional.set(to,from); });
  const oneWaySelected = new Map(movePairs.map(({from,to})=>[from,to]));

  // 逐对交换完整桌位对象，桌名保留在物理桌位上。
  for(const {from,to} of movePairs){
    const fromName = oldTables[from]?.name || `${from+1}号桌`;
    const toName = oldTables[to]?.name || `${to+1}号桌`;
    state.tables[to] = {...oldTables[from],name:toName,lastAction:"swap_table",movedAt:Date.now()};
    state.tables[from] = {...oldTables[to],name:fromName,lastAction:"swap_table",movedAt:Date.now()};
  }

  const remapArray = (arr,map)=>Array.from(new Set((arr || []).map(Number).map(i=>map.has(i)?map.get(i):i)));
  b.tableIndexes = remapArray(bookingIndexes,oneWaySelected);
  if(b.checkedInTableIndexes) b.checkedInTableIndexes = remapArray(b.checkedInTableIndexes,oneWaySelected);
  if(b.finishedTableIndexes) b.finishedTableIndexes = remapArray(b.finishedTableIndexes,oneWaySelected);
  delete b.tableIndex;

  // 目标桌位原本所属的预约反向换到原桌位。
  for(const other of affectedBookings.values()){
    other.tableIndexes = remapArray(other.tableIndexes || [other.tableIndex],bidirectional);
    if(other.checkedInTableIndexes) other.checkedInTableIndexes = remapArray(other.checkedInTableIndexes,bidirectional);
    if(other.finishedTableIndexes) other.finishedTableIndexes = remapArray(other.finishedTableIndexes,bidirectional);
    delete other.tableIndex;
    other.updatedAt = Date.now();
  }

  // 所有涉及到的运行分组随完整桌位对象一起交换。
  const involvedGroupIds = new Set();
  movePairs.forEach(({from,to})=>{
    [oldTables[from]?.groupId,oldTables[to]?.groupId].filter(Boolean).forEach(id=>involvedGroupIds.add(String(id)));
  });
  [b,...affectedBookings.values()].forEach(x=>x?.groupId && involvedGroupIds.add(String(x.groupId)));
  for(const group of state.groups || []){
    if(involvedGroupIds.has(String(group?.id))){
      group.tableIndexes = remapArray(group.tableIndexes,bidirectional);
      group.updatedAt = Date.now();
    }
  }

  await save(hasSwap ? "swap_booking_tables" : "move_booking_table");
  closeMoveTableModal();
  renderBookingGrid();
  renderList();
  alert(hasSwap ? "桌位已交换" : "桌位已移动");
}
async function confirmMoveRunningTable(){
  if(moveRunningFromIndex === null){
    alert("没有选择要移动的桌位");
    return;
  }

  if(movePairs.length === 0){
    alert("请先拖线选择目标桌位");
    return;
  }

  const pair = movePairs[0];
  const fromIndex = Number(pair.from);
  const toIndex = Number(pair.to);

  if(
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex)
  ){
    alert("桌位编号无效，请重新选择");
    return;
  }

  if(fromIndex === toIndex){
    alert("新桌位不能和原桌位相同");
    return;
  }

  const fromTable = state.tables[fromIndex];
  const toTable = state.tables[toIndex];

  if(!fromTable || !fromTable.start){
    alert("原桌位不是使用中状态");
    return;
  }

  if(fromTable.type !== "walkin"){
    alert("这里只能移动 Walk-in 桌位");
    return;
  }

  if(!toTable){
    alert("目标桌位不存在");
    return;
  }

  if(toTable.start){
    alert(`${toTable.name} 正在使用中，不能移动`);
    return;
  }

  if(
    !confirm(
      `确认把 ${fromTable.name} 移动到 ${toTable.name} 吗？`
    )
  ){
    return;
  }

  const oldFromName = fromTable.name;
  const oldToName = toTable.name;
  const movingGroupId = fromTable.groupId || "";

  try{
    /*
     * 移动桌位状态。
     */
    state.tables[toIndex] = {
      ...fromTable,
      name:oldToName,
      lastAction:"move_table",
      movedFromIndex:fromIndex,
      movedAt:Date.now()
    };

    state.tables[fromIndex] = resetTable(oldFromName);

    /*
     * 更新分组中的桌位编号。
     */
    const group = getGroupById(movingGroupId);

    if(group){
      if(!Array.isArray(group.tableIndexes)){
        group.tableIndexes = [];
      }

      group.tableIndexes = group.tableIndexes
        .map(Number)
        .map(index =>
          index === fromIndex
            ? toIndex
            : index
        );

      group.tableIndexes = Array.from(
        new Set(group.tableIndexes)
      );

      group.updatedAt = Date.now();
    }

    /*
     * 更新对应收银记录中的桌位名称。
     */
    const movedTable = state.tables[toIndex];

    if(movedTable.recordId){
      const snap = await getDoc(
        doc(db,"records",movedTable.recordId)
      );

      if(snap.exists()){
        const record = {
          id:snap.id,
          ...snap.data()
        };

        record.tableName = oldToName;
        record.tableIndex = toIndex;
        record.previousTableName = oldFromName;
        record.updatedAt = Date.now();

        await saveRecordSafely({
          db,
          ref,
          record
        });
      }
    }

    await save("move_walkin_table");

    closeMoveTableModal();
    renderBookingGrid();
    renderList();

    alert(`已移动到 ${oldToName}`);

  }catch(error){
    console.error("移动 Walk-in 桌位失败",error);

    alert(
      "移动桌位失败：\n" +
      (error?.message || String(error))
    );
  }
}

function closeMoveTableModal(){
  document.getElementById("moveTableModalBg").style.display = "none";

  moveBookingId = null;
  moveRunningFromIndex = null;
  moveMode = "booking";
  movePairs = [];
  draggingMoveFrom = null;

  window.removeEventListener("pointermove", moveDragLine);
  window.removeEventListener("pointerup", endMoveDrag);

  if(dragTempLine){
    dragTempLine.remove();
    dragTempLine = null;
  }

  moveAreaRect = null;
  dragFromCenter = null;
}

function startSelectSlot(e,tableIndex,rowIndex){
  if(bookingLocked) return;
  if(isTableBusyAtSlot(state.tables[tableIndex], rowIndex)) return;

  e.preventDefault();

  selecting = true;

  selection = {
    startTableIndex: tableIndex,
    endTableIndex: tableIndex,
    startRow: rowIndex,
    endRow: rowIndex
  };

  highlightSelection();
}


function moveSelectSlot(e,tableIndex,rowIndex){
  if(!selecting || !selection) return;
  if(tableIndex !== selection.tableIndex) return;

  selection.endRow = rowIndex;
  highlightSelection();
}

function moveSelectByPoint(e){
  if(!selecting || !selection) return;

  const target = document.elementFromPoint(e.clientX, e.clientY);
  if(!target || !target.classList.contains("slot-cell")) return;

  const tableIndex = Number(target.dataset.table);
  const rowIndex = Number(target.dataset.row);

  selection.endTableIndex = tableIndex;
  selection.endRow = rowIndex;

  highlightSelection();
}


function endSelectSlot(e){
  if(!selecting || !selection) return;

  selecting = false;

  const startRow = Math.min(selection.startRow, selection.endRow);
  const endRow = Math.max(selection.startRow, selection.endRow) + 1;

  const startTable = Math.min(selection.startTableIndex, selection.endTableIndex);
  const endTable = Math.max(selection.startTableIndex, selection.endTableIndex);

  const slots = getSlots();

  const startTime = slots[startRow];
  const endTime = slots[endRow] || `${getBusinessHours().close}:00`;

  const tableNames = [];

  for(let i=startTable; i<=endTable; i++){
    tableNames.push(state.tables[i].name);
  }

  document.getElementById("selectedRangeText").innerText =
    `${tableNames.join("、")}｜${startTime} - ${endTime}`;

  const tip = document.getElementById("selectionTip");
if(tip) tip.style.display = "none";

fillModalPackages();

const autoPackageIndex = findPackageIndexByDuration(startTime, endTime);
const modalPackage = document.getElementById("modalPackage");

if(modalPackage){
  modalPackage.value = String(autoPackageIndex);
}

const modalType = document.getElementById("modalType");
if(modalType) modalType.value = "booking";

toggleModalType();


  document.getElementById("bookingModalBg").style.display = "block";
}


function updateSelectionTip(){
  let tip = document.getElementById("selectionTip");

  if(!tip){
    tip = document.createElement("div");
    tip.id = "selectionTip";
    tip.className = "selection-tip";
    document.body.appendChild(tip);
  }

  if(!selection){
    tip.style.display = "none";
    return;
  }

  const startRow = Math.min(selection.startRow, selection.endRow);
  const endRow = Math.max(selection.startRow, selection.endRow) + 1;

  const minutes = (endRow - startRow) * SLOT_MINUTES;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  const durationText =
    hours > 0
      ? `${hours}小时${mins ? mins + "分钟" : ""}`
      : `${mins}分钟`;

  const slots = getSlots();
  const startTime = slots[startRow];
  const endTime = slots[endRow] || `${getBusinessHours().close}:00`;

  const tableCount =
    Math.abs(selection.endTableIndex - selection.startTableIndex) + 1;

  tip.innerHTML =
    `<b>${tableCount}桌｜${durationText}</b><br>${startTime} - ${endTime}`;

  const cell = document.querySelector(
    `.slot-cell[data-table="${selection.endTableIndex}"][data-row="${selection.endRow}"]`
  );

  if(cell){
    const rect = cell.getBoundingClientRect();
    tip.style.left = rect.right + 8 + "px";
    tip.style.top = rect.top + "px";
    tip.style.display = "block";
  }else{
    tip.style.display = "none";
  }
}



function highlightSelection(){
  document.querySelectorAll(".slot-cell.selecting").forEach(el=>{
    el.classList.remove("selecting");
  });

  if(!selection) return;

  const startRow = Math.min(selection.startRow, selection.endRow);
  const endRow = Math.max(selection.startRow, selection.endRow);

  const startTable = Math.min(selection.startTableIndex, selection.endTableIndex);
  const endTable = Math.max(selection.startTableIndex, selection.endTableIndex);

  document.querySelectorAll(".slot-cell").forEach(el=>{
    const table = Number(el.dataset.table);
    const row = Number(el.dataset.row);

    if(
      table >= startTable &&
      table <= endTable &&
      row >= startRow &&
      row <= endRow
    ){
      el.classList.add("selecting");
    }
  });
  updateSelectionTip();
}

function toggleModalType(){
  const type = document.getElementById("modalType")?.value || "booking";
  const packageBox = document.getElementById("modalPackageBox");
  const btn = document.getElementById("modalConfirmBtn");

  if(packageBox){
    packageBox.style.display = type === "walkin" ? "block" : "none";
  }

  if(btn){
    btn.innerText = type === "walkin" ? "开始计时" : "确认预约";
  }
}

function fillModalPackages(){
  const box = document.getElementById("modalPackage");
  if(!box) return;

  box.innerHTML = (state.packages || []).map((p,i)=>`
    <option value="${i}">
      ${p.name}｜${p.unlimited ? "不限时" : p.minutes + "分钟"}｜¥${p.price}
    </option>
  `).join("");
}

function resetBookingConfirmButton(){
  const btn = document.getElementById("modalConfirmBtn");
  if(!btn) return;

  btn.disabled = false;

  const type =
    document.getElementById("modalType")?.value || "booking";

  btn.innerText =
    type === "walkin"
      ? "开始计时"
      : "确认预约";
}

async function confirmGridBooking(){
  if(!selection) return;

  const confirmBtn =
    document.getElementById("modalConfirmBtn");

  if(confirmBtn?.disabled) return;

  if(confirmBtn){
    confirmBtn.disabled = true;
    confirmBtn.innerText = "正在保存预约…";
  }

  let completed = false;

  try{
    const type =
      document.getElementById("modalType")?.value || "booking";

    const name =
      document.getElementById("modalName")?.value.trim() || "";

    const phone =
      document.getElementById("modalPhone")?.value.trim() || "";

    const slots = getSlots();

    const start =
      Math.min(selection.startRow, selection.endRow);

    const end =
      Math.max(selection.startRow, selection.endRow) + 1;

    const startTable =
      Math.min(
        selection.startTableIndex,
        selection.endTableIndex
      );

    const endTable =
      Math.max(
        selection.startTableIndex,
        selection.endTableIndex
      );

    const tableIndexes = Array.from(
      {length:endTable - startTable + 1},
      (_,idx)=>startTable + idx
    );

    const busyTables =
      currentBookingDate === getTodayDate()
        ? tableIndexes.filter(
            idx=>state.tables[idx]?.start
          )
        : [];

    if(busyTables.length){
      alert(
        "以下桌位正在使用中，不能操作：\n" +
        busyTables
          .map(i=>state.tables[i]?.name)
          .filter(Boolean)
          .join("、")
      );
      return;
    }

    const startTime = slots[start];
    const endTime =
      slots[end] ||
      `${getBusinessHours().close}:00`;

    if(!startTime || !endTime){
      alert("没有正确取得预约时间，请重新选择");
      return;
    }

    if(type === "walkin"){
      const packageIndex = Number(
        document.getElementById("modalPackage")?.value || 0
      );

const now = Date.now();
const walkinColor = getNextBookingColor();

const walkinGroupId = await makeGroupId();

const walkinGroupName = "Walk-in组";

createOrUpdateGroup({
  groupId: walkinGroupId,
  groupName: walkinGroupName,
  groupColor: walkinColor,
  tableIndexes
});

for(const idx of tableIndexes){
        const t = state.tables[idx];

        if(!t){
          throw new Error(
            `${idx + 1}号桌的数据不存在`
          );
        }

        t.type = "walkin";

t.groupId = walkinGroupId;
t.groupColor = walkinColor;
t.groupName = walkinGroupName;

t.activeColor = walkinColor;
t.bookingId = null;
t.packageIndex = packageIndex;        
        t.pay = "";
        t.currency = "日元";
        t.customer = {
          name,
          phoneLast4:String(phone).slice(-4)
        };
        t.start = now;
        t.pausedAt = null;
        t.extra = 0;
        t.alerted = false;
        t.alerting = false;
        t.lastAction = "start";

        await createOrUpdateTableRecord(t,{
          customerType:"walkin",
          checkoutMethod:"Walk-in开始计时"
        });
      }

      await save("start_walkin");

      completed = true;
      closeBookingModal();
      renderBookingGrid();
      renderList();

      alert("Walk-in 已开始计时");
      return;
    }

    const conflicts = findBookingConflicts({
      date:currentBookingDate,
      tableIndexes,
      startTime,
      endTime
    });

    if(conflicts.length){
      const conflictLines = conflicts.map(existing=>{
        const occupiedIndexes = (existing.tableIndexes || [existing.tableIndex])
          .filter(v=>v !== undefined && v !== null)
          .map(Number)
          .filter(index=>tableIndexes.includes(index));
        const tableNames = occupiedIndexes
          .map(index=>state.tables[index]?.name || `${index + 1}号桌`)
          .join("、");
        return `${tableNames}｜${existing.startTime} - ${existing.endTime}｜${existing.name || "已有预约"}`;
      });

      alert(
        "创建预约失败：所选桌位和时间已存在预约，不能重叠。\n\n" +
        conflictLines.join("\n")
      );
      return;
    }

    const packageIndex =
      findPackageIndexByDuration(startTime,endTime);

    const bookingId = Date.now();
    const groupId = makeFastBookingGroupId(bookingId);
    const groupColor = getNextBookingColor();

    const booking = {
      id:bookingId,
      groupId,
      groupColor,
      groupName:"预约组",
      date:currentBookingDate,
      color:groupColor,
      name,
      phone,
      tableIndexes,
      startTime,
      endTime,
      packageIndex,
      checkedIn:false,
      checkInTime:null,
      checkInTimeText:"",
      cancelled:false,
      createdAt:Date.now()
    };

    createOrUpdateGroup({
      groupId,
      groupName:booking.groupName,
      groupColor,
      tableIndexes,
      bookingId:booking.id
    });

    if(!Array.isArray(state.bookings)){
      state.bookings = [];
    }

    state.bookings.push(booking);

    /*
     * saveStateSafely 会同步写入 localStorage 并立即广播。
     * 预约窗口无需等待 IndexedDB 或 Firestore 上传完成，登记后马上关闭。
     */
    const saveTask = save("create_booking");

    completed = true;
    closeBookingModal();
    renderBookingGrid();
    renderList();

    saveTask.catch(error=>{
      console.error("预约后台同步失败，将由本地队列继续重试", error);
      setSyncStatus("pending", "● 预约已保存在本机 · 云端上传将自动重试");
    });

  }catch(error){
    console.error("创建预约失败",error);

    alert(
      "预约保存失败：\n" +
      (error?.message || String(error))
    );

  }finally{
    /*
     * 成功时 closeBookingModal() 已经恢复按钮。
     * 失败或校验中止时，在这里恢复按钮。
     */
    if(!completed){
      resetBookingConfirmButton();
    }
  }
}


function closeBookingModal(){
  document.getElementById("bookingModalBg").style.display = "none";
  document.getElementById("modalName").value = "";
  document.getElementById("modalPhone").value = "";

  document.querySelectorAll(".slot-cell.selecting").forEach(el=>{
    el.classList.remove("selecting");
  });

  selecting = false;
  selection = null;
  const tip = document.getElementById("selectionTip");
if(tip) tip.style.display = "none";
  const modalType = document.getElementById("modalType");
if(modalType) modalType.value = "booking";

const packageBox = document.getElementById("modalPackageBox");
if(packageBox) packageBox.style.display = "none";

const btn = document.getElementById("modalConfirmBtn");
if(btn){
  btn.disabled = false;
  btn.innerText = "确认预约";
}
}

function openDatePicker(){
  const d = new Date(currentBookingDate);
  calendarYear = d.getFullYear();
  calendarMonth = d.getMonth();
  selectedCalendarDate = currentBookingDate;

  document.getElementById("datePickerModalBg").style.display = "block";
  renderCustomCalendar();
}


function getBookingDates(){
  const set = new Set();

  (state.bookings || []).forEach(b=>{
    if(b.date) set.add(b.date);
  });

  return set;
}

function renderCustomCalendar(){
  const box = document.getElementById("calendarGrid");
  const title = document.getElementById("calendarTitle");
  if(!box || !title) return;

  title.innerText = `${calendarYear}年${calendarMonth + 1}月`;

  const bookingDates = getBookingDates();

  const first = new Date(calendarYear, calendarMonth, 1);
  const last = new Date(calendarYear, calendarMonth + 1, 0);
  const startDay = first.getDay();
  const days = last.getDate();

  let html = `
    <div class="cal-week">日</div>
    <div class="cal-week">一</div>
    <div class="cal-week">二</div>
    <div class="cal-week">三</div>
    <div class="cal-week">四</div>
    <div class="cal-week">五</div>
    <div class="cal-week">六</div>
  `;

  for(let i=0;i<startDay;i++){
    html += `<div></div>`;
  }

  for(let d=1; d<=days; d++){
    const dateStr =
      `${calendarYear}-${String(calendarMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;

    const hasBooking = bookingDates.has(dateStr);
    const selected = selectedCalendarDate === dateStr;

const today = dateStr === getTodayDate();

html += `
  <button
    class="cal-day ${hasBooking ? "has-booking" : ""} ${selected ? "selected" : ""} ${today ? "today" : ""}"
    onclick="selectCalendarDate('${dateStr}')"
  >
    ${d}
    ${hasBooking ? `<span class="booking-dot"></span>` : ""}
  </button>
`;


  }

  box.innerHTML = html;
}

function selectCalendarDate(dateStr){
  selectedCalendarDate = dateStr;
  renderCustomCalendar();
}

function changeCalendarMonth(step){
  calendarMonth += step;

  if(calendarMonth < 0){
    calendarMonth = 11;
    calendarYear--;
  }

  if(calendarMonth > 11){
    calendarMonth = 0;
    calendarYear++;
  }

  renderCustomCalendar();
}

function closeDatePicker(){
  document.getElementById("datePickerModalBg").style.display = "none";
}

function confirmDatePicker(){
  currentBookingDate = selectedCalendarDate;

  closeDatePicker();
  renderBookingGrid();
  renderList();
}
  


function drawExistingBookings(){
  document.querySelectorAll(".slot-cell.booked, .slot-cell.checked-in-booking").forEach(el=>{
    el.classList.remove("booked","checked-in-booking");
    el.innerHTML = "";
    el.onclick = null;
    el.style.background = "";
    el.style.color = "";
  });

  const slots = getSlots();

  const dayBookings = (state.bookings || []).filter(b=>{
    return !b?.cancelled && (b.date || currentBookingDate) === currentBookingDate;
  });

  dayBookings.forEach(b=>{
    const finished = (b.finishedTableIndexes || []).map(Number);

    const tableIndexes = (b.tableIndexes || [b.tableIndex])
      .filter(v=>v !== undefined && v !== null)
      .map(Number)
      .filter(i=>!finished.includes(i));

    const bookingStart = timeToMinutes(b.startTime);
    const bookingEnd = timeToMinutes(b.endTime);
    const occupiedRows = slots.slice(0,-1)
      .map((slotTime,rowIndex)=>{
        const slotStart = timeToMinutes(slotTime);
        const slotEnd = timeToMinutes(slots[rowIndex + 1]);
        return bookingStart < slotEnd && bookingEnd > slotStart ? rowIndex : -1;
      })
      .filter(rowIndex=>rowIndex >= 0);

    if(!occupiedRows.length) return;

    const startRow = occupiedRows[0];
    const realEndRow = occupiedRows[occupiedRows.length - 1] + 1;
    const baseColor = b.color || "#B7E4C7";
    const bgColor = b.checkedIn ? darkenColor(baseColor, 35) : baseColor;

    tableIndexes.forEach(tableIndex=>{
      for(let rowIndex = startRow; rowIndex < realEndRow; rowIndex++){
        const cell = document.querySelector(
          `.slot-cell[data-table="${tableIndex}"][data-row="${rowIndex}"]`
        );

        if(!cell) continue;

        cell.classList.add(b.checkedIn ? "checked-in-booking" : "booked");
        cell.dataset.bookingId = String(b.id);
        cell.style.background = bgColor;
        cell.style.color = "#332d24";

        cell.onpointerdown = null;
        cell.onpointermove = null;
        cell.onpointerup = null;
        cell.onpointercancel = null;

        cell.onclick = (e)=>{
          e.preventDefault();
          e.stopPropagation();
          if(bookingLocked) return;
          openBookingAction(b.id);
        };

  if(rowIndex === startRow && tableIndex === tableIndexes[0]){
  const phoneLast4 = String(b.phone || "").slice(-4);

  cell.innerHTML = b.checkedIn
    ? ""
    : `
      <div class="booking-cell-name">${b.name || "-"}</div>
      <div class="booking-cell-phone">${phoneLast4 || ""}</div>
    `;
}
               
      }
    });
  });
}



function getRunningGroups(){
  const map = {};

  state.tables.forEach((t,index)=>{
    if(!t.start) return;

    const key = t.groupId || ("table_" + index);

    if(!map[key]){
      map[key] = {
        id:key,
        color:t.groupColor || t.activeColor || "#B7E4C7",
        name:t.groupName || "未命名组",
        tables:[]
      };
    }

    map[key].tables.push({
      index,
      table:t
    });
  });

  return Object.values(map);
}

function drawRunningTables(){
  document.querySelectorAll(".running-block").forEach(el=>{
    el.remove();
  });

  state.tables.forEach((t,tableIndex)=>{
    if(!t.start) return;

    const slots = getSlots();

    let startRow = -1;
    let endRow = -1;

    for(let row=0; row<slots.length-1; row++){
      if(isTableBusyAtSlot(t,row)){
        if(startRow === -1) startRow = row;
        endRow = row;
      }
    }

    if(startRow === -1) return;

    const bgColor = darkenColor(t.groupColor || getRunningColor(t), 35);
    const runningBookingId = t.bookingId === undefined || t.bookingId === null
      ? ""
      : String(t.bookingId);
    const drawableRows = [];

    for(let row=startRow; row<=endRow; row++){
      const cell = document.querySelector(
        `.slot-cell[data-table="${tableIndex}"][data-row="${row}"]`
      );

      if(!cell) continue;

      // 后续预约的颜色和点击入口优先保留。正在使用的色块只能覆盖空白格，
      // 或覆盖属于当前正在使用预约本身的格子。
      const cellBookingId = cell.dataset.bookingId || "";
      const occupiedByOtherBooking = cellBookingId && cellBookingId !== runningBookingId;
      if(occupiedByOtherBooking) continue;

      drawableRows.push(row);
      cell.style.background = bgColor;

      cell.onclick = (e)=>{
        e.preventDefault();
        e.stopPropagation();

        // 预约页只负责登记与排桌。到店后的付款、换桌、续时和结账统一进入计时器处理。
        window.location.href = `app.html#table-${tableIndex + 1}`;
      };
    }

    if(drawableRows.length === 0) return;

    const middleRow = drawableRows[Math.floor(drawableRows.length / 2)];

const middleCell = document.querySelector(
  `.slot-cell[data-table="${tableIndex}"][data-row="${middleRow}"]`
);

if(!middleCell) return;

const status = getTableStatusText(t);

middleCell.innerHTML = `
  <div class="running-block ${status.className}" style="border:3px solid ${t.groupColor || t.activeColor || "#B7E4C7"};">
    <div
      class="running-time"
      data-running-table="${tableIndex}"
    >
      ${status.text}
    </div>
  </div>
`;


      });
}

function startRunningTimeTextTimer(){
  if(runningTimeTextTimer) return;

  runningTimeTextTimer = setInterval(()=>{
    if(!state || !state.tables) return;

    document.querySelectorAll("[data-running-table]").forEach(el=>{
      const index = Number(el.dataset.runningTable);
      const t = state.tables[index];

      if(!t || !t.start){
        el.innerText = "";
        return;
      }

      const status = getTableStatusText(t);

      el.innerText = status.text;

      const block = el.closest(".running-block");
      if(block){
        block.className = `running-block ${status.className}`;
      }
    });
  },1000);
}

function getBookingById(id){
  return state.bookings.find(b=>Number(b.id) === Number(id));
}

function getBookingDetailDraft(){
  const rawPackageIndex = document.getElementById("detailPackage")?.value;
  return {
    name: document.getElementById("detailName")?.value.trim() || "",
    phone: document.getElementById("detailPhone")?.value.trim() || "",
    packageIndex:rawPackageIndex === "-1" ? null : Number(rawPackageIndex || 0)
  };
}

function getBookingDetailSnapshot(booking){
  return JSON.stringify({
    name: booking?.name || "",
    phone: booking?.phone || "",
    packageIndex:booking?.packageIndex === null || booking?.packageIndex === undefined
      ? null
      : Number(booking.packageIndex)
  });
}

function hasUnsavedBookingDetailChanges(){
  if(!activeBookingId || bookingDetailInitialSnapshot === null) return false;
  return JSON.stringify(getBookingDetailDraft()) !== bookingDetailInitialSnapshot;
}

function openBookingAction(id){
  const b = getBookingById(id);
  if(!b) return;

  activeBookingId = id;
  bookingDetailClosing = false;

  document.getElementById("bookingActionInfo").innerHTML = `
    时间：${b.startTime} - ${b.endTime}<br>
    状态：${getBookingVisitStatus(b).text}
  `;

  document.getElementById("detailName").value = b.name || "";
  document.getElementById("detailPhone").value = b.phone || "";

  const indexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);

  document.getElementById("detailTablesBox").innerHTML = `
    <div style="font-weight:800;margin:8px 0;">
      预约桌位：${indexes.map(i=>state.tables[i]?.name).filter(Boolean).join("、")}
    </div>
  `;

  const noPackageSelected = b.packageIndex === null || b.packageIndex === undefined || b.noPackage;
  document.getElementById("detailPackage").innerHTML =
    `<option value="-1" ${noPackageSelected ? "selected" : ""}>不选择套餐</option>` +
    (state.packages || []).map((p,i)=>`
      <option value="${i}" ${!noPackageSelected && Number(b.packageIndex) === i ? "selected" : ""}>
        ${p.name}｜${p.unlimited ? "不限时" : p.minutes + "分钟"}｜¥${p.price}
      </option>
    `).join("");

  bookingDetailInitialSnapshot = getBookingDetailSnapshot(b);
  document.getElementById("bookingActionModalBg").style.display = "block";
}

async function saveBookingDetail(options = {}){
  const { closeModal = false, showAlert = false } = options;
  const b = getBookingById(activeBookingId);
  if(!b) return false;

  const draft = getBookingDetailDraft();
  const indexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);

  b.name = draft.name;
  b.phone = draft.phone;
  b.packageIndex = draft.packageIndex;
  b.noPackage = draft.packageIndex === null;

  indexes.forEach(idx=>{
    const t = state.tables[idx];
    if(!t || !t.start) return;

    t.customer = {
      name:draft.name,
      phoneLast4:String(draft.phone || "").slice(-4)
    };

    t.packageIndex = draft.packageIndex;
    t.type = "booking";
  });

  await save("booking_detail_update");
  bookingDetailInitialSnapshot = getBookingDetailSnapshot(b);
  renderBookingGrid();
  renderList();

  if(closeModal) forceCloseBookingAction();
  if(showAlert) alert("修改成功");
  return true;
}

function forceCloseBookingAction(){
  document.getElementById("bookingActionModalBg").style.display = "none";
  activeBookingId = null;
  bookingDetailInitialSnapshot = null;
  bookingDetailClosing = false;
}

async function closeBookingAction(){
  if(bookingDetailClosing) return;

  if(!hasUnsavedBookingDetailChanges()){
    forceCloseBookingAction();
    return;
  }

  bookingDetailClosing = true;
  try{
    if(confirm("预约信息已修改。\n\n点击“确定”保存修改；点击“取消”选择是否放弃修改。")){
      await saveBookingDetail({ closeModal:true });
      return;
    }

    if(confirm("确定放弃尚未保存的修改吗？")){
      forceCloseBookingAction();
      return;
    }
  }finally{
    bookingDetailClosing = false;
  }
}

function openCheckInSelectModal(id){
  const b = getBookingById(id);
  if(!b) return;

  activeBookingId = id;

  const indexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);

  document.getElementById("checkInSelectInfo").innerHTML = `
    ${b.name || "-"}｜${b.startTime || "-"} - ${b.endTime || "-"}<br>
    预约桌位：${indexes.map(i=>state.tables[i]?.name).filter(Boolean).join("、")}
  `;

  document.getElementById("checkInMode").value = "all";

  const box = document.getElementById("checkInTableChecks");
  box.style.display = "none";

  box.innerHTML = indexes.map(i=>`
    <label class="table-check-card">
      <input type="checkbox" class="checkin-table-check" value="${i}" checked>
      ${state.tables[i]?.name || (i+1)+"号桌"}
    </label>
  `).join("");

  document.getElementById("checkInSelectModalBg").style.display = "block";
}

function toggleCheckInMode(){
  const mode = document.getElementById("checkInMode").value;
  const box = document.getElementById("checkInTableChecks");

  box.style.display = mode === "partial" ? "grid" : "none";
}

function closeCheckInSelectModal(){
  document.getElementById("checkInSelectModalBg").style.display = "none";
}

async function checkInBooking(){
  const bookingId = activeBookingId;
  if(!bookingId) return;

  // 到店操作总是使用画面中的最新资料；有修改时先自动保存。
  if(hasUnsavedBookingDetailChanges()){
    const saved = await saveBookingDetail();
    if(!saved) return;
  }

  openCheckInSelectModal(bookingId);
}

async function confirmCheckInSelected(){
  if(checkInSubmitting) return;
  const b = getBookingById(activeBookingId);
  if(!b) return;

  const allIndexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);

  const mode = document.getElementById("checkInMode").value;
  let indexes = allIndexes;

  if(mode === "partial"){
    indexes = [...document.querySelectorAll(".checkin-table-check:checked")]
      .map(el=>Number(el.value));
    if(indexes.length === 0){
      alert("请至少选择一张桌进入计时器");
      return;
    }
  }

  const busy = indexes.filter(idx=>state.tables[idx]?.start);
  if(busy.length){
    alert("以下桌位正在使用中，不能转入计时器：\n" + busy.map(i=>state.tables[i].name).join("、"));
    return;
  }

  const now = Date.now();
  for(const idx of indexes){
    const oldName = state.tables[idx]?.name || `${idx + 1}号桌`;
    const previous = state.tables[idx] || resetTable(oldName);
    state.tables[idx] = {
      ...resetTable(oldName),
      ...previous,
      name:oldName,
      type:"booking",
      bookingId:b.id,
      groupId:b.groupId,
      groupColor:b.groupColor || b.color || getNextBookingColor(),
      groupName:b.groupName || "预约组",
      activeColor:b.groupColor || b.color || getNextBookingColor(),
      customerKey:getCustomerKey(b.name,b.phone),
      pay:"",
      currency:"日元",
      payTiming:"prepaid",
      paidJPY:0,
      paidRMB:0,
      paidAt:null,
      packageIndex:b.packageIndex === null || b.packageIndex === undefined
        ? getDefaultBookingPackageIndex()
        : Number(b.packageIndex),
      customer:{
        name:b.name || "",
        phoneLast4:String(b.phone || "").slice(-4)
      },
      start:null,
      pausedAt:null,
      extra:0,
      recordId:"",
      visitId:"",
      startLocked:false,
      alerted:false,
      alerting:false,
      lastAction:"booking_arrived"
    };
  }

  b.arrived = true;
  b.arrivedAt = b.arrivedAt || now;
  b.arrivedTimeText = b.arrivedTimeText || new Date(now).toLocaleString();
  b.arrivedTableIndexes = Array.from(new Set([
    ...(b.arrivedTableIndexes || []).map(Number),
    ...indexes
  ]));

  // 这里只登记“已到店并送入计时器”，不产生账单、不计营业额。
  // 套餐费必须在计时器选择付款方式后点击“开始”才正式写入。
  //
  // 必须等待保存和云端提交完成后再跳页。iPad Safari 在 location.href
  // 执行后会立即终止当前页面尚未完成的异步任务；旧实现因此可能只留下
  // 状态副本，却没有成功建立/上传操作队列。
  const button = document.getElementById("confirmCheckInButton");
  checkInSubmitting = true;
  if(button){
    button.disabled = true;
    button.textContent = "正在保存并同步…";
  }

  try{
    state = await atomicCheckInBooking({
      db,
      ref,
      state,
      bookingId:b.id,
      tableIndexes:indexes
    });
    closeCheckInSelectModal();
    forceCloseBookingAction();
    renderBookingGrid();
    renderList();
    location.href = `./app.html#table-${indexes[0] + 1}`;
  }catch(error){
    console.error("预约到店状态保存失败",error);
    setSyncStatus("error","● 到店状态保存失败 · 未跳转");
    alert(`到店状态尚未保存成功，请不要重复操作。\n${error?.message || error}`);
  }finally{
    checkInSubmitting = false;
    if(button){
      button.disabled = false;
      button.textContent = "确认进入计时器";
    }
  }
}

function cancelBooking(){
  const b = getBookingById(activeBookingId);
  if(!b) return;

  if(!confirm("确定取消这个预约吗？")) return;

  const indexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);

  indexes.forEach(idx=>{
    const t = state.tables[idx];
    if(!t) return;

    if(
      !t.start &&
      t.type === "booking" &&
      t.customer?.name === b.name &&
      t.customer?.phoneLast4 === String(b.phone || "").slice(-4)
    ){
      t.type = "";
      t.customer = {name:"", phoneLast4:""};
    }
  });

  state.bookings = state.bookings.filter(x=>Number(x.id) !== Number(b.id));

  save();
  closeBookingAction();
  renderBookingGrid();
  renderList();
}

function printBookingGrid(){
  location.href = `./print-booking.html?date=${currentBookingDate}`;
}

function openAssignTableModal(id){

  const b = getBookingById(id);
  if(!b) return;

  assignBookingId = id;

  document.getElementById("assignBookingInfo").innerHTML = `
    <b>${b.name}</b><br>
    ${b.date}<br>
    ${b.startTime} - ${b.endTime}
  `;

  const box = document.getElementById("assignTableList");

  box.innerHTML = state.tables.map((t,i)=>{

    const conflict = hasBookingConflict(i,b,b.id);

    return `
      <button
        class="btn-${conflict?"danger":"ghost"} full"
        ${conflict?"disabled":""}
        onclick="assignBookingTable(${i})"
      >
        ${t.name}
        ${conflict?"（已有预约）":""}
      </button>
    `;

  }).join("");

  document.getElementById("assignTableModalBg").style.display="block";

}

async function assignBookingTable(index){

  const b = getBookingById(assignBookingId);

  if(!b) return;

  b.tableIndexes=[index];
  b.tableIndex=index;

  await save();

  closeAssignTableModal();

  renderList();
  renderBookingGrid();

}

function findAvailableTablesForBooking(b){
  return state.tables
    .map((t,i)=>({t,i}))
    .filter(({t,i})=>{
      if(currentBookingDate === getTodayDate() && t.start) return false;
      if(hasBookingConflict(i,b,b.id)) return false;
      return true;
    })
    .map(({i})=>i);
}

async function autoAssignBookingTable(){
  const b = getBookingById(assignBookingId);
  if(!b) return;

  const available = findAvailableTablesForBooking(b);

  if(!available.length){
    alert("没有可分配的空桌");
    return;
  }

  const people = Number(b.people || 1);
  const needTables = Math.max(1, Math.ceil(people / 2));

  let selected = available.slice(0, needTables);

  for(let i=0; i<available.length; i++){
    const group = available.slice(i, i + needTables);

    if(group.length === needTables){
      const continuous = group.every((v,idx)=>{
        return idx === 0 || v === group[idx - 1] + 1;
      });

      if(continuous){
        selected = group;
        break;
      }
    }
  }

  b.tableIndexes = selected;
  b.tableIndex = selected[0];

  await save();

  closeAssignTableModal();
  renderList();
  renderBookingGrid();

  alert("已自动分配：" + selected.map(i=>state.tables[i]?.name).join("、"));
}


function closeAssignTableModal(){

  assignBookingId=null;

  document.getElementById("assignTableModalBg").style.display="none";

}

function openGroupPayment(){
  const b = getBookingById(activeBookingId);
  if(!b) return;

  const group = getGroupById(b.groupId);

  const tables = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(i=>state.tables[Number(i)]?.name)
    .filter(Boolean)
    .join("、");

  document.getElementById("groupPaymentInfo").innerHTML = `
    <b>${b.groupName || b.name || "未命名组"}</b><br>
    桌位：${tables || "-"}<br>
    时间：${b.startTime || "-"} - ${b.endTime || "-"}<br>
    已记录付款：${group?.payments?.length || 0}笔
  `;

  document.getElementById("groupPayName").value = b.name || "";
  document.getElementById("groupPayAmount").value = "";
  document.getElementById("groupPayMethod").value = "现金";
  document.getElementById("groupPayNote").value = "";

  document.getElementById("groupPaymentModalBg").style.display = "block";
}

function closeGroupPayment(){

document.getElementById(
"groupPaymentModalBg"
).style.display="none";

}

async function confirmGroupPayment(){
  const b = getBookingById(activeBookingId);
  if(!b) return;

  const pay = document.getElementById("groupPayMethod").value;
  const payer = document.getElementById("groupPayName").value.trim();
  const amount = Number(document.getElementById("groupPayAmount").value || 0);
  const note = document.getElementById("groupPayNote").value.trim();

  if(!pay){
    alert("请选择付款方式");
    return;
  }

  if(amount <= 0){
    alert("请输入实收金额");
    return;
  }

  const tableIndexes = (b.tableIndexes || [b.tableIndex])
    .filter(v=>v !== undefined && v !== null)
    .map(Number);

  const tableNames = tableIndexes
    .map(i=>state.tables[i]?.name)
    .filter(Boolean);

  const group = createOrUpdateGroup({
    groupId:b.groupId,
    groupName:b.groupName || "预约组",
    groupColor:b.groupColor || b.color || getNextBookingColor(),
    tableIndexes,
    bookingId:b.id
  });

  const payment = {
    id:"pay_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
    type:"收入",
    reason:"整组收款",
    pay,
    payer:payer || b.name || "",
    amountJPY:amount,
    amountRMB:jpyToRmb(amount),
    tableIndexes,
    tableNames,
    note,
    receiptImage:"",
    receiptFileName:"",
    createdAt:Date.now(),
    createdTime:new Date().toLocaleString()
  };

  payment.currency = currencyForPaymentMethod(pay);
  payment.referenceOnly = true;
  if(!Array.isArray(group.payments)) group.payments = [];
  group.payments.push(payment);
  group.updatedAt = Date.now();

  await syncGroupPrepaymentsToRunningTables(b, group);

  b.groupPaymentStatus = "paid";
  b.groupPaymentUpdatedAt = Date.now();

  await save();

  closeGroupPayment();

  alert("已记录整组收款");
}

window.printBookingGrid = printBookingGrid;
window.openDatePicker = openDatePicker;
window.closeDatePicker = closeDatePicker;
window.confirmDatePicker = confirmDatePicker;
window.renderBookingGrid = renderBookingGrid;
window.startSelectSlot = startSelectSlot;
window.moveSelectSlot = moveSelectSlot;
window.endSelectSlot = endSelectSlot;
window.confirmGridBooking = confirmGridBooking;
window.closeBookingModal = closeBookingModal;
window.moveSelectByPoint = moveSelectByPoint;
window.openBookingAction = openBookingAction;
window.closeBookingAction = closeBookingAction;
window.checkInBooking = checkInBooking;
window.cancelBooking = cancelBooking;
window.saveBookingDetail = saveBookingDetail;
window.toggleBookingLock = toggleBookingLock;
window.changeCalendarMonth = changeCalendarMonth;
window.selectCalendarDate = selectCalendarDate;
window.toggleModalType = toggleModalType;
window.toggleBookingList = toggleBookingList;
window.checkInBookingById = checkInBookingById;
window.cancelBookingById = cancelBookingById;
window.openCheckInSelectModal = openCheckInSelectModal;
window.toggleCheckInMode = toggleCheckInMode;
window.closeCheckInSelectModal = closeCheckInSelectModal;
window.confirmCheckInSelected = confirmCheckInSelected;
window.openMoveTableModal = openMoveTableModal;
window.closeMoveTableModal = closeMoveTableModal;
window.confirmMoveTable = confirmMoveTable;
window.startMoveDrag = startMoveDrag;
window.openMoveRunningTableModal = openMoveRunningTableModal;
window.openAssignTableModal=openAssignTableModal;
window.assignBookingTable=assignBookingTable;
window.closeAssignTableModal=closeAssignTableModal;
window.autoAssignBookingTable = autoAssignBookingTable;
window.openGroupPayment = openGroupPayment;
window.closeGroupPayment = closeGroupPayment;
window.confirmGroupPayment = confirmGroupPayment;
window.recommendQuickBookingTables = recommendQuickBookingTables;
window.refreshQuickBookingAvailability = refreshQuickBookingAvailability;
window.updateQuickBookingSelection = updateQuickBookingSelection;
window.confirmQuickBooking = confirmQuickBooking;
window.toggleQuickBookingPanel = toggleQuickBookingPanel;
