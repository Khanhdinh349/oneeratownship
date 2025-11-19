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
  const vietnamOffset = 7 * 60; // UTC+7
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

// ---

//  Logic Modal Thông Báo Thành Công

// Biến toàn cục để lưu trữ bộ đếm thời gian
let countdownTimer;

/**
 * Hàm quản lý việc chuyển hướng về trang chủ
 * @param {string} lang Ngôn ngữ hiện tại
 * @param {HTMLElement} confirmBtn Nút Xác nhận
 */
function setupRedirect(lang, confirmBtn) {
    const redirectToIndex = () => {
        // Đảm bảo xóa bỏ bộ đếm và sự kiện click trước khi chuyển hướng
        if (countdownTimer) {
            clearInterval(countdownTimer);
        }
        confirmBtn.removeEventListener('click', redirectToIndex);
        window.location.href = `index.html?lang=${lang}`;
    };
    
    // Thiết lập sự kiện cho nút Xác nhận
    confirmBtn.onclick = redirectToIndex;
    return redirectToIndex;
}

/**
 * Hiển thị hộp thoại thông báo tùy chỉnh khi đăng ký thành công.
 * @param {string} lang Ngôn ngữ hiện tại ('vi' hoặc 'en').
 */
function showSuccessDialog(lang) {
  const modal = document.getElementById("success-modal");
  const title = document.getElementById("modal-title");
  const message = document.getElementById("modal-message");
  const confirmBtn = document.getElementById("confirm-btn");
  
  if (!modal || !confirmBtn) {
      // Fallback nếu không tìm thấy Modal HTML
      alert(lang === "vi" ? "Đăng ký thành công! (Không tìm thấy hộp thoại tùy chỉnh)" : "Registration Successful! (Custom dialog not found)");
      return;
  }

  let countdown = 4;
  
  // Dịch nội dung (ĐÃ CẬP NHẬT TIẾNG VIỆT & TIẾNG ANH VỚI <br/>)
  if (lang === "vi") {
    title.textContent = "✅ Đăng ký thành công!";
    message.innerHTML = `Chào Mừng Đến Với One Era.`;
    confirmBtn.textContent = "Xác nhận";
  } else {
    title.textContent = "✅ Successful Registration!";
    message.innerHTML = `Welcome to One Era.`;
    confirmBtn.textContent = "Confirm";
  }
  
  // === GỌI HIỆU ỨNG PHÁO HOA ===
  if (typeof confetti === 'function') {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  } 
  // ============================

  // Hiển thị hộp thoại
  modal.classList.add('show');
  
  // Khởi tạo logic chuyển hướng và gán sự kiện cho nút Xác nhận
  const redirectToIndex = setupRedirect(lang, confirmBtn);

            // Nếu request gửi đi không bị chặn, giả định Apps Script đã nhận.
            console.log("Dữ liệu đã được gửi. Kiểm tra Google Sheet để xác nhận dữ liệu đã được ghi.");
            
            // Xử lý thành công
            successMessage.classList.remove('hidden');
            form.reset(); 
            setTimeout(hideMessages, 5000);

// ---

// ## Thu thập & Xử lý Dữ liệu (XỬ LÝ CỤC BỘ)

// === Thu thập dữ liệu form (Sử dụng thuộc tính NAME) ===
function collectFormData(formId) {
    const data = {
        timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
    };

    // Ánh xạ các trường dữ liệu theo form ID
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


// === Khi tải mỗi trang ===
window.addEventListener("DOMContentLoaded", () => {
  const lang = getLang();
  setVietnamTime();
  translateForm(lang);
});

// === Submit form (Xử lý dữ liệu cục bộ) ===
// Dữ liệu chỉ được thu thập và in ra console.
document.addEventListener("submit", (e) => {
    e.preventDefault();
    const lang = getLang();
    const formId = e.target.id; 

    if (!formId.startsWith('form-')) return;

    const formData = collectFormData(formId);

    if (formData) {
        // Ghi dữ liệu vào Console để kiểm tra
        console.log(`Dữ liệu form đã thu thập (${formId}):`, formData); 
        
        // Gọi hộp thoại tùy chỉnh
        showSuccessDialog(lang);
    } else {
        alert(lang === "vi" ? "Lỗi: Không tìm thấy form ID hợp lệ." : "Error: No valid form ID found.");
    }

});
