document.addEventListener('DOMContentLoaded', () => {
  const themeSelect = document.getElementById('theme');
  const positionSelect = document.getElementById('position');
  const autoInsertCheck = document.getElementById('autoInsert');
  const saveBtn = document.getElementById('save');
  const statusDiv = document.getElementById('status');

  // 加载当前设置
  chrome.storage.sync.get('settings', (data) => {
    const settings = data.settings || { theme: 'light', position: 'right', autoInsert: false };
    themeSelect.value = settings.theme;
    positionSelect.value = settings.position;
    autoInsertCheck.checked = settings.autoInsert;
  });

  // 保存设置
  saveBtn.addEventListener('click', () => {
    const settings = {
      theme: themeSelect.value,
      position: positionSelect.value,
      autoInsert: autoInsertCheck.checked
    };
    chrome.storage.sync.set({ settings }, () => {
      statusDiv.textContent = '设置已保存！';
      setTimeout(() => { statusDiv.textContent = ''; }, 2000);
    });
  });
});