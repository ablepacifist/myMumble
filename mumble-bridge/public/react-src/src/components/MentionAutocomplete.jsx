import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * MentionAutocomplete — shows a dropdown of matching usernames when user types @
 * Communicates with chat.js via CustomEvents.
 */
export default function MentionAutocomplete() {
  const [visible, setVisible] = useState(false);
  const [filter, setFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef(null);

  // Listen for mention autocomplete events from chat.js
  useEffect(() => {
    const onTrigger = (e) => {
      const { partial, userList } = e.detail;
      if (!partial && partial !== '') {
        setVisible(false);
        return;
      }
      setUsers(userList || []);
      setFilter(partial.toLowerCase());
      setSelectedIndex(0);
      setVisible(true);
    };

    const onClose = () => setVisible(false);

    document.addEventListener('mention:autocomplete', onTrigger);
    document.addEventListener('mention:close', onClose);
    return () => {
      document.removeEventListener('mention:autocomplete', onTrigger);
      document.removeEventListener('mention:close', onClose);
    };
  }, []);

  const filtered = users.filter(u =>
    u.username.toLowerCase().startsWith(filter)
  ).slice(0, 8);

  const selectUser = useCallback((user) => {
    document.dispatchEvent(new CustomEvent('mention:selected', {
      detail: { username: user.username },
    }));
    setVisible(false);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return;
    const onKey = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered[selectedIndex]) {
          e.preventDefault();
          selectUser(filtered[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        setVisible(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [visible, filtered, selectedIndex, selectUser]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div className="mention-autocomplete">
      {filtered.map((user, i) => (
        <div
          key={user.username}
          className={`mention-item${i === selectedIndex ? ' selected' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); selectUser(user); }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="mention-username">@{user.username}</span>
        </div>
      ))}
    </div>
  );
}
