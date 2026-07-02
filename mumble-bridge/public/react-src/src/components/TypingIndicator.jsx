import React, { useState, useEffect, useCallback } from 'react';

/**
 * TypingIndicator — shows "User is typing..." below the message list.
 * 
 * Listens to CustomEvents dispatched by chat.js when 'typing' messages arrive.
 * This is the React version — chat.js also has a vanilla fallback for when React
 * bundle isn't loaded.
 */
export default function TypingIndicator() {
  const [typers, setTypers] = useState(new Map()); // username -> expiry timeout

  const handleTyping = useCallback((e) => {
    const { username, typing } = e.detail;
    if (!username) return;

    setTypers((prev) => {
      const next = new Map(prev);
      if (typing) {
        // Clear existing timeout
        if (next.has(username)) {
          clearTimeout(next.get(username));
        }
        // Set new timeout (auto-expire after 9s)
        const timeout = setTimeout(() => {
          setTypers((current) => {
            const updated = new Map(current);
            updated.delete(username);
            return updated;
          });
        }, 9000);
        next.set(username, timeout);
      } else {
        if (next.has(username)) {
          clearTimeout(next.get(username));
          next.delete(username);
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    document.addEventListener('feature:typing', handleTyping);
    return () => {
      document.removeEventListener('feature:typing', handleTyping);
    };
  }, [handleTyping]);

  const names = Array.from(typers.keys());

  if (names.length === 0) return null;

  let text;
  if (names.length === 1) {
    text = `${names[0]} is typing`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing`;
  } else {
    text = `${names[0]} and ${names.length - 1} others are typing`;
  }

  return (
    <div className="typing-indicator-react">
      <span className="typing-dots">
        <span className="dot"></span>
        <span className="dot"></span>
        <span className="dot"></span>
      </span>
      <span className="typing-text">{text}</span>
    </div>
  );
}
