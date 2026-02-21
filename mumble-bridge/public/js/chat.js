/**
 * IDIOTS PLAY GAMES — Voice Chat Client
 * Connects to the Mumble Bridge via WebSocket.
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────
  let ws = null;
  let username = '';
  let userId = null;
  let currentChannelId = 0;
  let channels = new Map();
  let users = new Map();
  let webClients = new Map(); // web_userId -> { id, username, channelId, inVoice }
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  let pollTimer = null;
  const POLL_INTERVAL = 5000; // refresh messages every 5 seconds
  const seenMessageIds = new Set(); // dedup messages by id
  const ACTIVITY_CHANNEL_ID = '__activity__'; // Virtual channel for activity feed
  let activityMessages = []; // Stored activity messages for the virtual channel
  const speakingUsers = new Set(); // webClientIds currently speaking
  const speakingTimers = new Map(); // debounce timers for speaking indicators

  // ── DOM refs ─────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const loginScreen   = $('#login-screen');
  const chatScreen    = $('#chat-screen');
  const usernameInput = $('#username-input');
  const loginBtn      = $('#login-btn');
  const loginError    = $('#login-error');
  const sidebar       = $('#sidebar');
  const toggleSidebar = $('#toggle-sidebar-btn');
  const channelList   = $('#channel-list');
  const userList      = $('#user-list');
  const userCount     = $('#user-count');
  const myUsername    = $('#my-username');
  const disconnectBtn = $('#disconnect-btn');
  const channelHeader = $('#current-channel-name');
  const messagesEl    = $('#messages');
  const msgContainer  = $('#messages-container');
  const messageInput  = $('#message-input');
  const sendBtn       = $('#send-btn');
  const statusDot     = $('#connection-status');
  const addChannelBtn  = $('#add-channel-btn');
  const channelDialog  = $('#channel-dialog');
  const channelNameInput = $('#channel-name-input');
  const channelSaveBtn = $('#channel-save-btn');
  const channelCancelBtn = $('#channel-cancel-btn');

  // ── Helpers ──────────────────────────────────────────────
  function setStatus(state) {
    statusDot.className = 'status-dot ' + state;
    statusDot.title = state.charAt(0).toUpperCase() + state.slice(1);
  }

  function showError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  }

  function hideError() {
    loginError.classList.add('hidden');
  }

  function switchToChat() {
    loginScreen.classList.remove('active');
    chatScreen.classList.add('active');
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
  }

  function switchToLogin() {
    chatScreen.classList.remove('active');
    loginScreen.classList.add('active');
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messagesEl.innerHTML = '';
    channelList.innerHTML = '';
    userList.innerHTML = '';
    channels.clear();
    users.clear();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    });
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function stripHtml(str) {
    return str.replace(/<[^>]+>/g, '').trim();
  }

  // ── WebSocket URL ────────────────────────────────────────
  function getWsUrl() {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + loc.host;
  }

  // ── Connection ───────────────────────────────────────────
  function connect() {
    if (ws && ws.readyState <= 1) return;

    setStatus('connecting');
    const url = getWsUrl();
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer'; // Receive binary audio as ArrayBuffer

    ws.onopen = () => {
      console.log('[WS] Connected');
      setStatus('connected');
      reconnectAttempts = 0;

      // Authenticate
      ws.send(JSON.stringify({ type: 'auth', username }));
    };

    ws.onmessage = (ev) => {
      // Binary messages = audio from Mumble
      if (ev.data instanceof ArrayBuffer) {
        handleAudioFromServer(ev.data);
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        handleMessage(msg);
      } catch (e) {
        console.error('[WS] Bad message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    stopPolling();
    reconnectAttempts = MAX_RECONNECT; // prevent reconnect
    if (ws) ws.close();
    ws = null;
    username = '';
    userId = null;
    seenMessageIds.clear();
    webClients.clear();
    switchToLogin();
    setStatus('disconnected');
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        send({ type: 'get_history', channelId: currentChannelId, limit: 20, _isRefresh: true });
      }
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
    addSystemMessage(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`);
    reconnectTimer = setTimeout(() => connect(), delay);
  }

  // ── Message Handler ──────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        userId = msg.userId;
        username = msg.username;
        myUsername.textContent = username;
        switchToChat();
        addSystemMessage(`Connected as ${username}`);
        // Request history
        send({ type: 'get_history', channelId: currentChannelId, limit: 50 });
        // Join default channel
        send({ type: 'join_channel', channelId: currentChannelId });
        // Start polling for new messages
        startPolling();
        break;

      case 'server_state':
        // Initial state — channels + users
        if (msg.channels) {
          msg.channels.forEach(ch => channels.set(ch.id, ch));
        }
        if (msg.users) {
          msg.users.forEach(u => users.set(u.session, u));
        }
        renderChannels();
        renderUsers();
        break;

      case 'channel_update':
        if (msg.channel) {
          channels.set(msg.channel.id, msg.channel);
          renderChannels();
        }
        break;

      case 'channel_remove':
        channels.delete(msg.channelId);
        renderChannels();
        break;

      case 'user_update':
        if (msg.user) {
          users.set(msg.user.session, msg.user);
          renderUsers();
          // If this is a new user joining, show system message
          const existingNames = new Set();
          users.forEach(u => existingNames.add(u.name));
          if (msg.user.name && !existingNames.has(msg.user.name)) {
            addActivityMessage(`${msg.user.name} joined`);
          }
        }
        break;

      case 'user_remove':
        users.delete(msg.session);
        renderUsers();
        if (msg.name) {
          addActivityMessage(`${msg.name} left`);
        }
        break;

      case 'web_users':
        // Full list of web clients (sent on connect)
        webClients.clear();
        if (msg.webClients) {
          msg.webClients.forEach(wc => webClients.set(wc.id, wc));
        }
        renderUsers();
        break;

      case 'web_user_join':
        if (msg.webClient) {
          webClients.set(msg.webClient.id, msg.webClient);
          renderUsers();
          // Don't show join message for ourselves
          if (msg.webClient.id !== `web_${userId}`) {
            addActivityMessage(`${msg.webClient.username} joined`);
          }
        }
        break;

      case 'web_user_leave':
        webClients.delete(msg.id);
        renderUsers();
        if (msg.username) {
          addActivityMessage(`${msg.username} left`);
        }
        break;

      case 'voice_state':
        if (msg.id && webClients.has(msg.id)) {
          webClients.get(msg.id).inVoice = msg.inVoice;
          renderUsers();
          if (msg.id !== `web_${userId}`) {
            addActivityMessage(msg.inVoice ? `🎤 ${msg.username} joined voice` : `${msg.username} left voice`);
          }
        }
        break;

      case 'voice_ready':
        // Server confirmed our Mumble voice session is active
        console.log('[Voice] Server confirmed voice session ready');
        break;

      case 'voice_stopped':
        // Server confirmed voice session stopped
        console.log('[Voice] Server confirmed voice session stopped');
        break;

      case 'voice_speaking':
        // Speaking indicator from server
        if (msg.id) {
          if (msg.speaking) {
            speakingUsers.add(msg.id);
          } else {
            speakingUsers.delete(msg.id);
          }
          renderUsers();
        }
        break;

      case 'text':
        addChatMessage(msg);
        break;

      case 'history': {
        if (msg.messages && msg.messages.length > 0) {
          // Deduplicate using normalized key (same as addChatMessage)
          const newMsgs = msg.messages.filter(m => {
            const name = m.senderName || m.username || '';
            const text = m.content || m.text || '';
            const key = m.id ? String(m.id) : dedupKey(name, text);
            if (seenMessageIds.has(key)) return false;
            seenMessageIds.add(key);
            return true;
          });
          if (newMsgs.length > 0 && !msg._isRefresh) {
            addSystemMessage(`— Loaded ${newMsgs.length} previous messages —`);
          }
          newMsgs
            .sort((a, b) => {
              const tA = new Date(a.createdAt || a.sentAt || a.timestamp || 0).getTime();
              const tB = new Date(b.createdAt || b.sentAt || b.timestamp || 0).getTime();
              if (tA !== tB) return tA - tB;
              // If same timestamp, sort by id if available
              return (a.id || 0) - (b.id || 0);
            })
            .forEach(m => {
              addChatMessage({
                username: m.senderName || m.username || 'Unknown',
                text: m.content || m.text || '',
                timestamp: m.createdAt || m.sentAt || m.timestamp || new Date().toISOString(),
                source: 'history',
              }, true);
            });
        }
        // Only auto-scroll on initial load, never on poll refreshes
        if (!msg._isRefresh) {
          scrollToBottom();
        }
        break;
      }

      case 'joined_channel':
        currentChannelId = msg.channelId;
        const ch = channels.get(currentChannelId);
        channelHeader.textContent = '#' + (ch ? ch.name : 'Unknown');
        renderChannels();
        break;

      case 'error':
        if (!userId) {
          showError(msg.message);
        } else {
          addSystemMessage('Error: ' + msg.message);
        }
        break;

      case 'media_results':
        if (msg.results && msg.results.length > 0) {
          addSystemMessage(`Found ${msg.results.length} results:`);
          msg.results.slice(0, 5).forEach((r, i) => {
            addSystemMessage(`  ${i + 1}. ${r.title || r.name || 'Untitled'}`);
          });
        } else {
          addSystemMessage('No media results found.');
        }
        break;

      case 'now_playing':
        if (msg.state && msg.state.title) {
          addSystemMessage(`🎵 Now playing: ${msg.state.title}`);
        } else {
          addSystemMessage('🎵 Nothing playing right now.');
        }
        break;

      case 'music_queue':
        if (msg.queue && msg.queue.length > 0) {
          addSystemMessage(`Queue (${msg.queue.length} tracks):`);
          msg.queue.slice(0, 5).forEach((t, i) => {
            addSystemMessage(`  ${i + 1}. ${t.title || 'Untitled'}`);
          });
        } else {
          addSystemMessage('Queue is empty.');
        }
        break;

      default:
        console.log('[WS] Unhandled:', msg.type, msg);
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ── Rendering ────────────────────────────────────────────
  function renderChannels() {
    channelList.innerHTML = '';
    const sorted = Array.from(channels.values()).sort((a, b) => a.id - b.id);
    sorted.forEach(ch => {
      const li = document.createElement('li');
      li.textContent = ch.name || 'Unnamed';
      if (ch.id === currentChannelId) li.classList.add('active');
      li.addEventListener('click', () => joinChannel(ch.id));
      channelList.appendChild(li);
    });

    // Activity virtual channel (always at the bottom)
    const actLi = document.createElement('li');
    actLi.className = 'activity-channel';
    actLi.textContent = '📋 Activity';
    if (currentChannelId === ACTIVITY_CHANNEL_ID) actLi.classList.add('active');
    actLi.addEventListener('click', () => joinChannel(ACTIVITY_CHANNEL_ID));
    channelList.appendChild(actLi);
  }

  function renderUsers() {
    userList.innerHTML = '';

    // Collect web clients (real users)
    const webUsers = Array.from(webClients.values()).sort((a, b) => (a.username || '').localeCompare(b.username || ''));

    // Collect Mumble-native users (exclude the bridge bot)
    const mumbleUsers = Array.from(users.values())
      .filter(u => u.name && u.name !== 'MumbleBridge')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Voice members section
    const voiceMembers = webUsers.filter(wc => wc.inVoice);
    if (voiceMembers.length > 0) {
      const voiceHeader = document.createElement('li');
      voiceHeader.className = 'user-section-header';
      voiceHeader.textContent = `🔊 In Voice — ${voiceMembers.length}`;
      userList.appendChild(voiceHeader);
      voiceMembers.forEach(wc => {
        const li = document.createElement('li');
        li.className = 'user-item in-voice';
        if (speakingUsers.has(wc.id)) li.classList.add('speaking');
        const dot = document.createElement('span');
        dot.className = 'user-avatar voice';
        li.appendChild(dot);
        const name = document.createElement('span');
        name.textContent = wc.username + ' 🎤';
        li.appendChild(name);
        userList.appendChild(li);
      });
    }

    // Online web users section
    const onlineHeader = document.createElement('li');
    onlineHeader.className = 'user-section-header';
    onlineHeader.textContent = `Online — ${webUsers.length}`;
    userList.appendChild(onlineHeader);
    webUsers.forEach(wc => {
      const li = document.createElement('li');
      li.className = 'user-item';
      if (wc.inVoice) li.classList.add('in-voice');
      const dot = document.createElement('span');
      dot.className = 'user-avatar' + (wc.inVoice ? ' voice' : '');
      li.appendChild(dot);
      const name = document.createElement('span');
      name.textContent = wc.username + (wc.inVoice ? ' 🎤' : '');
      li.appendChild(name);
      userList.appendChild(li);
    });

    // Mumble-native users section (if any besides the bot)
    if (mumbleUsers.length > 0) {
      const mumbleHeader = document.createElement('li');
      mumbleHeader.className = 'user-section-header';
      mumbleHeader.textContent = `Mumble — ${mumbleUsers.length}`;
      userList.appendChild(mumbleHeader);
      mumbleUsers.forEach(u => {
        const li = document.createElement('li');
        li.className = 'user-item';
        const dot = document.createElement('span');
        dot.className = 'user-avatar';
        li.appendChild(dot);
        const name = document.createElement('span');
        name.textContent = u.name;
        li.appendChild(name);
        const chTag = document.createElement('span');
        chTag.className = 'user-channel';
        const userCh = channels.get(u.channelId);
        chTag.textContent = userCh ? userCh.name : '';
        li.appendChild(chTag);
        userList.appendChild(li);
      });
    }

    userCount.textContent = webUsers.length + mumbleUsers.length;
  }

  function joinChannel(chId) {
    currentChannelId = chId;

    if (chId === ACTIVITY_CHANNEL_ID) {
      // Virtual activity channel — show stored activity messages
      channelHeader.textContent = '📋 Activity';
      renderChannels();
      messagesEl.innerHTML = '';
      seenMessageIds.clear();

      // Render stored activity messages
      activityMessages.forEach(am => {
        const div = document.createElement('div');
        div.className = 'message system-msg';
        const header = document.createElement('div');
        header.className = 'msg-header';
        const time = document.createElement('span');
        time.className = 'msg-time';
        time.textContent = formatTime(am.timestamp);
        header.appendChild(time);
        const text = document.createElement('div');
        text.className = 'msg-text';
        text.textContent = am.text;
        div.appendChild(header);
        div.appendChild(text);
        messagesEl.appendChild(div);
      });
      scrollToBottom();

      // Stop polling (activity channel doesn't use server history)
      stopPolling();
      // Hide input bar (read-only channel)
      messageInput.disabled = true;
      sendBtn.disabled = true;
      messageInput.placeholder = 'Activity feed is read-only';
      sidebar.classList.remove('open');
      return;
    }

    // Normal channel
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.placeholder = 'Type a message...';

    send({ type: 'join_channel', channelId: chId });
    const ch = channels.get(chId);
    channelHeader.textContent = '#' + (ch ? ch.name : 'Unknown');
    renderChannels();

    // Clear messages and load history for new channel
    messagesEl.innerHTML = '';
    seenMessageIds.clear();
    send({ type: 'get_history', channelId: chId, limit: 50 });

    // Restart polling for the new channel
    startPolling();

    // Close mobile sidebar
    sidebar.classList.remove('open');
  }

  // ── Chat Messages ────────────────────────────────────────

  /** Normalize dedup key: username + clean text (timestamps differ between sources) */
  function dedupKey(name, text) {
    return (name || '').toLowerCase() + '|' + stripHtml(text || '').toLowerCase().trim();
  }

  function addChatMessage(msg, isHistory) {
    // Dedup real-time messages too
    const key = msg.id ? String(msg.id) : dedupKey(msg.username, msg.text);
    if (seenMessageIds.has(key)) return;
    seenMessageIds.add(key);

    const div = document.createElement('div');
    div.className = 'message';

    const header = document.createElement('div');
    header.className = 'msg-header';

    const author = document.createElement('span');
    author.className = 'msg-author';
    const displayName = msg.username || 'Unknown';
    author.textContent = displayName;

    // Color the author name
    if (displayName === username) {
      author.classList.add('self');
    } else if (msg.source === 'mumble') {
      author.classList.add('mumble');
    }

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.timestamp || new Date().toISOString());

    header.appendChild(author);
    header.appendChild(time);

    const text = document.createElement('div');
    text.className = 'msg-text';
    // Strip HTML tags from Mumble messages but keep the text
    const cleanText = stripHtml(msg.text || '');
    text.textContent = cleanText;

    div.appendChild(header);
    div.appendChild(text);
    messagesEl.appendChild(div);

    // Auto-scroll if near bottom
    if (!isHistory) {
      const threshold = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
      if (threshold < 150) {
        scrollToBottom();
      }
    }
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system-msg';

    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = text;

    div.appendChild(textEl);
    messagesEl.appendChild(div);

    const threshold = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
    if (threshold < 150) {
      scrollToBottom();
    }
  }

  /**
   * Add a message to the activity feed (virtual Activity channel).
   * If the user is currently viewing Activity, render it immediately.
   */
  function addActivityMessage(text) {
    const timestamp = new Date().toISOString();
    activityMessages.push({ text, timestamp });

    // Keep only last 100 activity items
    while (activityMessages.length > 100) activityMessages.shift();

    // If currently viewing Activity channel, render it
    if (currentChannelId === ACTIVITY_CHANNEL_ID) {
      const div = document.createElement('div');
      div.className = 'message system-msg';
      const header = document.createElement('div');
      header.className = 'msg-header';
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = formatTime(timestamp);
      header.appendChild(time);
      const textEl = document.createElement('div');
      textEl.className = 'msg-text';
      textEl.textContent = text;
      div.appendChild(header);
      div.appendChild(textEl);
      messagesEl.appendChild(div);

      const threshold = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
      if (threshold < 150) scrollToBottom();
    }
  }

  // ── Send Message ─────────────────────────────────────────
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    // Check for bot commands
    if (text.startsWith('!')) {
      const parts = text.slice(1).split(/\s+/);
      send({ type: 'command', command: parts[0], args: parts.slice(1) });
    }

    // Show the message locally immediately (server won't echo it back to us)
    const now = new Date().toISOString();
    addChatMessage({
      username: username,
      text: text,
      timestamp: now,
      source: 'self',
    });

    // Send to server for broadcast to others + storage
    send({ type: 'text', text, channelId: currentChannelId });
    messageInput.value = '';
    messageInput.focus();
  }

  // ── Event Listeners ──────────────────────────────────────
  loginBtn.addEventListener('click', () => {
    hideError();
    const name = usernameInput.value.trim();
    if (!name) {
      showError('Please enter a username');
      return;
    }
    if (name.length < 2) {
      showError('Username must be at least 2 characters');
      return;
    }
    username = name;
    reconnectAttempts = 0;
    connect();
  });

  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });

  sendBtn.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  disconnectBtn.addEventListener('click', disconnect);

  toggleSidebar.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // ── Channel Management ───────────────────────────────────
  addChannelBtn.addEventListener('click', () => {
    channelDialog.classList.toggle('hidden');
    if (!channelDialog.classList.contains('hidden')) {
      channelNameInput.value = '';
      channelNameInput.focus();
    }
  });

  channelCancelBtn.addEventListener('click', () => {
    channelDialog.classList.add('hidden');
  });

  channelSaveBtn.addEventListener('click', () => {
    const name = channelNameInput.value.trim();
    if (name) {
      send({ type: 'create_channel', name, parentId: 0 });
      channelDialog.classList.add('hidden');
    }
  });

  channelNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') channelSaveBtn.click();
    if (e.key === 'Escape') channelCancelBtn.click();
  });

  // Close sidebar when clicking outside on mobile
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') &&
        !sidebar.contains(e.target) &&
        e.target !== toggleSidebar) {
      sidebar.classList.remove('open');
    }
  });

  // Check for username URL parameter (e.g., ?username=PlayerName)
  const urlParams = new URLSearchParams(window.location.search);
  const urlUsername = urlParams.get('username');
  if (urlUsername && urlUsername.trim().length >= 2) {
    usernameInput.value = urlUsername.trim();
  }

  // Focus username input on load
  usernameInput.focus();

  // ── Voice Chat (WebSocket audio + Mumble) ────────────────
  // No WebRTC. Audio goes: Mic → AudioWorklet → WebSocket binary → Mumble.
  // And back:              Mumble → WebSocket binary → AudioWorklet → Speaker.
  let audioContext = null;
  let voiceWorklet = null;
  let micStream = null;
  let voiceActive = false;
  let isMuted = false;
  let isDeafened = false;
  let sendBuffer = new Int16Array(0); // Accumulate mic samples until we have 960

  const voiceConnectBtn  = $('#voice-connect-btn');
  const voiceActiveCtrl  = $('#voice-active-controls');
  const muteBtn          = $('#mute-btn');
  const deafenBtn        = $('#deafen-btn');
  const voiceDisconnect  = $('#voice-disconnect-btn');
  const voiceStatus      = $('#voice-status');
  const headerVoiceBtn   = $('#header-voice-btn');
  const headerVoiceStatus = $('#header-voice-status');

  function setVoiceStatus(text, state) {
    voiceStatus.textContent = text;
    voiceStatus.className = 'voice-status' + (state ? ' ' + state : '');
    if (state === 'connected') {
      headerVoiceBtn.textContent = '🎤 Connected';
      headerVoiceBtn.classList.add('connected');
      headerVoiceStatus.textContent = '';
      headerVoiceStatus.classList.add('hidden');
    } else if (state === 'error') {
      headerVoiceBtn.textContent = '🎤 Join Voice';
      headerVoiceBtn.classList.remove('connected', 'hidden');
      headerVoiceStatus.textContent = text;
      headerVoiceStatus.className = 'header-voice-status error';
    } else if (text === 'Not connected') {
      headerVoiceBtn.textContent = '🎤 Join Voice';
      headerVoiceBtn.classList.remove('connected', 'hidden');
      headerVoiceStatus.classList.add('hidden');
    }
  }

  async function startVoice() {
    if (voiceActive) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const errMsg = 'Your browser does not support voice chat. Use a modern browser with HTTPS.';
      setVoiceStatus(errMsg, 'error');
      addSystemMessage('🎤 ' + errMsg);
      return;
    }

    try {
      setVoiceStatus('Requesting microphone...', '');
      addSystemMessage('🎤 Requesting microphone access...');

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });

      setVoiceStatus('Connecting...', '');
      addSystemMessage('🎤 Microphone access granted, connecting to voice...');

      // Create AudioContext at 48kHz (matches Mumble)
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

      // Load our AudioWorklet
      await audioContext.audioWorklet.addModule('/js/voice-processor.js');

      // Create worklet node — 1 input (mic), 1 output (speakers)
      voiceWorklet = new AudioWorkletNode(audioContext, 'voice-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: {},
      });

      // Mic → worklet (capture)
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(voiceWorklet);

      // Worklet → speakers (playback)
      voiceWorklet.connect(audioContext.destination);

      // When worklet captures mic audio, accumulate and send in 960-sample chunks
      // Only send frames that contain actual voice (basic energy-based VAD)
      sendBuffer = new Int16Array(0);
      voiceWorklet.port.onmessage = (e) => {
        if (e.data.type === 'capture' && ws && ws.readyState === WebSocket.OPEN) {
          // Accumulate samples
          const incoming = e.data.samples;
          const merged = new Int16Array(sendBuffer.length + incoming.length);
          merged.set(sendBuffer);
          merged.set(incoming, sendBuffer.length);
          sendBuffer = merged;

          // Send complete 960-sample frames (20ms at 48kHz)
          while (sendBuffer.length >= 960) {
            const frame = sendBuffer.slice(0, 960);
            sendBuffer = sendBuffer.slice(960);

            // Voice Activity Detection — skip silence frames
            // Compute RMS energy of the frame
            let sumSq = 0;
            for (let i = 0; i < frame.length; i++) {
              sumSq += frame[i] * frame[i];
            }
            const rms = Math.sqrt(sumSq / frame.length);
            // Threshold ~200 out of 32768 — catches actual speech, rejects noise floor
            if (rms < 200) continue;

            // Send as raw binary over WebSocket
            ws.send(frame.buffer);
          }
        }
      };

      // Tell the server to start our Mumble voice session
      send({ type: 'voice_start' });
      voiceActive = true;

      // UI updates
      setVoiceStatus('Connected', 'connected');
      voiceConnectBtn.classList.add('hidden');
      voiceActiveCtrl.classList.remove('hidden');
      addSystemMessage('🎤 Voice connected!');

    } catch (err) {
      console.error('[Voice] Error:', err);
      let errorMsg = err.message || 'Unknown error';
      if (err.name === 'NotAllowedError') {
        errorMsg = 'Microphone permission denied. Please allow microphone access.';
      } else if (err.name === 'NotFoundError') {
        errorMsg = 'No microphone found. Please connect a microphone.';
      } else if (err.name === 'NotReadableError') {
        errorMsg = 'Microphone is in use by another application.';
      }
      setVoiceStatus('Failed: ' + errorMsg, 'error');
      addSystemMessage('🎤 Voice error: ' + errorMsg);
      stopVoice();
    }
  }

  /**
   * Handle incoming binary audio from server (PCM Int16LE from Mumble).
   * Convert to Float32 and push to the AudioWorklet for playback.
   */
  function handleAudioFromServer(data) {
    if (!voiceWorklet || isDeafened) return;

    const int16 = new Int16Array(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Send to worklet for playback
    voiceWorklet.port.postMessage({ type: 'playback', samples: float32 }, [float32.buffer]);
  }

  function stopVoice() {
    voiceActive = false;
    sendBuffer = new Int16Array(0);

    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (voiceWorklet) {
      voiceWorklet.disconnect();
      voiceWorklet = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }

    isMuted = false;
    isDeafened = false;
    muteBtn.classList.remove('muted');
    muteBtn.textContent = '🎤';
    deafenBtn.classList.remove('muted');
    deafenBtn.textContent = '🔊';

    voiceConnectBtn.classList.remove('hidden');
    voiceActiveCtrl.classList.add('hidden');
    setVoiceStatus('Not connected', '');

    send({ type: 'voice_stop' });
  }

  function toggleMute() {
    if (!micStream) return;
    isMuted = !isMuted;
    micStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    if (voiceWorklet) {
      voiceWorklet.port.postMessage({ type: 'mute', muted: isMuted });
    }
    muteBtn.classList.toggle('muted', isMuted);
    muteBtn.textContent = isMuted ? '🚫' : '🎤';
    muteBtn.title = isMuted ? 'Unmute' : 'Mute';
    addSystemMessage(isMuted ? '🔇 Microphone muted' : '🎤 Microphone unmuted');
  }

  function toggleDeafen() {
    if (!voiceActive) return;
    isDeafened = !isDeafened;
    deafenBtn.classList.toggle('muted', isDeafened);
    deafenBtn.textContent = isDeafened ? '🔇' : '🔊';
    deafenBtn.title = isDeafened ? 'Undeafen' : 'Deafen';
    if (isDeafened && !isMuted) toggleMute();
    addSystemMessage(isDeafened ? '🔇 Deafened' : '🔊 Undeafened');
  }

  // Wire up voice buttons
  voiceConnectBtn.addEventListener('click', startVoice);
  headerVoiceBtn.addEventListener('click', () => {
    if (voiceActive) {
      stopVoice();
    } else {
      startVoice();
    }
  });
  muteBtn.addEventListener('click', toggleMute);
  deafenBtn.addEventListener('click', toggleDeafen);
  voiceDisconnect.addEventListener('click', stopVoice);

})();
