// 监听安装事件，初始化默认设置
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.sync.set({
        settings: {
          theme: 'light',
          position: 'right',
          autoInsert: false
        }
      });
    }
  });
});