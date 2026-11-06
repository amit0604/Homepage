import React, { useState, useEffect } from 'react';
import { jwtDecode } from 'jwt-decode';
import { isJwtExpired } from './utils/jwtSession';
import Header from './components/Header';
import Entery from './components/Entery';
import Requests from './components/Requests';
import AdminDashboard from './components/AdminDashboard ';
import Contact from './components/Contact';
import SupportReplyNotifier from './components/SupportReplyNotifier';
import Login from './components/Login'; 
import LobbyChatPage from './components/LobbyChatPage';
import PingerPage from './components/PingerPage';
import ErrorBoundary from './components/ErrorBoundary';

const VALID_TABS = new Set(['entery', 'lobbyChat', 'contact', 'requests', 'admindashboard', 'pinger']);
const SESSION_TAB_KEY = 'sc_activeTab';
const SESSION_ADMIN_TAB_KEY = 'sc_adminInitialTab';

function readSessionTab() {
  try {
    const t = sessionStorage.getItem(SESSION_TAB_KEY);
    if (t && VALID_TABS.has(t)) return t;
  } catch {
    /* ignore */
  }
  return 'entery';
}

function readSessionAdminTab() {
  try {
    const t = sessionStorage.getItem(SESSION_ADMIN_TAB_KEY);
    if (t && t !== 'helpLibrary' && typeof t === 'string' && t.length < 80) return t;
  } catch {
    /* ignore */
  }
  return 'allRequests';
}

function App() {
  const [activeTab, setActiveTab] = useState(readSessionTab);
  const [showLogin, setShowLogin] = useState(false);
  const [requestsMountKey, setRequestsMountKey] = useState(0);
  const [adminDashKey, setAdminDashKey] = useState(0);
  const [adminInitialTab, setAdminInitialTab] = useState(readSessionAdminTab);
  const [pingerInitialStatusFilter, setPingerInitialStatusFilter] = useState(null);
  const [editShortcutId, setEditShortcutId] = useState(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_TAB_KEY, activeTab);
    } catch {
      /* ignore */
    }
  }, [activeTab]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_ADMIN_TAB_KEY, adminInitialTab);
    } catch {
      /* ignore */
    }
  }, [adminInitialTab]);

  const handleTabClick = (tab, options = {}) => {
    if (tab === 'admindashboard' && options.adminInitialTab) {
      setEditShortcutId(options.editShortcutId || null);
      setAdminInitialTab(options.adminInitialTab);
      try {
        sessionStorage.setItem(SESSION_ADMIN_TAB_KEY, options.adminInitialTab);
      } catch {
        /* ignore */
      }
      setAdminDashKey((k) => k + 1);
    }
    if (tab === 'pinger') {
      const s = options.pingerStatusFilter;
      if (s === 'Down' || s === 'Up' || s === 'All') {
        setPingerInitialStatusFilter(s);
      } else {
        setPingerInitialStatusFilter(null);
      }
    }
    setActiveTab(tab);
  };

  const handleLoginClose = () => {
    setShowLogin(false);
  };

  // Keycloak SSO auto-login on page load (OIDC Authorization Code flow).
  // - Checks /api/auth/sso/status; if enabled and reachable, redirects to
  //   /api/auth/sso/login which in turn redirects to Keycloak.
  // - Keycloak handles Kerberos/SPNEGO natively with the browser.
  // - On success: callback page stores the JWT and redirects back here.
  // On failure (no Kerberos ticket, SSO disabled, etc.), sessionStorage sso_failed may be set
  // so the user knows SSO was attempted; LDAP sign-in still works via the header button.
  //   and we fall back silently so the user can sign in via LDAP.
  // - After Keycloak logout, sso_pause_until delays Auto SSO unless user clicks SSO in Sign in.
  useEffect(() => {
    const existingToken = localStorage.getItem('token');
    if (existingToken) return;

    const ssoAttempted = sessionStorage.getItem('sso_attempted');
    if (ssoAttempted) return;

    let cancelled = false;
    let timerId;

    const readPauseUntil = () => {
      try {
        const raw = sessionStorage.getItem('sso_pause_until');
        const n = raw ? Number(raw) : NaN;
        return Number.isFinite(n) ? n : 0;
      } catch {
        return 0;
      }
    };

    const runAutoSso = async () => {
      if (cancelled) return;
      try {
        const r = await fetch('/api/auth/sso/status');
        if (cancelled) return;
        if (!r.ok) return;
        const data = await r.json();
        if (!data.enabled || !data.reachable) return;
        sessionStorage.setItem('sso_attempted', 'true');
        window.location.href = '/api/auth/sso/login';
      } catch {
        /* SSO not available */
      }
    };

    const kickoff = () => {
      if (cancelled) return;

      try {
        let pauseUntil = readPauseUntil();
        const now = Date.now();
        if (pauseUntil > 0 && pauseUntil <= now) {
          sessionStorage.removeItem('sso_pause_until');
          pauseUntil = 0;
        }
        const delay = pauseUntil > now ? pauseUntil - now : 0;
        if (delay > 0) {
          timerId = window.setTimeout(() => {
            if (!cancelled) void runAutoSso();
          }, delay);
          return;
        }
      } catch {
        /* fall through — run SSO */
      }
      void runAutoSso();
    };

    kickoff();

    return () => {
      cancelled = true;
      if (timerId) window.clearTimeout(timerId);
    };
  }, []);

  // Chat tab: lock page scroll; only the chat list scrolls (see .body--lobby, .App--lobby in styles/shell.css)
  useEffect(() => {
    const root = document.getElementById('root');
    const html = document.documentElement;
    if (activeTab === 'lobbyChat') {
      html.classList.add('html--lobby');
      document.body.classList.add('body--lobby');
      root?.classList.add('root--lobby');
    } else {
      html.classList.remove('html--lobby');
      document.body.classList.remove('body--lobby');
      root?.classList.remove('root--lobby');
    }
    return () => {
      html.classList.remove('html--lobby');
      document.body.classList.remove('body--lobby');
      root?.classList.remove('root--lobby');
    };
  }, [activeTab]);

  // If chat is disabled (admin or LOBBY_CHAT_UI), leave the tab and sync session
  useEffect(() => {
    if (activeTab !== 'lobbyChat') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/public');
        if (!r.ok || cancelled) return;
        const d = await r.json();
        if (cancelled || d.lobbyChatEnabled !== false) return;
        setActiveTab('entery');
        try {
          sessionStorage.setItem(SESSION_TAB_KEY, 'entery');
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  // Deep link: ?show=admin opens Admin Dashboard only for logged-in admins (others: no effect, param stripped)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('show') !== 'admin') return;

    const stripShowParam = () => {
      params.delete('show');
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', next);
    };

    const token = localStorage.getItem('token');
    if (token) {
      try {
        const decoded = jwtDecode(token);
        const valid = !isJwtExpired(decoded);
        if (valid && decoded.isAdmin) {
          setAdminInitialTab('allRequests');
          try {
            sessionStorage.setItem(SESSION_ADMIN_TAB_KEY, 'allRequests');
            sessionStorage.setItem(SESSION_TAB_KEY, 'admindashboard');
          } catch {
            /* ignore */
          }
          setAdminDashKey((k) => k + 1);
          setActiveTab('admindashboard');
        }
      } catch {
        /* ignore */
      }
    }

    stripShowParam();
  }, []);

  return (
    <div className={`App${activeTab === 'lobbyChat' ? ' App--lobby' : ''}`}>
      <Header
        activeTab={activeTab}
        onTabClick={handleTabClick}
        onLoginClick={() => setShowLogin(true)}
      />
      <main className={activeTab === 'lobbyChat' ? 'main--lobby' : undefined}>
        <ErrorBoundary key={activeTab}>
          {activeTab === 'lobbyChat' && <LobbyChatPage />}
          {activeTab === 'entery' && (
            <Entery
              onOpenAdminCheckmk={() => handleTabClick('admindashboard', { adminInitialTab: 'checkmk' })}
              onEditShortcut={(id) => handleTabClick('admindashboard', { adminInitialTab: 'shortcuts', editShortcutId: id })}
            />
          )}
          {activeTab === 'pinger' && (
            <PingerPage initialStatusFilter={pingerInitialStatusFilter} />
          )}
          {activeTab === 'contact' && <Contact />}
          {activeTab === 'requests' && (
            <Requests key={requestsMountKey} />
          )}
          {activeTab === 'admindashboard' && (
            <AdminDashboard key={adminDashKey} initialTab={adminInitialTab} initialEditShortcutId={editShortcutId} />
          )}
        </ErrorBoundary>
      </main>
      <footer className="app-footer" dir="rtl">
        נבנה ומתוחזק ב-❤️ על ידי צוות שרתים
      </footer>
      {showLogin ? <Login onClose={handleLoginClose} /> : null}
      {!showLogin && (
        <SupportReplyNotifier
          onOpenRequests={() => {
            setRequestsMountKey((k) => k + 1);
            setActiveTab('requests');
            try {
              sessionStorage.setItem(SESSION_TAB_KEY, 'requests');
            } catch {
              /* ignore */
            }
          }}
        />
      )}
    </div>
  );
}

export default App;
