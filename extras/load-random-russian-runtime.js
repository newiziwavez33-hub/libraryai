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
      if (typeof loadRandomRussianBooks === 'function') {
        try { await loadRandomRussianBooks(); return; } catch(e) { console.warn('loadRandomRussianBooks failed, will fallback', e); }
      }

      incLoader?.();
      showLoader?.(true);

      const topics = ['роман','русская литература','бестселлер','повесть','детектив','фантастика','поэзия','проза'];
      const candidates = await fetchCandidatesForTopics(topics, 20);

      const seen = new Set();
      const unique = [];
      for (const it of candidates) {
        const id = (it.id || (it.volumeInfo && it.volumeInfo.title) || Math.random()).toString();
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(it);
      }

      if (!unique.length) {
        try { loadBooks?.('subject:fiction'); } catch(e){ console.warn('fallback loadBooks failed', e); }
        return;
      }

      for (let i = unique.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unique[i], unique[j]] = [unique[j], unique[i]];
      }

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
              translateToRussianCached(title || '').catch(()=>title),
              translateToRussianCached(desc || '').catch(()=>desc),
              translateToRussianCached(authors || '').catch(()=>authors)
            ]);
            d.title = titleRu || d.title;
            d.description = descRu || d.description;
            d.author_name = (authorsRu || authors).split(',').map(a => a.trim());
          }
        } catch (e) {
          console.warn('translation for candidate failed', e);
        }
        processed.push(d);
      }

      try { renderBooks(processed); } catch (e) { console.error('renderBooks failed in ensureLoadRandomRussianBooks', e); }
    } catch (e) {
      console.error('ensureLoadRandomRussianBooks unexpected error', e);
    } finally {
      try { decLoader?.(); } catch(e){}
      try { showLoader?.(false); } catch(e){}
    }
  }

  const runOnce = () => {
    try {
      ensureLoadRandomRussianBooks();
      setTimeout(() => { ensureLoadRandomRussianBooks(); }, 800);
    } catch(e) { console.warn(e); }
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(runOnce, 120);
  } else {
    document.addEventListener('DOMContentLoaded', runOnce, { once: true });
  }
})();
