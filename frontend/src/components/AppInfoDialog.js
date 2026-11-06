import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { safeLink } from '../utils/safeUrl';

function AppMark({ app, title }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = app.imgSrc && String(app.imgSrc).trim();
  if (!src || imgFailed) {
    return (
      <span className="tools-manpage__cap" aria-hidden="true">
        {title.charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <span className="tools-manpage__logo">
      <img src={src} alt="" onError={() => setImgFailed(true)} />
    </span>
  );
}

function ExampleCard({ example }) {
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
        {example.title ? <h4 className="tools-manpage__example-title">{example.title}</h4> : null}
        {text && navigator.clipboard ? (
          <button type="button" className="tools-manpage__example-copy" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
      {text ? <pre className="tools-manpage__example-body" dir="auto">{text}</pre> : null}
    </div>
  );
}

/** What an app is for and how to use it. Opened from the "i" button on a home shortcut. */
function AppInfoDialog({ app, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (ev) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = String(app.title || 'Untitled app').trim();
  const summary = String(app.summary || app.description || '').trim();
  const url = safeLink(app.url);
  const category = String(app.category || 'General').trim();
  const useCases = Array.isArray(app.useCases) ? app.useCases.filter((s) => s && String(s).trim()) : [];
  const examples = Array.isArray(app.examples)
    ? app.examples.filter((e) => e && (e.title || (e.body && String(e.body).trim())))
    : [];

  return createPortal(
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal-content app-info"
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`About ${title}`}
      >
        <header className="tools-manpage__header app-info__header">
          <AppMark app={app} title={title} />
          <div className="tools-manpage__heading">
            <span className="tools-manpage__category">{category}</span>
            <h2 className="tools-manpage__title">{title}</h2>
            {url ? (
              <a className="tools-manpage__url" href={url} target="_blank" rel="noopener noreferrer">
                {url}
              </a>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="close-button app-info__close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </header>

        <section className="tools-manpage__section">
          <h3 className="tools-manpage__h2">Summary</h3>
          <p className="tools-manpage__summary">
            {summary || 'No summary has been written for this app yet.'}
          </p>
        </section>

        {useCases.length > 0 && (
          <section className="tools-manpage__section">
            <h3 className="tools-manpage__h2">Use cases</h3>
            <ul className="tools-manpage__use-cases">
              {useCases.map((row, idx) => (
                <li key={`uc-${idx}`}>{row}</li>
              ))}
            </ul>
          </section>
        )}

        {examples.length > 0 && (
          <section className="tools-manpage__section">
            <h3 className="tools-manpage__h2">Examples</h3>
            <div className="tools-manpage__examples">
              {examples.map((ex, idx) => (
                <ExampleCard key={`ex-${idx}`} example={ex} />
              ))}
            </div>
          </section>
        )}

        {url ? (
          <div className="button-container">
            <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">
              Open app
            </a>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export default AppInfoDialog;
