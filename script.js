// ... (Giữ nguyên các hàm getLang, setLang, setVietnamTime, translateForm, showSuccessAndRedirect) ...

// === Hiển thị thông báo thành công và chuyển hướng (Đã chỉnh sửa từ trước) ===
function showSuccessAndRedirect(lang) {
  const successMessage = lang === "vi" ? "✅ Đăng ký thành công! Bạn sẽ được chuyển hướng." : "✅ Registration successful! You will be redirected.";
  
  // Logic Confetti (nếu bạn đã nhúng thư viện)
  if (typeof confetti === 'function') {
    confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
  } 

  // Sử dụng setTimeout để hiển thị thông báo sau đó chuyển hướng
  alert(successMessage);
  setTimeout(() => {
    window.location.href = `index.html?lang=${lang}`;
  }, 100); // Đợi 100ms sau khi đóng alert để chuyển trang
}

// === Thu thập dữ liệu form cụ thể ===
function collectFormData(formId) {
    const data = {
        timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
    };

    // Lấy tất cả các trường input/select/textarea trong form
    const formElements = document.getElementById(formId).elements;
    
    // Tên các thuộc tính trong đối tượng data phải KHỚP với tên cột trong Apps Script
    // Tên thuộc tính sẽ được định nghĩa ở đây và dựa trên layout của form
    const fieldMap = {
        // doitac.html
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
        // khach.html
        "form-khach": [
            { selector: '[data-ph-en="Enter full name"]', name: 'fullName' },
            { selector: '[data-ph-en="Enter ID number"]', name: 'idNumber' },
            { selector: '[data-ph-en="Enter phone number"]', name: 'phoneNumber' },
            { selector: '[data-ph-en="Enter email if available"]', name: 'email' },
            { selector: '#visitDate', name: 'visitDate' },
            { selector: '#visitTime', name: 'visitTime' },
            { selector: 'textarea', name: 'notes' }
        ],
        // daily.html
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
        const element = document.querySelector(`#${formId} ${field.selector}`);
        if (element) {
            data[field.name] = element.value;
        }
    });

    data.formType = formId.replace('form-', ''); // Xác định loại form: doitac, khach, daily
    return data;
}

// Thay thế URL này bằng URL Apps Script đã triển khai của bạn!
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
                'Content-Type': 'text/plain;charset=utf-8' // Quan trọng cho Apps Script
            },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (result.result === "success") {
            showSuccessAndRedirect(lang);
        } else {
            alert(`Lỗi khi ghi dữ liệu: ${result.message}`);
        }
    } catch (error) {
        alert(`Lỗi kết nối máy chủ: ${error.message}`);
    }
}


// === Submit form (Cập nhật logic) ===
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