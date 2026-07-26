// Chiptune 营业日：每天早上 06:00 换日。
// 例如 7 月 14 日 00:00–05:59 仍归属于 7 月 13 日营业收入。
export const BUSINESS_DAY_START_HOUR = 6;
// 全站统一货币配置。现金/PayPay 使用日元；微信/支付宝使用人民币。
export const RMB_PER_JPY = 0.044;
export function jpyToRmb(jpy){ return Math.floor(Number(jpy || 0) * RMB_PER_JPY); }
export function currencyForPaymentMethod(method){
  return ["微信","支付宝"].includes(String(method || "")) ? "人民币" : "日元";
}

function isRmbPayment(payment = {}, record = {}){
  const method = payment.pay || record.pay || "";
  return currencyForPaymentMethod(method) === "人民币" ||
    payment.currency === "人民币" ||
    record.currency === "人民币";
}

export function inferPaymentJPY(payment = {}, record = {}, paymentCount = 1){
  const stored = Number(payment.amountJPY || 0);
  if(stored !== 0) return stored;
  if(!isRmbPayment(payment,record)) return 0;

  const amountRMB = Number(payment.amountRMB || 0);
  if(amountRMB === 0) return 0;

  const sign = amountRMB < 0 ? -1 : 1;
  const absoluteRMB = Math.abs(amountRMB);
  const directCandidates = [
    payment.expectedJPY,
    payment.originalJPY
  ];

  if(Number(paymentCount || 0) === 1){
    directCandidates.push(
      record.originalJPY,
      record.packagePrice,
      record.paidJPY,
      record.totalJPY,
      record.jpy
    );
  }

  for(const value of directCandidates){
    const candidate = Math.abs(Number(value || 0));
    if(candidate > 0 && jpyToRmb(candidate) === absoluteRMB){
      return sign * candidate;
    }
  }

  // 人民币金额是由 Math.floor(日元 × 0.044) 得到，无法百分百反推原数。
  // 店内套餐和补收以百日元为单位，取最近的百日元可还原 145→3300。
  const reverse = absoluteRMB / RMB_PER_JPY;
  return sign * Math.max(100,Math.round(reverse / 100) * 100);
}

export function repairRecordPaymentAmounts(record = {}){
  if(!Array.isArray(record.payments) || !record.payments.length){
    return {record,changed:false};
  }

  let changed = false;
  const paymentCount = record.payments.filter(payment=>
    Number(payment?.amountJPY || 0) !== 0 ||
    Number(payment?.amountRMB || 0) !== 0
  ).length || record.payments.length;

  const payments = record.payments.map(payment=>{
    const amountJPY = inferPaymentJPY(payment,record,paymentCount);
    if(Number(payment?.amountJPY || 0) === 0 && amountJPY !== 0){
      changed = true;
      return {
        ...payment,
        amountJPY,
        jpyAmountAutoRepaired:true
      };
    }
    return payment;
  });

  if(!changed) return {record,changed:false};

  const next = {...record,payments};
  const totalJPY = payments.reduce(
    (sum,payment)=>sum + Number(payment?.amountJPY || 0),
    0
  );

  if(Number(next.totalJPY || 0) === 0) next.totalJPY = totalJPY;
  if(Number(next.paidJPY || 0) === 0) next.paidJPY = totalJPY;
  if(next.dueJPY !== undefined){
    next.dueJPY = Math.max(0,Number(next.originalJPY || next.packagePrice || 0) - totalJPY);
  }
  next.jpyAmountsAutoRepaired = true;

  return {record:next,changed:true};
}


export function dateKey(value = Date.now()){
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if(Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export function getBusinessDateKey(value = Date.now()){
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if(Number.isNaN(d.getTime())) return "";
  d.setHours(d.getHours() - BUSINESS_DAY_START_HOUR);
  return dateKey(d);
}

export function getCurrentBusinessDate(){
  return getBusinessDateKey(Date.now());
}

function parseTimestampValue(value){
  if(value === undefined || value === null || value === "") return 0;

  // Firestore Timestamp / Timestamp-like objects.
  if(typeof value?.toMillis === "function"){
    const ms = Number(value.toMillis());
    if(Number.isFinite(ms)) return ms;
  }
  if(typeof value === "object" && Number.isFinite(Number(value.seconds))){
    return Number(value.seconds) * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1e6);
  }

  if(typeof value === "number"){
    if(!Number.isFinite(value)) return 0;
    // 10 位秒时间戳兼容。
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }

  const text = String(value).trim();
  if(!text) return 0;

  // 兼容页面历史显示格式：14/07/2026, 00:00:13 或 2026/7/14 12:50:28。
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const d = new Date(Number(m[3]), Number(m[2])-1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return d.getTime();
  }
  m = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return d.getTime();
  }

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export function getRecordTimestamp(record = {}){
  const candidates = [
    record.startAt,
    record.timestamp,
    record.paidAt,
    record.closedAt,
    record.closedTime,
    record.time,
    record.date
  ];

  for(const value of candidates){
    const timestamp = parseTimestampValue(value);
    if(timestamp) return timestamp;
  }
  return 0;
}

export function getRecordBusinessDate(record = {}){
  // 手工修改过营业日的账单应保留人工指定结果。
  if(record.businessDateManual && record.businessDate){
    return String(record.businessDate);
  }

  const timestamp = getRecordTimestamp(record);
  if(timestamp) return getBusinessDateKey(timestamp);

  // 极旧数据可能只有 businessDate，没有任何可解析时间。
  return record.businessDate ? String(record.businessDate) : "";
}

export function businessDateToLocalDate(key){
  const d = new Date(`${key}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
