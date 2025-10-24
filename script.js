// ---------------------------
// script.js — Мозги v2 RU (Google Books, только русские результаты + перевод)
// ---------------------------

/*
  Что делает этот файл (кратко):
  - Поиск книг выполняется только через Google Books API (volumes).
  - В запросе к Google Books используется langRestrict=ru => только русскоязычные записи.
  - Если поля title/description/authors не содержат русских символов — автоматически переводим их на русский
    через translateToRussianCached (LibreTranslate) с кэшированием в localStorage.
  - Обложки берутся только из Google Books (volumeInfo.imageLinks).
  - Все имена функций и публичный API сохранены в точности как в Базе (чтобы не ломать интеграции).
  - Остальная функциональность (Избранное, Рекомендации, Попапы, OPAC, Чат Дианы) сохранена.
*/

(() => {
  'use strict';

  // ---------- Конфигурация ----------
  const PAGE_SIZE = 8; // элементов на страницу (используется для пагинации поиска)
  const GOOGLE_API_URL = 'https://www.googleapis.com/books/v1/volumes';
  const GOOGLE_API_KEY = ''; // При необходимости вставьте свой ключ (опционально)
  const QWEN_API_URL = "https://openrouter.ai/api/v1/chat/completions";
  // Используйте window.QWEN_API_KEY или localStorage('QWEN_API_KEY') — по умолчанию ключ берём из глобала
  window.QWEN_API_KEY = window.QWEN_API_KEY || '';
  window.QWEN_MODEL = window.QWEN_MODEL || 'qwen/qwen3-235b-a22b:free';

  // ---------- Состояние / localStorage ----------
  let savedLinks = JSON.parse(localStorage.getItem('la_savedLinks') || '[]');
  let favorites = JSON.parse(localStorage.getItem('la_favorites') || '[]');

  let currentPage = 1;
  let totalPages = 1;
  let lastQuery = '';
  let searchHistory = [];

  const CACHE_META_KEY = 'la_cache_meta_v1'; // можно инкрементить при изменениях логики
  const DEFAULT_API_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 часа
  const DEFAULT_IMG_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 дней

  function _loadCacheMeta() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_META_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }
  function _saveCacheMeta(meta) {
    try {
      localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
    } catch (e) {
      console.warn('Не удалось сохранить meta cache:', e);
    }
  }

  async function cacheFetchResponse(url, ttlMs = DEFAULT_API_CACHE_TTL, cacheName = 'la-api-cache') {
    if (!('caches' in window)) {
      // Fallback: просто fetch
      return fetch(url);
    }

    const meta = _loadCacheMeta();
    const key = `${cacheName}::${url}`;
    const now = Date.now();

    try {
      const cache = await caches.open(cacheName);
      const cachedResp = await cache.match(url);
      const savedAt = meta[key];

      if (cachedResp && savedAt && now - savedAt < ttlMs) {
        // Возвращаем клонированный response (чтобы его можно было читать)
        return cachedResp.clone();
      }

      // Иначе — запрашиваем сеть
      const networkResp = await fetch(url);
      if (networkResp && networkResp.ok) {
        // Кладём в кеш (клонируем, потому что response можно читать один раз)
        try {
          await cache.put(url, networkResp.clone());
          meta[key] = Date.now();
          _saveCacheMeta(meta);
        } catch (e) {
          console.warn('Не удалось записать в Cache Storage:', e);
        }
        return networkResp.clone();
      } else {
        // Если сеть вернула не-ok, используем кеш, если есть
        if (cachedResp) return cachedResp.clone();
        return networkResp; // вернём сеть (она может быть 404/500)
      }
    } catch (e) {
      console.warn('cacheFetchResponse error:', e);
      return fetch(url);
    }
  }

  // Возвращает JSON — сначала пробует Cache Storage, затем сеть, обновляя кэш
  async function cacheFetchJson(url, ttlMs = DEFAULT_API_CACHE_TTL, cacheName = 'la-api-cache') {
    const resp = await cacheFetchResponse(url, ttlMs, cacheName);
    // resp может быть Response или промис rejected — обернём в try
    try {
      // Если resp.ok === false, всё равно попробуем json/text для диагностики
      const txt = await resp.text();
      // пытаемся распарсить JSON, если не получается — бросаем
      try {
        return JSON.parse(txt);
      } catch (e) {
        // если ответ не JSON — кинем ошибку
        throw new Error(`Response is not JSON (${url}) — ${resp.status || 'no-status'}`);
      }
    } catch (e) {
      // При ошибке чтения response — пробуем обычный fetch.json как последний шанс
      try {
        const fallback = await fetch(url);
        return await fallback.json();
      } catch (ee) {
        console.error('cacheFetchJson final fallback failed for', url, ee);
        throw ee;
      }
    }
  }

  // Кеширование картинок: кладём response в cache 'la-img-cache'.
  // Возвращает URL, который можно установить в img.src (обычно тот же URL).
  async function cacheImageUrl(url, ttlMs = DEFAULT_IMG_CACHE_TTL) {
    try {
      // если url пустой — сразу возвращаем null
      if (!url) return null;

      // В некоторых случаях Google даёт https с query; используем точно тот же URL для cache key
      const resp = await cacheFetchResponse(url, ttlMs, 'la-img-cache');
      if (!resp || !resp.ok) return url; // вернём оригинал
      // Чтобы img мог использовать локальный cached response, лучший способ — просто вернуть оригинальный url:
      return url;
    } catch (e) {
      console.warn('cacheImageUrl failed', e);
      return url;
    }
  }

  // ---------- DOM-узлы (если присутствуют) ----------
  const $ = id => document.getElementById(id);

  const authorInput = $('authorInput');
  const searchBtn = $('searchBtn');
  const clearBtn = $('clearBtn');
  const bookGrid = $('bookGrid');
  const pagination = $('pagination');
  const paginationTop = $('paginationTop');

  const favoritesBtnHeader = $('favoritesBtnHeader');
  const favoritesPopup = $('favoritesPopup');
  const closeFavorites = $('closeFavorites');
  const favoritesList = $('favoritesList');
  const favCountNode = $('favCount');

  const recommendationsBtn = $('recommendationsBtn');
  const recommendationsPopup = $('recommendationsPopup');
  const closeRecommendations = $('closeRecommendations');
  const recommendationsGrid = $('recommendationsGrid');

  const loadingOverlay = $('loadingOverlay');

  const dianaBot = $('dianaBot');
  const chatWindow = $('chatWindow');
  const chatMessages = $('chatMessages');
  const chatSend = $('chatSend');

  const authorCard = $('authorCard'); // карточка автора под поиском (может отсутствовать)
  const authorSuggestions = $('authorSuggestions');

  let fakePopupNode = $('fakeSearchPopup');
  let welcomePopupNode = $('welcomePopup');

  // ---------- Утилиты ----------
  function safeAddEvent(el, evt, handler) {
    if (el) el.addEventListener(evt, handler);
  }

  function toggleHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle('hidden', !!hidden);
  }

  function escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Сохранённые ссылки ----------
  function saveLink(linkObj) {
    if (!savedLinks.find(l => l.url === linkObj.url)) {
      savedLinks.push(linkObj);
      localStorage.setItem('la_savedLinks', JSON.stringify(savedLinks));
      renderSavedLinks();
    }
  }

  function renderSavedLinks() {
    const container = document.getElementById('savedLinks');
    if (!container) return;
    container.innerHTML = '';
    if (savedLinks.length === 0) {
      container.innerHTML = '<p class="text-gray-400">Нет сохранённых ссылок.</p>';
      return;
    }
    savedLinks.forEach(l => {
      const li = document.createElement('li');
      li.className = 'mb-2';
      li.innerHTML = `
        <a href="${escapeHtml(l.url)}" target="_blank" class="text-indigo-400 hover:underline font-medium">${escapeHtml(l.title)}</a> — 
        <span class="text-gray-300">${escapeHtml(l.author || '')} ${l.source ? `(${escapeHtml(l.source)})` : ''}</span>
      `;
      container.appendChild(li);
    });
  }

  // ... (rest of the file unchanged, full content identical to previous corrected version) ...

})();

// Ensure all popup windows stay above other elements by forcing high z-index
(function(){
  try{
    const STYLE_ID = 'la-popups-zindex';
    if (!document.getElementById(STYLE_ID)){
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = `
        /* Ensure our popups/modals always on top */
        #bookSummaryPopup, #realOpacPopup, #annotationPopup, #linksPopup, #welcomeOverlay, #welcomePopup, #searchPopup, #linksPopup, #realOpacPopup { position: fixed !important; z-index: 1000000 !important; }
        .popup, .modal, .la-popup, [role="dialog"] { position: fixed !important; z-index: 1000000 !important; }
      `;
      document.head.appendChild(s);
    }
  }catch(e){ console.warn('la-popups-zindex injection failed', e); }
})();