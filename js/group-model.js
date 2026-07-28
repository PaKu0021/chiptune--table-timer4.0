import { doc, runTransaction } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

export const GROUP_VERSION = 2;

export function groupDateKey(timestamp = Date.now()){
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}

function counterToken(number){
  const n = Math.max(1, Number(number) || 1);
  const letterIndex = Math.floor((n - 1) / 99);
  const numberPart = ((n - 1) % 99) + 1;
  let letters = "";
  let value = letterIndex;
  do{
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  }while(value >= 0);
  return `${letters}${String(numberPart).padStart(2,"0")}`;
}

export function parseGroupSequence(groupId, dateKey = ""){
  const text = String(groupId || "");
  const escaped = String(dateKey || groupDateKey()).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const match = text.match(new RegExp(`^${escaped}_([A-Z]+)(\\d{2})$`));
  if(!match) return 0;
  let letterIndex = 0;
  for(const char of match[1]) letterIndex = letterIndex * 26 + (char.charCodeAt(0) - 64);
  letterIndex -= 1;
  return letterIndex * 99 + Number(match[2] || 0);
}

export function nextLocalGroupId(groups = [], timestamp = Date.now()){
  const dateKey = groupDateKey(timestamp);
  const max = (Array.isArray(groups) ? groups : []).reduce((value,g)=>{
    return Math.max(value, parseGroupSequence(g?.id || g?.groupId, dateKey));
  },0);
  return `${dateKey}_${counterToken(max + 1)}`;
}

export async function allocateGroupId(db, groups = [], timestamp = Date.now()){
  const dateKey = groupDateKey(timestamp);
  const counterId = dateKey.replaceAll("/","-");
  const localId = nextLocalGroupId(groups,timestamp);

  // 组编号必须由云端事务唯一分配。本机顺序编号只能用于计算事务下限，
  // 不能在网络较慢时直接返回，否则两台设备可能同时拿到同一个编号。
  const timeout = new Promise((_,reject)=>setTimeout(()=>{
    const error = new Error("云端组编号分配超时，请确认网络后重试");
    error.code = "group-id-timeout";
    reject(error);
  },3000));
  const cloudAllocation = runTransaction(db, async transaction=>{
    const counterRef = doc(db,"groupCounters",counterId);
    const snap = await transaction.get(counterRef);
    const cloudNext = Number(snap.data()?.lastSequence || 0) + 1;
    const localNext = (Array.isArray(groups) ? groups : []).reduce((value,g)=>{
      return Math.max(value, parseGroupSequence(g?.id || g?.groupId,dateKey));
    },0) + 1;
    const sequence = Math.max(cloudNext,localNext);
    transaction.set(counterRef,{dateKey,lastSequence:sequence,updatedAt:Date.now()},{merge:true});
    return `${dateKey}_${counterToken(sequence)}`;
  });

  return Promise.race([cloudAllocation,timeout]);
}

export function normalizePayment(payment = {}){
  return {
    id:String(payment.id || `pay_${Date.now()}_${Math.random().toString(36).slice(2,8)}`),
    payerName:String(payment.payerName || payment.payer || ""),
    method:String(payment.method || payment.pay || ""),
    amountJPY:Number(payment.amountJPY ?? payment.amount ?? 0),
    coveredMemberIds:Array.isArray(payment.coveredMemberIds) ? payment.coveredMemberIds.map(String) : [],
    coveredTableIndexes:Array.isArray(payment.coveredTableIndexes) ? payment.coveredTableIndexes.map(Number).filter(Number.isFinite) : [],
    coveredPeople:Number(payment.coveredPeople || 0),
    note:String(payment.note || ""),
    createdAt:Number(payment.createdAt || Date.now())
  };
}

export function normalizeGroup(group = {}){
  const id = String(group.id || group.groupId || "");
  const tableIndexes = Array.from(new Set((group.tableIndexes || []).map(Number).filter(Number.isFinite)));
  const bookingIds = Array.from(new Set((group.bookingIds || []).map(String).filter(Boolean)));
  const memberIds = Array.from(new Set((group.memberIds || []).map(String).filter(Boolean)));
  const payments = Array.isArray(group.payments) ? group.payments.map(normalizePayment) : [];
  return {
    ...group,
    id,
    groupId:id,
    version:GROUP_VERSION,
    name:String(group.name || group.groupName || "未命名组"),
    color:String(group.color || group.groupColor || "#B7E4C7"),
    status:String(group.status || "active"),
    paymentMode:String(group.paymentMode || "split"),
    peopleCount:Math.max(1,tableIndexes.length || Number(group.peopleCount || group.partySize || 1)),
    tableIndexes,
    bookingIds,
    memberIds,
    payments,
    createdAt:Number(group.createdAt || Date.now()),
    updatedAt:Number(group.updatedAt || group.createdAt || Date.now())
  };
}

export function ensureGroups(state){
  if(!state || typeof state !== "object") return [];
  if(!Array.isArray(state.groups)) state.groups = [];
  const map = new Map();
  state.groups.forEach(raw=>{
    const group = normalizeGroup(raw);
    if(group.id) map.set(group.id,group);
  });
  state.groups = [...map.values()];
  return state.groups;
}

export function getGroup(state, groupId){
  const id = String(groupId || "");
  return ensureGroups(state).find(g=>g.id === id) || null;
}

export function upsertGroup(state, input = {}){
  const groups = ensureGroups(state);
  const id = String(input.id || input.groupId || "");
  if(!id) throw new Error("缺少 groupId");
  const index = groups.findIndex(g=>g.id === id);
  const merged = normalizeGroup(index >= 0 ? {...groups[index],...input,id} : {...input,id});
  if(index >= 0) groups[index] = merged; else groups.push(merged);
  return merged;
}

export function syncGroupReferences(state, group){
  if(!state || !group) return;
  const tableSet = new Set((group.tableIndexes || []).map(Number));
  (state.tables || []).forEach((table,index)=>{
    if(!table) return;
    if(tableSet.has(index)){
      table.groupId = group.id;
      table.groupName = group.name;
      table.groupColor = group.color;
    }else if(String(table.groupId || "") === group.id){
      table.groupId = ""; table.groupName = ""; table.groupColor = "";
    }
  });
  const bookingSet = new Set((group.bookingIds || []).map(String));
  (state.bookings || []).forEach(booking=>{
    if(!booking) return;
    if(bookingSet.has(String(booking.id))){
      booking.groupId = group.id;
      booking.groupName = group.name;
      booking.groupColor = group.color;
    }
  });
}

export function encodeGroupDocumentId(groupId){
  return encodeURIComponent(String(groupId || ""));
}
