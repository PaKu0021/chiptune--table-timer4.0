import { db } from "./firebase.js?v=4.0.43";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { loadLocalState } from "./safe-state.js?v=4.0.43";

const ref = doc(db, "shop", "main");
const gridEl = document.getElementById("printGrid");
const titleEl = document.getElementById("printTitle");

function getTodayDate(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

const params = new URLSearchParams(location.search);
const printDate = params.get("date") || getTodayDate();

titleEl.innerText = `${printDate} 预约时间表`;
gridEl.innerHTML = `<div class="print-loading">正在读取预约数据…</div>`;

function getSlots(hours){
  const slots = [];
  for(let h = hours.open; h < hours.close; h++){
    slots.push(`${String(h).padStart(2,"0")}:00`);
    slots.push(`${String(h).padStart(2,"0")}:30`);
  }
  // 最后一项是营业结束边界，只用于计算最后一行的结束时间。
  slots.push(`${String(hours.close).padStart(2,"0")}:00`);
  return slots;
}

function timeToMinutes(value){
  const [hour,minute] = String(value || "").split(":").map(Number);
  if(!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;
  return hour * 60 + minute;
}

function parseLocalDate(dateText){
  const [year,month,day] = String(dateText || "").split("-").map(Number);
  return new Date(year, Math.max(0,(month || 1)-1), day || 1);
}

function getBusinessHours(state){
  const h = state?.businessHours || {
    weekdayOpen:12,
    weekdayClose:22,
    weekendOpen:10,
    weekendClose:22
  };

  const d = parseLocalDate(printDate);
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;

  return {
    open: isWeekend ? Number(h.weekendOpen || 10) : Number(h.weekdayOpen || 12),
    close: isWeekend ? Number(h.weekendClose || 22) : Number(h.weekdayClose || 22)
  };
}


function darkenColor(hex, amount = 35){
  const value = String(hex || "#B7E4C7").replace("#", "");
  const full = value.length === 3 ? value.split("").map(ch=>ch+ch).join("") : value.padEnd(6,"0").slice(0,6);
  const num = Number.parseInt(full,16);
  if(!Number.isFinite(num)) return "#8bab95";
  const clamp = value=>Math.max(0,Math.min(255,value));
  const r=clamp((num>>16)-amount), g=clamp(((num>>8)&255)-amount), b=clamp((num&255)-amount);
  return `#${[r,g,b].map(v=>v.toString(16).padStart(2,"0")).join("")}`;
}

function normalizeTableIndexes(booking){
  const raw = Array.isArray(booking?.tableIndexes)
    ? booking.tableIndexes
    : [booking?.tableIndex];
  return raw.map(Number).filter(Number.isFinite);
}

function renderState(state){
  if(!state || typeof state !== "object") return false;

  const tables = Array.isArray(state.tables) ? state.tables : [];
  const bookings = (Array.isArray(state.bookings) ? state.bookings : []).filter(booking=>{
    if(booking?.cancelled || booking?.status === "cancelled") return false;
    return String(booking?.date || printDate) === printDate;
  });
  const slots = getSlots(getBusinessHours(state));

  if(!tables.length){
    gridEl.innerHTML = `<div class="print-error">没有读取到桌位资料，请返回预约系统后重试。</div>`;
    return false;
  }

  let html = `
    <table class="print-booking-table">
      <thead>
        <tr>
          <th>时间</th>
          ${tables.map((table,index)=>`<th>${table?.name || `${index+1}号桌`}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
  `;

  slots.slice(0,-1).forEach((time,rowIndex)=>{
    html += `<tr><td class="print-time">${time}</td>`;

    tables.forEach((table,tableIndex)=>{
      const booking = bookings.find(item=>{
        const tableIndexes = normalizeTableIndexes(item);
        const bookingStart = timeToMinutes(item?.startTime);
        const bookingEnd = timeToMinutes(item?.endTime);
        const rowStart = timeToMinutes(slots[rowIndex]);
        const rowEnd = timeToMinutes(slots[rowIndex + 1]);

        return Number.isFinite(bookingStart) &&
               Number.isFinite(bookingEnd) &&
               bookingEnd > bookingStart &&
               tableIndexes.includes(tableIndex) &&
               bookingStart < rowEnd &&
               bookingEnd > rowStart;
      });

      const bookingStart = timeToMinutes(booking?.startTime);
      const rowStart = timeToMinutes(slots[rowIndex]);
      const rowEnd = timeToMinutes(slots[rowIndex + 1]);
      const isStart = booking &&
        bookingStart >= rowStart &&
        bookingStart < rowEnd;
      const customer = booking?.name || booking?.customer || "";
      const phone = booking?.phone || booking?.phoneLast4 || "";
      const label = isStart
        ? `${customer}${phone ? `<br><small>${phone}</small>` : ""}`
        : "";

      const bookingColor = booking
        ? (booking.checkedIn
            ? darkenColor(booking.color || booking.groupColor || "#B7E4C7",35)
            : (booking.color || booking.groupColor || "#B7E4C7"))
        : "";
      const cellStyle = bookingColor
        ? ` style="background:${bookingColor};color:#332d24;"`
        : "";

      html += `
        <td class="${booking ? (booking.checkedIn ? "print-checked" : "print-booked") : ""}"${cellStyle}>
          ${label}
        </td>
      `;
    });

    html += `</tr>`;
  });

  html += `</tbody></table>`;
  gridEl.innerHTML = html;
  return true;
}

async function loadAndRender(){
  let rendered = false;

  try{
    const localState = await loadLocalState();
    rendered = renderState(localState) || rendered;
  }catch(error){
    console.warn("读取本地预约数据失败", error);
  }

  try{
    const snap = await getDoc(ref);
    if(snap.exists()) rendered = renderState(snap.data()) || rendered;
  }catch(error){
    console.warn("读取云端预约数据失败", error);
    if(!rendered){
      gridEl.innerHTML = `
        <div class="print-error">
          预约数据读取失败。请确认网络连接，或返回预约系统刷新后再打开打印时间表。
        </div>
      `;
    }
  }

  if(!rendered && gridEl.querySelector(".print-loading")){
    gridEl.innerHTML = `<div class="print-error">暂时没有可显示的预约数据。</div>`;
  }
}

loadAndRender();

function doPrint(){
  window.print();
}

window.doPrint = doPrint;
