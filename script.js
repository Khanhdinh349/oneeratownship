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
    const selectedDate = dateInput.value;
    const lang = getLang();
    
    // Prevent selection of past dates
    if (selectedDate < todayStr) {
      alert(lang === "vi" 
        ? "Không thể chọn ngày trong quá khứ. Vui lòng chọn ngày hôm nay hoặc sau này." 
        : "Cannot select past dates. Please choose today or later.");
      dateInput.value = todayStr;
      return;
    }
    
    // Prevent selection beyond max date
    if (selectedDate > maxStr) {
      alert(lang === "vi" 
        ? "Ngày chọn vượt quá giới hạn. Vui lòng chọn trong 2 ngày tới." 
        : "Selected date exceeds the limit. Please choose within the next 2 days.");
      dateInput.value = todayStr;
      return;
    }
    
    fetchSlotStatus(selectedDate);
  });
  
  fetchSlotStatus(todayStr);
}