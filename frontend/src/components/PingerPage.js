import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { jwtDecode } from 'jwt-decode';
import { isJwtExpired } from '../utils/jwtSession';
import PingerSshManager from './PingerSshManager';
import { safeLink } from '../utils/safeUrl';

const POLL_MS = 28000;
const LIVE_STORAGE_KEY = 'pinger_live_enabled';

function authHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function sortHostsLikeBackend(list) {
  return [...list].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a._id).localeCompare(String(b._id)),
  );
}

/** Reorder full host rows to match id list (optimistic UI). */
function applyHostOrder(prev, orderedIds) {
  const map = new Map(prev.map((h) => [String(h._id), h]));
  const out = [];
  for (let i = 0; i < orderedIds.length; i += 1) {
    const h = map.get(String(orderedIds[i]).trim());
    if (h) out.push(h);
  }
  return out;
}

function hostRowPendingFromApi(row) {
  return {
    ...row,
    alive: false,
    ms: null,
    state: 'pending',
    error: null,
    lastDownSince: null,
  };
}

/** Swap two positions in the full host list by id (used by drag-and-drop). */
function swapHostIds(hostList, idA, idB) {
  const sa = String(idA).trim();
  const sb = String(idB).trim();
  if (!sa || !sb || sa === sb) return null;
  const ids = hostList.map((host) => host._id);
  const i = ids.findIndex((id) => String(id) === sa);
  const j = ids.findIndex((id) => String(id) === sb);
  if (i === -1 || j === -1) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function formatDownSince(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

const NO_TYPE = '(no type)';
const TYPE_CUSTOM = '__custom__';

const CONNECT_NONE = 'none';
const CONNECT_SSH = 'ssh';
const CONNECT_HTTP = 'http';
const CONNECT_BOTH = 'both';

function normalizeConnectModeClient(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'web' || s === 'https' || s === 'http/s') return CONNECT_HTTP;
  if (s === CONNECT_SSH || s === CONNECT_HTTP || s === CONNECT_BOTH) return s;
  return CONNECT_NONE;
}

function bracketIpv6Host(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (t.includes(':') && !t.startsWith('[')) return `[${t}]`;
  return t;
}

function resolveBrowserUrl(webUrl, ip) {
  const u = String(webUrl || '').trim();
  if (u) {
    if (/^https?:\/\//i.test(u)) return u;
    return `https://${u}`;
  }
  const t = bracketIpv6Host(ip);
  if (!t) return '';
  return `https://${t}`;
}

const STATUS_FILTER_ALL = 'All';
const STATUS_FILTER_UP = 'Up';
const STATUS_FILTER_DOWN = 'Down';

/** One canonical label per type, ignoring case (first occurrence wins). */
function distinctTypesFromHosts(hostList) {
  const byLower = new Map();
  for (let i = 0; i < hostList.length; i += 1) {
    const t = (hostList[i].type || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, t);
  }
  return Array.from(byLower.values()).sort((a, b) => a.localeCompare(b));
}

function typeEqualsFilter(hostType, filterValue) {
  const t = (hostType || '').trim();
  return t.toLowerCase() === String(filterValue || '').trim().toLowerCase();
}

function resolveInitialStatusFilter(value) {
  if (value === STATUS_FILTER_UP || value === STATUS_FILTER_DOWN || value === STATUS_FILTER_ALL) {
    return value;
  }
  return STATUS_FILTER_ALL;
}

/** LDAP pinger group (pingerAccess) without isAdmin: view status only. */
function computePingerReadOnly() {
  const token = localStorage.getItem('token');
  if (!token) return true;
  try {
    const d = jwtDecode(token);
    if (isJwtExpired(d)) return true;
    if (d.isAdmin) return false;
    if (d.pingerAccess) return true;
    return true;
  } catch {
    return true;
  }
}

function PingerPage({ initialStatusFilter } = {}) {
  const [hosts, setHosts] = useState([]);
  const [checkedAt, setCheckedAt] = useState('');
  const [warnMs, setWarnMs] = useState(200);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [form, setForm] = useState({
    hostname: '',
    ip: '',
    type: '',
    connectMode: CONNECT_NONE,
    webUrl: '',
  });
  /** '' | known type string | TYPE_CUSTOM — keeps select stable for "Other…". */
  const [typePick, setTypePick] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHostModal, setShowHostModal] = useState(false);
  const [hostModalEditId, setHostModalEditId] = useState(null);
  const [addFormError, setAddFormError] = useState('');
  const hostModalFirstInputRef = useRef(null);
  const [sshSessions, setSshSessions] = useState([]);
  const [sshActiveId, setSshActiveId] = useState(null);
  const [pingerSshIdleMinutes, setPingerSshIdleMinutes] = useState(5);
  const [pingerSshCommonCommands, setPingerSshCommonCommands] = useState([]);
  const [liveEnabled, setLiveEnabled] = useState(() => {
    try {
      return sessionStorage.getItem(LIVE_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  /** Right-click menu: { x, y, host, index } */
  const [cardContextMenu, setCardContextMenu] = useState(null);
  const cardContextMenuRef = useRef(null);
  const importJsonInputRef = useRef(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);
  const [typeFilter, setTypeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState(() => resolveInitialStatusFilter(initialStatusFilter));

  const pingerReadOnly = useMemo(() => computePingerReadOnly(), []);

  const openSshSession = useCallback((host) => {
    const id = `${host._id}-${Date.now()}`;
    setSshSessions((prev) => [
      ...prev,
      { id, host, phase: 'login', username: '', reconnectCreds: null },
    ]);
    setSshActiveId(id);
  }, []);

  const closeSshSession = useCallback((id) => {
    setSshSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setSshActiveId((cur) => {
        if (cur !== id) return cur;
        return next.length ? next[next.length - 1].id : null;
      });
      return next;
    });
  }, []);

  const selectSshTab = useCallback((id) => setSshActiveId(id), []);

  const updateSshSessionMeta = useCallback((id, phase, username) => {
    setSshSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, phase: phase || s.phase, username: username ?? s.username } : s)),
    );
  }, []);

  const openHostWeb = useCallback((h) => {
    const mode = normalizeConnectModeClient(h.connectMode);
    if (mode !== CONNECT_HTTP && mode !== CONNECT_BOTH) return;
    const url = safeLink(resolveBrowserUrl(h.webUrl, h.ip));
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const typeOptions = useMemo(() => {
    let hasEmpty = false;
    for (let i = 0; i < hosts.length; i += 1) {
      if (!(hosts[i].type || '').trim()) hasEmpty = true;
    }
    const opts = ['All'];
    if (hasEmpty) opts.push(NO_TYPE);
    opts.push(...distinctTypesFromHosts(hosts));
    return opts;
  }, [hosts]);

  /** Distinct non-empty types (for add/edit dropdown). */
  const formTypeOptions = useMemo(() => distinctTypesFromHosts(hosts), [hosts]);

  const filteredHosts = useMemo(() => {
    let list = hosts;
    if (typeFilter !== 'All') {
      list = list.filter((h) => {
        const t = (h.type || '').trim();
        if (typeFilter === NO_TYPE) return !t;
        return typeEqualsFilter(t, typeFilter);
      });
    }
    if (statusFilter === STATUS_FILTER_UP) {
      list = list.filter((h) => h.state !== 'down');
    } else if (statusFilter === STATUS_FILTER_DOWN) {
      list = list.filter((h) => h.state === 'down');
    }
    return list;
  }, [hosts, typeFilter, statusFilter]);

  useEffect(() => {
    if (typeOptions.includes(typeFilter)) return;
    setTypeFilter('All');
  }, [typeOptions, typeFilter]);

  const loadStatus = useCallback(async (options = {}) => {
    const fresh = options.fresh === true;
    const token = localStorage.getItem('token');
    if (!token) {
      setError('Sign in to use Pinger.');
      setLoading(false);
      setHosts([]);
      return;
    }
    setError('');
    try {
      const qs = fresh ? '?fresh=1' : '';
      const res = await fetch(`/api/pinger/status${qs}`, { headers: { ...authHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      setHosts(Array.isArray(data.hosts) ? data.hosts : []);
      setCheckedAt(data.checkedAt || '');
      setWarnMs(typeof data.warnMs === 'number' ? data.warnMs : 200);
    } catch (e) {
      setError(e.message || 'Failed to load status');
      setHosts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/public');
        const data = await res.json().catch(() => ({}));
        if (cancelled || !res.ok) return;
        const n = Number(data.pingerSshIdleTimeoutMinutes);
        if (Number.isFinite(n) && n >= 1) {
          setPingerSshIdleMinutes(Math.min(Math.round(n), 1440));
        }
        if (Array.isArray(data.pingerSshCommonCommands)) {
          setPingerSshCommonCommands(data.pingerSshCommonCommands);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LIVE_STORAGE_KEY, liveEnabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [liveEnabled]);

  useEffect(() => {
    if (!liveEnabled) return undefined;
    const t = setInterval(loadStatus, POLL_MS);
    return () => clearInterval(t);
  }, [liveEnabled, loadStatus]);

  const closeCardContextMenu = useCallback(() => setCardContextMenu(null), []);

  useEffect(() => {
    if (!cardContextMenu) return undefined;
    const onPointerDown = (ev) => {
      if (cardContextMenuRef.current?.contains(ev.target)) return;
      closeCardContextMenu();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') closeCardContextMenu();
    };
    const onScroll = () => closeCardContextMenu();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [cardContextMenu, closeCardContextMenu]);

  const handleExportPingerJson = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setError('Sign in to use Pinger.');
      return;
    }
    setError('');
    try {
      const res = await fetch('/api/pinger/hosts/export', { headers: { ...authHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      const out = { hosts: Array.isArray(data.hosts) ? data.hosts : [] };
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pinger-hosts_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || 'Export failed');
    }
  }, []);

  const handleImportJsonPick = useCallback(() => {
    if (pingerReadOnly) return;
    setImportNotice('');
    setError('');
    importJsonInputRef.current?.click();
  }, [pingerReadOnly]);

  const handleImportJsonChange = useCallback(
    async (ev) => {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      if (!file || pingerReadOnly) return;
      setError('');
      setImportNotice('');
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const res = await fetch('/api/pinger/hosts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(parsed),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
        await loadStatus({ fresh: true });
        const skipped = typeof data.skipped === 'number' ? data.skipped : 0;
        const imported = typeof data.imported === 'number' ? data.imported : 0;
        setImportNotice(
          skipped
            ? `Import finished: ${imported} added, ${skipped} row(s) skipped.`
            : `Import finished: ${imported} host(s) added.`,
        );
      } catch (e) {
        setError(e.message || 'Import failed');
      }
    },
    [pingerReadOnly, loadStatus],
  );

  useEffect(() => {
    if (!showHostModal) return;
    const t = requestAnimationFrame(() => {
      hostModalFirstInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [showHostModal]);

  const openAddModal = () => {
    if (pingerReadOnly) return;
    setHostModalEditId(null);
    setTypePick('');
    setForm({
      hostname: '',
      ip: '',
      type: '',
      connectMode: CONNECT_NONE,
      webUrl: '',
    });
    setAddFormError('');
    setShowHostModal(true);
  };

  const openEditModal = (h) => {
    if (pingerReadOnly) return;
    setHostModalEditId(h._id);
    const hostname = h.hostname != null ? String(h.hostname) : '';
    const ip = h.ip != null ? String(h.ip) : '';
    const typeRaw = h.type != null ? String(h.type) : '';
    const t = typeRaw.trim();
    setForm({
      hostname,
      ip,
      type: typeRaw,
      connectMode: normalizeConnectModeClient(h.connectMode),
      webUrl: h.webUrl != null ? String(h.webUrl) : '',
    });
    const opts = distinctTypesFromHosts(hosts);
    if (!t) setTypePick('');
    else {
      const found = opts.find((opt) => opt.toLowerCase() === t.toLowerCase());
      if (found) setTypePick(found);
      else setTypePick(TYPE_CUSTOM);
    }
    setAddFormError('');
    setShowHostModal(true);
  };

  const closeHostModal = () => {
    setAddFormError('');
    setShowHostModal(false);
    setHostModalEditId(null);
    setTypePick('');
    setForm({
      hostname: '',
      ip: '',
      type: '',
      connectMode: CONNECT_NONE,
      webUrl: '',
    });
  };

  const onTypeSelectChange = (ev) => {
    const v = ev.target.value;
    if (v === '') {
      setTypePick('');
      setForm((f) => ({ ...f, type: '' }));
      return;
    }
    if (v === TYPE_CUSTOM) {
      setTypePick(TYPE_CUSTOM);
      setForm((f) => {
        const cur = (f.type || '').trim();
        const known = formTypeOptions.some((o) => o.toLowerCase() === cur.toLowerCase());
        if (cur && !known) return { ...f };
        return { ...f, type: '' };
      });
      return;
    }
    setTypePick(v);
    setForm((f) => ({ ...f, type: v }));
  };

  const handleHostSubmit = async (e) => {
    e.preventDefault();
    if (pingerReadOnly) return;
    const hostname = form.hostname.trim();
    const ip = form.ip.trim();
    if (!hostname || !ip) return;
    const mode = form.connectMode;
    const webUrl =
      mode === CONNECT_HTTP || mode === CONNECT_BOTH ? String(form.webUrl || '').trim() : '';
    setSaving(true);
    setAddFormError('');
    try {
      if (hostModalEditId) {
        const res = await fetch(`/api/pinger/hosts/${encodeURIComponent(hostModalEditId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            hostname,
            ip,
            type: form.type.trim(),
            connectMode: mode,
            webUrl,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
        closeHostModal();
        setHosts((prev) =>
          prev.map((h) => {
            if (String(h._id) !== String(hostModalEditId)) return h;
            const next = { ...h, ...data };
            const ipSame = String(h.ip || '') === String(data.ip || '');
            if (ipSame) return next;
            return hostRowPendingFromApi(next);
          }),
        );
        void loadStatus({ fresh: true });
      } else {
        const res = await fetch('/api/pinger/hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            hostname,
            ip,
            type: form.type.trim(),
            connectMode: mode,
            webUrl,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
        closeHostModal();
        setHosts((prev) => sortHostsLikeBackend([...prev, hostRowPendingFromApi(data)]));
        void loadStatus({ fresh: true });
      }
    } catch (err) {
      setAddFormError(err.message || (hostModalEditId ? 'Update failed' : 'Add failed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id) => {
    if (pingerReadOnly) return;
    if (!window.confirm('Remove this host from Pinger?')) return;
    setError('');
    try {
      const res = await fetch(`/api/pinger/hosts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      await loadStatus({ fresh: true });
    } catch (err) {
      setError(err.message || 'Remove failed');
    }
  };

  const persistReorder = async (newIds) => {
    if (pingerReadOnly) return;
    const ids = newIds.map((id) => String(id).trim());
    setHosts((prev) => applyHostOrder(prev, ids));
    setError('');
    try {
      const res = await fetch('/api/pinger/hosts/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      if (Array.isArray(data.hosts) && data.hosts.length) {
        setHosts((prev) => {
          const byId = new Map(data.hosts.map((r) => [String(r._id), r]));
          return prev.map((h) => {
            const row = byId.get(String(h._id));
            return row ? { ...h, sortOrder: row.sortOrder ?? h.sortOrder } : h;
          });
        });
      }
    } catch (err) {
      setError(err.message || 'Reorder failed');
      void loadStatus({ fresh: true });
    }
  };

  const moveUp = (index) => {
    if (index <= 0) return;
    const ids = hosts.map((h) => h._id);
    const next = [...ids];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    persistReorder(next);
  };

  const moveDown = (index) => {
    if (index >= hosts.length - 1) return;
    const ids = hosts.map((h) => h._id);
    const next = [...ids];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    persistReorder(next);
  };

  const onDragStart = (e, hostId) => {
    if (pingerReadOnly) return;
    const id = String(hostId).trim();
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(id);
    setDropTargetIndex(null);
  };

  const onDragEnd = () => {
    setDraggingId(null);
    setDropTargetIndex(null);
  };

  const onDragOver = (e, index) => {
    if (pingerReadOnly) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetIndex(index);
  };

  const onDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropTargetIndex(null);
  };

  const onDrop = (e, targetIndex) => {
    if (pingerReadOnly) return;
    e.preventDefault();
    setDropTargetIndex(null);
    const draggedId = String(e.dataTransfer.getData('text/plain') || '').trim();
    if (!draggedId) return;
    const targetHost = hosts[targetIndex];
    if (!targetHost) return;
    const next = swapHostIds(hosts, draggedId, targetHost._id);
    if (next) persistReorder(next);
    setDraggingId(null);
  };

  const onCardContextMenu = (e, h, index) => {
    e.preventDefault();
    e.stopPropagation();
    const pad = 8;
    const mw = 200;
    const mh = 220;
    let x = e.clientX;
    let y = e.clientY;
    if (x + mw > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - mw - pad);
    if (y + mh > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - mh - pad);
    setCardContextMenu({ x, y, host: h, index });
  };

  const msLabel = (h) => {
    if (h.state === 'pending') return '…';
    if (h.state === 'down') return '';
    if (h.ms != null && Number.isFinite(h.ms)) return `${Math.round(h.ms)} ms`;
    return '—';
  };

  const cardStateClass = (h) => {
    if (h.state === 'warn') return 'warn';
    if (h.state === 'pending') return 'pending';
    return h.state === 'up' ? 'up' : 'down';
  };

  const isEdit = Boolean(hostModalEditId);

  const ctxMode = cardContextMenu
    ? normalizeConnectModeClient(cardContextMenu.host?.connectMode)
    : CONNECT_NONE;
  const ctxCanSsh =
    Boolean(cardContextMenu) && (ctxMode === CONNECT_SSH || ctxMode === CONNECT_BOTH);
  const ctxCanWeb =
    Boolean(cardContextMenu) && (ctxMode === CONNECT_HTTP || ctxMode === CONNECT_BOTH);
  const ctxMenuSep = Boolean(cardContextMenu) && !pingerReadOnly && (ctxCanSsh || ctxCanWeb);

  return (
    <section className="pinger-page" dir="ltr" lang="en" aria-label="Pinger dashboard">
      <div className="pinger-page__header">
        <div className="pinger-page__title-row">
          <h2 className="pinger-page__title">Pinger</h2>
          <div className="pinger-page__title-actions">
            <label
              className={`pinger-page__live ${liveEnabled ? 'pinger-page__live--on' : ''}`}
            >
              <input
                type="checkbox"
                className="pinger-page__live-input"
                checked={liveEnabled}
                onChange={(ev) => setLiveEnabled(ev.target.checked)}
              />
              <span className="pinger-page__live-text">Live</span>
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => loadStatus({ fresh: true })}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleExportPingerJson}
              disabled={loading}
              aria-label="Export hosts as JSON"
            >
              Export JSON
            </button>
            {!pingerReadOnly && (
              <>
                <input
                  ref={importJsonInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="pinger-page__import-input-hidden"
                  onChange={handleImportJsonChange}
                  aria-hidden
                  tabIndex={-1}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleImportJsonPick}
                  disabled={loading}
                  aria-label="Import hosts from JSON"
                >
                  Import JSON
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={openAddModal}
                  aria-label="Add host"
                >
                  Add host
                </button>
              </>
            )}
          </div>
        </div>
        <p className="pinger-page__subtitle">
          ICMP from server — green / yellow / red by latency (warn ≥ {warnMs} ms) and reachability. Right-click a host for
          SSH session or web UI when configured.
          {!pingerReadOnly && (
            <>
              {' '}
              <p className="pinger-page__hint-inline">
              <span className="pinger-page__hint-inline">
                Import uses <code className="pinger-page__hint-code">name</code>,{' '}
                <code className="pinger-page__hint-code">ip</code>, and{' '}
                <code className="pinger-page__hint-code">type</code>, optional{' '}
                <code className="pinger-page__hint-code">connectMode</code> (none | ssh | http | both),{' '}
                <code className="pinger-page__hint-code">webUrl</code> per object; other fields are ignored.
              </span>
              </p>
            </>
          )}
          {pingerReadOnly && (
            <>
              {' '}
              <span className="pinger-page__readonly-note">View only.</span>
            </>
          )}
          {checkedAt && (
            <>
              {' '}
              <span className="pinger-page__checked-inline">
                Last check: {new Date(checkedAt).toLocaleString()}
              </span>
            </>
          )}
        </p>
        {hosts.length > 0 && (
          <div className="pinger-page__filter-row">
            <label className="pinger-page__filter-label" htmlFor="pinger-type-filter">
              Type
            </label>
            <select
              id="pinger-type-filter"
              className="pinger-page__filter-select"
              value={typeFilter}
              onChange={(ev) => setTypeFilter(ev.target.value)}
            >
              {typeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt === NO_TYPE ? '(no type)' : opt}
                </option>
              ))}
            </select>
            <label className="pinger-page__filter-label" htmlFor="pinger-status-filter">
              Status
            </label>
            <select
              id="pinger-status-filter"
              className="pinger-page__filter-select"
              value={statusFilter}
              onChange={(ev) => setStatusFilter(ev.target.value)}
            >
              <option value={STATUS_FILTER_ALL}>All</option>
              <option value={STATUS_FILTER_UP}>Up</option>
              <option value={STATUS_FILTER_DOWN}>Down</option>
            </select>
            <span className="pinger-page__filter-count">
              {filteredHosts.length} / {hosts.length}
            </span>
          </div>
        )}
      </div>

      {error && <p className="pinger-page__error">{error}</p>}
      {importNotice && !error && <p className="pinger-page__notice">{importNotice}</p>}

      {showHostModal && !pingerReadOnly && (
        <div
          className="modal-overlay"
          onClick={closeHostModal}
          role="presentation"
        >
          <div
            className="modal-content pinger-add-modal"
            dir="ltr"
            lang="en"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pinger-host-modal-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="modal-header pinger-add-modal__header">
              <h3 id="pinger-host-modal-title" className="modal-title pinger-add-modal__title">
                {isEdit ? 'Edit host' : 'Add host'}
              </h3>
              <button
                type="button"
                className="close-button pinger-add-modal__close"
                onClick={closeHostModal}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <form className="pinger-add-modal__form" onSubmit={handleHostSubmit}>
              {addFormError && (
                <p className="pinger-add-modal__error" role="alert">
                  {addFormError}
                </p>
              )}
              <div className="pinger-add-modal__field">
                <label className="pinger-add-modal__label" htmlFor="pinger-host-modal-hostname">
                  Hostname
                </label>
                <input
                  id="pinger-host-modal-hostname"
                  ref={hostModalFirstInputRef}
                  className="pinger-add-modal__input"
                  placeholder="Label"
                  value={form.hostname}
                  onChange={(ev) => setForm((f) => ({ ...f, hostname: ev.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="pinger-add-modal__field">
                <label className="pinger-add-modal__label ltr" dir="ltr" htmlFor="pinger-host-modal-ip">
                  IP / FQDN
                </label>
                <input
                  id="pinger-host-modal-ip"
                  className="pinger-add-modal__input ltr"
                  dir="ltr"
                  placeholder="Ping target"
                  value={form.ip}
                  onChange={(ev) => setForm((f) => ({ ...f, ip: ev.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="pinger-add-modal__field">
                <label className="pinger-add-modal__label" htmlFor="pinger-host-modal-type">
                  Type
                </label>
                <select
                  id="pinger-host-modal-type"
                  className="pinger-add-modal__select"
                  value={typePick}
                  onChange={onTypeSelectChange}
                >
                  <option value="">(no type)</option>
                  {formTypeOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  <option value={TYPE_CUSTOM}>Other…</option>
                </select>
                {typePick === TYPE_CUSTOM && (
                  <input
                    id="pinger-host-modal-type-custom"
                    className="pinger-add-modal__input pinger-add-modal__input--type-custom"
                    placeholder="Type name"
                    value={form.type}
                    onChange={(ev) => setForm((f) => ({ ...f, type: ev.target.value }))}
                    autoComplete="off"
                  />
                )}
              </div>
              <div className="pinger-add-modal__field">
                <span className="pinger-add-modal__label" id="pinger-host-modal-connect-label">
                  Quick connect
                </span>
                <div
                  className="pinger-connect-mode-row"
                  role="group"
                  aria-labelledby="pinger-host-modal-connect-label"
                >
                  {[
                    { value: CONNECT_NONE, label: 'None' },
                    { value: CONNECT_SSH, label: 'SSH' },
                    { value: CONNECT_HTTP, label: 'HTTP(S)' },
                    { value: CONNECT_BOTH, label: 'Both' },
                  ].map((opt) => (
                    <label key={opt.value} className="pinger-connect-mode-option">
                      <input
                        type="radio"
                        name="pinger-connect-mode"
                        value={opt.value}
                        checked={form.connectMode === opt.value}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            connectMode: opt.value,
                          }))
                        }
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              {(form.connectMode === CONNECT_HTTP || form.connectMode === CONNECT_BOTH) && (
                <div className="pinger-add-modal__field">
                  <label className="pinger-add-modal__label ltr" dir="ltr" htmlFor="pinger-host-modal-web-url">
                    Web URL (optional)
                  </label>
                  <input
                    id="pinger-host-modal-web-url"
                    className="pinger-add-modal__input ltr"
                    dir="ltr"
                    placeholder="https://… — empty uses https://[IP/FQDN]"
                    value={form.webUrl}
                    onChange={(ev) => setForm((f) => ({ ...f, webUrl: ev.target.value }))}
                    autoComplete="off"
                  />
                </div>
              )}
              <div className="pinger-add-modal__actions">
                <button type="submit" className="login-submit pinger-add-modal__submit" disabled={saving}>
                  {saving ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {sshSessions.length > 0 && (
        <PingerSshManager
          sessions={sshSessions}
          activeId={sshActiveId}
          onSelectTab={selectSshTab}
          onSessionMeta={updateSshSessionMeta}
          onCloseSession={closeSshSession}
          idleMinutes={pingerSshIdleMinutes}
          commonCommandsCatalog={pingerSshCommonCommands}
        />
      )}

      {loading && hosts.length === 0 ? (
        <p className="pinger-page__loading">Loading…</p>
      ) : hosts.length === 0 ? (
        <p className="pinger-page__empty">
          {pingerReadOnly ? 'No hosts configured.' : 'No hosts configured. Click Add host to add one.'}
        </p>
      ) : filteredHosts.length === 0 ? (
        <p className="pinger-page__empty">No hosts match the current filters.</p>
      ) : (
        <ul
          className="pinger-page__grid"
          onDragOver={(e) => {
            if (pingerReadOnly) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
        >
          {filteredHosts.map((h) => {
            const index = hosts.findIndex((x) => String(x._id) === String(h._id));
            const msText = msLabel(h);
            return (
            <li
              key={h._id}
              draggable={!pingerReadOnly}
              onDragStart={(e) => onDragStart(e, h._id)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, index)}
              onDragLeave={onDragLeave}
              onDrop={(e) => onDrop(e, index)}
              onContextMenu={(e) => onCardContextMenu(e, h, index)}
              className={`pinger-card pinger-card--${cardStateClass(h)}${
                pingerReadOnly ? ' pinger-card--readonly' : ' pinger-card--no-reorder'
              }${
                draggingId === String(h._id) ? ' pinger-card--dragging' : ''
              }${
                dropTargetIndex === index && draggingId && draggingId !== String(h._id)
                  ? ' pinger-card--drop-hover'
                  : ''
              }`}
            >
              <div className="pinger-card__body">
                <span className="pinger-card__hostname" title={h.hostname || ''}>
                  {h.hostname || '—'}
                </span>
                <span className="pinger-card__ip ltr" dir="ltr" title={h.ip || ''}>
                  {h.ip || '—'}
                </span>
                <span className="pinger-card__type" title={h.type || ''}>
                  {h.type || '—'}
                </span>
                <div className="pinger-card__ms-row ltr" dir="ltr">
                  {msText !== '' && <span className="pinger-card__ms">{msText}</span>}
                  {h.state === 'down' && h.lastDownSince && (
                    <span
                      className="pinger-card__down-since"
                      title="Down since (server time)"
                    >
                      Down: {formatDownSince(h.lastDownSince)}
                    </span>
                  )}
                </div>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      {cardContextMenu && (
        <div
          ref={cardContextMenuRef}
          className="pinger-card-context-menu"
          role="menu"
          style={{ left: cardContextMenu.x, top: cardContextMenu.y }}
        >
          {ctxCanSsh && (
            <button
              type="button"
              className="pinger-card-context-menu__item"
              role="menuitem"
              onClick={() => {
                const { host } = cardContextMenu;
                closeCardContextMenu();
                openSshSession(host);
              }}
            >
              SSH session…
            </button>
          )}
          {ctxCanWeb && (
            <button
              type="button"
              className="pinger-card-context-menu__item"
              role="menuitem"
              onClick={() => {
                const { host } = cardContextMenu;
                closeCardContextMenu();
                openHostWeb(host);
              }}
            >
              Open web UI
            </button>
          )}
          {ctxMenuSep && <div className="pinger-card-context-menu__sep" aria-hidden />}
          {!pingerReadOnly && (
            <>
              <button
                type="button"
                className="pinger-card-context-menu__item"
                role="menuitem"
                onClick={() => {
                  const { host } = cardContextMenu;
                  closeCardContextMenu();
                  openEditModal(host);
                }}
              >
                Edit host
              </button>
              <button
                type="button"
                className="pinger-card-context-menu__item"
                role="menuitem"
                disabled={cardContextMenu.index <= 0}
                onClick={() => {
                  const i = cardContextMenu.index;
                  closeCardContextMenu();
                  if (i > 0) moveUp(i);
                }}
              >
                Move up
              </button>
              <button
                type="button"
                className="pinger-card-context-menu__item"
                role="menuitem"
                disabled={cardContextMenu.index < 0 || cardContextMenu.index >= hosts.length - 1}
                onClick={() => {
                  const i = cardContextMenu.index;
                  closeCardContextMenu();
                  if (i >= 0 && i < hosts.length - 1) moveDown(i);
                }}
              >
                Move down
              </button>
              <button
                type="button"
                className="pinger-card-context-menu__item pinger-card-context-menu__item--danger"
                role="menuitem"
                onClick={() => {
                  const id = cardContextMenu.host?._id;
                  closeCardContextMenu();
                  if (id != null) void handleRemove(id);
                }}
              >
                Remove host
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default PingerPage;
