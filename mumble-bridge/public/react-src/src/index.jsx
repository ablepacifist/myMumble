import React from 'react';
import { createRoot } from 'react-dom/client';
import TypingIndicator from './components/TypingIndicator.jsx';
import MentionAutocomplete from './components/MentionAutocomplete.jsx';
import NotificationToast from './components/NotificationToast.jsx';
import EmojiReactions from './components/EmojiReactions.jsx';
import './styles/features.css';

/**
 * Mount React feature components into existing page anchor elements.
 * Each component mounts independently — no global React router needed.
 * Communication with existing chat.js via CustomEvents and window.ws.
 */
function mountFeatures() {
  // Typing Indicator — mounts below message list, above input
  const typingMount = document.getElementById('typing-indicator-mount');
  if (typingMount) {
    createRoot(typingMount).render(<TypingIndicator />);
  }

  // Mention Autocomplete — mounts above the input bar
  const mentionMount = document.getElementById('mention-autocomplete-mount');
  if (mentionMount) {
    createRoot(mentionMount).render(<MentionAutocomplete />);
  }

  // Notification Toast — mounts in top-right corner overlay
  const toastMount = document.getElementById('notification-toast-mount');
  if (toastMount) {
    createRoot(toastMount).render(<NotificationToast />);
  }

  // Emoji Reactions — global manager, mounts in a hidden div
  const reactionsMount = document.getElementById('reactions-mount');
  if (reactionsMount) {
    createRoot(reactionsMount).render(<EmojiReactions />);
  }

  console.log('[React Features] Mounted successfully');
}

// Mount when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountFeatures);
} else {
  mountFeatures();
}
