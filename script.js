// === 🧠 Quản lý Ngôn ngữ & Điều hướng Ban đầu ===

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

// === Tự động cập nhật giờ VN (UTC+7) ===
function setVietnamTime() {
  const now = new Date();
  const vietnamOffset = 7 * 60; 
  const localOffset = now.getTimezoneOffset();
  const vietnamTime = new Date(now.getTime() + (vietnamOffset + localOffset) * 60000);

  const dateInput = document.getElementById("visitDate");
  const timeInput = document.getElementById("visitTime");
  if (dateInput && timeInput) {
    const yyyy = vietnamTime.getFullYear();
    const mm = String(vietnamTime.getMonth() + 1).padStart(2, "0");
    const dd = String(vietnamTime.getDate()).padStart(2, "0");
    dateInput.value = `${yyyy}-${mm}-${dd}`;

    const hh = String(vietnamTime.getHours()).padStart(2, "0");
    const mi = String(vietnamTime.getMinutes()).padStart(2, "0");
    timeInput.value = `${hh}:${mi}`;
  }
}

// === Dịch toàn bộ form ===
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
      khach: { vi: "Đăng Ký Khách", en: "Guest Registration" },
      daily: { vi: "Đăng Ký Đại Lý", en: "Agency Registration" },
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

// === Modal Redirect Logic ===
let countdownTimer;

function setupRedirect(lang, confirmBtn) {
  const redirectToIndex = () => {
    if (countdownTimer) clearInterval(countdownTimer);
    // Bỏ attach listener cũ để tránh lỗi double click
    confirmBtn.removeEventListener('click', redirectToIndex); 
    window.location.href = `index.html?lang=${lang}`;
  };

  confirmBtn.onclick = redirectToIndex;
  return redirectToIndex;
}

// === Hiển thị thông báo thành công ===
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

  if (typeof confetti === 'function') {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  }

  modal.classList.add('show');
  setupRedirect(lang, confirmBtn);

  const activeForm = modal.closest("body").querySelector("form");
  if (activeForm) activeForm.reset();
}

// === Thu thập dữ liệu form ===
function collectFormData(formId) {
  const data = {
    timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  };

  const fieldMap = {
    "form-doitac": [
      { selector: '[name="fullName"]', name: 'fullName' },
      { selector: '[name="idNumber"]', name: 'idNumber' },
      { selector: '[name="phoneNumber"]', name: 'phoneNumber' },
      { selector: '[name="company"]', name: 'company' },
      { selector: '[name="recDepartment"]', name: 'recDepartment' },
      { selector: '[name="recStaff"]', name: 'recStaff' },
      { selector: '[name="visitDate"]', name: 'visitDate' },
      { selector: '[name="visitTime"]', name: 'visitTime' },
      { selector: '[name="notes"]', name: 'notes' }
    ],
    "form-khach": [
      { selector: '[name="fullName"]', name: 'fullName' },
      { selector: '[name="idNumber"]', name: 'idNumber' },
      { selector: '[name="phoneNumber"]', name: 'phoneNumber' },
      { selector: '[name="email"]', name: 'email' },
      { selector: '[name="visitDate"]', name: 'visitDate' },
      { selector: '[name="visitTime"]', name: 'visitTime' },
      { selector: '[name="notes"]', name: 'notes' }
    ],
    "form-daily": [
      { selector: '[name="agencyName"]', name: 'agencyName' },
      { selector: '[name="staffName"]', name: 'staffName' },
      { selector: '[name="idNumber"]', name: 'idNumber' },
      { selector: '[name="phoneNumber"]', name: 'phoneNumber' },
      { selector: '[name="visitDate"]', name: 'visitDate' },
      { selector: '[name="visitTime"]', name: 'visitTime' },
      { selector: '[name="notes"]', name: 'notes' }
    ]
  };

  const currentFormMap = fieldMap[formId];
  if (!currentFormMap) return null;

  currentFormMap.forEach(f => {
    const el = document.querySelector(`#${formId} ${f.selector}`);
    if (el) data[f.name] = el.value;
  });

  data.formType = formId.replace("form-", "");
  return data;
}

// === Khi tải trang ===
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  setVietnamTime();
  translateForm(lang);
});


// ==========================================================
// === 🔑 KHAI BÁO URL CỦA GOOGLE APPS SCRIPT (ENDPOINT) ===
// ==========================================================

const APPSSCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzwNPeNr19fJr7hpO57m222AtX9cGisM0SVQydmofrd0RmoiDS7K4eGz6TVJYnz908YuQ/exec'; 


// ========================================================
// === 🚀 Submit form GỬI DỮ LIỆU ĐẾN APPS SCRIPT ===
// ========================================================
document.addEventListener("submit", (e) => {
  e.preventDefault();
  
  const lang = getLang();
  const formId = e.target.id;

  if (!formId.startsWith("form-")) return;

  // 1. Thu thập dữ liệu form
  const formData = collectFormData(formId);

  // 2. Tắt nút Submit để tránh gửi nhiều lần
  const submitBtn = e.target.querySelector('.submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = (lang === 'vi' ? "Đang gửi..." : "Sending...");
  }

  // 3. Gửi dữ liệu qua Apps Script bằng Fetch API
  fetch(APPSSCRIPT_URL, {
      method: 'POST',
      // Dữ liệu phải được chuyển thành chuỗi JSON để gửi đi
      body: JSON.stringify(formData), 
  })
  .then(response => {
      // Kiểm tra trạng thái HTTP, ví dụ: 200 OK
      if (response.ok) {
          return response.json(); 
      }
      // Xử lý lỗi HTTP
      throw new Error(`Lỗi server. Mã trạng thái: ${response.status}`);
  })
  .then(data => {
      if (data.result === 'success') {
          console.log("Dữ liệu đã được ghi thành công:", data.data);
          showSuccessDialog(lang); 
      } else {
          // Xử lý lỗi từ Apps Script (ví dụ: lỗi JSON.parse trong GAS)
          alert(lang === 'vi' ? 
              `Lỗi khi ghi dữ liệu. Chi tiết: ${data.message}` : 
              `Error writing data. Details: ${data.message}`);
          console.error("Lỗi Apps Script:", data.message);
      }
  })
  .catch(error => {
      // Xử lý lỗi kết nối mạng (Network Error, CORS)
      alert(lang === 'vi' ? 
          "Lỗi kết nối hoặc cấu hình. Vui lòng kiểm tra lại Apps Script URL và kết nối mạng." : 
          "Connection or configuration error. Please check Apps Script URL and network connection.");
      console.error('Lỗi khi gửi form:', error);
  })
  .finally(() => {
    // Luôn mở lại nút submit sau khi hoàn thành (dù thành công hay thất bại)
    if (submitBtn) {
        submitBtn.disabled = false;
        // Khôi phục lại nội dung ban đầu (Gửi đăng ký / Submit)
        submitBtn.textContent = (lang === 'vi' ? "Gửi đăng ký" : "Submit"); 
    }
  });
});