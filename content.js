(function() {
  // --- 配置 ---
  const DB_NAME = 'PromptKeeperDB';
  const DB_VERSION = 3;
  const STORE_NAME = 'prompts';

  // --- 全局变量 ---
  let sidebarVisible = false;
  let prompts = [];          // 存储所有提示词（已排序）
  let searchTerm = '';

  // --- IndexedDB 操作（与之前相同）---
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        const transaction = event.target.transaction;

        if (oldVersion < 2) {
          if (db.objectStoreNames.contains(STORE_NAME)) {
            const store = transaction.objectStore(STORE_NAME);
            store.openCursor().onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const data = cursor.value;
                if (data.pinned === undefined) {
                  data.pinned = false;
                  cursor.update(data);
                }
                cursor.continue();
              }
            };
          }
        }

        if (oldVersion < 3) {
          if (db.objectStoreNames.contains(STORE_NAME)) {
            const store = transaction.objectStore(STORE_NAME);
            const pinnedRecords = [];
            const unpinnedRecords = [];
            store.openCursor().onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const data = cursor.value;
                if (data.pinned) {
                  pinnedRecords.push(data);
                } else {
                  unpinnedRecords.push(data);
                }
                cursor.continue();
              } else {
                const sortByTime = (a, b) => {
                  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : a.id;
                  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : b.id;
                  return timeB - timeA;
                };
                pinnedRecords.sort(sortByTime);
                unpinnedRecords.sort(sortByTime);
                pinnedRecords.forEach((record, idx) => {
                  record.order = idx;
                  store.put(record);
                });
                unpinnedRecords.forEach((record, idx) => {
                  record.order = idx;
                  store.put(record);
                });
              }
            };
          }
        }

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('title', 'title', { unique: false });
          store.createIndex('content', 'content', { unique: false });
          store.createIndex('pinned', 'pinned', { unique: false });
          store.createIndex('order', 'order', { unique: false });
        }
      };
    });
  }

  async function getAllPrompts() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const list = request.result;
        // 排序：先置顶，再按 order 升序
        list.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return (a.order || 0) - (b.order || 0);
        });
        resolve(list);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getMaxOrder(pinned) {
    const all = await getAllPrompts();
    const filtered = all.filter(p => p.pinned === pinned);
    return filtered.reduce((max, p) => Math.max(max, p.order || 0), -1);
  }

  async function addPrompt(prompt) {
    const db = await openDB();
    const maxOrder = await getMaxOrder(false);
    const newPrompt = {
      ...prompt,
      pinned: false,
      order: maxOrder + 1,
      createdAt: new Date().toISOString()
    };
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.add(newPrompt);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function updatePrompt(id, updated) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => {
        const data = request.result;
        if (data) {
          const newData = { ...data, ...updated };
          const putRequest = store.put(newData);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          reject(new Error('Prompt not found'));
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function deletePrompt(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function batchUpdateOrders(updates) {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    for (const { id, pinned, order } of updates) {
      const data = await new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (data) {
        data.pinned = pinned;
        data.order = order;
        store.put(data);
      }
    }
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // --- 仅刷新数据（不渲染UI）---
  async function refreshPromptsData() {
    prompts = await getAllPrompts();
  }

  // --- 输入框查找与操作 ---
  function getCurrentInput() {
    const selectors = [
      'textarea[placeholder*="给 DeepSeek 发送消息"]',
      'textarea.ds-scroll-area',
      'textarea[placeholder*="发送消息"]',
      'textarea[placeholder*="给DeepSeek"]',
      'textarea[placeholder*="message"]',
      'div[contenteditable="true"][role="textbox"]',
      '#chat-input',
      '.chat-input',
      'textarea.w-full'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (ta.offsetWidth > 0 && ta.offsetHeight > 0 && !ta.disabled) {
        return ta;
      }
    }
    return null;
  }

  function quickInsertPrompt(content) {
    const input = getCurrentInput();
    if (!input) {
      showToast('❌ 未找到输入框', 2000);
      return;
    }
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = content;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (input.isContentEditable) {
      input.innerHTML = content.replace(/\n/g, '<br>');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    showToast('✅ 提示词已插入', 1000);
  }

  function insertPromptWithConfirm(content) {
    const input = getCurrentInput();
    if (!input) {
      if (confirm('未找到输入框，是否手动选择输入框？')) {
        startManualSelect();
      }
      return;
    }
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      if (confirm('替换当前输入框内容？点“确定”替换，“取消”则追加到末尾')) {
        input.value = content;
      } else {
        input.value += '\n' + content;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (input.isContentEditable) {
      if (confirm('替换当前内容？点“确定”替换，“取消”则追加')) {
        input.innerHTML = content.replace(/\n/g, '<br>');
      } else {
        input.innerHTML += '<br>' + content.replace(/\n/g, '<br>');
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    hideSidebar();
  }

  // --- 快捷键处理 ---
  async function insertPromptByIndex(index) {
    // 如果数据不足，先刷新数据（不渲染）
    if (prompts.length <= index) {
      await refreshPromptsData();
    }
    if (prompts.length > index) {
      const prompt = prompts[index];
      quickInsertPrompt(prompt.content);
    } else {
      showToast(`⚠️ 提示词库只有 ${prompts.length} 条`, 2000);
    }
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const key = e.key;
        if (key >= '1' && key <= '9') {
          e.preventDefault();
          e.stopPropagation();
          const index = parseInt(key) - 1;
          await insertPromptByIndex(index);
        } else if (key === '0') {
          e.preventDefault();
          e.stopPropagation();
          await insertPromptByIndex(9);
        }
      }
    });
  }

  // --- Toast 提示 ---
  function showToast(message, duration = 1500) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = 'rgba(0,0,0,0.8)';
    toast.style.color = 'white';
    toast.style.padding = '8px 16px';
    toast.style.borderRadius = '20px';
    toast.style.fontSize = '14px';
    toast.style.zIndex = '10010';
    toast.style.pointerEvents = 'none';
    toast.style.transition = 'opacity 0.3s';
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- 原生拖拽相关变量 ---
  let dragSrcItem = null;

  // --- UI 创建（侧边栏）---
  function createSidebar() {
    const container = document.createElement('div');
    container.id = 'prompt-keeper-container';
    container.innerHTML = `
      <style>
        /* 样式与之前完全相同，此处省略以节省篇幅，实际使用时请保留完整样式 */
        #prompt-keeper-container * { box-sizing: border-box; font-family: system-ui, sans-serif; }
        #prompt-keeper-toggle { position: fixed; top: 100px; right: 0; width: 40px; height: 40px; background: #4f46e5; color: white; border: none; border-radius: 20px 0 0 20px; cursor: pointer; box-shadow: -2px 2px 8px rgba(0,0,0,0.2); z-index: 10000; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: right 0.3s; }
        #prompt-keeper-sidebar { position: fixed; top: 0; right: -350px; width: 350px; height: 100vh; background: white; box-shadow: -2px 0 12px rgba(0,0,0,0.15); z-index: 10001; transition: right 0.3s; display: flex; flex-direction: column; border-left: 1px solid #e5e7eb; }
        #prompt-keeper-sidebar.visible { right: 0; }
        #prompt-keeper-header { padding: 16px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; background: #f9fafb; }
        #prompt-keeper-header h3 { margin: 0; font-size: 16px; font-weight: 600; color: #111827; }
        #prompt-keeper-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280; }
        #prompt-keeper-search { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
        #prompt-keeper-search input { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
        #prompt-keeper-actions { padding: 12px 16px; display: flex; gap: 8px; border-bottom: 1px solid #e5e7eb; }
        .prompt-keeper-btn { padding: 6px 12px; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; gap: 4px; }
        .prompt-keeper-btn-primary { background: #4f46e5; color: white; border-color: #4f46e5; }
        #prompt-keeper-list { flex: 1; overflow-y: auto; padding: 8px; }
        .sortable-group { margin-bottom: 16px; }
        .group-header { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px 4px; }
        .prompt-item { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 8px; transition: background 0.2s; user-select: none; }
        .prompt-item.dragging { opacity: 0.5; background: #e5e7eb; }
        .prompt-item:hover { background: #f3f4f6; }
        .prompt-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .prompt-item-title-area { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
        .drag-handle { color: #9ca3af; font-size: 18px; line-height: 1; cursor: grab; user-select: none; margin-right: 4px; }
        .drag-handle:active { cursor: grabbing; }
        .pin-btn { background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; color: #9ca3af; transition: color 0.2s; }
        .pin-btn.pinned { color: #fbbf24; }
        .pin-btn:hover { color: #f59e0b; }
        .prompt-item-title { font-weight: 600; font-size: 14px; color: #111827; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .prompt-item-actions { display: flex; gap: 4px; }
        .prompt-item-actions button { background: none; border: none; cursor: pointer; color: #6b7280; font-size: 14px; padding: 2px 4px; }
        .prompt-item-actions button:hover { color: #4f46e5; }
        .prompt-item-preview { font-size: 13px; color: #4b5563; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        #prompt-keeper-footer { padding: 12px 16px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; font-size: 12px; color: #6b7280; }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 10002; display: flex; align-items: center; justify-content: center; }
        .modal-content { background: white; border-radius: 12px; width: 400px; max-width: 90%; padding: 20px; }
        .modal-content h4 { margin-top: 0; margin-bottom: 16px; }
        .modal-content input, .modal-content textarea { width: 100%; padding: 8px 12px; margin-bottom: 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
        .modal-content textarea { min-height: 100px; resize: vertical; }
        .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
        .warning-message { background: #fff3cd; color: #856404; padding: 8px 12px; margin: 8px 16px; border-radius: 4px; font-size: 13px; border: 1px solid #ffeeba; }
      </style>
      <button id="prompt-keeper-toggle" title="打开提示词库 (Alt+1~0 快速插入)">📋</button>
      <div id="prompt-keeper-sidebar">
        <div id="prompt-keeper-header">
          <h3>📚 提示词库</h3>
          <button id="prompt-keeper-close">&times;</button>
        </div>
        <div id="prompt-keeper-search">
          <input type="text" id="search-input" placeholder="搜索提示词...">
        </div>
        <div id="prompt-keeper-actions">
          <button class="prompt-keeper-btn prompt-keeper-btn-primary" id="add-prompt">+ 新增</button>
          <button class="prompt-keeper-btn" id="import-prompt">📥 导入</button>
          <button class="prompt-keeper-btn" id="export-prompt">📤 导出</button>
        </div>
        <div id="prompt-keeper-list">
          <div class="sortable-group" id="pinned-group">
            <div class="group-header">📌 置顶</div>
            <div id="pinned-container"></div>
          </div>
          <div class="sortable-group" id="unpinned-group">
            <div class="group-header">📋 普通</div>
            <div id="unpinned-container"></div>
          </div>
        </div>
        <div id="prompt-keeper-footer">
          <span>✨ 本地存储，隐私安全</span>
          <span id="prompt-count">0 条</span>
        </div>
        <div id="input-warning" class="warning-message" style="display: none;">
          ⚠️ 未检测到输入框，请检查页面或<a href="#" id="manual-select">手动选择</a>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const toggleBtn = document.getElementById('prompt-keeper-toggle');
    const sidebar = document.getElementById('prompt-keeper-sidebar');
    const closeBtn = document.getElementById('prompt-keeper-close');
    const searchInput = document.getElementById('search-input');
    const addBtn = document.getElementById('add-prompt');
    const importBtn = document.getElementById('import-prompt');
    const exportBtn = document.getElementById('export-prompt');
    const pinnedContainer = document.getElementById('pinned-container');
    const unpinnedContainer = document.getElementById('unpinned-container');
    const countEl = document.getElementById('prompt-count');
    const warningDiv = document.getElementById('input-warning');
    const manualSelectLink = document.getElementById('manual-select');

    toggleBtn.addEventListener('click', toggleSidebar);
    closeBtn.addEventListener('click', hideSidebar);
    searchInput.addEventListener('input', (e) => {
      searchTerm = e.target.value.toLowerCase();
      renderList();
    });
    addBtn.addEventListener('click', showAddModal);
    importBtn.addEventListener('click', importPrompts);
    exportBtn.addEventListener('click', exportPrompts);
    manualSelectLink.addEventListener('click', (e) => {
      e.preventDefault();
      startManualSelect();
    });

    // --- 拖拽事件处理 ---
    function handleDragStart(e) {
      dragSrcItem = this;
      e.dataTransfer.setData('text/plain', this.dataset.id);
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }

    function handleDragEnd(e) {
      this.classList.remove('dragging');
      dragSrcItem = null;
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }

    async function handleDrop(e) {
      e.preventDefault();
      const targetItem = this;
      if (!dragSrcItem || targetItem === dragSrcItem) return;

      // 检查是否在同一组内
      const srcContainer = dragSrcItem.parentNode;
      const tgtContainer = targetItem.parentNode;
      if (srcContainer !== tgtContainer) {
        showToast('请使用星标切换组', 2000);
        return;
      }

      const container = srcContainer;
      const items = Array.from(container.children);
      const srcIndex = items.indexOf(dragSrcItem);
      const tgtIndex = items.indexOf(targetItem);

      if (srcIndex < tgtIndex) {
        container.insertBefore(dragSrcItem, targetItem.nextSibling);
      } else {
        container.insertBefore(dragSrcItem, targetItem);
      }

      // 更新数据库中的顺序
      const pinned = container.id === 'pinned-container';
      const newItems = Array.from(container.children);
      const updates = newItems.map((el, idx) => ({
        id: parseInt(el.dataset.id),
        pinned: pinned,
        order: idx
      }));
      await batchUpdateOrders(updates);
      await refreshPromptsData(); // 仅刷新数据，不渲染
      renderList();               // 重新渲染以保持UI一致
    }

    // --- 核心函数 ---
    function toggleSidebar() {
      sidebarVisible = !sidebarVisible;
      if (sidebarVisible) {
        sidebar.classList.add('visible');
        // 打开侧边栏时，确保数据最新并渲染
        (async () => {
          await refreshPromptsData();
          renderList();
        })();
        checkInputExistence();
      } else {
        sidebar.classList.remove('visible');
      }
    }

    function hideSidebar() {
      sidebarVisible = false;
      sidebar.classList.remove('visible');
    }

    function renderList() {
      // 根据当前搜索词过滤
      const filtered = prompts.filter(p => 
        p.title.toLowerCase().includes(searchTerm) || 
        p.content.toLowerCase().includes(searchTerm)
      );
      const pinnedItems = filtered.filter(p => p.pinned);
      const unpinnedItems = filtered.filter(p => !p.pinned);

      pinnedContainer.innerHTML = '';
      unpinnedContainer.innerHTML = '';

      pinnedItems.forEach(p => {
        pinnedContainer.appendChild(createPromptElement(p));
      });
      unpinnedItems.forEach(p => {
        unpinnedContainer.appendChild(createPromptElement(p));
      });

      countEl.textContent = `${prompts.length} 条`;
    }

    function createPromptElement(p) {
      const item = document.createElement('div');
      item.className = 'prompt-item';
      item.setAttribute('data-id', p.id);
      item.setAttribute('draggable', 'true');
      item.innerHTML = `
        <div class="prompt-item-header">
          <div class="prompt-item-title-area">
            <span class="drag-handle" style="cursor: grab; user-select: none;">⋮⋮</span>
            <button class="pin-btn ${p.pinned ? 'pinned' : ''}" data-id="${p.id}" title="${p.pinned ? '取消置顶' : '置顶'}">${p.pinned ? '★' : '☆'}</button>
            <span class="prompt-item-title">${escapeHtml(p.title)}</span>
          </div>
          <div class="prompt-item-actions">
            <button class="edit-btn" data-id="${p.id}" title="编辑">✏️</button>
            <button class="delete-btn" data-id="${p.id}" title="删除">🗑️</button>
          </div>
        </div>
        <div class="prompt-item-preview">${escapeHtml(p.content)}</div>
      `;

      // 拖拽事件
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragend', handleDragEnd);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('drop', handleDrop);

      // 点击插入（排除按钮和拖拽手柄）
      item.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('.drag-handle')) return;
        insertPromptWithConfirm(p.content);
      });

      // 置顶按钮
      item.querySelector('.pin-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const newPinned = !p.pinned;
        const all = await getAllPrompts();
        const targetGroup = all.filter(x => x.pinned === newPinned);
        const maxOrder = targetGroup.reduce((max, x) => Math.max(max, x.order || 0), -1);
        await updatePrompt(p.id, { pinned: newPinned, order: maxOrder + 1 });
        await refreshPromptsData();
        renderList();
      });

      // 编辑按钮
      item.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showEditModal(p);
      });

      // 删除按钮
      item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDelete(p.id);
      });

      return item;
    }

    function escapeHtml(unsafe) {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function checkInputExistence() {
      const input = getCurrentInput();
      warningDiv.style.display = input ? 'none' : 'block';
    }

    function startManualSelect() {
      alert('请点击页面上的输入框以选择它。');
      const clickHandler = (e) => {
        const target = e.target;
        if (target.tagName === 'TEXTAREA' || target.isContentEditable) {
          const selector = target.tagName.toLowerCase() + 
            (target.id ? '#' + target.id : '') + 
            (target.classList.length ? '.' + Array.from(target.classList).join('.') : '');
          localStorage.setItem('customInputSelector', selector);
          alert('已选择输入框，现在可以使用插入功能。');
          document.removeEventListener('click', clickHandler, true);
        }
      };
      document.addEventListener('click', clickHandler, true);
    }

    function showAddModal() {
      const input = getCurrentInput();
      const defaultContent = input ? (input.value || input.innerText || '') : '';
      showPromptModal(null, defaultContent);
    }

    function showEditModal(prompt) {
      showPromptModal(prompt);
    }

    function showPromptModal(existingPrompt, defaultContent = '') {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-content">
          <h4>${existingPrompt ? '编辑提示词' : '新增提示词'}</h4>
          <input type="text" id="modal-title" placeholder="标题" value="${existingPrompt ? escapeHtml(existingPrompt.title) : ''}">
          <textarea id="modal-content" placeholder="提示词内容">${existingPrompt ? escapeHtml(existingPrompt.content) : escapeHtml(defaultContent)}</textarea>
          <div class="modal-actions">
            <button class="prompt-keeper-btn" id="modal-cancel">取消</button>
            <button class="prompt-keeper-btn prompt-keeper-btn-primary" id="modal-save">保存</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const titleInput = document.getElementById('modal-title');
      const contentInput = document.getElementById('modal-content');
      const cancelBtn = document.getElementById('modal-cancel');
      const saveBtn = document.getElementById('modal-save');

      cancelBtn.addEventListener('click', () => overlay.remove());
      saveBtn.addEventListener('click', async () => {
        const title = titleInput.value.trim();
        const content = contentInput.value.trim();
        if (!title || !content) {
          alert('标题和内容不能为空');
          return;
        }
        if (existingPrompt) {
          await updatePrompt(existingPrompt.id, { title, content });
        } else {
          await addPrompt({ title, content });
        }
        overlay.remove();
        await refreshPromptsData();
        renderList();
      });
    }

    function confirmDelete(id) {
      if (confirm('确定删除该提示词吗？')) {
        deletePrompt(id).then(async () => {
          await refreshPromptsData();
          renderList();
        });
      }
    }

    async function exportPrompts() {
      const all = await getAllPrompts();
      const dataStr = JSON.stringify(all, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `deepseek-prompts-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function importPrompts() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (!Array.isArray(imported)) throw new Error('数据格式错误');
            for (const item of imported) {
              if (item.title && item.content) {
                if (item.order === undefined) {
                  const maxOrder = await getMaxOrder(item.pinned || false);
                  item.order = maxOrder + 1;
                }
                await addPrompt({
                  title: item.title,
                  content: item.content,
                  pinned: item.pinned || false,
                  order: item.order,
                  createdAt: item.createdAt || new Date().toISOString()
                });
              }
            }
            await refreshPromptsData();
            renderList();
            alert('导入成功');
          } catch (err) {
            alert('导入失败：' + err.message);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }

    // 快捷键设置在创建侧边栏时注册（只注册一次）
    setupKeyboardShortcuts();
  }

  // --- 启动顺序：先预加载数据，再创建侧边栏 ---
  (async function init() {
    await refreshPromptsData(); // 预加载数据，使快捷键立即可用
    createSidebar();
  })();
})();