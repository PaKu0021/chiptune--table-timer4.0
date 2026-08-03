import { db } from "./firebase.js?v=4.0.54";
import {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

const logEl = document.getElementById("log");
const btn = document.getElementById("migrateBtn");

function log(message){
  logEl.textContent += `${new Date().toLocaleTimeString()} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function itemId(value, index, prefix){
  return String(value?.id || value?.bookingId || value?.groupId || `${prefix}_${index}`);
}

async function migrate(){
  btn.disabled = true;

  try{
    log("读取旧 shop/main...");
    const mainRef = doc(db, "shop", "main");
    const snap = await getDoc(mainRef);
    if(!snap.exists()) throw new Error("找不到 shop/main");

    const state = snap.data();
    let count = 0;

    for(let i = 0; i < (state.tables || []).length; i++){
      const id = `table_${String(i + 1).padStart(2, "0")}`;
      await setDoc(
        doc(db, "shops", "main", "tables", id),
        {
          ...(state.tables[i] || {}),
          id,
          tableIndex:i,
          version:Number(state.tables[i]?._entitySync?.version || 1),
          deleted:false,
          updatedAt:serverTimestamp(),
          migratedFrom:"shop/main"
        },
        {merge:true}
      );
      count++;
    }

    for(const [key, col, prefix] of [["bookings", "bookings", "booking"], ["groups", "groups", "group"]]){
      for(let i = 0; i < (state[key] || []).length; i++){
        const value = state[key][i] || {};
        const id = itemId(value, i, prefix);
        await setDoc(
          doc(db, "shops", "main", col, id),
          {
            ...value,
            id,
            version:Number(value?._entitySync?.version || 1),
            deleted:false,
            updatedAt:serverTimestamp(),
            migratedFrom:"shop/main"
          },
          {merge:true}
        );
        count++;
      }
    }

    for(const [id, value] of Object.entries(state.customers || {})){
      await setDoc(
        doc(db, "shops", "main", "customers", String(id)),
        {
          ...(value || {}),
          id:String(id),
          version:Number(value?._entitySync?.version || 1),
          deleted:false,
          updatedAt:serverTimestamp(),
          migratedFrom:"shop/main"
        },
        {merge:true}
      );
      count++;
    }

    await setDoc(
      doc(db, "shops", "main"),
      {
        schemaVersion:3,
        migratedAt:serverTimestamp(),
        legacyMainPath:"shop/main"
      },
      {merge:true}
    );

    log(`状态实体完成：${count} 项。读取 records...`);
    const recordsSnap = await getDocs(collection(db, "records"));
    let recordCount = 0;
    let paymentCount = 0;

    for(const recordSnap of recordsSnap.docs){
      const record = recordSnap.data();
      const recordId = String(record.id || recordSnap.id);
      const {payments = [], ...meta} = record;

      await setDoc(
        doc(db, "shops", "main", "records", recordId),
        {
          ...meta,
          id:recordId,
          version:Number(record?._recordSync?.version || 1),
          deleted:false,
          updatedAt:serverTimestamp(),
          migratedFrom:"records"
        },
        {merge:true}
      );
      recordCount++;

      for(let i = 0; i < payments.length; i++){
        const payment = payments[i] || {};
        const paymentId = String(
          payment.id ||
          payment.paymentId ||
          `${recordId}_payment_${i}_${Number(payment.createdAt || 0)}`
        );

        await setDoc(
          doc(db, "shops", "main", "records", recordId, "payments", paymentId),
          {
            ...payment,
            id:paymentId,
            paymentId,
            status:payment.status || "active",
            updatedAt:serverTimestamp(),
            migratedFrom:"records.payments"
          },
          {merge:true}
        );
        paymentCount++;
      }
    }

    log(`账单 ${recordCount} 张、付款流水 ${paymentCount} 条迁移完成。`);
    log("迁移成功。旧数据会保留作为兼容视图，请不要立即删除 shop/main 或 records。");
  }catch(error){
    log(`失败：${error?.message || error}`);
    console.error(error);
  }finally{
    btn.disabled = false;
  }
}

btn.addEventListener("click", () => {
  if(confirm("请确认营业已暂停、所有设备已关闭旧页面，并且已经备份 Firestore。继续迁移？")){
    migrate();
  }
});
