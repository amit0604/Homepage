import React, { useCallback, useEffect, useState } from 'react';
import ApiGuide from './ApiGuide';
import WebhookDialog from './WebhookDialog';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('token')}`,
  };
}

function when(value) {
  if (!value) return 'Never';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
}

/** Admin → Integrations: API keys for other support apps that send requests here. */
function AdminIntegrations() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [webhookFor, setWebhookFor] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/integrations/keys', { headers: authHeaders() });
    if (!r.ok) throw new Error(`Could not load keys (HTTP ${r.status})`);
    setKeys(await r.json());
  }, []);

  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  const createKey = async (ev) => {
    ev.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/api/integrations/keys', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Could not create the key (HTTP ${r.status})`);
      setCreated(data);
      setCopied(false);
      setName('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row) => {
    const ok = window.confirm(
      `Revoke the key for "${row.name}"? The app stops connecting immediately. Its requests stay in the list.`,
    );
    if (!ok) return;
    setError('');
    try {
      const r = await fetch(`/api/integrations/keys/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error(`Could not revoke the key (HTTP ${r.status})`);
      if (created && created.id === row.id) setCreated(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const copyKey = () => {
    if (!created || !navigator.clipboard) return;
    navigator.clipboard.writeText(created.key).then(() => setCopied(true), () => {});
  };

  return (
    <div className="col-md-12 integrations">
      <div className="card admin-surface">
        <div className="card-header admin-card-header">
          <h3 className="title admin-card-title">Connected apps</h3>
        </div>
        <div className="card-body">
          {error ? <div className="admin-alert admin-alert--error mb-3" role="alert">{error}</div> : null}

          <form className="integrations__form" onSubmit={createKey}>
            <div className="form-group mb-0 integrations__name">
              <label htmlFor="integration-name">App name</label>
              <input
                id="integration-name"
                className="form-control"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="For example, Helpdesk"
                maxLength={80}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              Create key
            </button>
          </form>

          {created ? (
            <div className="integrations__secret" role="status">
              <strong>Copy the key for {created.name} now. It won&apos;t be shown again.</strong>
              <div className="integrations__secret-row">
                <code className="integrations__key user-select-all">{created.key}</code>
                {navigator.clipboard ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={copyKey}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreated(null)}>
                  Done
                </button>
              </div>
            </div>
          ) : null}

          <div className="table-body integrations__table">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Key</th>
                  <th>Last used</th>
                  <th>Chat delivery</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="admin-ticket-row-title">{row.name}</div>
                      <div className="admin-ticket-row-meta">Source: {row.source}</div>
                    </td>
                    <td><code>{row.keyPreview}</code></td>
                    <td>{when(row.lastUsedAt)}</td>
                    <td>
                      <div>{row.webhookUrl ? 'Webhook' : 'App collects'}</div>
                      {row.delivery?.pending > 0 ? (
                        <div className="admin-ticket-row-meta">{row.delivery.pending} waiting</div>
                      ) : null}
                      {row.delivery?.failed > 0 ? (
                        <div className="integrations__failed">{row.delivery.failed} not delivered</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="integrations__actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setWebhookFor(row.id)}>
                          Webhook
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => revoke(row)}>
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && keys.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="admin-empty-row">No apps are connected yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

        </div>
      </div>

      <ApiGuide />

      {webhookFor && keys.find((k) => k.id === webhookFor) ? (
        <WebhookDialog
          app={keys.find((k) => k.id === webhookFor)}
          onClose={() => setWebhookFor(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}

export default AdminIntegrations;
