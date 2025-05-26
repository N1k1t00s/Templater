let currentTemplate = null;
let hasUnsavedChanges = false;
let uiState = {
  selectedFolder: null,
  selectedTemplate: null
};

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  setupEventListeners();
});

// Загрузка сохраненного состояния
async function loadState() {
  const { templates = { folders: [] }, uiState: savedState } = 
    await chrome.storage.local.get(['templates', 'uiState']);
  
  uiState = savedState || { 
    selectedFolder: null, 
    selectedTemplate: null 
  };

  renderFolders(templates.folders);

  // Восстановление выбранной папки
  if (uiState.selectedFolder) {
    document.getElementById('folderSelect').value = uiState.selectedFolder;
    await loadTemplates();
  }

  // Восстановление выбранного шаблона
  if (uiState.selectedTemplate) {
    document.getElementById('templateSelect').value = uiState.selectedTemplate;
    await loadTemplateContent();
  }
}

// Сохранение текущего состояния
async function saveState() {
  await chrome.storage.local.set({ uiState });
}

// Настройка обработчиков событий
function setupEventListeners() {
  document.getElementById('newFolder').addEventListener('click', createFolder);
  document.getElementById('deleteFolder').addEventListener('click', deleteFolder);
  document.getElementById('saveTemplate').addEventListener('click', saveTemplate);
  document.getElementById('deleteTemplate').addEventListener('click', deleteTemplate);
  document.getElementById('autoBuild').addEventListener('click', autoBuild);
  document.getElementById('addSelector').addEventListener('click', addSelectorField);
   document.getElementById('newTemplate').addEventListener('click', createTemplate);
  
  document.getElementById('folderSelect').addEventListener('change', async () => {
    uiState.selectedFolder = document.getElementById('folderSelect').value;
    uiState.selectedTemplate = null;
    await saveState();
    loadTemplates();
  });

  document.getElementById('templateSelect').addEventListener('change', async () => {
    uiState.selectedTemplate = document.getElementById('templateSelect').value;
    await saveState();
    loadTemplateContent();
  });

  document.getElementById('templateName').addEventListener('input', () => {
    hasUnsavedChanges = true;
  });

  document.getElementById('templateContent').addEventListener('input', () => {
    hasUnsavedChanges = true;
  });
}

// Загрузка шаблонов для выбранной папки
async function loadTemplates() {
  const folderName = uiState.selectedFolder;
  if (!folderName) return;

  const { templates } = await chrome.storage.local.get('templates');
  const folder = templates.folders.find(f => f.name === folderName);
  
  renderTemplates(folder?.templates || []);
  clearEditor();
  hasUnsavedChanges = false;
}

// Загрузка содержимого шаблона
async function loadTemplateContent() {
  const templateName = uiState.selectedTemplate;
  if (!templateName) return;

  const { templates } = await chrome.storage.local.get('templates');
  const folder = templates.folders.find(f => f.name === uiState.selectedFolder);
  const template = folder?.templates.find(t => t.name === templateName);
  
  if (template) {
    currentTemplate = templateName;
    document.getElementById('templateName').value = templateName;
    document.getElementById('templateContent').value = template.content;
    document.getElementById('selectorList').innerHTML = '';
    Object.entries(template.selectors).forEach(([key, value]) => {
      addSelectorField(key, value);
    });
    hasUnsavedChanges = false;
  }
}

// Создание новой папки
async function createFolder() {
  const folderName = prompt('Введите название папки:');
  if (!folderName) return;

  const { templates = { folders: [] } } = await chrome.storage.local.get('templates');
  templates.folders.push({ 
    name: folderName, 
    templates: [] 
  });
  
  await chrome.storage.local.set({ templates });
  renderFolders(templates.folders);
  showNotification('Папка создана!');
}

// Удаление папки
async function deleteFolder() {
  const folderName = uiState.selectedFolder;
  if (!folderName || !confirm(`Удалить папку "${folderName}"?`)) return;

  const { templates } = await chrome.storage.local.get('templates');
  templates.folders = templates.folders.filter(f => f.name !== folderName);
  
  await chrome.storage.local.set({ templates });
  uiState.selectedFolder = null;
  uiState.selectedTemplate = null;
  await saveState();
  renderFolders(templates.folders);
  clearEditor();
  showNotification('Папка удалена!');
}

// Сохранение шаблона
async function saveTemplate() {
  const folderName = uiState.selectedFolder;
  const templateName = document.getElementById('templateName').value.trim();
  const content = document.getElementById('templateContent').value;
  const selectors = getCurrentSelectors();

  if (!templateName) {
    showNotification('Введите название шаблона!', 'error');
    return;
  }

  const { templates } = await chrome.storage.local.get('templates');
  const folder = templates.folders.find(f => f.name === folderName);
  const previousName = currentTemplate;

  // Обновление или создание шаблона
  if (previousName) {
    const index = folder.templates.findIndex(t => t.name === previousName);
    folder.templates[index] = { name: templateName, content, selectors };
  } else {
    folder.templates.push({ name: templateName, content, selectors });
  }

  await chrome.storage.local.set({ templates });
  currentTemplate = templateName;
  uiState.selectedTemplate = templateName;
  await saveState();
  renderTemplates(folder.templates, templateName);
  hasUnsavedChanges = false;
  showNotification('Шаблон сохранен!');
}

// Автоматическая сборка данных
async function autoBuild() {
  const template = await getCurrentTemplate();
  if (!template) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.startsWith('http')) {
      showNotification('Работает только на веб-страницах!', 'error');
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeData,
      args: [template.selectors],
      world: 'MAIN'
    });

    const data = results[0]?.result || {};
    let content = template.content;
    let foundAny = false;
    
    // Замена плейсхолдеров
    for (const [key, value] of Object.entries(data)) {
      if (value !== 'N/A' && value !== 'Error') {
        content = content.replace(new RegExp(`{{${key}}}`, 'gi'), value);
        foundAny = true;
      }
    }
    
    if (!foundAny) {
      showNotification('Данные не найдены! Проверьте селекторы', 'error');
      return;
    }

    // Копирование в буфер обмена
    await navigator.clipboard.writeText(content);
    showNotification('Данные скопированы!', 'success');

  } catch (error) {
    showNotification(`Ошибка: ${error.message}`, 'error');
  }
}

// Парсинг данных со страницы
function scrapeData(selectors) {
  const result = {};
  for (const [key, selector] of Object.entries(selectors)) {
    try {
      const element = document.querySelector(selector);
      result[key] = element?.textContent?.trim() || 
                   element?.value?.trim() || 
                   element?.getAttribute('content')?.trim() || 
                   'N/A';
    } catch {
      result[key] = 'Error';
    }
  }
  return result;
}

// Добавление поля для селектора
function addSelectorField(key = '', value = '') {
  const div = document.createElement('div');
  div.className = 'selector-item';
  div.innerHTML = `
    <input type="text" class="selector-input var-name" 
      placeholder="Переменная" value="${key}">
    <input type="text" class="selector-input css-selector" 
      placeholder="CSS-селектор" value="${value}">
    <button class="icon-btn danger delete-selector">
      <i class="material-icons">delete</i>
    </button>
  `;
  div.querySelector('.delete-selector').addEventListener('click', () => div.remove());
  document.getElementById('selectorList').appendChild(div);
}

// Получение текущих селекторов
function getCurrentSelectors() {
  const selectors = {};
  document.querySelectorAll('.selector-item').forEach(item => {
    const key = item.querySelector('.var-name').value.trim();
    const value = item.querySelector('.css-selector').value.trim();
    if (key && value) selectors[key] = value;
  });
  return selectors;
}

// ================== УДАЛЕНИЕ ПАПКИ ==================
async function deleteFolder() {
  const folderName = uiState.selectedFolder;
  if (!folderName || !confirm(`Удалить папку "${folderName}" и все её шаблоны?`)) return;

  try {
    const { templates } = await chrome.storage.local.get('templates');
    
    // Удаление папки
    const updatedFolders = templates.folders.filter(f => f.name !== folderName);
    
    // Обновление состояния
    uiState.selectedFolder = updatedFolders.length > 0 ? updatedFolders[0].name : null;
    uiState.selectedTemplate = null;
    
    await chrome.storage.local.set({ 
      templates: { folders: updatedFolders },
      uiState 
    });
    
    // Обновление интерфейса
    renderFolders(updatedFolders);
    clearEditor();
    showNotification('Папка удалена!');
    
  } catch (error) {
    showNotification('Ошибка при удалении папки', 'error');
    console.error(error);
  }
}

// ================== УДАЛЕНИЕ ШАБЛОНА ==================
async function deleteTemplate() {
  const folderName = uiState.selectedFolder;
  const templateName = uiState.selectedTemplate;
  
  if (!folderName || !templateName || !confirm(`Удалить шаблон "${templateName}"?`)) return;

  try {
    const { templates } = await chrome.storage.local.get('templates');
    const folder = templates.folders.find(f => f.name === folderName);
    
    // Удаление шаблона
    const updatedTemplates = folder.templates.filter(t => t.name !== templateName);
    folder.templates = updatedTemplates;
    
    // Обновление состояния
    uiState.selectedTemplate = updatedTemplates.length > 0 ? updatedTemplates[0].name : null;
    
    await chrome.storage.local.set({ 
      templates,
      uiState 
    });
    
    // Обновление интерфейса
    renderTemplates(updatedTemplates);
    if (updatedTemplates.length === 0) clearEditor();
    showNotification('Шаблон удален!');
    
  } catch (error) {
    showNotification('Ошибка при удалении шаблона', 'error');
    console.error(error);
  }
}

// ================== ОБНОВЛЕННЫЙ РЕНДЕРИНГ ==================
function renderFolders(folders) {
  const select = document.getElementById('folderSelect');
  select.innerHTML = folders.map(f => `
    <option value="${escapeHTML(f.name)}" 
      ${f.name === uiState.selectedFolder ? 'selected' : ''}>
      ${escapeHTML(f.name)}
    </option>
  `).join('');
  
  document.getElementById('deleteFolder').disabled = folders.length === 0;
  
  // Автовыбор первой папки если текущая удалена
  if (folders.length > 0 && !uiState.selectedFolder) {
    uiState.selectedFolder = folders[0].name;
    select.value = folders[0].name;
    loadTemplates();
  }
}

function renderTemplates(templates) {
  const select = document.getElementById('templateSelect');
  select.innerHTML = templates.map(t => `
    <option value="${escapeHTML(t.name)}" 
      ${t.name === uiState.selectedTemplate ? 'selected' : ''}>
      ${escapeHTML(t.name)}
    </option>
  `).join('');
  
  document.getElementById('deleteTemplate').disabled = templates.length === 0;
  
  // Автовыбор первого шаблона если текущий удален
  if (templates.length > 0 && !uiState.selectedTemplate) {
    uiState.selectedTemplate = templates[0].name;
    select.value = templates[0].name;
    loadTemplateContent();
  }
}

// Очистка редактора
function clearEditor() {
  currentTemplate = null;
  document.getElementById('templateName').value = '';
  document.getElementById('templateContent').value = '';
  document.getElementById('selectorList').innerHTML = '';
}

// Показать уведомление
function showNotification(message, type = 'success') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 2500);
}

// Экранирование HTML
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Получение текущего шаблона
async function getCurrentTemplate() {
  if (!uiState.selectedFolder || !uiState.selectedTemplate) return null;
  
  const { templates } = await chrome.storage.local.get('templates');
  const folder = templates.folders.find(f => f.name === uiState.selectedFolder);
  return folder?.templates.find(t => t.name === uiState.selectedTemplate);
}

// Создание нового шаблона
async function createTemplate() {
  if (!uiState.selectedFolder) {
    showNotification('Сначала выберите папку!', 'error');
    return;
  }

  const templateName = prompt('Введите название шаблона:');
  if (!templateName) return;

  const { templates } = await chrome.storage.local.get('templates');
  const folder = templates.folders.find(f => f.name === uiState.selectedFolder);
  
  if (folder.templates.some(t => t.name === templateName)) {
    showNotification('Шаблон с таким именем уже существует!', 'error');
    return;
  }

  folder.templates.push({
    name: templateName,
    content: '',
    selectors: {}
  });

  await chrome.storage.local.set({ templates });
  renderTemplates(folder.templates);
  showNotification('Шаблон создан!');
}