import React, { useState, useEffect, useCallback, useRef } from 'react';

/**
 * EmojiReactions — global reaction manager.
 * The "+" button is rendered statically in each message's HTML by chat.js.
 * This component handles:
 *   - The emoji picker overlay (shown when "+" is clicked)
 *   - Rendering reaction badges into message containers when updates arrive
 */

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👀', '🎉'];

export default function EmojiReactions() {
  const [reactionsMap, setReactionsMap] = useState(new Map());
  const [pickerTarget, setPickerTarget] = useState(null);
  const [pickerPos, setPickerPos] = useState({ top: 0, left: 0 });

  // Listen for reaction updates from server
  useEffect(() => {
    const onUpdate = (e) => {
      const { messageId, reactions } = e.detail;
      setReactionsMap(prev => {
        const next = new Map(prev);
        next.set(String(messageId), reactions || []);
        return next;
      });
    };
    document.addEventListener('reaction:update', onUpdate);
    return () => document.removeEventListener('reaction:update', onUpdate);
  }, []);

  // Listen for picker open requests
  useEffect(() => {
    const onOpen = (e) => {
      const msgId = e.detail?.messageId;
      if (!msgId) return;
      if (pickerTarget === String(msgId)) {
        setPickerTarget(null);
        return;
      }
      // Position picker near the message
      const msgEl = document.querySelector(`[data-message-id="${msgId}"]`);
      if (msgEl) {
        const rect = msgEl.getBoundingClientRect();
        setPickerPos({
          top: Math.max(8, rect.bottom - 200),
          left: Math.min(rect.right - 180, window.innerWidth - 200),
        });
      }
      setPickerTarget(String(msgId));
    };
    document.addEventListener('reaction:open-picker', onOpen);
    return () => document.removeEventListener('reaction:open-picker', onOpen);
  }, [pickerTarget]);

  const sendReaction = useCallback((messageId, emoji, remove = false) => {
    document.dispatchEvent(new CustomEvent(remove ? 'reaction:remove' : 'reaction:add', {
      detail: { messageId, emoji },
    }));
    setPickerTarget(null);
  }, []);

  // Render reaction badges into message containers
  useEffect(() => {
    for (const [msgId, reactions] of reactionsMap) {
      const container = document.querySelector(`[data-reactions-for="${msgId}"]`);
      if (!container) continue;

      // Remove existing badges but keep the "+" button
      container.querySelectorAll('.reaction-badge').forEach(el => el.remove());

      if (reactions.length === 0) continue;

      const currentUser = window._chatUsername || '';
      const addBtn = container.querySelector('.reaction-add-btn');

      reactions.forEach(r => {
        const btn = document.createElement('button');
        const isMine = r.users.includes(currentUser);
        btn.className = 'reaction-badge' + (isMine ? ' reaction-mine' : '');
        btn.title = r.users.join(', ');
        btn.textContent = `${r.emoji} ${r.count}`;
        btn.onclick = () => sendReaction(msgId, r.emoji, isMine);
        // Insert before the "+" button
        if (addBtn) {
          container.insertBefore(btn, addBtn);
        } else {
          container.appendChild(btn);
        }
      });
    }
  }, [reactionsMap, sendReaction]);

  if (!pickerTarget) return null;

  return (
    <div className="emoji-picker-overlay" onClick={() => setPickerTarget(null)}>
      <div
        className="emoji-picker"
        style={{ top: pickerPos.top + 'px', left: pickerPos.left + 'px' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="emoji-picker-grid">
          {QUICK_EMOJIS.map(emoji => (
            <button
              key={emoji}
              className="emoji-picker-item"
              onClick={() => sendReaction(pickerTarget, emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
