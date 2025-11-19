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

// === Hiển thị thông báo thành công và chuyển hướng ===
function showSuccessAndRedirect(lang) {
  // Đã sửa thông báo để phản ánh việc xử lý cục bộ
  const successMessage = lang === "vi" ? 
    "✅ Đăng ký thành công! Dữ liệu đã được xử lý cục bộ (kiểm tra console). Bạn sẽ được chuyển hướng." : 
    "✅ Registration successful! Data was processed locally (check console). You will be redirected.";
  
  // Confetti vẫn được giữ lại nếu thư viện confetti có sẵn
  if (typeof confetti === 'function') {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
  } 

  alert(successMessage);
  
  setTimeout(() => {
    window.location.href = `index.html?lang=${lang}`;
  }, 100); 
}

// === Thu thập dữ liệu form (Không thay đổi) ===
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
        
        // Chỉ hiển thị thông báo thành công và chuyển hướng
        showSuccessAndRedirect(lang);
    } else {
        alert(lang === "vi" ? "Lỗi: Không tìm thấy form ID hợp lệ." : "Error: No valid form ID found.");
    }
});