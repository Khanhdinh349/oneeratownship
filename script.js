document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('registerForm');
    const successMessage = document.getElementById('successMessage');
    // KHẮC PHỤC LỖI: Thêm lại biến errorMessage để tránh lỗi "Cannot read properties of null"
    const errorMessage = document.getElementById('errorMessage'); 

    // !!! BƯỚC QUAN TRỌNG: Vui lòng thay thế chuỗi dưới đây bằng URL Web App thực tế của bạn
    // URL Web App KHÔNG được chứa "YOUR_APPS_SCRIPT_WEB_APP_U..." hay "RL"
    // URL phải có dạng: https://script.google.com/macros/s/xxxxxxxxxx/exec
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyuDDY28hFBK6cBcnMnsAEhLTyn6-FrWkXoFf9dqnbM5ea7-xIaxY1E1m4CDQ3967hw/exec'; // Vui lòng cập nhật URL thực tế

    const hideMessages = () => {
        if (successMessage) successMessage.classList.add('hidden');
        if (errorMessage) errorMessage.classList.add('hidden');
    };

    form.addEventListener('submit', async function(event) {
        event.preventDefault(); 
        hideMessages();

        // Kiểm tra LỖI CẤU HÌNH: Nếu người dùng chưa thay URL thực tế
        if (APPS_SCRIPT_URL.includes('YOUR_APPS_SCRIPT_WEB_APP_U') || !APPS_SCRIPT_URL.startsWith('https://')) {
             console.error("Lỗi cấu hình: Vui lòng thay thế URL Apps Script Web App đã triển khai.");
             errorMessage.textContent = "❌ Lỗi cấu hình Apps Script. Vui lòng cập nhật URL Web App.";
             errorMessage.classList.remove('hidden');
             return;
        }

        // Tạo đối tượng dữ liệu với tên thuộc tính KHỚP HOÀN TOÀN với Headers trong Apps Script
        const formData = {
            // Thông tin chung
            timestamp: new Date().toLocaleString('vi-VN'),

            // Thông tin Môi giới (Agent) - Đã cập nhật ID trong HTML để khớp với tên thuộc tính này
            agency: document.getElementById('agency').value,
            agentName: document.getElementById('agentName').value,
            agentCCCD: document.getElementById('agentCCCD').value,
            agentPhone: document.getElementById('agentPhone').value,
            agentEmail: document.getElementById('agentEmail').value,

            // Thông tin Khách hàng (Customer)
            cusName: document.getElementById('cusName').value,
            cusPhone: document.getElementById('cusPhone').value,
            cusMail: document.getElementById('cusMail').value,
            visitDate: document.getElementById('visitDate').value,
            visitTime: document.getElementById('visitTime').value,
            apartmentType: document.getElementById('apartmentType').value,
            note: document.getElementById('note').value,
        };
        
        try {
            // Gửi dữ liệu dưới dạng JSON (dùng POST request)
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                // Bắt buộc phải có để tránh lỗi CORS khi gọi từ ngoài Google
                mode: 'no-cors', 
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData),
            });

            // Nếu request gửi đi không bị chặn, ta giả định Apps Script đã nhận.
            console.log("Dữ liệu đã được gửi. Kiểm tra Google Sheet để xác nhận dữ liệu đã được ghi.");
            
            // Xử lý thành công
            successMessage.classList.remove('hidden');
            form.reset(); 
            setTimeout(hideMessages, 5000);

        } catch (error) {
            console.error("Lỗi khi gửi dữ liệu:", error);
            // Hiển thị lỗi trên UI thay vì dùng alert()
            errorMessage.textContent = `❌ Lỗi kết nối mạng: Không thể gửi đăng ký. Chi tiết: ${error.message}`;
            errorMessage.classList.remove('hidden');
            setTimeout(hideMessages, 7000);
        }
    });
});