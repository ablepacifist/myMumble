import React, { useState, useEffect } from 'react';

/**
 * NotificationToast — shows toast notifications for @mentions.
 * Listens for 'feature:notification' CustomEvents from chat.js.
 */
export default function NotificationToast() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const onNotification = (e) => {
      const notif = e.detail;
      const id = notif.id || Date.now();
      setToasts(prev => [...prev.slice(-4), { ...notif, id }]); // keep max 5

      // Auto-dismiss after 5 seconds
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 5000);
    };

    document.addEventListener('feature:notification', onNotification);
    return () => document.removeEventListener('feature:notification', onNotification);
  }, []);

  const dismiss = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="notification-toast-container">
      {toasts.map(t => (
        <div key={t.id} className="notification-toast" onClick={() => dismiss(t.id)}>
          <div className="toast-icon">@</div>
          <div className="toast-body">
            <div className="toast-title">
              <strong>{t.fromUsername}</strong> mentioned you
              {t.channelName ? ` in #${t.channelName}` : ''}
            </div>
            {t.messagePreview && (
              <div className="toast-preview">{t.messagePreview.slice(0, 100)}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
