import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toolsPageUi } from '../config/toolsPageUi';

const { public: pub, fallbacks: fb } = toolsPageUi;

function excerpt(text, maxLen) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen).trim()}…`;
}

function AppTileMedia({ app, lead }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = app.imgSrc && String(app.imgSrc).trim();
  useEffect(() => {
    setImgFailed(false);
  }, [app._id, app.imgSrc]);
  if (!src || imgFailed) {
    return (
      <span className="tools-tile__cap" aria-hidden>
        {lead}
      </span>
    );
  }
  return (
    <span className="tools-tile__media tools-tile__media--contain">
      <img src={src} alt="" onError={() => setImgFailed(true)} />
    </span>
  );
}

function ManPageHero({ app }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = app.imgSrc && String(app.imgSrc).trim();
  const lead = (app.title || '?').trim().charAt(0).toUpperCase() || '?';
  if (!src || imgFailed) {
    return (
      <span className="tools-manpage__cap" aria-hidden>
        {lead}
      </span>
    );
  }
  return (
    <span className="tools-manpage__logo">
      <img src={src} alt="" onError={() => setImgFailed(true)} />
    </span>
  );
}

function ExampleCard({ example, copyLabel }) {
  const [copied, setCopied] = useState(false);
  const text = String(example.body || '');

  const onCopy = () => {
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="tools-manpage__example">
      <div className="tools-manpage__example-head">
        {example.title ? (
          <h4 className="tools-manpage__example-title">{example.title}</h4>
        ) : (
          <span aria-hidden />
        )}
        {text ? (
          <button
            type="button"
            className="tools-manpage__example-copy"
            onClick={onCopy}
          >
            {copied ? '✓' : copyLabel}
          </button>
        ) : null}
      </div>
      {text ? (
        <pre className="tools-manpage__example-body" dir="auto">{text}</pre>
      ) : null}
    </div>
  );
}

const ToolsPage = () => {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(pub.allCategory);
  const [selectedAppId, setSelectedAppId] = useState(null);
  const manPageRef = useRef(null);

  const loadApps = useCallback(async () => {
    const token = localStorage.getItem('token');
    const r = await fetch('/api/shortcuts', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    setApps(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        await loadApps();
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadApps]);

  const sortedApps = useMemo(() => {
    return [...apps].sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        String(a.title || '').localeCompare(String(b.title || '')),
    );
  }, [apps]);

  const categoryChips = useMemo(() => {
    const cats = Array.from(
      new Set(sortedApps.map((s) => s.category).filter(Boolean)),
    );
    return [pub.allCategory, ...cats];
  }, [sortedApps]);

  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sortedApps.filter((item) => {
      const matchesCategory =
        activeCategory === pub.allCategory || item.category === activeCategory;
      if (!matchesCategory) return false;
      if (!q) return true;
      const haystack = [
        item.title,
        item.description,
        item.summary,
        item.category,
        item.url,
      ]
        .filter((x) => x != null && String(x).trim() !== '')
        .map((x) => String(x).toLowerCase())
        .join('\n');
      return haystack.includes(q);
    });
  }, [sortedApps, searchQuery, activeCategory]);

  const selectedApp = useMemo(
    () => sortedApps.find((s) => s._id === selectedAppId) || null,
    [sortedApps, selectedAppId],
  );

  useEffect(() => {
    if (selectedApp && manPageRef.current) {
      manPageRef.current.focus({ preventScroll: false });
    }
  }, [selectedApp]);

  const openManPage = (appId) => {
    setSelectedAppId(appId);
  };

  const closeManPage = () => {
    setSelectedAppId(null);
  };

  if (selectedApp) {
    const title = String(selectedApp.title || fb.app).trim() || fb.app;
    const summary =
      (selectedApp.summary && String(selectedApp.summary).trim()) ||
      (selectedApp.description && String(selectedApp.description).trim()) ||
      '';
    const useCases = Array.isArray(selectedApp.useCases)
      ? selectedApp.useCases.filter((s) => s && String(s).trim())
      : [];
    const examples = Array.isArray(selectedApp.examples)
      ? selectedApp.examples.filter(
          (e) => e && (e.title || (e.body && String(e.body).trim())),
        )
      : [];
    const url = String(selectedApp.url || '').trim();
    const category = String(selectedApp.category || fb.category).trim();

    return (
      <div className="tools-library tools-library--manpage">
        <div className="tools-library__inner">
          <div
            className="tools-manpage"
            ref={manPageRef}
            tabIndex={-1}
          >
            <div className="tools-manpage__topbar">
              <button
                type="button"
                className="tools-library__btn tools-library__btn--ghost"
                onClick={closeManPage}
              >
                ← {pub.backToGallery}
              </button>
              {url ? (
                <a
                  className="tools-library__btn tools-library__btn--primary"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {pub.openApp}
                </a>
              ) : null}
            </div>

            <header className="tools-manpage__header">
              <ManPageHero app={selectedApp} />
              <div className="tools-manpage__heading">
                <span className="tools-manpage__category">{category}</span>
                <h1 className="tools-manpage__title">{title}</h1>
                {url ? (
                  <a
                    className="tools-manpage__url"
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {url}
                  </a>
                ) : null}
              </div>
            </header>

            <section className="tools-manpage__section">
              <h2 className="tools-manpage__h2">{pub.summaryHeading}</h2>
              <p className="tools-manpage__summary">
                {summary || pub.noSummary}
              </p>
            </section>

            {useCases.length > 0 && (
              <section className="tools-manpage__section">
                <h2 className="tools-manpage__h2">{pub.useCasesHeading}</h2>
                <ul className="tools-manpage__use-cases">
                  {useCases.map((row, idx) => (
                    <li key={`uc-${idx}`}>{row}</li>
                  ))}
                </ul>
              </section>
            )}

            {examples.length > 0 && (
              <section className="tools-manpage__section">
                <h2 className="tools-manpage__h2">{pub.examplesHeading}</h2>
                <div className="tools-manpage__examples">
                  {examples.map((ex, idx) => (
                    <ExampleCard
                      key={`ex-${idx}`}
                      example={ex}
                      copyLabel={pub.copyExample}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tools-library">
      <div className="tools-library__inner">
        <header className="tools-library__header">
          <div className="tools-library__headline">
            <h1 className="tools-library__title">{pub.pageTitle}</h1>
            <p className="tools-library__lede">{pub.pageLede}</p>
          </div>
        </header>

        {error && (
          <div className="tools-library__msg tools-library__msg--err" role="alert">
            {error}
          </div>
        )}

        {loading && <p className="tools-library__loading">{pub.loading}</p>}

        {!loading && !error && sortedApps.length === 0 && (
          <div className="tools-library__empty">
            <p className="tools-library__empty-icon" aria-hidden>⊕</p>
            <p>{pub.emptyTitle}</p>
            <p className="tools-library__empty-hint">{pub.emptyHint}</p>
          </div>
        )}

        {!loading && !error && sortedApps.length > 0 && (
          <>
            <div className="tools-library__filters">
              <input
                type="search"
                className="tools-library__search"
                placeholder={pub.searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label={pub.searchPlaceholder}
              />
              {categoryChips.length > 1 && (
                <div className="tools-library__chips" role="tablist" aria-label="Categories">
                  {categoryChips.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      role="tab"
                      aria-selected={activeCategory === cat}
                      className={`category-chip ${activeCategory === cat ? 'category-chip-active' : ''}`}
                      onClick={() => setActiveCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {filteredApps.length === 0 ? (
              <p className="tools-library__loading">{pub.noResults}</p>
            ) : (
              <div className="tools-library__grid" role="list">
                {filteredApps.map((app) => {
                  const title = String(app.title || fb.app).trim() || fb.app;
                  const lead = title.charAt(0).toUpperCase() || '·';
                  const previewSrc =
                    (app.summary && String(app.summary).trim()) ||
                    (app.description && String(app.description).trim()) ||
                    '';
                  const preview = excerpt(previewSrc, 96);
                  return (
                    <button
                      key={app._id}
                      type="button"
                      className="tools-tile"
                      role="listitem"
                      onClick={() => openManPage(app._id)}
                    >
                      <span className="tools-tile__glare" aria-hidden />
                      <AppTileMedia app={app} lead={lead} />
                      <span className="tools-tile__name">{title}</span>
                      {preview && <span className="tools-tile__preview">{preview}</span>}
                      <span className="tools-tile__cta">{pub.tileCta}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ToolsPage;
