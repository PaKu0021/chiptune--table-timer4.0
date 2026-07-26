import { doc, onSnapshot, collection, setDoc } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { setStateBaseline, saveStateSafely, installConnectionGuard, setSyncStatus, loadLocalState, reconcileCloudState, flushPending, loadLocalRecords, mergeRecordLists, saveRecordSafely, subscribeAllRecords, emergencySaveRecord, emergencySaveState } from "./safe-state.js?v=4.0.35";
import { encodeGroupDocumentId, ensureGroups } from "./group-model.js?v=4.0.35";
import { dateKey, getCurrentBusinessDate, getRecordBusinessDate, getRecordTimestamp } from "./business-day.js?v=4.0.35";
import { RMB_PER_JPY } from "./business-day.js?v=4.0.35";


import { db } from "./firebase.js?v=4.0.35";

const ref = doc(db, "shop", "main");
const recordsRef = collection(db, "records");


let state = null;
installConnectionGuard();
loadLocalState().then(local=>{
  if(local && !state){
    state = local;
    try{ renderTodayBill(); }catch(err){ console.warn("本机账单状态显示失败",err); }
  }
});
window.addEventListener("chiptune-online-change",e=>{
  if(e.detail?.online){
    flushPending({db,ref}).catch(err=>console.warn("自动同步失败",err));
  }
});

let records = [];
loadLocalRecords().then(localRecords=>{
  records = mergeRecordLists(records, localRecords);
  renderTodayBill();
}).catch(err=>console.warn("读取本机账单失败",err));

window.addEventListener("chiptune-record-broadcast",event=>{
  const record = event.detail?.record;
  if(!record?.id) return;
  records = mergeRecordLists(records,[record]);
  renderTodayBill();
});


let editingRecordId = null;
let uploadingPaymentRecordId = null;
let uploadingPaymentIndex = null;
let uploadingGroupId = null;
let uploadingGroupPaymentIndex = null;
let editingGroupId = null;
let groupReceiptMap = {};
let timeSortDirection = "asc";

// 整组截图独立存放，避免把 Base64 图片塞进 shop/main。
onSnapshot(collection(db,"groupReceipts"), snap=>{
  const next = {};
  snap.docs.forEach(d=>{ const data=d.data(); next[String(data.groupId || d.id)] = {id:d.id,...data}; });
  groupReceiptMap = next;
  try{ renderTodayBill(); }catch(err){ console.warn("整组截图刷新失败",err); }
}, err=>console.warn("整组截图监听失败",err));


onSnapshot(ref, { includeMetadataChanges:true }, async snap => {
  if(!snap.exists()) return;

  state = await reconcileCloudState(snap.data());
  if(!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) setStateBaseline(snap.data());
  if(snap.metadata.fromCache) setSyncStatus("cache");

ensureGroups(state);

renderTodayBill();
  
});

subscribeAllRecords({
  db,
  onChange:list=>{ records=list; renderTodayBill(); }
});

function getRecordTime(record){
  return getRecordTimestamp(record);
}


function normalizePayments(r){
  if(Array.isArray(r.payments)) return r.payments;

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


function paymentCurrency(pay){
  return pay === "微信" || pay === "支付宝" ? "人民币" : "日元";
}

function summarizePaymentMethods(payments){
  const methods = [...new Set((payments || [])
    .filter(p=>Number(p.amountJPY || 0) !== 0)
    .map(p=>p.pay || "未记录"))];
  if(methods.length === 0) return "未记录";
  return methods.length === 1 ? methods[0] : "混合";
}

function summarizeCurrencies(payments){
  const currencies = [...new Set((payments || [])
    .filter(p=>Number(p.amountJPY || 0) !== 0)
    .map(p=>p.currency || paymentCurrency(p.pay)))];
  if(currencies.length === 0) return "日元";
  return currencies.length === 1 ? currencies[0] : "混合";
}

function makeManualAdjustment({amountJPY, pay, note, reason}){
  return {
    operationId:`manual_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type: amountJPY < 0 ? "退款" : "收入",
    reason: reason || (amountJPY < 0 ? "手动退款修正" : "手动补收修正"),
    pay: pay || "未记录",
    currency: paymentCurrency(pay),
    amountJPY:Number(amountJPY || 0),
    amountRMB:paymentCurrency(pay) === "人民币"
      ? Math.floor(Number(amountJPY || 0) * RMB_PER_JPY)
      : 0,
    note:note || "",
    time:new Date().toLocaleString(),
    timestamp:Date.now()
  };
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

  return list.map((p,i)=>{
    const amount = Number(p.amountJPY || 0);
    const sign = amount < 0 ? "-" : "+";
    const style = amount < 0
      ? "color:#e85d5d;font-weight:900;"
      : "font-weight:800;";

    const pay = p.pay || "未记录";
    const needReceipt = pay !== "现金" && amount !== 0;

    let receiptHTML = "";

    if(needReceipt){
      if(p.receiptImage){
        receiptHTML = `
          <br>
          <button class="btn-ghost" onclick="viewPaymentReceipt('${r.id}',${i})">
            查看截图
          </button>
        `;
      }else{
        receiptHTML = `
          <br>
          <button class="btn-main" onclick="uploadPaymentReceipt('${r.id}',${i})">
            上传截图
          </button>
        `;
      }
    }else{
      receiptHTML = `<br><small style="color:#8a8174;">现金无需截图</small>`;
    }

    return `
      <div style="${style}">
        ${p.reason || p.type || ""}｜
        ${pay}｜
        ${isRmbPayment(p, r)
  ? `${sign}人民币 ¥${Math.abs(paymentRMB(p)).toLocaleString()}（日元换算 ¥${Math.abs(amount).toLocaleString()}）`
  : `${sign}日元 ¥${Math.abs(amount).toLocaleString()}`
}
        ${p.note ? `<br><small style="color:#8a8174;">${p.note}</small>` : ""}
        ${receiptHTML}
      </div>
    `;
  }).join("");
}

function getTodayRecords(){
  return records.filter(r=>{
    return getRecordBusinessDate(r) === getCurrentBusinessDate();
  });
}



function getGroupMap(){
  const map = {};

  (state?.groups || []).forEach(g=>{
    map[g.id] = g;
  });

  return map;
}

function getRecordsByGroup(list){
  const map = {};
  const singles = [];

  list.forEach(r=>{
    if(r.groupId){
      if(!map[r.groupId]) map[r.groupId] = [];
      map[r.groupId].push(r);
    }else{
      singles.push(r);
    }
  });

  return {map, singles};
}

function toJPY(r){
  if(Array.isArray(r.payments)){
    return sumPaymentsJPY(r);
  }

  if(r.totalJPY !== undefined) return Number(r.totalJPY || 0);
  if(r.jpy !== undefined) return Number(r.jpy || 0);
  if(r.currency === "人民币") return Math.floor(Number(r.totalRMB || r.rmb || 0) / RMB_PER_JPY);
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

function compressImage(file, maxWidth = 600, quality = 0.45){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    const reader = new FileReader();

    reader.onload = e=>{
      img.src = e.target.result;
    };

    img.onload = ()=>{
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(blob=>{
        if(!blob){
          reject(new Error("图片压缩失败"));
          return;
        }

        resolve(new File(
          [blob],
          file.name.replace(/\.[^.]+$/, "") + ".jpg",
          { type:"image/jpeg" }
        ));
      }, "image/jpeg", quality);
    };

    img.onerror = reject;
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function updateTodayTimeSortHeader(){
  const button = document.getElementById("todayTimeSortButton");
  if(!button) return;
  const ascending = timeSortDirection === "asc";
  button.innerHTML = `时间 <span aria-hidden="true">${ascending ? "▲" : "▼"}</span>`;
  button.title = ascending ? "当前从早到晚，点击切换为从晚到早" : "当前从晚到早，点击切换为从早到晚";
  button.setAttribute("aria-label", button.title);
}

function toggleTodayTimeSort(){
  timeSortDirection = timeSortDirection === "asc" ? "desc" : "asc";
  renderTodayBill();
}

function renderTodayBill(){
  updateTodayTimeSortHeader();
  const list = getTodayRecords();
  const groupMap = getGroupMap();
  const summary = buildCurrencySummary(list);
  const typeStats = {walkin:0, booking:0};
  list.forEach(r=>{ const type=r.customerType || r.type || "walkin"; typeStats[type]=(typeStats[type]||0)+1; });

  document.getElementById("todaySummary").innerHTML = `
    日元实收：¥${Math.floor(summary.actualJPY).toLocaleString()}<br>
    日元实收对应人民币参考：人民币 ¥${Math.floor(summary.jpyToRmb).toLocaleString()}<br>
    人民币实收：人民币 ¥${Math.floor(summary.actualRMB).toLocaleString()}<br>
    人民币实收对应日元参考：¥${Math.floor(summary.rmbToJpy).toLocaleString()}<br>
    换算日元总收入：¥${Math.floor(summary.convertedJPY).toLocaleString()}<br>
    换算人民币总收入：人民币 ¥${Math.floor(summary.convertedRMB).toLocaleString()}<br>
    笔数：${list.length}`;

  document.getElementById("todayPayStats").innerHTML = `
    付款渠道：${channelSummaryText(summary)}<br>
    客源：Walk-in ${typeStats.walkin || 0}笔 / 预约 ${typeStats.booking || 0}笔`;

  const directionFactor = timeSortDirection === "asc" ? 1 : -1;
  const compareRecordsByTime = (a,b)=>{
    const diff = getRecordTime(a) - getRecordTime(b);
    if(diff) return diff * directionFactor;
    return String(a.tableName || "").localeCompare(String(b.tableName || ""), "zh-CN", {numeric:true}) * directionFactor;
  };
  const chronological = [...list].sort(compareRecordsByTime);
  const { map:groupRecords, singles } = getRecordsByGroup(chronological);

  // 组作为一个完整区块显示；区块按照组内最早一笔账单时间排列，散桌也参与同一时间轴。
  const blocks = [
    ...Object.keys(groupRecords).map(groupId=>({
      type:"group",
      groupId,
      rows:groupRecords[groupId].sort(compareRecordsByTime),
      time:Math.min(...groupRecords[groupId].map(getRecordTime).filter(Boolean)) || 0
    })),
    ...singles.map(record=>({type:"single", record, time:getRecordTime(record)}))
  ].sort((a,b)=>(a.time-b.time) * directionFactor);

  let html = "";

  blocks.forEach(block=>{
    if(block.type === "single"){
      html += renderRecordRow(block.record,true);
      return;
    }
    const groupId = block.groupId;
    const rows = block.rows;
    const group = groupMap[groupId];

    html += `
      <tr style="background:${group?.color || "#eef8ff"};font-weight:900;">
        <td colspan="15">
          👥 ${group?.name || rows[0]?.groupName || "未命名组"}
          （${rows.map(r=>r.tableName).join("、")}）
          <button class="btn-ghost" style="margin-left:12px;" onclick="openEditGroup('${groupId}')">修改组 / 加桌</button>
          ${rows.length > 1 && rows.some(r=>getPaySummary(r)!=="现金") ? (rows.find(r=>r.receiptImage) ? `<button class="btn-ghost" style="margin-left:8px;" onclick="viewPaymentReceipt('${rows.find(r=>r.receiptImage).id}',0)">查看共用截图</button>` : `<button class="btn-main" style="margin-left:8px;" onclick="uploadSharedGroupReceipt('${groupId}')">上传共用截图（只需一次）</button>`) : ""}
        </td>
      </tr>
    `;

    if(group?.payments?.length){
      const nonCashGroupPayment = group.payments.find(p=>p.pay && p.pay !== "现金");
      const legacyReceiptPayment = group.payments.find(p=>p.receiptImage);
      const groupReceipt = groupReceiptMap[String(group.id)] || null;
      const groupHasReceipt = !!(groupReceipt?.receiptImage || group.receiptImage || legacyReceiptPayment?.receiptImage);
      html += `
        <tr>
          <td colspan="15" style="background:#fffaf0;font-weight:800;">
            ${group.payments.map(p=>`
              整组付款：${p.reason || "整组收款"}｜${p.pay || "未记录"}｜¥${Number(p.amountJPY || 0).toLocaleString()}｜付款人：${p.payer || "-"}
            `).join("<br>")}
            ${nonCashGroupPayment
              ? (groupHasReceipt
                  ? `<br><button class="btn-ghost" onclick="viewGroupPaymentReceipt('${group.id}')">查看整组付款截图</button>`
                  : `<br><button class="btn-main" onclick="uploadGroupPaymentReceipt('${group.id}')">上传整组付款截图（只需一次）</button>`)
              : `<br><small style="color:#8a8174;">整组均为现金，无需截图</small>`}
          </td>
        </tr>
      `;
    }

    rows.forEach(r=>{
      html += renderRecordRow(r,false);
    });
  });

  document.getElementById("todayRecords").innerHTML = html;
}


function renderRecordRow(r, showReceipt = true){
  const table = r.tableName || r.table || "";
  const name = r.customerName || r.name || "";
  const phone = r.phoneLast4 || "";
  const type = (r.customerType || r.type) === "booking" ? "预约" : "Walk-in";
  const packageName = r.packageName || "";
  const extra = r.extraMinutes || 0;
  const original = r.originalJPY || r.totalJPY || r.jpy || 0;

  return `
    <tr>
      <td>${r.closedTime || r.time || ""}</td>
      <td>${table}</td>
      <td>${name}${phone ? "(" + phone + ")" : ""}</td>
      <td>${type}</td>
      <td>${packageName}</td>
      <td>${extra}分</td>
      <td>¥${Number(original).toLocaleString()}</td>
      <td>¥${Number(toJPY(r)).toLocaleString()}</td>
      <td>¥${Number(actualRMBIncome(r)).toLocaleString()}</td>
      <td>${paymentDetailHTML(r)}</td>
      <td>${displayCurrency(r)}</td>
      <td>${r.roundRule || ""}</td>
      <td>
        ${showReceipt
          ? (
              r.receiptImage
                ? `<img src="${r.receiptImage}" onclick="viewReceipt('${r.id}')" style="width:60px;height:60px;object-fit:cover;border-radius:8px;cursor:pointer;">`
                : `<button class="btn-ghost" onclick="uploadReceipt('${r.id}')">上传</button>`
            )
          : "-"
        }
      </td>
      <td>
        ${Number(r.extraMinutes || 0) > 0
          ? (
              r.extensionConfirmed
                ? `已确认<br><small>${r.extensionConfirmedTime || ""}</small>`
                : `<button class="btn-main" onclick="confirmExtension('${r.id}')">续费确认</button>`
            )
          : "-"
        }
      </td>
      <td>
        <button class="btn-ghost" onclick="openEditRecord('${r.id}')">
          修改
        </button>
      </td>
    </tr>
  `;
}

function uploadReceipt(recordId){
  const input = document.getElementById("receiptInput");
  if(!input){
    alert("找不到 receiptInput，请先在 today-bill.html 加上传 input");
    return;
  }

  input.value = "";
  input.dataset.recordId = recordId;
  input.click();
}

function uploadPaymentReceipt(recordId, paymentIndex){
  const input = document.getElementById("receiptInput");

  if(!input){
    alert("找不到 receiptInput");
    return;
  }

  uploadingPaymentRecordId = recordId;
  uploadingPaymentIndex = Number(paymentIndex);

  input.value = "";
  input.dataset.recordId = "";
  input.click();
}

function uploadGroupPaymentReceipt(groupId){
  const input = document.getElementById("receiptInput");
  if(!input){
    alert("找不到 receiptInput");
    return;
  }
  uploadingGroupId = groupId;
  uploadingGroupPaymentIndex = -1;
  uploadingPaymentRecordId = null;
  uploadingPaymentIndex = null;
  input.value = "";
  input.dataset.recordId = "";
  input.click();
}

async function handleReceiptFileChange(e){

  const file = e.target.files?.[0];
  const recordId = e.target.dataset.recordId;

if(!file) return;

if(uploadingGroupId !== null && uploadingGroupPaymentIndex !== null){
  await handleGroupPaymentReceiptFile(file);
  return;
}

if(uploadingPaymentRecordId !== null && uploadingPaymentIndex !== null){
  await handlePaymentReceiptFile(file);
  return;
}

if(!recordId) return;

  const r = records.find(x=>x.id===recordId);

  if(!r){
    alert("找不到这条账单");
    return;
  }

  try{

    const compressed = await compressImage(file,800,0.6);

    const base64 = await fileToBase64(compressed);

    r.receiptImage = base64;
    r.receiptFileName = file.name;
    r.receiptUploadedAt = Date.now();
    r.receiptUploadedTime = new Date().toLocaleString();

    await saveRecordSafely({db,ref,record:r});
    records = mergeRecordLists(records,[r]);
    renderTodayBill();

    alert("收款截图已保存");

  }catch(err){

    console.error(err);
    alert(err.message);

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

async function handlePaymentReceiptFile(file){

  const record = records.find(r=>r.id===uploadingPaymentRecordId);

  if(!record){
    alert("找不到账单");
    return;
  }

  if(!Array.isArray(record.payments)){
    alert("这条账单没有 payments");
    return;
  }

  const payment = record.payments[uploadingPaymentIndex];

  if(!payment){
    alert("找不到付款记录");
    return;
  }

  try{

    const compressed = await compressImage(file,800,0.6);

    const base64 = await fileToBase64(compressed);

    const uploadedAt = Date.now();
    payment.receiptImage = base64;
    payment.receiptFileName = file.name;
    payment.receiptUploadedAt = uploadedAt;
    payment.receiptUploadedTime = new Date(uploadedAt).toLocaleString();
    // 同时保存在账单级别，避免付款明细合并或索引变化后出现“查看但没有截图”。
    record.receiptImage = base64;
    record.receiptFileName = file.name;
    record.receiptUploadedAt = uploadedAt;
    record.receiptUploadedTime = payment.receiptUploadedTime;

    await saveRecordSafely({db,ref,record});
    records = mergeRecordLists(records,[record]);
    renderTodayBill();

    uploadingPaymentRecordId = null;
    uploadingPaymentIndex = null;

    alert("付款截图已保存");

  }catch(err){

    console.error(err);
    alert(err.message);

  }

}

async function handleGroupPaymentReceiptFile(file){
  const group = (state.groups || []).find(g=>String(g.id) === String(uploadingGroupId));
  if(!group){
    alert("找不到整组记录");
    return;
  }
  try{
    const compressed = await compressImage(file,800,0.6);
    const base64 = await fileToBase64(compressed);
    const receiptDoc = {
      groupId:String(group.id),
      receiptImage:base64,
      receiptFileName:file.name,
      receiptUploadedAt:Date.now(),
      receiptUploadedTime:new Date().toLocaleString(),
      updatedAt:Date.now()
    };
    // 独立文档保存。shop/main 中不再写入图片。
    await setDoc(doc(db,"groupReceipts",encodeGroupDocumentId(group.id)), receiptDoc, {merge:true});
    groupReceiptMap[String(group.id)] = receiptDoc;
    // 清理旧版可能残留在主状态和付款明细中的重复图片。
    delete group.receiptImage;
    delete group.receiptFileName;
    delete group.receiptUploadedAt;
    delete group.receiptUploadedTime;
    (group.payments || []).forEach(p=>{
      delete p.receiptImage;
      delete p.receiptFileName;
      delete p.receiptUploadedAt;
      delete p.receiptUploadedTime;
    });
    saveStateSafely({db, ref, getState:()=>state, action:"cleanup_legacy_group_receipt"})
      .catch(err=>console.warn("旧整组截图字段清理稍后重试",err));
    uploadingGroupId = null;
    uploadingGroupPaymentIndex = null;
    alert("整组付款截图已保存（整组只需上传一次）");
    renderTodayBill();
  }catch(err){
    console.error(err);
    alert(err.message);
  }
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


function viewPaymentReceipt(recordId, paymentIndex){
  const r = records.find(x=>x.id === recordId);
  const p = r?.payments?.[paymentIndex];

  const receiptImage = p?.receiptImage || r?.receiptImage;
  if(!receiptImage){
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
        <h2>付款截图</h2>
        <img id="receiptPreviewImg" style="width:100%;height:auto;border-radius:16px;margin:12px 0;display:block;">
        <button class="btn-ghost full" onclick="closeReceiptPreview()">关闭</button>
      </div>
    `;
    document.body.appendChild(bg);
  }

  document.getElementById("receiptPreviewImg").src = receiptImage;
  bg.style.display = "block";
}

function viewGroupPaymentReceipt(groupId){
  const group = (state.groups || []).find(g=>String(g.id) === String(groupId));
  const legacy = group?.payments?.find(p=>p.receiptImage);
  const receiptDoc = groupReceiptMap[String(groupId)] || null;
  const receiptImage = receiptDoc?.receiptImage || group?.receiptImage || legacy?.receiptImage;

  if(!receiptImage){
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
        <h2>整组付款截图</h2>
        <img id="receiptPreviewImg" style="width:100%;height:auto;border-radius:16px;margin:12px 0;display:block;">
        <button class="btn-ghost full" onclick="closeReceiptPreview()">关闭</button>
      </div>
    `;
    document.body.appendChild(bg);
  }

  document.getElementById("receiptPreviewImg").src = receiptImage;
  bg.style.display = "block";
}

function closeReceiptPreview(){
  const bg = document.getElementById("receiptPreviewBg");
  if(bg) bg.style.display = "none";
}

async function confirmExtension(recordId){
const r = records.find(x => x.id === recordId);

  if(!r) return;

  const hasReceipt = normalizePayments(r).some(p=>{
  if(p.pay === "现金") return true;
  return !!p.receiptImage;
});

if(!hasReceipt){
  r.extensionReceiptPending = true;
}

  r.extensionConfirmed = true;
  r.extensionConfirmedAt = Date.now();
  r.extensionConfirmedTime = new Date().toLocaleString();

  await saveRecordSafely({db, ref, record:r});
  alert("续费已确认");
}


function openEditGroup(groupId){
  const group = (state?.groups || []).find(g=>String(g.id) === String(groupId));
  if(!group){ alert("找不到这个组"); return; }
  editingGroupId = String(groupId);
  const today = getTodayRecords();
  const currentIds = new Set(today.filter(r=>String(r.groupId || "") === editingGroupId).map(r=>String(r.id)));
  document.getElementById("editGroupInfo").innerHTML = `
    <b>${group.name || "未命名组"}</b><br>
    当前桌位：${today.filter(r=>currentIds.has(String(r.id))).map(r=>r.tableName).filter(Boolean).join("、") || "-"}
  `;
  document.getElementById("editGroupRecordList").innerHTML = today
    .filter(r=>r.id && r.tableName)
    .sort((a,b)=>String(a.tableName).localeCompare(String(b.tableName),"zh-CN",{numeric:true}))
    .map(r=>{
      const checked = currentIds.has(String(r.id));
      const otherGroup = r.groupId && String(r.groupId)!==editingGroupId;
      return `<label class="edit-group-card ${checked ? "selected" : ""} ${otherGroup ? "other-group" : ""}">
        <input type="checkbox" class="edit-group-record-check" value="${r.id}" ${checked ? "checked" : ""} onchange="this.closest('.edit-group-card')?.classList.toggle('selected', this.checked)">
        <span class="edit-group-checkmark" aria-hidden="true">✓</span>
        <span class="edit-group-card-body">
          <strong>${r.tableName}</strong>
          <span class="edit-group-customer">${r.customerName || "未填写姓名"}</span>
          <span class="edit-group-package">${r.packageName || "未选择套餐"}</span>
          ${otherGroup ? '<em>当前属于其他组，选择后会移入本组</em>' : ''}
        </span>
      </label>`;
    }).join("") || "今天暂无可加入的桌位账单";
  document.getElementById("editGroupModalBg").style.display = "block";
}

function closeEditGroup(){
  editingGroupId = null;
  document.getElementById("editGroupModalBg").style.display = "none";
}

async function saveEditedGroup(){
  const group = (state?.groups || []).find(g=>String(g.id) === String(editingGroupId));
  if(!group){ alert("找不到这个组"); return; }
  const selectedIds = [...document.querySelectorAll(".edit-group-record-check:checked")].map(el=>String(el.value));
  if(!selectedIds.length){ alert("请至少选择一张桌"); return; }

  const button = document.querySelector('#editGroupModalBg .btn-main');
  if(button){ button.disabled=true; button.textContent="正在保存…"; }

  const now = Date.now();
  const today = getTodayRecords().filter(r=>r.id && r.tableName);
  const selectedSet = new Set(selectedIds);
  const changedRecords = [];
  const selectedTableIndexes = [];

  // 先把所有关系在内存中一次性算完，再统一保存，避免逐条 await 造成半完成状态。
  for(const r of today){
    const belongsHere = String(r.groupId || "") === String(group.id);
    const selected = selectedSet.has(String(r.id));
    const idx = (state.tables || []).findIndex(t=>String(t?.name || "") === String(r.tableName || ""));

    if(selected){
      r.groupId = group.id;
      r.groupName = group.name || "未命名组";
      r.groupColor = group.color || "#eef8ff";
      r.editedAt = now;
      if(idx >= 0){
        selectedTableIndexes.push(idx);
        const t = state.tables[idx];
        t.groupId = group.id;
        t.groupName = group.name;
        t.groupColor = group.color;
        t.activeColor = group.color || t.activeColor;
      }
      changedRecords.push(r);
    }else if(belongsHere){
      delete r.groupId;
      delete r.groupName;
      delete r.groupColor;
      r.editedAt = now;
      if(idx >= 0){
        const t = state.tables[idx];
        if(String(t?.groupId || "") === String(group.id)){
          delete t.groupId; delete t.groupName; delete t.groupColor;
        }
      }
      changedRecords.push(r);
    }
  }

  // 从其他组中移除这次被转入本组的桌位，避免一桌残留在多个组。
  const selectedIndexSet = new Set(selectedTableIndexes.map(Number));
  for(const g of (state.groups || [])){
    if(String(g.id) === String(group.id)) continue;
    const before = Array.isArray(g.tableIndexes) ? g.tableIndexes.map(Number) : [];
    const after = before.filter(i=>!selectedIndexSet.has(i));
    if(after.length !== before.length){
      g.tableIndexes = after;
      g.updatedAt = now;
    }
  }

  group.tableIndexes = Array.from(new Set(selectedTableIndexes.map(Number)));
  group.updatedAt = now;

  try{
    // 先同步写入本机影子并立即关闭窗口；云端上传全部转入后台。
    changedRecords.forEach(r=>emergencySaveRecord({db,ref,record:r}));
    emergencySaveState({db,ref,state,action:"today_bill_replace_group_tables"});

    closeEditGroup();
    renderTodayBill();

    Promise.all(changedRecords.map(r=>saveRecordSafely({db,ref,record:r})))
      .catch(err=>console.warn("组账单后台同步失败，将自动重试",err));
    saveStateSafely({db,ref,getState:()=>state,action:"today_bill_replace_group_tables"})
      .catch(err=>console.warn("组状态后台同步失败，将自动重试",err));
  }finally{
    if(button){ button.disabled=false; button.textContent="保存组桌位"; }
  }
}

function openEditRecord(recordId){
  const r = records.find(x=>x.id === recordId);

  if(!r){
    alert("找不到这条账单");
    return;
  }

  editingRecordId = recordId;

  document.getElementById("editRecordInfo").innerHTML = `
    ${r.closedTime || r.time || ""}<br>
    ${r.tableName || ""}｜${r.customerName || "-"} ${r.phoneLast4 || ""}
  `;

  renderEditPayments(normalizePayments(r));
  document.getElementById("editBusinessDate").value =
  getRecordBusinessDate(r) || r.businessDate || "";

  document.getElementById("editGroupPaid").value =
    r.groupPaymentId ? "yes" : "";

  document.getElementById("editGroupPayerName").value =
    r.groupPayerName || "";

  document.getElementById("editGroupPaymentId").value =
    r.groupPaymentId || "";

  document.getElementById("editPaymentNote").value =
    r.paymentNote || r.groupPaymentNote || "";

  document.getElementById("editRecordModalBg").style.display = "block";
}

function closeEditRecord(){
  editingRecordId = null;
  document.getElementById("editRecordModalBg").style.display = "none";
}

function editPaymentRowHTML(payment = {}, index = -1){
  const pay = payment.pay || "现金";
  const amountJPY = Number(payment.amountJPY || 0);
  const amountRMB = Number(payment.amountRMB || 0);
  const note = payment.note || "";
  return `
    <div class="edit-payment-row" data-original-index="${index}" style="border:1px solid #e7dfd2;border-radius:12px;padding:10px;margin-bottom:9px;background:#fff;">
      <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:8px;align-items:end;">
        <div><label style="margin-top:0;">方式</label><select class="edit-payment-pay">
          ${["现金","PayPay","微信","支付宝"].map(x=>`<option value="${x}" ${x===pay?'selected':''}>${x}</option>`).join('')}
        </select></div>
        <div><label style="margin-top:0;">日元金额</label><input class="edit-payment-jpy" type="number" value="${amountJPY}"></div>
        <div><label style="margin-top:0;">人民币金额</label><input class="edit-payment-rmb" type="number" value="${amountRMB}"></div>
        <button type="button" class="btn-ghost" style="height:46px;padding:0 14px;" onclick="removeEditPaymentRow(this)">删除</button>
      </div>
      <label>该笔备注</label>
      <input class="edit-payment-note" value="${String(note).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" placeholder="例如：补收、退款、代付">
    </div>`;
}

function renderEditPayments(payments){
  const list = Array.isArray(payments) && payments.length ? payments : [{pay:"现金",amountJPY:0,amountRMB:0,note:""}];
  document.getElementById("editPaymentsList").innerHTML = list.map((p,i)=>editPaymentRowHTML(p,i)).join("");
}

function addEditPaymentRow(){
  document.getElementById("editPaymentsList").insertAdjacentHTML("beforeend", editPaymentRowHTML({pay:"现金",amountJPY:0,amountRMB:0,note:""},-1));
}

function removeEditPaymentRow(button){
  const rows = document.querySelectorAll("#editPaymentsList .edit-payment-row");
  if(rows.length <= 1){ alert("账单至少需要保留一条付款记录"); return; }
  button.closest(".edit-payment-row")?.remove();
}

async function saveEditedRecord(){
  const r = records.find(x=>x.id === editingRecordId);
  if(!r){ alert("找不到这条账单"); return; }

  const originalPayments = normalizePayments(r).map(p=>({...p}));
  const rows = [...document.querySelectorAll("#editPaymentsList .edit-payment-row")];
  if(!rows.length){ alert("请至少保留一条付款记录"); return; }

  const now = Date.now();
  const payments = rows.map((row, rowIndex)=>{
    const originalIndex = Number(row.dataset.originalIndex ?? -1);
    const old = originalIndex >= 0 ? (originalPayments[originalIndex] || {}) : {};
    const pay = row.querySelector(".edit-payment-pay").value;
    const amountJPY = Number(row.querySelector(".edit-payment-jpy").value || 0);
    const amountRMB = Number(row.querySelector(".edit-payment-rmb").value || 0);
    const paymentNote = row.querySelector(".edit-payment-note").value.trim();
    return {
      ...old,
      operationId: old.operationId || `manual_edit_${now}_${rowIndex}_${Math.random().toString(36).slice(2,7)}`,
      type: amountJPY < 0 || amountRMB < 0 ? "退款" : "收入",
      reason: old.reason || "手动编辑付款记录",
      pay,
      currency: paymentCurrency(pay),
      amountJPY,
      amountRMB,
      note: paymentNote,
      time: old.time || new Date(now).toLocaleString(),
      timestamp: old.timestamp || now,
      editedAt: now
    };
  });

  const groupPaid = document.getElementById("editGroupPaid").value === "yes";
  const groupPayerName = document.getElementById("editGroupPayerName").value.trim();
  const groupPaymentId = document.getElementById("editGroupPaymentId").value.trim();
  const note = document.getElementById("editPaymentNote").value.trim();
  const businessDate = document.getElementById("editBusinessDate").value;

  r.payments = payments;
  r.totalJPY = payments.reduce((sum,p)=>sum + Number(p.amountJPY || 0),0);
  r.totalRMB = payments.reduce((sum,p)=>sum + Number(p.amountRMB || 0),0);
  r.paidJPY = r.totalJPY;
  const originalJPY = Number(r.originalJPY ?? r.packagePrice ?? r.totalJPY ?? 0);
  r.originalJPY = originalJPY;
  r.dueJPY = Math.max(0, originalJPY - r.paidJPY);
  r.pay = summarizePaymentMethods(payments);
  r.currency = summarizeCurrencies(payments);
  r.paidStatus = r.dueJPY > 0 ? "未结清" : "已结清";
  r.businessDate = businessDate || getRecordBusinessDate(r);
  r.businessDateManual = Boolean(businessDate);
  r.paymentNote = note;
  r.editedAt = now;
  r.editedTime = new Date(now).toLocaleString();

  if(groupPaid){
    r.groupPaymentId = groupPaymentId || ("manual_group_" + dateKey(now));
    r.groupPayerName = groupPayerName;
    r.groupPaymentNote = note;
  }else{
    delete r.groupPaymentId;
    delete r.groupPayerName;
    delete r.groupPaymentNote;
  }

  await saveRecordSafely({db, ref, record:r});
  closeEditRecord();
  renderTodayBill();
  alert("付款记录已修改");
}

window.addEditPaymentRow = addEditPaymentRow;
window.removeEditPaymentRow = removeEditPaymentRow;

window.toggleTodayTimeSort = toggleTodayTimeSort;
window.confirmExtension = confirmExtension;
window.uploadReceipt = uploadReceipt;
window.handleReceiptFileChange = handleReceiptFileChange;
window.viewReceipt = viewReceipt;
window.closeReceiptPreview = closeReceiptPreview;
window.openEditRecord = openEditRecord;
window.closeEditRecord = closeEditRecord;
window.saveEditedRecord = saveEditedRecord;
window.uploadPaymentReceipt = uploadPaymentReceipt;
window.viewPaymentReceipt = viewPaymentReceipt;
window.uploadGroupPaymentReceipt = uploadGroupPaymentReceipt;
window.viewGroupPaymentReceipt = viewGroupPaymentReceipt;
window.openEditGroup = openEditGroup;
window.closeEditGroup = closeEditGroup;
window.saveEditedGroup = saveEditedGroup;

window.uploadSharedGroupReceipt = function(groupId){
  const input=document.createElement("input"); input.type="file"; input.accept="image/*";
  input.onchange=async()=>{ const file=input.files?.[0]; if(!file)return; const rows=records.filter(r=>String(r.groupId||"")===String(groupId)); if(!rows.length)return;
    const compressedBlob=await compressImage(file); const base64=await fileToBase64(compressedBlob);
    for(const r of rows){ r.receiptImage=base64; r.receiptFileName=file.name||""; r.receiptUploadedAt=Date.now(); r.receiptUploadedTime=new Date().toLocaleString(); await saveRecordSafely({db,ref,record:r}); }
    records=mergeRecordLists(records,rows); renderTodayBill(); alert("整组收款截图已保存，组内账单共用此截图");
  }; input.click();
};
