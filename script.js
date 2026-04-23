// ==========================================
// ⚙️ CONFIG HỆ THỐNG
// ==========================================
const SLOT_CAPACITY            = 30;   // Tổng tối đa 30 người / khung giờ
const MAX_PER_REGISTRATION     = 10;   // Tối đa 10 người / lần đăng ký
const MAX_REGISTRATIONS_PER_SLOT = 3; // Tối đa 3 lượt đăng ký / khung giờ
const SECRET_TOKEN             = 'OE_2026_SECURE'; // ✅ FIX #1: phải gửi token

const APPSSCRIPT_URL = "https://script.google.com/macros/s/AKfycbzwNPeNr19fJr7hpO57m222AtX9cGisM0SVQydmofrd0RmoiDS7K4eGz6TVJYnz908YuQ/exec";

const LOCK_CONFIG = {
  "2026-04-25": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-04-26": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-04-27": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-04-28": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-04-29": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-04-30": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-05-01": ["09:00-10:30", "10:30-12:00", "13:00-14:30", "14:30-16:00"],
  "2026-04-23": ["13:00-14:30", "14:30-16:00"],
  "2026-04-24": ["09:00-10:30", "10:30-12:00"],
};

const TIME_SLOTS = [
  { value: "09:00-10:30", labelVi: "09:00 – 10:30" },
  { value: "10:30-12:00", labelVi: "10:30 – 12:00" },
  { value: "13:00-14:30", labelVi: "13:00 – 14:30" },
  { value: "14:30-16:00", labelVi: "14:30 – 16:00" },
];

// ✅ FIX #2: Lưu cả dữ liệu người lẫn dữ liệu lượt đăng ký
let lastSlotData = null; // { "09:00-10:30": 15, ... }  — số người
let lastRegData  = null; // { "09:00-10:30": 2,  ... }  — số lượt đăng ký

// ==========================================
// 🛠 HELPER
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
// 🧠 NGÔN NGỮ
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
      khach:  { vi: "Đăng Ký Khách",   en: "Guest Registration"   },
      daily:  { vi: "Đăng Ký Đại Lý",  en: "Agency Registration"  },
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
  fetch(`${APPSSCRIPT_URL}?action=getSlots&date=${dateStr}`)
    .then(res => res.json())
    .then(data => {
      if (data.result === "success") {
        lastSlotData = data.slots;        // ✅ FIX #2: lưu số người
        lastRegData  = data.registrations; // ✅ FIX #2: lưu số lượt
        updateTimeOptions(data);
      }
    })
    .catch(err => console.error("fetchSlotStatus error:", err));
}

// ✅ FIX #3: Khoá slot dựa trên CẢ HAI điều kiện — số lượt và số người
function updateTimeOptions(slotData) {
  const timeMenu        = document.getElementById("visitTimeMenu");
  const timeValue       = document.getElementById("visitTime");
  const selectedTimeText = document.getElementById("selectedTimeText");
  const selectedDate    = document.getElementById("visitDate")?.value;

  if (!timeMenu || !slotData?.slots) return;

  const maxRegs   = slotData.maxRegistrations || MAX_REGISTRATIONS_PER_SLOT;
  const maxPeople = slotData.maxPeople        || SLOT_CAPACITY;

  timeMenu.querySelectorAll(".menu-item").forEach(item => {
    const val = item.getAttribute("data-value");
    if (!val) return;

    const meta        = TIME_SLOTS.find(s => s.value === val);
    const baseLabel   = meta ? meta.labelVi : val;
    const peopleCount = (slotData.slots[val]        || 0);
    const regCount    = (slotData.registrations?.[val] || 0);

    // Reset
    item.style.opacity       = "";
    item.style.pointerEvents = "";

    // --- Trường hợp khoá ---

    // 1. Khoá thủ công qua LOCK_CONFIG
    if (isSlotLocked(selectedDate, val)) {
      _disableItem(item, `${baseLabel} (ĐÃ KHOÁ)`, timeValue, selectedTimeText, val);
      return;
    }

    // 2. ✅ FIX #3: Đủ 3 lượt đăng ký → khoá, không cho thêm
    if (regCount >= maxRegs) {
      _disableItem(item, `${baseLabel} (ĐÃ ĐỦ LƯỢT)`, timeValue, selectedTimeText, val);
      return;
    }

    // 3. Đủ 30 người → hết chỗ
    if (peopleCount >= maxPeople) {
      _disableItem(item, `${baseLabel} (HẾT CHỖ)`, timeValue, selectedTimeText, val);
      return;
    }

    // --- Còn chỗ: hiển thị trạng thái ---
    item.textContent = `${baseLabel} (${regCount}/${maxRegs} lượt · ${peopleCount}/${maxPeople} người)`;
    if (timeValue?.value === val && selectedTimeText) {
      selectedTimeText.textContent = item.textContent;
    }
  });
}

// Helper: vô hiệu hoá một item và reset nếu đang được chọn
function _disableItem(item, label, timeValue, selectedTimeText, val) {
  item.style.opacity       = "0.4";
  item.style.pointerEvents = "none";
  item.textContent         = label;
  if (timeValue?.value === val) {
    timeValue.value = "";
    if (selectedTimeText) selectedTimeText.textContent = "-- Chọn khung giờ --";
  }
}

// ==========================================
// ✅ VALIDATE FORM
// ==========================================
function validateForm(formData, lang) {
  const phoneRegex = /^(0[3|5|7|8|9])[0-9]{8}$/;
  const cccdRegex  = /^[0-9]{12}$/;

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
// 🚀 COLLECT & SUBMIT
// ==========================================
function collectFormData(formId) {
  const data = {
    timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
    token: SECRET_TOKEN, // ✅ FIX #1: gửi token để server xác thực
  };

  const fieldMap = {
    "form-doitac": ["fullName","idNumber","phoneNumber","company","recDepartment","recStaff","quantity","visitDate","visitTime","notes"],
    "form-khach":  ["fullName","idNumber","phoneNumber","email","quantity","visitDate","visitTime","notes"],
    "form-daily":  ["agencyName","staffName","idNumber","phoneNumber","customerName","customerPhoneSuffix","quantity","visitDate","visitTime","notes"],
  };

  const fields = fieldMap[formId];
  if (!fields) return null;

  fields.forEach(name => {
    const el = document.querySelector(`#${formId} [name="${name}"]`);
    if (el) data[name] = el.value;
  });

  // Nếu chọn "KHÁC", dùng tên nhập tay
  if (formId === "form-daily") {
    const customEl = document.querySelector('#form-daily [name="customAgencyName"]');
    if (customEl?.value && data.agencyName?.includes("KHÁC")) {
      data.agencyName = customEl.value;
    }
  }

  data.formType = formId.replace("form-", "");
  return data;
}

document.addEventListener("submit", e => {
  e.preventDefault();
  const lang     = getLang();
  const formId   = e.target.id;
  const submitBtn = e.target.querySelector('button[type="submit"]');

  if (!formId.startsWith("form-") || !submitBtn) return;

  const formData = collectFormData(formId);
  const qty      = Number(formData.quantity || 0);

  // 0. Kiểm tra số điện thoại / CCCD
  if (!validateForm(formData, lang)) return;

  // 1. Kiểm tra giới hạn 10 người / lần
  if (qty < 1 || qty > MAX_PER_REGISTRATION) {
    alert(lang === "vi"
      ? `Mỗi lần đăng ký tối đa ${MAX_PER_REGISTRATION} người.`
      : `Max ${MAX_PER_REGISTRATION} people per registration.`);
    return;
  }

  // 2. Kiểm tra khoá thủ công
  if (isSlotLocked(formData.visitDate, formData.visitTime)) {
    alert(lang === "vi" ? "Khung giờ này đã bị khóa." : "This slot is locked.");
    return;
  }

  // 3. ✅ FIX #4: Kiểm tra giới hạn 3 lượt đăng ký (client-side)
  if (lastRegData) {
    const currentRegs = lastRegData[formData.visitTime] || 0;
    if (currentRegs >= MAX_REGISTRATIONS_PER_SLOT) {
      alert(lang === "vi"
        ? `Khung giờ này đã đủ ${MAX_REGISTRATIONS_PER_SLOT} lượt đăng ký. Vui lòng chọn khung giờ khác.`
        : `This slot has reached the maximum of ${MAX_REGISTRATIONS_PER_SLOT} bookings. Please select another time.`);
      return;
    }
  }

  // 4. Kiểm tra tổng 30 người (client-side)
  if (lastSlotData) {
    const currentOccupied = lastSlotData[formData.visitTime] || 0;
    if (currentOccupied + qty > SLOT_CAPACITY) {
      alert(lang === "vi"
        ? `Không đủ chỗ. Khung giờ này chỉ còn ${SLOT_CAPACITY - currentOccupied} chỗ trống.`
        : `Not enough space. Only ${SLOT_CAPACITY - currentOccupied} slots remaining.`);
      return;
    }
  }

  // 5. Gửi lên server
  setLoadingState(submitBtn, true, lang);

  fetch(APPSSCRIPT_URL, {
    method: "POST",
    body: JSON.stringify(formData),
  })
    .then(res => res.json())
    .then(data => {
      if (data.result === "success") {
        showSuccessDialog(lang);
      } else if (data.result === "full") {
        // ✅ FIX #5: Xử lý phản hồi "full" riêng biệt (khoá lượt hoặc hết chỗ)
        alert(data.message || (lang === "vi" ? "Khung giờ đã đầy." : "This slot is full."));
        setLoadingState(submitBtn, false, lang);
        // Làm mới trạng thái slot để UI cập nhật ngay
        const dateInput = document.getElementById("visitDate");
        if (dateInput) fetchSlotStatus(dateInput.value);
      } else {
        alert(data.message || "Lỗi hệ thống. Vui lòng thử lại.");
        setLoadingState(submitBtn, false, lang);
      }
    })
    .catch(() => {
      alert(lang === "vi" ? "Không thể kết nối máy chủ." : "Cannot connect to server.");
      setLoadingState(submitBtn, false, lang);
    });
});

// ==========================================
// ✨ KHỞI TẠO
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  translateForm(lang);

  // Giới hạn ô nhập số lượng
  const qtyInput = document.querySelector('input[name="quantity"]');
  if (qtyInput) {
    qtyInput.addEventListener("change", function () {
      if (this.value > MAX_PER_REGISTRATION) {
        alert(`Tối đa ${MAX_PER_REGISTRATION} người mỗi lần`);
        this.value = MAX_PER_REGISTRATION;
      }
      if (this.value < 1) this.value = 1;
    });
  }

  // Custom time select box
  const timeBox          = document.getElementById("visitTimeBox");
  const timeMenu         = document.getElementById("visitTimeMenu");
  const timeHidden       = document.getElementById("visitTime");
  const selectedTimeText = document.getElementById("selectedTimeText");

  if (timeBox && timeMenu) {
    timeBox.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = timeMenu.classList.contains("show");
      // Đóng dropdown đại lý nếu đang mở
      const agencyDropdown = document.getElementById("agencyDropdown");
      if (agencyDropdown) agencyDropdown.style.display = "none";
      timeMenu.classList.toggle("show", !isOpen);
      timeBox.querySelector(".chevron")?.classList.toggle("rotate", !isOpen);
    });

    timeMenu.querySelectorAll(".menu-item").forEach(item => {
      item.addEventListener("click", () => {
        // Bỏ qua nếu bị vô hiệu hoá
        if (item.style.pointerEvents === "none") return;
        const val = item.getAttribute("data-value");
        if (!val) return;
        if (timeHidden)       timeHidden.value           = val;
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

  // Ngày — set giá trị mặc định và lắng nghe thay đổi
  const dateInput = document.getElementById("visitDate");
  if (dateInput) {
    const now      = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const maxDate  = new Date();
    maxDate.setDate(now.getDate() + 2);
    const maxStr = maxDate.toISOString().split("T")[0];

    dateInput.value = todayStr;
    dateInput.min   = todayStr;
    dateInput.max   = maxStr;

    dateInput.addEventListener("change", () => fetchSlotStatus(dateInput.value));
    fetchSlotStatus(todayStr);
  }
});

// ==========================================
// ✅ MODAL THÀNH CÔNG
// ==========================================
function showSuccessDialog(lang) {
  const modal      = document.getElementById("success-modal");
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
