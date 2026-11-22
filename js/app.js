/* Blox OS — front-end logic (vanilla JS + Lumin SDK catalog). */

'use strict';

const PROXY_PREFIX = '/api/proxy/';
const STORE_KEY = 'bloxos.customGames';
const SAVED_KEY = 'bloxos.savedGames';
const PAGE_SIZE = 48;

/* ---------------- URL helpers ---------------- */

function encodeTarget(url) {
  return PROXY_PREFIX + btoa(unescape(encodeURIComponent(url)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTarget(encoded) {
  try {
    let s = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  } catch { return encoded; }
}

function normalizeInput(input) {
  let value = input.trim();
  if (!value) return null;
  const looksLikeUrl = /^https?:\/\//i.test(value) || /^([\w-]+\.)+[a-z]{2,}([/:?#]|$)/i.test(value);
  if (!looksLikeUrl) return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(value);
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  return value;
}

function prettyHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/* ---------------- Tabs & views ---------------- */

const views = {
  home: document.getElementById('view-home'),
  games: document.getElementById('view-games'),
  cloud: document.getElementById('view-cloud'),
  ai: document.getElementById('view-ai'),
  browse: document.getElementById('view-browse'),
};

let tabs = [{ id: 1, title: 'Home', view: 'home', url: null }];
let activeTabId = 1;
let tabSeq = 2;

const activeTab = () => tabs.find((t) => t.id === activeTabId) || tabs[0];

function renderTabs() {
  document.getElementById('tabBar').innerHTML = tabs.map((t) => `
    <div class="tab ${t.id === activeTabId ? 'active' : ''}" data-tab="${t.id}">
      <span class="tab-title">${escapeHtml(t.title)}</span>
      <button class="tab-close" data-close-tab="${t.id}" title="Close tab">×</button>
    </div>`).join('');
}

function updateAddress() {
  const tab = activeTab();
  const value = tab.view === 'browse' && tab.url ? tab.url
    : tab.view === 'games' ? 'blox://games'
    : tab.view === 'cloud' ? 'blox://cloud'
    : tab.view === 'ai' ? 'blox://ai'
    : 'blox://browser';
  document.getElementById('osAddress').value = value;
}

function setView(name, { push = true } = {}) {
  if (!views[name]) name = 'home';
  const tab = activeTab();
  tab.view = name;
  if (name !== 'browse') tab.url = null;
  tab.title = name === 'games' ? 'Games' : name === 'cloud' ? 'Cloud'
    : name === 'ai' ? 'AI' : name === 'home' ? 'Home'
    : prettyHost(tab.url || '') || 'Browser';

  Object.entries(views).forEach(([key, el]) => el.classList.toggle('active', key === name));
  document.querySelectorAll('.side-btn[data-view]').forEach((el) =>
    el.classList.toggle('active', el.dataset.view === name)
  );
  if (name === 'ai') { renderAiHistory(); renderAiThread(); }
  renderTabs();
  updateAddress();
  if (push && location.hash !== '#' + name) history.pushState(null, '', '#' + name);
}

document.getElementById('tabBar').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close-tab]');
  if (close) {
    e.stopPropagation();
    const id = Number(close.dataset.closeTab);
    if (tabs.length === 1) { tabs = [{ id: 1, title: 'Home', view: 'home', url: null }]; activeTabId = 1; }
    else {
      const i = tabs.findIndex((t) => t.id === id);
      tabs.splice(i, 1);
      if (activeTabId === id) activeTabId = tabs[Math.min(i, tabs.length - 1)].id;
    }
    renderTabs();
    setView(activeTab().view, { push: false });
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) setActiveTab(Number(tab.dataset.tab));
});

function setActiveTab(id) {
  if (!tabs.some((t) => t.id === id)) return;
  activeTabId = id;
  const tab = activeTab();
  Object.entries(views).forEach(([key, el]) => el.classList.toggle('active', key === tab.view));
  document.querySelectorAll('.side-btn[data-view]').forEach((el) =>
    el.classList.toggle('active', el.dataset.view === tab.view)
  );
  if (tab.view === 'ai') { renderAiHistory(); renderAiThread(); }
  renderTabs();
  updateAddress();
}

document.getElementById('newTabBtn').addEventListener('click', () => {
  tabs.push({ id: tabSeq++, title: 'Home', view: 'home', url: null });
  activeTabId = tabs[tabs.length - 1].id;
  setView('home');
  document.getElementById('startSearchInput').focus();
});

document.querySelector('.os-sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('.side-btn[data-view]');
  if (btn) setView(btn.dataset.view);
});

document.getElementById('osBrand').addEventListener('click', () => setView('home'));
document.getElementById('osHome').addEventListener('click', () => setView('home'));
window.addEventListener('popstate', () => setView((location.hash || '#home').slice(1), { push: false }));

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) closeModal(close.dataset.close);
});

/* ---------------- Modals & loader ---------------- */

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
function showLoader() { document.getElementById('page-loader').hidden = false; }
function hideLoader() { document.getElementById('page-loader').hidden = true; }

/* ---------------- Browser ---------------- */

const frame = document.getElementById('proxyFrame');
let historyStack = [];
let historyIndex = -1;
let STATIC_MODE = false;

async function detectStaticMode() {
  try {
    const res = await fetch('api/reviews');
    const ct = res.headers.get('content-type') || '';
    STATIC_MODE = !ct.includes('application/json');
  } catch {
    STATIC_MODE = true;
  }
}

/* Static/CDN browsing: try a public CORS proxy, then fall back to a new tab. */
const CDN_PROXY = 'https://api.allorigins.win/raw?url=';
const cdnUrl = (url) => CDN_PROXY + encodeURIComponent(url);

function skipClientUrl(value) {
  return /^\s*(?:#|javascript:|data:|mailto:|tel:|about:|blob:)/i.test(value);
}

function proxifyClient(value, base) {
  if (skipClientUrl(value)) return value;
  try {
    const absolute = new URL(value, base).href;
    if (!/^https?:$/.test(new URL(absolute).protocol)) return value;
    return cdnUrl(absolute);
  } catch { return value; }
}

function rewriteHtmlClient(html, base) {
  let out = html.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(
    /(\b(?:href|src|action|poster|background|data-src|data-href|formaction)\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (m, prefix, quote, value) => skipClientUrl(value) ? m : prefix + quote + proxifyClient(value, base) + quote
  );
  out = out.replace(
    /(\bsrcset\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (m, prefix, quote, value) => prefix + quote + value.split(',').map((entry) => {
      const t = entry.trim();
      const split = t.search(/\s/);
      const url = split === -1 ? t : t.slice(0, split);
      const rest = split === -1 ? '' : t.slice(split);
      return skipClientUrl(url) ? t : proxifyClient(url, base) + rest;
    }).join(', ') + quote
  );
  return out;
}

async function loadUrl(raw, { push = true } = {}) {
  const url = normalizeInput(raw);
  if (!url) return;
  const tab = activeTab();
  tab.view = 'browse';
  tab.url = url;
  tab.title = prettyHost(url);
  setView('browse', { push: false });

  if (push) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(url);
    historyIndex = historyStack.length - 1;
  }
  updateHistoryButtons();

  showLoader();
  if (STATIC_MODE) {
    frame.style.display = 'block';
    document.getElementById('proxyNotice').hidden = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(cdnUrl(url), { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const contentType = res.headers.get('content-type') || '';
      if (!/html/i.test(contentType)) throw new Error('Not HTML');
      const html = await res.text();
      frame.srcdoc = rewriteHtmlClient(html, url);
      hideLoader();
      return;
    } catch (err) {
      hideLoader();
      window.open(url, '_blank', 'noopener');
      frame.style.display = 'none';
      const notice = document.getElementById('proxyNotice');
      notice.hidden = false;
      notice.querySelector('p').innerHTML =
        `Opened <strong>${escapeHtml(prettyHost(url))}</strong> in a new tab. This CDN link can't proxy sites inside the app — run <code>node server.js</code> or use a Cloudflare Tunnel for full in-app browsing.`;
      return;
    }
  }
  document.getElementById('proxyNotice').hidden = true;
  frame.style.display = 'block';
  frame.src = encodeTarget(url);
}

function updateHistoryButtons() {
  document.getElementById('osBack').disabled = historyIndex <= 0;
  document.getElementById('osForward').disabled = historyIndex >= historyStack.length - 1;
}

frame.addEventListener('load', () => {
  hideLoader();
  const tab = activeTab();
  if (tab.view !== 'browse') return;
  try {
    const href = frame.contentWindow.location.href;
    const marker = href.indexOf(PROXY_PREFIX);
    if (marker !== -1) {
      const real = decodeTarget(href.slice(marker + PROXY_PREFIX.length).split(/[?#]/)[0]);
      if (/^https?:\/\//i.test(real)) {
        tab.url = real;
        tab.title = prettyHost(real);
        renderTabs();
        updateAddress();
      }
    }
  } catch { /* page escaped the proxy — keep last known URL */ }
});

document.getElementById('addressForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = document.getElementById('osAddress').value;
  if (/^blox:\/\//i.test(value)) {
    const route = value.replace(/^blox:\/\//i, '').split(/[/?#]/)[0];
    setView(views[route] ? route : 'home');
    return;
  }
  loadUrl(value);
});
document.getElementById('startSearchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  loadUrl(document.getElementById('startSearchInput').value);
});
document.getElementById('osBack').addEventListener('click', () => {
  if (historyIndex > 0) loadUrl(historyStack[--historyIndex], { push: false });
});
document.getElementById('osForward').addEventListener('click', () => {
  if (historyIndex < historyStack.length - 1) loadUrl(historyStack[++historyIndex], { push: false });
});
document.getElementById('osReload').addEventListener('click', () => {
  if (frame.src) { showLoader(); frame.src = frame.src; }
});
document.getElementById('osExternal').addEventListener('click', () => {
  const tab = activeTab();
  if (tab.view === 'browse' && tab.url) window.open(tab.url, '_blank', 'noopener');
  else setView('browse');
});

document.querySelector('.start-shortcuts').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-shortcut]');
  if (!btn) return;
  if (btn.dataset.shortcut === 'games') setView('games');
  if (btn.dataset.shortcut === 'random') playRandomGame();
  if (btn.dataset.shortcut === 'library') showSaved();
});

/* ---------------- Catalog ---------------- */

function readStore(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function writeStore(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const getCustomGames = () => readStore(STORE_KEY);
const saveCustomGames = (games) => writeStore(STORE_KEY, games);
const getSaved = () => readStore(SAVED_KEY);
const saveSaved = (ids) => writeStore(SAVED_KEY, ids);

let luminGames = [];
let luminByName = new Map();
let cloudGames = [];
let cloudVisible = 48;
let cloudTerm = '';
let catalogLoading = true;
let activeCategory = 'All';
let searchTerm = '';
let visibleCount = PAGE_SIZE;
let currentGame = null;

const allGames = () => [...luminGames, ...(window.DEFAULT_GAMES || []), ...getCustomGames()];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
const escapeAttr = escapeHtml;

async function initLuminCatalog() {
  if (!window.Lumin) {
    catalogLoading = false;
    renderFilters(); renderGames(); renderFeatured();
    return;
  }
  try {
    await Lumin.init({ headless: true });
    const { games } = await Lumin.getGames({ page: 1, limit: 1200 });
    const thumbs = await Promise.all(
      games.map((g) => Lumin.getImageUrl(g.image_token).catch(() => ''))
    );
    luminGames = games.map((g, i) => {
      const prefix = (g.id || '').split('/')[0];
      const category = prefix === 'truffled' ? 'Truffled' : prefix === 'quasar' ? 'Quasar' : 'Lumin';
      return {
        id: 'lumin-' + g.id,
        gameId: g.id,
        name: g.name,
        description: `${category} browser game — part of the Lumin library.`,
        category,
        icon: '🎮',
        thumb: thumbs[i] || '',
        url: g.id,
        lumin: true,
        external: false,
        proxied: false,
      };
    });
  } catch (err) {
    console.warn('Blox OS: Lumin catalog unavailable', err);
  }
  luminByName = new Map(luminGames.map((g) => [g.name.toLowerCase().trim(), g]));
  catalogLoading = false;
  renderFilters();
  renderGames();
  renderFeatured();
}

async function loadCloudCatalog() {
  try {
    const [baseRes, lessonsRes] = await Promise.all([
      fetch('js/cloud-games.json'),
      fetch('js/astra-lessons.json'),
    ]);
    const [base, lessons] = await Promise.all([baseRes.json(), lessonsRes.json()]);

    cloudGames = [
      ...base.map((g) => ({
        id: 'cloud-' + g.key,
        name: g.name,
        img: g.img,
        desc: g.desc,
        category: g.tagline || (g.tags && g.tags[0]) || 'Cloud',
        tags: g.tags || [],
        cloud: true,
      })),
      ...lessons.map((l) => ({
        id: 'astra-' + l.id,
        name: l.title,
        img: l.cover,
        desc: 'Astra cloud title',
        category: 'Astra',
        tags: [l.track || 'Astra'],
        cloud: true,
        lessonId: l.id,
      })),
    ];
    renderCloud();
  } catch (err) {
    console.warn('Blox OS: cloud catalog unavailable', err);
  }
}

function renderCloud() {
  const term = cloudTerm.toLowerCase();
  const list = cloudGames.filter((g) => !term || g.name.toLowerCase().includes(term) ||
    (g.desc || '').toLowerCase().includes(term));
  const shown = list.slice(0, cloudVisible);
  document.getElementById('cloudGrid').innerHTML = shown.map((g) => `
    <article class="cloud-card" data-cloud-id="${escapeAttr(g.id)}">
      <img class="cover" src="${escapeAttr(g.img)}" alt="" loading="lazy" />
      <div class="cloud-info">
        <h3>${escapeHtml(g.name)}</h3>
        <div class="cat">${escapeHtml(g.category)}</div>
      </div>
    </article>`).join('');
  document.getElementById('cloudMoreWrap').hidden = list.length <= cloudVisible;
  const input = document.getElementById('cloudSearch');
  input.placeholder = `Search ${cloudGames.length.toLocaleString()} cloud titles…`;
}

function playCloudGame(game) {
  const match = luminByName.get(game.name.toLowerCase().trim()) ||
    [...luminByName.entries()].find(([name]) => name.includes(game.name.toLowerCase().trim()) && game.name.length > 5);
  if (match) {
    playGame(match[1]);
    return;
  }
  currentGame = game;
  document.getElementById('playCategory').textContent = 'Cloud title';
  document.getElementById('playTitle').textContent = game.name;
  document.getElementById('playDesc').textContent =
    (game.desc || '') + ' — This title needs a cloud streaming slot from the provider and cannot be streamed in this local build.';
  document.getElementById('externalNote').hidden = false;
  const original = document.getElementById('openOriginalBtn');
  original.hidden = true;
  updateSaveButton();
  document.getElementById('gameFrame').src = 'about:blank';
  openModal('playModal');
}

function renderFilters() {
  const counts = {};
  allGames().forEach((g) => { const c = g.category || 'Other'; counts[c] = (counts[c] || 0) + 1; });
  const categories = ['All', ...Object.keys(counts)];
  document.getElementById('categoryFilters').innerHTML = categories.map((cat) =>
    `<button class="filter-chip ${cat === activeCategory ? 'active' : ''}" data-cat="${escapeAttr(cat)}">${escapeHtml(cat)} <span class="chip-count">${cat === 'All' ? allGames().length : counts[cat]}</span></button>`
  ).join('');
  document.getElementById('gameSearch').placeholder = `Search ${allGames().length.toLocaleString()} games…`;
}

document.getElementById('categoryFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  activeCategory = chip.dataset.cat;
  visibleCount = PAGE_SIZE;
  renderGames();
  renderFilters();
});

function visibleGames() {
  const term = searchTerm.toLowerCase();
  return allGames().filter((g) => {
    const inCat = activeCategory === 'All' || (g.category || 'Other') === activeCategory;
    const inSearch = !term || g.name.toLowerCase().includes(term) ||
      (g.description || '').toLowerCase().includes(term);
    return inCat && inSearch;
  });
}

function gameIcon(g) {
  return g.thumb
    ? `<img src="${escapeAttr(g.thumb)}" alt="" loading="lazy" />`
    : `<span class="tile-icon">${escapeHtml(g.icon || '🎮')}</span>`;
}

function cardHtml(game, showDelete) {
  const badge = game.local ? 'Local' : game.lumin ? 'Lumin' : (game.external ? 'External' : 'Game');
  return `
    <article class="game-card" data-game-id="${escapeAttr(game.id)}">
      <div class="game-thumb">
        ${gameIcon(game)}
        <span class="tile-badge">${badge}</span>
        ${showDelete ? `<button class="delete-game" data-delete="${escapeAttr(game.id)}" title="Remove">✕</button>` : ''}
      </div>
      <div class="game-info">
        <div class="modal-eyebrow">${escapeHtml(game.category || 'Other')}</div>
        <h3>${escapeHtml(game.name)}</h3>
        <p>${escapeHtml(game.description || 'No description yet.')}</p>
        <div class="play-line">▶ Play now</div>
      </div>
    </article>`;
}

function renderGames() {
  const list = visibleGames();
  const shown = list.slice(0, visibleCount);
  document.getElementById('allGames').innerHTML = catalogLoading
    ? '<div class="catalog-status">Loading the Lumin game library…</div>'
    : shown.map((g) => cardHtml(g, !!g.custom)).join('');
  document.getElementById('gamesEmpty').hidden = catalogLoading || list.length > 0;
  document.getElementById('loadMoreWrap').hidden = list.length <= visibleCount;
}

function renderFeatured() {
  const pool = luminGames.length ? luminGames : (window.DEFAULT_GAMES || []);
  const wanted = ['Hill Climb Racing 2', 'Krunker', 'Fireboy & Watergirl 4', 'Super Mario Bros 2',
    'Minecraft', 'Subway Surfers', 'Papa\'s Pizzeria', 'DOOM'];
  const picks = wanted.map((name) => pool.find((g) => g.name === name) || pool.find((g) => g.name.startsWith(name)))
    .filter(Boolean).slice(0, 8);
  const source = picks.length >= 4 ? picks : pool.slice(0, 8);
  const cards = source.map((g) => `
    <div class="feature-card" data-game-id="${escapeAttr(g.id)}">
      <div class="feature-avatar">${g.thumb ? `<img src="${escapeAttr(g.thumb)}" alt="" loading="lazy" />` : escapeHtml(g.icon || '🎮')}</div>
      <div class="feature-text">
        <div class="feature-title">${escapeHtml(g.name)} · ${escapeHtml(g.category || 'Game')}</div>
        <div class="feature-quote">${escapeHtml(g.description || '')}</div>
      </div>
    </div>`).join('');
  document.getElementById('featuredRail').innerHTML = cards + cards;
}

async function playGame(game) {
  currentGame = game;
  document.getElementById('playCategory').textContent = game.category || 'Game';
  document.getElementById('playTitle').textContent = game.name;
  document.getElementById('playDesc').textContent = game.description || '';
  document.getElementById('externalNote').hidden = !game.external;
  const original = document.getElementById('openOriginalBtn');
  original.hidden = !game.external;
  original.onclick = () => window.open(game.url, '_blank', 'noopener');
  updateSaveButton();
  openModal('playModal');

  const gameFrame = document.getElementById('gameFrame');
  if (game.lumin && window.Lumin) {
    gameFrame.src = 'about:blank';
    try {
      const { url } = await Lumin.getGameUrl(game.gameId);
      gameFrame.src = url;
    } catch (err) {
      document.getElementById('playDesc').textContent = 'Could not start this game. Try another title.';
      console.warn('Blox OS: could not start Lumin game', err);
    }
  } else {
    gameFrame.src = game.proxied ? encodeTarget(game.url) : game.url;
  }
}

function playRandomGame() {
  const pool = visibleGames().length ? visibleGames() : allGames();
  if (pool.length) playGame(pool[Math.floor(Math.random() * pool.length)]);
}

function updateSaveButton() {
  const btn = document.getElementById('saveGameBtn');
  if (!currentGame) return;
  btn.textContent = getSaved().includes(currentGame.id) ? '★ Saved' : '☆ Save';
}

document.getElementById('saveGameBtn').addEventListener('click', () => {
  if (!currentGame) return;
  const saved = getSaved();
  const i = saved.indexOf(currentGame.id);
  if (i === -1) saved.push(currentGame.id); else saved.splice(i, 1);
  saveSaved(saved);
  updateSaveButton();
});

document.getElementById('randomGameBtn').addEventListener('click', playRandomGame);
document.getElementById('loadMoreBtn').addEventListener('click', () => {
  visibleCount += PAGE_SIZE;
  renderGames();
});

document.getElementById('cloudSearch').addEventListener('input', (e) => {
  cloudTerm = e.target.value;
  cloudVisible = 48;
  renderCloud();
});
document.getElementById('cloudMoreBtn').addEventListener('click', () => {
  cloudVisible += 48;
  renderCloud();
});
document.addEventListener('click', (e) => {
  const card = e.target.closest('.cloud-card');
  if (!card) return;
  const game = cloudGames.find((g) => g.id === card.dataset.cloudId);
  if (game) playCloudGame(game);
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-delete]') || e.target.closest('[data-play]')) return;
  const card = e.target.closest('.game-card, .feature-card');
  if (!card) return;
  const game = allGames().find((g) => g.id === card.dataset.gameId);
  if (game) playGame(game);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  e.stopPropagation();
  saveCustomGames(getCustomGames().filter((g) => g.id !== btn.dataset.delete));
  renderFilters(); renderGames();
});

document.getElementById('gameSearch').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  visibleCount = PAGE_SIZE;
  renderGames();
});

/* ---------------- Add game ---------------- */

document.getElementById('addGameBtn').addEventListener('click', () => {
  document.getElementById('addGameForm').reset();
  openModal('addModal');
});

document.getElementById('addGameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const game = {
    id: 'custom-' + Date.now(),
    name: data.get('name').trim(),
    description: data.get('description').trim(),
    category: data.get('category').trim() || 'Custom',
    icon: data.get('icon').trim() || '🎮',
    url: data.get('url').trim(),
    proxied: data.get('proxied') === 'on',
    external: data.get('external') === 'on',
    custom: true,
  };
  const custom = getCustomGames();
  custom.push(game);
  saveCustomGames(custom);
  closeModal('addModal');
  activeCategory = 'All'; searchTerm = ''; visibleCount = PAGE_SIZE;
  document.getElementById('gameSearch').value = '';
  renderFilters(); renderGames();
  playGame(game);
});

/* ---------------- AI assistant ---------------- */

const AI_CHATS_KEY = 'bloxos.aiChats';
const AI_USAGE_KEY = 'bloxos.aiUsage';
const CLIENT_AI_SYSTEM = [
  'You are Blox AI, a helpful, friendly assistant inside Blox OS.',
  'You can answer general questions, explain concepts, and help with legitimate coding, debugging, and learning.',
  'HARD RULES: Refuse any request that asks for malware, viruses, ransomware, spyware, keyloggers, exploit code,',
  'credential theft, phishing, DDoS, bombs, weapons, illegal drug or hacking instructions, or anything intended',
  'to harm, spy on, or exploit other people. Do not write such code even for "educational" framing.',
  'For those requests, reply with a brief refusal and offer a safe alternative. Otherwise be concise and kind.',
].join(' ');
let aiChats = [];
let aiActiveId = null;
let aiBusy = false;

function loadAiState() {
  try { aiChats = JSON.parse(localStorage.getItem(AI_CHATS_KEY)) || []; }
  catch { aiChats = []; }
  if (!aiChats.length) {
    aiActiveId = 'ai-' + Date.now();
    aiChats = [{ id: aiActiveId, title: 'New chat', messages: [] }];
    saveAiChats();
  } else if (!aiChats.some((c) => c.id === aiActiveId)) {
    aiActiveId = aiChats[0].id;
  }
}

function saveAiChats() { localStorage.setItem(AI_CHATS_KEY, JSON.stringify(aiChats.slice(0, 20))); }
function activeAiChat() { return aiChats.find((c) => c.id === aiActiveId) || aiChats[0]; }

function getAiUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(AI_USAGE_KEY));
    if (u && Date.now() - (u.hour || 0) < 3600000) return u;
  } catch { /* start fresh */ }
  return { requests: 0, tokens: 0, hour: Date.now() };
}
function setAiUsage(u) { localStorage.setItem(AI_USAGE_KEY, JSON.stringify(u)); updateAiUsage(); }

function updateAiUsage() {
  const u = getAiUsage();
  document.getElementById('aiRequests').textContent = `${u.requests} / 15`;
  document.getElementById('aiTokens').textContent = `${u.tokens.toLocaleString()} / 61K`;
  const pct = Math.min(100, Math.round((u.requests / 15) * 100));
  document.getElementById('aiUsagePct').textContent = pct + '%';
  document.getElementById('aiUsageBar').style.width = pct + '%';
  document.getElementById('aiUsageNote').textContent = u.requests >= 15 ? 'Hourly limit reached' : '1 message / 45s on free tier';
}

function renderAiHistory() {
  document.getElementById('aiHistory').innerHTML = aiChats.length
    ? aiChats.map((c) => `<div class="ai-history-item ${c.id === aiActiveId ? 'active' : ''}" data-chat="${escapeAttr(c.id)}">${escapeHtml(c.title)}</div>`).join('')
    : '<div class="ai-empty-history">No chats yet</div>';
  const chat = activeAiChat();
  document.getElementById('aiChatTitle').textContent = chat ? chat.title : 'New chat';
}

function formatAi(text) {
  let safe = escapeHtml(text);
  safe = safe.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/^\n|\n$/g, '')}</code></pre>`);
  safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return safe;
}

const AI_GREETING_HTML = `
  <div class="ai-greeting" id="aiGreeting">
    <h2>Good Evening!</h2>
    <div class="ai-suggestions">
      <button data-suggest="Write a poem about the ocean.">Write a poem about the ocean.</button>
      <button data-suggest="Explain quantum physics simply.">Explain quantum physics simply.</button>
      <button data-suggest="Give me a healthy dinner recipe.">Give me a healthy dinner recipe.</button>
      <button data-suggest="Help me debug a JavaScript function.">Help me debug a JavaScript function.</button>
    </div>
  </div>`;

function renderAiThread() {
  const chat = activeAiChat();
  const thread = document.getElementById('aiThread');
  if (!chat || !chat.messages.length) {
    thread.innerHTML = AI_GREETING_HTML;
    return;
  }
  thread.innerHTML = chat.messages.map((m) => `
    <div class="msg ${m.role}">
      <div class="avatar">${m.role === 'user' ? 'You' : 'B'}</div>
      <div class="bubble">${formatAi(m.content)}</div>
    </div>`).join('');
  thread.scrollTop = thread.scrollHeight;
}

async function requestAi(messages, model, apiKey) {
  // Try our own backend first. On a static CDN (jsDelivr / GitHub Pages) the
  // API does not exist, so fall back to the free provider directly.
  try {
    const res = await fetch('api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model, apiKey }),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      if (data.ok) return data;
      throw new Error(data.error || 'AI error');
    }
  } catch (err) {
    if (err.message && /limit|refus|sorry/i.test(err.message)) throw err;
  }

  // Static CDN fallback. Try the free provider directly first — it works from
  // real https origins (GitHub Pages / jsDelivr) with a 45s cooldown.
  const last = Number(localStorage.getItem('bloxos.aiLast') || 0);
  const wait = 45000 - (Date.now() - last);
  if (wait > 0) {
    throw new Error(`Free AI limit: one message every 45 seconds. Wait ${Math.ceil(wait / 1000)}s.`);
  }
  localStorage.setItem('bloxos.aiLast', String(Date.now()));
  try {
    const res = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model === 'mistral' ? 'mistral' : 'openai',
        messages: [{ role: 'system', content: CLIENT_AI_SYSTEM }, ...messages],
      }),
    });
    if (res.ok) {
      return { ok: true, answer: (await res.text()).slice(0, 8000), provider: 'Free tier' };
    }
  } catch { /* try the personal key below */ }

  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('AI is busy right now. Get a free key at console.groq.com, paste it in the AI panel, or try again shortly.');
  }
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: CLIENT_AI_SYSTEM }, ...messages],
      max_tokens: 1024,
    }),
  });
  if (!groqRes.ok) throw new Error('Groq key rejected (' + groqRes.status + '). Check the key in the AI panel.');
  const data = await groqRes.json();
  const answer = (data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '').slice(0, 8000);
  return { ok: true, answer, provider: 'Groq (your key)' };
}

async function sendAiMessage(text) {
  if (aiBusy || !text.trim()) return;
  const chat = activeAiChat();
  const usage = getAiUsage();
  if (usage.requests >= 15) {
    chat.messages.push({ role: 'assistant', content: 'Hourly limit reached (15 requests). Please try again later.' });
    saveAiChats(); renderAiThread();
    return;
  }
  aiBusy = true;
  document.getElementById('aiInput').disabled = true;
  chat.messages.push({ role: 'user', content: text.trim() });
  if (chat.messages.length === 1) chat.title = text.trim().slice(0, 32);
  saveAiChats(); renderAiThread(); renderAiHistory();

  const thread = document.getElementById('aiThread');
  const thinking = document.createElement('div');
  thinking.className = 'ai-thinking';
  thinking.textContent = 'Blox AI is thinking…';
  thread.appendChild(thinking);
  thread.scrollTop = thread.scrollHeight;

  try {
    const data = await requestAi(
      chat.messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
      document.getElementById('aiModel').value,
      document.getElementById('aiKey').value.trim()
    );
    thinking.remove();
    chat.messages.push({ role: 'assistant', content: data.answer });
    usage.requests++;
    usage.tokens += Math.min(4000, text.length + data.answer.length);
    setAiUsage(usage);
  } catch (err) {
    thinking.remove();
    chat.messages.push({ role: 'assistant', content: err.message || 'Could not reach Blox AI.' });
  }
  aiBusy = false;
  document.getElementById('aiInput').disabled = false;
  saveAiChats(); renderAiThread(); renderAiHistory();
}

document.getElementById('aiForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('aiInput');
  const text = input.value;
  input.value = '';
  sendAiMessage(text);
});
document.getElementById('aiNewChat').addEventListener('click', () => {
  aiActiveId = 'ai-' + Date.now();
  aiChats.unshift({ id: aiActiveId, title: 'New chat', messages: [] });
  saveAiChats(); renderAiHistory(); renderAiThread();
});
document.getElementById('aiMenu').addEventListener('click', () => {
  document.querySelector('.ai-side').classList.toggle('mobile-open');
});
document.getElementById('aiReset').addEventListener('click', () => {
  if (confirm('Reset your local AI usage counter? (The server limit still applies.)')) {
    setAiUsage({ requests: 0, tokens: 0, hour: Date.now() });
  }
});
document.getElementById('aiHistory').addEventListener('click', (e) => {
  const item = e.target.closest('[data-chat]');
  if (!item) return;
  aiActiveId = item.dataset.chat;
  renderAiHistory(); renderAiThread();
});
document.getElementById('aiThread').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-suggest]');
  if (btn) sendAiMessage(btn.dataset.suggest);
});

/* ---------------- Side panels ---------------- */

function showPanel(title, html) {
  document.getElementById('infoTitle').textContent = title;
  document.getElementById('infoBody').innerHTML = html;
  openModal('infoModal');
}

function showSaved() {
  const savedIds = getSaved();
  const games = allGames().filter((g) => savedIds.includes(g.id));
  showPanel('Saved games', games.length
    ? '<ul>' + games.map((g) => `
        <li><strong>${escapeHtml(g.name)}</strong> · ${escapeHtml(g.category || 'Game')}
          <button class="inline-link" data-play="${escapeAttr(g.id)}">Play →</button>
        </li>`).join('') + '</ul>'
    : '<p>No saved games yet. Open a game and press <strong>Save</strong> to add it here.</p>');
}

document.getElementById('osSettings').addEventListener('click', () => {
  showPanel('Settings', `
    <p>Your library data lives in this browser.</p>
    <ul>
      <li>Custom games: <strong>${getCustomGames().length}</strong><button class="inline-link" id="clearCustom">Clear</button></li>
      <li>Saved games: <strong>${getSaved().length}</strong><button class="inline-link" id="clearSaved">Clear</button></li>
      <li>Saved library <button class="inline-link" id="openSaved">Open</button></li>
      <li>Share links <button class="inline-link" id="openLinks">Open</button></li>
      <li>Click sounds <button class="inline-link" id="toggleSound">${localStorage.getItem('bloxos.muted') === '1' ? 'Enable' : 'Mute'}</button></li>
    </ul>`);
  document.getElementById('openLinks').onclick = showLinks;
  document.getElementById('toggleSound').onclick = () => {
    const muted = localStorage.getItem('bloxos.muted') === '1';
    if (muted) localStorage.removeItem('bloxos.muted');
    else localStorage.setItem('bloxos.muted', '1');
    document.getElementById('osSettings').click();
  };
  document.getElementById('clearCustom').onclick = () => {
    if (confirm('Remove all custom games?')) {
      saveCustomGames([]); renderFilters(); renderGames();
      document.getElementById('osSettings').click();
    }
  };
  document.getElementById('clearSaved').onclick = () => {
    if (confirm('Remove all saved games?')) {
      saveSaved([]); updateSaveButton();
      document.getElementById('osSettings').click();
    }
  };
  document.getElementById('openSaved').onclick = showSaved;
});

document.getElementById('osDiscord').addEventListener('click', () =>
  showPanel('Community', '<p>Community chat isn’t connected in this local build.</p>'));

document.addEventListener('click', (e) => {
  const play = e.target.closest('[data-play]');
  if (!play) return;
  const game = allGames().find((g) => g.id === play.dataset.play);
  if (game) { closeModal('infoModal'); playGame(game); }
});

/* ---------------- Real online presence ---------------- */

let onlineData = null;

async function updateOnline() {
  try {
    const res = await fetch('https://t9os.space/online', { cache: 'no-store' });
    const data = await res.json();
    onlineData = data;
    if (typeof data.online === 'number') {
      document.getElementById('onlineCount').textContent = data.online;
    }
  } catch {
    document.getElementById('onlineCount').textContent = '—';
  }
}

document.getElementById('onlinePill').addEventListener('click', () => {
  if (!onlineData) {
    showPanel('Live users', '<p>Could not load live presence data.</p>');
    return;
  }
  const countries = {};
  (onlineData.users || []).forEach((u) => {
    const c = u.country || 'Unknown';
    countries[c] = (countries[c] || 0) + 1;
  });
  const top = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 8);
  showPanel('Live users', `
    <p><strong>${onlineData.online ?? '—'}</strong> people online right now · <strong>${onlineData.connections ?? '—'}</strong> connections.</p>
    <ul>${top.length ? top.map(([c, n]) => `<li>${escapeHtml(c)} <strong>${n}</strong></li>`).join('') : '<li>No location data available</li>'}</ul>
    <p style="font-size:11px;color:#66666f">Live presence is provided by the public online endpoint.</p>`);
});

/* ---------------- Reviews ---------------- */

const REVIEW_LOCAL_KEY = 'bloxos.reviews';

async function loadReviews() {
  try {
    const res = await fetch('api/reviews');
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
  } catch { /* static CDN — use local storage */ }
  try { return JSON.parse(localStorage.getItem(REVIEW_LOCAL_KEY)) || []; }
  catch { return []; }
}

async function postReview(payload) {
  try {
    const res = await fetch('api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not post review.');
      return;
    }
  } catch (err) {
    if (err.message && !/fetch|network|failed/i.test(err.message)) throw err;
  }
  // Static fallback: keep reviews in this browser.
  const last = Number(localStorage.getItem('bloxos.reviewLast') || 0);
  if (Date.now() - last < 30000) throw new Error('Please wait 30 seconds before posting again.');
  const clean = {
    name: String(payload.name).replace(/[<>\r\n]/g, ' ').trim().slice(0, 40),
    text: String(payload.text).replace(/[<>\r\n]/g, ' ').trim().slice(0, 500),
    rating: Math.min(5, Math.max(1, Number(payload.rating) || 5)),
  };
  const reviews = JSON.parse(localStorage.getItem(REVIEW_LOCAL_KEY) || '[]');
  reviews.unshift({ id: Date.now().toString(36), ...clean, date: new Date().toISOString().slice(0, 10) });
  localStorage.setItem(REVIEW_LOCAL_KEY, JSON.stringify(reviews.slice(0, 100)));
  localStorage.setItem('bloxos.reviewLast', String(Date.now()));
}

async function showReviews() {
  showPanel('Reviews', '<div class="catalog-status">Loading reviews…</div>');
  const reviews = await loadReviews();
  const avg = reviews.length
    ? (reviews.reduce((s, r) => s + (Number(r.rating) || 5), 0) / reviews.length).toFixed(1)
    : '—';
  const list = reviews.length
    ? reviews.map((r) => `
        <div class="review-item">
          <div class="review-top">
            <span class="review-name">${escapeHtml(r.name)}</span>
            <span class="stars">${'★'.repeat(r.rating || 5)}${'☆'.repeat(5 - (r.rating || 5))}</span>
          </div>
          <div class="review-text">${escapeHtml(r.text)}</div>
          <div class="review-date">${escapeHtml(r.date || '')}</div>
        </div>`).join('')
    : '<p>No reviews yet. Be the first to leave one!</p>';
  showPanel('Reviews', `
    <p><strong>${avg}</strong> ★ average from <strong>${reviews.length}</strong> review${reviews.length === 1 ? '' : 's'}.</p>
    ${list}
    <form class="review-form" id="reviewForm">
      <div class="row">
        <input name="name" maxlength="40" placeholder="Your name" required />
        <select name="rating"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select>
      </div>
      <textarea name="text" maxlength="500" placeholder="What do you think of Blox OS?" required></textarea>
      <button class="pill-btn primary" type="submit">Post review</button>
    </form>`);

  document.getElementById('reviewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await postReview({ name: form.name.value, rating: Number(form.rating.value), text: form.text.value });
      showReviews();
    } catch (err) {
      btn.disabled = false;
      form.insertAdjacentHTML('beforeend', `<p style="color:#ff8a8a;font-size:12px">${escapeHtml(err.message)}</p>`);
    }
  });
}
document.getElementById('osReviews').addEventListener('click', showReviews);

/* ---------------- Shareable links / note pad ---------------- */

function buildLinksText() {
  const origin = location.origin;
  const publicUrl = localStorage.getItem('bloxos.publicUrl') || '';
  return `🎮 BLOX OS — SHARE LINKS

Main site: ${origin}
Home:      ${origin}/#home
Games:     ${origin}/#games
Cloud:     ${origin}/#cloud
AI:        ${origin}/#ai
Browse:    ${origin}/#browse

Public URL: ${publicUrl || '(add one in Settings → Share links)'}

--- Discord post ---
🎮 Blox OS — browse the web and play 1,600+ games.
${publicUrl || origin}
`;
}

function showLinks() {
  showPanel('Share links', `
    <p>Copy this block and paste it into your Discord server.</p>
    <div class="link-box" id="linksBox">${escapeHtml(buildLinksText())}</div>
    <label class="link-field"><span>Public URL (for the Discord post)</span>
      <input id="publicUrlInput" type="text" placeholder="https://your-domain.com" value="${escapeAttr(localStorage.getItem('bloxos.publicUrl') || '')}" />
    </label>
    <div class="link-actions">
      <button class="pill-btn primary" id="copyLinks">Copy links</button>
      <button class="pill-btn" id="savePublicUrl">Save URL</button>
      <a class="pill-btn" href="custom-links.txt" download>Download .txt</a>
    </div>`);

  document.getElementById('savePublicUrl').addEventListener('click', () => {
    const value = document.getElementById('publicUrlInput').value.trim();
    if (value) localStorage.setItem('bloxos.publicUrl', value);
    else localStorage.removeItem('bloxos.publicUrl');
    showLinks();
  });
  document.getElementById('copyLinks').addEventListener('click', async () => {
    const text = buildLinksText();
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById('copyLinks').textContent = 'Copied!';
    } catch {
      const box = document.getElementById('linksBox');
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
  });
}

/* ---------------- Click sounds ---------------- */

let audioCtx = null;
function playClick() {
  if (localStorage.getItem('bloxos.muted') === '1') return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(720, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(360, audioCtx.currentTime + 0.045);
    gain.gain.setValueAtTime(0.045, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.07);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.075);
  } catch { /* audio is optional */ }
}

document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, .game-card, .feature-card, .cloud-card, .filter-chip, .ai-history-item, .ai-suggestions button, .tab')) {
    playClick();
  }
}, true);

/* ---------------- Keyboard ---------------- */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    if (activeTab().view === 'games') document.getElementById('gameSearch').focus();
    else { setView('home'); document.getElementById('startSearchInput').focus(); }
  }
  if (e.key === 'Escape') ['playModal', 'addModal', 'infoModal'].forEach(closeModal);
});

/* ---------------- Init ---------------- */

renderTabs();
updateAddress();
updateHistoryButtons();
hideLoader();
detectStaticMode();
setView((location.hash || '#home').slice(1), { push: false });
loadAiState();
document.getElementById('aiKey').value = localStorage.getItem('bloxos.aiKey') || '';
document.getElementById('aiKey').addEventListener('change', (e) => {
  if (e.target.value.trim()) localStorage.setItem('bloxos.aiKey', e.target.value.trim());
  else localStorage.removeItem('bloxos.aiKey');
});
updateAiUsage();
updateOnline();
setInterval(updateOnline, 15000);
loadCloudCatalog();
initLuminCatalog();
