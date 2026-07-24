import React, { useState, useEffect } from 'react';

function Login({ onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [userEmailDomain, setUserEmailDomain] = useState('');
  const [ssoReachable, setSsoReachable] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      document.getElementById('login-popup-username')?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    fetch('/api/auth/sso/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.enabled && d.reachable) setSsoReachable(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    fetch('/api/settings/public')
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.userEmailDomain === 'string') {
          setUserEmailDomain(String(d.userEmailDomain).replace(/^@/, ''));
        }
      })
      .catch(() => {});
  }, []);

  const startKeycloakSignIn = () => {
    try {
      sessionStorage.setItem('sso_attempted', 'true');
      sessionStorage.removeItem('sso_failed');
      sessionStorage.removeItem('sso_pause_until');
    } catch {
      /* ignore */
    }
    window.location.href = '/api/auth/sso/login';
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);

    try {
      const raw = String(username).trim();
      const dom = String(userEmailDomain || '').replace(/^@/, '').trim();
      const loginId = raw.includes('@') || !dom ? raw : `${raw}@${dom}`;
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginId,
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      localStorage.setItem('token', data.token);
      onClose();
      window.location.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <div className="login-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="login-modal login-modal--popup"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-popup-title"
      >
        <div className="login-popup__head">
          <h2 id="login-popup-title" className="login-popup__title">
            Sign in
          </h2>
          <button type="button" className="login-popup__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {ssoReachable ? (
          <div className="login-popup__sso-block">
            <button
              type="button"
              className="login-popup__sso"
              disabled={isLoggingIn}
              onClick={startKeycloakSignIn}
            >
              Sign in with Keycloak (SSO)
            </button>
            <div className="login-popup__divider">
              <span className="login-popup__divider-line" aria-hidden="true" />
              <span className="login-popup__divider-text">or with directory account</span>
              <span className="login-popup__divider-line" aria-hidden="true" />
            </div>
          </div>
        ) : null}
        <form onSubmit={handleLogin} className="login-popup__form">
          <div className="login-popup__field">
            <label htmlFor="login-popup-username" className="login-popup__label">
              Username
            </label>
            <input
              id="login-popup-username"
              type="text"
              className="login-popup__input"
              placeholder={
                userEmailDomain
                  ? `sAM, UPN, or DOMAIN\\user (e.g. user@${userEmailDomain})`
                  : 'Username'
              }
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={isLoggingIn}
              autoComplete="username"
            />
          </div>

          <div className="login-popup__field login-popup__field--password">
            <label htmlFor="login-popup-password" className="login-popup__label">
              Password
            </label>
            <input
              id="login-popup-password"
              type={showPassword ? 'text' : 'password'}
              className="login-popup__input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoggingIn}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="login-popup__toggle-pw"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>

          <button type="submit" disabled={isLoggingIn} className="login-popup__submit">
            {isLoggingIn ? 'Signing in…' : 'Sign in'}
          </button>

          {error ? <p className="login-popup__error">{error}</p> : null}
        </form>
      </div>
    </div>
  );
}

export default Login;
