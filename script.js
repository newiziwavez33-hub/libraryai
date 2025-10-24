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
   window.QWEN_API_KEY = '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';
   window.QWEN_MODEL = 'qwen/qwen3-235b-a22b:free';
  // ---------- Конфигурация ----------
  const PAGE_SIZE = 8; // элементов на страницу (используется для пагинации поиска)
  const GOOGLE_API_URL = 'https://www.googleapis.com/books/v1/volumes';
  const GOOGLE_API_KEY = ''; // При необходимости вставьте свой ключ (опционально)
  const QWEN_API_URL = "https://openrouter.ai/api/v1/chat/completions";
  const QWEN_API_KEY = "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";
  const QWEN_MODEL = "qwen/qwen3-235b-a22b:free";
  
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
// Также поддерживаем data URL or blob if needed (оставляем как URL).
async function cacheImageUrl(url, ttlMs = DEFAULT_IMG_CACHE_TTL) {
  try {
    // если url пустой — сразу возвращаем null
    if (!url) return null;

    // В некоторых случаях Google даёт https с query; используем точно тот же URL для cache key
    const resp = await cacheFetchResponse(url, ttlMs, 'la-img-cache');
    if (!resp || !resp.ok) return url; // вернём оригинал
    // Чтобы img мог использовать локальный cached response, лучший способ — просто вернуть оригинальный url:
    // браузер сам возьмёт его из HTTP-кэша/Cache Storage при совпадении.
    // Если нужен blob: можно вернуть blob URL, но тогда всё сложнее для повторного использования.
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
        <a href="${l.url}" target="_blank" class="text-indigo-400 hover:underline font-medium">${escapeHtml(l.title)}</a> — 
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
  <div class=\"la-loader-wrap\" role=\"status\" aria-live=\"polite\">\
    <div id=\"la-anim\" style=\"width:120px; height:120px; display:flex; align-items:center; justify-content:center; position:relative;\">\
      <svg class=\"la-svg la-hourglass\" viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\">\
        <g fill=\"none\" stroke=\"#fff\" stroke-width=\"2\">\
          <path d=\"M16 8h32M16 56h32\" stroke-linecap=\"round\"/>\
          <path d=\"M20 8v8c0 6 8 12 12 12s12-6 12-12V8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\
          <path d=\"M20 56v-8c0-6 8-12 12-12s12 6 12 12v8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\
        </g>\
      </svg>\
\
      <svg class=\"la-svg la-book\" viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\" style=\"opacity:0; position:absolute;\">\
        <g fill=\"none\" stroke=\"#fff\" stroke-width=\"2\">\
          <path d=\"M12 12h32v40H12z\" />\
          <path class=\"la-pages\" d=\"M44 12c4 0 6 1 8 3v34c-2 2-4 3-8 3\" stroke-linejoin=\"round\"/>\
        </g>\
      </svg>\
    </div>\
    <div class=\"la-loader-text\">Загрузка</div>\
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
  // ---------- Загрузка ТОП книг при старте (через Google Books, с переводом на русский) ----------
// ---------- Загрузка ТОП книг при старте (через Google Books, с переводом на русский) ----------
// ---------- Загрузка ТОП-книг при старте (через Google Books, с переводом на русский и fallback-популярными ключами) ----------
async function loadBooks(query = 'subject:fiction') {
  try {
    showLoader(true);

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
      const key = (item.volumeInfo.title + (item.volumeInfo.authors || []).join(',')).toLowerCase();
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
  // ---------- Поиск (Google Books) — поддержка Author / Title / ISBN, только RU, с безопасным переводом ----------
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
              if (imgEl.src && !imgEl.src.endsWith('Diana.jpg')) {
                imgEl.src = 'Diana.jpg';
              } else {
                // already Diana or failed; resolve anyway
              }
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
        author
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
      div.querySelector('.flex.flex-col.sm\\:flex-row').appendChild(moreBtnFav);

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
          <button class="btn search-lib bg-gray-300 text-white-800 text-xs px-2 py-1 mt-2 sm:mt-0">Искать</button>
        </div>
      `;

      const moreBtnRec = document.createElement('button');
      moreBtnRec.textContent = 'Аннотация от Дианы';
      moreBtnRec.className = 'btn bg-indigo-600 text-white text-xs px-2 py-1 mt-2 sm:mt-0 hover:bg-indigo-700';
      moreBtnRec.addEventListener('click', () => showBookSummary(bk));

      div.querySelector('.flex.flex-col.sm\\:flex-row').appendChild(moreBtnRec);
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
          <h2 id="searchStatus" class="text-white text-2xl font-semibold mb-4 text-center">Ищу в: 📚"${escapeHtml(title)}"</h2>
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
            link: b.formats['text/html'] || '#',
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
        li.innerHTML = `<a href="${b.link}" target="_blank" class="text-indigo-400 hover:underline font-medium">${escapeHtml(b.title)}</a> — <span class="text-gray-300">${escapeHtml(b.author)} (${escapeHtml(b.source)})</span>`;

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
  // ---------- Аннотация Дианы (с проверкой ключа и безопасным фолбэком) ----------
// ---------- Аннотация Дианы (QWEN3 через OpenRouter) ----------
// Требования выполнены:
// - Используется endpoint https://openrouter.ai/api/v1/chat/completions
// - Берёт ключ из window.QWEN_API_KEY или из localStorage ('QWEN_API_KEY')
// - Обрабатывает 401, другие ошибки и таймауты
// - При отсутствии ключа показывает безопасный локальный фолбэк (перевод описания)
// - Удаляет "<think>...</think>" и фразы "Я думаю" и т.п. из ответа
// - Очень подробные комментарии и аккуратная обработка ошибок
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
  // 1) window.QWEN_API_KEY (если кто-то положил прямо в глобал)
  // 2) localStorage.getItem('QWEN_API_KEY') — удобно, когда ключ введён через UI и сохранён
  // 3) window.QWEN_KEY (устаревший вариант) — проверим для обратной совместимости
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
  // Безопасность: ставим таймаут (AbortController) на 25 секунд — чтобы не вешать UI
  const controller = new AbortController();
  const timeoutMs = 25000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Подстраиваем модель. По умолчанию используем проверенный идентификатор (с :free если нужно)
    const model = (window?.QWEN_MODEL || "qwen/qwen3-235b-a22b:free").toString();

    // Система: чёткие правила (используем краткий строгий system prompt)
    const systemMessage = {
      role: "system",
      content: `
Ты — Диана, библиотечный ИИ-библиотекарь. Дай структурированную аннотацию книги.
Требования:
- Только фактические данные: аннотация, краткий пересказ сюжета, анализ (несколько предложений), 2-3 цитаты (если доступны).
- Не добавлять фразы "Я думаю", "Моя мысль", "<think>" и т.п.
- Форматируй: заголовки, абзацы, цитаты.
- Отвечай на русском.
`.trim()
    };

    // Пользовательское сообщение — можем добавить дополнительные указания, например длину
    const userMessage = {
      role: "user",
      content: `Составь аннотацию книги:
Название: "${book.title}"
Автор: "${book.author || (Array.isArray(book.author_name) ? book.author_name.join(', ') : '')}"
Если нужно — используй доступные данные об описании и кратко поясни сюжет, анализ и приведите 2 цитаты.`
    };

    // Собираем тело запроса (OpenAI-like)
    const body = {
      model,
      messages: [systemMessage, userMessage],
      max_tokens: 1600, // достаточно для длинной аннотации
      temperature: 0.2 // более детализированная, консервативная аннотация
    };

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${QWEN_API_KEY}`,
        "Content-Type": "application/json",
        // OpenRouter допускает дополнительные заголовки, но не обязательны
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    // Обработка ошибок статуса
    if (resp.status === 401) {
      // Неавторизованный — явно неверный ключ
      console.error('OpenRouter 401 Unauthorized — проверьте QWEN API key');
      summaryDiv.innerHTML = `
        <p class="text-red-400">⚠️ Ошибка авторизации (401) при запросе аннотации. Проверьте ваш OpenRouter API key.</p>
        <p class="text-gray-400 mt-2">Временно показываем локальную аннотацию.</p>
      `;
      // Вставляем локальную краткую аннотацию (из description) — не завершаем с ошибкой
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
      // Попытка получить тело ошибки: JSON или текст
      let errText = '';
      try {
        const t = await resp.text();
        errText = t ? `: ${t}` : '';
      } catch (e) {
        errText = '';
      }
      throw new Error(`OpenRouter API error ${resp.status}${errText}`);
    }

    // Обычный успешный путь — парсим JSON
    const data = await resp.json();

    // В OpenRouter ответ OpenAI-совместим → ищем data.choices[0].message.content
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
    if (!content) {
      throw new Error('Пустой ответ от OpenRouter.');
    }

    // Чистка: убираем возможности "мыслящего" формата и нежелательные фразы
    let text = String(content)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/\b(Я думаю|Моя мысль|В моем понимании|I think|My thought)\b/gi, '')
      .trim();

    // Минимальное форматирование: перевод строк в блоки, цитаты — в blockquote
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
    // Специальная обработка AbortError (таймаут) и прочих ошибок
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

    bubble.innerHTML += `
      <div>${escapeHtml(message)}</div>
      <button class="disable-tips" style="margin-top:6px; font-size:0.85rem; text-decoration:underline; background:none; border:none; cursor:pointer; color:#1f2937;">Отключить подсказки</button>
    `;

    tipDiv.appendChild(avatar);
    tipDiv.appendChild(bubble);
    document.body.appendChild(tipDiv);

    bubble.querySelector('.disable-tips').addEventListener('click', () => {
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
  // (раньше показывала всплывающую подсказку Дианы при наведении на карточку)
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
  // Теперь автодополнение использует Google Books (volumes) — собираем авторов из результатов.
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

  // ---------- Чат Дианы (локальная обёртка) ----------
  function ensureChatCloseButton() {
    if (!chatWindow) return;
    if (chatWindow.querySelector('.chat-close-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'chat-close-btn absolute top-2 right-3 text-white-600 hover:text-white-900';
    btn.textContent = '✕';
    btn.style.background = 'transparent';
    btn.style.border = 'none';
    btn.style.fontSize = '1.1rem';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', () => chatWindow.classList.add('hidden'));
    chatWindow.style.position = 'fixed';
    chatWindow.appendChild(btn);
  }

  function sendChatMessage() {
    const chatInput = document.getElementById('chatInput');
    const chatMessagesLocal = document.getElementById('chatMessages');
    if (!chatInput || !chatMessagesLocal) return;
    const txt = (chatInput.value || '').trim();
    if (!txt) return;
    const userDiv = document.createElement('div');
    userDiv.className = 'bg-indigo-100 text-indigo-900 text-sm px-3 py-2 rounded-lg w-fit ml-auto';
    userDiv.textContent = txt;
    chatMessagesLocal.appendChild(userDiv);
    chatInput.value = '';
    chatMessagesLocal.scrollTop = chatMessagesLocal.scrollHeight;

    setTimeout(() => {
      const botDiv = document.createElement('div');
      botDiv.className = 'bg-gray-100 text-gray-800 text-sm px-3 py-2 rounded-lg w-fit';
      botDiv.textContent = `Диана 🤖: Я получила ваше сообщение — "${txt}"`;
      chatMessagesLocal.appendChild(botDiv);
      chatMessagesLocal.scrollTop = chatMessagesLocal.scrollHeight;
    }, 600);
  }

  // ---------- Приветственный попап ----------
  function showWelcomePopup() {
    if (welcomePopupNode) {
      welcomePopupNode.classList.remove('hidden');
      safeAddEvent($('closeWelcome'), 'click', () => welcomePopupNode.classList.add('hidden'));
      setTimeout(() => welcomePopupNode.classList.add('hidden'), 30000);
      return;
    }

    const el = document.createElement('div');
    el.id = 'welcomePopup';
    el.className = 'fixed inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-60 text-white p-6';
    el.innerHTML = `
      <button id="closeWelcome" class="absolute top-4 right-6 text-white text-2xl font-bold hover:text-gray-300">✕</button>
      <img src="dainaload.jpg" alt="Диана" class="w-28 h-28 rounded-full mb-4">
      <h2 class="text-2xl font-semibold mb-2">👋 Добро пожаловать в LibraryAI!</h2>
      <p class="text-center mb-2">📚 Здесь ты можешь искать книги по авторам, ⭐ добавлять произведения в Избранное, 🔎 получать Рекомендации и 🤖 общаться с Дианой.</p>
      <p class="text-center text-sm">⚠️ Это демо-версия — некоторые функции ограничены.</p>
    `;
    document.body.appendChild(el);
    safeAddEvent($('closeWelcome'), 'click', () => el.remove());
    setTimeout(() => el.remove(), 10000);
  }

  // ---------- Инициализация событий ----------
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
      // ensure popup is above the book cards
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
  
// ---------- Приветственный попап ----------
function showWelcomePopupOverlay() {
  try { window._welcomeShownAt = Date.now(); } catch(e) {}
  try {
    const overlay = document.createElement('div');
    overlay.id = 'welcomeOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;text-align:center;';
    overlay.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
        <svg class="la-svg la-book" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="width:90px;height:90px;">
          <g fill="none" stroke="#fff" stroke-width="2">
            <path d="M12 12h32v40H12z" />
            <path class="la-pages" d="M44 12c4 0 6 1 8 3v34c-2 2-4 3-8 3" stroke-linejoin="round"/>
          </g>
        </svg>
        <div style="font-size:18px;font-weight:600;">Приветствуем Вас на сайте LibraryAi.ru</div>
        <div style="font-size:16px;">Загрузка...</div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = '@keyframes pageFlip {0%{transform:translateY(0) rotateX(0deg);}50%{transform:translateY(-6px) rotateX(12deg);}100%{transform:translateY(0) rotateX(0deg);}} .la-pages{transform-origin:left center;animation:pageFlip 1s ease-in-out infinite;}';
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    window.addEventListener('load', () => {
      overlay.style.transition = 'opacity 0.6s';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 700);
    });
  } catch(e) { console.warn('Welcome popup failed', e); }
}
try { showWelcomePopupOverlay(); } catch(e) {}



// /* injected: book-card z-index */
(function(){ try {
  const s = document.createElement('style');
  s.id = 'injected-bookcard-style';
  s.textContent = ".book-card{position:relative; z-index:5 !important;} #bookSummaryPopup, #realOpacPopup, #annotationPopup, #linksPopup, #welcomeOverlay, #searchPopup, #linksPopup { position: fixed !important; z-index: 100000 !important; } #loadingOverlay { position: fixed !important; z-index: 100001 !important; }";
  document.head.appendChild(s);
} catch(e){} })();


document.addEventListener('DOMContentLoaded', () => {
    try { const ap = document.getElementById('annotationPopup'); if (ap) { ap.style.position='fixed'; ap.style.zIndex='100000'; } const sp = document.getElementById('searchPopup'); if (sp) { sp.style.position='fixed'; sp.style.zIndex='100000'; } const lp = document.getElementById('linksPopup'); if (lp) { lp.style.position='fixed'; lp.style.zIndex='100000'; } } catch(e){}
    updateFavCounter();
    renderFavoritesList();
    loadTopAuthors();
    loadBooks('subject:fiction'); // загрузка топ-книг (русские)
    // приветствие при загрузке отключено по требованию
    // try { showWelcomePopup(); } catch (e) { /* ignore */ }
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
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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

})(); // IIFE end

// === PATCH: Улучшение логики приветственного popup ===
// Popup не исчезает, пока не прогрузятся все карточки книг с изображениями.

(function() {
  const welcomePopup = document.getElementById('welcomePopup') || document.getElementById('welcomeOverlay');
  if (!welcomePopup) return;

  // Принудительно показать popup при старте
  welcomePopup.style.opacity = '1';
  welcomePopup.style.display = 'flex';

  // Переопределяем tryHideWelcomeOverlay для контроля
  const _origTryHideWelcomeOverlay = window.tryHideWelcomeOverlay || function(){};

  window.tryHideWelcomeOverlay = function() {
    try {
      // Проверяем, все ли изображения в карточках книг прогрузились
      const imgs = Array.from(document.querySelectorAll('#bookGrid img.book-card-img'));
      if (imgs.length === 0) return; // нечего проверять
      const notLoaded = imgs.some(img => !img.complete || img.naturalWidth === 0);

      // Если есть незагруженные картинки или есть активные лоадеры — ждём
      if (notLoaded || (window._loaderCount || 0) > 0) {
        setTimeout(window.tryHideWelcomeOverlay, 500);
        return;
      }

      // Всё загружено — скрываем popup
      welcomePopup.style.transition = 'opacity 0.6s';
      welcomePopup.style.opacity = '0';
      setTimeout(() => {
        welcomePopup.remove();
      }, 700);
    } catch (e) {
      console.warn('Ошибка скрытия welcomePopup:', e);
      _origTryHideWelcomeOverlay();
    }
  };

  // Проверяем состояние каждые 500 мс, пока всё не готово
  window.addEventListener('load', () => setTimeout(window.tryHideWelcomeOverlay, 500));
})();

// === PATCH 2: Улучшение карточек, приветственного окна, лоадера и пагинации ===

// --- 1. Авторы в столбик, не более 4 ---
(function() {
  const origFormatAuthors = window.formatAuthors;
  window.formatAuthors = function(authors) {
    if (!authors) return 'Неизвестный автор';
    const list = Array.isArray(authors) ? authors.slice(0, 4) : [authors];
    return list.map(a => `<div>${a}</div>`).join('');
  };

  // перерисовка после обновления книг
  const origRenderBooks = window.renderBooks;
  window.renderBooks = async function(books = [], container) {
    await origRenderBooks(books, container);
    document.querySelectorAll('.book-author').forEach(el => {
      el.style.whiteSpace = 'pre-line';
      el.style.textAlign = 'center';
      el.style.lineHeight = '1.3';
    });
  };
})();

// --- 2. Приветственное окно с плавной анимацией ---
(function() {
  const popup = document.getElementById('welcomePopup') || document.getElementById('welcomeOverlay');
  if (popup) {
    popup.innerHTML = `
      <div style="text-align:center; color:white; font-size:1.5rem; font-weight:500; animation: fadeIn 1.5s ease-in;">
        📚 Подготовка библиотеки...
      </div>
    `;
    popup.style.background = 'rgba(0, 0, 0, 0.85)';
    popup.style.display = 'flex';
    popup.style.alignItems = 'center';
    popup.style.justifyContent = 'center';
    popup.style.transition = 'opacity 0.8s ease-in-out';
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fadeIn { from {opacity: 0;} to {opacity: 1;} }
    `;
    document.head.appendChild(style);
  }
})();

// --- 3. Улучшение лоадера: показываем счётчик загруженных карточек ---
(function() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  let counterText = document.createElement('div');
  counterText.id = 'la-progress-text';
  counterText.style.color = '#fff';
  counterText.style.fontSize = '1rem';
  counterText.style.marginTop = '8px';
  counterText.textContent = '';
  overlay.querySelector('.la-loader-wrap')?.appendChild(counterText);

  const origRenderBooks = window.renderBooks;
  window.renderBooks = async function(books = [], container) {
    if (books && books.length) {
      let loaded = 0;
      const total = books.length;
      const updateText = () => {
        const textEl = document.getElementById('la-progress-text');
        if (textEl) textEl.textContent = `Загружено ${loaded}/${total}`;
      };
      updateText();

      const imgs = Array.from(document.querySelectorAll('#bookGrid img.book-card-img'));
      imgs.forEach(img => {
        if (img.complete) {
          loaded++;
          updateText();
        } else {
          img.addEventListener('load', () => { loaded++; updateText(); });
          img.addEventListener('error', () => { loaded++; updateText(); });
        }
      });
    }
    await origRenderBooks(books, container);
  };
})();

// --- 4. Пагинация: плавное появление и hover-эффект ---
(function() {
  const origRenderPagination = window.renderPagination;
  window.renderPagination = function() {
    origRenderPagination();
    document.querySelectorAll('#pagination button, #paginationTop button').forEach(btn => {
      btn.style.transition = 'all 0.3s ease';
      btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.05)');
      btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');
    });
  };
})();

// === PATCH 3: Отображение popup загрузки при пагинации и загрузке рекомендаций/рейтинга ===

(function() {
  // --- 1. Лоадер при переключении страниц ---
  const origRenderPagination = window.renderPagination;
  window.renderPagination = function() {
    origRenderPagination();

    // Навешиваем событие на кнопки пагинации
    document.querySelectorAll('#pagination button, #paginationTop button').forEach(btn => {
      btn.addEventListener('click', () => {
        try { window.incLoader?.(); } catch(e) {}
        // На всякий случай, чтобы не застрял — убираем через 10 секунд
        setTimeout(() => { try { window.decLoader?.(); } catch(e) {} }, 10000);
      });
    });
  };

  // --- 2. Лоадер при загрузке рейтинговых книг ---
  const origLoadBooks = window.loadBooks;
  if (typeof origLoadBooks === 'function') {
    window.loadBooks = async function(query = 'subject:fiction') {
      try { window.incLoader?.(); } catch(e) {}
      try {
        await origLoadBooks(query);
      } finally {
        try { window.decLoader?.(); } catch(e) {}
      }
    };
  }

  // --- 3. Лоадер при загрузке рекомендаций ---
  const origRenderRecommendations = window.renderRecommendations;
  if (typeof origRenderRecommendations === 'function') {
    window.renderRecommendations = async function() {
      try { window.incLoader?.(); } catch(e) {}
      try {
        await origRenderRecommendations();
      } finally {
        try { window.decLoader?.(); } catch(e) {}
      }
    };
  }
})();

// === PATCH 4: Улучшенный popup загрузки и стили авторов ===
(function() {
  // --- 1. Улучшенный popup загрузки ---
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.innerHTML = `
      <div class="loader-modern">
        <div class="loader-ring"></div>
        <div class="loader-text">📖 Загружаю книги...</div>
        <div id="la-progress-text" class="loader-progress"></div>
      </div>
    `;
    overlay.style.background = 'rgba(10, 10, 15, 0.9)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.flexDirection = 'column';
    overlay.style.transition = 'opacity 0.6s ease-in-out';

    const style = document.createElement('style');
    style.textContent = `
      .loader-modern {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        animation: fadeIn 0.5s ease-in-out;
      }
      .loader-ring {
        width: 80px;
        height: 80px;
        border: 5px solid rgba(255, 255, 255, 0.2);
        border-top-color: #8b5cf6;
        border-radius: 50%;
        animation: spin 1.2s linear infinite;
      }
      .loader-text {
        color: #fff;
        font-size: 1.2rem;
        font-weight: 500;
        letter-spacing: 0.5px;
        text-shadow: 0 0 6px rgba(139, 92, 246, 0.8);
      }
      .loader-progress {
        color: #ccc;
        font-size: 0.95rem;
      }
      @keyframes spin { 0% { transform: rotate(0deg);} 100% { transform: rotate(360deg);} }
      @keyframes fadeIn { from { opacity: 0;} to { opacity: 1;} }
    `;
    document.head.appendChild(style);
  }

  // --- 2. Улучшенное отображение авторов в карточках ---
  const origFormatAuthors = window.formatAuthors;
  window.formatAuthors = function(authors) {
    if (!authors) return '<div>Неизвестный автор</div>';
    const list = Array.isArray(authors) ? authors.slice(0, 4) : [authors];
    return list.map(a => `<div class="book-author-line">${a}</div>`).join('');
  };

  const authorStyle = document.createElement('style');
  authorStyle.textContent = `
    .book-author-line {
      display: block;
      text-align: center;
      color: #4b5563;
      line-height: 1.35;
      font-size: 0.85rem;
      font-weight: 500;
      padding: 1px 0;
      transition: color 0.3s ease;
    }
    .book-author-line:hover {
      color: #8b5cf6;
    }
  `;
  document.head.appendChild(authorStyle);
})();

// === MINIPATCH v5: Увеличение минимального времени показа лоадера до 5s и показываем только первого автора в карточках ===
(function(){
  // 1) Минимальное время отображения лоадера (ms)
  const MIN_LOADER_MS = 5000;

  // Сохраняем оригинальные функции, если они есть
  const _origIncLoader = window.incLoader;
  const _origDecLoader = window.decLoader;

  // Текущее время последнего показа
  let _loaderShownAt = 0;
  // Флаг отложенного вызова dec
  let _pendingDec = null;

  // Переопределяем incLoader
  window.incLoader = function() {
    try {
      _loaderShownAt = Date.now();
      if (typeof _origIncLoader === 'function') _origIncLoader();
    } catch(e){ console.warn('incLoader override error', e); }
  };

  // Переопределяем decLoader с гарантией мин. времени отображения
  window.decLoader = function() {
    try {
      const now = Date.now();
      const elapsed = Math.max(0, now - (_loaderShownAt || 0));
      const remaining = Math.max(0, MIN_LOADER_MS - elapsed);

      // Если осталось время — отложим вызов оригинальной decLoader
      if (remaining > 0) {
        // если уже есть отложенный — не создаём лишний
        if (_pendingDec) return;
        _pendingDec = setTimeout(() => {
          try { if (typeof _origDecLoader === 'function') _origDecLoader(); } catch(e) { console.warn('decLoader delayed call error', e); }
          _pendingDec = null;
        }, remaining);
      } else {
        // иначе вызываем сразу
        if (typeof _origDecLoader === 'function') _origDecLoader();
      }
    } catch(e){ console.warn('decLoader override error', e); }
  };

  // 2) Отображаем в карточке только первого автора
  // Сохраним оригинал, если нужен
  const _origFormatAuthors = window.formatAuthors;
  window.formatAuthors = function(authors) {
    try {
      if (!authors) return 'Неизвестный автор';
      if (Array.isArray(authors)) {
        const first = authors[0] || '';
        return String(first).split(' ').slice(0, 4).join(' ') || 'Неизвестный автор';
      }
      // если строка
      if (typeof authors === 'string') {
        return authors.split(',')[0].split(' ').slice(0,4).join(' ') || 'Неизвестный автор';
      }
      return 'Неизвестный автор';
    } catch(e) {
      console.warn('formatAuthors override error', e);
      return _origFormatAuthors ? _origFormatAuthors(authors) : 'Неизвестный автор';
    }
  };

  // Небольшая коррекция: если в карточках уже есть элементы с классом .book-author-line, удалим их и заменим на простой текст
  function normalizeRenderedAuthors() {
    try {
      document.querySelectorAll('.book-card .book-author, .book-card .book-author-line').forEach(node => {
        // node may be container with HTML; replace with plain first author if available
        const parentCard = node.closest('.book-card');
        if (!parentCard) return;
        // try to read stored data-author attribute or fallback to innerText split
        let authorText = '';
        // prefer data attribute
        if (parentCard.dataset && parentCard.dataset.author) authorText = parentCard.dataset.author;
        if (!authorText) {
          // find any element that looks like author content
          const existing = parentCard.querySelector('.book-author, .book-author-line');
          if (existing) authorText = existing.innerText || existing.textContent || '';
        }
        // extract first author
        authorText = (authorText || '').split(/[,\n]/)[0] || '';
        if (!authorText) {
          // try to find from other markup (like button handlers)
          const textNodes = Array.from(parentCard.querySelectorAll('p,div,span'));
          for (const tn of textNodes) {
            const t = (tn.innerText||tn.textContent||'').trim();
            if (t && /[A-Za-zА-Яа-яЁё]/.test(t) && t.length < 60 && t.length > 1) {
              authorText = t; break;
            }
          }
        }
        // replace or set author element
        let authorEl = parentCard.querySelector('.book-author-simple');
        if (!authorEl) {
          authorEl = document.createElement('p');
          authorEl.className = 'book-author-simple text-xs text-gray-500 text-center';
          const old = parentCard.querySelector('.book-author, .book-author-line');
          if (old) old.replaceWith(authorEl);
          else parentCard.appendChild(authorEl);
        }
        authorEl.textContent = authorText || 'Неизвестный автор';
      });
    } catch(e) {
      console.warn('normalizeRenderedAuthors error', e);
    }
  }

  // Запускаем нормализацию после DOMContentLoaded и после любых рендеров книг (если есть global hook onBooksUpdated, используем)
  document.addEventListener('DOMContentLoaded', () => setTimeout(normalizeRenderedAuthors, 80));
  if (typeof window.onBooksUpdated === 'function') {
    const _origOnBooksUpdated = window.onBooksUpdated;
    window.onBooksUpdated = function() {
      try { normalizeRenderedAuthors(); } catch(e) {}
      try { return _origOnBooksUpdated(); } catch(e) {}
    };
  } else {
    // Fallback: observe mutations in bookGrid to normalize after new cards appended
    const grid = document.getElementById('bookGrid');
    if (grid && window.MutationObserver) {
      const mo = new MutationObserver(() => setTimeout(normalizeRenderedAuthors, 40));
      mo.observe(grid, { childList: true, subtree: true });
    }
  }

})();

// === MINIPATCH v6: popup загрузки фикс 5s и показ при пагинации/смене страниц ===
(function() {
  const MIN_VISIBLE_TIME = 5000;
  let overlay = null;
  let showTime = 0;
  let hideTimeout = null;

  function getOverlay() {
    if (!overlay) overlay = document.getElementById('loadingOverlay');
    return overlay;
  }

  // --- Показываем popup ---
  window.showLoadingOverlay = function() {
    const el = getOverlay();
    if (!el) return;
    el.style.display = 'flex';
    el.style.opacity = '1';
    showTime = Date.now();
    if (hideTimeout) clearTimeout(hideTimeout);
  };

  // --- Прячем popup с минимальным временем показа ---
  window.hideLoadingOverlay = function() {
    const el = getOverlay();
    if (!el) return;
    const elapsed = Date.now() - showTime;
    const remaining = Math.max(0, MIN_VISIBLE_TIME - elapsed);
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      el.style.transition = 'opacity 0.5s ease';
      el.style.opacity = '0';
      setTimeout(() => el.style.display = 'none', 500);
    }, remaining);
  };

  // --- Оборачиваем loadBooks и renderBooks ---
  const origLoadBooks = window.loadBooks;
  if (typeof origLoadBooks === 'function') {
    window.loadBooks = async function(...args) {
      window.showLoadingOverlay();
      try {
        return await origLoadBooks(...args);
      } finally {
        window.hideLoadingOverlay();
      }
    };
  }

  const origRenderBooks = window.renderBooks;
  if (typeof origRenderBooks === 'function') {
    window.renderBooks = async function(...args) {
      window.showLoadingOverlay();
      try {
        return await origRenderBooks(...args);
      } finally {
        window.hideLoadingOverlay();
      }
    };
  }

  // --- Также показываем popup при переключении страниц ---
  const origRenderPagination = window.renderPagination;
  if (typeof origRenderPagination === 'function') {
    window.renderPagination = function(...args) {
      origRenderPagination(...args);
      document.querySelectorAll('#pagination button, #paginationTop button')
        .forEach(btn => {
          btn.addEventListener('click', () => {
            window.showLoadingOverlay();
            setTimeout(() => window.hideLoadingOverlay(), MIN_VISIBLE_TIME + 300);
          });
        });
    };
  }

})();

// === PATCH v7: Popup загрузки ждёт полную загрузку сайта и карточек (мин. 5 сек) ===
(function () {
  const overlay = document.getElementById("loadingOverlay");
  if (!overlay) return;

  const MIN_VISIBLE_TIME = 5000; // минимальное время видимости (5с)
  let showTime = Date.now();
  let isHiding = false;

  // Показываем popup сразу при старте
  window.addEventListener("DOMContentLoaded", () => {
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
    showTime = Date.now();
  });

  // Проверка полной загрузки карточек
  async function waitForBookImages() {
    const grid = document.getElementById("bookGrid");
    if (!grid) return;

    // ждём пока карточки появятся
    const start = Date.now();
    while (grid.children.length === 0 && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const imgs = Array.from(grid.querySelectorAll("img"));
    if (imgs.length === 0) return;

    await Promise.all(
      imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener("load", resolve);
          img.addEventListener("error", resolve);
        });
      })
    );
  }

  async function hideWhenReady() {
    if (isHiding) return;
    isHiding = true;

    const elapsed = Date.now() - showTime;
    const remaining = Math.max(0, MIN_VISIBLE_TIME - elapsed);

    // ждём карточки и минимальное время
    await Promise.all([
      waitForBookImages(),
      new Promise((r) => setTimeout(r, remaining))
    ]);

    overlay.style.transition = "opacity 0.6s ease";
    overlay.style.opacity = "0";
    setTimeout(() => (overlay.style.display = "none"), 600);
  }

  // Скрываем popup после полной загрузки страницы
  window.addEventListener("load", hideWhenReady);

  // Также при рендере книг (динамическая подгрузка)
  const origRenderBooks = window.renderBooks;
  if (typeof origRenderBooks === "function") {
    window.renderBooks = async function (...args) {
      overlay.style.display = "flex";
      overlay.style.opacity = "1";
      showTime = Date.now();
      try {
        const result = await origRenderBooks(...args);
        await hideWhenReady();
        return result;
      } catch (err) {
        console.error("Ошибка рендера книг:", err);
        await hideWhenReady();
      }
    };
  }
})();


// === PATCH v8: Ensure loadingOverlay stays until min time and images loaded ===
(function(){
  const overlay = document.getElementById("loadingOverlay");
  if (!overlay) return;
  const MIN_VISIBLE_TIME = 5000;
  let showTime = 0;
  let hidingInProgress = false;

  // Helpers to show/hide using inline styles (more forceful)
  function forceShow() {
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
    showTime = Date.now();
  }
  function forceHideImmediate() {
    overlay.style.transition = "opacity 0.6s ease";
    overlay.style.opacity = "0";
    setTimeout(()=> { try{ overlay.style.display = "none"; }catch(e){} }, 600);
  }

  // Wrap existing window.showLoadingOverlay / hideLoadingOverlay if present
  const origShow = window.showLoadingOverlay;
  const origHide = window.hideLoadingOverlay;

  window.showLoadingOverlay = function(){
    try{
      forceShow();
    }catch(e){}
    if (typeof origShow === "function") {
      try{ origShow(); }catch(e){}
    }
  };

  window.hideLoadingOverlay = async function(){
    // Wait until min visible and images loaded
    try{
      const elapsed = Date.now() - (showTime || 0);
      const remaining = Math.max(0, MIN_VISIBLE_TIME - elapsed);
      // Wait remaining time
      await new Promise(r=>setTimeout(r, remaining));
      // Wait for book images
      const grid = document.getElementById("bookGrid");
      if (grid) {
        const start = Date.now();
        while (grid.children.length === 0 && Date.now() - start < 10000) {
          await new Promise(r=>setTimeout(r,100));
        }
        const imgs = Array.from(grid.querySelectorAll("img"));
        await Promise.all(imgs.map(img=>{
          if (img.complete) return Promise.resolve();
          return new Promise(r=> { img.addEventListener("load", r); img.addEventListener("error", r); });
        }));
      }
    }catch(e){}
    // finally hide (call original too)
    try{ forceHideImmediate(); }catch(e){}
    if (typeof origHide === "function") {
      try{ origHide(); }catch(e){}
    }
  };

  // Also wrap incLoader/decLoader to ensure showTime logic
  const origInc = window.incLoader;
  const origDec = window.decLoader;

  window.incLoader = function(){
    try{
      showTime = Date.now();
    }catch(e){}
    if (typeof origInc === "function") try{ origInc(); }catch(e){}
    // ensure visible
    try{ forceShow(); }catch(e){}
  };

  window.decLoader = function(){
    // call original first to maintain count
    if (typeof origDec === "function") {
      try{ origDec(); }catch(e){}
    }
    // then ensure overlay doesn't disappear prematurely by calling hideLoadingOverlay (which enforces waits)
    try{ window.hideLoadingOverlay(); }catch(e){}
  };

  // MutationObserver: if overlay gets hidden by other code prematurely, re-show until ready
  const mo = new MutationObserver(muts=>{
    try{
      const comp = window.getComputedStyle(overlay);
      if ((comp.display === "none" || comp.opacity === "0") && (Date.now() - showTime) < MIN_VISIBLE_TIME) {
        // re-show
        forceShow();
      }
    }catch(e){}
  });
  try{
    mo.observe(overlay, { attributes: true, attributeFilter: ["style", "class"] });
  }catch(e){}

  // Ensure initial show on DOMContentLoaded
  window.addEventListener("DOMContentLoaded", ()=> {
    try{ window.showLoadingOverlay(); }catch(e){}
  });
})();

// === PATCH v9: Увеличение времени отображения приветственного окна до 5 секунд ===
(function() {
  const welcomeOverlay = document.getElementById('welcomeOverlay');
  if (!welcomeOverlay) return;

  const MIN_VISIBLE_TIME = 5000; // 5 секунд минимум
  let showTime = Date.now();
  let alreadyHidden = false;

  // Фиксируем момент показа
  window.addEventListener('DOMContentLoaded', () => {
    if (welcomeOverlay.style.display !== 'flex') {
      welcomeOverlay.style.display = 'flex';
      welcomeOverlay.style.opacity = '1';
    }
    showTime = Date.now();
  });

  // Обновляем логику скрытия
  async function hideWelcomeOverlay() {
    if (alreadyHidden) return;
    alreadyHidden = true;
    const elapsed = Date.now() - showTime;
    const remaining = Math.max(0, MIN_VISIBLE_TIME - elapsed);
    await new Promise(r => setTimeout(r, remaining));
    welcomeOverlay.style.transition = 'opacity 0.8s ease';
    welcomeOverlay.style.opacity = '0';
    setTimeout(() => (welcomeOverlay.style.display = 'none'), 800);
  }

  // После загрузки всех картинок — скрываем, но учитываем таймер
  window.addEventListener('load', async () => {
    const imgs = Array.from(document.querySelectorAll('#bookGrid img'));
    if (imgs.length === 0) return hideWelcomeOverlay();

    await Promise.all(
      imgs.map(img =>
        img.complete
          ? Promise.resolve()
          : new Promise(res => {
              img.addEventListener('load', res);
              img.addEventListener('error', res);
            })
      )
    );
    hideWelcomeOverlay();
  });
})();

// === PATCH v10: Universal welcomeOverlay controller waiting for Google Books API and images (min 5s) ===
(function(){
  const MIN_VISIBLE = 5000;
  const welcome = document.getElementById('welcomeOverlay');
  if (!welcome) return;

  // Ensure inner structure: text + animated dots + ring
  (function ensureMarkup(){
    if (welcome.querySelector('.welcome-inner')) return;
    welcome.innerHTML = `
      <div class="welcome-inner">
        <div class="welcome-text">📚 Добро пожаловать! Загружаем книги<span class="welcome-dots"></span></div>
        <div class="welcome-ring" aria-hidden="true"></div>
      </div>
    `;
    // minimal styles if CSS not present
    const sId = 'welcome-inline-styles';
    if (!document.getElementById(sId)) {
      const style = document.createElement('style');
      style.id = sId;
      style.textContent = `
        #welcomeOverlay { display:flex; align-items:center; justify-content:center; z-index:9999; }
        #welcomeOverlay .welcome-inner { text-align:center; color:#fff; animation:fadeIn .6s ease; }
        #welcomeOverlay .welcome-text { font-size:1.4rem; font-weight:600; margin-bottom:12px; }
        #welcomeOverlay .welcome-dots::after { content: ' ...'; opacity:1; animation: dots 1s steps(4, end) infinite; }
        #welcomeOverlay .welcome-ring { width:56px; height:56px; border:6px solid rgba(255,255,255,0.12); border-top-color:#a78bfa; border-radius:50%; animation: spin 1s linear infinite; margin:0 auto; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes dots { 0% { content: ' .'; } 25% { content: ' ..'; } 50% { content: ' ...'; } 75% { content: ' ....'; } 100% { content: ' '; } }
        @keyframes fadeIn { from { opacity:0; transform:scale(.98); } to { opacity:1; transform:scale(1);} }
      `;
      document.head.appendChild(style);
    }
  })();

  // State tracking
  let apiPending = 0;
  let apiActive = false;
  let shownAt = Date.now();
  let hideScheduled = false;

  function showWelcome(){
    if (!welcome) return;
    welcome.style.display = 'flex';
    welcome.style.opacity = '1';
    shownAt = Date.now();
    hideScheduled = false;
  }

  function hideWelcomeSmooth(){
    if (!welcome) return;
    welcome.style.transition = 'opacity .6s ease';
    welcome.style.opacity = '0';
    setTimeout(()=> { try{ welcome.style.display='none'; }catch(e){} }, 650);
  }

  // Wait for images in grid
  async function waitForGridImages(timeoutMs=15000){
    const grid = document.getElementById('bookGrid');
    if (!grid) return;
    // wait for children
    const start = Date.now();
    while (grid.children.length === 0 && Date.now()-start < timeoutMs){
      await new Promise(r=>setTimeout(r,100));
    }
    const imgs = Array.from(grid.querySelectorAll('img'));
    if (imgs.length===0) return;
    await Promise.all(imgs.map(img=>{
      if (img.complete) return Promise.resolve();
      return new Promise(res=>{
        img.addEventListener('load', res, {once:true});
        img.addEventListener('error', res, {once:true});
      });
    }));
  }

  // Core hide logic: only hide when no api pending and images loaded and min time passed
  async function tryHide(){
    if (hideScheduled) return;
    if (apiPending>0) return;
    // ensure min visible
    const elapsed = Date.now() - shownAt;
    const waitMin = Math.max(0, MIN_VISIBLE - elapsed);
    hideScheduled = true;
    await Promise.all([ new Promise(r=>setTimeout(r, waitMin)), waitForGridImages() ]);
    // double-check no new api started
    if (apiPending>0) { hideScheduled=false; return; }
    // show done text briefly
    const textEl = welcome.querySelector('.welcome-text');
    if (textEl) textEl.textContent = '✅ Готово!';
    // stop ring animation
    const ring = welcome.querySelector('.welcome-ring');
    if (ring) ring.style.animation = 'none';
    // small delay then hide
    setTimeout(hideWelcomeSmooth, 600);
  }

  // Intercept fetch to detect Google Books API calls
  const origFetch = window.fetch;
  window.fetch = async function(input, init){
    try {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const isGoogle = typeof url==='string' && url.includes('googleapis.com/books');
      if (isGoogle){
        apiPending++; apiActive = true; showWelcome();
      }
      const res = await origFetch.apply(this, arguments);
      if (isGoogle){
        apiPending = Math.max(0, apiPending-1);
        setTimeout(tryHide, 0);
      }
      return res;
    } catch (e){
      // decrement if error
      apiPending = Math.max(0, apiPending-1);
      setTimeout(tryHide, 0);
      throw e;
    }
  };

  // Intercept XHR as well
  (function(){
    const XHR = window.XMLHttpRequest;
    if (!XHR) return;
    function newXHR(){
      const real = new XHR();
      real.addEventListener('readystatechange', function(){
        try{
          const url = real.responseURL || '';
          if (url && url.includes('googleapis.com/books')){
            if (real.readyState===1){ apiPending++; apiActive=true; showWelcome(); }
            if (real.readyState===4){ apiPending = Math.max(0, apiPending-1); setTimeout(tryHide,0); }
          }
        }catch(e){}
      }, false);
      return real;
    }
    window.XMLHttpRequest = newXHR;
  })();

  // Wrap likely functions names as fallback
  const fnNames = ['loadBooks','fetchBooks','getBooksFromGoogle','fetchBookInfo','searchBooks','renderBooks'];
  fnNames.forEach(name=>{
    const orig = window[name];
    if (typeof orig === 'function'){
      window[name] = async function(...args){
        // If google fetch not detected earlier, mark apiPending conservatively
        apiPending++; apiActive=true; showWelcome();
        try{
          const res = await orig.apply(this,args);
          return res;
        } finally {
          apiPending = Math.max(0, apiPending-1);
          setTimeout(tryHide,0);
        }
      };
    }
  });

  // Also wrap renderBooks specifically to wait for images
  if (typeof window.renderBooks === 'function'){
    const orig = window.renderBooks;
    window.renderBooks = async function(...args){
      // ensure welcome visible while rendering
      showWelcome();
      try{
        const res = await orig.apply(this,args);
        // after render, try hiding (will wait for images)
        setTimeout(tryHide,0);
        return res;
      } catch(e){ setTimeout(tryHide,0); throw e; }
    };
  }

  // initial show
  showWelcome();

  // safety: if nothing detected, still hide after 8s (but respecting MIN_VISIBLE)
  setTimeout(()=>{ setTimeout(tryHide,0); }, 8000);

})();

// === PATCH v11: Приветственное окно ждёт завершения Google Books API и загрузки карточек (минимум 5s) ===
(function () {
  const overlay = document.getElementById("welcomeOverlay");
  if (!overlay) return;

  const MIN_VISIBLE_TIME = 5000; // минимум 5 секунд
  let showTime = Date.now();
  let activeRequests = 0;
  let apiCompleted = false;

  // Helper: ensure overlay structure (text + ring)
  function ensureOverlayUI() {
    let textEl = overlay.querySelector(".welcome-text");
    let ringEl = overlay.querySelector(".loader-ring");
    if (!textEl) {
      textEl = document.createElement("div");
      textEl.className = "welcome-text";
      textEl.style.color = "white";
      textEl.style.fontSize = "1.6rem";
      textEl.style.fontWeight = "500";
      textEl.style.textAlign = "center";
      textEl.style.margin = "0 20px";
      textEl.innerText = "📚 Добро пожаловать! Загружаем книги";
      overlay.appendChild(textEl);
    }
    if (!ringEl) {
      ringEl = document.createElement("div");
      ringEl.className = "loader-ring";
      ringEl.style.marginTop = "16px";
      overlay.appendChild(ringEl);
    }
  }

  // === Показываем оверлей при загрузке страницы ===
  window.addEventListener("DOMContentLoaded", () => {
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    showTime = Date.now();
    ensureOverlayUI();
    startTextAnimation();
  });

  // === Перехват fetch для googleapis.com/books ===
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const url = args[0];
      if (typeof url === "string" && url.includes("googleapis.com/books")) {
        activeRequests++;
      }
      const res = await originalFetch.apply(this, args);
      return res;
    } finally {
      try {
        const url = args[0];
        if (typeof url === "string" && url.includes("googleapis.com/books")) {
          // decrement in next tick to allow promise chains to run
          setTimeout(() => {
            activeRequests = Math.max(0, activeRequests - 1);
            if (activeRequests === 0) {
              apiCompleted = true;
              checkHideOverlay();
            }
          }, 0);
        }
      } catch (e) {
        console.warn('fetch-wrap error', e);
      }
    }
  };

  // also wrap XMLHttpRequest open/send to catch older code if any
  try {
    const OrigXHR = window.XMLHttpRequest;
    function XHRProxy() {
      const xhr = new OrigXHR();
      const nativeOpen = xhr.open;
      let url = null;
      xhr.open = function(method, u) {
        url = u;
        return nativeOpen.apply(this, arguments);
      };
      const nativeSend = xhr.send;
      xhr.send = function() {
        try {
          if (typeof url === "string" && url.includes("googleapis.com/books")) {
            activeRequests++;
            xhr.addEventListener('loadend', function() {
              setTimeout(() => {
                activeRequests = Math.max(0, activeRequests - 1);
                if (activeRequests === 0) {
                  apiCompleted = true;
                  checkHideOverlay();
                }
              }, 0);
            });
          }
        } catch(e){}
        return nativeSend.apply(this, arguments);
      };
      return xhr;
    }
    XHRProxy.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = XHRProxy;
  } catch (e) {
    // ignore
  }

  // Ждём появления карточек и загрузки всех изображений
  async function waitForBookImages(timeout = 30000) {
    const grid = document.getElementById("bookGrid");
    if (!grid) return;
    const start = Date.now();
    while (grid.children.length === 0 && Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const imgs = Array.from(grid.querySelectorAll("img"));
    if (imgs.length === 0) return;
    await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => { img.addEventListener('load', res); img.addEventListener('error', res); })));
  }

  // Проверка и скрытие оверлея
  async function checkHideOverlay() {
    // если API ещё не завершился — ждём
    if (!apiCompleted) return;
    // Убедимся, что прошло минимум времени показа
    const elapsed = Date.now() - showTime;
    const remaining = Math.max(0, MIN_VISIBLE_TIME - elapsed);
    await new Promise(r => setTimeout(r, remaining));
    // Дождёмся картинок
    await waitForBookImages();
    // плавное скрытие
    overlay.style.transition = "opacity 0.8s ease";
    overlay.style.opacity = "0";
    setTimeout(() => { overlay.style.display = "none"; }, 800);
  }

  // При ручном рендере книг — перехватываем renderBooks если есть
  const origRenderBooks = window.renderBooks;
  if (typeof origRenderBooks === "function") {
    window.renderBooks = async function(...args) {
      // ensure overlay visible when rendering new page
      overlay.style.display = "flex";
      overlay.style.opacity = "1";
      showTime = Date.now();
      ensureOverlayUI();
      startTextAnimation();
      try {
        const res = await origRenderBooks.apply(this, args);
        // after render, if API already done trigger hide check
        if (activeRequests === 0) {
          apiCompleted = true;
          checkHideOverlay();
        }
        return res;
      } catch (e) {
        if (activeRequests === 0) {
          apiCompleted = true;
          checkHideOverlay();
        }
        throw e;
      }
    };
  }

  // Текстовая анимация точек
  function startTextAnimation() {
    const textEl = overlay.querySelector(".welcome-text");
    if (!textEl) return;
    let dots = 0;
    if (textEl._dotTimer) clearInterval(textEl._dotTimer);
    textEl._dotTimer = setInterval(() => {
      if (overlay.style.display === "none") { clearInterval(textEl._dotTimer); return; }
      dots = (dots + 1) % 4;
      textEl.innerText = "📚 Добро пожаловать! Загружаем книги" + ".".repeat(dots);
    }, 600);
  }

  // Deactivate loadingOverlay if present (hide it to avoid conflict)
  const loadingOverlay = document.getElementById("loadingOverlay");
  if (loadingOverlay) {
    loadingOverlay.style.display = "none";
  }

  // If page fully loads without any API calls, set a fallback hide after MIN_VISIBLE_TIME
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (activeRequests === 0) {
        apiCompleted = true;
        checkHideOverlay();
      }
    }, MIN_VISIBLE_TIME);
  });
// === PATCH v12: Расширенная поддержка API и увеличенный таймаут ===
(function () {
  const overlay = document.getElementById("welcomeOverlay");
  if (!overlay) return;
  const MIN_VISIBLE_TIME = 5000;
  const WAIT_TIMEOUT = 45000; // 45 сек ожидания карточек
  let showTime = Date.now();
  let activeRequests = 0;
  let apiCompleted = false;

  const apiPatterns = [
    "googleapis.com/books",
    "/api/books",
    "/books/search",
    "/books/popular",
    "/books/recommend",
    "/books/rating"
  ];

  const matchesAPI = (url) =>
    typeof url === "string" && apiPatterns.some((p) => url.includes(p));

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = args[0];
    if (matchesAPI(url)) activeRequests++;
    try {
      const response = await originalFetch.apply(this, args);
      return response;
    } finally {
      if (matchesAPI(url)) {
        setTimeout(() => {
          activeRequests = Math.max(0, activeRequests - 1);
          if (activeRequests === 0) {
            apiCompleted = true;
            checkHideOverlay();
          }
        }, 0);
      }
    }
  };

  async function waitForBookImages(timeout = WAIT_TIMEOUT) {
    const grid = document.getElementById("bookGrid");
    if (!grid) return;
    const start = Date.now();
    while (grid.children.length === 0 && Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const imgs = Array.from(grid.querySelectorAll("img"));
    if (imgs.length === 0) return;
    await Promise.all(
      imgs.map(
        (img) =>
          img.complete ||
          new Promise((res) => {
            img.addEventListener("load", res);
            img.addEventListener("error", res);
          })
      )
    );
  }

  async function checkHideOverlay() {
    if (!apiCompleted) return;
    const elapsed = Date.now() - showTime;
    const remaining = Math.max(0, MIN_VISIBLE_TIME - elapsed);
    await new Promise((r) => setTimeout(r, remaining));
    await waitForBookImages();
    overlay.style.transition = "opacity 0.8s ease";
    overlay.style.opacity = "0";
    setTimeout(() => (overlay.style.display = "none"), 800);
  }

  // fallback hide
  window.addEventListener("load", () => {
    setTimeout(() => {
      if (activeRequests === 0) {
        apiCompleted = true;
        checkHideOverlay();
      }
    }, MIN_VISIBLE_TIME);
  });
})();

})();
// === END PATCH v11 ===

// === CLIENT PATCH v18 (PHP backends) ===
// Helper to attach Google ID token if present
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

// Server favorites actions
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

// Diana annotations
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
