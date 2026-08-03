import { db } from "./firebase.js?v=4.0.65";
import { RMB_PER_JPY } from "./business-day.js?v=4.0.65";

import { doc, onSnapshot, collection, deleteDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { setStateBaseline, saveStateSafely, installConnectionGuard, setSyncStatus, loadLocalState, reconcileCloudState, flushPending, loadLocalRecords, mergeRecordLists, saveRecordSafely, deleteRecordSafely, subscribeAllRecords } from "./safe-state.js?v=4.0.65";
import { dateKey, getCurrentBusinessDate, getRecordBusinessDate, getRecordTimestamp, businessDateToLocalDate, repairRecordPaymentAmounts } from "./business-day.js?v=4.0.65";

const ref = doc(db,"shop","main");
const recordsRef = collection(db,"records");


// 所有页面统一使用营业日模块解析账单时间，避免未定义函数及 Safari 日期格式差异。
function getRecordTime(record){
  return getRecordTimestamp(record);
}

let state = null;
installConnectionGuard();
loadLocalState().then(local=>{
  if(local && !state){
    state = local;
    try{ render(); renderBusinessHours(); }catch(err){ console.warn("本机设置显示失败",err); }
  }
});
window.addEventListener("chiptune-online-change",e=>{
  if(e.detail?.online){
    flushPending({db,ref}).catch(err=>console.warn("自动同步失败",err));
      }
});

let currentFilter = "today";
let currencyMode = "CONVERTED";
let selectedChartDate = "";
let chartHitPoints = [];
let recordsTimeSortDirection = "desc";
let packagePanelOpen = false;
let records = [];
const repairingPaymentAmountRecords = new Set();

function schedulePaymentAmountRepairs(list){
  for(const rawRecord of list || []){
    if(!rawRecord?.id) continue;
    const repaired = repairRecordPaymentAmounts(rawRecord);
    if(!repaired.changed || repairingPaymentAmountRecords.has(String(rawRecord.id))) continue;

    const record = {
      ...repaired.record,
      jpyAmountsAutoRepairedAt:Date.now()
    };
    repairingPaymentAmountRecords.add(String(rawRecord.id));
    records = mergeRecordLists(records,[record]);
    const paymentWrites = record.payments
      .filter(payment=>payment?.jpyAmountAutoRepaired && payment?.id)
      .map(payment=>setDoc(
        doc(db,"records",String(record.id),"payments",String(payment.id)),
        {
          amountJPY:Number(payment.amountJPY || 0),
          jpyAmountAutoRepaired:true
        },
        {merge:true}
      ));
    const recordPatch = {
      jpyAmountsAutoRepaired:true,
      jpyAmountsAutoRepairedAt:record.jpyAmountsAutoRepairedAt
    };
    if(Number(rawRecord.totalJPY || 0) === 0) recordPatch.totalJPY = Number(record.totalJPY || 0);
    if(Number(rawRecord.paidJPY || 0) === 0) recordPatch.paidJPY = Number(record.paidJPY || 0);
    if(rawRecord.dueJPY !== undefined) recordPatch.dueJPY = Number(record.dueJPY || 0);

    Promise.all([
      setDoc(doc(db,"records",String(record.id)),recordPatch,{merge:true}),
      ...paymentWrites
    ])
      .catch(error=>console.warn("人民币付款日元换算补全失败",error))
      .finally(()=>repairingPaymentAmountRecords.delete(String(rawRecord.id)));
  }
}

loadLocalRecords().then(localRecords=>{
  records = mergeRecordLists(records, localRecords);
  if(state) render();
}).catch(err=>console.warn("读取本机收银记录失败",err));


let customerPanelOpen = false;
let customerSearch = "";


function newTable(i){
  return {
    name:i+"号桌",
    start:null,
    extra:0,
    packageIndex:0,
    type:"",
    pay:"",
    currency:"日元",
    customer:{name:"",phoneLast4:""},
    alerted:false,
    alerting:false,
    pausedAt:null
  };
}

onSnapshot(ref,{ includeMetadataChanges:true },async snap=>{
  if(!snap.exists()) return;

  state = await reconcileCloudState(snap.data());
  if(!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) setStateBaseline(snap.data());
  if(snap.metadata.fromCache) setSyncStatus("cache");

  if(!state.packages) state.packages = [];
  if(!state.tables) state.tables = [];

  if(!state.businessHours){
  state.businessHours = {
    weekdayOpen:12,
    weekdayClose:22,
    weekendOpen:10,
    weekendClose:22
  };
}

render();
renderBusinessHours();

});

subscribeAllRecords({
  db,
  onChange:list=>{
    records=list.map(record=>repairRecordPaymentAmounts(record).record);
    schedulePaymentAmountRepairs(list);
    if(state) render();
  }
});

function save(action="owner_update"){
  return saveStateSafely({db, ref, getState:()=>state, action});
}

function getFilteredRecords(){
  const now = businessDateToLocalDate(getCurrentBusinessDate()) || new Date();

  return records.filter(r=>{
    const businessDate = getRecordBusinessDate(r);

    if(currentFilter === "all"){
      return true;
    }

    if(currentFilter === "today"){
      return businessDate === getCurrentBusinessDate();
    }

    const d = businessDateToLocalDate(businessDate);

    if(!d || isNaN(d.getTime())) return false;

    if(currentFilter === "week"){
      const day = now.getDay() || 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - day + 1);
      monday.setHours(0,0,0,0);

      const nextMonday = new Date(monday);
      nextMonday.setDate(monday.getDate()+7);

      return d >= monday && d < nextMonday;
    }

    if(currentFilter === "month"){
      return d.getFullYear() === now.getFullYear() &&
             d.getMonth() === now.getMonth();
    }

    if(currentFilter === "year"){
      return d.getFullYear() === now.getFullYear();
    }

    return true;
  });
}


function normalizePayments(r){
  if(Array.isArray(r.payments)) return repairRecordPaymentAmounts(r).record.payments;

  const amount = Number(r.totalJPY || r.jpy || 0);

  if(amount !== 0){
    return [{
      type:"收入",
      reason:r.checkoutMethod || "历史记录",
      pay:r.pay || "未记录",
      amountJPY:amount,
      amountRMB:Number(r.totalRMB || r.rmb || 0),
      note:"旧数据"
    }];
  }

  return [];
}

function currencyForManualPay(pay){
  return ["微信","支付宝"].includes(String(pay || "")) ? "人民币" : "日元";
}

function manualDateTimeMs(dateText,timeText){
  if(!dateText) return Date.now();
  const time = timeText || "12:00";
  const d = new Date(`${dateText}T${time}:00`);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function openManualRecordModal(){
  const bg = document.getElementById("manualRecordModalBg");
  if(!bg) return;

  const businessDate = document.getElementById("manualBusinessDate");
  if(businessDate) businessDate.value = getCurrentBusinessDate();

  const tableSelect = document.getElementById("manualTableName");
  if(tableSelect){
    const tables = Array.isArray(state?.tables) && state.tables.length
      ? state.tables
      : Array.from({length:12},(_,i)=>({name:`${i+1}号桌`}));
    tableSelect.innerHTML = tables.map((table,index)=>`
      <option value="${table?.name || `${index+1}号桌`}">${table?.name || `${index+1}号桌`}</option>
    `).join("");
  }

  const packageSelect = document.getElementById("manualPackageIndex");
  if(packageSelect){
    const packages = Array.isArray(state?.packages) && state.packages.length
      ? state.packages
      : [{name:"1小时",minutes:60,price:1500,extensionPrice:900}];
    packageSelect.innerHTML = packages.map((p,index)=>`
      <option value="${index}">${p.name || "套餐"}｜${p.unlimited ? "不限时" : `${Number(p.minutes || 0)}分钟`}｜¥${Number(p.price || 0).toLocaleString()}</option>
    `).join("");
  }

  document.getElementById("manualCustomerType").value = "walkin";
  document.getElementById("manualCustomerName").value = "";
  document.getElementById("manualPhoneLast4").value = "";
  document.getElementById("manualStartTime").value = "";
  document.getElementById("manualEndTime").value = "";
  document.getElementById("manualExtraMinutes").value = "0";
  document.getElementById("manualRecordNote").value = "";
  document.getElementById("manualPaymentLines").innerHTML = "";
  addManualPaymentLine("套餐预付款");
  updateManualRecordSummary();
  bg.style.display = "block";
}

function closeManualRecordModal(){
  const bg = document.getElementById("manualRecordModalBg");
  if(bg) bg.style.display = "none";
}

function addManualPaymentLine(reason="加时补收"){
  const box = document.getElementById("manualPaymentLines");
  if(!box) return;
  const row = document.createElement("div");
  row.className = "manual-payment-line";
  row.style.cssText = "display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr auto;gap:8px;align-items:end;margin:8px 0;";
  row.innerHTML = `
    <label><small>项目</small><input class="manual-payment-reason" value="${reason}"></label>
    <label><small>付款方式</small><select class="manual-payment-pay"><option>现金</option><option>PayPay</option><option>微信</option><option>支付宝</option><option>未记录</option></select></label>
    <label><small>日元金额</small><input class="manual-payment-jpy" type="number" step="1" value="0" oninput="updateManualRecordSummary()"></label>
    <label><small>人民币金额</small><input class="manual-payment-rmb" type="number" step="1" value="0" oninput="updateManualRecordSummary()"></label>
    <button class="btn-danger" type="button" onclick="this.closest('.manual-payment-line').remove();updateManualRecordSummary();">删除</button>
  `;
  box.appendChild(row);
}

function fillManualPaymentFromPackage(){
  const packageIndex = Number(document.getElementById("manualPackageIndex")?.value || 0);
  const p = state?.packages?.[packageIndex] || {};
  let row = document.querySelector("#manualPaymentLines .manual-payment-line");
  if(!row){
    addManualPaymentLine("套餐预付款");
    row = document.querySelector("#manualPaymentLines .manual-payment-line");
  }
  if(row){
    row.querySelector(".manual-payment-reason").value = "套餐预付款";
    row.querySelector(".manual-payment-jpy").value = Number(p.price || 0);
    row.querySelector(".manual-payment-rmb").value = 0;
  }
  updateManualRecordSummary();
}

function readManualPayments(){
  const now = Date.now();
  return [...document.querySelectorAll("#manualPaymentLines .manual-payment-line")]
    .map((row,index)=>{
      const pay = row.querySelector(".manual-payment-pay")?.value || "未记录";
      const amountJPY = Number(row.querySelector(".manual-payment-jpy")?.value || 0);
      const amountRMB = Number(row.querySelector(".manual-payment-rmb")?.value || 0);
      const currency = amountRMB !== 0 || currencyForManualPay(pay) === "人民币" ? "人民币" : "日元";
      return {
        id:`manual_pay_${now}_${index}_${Math.random().toString(36).slice(2,7)}`,
        operationId:`manual_op_${now}_${index}_${Math.random().toString(36).slice(2,7)}`,
        type:amountJPY < 0 || amountRMB < 0 ? "退款" : "收入",
        reason:row.querySelector(".manual-payment-reason")?.value.trim() || "补录付款",
        pay,
        currency,
        amountJPY,
        amountRMB,
        note:document.getElementById("manualRecordNote")?.value.trim() || "",
        time:new Date(now).toLocaleString(),
        timestamp:now,
        source:"manual-owner-entry"
      };
    })
    .filter(payment=>Number(payment.amountJPY || 0) !== 0 || Number(payment.amountRMB || 0) !== 0);
}

function updateManualRecordSummary(){
  const payments = readManualPayments();
  const totalJPY = payments.reduce((sum,p)=>sum + Number(p.amountJPY || 0),0);
  const totalRMB = payments.reduce((sum,p)=>sum + Number(p.amountRMB || 0),0);
  const el = document.getElementById("manualRecordSummary");
  if(el){
    el.textContent = `合计：日元 ¥${totalJPY.toLocaleString()}｜人民币 ¥${totalRMB.toLocaleString()}`;
  }
}

async function saveManualRecord(){
  const button = document.querySelector('#manualRecordModalBg .btn-main.full');
  const originalText = button?.textContent || "保存补录账单";
  try{
    const businessDate = document.getElementById("manualBusinessDate")?.value || getCurrentBusinessDate();
    const tableName = document.getElementById("manualTableName")?.value || "";
    const customerType = document.getElementById("manualCustomerType")?.value || "walkin";
    const customerName = document.getElementById("manualCustomerName")?.value.trim() || "";
    const phoneLast4 = String(document.getElementById("manualPhoneLast4")?.value || "").slice(-4);
    const packageIndex = Number(document.getElementById("manualPackageIndex")?.value || 0);
    const startTime = document.getElementById("manualStartTime")?.value || "";
    const endTime = document.getElementById("manualEndTime")?.value || "";
    const extraMinutes = Math.max(0,Number(document.getElementById("manualExtraMinutes")?.value || 0));
    const note = document.getElementById("manualRecordNote")?.value.trim() || "";
    const payments = readManualPayments();

    if(!businessDate){
      alert("请选择营业日");
      return;
    }
    if(!tableName){
      alert("请选择桌位");
      return;
    }
    if(!payments.length){
      alert("请至少填写一笔付款金额");
      return;
    }

    if(button){
      button.disabled = true;
      button.textContent = "正在保存...";
    }

    const p = state?.packages?.[packageIndex] || {};
    const startAt = manualDateTimeMs(businessDate,startTime || "12:00");
    const closedAt = manualDateTimeMs(businessDate,endTime || startTime || "12:00");
    const totalJPY = payments.reduce((sum,payment)=>sum + Number(payment.amountJPY || 0),0);
    const totalRMB = payments.reduce((sum,payment)=>sum + Number(payment.amountRMB || 0),0);
    const packagePrice = Number(p.price || 0);
    const extensionAmount = Math.max(0,totalJPY - packagePrice);
    const payMethods = [...new Set(payments.map(payment=>payment.pay || "未记录").filter(Boolean))];
    const currencies = [...new Set(payments.map(payment=>payment.currency || currencyForManualPay(payment.pay)).filter(Boolean))];
    const now = Date.now();
    const recordId = `manual_${businessDate.replace(/-/g,"")}_${now}_${Math.random().toString(36).slice(2,7)}`;

    const record = {
      id:recordId,
      manualEntry:true,
      manualEntryAt:now,
      manualEntryTime:new Date(now).toLocaleString(),
      timestamp:startAt,
      startAt,
      closedAt,
      time:new Date(startAt).toLocaleString(),
      startedTime:new Date(startAt).toLocaleString(),
      closedTime:new Date(closedAt).toLocaleString(),
      businessDate,
      businessDateManual:true,
      tableName,
      customerName,
      phoneLast4,
      customerType,
      packageName:p.name || "补录套餐",
      packageMinutes:p.unlimited ? "不限时" : Number(p.minutes || 0),
      packagePrice,
      extraMinutes,
      extensionAmount,
      originalJPY:Math.max(packagePrice + extensionAmount,totalJPY),
      payments,
      paidJPY:totalJPY,
      totalJPY,
      totalRMB,
      dueJPY:0,
      pay:payMethods.length === 1 ? payMethods[0] : "混合",
      currency:currencies.length === 1 ? currencies[0] : "混合",
      paidStatus:"已结清",
      recordType:"manual",
      status:"已补录",
      closed:true,
      checkoutMethod:"老板模式补录",
      roundRule:"补录",
      paymentNote:note,
      receiptImage:"",
      receiptFileName:"",
      updatedAt:now,
      localUpdatedAt:now
    };

    const saved = await saveRecordSafely({db,ref,record});
    records = mergeRecordLists(records,[saved]);
    closeManualRecordModal();
    render();
    alert("补录账单已保存");
  }catch(err){
    console.error("补录账单失败",err);
    alert("补录账单失败：" + (err?.message || err));
  }finally{
    if(button){
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function isRmbPayment(p, r){
  const pay = p.pay || r.pay || "";
  return pay === "微信" || pay === "支付宝" || p.currency === "人民币" || r.currency === "人民币";
}

function paymentJPY(p){
  return Number(p.amountJPY || 0);
}

function paymentRMB(p){
  if(p.amountRMB !== undefined){
    return Number(p.amountRMB || 0);
  }
  return Math.floor(Number(p.amountJPY || 0) * RMB_PER_JPY);
}


function sumPaymentsJPY(r){
  return normalizePayments(r)
    .reduce((sum,p)=>sum + Number(p.amountJPY || 0),0);
}

function paymentDetailHTML(r){
  const list = normalizePayments(r);

  if(!list.length) return r.pay || "未记录";

  return list.map(p=>{
    const amount = Number(p.amountJPY || 0);
    const sign = amount < 0 ? "-" : "+";

    return `
      <div>
        ${p.reason || p.type || ""}｜
        ${p.pay || "未记录"}｜
        ${isRmbPayment(p, r)
  ? `${sign}人民币 ¥${Math.abs(paymentRMB(p)).toLocaleString()}（日元换算 ¥${Math.abs(amount).toLocaleString()}）`
  : `${sign}日元 ¥${Math.abs(amount).toLocaleString()}`
}
        ${p.note ? `<br><small>${p.note}</small>` : ""}
      </div>
    `;
  }).join("");
}


function toJPY(r){
  if(Array.isArray(r.payments)){
    return normalizePayments(r)
      .reduce((sum,p)=>sum + Number(p.amountJPY || 0),0);
  }

  if(r.totalJPY !== undefined) return Number(r.totalJPY || 0);
  if(r.jpy !== undefined) return Number(r.jpy || 0);

  if(r.currency === "人民币"){
    return Math.floor(Number(r.totalRMB || r.rmb || 0) / RMB_PER_JPY);
  }

  return 0;
}


function toRMB(r){
  if(Array.isArray(r.payments)){
    return Math.floor(toJPY(r) * RMB_PER_JPY);
  }

  if(r.totalRMB !== undefined) return Number(r.totalRMB || 0);
  if(r.rmb !== undefined) return Number(r.rmb || 0);
  return Math.floor(toJPY(r) * RMB_PER_JPY);
}

function actualRMBIncome(r){
  return normalizePayments(r).reduce((sum,p)=>{
    if(isRmbPayment(p,r)){
      return sum + paymentRMB(p);
    }
    return sum;
  },0);
}

function displayCurrency(r){
  const list = normalizePayments(r);
  const hasRmb = list.some(p=>isRmbPayment(p,r));
  const hasJpy = list.some(p=>!isRmbPayment(p,r));

  if(hasRmb && hasJpy) return "混合";
  if(hasRmb) return "人民币";
  return "日元";
}

function getPaySummary(r){
  const pays = [...new Set(
    normalizePayments(r)
      .filter(p=>Number(p.amountJPY || 0) !== 0 || Number(p.amountRMB || 0) !== 0)
      .map(p=>p.pay || r.pay || "未记录")
  )];
  if(pays.length === 0) return r.pay || "未记录";
  if(pays.length === 1) return pays[0];
  return "混合";
}

function buildCurrencySummary(rows){
  const channels = {
    "现金":{currency:"日元",amount:0},
    "PayPay":{currency:"日元",amount:0},
    "微信":{currency:"人民币",amount:0},
    "支付宝":{currency:"人民币",amount:0},
    "未记录":{currency:"日元",amount:0}
  };
  let actualJPY = 0;
  let actualRMB = 0;
  rows.forEach(r=>{
    normalizePayments(r).forEach(p=>{
      const pay = p.pay || r.pay || "未记录";
      const rmb = isRmbPayment(p,r);
      const amount = rmb ? paymentRMB(p) : paymentJPY(p);
      if(!channels[pay]) channels[pay] = {currency:rmb ? "人民币" : "日元",amount:0};
      channels[pay].currency = rmb ? "人民币" : "日元";
      channels[pay].amount += amount;
      if(rmb) actualRMB += amount; else actualJPY += amount;
    });
  });
  const jpyToRmb = Math.floor(actualJPY * RMB_PER_JPY);
  const rmbToJpy = Math.floor(actualRMB / RMB_PER_JPY);
  return {
    channels, actualJPY, actualRMB, jpyToRmb, rmbToJpy,
    convertedJPY: actualJPY + rmbToJpy,
    convertedRMB: actualRMB + jpyToRmb
  };
}

function channelSummaryText(summary){
  return Object.entries(summary.channels)
    .filter(([,v])=>Number(v.amount)!==0)
    .map(([name,v])=>`${name} ${v.currency === "人民币" ? "人民币 " : ""}¥${Math.floor(v.amount).toLocaleString()}`)
    .join(" / ") || "暂无";
}

function getAmountByMode(r){
  const jpy = toJPY(r);

  if(currencyMode === "JPY"){
    return jpy;
  }

  if(currencyMode === "RMB"){
  return actualRMBIncome(r);
}

  return jpy;
}

function filterName(){
  if(currentFilter === "today") return "今天";
  if(currentFilter === "week") return "本周";
  if(currentFilter === "month") return "本月";
  if(currentFilter === "year") return "本年";
  return "全部";
}

function render(){
  renderButtons();
  renderSummary();
  renderChart();
  renderPackages();
  renderRecords();
  renderCustomers();
  const tableInput = document.getElementById("tableCount");
  if(tableInput) tableInput.value = state.tables.length || 0;

  const packageBody = document.getElementById("packagePanelBody");
const packageBtn = document.getElementById("packageToggleBtn");

if(packageBody){
  packageBody.style.display = packagePanelOpen ? "block" : "none";
}

if(packageBtn){
  packageBtn.innerText = packagePanelOpen ? "收起" : "展开";
}
const customerBody = document.getElementById("customerPanelBody");
const customerBtn = document.getElementById("customerToggleBtn");

if(customerBody){
  customerBody.style.display = customerPanelOpen ? "block" : "none";
}

if(customerBtn){
  customerBtn.innerText = customerPanelOpen ? "收起" : "展开";
}
}

function renderButtons(){
  ["today","week","month","year","all"].forEach(k=>{
    const btn = document.getElementById("f_"+k);
    if(btn) btn.classList.toggle("active",currentFilter === k);
  });

document.getElementById("c_jpy")?.classList.toggle("active",currencyMode === "JPY");
document.getElementById("c_rmb")?.classList.toggle("active",currencyMode === "RMB");
document.getElementById("c_converted")?.classList.toggle("active",currencyMode === "CONVERTED");

}

function renderSummary(){
  const list = getFilteredRecords();
  const summary = buildCurrencySummary(list);
  const typeStats = {walkin:0, booking:0};
  list.forEach(r=>{ const type=r.customerType || r.type || "walkin"; typeStats[type]=(typeStats[type]||0)+1; });
  document.getElementById("summary").innerHTML =
    `${filterName()}｜日元实收：¥${Math.floor(summary.actualJPY).toLocaleString()}｜日元→人民币参考：人民币 ¥${Math.floor(summary.jpyToRmb).toLocaleString()}｜人民币实收：人民币 ¥${Math.floor(summary.actualRMB).toLocaleString()}｜人民币→日元参考：¥${Math.floor(summary.rmbToJpy).toLocaleString()}｜换算日元总收入：¥${Math.floor(summary.convertedJPY).toLocaleString()}｜笔数：${list.length}`;
  document.getElementById("payStats").innerHTML =
    `付款渠道：${channelSummaryText(summary)}<br>客源：Walk-in ${typeStats.walkin || 0}笔 / 预约 ${typeStats.booking || 0}笔`;
}

function renderChart(){
  const canvas = document.getElementById("chart");
  if(!canvas) return;
  chartHitPoints = [];
  canvas.onclick = null;

  const panel = canvas.closest(".panel");
  const availableWidth = Math.max(320, Math.floor((panel?.clientWidth || window.innerWidth) - 48));
  const cssWidth = Math.min(availableWidth, 1500);
  const cssHeight = Math.max(320, Math.min(440, Math.round(cssWidth * 0.34)));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssWidth,cssHeight);

  const list = getFilteredRecords();
  const grouped = {};

  list.forEach(r=>{
    const key = getRecordBusinessDate(r);
    const value = currencyMode === "RMB" ? actualRMBIncome(r) : toJPY(r);
    grouped[key] = (grouped[key] || 0) + value;
  });

  const labels = Object.keys(grouped).sort();
  const values = labels.map(k=>grouped[k]);
  const unitText = currencyMode === "JPY"
    ? "日元收入"
    : currencyMode === "RMB"
      ? "人民币收入"
      : "换算日元总收入";

  const padL = 78;
  const padR = 36;
  const padT = 76;
  const padB = 58;
  const w = cssWidth - padL - padR;
  const h = cssHeight - padT - padB;

  ctx.textBaseline = "alphabetic";
  ctx.font = "600 15px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = "#332d24";
  ctx.fillText(`单位：${unitText}`,padL,28);

  ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = "#8a8174";
  ctx.fillText("按营业日统计",padL,50);

  if(!labels.length){
    ctx.font = "15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#8a8174";
    ctx.textAlign = "center";
    ctx.fillText("暂无收入数据",padL + w / 2,padT + h / 2);
    ctx.textAlign = "left";
    return;
  }

  const maxValue = Math.max(...values,1);
  const roughStep = maxValue / 5;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep,1)));
  const normalized = roughStep / magnitude;
  const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const yStep = niceFactor * magnitude;
  const yMax = Math.max(yStep * 5, Math.ceil(maxValue / yStep) * yStep);
  const steps = Math.max(4, Math.round(yMax / yStep));

  ctx.strokeStyle = "#ebe2d4";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";

  for(let i=0;i<=steps;i++){
    const y = padT + h - (i/steps)*h;
    const value = Math.round((yMax/steps)*i);

    ctx.beginPath();
    ctx.moveTo(padL,y);
    ctx.lineTo(padL+w,y);
    ctx.stroke();

    ctx.fillStyle = "#8a8174";
    ctx.fillText(value.toLocaleString(),padL-12,y+4);
  }

  ctx.strokeStyle = "#6b6258";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(padL,padT);
  ctx.lineTo(padL,padT+h);
  ctx.lineTo(padL+w,padT+h);
  ctx.stroke();

  const points = labels.map((label,i)=>({
    label,
    value:values[i],
    x:labels.length === 1 ? padL + w/2 : padL + i*(w/(labels.length-1)),
    y:padT + h - (values[i]/yMax)*h
  }));
  chartHitPoints = points.map(point=>({...point,cssWidth,cssHeight}));

  // 轻微面积填充，让走势更容易辨认。
  const gradient = ctx.createLinearGradient(0,padT,0,padT+h);
  gradient.addColorStop(0,"rgba(216,169,0,0.22)");
  gradient.addColorStop(1,"rgba(216,169,0,0.02)");
  ctx.beginPath();
  ctx.moveTo(points[0].x,padT+h);
  points.forEach((point,i)=> i === 0 ? ctx.lineTo(point.x,point.y) : ctx.lineTo(point.x,point.y));
  ctx.lineTo(points[points.length-1].x,padT+h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = "#d8a900";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach((point,i)=> i === 0 ? ctx.moveTo(point.x,point.y) : ctx.lineTo(point.x,point.y));
  ctx.stroke();

  const minLabelGap = 34;
  points.forEach((point,i)=>{
    const selected = selectedChartDate === point.label;
    if(selected){
      ctx.fillStyle = "rgba(43,111,201,.18)";
      ctx.beginPath();
      ctx.arc(point.x,point.y,12,0,Math.PI*2);
      ctx.fill();
    }
    ctx.fillStyle = "#332d24";
    ctx.beginPath();
    ctx.arc(point.x,point.y,selected ? 7 : 5,0,Math.PI*2);
    ctx.fill();

    ctx.strokeStyle = selected ? "#2b6fc9" : "#fffaf1";
    ctx.lineWidth = selected ? 3 : 2;
    ctx.stroke();

    const isNearTop = point.y < padT + 28;
    const prev = points[i-1];
    const next = points[i+1];
    const crowded = (prev && Math.abs(prev.y-point.y)<minLabelGap) || (next && Math.abs(next.y-point.y)<minLabelGap);
    const placeBelow = isNearTop || (crowded && i % 2 === 1);
    const labelY = placeBelow ? point.y + 22 : point.y - 14;

    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    const text = Math.floor(point.value).toLocaleString();
    const textWidth = ctx.measureText(text).width;
    const boxX = Math.max(padL, Math.min(point.x - textWidth/2 - 5, padL+w-textWidth-10));
    ctx.fillStyle = "rgba(255,250,241,0.92)";
    ctx.beginPath();
    ctx.roundRect(boxX,labelY-13,textWidth+10,18,6);
    ctx.fill();
    ctx.fillStyle = "#4b4339";
    ctx.fillText(text,boxX+(textWidth+10)/2,labelY);

    ctx.fillStyle = "#8a8174";
    ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(point.label.slice(5),point.x,padT+h+28);
  });

  ctx.textAlign = "left";

  canvas.onclick = event=>{
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (cssWidth / rect.width);
    const y = (event.clientY - rect.top) * (cssHeight / rect.height);
    let nearest = null;
    let nearestDistance = Infinity;
    for(const point of chartHitPoints){
      const distance = Math.hypot(point.x-x,point.y-y);
      if(distance < nearestDistance){
        nearest = point;
        nearestDistance = distance;
      }
    }
    if(!nearest || nearestDistance > 32) return;
    selectedChartDate = nearest.label;
    renderChart();
    renderRecords();
    document.getElementById("recordsPanel")?.scrollIntoView({behavior:"smooth",block:"start"});
  };
}

let chartResizeTimer = null;
window.addEventListener("resize",()=>{
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(renderChart,160);
});

function renderPackages(){
  const box = document.getElementById("packageBox");
  box.innerHTML = "";

  state.packages.forEach((p,i)=>{
    const row = document.createElement("div");
    row.className = "package-setting-row";

    row.innerHTML = `
      <label class="package-field">
        <span class="package-field-label">套餐名称${p.customPricing ? "（独立金额套餐）" : ""}</span>
        <input data-pkg-name="${i}" value="${p.name || ""}" placeholder="例如：2小时活动套餐">
      </label>

      <label class="package-field">
        <span class="package-field-label">套餐时长（分钟）</span>
        <span class="package-field-hint">填写 0 代表不限时</span>
        <input type="number" min="0" step="1" data-pkg-minutes="${i}" value="${p.minutes || 0}" placeholder="例如：120">
      </label>

      <label class="package-field">
        <span class="package-field-label">套餐金额（日元）</span>
        <input type="number" min="0" step="1" data-pkg-price="${i}" value="${p.price || 0}" placeholder="例如：2800">
      </label>

      <label class="package-field">
        <span class="package-field-label">续时金额（每1小时／日元）</span>
        <input type="number" min="0" step="1" data-pkg-extension="${i}" value="${p.extensionPrice || 0}" placeholder="例如：900">
      </label>

      <button class="btn-danger package-delete-btn" type="button" onclick="removePackage(${i})">删除套餐</button>
    `;

    box.appendChild(row);
  });
}

function renderRecords(){
  const rows = getFilteredRecords()
    .filter(r=>!selectedChartDate || getRecordBusinessDate(r) === selectedChartDate)
    .sort((a,b)=>{
      const difference = Number(getRecordTimestamp(a) || 0) - Number(getRecordTimestamp(b) || 0);
      return recordsTimeSortDirection === "asc" ? difference : -difference;
    });
  const title = document.getElementById("recordsTitle");
  const note = document.getElementById("recordDateFilterNote");
  const sortButton = document.getElementById("recordsTimeSortBtn");
  if(title){
    title.innerText = selectedChartDate
      ? `${selectedChartDate} 收银记录`
      : "收银记录";
  }
  if(note){
    note.style.display = selectedChartDate ? "flex" : "none";
    note.innerHTML = selectedChartDate
      ? `<span>当前显示营业日：${selectedChartDate}（${rows.length}笔）</span><button class="btn-ghost" type="button" onclick="clearChartDateFilter()">显示当前范围全部记录</button>`
      : "";
  }
  if(sortButton){
    sortButton.innerText = recordsTimeSortDirection === "asc"
      ? "时间：旧 → 新"
      : "时间：新 → 旧";
  }

  document.getElementById("records").innerHTML = rows.length ? rows.map(r=>{
    const table = r.tableName || r.table || "";
    const name = r.customerName || r.name || "";
    const phone = r.phoneLast4 || "";
    const type = (r.customerType || r.type) === "booking" ? "预约" : "Walk-in";
    const packageName = r.packageName || "";
    const extra = Number(r.extraMinutes || 0);
    const original = r.originalJPY || r.totalJPY || r.jpy || 0;
    const jpy = toJPY(r);
    const rmb = actualRMBIncome(r);

    return `
      <tr style="${getPaySummary(r)!=="现金" ? "height:120px;" : ""}">
        <td>${r.closedTime || r.time || ""}</td>
        <td>${table}</td>
        <td>${name}${phone ? "("+phone+")" : ""}</td>
        <td>${type}</td>
        <td>${packageName}</td>
        <td>${extra}分</td>
        <td>¥${Number(original).toLocaleString()}</td>
        <td>¥${Number(jpy).toLocaleString()}</td>
        <td>¥${Number(rmb).toLocaleString()}</td>
        <td>${paymentDetailHTML(r)}</td>        
        <td>${displayCurrency(r)}</td>
        <td>${r.roundRule || ""}</td>

        <td>
          ${r.receiptImage
            ? `<img
    src="${r.receiptImage}"
    onclick="viewReceipt('${r.id}')"
    style="width:60px;height:60px;object-fit:cover;border-radius:8px;cursor:pointer;"
  >`
            : `<button class="btn-ghost" onclick="uploadReceipt('${r.id}')">上传</button>`
          }
        </td>

        <td>
          ${extra > 0
            ? (
                r.extensionConfirmed
                  ? `已确认<br><small>${r.extensionConfirmedTime || ""}</small>`
                  : `<button class="btn-main" onclick="confirmExtension('${r.id}')">续费确认</button>`
              )
            : "-"
          }
        </td>
        <td>
  <button class="btn-danger" onclick="deleteOwnerRecord('${r.id}')">
    删除
  </button>
</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="15">该营业日暂无收银记录</td></tr>`;

}

function buildCustomerStats(){
  const map = {};

  records.forEach(r=>{
    const name = r.customerName || r.name || "";
    const phone = r.phoneLast4 || "";
    const key = r.customerKey || `${name}_${phone}`;

    if(!name && !phone) return;

    if(!map[key]){
      map[key] = {
        key,
        name,
        phone,
        visitCount:0,
        totalJPY:0,
        lastTime:0,
        lastTimeText:"",
        lastPackage:""
      };
    }

    const ts = getRecordTime(r);

    const jpy = sumPaymentsJPY(r);

map[key].visitCount += 1;
map[key].totalJPY += jpy;

    if(ts > map[key].lastTime){
      map[key].lastTime = ts;
      map[key].lastTimeText = r.closedTime || r.time || "";
      map[key].lastPackage = r.packageName || "";
    }
  });

  return Object.values(map)
    .sort((a,b)=>b.totalJPY - a.totalJPY);
}

function renderCustomers(){
  const summary = document.getElementById("customerSummary");
  const tbody = document.getElementById("customerRows");

  if(!summary || !tbody) return;

  let list = buildCustomerStats();

  const kw = customerSearch.trim().toLowerCase();

  if(kw){
    list = list.filter(c=>{
      return [
        c.name,
        c.phone,
        c.key
      ].join(" ").toLowerCase().includes(kw);
    });
  }

  const totalCustomers = list.length;
  const totalVisits = list.reduce((sum,c)=>sum + c.visitCount,0);
  const totalAmount = list.reduce((sum,c)=>sum + c.totalJPY,0);

  summary.innerHTML =
    `客户数：${totalCustomers}人｜来店记录：${totalVisits}次｜累计消费：¥${Math.floor(totalAmount).toLocaleString()}`;

  if(!list.length){
    tbody.innerHTML = `
      <tr>
        <td colspan="6">暂无客户记录</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map(c=>`
    <tr>
      <td>${c.name || "-"}</td>
      <td>${c.phone || "-"}</td>
      <td>${c.visitCount}</td>
      <td>¥${Math.floor(c.totalJPY).toLocaleString()}</td>
      <td>${c.lastTimeText || "-"}</td>
      <td>${c.lastPackage || "-"}</td>
    </tr>
  `).join("");
}

function toggleCustomerPanel(){
  customerPanelOpen = !customerPanelOpen;
  render();
}

function setCustomerSearch(v){
  customerSearch = v || "";
  renderCustomers();
}

let uploadingRecordId = null;

function uploadReceipt(recordId){
  uploadingRecordId = recordId;

  let input = document.getElementById("ownerReceiptInput");

  if(!input){
    input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.id = "ownerReceiptInput";
    input.style.display = "none";

    input.onchange = handleOwnerReceiptFileChange;

    document.body.appendChild(input);
  }

  input.value = "";
  input.click();
}

async function compressImage(file){
  return new Promise(resolve=>{
    const img = new Image();

    img.onload = ()=>{
      const canvas = document.createElement("canvas");

      const maxWidth = 600;

      const scale = Math.min(1,maxWidth / img.width);

      canvas.width = img.width * scale;
      canvas.height = img.height * scale;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img,0,0,canvas.width,canvas.height);

      canvas.toBlob(
        blob=>resolve(blob),
        "image/jpeg",
        0.45
      );
      
    };

    img.src = URL.createObjectURL(file);
  });
}

async function handleOwnerReceiptFileChange(e){
  const file = e.target.files?.[0];

  if(!file || !uploadingRecordId) return;

  const r = records.find(x => x.id === uploadingRecordId);
  if(!r){
    alert("找不到这条账单");
    return;
  }

  try{
    const compressedBlob = await compressImage(file);
    const base64 = await fileToBase64(compressedBlob);

    r.receiptImage = base64;
    delete r.receiptPath;
    r.receiptFileName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    r.receiptUploadedAt = Date.now();
    r.receiptUploadedTime = new Date().toLocaleString();

    const linked = r.groupId ? records.filter(x=>String(x.groupId||"")===String(r.groupId)) : [r];
    for(const item of linked){ item.receiptImage=base64; item.receiptFileName=r.receiptFileName; item.receiptUploadedAt=r.receiptUploadedAt; item.receiptUploadedTime=r.receiptUploadedTime; await saveRecordSafely({db,ref,record:item}); }

    uploadingRecordId = null;
    alert("收款截图已保存");
  }catch(err){
    console.error(err);
    alert("保存失败：" + err.message);
  }
}

function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function viewReceipt(recordId){
  const r = records.find(x => x.id === recordId);

  if(!r || !r.receiptImage){
    alert("没有截图");
    return;
  }

  let bg = document.getElementById("receiptPreviewBg");

  if(!bg){
    bg = document.createElement("div");
    bg.id = "receiptPreviewBg";
    bg.className = "modal-bg";
    bg.innerHTML = `
      <div class="modal" style="max-height:90vh;overflow:auto;">
        <h2>收款截图</h2>
        <img
          id="receiptPreviewImg"
          style="width:100%;height:auto;border-radius:16px;margin:12px 0;display:block;"
        >
        <button class="btn-ghost full" onclick="closeReceiptPreview()">关闭</button>
      </div>
    `;
    document.body.appendChild(bg);
  }

  document.getElementById("receiptPreviewImg").src = r.receiptImage;
  bg.style.display = "block";
}

function closeReceiptPreview(){
  const bg = document.getElementById("receiptPreviewBg");
  if(bg) bg.style.display = "none";
}

function confirmExtension(recordId){
const r = records.find(x=>x.id === recordId);  
  if(!r) return;

  if(!r.receiptImage){
    const ok = confirm("这笔续费还没有上传收款截图，确定先确认吗？");
    if(!ok) return;
  }

  r.extensionConfirmed = true;
  r.extensionConfirmedAt = Date.now();
  r.extensionConfirmedTime = new Date().toLocaleString();

  saveRecordSafely({db,ref,record:r}).catch(err=>{
    console.error("续费确认同步失败",err);
    showOwnerMessage("续费确认已保存在本机，云端将在联网后重试。");
  });
  alert("续费已确认");
}

let pendingDeleteRecordId = null;

function deleteOwnerRecord(recordId){
  const r = records.find(x=>String(x.id) === String(recordId));
  if(!r){
    showOwnerMessage("找不到这条记录，请重新加载页面。");
    return;
  }

  pendingDeleteRecordId = String(recordId);
  let bg = document.getElementById("ownerDeleteRecordBg");
  if(!bg){
    bg = document.createElement("div");
    bg.id = "ownerDeleteRecordBg";
    bg.className = "modal-bg";
    bg.innerHTML = `
      <div class="modal" style="max-width:560px;">
        <h2>删除收银记录</h2>
        <div id="ownerDeleteRecordSummary" style="line-height:1.8;margin:12px 0 18px;"></div>
        <div style="background:#fff0f0;color:#a32121;padding:12px;border-radius:12px;font-weight:800;margin-bottom:14px;">
          删除后会立即从本机列表移除，并在联网后删除云端记录。
        </div>
        <button id="ownerDeleteRecordConfirmBtn" class="btn-danger full" onclick="confirmDeleteOwnerRecord()">确认删除</button>
        <button class="btn-ghost full" style="margin-top:10px;" onclick="closeDeleteOwnerRecord()">取消</button>
      </div>`;
    document.body.appendChild(bg);
  }

  document.getElementById("ownerDeleteRecordSummary").innerHTML = `
    <b>${r.tableName || "未知桌位"}</b><br>
    ${r.closedTime || r.time || ""}<br>
    ${r.packageName || ""}｜实收 ¥${Number(sumPaymentsJPY(r) || 0).toLocaleString()}`;
  const btn = document.getElementById("ownerDeleteRecordConfirmBtn");
  btn.disabled = false;
  btn.textContent = "确认删除";
  bg.style.display = "flex";
}

function closeDeleteOwnerRecord(){
  const bg = document.getElementById("ownerDeleteRecordBg");
  if(bg) bg.style.display = "none";
  pendingDeleteRecordId = null;
}

async function confirmDeleteOwnerRecord(){
  const id = pendingDeleteRecordId;
  if(!id) return;
  const btn = document.getElementById("ownerDeleteRecordConfirmBtn");
  if(btn){ btn.disabled = true; btn.textContent = "正在删除…"; }

  try{
    await deleteRecordSafely({db,ref,recordId:id});
    records = records.filter(r=>String(r.id)!==id);
    closeDeleteOwnerRecord();
    render();
    showOwnerMessage("记录已从本机删除；如暂时离线，恢复网络后会自动删除云端记录。");
  }catch(err){
    console.error(err);
    if(btn){ btn.disabled = false; btn.textContent = "确认删除"; }
    showOwnerMessage("删除失败：" + (err?.message || err));
  }
}

function showOwnerMessage(text){
  let bg = document.getElementById("ownerMessageBg");
  if(!bg){
    bg = document.createElement("div");
    bg.id = "ownerMessageBg";
    bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal" style="max-width:520px;"><h2>提示</h2><div id="ownerMessageText" style="line-height:1.7;margin:16px 0;"></div><button class="btn-main full" onclick="closeOwnerMessage()">知道了</button></div>`;
    document.body.appendChild(bg);
  }
  document.getElementById("ownerMessageText").textContent = text;
  bg.style.display = "flex";
}
function closeOwnerMessage(){ const bg=document.getElementById("ownerMessageBg"); if(bg) bg.style.display="none"; }

function collectPackagesFromInputs(){
  state.packages = state.packages.map((p,i)=>({
    name: document.querySelector(`[data-pkg-name="${i}"]`)?.value || p.name || "新套餐",
    minutes: Number(document.querySelector(`[data-pkg-minutes="${i}"]`)?.value || 0),
    price: Number(document.querySelector(`[data-pkg-price="${i}"]`)?.value || 0),
    extensionPrice: Number(document.querySelector(`[data-pkg-extension="${i}"]`)?.value || 0),
    unlimited: Number(document.querySelector(`[data-pkg-minutes="${i}"]`)?.value || 0) === 0,
    customPricing: Boolean(p.customPricing)
  }));
}

function addPackage(){
  collectPackagesFromInputs();

  state.packages.push({
    name:"自定义套餐",
    minutes:60,
    price:0,
    extensionPrice:0,
    unlimited:false,
    customPricing:true
  });

  render();
}

function removePackage(i){
  collectPackagesFromInputs();

  if(state.packages.length <= 1){
    alert("至少保留一个套餐");
    return;
  }

  state.packages.splice(i,1);

  state.tables.forEach(t=>{
    const current = Number(t.packageIndex || 0);
    if(current === i){
      t.packageIndex = 0;
    }else if(current > i){
      t.packageIndex = current - 1;
    }
  });

  render();
}

async function savePackages(){
  collectPackagesFromInputs();
  state.packages = state.packages.map((p,i)=>{
    const name = document.querySelector(`[data-pkg-name="${i}"]`).value || "未命名套餐";
    const minutes = Number(document.querySelector(`[data-pkg-minutes="${i}"]`).value || 0);
    const price = Number(document.querySelector(`[data-pkg-price="${i}"]`).value || 0);
    const extensionPrice = Number(document.querySelector(`[data-pkg-extension="${i}"]`).value || 0);

    return {
      name,
      minutes,
      price,
      extensionPrice,
      unlimited: minutes === 0,
      customPricing: Boolean(p.customPricing)
    };
  });

  const invalid = state.packages.find(p => !p.name.trim() || p.minutes < 0 || p.price < 0 || p.extensionPrice < 0);
  if(invalid){
    alert("请确认套餐名称已填写，时长和金额均不能为负数");
    return;
  }

  await save("package_settings_update");
  alert("套餐设置已保存，计时器页面会自动更新套餐列表");
}

function saveTableCount(){
  const count = Number(document.getElementById("tableCount").value || state.tables.length);

  if(count < 1) return alert("桌位数量至少为1");

  if(count > state.tables.length){
    for(let i=state.tables.length;i<count;i++){
      state.tables.push(newTable(i+1));
    }
  }else if(count < state.tables.length){
    const deleting = state.tables.slice(count);
    const hasRunning = deleting.some(t=>t.start);

    if(hasRunning && !confirm("删除范围内有正在计时桌位，确定删除吗？")){
      return;
    }

    state.tables = state.tables.slice(0,count);
  }

  save();
  alert("桌位数量已保存");
}

function exportCSV(){
  const rows = getFilteredRecords();

  const headers = [
    "时间","桌位","客人姓名","手机尾号","类型","套餐",
    "续费分钟","原价日元","结账日元","人民币","付款渠道","币种","抹零规则"
  ];

  const body = rows.map(r=>[
    r.time || "",
    r.tableName || r.table || "",
    r.customerName || r.name || "",
    r.phoneLast4 || "",
    (r.customerType || r.type) === "booking" ? "预约" : "Walk-in",
    r.packageName || "",
    r.extraMinutes || 0,
    r.originalJPY || r.totalJPY || r.jpy || 0,
    toJPY(r),
    actualRMBIncome(r),
    paymentDetailHTML(r).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(),    
    displayCurrency(r),
    r.roundRule || ""
  ]);

  const csv = [headers,...body]
    .map(row=>row.map(cell=>`"${String(cell ?? "").replace(/"/g,'""')}"`).join(","))
    .join("\n");

  const blob = new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chiptune_${currentFilter}_${dateKey(Date.now())}.csv`;
  a.click();
}

function setFilter(v){
  currentFilter = v;
  selectedChartDate = "";
  render();
}

function clearChartDateFilter(){
  selectedChartDate = "";
  renderChart();
  renderRecords();
}

function toggleRecordTimeSort(){
  recordsTimeSortDirection = recordsTimeSortDirection === "asc" ? "desc" : "asc";
  renderRecords();
}

function setCurrencyMode(v){
  currencyMode = v;
  render();
}

function togglePackagePanel(){
  packagePanelOpen = !packagePanelOpen;

  const body = document.getElementById("packagePanelBody");
  const btn = document.getElementById("packageToggleBtn");

  if(body){
    body.style.display = packagePanelOpen ? "block" : "none";
  }

  if(btn){
    btn.innerText = packagePanelOpen ? "收起" : "展开";
  }
}


function renderBusinessHours(){
  const h = state.businessHours || {
    weekdayOpen:12,
    weekdayClose:22,
    weekendOpen:10,
    weekendClose:22
  };

  const ids = ["weekdayOpen","weekdayClose","weekendOpen","weekendClose"];

  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.value = h[id];
  });
}

function saveBusinessHours(){
  state.businessHours = {
    weekdayOpen: Number(document.getElementById("weekdayOpen").value || 12),
    weekdayClose: Number(document.getElementById("weekdayClose").value || 22),
    weekendOpen: Number(document.getElementById("weekendOpen").value || 10),
    weekendClose: Number(document.getElementById("weekendClose").value || 22)
  };

  save();
  alert("营业时间已保存");
}

function logoutOwner(){
  sessionStorage.removeItem("owner_auth");
  sessionStorage.removeItem("owner_auth_time");
  location.href="./index.html";
}

function setTopActionActive(type){

  document
    .getElementById("btnQrPage")
    ?.classList.remove("active-top-btn");

  document
    .getElementById("btnCashierPage")
    ?.classList.remove("active-top-btn");

  if(type === "qr"){
    document
      .getElementById("btnQrPage")
      ?.classList.add("active-top-btn");
  }

  if(type === "cashier"){
    document
      .getElementById("btnCashierPage")
      ?.classList.add("active-top-btn");
  }
}

function openQrPage(){
  setTopActionActive("qr");

  setTimeout(()=>{
    location.href = "./qr.html";
  },120);
}

function openCashierPage(){
  setTopActionActive("cashier");

  setTimeout(()=>{
    location.href = "./cashier.html";
  },120);
}

window.logoutOwner = logoutOwner;
window.saveBusinessHours = saveBusinessHours;
window.togglePackagePanel = togglePackagePanel;
window.setFilter = setFilter;
window.clearChartDateFilter = clearChartDateFilter;
window.toggleRecordTimeSort = toggleRecordTimeSort;
window.setCurrencyMode = setCurrencyMode;
window.addPackage = addPackage;
window.removePackage = removePackage;
window.savePackages = savePackages;
window.saveTableCount = saveTableCount;
window.exportCSV = exportCSV;
window.openQrPage = openQrPage;
window.openCashierPage = openCashierPage;
window.openManualRecordModal = openManualRecordModal;
window.closeManualRecordModal = closeManualRecordModal;
window.addManualPaymentLine = addManualPaymentLine;
window.fillManualPaymentFromPackage = fillManualPaymentFromPackage;
window.updateManualRecordSummary = updateManualRecordSummary;
window.saveManualRecord = saveManualRecord;
window.uploadReceipt = uploadReceipt;
window.confirmExtension = confirmExtension;
window.toggleCustomerPanel = toggleCustomerPanel;
window.setCustomerSearch = setCustomerSearch;
window.deleteOwnerRecord = deleteOwnerRecord;
window.confirmDeleteOwnerRecord = confirmDeleteOwnerRecord;
window.closeDeleteOwnerRecord = closeDeleteOwnerRecord;
window.closeOwnerMessage = closeOwnerMessage;
window.viewReceipt = viewReceipt;
window.closeReceiptPreview = closeReceiptPreview;
