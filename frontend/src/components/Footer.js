import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MegaphoneIcon } from './Icons';
import { safeLink } from '../utils/safeUrl';

/** Announcements button for the navigation rail, and the dialog it opens. */
function Footer() {
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);

  // A desktop notification about an announcement opens this list.
  useEffect(() => {
    const open = () => setShowNotifications(true);
    window.addEventListener('sc:open-news', open);
    return () => window.removeEventListener('sc:open-news', open);
  }, []);

  // Escape closes the list, like the app's other dialogs.
  useEffect(() => {
    if (!showNotifications) return undefined;
    const onKey = (ev) => {
      if (ev.key === 'Escape') setShowNotifications(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showNotifications]);

  // Visible announcements, refreshed every minute and whenever the list opens.
  const loadNotifications = useCallback(() => {
    fetch('/api/notifications')
      .then((res) => res.json())
      .then((data) => {
        setNotifications(Array.isArray(data) ? data.filter((notification) => notification.isVisible) : []);
      })
      .catch((err) => console.error('Error fetching notifications:', err));
  }, []);

  useEffect(() => {
    loadNotifications();
    const id = setInterval(loadNotifications, 60000);
    return () => clearInterval(id);
  }, [loadNotifications]);

  useEffect(() => {
    if (showNotifications) loadNotifications();
  }, [showNotifications, loadNotifications]);

  return (
    <>
      <button
        type="button"
        className="rail__item"
        onClick={() => setShowNotifications(true)}
        aria-label="Important notifications"
        title="Important notifications"
      >
        <span className="rail__icon">
          <MegaphoneIcon />
          {notifications.length > 0 ? (
            <span className="rail__badge" aria-hidden="true">
              {notifications.length > 99 ? '99+' : notifications.length}
            </span>
          ) : null}
        </span>
        <span className="rail__label">News</span>
      </button>
      {showNotifications &&
        createPortal(
          <div className="modal-overlay" onClick={() => setShowNotifications(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">Important Notifications</h3>
                <button
                  type="button"
                  className="close-button"
                  onClick={() => setShowNotifications(false)}
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>
              <div className="modal-body">
                {notifications.length === 0 ? (
                  <p className="no-requests">There are no notifications right now.</p>
                ) : (
                  <div className="notification-list">
                    {notifications.map((notification) => (
                      <div key={notification._id} className="notification-item">
                        <span className="notification-item__icon" aria-hidden="true">
                          {notification.icon || '📢'}
                        </span>
                        <div>
                          <h4 className="notification-item__title">{notification.title}</h4>
                          <p className="notification-item__desc">{notification.description}</p>
                          {safeLink(notification.link) && (
                            <a
                              className="notification-item__link"
                              href={safeLink(notification.link)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Read more
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default Footer;
