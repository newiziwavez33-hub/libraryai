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
  window.QWEN_API_KEY = window.QWEN_API_KEY || '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';
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

  // ---------- Текстовые хелперы ----------
  function shortenWords(str = '', maxWords = 8) {
    if (!str) return '';
    const arr = str.trim().split(/\s+/);
    return arr.length <= maxWords ? arr.join(' ') : arr.slice(0, maxWords).join(' ') + '…';
  }

  function formatAuthors(authors) {
    if (!authors) return 'Неизвестный автор';
    if (Array.isArray(authors)) {
      return authors.map(a => a.split(' ').slice(0, 4).join(' ')).join(', ');
    } else if (typeof authors === 'string') {
      return authors.split(' ').slice(0, 4).join(' ');
    }
    return 'Неизвестный автор';
  }

  function shortenForList(str) {
    return shortenWords(str, 8);
  }

  // ---------- Перевод с кешем (LibreTranslate) ----------
  // Кэширует переводы в localStorage: ключ translate_<text>
  async function translateToRussianCached(text) {
    if (!text) return '';
    const cacheKey = `translate_${text}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;

    try {
      const response = await fetch('https://libretranslate.de/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: 'auto',
          target: 'ru',
          format: 'text'
        })
      });

      if (!response.ok) throw new Error('Ошибка перевода');

      const data = await response.json();
      const translated = data.translatedText;
      localStorage.setItem(cacheKey, translated);
      return translated;
    } catch (err) {
      console.error('Ошибка перевода:', err);
      return text; // Возвращаем оригинал при ошибке
    }
  }

  // ---------- Лоадер ----------
  function showLoader(show = true) {
    if (!loadingOverlay) return;
    toggleHidden(loadingOverlay, !show);
  }

  // Init loader animation: hourglass ↔ flipping book (SVG + CSS). Adds content to loadingOverlay.
  function initLoaderAnimation() {
    try {
      if (!loadingOverlay) return;
      // inject styles once
      if (!document.getElementById('la-loader-styles')) {
        const style = document.createElement('style');
        style.id = 'la-loader-styles';
        style.textContent = "\
#loadingOverlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 99998; align-items: center; justify-content: center; }\
#loadingOverlay.la-show { display: flex; }\
.la-loader-wrap { display:flex; flex-direction:column; align-items:center; gap:12px; }\
.la-svg { width:80px; height:80px; display:block; }\
@keyframes rotateHourglass { 0% { transform: rotate(0deg); } 50% { transform: rotate(180deg); } 100% { transform: rotate(360deg); } }\
@keyframes pageFlip { 0% { transform: translateY(0) rotateX(0deg); } 50% { transform: translateY(-6px) rotateX(12deg); } 100% { transform: translateY(0) rotateX(0deg); } }\
.la-hourglass { animation: rotateHourglass 2.6s linear infinite; }\
.la-book { animation: none; }\
.la-pages { transform-origin: left center; animation: pageFlip 1s ease-in-out infinite; }\
.la-loader-text { color: #fff; font-size: 1rem; font-weight: 600; margin-top:6px; }\
";
        document.head.appendChild(style);
      }

      // add inner HTML (two SVGs toggled by opacity via simple JS cycle)
      loadingOverlay.innerHTML = '\
  <div class="la-loader-wrap" role="status" aria-live="polite">\
    <div id="la-anim" style="width:120px; height:120px; display:flex; align-items:center; justify-content:center; position:relative;">\
      <svg class="la-svg la-hourglass" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">\
        <g fill="none" stroke="#fff" stroke-width="2">\
          <path d="M16 8h32M16 56h32" stroke-linecap="round"/>\
          <path d="M20 8v8c0 6 8 12 12 12s12-6 12-12V8" stroke-linecap="round" stroke-linejoin="round"/>\
          <path d="M20 56v-8c0-6 8-12 12-12s12 6 12 12v8" stroke-linecap="round" stroke-linejoin="round"/>\
        </g>\
      </svg>\
\
      <svg class="la-svg la-book" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="opacity:0; position:absolute;">\
        <g fill="none" stroke="#fff" stroke-width="2">\
          <path d="M12 12h32v40H12z" />\
          <path class="la-pages" d="M44 12c4 0 6 1 8 3v34c-2 2-4 3-8 3" stroke-linejoin="round"/>\
        </g>\
      </svg>\
    </div>\
    <div class="la-loader-text">Загрузка</div>\
  </div>\
      ';

      // cycle visibility hourglass <-> book
      let showingHour = true;
      if (loadingOverlay._la_cycle) clearInterval(loadingOverlay._la_cycle);
      loadingOverlay._la_cycle = setInterval(() => {
        const hg = loadingOverlay.querySelector('.la-hourglass');
        const bk = loadingOverlay.querySelector('.la-book');
        if (!hg || !bk) return;
        if (showingHour) {
          // fade to book
          hg.style.transition = 'opacity 300ms';
          bk.style.transition = 'opacity 300ms';
          hg.style.opacity = '0';
          bk.style.opacity = '1';
        } else {
          hg.style.opacity = '1';
          bk.style.opacity = '0';
        }
        showingHour = !showingHour;
      }, 2600);
    } catch (e) {
      console.warn('initLoaderAnimation failed', e);
    }
  }

  // enhance showLoader to toggle class for display
  const _origShowLoader = showLoader;
  function showLoader(show = true) {
    if (!loadingOverlay) return;
    if (show) {
      loadingOverlay.classList.add('la-show');
    } else {
      loadingOverlay.classList.remove('la-show');
    }
  }

  // loader reference counting — show loader while any async fetches are running
  let _loaderCount = 0;
  function incLoader() {
    try { _loaderCount = (_loaderCount || 0) + 1; } catch(e) { _loaderCount = 1; }
    try { showLoader(true); } catch(e) {}
  }
  function decLoader() {
    try { _loaderCount = Math.max(0, (_loaderCount||0) - 1); } catch(e) { _loaderCount = 0; }
    try { if ((_loaderCount||0) === 0) showLoader(false); } catch(e) {}
    tryHideWelcomeOverlay();
  }

  // welcome overlay removal only when page is fully loaded AND there are no active loaders
  function tryHideWelcomeOverlay() {
    try {
      const overlay = document.getElementById('welcomeOverlay');
      if (!overlay) return;
      // respect minimum visible time if set
      const minMs = 5000;
      const shownAt = (window._welcomeShownAt) || 0;
      const elapsed = Date.now() - shownAt;
      if (document.readyState === 'complete' && ((_loaderCount||0) === 0)) {
        if (elapsed < minMs) {
          // delay hide until min visible time passed
          setTimeout(tryHideWelcomeOverlay, minMs - elapsed + 50);
          return;
        }
        overlay.style.transition = 'opacity 0.6s';
        overlay.style.opacity = '0';
        setTimeout(() => { try { overlay.remove(); } catch(e) {} }, 700);
      }
    } catch(e) {}
  }
  // also listen for window load to attempt hide
  window.addEventListener('load', tryHideWelcomeOverlay);

  // initialize loader animation immediately if DOM already ready
  try { if (document.readyState !== 'loading') initLoaderAnimation(); } catch(e) {}
  // ---------- Вспомогательные функции для Google Books ----------
  function buildGoogleBooksUrl({ q = '', startIndex = 0, maxResults = 8, langRestrict = '' } = {}) {
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('startIndex', String(startIndex));
    params.set('maxResults', String(maxResults));
    if (langRestrict) params.set('langRestrict', langRestrict);
    if (GOOGLE_API_KEY) params.set('key', GOOGLE_API_KEY);
    return `${GOOGLE_API_URL}?${params.toString()}`;
  }

  function googleItemToDoc(item) {
    const vi = item.volumeInfo || {};
    return {
      title: vi.title || 'Без названия',
      author_name: vi.authors || [],
      description: vi.description || vi.subtitle || '',
      cover: (vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail)) || null,
      publishedDate: vi.publishedDate || '',
      language: vi.language || '',
      infoLink: vi.infoLink || '',
      _rawVolume: item
    };
  }

  // ---------- Загрузка ТОП книг при старте (через Google Books) ----------
  async function loadBooks(query = 'subject:fiction') {
   try {
  if (typeof loadRandomRussianBooks === 'function') {
    loadRandomRussianBooks();
  } else {
    loadBooks('subject:fiction'); // fallback
  }
} catch (e) {
  console.warn('startup loadRandomRussianBooks failed, fallback to loadBooks', e);
  loadBooks('subject:fiction');
}

      // Тематические запросы для выборки популярных русскоязычных книг
      const ratingQueries = [
        'бестселлер',
        'популярные книги',
        'роман',
        'современная литература',
        'русская литература',
        'детектив',
        'фантастика',
        'поэзия'
      ];

      const allBooks = [];

      // Загружаем результаты по нескольким запросам и объединяем
      for (const qCandidate of ratingQueries) {
        const url = buildGoogleBooksUrl({
          q: qCandidate,
          startIndex: 0,
          maxResults: 20,
          langRestrict: 'ru'
        });

        console.log('📚 Загрузка рейтинговых книг:', url);

        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          for (const item of items) {
            if (item.volumeInfo) {
              allBooks.push(item);
            }
          }
        } catch (err) {
          console.warn('Ошибка загрузки для запроса', qCandidate, err);
        }
      }

      if (!allBooks.length) {
        throw new Error('Не удалось загрузить рейтинговые русские книги.');
      }

      // Сортируем по рейтингу и количеству отзывов
      const sorted = allBooks
        .map(item => {
          const vi = item.volumeInfo || {};
          return {
            ...item,
            rating: vi.averageRating || 0,
            ratingsCount: vi.ratingsCount || 0
          };
        })
        .sort((a, b) => {
          // первично по рейтингу, вторично по количеству отзывов
          if (b.rating === a.rating) return (b.ratingsCount || 0) - (a.ratingsCount || 0);
          return b.rating - a.rating;
        });

      // Оставляем только уникальные книги по title + author
      const seen = new Set();
      const unique = [];
      for (const item of sorted) {
        const key = ((item.volumeInfo.title || '') + (item.volumeInfo.authors || []).join(',')).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      }

      // Берём топ-12
      const topItems = unique.slice(0, 12);
      const docs = topItems.map(googleItemToDoc);

      // Переводим на русский, если надо
      const translated = [];
      for (const d of docs) {
        const vi = d._rawVolume?.volumeInfo || {};
        const lang = (vi.language || '').toLowerCase();
        const title = d.title || '';
        const desc = d.description || '';
        const authors = Array.isArray(d.author_name) ? d.author_name.join(', ') : (d.author_name || '');
        const hasCyr = /[а-яё]/i.test(title + desc + authors);

        if (lang !== 'ru' || !hasCyr) {
          try {
            const [titleRu, descRu, authorsRu] = await Promise.all([
              translateToRussianCached(title || ''),
              translateToRussianCached(desc || ''),
              translateToRussianCached(authors || '')
            ]);
            d.title = titleRu || d.title;
            d.description = descRu || d.description;
            d.author_name = (authorsRu && authorsRu.split(',').map(a => a.trim())) || d.author_name;
          } catch (trErr) {
            console.warn('Ошибка перевода рейтинговой книги:', trErr);
          }
        }

        translated.push(d);
      }

      renderBooks(translated);
    } catch (e) {
      console.error('Ошибка при загрузке рейтинговых книг:', e);
      if (bookGrid) {
        bookGrid.innerHTML = `<p class="text-red-400 col-span-full text-center">
          ⚠️ Ошибка при загрузке рейтинговых книг: ${escapeHtml(e.message || 'Неизвестная ошибка')}
        </p>`;
      }
    } finally {
      showLoader(false);
    }
  }

  // ---------- Поиск (Google Books) — ТОЛЬКО русские книги, с переводом метаданных ----------
  async function searchBooks() {
    if (!authorInput || !bookGrid) return;

    // track total items returned by Google Books for pagination
    let lastSearchTotalItems = 0;

    const rawQuery = (authorInput.value || '').trim();
    if (!rawQuery) {
      bookGrid.innerHTML = '<p class="text-gray-500 col-span-full text-center">Введите имя автора, название или ISBN для поиска.</p>';
      return;
    }

    lastQuery = rawQuery;
    searchHistory.unshift(rawQuery);

    const genre = $('genreFilter')?.value || '';
    const yearFrom = $('yearFrom')?.value || '';
    const yearTo = $('yearTo')?.value || '';

    // Хелпер: выполняет запрос к Google Books и возвращает массив docs (в формате googleItemToDoc)
    async function fetchDocsForQuery(q) {
      try { incLoader(); } catch(e) {}

      const url = buildGoogleBooksUrl({
        q,
        startIndex: (Math.max(1, currentPage) - 1) * PAGE_SIZE,
        maxResults: PAGE_SIZE,
        langRestrict: 'ru'
      });
      console.log('🔍 Google Books query:', q, url);
      const res = await fetch(url);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('Ошибка Google Books:', res.status, txt);
        throw new Error(`Google Books API error ${res.status}`);
      }
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      // record totalItems for pagination (fallback to items.length if not provided)
      try { lastSearchTotalItems = parseInt(data.totalItems) || items.length || 0; } catch(e) { lastSearchTotalItems = items.length || 0; }
      return items.map(googleItemToDoc);
    }

    showLoader(true);

    try {
      let docs = [];

      // 1) Если строка выглядит как ISBN (10 или 13 цифр, возможно с дефисами/пробелами) — пробуем isbn:
      const isbnCandidate = rawQuery.replace(/[-\s]/g, '');
      const isbnPattern = /^(97(8|9))?\d{9}(\d|X)$/i; // простая проверка ISBN-10/13 (X для ISBN-10)
      if (isbnPattern.test(isbnCandidate)) {
        try {
          docs = await fetchDocsForQuery(`isbn:${isbnCandidate}`);
        } catch (e) {
          console.warn('ISBN-запрос не удался:', e);
        }
      }

      // 2) Если ничего не найдено — пробуем поиск по автору (инаuthor)
      if (!docs || docs.length === 0) {
        try {
          docs = await fetchDocsForQuery(`inauthor:${rawQuery}${genre ? ' subject:' + genre : ''}`);
        } catch (e) {
          console.warn('Author-запрос не удался:', e);
        }
      }

      // 3) Если всё ещё ничего — пробуем поиск по названию (intitle)
      if (!docs || docs.length === 0) {
        try {
          docs = await fetchDocsForQuery(`intitle:${rawQuery}`);
        } catch (e) {
          console.warn('Title-запрос не удался:', e);
        }
      }

      // 4) Финальный фоллбек — общий запрос (ищет по всему)
      if (!docs || docs.length === 0) {
        try {
          docs = await fetchDocsForQuery(rawQuery);
        } catch (e) {
          console.warn('Общий запрос не удался:', e);
        }
      }

      // Если нет результатов — отображаем корректное сообщение (и пагинацию)
      if (!docs || docs.length === 0) {
        bookGrid.innerHTML = '<p class="text-gray-500 col-span-full text-center">Книги не найдены.</p>';
        totalPages = 1;
        renderPagination();
        return;
      }

      // Переводим только при необходимости: если volumeInfo.language !== 'ru' или нет кириллицы
      const processed = [];
      for (const d of docs) {
        const vi = d._rawVolume?.volumeInfo || {};
        const lang = (vi.language || '').toLowerCase();
        const title = d.title || '';
        const desc = d.description || '';
        const authors = Array.isArray(d.author_name) ? d.author_name.join(', ') : (d.author_name || '');
        const containsRussian = /[а-яё]/i.test(title + desc + authors);

        if (lang !== 'ru' || !containsRussian) {
          try {
            const [titleRu, descRu, authorsRu] = await Promise.all([
              translateToRussianCached(title),
              translateToRussianCached(desc),
              translateToRussianCached(authors)
            ]);
            d.title = titleRu || d.title;
            d.description = descRu || d.description;
            d.author_name = (authorsRu || authors).split(',').map(a => a.trim());
          } catch (trErr) {
            console.warn('Ошибка перевода при поиске:', trErr);
            // в случае ошибки перевода оставляем оригинальные поля
          }
        }

        processed.push(d);
      }

      // client-side фильтр по году (если есть)
      let filteredDocs = processed;
      if (yearFrom || yearTo) {
        filteredDocs = processed.filter(d => {
          const pd = d.publishedDate || '';
          const y = parseInt(pd.slice(0, 4));
          if (!y) return true;
          if (yearFrom && y < parseInt(yearFrom)) return false;
          if (yearTo && y > parseInt(yearTo)) return false;
          return true;
        });
      }

      // обновляем author card и рендер
      renderAuthorCardFromQuery(rawQuery);
      renderBooks(filteredDocs);

      // compute totalPages from lastSearchTotalItems if available
      try {
        totalPages = Math.max(1, Math.ceil((lastSearchTotalItems || filteredDocs.length || 1) / PAGE_SIZE));
      } catch (e) {
        totalPages = 1;
      }
      renderPagination();

    } catch (err) {
      console.error('❌ Ошибка поиска книг:', err);
      if (bookGrid) {
        bookGrid.innerHTML = `<p class="text-red-400 col-span-full text-center">
          ⚠️ Ошибка при загрузке книг: ${escapeHtml(err.message || 'Неизвестная ошибка')}
        </p>`;
      }
    } finally {
      showLoader(false);
    }
  }
  // ---------- Рендер карточек книг ----------
  async function renderBooks(books = [], container = bookGrid) {
    if (!container) return;
    container.innerHTML = '';

    if (!books || books.length === 0) {
      container.innerHTML = '<p class="text-gray-500 col-span-full text-center">Книги не найдены</p>';
      return;
    }

    // Ensure loader stays visible until all book images are loaded.
    try { incLoader(); } catch (e) {}

    const imgPromises = [];

    for (const b of books) {
      const title = b.title || 'Без названия';
      const author = (b.author_name && b.author_name.join(', ')) || 'Неизвестный автор';
      // Use Diana.jpg as default fallback when cover is missing or falsy
      const cover = b.cover || 'Diana.jpg';
      const description = b.description || '';

      const card = document.createElement('div');
      card.className = 'book-card flex flex-col items-center bg-white p-2 rounded shadow';
      // keep book cards below popups; do not set excessively high z-index on cards
      try { card.style.zIndex = '5'; } catch(e) {}
      // store first author for later normalization
      try { card.dataset.author = author; } catch(e) {}
      card.innerHTML = `
        <img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" class="w-full h-40 object-cover mb-2 rounded book-card-img">
        <p class="font-medium text-sm text-center book-title">${escapeHtml(shortenWords(title, 12))}</p>
        <p class="text-xs text-gray-500 text-center book-author">${escapeHtml(formatAuthors(b.author_name))}</p>
        <div class="flex gap-2 mt-2">
          <button class="btn add-fav">Добавить в избранное</button>
          <button class="btn search-lib bg-gray-100 text-gray-800">Искать</button>
        </div>
      `;

      // Track image loading for this card
      const imgEl = card.querySelector('img.book-card-img');
      if (imgEl) {
        const p = new Promise(resolve => {
          if (imgEl.complete && imgEl.naturalWidth && imgEl.naturalWidth > 0) {
            resolve(true);
          } else {
            imgEl.addEventListener('load', () => resolve(true));
            imgEl.addEventListener('error', () => {
              // on error, fallback to Diana.jpg if not already
              try {
                if (imgEl.src && !imgEl.src.endsWith('Diana.jpg')) {
                  imgEl.src = 'Diana.jpg';
                }
              } catch(e){}
              resolve(true);
            });
          }
        });
        imgPromises.push(p);
      }

      // Добавление в избранное
      card.querySelector('.add-fav')?.addEventListener('click', () => {
        addToFavorites({
          title,
          author,
          cover
        });
        const btn = card.querySelector('.add-fav');
        if (btn) btn.textContent = 'В избранном ✓';
      });

      // Фейковый OPAC-поиск
      card.querySelector('.search-lib')?.addEventListener('click', () => openRealOpacSearch(title));

      // Кнопка "Аннотация от Дианы"
      const moreBtn = document.createElement('button');
      moreBtn.textContent = 'Аннотация от Дианы';
      moreBtn.className = 'btn bg-gray-100 text-gray-800 text-xs px-2 py-1';
      moreBtn.addEventListener('click', () => showBookSummary({
        title,
        author,
        _rawVolume: b._rawVolume,
        description: description
      }));

      card.querySelector('.flex.gap-2')?.appendChild(moreBtn);

      container.appendChild(card);
    }

    // After appending cards, wait for all images to finish loading (or error) before hiding loader.
    try {
      await Promise.all(imgPromises);
    } catch (e) {
      // ignore image promise errors - we resolve on error above
    } finally {
      try { decLoader(); } catch (e) {}
    }

    // После рендера — инициализируем подсказки/ховер
    onBooksUpdated();
  }

  // ---------- Пагинация ----------
  function renderPagination() {
    [paginationTop, pagination].forEach(container => {
      if (!container) return;
      container.innerHTML = '';

      const prev = document.createElement('button');
      prev.textContent = '← Назад';
      prev.className = `btn px-3 py-1 ${currentPage === 1 ? 'bg-gray-300 text-gray-500' : ''}`;
      prev.disabled = currentPage === 1;
      prev.addEventListener('click', () => {
        if (currentPage > 1) {
          currentPage--;
          searchBooks();
        }
      });
      container.appendChild(prev);

      let start = Math.max(1, currentPage - 2);
      let end = Math.min(totalPages, start + 4);
      if (end - start < 4) start = Math.max(1, end - 4);
      for (let i = start; i <= end; i++) {
        const btn = document.createElement('button');
        btn.textContent = i;
        btn.className = `btn px-2 py-1 ${i === currentPage ? 'bg-indigo-600 text-white' : ''}`;
        btn.addEventListener('click', () => {
          currentPage = i;
          searchBooks();
        });
        container.appendChild(btn);
      }

      const next = document.createElement('button');
      next.textContent = 'Далее →';
      next.className = `btn px-3 py-1 ${currentPage === totalPages ? 'bg-gray-300 text-gray-500' : ''}`;
      next.disabled = currentPage === totalPages;
      next.addEventListener('click', () => {
        if (currentPage < totalPages) {
          currentPage++;
          searchBooks();
        }
      });
      container.appendChild(next);
    });
  }

  // ---------- Избранное ----------
  function saveFavorites() {
    localStorage.setItem('la_favorites', JSON.stringify(favorites));
  }

  function addToFavorites(book) {
    if (!book) return;
    if (!favorites.find(f => f.title === book.title && f.author === book.author)) {
      favorites.push(book);
      saveFavorites();
      updateFavCounter();
      renderFavoritesList();
    }
  }

  function removeFromFavorites(index) {
    if (index < 0 || index >= favorites.length) return;
    favorites.splice(index, 1);
    saveFavorites();
    updateFavCounter();
    renderFavoritesList();
  }

  function updateFavCounter() {
    if (!favCountNode) return;
    favCountNode.textContent = favorites.length || '';
    if (favorites.length === 0) favCountNode.classList.add('hidden');
    else favCountNode.classList.remove('hidden');
  }

  function renderFavoritesList() {
    if (!favoritesList) return;
    favoritesList.innerHTML = '';
    favorites.forEach((bk, idx) => {
      const div = document.createElement('div');
      div.className = 'flex items-center justify-between bg-gray-50 border border-gray-200 p-3 rounded-lg hover:shadow mb-2';
      div.innerHTML = `
        <div class="flex items-center gap-3">
          <img src="${escapeHtml(bk.cover) || 'Diana.jpg'}" alt="${escapeHtml(bk.title)}" class="w-12 h-16 object-cover rounded">
          <div>
            <div class="font-medium text-sm">${escapeHtml(shortenForList(bk.title))}</div>
            <div class="text-xs text-gray-500">${escapeHtml(shortenForList(bk.author))}</div>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row sm:gap-2">
          <button class="btn removeFav bg-red-500 text-white text-xs px-2 py-1">Удалить</button>
          <button class="btn searchFav bg-gray-300 text-gray-800 text-xs px-2 py-1 mt-2 sm:mt-0">Искать</button>
        </div>
      `;

      const moreBtnFav = document.createElement('button');
      moreBtnFav.textContent = 'Аннотация от Дианы';
      moreBtnFav.className = 'btn bg-indigo-600 text-white text-xs px-2 py-1 mt-2 sm:mt-0 hover:bg-indigo-700';
      moreBtnFav.addEventListener('click', () => showBookSummary(bk));
      const containerRight = div.querySelector('.flex.flex-col.sm\\:flex-row');
      if (containerRight) containerRight.appendChild(moreBtnFav);

      div.querySelector('.removeFav').addEventListener('click', () => removeFromFavorites(idx));

      div.querySelector('.searchFav').addEventListener('click', () => {
        if (favoritesPopup) favoritesPopup.classList.add('hidden');
        openRealOpacSearch(bk.title);
      });

      favoritesList.appendChild(div);
    });
  }

  // ---------- Рекомендации ----------
  async function renderRecommendations() {
    if (!recommendationsGrid) return;
    recommendationsGrid.innerHTML = '';

    const loader = document.createElement('div');
    loader.className = 'text-center text-gray-500 py-6';
    loader.innerHTML = '⏳ Загружаю рекомендации...';
    recommendationsGrid.appendChild(loader);

    if (!favorites.length) {
      loader.textContent = 'Добавьте книги в Избранное, чтобы увидеть рекомендации.';
      return;
    }

    const authors = [...new Set(favorites.map(f => f.author))];
    const genres = [...new Set(favorites.map(f => f.genre).filter(Boolean))];
    const recs = [];
    const favKeys = new Set(favorites.map(f => `${f.title}||${f.author}`));

    // По авторам (через Google Books)
    for (const author of authors) {
      try {
        const url = buildGoogleBooksUrl({ q: `inauthor:${author}`, startIndex: 0, maxResults: 5, langRestrict: 'ru' });
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        items.slice(0, 5).forEach(it => {
          const doc = googleItemToDoc(it);
          const key = `${doc.title}||${(doc.author_name && doc.author_name.join(', ')) || author}`;
          if (!favKeys.has(key)) {
            recs.push({ title: doc.title, author: (doc.author_name || []).join(', '), cover: doc.cover || 'Diana.jpg' });
          }
        });
      } catch (e) {
        console.error(e);
      }
    }

    // По жанрам (subject)
    for (const genre of genres) {
      try {
        const url = buildGoogleBooksUrl({ q: `subject:${genre}`, startIndex: 0, maxResults: 5, langRestrict: 'ru' });
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        items.slice(0, 5).forEach(it => {
          const doc = googleItemToDoc(it);
          const authorName = (doc.author_name || []).join(', ') || 'Неизвестный';
          const key = `${doc.title}||${authorName}`;
          if (!favKeys.has(key)) {
            recs.push({ title: doc.title, author: authorName, cover: doc.cover || 'Diana.jpg' });
          }
        });
      } catch (e) {
        console.error(e);
      }
    }

    recommendationsGrid.innerHTML = '';

    recs.slice(0, 12).forEach(bk => {
      const div = document.createElement('div');
      div.className = 'flex items-center justify-between bg-gray-50 border border-gray-200 p-3 rounded-lg hover:shadow mb-2';
      div.innerHTML = `
        <div class="flex items-center gap-3">
          <img src="${escapeHtml(bk.cover) || 'Diana.jpg'}" alt="${escapeHtml(bk.title)}" class="w-12 h-16 object-cover rounded">
          <div>
            <div class="font-medium text-sm">${escapeHtml(shortenForList(bk.title))}</div>
            <div class="text-xs text-gray-500">${escapeHtml(shortenForList(bk.author))}</div>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row sm:gap-2">
          <button class="btn add-fav bg-indigo-600 text-white text-xs px-2 py-1">Добавить в избранное</button>
          <button class="btn search-lib bg-gray-300 text-gray-800 text-xs px-2 py-1 mt-2 sm:mt-0">Искать</button>
        </div>
      `;

      const moreBtnRec = document.createElement('button');
      moreBtnRec.textContent = 'Аннотация от Дианы';
      moreBtnRec.className = 'btn bg-indigo-600 text-white text-xs px-2 py-1 mt-2 sm:mt-0 hover:bg-indigo-700';
      moreBtnRec.addEventListener('click', () => showBookSummary(bk));

      const rightCont = div.querySelector('.flex.flex-col.sm\\:flex-row');
      if (rightCont) rightCont.appendChild(moreBtnRec);
      div.querySelector('.add-fav').addEventListener('click', () => {
        addToFavorites(bk);
        div.querySelector('.add-fav').textContent = 'В избранном ✓';
      });

      div.querySelector('.search-lib').addEventListener('click', () => {
        openRealOpacSearch(bk.title);
      });

      recommendationsGrid.appendChild(div);
    });
  }

  // ---------- OPAC-поиск (реальный/фейковый) ----------
  async function openRealOpacSearch(title = '') {
    if (!title) return;

    let popup = $('realOpacPopup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'realOpacPopup';
      popup.className = 'fixed inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center z-90 p-4';
      popup.style.overflow = 'hidden';
      popup.innerHTML = `
        <div class="flex flex-col items-center mb-6 mt-10">
          <img src="dainaload.jpg" class="w-20 h-20 rounded-full mb-4" alt="Диана">
          <h2 id="searchStatus" class="text-white text-2xl font-semibold mb-4 text-center">Ищу: "${escapeHtml(title)}"</h2>
          <button id="closeRealOpac" class="px-4 py-2 bg-indigo-600 rounded text-white hover:bg-indigo-700">Закрыть</button>
        </div>
        <ul id="realOpacList" class="flex flex-col items-center justify-center w-full max-h-[60vh] overflow-y-auto text-center text-white"></ul>
        <div id="realOpacPagination" class="flex gap-2 mt-4 justify-center"></div>
      `;
      document.body.appendChild(popup);
      $('closeRealOpac')?.addEventListener('click', () => popup.classList.add('hidden'));
    } else {
      popup.classList.remove('hidden');
    }

    const listContainer = $('realOpacList');
    const paginationContainer = $('realOpacPagination');
    const searchStatus = $('searchStatus');
    if (!listContainer || !paginationContainer || !searchStatus) return;
    listContainer.innerHTML = '';
    paginationContainer.innerHTML = '';

    const books = [];
    const PAGE_SIZE_OPAC = 5;
    let currentPageOpac = 1;

    const services = [
      {
        name: 'Google Books',
        url: buildGoogleBooksUrl({ q: title, startIndex: 0, maxResults: 20, langRestrict: 'ru' }),
        parser: data => {
          if (!data || !data.items) return [];
          return data.items.map(b => {
            const vi = b.volumeInfo || {};
            return {
              title: vi.title,
              author: (vi.authors || []).join(', ') || 'Неизвестный автор',
              link: vi.infoLink || '#',
              source: 'Google Books'
            };
          });
        }
      },
      {
        name: 'Гутенберг',
        url: `https://gutendex.com/books?search=${encodeURIComponent(title)}`,
        parser: data => {
          if (!data || !data.results) return [];
          return data.results.map(b => ({
            title: b.title,
            author: (b.authors?.map(a => a.name) || []).join(', ') || 'Неизвестный автор',
            link: b.formats ? (b.formats['text/html'] || '#') : '#',
            source: 'Гутенберг'
          }));
        }
      },
      {
        name: 'Bookmate (фоллбек)',
        url: `https://api.bookmate.com/v2/search?q=${encodeURIComponent(title)}&type=book&limit=20`,
        parser: data => {
          if (!data || !data.items) return [];
          return data.items.map(b => ({
            title: b.title,
            author: b.authors?.join(', ') || 'Неизвестный автор',
            link: b.url || '#',
            source: 'Bookmate'
          }));
        }
      }
    ];

    for (const service of services) {
      searchStatus.textContent = `Ищу книгу в ${service.name}...`;
      try {
        const res = await fetch(service.url);
        const data = await res.json();
        const parsed = service.parser(data);
        books.push(...parsed);
      } catch (err) {
        console.error(`Ошибка при поиске в ${service.name}:`, err);
      }
    }

    function renderPage(page) {
      listContainer.innerHTML = '';
      const start = (page - 1) * PAGE_SIZE_OPAC;
      const pageBooks = books.slice(start, start + PAGE_SIZE_OPAC);
      pageBooks.forEach(b => {
        const li = document.createElement('li');
        li.className = 'mb-3';
        // build safe link element
        const a = document.createElement('a');
        a.href = b.link || '#';
        a.target = '_blank';
        a.className = 'text-indigo-400 hover:underline font-medium';
        a.textContent = b.title || 'Без названия';
        const meta = document.createElement('span');
        meta.className = 'text-gray-300';
        meta.textContent = ` — ${b.author || 'Неизвестный автор'}`;

        li.appendChild(a);
        li.appendChild(meta);

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '💾 Сохранить ссылку';
        saveBtn.className = 'ml-2 px-2 py-1 bg-indigo-600 text-white rounded text-xs hover:bg-indigo-700';
        saveBtn.addEventListener('click', () => {
          saveBtn.classList.add('scale-110');
          setTimeout(() => saveBtn.classList.remove('scale-110'), 150);
          saveLink({ title: b.title, author: b.author, url: b.link, source: b.source });
        });

        li.appendChild(saveBtn);
        listContainer.appendChild(li);
      });

      paginationContainer.innerHTML = '';
      const totalPagesLocal = Math.ceil(books.length / PAGE_SIZE_OPAC) || 1;
      if (totalPagesLocal <= 1) {
        searchStatus.textContent = `Результаты поиска для: "${escapeHtml(title)}"`;
        return;
      }

      const prev = document.createElement('button');
      prev.textContent = '← Назад';
      prev.className = `px-3 py-1 bg-gray-700 text-white rounded ${page === 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`;
      prev.disabled = page === 1;
      prev.addEventListener('click', () => {
        if (currentPageOpac > 1) {
          currentPageOpac--;
          renderPage(currentPageOpac);
        }
      });
      paginationContainer.appendChild(prev);

      for (let i = 1; i <= totalPagesLocal; i++) {
        const btn = document.createElement('button');
        btn.textContent = i;
        btn.className = `px-3 py-1 rounded ${i === page ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-white hover:bg-gray-600'}`;
        btn.addEventListener('click', () => {
          currentPageOpac = i;
          renderPage(currentPageOpac);
        });
        paginationContainer.appendChild(btn);
      }

      const next = document.createElement('button');
      next.textContent = 'Вперёд →';
      next.className = `px-3 py-1 bg-gray-700 text-white rounded ${page === totalPagesLocal ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`;
      next.disabled = page === totalPagesLocal;
      next.addEventListener('click', () => {
        if (currentPageOpac < totalPagesLocal) {
          currentPageOpac++;
          renderPage(currentPageOpac);
        }
      });
      paginationContainer.appendChild(next);

      searchStatus.textContent = `Результаты поиска для: "${escapeHtml(title)}"`;
    }

    renderPage(currentPageOpac);
  }

  // ---------- Аннотации Дианы (OpenRouter) ----------
  async function showBookSummary(book) {
    if (!book || !book.title) return;

    // ---------- Подготовка UI попапа ----------
    const existing = document.getElementById('bookSummaryPopup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.id = 'bookSummaryPopup';
    popup.className = `
      fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-90 p-4
      overflow-auto
    `;

    const container = document.createElement('div');
    container.className = `
      bg-gray-900 text-gray-100 rounded-lg p-4 sm:p-6 max-w-3xl w-full
      shadow-lg flex flex-col gap-4 relative
    `;

    container.innerHTML = `
      <button id="closeSummaryBtn" class="absolute top-3 right-3 text-gray-400 hover:text-white
        bg-transparent border-none text-lg cursor-pointer">✕</button>

      <div class="flex flex-col sm:flex-row items-start gap-4">
        <img src="dainaload.jpg" alt="Диана" class="w-12 h-12 rounded-full border border-gray-700 flex-shrink-0">
        <div class="flex-1">
          <h3 class="text-lg font-semibold">${escapeHtml(book.title)}</h3>
          <p class="text-sm text-gray-300">${escapeHtml(book.author || (Array.isArray(book.author_name) ? book.author_name.join(', ') : 'Неизвестный автор'))}</p>
        </div>
      </div>

      <div id="summaryContent" class="text-gray-200 text-sm leading-relaxed mt-2
        max-h-[60vh] overflow-y-auto p-2 border border-gray-700 rounded">
        <div class="animate-pulse text-gray-400">⏳ Диана формирует аннотацию...</div>
      </div>
    `;

    popup.appendChild(container);
    document.body.appendChild(popup);
    document.getElementById('closeSummaryBtn')?.addEventListener('click', () => popup.remove());
    const summaryDiv = document.getElementById('summaryContent');

    // ---------- Где может жить ключ: проверяем несколько мест ----------
    const keyCandidates = [
      window?.QWEN_API_KEY,
      window?.QWEN_KEY,
      localStorage.getItem('QWEN_API_KEY'),
      localStorage.getItem('QWEN_KEY')
    ];
    const QWEN_KEY = (keyCandidates.find(k => k && String(k).trim()) || '').toString().trim();

    // Если ключа нет — используем локальный фолбэк (без запроса к OpenRouter)
    if (!QWEN_KEY) {
      // Формируем локальную краткую аннотацию (переводим при необходимости)
      try {
        let desc = book.description || (book._rawVolume?.volumeInfo?.description || '') || '';
        const combined = `${book.title} ${book.author || ''} ${desc}`;
        const hasCyr = /[а-яё]/i.test(combined);
        if (!hasCyr && desc) {
          // переводим описание на русский (кэшированно)
          try {
            desc = await translateToRussianCached(desc);
          } catch (tErr) {
            console.warn('Ошибка перевода описания (фолбэк):', tErr);
          }
        }

        const shortDesc = desc ? desc.split('\n').slice(0, 6).join('\n') : 'Описание временно недоступно.';
        const authorText = book.author || (Array.isArray(book.author_name) ? book.author_name.join(', ') : '');

        summaryDiv.innerHTML = `
          <h4 class="font-semibold text-indigo-400 mb-2">Короткая аннотация (локально)</h4>
          <p class="mb-2">${escapeHtml(shortDesc)}</p>
          <h4 class="font-semibold text-indigo-400 mb-1">Инфо</h4>
          <p class="mb-2">Автор: ${escapeHtml(authorText || 'Неизвестен')}</p>
          <p class="mb-2 text-gray-400">🔑 Для расширенной аннотации подключите ключ OpenRouter (QWEN API key).</p>
        `;
      } catch (err) {
        console.error('Ошибка формирования локальной аннотации:', err);
        summaryDiv.innerHTML = `<p class="text-red-400">⚠️ Не удалось сформировать аннотацию локально.</p>`;
      }
      return;
    }

    // ---------- Если ключ есть — готовим и отправляем запрос в OpenRouter ----------
    const controller = new AbortController();
    const timeoutMs = 25000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const model = (window?.QWEN_MODEL || "qwen/qwen3-235b-a22b:free").toString();

      const systemMessage = {
        role: "system",
        content: `
Ты — Диана, библиотечный ИИ-библиотекарь. Дай структурированную аннотацию книги.
Требования:
- Только фактические данные: аннотация, краткий пересказ сюжета, анализ (несколько предложений), 2-3 цитаты.
- Не добавлять фразы "Я думаю", "Моя мысль", "<think>" и т.п.
- Форматируй: заголовки, абзацы, цитаты.
- Отвечай на русском.
`.trim()
      };

      const userMessage = {
        role: "user",
        content: `Составь аннотацию книги:
Название: "${book.title}"
Автор: "${book.author || (Array.isArray(book.author_name) ? book.author_name.join(', ') : '')}"
Если нужно — используй доступные данные об описании и кратко поясни сюжет, анализ и приведи 2 цитаты.`
      };

      const body = {
        model,
        messages: [systemMessage, userMessage],
        max_tokens: 1600,
        temperature: 0.2
      };

      const resp = await fetch(QWEN_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${QWEN_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (resp.status === 401) {
        console.error('OpenRouter 401 Unauthorized — проверьте QWEN API key');
        summaryDiv.innerHTML = `
          <p class="text-red-400">⚠️ Ошибка авторизации (401) при запросе аннотации. Проверьте ваш OpenRouter API key.</p>
          <p class="text-gray-400 mt-2">Временно показываем локальную аннотацию.</p>
        `;
        try {
          let desc = book.description || (book._rawVolume?.volumeInfo?.description || '') || '';
          if (!/[а-яё]/i.test(desc) && desc) {
            desc = await translateToRussianCached(desc);
          }
          summaryDiv.innerHTML += `<p class="mt-3">${escapeHtml(shortenWords(desc || 'Описание недоступно.', 80))}</p>`;
        } catch (tErr) {
          console.warn('Ошибка перевода описания при 401:', tErr);
        }
        return;
      }

      if (!resp.ok) {
        let errText = '';
        try {
          const t = await resp.text();
          errText = t ? `: ${t}` : '';
        } catch (e) {
          errText = '';
        }
        throw new Error(`OpenRouter API error ${resp.status}${errText}`);
      }

      const data = await resp.json();

      const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
      if (!content) {
        throw new Error('Пустой ответ от OpenRouter.');
      }

      let text = String(content)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\b(Я думаю|Моя мысль|В моем понимании|I think|My thought)\b/gi, '')
        .trim();

      const formatted = text.split('\n').filter(Boolean).map(p => {
        const trimmed = p.trim();
        if (trimmed.startsWith('"') || /^«/.test(trimmed) || trimmed.toLowerCase().startsWith('цитата')) {
          return `<blockquote class="border-l-2 border-indigo-600 pl-3 italic text-gray-300 mb-2">${escapeHtml(trimmed)}</blockquote>`;
        }
        if (/^(Аннотация|Сюжет|Анализ|Выдержки|Цитаты)/i.test(trimmed)) {
          return `<h4 class="font-semibold text-indigo-400 mb-1">${escapeHtml(trimmed)}</h4>`;
        }
        return `<p class="mb-2">${escapeHtml(trimmed)}</p>`;
      }).join('');

      summaryDiv.innerHTML = formatted;

    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('Запрос к OpenRouter прерван по таймауту.', err);
        summaryDiv.innerHTML = `<p class="text-red-400">⚠️ Превышено время ожидания ответа от сервиса аннотаций. Попробуйте позже.</p>`;
        return;
      }

      console.error('Ошибка при получении аннотации от OpenRouter:', err);
      summaryDiv.innerHTML = `<p class="text-red-400">⚠️ Ошибка при получении аннотации: ${escapeHtml(err.message || String(err))}</p>`;
    } finally {
      try { clearTimeout(timeout); } catch (e) {}
    }
  }

  // ---------- Подсказки Дианы ----------
  const dianaTips = [
    "Заполняйте полное Ф.И.О автора для точного поиска",
    "Используйте автозаполнение при вводе имени автора",
    "Вы можете искать книги по названию и жанру одновременно",
    "Книги в избранном сохраняются между сеансами",
    "Используйте фильтры по настроению или теме для поиска",
    "Временная линия позволяет проследить историю литературы",
    "На литературной карте отображаются страны авторов и событий",
    "Интерактивные карточки книг показывают обложку, автора и аннотацию",
    "Попап с цитатами и анализом появляется при клике на 'Подробнее'",
    "Добавляйте книги в избранное, чтобы увидеть статистику"
  ];

  let tipsInterval;
  let tipsDisabled = false;

  function showDianaTip(message) {
    if (tipsDisabled || !document.body) return;

    const tipDiv = document.createElement('div');
    tipDiv.className = 'fixed bottom-4 left-4 flex items-start z-50 animate-slideIn';
    tipDiv.style.gap = '8px';

    const avatar = document.createElement('img');
    avatar.src = 'dainaload.jpg';
    avatar.alt = 'Диана';
    avatar.style.width = '96px';
    avatar.style.height = '96px';
    avatar.style.borderRadius = '50%';
    avatar.style.border = '3px solid #8b5cf6';
    avatar.style.flexShrink = '0';
    avatar.style.animation = 'jump 0.5s ease-out';

    const bubble = document.createElement('div');
    bubble.style.background = '#fff';
    bubble.style.color = '#111';
    bubble.style.padding = '16px 22px';
    bubble.style.borderRadius = '12px';
    bubble.style.boxShadow = '0 6px 20px rgba(0,0,0,0.2)';
    bubble.style.maxWidth = '360px';
    bubble.style.fontSize = '1rem';
    bubble.style.position = 'relative';
    bubble.style.lineHeight = '1.3';

    const triangle = document.createElement('div');
    triangle.style.position = 'absolute';
    triangle.style.left = '-12px';
    triangle.style.top = '32px';
    triangle.style.width = '0';
    triangle.style.height = '0';
    triangle.style.borderTop = '12px solid transparent';
    triangle.style.borderBottom = '12px solid transparent';
    triangle.style.borderRight = '12px solid #fff';
    bubble.appendChild(triangle);

    // безопасная вставка message + кнопки отключения подсказок
    const msgDiv = document.createElement('div');
    msgDiv.textContent = message;
    const disableBtn = document.createElement('button');
    disableBtn.className = 'disable-tips';
    disableBtn.style.marginTop = '6px';
    disableBtn.style.fontSize = '0.85rem';
    disableBtn.style.textDecoration = 'underline';
    disableBtn.style.background = 'none';
    disableBtn.style.border = 'none';
    disableBtn.style.cursor = 'pointer';
    disableBtn.style.color = '#1f2937';
    disableBtn.textContent = 'Отключить подсказки';

    bubble.appendChild(msgDiv);
    bubble.appendChild(disableBtn);

    tipDiv.appendChild(avatar);
    tipDiv.appendChild(bubble);
    document.body.appendChild(tipDiv);

    disableBtn.addEventListener('click', () => {
      tipsDisabled = true;
      clearInterval(tipsInterval);
      tipDiv.remove();
    });

    setTimeout(() => tipDiv.remove(), 12000);
  }

  function startDianaTips() {
    if (tipsDisabled) return;
    setTimeout(() => {
      showDianaTip(dianaTips[Math.floor(Math.random() * dianaTips.length)]);
      tipsInterval = setInterval(() => {
        showDianaTip(dianaTips[Math.floor(Math.random() * dianaTips.length)]);
      }, 60000);
    }, 15000);
  }

  function initDianaForBooks() {
    // Функция оставлена пустой, чтобы сохранить структуру, но без событий
  }

  function onBooksUpdated() {
    // Вызывается после рендера карточек книг — оставляем для совместимости
  }

  // ---------- Авторы (топ авторы, лайки) ----------
  const famousAuthors = [
    "Leo Tolstoy", "Fyodor Dostoevsky", "William Shakespeare", "Jane Austen",
    "Charles Dickens", "Ernest Hemingway", "George Orwell", "Agatha Christie",
    "Mark Twain", "J.K. Rowling", "Haruki Murakami", "Franz Kafka",
    "Gabriel Garcia Marquez", "Oscar Wilde", "Homer", "Victor Hugo",
    "Jules Verne", "Anton Chekhov", "Stephen King", "Emily Bronte",
    "Jack London", "Arthur Conan Doyle", "H. G. Wells", "Herman Melville",
    "Ray Bradbury", "Albert Camus", "George R. R. Martin", "Terry Pratchett",
    "Isaac Asimov", "Neil Gaiman"
  ];

  async function getAuthorImage(name) {
    try {
      const wikiResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`);
      if (wikiResponse.ok) {
        const wikiData = await wikiResponse.json();
        if (wikiData.thumbnail && wikiData.thumbnail.source) {
          return wikiData.thumbnail.source;
        }
      }
    } catch (err) {
      console.warn("Wikipedia fetch failed:", err);
    }

    try {
      const openLibResponse = await fetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}`);
      if (openLibResponse.ok) {
        const openLibData = await openLibResponse.json();
        if (openLibData.docs && openLibData.docs.length > 0 && openLibData.docs[0].photo_id) {
          return `https://covers.openlibrary.org/a/id/${openLibData.docs[0].photo_id}-M.jpg`;
        }
      }
    } catch (err) {
      console.warn("OpenLibrary fetch failed:", err);
    }

    try {
      const wikidataResponse = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(name)}&props=claims&format=json&origin=*`);
      if (wikidataResponse.ok) {
        const wikidata = await wikidataResponse.json();
        const entities = wikidata.entities;
        for (const key in entities) {
          const claims = entities[key].claims;
          if (claims && claims.P18 && claims.P18[0].mainsnak.datavalue) {
            const filename = claims.P18[0].mainsnak.datavalue.value;
            const imageUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;
            return imageUrl;
          }
        }
      }
    } catch (err) {
      console.warn("Wikidata fetch failed:", err);
    }

    return "https://via.placeholder.com/110x200?text=No+Image";
  }

  function getLikedAuthors() {
    return JSON.parse(localStorage.getItem('likedAuthors') || '[]');
  }

  function toggleAuthorLike(name, btn) {
    const liked = getLikedAuthors();
    const index = liked.indexOf(name);

    if (index === -1) {
      liked.push(name);
      btn.textContent = "❤️";
      btn.classList.add("liked");
    } else {
      liked.splice(index, 1);
      btn.textContent = "🤍";
      btn.classList.remove("liked");
    }

    localStorage.setItem('likedAuthors', JSON.stringify(liked));
  }

  async function loadTopAuthors() {
    const grid = document.getElementById("authorGrid");
    if (!grid) return;

    grid.innerHTML = "<p class='text-gray-500'>Загрузка авторов...</p>";

    const liked = getLikedAuthors();
    const cards = [];

    const shuffled = famousAuthors.sort(() => 0.5 - Math.random()).slice(0, 9);

    for (const author of shuffled) {
      const img = await getAuthorImage(author);
      const isLiked = liked.includes(author);
      const heart = isLiked ? "❤️" : "🤍";

      cards.push(`
        <div class="author-card">
          <span class="like-btn ${isLiked ? "liked" : ""}" data-author="${escapeHtml(author)}">${heart}</span>
          <img src="${img}" alt="${escapeHtml(author)}">
          <div class="author-name">${escapeHtml(author)}</div>
          <div class="author-genre">Великий писатель</div>
        </div>
      `);
    }

    grid.innerHTML = cards.join("");

    grid.querySelectorAll(".like-btn").forEach(btn => {
      btn.addEventListener('click', () => toggleAuthorLike(btn.dataset.author, btn));
    });
  }

  // ---------- Скрывать топ авторов при вводе поиска ----------
  const searchInput = document.getElementById('searchInput');
  const topAuthorsDiv = document.getElementById('topAuthors');
  if (searchInput && topAuthorsDiv) {
    searchInput.addEventListener('input', () => {
      if (searchInput.value.trim() !== '') {
        topAuthorsDiv.style.display = 'none';
      } else {
        topAuthorsDiv.style.display = 'grid';
      }
    });
  }

  // ---------- Автодополнение авторов (Google Books) ----------
  let suggestionTimeout;
  if (authorInput) {
    authorInput.addEventListener('input', () => {
      const q = authorInput.value.trim();
      if (!q) {
        toggleHidden(authorSuggestions, true);
        return;
      }

      clearTimeout(suggestionTimeout);
      suggestionTimeout = setTimeout(async () => {
        try {
          const url = buildGoogleBooksUrl({ q: `inauthor:${q}`, startIndex: 0, maxResults: 12, langRestrict: 'ru' });
          const res = await fetch(url);
          if (!res.ok) return;
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];

          // extract unique authors
          const authorsSet = new Set();
          items.forEach(it => {
            const auths = (it.volumeInfo && it.volumeInfo.authors) || [];
            auths.forEach(a => {
              if (a && a.toString().trim()) authorsSet.add(a.toString().trim());
            });
          });

          const authors = Array.from(authorsSet).slice(0, 5);

          if (!authors.length) {
            toggleHidden(authorSuggestions, true);
            return;
          }

          authorSuggestions.innerHTML = '';
          authors.forEach(a => {
            const li = document.createElement('li');
            li.textContent = a;
            li.className = 'cursor-pointer px-3 py-1 hover:bg-indigo-100';
            li.addEventListener('click', () => {
              authorInput.value = a;
              toggleHidden(authorSuggestions, true);
              currentPage = 1;
              searchBooks();
            });
            authorSuggestions.appendChild(li);
          });

          toggleHidden(authorSuggestions, false);
        } catch (err) {
          console.error(err);
          toggleHidden(authorSuggestions, true);
        }
      }, 300);
    });

    document.addEventListener('click', (e) => {
      if (!authorInput.contains(e.target) && !authorSuggestions.contains(e.target)) {
        toggleHidden(authorSuggestions, true);
      }
    });
  }

  // ---------- Авторская карточка (Wikipedia) ----------
  async function fetchAuthorInfo(name) {
    if (!name) return null;
    const langs = ['ru', 'en', 'de', 'fr'];
    const allowedKeywords = ['поэт', 'писатель', 'критик', 'романист', 'сценарист', 'поэтесса', 'литературовед'];

    for (const lang of langs) {
      try {
        const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        const desc = (json.description || '').toLowerCase();
        const isWriter = allowedKeywords.some(keyword => desc.includes(keyword));
        if (!isWriter) continue;

        if (json && (json.extract || json.description)) {
          return {
            title: json.title || name,
            summary: (json.extract || json.description || '').split('\n')[0],
            thumbnail: json.thumbnail ? json.thumbnail.source : null,
            lang
          };
        }
      } catch (e) {
        // try next language
      }
    }
    return null;
  }

  async function renderAuthorCardFromQuery(name) {
    if (!authorCard) return;
    authorCard.classList.add('opacity-50');
    const info = await fetchAuthorInfo(name);
    authorCard.classList.remove('opacity-50');
    if (!info) {
      authorCard.classList.add('hidden');
      authorCard.innerHTML = '';
      return;
    }
    authorCard.classList.remove('hidden');
    authorCard.innerHTML = `
      <div class="flex items-start gap-4 w-full">
        ${info.thumbnail ? `<img src="${info.thumbnail}" alt="${escapeHtml(info.title)}" class="w-20 h-20 object-cover rounded-md">` : ''}
        <div>
          <div class="text-lg font-semibold text-white">${escapeHtml(info.title)} ${info.lang ? `<span class="text-xs text-gray-200">(${escapeHtml(info.lang)})</span>` : ''}</div>
          <p class="text-sm text-white mt-1">${escapeHtml(shortenWords(info.summary, 32))}</p>
        </div>
      </div>
    `;
    authorCard.style.background = authorCard.style.background || 'linear-gradient(90deg,#6d28d9,#7c3aed)';
    authorCard.style.color = 'white';
    authorCard.style.borderRadius = '12px';
    authorCard.style.padding = '12px';
  }

  // ---------- Слушатели и инициализация ----------
  safeAddEvent(searchBtn, 'click', () => {
    currentPage = 1;
    searchBooks();
  });

  if (authorInput) {
    safeAddEvent(authorInput, 'keydown', e => {
      if (e.key === 'Enter') {
        currentPage = 1;
        searchBooks();
      }
    });
  }

  safeAddEvent(clearBtn, 'click', () => {
    if (authorInput) authorInput.value = '';
    if (bookGrid) bookGrid.innerHTML = '';
  });

  safeAddEvent(favoritesBtnHeader, 'click', () => {
    if (!favoritesPopup) {
      alert('Избранное:\n' + (favorites.map(f => `${f.title} — ${f.author}`).join('\n') || 'Пусто'));
      return;
    }
    favoritesPopup.classList.toggle('hidden');
    renderFavoritesList();
  });
  safeAddEvent(closeFavorites, 'click', () => {
    if (favoritesPopup) favoritesPopup.classList.add('hidden');
  });

  safeAddEvent(recommendationsBtn, 'click', () => {
    renderRecommendations();
    if (recommendationsPopup) recommendationsPopup.classList.remove('hidden');
  });
  safeAddEvent(closeRecommendations, 'click', () => {
    if (recommendationsPopup) recommendationsPopup.classList.add('hidden');
  });

  const linksBtn = document.getElementById('linksBtn');
  const linksPopup = document.getElementById('linksPopup');
  const closeLinks = document.getElementById('closeLinks');
  if (linksBtn && linksPopup && closeLinks) {
    linksBtn.addEventListener('click', () => {
      renderSavedLinks();
      try {
        linksPopup.classList.remove('hidden');
        linksPopup.style.zIndex = '99999';
        linksPopup.style.position = linksPopup.style.position || 'fixed';
      } catch (e) {}
    });
    closeLinks.addEventListener('click', () => {
      linksPopup.classList.add('hidden');
    });
  }

  safeAddEvent(dianaBot, 'click', () => {
    if (chatWindow) chatWindow.classList.toggle('hidden');
  });
  safeAddEvent(chatSend, 'click', sendChatMessage);
  safeAddEvent(document.getElementById('chatInput'), 'keydown', e => {
    if (e.key === 'Enter') sendChatMessage();
  });

  ensureChatCloseButton();

  // ---------- On load ----------
  document.addEventListener('DOMContentLoaded', () => {
    try { const ap = document.getElementById('annotationPopup'); if (ap) { ap.style.position='fixed'; ap.style.zIndex='100000'; } } catch(e){}
    updateFavCounter();
    renderFavoritesList();
    loadTopAuthors();
    loadBooks('subject:fiction'); // загрузка топ-книг (русские)
    try { initLoaderAnimation(); } catch(e) {}
    startDianaTips();
  });

  // ---------- Экспорт API для консоли / отладки ----------
  window.LA = {
    openRealOpacSearch,
    searchBooks,
    addToFavorites,
    removeFromFavorites,
    renderFavoritesList,
    renderRecommendations,
    openFakeOpacSearch: openRealOpacSearch
  };

  // ---------- Новый чат Дианы (OpenRouter) ----------
  (function initDianaChat() {
    const chatLog = document.getElementById("chatMessages");
    const chatInputLocal = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chatSend");

    if (!chatLog || !chatInputLocal || !sendBtn) return;

    function appendMessage(role, text) {
      const wrapper = document.createElement("div");
      wrapper.className = `flex items-end gap-2 mb-3 ${role === "user" ? "justify-end" : "justify-start"}`;
      if (role === "ai") {
        const avatar = document.createElement("img");
        avatar.src = "dainaload.jpg";
        avatar.alt = "Диана";
        avatar.className = "w-8 h-8 rounded-full border border-gray-300";
        wrapper.appendChild(avatar);
      }
      const bubble = document.createElement("div");
      bubble.className =
        role === "user" ?
        "bg-indigo-600 text-white rounded-2xl px-3 py-2 max-w-[75%] text-sm shadow-md" :
        "bg-gray-100 text-gray-800 rounded-2xl px-3 py-2 max-w-[75%] text-sm shadow-sm";
      bubble.textContent = text;
      wrapper.appendChild(bubble);
      chatLog.appendChild(wrapper);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    async function sendToDiana(message) {
      appendMessage("user", message);
      chatInputLocal.value = "";

      const placeholder = document.createElement("div");
      placeholder.className = "flex items-end gap-2 mb-3 justify-start";
      placeholder.innerHTML = `
        <img src="dainaload.jpg" alt="Диана" class="w-8 h-8 rounded-full border border-gray-300">
        <div class="bg-gray-100 text-gray-500 rounded-2xl px-3 py-2 text-sm animate-pulse">Диана думает...</div>
      `;
      chatLog.appendChild(placeholder);
      chatLog.scrollTop = chatLog.scrollHeight;

      try {
        const resp = await fetch(QWEN_API_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${window?.QWEN_API_KEY || ''}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: window?.QWEN_MODEL || "qwen/qwen3-235b-a22b:free",
            messages: [{
                role: "system",
                content: "Ты — Диана, библиотечный ИИ-ассистент. Отвечай дружелюбно и по существу."
              },
              {
                role: "user",
                content: message
              }
            ],
            max_tokens: 800
          })
        });

        let reply = "Диана не ответила.";
        if (resp.ok) {
          const data = await resp.json();
          reply = data.choices?.[0]?.message?.content?.trim() || reply;
        } else if (resp.status === 429) {
          reply = "⚠️ Слишком много запросов. Попробуйте позже.";
        } else {
          reply = `⚠️ Ошибка API: ${resp.status}`;
        }

        placeholder.remove();
        appendMessage("ai", reply);
      } catch (err) {
        placeholder.querySelector("div").textContent = "⚠️ Ошибка при обращении к Диане.";
        console.error(err);
      }
    }

    sendBtn.addEventListener("click", () => {
      const msg = chatInputLocal.value.trim();
      if (!msg) return;
      sendToDiana(msg);
    });

    chatInputLocal.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendBtn.click();
      }
    });
  })();

  // ---------- REST helpers (server favorites / annotations) ----------
  async function apiFetch(url, opts={}) {
    const token = localStorage.getItem('googleIdToken') || null;
    const headers = opts.headers || {};
    if (token && !headers['Authorization']) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    opts.headers = headers;
    const res = await fetch(url, opts);
    return res;
  }

  async function addBookToFavoritesServer(book) {
    const token = localStorage.getItem('googleIdToken');
    if (!token) {
      alert('Только авторизованные пользователи могут добавлять в избранное. Пожалуйста, войдите через Google.');
      return;
    }
    const payload = {
      isbn: book.id || book.isbn || book.book_id || '',
      title: book.title || '',
      authors: Array.isArray(book.authors) ? book.authors.join(', ') : (book.authors || ''),
      cover_url: book.cover || book.cover_url || ''
    };
    try {
      const res = await apiFetch('/api/favorites.php', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!json || !json.ok) {
        console.warn('favorites add response', json);
      }
    } catch (e) {
      console.error('addBookToFavoritesServer error', e);
    }
  }

  async function removeBookFromFavoritesServer(isbn) {
    const token = localStorage.getItem('googleIdToken');
    if (!token) {
      alert('Только авторизованные пользователи могут удалять из избранного.');
      return;
    }
    try {
      const url = '/api/favorites.php?isbn=' + encodeURIComponent(isbn);
      const res = await apiFetch(url, { method: 'DELETE' });
      const json = await res.json();
      if (!json || !json.ok) console.warn('remove response', json);
    } catch (e) {
      console.error('removeBookFromFavoritesServer error', e);
    }
  }

  async function fetchFavoritesServer() {
    const token = localStorage.getItem('googleIdToken');
    if (!token) return [];
    try {
      const res = await apiFetch('/api/favorites.php', { method: 'GET' });
      const json = await res.json();
      if (json && json.ok && Array.isArray(json.data)) return json.data;
    } catch (e) {
      console.error('fetchFavoritesServer error', e);
    }
    return [];
  }

  async function getAnnotationForBook(book) {
    const isbn = book.id || book.isbn || book.book_id || '';
    const title = book.title || '';
    const authors = Array.isArray(book.authors) ? book.authors.join(', ') : (book.authors || '');
    const cover = book.cover || book.cover_url || '';
    try {
      const url = '/api/annotations.php?isbn=' + encodeURIComponent(isbn) + '&title=' + encodeURIComponent(title) + '&authors=' + encodeURIComponent(authors) + '&cover_url=' + encodeURIComponent(cover);
      const res = await fetch(url);
      const json = await res.json();
      if (json && json.ok && json.data) return json.data.annotation;
      if (json && json.data && json.data.annotation) return json.data.annotation;
    } catch (e) {
      console.error('getAnnotationForBook error', e);
    }
    return null;
  }

  // Hook existing client functions (best-effort)
  if (window.addBookToFavorites) {
    const origAdd = window.addBookToFavorites;
    window.addBookToFavorites = function(book) {
      try { origAdd(book); } catch(e){}
      addBookToFavoritesServer(book);
    };
  } else {
    window.addBookToFavorites = addBookToFavoritesServer;
  }

  if (window.removeBookFromFavorites) {
    const origRem = window.removeBookFromFavorites;
    window.removeBookFromFavorites = function(id) {
      try { origRem(id); } catch(e) {}
      removeBookFromFavoritesServer(id);
    };
  } else {
    window.removeBookFromFavorites = removeBookFromFavoritesServer;
  }

  window.getAnnotationForBook = getAnnotationForBook;

  // === Конец основного скрипта ===

})(); 
// --- FORCE: загрузить 12 случайных русских книг при старте (override/fallback) ---
(function(){
  async function fetchCandidatesForTopics(topics = [], perTopic = 20) {
    const all = [];
    for (const t of topics) {
      try {
        const url = buildGoogleBooksUrl({ q: t, startIndex: 0, maxResults: perTopic, langRestrict: 'ru' });
        const res = await fetch(url);
        if (!res || !res.ok) continue;
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
          const vi = it.volumeInfo || {};
          const text = `${vi.title||''} ${vi.subtitle||''} ${(vi.authors||[]).join(' ')} ${vi.description||''}`;
          const hasCyr = /[а-яё]/i.test(text);
          // accept only items that are russian by metadata OR contain Cyrillic
          if ((vi.language && vi.language.toLowerCase() === 'ru') || hasCyr) {
            all.push(it);
          }
        }
      } catch (e) {
        console.warn('fetchCandidatesForTopics error for topic', t, e);
      }
    }
    return all;
  }

  async function ensureLoadRandomRussianBooks() {
    try {
      // if function already exists, call it (preferred)
      if (typeof loadRandomRussianBooks === 'function') {
        try { await loadRandomRussianBooks(); return; } catch(e) { console.warn('loadRandomRussianBooks failed, will fallback', e); }
      }

      // fallback: lightweight local implementation (does not rely on external patch)
      incLoader?.();
      showLoader?.(true);

      const topics = ['роман','русская литература','бестселлер','повесть','детектив','фантастика','поэзия','проза'];
      const candidates = await fetchCandidatesForTopics(topics, 20);

      // dedupe by id/title
      const seen = new Set();
      const unique = [];
      for (const it of candidates) {
        const id = (it.id || (it.volumeInfo && it.volumeInfo.title) || Math.random()).toString();
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(it);
      }

      if (!unique.length) {
        // если совсем пусто — оставляем стандартную загрузку как fallback
        try { loadBooks?.('subject:fiction'); } catch(e){ console.warn('fallback loadBooks failed', e); }
        return;
      }

      // shuffle
      for (let i = unique.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unique[i], unique[j]] = [unique[j], unique[i]];
      }

      // take 12 and convert to doc format expected by renderBooks
      const take = unique.slice(0, 12).map(it => {
        const vi = it.volumeInfo || {};
        return {
          title: vi.title || 'Без названия',
          author_name: vi.authors || [],
          description: vi.description || vi.subtitle || '',
          cover: (vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail)) || 'Diana.jpg',
          publishedDate: vi.publishedDate || '',
          language: vi.language || '',
          infoLink: vi.infoLink || '',
          _rawVolume: it
        };
      });

      // translate if needed (use existing translateToRussianCached if present)
      const processed = [];
      for (const d of take) {
        try {
          const vi = d._rawVolume?.volumeInfo || {};
          const lang = (vi.language || '').toLowerCase();
          const title = d.title || '';
          const desc = d.description || '';
          const authors = Array.isArray(d.author_name) ? d.author_name.join(', ') : (d.author_name || '');
          const containsRussian = /[а-яё]/i.test(title + desc + authors);

          if (typeof translateToRussianCached === 'function' && (lang !== 'ru' || !containsRussian)) {
            const [titleRu, descRu, authorsRu] = await Promise.all([
              translateToRussianCached(title || '') .catch(()=>title),
              translateToRussianCached(desc || '') .catch(()=>desc),
              translateToRussianCached(authors || '') .catch(()=>authors)
            ]);
            d.title = titleRu || d.title;
            d.description = descRu || d.description;
            d.author_name = (authorsRu && authorsRu.split(',').map(a => a.trim())) || d.author_name;
          }
        } catch (e) {
          console.warn('translation for candidate failed', e);
        }
        processed.push(d);
      }

      // render — replace grid
      try {
        renderBooks(processed);
      } catch (e) {
        console.error('renderBooks failed in ensureLoadRandomRussianBooks', e);
      }
    } catch (e) {
      console.error('ensureLoadRandomRussianBooks unexpected error', e);
    } finally {
      try { decLoader?.(); } catch(e){}
      try { showLoader?.(false); } catch(e){}
    }
  }

  // run after DOMContentLoaded, and again shortly after to override any competing init
  const runOnce = () => {
    try {
      ensureLoadRandomRussianBooks();
      // second attempt a bit later to override other inits that run after DOMContentLoaded
      setTimeout(() => { ensureLoadRandomRussianBooks(); }, 800);
    } catch(e) { console.warn(e); }
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // schedule on next tick
    setTimeout(runOnce, 120);
  } else {
    document.addEventListener('DOMContentLoaded', runOnce, { once: true });
  }
})();