import React, { useState } from 'react';
import { createPortal } from 'react-dom';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('token')}`,
  };
}

/** Where an app receives the messages your users write here. */
function WebhookDialog({ app, onClose, onChanged }) {
  const [url, setUrl] = useState(app.webhookUrl || '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const base = `/api/integrations/keys/${encodeURIComponent(app.id)}`;

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const call = async (path, method, body) => {
    const r = await fetch(path, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `The request failed (HTTP ${r.status})`);
    return data;
  };

  const save = (ev) => {
    ev.preventDefault();
    run(async () => {
      const data = await call(`${base}/webhook`, 'PUT', { webhookUrl: url.trim() });
      if (data.webhookSecret) setSecret(data.webhookSecret);
      setNotice(url.trim() ? 'Webhook saved.' : 'Webhook removed. The app now collects its messages.');
    });
  };

  const test = () => run(async () => {
    const result = await call(`${base}/webhook/test`, 'POST');
    if (!result.ok) throw new Error(`The test failed: ${result.error}`);
    setNotice(`The test worked. The webhook replied with HTTP ${result.status}.`);
  });

  const rotate = () => {
    const ok = window.confirm('Create a new secret? The app must switch to it, because the old one stops working immediately.');
    if (!ok) return;
    run(async () => {
      const data = await call(`${base}/webhook/rotate-secret`, 'POST');
      setSecret(data.webhookSecret);
    });
  };

  const retry = () => run(async () => {
    const data = await call(`${base}/retry-failed`, 'POST');
    setNotice(`Sending ${data.retried} message(s) again.`);
  });

  return createPortal(
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal-content webhook-dialog"
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhook-title"
      >
        <div className="modal-header">
          <h3 id="webhook-title" className="modal-title">Webhook for {app.name}</h3>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <p className="admin-help-text mb-3">
          Messages your users write in this app&apos;s conversations are sent to this address straight away.
          Leave it empty if the app collects its messages itself.
        </p>
        {error ? <div className="admin-alert admin-alert--error mb-3" role="alert">{error}</div> : null}
        {notice ? <div className="admin-alert admin-alert--success mb-3" role="status">{notice}</div> : null}

        <form onSubmit={save}>
          <div className="form-group">
            <label htmlFor="webhook-url">Webhook address</label>
            <input
              id="webhook-url"
              className="form-control"
              type="url"
              dir="ltr"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://connector.example.com/chat-events"
              maxLength={2000}
            />
          </div>
          <div className="integrations__actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
            {app.webhookUrl ? (
              <>
                <button type="button" className="btn btn-secondary" onClick={test} disabled={busy}>Send test</button>
                <button type="button" className="btn btn-secondary" onClick={rotate} disabled={busy}>New secret</button>
              </>
            ) : null}
          </div>
        </form>

        {secret ? (
          <div className="integrations__secret webhook-dialog__secret" role="status">
            <strong>Copy this secret now. It won&apos;t be shown again.</strong>
            <code className="integrations__key user-select-all webhook-dialog__secret-value">{secret}</code>
          </div>
        ) : null}

        {app.delivery?.failed > 0 ? (
          <div className="webhook-dialog__failed">
            <div>
              <strong>{app.delivery.failed} message(s) not delivered.</strong>
              {app.delivery.lastError ? <div className="admin-help-text">{app.delivery.lastError}</div> : null}
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={retry} disabled={busy}>Retry</button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export default WebhookDialog;
