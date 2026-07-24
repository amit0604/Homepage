import React, { useState, useEffect, useCallback } from 'react';
import { jwtDecode } from 'jwt-decode';
import { userDisplayName } from '../utils/userDisplayName';
import { isJwtExpired } from '../utils/jwtSession';

function Header({ onTabClick, onLoginClick }) {
  const [user, setUser] = useState(null);
  const [logoUrl, setLogoUrl] = useState('logo192.png');
  const [lobbyTabVisible, setLobbyTabVisible] = useState(true);
  const [chatUnread, setChatUnread] = useState(0);


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
        if (settings.logoUrl) {
          setLogoUrl(settings.logoUrl);
        }
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
    setUser(null);
    localStorage.removeItem('token');
    onTabClick('entery');
  }, [onTabClick]);

  return (
    <header className="header">
      <div className="logo-container">
        <span
          onClick={() => onTabClick('entery')}
          aria-label="Go to home page"
        >
          <img src={logoUrl} alt="Logo" className="logo" />
        </span>
      </div>
      
      <nav aria-label="Main navigation">
        {user && user.isAdmin && (
          <span
            className="header-nav-item"
            onClick={() => onTabClick('admindashboard', { adminInitialTab: 'allRequests' })}
            aria-label="Admin Dashboard"
          >
            <span className="header-nav-item__label">Admin Dashboard</span>
            <div className="ltr" />
            <div className="rtl" />
          </span>
        )}

        {user && (
          <span
            className="header-nav-item"
            onClick={() => onTabClick('requests')}
            aria-label="My Requests"
          >
            <span className="header-nav-item__label">My Requests</span>
            <div className="ltr" />
            <div className="rtl" />
          </span>
        )}
        {user && (user.isAdmin || user.pingerAccess) && (
          <span
            className="header-nav-item"
            onClick={() => onTabClick('pinger')}
            aria-label="Pinger"
          >
            <span className="header-nav-item__label">Pinger</span>
            <div className="ltr" />
            <div className="rtl" />
          </span>
        )}
        <span
          className="header-nav-item"
          onClick={() => onTabClick('helpLibrary')}
          aria-label="Help library"
        >
          <span className="header-nav-item__label">Help library</span>
          <div className="ltr" />
          <div className="rtl" />
        </span>
        {lobbyTabVisible && (
          <span
            className="header-nav-item header-nav-item--chat"
            onClick={() => onTabClick('lobbyChat')}
            aria-label={chatUnread > 0 ? `Chat, ${chatUnread} unread` : 'Chat'}
          >
            <span className="header-nav-item__label">
              Chat
              {chatUnread > 0 ? (
                <span className="header-nav-item__badge" aria-hidden>
                  {chatUnread > 99 ? '99+' : chatUnread}
                </span>
              ) : null}
            </span>
            <div className="ltr" />
            <div className="rtl" />
          </span>
        )}
        <span
          className="header-nav-item"
          onClick={() => onTabClick('contact')}
          aria-label="Contact"
        >
          <span className="header-nav-item__label">Contact</span>
          <div className="ltr" />
          <div className="rtl" />
        </span>

        <span
          className="header-nav-item"
          onClick={() => onTabClick('entery')}
          aria-label="Home"
        >
          <span className="header-nav-item__label">Home</span>
          <div className="ltr" />
          <div className="rtl" />
        </span>
      </nav>
      
      <div className="login-container">
        {user ? (
          <div
            className="user-info"
            aria-label={`Logged in as ${userDisplayName(user)}`}
            title={user.username ? String(user.username) : undefined}
          >
            <span className="welcome-text">{userDisplayName(user)}</span>
            <button 
              className="logout-button" 
              onClick={handleLogout}
              aria-label="Logout"
            >
              Logout
            </button>
          </div>
        ) : (
          <div className="login-wrapper">
            <button
              className="login-button"
              onClick={onLoginClick} 
              aria-label="Open sign in"
            >
              Sign In
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export default Header;