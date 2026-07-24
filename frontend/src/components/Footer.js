import React, { useState, useEffect } from 'react';

function Footer() {
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);

  // Fetch notifications when component mounts (only visible ones)
  useEffect(() => {
    fetch('/api/notifications')
      .then((res) => res.json())
      .then((data) => {
        // Filter only visible notifications
        const visibleNotifications = data.filter(notification => notification.isVisible);
        setNotifications(visibleNotifications);
      })
      .catch((err) => console.error('Error fetching notifications:', err));
  }, []);

  return (
    <footer className="footer">
      {/* Notification Button */}
      <button className="notification-button" onClick={() => setShowNotifications(true)}>
        📢
      </button>
      {/* Notification Modal - Using the same style as Entery component */}
      {showNotifications && notifications.length > 0 && (
        <div className="modal-overlay" onClick={() => setShowNotifications(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3 className="modal-title">Important Notifications</h3>
              <button className="close-button" onClick={() => setShowNotifications(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {notifications.map((notification) => (
                <div key={notification._id} className="notification-item" style={{ marginBottom: '15px', padding: '10px', border: '1px solid #eee', borderRadius: '5px' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ fontSize: '24px', marginRight: '10px' }}>{notification.icon || '📢'}</span>
                    <div>
                      <h4 style={{ margin: '0 0 5px 0', textAlign: 'center' }}>{notification.title}</h4>
                      <p style={{ margin: '0 0 10px 0', textAlign: 'center' }}>{notification.description}</p>
                      {notification.link && (
                        <a href={notification.link} target="_blank" rel="noopener noreferrer" style={{ color: '#007bff', textAlign: 'center' }}>
                          Read more
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-footer" style={{ textAlign: 'right' }}>
            </div>
          </div>
        </div>
      )}
    </footer>
  );
}

export default Footer;
