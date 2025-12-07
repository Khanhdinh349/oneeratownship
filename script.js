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
  // Dịch label
  document.querySelectorAll("label[data-vi]").forEach((lbl) => {
    lbl.textContent = lbl.getAttribute(`data-${lang}`);
  });

  // Dịch placeholder
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
// 📝 Thu thập dữ liệu form (kèm quantity)
// ================================
function collectFormData(formId) {
  const data = {
    timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
  };

  const fieldMap = {
    "form-doitac": [
      { selector: '[name="fullName"]',      name: "fullName" },
      { selector: '[name="idNumber"]',      name: "idNumber" },
      { selector: '[name="phoneNumber"]',   name: "phoneNumber" },
      { selector: '[name="company"]',       name: "company" },
      { selector: '[name="recDepartment"]', name: "recDepartment" },
      { selector: '[name="recStaff"]',      name: "recStaff" },
      { selector: '[name="quantity"]',      name: "quantity" },
      { selector: '[name="visitDate"]',     name: "visitDate" },
      { selector: '[name="visitTime"]',     name: "visitTime" },
      { selector: '[name="notes"]',         name: "notes" },
    ],
    "form-khach": [
      { selector: '[name="fullName"]',      name: "fullName" },
      { selector: '[name="idNumber"]',      name: "idNumber" },
      { selector: '[name="phoneNumber"]',   name: "phoneNumber" },
      { selector: '[name="email"]',         name: "email" },
      { selector: '[name="quantity"]',      name: "quantity" },
      { selector: '[name="visitDate"]',     name: "visitDate" },
      { selector: '[name="visitTime"]',     name: "visitTime" },
      { selector: '[name="notes"]',         name: "notes" },
    ],
    "form-daily": [
      { selector: '[name="agencyName"]',    name: "agencyName" },
      { selector: '[name="staffName"]',     name: "staffName" },
      { selector: '[name="idNumber"]',      name: "idNumber" },
      { selector: '[name="phoneNumber"]',   name: "phoneNumber" },
      { selector: '[name="quantity"]',      name: "quantity" },
      { selector: '[name="visitDate"]',     name: "visitDate" },
      { selector: '[name="visitTime"]',     name: "visitTime" },
      { selector: '[name="notes"]',         name: "notes" },
    ],
  };

  const currentFormMap = fieldMap[formId];
  if (!currentFormMap) return null;

  currentFormMap.forEach((f) => {
    const el = document.querySelector(`#${formId} ${f.selector}`);
    if (el) data[f.name] = el.value;
  });

  data.formType = formId.replace("form-", ""); // doitac | khach | daily
  return data;
}

// ================================
// ⏰ QUẢN LÝ KHUNG GIỜ & SỐ LƯỢNG
// ================================
const TIME_SLOTS = [
  { value: "09:00-10:30", labelVi: "09:00 – 10:30" },
  { value: "10:30-12:00", labelVi: "10:30 – 12:00" },
  { value: "13:00-14:30", labelVi: "13:00 – 14:30" },
  { value: "14:30-16:00", labelVi: "14:30 – 16:00" },
  { value: "16:00-17:30", labelVi: "16:00 – 17:30" },
];

const SLOT_CAPACITY = 25; // tối đa 25 khách
let lastSlotData = null;

function detectFormType() {
  const page = window.location.pathname.split("/").pop().split(".")[0];
  if (["doitac", "khach", "daily"].includes(page)) return page;
  return "";
}

function getSlotMeta(value) {
  return TIME_SLOTS.find((s) => s.value === value);
}

function updateSlotNotice(selectedValue) {
  const slotNotice = document.getElementById("slotNotice");
  if (!slotNotice) return;

  slotNotice.textContent = "";
  slotNotice.classList.remove("full", "near-full");

  if (!selectedValue || !lastSlotData || !lastSlotData.slots) return;

  const count = lastSlotData.slots[selectedValue] || 0;
  const meta = getSlotMeta(selectedValue);
  const baseLabel = meta ? meta.labelVi : selectedValue;

  slotNotice.textContent = `${baseLabel}: ${count}/${SLOT_CAPACITY} khách`;

  if (count >= SLOT_CAPACITY) {
    slotNotice.textContent += " (ĐÃ ĐỦ SLOT, vui lòng chọn khung khác)";
    slotNotice.classList.add("full");
  } else if (count > 0) {
    slotNotice.textContent += " (Còn chỗ)";
    slotNotice.classList.add("near-full");
  }
}

function updateTimeOptions(slotData) {
  const timeSelect = document.getElementById("visitTime");
  if (!timeSelect || !slotData || !slotData.slots) return;

  lastSlotData = slotData;
  let needClearSelection = false;

  Array.from(timeSelect.options).forEach((opt) => {
    const val = opt.value;
    if (!val) return; // bỏ placeholder

    const meta = getSlotMeta(val);
    const baseLabel = meta ? meta.labelVi : opt.textContent;
    const count = slotData.slots[val] || 0;

    // reset
    opt.hidden = false;
    opt.disabled = false;

    if (count >= SLOT_CAPACITY) {
      // Đã đủ 25 khách: disable & cảnh báo
      opt.disabled = true;
      opt.textContent = `${baseLabel} (ĐÃ ĐỦ SLOT, vui lòng chọn khung khác)`;
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

  updateSlotNotice(timeSelect.value);
}

// =====================================
// 🔑 URL Google Apps Script (Web App)
// =====================================
const APPSSCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzwNPeNr19fJr7hpO57m222AtX9cGisM0SVQydmofrd0RmoiDS7K4eGz6TVJYnz908YuQ/exec";

// Lấy số lượng slot từ server
function fetchSlotStatus(dateStr, formType) {
  if (!dateStr) return;

  const url = `${APPSSCRIPT_URL}?action=getSlots&date=${encodeURIComponent(
    dateStr
  )}&formType=${encodeURIComponent(formType || "")}`;

  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then((data) => {
      if (data.result === "success") {
        updateTimeOptions(data);
      } else {
        console.error("Lỗi lấy số lượng slot:", data.message);
      }
    })
    .catch((err) => {
      console.error("Lỗi fetch slot:", err);
    });
}

function setupSlotControl() {
  const dateInput  = document.getElementById("visitDate");
  const timeSelect = document.getElementById("visitTime");
  if (!dateInput || !timeSelect) return;

  const formType = detectFormType();

  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    fetchSlotStatus(dateInput.value, formType);
  });

  timeSelect.addEventListener("change", () => {
    updateSlotNotice(timeSelect.value);
  });

  if (dateInput.value) {
    fetchSlotStatus(dateInput.value, formType);
  }
}

// ================================
// 🚀 Khi tải trang
// ================================
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  translateForm(lang);
  setupSlotControl();
});

// ========================================================
// 🚀 Submit form – Gửi dữ liệu đến Apps Script
// ========================================================
document.addEventListener("submit", (e) => {
  e.preventDefault();

  const lang = getLang();
  const formId = e.target.id;
  if (!formId.startsWith("form-")) return;

  const formData = collectFormData(formId);

  const submitBtn = e.target.querySelector(".submit-btn");
  if (submitBtn) {
    submitBtn.disabled   = true;
    submitBtn.textContent = lang === "vi" ? "Đang gửi..." : "Sending...";
  }

  fetch(APPSSCRIPT_URL, {
    method: "POST",
    body: JSON.stringify(formData),
  })
    .then((response) => {
      if (response.ok) return response.json();
      throw new Error(`Lỗi server. Mã trạng thái: ${response.status}`);
    })
    .then((data) => {
      if (data.result === "success") {
        console.log("Dữ liệu đã được ghi thành công:", data.data);
        showSuccessDialog(lang);
      } else if (data.result === "full") {
        const msgVi = "Khung giờ này đã vượt quá 25 khách. Vui lòng chọn khung khác.";
        const msgEn = "This time slot already exceeds 25 guests. Please choose another slot.";
        alert(lang === "vi" ? msgVi : msgEn);

        const formType = formData.formType;
        if (formData.visitDate) {
          fetchSlotStatus(formData.visitDate, formType);
        }
      } else {
        alert(
          lang === "vi"
            ? `Lỗi khi ghi dữ liệu. Chi tiết: ${data.message}`
            : `Error writing data. Details: ${data.message}`
        );
        console.error("Lỗi Apps Script:", data.message);
      }
    })
    .catch((error) => {
      alert(
        lang === "vi"
          ? "Lỗi kết nối hoặc cấu hình. Vui lòng kiểm tra lại Apps Script URL và kết nối mạng."
          : "Connection or configuration error. Please check Apps Script URL and network connection."
      );
      console.error("Lỗi khi gửi form:", error);
    })
    .finally(() => {
      if (submitBtn) {
        submitBtn.disabled   = false;
        submitBtn.textContent = lang === "vi" ? "Gửi đăng ký" : "Submit";
      }
    });
});
