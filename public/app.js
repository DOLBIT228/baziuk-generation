const state = { user: null, aspectRatio: '1:1', gallery: [] };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const promptInput = $('#prompt');
const counter = $('#counter');
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

function setUser(user) {
  state.user = user;
  $('#loginOpen').classList.toggle('hidden', Boolean(user));
  $('#logoutBtn').classList.toggle('hidden', !user);
  $('#adminLink').classList.toggle('hidden', user?.role !== 'admin');
  $('#adminPanel').classList.toggle('hidden', user?.role !== 'admin');
  if (user?.role === 'admin') loadUsers();
}

function renderGeneration(item, compact = false) {
  const card = document.createElement('article');
  card.className = 'result-card';
  card.innerHTML = `
    <a href="${item.imageUrl}" target="_blank" rel="noreferrer"><img src="${item.imageUrl}" alt="${escapeHtml(item.prompt)}" /></a>
    <div class="result-meta">
      <div class="cost"><span class="pill">$${Number(item.cost?.usd || 0).toFixed(6)}</span><span class="pill">₴${Number(item.cost?.uah || 0).toFixed(2)}</span>${item.mocked ? '<span class="pill">mock</span>' : ''}</div>
      <p>${escapeHtml(item.prompt)}</p>
      ${compact ? '' : `<p>${escapeHtml(item.aspectRatio)} · ${escapeHtml(item.imageSize)} · ${new Date(item.createdAt).toLocaleString('uk-UA')}</p>`}
    </div>`;
  return card;
}

function renderGallery(items = state.gallery) {
  const gallery = $('#gallery');
  gallery.innerHTML = '';
  if (!items.length) {
    gallery.innerHTML = '<div class="empty">Поки що немає зображень. Згенеруйте перший дизайн.</div>';
    return;
  }
  items.forEach((item) => gallery.append(renderGeneration(item)));
  const referenceSelect = $('#referenceImage');
  referenceSelect.innerHTML = '<option value="">Нове зображення без референсу</option>';
  items.slice(0, 30).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.imageUrl;
    option.textContent = `${item.prompt.slice(0, 52)} — ${new Date(item.createdAt).toLocaleDateString('uk-UA')}`;
    referenceSelect.append(option);
  });
}

async function loadGallery() {
  if (!state.user) {
    renderGallery([]);
    return;
  }
  const data = await api('/api/gallery');
  state.gallery = data.generations || [];
  renderGallery();
}

async function loadUsers() {
  const data = await api('/api/admin/users');
  const table = $('#usersTable');
  table.innerHTML = '';
  data.users.forEach((user) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td><td><span class="badge ${user.active ? '' : 'off'}">${user.active ? 'активний' : 'вимкнений'}</span></td><td><button class="secondary" data-user="${user.id}" data-active="${!user.active}">${user.active ? 'Вимкнути' : 'Увімкнути'}</button></td>`;
    table.append(row);
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

promptInput.addEventListener('input', () => { counter.textContent = `${promptInput.value.length}/1000`; });
count.addEventListener('input', () => { countNumber.value = count.value; });
countNumber.addEventListener('input', () => { count.value = countNumber.value; });

$$('.ratio').forEach((button) => button.addEventListener('click', () => {
  $$('.ratio').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.aspectRatio = button.dataset.ratio;
}));

$('#loginOpen').addEventListener('click', () => loginModal.classList.remove('hidden'));
$('#closeLogin').addEventListener('click', () => loginModal.classList.add('hidden'));
$('#adminLink').addEventListener('click', () => document.querySelector('#adminPanel').scrollIntoView({ behavior: 'smooth' }));
$('#refreshGallery').addEventListener('click', () => loadGallery().catch((error) => notify(error.message)));

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    setUser(data.user);
    loginModal.classList.add('hidden');
    notify(`Вітаю, ${data.user.username}!`);
    await loadGallery();
  } catch (error) { notify(error.message); }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  setUser(null);
  state.gallery = [];
  renderGallery([]);
  notify('Ви вийшли із системи');
});

$('#generateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.user) {
    loginModal.classList.remove('hidden');
    notify('Спочатку увійдіть у систему');
    return;
  }
  const btn = $('#generateBtn');
  const results = $('#results');
  const dropzone = $('#dropzone');
  btn.disabled = true;
  btn.textContent = 'Генерація...';
  results.classList.remove('hidden');
  dropzone.classList.add('hidden');
  results.innerHTML = '<div class="empty">Модель створює зображення, зачекайте...</div>';
  try {
    const requests = Array.from({ length: Number(count.value) }, () => api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt: promptInput.value,
        aspectRatio: state.aspectRatio,
        imageSize: $('#imageSize').value,
        style: $('#style').value,
        referenceImage: $('#referenceImage').value,
      }),
    }));
    const generated = await Promise.all(requests);
    const items = generated.map((item) => item.generation);
    results.innerHTML = '';
    items.forEach((item) => results.append(renderGeneration(item, true)));
    state.gallery = [...items, ...state.gallery];
    renderGallery();
    notify('Готово! Зображення додано в галерею.');
  } catch (error) {
    results.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    notify(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Згенерувати зображення';
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

(async function init() {
  try {
    const data = await api('/api/me');
    setUser(data.user);
    await loadGallery();
  } catch {
    setUser(null);
    renderGallery([]);
  }
})();
