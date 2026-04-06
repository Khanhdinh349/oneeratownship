// ================================
// 🔒 CONFIG LOCK NGÀY / GIỜ
// ================================
const LOCK_CONFIG = {
  // "2026-04-05": ["all"], // khoá cả ngày
  "2026-04-02": ["09:00-10:30", "10:30-12:00"], // khoá cụ thể slot
};

function isSlotLocked(date, time) {
  if (!LOCK_CONFIG[date]) return false;
  const locked = LOCK_CONFIG[date];
  if (locked.includes("all")) return true;
  return locked.includes(time);
}

// ================================
// 🛠 HELPER: LOADING STATE (CHỐNG BẤM NHIỀU LẦN)
// ================================
function setLoadingState(button, isLoading, lang = 'vi') {
  if (isLoading) {
    button.disabled = true;
    button.style.opacity = "0.7";
    button.style.cursor = "not-allowed";
    button.setAttribute("data-original-text", button.textContent);
    button.textContent = lang === "vi" ? "ĐANG XỬ LÝ..." : "PROCESSING...";
  } else {
    button.disabled = false;
    button.style.opacity = "1";
    button.style.cursor = "pointer";
    button.textContent = button.getAttribute("data-original-text") || button.textContent;
  }
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
    const lang = getLang(); // Lấy lang hiện tại
    const type = document.getElementById("userType")?.value;

    if (type === "" || !type) {
      alert(lang === "vi" ? "Vui lòng chọn loại đăng ký" : "Please select a registration type");
      return;
    }

    // Block nút chuyển hướng
    setLoadingState(goBtn, true, lang);
    
    setLang(lang);
    setTimeout(() => {
        window.location.href = `${type}.html?lang=${lang}`;
    }, 300);
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
  let submitBtn = document.querySelector(".submit-btn") || document.getElementById("goBtn");

  if (title) {
    const map = {
      doitac: { vi: "Đăng Ký Đối Tác", en: "Partner Registration" },
      khach:  { vi: "Đăng Ký Khách",   en: "Guest Registration" },
      daily:  { vi: "Đăng Ký Đại Lý",  en: "Agency Registration" },
    };
    const page = window.location.pathname.split("/").pop().split(".")[0];

    if (map[page]) {
      title.textContent = map[page][lang];
      if (submitBtn && !document.getElementById("goBtn")) {
        submitBtn.textContent = lang === "vi" ? "Gửi đăng ký" : "Submit";
      }
    }
  }
}

// ================================
// 🎉 Modal thông báo thành công
// ================================
function setupRedirect(lang, confirmBtn) {
  const redirectToIndex = () => {
    window.location.href = `index.html?lang=${lang}`;
  };
  confirmBtn.onclick = redirectToIndex;
}

function showSuccessDialog(lang) {
  const modal = document.getElementById("success-modal");
  const title = document.getElementById("modal-title");
  const message = document.getElementById("modal-message");
  const confirmBtn = document.getElementById("confirm-btn");

  if (!modal || !confirmBtn) {
    alert(lang === "vi" ? "Đăng ký thành công!" : "Registration Successful!");
    window.location.href = `index.html?lang=${lang}`;
    return;
  }

  title.textContent = lang === "vi" ? "✅ Đăng ký thành công!" : "✅ Successful Registration!";
  message.innerHTML = lang === "vi" ? "Chào Mừng Đến Với One Era." : "Welcome to One Era.";
  confirmBtn.textContent = lang === "vi" ? "Xác nhận" : "Confirm";

  if (typeof confetti === "function") {
    confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
  }

  modal.classList.add("show");
  setupRedirect(lang, confirmBtn);
}

// ================================
// 📝 Thu thập dữ liệu form
// ================================
function collectFormData(formId) {
  const data = {
    timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
  };

  const fieldMap = {
    "form-doitac": ["fullName","idNumber","phoneNumber","company","recDepartment","recStaff","quantity","visitDate","visitTime","notes"],
    "form-khach":  ["fullName","idNumber","phoneNumber","email","quantity","visitDate","visitTime","notes"],
    "form-daily":  ["agencyName","staffName","idNumber","phoneNumber","quantity","visitDate","visitTime","notes"],
  };

  const fields = fieldMap[formId];
  if (!fields) return null;

  fields.forEach((name) => {
    const el = document.querySelector(`#${formId} [name="${name}"]`);
    if (el) data[name] = el.value;
  });

  data.formType = formId.replace("form-", "");
  return data;
}

// ================================
// ⏰ SLOT CONFIG
// ================================
const TIME_SLOTS = [
  { value: "09:00-10:30", labelVi: "09:00 – 10:30" },
  { value: "10:30-12:00", labelVi: "10:30 – 12:00" },
  { value: "13:30-15:00", labelVi: "13:30 - 15:00" },
  { value: "15:00-16:30", labelVi: "15:00 – 16:30" },
];
const SLOT_CAPACITY = 30; // Đã cập nhật theo yêu cầu trước đó

function detectFormType() {
  return window.location.pathname.split("/").pop().split(".")[0];
}

function updateTimeOptions(slotData) {
  const timeSelect = document.getElementById("visitTime");
  const selectedDate = document.getElementById("visitDate")?.value;
  if (!timeSelect || !slotData?.slots) return;

  Array.from(timeSelect.options).forEach((opt) => {
    const val = opt.value;
    if (!val) return;

    const meta = TIME_SLOTS.find(s => s.value === val);
    const baseLabel = meta ? meta.labelVi : opt.textContent;
    const count = slotData.slots[val] || 0;

    opt.disabled = false;

    if (isSlotLocked(selectedDate, val)) {
      opt.disabled = true;
      opt.textContent = `${baseLabel} (ĐÃ KHOÁ)`;
    } else if (count >= SLOT_CAPACITY) {
      opt.disabled = true;
      opt.textContent = `${baseLabel} (HẾT CHỖ)`;
    } else {
      opt.textContent = count > 0 ? `${baseLabel} (${count}/${SLOT_CAPACITY})` : baseLabel;
    }
  });
}

// ================================
// 🌐 API & SUBMIT
// ================================
const APPSSCRIPT_URL = "https://script.google.com/macros/s/AKfycbzwNPeNr19fJr7hpO57m222AtX9cGisM0SVQydmofrd0RmoiDS7K4eGz6TVJYnz908YuQ/exec";

function fetchSlotStatus(dateStr, formType) {
  if (!dateStr) return;
  fetch(`${APPSSCRIPT_URL}?action=getSlots&date=${dateStr}&formType=${formType}`)
    .then(res => res.json())
    .then(data => data.result === "success" && updateTimeOptions(data));
}

// KHỞI TẠO
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  translateForm(lang);

  const dateInput = document.getElementById("visitDate");
  if (dateInput) {
    dateInput.addEventListener("change", () => fetchSlotStatus(dateInput.value, detectFormType()));
  }
});

// XỬ LÝ SUBMIT FORM
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const lang = getLang();
  const formId = e.target.id;
  const submitBtn = e.target.querySelector('button[type="submit"]');

  if (!formId.startsWith("form-") || !submitBtn) return;

  const formData = collectFormData(formId);

  // 1. Kiểm tra Lock Slot
  if (isSlotLocked(formData.visitDate, formData.visitTime)) {
    alert(lang === "vi" ? "Khung giờ này đã bị khóa." : "This slot is locked.");
    return;
  }

  // 2. Bật trạng thái Loading & Block nút
  setLoadingState(submitBtn, true, lang);

  fetch(APPSSCRIPT_URL, {
    method: "POST",
    body: JSON.stringify(formData),
  })
    .then(res => res.json())
    .then(data => {
      if (data.result === "success") {
        showSuccessDialog(lang);
      } else {
        alert(data.message || "Lỗi hệ thống");
        setLoadingState(submitBtn, false, lang); // Mở lại nút nếu lỗi
      }
    })
    .catch(err => {
      console.error(err);
      alert("Không thể kết nối máy chủ.");
      setLoadingState(submitBtn, false, lang); // Mở lại nút nếu lỗi
    });
});