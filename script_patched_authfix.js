/* PATCH v2.2-authfix: robust auth.php handling to avoid 404 errors */
(function(){
  if (window.__la_authfix_installed) return;
  window.__la_authfix_installed = true;
  const _origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try {
      let url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (!url) return _origFetch(input, init);
      // If request targets auth.php (any path), try alternative endpoints to avoid 404.
      if (/auth\.php$/i.test(url) || /\/auth(\/|$)/i.test(url) && url.includes('auth')) {
        const candidates = [
          '/api/auth.php',
          '/api/google/auth.php',
          '/auth.php',
          '/api/auth/index.php',
          url
        ];
        for (const u of candidates) {
          try {
            const resp = await _origFetch(u, init);
            if (resp && resp.ok) {
              console.info('[LA authfix] used endpoint:', u);
              return resp;
            } else {
              // If 404, try next; for other 4xx/5xx, still try next but log.
              console.warn('[LA authfix] endpoint failed', u, resp && resp.status);
            }
          } catch (e) {
            console.warn('[LA authfix] fetch error for', u, e && e.message);
          }
        }
        // if all failed, return a simple 404-like Response to keep original behavior predictable
        return new Response(JSON.stringify({ error: 'auth endpoints not found' }), { status: 404, headers: { 'Content-Type':'application/json' }});
      }
    } catch (err) {
      console.warn('authfix wrapper error', err);
    }
    return _origFetch(input, init);
  };
})(); 
/* End PATCH v2.2-authfix */

// ---------------------------
// script.js (полная версия)
// ---------------------------

/*
  Этот скрипт объединяет:
  - поиск по OpenLibrary (8 книг / страница),
  - пагинацию (вверху и внизу),
  - локальное "Избранное" (localStorage),
  - Попап "Избранное" и "Рекомендации",
  - Приветственный попап с автозакрытием,
  - Фейковый OPAC-поиск (попап с анимацией и фразами),
  - Чат Дианы (с крестиком закрытия),
  - Защита от отсутствующих DOM-элементов.
*/

(() => {
    // ---------- Конфигурация ----------
    const PAGE_SIZE = 8;
    let savedLinks = JSON.parse(localStorage.getItem('la_savedLinks') || '[]');

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
      <a href="${l.url}" target="_blank" class="text-indigo-400 hover:underline font-medium">${l.title}</a> — 
      <span class="text-gray-300">${l.author} (${l.source})</span>
    `;
            container.appendChild(li);
        });
    }


    // ---------- DOM-узлы (берём, если есть) ----------
    const $ = id => document.getElementById(id);
    const authorInput = $('authorInput');
    const searchBtn = $('searchBtn');
    const clearBtn = $('clearBtn');
    const bookGrid = $('bookGrid');
    const pagination = $('pagination');
    const paginationTop = $('paginationTop');

    const QWEN_API_URL = "https://openrouter.ai/api/v1/chat/completions";
    const QWEN_API_KEY = "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";
    const QWEN_MODEL = "qwen/qwen3-235b-a22b:free";

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

    // fake search popup nodes: if not present in HTML, we'll create them on demand
    let fakePopupNode = $('fakeSearchPopup');
    let welcomePopupNode = $('welcomePopup');

    // ---------- Состояние ----------
    let currentPage = 1;
    let totalPages = 1;
    let lastQuery = '';
    let searchHistory = [];
    let favorites = JSON.parse(localStorage.getItem('la_favorites') || '[]');


    // ---------- Утилиты ----------
    function safeAddEvent(el, evt, handler) {
        if (el) el.addEventListener(evt, handler);
    }

    function toggleHidden(el, hidden) {
        if (!el) return;
        el.classList.toggle('hidden', !!hidden);
    }
    // ---------- Загрузка ТОП книг ----------------
    async function loadBooks(query = 'top') {
        const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=12`);
        const data = await res.json();
        renderBooks(data.docs);
    }

    function shortenWords(str, maxWords = 8) {
        if (!str) return '';
        const arr = str.trim().split(/\s+/);
        return arr.length <= maxWords ? arr.join(' ') : arr.slice(0, maxWords).join(' ') + '…';
    }
// ------ Формат Авторов -------------------------
  function formatAuthors(authors) {
  if (!authors || authors.length === 0) return 'Неизвестный автор';
  // Берем только первого автора, максимум 4 слова
  return authors[0].split(' ').slice(0, 4).join(' ');
}
    // ---------Рендер карточек и фильтр автора
    async function translateToRussian(text) {
  const response = await fetch('https://libretranslate.de/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'en',
      target: 'ru',
      format: 'text'
    })
  });
  const data = await response.json();
  return data.translatedText;
}

    function renderBooks(books) {
        const grid = document.getElementById('bookGrid');
        grid.innerHTML = '';

        books.forEach(b => {
            const cover = b.cover_i ?
                `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` :
                'https://via.placeholder.com/110x200?text=No+Cover';

            const title = truncateText(b.title || "Без названия", 8);
            const author = b.author_name && b.author_name.length > 0 ?
                truncateText(b.author_name.join(", "), 8) :
                "Автор неизвестен";

            const description = b.first_sentence ?
                truncateText(b.first_sentence, 8) :
                "Описание отсутствует";

            const card = document.createElement('div');
            card.className = `
      book-card bg-white rounded-2xl shadow-md hover:shadow-xl 
      transition transform hover:-translate-y-1 p-4 flex flex-col 
      items-center text-center
    `;
  
        card.innerHTML = `
  <img src="${cover}" alt="${b.title}">
  <div class="book-title">${shortenWords(b.title, 8)}</div>
  <div class="book-author">${formatAuthors(b.author_name)}</div>
  <div class="book-desc">${shortenWords(b.description, 8)}</div>
  <div class="book-actions">
    <button class="addFav">В избранное</button>
    <button class="moreInfo">Аннотация от Дианы</button>
  </div>
`;

            // Добавляем обработчики
            card.querySelector('.addFav').addEventListener('click', () => {
                alert(`Добавлено в избранное: ${b.title}`);
            });

            card.querySelector('.moreInfo').addEventListener('click', () => {
                alert(`Автор: ${author}\n\nНазвание: ${title}`);
            });

            grid.appendChild(card);
        });
    }



    function renderRecommendations(books) {
        const grid = document.getElementById('recommendationGrid');
        grid.innerHTML = '';

        books.forEach(b => {
            const cover = b.cover_i ?
                `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` :
                'https://via.placeholder.com/110x200?text=No+Cover';

            const card = document.createElement('div');
            card.className = 'book-card';
            card.innerHTML = `
      <img src="${cover}" alt="${b.title}">
      <div class="book-title">${shortenWords(b.title)}</div>
      <div class="book-author">${formatAuthors(b.author_name)}</div>
      <div class="book-actions">
        <button class="addFav">В избранное</button>
        <button class="moreInfo">Аннотация от Дианы</button>
      </div>
    `;

            card.querySelector('.addFav').addEventListener('click', () => {
                alert(`Добавлено в избранное: ${b.title}`);
            });

            card.querySelector('.moreInfo').addEventListener('click', () => {
                alert(`Автор: ${formatAuthors(b.author_name)}\n\nНазвание: ${b.title}`);
            });

            grid.appendChild(card);
        });
    }
    loadBooks(); // загрузка при старте


    // ---------- Лоадер ----------
    function showLoader(show = true) {
        if (!loadingOverlay) return;
        toggleHidden(loadingOverlay, !show);
    }

    // ---------- Поиск (OpenLibrary) ----------
    async function searchBooks() {
        if (!authorInput || !bookGrid) return;

        const query = (authorInput.value || '').trim();
        if (!query) {
            bookGrid.innerHTML = '<p class="text-gray-500 col-span-full text-center">Введите имя автора для поиска.</p>';
            return;
        }

        // Формируем URL для OpenLibrary
        let url = `https://openlibrary.org/search.json?author=${encodeURIComponent(query)}&page=${currentPage}&limit=${PAGE_SIZE}`;

        // Опциональные фильтры (жанр, язык, год)
        const genre = $('genreFilter')?.value || '';
        const language = $('languageFilter')?.value || '';
        const yearFrom = $('yearFrom')?.value || '';
        const yearTo = $('yearTo')?.value || '';

        if (genre) url += `&subject=${encodeURIComponent(genre)}`;
        if (language) url += `&language=${encodeURIComponent(language)}`;
        if (yearFrom) url += `&first_publish_year>=${yearFrom}`;
        if (yearTo) url += `&first_publish_year<=${yearTo}`;

        console.log('Fetching URL:', url); // отладка

        showLoader(true);

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Ошибка OpenLibrary: ${res.status}`);
            const data = await res.json();

            const docs = Array.isArray(data.docs) ? data.docs.slice(0, PAGE_SIZE) : [];
            totalPages = Math.max(1, Math.ceil((data.numFound || docs.length) / PAGE_SIZE));

            renderAuthorCardFromQuery(query);
            renderBooks(docs);
            renderPagination();

        } catch (err) {
            console.error('Ошибка поиска книг:', err);
            if (bookGrid) {
                bookGrid.innerHTML = '<p class="text-red-400 col-span-full text-center">Ошибка при загрузке книг.</p>';
            }
        } finally {
            showLoader(false);
        }
    }

    // ---------- Рендер карточек книг ----------
// Функция перевода с кешем
async function translateToRussianCached(text) {
  const cacheKey = `translate_${text}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch('https://libretranslate.de/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        source: 'en',
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

// Укорочивание текста до 8 слов
function shortenWords(text, maxWords = 8) {
  const words = text.split(' ');
  return words.length > maxWords ? words.slice(0, maxWords).join(' ') + '…' : text;
}

// Форматирование авторов (не больше 4 слов)
function formatAuthors(authors = []) {
  return authors.map(a => a.split(' ').slice(0, 4).join(' ')).join(', ');
}

// Рендер карточек с переводом
async function renderBooks(books) {
  const grid = document.getElementById('bookGrid');
  grid.innerHTML = '';

  for (const b of books) {
    const cover = b.cover_i
      ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg`
      : 'https://via.placeholder.com/110x200?text=No+Cover';

    // Переводим название книги
    const translatedTitle = await translateToRussianCached(b.title);
    const shortTitle = shortenWords(translatedTitle);

    const card = document.createElement('div');
    card.className = 'book-card';
    card.innerHTML = `
      <img src="${cover}" alt="${b.title}">
      <div class="book-title">${shortTitle}</div>
      <div class="book-author">${formatAuthors(b.author_name)}</div>
      <div class="book-actions">
        <button class="addFav">В избранное</button>
        <button class="moreInfo">Аннотация от Дианы</button>
        <button class="searchBook">Искать</button>
      </div>
    `;

    card.querySelector('.addFav').addEventListener('click', () => {
      alert(`Добавлено в избранное: ${b.title}`);
    });

    card.querySelector('.moreInfo').addEventListener('click', () => {
      alert(`Автор: ${formatAuthors(b.author_name)}\n\nНазвание: ${b.title}`);
    });

    card.querySelector('.searchBook').addEventListener('click', () => {
      alert(`Ищем информацию о книге: ${b.title}`);
    });

    grid.appendChild(card);
  }
}

    // ---------- Показ сводки книги ----------
    // ---------- Функция отображения аннотации книги ----------
    async function showBookSummary(book) {
        if (!book || !book.title) return;

        const systemMessage = {
            role: "system",
            content: `
    /no_think Ты — Диана, библиотечный ИИ-библиотекарь.
    Нужно дать **только**:
      - аннотацию книги,
      - краткий обзор сюжета,
      - краткий анализ,
      - цитаты из книги.
    Не добавляй никаких своих мыслей, комментариев, рассуждений, <think> или внутренних заметок.
    Не вставляй фразы вроде "Я думаю" или "Моя мысль".
    Форматируй текст красиво: абзацы, заголовки, цитаты.
    Всё, что генерируешь — строго по запросу книги. </no_think> /no_think
  `
        };

        // Удаляем старый попап
        const existing = document.getElementById('bookSummaryPopup');
        if (existing) existing.remove();

        // Создаем попап
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
        <h3 class="text-lg font-semibold">${book.title}</h3>
        <p class="text-sm text-gray-300">${book.author || 'Неизвестный автор'}</p>
      </div>
    </div>

    <div id="summaryContent" class="text-gray-200 text-sm leading-relaxed mt-2
      max-h-[60vh] overflow-y-auto p-2 border border-gray-700 rounded">
      <div class="animate-pulse text-gray-400">⏳ Диана формирует аннотацию...</div>
    </div>
  `;

        popup.appendChild(container);
        document.body.appendChild(popup);

        // Закрытие
        document.getElementById('closeSummaryBtn').addEventListener('click', () => popup.remove());

        // Запрос к API
        try {
            const summaryDiv = document.getElementById('summaryContent');

            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${QWEN_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: QWEN_MODEL,
                    messages: [systemMessage, {
                        role: "user",
                        content: `Сделай аннотацию книги "${book.title}" автора "${book.author || 'неизвестен'}".`
                    }],
                    max_tokens: 2000
                })
            });

            if (!response.ok) throw new Error(`Ошибка API: ${response.status}`);
            const data = await response.json();
            let text = data.choices?.[0]?.message?.content || '⚠️ Диана не смогла составить аннотацию.';

            // Удаляем все теги <think> и любые конструкции "Я думаю", "Моя мысль"
            text = text
                .replace(/<think>.*?<\/think>/gi, '')
                .replace(/\b(Я думаю|Моя мысль|В моем понимании)\b/gi, '');

            // Форматирование текста
            text = text.split('\n').filter(Boolean).map(p => {
                if (p.startsWith('Цитата:') || p.startsWith('"')) {
                    return `<blockquote class="border-l-2 border-indigo-600 pl-3 italic text-gray-300 mb-2">${p}</blockquote>`;
                } else if (p.match(/(Аннотация|Сюжет|Анализ)/i)) {
                    return `<h4 class="font-semibold text-indigo-400 mb-1">${p}</h4>`;
                } else {
                    return `<p class="mb-2">${p}</p>`;
                }
            }).join('');

            summaryDiv.innerHTML = text;

        } catch (err) {
            console.error(err);
            const summaryDiv = document.getElementById('summaryContent');
            if (summaryDiv) summaryDiv.innerHTML = `<p class="text-red-400">⚠️ Ошибка при получении аннотации: ${err.message}</p>`;
        }
    }

    async function safeFetchAnnotation(payload, retries = 2) {
        try {
            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${QWEN_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error(`Ошибка API: ${res.status}`);
            const data = await res.json();
            return data;
        } catch (err) {
            if (retries > 0) {
                console.warn("Повтор запроса из-за ошибки:", err);
                await new Promise(r => setTimeout(r, 1000)); // пауза 1 сек
                return safeFetchAnnotation(payload, retries - 1);
            } else {
                throw err;
            }
        }
    }

    // ---------- Добавление кнопки "Подробнее" в карточки книг ----------
    function addMoreButtonToBookCard(div, book) {
        const moreBtnRec = document.createElement("button");
        moreBtnRec.textContent = "Аннотация от Дианы";
        moreBtnRec.className = "btn bg-indigo-600 text-white text-xs px-2 py-1 mt-2 sm:mt-0 hover:bg-indigo-700";
        moreBtnRec.addEventListener("click", () => showBookSummary(book));

        // вставляем в контейнер кнопок книги
        const btnContainer = div.querySelector(".flex.flex-col.sm\\:flex-row");
        if (btnContainer) btnContainer.appendChild(moreBtnRec);
    }


    async function renderBooks(books = [], container = bookGrid) {
        if (!container) return;
        container.innerHTML = '';

        if (!books.length) {
            container.innerHTML = '<p class="text-gray-500 col-span-full text-center">Книги не найдены</p>';
            return;
        }

        for (let b of books) {
            let title = b.title || 'Без названия';
            const author = (b.author_name && b.author_name.join(', ')) || 'Неизвестный автор';
            const cover = b.cover_i ?
                `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` :
                'Diana.jpg';

            // Перевод названия на русский
            

            const card = document.createElement('div');
            card.className = 'book-card flex flex-col items-center bg-white p-2 rounded shadow';
            card.innerHTML = `
      <img src="${cover}" alt="${title}" class="w-full h-40 object-cover mb-2 rounded">
      <p class="font-medium text-sm text-center">${title}</p>
      <p class="text-xs text-gray-500 text-center">${author}</p>
      <div class="flex gap-2 mt-2">
        <button class="btn add-fav">Добавить в избранное</button>
        <button class="btn search-lib bg-gray-100 text-gray-800">Искать</button>
        
      </div>
    `;

            // Кнопка "Добавить в избранное"
            card.querySelector('.add-fav')?.addEventListener('click', () => {
                addToFavorites({
                    title,
                    author,
                    cover
                });
                card.querySelector('.add-fav').textContent = 'В избранном ✓';
            });

            // Кнопка "Искать" — фейковый OPAC
            card.querySelector('.search-lib')?.addEventListener('click', () => openRealOpacSearch(title));

            container.appendChild(card);
            const moreBtn = document.createElement("button");
            moreBtn.textContent = "Аннотация от Дианы";
            moreBtn.className = "btn bg-gray-100 text-gray-800 text-xs px-2 py-1";
            moreBtn.addEventListener("click", () => showBookSummary({
                title,
                author
            }));

            // добавляем в контейнер с кнопками
            card.querySelector(".flex.gap-2").appendChild(moreBtn);
        }

    }



    // ---------- Всплывающие подсказки Дианы ----------
 
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
  "Добавляйте книги в избранное, чтобы увидеть статистику",
  // Можно добавить больше подсказок...
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

  // треугольник комикс-бабла
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

  // текст и кнопка
  bubble.innerHTML += `
    <div>${message}</div>
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

// функция, привязывающая подсказки к карточкам
function initDianaForBooks() {
  const cards = document.querySelectorAll('.book-card');
  cards.forEach(card => {
    if (!card.dataset.dianaAttached) {
      card.addEventListener('mouseenter', () => {
        const author = card.querySelector('.book-author')?.textContent || 'Неизвестный автор';
        const title = card.querySelector('.book-title')?.textContent || 'Без названия';
        showDianaTip(`Книга: "${title}", Автор: ${author}`);
      });
      card.dataset.dianaAttached = 'true';
    }
  });
}

// запуск подсказок для страницы
document.addEventListener('DOMContentLoaded', () => {
  startDianaTips();
  initDianaForBooks();
});

// Если карточки генерируются динамически после поиска
function onBooksUpdated() {
  initDianaForBooks();
}

    // ---------- Пагинация (top + bottom) ----------
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

            // page buttons (window of 5)
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
        // book = {title, author, cover}
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
        <img src="${bk.cover}" alt="${bk.title}" class="w-12 h-16 object-cover rounded">
        <div>
          <div class="font-medium text-sm">${shortenForList(bk.title)}</div>
          <div class="text-xs text-gray-500">${shortenForList(bk.author)}</div>
        </div>
      </div>
      <div class="flex flex-col sm:flex-row sm:gap-2">
        <button class="btn removeFav bg-red-500 text-white text-xs px-2 py-1">Удалить</button>
        <button class="btn searchFav bg-gray-300 text-gray-800 text-xs px-2 py-1 mt-2 sm:mt-0">Искать</button>
      </div>
	  
    `;
            const moreBtnFav = document.createElement("button");
            moreBtnFav.textContent = "Аннотация от Дианы";
            moreBtnFav.className = "btn bg-indigo-600 text-white text-xs px-2 py-1 mt-2 sm:mt-0 hover:bg-indigo-700";
            moreBtnFav.addEventListener("click", () => showBookSummary(bk));

            // вставляем в контейнер кнопок
            div.querySelector(".flex.flex-col.sm\\:flex-row").appendChild(moreBtnFav);
            div.querySelector('.removeFav').addEventListener('click', () => removeFromFavorites(idx));

            div.querySelector('.searchFav').addEventListener('click', () => {
                // Закрываем попап Избранного
                if (favoritesPopup) favoritesPopup.classList.add('hidden');

                // Открываем реальный OPAC-попап
                openRealOpacSearch(bk.title);
            });

            favoritesList.appendChild(div);
        });
    }


    function shortenForList(str) {
        return shortenWords(str, 8);
    }
    //Реки
    async function loadRecommendations(baseBooks) {
        const grid = document.getElementById('recommendationGrid');
        grid.innerHTML = '<p class="text-gray-500">Загрузка рекомендаций...</p>';

        try {
            // Берём случайных 2 авторов из найденных книг
            const authors = baseBooks
                .flatMap(b => b.author_name || [])
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .sort(() => 0.5 - Math.random())
                .slice(0, 2);

            // Если авторов нет, fallback по жанрам или случайным словам
            const query = authors.length ? authors.join(' ') : 'fiction classic';

            const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=6`);
            const data = await res.json();




            renderRecommendations(data.docs);
        } catch (e) {
            grid.innerHTML = `<p class="text-red-500">Ошибка загрузки рекомендаций</p>`;
            console.error(e);
        }
    }


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

    // Загружаем изображение автора с OpenLibrary или Wikipedia
    async function getAuthorImage(name) {
        // 1. Попытка через Wikipedia REST API
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

        // 2. Попытка через OpenLibrary
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

        // 3. Попытка через Wikidata
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

        // 4. Fallback (пустое изображение)
        return "https://via.placeholder.com/110x200?text=No+Image";
    }

    // Работа с лайками
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

    // Отрисовка карточек
    async function loadTopAuthors() {
        const grid = document.getElementById("authorGrid");
        if (!grid) return;

        grid.innerHTML = "<p class='text-gray-500'>Загрузка авторов...</p>";

        const liked = getLikedAuthors();
        const cards = [];

        // Берём случайных 9 авторов из списка 30
        const shuffled = famousAuthors.sort(() => 0.5 - Math.random()).slice(0, 9);

        for (const author of shuffled) {
            const img = await getAuthorImage(author);
            const isLiked = liked.includes(author);
            const heart = isLiked ? "❤️" : "🤍";

            cards.push(`
      <div class="author-card">
        <span class="like-btn ${isLiked ? "liked" : ""}" data-author="${author}">${heart}</span>
        <img src="${img}" alt="${author}">
        <div class="author-name">${author}</div>
        <div class="author-genre">Великий писатель</div>
      </div>
    `);
        }

        grid.innerHTML = cards.join("");

        // Навешиваем обработчики лайков
        grid.querySelectorAll(".like-btn").forEach(btn => {
            btn.addEventListener("click", () => toggleAuthorLike(btn.dataset.author, btn));
        });
    }

    // 🔍 Скрывать топ авторов при поиске
    const searchInput = document.getElementById('searchInput');
    const topAuthorsDiv = document.getElementById('topAuthors');

    if (searchInput && topAuthorsSection) {
        searchInput.addEventListener('input', () => {
            if (searchInput.value.trim() !== '') {
                topAuthorsDiv.style.display = 'none';
            } else {
                topAuthorsDiv.style.display = 'grid';
            }
        });
    }

    // 🚀 Запуск
    loadTopAuthors();




    async function renderRecommendations() {
        if (!recommendationsGrid) return;
        recommendationsGrid.innerHTML = '';

        // ---------- Лоадер ----------
        const loader = document.createElement('div');
        loader.className = 'text-center text-gray-500 py-6';
        loader.innerHTML = '⏳ Загружаю рекомендации...';
        recommendationsGrid.appendChild(loader);

        if (!favorites.length) {
            loader.textContent = 'Добавьте книги в Избранное, чтобы увидеть рекомендации.';
            return;
        }

        const authors = [...new Set(favorites.map(f => f.author))];
        const genres = [...new Set(favorites.map(f => f.genre).filter(g => g))];
        const recs = [];
        const favKeys = new Set(favorites.map(f => `${f.title}||${f.author}`));

        // ---------- Рекомендации по авторам ----------
        for (const author of authors) {
            try {
                const res = await fetch(`https://openlibrary.org/search.json?author=${encodeURIComponent(author)}&limit=5`);
                if (!res.ok) continue;
                const data = await res.json();
                if (Array.isArray(data.docs)) {
                    data.docs.slice(0, 5).forEach(b => {
                        const key = `${b.title}||${(b.author_name && b.author_name.join(', ')) || author}`;
                        if (!favKeys.has(key)) {
                            recs.push({
                                title: b.title,
                                author: (b.author_name && b.author_name.join(', ')) || author,
                                cover: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : 'Diana.jpg'
                            });
                        }
                    });
                }
            } catch (e) {
                console.error(e);
            }
        }

        // ---------- Рекомендации по жанрам ----------
        for (const genre of genres) {
            try {
                const res = await fetch(`https://openlibrary.org/subjects/${encodeURIComponent(genre.toLowerCase())}.json?limit=5`);
                if (!res.ok) continue;
                const data = await res.json();
                if (Array.isArray(data.works)) {
                    data.works.slice(0, 5).forEach(b => {
                        const authorName = (b.authors && b.authors.map(a => a.name).join(', ')) || 'Неизвестный';
                        const key = `${b.title}||${authorName}`;
                        if (!favKeys.has(key)) {
                            recs.push({
                                title: b.title,
                                author: authorName,
                                cover: b.cover_id ? `https://covers.openlibrary.org/b/id/${b.cover_id}-M.jpg` : 'Diana.jpg'
                            });
                        }
                    });
                }
            } catch (e) {
                console.error(e);
            }
        }

        // ---------- Очистка лоадера ----------
        recommendationsGrid.innerHTML = '';

        // Ограничение до 12 уникальных рекомендаций
        recs.slice(0, 12).forEach(bk => {
            const div = document.createElement('div');
            div.className = 'flex items-center justify-between bg-gray-50 border border-gray-200 p-3 rounded-lg hover:shadow mb-2';
            div.innerHTML = `
      <div class="flex items-center gap-3">
        <img src="${bk.cover}" alt="${bk.title}" class="w-12 h-16 object-cover rounded">
        <div>
          <div class="font-medium text-sm">${shortenForList(bk.title)}</div>
          <div class="text-xs text-gray-500">${shortenForList(bk.author)}</div>
        </div>
      </div>
      <div class="flex flex-col sm:flex-row sm:gap-2">
        <button class="btn add-fav bg-indigo-600 text-white text-xs px-2 py-1">Добавить в избранное</button>
        <button class="btn search-lib bg-gray-300 text-white-800 text-xs px-2 py-1 mt-2 sm:mt-0">Искать</button>
      </div>
	  `;

            const moreBtnRec = document.createElement("button");
            moreBtnRec.textContent = "Аннотация от Дианы";
            moreBtnRec.className = "btn bg-indigo-600 text-white text-xs px-2 py-1 mt-2 sm:mt-0 hover:bg-indigo-700";
            moreBtnRec.addEventListener("click", () => showBookSummary(bk));

            // вставляем в контейнер кнопок
            div.querySelector(".flex.flex-col.sm\\:flex-row").appendChild(moreBtnRec);
            div.querySelector('.add-fav').addEventListener('click', () => {
                addToFavorites(bk);
                div.querySelector('.add-fav').textContent = 'В избранном ✓';
            });

            div.querySelector('.search-lib').addEventListener('click', () => {
                openFakeOpacSearch(bk.title);
            });

            recommendationsGrid.appendChild(div);
        });
    }


    // ---------- Чат Дианы ----------
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
        if (!chatInput || !chatMessages) return;
        const txt = (chatInput.value || '').trim();
        if (!txt) return;
        const userDiv = document.createElement('div');
        userDiv.className = 'bg-indigo-100 text-indigo-900 text-sm px-3 py-2 rounded-lg w-fit ml-auto';
        userDiv.textContent = txt;
        chatMessages.appendChild(userDiv);
        chatInput.value = '';
        chatMessages.scrollTop = chatMessages.scrollHeight;

        setTimeout(() => {
            const botDiv = document.createElement('div');
            botDiv.className = 'bg-gray-100 text-gray-800 text-sm px-3 py-2 rounded-lg w-fit';
            botDiv.textContent = `Диана 🤖: Я получила ваше сообщение — "${txt}"`;
            chatMessages.appendChild(botDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }, 600);
    }

    // ---------- Приветственный попап ----------
    function showWelcomePopup() {
        // если есть готовый узел welcomePopup в DOM — используем его, иначе создаём
        if (welcomePopupNode) {
            welcomePopupNode.classList.remove('hidden');
            safeAddEvent($('closeWelcome'), 'click', () => welcomePopupNode.classList.add('hidden'));
            setTimeout(() => welcomePopupNode.classList.add('hidden'), 30000);
            return;
        }

        // создаём элемент
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

    // ---------- Фейковый OPAC-поиск (попап) ----------
    async function openRealOpacSearch(title = '') {
        if (!title) return;

        // создаём/показываем попап
        let popup = $('realOpacPopup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'realOpacPopup';
            popup.className = 'fixed inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center z-90 p-4';
            popup.style.overflow = 'hidden';
            popup.innerHTML = `
      <div class="flex flex-col items-center mb-6 mt-10">
        <img src="dainaload.jpg" class="w-20 h-20 rounded-full mb-4" alt="Диана">
		 
        <h2 id="searchStatus" class="text-white text-2xl font-semibold mb-4 text-center">Ищу в: 📚"${title}"</h2>
        <button id="closeRealOpac" class="px-4 py-2 bg-indigo-600 rounded text-white hover:bg-indigo-700">Закрыть</button>
      </div>
      <ul id="realOpacList" class="flex flex-col items-center justify-center w-full max-h-[60vh] overflow-y-auto text-center text-white"></ul>
      <div id="realOpacPagination" class="flex gap-2 mt-4 justify-center"></div>
    `;
            document.body.appendChild(popup);
            $('closeRealOpac').addEventListener('click', () => popup.classList.add('hidden'));
        } else {
            popup.classList.remove('hidden');
        }

        const listContainer = $('realOpacList');
        const paginationContainer = $('realOpacPagination');
        const searchStatus = $('searchStatus');
        listContainer.innerHTML = '';
        paginationContainer.innerHTML = '';

        const books = [];
        const PAGE_SIZE = 5;
        let currentPage = 1;

        const services = [{
                name: 'Google Books',
                url: `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&maxResults=20`,
                parser: data => {
                    if (!data.items) return [];
                    return data.items.map(b => ({
                        title: b.volumeInfo.title,
                        author: (b.volumeInfo.authors || []).join(', ') || 'Неизвестный автор',
                        link: b.volumeInfo.infoLink,
                        source: 'Google Books'
                    }));
                }
            },
            {
                name: 'Гутенберг',
                url: `https://gutendex.com/books?search=${encodeURIComponent(title)}`,
                parser: data => {
                    if (!data.results) return [];
                    return data.results.map(b => ({
                        title: b.title,
                        author: (b.authors?.map(a => a.name) || []).join(', ') || 'Неизвестный автор',
                        link: b.formats['text/html'] || '#',
                        source: 'Гутенберг'
                    }));
                }
            },
            {
                name: 'Яндекс.Книги',
                url: `https://api.bookmate.com/v2/search?q=${encodeURIComponent(title)}&type=book&limit=20`,
                parser: data => {
                    if (!data.items) return [];
                    return data.items.map(b => ({
                        title: b.title,
                        author: b.authors?.join(', ') || 'Неизвестный автор',
                        link: b.url || '#',
                        source: 'Яндекс.Книги'
                    }));
                }
            },

        ];

        for (let service of services) {
            searchStatus.textContent = `Ищу книгу в ${service.name}...`;
            try {
                const res = await fetch(service.url);
                const data = await res.json();
                const parsedBooks = service.parser(data);
                books.push(...parsedBooks);
            } catch (err) {
                console.error(`Ошибка при поиске в ${service.name}:`, err);
            }
        }

        // рендер страницы
        function renderPage(page) {
            listContainer.innerHTML = '';
            const start = (page - 1) * PAGE_SIZE;
            const pageBooks = books.slice(start, start + PAGE_SIZE);
            pageBooks.forEach(b => {
                const li = document.createElement('li');
                li.className = 'mb-3';
                li.innerHTML = `<a href="${b.link}" target="_blank" class="text-indigo-400 hover:underline font-medium">${b.title}</a> — <span class="text-gray-300">${b.author} (${b.source})</span>`;

                // Добавляем кнопку "Сохранить ссылку"
                const saveBtn = document.createElement('button');
                saveBtn.textContent = '💾 Сохранить ссылку';
                saveBtn.className = 'ml-2 px-2 py-1 bg-indigo-600 text-white rounded text-xs hover:bg-indigo-700';
                saveBtn.addEventListener('click', () => {
                    // эффект "прыжка"
                    saveBtn.classList.add('scale-110');
                    setTimeout(() => saveBtn.classList.remove('scale-110'), 150);

                    // сохраняем ссылку
                    saveLink({
                        title: b.title,
                        author: b.author,
                        url: b.link,
                        source: b.source
                    });
                });

                // добавляем кнопку к li
                li.appendChild(saveBtn);
                listContainer.appendChild(li);

            });

            // пагинация
            paginationContainer.innerHTML = '';
            const totalPages = Math.ceil(books.length / PAGE_SIZE);
            if (totalPages <= 1) return;

            const prev = document.createElement('button');
            prev.textContent = '← Назад';
            prev.className = `px-3 py-1 bg-gray-700 text-white rounded ${page === 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`;
            prev.disabled = page === 1;
            prev.addEventListener('click', () => {
                if (currentPage > 1) {
                    currentPage--;
                    renderPage(currentPage);
                }
            });
            paginationContainer.appendChild(prev);

            for (let i = 1; i <= totalPages; i++) {
                const btn = document.createElement('button');
                btn.textContent = i;
                btn.className = `px-3 py-1 rounded ${i === page ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-white hover:bg-gray-600'}`;
                btn.addEventListener('click', () => {
                    currentPage = i;
                    renderPage(currentPage);
                });
                paginationContainer.appendChild(btn);
            }

            const next = document.createElement('button');
            next.textContent = 'Вперёд →';
            next.className = `px-3 py-1 bg-gray-700 text-white rounded ${page === totalPages ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'}`;
            next.disabled = page === totalPages;
            next.addEventListener('click', () => {
                if (currentPage < totalPages) {
                    currentPage++;
                    renderPage(currentPage);
                }
            });
            paginationContainer.appendChild(next);

            searchStatus.textContent = `Результаты поиска для: "${title}"`;
        }

        renderPage(currentPage);
    }


    // ---------- Wikipedia author card ----------
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

                // Фильтр по профессии
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
    const authorSuggestions = $('authorSuggestions');

    let suggestionTimeout;

    if (authorInput) {
        authorInput.addEventListener('input', () => {
            const query = authorInput.value.trim();
            if (!query) {
                toggleHidden(authorSuggestions, true);
                return;
            }

            // debounce запросов
            clearTimeout(suggestionTimeout);
            suggestionTimeout = setTimeout(async () => {
                try {
                    const res = await fetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(query)}`);
                    if (!res.ok) return;
                    const data = await res.json();
                    const authors = (data.docs || []).slice(0, 5); // показываем максимум 5 вариантов

                    if (!authors.length) {
                        toggleHidden(authorSuggestions, true);
                        return;
                    }

                    authorSuggestions.innerHTML = '';
                    authors.forEach(a => {
                        const li = document.createElement('li');
                        li.textContent = a.name;
                        li.className = 'cursor-pointer px-3 py-1 hover:bg-indigo-100';
                        li.addEventListener('click', () => {
                            authorInput.value = a.name;
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
            }, 300); // задержка 300ms
        });

        // скрываем подсказки при клике вне
        document.addEventListener('click', (e) => {
            if (!authorInput.contains(e.target) && !authorSuggestions.contains(e.target)) {
                toggleHidden(authorSuggestions, true);
            }
        });
    }

    async function renderAuthorCardFromQuery(name) {
        if (!authorCard) return;
        authorCard.classList.add('opacity-50'); // show loading look
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
        ${info.thumbnail ? `<img src="${info.thumbnail}" alt="${info.title}" class="w-20 h-20 object-cover rounded-md">` : ''}
        <div>
          <div class="text-lg font-semibold text-white">${info.title} ${info.lang ? `<span class="text-xs text-gray-200">(${info.lang})</span>` : ''}</div>
          <p class="text-sm text-white mt-1">${shortenWords(info.summary, 32)}</p>
        </div>
      </div>
    `;
        // styling: ensure purple background — user asked for a purple block; add inline style if not set by CSS
        authorCard.style.background = authorCard.style.background || 'linear-gradient(90deg,#6d28d9,#7c3aed)';
        authorCard.style.color = 'white';
        authorCard.style.borderRadius = '12px';
        authorCard.style.padding = '12px';
    }

    // ---------- Инициализация событий ----------
    safeAddEvent(searchBtn, 'click', () => {
        currentPage = 1;
        searchBooks();
    });
    safeAddEvent(authorInput, 'keydown', e => {
        if (e.key === 'Enter') {
            currentPage = 1;
            searchBooks();
        }
    });
    safeAddEvent(clearBtn, 'click', () => {
        if (authorInput) authorInput.value = '';
        if (bookGrid) bookGrid.innerHTML = '';
    });

    // favorites popup toggle
    safeAddEvent(favoritesBtnHeader, 'click', () => {
        if (!favoritesPopup) {
            // If popup container missing, just show the list as an alert fallback
            alert('Избранное:\n' + (favorites.map(f => `${f.title} — ${f.author}`).join('\n') || 'Пусто'));
            return;
        }
        favoritesPopup.classList.toggle('hidden');
        renderFavoritesList();
    });
    safeAddEvent(closeFavorites, 'click', () => {
        if (favoritesPopup) favoritesPopup.classList.add('hidden');
    });

    // recommendations toggle
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
            linksPopup.classList.remove('hidden');
        });

        closeLinks.addEventListener('click', () => {
            linksPopup.classList.add('hidden');
        });


    }

    // Chat
    safeAddEvent(dianaBot, 'click', () => {
        if (chatWindow) chatWindow.classList.toggle('hidden');
    });
    safeAddEvent(chatSend, 'click', sendChatMessage);
    safeAddEvent(chatInput, 'keydown', e => {
        if (e.key === 'Enter') sendChatMessage();
    });

    ensureChatCloseButton();

    // ---------- On load ----------
    document.addEventListener('DOMContentLoaded', () => {
        updateFavCounter();
        renderFavoritesList();
        // show welcome popup once on load
        try {
            showWelcomePopup();
        } catch (e) {
            /* ignore */
        }
    });

    // expose some functions for console/debug if needed
    window.LA = {
        openFakeOpacSearch,
        searchBooks,
        addToFavorites,
        removeFromFavorites,
        renderFavoritesList,
        renderRecommendations
    };

    // ---------- Новый чат Дианы на OpenRouter ----------
    // ---------------------------
    // Новый рабочий чат Дианы
    // ---------------------------
    (function initDianaChat() {
        const chatLog = document.getElementById("chatMessages"); // лог чата
        const chatInput = document.getElementById("chatInput"); // поле ввода
        const sendBtn = document.getElementById("chatSend"); // кнопка отправки
        const dianaMsg = document.getElementById("dianaMsg");
        const dianaBubble = document.getElementById("dianaBubble");

        if (!chatLog || !chatInput || !sendBtn) return;


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
            chatInput.value = "";

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
                        "Authorization": `Bearer ${QWEN_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: QWEN_MODEL,
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

                if (dianaMsg && dianaBubble) {
                    dianaMsg.textContent = reply;
                    dianaBubble.classList.add("active");
                    setTimeout(() => dianaBubble.classList.remove("active"), 9000);
                }
            } catch (err) {
                placeholder.querySelector("div").textContent = "⚠️ Ошибка при обращении к Диане.";
                console.error(err);
            }
        }

        sendBtn.addEventListener("click", () => {
            const msg = chatInput.value.trim();
            if (!msg) return;
            sendToDiana(msg);
        });

        chatInput.addEventListener("keydown", e => {
            if (e.key === "Enter") {
                e.preventDefault();
                sendBtn.click();
            }

        });

    })();

})(); // IIFE end