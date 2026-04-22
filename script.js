// ==========================================
// ⚙️ CONFIG HỆ THỐNG
// ==========================================
const SLOT_CAPACITY = 30;           // Tổng tối đa 30 người cho 1 khung giờ
const MAX_PER_REGISTRATION = 10;    // Tối đa 10 người cho 1 lần đăng ký
const APPSSCRIPT_URL = "https://script.google.com/macros/s/AKfycbzwNPeNr19fJr7hpO57m222AtX9cGisM0SVQydmofrd0RmoiDS7K4eGz6TVJYnz908YuQ/exec";

const LOCK_CONFIG = {
  
  "2026-04-25": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-04-26": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-04-27": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-04-28": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-04-29": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-04-30": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-05-01": ["09:00-10:30", "10:30-12:00","14:30-16:00","13:00-14:30"], // Khóa toàn bộ ngày
  "2026-04-23": ["14:30-16:00","13:00-14:30"],
};

const TIME_SLOTS = [
  { value: "09:00-10:30", labelVi: "09:00 – 10:30" },
  { value: "10:30-12:00", labelVi: "10:30 – 12:00" },
  { value: "13:00-14:30", labelVi: "13:00 - 14:30" },
  { value: "14:30-16:00", labelVi: "14:30 - 16:00" },
];

let lastSlotData = null; // Lưu trữ dữ liệu slot từ server để kiểm tra nhanh

// ==========================================
// 🛠 HELPER: LOADING & LOCK SLOT
// ==========================================
function isSlotLocked(date, time) {
  if (!LOCK_CONFIG[date]) return false;
  const locked = LOCK_CONFIG[date];
  return locked.includes("all") || locked.includes(time);
}

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

// ==========================================
// 🧠 NGÔN NGỮ & ĐIỀU HƯỚNG
// ==========================================
function getLang() {
  const params = new URLSearchParams(window.location.search);
  return params.get("lang") || localStorage.getItem("lang") || "vi";
}

function translateForm(lang) {
  document.querySelectorAll("label[data-vi]").forEach(lbl => {
    lbl.textContent = lbl.getAttribute(`data-${lang}`);
  });
  document.querySelectorAll("[data-ph-vi]").forEach(el => {
    el.placeholder = el.getAttribute(`data-ph-${lang}`);
  });
  const title = document.getElementById("form-title");
  if (title) {
    const map = {
      doitac: { vi: "Đăng Ký Đối Tác", en: "Partner Registration" },
      khach:  { vi: "Đăng Ký Khách",   en: "Guest Registration" },
      daily:  { vi: "Đăng Ký Đại Lý",  en: "Agency Registration" },
    };
    const page = window.location.pathname.split("/").pop().split(".")[0];
    if (map[page]) title.textContent = map[page][lang];
  }
}

// ==========================================
// ⏰ QUẢN LÝ SLOT THỜI GIAN
// ==========================================
function fetchSlotStatus(dateStr) {
  if (!dateStr) return;
  // Lưu ý: Không gửi formType để Server trả về tổng của cả 3 bảng
  fetch(`${APPSSCRIPT_URL}?action=getSlots&date=${dateStr}`)
    .then(res => res.json())
    .then(data => {
      if (data.result === "success") {
        lastSlotData = data.slots;
        updateTimeOptions(data);
      }
    });
}

function updateTimeOptions(slotData) {
  const timeMenu = document.getElementById("visitTimeMenu");
  const timeValue = document.getElementById("visitTime");
  const selectedTimeText = document.getElementById("selectedTimeText");
  const selectedDate = document.getElementById("visitDate")?.value;
  if (!timeMenu || !slotData?.slots) return;

  timeMenu.querySelectorAll(".menu-item").forEach((item) => {
    const val = item.getAttribute("data-value");
    if (!val) return;

    const meta = TIME_SLOTS.find(s => s.value === val);
    const baseLabel = meta ? meta.labelVi : val;
    const count = slotData.slots[val] || 0;

    item.style.opacity = "";
    item.style.pointerEvents = "";

    if (isSlotLocked(selectedDate, val)) {
      item.style.opacity = "0.4";
      item.style.pointerEvents = "none";
      item.textContent = `${baseLabel} (ĐÃ KHOÁ)`;
      if (timeValue && timeValue.value === val) {
        timeValue.value = "";
        if (selectedTimeText) selectedTimeText.textContent = "-- Chọn khung giờ --";
      }
    } else if (count >= SLOT_CAPACITY) {
      item.style.opacity = "0.4";
      item.style.pointerEvents = "none";
      item.textContent = `${baseLabel} (HẾT CHỖ)`;
      if (timeValue && timeValue.value === val) {
        timeValue.value = "";
        if (selectedTimeText) selectedTimeText.textContent = "-- Chọn khung giờ --";
      }
    } else {
      item.textContent = count > 0 ? `${baseLabel} (${count}/${SLOT_CAPACITY})` : baseLabel;
      if (timeValue && timeValue.value === val && selectedTimeText) {
        selectedTimeText.textContent = item.textContent;
      }
    }
  });
}

// ==========================================
// ✅ VALIDATE FORM
// ==========================================
function validateForm(formData, lang) {
  const phoneRegex = /^(0[3|5|7|8|9])[0-9]{8}$/;
  const cccdRegex = /^[0-9]{12}$/;
  if (formData.phoneNumber && !phoneRegex.test(formData.phoneNumber)) {
    alert(lang === "vi"
      ? "Số điện thoại không hợp lệ (10 số, bắt đầu bằng 03/05/07/08/09)."
      : "Invalid phone number (10 digits, starting with 03/05/07/08/09).");
    return false;
  }
  if (formData.idNumber && formData.idNumber.length > 0 && !cccdRegex.test(formData.idNumber)) {
    alert(lang === "vi"
      ? "Số CCCD không hợp lệ (phải là 12 chữ số)."
      : "Invalid ID number (must be 12 digits).");
    return false;
  }
  return true;
}

// ==========================================
// 🚀 XỬ LÝ SUBMIT FORM
// ==========================================
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
  // Fix #3: Use custom agency name if "KHÁC" was selected
  if (formId === "form-daily") {
    const customEl = document.querySelector('#form-daily [name="customAgencyName"]');
    if (customEl && customEl.value && data.agencyName && data.agencyName.includes("KHÁC")) {
      data.agencyName = customEl.value;
    }
  }
  data.formType = formId.replace("form-", "");
  return data;
}

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const lang = getLang();
  const formId = e.target.id;
  const submitBtn = e.target.querySelector('button[type="submit"]');

  if (!formId.startsWith("form-") || !submitBtn) return;

  const formData = collectFormData(formId);
  const qty = Number(formData.quantity || 0);

  // 0. Validate phone & ID
  if (!validateForm(formData, lang)) return;

  // 1. Kiểm tra giới hạn 10 người/lần đăng ký
  if (qty > MAX_PER_REGISTRATION) {
    alert(lang === "vi" ? `Tối đa ${MAX_PER_REGISTRATION} người mỗi lần đăng ký.` : `Max ${MAX_PER_REGISTRATION} people per registration.`);
    return;
  }

  // 2. Kiểm tra Lock Slot thủ công
  if (isSlotLocked(formData.visitDate, formData.visitTime)) {
    alert(lang === "vi" ? "Khung giờ này đã bị khóa." : "This slot is locked.");
    return;
  }

  // 3. Kiểm tra tổng slot còn lại (Client-side check)
  if (lastSlotData) {
    const currentOccupied = lastSlotData[formData.visitTime] || 0;
    if (currentOccupied + qty > SLOT_CAPACITY) {
      alert(lang === "vi" 
        ? `Không đủ chỗ. Khung giờ này chỉ còn ${SLOT_CAPACITY - currentOccupied} chỗ trống.` 
        : `Not enough space. Only ${SLOT_CAPACITY - currentOccupied} slots left.`);
      return;
    }
  }

  // 4. Bật trạng thái Loading & Gửi dữ liệu
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
        setLoadingState(submitBtn, false, lang);
      }
    })
    .catch(err => {
      alert("Không thể kết nối máy chủ.");
      setLoadingState(submitBtn, false, lang);
    });
});

// ==========================================
// ✨ KHỞI TẠO
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  translateForm(lang);

  // Ràng buộc ô nhập số lượng (không cho nhập âm hoặc quá 10)
  const qtyInput = document.querySelector('input[name="quantity"]');
  if (qtyInput) {
    qtyInput.addEventListener("change", function() {
      if (this.value > MAX_PER_REGISTRATION) {
        alert(`Tối đa ${MAX_PER_REGISTRATION} người mỗi lần`);
        this.value = MAX_PER_REGISTRATION;
      }
      if (this.value < 1) this.value = 1;
    });
  }

  // Set up custom time select box
  const timeBox = document.getElementById("visitTimeBox");
  const timeMenu = document.getElementById("visitTimeMenu");
  const timeHidden = document.getElementById("visitTime");
  const selectedTimeText = document.getElementById("selectedTimeText");

  if (timeBox && timeMenu) {
    timeBox.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = timeMenu.classList.contains("show");
      // Close agency dropdown if open (daily.html)
      const agencyDropdown = document.getElementById("agencyDropdown");
      if (agencyDropdown) agencyDropdown.style.display = "none";
      timeMenu.classList.toggle("show", !isOpen);
      timeBox.querySelector(".chevron")?.classList.toggle("rotate", !isOpen);
    });

    timeMenu.querySelectorAll(".menu-item").forEach(item => {
      item.addEventListener("click", () => {
        const val = item.getAttribute("data-value");
        if (timeHidden) timeHidden.value = val;
        if (selectedTimeText) selectedTimeText.textContent = item.textContent;
        timeMenu.classList.remove("show");
        timeBox.querySelector(".chevron")?.classList.remove("rotate");
      });
    });

    document.addEventListener("click", () => {
      timeMenu.classList.remove("show");
      timeBox.querySelector(".chevron")?.classList.remove("rotate");
    });
  }

  const dateInput = document.getElementById("visitDate");
  if (dateInput) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const maxDate = new Date();
    maxDate.setDate(now.getDate() + 2);
    const maxStr = maxDate.toISOString().split('T')[0];
    dateInput.value = todayStr;
    dateInput.min = todayStr;
    dateInput.max = maxStr;
    dateInput.addEventListener("change", () => {
      fetchSlotStatus(dateInput.value);
    });
    fetchSlotStatus(todayStr);
  }
});

// Hàm hiển thị Modal (Giữ nguyên logic của bạn)
function showSuccessDialog(lang) {
  const modal = document.getElementById("success-modal");
  const confirmBtn = document.getElementById("confirm-btn");
  const countdownEl = document.getElementById("countdown");
  if (!modal || !confirmBtn) {
    alert("Đăng ký thành công!");
    window.location.href = `index.html?lang=${lang}`;
    return;
  }
  modal.classList.add("show");
  let count = 4;
  const timer = setInterval(() => {
    count--;
    if (countdownEl) countdownEl.textContent = count;
    if (count <= 0) {
      clearInterval(timer);
      window.location.href = `index.html?lang=${lang}`;
    }
  }, 1000);
  confirmBtn.onclick = () => {
    clearInterval(timer);
    window.location.href = `index.html?lang=${lang}`;
  };
}
