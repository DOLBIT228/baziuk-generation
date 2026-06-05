const defaultStyles = ['Комерційний банер', 'Реалістична фотографія', 'Мінімалістичний UI', '3D ілюстрація', 'Кінематографічний'];
const state = { user: null, aspectRatio: '1:1', gallery: [], chats: [], activeChatId: null, attachments: [], styles: defaultStyles };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const promptInput = $('#prompt');
const count = $('#count');
const countNumber = $('#countNumber');
const loginModal = $('#loginModal');
const toast = $('#toast');

function notify(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Помилка запиту');
  return data;
}

function routeTo(path) {
  history.pushState({}, '', path);
  renderRoute();
}

function renderRoute() {
  const path = window.location.pathname;
  const showProfile = path === '/profile';
  $('#landingPage').classList.toggle('hidden', Boolean(state.user));
  $('#appPage').classList.toggle('hidden', !state.user || showProfile);
  $('#profilePage').classList.toggle('hidden', !state.user || !showProfile);
  if (showProfile && !state.user) loginModal.classList.remove('hidden');
  if (showProfile && state.user?.role === 'admin') loadUsers().catch((error) => notify(error.message));
}

function setUser(user) {
  state.user = user;
  $('#loginOpen').classList.toggle('hidden', Boolean(user));
  $('#profileLink').classList.toggle('hidden', !user);
  $('#logoutBtn').classList.toggle('hidden', !user);
  $('#styleAdmin').classList.toggle('hidden', user?.role !== 'admin');
  $('#adminAccess').classList.toggle('hidden', user?.role !== 'admin');
  $('#profileInfo').classList.toggle('hidden', user?.role === 'admin');
  renderRoute();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function groupChats(items) {
  const map = new Map();
  items.forEach((item) => {
    const chatId = item.chatId || item.id;
    if (!map.has(chatId)) map.set(chatId, { id: chatId, title: item.chatTitle || item.prompt.slice(0, 64) || 'Новий візуал', items: [] });
    map.get(chatId).items.push(item);
  });
  return [...map.values()].map((chat) => ({ ...chat, items: chat.items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) }));
}

function ensureActiveChat() {
  if (state.activeChatId && state.chats.some((chat) => chat.id === state.activeChatId)) return;
  state.activeChatId = state.chats[0]?.id || `local_${Date.now()}`;
  if (!state.chats.length) state.chats.push({ id: state.activeChatId, title: 'Новий візуал', items: [] });
}

function renderChats() {
  ensureActiveChat();
  const chatList = $('#chatList');
  chatList.innerHTML = '';
  state.chats.forEach((chat) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-item ${chat.id === state.activeChatId ? 'active' : ''}`;
    button.dataset.chat = chat.id;
    button.innerHTML = `<b>${escapeHtml(chat.title)}</b><span>${chat.items.length ? `${chat.items.length} генерацій` : 'Порожній чат'}</span>`;
    chatList.append(button);
  });
  renderActiveChat();
}

function renderActiveChat() {
  const chat = state.chats.find((item) => item.id === state.activeChatId);
  $('#chatTitle').textContent = chat?.title || 'Новий візуал';
  const messages = $('#chatMessages');
  messages.innerHTML = '';
  if (!chat?.items.length) {
    messages.innerHTML = '<div class="empty welcome-message"><b>Почніть новий чат.</b><span>Напишіть промт унизу, додайте до двох референсів за потреби та згенеруйте перший візуал.</span></div>';
    return;
  }
  chat.items.forEach((item, index) => messages.append(renderMessage(item, index + 1)));
  messages.scrollTop = messages.scrollHeight;
}

function renderMessage(item, index) {
  const article = document.createElement('article');
  article.className = 'message-pair';
  article.innerHTML = `
    <div class="message user-message"><span>Промт ${index}</span><p>${escapeHtml(item.prompt)}</p></div>
    <div class="message image-message">
      <a href="${item.imageUrl}" target="_blank" rel="noreferrer"><img src="${item.imageUrl}" alt="${escapeHtml(item.prompt)}" /></a>
      <div class="result-meta">
        <div class="cost"><span class="pill">${escapeHtml(item.aspectRatio)}</span><span class="pill">${escapeHtml(item.imageSize)}</span>${item.style ? `<span class="pill">${escapeHtml(item.style)}</span>` : ''}${item.mocked ? '<span class="pill">mock</span>' : ''}</div>
        <p>${new Date(item.createdAt).toLocaleString('uk-UA')}</p>
      </div>
    </div>`;
  return article;
}

function renderStyles() {
  const styleSelect = $('#style');
  styleSelect.innerHTML = '<option value="">Оберіть стиль</option>';
  state.styles.forEach((style) => {
    const option = document.createElement('option');
    option.value = style;
    option.textContent = style;
    styleSelect.append(option);
  });
  $('#stylesEditor').value = state.styles.join('\n');
}

async function loadSettings() {
  const data = await api('/api/settings');
  state.styles = data.styles?.length ? data.styles : defaultStyles;
  renderStyles();
}

async function loadGallery() {
  if (!state.user) {
    state.gallery = [];
    state.chats = [];
    return renderChats();
  }
  const data = await api('/api/gallery');
  state.gallery = data.generations || [];
  state.chats = groupChats(state.gallery);
  renderChats();
}

async function loadUsers() {
  if (state.user?.role !== 'admin') return;
  const data = await api('/api/admin/users');
  const table = $('#usersTable');
  table.innerHTML = '';
  data.users.forEach((user) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td><td><span class="badge ${user.active ? '' : 'off'}">${user.active ? 'активний' : 'вимкнений'}</span></td><td><button class="secondary" data-user="${user.id}" data-active="${!user.active}">${user.active ? 'Вимкнути' : 'Увімкнути'}</button></td>`;
    table.append(row);
  });
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
    reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
    reader.readAsDataURL(file);
  });
}

function renderAttachments() {
  const preview = $('#attachmentPreview');
  preview.innerHTML = '';
  state.attachments.forEach((file, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'attachment-thumb';
    item.dataset.removeAttachment = index;
    item.innerHTML = `<img src="${file.dataUrl}" alt="${escapeHtml(file.name)}" /><span>×</span>`;
    preview.append(item);
  });
}

count.addEventListener('input', () => { countNumber.value = count.value; });
countNumber.addEventListener('input', () => { count.value = countNumber.value; });

$$('.ratio').forEach((button) => button.addEventListener('click', () => {
  $$('.ratio').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.aspectRatio = button.dataset.ratio;
}));

$('#homeLink').addEventListener('click', () => routeTo('/'));
$('#loginOpen').addEventListener('click', () => loginModal.classList.remove('hidden'));
$('#landingLogin').addEventListener('click', () => loginModal.classList.remove('hidden'));
$('#landingDemo').addEventListener('click', () => $('#landingInfo').scrollIntoView({ behavior: 'smooth' }));
$('#closeLogin').addEventListener('click', () => loginModal.classList.add('hidden'));
$('#profileLink').addEventListener('click', () => routeTo('/profile'));

$('#chatList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-chat]');
  if (!button) return;
  state.activeChatId = button.dataset.chat;
  renderChats();
});

$('#newChatBtn').addEventListener('click', () => {
  const chat = { id: `local_${Date.now()}`, title: 'Новий візуал', items: [] };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  renderChats();
});

$('#referenceFiles').addEventListener('change', async (event) => {
  const files = [...event.target.files].slice(0, 2);
  state.attachments = await Promise.all(files.map(fileToDataUrl));
  renderAttachments();
  event.target.value = '';
});

$('#attachmentPreview').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-attachment]');
  if (!button) return;
  state.attachments.splice(Number(button.dataset.removeAttachment), 1);
  renderAttachments();
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    setUser(data.user);
    loginModal.classList.add('hidden');
    routeTo('/');
    notify(`Вітаю, ${data.user.username}!`);
    await Promise.all([loadSettings(), loadGallery()]);
  } catch (error) { notify(error.message); }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  setUser(null);
  state.gallery = [];
  state.chats = [];
  routeTo('/');
  notify('Ви вийшли із системи');
});

$('#generateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.user) {
    loginModal.classList.remove('hidden');
    notify('Спочатку увійдіть у систему');
    return;
  }
  if (promptInput.value.trim().length < 3) return notify('Опишіть зображення детальніше');

  const btn = $('#generateBtn');
  const status = $('#chatStatus');
  btn.disabled = true;
  btn.textContent = 'Генерація...';
  status.textContent = 'Генеруємо';
  const chatId = state.activeChatId || `local_${Date.now()}`;
  const currentChat = state.chats.find((chat) => chat.id === chatId);
  const referenceFromChat = currentChat?.items.at(-1)?.imageUrl || '';

  try {
    const requests = Array.from({ length: Number(count.value) }, () => api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt: promptInput.value,
        chatId,
        chatTitle: currentChat?.items.length ? currentChat.title : promptInput.value.slice(0, 64),
        aspectRatio: state.aspectRatio,
        imageSize: $('#imageSize').value,
        style: $('#style').value,
        referenceImage: referenceFromChat,
        referenceImages: state.attachments.map((item) => item.dataUrl),
      }),
    }));
    const generated = await Promise.all(requests);
    const items = generated.map((item) => item.generation);
    state.gallery = [...items, ...state.gallery];
    state.chats = groupChats(state.gallery);
    state.activeChatId = items[0].chatId;
    promptInput.value = '';
    state.attachments = [];
    renderAttachments();
    renderChats();
    notify('Готово! Візуал додано в чат.');
  } catch (error) {
    notify(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Згенерувати';
    status.textContent = 'Готово';
  }
});

$('#createUserForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: $('#newUsername').value, password: $('#newPassword').value, role: $('#newRole').value }) });
    event.target.reset();
    notify('Доступ створено');
    await loadUsers();
  } catch (error) { notify(error.message); }
});

$('#usersTable').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-user]');
  if (!button) return;
  try {
    await api(`/api/admin/users/${button.dataset.user}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active === 'true' }) });
    await loadUsers();
  } catch (error) { notify(error.message); }
});

$('#stylesForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const styles = $('#stylesEditor').value.split('\n').map((item) => item.trim()).filter(Boolean);
    const data = await api('/api/admin/styles', { method: 'PUT', body: JSON.stringify({ styles }) });
    state.styles = data.styles;
    renderStyles();
    notify('Стилі оновлено');
  } catch (error) { notify(error.message); }
});

window.addEventListener('popstate', renderRoute);

(async function init() {
  await loadSettings().catch(() => renderStyles());
  try {
    const data = await api('/api/me');
    setUser(data.user);
    if (data.user) await loadGallery();
    else renderRoute();
  } catch {
    setUser(null);
  }
})();
