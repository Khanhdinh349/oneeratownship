// ================================
// 🔒 CONFIG LOCK NGÀY / GIỜ (THÊM MỚI)
// ================================
const LOCK_CONFIG = {
  // "2026-04-05": ["all"], // khoá cả ngày
  // "2026-04-02": ["09:00-10:30"], // khoá 1 slot
  "2026-04-02": ["09:00-10:30", "10:30-12:00"],
};

function isSlotLocked(date, time) {
  if (!LOCK_CONFIG[date]) return false;
  const locked = LOCK_CONFIG[date];
  if (locked.includes("all")) return true;
  return locked.includes(time);
}


// ================================
// 🧠 Quản lý Ngôn ngữ & Điều hướng
// ================================

function getLang() {
  const params = new URLSearchParams(window.location.search);
  return params.get("lang") || localStorage.getItem("lang") || "vi";
}

function setLang(lang) {
  localStorage.setItem("lang", lang);
}

// Logic chuyển hướng từ index.html
const goBtn = document.getElementById("goBtn");
if (goBtn) {
  goBtn.addEventListener("click", () => {
    const lang = document.getElementById("language")?.value;
    const type = document.getElementById("userType")?.value;

    if (!lang || !type) {
      alert("Lỗi: Không tìm thấy các trường chọn ngôn ngữ hoặc loại đăng ký.");
      return;
    }

    if (type === "") {
      alert(lang === "vi" ? "Vui lòng chọn loại đăng ký" : "Please select a registration type");
      return;
    }

    setLang(lang);
    window.location.href = `${type}.html?lang=${lang}`;
  });
}

// ================================
// 🌐 Dịch toàn bộ form
// ================================
function translateForm(lang) {
  document.querySelectorAll("label[data-vi]").forEach((lbl) => {
    lbl.textContent = lbl.getAttribute(`data-${lang}`);
  });

  document.querySelectorAll("[data-ph-vi]").forEach((el) => {
    el.placeholder = el.getAttribute(`data-ph-${lang}`);
  });

  const title = document.getElementById("form-title");
  let submitBtn = document.getElementById("goBtn") || document.querySelector(".submit-btn");

  if (title && submitBtn) {
    const map = {
      doitac: { vi: "Đăng Ký Đối Tác", en: "Partner Registration" },
      khach:  { vi: "Đăng Ký Khách",   en: "Guest Registration" },
      daily:  { vi: "Đăng Ký Đại Lý",  en: "Agency Registration" },
    };
    const page = window.location.pathname.split("/").pop().split(".")[0];

    if (map[page]) {
      title.textContent = map[page][lang];
      if (!document.getElementById("goBtn")) {
        submitBtn.textContent = lang === "vi" ? "Gửi đăng ký" : "Submit";
      }
    }
  }
}

// ================================
// 🎉 Modal thông báo thành công
// ================================
let countdownTimer;

function setupRedirect(lang, confirmBtn) {
  const redirectToIndex = () => {
    if (countdownTimer) clearInterval(countdownTimer);
    confirmBtn.removeEventListener("click", redirectToIndex);
    window.location.href = `index.html?lang=${lang}`;
  };

  confirmBtn.onclick = redirectToIndex;
  return redirectToIndex;
}

function showSuccessDialog(lang) {
  const modal = document.getElementById("success-modal");
  const title = document.getElementById("modal-title");
  const message = document.getElementById("modal-message");
  const confirmBtn = document.getElementById("confirm-btn");

  if (!modal || !confirmBtn) {
    alert(lang === "vi" ? "Đăng ký thành công!" : "Registration Successful!");
    return;
  }

  if (lang === "vi") {
    title.textContent = "✅ Đăng ký thành công!";
    message.innerHTML = `Chào Mừng Đến Với One Era.`;
    confirmBtn.textContent = "Xác nhận";
  } else {
    title.textContent = "✅ Successful Registration!";
    message.innerHTML = `Welcome to One Era.`;
    confirmBtn.textContent = "Confirm";
  }

  if (typeof confetti === "function") {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
    });
  }

  modal.classList.add("show");
  setupRedirect(lang, confirmBtn);

  const activeForm = modal.closest("body").querySelector("form");
  if (activeForm) activeForm.reset();
}

// ================================
// 📝 Thu thập dữ liệu form
// ================================
function collectFormData(formId) {
  const data = {
    timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
  };

  const fieldMap = {
    "form-doitac": [
      { selector: '[name="fullName"]', name: "fullName" },
      { selector: '[name="idNumber"]', name: "idNumber" },
      { selector: '[name="phoneNumber"]', name: "phoneNumber" },
      { selector: '[name="company"]', name: "company" },
      { selector: '[name="recDepartment"]', name: "recDepartment" },
      { selector: '[name="recStaff"]', name: "recStaff" },
      { selector: '[name="quantity"]', name: "quantity" },
      { selector: '[name="visitDate"]', name: "visitDate" },
      { selector: '[name="visitTime"]', name: "visitTime" },
      { selector: '[name="notes"]', name: "notes" },
    ],
    "form-khach": [
      { selector: '[name="fullName"]', name: "fullName" },
      { selector: '[name="idNumber"]', name: "idNumber" },
      { selector: '[name="phoneNumber"]', name: "phoneNumber" },
      { selector: '[name="email"]', name: "email" },
      { selector: '[name="quantity"]', name: "quantity" },
      { selector: '[name="visitDate"]', name: "visitDate" },
      { selector: '[name="visitTime"]', name: "visitTime" },
      { selector: '[name="notes"]', name: "notes" },
    ],
    "form-daily": [
      { selector: '[name="agencyName"]', name: "agencyName" },
      { selector: '[name="staffName"]', name: "staffName" },
      { selector: '[name="idNumber"]', name: "idNumber" },
      { selector: '[name="phoneNumber"]', name: "phoneNumber" },
      { selector: '[name="quantity"]', name: "quantity" },
      { selector: '[name="visitDate"]', name: "visitDate" },
      { selector: '[name="visitTime"]', name: "visitTime" },
      { selector: '[name="notes"]', name: "notes" },
    ],
  };

  const currentFormMap = fieldMap[formId];
  if (!currentFormMap) return null;

  currentFormMap.forEach((f) => {
    const el = document.querySelector(`#${formId} ${f.selector}`);
    if (el) data[f.name] = el.value;
  });

  data.formType = formId.replace("form-", "");
  return data;
}

// ================================
// ⏰ SLOT
// ================================
const TIME_SLOTS = [
  { value: "09:00-10:30", labelVi: "09:00 – 10:30" },
  { value: "10:30-12:00", labelVi: "10:30 – 12:00" },
  { value: "13:30-15:00", labelVi: "13:30 - 15:00" },
  { value: "15:00-16:30", labelVi: "15:00 – 16:30" },
];

const SLOT_CAPACITY = 20;

let lastSlotData = null;

function detectFormType() {
  const page = window.location.pathname.split("/").pop().split(".")[0];
  if (["doitac", "khach", "daily"].includes(page)) return page;
  return "";
}

function getSlotMeta(value) {
  return TIME_SLOTS.find((s) => s.value === value);
}

// ================================
// 🔥 UPDATE SLOT (CHỈ THÊM LOCK)
// ================================
function updateTimeOptions(slotData) {
  const timeSelect = document.getElementById("visitTime");
  if (!timeSelect || !slotData || !slotData.slots) return;

  lastSlotData = slotData;
  let needClearSelection = false;

  const selectedDate = document.getElementById("visitDate")?.value;

  Array.from(timeSelect.options).forEach((opt) => {
    const val = opt.value;
    if (!val) return;

    const meta = getSlotMeta(val);
    const baseLabel = meta ? meta.labelVi : opt.textContent;
    const count = slotData.slots[val] || 0;

    opt.hidden = false;
    opt.disabled = false;

    // 🔒 LOCK
    if (isSlotLocked(selectedDate, val)) {
      opt.disabled = true;
      opt.textContent = `${baseLabel} (ĐÃ KHOÁ)`;
      if (timeSelect.value === val) needClearSelection = true;
      return;
    }

    // FULL
    if (count >= SLOT_CAPACITY) {
      opt.disabled = true;
      opt.textContent = `${baseLabel} (ĐÃ ĐỦ SLOT)`;
      if (timeSelect.value === val) needClearSelection = true;
    } else if (count > 0) {
      opt.textContent = `${baseLabel} (${count}/${SLOT_CAPACITY})`;
    } else {
      opt.textContent = baseLabel;
    }
  });

  if (needClearSelection) {
    timeSelect.value = "";
  }
}

// ================================
// 🌐 API
// ================================
const APPSSCRIPT_URL = "https://script.google.com/macros/s/AKfycbzwNPeNr19fJr7hpO57m222AtX9cGisM0SVQydmofrd0RmoiDS7K4eGz6TVJYnz908YuQ/exec";

function fetchSlotStatus(dateStr, formType) {
  if (!dateStr) return;

  const url = `${APPSSCRIPT_URL}?action=getSlots&date=${dateStr}&formType=${formType}`;

  fetch(url)
    .then(res => res.json())
    .then(data => {
      if (data.result === "success") {
        updateTimeOptions(data);
      }
    });
}

// ================================
// 🚀 INIT
// ================================
window.addEventListener("DOMContentLoaded", () => {
  translateForm(getLang());

  const dateInput = document.getElementById("visitDate");
  if (dateInput) {
    dateInput.addEventListener("change", () => {
      const formType = detectFormType();
      fetchSlotStatus(dateInput.value, formType);
    });
  }
});

// ================================
// 🚀 SUBMIT (CHẶN LOCK)
// ================================
document.addEventListener("submit", (e) => {
  e.preventDefault();

  const lang = getLang();
  const formId = e.target.id;
  if (!formId.startsWith("form-")) return;

  const formData = collectFormData(formId);

  // 🔒 BLOCK nếu bị khoá
  if (isSlotLocked(formData.visitDate, formData.visitTime)) {
    alert("Khung giờ này đã bị khóa. Vui lòng chọn khung khác.");
    return;
  }

  fetch(APPSSCRIPT_URL, {
    method: "POST",
    body: JSON.stringify(formData),
  })
    .then(res => res.json())
    .then(data => {
      if (data.result === "success") {
        showSuccessDialog(lang);
      } else {
        alert(data.message || "Lỗi");
      }
    });
});