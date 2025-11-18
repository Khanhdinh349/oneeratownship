// === 🧠 Ngôn ngữ ===
function getLang() {
  const params = new URLSearchParams(window.location.search);
  return params.get("lang") || localStorage.getItem("lang") || "vi";
}

function setLang(lang) {
  localStorage.setItem("lang", lang);
}

// === Trang chọn loại đăng ký (index.html) ===
const goBtn = document.getElementById("goBtn");
if (goBtn) {
  goBtn.addEventListener("click", () => {
    const lang = document.getElementById("language").value;
    const type = document.getElementById("userType").value;
    if (!type) {
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
  const submitBtn = document.getElementById("goBtn");
  if (title && submitBtn) {
    const map = {
      doitac: { vi: "Đăng Ký Đối Tác", en: "Partner Registration" },
      khach: { vi: "Đăng Ký Khách", en: "Guest Registration" },
      daily: { vi: "Đăng Ký Đại Lý", en: "Agency Registration" },
    };
    const page = window.location.pathname.split("/").pop().split(".")[0];
    if (map[page]) {
      title.textContent = map[page][lang];
    }
    submitBtn.textContent = lang === "vi" ? "Gửi đăng ký" : "Submit";
  }
}

// === Hiển thị thông báo thành công và chuyển hướng ===
function showSuccessAndRedirect(lang) {
  const successMessage = lang === "vi" ? "✅ Đăng ký thành công! Bạn sẽ được chuyển hướng." : "✅ Registration successful! You will be redirected.";
  
  // --- Logic Hiệu ứng Pháo hoa Giấy (Confetti) ---
  // Cần nhúng thư viện canvas-confetti.js trong HTML để hoạt động
  if (typeof confetti === 'function') {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  } 

  // Hiển thị thông báo thành công
  alert(successMessage);
  
  // Chuyển hướng về trang index.html
  setTimeout(() => {
    window.location.href = `index.html?lang=${lang}`;
  }, 100); 
}

// === Thu thập dữ liệu form cụ thể ===
function collectFormData(formId) {
    const data = {
        timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
    };

    // Định nghĩa ánh xạ giữa selector trong form HTML và tên thuộc tính
    // Tên thuộc tính phải KHỚP với TÊN CỘT trong Google Apps Script
    const fieldMap = {
        "form-doitac": [
            { selector: '[data-ph-en="Enter full name"]', name: 'fullName' },
            { selector: '[data-ph-en="Enter ID number"]', name: 'idNumber' },
            { selector: '[data-ph-en="Enter phone number"]', name: 'phoneNumber' },
            { selector: '[data-ph-en="Company name"]', name: 'company' },
            { selector: '[data-ph-en="Department name"]', name: 'recDepartment' },
            { selector: '[data-ph-en="Staff name"]', name: 'recStaff' },
            { selector: '#visitDate', name: 'visitDate' },
            { selector: '#visitTime', name: 'visitTime' },
            { selector: 'textarea', name: 'notes' }
        ],
        "form-khach": [
            { selector: '[data-ph-en="Enter full name"]', name: 'fullName' },
            { selector: '[data-ph-en="Enter ID number"]', name: 'idNumber' },
            { selector: '[data-ph-en="Enter phone number"]', name: 'phoneNumber' },
            { selector: '[data-ph-en="Enter email if available"]', name: 'email' },
            { selector: '#visitDate', name: 'visitDate' },
            { selector: '#visitTime', name: 'visitTime' },
            { selector: 'textarea', name: 'notes' }
        ],
        "form-daily": [
            { selector: '[data-ph-en="Enter agency name"]', name: 'agencyName' },
            { selector: '[data-ph-en="Enter staff name"]', name: 'staffName' },
            { selector: '[data-ph-en="Enter ID number"]', name: 'idNumber' },
            { selector: '[data-ph-en="Enter phone number"]', name: 'phoneNumber' },
            { selector: '#visitDate', name: 'visitDate' },
            { selector: '#visitTime', name: 'visitTime' },
            { selector: 'textarea', name: 'notes' }
        ]
    };
    
    // Lấy ID form hiện tại
    const currentFormMap = fieldMap[formId];
    if (!currentFormMap) return null;

    currentFormMap.forEach(field => {
        // Tìm phần tử trong form hiện tại
        const element = document.querySelector(`#${formId} ${field.selector}`);
        if (element) {
            data[field.name] = element.value;
        }
    });

    data.formType = formId.replace('form-', ''); // Thêm loại form (doitac, khach, daily)
    return data;
}

// !!! THAY THẾ URL NÀY BẰNG URL APPS SCRIPT ĐÃ TRIỂN KHAI CỦA BẠN !!!
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyuDDY28hFBK6cBcnMnsAEhLTyn6-FrWkXoFf9dqnbM5ea7-xIaxY1E1m4CDQ3967hw/exec'; 

async function sendDataToSheet(formData, lang) {
    if (APPS_SCRIPT_URL === 'https://script.google.com/macros/s/AKfycbyuDDY28hFBK6cBcnMnsAEhLTyn6-FrWkXoFf9dqnbM5ea7-xIaxY1E1m4CDQ3967hw/exec') {
        alert("Lỗi: Vui lòng thay thế APPS_SCRIPT_URL trong script.js bằng URL đã triển khai của bạn.");
        return;
    }
    
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            mode: 'cors',
            headers: {
                // Sử dụng text/plain để Apps Script có thể dễ dàng đọc JSON
                'Content-Type': 'text/plain;charset=utf-8' 
            },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (result.result === "success") {
            showSuccessAndRedirect(lang); // Hiển thị chúc mừng và chuyển hướng
        } else {
            alert(`Lỗi khi ghi dữ liệu: ${result.message}`);
        }
    } catch (error) {
        alert(`Lỗi kết nối máy chủ: ${error.message}`);
    }
}


// === Khi tải mỗi trang ===
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  setVietnamTime();
  translateForm(lang);
});

// === Submit form (Gửi dữ liệu) ===
document.addEventListener("submit", (e) => {
    e.preventDefault();
    const lang = getLang();
    const formId = e.target.id; 

    // 1. Thu thập dữ liệu
    const formData = collectFormData(formId);

    if (formData) {
        // 2. Gửi dữ liệu đến Apps Script
        sendDataToSheet(formData, lang);
    } else {
        alert("Lỗi: Không tìm thấy form ID hợp lệ.");
    }
});