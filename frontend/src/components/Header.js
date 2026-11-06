import React, { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { jwtDecode } from 'jwt-decode';
import { userDisplayName } from '../utils/userDisplayName';
import { isJwtExpired } from '../utils/jwtSession';
import { currentTheme, saveTheme } from '../utils/theme';
import Footer from './Footer';
import ProfileDialog from './ProfileDialog';
import {
  ChatIcon,
  ChevronRightIcon,
  HomeIcon,
  MoonIcon,
  PhoneIcon,
  PulseIcon,
  ShieldIcon,
  SignInIcon,
  SunIcon,
  TicketIcon,
} from './Icons';

const RAIL_KEY = 'sc_rail_expanded';

function readRailExpanded() {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function RailItem({ icon, label, ariaLabel, active, badge, title, onClick, className, ariaExpanded }) {
  return (
    <button
      type="button"
      className={`rail__item${active ? ' rail__item--active' : ''}${className ? ` ${className}` : ''}`}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      aria-label={ariaLabel || label}
      aria-current={active ? 'page' : undefined}
      title={title || label}
    >
      <span className="rail__icon">
        {icon}
        {badge ? <span className="rail__badge" aria-hidden="true">{badge}</span> : null}
      </span>
      <span className="rail__label">{label}</span>
    </button>
  );
}

function Header({ activeTab, onTabClick, onLoginClick }) {
  const [user, setUser] = useState(null);
  const [lobbyTabVisible, setLobbyTabVisible] = useState(true);
  const [chatUnread, setChatUnread] = useState(0);
  const [openTickets, setOpenTickets] = useState(0);
  const [pingerDown, setPingerDown] = useState(0);
  const [theme, setTheme] = useState(currentTheme);
  const [expanded, setExpanded] = useState(readRailExpanded);
  const [showProfile, setShowProfile] = useState(false);

  useLayoutEffect(() => {
    document.documentElement.dataset.rail = expanded ? 'expanded' : 'collapsed';
  }, [expanded]);

  const toggleExpanded = () => {
    setExpanded((value) => {
      const next = !value;
      try {
        localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      } catch {
        /* The choice still applies for this page view. */
      }
      return next;
    });
  };

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (storedToken) {
      try {
        const decoded = jwtDecode(storedToken);
        if (isJwtExpired(decoded)) {
          localStorage.removeItem('token');
          return;
        }

        setUser(decoded);
       
      } catch (err) {
        console.error("Invalid token in localStorage");
        localStorage.removeItem('token');
      }
    }
  }, []);

  useEffect(() => {
    fetch('/api/settings/public')
      .then((response) => response.json())
      .then((settings) => {
        setLobbyTabVisible(settings.lobbyChatEnabled !== false);
        const href =
          (settings.faviconUrl || settings.logoUrl || 'logo192.png');
        if (typeof document !== 'undefined' && href) {
          let link = document.querySelector("link[rel~='icon']");
          if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
          }
          link.href = href;
          let apple = document.querySelector("link[rel='apple-touch-icon']");
          if (!apple) {
            apple = document.createElement('link');
            apple.rel = 'apple-touch-icon';
            document.head.appendChild(apple);
          }
          apple.href = href;
        }
      })
      .catch((err) => console.error('Failed to load logo settings:', err));
  }, []);

  useEffect(() => {
    const fetchUnread = () => {
      const token = localStorage.getItem('token');
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      fetch('/api/chat/summary', { headers })
        .then((r) => (r.ok ? r.json() : Promise.resolve({ enabled: false, unreadTotal: 0 })))
        .then((d) => {
          if (d && d.enabled && typeof d.unreadTotal === 'number') {
            setChatUnread(d.unreadTotal);
          } else {
            setChatUnread(0);
          }
        })
        .catch(() => setChatUnread(0));
    };
    fetchUnread();
    const id = setInterval(fetchUnread, 20000);
    const onFocus = () => fetchUnread();
    const onActivity = () => fetchUnread();
    window.addEventListener('focus', onFocus);
    window.addEventListener('sc:chat-activity', onActivity);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('sc:chat-activity', onActivity);
    };
  }, [user]);

  // Sidebar badges: open tickets, and hosts that are down.
  useEffect(() => {
    if (!user) {
      setOpenTickets(0);
      setPingerDown(0);
      return undefined;
    }
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
    const canPing = user.isAdmin || user.pingerAccess;
    let cancelled = false;
    const refresh = () => {
      fetch('/api/tickets/open-count', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d && typeof d.open === 'number') setOpenTickets(d.open);
        })
        .catch(() => {});
      if (canPing) {
        fetch('/api/pinger/status', { headers })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!cancelled && d && Array.isArray(d.hosts)) {
              setPingerDown(d.hosts.filter((h) => h.state === 'down').length);
            }
          })
          .catch(() => {});
      }
    };
    refresh();
    const id = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', refresh);
    };
  }, [user, activeTab]);

  const formatBadge = (n) => (n > 0 ? (n > 99 ? '99+' : n) : null);

  const handleLogout = useCallback(() => {
    const token = localStorage.getItem('token');
    try {
      const decoded = token ? jwtDecode(token) : null;
      if (decoded && decoded.sso === true) {
        window.location.href = '/api/auth/sso/logout';
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.removeItem('sso_attempted');
      sessionStorage.removeItem('sso_failed');
    } catch {
      /* ignore */
    }
    setShowProfile(false);
    setUser(null);
    localStorage.removeItem('token');
    onTabClick('entery');
  }, [onTabClick]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    saveTheme(next);
    setTheme(next);
  };

  const displayName = user ? userDisplayName(user) : '';

  return (
    <header className="rail">
      <div className="rail__brand">
        <button
          type="button"
          className="rail__logo"
          onClick={() => onTabClick('entery')}
          aria-label="Go to home page"
          title="Home"
        >
          <img src="iaf-logo.png" alt="Israeli Air Force logo" />
        </button>
        <div className="rail__brand-text" dir="ltr">
          <span className="rail__brand-name">PITUAH.iaf</span>
          <span className="rail__brand-tag">108</span>
        </div>
      </div>
      <nav className="rail__nav" aria-label="Main navigation">
        <RailItem
          icon={<HomeIcon />}
          label="Home"
          active={activeTab === 'entery'}
          onClick={() => onTabClick('entery')}
        />
        {user && (
          <RailItem
            icon={<TicketIcon />}
            label="Requests"
            ariaLabel={!user.isAdmin && openTickets > 0 ? `My Requests, ${openTickets} open` : 'My Requests'}
            title="My Requests"
            active={activeTab === 'requests'}
            badge={user.isAdmin ? null : formatBadge(openTickets)}
            onClick={() => onTabClick('requests')}
          />
        )}
        {user && (user.isAdmin || user.pingerAccess) && (
          <RailItem
            icon={<PulseIcon />}
            label="Pinger"
            ariaLabel={pingerDown > 0 ? `Pinger, ${pingerDown} down` : 'Pinger'}
            title={pingerDown > 0 ? `${pingerDown} host(s) down` : 'Pinger'}
            active={activeTab === 'pinger'}
            badge={formatBadge(pingerDown)}
            onClick={() => onTabClick('pinger')}
          />
        )}
        {lobbyTabVisible && (
          <RailItem
            icon={<ChatIcon />}
            label="Chat"
            ariaLabel={chatUnread > 0 ? `Chat, ${chatUnread} unread` : 'Chat'}
            active={activeTab === 'lobbyChat'}
            badge={chatUnread > 0 ? (chatUnread > 99 ? '99+' : chatUnread) : null}
            onClick={() => onTabClick('lobbyChat')}
          />
        )}
        <RailItem
          icon={<PhoneIcon />}
          label="Contact"
          active={activeTab === 'contact'}
          onClick={() => onTabClick('contact')}
        />
        {user && user.isAdmin && (
          <RailItem
            icon={<ShieldIcon />}
            label="Admin"
            ariaLabel={openTickets > 0 ? `Admin Dashboard, ${openTickets} open tickets` : 'Admin Dashboard'}
            title={openTickets > 0 ? `${openTickets} open ticket(s)` : 'Admin Dashboard'}
            active={activeTab === 'admindashboard'}
            badge={formatBadge(openTickets)}
            onClick={() => onTabClick('admindashboard', { adminInitialTab: 'allRequests' })}
          />
        )}
      </nav>

      <div className="rail__tools">
        <Footer />
        <RailItem
          icon={theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          label={theme === 'dark' ? 'Light' : 'Dark'}
          ariaLabel={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        />
        {user ? (
          <>
            <button
              type="button"
              className="rail__user"
              onClick={() => setShowProfile(true)}
              aria-label={`Profile: ${displayName}`}
              title={user.username ? `${displayName} (${user.username})` : displayName}
            >
              <span className="rail__avatar" aria-hidden="true">
                {(displayName || '?').trim().charAt(0).toUpperCase()}
              </span>
              <span className="rail__user-name">{displayName}</span>
            </button>
          </>
        ) : (
          <RailItem
            icon={<SignInIcon />}
            label="Sign in"
            ariaLabel="Open sign in"
            onClick={onLoginClick}
          />
        )}
        <RailItem
          className="rail__item--toggle"
          icon={<ChevronRightIcon />}
          label={expanded ? 'Collapse' : 'Expand'}
          ariaLabel={expanded ? 'Collapse menu' : 'Expand menu'}
          ariaExpanded={expanded}
          onClick={toggleExpanded}
        />
      </div>

      {showProfile && user ? (
        <ProfileDialog user={user} onClose={() => setShowProfile(false)} onLogout={handleLogout} />
      ) : null}
    </header>
  );
}

export default Header;