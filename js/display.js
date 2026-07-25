import { db } from "./firebase.js?v=4.0.28";
import { doc, onSnapshot, getDocFromServer } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

const ref = doc(db,"shop","main");
const params = new URLSearchParams(location.search);
const tableNo = Number(params.get("table"));
const tableIndex = tableNo - 1;

let state = null;

function formatTime(ms){
  ms = Math.max(0,ms);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

function renderDisplay(){
  if(!state) return;

  const t = state.tables?.[tableIndex];

  if(!t){
    document.getElementById("tableName").innerText = "桌位不存在";
    return;
  }

  document.getElementById("tableName").innerText = t.name || `${tableNo}号桌`;

  if(!t.start){
    document.getElementById("timeText").innerText = "未开始";
    document.getElementById("statusText").innerText = "请等待店员开始计时";
    return;
  }

  const p = state.packages?.[t.packageIndex] || {};
  const elapsed = (t.pausedAt || Date.now()) - t.start;

  if(p.unlimited || Number(p.minutes || 0) === 0){
    document.getElementById("timeText").innerText = formatTime(elapsed);
    document.getElementById("statusText").innerText = "已使用时间";
    return;
  }

  const limit = Number(p.minutes || 0) * 60000 + Number(t.extra || 0);
  const remain = limit - elapsed;

  if(remain <= 0){
    document.getElementById("timeText").innerText = formatTime(Math.abs(remain));
    document.getElementById("statusText").innerText = "已超时";
  }else{
    document.getElementById("timeText").innerText = formatTime(remain);
    document.getElementById("statusText").innerText = "剩余时间";
  }
}

onSnapshot(ref,{includeMetadataChanges:true},snap=>{
  if(!snap.exists()) return;
  state = snap.data();
  renderDisplay();

  // 缓存快照可能还是“未开始”，收到缓存后立即再向服务器核对。
  if(snap.metadata.fromCache && navigator.onLine) refreshFromServer();
},err=>{
  console.warn("二维码页面实时监听失败",err);
  if(navigator.onLine) refreshFromServer();
});

async function refreshFromServer(){
  if(!navigator.onLine) return;
  try{
    const snap = await getDocFromServer(ref);
    if(snap.exists()){
      state = snap.data();
      renderDisplay();
    }
  }catch(err){
    console.warn("二维码页面刷新云端状态失败",err);
  }
}

setInterval(renderDisplay,1000);
setInterval(refreshFromServer,2000);
window.addEventListener("online",refreshFromServer);
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) refreshFromServer(); });
refreshFromServer();