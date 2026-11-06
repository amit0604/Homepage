import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { jwtDecode } from 'jwt-decode';
import { isJwtExpired } from '../utils/jwtSession';
import AppInfoDialog from './AppInfoDialog';
import { InfoIcon } from './Icons';
import { safeLink } from '../utils/safeUrl';
/** Match TeamsChatPanel: open this conversation when switching to the Chat tab from home. */
const CHAT_FOCUS_CONV_STORAGE_KEY = 'sc_chat_focus_conv_id';

function chatUnreadKindLabel(type) {
  switch (String(type || '').toLowerCase()) {
    case 'global':
      return 'Channel';
    case 'dm':
      return 'Direct';
    case 'group':
      return 'Group';
    default:
      return 'Chat';
  }
}
function displayShortcutUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  try {
    const u = new URL(s);
    return `${u.host}${u.pathname}${u.search || ''}`;
  } catch {
    return s.length > 80 ? `${s.slice(0, 78)}…` : s;
  }
}

function QuickLinkFavoriteStar({ sid, isFavorite, toggleFavorite }) {
  return (
    <button
      type="button"
      className={`quick-link-favorite${isFavorite ? ' quick-link-favorite--active' : ''}`}
      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={isFavorite}
      title={isFavorite ? 'Remove favorite' : 'Favorite'}
      onClick={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (sid) toggleFavorite(sid, !isFavorite);
      }}
    >
      <span aria-hidden>{isFavorite ? '★' : '☆'}</span>
    </button>
  );
}

function isShortcutFavoritesEligible() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return false;
    return !isJwtExpired(jwtDecode(token));
  } catch {
    return false;
  }
}

function QuickLinkThumb({ item }) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [item.imgSrc]);

  const hasSrc = Boolean(item.imgSrc);
  const showImg = hasSrc && !imgFailed;
  const useContain = item.imageFit === 'contain';

  if (!showImg) {
    const letter = (item.title || item.url || '?').trim().charAt(0).toUpperCase() || '?';
    return (
      <div className="quick-link-thumb-fallback" aria-hidden>
        {letter}
      </div>
    );
  }

  return (
    <div
      className={`quick-link-thumb-media ${useContain ? 'quick-link-thumb-media--contain' : 'quick-link-thumb-media--cover'}`}
    >
      <img
        src={item.imgSrc}
        alt=""
        onError={() => setImgFailed(true)}
      />
    </div>
  );
}

/** Admin home metric tile: open tickets, Checkmk down count, or Pinger down count (same 100×100 layout). */
function AdminHomeTile({
  checkmk,
  pinger,
  error,
  loading,
  notConfigured,
  count,
  onClick,
  ariaOk,
  ariaLoading,
}) {
  const mod = pinger ? ` home-admin-open-square--pinger${count > 0 ? ' home-admin-open-square--alert' : ''}` : checkmk ? ' home-admin-open-square--checkmk' : '';
  const kicker = pinger ? 'Pinger' : checkmk ? 'Down' : 'Open tickets';
  const errKicker = pinger ? 'Pinger' : checkmk ? 'Checkmk' : 'Open tickets';

  if (error) {
    return (
      <div
        className={`home-admin-open-square home-admin-open-square--error${mod}`}
        title={error}
        aria-label={error}
      >
        <span className="home-admin-open-square-inner">
          <span className="home-admin-open-square-kicker">{errKicker}</span>
          <span className="home-admin-open-square-mark" aria-hidden="true">!</span>
        </span>
      </div>
    );
  }
  if (loading) {
    return (
      <div
        className={`home-admin-open-square home-admin-open-square--loading${mod}`}
        aria-busy="true"
        aria-label={ariaLoading}
      >
        <span className="home-admin-open-square-inner home-admin-open-square-inner--center">
          <span className="home-admin-open-square-kicker">{kicker}</span>
          <span className="home-admin-open-square-dots">…</span>
        </span>
      </div>
    );
  }
  if (notConfigured && checkmk) {
    return (
      <div
        className={`home-admin-open-square home-admin-open-square--static${mod}`}
        title="Checkmk is not configured on the server."
        aria-label="Checkmk is not configured on the server."
      >
        <span className="home-admin-open-square-inner">
          <span className="home-admin-open-square-kicker">Checkmk</span>
          <span className="home-admin-open-square-num home-admin-open-square-num--muted" aria-hidden="true">
            —
          </span>
        </span>
      </div>
    );
  }

  const inner = (
    <span className="home-admin-open-square-inner">
      <span className="home-admin-open-square-kicker">{kicker}</span>
      <span className="home-admin-open-square-num" aria-hidden="true">{count}</span>
    </span>
  );
  if (typeof onClick === 'function') {
    return (
      <button type="button" className={`home-admin-open-square${mod}`} onClick={onClick} aria-label={ariaOk}>
        {inner}
      </button>
    );
  }
  return (
    <div className={`home-admin-open-square home-admin-open-square--static${mod}`} aria-label={ariaOk}>
      {inner}
    </div>
  );
}

/** Right-click menu on a shortcut, for admins. */
function TileMenu({ menu, onClose, onEdit }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="pinger-card-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      aria-label={`Actions for ${menu.title}`}
    >
      <button type="button" role="menuitem" className="pinger-card-context-menu__item" autoFocus onClick={onEdit}>
        Edit shortcut
      </button>
    </div>,
    document.body,
  );
}

function Entery({ onOpenAdminCheckmk, onOpenChat, onEditShortcut }) {
  const [brandLogo, setBrandLogo] = useState('logo192.png');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [isCompact, setIsCompact] = useState(true);
  const [notifications, setNotifications] = useState([]);
  const [apiShortcuts, setApiShortcuts] = useState([]);
  const [favoriteShortcutIds, setFavoriteShortcutIds] = useState(() => []);
  const [adminCheckmkCount, setAdminCheckmkCount] = useState(null);
  const [adminCheckmkConfigured, setAdminCheckmkConfigured] = useState(null);
  const [adminCheckmkError, setAdminCheckmkError] = useState('');
  const [checkmkUiEnabled, setCheckmkUiEnabled] = useState(true);
  const [systemInfo, setSystemInfo] = useState({ computerName: '', ipAddress: '' });
  const [systemInfoError, setSystemInfoError] = useState('');
  const [systemInfoLoaded, setSystemInfoLoaded] = useState(false);
  const [lobbyChatUiEnabled, setLobbyChatUiEnabled] = useState(true);
  const [homeUnreadChats, setHomeUnreadChats] = useState([]);
  const [homeMotd, setHomeMotd] = useState(null);

  const [infoAppId, setInfoAppId] = useState(null);
  const [tileMenu, setTileMenu] = useState(null);
  const [session] = useState(() => {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const decoded = jwtDecode(token);
      return isJwtExpired(decoded) ? null : decoded;
    } catch {
      return null;
    }
  });

  const [adminSession] = useState(() => {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const decoded = jwtDecode(token);
      if (isJwtExpired(decoded)) {
        return null;
      }
      if (!decoded.isAdmin) return null;
      return decoded;
    } catch {
      return null;
    }
  });

  const categoryChips = useMemo(() => {
    const cats = Array.from(new Set(
      apiShortcuts.map((s) => s.category).filter(Boolean),
    ));
    return ['All', ...cats];
  }, [apiShortcuts]);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('token');

    fetch('/api/shortcuts', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      })
      .then((data) => {
        if (!cancelled) setApiShortcuts(data);
      })
      .catch(() => {
        if (!cancelled) setApiShortcuts([]);
      });

    if (!token) {
      setFavoriteShortcutIds([]);
    } else {
      try {
        const decoded = jwtDecode(token);
        if (isJwtExpired(decoded)) {
          setFavoriteShortcutIds([]);
        } else {
          fetch('/api/shortcut-favorites', { headers: { Authorization: `Bearer ${token}` } })
            .then(async (res) => (res.ok ? res.json().catch(() => ({})) : {}))
            .then((body) => {
              if (cancelled) return;
              const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
              setFavoriteShortcutIds(ids);
            })
            .catch(() => {
              if (!cancelled) setFavoriteShortcutIds([]);
            });
        }
      } catch {
        setFavoriteShortcutIds([]);
      }
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const favoriteIdSet = useMemo(
    () => new Set(favoriteShortcutIds.map(String)),
    [favoriteShortcutIds],
  );

  const toggleFavorite = useCallback(async (shortcutId, nextFavorite) => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const r = await fetch('/api/shortcut-favorites', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ shortcutId: String(shortcutId), favorite: nextFavorite }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return;
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      setFavoriteShortcutIds(ids);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const response = await fetch('/api/notifications');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const visibleNotifications = Array.isArray(data)
          ? data.filter((notification) => notification.isVisible)
          : [];
        setNotifications(visibleNotifications);
      } catch (err) {
        console.error('Failed to fetch notifications:', err);
        setNotifications([]);
      }
    };

    fetchNotifications();
  }, []);

  useEffect(() => {
    if (!adminSession?.isAdmin) {
      setAdminCheckmkCount(null);
      setAdminCheckmkConfigured(null);
      setAdminCheckmkError('');
      setCheckmkUiEnabled(true);
      return;
    }
    const token = localStorage.getItem('token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let cancelled = false;
    setAdminCheckmkError('');
    setAdminCheckmkCount(null);
    setAdminCheckmkConfigured(null);

    const loadCheckmk = fetch('/api/admin/checkmk/down-hosts', { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error('checkmk');
        return res.json();
      })
      .then((data) => ({ ok: true, data }))
      .catch(() => ({ ok: false }));

    (async () => {
      let ckOn = true;
      try {
        const pr = await fetch('/api/settings/public');
        const pub = pr.ok ? await pr.json() : {};
        if (cancelled) return;
        ckOn = pub.checkmkUiEnabled !== false;
        setCheckmkUiEnabled(ckOn);
      } catch {
        if (cancelled) return;
        setCheckmkUiEnabled(true);
      }
      if (cancelled) return;

      if (!ckOn) {
        setAdminCheckmkCount(null);
        setAdminCheckmkConfigured(null);
        setAdminCheckmkError('');
        return;
      }

      const c = await loadCheckmk;
      if (cancelled) return;
      if (c.ok && c.data) {
        if (c.data.configured === false) {
          setAdminCheckmkConfigured(false);
          setAdminCheckmkCount(null);
        } else {
          setAdminCheckmkConfigured(true);
          const hosts = Array.isArray(c.data.hosts) ? c.data.hosts : [];
          setAdminCheckmkCount(hosts.length);
        }
      } else {
        setAdminCheckmkCount(null);
        setAdminCheckmkConfigured(null);
        setAdminCheckmkError('Checkmk unavailable.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adminSession]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/system-info')
      .then(async (res) => {
        if (!res.ok) throw new Error('system-info');
        const data = await res.json();
        return data && typeof data === 'object' ? data : {};
      })
      .then((data) => {
        if (cancelled) return;
        const next = {
          computerName: typeof data.computerName === 'string' ? data.computerName : '',
          ipAddress: typeof data.ipAddress === 'string' ? data.ipAddress : '',
        };
        setSystemInfo({
          computerName: next.computerName,
          ipAddress: next.ipAddress,
        });
        setSystemInfoError(next.computerName || next.ipAddress ? '' : 'Unavailable');
        setSystemInfoLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSystemInfo({ computerName: '', ipAddress: '' });
        setSystemInfoError('Unavailable');
        setSystemInfoLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshHomeUnreadChats = useCallback(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setHomeUnreadChats([]);
      return;
    }
    try {
      const decoded = jwtDecode(token);
      if (isJwtExpired(decoded)) {
        setHomeUnreadChats([]);
        return;
      }
    } catch {
      setHomeUnreadChats([]);
      return;
    }

    fetch('/api/chat/conversations', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (r.status === 403) return [];
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        const list = Array.isArray(data.conversations) ? data.conversations : [];
        return list.filter((c) => typeof c.unread === 'number' && c.unread > 0);
      })
      .then((rows) => {
        rows.sort((a, b) => {
          const diff = Number(b.unread || 0) - Number(a.unread || 0);
          if (diff !== 0) return diff;
          return String(a.title || '').localeCompare(String(b.title || ''), undefined, {
            sensitivity: 'base',
          });
        });
        setHomeUnreadChats(rows);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/motd')
        .then((r) => (r.ok ? r.json() : {}))
        .then((d) => {
          if (!cancelled) setHomeMotd(d && typeof d === 'object' ? d : null);
        })
        .catch(() => {
          if (!cancelled) setHomeMotd(null);
        });
    };
    load();
    const id = setInterval(load, 120000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/public')
      .then((r) => (r.ok ? r.json() : {}))
      .then((settings) => {
        if (cancelled) return;
        setLobbyChatUiEnabled(settings?.lobbyChatEnabled !== false);
        if (settings?.logoUrl) setBrandLogo(settings.logoUrl);
      })
      .catch(() => {
        if (!cancelled) setLobbyChatUiEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!lobbyChatUiEnabled) {
      setHomeUnreadChats([]);
      return undefined;
    }
    const tick = () => refreshHomeUnreadChats();
    tick();
    const id = setInterval(tick, 20000);
    const onFocus = () => tick();
    const onActivity = () => tick();
    const onVis = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('sc:chat-activity', onActivity);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('sc:chat-activity', onActivity);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [lobbyChatUiEnabled, refreshHomeUnreadChats]);

  const openUnreadChatThread = useCallback(
    (conversationId) => {
      try {
        sessionStorage.setItem(CHAT_FOCUS_CONV_STORAGE_KEY, String(conversationId));
      } catch {
        /* ignore */
      }
      if (typeof onOpenChat === 'function') {
        onOpenChat();
      }
    },
    [onOpenChat],
  );

  const checkmkTileLoading =
    checkmkUiEnabled &&
    adminCheckmkConfigured === null &&
    adminCheckmkCount === null &&
    !adminCheckmkError;

  const infoApp = useMemo(
    () => apiShortcuts.find((s) => String(s._id) === String(infoAppId)) || null,
    [apiShortcuts, infoAppId],
  );
  const closeInfo = useCallback(() => setInfoAppId(null), []);

  const filteredHomeItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const rows = apiShortcuts
      .filter((item) => {
        const matchesCategory = activeCategory === 'All' || item.category === activeCategory;
        const urlStr = (item.url || '').toLowerCase();
        const matchesQuery = !query ||
          (item.title || '').toLowerCase().includes(query) ||
          (item.description || '').toLowerCase().includes(query) ||
          (item.category || '').toLowerCase().includes(query) ||
          urlStr.includes(query);
        return matchesCategory && matchesQuery;
      })
      .map((item, originalIndex) => ({
        kind: 'shortcut',
        shortcutId: item._id,
        originalIndex,
        key: `shortcut-${item._id}`,
        title: item.title,
        description: item.description || '',
        url: item.url,
        imgSrc: item.imgSrc || '',
        imageFit: 'cover',
        category: item.category || 'General',
      }));

    rows.sort((a, b) => {
      const fa = favoriteIdSet.has(String(a.shortcutId)) ? 0 : 1;
      const fb = favoriteIdSet.has(String(b.shortcutId)) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return a.originalIndex - b.originalIndex;
    });

    return rows;
  }, [searchQuery, activeCategory, apiShortcuts, favoriteIdSet]);

  return (
    <section id="entery">
      <div className="home-shell">
        <div className="home-shell-layout">
          <div className="home-hero">
            <img className="home-hero__logo" src={brandLogo} alt="" />
            <h1 className="home-hero__title" dir="auto">
              {session ? `Hello ${session.username}!` : 'Pituah Home Page'}
            </h1>
              <aside className="home-system-widget" aria-label="Computer details">
                <div className="home-system-widget__row">
                  <span className="home-system-widget__label">Name</span>
                  <span className="home-system-widget__value">
                    {systemInfo.computerName || (systemInfoError ? systemInfoError : (systemInfoLoaded ? 'Unavailable' : 'Loading...'))}
                  </span>
                </div>
                <div className="home-system-widget__row">
                  <span className="home-system-widget__label">IP</span>
                  <span className="home-system-widget__value">
                    {systemInfo.ipAddress || (systemInfoError ? systemInfoError : (systemInfoLoaded ? 'Unavailable' : 'Loading...'))}
                  </span>
                </div>
              </aside>
          <div className="quick-links-search-row">
            <input
              type="search"
              placeholder="Filter shortcuts by name, URL, or category..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-bar quick-links-filter"
              aria-label="Filter shortcuts"
            />
          </div>
            {adminSession?.isAdmin && checkmkUiEnabled ? (
              <div className="home-shell-metrics" aria-label="Monitoring">
                <div className="home-admin-tiles">
                  <AdminHomeTile
                    checkmk
                    error={adminCheckmkError}
                    loading={checkmkTileLoading}
                    notConfigured={adminCheckmkConfigured === false}
                    count={adminCheckmkCount}
                    onClick={onOpenAdminCheckmk}
                    ariaOk={
                      adminCheckmkCount != null
                        ? `${adminCheckmkCount} Checkmk hosts down or unreachable. Open Checkmk in admin.`
                        : 'Checkmk down hosts'
                    }
                    ariaLoading="Loading Checkmk down host count"
                  />
                </div>
              </div>
            ) : null}
          </div>
          <div className="home-shell-content">
            <div className="quick-links-panel">
          {notifications.length > 0 ? (
            <aside
              className="home-notifications-widget"
              aria-label="Announcements"
            >
              <h2 className="home-notifications-widget__title">Announcements</h2>
              <div className="home-notifications-widget__list">
                {notifications.map((notification) => (
                  <article key={notification._id} className="home-notification-card">
                    <span className="home-notification-card__icon" aria-hidden="true">
                      {notification.icon || '!'}
                    </span>
                    <div className="home-notification-card__body">
                      {notification.title ? (
                        <h3 className="home-notification-card__title">{notification.title}</h3>
                      ) : null}
                      {notification.description ? (
                        <p className="home-notification-card__desc">{notification.description}</p>
                      ) : null}
                      {safeLink(notification.link) ? (
                        <a
                          className="home-notification-card__link"
                          href={safeLink(notification.link)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Read more
                        </a>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </aside>
          ) : null}
          <div className="quick-links-toolbar">
            <div className="quick-link-categories" aria-label="Shortcut categories">
              {categoryChips.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={`category-chip ${activeCategory === category ? 'category-chip-active' : ''}`}
                  onClick={() => setActiveCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="density-toggle"
              onClick={() => setIsCompact((value) => !value)}
            >
              {isCompact ? 'Comfort view' : 'Small view'}
            </button>
          </div>

          <div className={`quick-links-grid ${isCompact ? 'quick-links-grid-compact' : ''}`}>
            {filteredHomeItems.map((item) => {
              const sid = item.shortcutId != null ? String(item.shortcutId) : '';
              const isFavorite = sid && favoriteIdSet.has(sid);
              const showFavorite = isShortcutFavoritesEligible();
              const openShortcut = () => {
                const target = safeLink(item.url);
                if (target) window.open(target, '_blank', 'noopener');
              };
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  className="quick-link-card"
                  onContextMenu={
                    adminSession?.isAdmin
                      ? (ev) => {
                          ev.preventDefault();
                          setTileMenu({
                            id: item.shortcutId,
                            title: item.title,
                            x: Math.min(ev.clientX, window.innerWidth - 190),
                            y: Math.min(ev.clientY, window.innerHeight - 60),
                          });
                        }
                      : undefined
                  }
                  onClick={openShortcut}
                  onKeyDown={(ev) => {
                    if (ev.target !== ev.currentTarget) return;
                    if (ev.key !== 'Enter' && ev.key !== ' ') return;
                    ev.preventDefault();
                    openShortcut();
                  }}
                >
                  {showFavorite && isCompact ? (
                    <span className="quick-link-favorite-anchor quick-link-favorite-anchor--compact">
                      <QuickLinkFavoriteStar
                        sid={sid}
                        isFavorite={isFavorite}
                        toggleFavorite={toggleFavorite}
                      />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="quick-link-info"
                    aria-label={`About ${item.title}`}
                    title="About this app"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setInfoAppId(item.shortcutId);
                    }}
                  >
                    <InfoIcon />
                  </button>
                  <QuickLinkThumb item={item} />
                  <span className="quick-link-content">
                    <span className="quick-link-title">{item.title}</span>
                    <span className="quick-link-description">{item.description}</span>
                    <span className="quick-link-url-row">
                      <span className="quick-link-url" title={item.url || ''}>
                        {displayShortcutUrl(item.url)}
                      </span>
                      {showFavorite && !isCompact ? (
                        <span className="quick-link-favorite-anchor quick-link-favorite-anchor--comfort">
                          <QuickLinkFavoriteStar
                            sid={sid}
                            isFavorite={isFavorite}
                            toggleFavorite={toggleFavorite}
                          />
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="quick-link-category">{item.category}</span>
                </div>
              );
            })}
          </div>

            {filteredHomeItems.length === 0 && (
              <p className="no-requests">No shortcuts match your search.</p>
            )}
            </div>

            <div className="home-shell-side-column">
              {homeMotd && homeMotd.enabled ? (
                <aside className="home-motd-widget" aria-label="Message of the day">
                  <h3 className="home-motd-widget__heading">{homeMotd.title || 'Message of the day'}</h3>
                  <div className="home-motd-widget__body">
                    {homeMotd.body ? (
                      <p className="home-motd-widget__text">{homeMotd.body}</p>
                    ) : (
                      <p className="home-motd-widget__placeholder text-muted small mb-0">
                        {homeMotd.stale ? 'Preparing your message…' : 'No message yet — configure in Admin → Settings.'}
                      </p>
                    )}
                  </div>
                </aside>
              ) : null}

              {lobbyChatUiEnabled && typeof onOpenChat === 'function' && homeUnreadChats.length > 0 ? (
                <aside className="home-chat-unread-widget" aria-label="Unread chats">
                  <div className="home-chat-unread-widget__heading">
                    <span className="home-chat-unread-widget__label">Unread chats</span>
                  </div>
                  <ul className="home-chat-unread-widget__list">
                    {homeUnreadChats.map((c) => {
                      const kind = chatUnreadKindLabel(c.type);
                      const title = c.title || 'Chat';
                      return (
                        <li key={String(c.id)} className="home-chat-unread-widget__item">
                          <button
                            type="button"
                            className="home-chat-unread-widget__row"
                            onClick={() => openUnreadChatThread(c.id)}
                            aria-label={`Open chat: ${title}, ${kind}, ${typeof c.unread === 'number' ? c.unread : 0} unread`}
                          >
                            <span className="home-chat-unread-widget__row-main">
                              <span className="home-chat-unread-widget__title">{title}</span>
                              <span className="home-chat-unread-widget__kind">{kind}</span>
                            </span>
                            <span className="home-chat-unread-widget__badge" aria-hidden="true">
                              {typeof c.unread === 'number' && c.unread > 99 ? '99+' : c.unread}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </aside>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {tileMenu ? (
        <TileMenu
          menu={tileMenu}
          onClose={() => setTileMenu(null)}
          onEdit={() => {
            const { id } = tileMenu;
            setTileMenu(null);
            onEditShortcut(id);
          }}
        />
      ) : null}
      {infoApp ? <AppInfoDialog app={infoApp} onClose={closeInfo} /> : null}
    </section>
  );
}

export default Entery;
