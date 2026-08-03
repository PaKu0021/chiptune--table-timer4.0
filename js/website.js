import { db } from "./firebase.js?v=4.0.64";

import {
    doc,
    runTransaction
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

const LANG = {
  zh:{
    navPrice:"价格", navAccessory:"配饰", navBooking:"预约", navAccess:"交通",
    heroTag:"池袋拼豆体验店",
    heroTitle:"来 Chiptune 制作属于自己的拼豆作品",
    heroText:"221种颜色、免费加工、丰富配饰，第一次来也完全没问题。",
    heroButton:"立即预约",
    featureTitle:"为什么选择 Chiptune？",
    feature1Title:"221种颜色", feature1Text:"覆盖各种IP、角色、大图作品。",
    feature2Title:"免费加工", feature2Text:"免费熨烫、打孔、组装。",
    feature3Title:"丰富配饰", feature3Text:"钥匙扣、手机支架、戒指、发夹等。",
    priceTitle:"价格",
    weekdayTitle:"平日", weekdayPrice1:"5小时 ¥3300", weekdayPrice2:"不限时 ¥5500",
    weekendTitle:"周末·节假日", weekendPrice1:"3小时 ¥3300", weekendPrice2:"6小时 ¥5500",
    accessoryTitle:"配饰", accessoryText:"每件作品可选择一个免费配饰。",
    acc1:"钥匙扣", acc2:"手机支架", acc3:"发夹", acc4:"戒指", acc5:"磁铁", acc6:"立牌", acc7:"轴承", acc8:"帆布袋",
    bookingTitle:"预约", bookingLead:"提交预约后，我们会尽快确认。",
    nameLabel:"姓名", contactLabel:"联系方式", peopleLabel:"人数", dateLabel:"日期", startLabel:"开始时间", endLabel:"结束时间", noteLabel:"备注",
    submitBooking:"提交预约",
    accessTitle:"交通", accessText:"池袋站步行约5分钟。",
    namePlaceholder:"请输入姓名",
    contactPlaceholder:"电话 / 微信 / Instagram 等",
    notePlaceholder:"例：第一次来 / 想做大图 / 需要中文说明",
  },

  ja:{
    navPrice:"料金", navAccessory:"アクセサリー", navBooking:"予約", navAccess:"アクセス",
    heroTag:"池袋アイロンビーズ工房",
    heroTitle:"世界に一つだけの作品を作ろう",
    heroText:"221色・無料加工・豊富なアクセサリーをご用意しています。",
    heroButton:"予約する",
    featureTitle:"Chiptuneの特徴",
    feature1Title:"221色", feature1Text:"キャラクター作品にも対応。",
    feature2Title:"無料加工", feature2Text:"アイロン・穴あけ・組立無料。",
    feature3Title:"アクセサリー", feature3Text:"キーホルダー・スマホスタンドなど。",
    priceTitle:"料金",
    weekdayTitle:"平日", weekdayPrice1:"5時間 ¥3300", weekdayPrice2:"フリー ¥5500",
    weekendTitle:"土日祝", weekendPrice1:"3時間 ¥3300", weekendPrice2:"6時間 ¥5500",
    accessoryTitle:"アクセサリー", accessoryText:"作品ごとに1つ無料で選べます。",
    acc1:"キーホルダー", acc2:"スマホスタンド", acc3:"ヘアピン", acc4:"リング", acc5:"マグネット", acc6:"スタンド", acc7:"ベアリング", acc8:"トートバッグ",
    bookingTitle:"予約", bookingLead:"送信後、スタッフが確認いたします。",
    nameLabel:"お名前", contactLabel:"連絡先", peopleLabel:"人数", dateLabel:"日付", startLabel:"開始時間", endLabel:"終了時間", noteLabel:"備考",
    submitBooking:"予約する",
    accessTitle:"アクセス", accessText:"池袋駅より徒歩約5分。",
    namePlaceholder:"お名前を入力してください",
    contactPlaceholder:"電話番号 / Instagram / X など",
    notePlaceholder:"例：初めて / 大きい作品を作りたい など",
  },

  en:{
    navPrice:"Price", navAccessory:"Accessories", navBooking:"Booking", navAccess:"Access",
    heroTag:"Ikebukuro Perler Bead Studio",
    heroTitle:"Create Your Own Bead Art",
    heroText:"221 colors, free ironing, and many accessories.",
    heroButton:"Book Now",
    featureTitle:"Why Chiptune?",
    feature1Title:"221 Colors", feature1Text:"Perfect for pixel art and characters.",
    feature2Title:"Free Finishing", feature2Text:"Ironing and assembly included.",
    feature3Title:"Accessories", feature3Text:"Keychains, stands, magnets and more.",
    priceTitle:"Price",
    weekdayTitle:"Weekdays", weekdayPrice1:"5 Hours ¥3300", weekdayPrice2:"Unlimited ¥5500",
    weekendTitle:"Weekend", weekendPrice1:"3 Hours ¥3300", weekendPrice2:"6 Hours ¥5500",
    accessoryTitle:"Accessories", accessoryText:"One free accessory per artwork.",
    acc1:"Keychain", acc2:"Phone Stand", acc3:"Hair Clip", acc4:"Ring", acc5:"Magnet", acc6:"Display Stand", acc7:"Bearing", acc8:"Tote Bag",
    bookingTitle:"Booking", bookingLead:"We'll confirm your reservation shortly.",
    nameLabel:"Name", contactLabel:"Contact", peopleLabel:"People", dateLabel:"Date", startLabel:"Start", endLabel:"End", noteLabel:"Note",
    submitBooking:"Book Now",
    accessTitle:"Access", accessText:"5 minutes from Ikebukuro Station.",
    namePlaceholder:"Enter your name",
    contactPlaceholder:"Phone / Instagram / X etc.",
    notePlaceholder:"Example: first visit / large artwork / special request",
  }
};

function setLang(lang){
  localStorage.setItem("lang",lang);

  const dict = LANG[lang];

  document.querySelectorAll("[data-i18n]").forEach(el=>{
    const key = el.dataset.i18n;
    if(dict[key]){
      el.innerText = dict[key];
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(el=>{
    const key = el.dataset.i18nPlaceholder;
    if(dict[key]){
      el.placeholder = dict[key];
    }
  });

  document.querySelectorAll(".lang-switch button").forEach(btn=>{
    btn.classList.remove("active");
  });

  document
    .querySelector(`.lang-switch button[onclick="setLang('${lang}')"]`)
    ?.classList.add("active");
}

window.setLang = setLang;


let submitting = false;

async function submitWebsiteBooking(){
  if(submitting) return;
  submitting = true;

  try{
    const name = document.getElementById("bookingName").value.trim();
    const contact = document.getElementById("bookingContact").value.trim();
    const people = Number(document.getElementById("bookingPeople").value || 1);
    const date = document.getElementById("bookingDate").value;
    const startTime = document.getElementById("bookingStart").value;
    const endTime = document.getElementById("bookingEnd").value;
    const note = document.getElementById("bookingNote").value.trim();

    if(!name) return alert("请输入姓名");
    if(!contact) return alert("请输入联系方式");
    if(!date || !startTime || !endTime) return alert("请选择预约日期和时间");
    if(startTime >= endTime) return alert("结束时间必须晚于开始时间");

    const now = Date.now();
    const booking = {
      id: now * 1000 + Math.floor(Math.random() * 1000),
      date,
      name,
      phone: contact,
      people,
      startTime,
      endTime,
      note,
      source: "官网",
      color: "#B7E4C7",
      tableIndex: null,
      tableIndexes: [],
      packageIndex: 0,
      pay: "",
      checkedIn: false,
      checkInTime: null,
      checkInTimeText: "",
      checkedInTableIndexes: [],
      finishedTableIndexes: [],
      cancelled: false,
      status: "pending",
      createdAt: now,
      createdTime: new Date().toLocaleString()
    };

    const ref = doc(db,"shop","main");
    await runTransaction(db, async transaction=>{
      const snap = await transaction.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const bookings = Array.isArray(data.bookings) ? data.bookings : [];
      const nextBookings = [...bookings, booking];
      if(snap.exists()){
        transaction.update(ref,{bookings:nextBookings});
      }else{
        transaction.set(ref,{bookings:nextBookings},{merge:true});
      }
    });

    alert("预约已提交，我们会尽快确认。");

    document.getElementById("bookingName").value = "";
    document.getElementById("bookingContact").value = "";
    document.getElementById("bookingPeople").value = "1";
    document.getElementById("bookingDate").value = "";
    document.getElementById("bookingStart").value = "";
    document.getElementById("bookingEnd").value = "";
    document.getElementById("bookingNote").value = "";

  }catch(err){
    console.error(err);
    alert("预约提交失败：" + err.message);
  }finally{
    submitting = false;
  }
}


window.submitWebsiteBooking = submitWebsiteBooking;
setLang(localStorage.getItem("lang") || "ja");
