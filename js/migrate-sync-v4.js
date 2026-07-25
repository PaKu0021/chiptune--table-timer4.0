import { db } from "./firebase.js?v=4.0.21";
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
const verifyBtn = document.getElementById("verifyBtn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const progressTextEl = document.getElementById("progressText");
const statsBody = document.getElementById("statsBody");
const resultCard = document.getElementById("resultCard");

const TYPES = ["tables", "bookings", "groups", "customers", "records", "payments"];
const labels = {
  tables:"桌位",
  bookings:"预约",
  groups:"分组",
  customers:"客户",
  records:"账单",
  payments:"付款流水"
};

const stats = Object.fromEntries(TYPES.map(key => [key, {
  source:0,
  created:0,
  skipped:0,
  failed:0,
  verified:"待检查"
}]));

let totalJobs = 0;
let finishedJobs = 0;
let running = false;

function log(message){
  logEl.textContent += `${new Date().toLocaleTimeString()} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function renderStats(){
  statsBody.innerHTML = TYPES.map(type => {
    const s = stats[type];
    return `<tr><td>${labels[type]}</td><td>${s.source}</td><td>${s.created}</td><td>${s.skipped}</td><td>${s.failed}</td><td>${s.verified}</td></tr>`;
  }).join("");
}

function updateProgress(message){
  const percent = totalJobs > 0
    ? Math.min(100, Math.round(finishedJobs / totalJobs * 100))
    : 0;

  progressEl.value = percent;
  progressTextEl.textContent = `${percent}%（${finishedJobs}/${totalJobs || 0}）`;
  if(message) statusEl.textContent = message;
  renderStats();
}

function resetStats(){
  for(const type of TYPES){
    Object.assign(stats[type], {
      source:0,
      created:0,
      skipped:0,
      failed:0,
      verified:"待检查"
    });
  }

  totalJobs = 0;
  finishedJobs = 0;
  resultCard.hidden = true;
  resultCard.className = "card";
  resultCard.textContent = "";
  updateProgress("正在读取源数据...");
}

function itemId(value, index, prefix){
  return String(value?.id || value?.bookingId || value?.groupId || `${prefix}_${index}`);
}

function entityMetadata(value, id, source){
  return {
    id,
    version:Math.max(1, Number(value?.version || value?._entitySync?.version || 0)),
    deleted:Boolean(value?.deleted),
    updatedAt:serverTimestamp(),
    updatedBy:"migration-v4.0.1",
    migratedFrom:source,
    schemaVersion:4
  };
}

async function createOnly(ref, fullData, type){
  try{
    const existing = await getDoc(ref);
    if(existing.exists()){
      stats[type].skipped++;
      return "skipped";
    }

    await setDoc(ref, fullData);
    stats[type].created++;
    return "created";
  }catch(error){
    stats[type].failed++;
    log(`✗ ${type}/${ref.id}：${error?.message || error}`);
    return "failed";
  }finally{
    finishedJobs++;
    updateProgress(`正在迁移 ${labels[type]}...`);
  }
}

async function migrateEntityArray(values, collectionName, prefix, type, source){
  for(let i = 0; i < values.length; i++){
    const value = values[i] || {};
    const id = type === "tables"
      ? `table_${String(i + 1).padStart(2, "0")}`
      : itemId(value, i, prefix);

    await createOnly(
      doc(db, collectionName, id),
      {
        ...value,
        ...entityMetadata(value, id, source),
        ...(type === "tables" ? {tableIndex:i} : {})
      },
      type
    );
  }
}

async function readSource(){
  const mainRef = doc(db, "shop", "main");
  const mainSnap = await getDoc(mainRef);
  if(!mainSnap.exists()){
    throw new Error("找不到 shop/main，无法读取旧版数据");
  }

  const state = mainSnap.data() || {};
  const tables = Array.isArray(state.tables) ? state.tables : [];
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const customersMap = Array.isArray(state.customers)
    ? Object.fromEntries(state.customers.map((value, index) => [String(value?.id || `customer_${index}`), value]))
    : (state.customers || {});

  const recordsSnap = await getDocs(collection(db, "records"));
  const records = recordsSnap.docs
    .filter(recordDoc => recordDoc.id !== "init")
    .map(recordDoc => ({snapId:recordDoc.id, data:recordDoc.data() || {}}));

  stats.tables.source = tables.length;
  stats.bookings.source = bookings.length;
  stats.groups.source = groups.length;
  stats.customers.source = Object.keys(customersMap).length;
  stats.records.source = records.length;
  stats.payments.source = records.reduce((sum, record) => {
    return sum + (Array.isArray(record.data.payments) ? record.data.payments.length : 0);
  }, 0);

  totalJobs = TYPES.reduce((sum, type) => sum + stats[type].source, 0);
  updateProgress("源数据读取完成，准备迁移...");
  return {mainRef, tables, bookings, groups, customersMap, records};
}

async function migrateRecords(records){
  for(const {snapId, data:record} of records){
    const recordId = String(record.id || snapId);
    const recordRef = doc(db, "records", recordId);

    try{
      const current = await getDoc(recordRef);
      if(!current.exists()){
        await setDoc(recordRef, {
          ...record,
          id:recordId,
          version:Math.max(1, Number(record.version || record?._recordSync?.version || 0)),
          deleted:Boolean(record.deleted),
          updatedAt:serverTimestamp(),
          updatedBy:"migration-v4.0.1",
          paymentSchemaVersion:2,
          schemaVersion:4
        });
        stats.records.created++;
      }else{
        const currentData = current.data() || {};
        await setDoc(recordRef, {
          id:recordId,
          version:Math.max(1, Number(currentData.version || record.version || record?._recordSync?.version || 0)),
          deleted:Boolean(currentData.deleted),
          paymentSchemaVersion:2,
          schemaVersion:4,
          migrationMetadataUpdatedAt:serverTimestamp()
        }, {merge:true});
        stats.records.skipped++;
      }
    }catch(error){
      stats.records.failed++;
      log(`✗ records/${recordId}：${error?.message || error}`);
    }finally{
      finishedJobs++;
      updateProgress("正在迁移账单...");
    }

    const payments = Array.isArray(record.payments) ? record.payments : [];
    for(let i = 0; i < payments.length; i++){
      const payment = payments[i] || {};
      const paymentId = String(
        payment.id ||
        payment.paymentId ||
        `${recordId}_legacy_${i}_${Number(payment.createdAt || payment.localCreatedAt || 0)}`
      );

      await createOnly(
        doc(db, "records", recordId, "payments", paymentId),
        {
          ...payment,
          id:paymentId,
          paymentId,
          recordId,
          status:payment.status || "active",
          createdAt:payment.createdAt || serverTimestamp(),
          updatedAt:serverTimestamp(),
          updatedBy:"migration-v4.0.1",
          migratedFrom:"records.payments",
          schemaVersion:4
        },
        "payments"
      );
    }
  }
}

async function countCollection(name){
  const snap = await getDocs(collection(db, name));
  return snap.docs.filter(recordDoc => recordDoc.id !== "init" && !recordDoc.data()?.deleted).length;
}

async function countPaymentSubcollections(records){
  let count = 0;
  for(const {snapId, data} of records){
    const recordId = String(data.id || snapId);
    const snap = await getDocs(collection(db, "records", recordId, "payments"));
    count += snap.size;
  }
  return count;
}

async function verifyMigration(source = null){
  statusEl.textContent = "正在回读 Firestore 验证...";
  log("开始回读新结构进行验证...");

  let sourceData = source;
  if(!sourceData) sourceData = await readSource();

  const actual = {
    tables:await countCollection("tables"),
    bookings:await countCollection("bookings"),
    groups:await countCollection("groups"),
    customers:await countCollection("customers"),
    records:await countCollection("records"),
    payments:await countPaymentSubcollections(sourceData.records)
  };

  let allOk = true;
  for(const type of TYPES){
    const expected = stats[type].source;
    const ok = actual[type] >= expected;
    stats[type].verified = ok ? `✓ ${actual[type]}` : `✗ ${actual[type]}/${expected}`;
    if(!ok) allOk = false;
  }
  renderStats();

  if(allOk){
    await setDoc(doc(db, "settings", "migration_v4"), {
      schemaVersion:4,
      migrationVersion:"4.0.1",
      status:"completed",
      completedAt:serverTimestamp(),
      verifiedAt:serverTimestamp(),
      sourceCounts:Object.fromEntries(TYPES.map(type => [type, stats[type].source])),
      verifiedCounts:actual,
      oldDataDeleted:false
    }, {merge:true});

    await setDoc(sourceData.mainRef, {
      schemaVersion:4,
      entitySyncEnabled:true,
      migrationVersion:"4.0.1",
      migratedAt:serverTimestamp()
    }, {merge:true});

    progressEl.value = 100;
    progressTextEl.textContent = "100%";
    statusEl.textContent = "✓ 迁移完成并验证通过";
    resultCard.hidden = false;
    resultCard.className = "card success";
    resultCard.innerHTML = `<strong>✓ Migration Complete</strong><br><br>迁移标记已写入：<code>settings/migration_v4</code><br>状态：<code>completed</code><br><br>现在可以关闭此页面，再逐台打开其他设备。`;
    log("✓ 迁移完成，所有数量验证通过，已写入 settings/migration_v4。");
    return true;
  }

  await setDoc(doc(db, "settings", "migration_v4"), {
    schemaVersion:4,
    migrationVersion:"4.0.1",
    status:"verification_failed",
    verifiedAt:serverTimestamp(),
    sourceCounts:Object.fromEntries(TYPES.map(type => [type, stats[type].source])),
    verifiedCounts:actual,
    oldDataDeleted:false
  }, {merge:true});

  statusEl.textContent = "✗ 迁移未通过验证";
  resultCard.hidden = false;
  resultCard.className = "card error";
  resultCard.innerHTML = `<strong>迁移尚未完成。</strong><br><br>请查看上方“验证”列和日志。可以再次点击“开始/继续迁移”，工具只会补齐缺失数据，不会覆盖已经存在的数据。`;
  log("✗ 数量验证未通过，可以安全地再次执行迁移。");
  return false;
}

async function migrate(){
  if(running) return;
  running = true;
  btn.disabled = true;
  verifyBtn.disabled = true;
  resetStats();
  logEl.textContent = "";

  try{
    const source = await readSource();
    log(`源数据：桌位 ${stats.tables.source}、预约 ${stats.bookings.source}、分组 ${stats.groups.source}、客户 ${stats.customers.source}、账单 ${stats.records.source}、付款 ${stats.payments.source}`);

    await migrateEntityArray(source.tables, "tables", "table", "tables", "shop/main.tables");
    await migrateEntityArray(source.bookings, "bookings", "booking", "bookings", "shop/main.bookings");
    await migrateEntityArray(source.groups, "groups", "group", "groups", "shop/main.groups");

    for(const [id, value] of Object.entries(source.customersMap)){
      await createOnly(
        doc(db, "customers", String(id)),
        {
          ...(value || {}),
          ...entityMetadata(value, String(id), "shop/main.customers")
        },
        "customers"
      );
    }

    await migrateRecords(source.records);
    await verifyMigration(source);
  }catch(error){
    statusEl.textContent = "✗ 迁移发生错误";
    resultCard.hidden = false;
    resultCard.className = "card error";
    resultCard.textContent = `失败：${error?.message || error}`;
    log(`✗ 失败：${error?.message || error}`);
    console.error(error);
  }finally{
    running = false;
    btn.disabled = false;
    verifyBtn.disabled = false;
  }
}

async function verifyOnly(){
  if(running) return;
  running = true;
  btn.disabled = true;
  verifyBtn.disabled = true;
  resetStats();
  logEl.textContent = "";

  try{
    const source = await readSource();
    await verifyMigration(source);
    const marker = await getDoc(doc(db, "settings", "migration_v4"));
    if(marker.exists()){
      log(`迁移标记当前状态：${marker.data()?.status || "未知"}`);
    }
  }catch(error){
    statusEl.textContent = "✗ 检查失败";
    log(`✗ 检查失败：${error?.message || error}`);
  }finally{
    running = false;
    btn.disabled = false;
    verifyBtn.disabled = false;
  }
}

btn.addEventListener("click", () => {
  if(confirm("请确认所有旧页面已关闭且当前暂停营业。开始或继续 v4 数据迁移？")){
    migrate();
  }
});

verifyBtn.addEventListener("click", verifyOnly);
renderStats();
