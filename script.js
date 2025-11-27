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
      if (submitBtn.textContent.includes("Gửi") || submitBtn.textContent.includes("Continue")) {
          submitBtn.textContent = lang === "vi" ? "Gửi đăng ký" : "Submit";
      }
    }
  }
}

// === Modal Redirect Logic ===
let countdownTimer;

function setupRedirect(lang, confirmBtn) {
    const redirectToIndex = () => {
        if (countdownTimer) {
            clearInterval(countdownTimer);
        }
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
      alert(lang === "vi" ? "Đăng ký thành công! (Không tìm thấy hộp thoại tùy chỉnh)" : "Registration Successful! (Custom dialog not found)");
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

  // Hiệu ứng Confetti
  if (typeof confetti === 'function') {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  }

  // Hiển thị modal
  modal.classList.add('show');

  // Redirect Setup
  const redirectToIndex = setupRedirect(lang, confirmBtn);

  // Reset form an toàn
  const activeForm = modal.closest("body").querySelector("form");
  if (activeForm) activeForm.reset();
} // <-- ĐÓNG HÀM ĐÚNG CHỖ

// === Thu thập dữ liệu form ===
function collectFormData(formId) {
    const data = {
        timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
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

    currentFormMap.forEach(field => {
        const element = document.querySelector(`#${formId} ${field.selector}`);
        if (element) {
            data[field.name] = element.value;
        }
    });

    data.formType = formId.replace('form-', ''); 
    return data;
}

// === HÀM MỚI: Gửi dữ liệu qua Apps Script (Thực hiện POST) ===
async function sendDataToSheet(formData, lang) {
    // 🚀 Đã thay thế URL Web App của bạn vào đây
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx_piizLKBsIKb2LqFZjpOud0DUATR-YjcjZ-f6Lh5mfxOi9fz_ToqeVXJtEv1gSbt6/exec'; 
    const errorMsg = lang === "vi" ? "Gửi dữ liệu thất bại." : "Data submission failed.";
    const submitBtn = document.querySelector(".submit-btn");

    if (submitBtn) {
        submitBtn.disabled = true; // Tắt nút gửi trong khi chờ phản hồi
        submitBtn.textContent = lang === "vi" ? "Đang gửi..." : "Sending...";
    }

    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-cache',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData) // Chuyển object dữ liệu thành chuỗi JSON
        });

        const result = await response.json();
        
        if (result.result === 'success') {
            console.log("Apps Script Response:", result.message);
            showSuccessDialog(lang); // Chỉ hiển thị thành công khi server xác nhận
        } else {
            console.error("Apps Script Error:", result.message);
            alert(`${errorMsg} Chi tiết: ${result.message}`);
        }

    } catch (error) {
        console.error("Fetch Error:", error);
        alert(`${errorMsg} Vui lòng kiểm tra kết nối mạng hoặc URL Apps Script.`);
    } finally {
        // Đảm bảo nút được bật lại và văn bản được đặt lại sau khi hoàn tất
        if (submitBtn) {
             submitBtn.disabled = false; 
             const page = window.location.pathname.split("/").pop().split(".")[0];
             const defaultText = lang === "vi" ? "Gửi đăng ký" : "Submit";
             // Chỉ thay đổi nếu đây là nút submit form
             if (page && (page === 'doitac' || page === 'khach' || page === 'daily')) {
                submitBtn.textContent = defaultText;
             }
        }
    }
}


// === Khi tải mỗi trang ===
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  setVietnamTime();
  translateForm(lang);
});

// === Submit form (ĐÃ CẬP NHẬT để gọi hàm gửi dữ liệu) ===
document.addEventListener("submit", (e) => {
    e.preventDefault();
    const lang = getLang();
    const formId = e.target.id;

    if (!formId.startsWith('form-')) return;

    const formData = collectFormData(formId);

    if (formData) {
        console.log(`Dữ liệu form đã thu thập (${formId}):`, formData); 
        // Gọi hàm gửi dữ liệu đến Google Sheet
        sendDataToSheet(formData, lang); 
    } else {
        alert(lang === "vi" ? "Lỗi: Không tìm thấy form ID hợp lệ." : "Error: No valid form ID found.");
    }
});