// ==========================================
// ⚙️ CẤU HÌNH — chỉ cần chỉnh 1 dòng này
// ==========================================
const SCRIPT_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
const SECRET_TOKEN = 'OE_2026_SECURE';

// ==========================================
// 🌐 NGÔN NGỮ
// ==========================================
const urlParams  = new URLSearchParams(window.location.search);
let currentLang  = urlParams.get('lang') || 'vi';

function applyLanguage() {
  // Labels, button text, titles
  document.querySelectorAll('[data-vi]').forEach(el => {
    const text = el.getAttribute(`data-${currentLang}`);
    if (text) el.innerText = text;
  });
  // Placeholders
  document.querySelectorAll('[data-ph-vi]').forEach(el => {
    const ph = el.getAttribute(`data-ph-${currentLang}`);
    if (ph) el.placeholder = ph;
  });
}

// ==========================================
// 📅 DATEPICKER — đặt min = hôm nay
// ==========================================
function initDatePicker() {
  const dateInput = document.getElementById('visitDate');
  if (!dateInput) return;

  const today = new Date();
  const yyyy  = today.getFullYear();
  const mm    = String(today.getMonth() + 1).padStart(2, '0');
  const dd    = String(today.getDate()).padStart(2, '0');
  dateInput.min = `${yyyy}-${mm}-${dd}`;

  dateInput.addEventListener('change', () => {
    const date = dateInput.value;
    if (date) fetchAndUpdateSlots(date);
  });
}

// ==========================================
// ⏰ TIME SLOT DROPDOWN
// ==========================================
function initTimeDropdown() {
  const timeBox   = document.getElementById('visitTimeBox');
  const timeMenu  = document.getElementById('visitTimeMenu');
  const timeInput = document.getElementById('visitTime');
  const timeText  = document.getElementById('selectedTimeText');

  if (!timeBox || !timeMenu) return;

  // Toggle mở/đóng
  timeBox.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = timeMenu.classList.contains('show');
    timeMenu.classList.toggle('show', !isOpen);
    timeBox.querySelector('.chevron')?.classList.toggle('rotate', !isOpen);
  });

  // Chọn item
  timeMenu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('slot-disabled')) return;

      const val = item.getAttribute('data-value');
      timeInput.value = val;
      // Hiển thị chỉ phần giờ, bỏ "(còn X lượt)"
      timeText.textContent = val.replace('-', ' – ');
      timeMenu.classList.remove('show');
      timeBox.querySelector('.chevron')?.classList.remove('rotate');
    });
  });

  // Đóng khi click ra ngoài
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#visitTimeBox') && !e.target.closest('#visitTimeMenu')) {
      timeMenu.classList.remove('show');
      timeBox.querySelector('.chevron')?.classList.remove('rotate');
    }
  });
}

// ==========================================
// 🔍 LẤY THÔNG TIN SLOT TỪ SERVER
// ==========================================
async function fetchAndUpdateSlots(date) {
  const timeMenu  = document.getElementById('visitTimeMenu');
  const timeInput = document.getElementById('visitTime');
  const timeText  = document.getElementById('selectedTimeText');
  if (!timeMenu) return;

  const items = timeMenu.querySelectorAll('.menu-item');

  // Hiển thị trạng thái đang tải
  items.forEach(item => {
    item.classList.add('slot-disabled');
    const val = item.getAttribute('data-value');
    item.textContent = val.replace('-', ' – ') + ' · đang tải...';
  });

  try {
    const res  = await fetch(`${SCRIPT_URL}?action=getSlots&date=${date}`);
    const data = await res.json();

    if (data.result !== 'success') {
      // Nếu lỗi server, mở lại tất cả
      items.forEach(item => {
        item.classList.remove('slot-disabled');
        const val = item.getAttribute('data-value');
        item.textContent = val.replace('-', ' – ');
      });
      return;
    }

    const { registrations, maxRegistrations } = data;

    items.forEach(item => {
      const val      = item.getAttribute('data-value');
      const regCount = registrations[val] || 0;
      const isFull   = regCount >= maxRegistrations;
      const left     = maxRegistrations - regCount;

      if (isFull) {
        item.textContent = `${val.replace('-', ' – ')} · HẾT SLOT`;
        item.classList.add('slot-disabled');
      } else {
        item.textContent = `${val.replace('-', ' – ')} · còn ${left} lượt`;
        item.classList.remove('slot-disabled');
      }
    });

    // Nếu slot đang chọn đã đầy → reset
    const currentTime = timeInput?.value;
    if (currentTime && (registrations[currentTime] || 0) >= maxRegistrations) {
      timeInput.value   = '';
      timeText.textContent = currentLang === 'vi' ? '-- Chọn khung giờ --' : '-- Select time --';
    }

  } catch (err) {
    console.error('fetchSlots error:', err);
    items.forEach(item => {
      item.classList.remove('slot-disabled');
      const val = item.getAttribute('data-value');
      item.textContent = val.replace('-', ' – ');
    });
  }
}

// ==========================================
// 🚀 XỬ LÝ SUBMIT CHUNG
// ==========================================
async function submitForm(form, formType) {
  const btn          = form.querySelector('.btnSubmit');
  const originalText = btn.textContent;

  // Validate khung giờ
  const timeInput = document.getElementById('visitTime');
  if (!timeInput || !timeInput.value) {
    showAlert('⚠️ Vui lòng chọn khung giờ!');
    return;
  }

  // Validate ngày
  const dateInput = document.getElementById('visitDate');
  if (!dateInput || !dateInput.value) {
    showAlert('⚠️ Vui lòng chọn ngày tham quan!');
    return;
  }

  // Validate đại lý (chỉ cho form daily)
  if (formType === 'daily') {
    const agencyVal = document.getElementById('agencyValue')?.value;
    if (!agencyVal) {
      showAlert('⚠️ Vui lòng chọn đơn vị đại lý!');
      return;
    }
  }

  // Đặt trạng thái loading
  btn.disabled    = true;
  btn.textContent = '⏳ Đang xử lý...';

  // Thu thập dữ liệu form
  const formData = new FormData(form);
  const payload  = { token: SECRET_TOKEN, formType };

  for (const [key, value] of formData.entries()) {
    if (key !== 'customAgencyName') {
      payload[key] = value.trim();
    }
  }

  // Xử lý tên đại lý custom (form daily)
  if (formType === 'daily') {
    const agencyValue = document.getElementById('agencyValue')?.value || '';
    const customInput = document.getElementById('customAgencyInput');
    if (agencyValue.includes('KHÁC') && customInput?.value.trim()) {
      payload.agencyName = customInput.value.trim();
    } else {
      payload.agencyName = agencyValue;
    }
  }

  try {
    const res    = await fetch(SCRIPT_URL, {
      method:  'POST',
      body:    JSON.stringify(payload),
    });
    const result = await res.json();

    switch (result.result) {
      case 'success':
        showSuccessModal(payload.fullName || payload.staffName || payload.fullName || '');
        break;

      case 'full':
        showAlert(`⛔ ${result.message}\n\nVui lòng chọn khung giờ hoặc ngày khác.`);
        // Refresh slots để cập nhật UI
        if (dateInput?.value) fetchAndUpdateSlots(dateInput.value);
        break;

      case 'error':
      default:
        showAlert(`❌ Đã xảy ra lỗi:\n${result.message || 'Vui lòng thử lại.'}`);
        break;
    }

  } catch (err) {
    console.error('Submit error:', err);
    showAlert('❌ Lỗi kết nối. Vui lòng kiểm tra mạng và thử lại!');
  } finally {
    btn.disabled    = false;
    btn.textContent = originalText;
  }
}

// ==========================================
// ✅ SUCCESS MODAL + CONFETTI
// ==========================================
function showSuccessModal(name) {
  const modal      = document.getElementById('success-modal');
  const countdown  = document.getElementById('countdown');
  if (!modal) return;

  modal.style.display = 'flex';

  // Confetti
  if (typeof confetti !== 'undefined') {
    confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
    setTimeout(() => confetti({ particleCount: 80, spread: 50, origin: { y: 0.5, x: 0.2 } }), 400);
    setTimeout(() => confetti({ particleCount: 80, spread: 50, origin: { y: 0.5, x: 0.8 } }), 700);
  }

  let count = 4;
  const timer = setInterval(() => {
    count--;
    if (countdown) countdown.textContent = count;
    if (count <= 0) {
      clearInterval(timer);
      window.location.href = 'index.html';
    }
  }, 1000);

  const confirmBtn = document.getElementById('confirm-btn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      clearInterval(timer);
      window.location.href = 'index.html';
    };
  }
}

// ==========================================
// ⚠️ ALERT (dùng thay window.alert gốc)
// ==========================================
function showAlert(msg) {
  alert(msg); // Có thể thay bằng custom modal sau
}

// ==========================================
// 📝 FORM: KHÁCH (khach.html)
// ==========================================
function initKhachForm() {
  const form = document.getElementById('form-khach');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitForm(form, 'khach');
  });
}

// ==========================================
// 🏢 FORM: ĐẠI LÝ (daily.html)
// ==========================================
function initDailyForm() {
  const form = document.getElementById('form-daily');
  if (!form) return;

  // Dropdown đại lý
  initAgencyDropdown();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitForm(form, 'daily');
  });
}

function initAgencyDropdown() {
  const agencies = [
    "THE ONE REAL ESTATE",
    "REVER",
    "REALPLUS",
    "QS LAND",
    "INDOCHINE",
    "ERA VIỆT NAM",
    "STHOME & LỘC PHÁT HƯNG",
    "BÁCH NHƯ",
    "DOUBLE LAND",
    "GENIE PROPERTY & LINH HOMES",
    "KZEN HOLDINGS",
    "THẾ GIỚI ĐẤT VIỆT",
    "SGROUP & BAM LAND",
    "KIM OANH REALTY",
    "KHÁC",
  ];

  const header         = document.getElementById('agencyHeader');
  const dropdown       = document.getElementById('agencyDropdown');
  const listContainer  = document.getElementById('agencyList');
  const selectedText   = document.getElementById('selectedAgencyText');
  const agencyValue    = document.getElementById('agencyValue');
  const extraContainer = document.getElementById('extraInputContainer');

  if (!header || !listContainer) return;

  // Xóa các item cũ nếu có (tránh duplicate)
  listContainer.innerHTML = '';

  agencies.forEach(agency => {
    const item       = document.createElement('div');
    item.className   = 'dropdownItem';
    item.innerText   = agency;
    item.addEventListener('click', () => {
      selectedText.innerText       = agency;
      selectedText.style.color     = '#ffffff';
      agencyValue.value            = agency;
      dropdown.style.display       = 'none';
      extraContainer.style.display = agency.includes('KHÁC') ? 'block' : 'none';
    });
    listContainer.appendChild(item);
  });

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });

  window.addEventListener('click', () => {
    dropdown.style.display = 'none';
  });
}

// ==========================================
// 🤝 FORM: ĐỐI TÁC (doitac.html)
// ==========================================
function initDoitacForm() {
  const form = document.getElementById('form-doitac');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitForm(form, 'doitac');
  });
}

// ==========================================
// 🚀 KHỞI ĐỘNG
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  applyLanguage();
  initDatePicker();
  initTimeDropdown();
  initKhachForm();
  initDailyForm();
  initDoitacForm();
});
