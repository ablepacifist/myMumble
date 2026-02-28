/**
 * IDIOTS PLAY GAMES — Voice Chat Client (Discord-style)
 * Connects to the Mumble Bridge via WebSocket.
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────
  let ws = null;
  let username = '';
  let userId = null;
  let isAdmin = false;
  let currentChannelId = 1;  // default to 'general' channel
  let channels = new Map();       // id -> { id, name, parentId, ... }
  let users = new Map();          // session -> mumble user
  let webClients = new Map();     // web_userId -> { id, username, channelId, inVoice }
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  let pollTimer = null;
  const POLL_INTERVAL = 30000;
  const seenMessageIds = new Set();
  const ACTIVITY_CHANNEL_ID = '__activity__';
  let activityMessages = [];
  let collapsedCategories = new Set(); // persisted category collapsed state
  let memberListVisible = true;
  let lastMessageAuthor = null;     // for grouping messages
  let lastMessageTime = 0;

  // Avatar cache
  const avatarCache = {};
  const DEFAULT_AVATAR = '/uploads/avatars/default.jpg';

  // Voice settings (persisted to localStorage)
  let voiceSettings = loadVoiceSettings();

  // ── DOM refs ─────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const loginScreen     = $('#login-screen');
  const chatScreen      = $('#chat-screen');
  const usernameInput   = $('#username-input');
  const loginBtn        = $('#login-btn');
  const loginError      = $('#login-error');
  const sidebar         = $('#sidebar');
  const toggleSidebar   = $('#toggle-sidebar-btn');
  const channelTree     = $('#channel-tree');
  const myUsername       = $('#my-username');
  const myAvatar        = $('#my-avatar');
  const channelHeader   = $('#current-channel-name');
  const channelHash     = $('.channel-hash');
  const messagesEl      = $('#messages');
  const msgContainer    = $('#messages-container');
  const messageInput    = $('#message-input');
  const sendBtn         = $('#send-btn');
  const statusDot       = $('#connection-status');
  const channelDialog   = $('#channel-dialog');
  const channelNameInput = $('#channel-name-input');
  const channelCategorySelect = $('#channel-category-select');
  const channelVoiceCheck = $('#channel-voice-check');
  const channelSaveBtn  = $('#channel-save-btn');
  const channelCancelBtn = $('#channel-cancel-btn');
  const membersToggle   = $('#members-toggle');
  const memberList      = $('#member-list');
  const memberListContent = $('#member-list-content');
  const settingsBtn     = $('#settings-btn');
  const settingsModal   = $('#settings-modal');
  const settingsClose   = $('#settings-close');
  const settingsLogout  = $('#settings-logout');
  const muteBtn         = $('#mute-btn');
  const deafenBtn       = $('#deafen-btn');
  const headerVoiceBtn  = $('#header-voice-btn');

  // Settings DOM
  const profileAvatar   = $('#profile-avatar-preview');
  const avatarUpload    = $('#avatar-upload');
  const avatarRemove    = $('#avatar-remove');
  const profileDisplayName = $('#profile-display-name');
  const profileUsername  = $('#profile-username');

  // Voice settings DOM
  const voiceInputDevice = $('#voice-input-device');
  const voiceOutputDevice = $('#voice-output-device');
  const voiceInputVolume = $('#voice-input-volume');
  const voiceOutputVolume = $('#voice-output-volume');
  const voiceVadThreshold = $('#voice-vad-threshold');
  const voiceEchoCancel = $('#voice-echo-cancel');
  const voiceNoiseSuppress = $('#voice-noise-suppress');
  const voiceAutoGain   = $('#voice-auto-gain');
  const voiceInputVolumeVal = $('#voice-input-volume-val');
  const voiceOutputVolumeVal = $('#voice-output-volume-val');
  const voiceVadThresholdVal = $('#voice-vad-threshold-val');
  const voiceTestBtn    = $('#voice-test-btn');
  const voiceTestMeter  = $('#voice-test-meter');

  // Appearance
  const appearanceFontSize = $('#appearance-font-size');
  const appearanceCompact = $('#appearance-compact');

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
    myUsername.textContent = username;
    profileUsername.value = username;
    profileDisplayName.value = username;
  }

  function switchToLogin() {
    chatScreen.classList.remove('active');
    loginScreen.classList.add('active');
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messagesEl.innerHTML = '';
    channelTree.innerHTML = '';
    memberListContent.innerHTML = '';
    channels.clear();
    users.clear();
    webClients.clear();
    lastMessageAuthor = null;
    lastMessageTime = 0;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    });
  }

  function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return 'Today at ' + time;
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday at ' + time;
    return d.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' ' + time;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function stripHtml(str) {
    return str.replace(/<[^>]+>/g, '').trim();
  }

  function getAvatarUrl(username) {
    return avatarCache[username] || DEFAULT_AVATAR;
  }

  // ── Voice Settings Persistence ───────────────────────────
  function loadVoiceSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('voiceSettings'));
      return Object.assign({
        inputDeviceId: 'default',
        outputDeviceId: 'default',
        inputVolume: 100,
        outputVolume: 100,
        vadThreshold: 200,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }, s || {});
    } catch { return { inputDeviceId: 'default', outputDeviceId: 'default', inputVolume: 100, outputVolume: 100, vadThreshold: 200, echoCancellation: true, noiseSuppression: true, autoGainControl: true }; }
  }

  function saveVoiceSettings() {
    localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
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
    ws = new WebSocket(getWsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setStatus('connected');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'auth', username }));
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleAudioFromServer(ev.data);
        return;
      }
      try { handleMessage(JSON.parse(ev.data)); }
      catch (e) { console.error('[WS] Bad message:', e); }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      scheduleReconnect();
    };
    ws.onerror = (err) => console.error('[WS] Error:', err);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    stopPolling();
    reconnectAttempts = MAX_RECONNECT;
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
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    addActivityMessage(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`);
    reconnectTimer = setTimeout(() => connect(), delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ── Message Handler ──────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        userId = msg.userId;
        username = msg.username;
        isAdmin = !!msg.isAdmin;
        myUsername.textContent = username;
        profileUsername.value = username;
        profileDisplayName.value = username;
        switchToChat();
        addActivityMessage(`Connected as ${username}`);
        send({ type: 'get_history', channelId: currentChannelId, limit: 50 });
        send({ type: 'join_channel', channelId: currentChannelId });
        startPolling();
        // Load our avatar
        loadMyAvatar();
        break;

      case 'server_state':
        if (msg.channels) msg.channels.forEach(ch => channels.set(ch.id, ch));
        if (msg.users) msg.users.forEach(u => users.set(u.session, u));
        renderChannels();
        renderMembers();
        break;

      case 'channel_update':
        if (msg.channel) { channels.set(msg.channel.id, msg.channel); renderChannels(); }
        break;

      case 'channel_remove':
        channels.delete(msg.channelId);
        renderChannels();
        break;

      case 'user_update':
        if (msg.user) {
          users.set(msg.user.session, msg.user);
          renderMembers();
        }
        break;

      case 'user_remove':
        users.delete(msg.session);
        renderMembers();
        if (msg.name) addActivityMessage(`${msg.name} left`);
        break;

      case 'web_users':
        webClients.clear();
        if (msg.webClients) msg.webClients.forEach(wc => {
          webClients.set(wc.id, wc);
          if (wc.avatarUrl) avatarCache[wc.username] = wc.avatarUrl + '?t=' + Date.now();
        });
        renderMembers();
        renderChannels();
        break;

      case 'web_user_join':
        if (msg.webClient) {
          webClients.set(msg.webClient.id, msg.webClient);
          if (msg.webClient.avatarUrl) avatarCache[msg.webClient.username] = msg.webClient.avatarUrl + '?t=' + Date.now();
          renderMembers();
          renderChannels();
          if (msg.webClient.id !== `web_${userId}`) addActivityMessage(`${msg.webClient.username} joined`);
        }
        break;

      case 'web_user_leave':
        webClients.delete(msg.id);
        renderMembers();
        if (msg.username) addActivityMessage(`${msg.username} left`);
        break;

      case 'voice_state':
        if (msg.id && webClients.has(msg.id)) {
          const wc = webClients.get(msg.id);
          wc.inVoice = msg.inVoice;
          wc.voiceChannelId = msg.voiceChannelId || null;
          renderMembers();
          renderChannels();
          if (msg.id !== `web_${userId}`) {
            addActivityMessage(msg.inVoice ? `🎤 ${msg.username} joined voice` : `${msg.username} left voice`);
          }
        }
        break;

      case 'voice_ready':
        console.log('[Voice] Server confirmed voice session ready');
        break;

      case 'voice_stopped':
        console.log('[Voice] Server confirmed voice session stopped');
        break;

      case 'text':
        addChatMessage(msg);
        break;

      case 'history': {
        if (msg.messages && msg.messages.length > 0) {
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
        if (!msg._isRefresh) scrollToBottom();
        break;
      }

      case 'joined_channel':
        currentChannelId = msg.channelId;
        updateChannelHeader();
        renderChannels();
        break;

      case 'error':
        if (!userId) showError(msg.message);
        else addSystemMessage('Error: ' + msg.message);
        break;

      case 'media_results':
        if (msg.results && msg.results.length > 0) {
          addSystemMessage(`Found ${msg.results.length} results:`);
          msg.results.slice(0, 5).forEach((r, i) => addSystemMessage(`  ${i + 1}. ${r.title || r.name || 'Untitled'}`));
        } else addSystemMessage('No media results found.');
        break;

      case 'now_playing':
        if (msg.state && msg.state.title) addSystemMessage(`🎵 Now playing: ${msg.state.title}`);
        else addSystemMessage('🎵 Nothing playing right now.');
        break;

      case 'music_queue':
        if (msg.queue && msg.queue.length > 0) {
          addSystemMessage(`Queue (${msg.queue.length} tracks):`);
          msg.queue.slice(0, 5).forEach((t, i) => addSystemMessage(`  ${i + 1}. ${t.title || 'Untitled'}`));
        } else addSystemMessage('Queue is empty.');
        break;

      case 'avatar_updated':
        if (msg.avatarUrl) {
          avatarCache[msg.username || username] = msg.avatarUrl + '?t=' + Date.now();
          if (!msg.username || msg.username === username) {
            myAvatar.src = avatarCache[username];
            profileAvatar.src = avatarCache[username];
          }
          renderMembers();
          renderChannels();
        }
        break;

      default:
        console.log('[WS] Unhandled:', msg.type, msg);
    }
  }

  // ── Channel Header ───────────────────────────────────────
  function updateChannelHeader() {
    if (currentChannelId === ACTIVITY_CHANNEL_ID) {
      channelHeader.textContent = 'Activity';
      channelHash.textContent = '📋';
      messageInput.placeholder = 'Activity feed is read-only';
    } else {
      const ch = channels.get(currentChannelId);
      const name = ch ? ch.name : 'general';
      channelHeader.textContent = name;
      channelHash.textContent = '#';
      messageInput.placeholder = `Message #${name}`;
    }
  }

  // ── Rendering: Channel Tree ──────────────────────────────
  function renderChannels() {
    channelTree.innerHTML = '';

    // Build parent->children map
    const allChannels = Array.from(channels.values());
    const rootChannels = []; // parentId === 0 or undefined
    const categoryChannels = new Map(); // parentId -> children[]

    allChannels.forEach(ch => {
      if (ch.id === 0) return; // Skip Root
      const pid = ch.parentId || 0;
      if (pid === 0) {
        rootChannels.push(ch);
      } else {
        if (!categoryChannels.has(pid)) categoryChannels.set(pid, []);
        categoryChannels.get(pid).push(ch);
      }
    });

    // Separate categories (channels that have children) from leaf channels
    const categories = rootChannels.filter(ch => categoryChannels.has(ch.id));
    const standaloneChannels = rootChannels.filter(ch => !categoryChannels.has(ch.id));

    // Render standalone channels first (under no category)
    if (standaloneChannels.length > 0) {
      standaloneChannels.sort((a, b) => a.id - b.id).forEach(ch => {
        channelTree.appendChild(createChannelItem(ch));
      });
    }

    // Render each category
    categories.sort((a, b) => a.id - b.id).forEach(cat => {
      const isCollapsed = collapsedCategories.has(cat.id);

      // Category header
      const header = document.createElement('div');
      header.className = 'category-header' + (isCollapsed ? ' collapsed' : '');
      header.innerHTML = `
        <svg class="category-arrow" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        <span class="category-label">${escapeHtml(cat.name)}</span>
        ${isAdmin ? `<div class="category-actions">
          <button class="category-action-btn" title="Create Channel">+</button>
        </div>` : ''}
      `;
      header.addEventListener('click', (e) => {
        if (e.target.closest('.category-action-btn')) {
          e.stopPropagation();
          openChannelDialog(cat.id);
          return;
        }
        if (isCollapsed) collapsedCategories.delete(cat.id);
        else collapsedCategories.add(cat.id);
        renderChannels();
      });
      channelTree.appendChild(header);

      // Children container
      const childContainer = document.createElement('div');
      childContainer.className = 'category-channels';
      if (!isCollapsed) {
        const children = (categoryChannels.get(cat.id) || []).sort((a, b) => a.id - b.id);
        children.forEach(ch => {
          childContainer.appendChild(createChannelItem(ch));
        });
      }
      channelTree.appendChild(childContainer);
    });

    // Activity virtual channel at end
    const actItem = document.createElement('div');
    actItem.className = 'channel-item activity-channel' + (currentChannelId === ACTIVITY_CHANNEL_ID ? ' active' : '');
    actItem.innerHTML = `<span class="channel-icon">📋</span><span class="channel-name">Activity</span>`;
    actItem.addEventListener('click', () => joinChannel(ACTIVITY_CHANNEL_ID));
    channelTree.appendChild(actItem);

    // Update category select in dialog
    channelCategorySelect.innerHTML = '<option value="0">No Category (Root)</option>';
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.name;
      channelCategorySelect.appendChild(opt);
    });
  }

  function createChannelItem(ch) {
    // Detect voice channels: under a parent named "Voice Channels", or name contains voice/walky/afk
    const parentCh = channels.get(ch.parentId);
    const isUnderVoiceCategory = parentCh && parentCh.name && parentCh.name.toLowerCase().includes('voice');
    const isVoice = isUnderVoiceCategory || (ch.name && (ch.name.toLowerCase().includes('voice') || ch.name.toLowerCase().includes('walky')));
    const icon = isVoice ? '🔊' : '#';
    const item = document.createElement('div');
    item.className = 'channel-item' + (ch.id === currentChannelId && !isVoice ? ' active' : '') + (isVoice ? ' voice-channel' : '');

    // Check if current user is in this voice channel
    const myWc = webClients.get(`web_${userId}`);
    const isMyVoiceChannel = isVoice && myWc && myWc.inVoice && myWc.voiceChannelId === ch.id;
    if (isMyVoiceChannel) item.classList.add('active');

    item.innerHTML = `
      <span class="channel-icon">${icon}</span>
      <span class="channel-name">${escapeHtml(ch.name || 'Unnamed')}</span>
      ${isAdmin ? `<div class="channel-actions">
        <button class="channel-action-btn" title="Delete channel">&times;</button>
      </div>` : ''}
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.channel-action-btn')) {
        e.stopPropagation();
        if (confirm(`Delete #${ch.name}?`)) {
          send({ type: 'remove_channel', channelId: ch.id });
        }
        return;
      }
      if (isVoice) {
        joinVoiceChannel(ch.id);
      } else {
        joinChannel(ch.id);
      }
    });

    // Show voice users under voice channels (matched by voiceChannelId)
    if (isVoice) {
      const voiceUsers = Array.from(webClients.values()).filter(wc => wc.inVoice && wc.voiceChannelId === ch.id);
      const container = document.createElement('div');
      container.appendChild(item);
      if (voiceUsers.length > 0) {
        const userList = document.createElement('div');
        userList.className = 'voice-channel-users';
        voiceUsers.forEach(wc => {
          const vu = document.createElement('div');
          vu.className = 'voice-user';
          vu.innerHTML = `<img class="avatar" src="${getAvatarUrl(wc.username)}" alt=""><span>${escapeHtml(wc.username)}</span>`;
          userList.appendChild(vu);
        });
        container.appendChild(userList);
      }
      return container;
    }
    return item;
  }

  function openChannelDialog(parentId) {
    channelDialog.classList.remove('hidden');
    channelNameInput.value = '';
    channelNameInput.focus();
    if (parentId !== undefined) channelCategorySelect.value = String(parentId);
  }

  // ── Rendering: Member List (right panel) ─────────────────
  function renderMembers() {
    memberListContent.innerHTML = '';

    const webUsers = Array.from(webClients.values()).sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    const mumbleUsers = Array.from(users.values())
      .filter(u => u.name && u.name !== 'MumbleBridge')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Voice users
    const voiceMembers = webUsers.filter(wc => wc.inVoice);
    if (voiceMembers.length > 0) {
      addMemberCategory(`In Voice — ${voiceMembers.length}`);
      voiceMembers.forEach(wc => {
        addMemberItem(wc.username, true, false, '🎤 Connected');
      });
    }

    // Online
    const onlineNotVoice = webUsers.filter(wc => !wc.inVoice);
    addMemberCategory(`Online — ${webUsers.length}`);
    onlineNotVoice.forEach(wc => addMemberItem(wc.username, true, false, 'Online'));

    // Mumble native
    if (mumbleUsers.length > 0) {
      addMemberCategory(`Mumble — ${mumbleUsers.length}`);
      mumbleUsers.forEach(u => {
        const ch = channels.get(u.channelId);
        addMemberItem(u.name, true, false, ch ? ch.name : '');
      });
    }
  }

  function addMemberCategory(text) {
    const div = document.createElement('div');
    div.className = 'member-category';
    div.textContent = text;
    memberListContent.appendChild(div);
  }

  function addMemberItem(name, online, speaking, status) {
    const div = document.createElement('div');
    div.className = 'member-item' + (online ? ' online' : '') + (speaking ? ' speaking' : '');
    div.innerHTML = `
      <img class="avatar avatar-sm" src="${getAvatarUrl(name)}" alt="">
      <div class="member-item-info">
        <div class="member-item-name">${escapeHtml(name)}</div>
        ${status ? `<div class="member-item-status">${escapeHtml(status)}</div>` : ''}
      </div>
    `;
    memberListContent.appendChild(div);
  }

  // ── Join Channel ─────────────────────────────────────────
  let currentVoiceChannelId = null;

  function joinChannel(chId) {
    currentChannelId = chId;
    lastMessageAuthor = null;
    lastMessageTime = 0;

    if (chId === ACTIVITY_CHANNEL_ID) {
      updateChannelHeader();
      renderChannels();
      messagesEl.innerHTML = '';
      seenMessageIds.clear();
      activityMessages.forEach(am => addSystemMessage(am.text, am.timestamp));
      scrollToBottom();
      stopPolling();
      messageInput.disabled = true;
      sendBtn.disabled = true;
      sidebar.classList.remove('open');
      return;
    }

    messageInput.disabled = false;
    sendBtn.disabled = false;
    send({ type: 'join_channel', channelId: chId });
    updateChannelHeader();
    renderChannels();
    messagesEl.innerHTML = '';
    seenMessageIds.clear();
    send({ type: 'get_history', channelId: chId, limit: 50 });
    startPolling();
    sidebar.classList.remove('open');
  }

  function joinVoiceChannel(chId) {
    if (voiceActive && currentVoiceChannelId === chId) {
      // Already in this voice channel — disconnect
      stopVoice();
      return;
    }
    currentVoiceChannelId = chId;
    if (voiceActive) {
      // Move to different voice channel
      send({ type: 'voice_join_channel', channelId: chId });
      addActivityMessage(`🔊 Moved to ${channels.get(chId)?.name || 'voice channel'}`);
      renderChannels();
    } else {
      // Start voice in this channel
      startVoice(chId);
    }
  }

  // ── Chat Messages (Discord-style grouping) ───────────────
  function dedupKey(name, text) {
    return (name || '').toLowerCase() + '|' + stripHtml(text || '').toLowerCase().trim();
  }

  function addChatMessage(msg, isHistory) {
    const key = msg.id ? String(msg.id) : dedupKey(msg.username, msg.text);

    if (msg.source === 'self') {
      // Self-sent messages always display — the user explicitly typed them.
      // Register the text fingerprint so history polling won't re-add the same message.
      seenMessageIds.add(key);
    } else {
      if (seenMessageIds.has(key)) return;
      seenMessageIds.add(key);
    }

    const author = msg.username || 'Unknown';
    const time = msg.timestamp || new Date().toISOString();
    const timeMs = new Date(time).getTime();
    const cleanText = stripHtml(msg.text || '');

    // Group: same author within 7 minutes = compact message
    const showHeader = (author !== lastMessageAuthor || (timeMs - lastMessageTime) > 7 * 60 * 1000);

    const div = document.createElement('div');
    div.className = 'message' + (showHeader ? ' has-header' : '');

    if (showHeader) {
      div.innerHTML = `
        <div class="message-avatar"><img class="avatar avatar-md" src="${getAvatarUrl(author)}" alt=""></div>
        <div class="message-body">
          <div class="message-header">
            <span class="message-author">${escapeHtml(author)}</span>
            <span class="message-timestamp">${formatTime(time)}</span>
          </div>
          <div class="message-text">${escapeHtml(cleanText)}</div>
        </div>
      `;
    } else {
      div.innerHTML = `
        <div class="message-avatar"></div>
        <div class="message-body">
          <div class="message-text">${escapeHtml(cleanText)}</div>
        </div>
      `;
    }

    messagesEl.appendChild(div);
    lastMessageAuthor = author;
    lastMessageTime = timeMs;

    if (!isHistory) {
      const threshold = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
      if (threshold < 150) scrollToBottom();
    }
  }

  function addSystemMessage(text, timestamp) {
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.innerHTML = `<div class="message-body"><div class="message-text">${escapeHtml(text)}</div></div>`;
    messagesEl.appendChild(div);

    // Reset grouping
    lastMessageAuthor = null;
    lastMessageTime = 0;

    const threshold = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
    if (threshold < 150) scrollToBottom();
  }

  function addActivityMessage(text) {
    const timestamp = new Date().toISOString();
    activityMessages.push({ text, timestamp });
    while (activityMessages.length > 100) activityMessages.shift();
    if (currentChannelId === ACTIVITY_CHANNEL_ID) {
      addSystemMessage(text, timestamp);
    }
  }

  // ── Send Message ─────────────────────────────────────────
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    if (text.startsWith('!')) {
      const parts = text.slice(1).split(/\s+/);
      send({ type: 'command', command: parts[0], args: parts.slice(1) });
    }

    addChatMessage({ username, text, timestamp: new Date().toISOString(), source: 'self' });
    send({ type: 'text', text, channelId: currentChannelId });
    messageInput.value = '';
    messageInput.focus();
  }

  // ── Avatar upload ────────────────────────────────────────
  async function loadMyAvatar() {
    try {
      const res = await fetch(`/api/avatar/${encodeURIComponent(username)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.avatarUrl) {
          avatarCache[username] = data.avatarUrl + '?t=' + Date.now();
          myAvatar.src = avatarCache[username];
          profileAvatar.src = avatarCache[username];
        }
      }
    } catch (e) { console.log('[Avatar] Could not load avatar:', e); }
  }

  async function uploadAvatar(file) {
    if (file.size > 2 * 1024 * 1024) {
      alert('File too large. Max 2MB.');
      return;
    }
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('username', username);
    formData.append('userId', userId);
    try {
      const res = await fetch('/api/avatar/upload', { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json();
        if (data.avatarUrl) {
          avatarCache[username] = data.avatarUrl + '?t=' + Date.now();
          myAvatar.src = avatarCache[username];
          profileAvatar.src = avatarCache[username];
          renderMembers();
          renderChannels();
          // Broadcast to other users via WebSocket
          send({ type: 'avatar_changed', avatarUrl: data.avatarUrl });
        }
      } else {
        alert('Upload failed: ' + (await res.text()));
      }
    } catch (e) { alert('Upload error: ' + e.message); }
  }

  async function removeAvatar() {
    try {
      const res = await fetch('/api/avatar/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, userId }),
      });
      if (res.ok) {
        avatarCache[username] = DEFAULT_AVATAR;
        myAvatar.src = DEFAULT_AVATAR;
        profileAvatar.src = DEFAULT_AVATAR;
        renderMembers();
        renderChannels();
        // Broadcast removal to other users
        send({ type: 'avatar_changed', avatarUrl: DEFAULT_AVATAR });
      }
    } catch (e) { console.error('[Avatar] Remove error:', e); }
  }

  // ── Settings Modal ───────────────────────────────────────
  function openSettings(tab) {
    settingsModal.classList.remove('hidden');
    switchSettingsTab(tab || 'profile');
    populateAudioDevices();
    syncVoiceSettingsUI();
  }

  function closeSettings() {
    settingsModal.classList.add('hidden');
    stopVoiceTest();
  }

  function switchSettingsTab(tabName) {
    document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tabName));
    document.querySelectorAll('.settings-tab').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tabName));
  }

  async function populateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      voiceInputDevice.innerHTML = '<option value="default">Default</option>';
      voiceOutputDevice.innerHTML = '<option value="default">Default</option>';
      devices.forEach(d => {
        if (d.kind === 'audioinput') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microphone ${voiceInputDevice.options.length}`;
          if (d.deviceId === voiceSettings.inputDeviceId) opt.selected = true;
          voiceInputDevice.appendChild(opt);
        } else if (d.kind === 'audiooutput') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Speaker ${voiceOutputDevice.options.length}`;
          if (d.deviceId === voiceSettings.outputDeviceId) opt.selected = true;
          voiceOutputDevice.appendChild(opt);
        }
      });
    } catch (e) { console.error('[Settings] Could not enumerate devices:', e); }
  }

  function syncVoiceSettingsUI() {
    voiceInputVolume.value = voiceSettings.inputVolume;
    voiceInputVolumeVal.textContent = voiceSettings.inputVolume + '%';
    voiceOutputVolume.value = voiceSettings.outputVolume;
    voiceOutputVolumeVal.textContent = voiceSettings.outputVolume + '%';
    voiceVadThreshold.value = voiceSettings.vadThreshold;
    voiceVadThresholdVal.textContent = voiceSettings.vadThreshold;
    voiceEchoCancel.checked = voiceSettings.echoCancellation;
    voiceNoiseSuppress.checked = voiceSettings.noiseSuppression;
    voiceAutoGain.checked = voiceSettings.autoGainControl;
  }

  // Voice test microphone
  let testStream = null;
  let testContext = null;
  let testAnalyser = null;
  let testRaf = null;

  function startVoiceTest() {
    stopVoiceTest();
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: voiceSettings.inputDeviceId !== 'default' ? { exact: voiceSettings.inputDeviceId } : undefined }
    }).then(stream => {
      testStream = stream;
      testContext = new AudioContext();
      testAnalyser = testContext.createAnalyser();
      testAnalyser.fftSize = 256;
      const src = testContext.createMediaStreamSource(stream);
      src.connect(testAnalyser);
      const data = new Uint8Array(testAnalyser.frequencyBinCount);
      const meterFill = voiceTestMeter.querySelector('.voice-meter-fill');
      function tick() {
        testAnalyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        meterFill.style.width = Math.min(100, avg / 128 * 100) + '%';
        testRaf = requestAnimationFrame(tick);
      }
      tick();
      voiceTestBtn.textContent = 'Stop Test';
    }).catch(e => console.error('[VoiceTest]', e));
  }

  function stopVoiceTest() {
    if (testRaf) { cancelAnimationFrame(testRaf); testRaf = null; }
    if (testStream) { testStream.getTracks().forEach(t => t.stop()); testStream = null; }
    if (testContext) { testContext.close().catch(() => {}); testContext = null; }
    const meterFill = voiceTestMeter.querySelector('.voice-meter-fill');
    if (meterFill) meterFill.style.width = '0%';
    voiceTestBtn.textContent = 'Test Microphone';
  }

  // ── Event Listeners ──────────────────────────────────────
  // Login
  loginBtn.addEventListener('click', () => {
    hideError();
    const name = usernameInput.value.trim();
    if (!name) { showError('Please enter a username'); return; }
    if (name.length < 2) { showError('Username must be at least 2 characters'); return; }
    username = name;
    reconnectAttempts = 0;
    connect();
  });
  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginBtn.click(); });

  // Chat
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Sidebar toggle (mobile)
  toggleSidebar.addEventListener('click', () => sidebar.classList.toggle('open'));

  // Member list toggle
  membersToggle.addEventListener('click', () => {
    memberListVisible = !memberListVisible;
    memberList.classList.toggle('hidden-panel', !memberListVisible);
    membersToggle.classList.toggle('active', memberListVisible);
  });

  // Channel dialog
  channelCancelBtn.addEventListener('click', () => channelDialog.classList.add('hidden'));
  channelSaveBtn.addEventListener('click', () => {
    const name = channelNameInput.value.trim();
    if (name) {
      const parentId = parseInt(channelCategorySelect.value) || 0;
      send({ type: 'create_channel', name, parentId });
      channelDialog.classList.add('hidden');
    }
  });
  channelNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') channelSaveBtn.click();
    if (e.key === 'Escape') channelCancelBtn.click();
  });

  // Settings modal
  settingsBtn.addEventListener('click', () => openSettings('profile'));
  settingsClose.addEventListener('click', closeSettings);
  settingsLogout.addEventListener('click', () => { closeSettings(); disconnect(); });
  document.querySelector('.modal-backdrop')?.addEventListener('click', closeSettings);
  document.querySelectorAll('.settings-nav-item[data-tab]').forEach(el => {
    el.addEventListener('click', () => switchSettingsTab(el.dataset.tab));
  });

  // Avatar upload
  avatarUpload.addEventListener('change', (e) => {
    if (e.target.files[0]) uploadAvatar(e.target.files[0]);
  });
  avatarRemove.addEventListener('click', removeAvatar);

  // Voice settings handlers
  voiceInputDevice.addEventListener('change', () => { voiceSettings.inputDeviceId = voiceInputDevice.value; saveVoiceSettings(); });
  voiceOutputDevice.addEventListener('change', () => { voiceSettings.outputDeviceId = voiceOutputDevice.value; saveVoiceSettings(); });
  voiceInputVolume.addEventListener('input', () => {
    voiceSettings.inputVolume = parseInt(voiceInputVolume.value);
    voiceInputVolumeVal.textContent = voiceSettings.inputVolume + '%';
    saveVoiceSettings();
  });
  voiceOutputVolume.addEventListener('input', () => {
    voiceSettings.outputVolume = parseInt(voiceOutputVolume.value);
    voiceOutputVolumeVal.textContent = voiceSettings.outputVolume + '%';
    saveVoiceSettings();
    if (gainNode) gainNode.gain.value = voiceSettings.outputVolume / 100;
  });
  voiceVadThreshold.addEventListener('input', () => {
    voiceSettings.vadThreshold = parseInt(voiceVadThreshold.value);
    voiceVadThresholdVal.textContent = voiceSettings.vadThreshold;
    saveVoiceSettings();
  });
  voiceEchoCancel.addEventListener('change', () => { voiceSettings.echoCancellation = voiceEchoCancel.checked; saveVoiceSettings(); });
  voiceNoiseSuppress.addEventListener('change', () => { voiceSettings.noiseSuppression = voiceNoiseSuppress.checked; saveVoiceSettings(); });
  voiceAutoGain.addEventListener('change', () => { voiceSettings.autoGainControl = voiceAutoGain.checked; saveVoiceSettings(); });
  voiceTestBtn.addEventListener('click', () => { testStream ? stopVoiceTest() : startVoiceTest(); });

  // Appearance
  appearanceFontSize.addEventListener('change', () => {
    const sizes = { small: '13px', normal: '15px', large: '18px' };
    document.documentElement.style.fontSize = sizes[appearanceFontSize.value] || '15px';
    localStorage.setItem('fontSize', appearanceFontSize.value);
  });
  appearanceCompact.addEventListener('change', () => {
    document.body.classList.toggle('compact-mode', appearanceCompact.checked);
    localStorage.setItem('compactMode', appearanceCompact.checked);
  });

  // Load appearance prefs
  const savedFontSize = localStorage.getItem('fontSize');
  if (savedFontSize) {
    appearanceFontSize.value = savedFontSize;
    const sizes = { small: '13px', normal: '15px', large: '18px' };
    document.documentElement.style.fontSize = sizes[savedFontSize] || '15px';
  }
  const savedCompact = localStorage.getItem('compactMode');
  if (savedCompact === 'true') {
    appearanceCompact.checked = true;
    document.body.classList.add('compact-mode');
  }

  // Close sidebar on outside click (mobile)
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== toggleSidebar) {
      sidebar.classList.remove('open');
    }
  });

  // URL param login
  const urlParams = new URLSearchParams(window.location.search);
  const urlUsername = urlParams.get('username');
  if (urlUsername && urlUsername.trim().length >= 2) usernameInput.value = urlUsername.trim();
  usernameInput.focus();

  // ── Voice Chat ───────────────────────────────────────────
  let audioContext = null;
  let voiceWorklet = null;
  let micStream = null;
  let voiceActive = false;
  let isMuted = false;
  let isDeafened = false;
  let gainNode = null;

  async function startVoice(voiceChannelId) {
    if (voiceActive) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addActivityMessage('🎤 Your browser does not support voice chat.');
      return;
    }

    try {
      addActivityMessage('🎤 Requesting microphone access...');

      const constraints = {
        audio: {
          echoCancellation: voiceSettings.echoCancellation,
          noiseSuppression: voiceSettings.noiseSuppression,
          autoGainControl: voiceSettings.autoGainControl,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      };
      if (voiceSettings.inputDeviceId && voiceSettings.inputDeviceId !== 'default') {
        constraints.audio.deviceId = { exact: voiceSettings.inputDeviceId };
      }

      micStream = await navigator.mediaDevices.getUserMedia(constraints);
      addActivityMessage('🎤 Connecting to voice...');

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      await audioContext.audioWorklet.addModule('/js/voice-processor.js');

      voiceWorklet = new AudioWorkletNode(audioContext, 'voice-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: {},
      });

      // Mic → worklet
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(voiceWorklet);

      // Worklet → gain → speakers
      gainNode = audioContext.createGain();
      gainNode.gain.value = voiceSettings.outputVolume / 100;
      voiceWorklet.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Handle captured audio — zero-alloc ring buffer accumulation
      const FRAME_SIZE = 960;               // 20ms @ 48kHz
      const SEND_RING_SIZE = FRAME_SIZE * 6; // 6 frames of headroom
      const sendRing = new Int16Array(SEND_RING_SIZE);
      const sendFrame = new Int16Array(FRAME_SIZE);
      let sendWPos = 0;
      let sendRPos = 0;
      let sendBuffered = 0;

      // VAD with hold timer — keep transmitting for a short time after speech
      // stops to avoid clipping word endings (consonants are quiet).
      // holdFrames counts down from VAD_HOLD_FRAMES each time we detect speech,
      // and we keep sending until it reaches 0.
      const VAD_HOLD_FRAMES = 15; // 15 × 20ms = 300ms tail after speech drops
      let vadHoldCounter = 0;

      voiceWorklet.port.onmessage = (e) => {
        if (e.data.type === 'capture' && ws && ws.readyState === WebSocket.OPEN) {
          const incoming = e.data.samples;

          // Read settings dynamically so slider changes take effect immediately
          const inputVolumeScale = voiceSettings.inputVolume / 100;
          const vadThreshold = voiceSettings.vadThreshold;

          // Apply input volume
          if (inputVolumeScale !== 1) {
            for (let i = 0; i < incoming.length; i++) {
              incoming[i] = Math.max(-32768, Math.min(32767, Math.round(incoming[i] * inputVolumeScale)));
            }
          }

          // Write to ring buffer (avoids array concatenation / GC pressure)
          for (let i = 0; i < incoming.length; i++) {
            sendRing[sendWPos] = incoming[i];
            sendWPos = (sendWPos + 1) % SEND_RING_SIZE;
          }
          sendBuffered += incoming.length;

          // Extract complete 20ms frames
          while (sendBuffered >= FRAME_SIZE) {
            for (let i = 0; i < FRAME_SIZE; i++) {
              sendFrame[i] = sendRing[sendRPos];
              sendRPos = (sendRPos + 1) % SEND_RING_SIZE;
            }
            sendBuffered -= FRAME_SIZE;

            // VAD with hold — skip truly silent frames but keep tail after speech
            let sumSq = 0;
            for (let i = 0; i < FRAME_SIZE; i++) sumSq += sendFrame[i] * sendFrame[i];
            const rms = Math.sqrt(sumSq / FRAME_SIZE);
            if (rms >= vadThreshold) {
              vadHoldCounter = VAD_HOLD_FRAMES; // Reset hold timer on speech
            } else if (vadHoldCounter > 0) {
              vadHoldCounter--; // Still in hold period — send this frame
            } else {
              continue; // Truly silent — skip
            }

            // Copy frame buffer for async WebSocket send
            ws.send(sendFrame.buffer.slice(0));
          }
        }
      };

      send({ type: 'voice_start', voiceChannelId: voiceChannelId || currentVoiceChannelId });
      voiceActive = true;
      stopPolling(); // Pause message polling while in voice to reduce event loop contention

      // Show voice status in sidebar
      showVoiceStatus(true);
      addActivityMessage('🎤 Voice connected!' + (voiceChannelId ? ` (${channels.get(voiceChannelId)?.name || 'Voice'})` : ''));

    } catch (err) {
      console.error('[Voice] Error:', err);
      let errorMsg = err.message || 'Unknown error';
      if (err.name === 'NotAllowedError') errorMsg = 'Microphone permission denied.';
      else if (err.name === 'NotFoundError') errorMsg = 'No microphone found.';
      else if (err.name === 'NotReadableError') errorMsg = 'Microphone is in use.';
      addActivityMessage('🎤 Voice error: ' + errorMsg);
      stopVoice();
    }
  }

  function handleAudioFromServer(data) {
    if (!voiceWorklet || isDeafened) return;
    const int16 = new Int16Array(data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    voiceWorklet.port.postMessage({ type: 'playback', samples: float32 }, [float32.buffer]);
  }

  function stopVoice() {
    voiceActive = false;
    currentVoiceChannelId = null;
    startPolling(); // Resume message polling now that voice is off
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (voiceWorklet) { voiceWorklet.disconnect(); voiceWorklet = null; }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    isMuted = false;
    isDeafened = false;
    updateMuteDeafenUI();
    showVoiceStatus(false);
    send({ type: 'voice_stop' });
    addActivityMessage('Voice disconnected');
    renderChannels();
  }

  function showVoiceStatus(connected) {
    // Insert/remove voice status bar above user panel
    const existing = document.querySelector('.voice-status');
    if (existing) existing.remove();

    if (connected) {
      const chName = currentVoiceChannelId ? (channels.get(currentVoiceChannelId)?.name || 'Voice') : 'Voice';
      const vs = document.createElement('div');
      vs.className = 'voice-status';
      vs.innerHTML = `
        <div class="voice-status-header">
          <span class="voice-status-text">Voice Connected</span>
          <button class="voice-disconnect-btn" title="Disconnect">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/></svg>
          </button>
        </div>
        <span class="voice-status-channel">${escapeHtml(chName)}</span>
      `;
      vs.querySelector('.voice-disconnect-btn').addEventListener('click', stopVoice);
      const userPanel = document.querySelector('.user-panel');
      userPanel.parentNode.insertBefore(vs, userPanel);
    }

    headerVoiceBtn.title = connected ? 'Disconnect voice' : 'Join voice chat';
  }

  function updateMuteDeafenUI() {
    // Mute button
    muteBtn.classList.toggle('active-red', isMuted);
    muteBtn.title = isMuted ? 'Unmute' : 'Mute';
    if (isMuted) {
      muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
        <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`;
    } else {
      muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
      </svg>`;
    }
    // Deafen button
    deafenBtn.classList.toggle('active-red', isDeafened);
    deafenBtn.title = isDeafened ? 'Undeafen' : 'Deafen';
    if (isDeafened) {
      deafenBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 1a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9z"/>
        <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`;
    } else {
      deafenBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 1a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9z"/>
      </svg>`;
    }
  }

  function toggleMute() {
    if (!voiceActive) return;
    isMuted = !isMuted;
    if (micStream) micStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    if (voiceWorklet) voiceWorklet.port.postMessage({ type: 'mute', muted: isMuted });
    updateMuteDeafenUI();
    addActivityMessage(isMuted ? '🔇 Microphone muted' : '🎤 Microphone unmuted');
  }

  function toggleDeafen() {
    if (!voiceActive) return;
    isDeafened = !isDeafened;
    if (isDeafened && !isMuted) toggleMute();
    if (!isDeafened && isMuted) toggleMute();
    updateMuteDeafenUI();
    addActivityMessage(isDeafened ? '🔇 Deafened' : '🔊 Undeafened');
  }

  // Voice button handlers
  headerVoiceBtn.addEventListener('click', () => {
    if (voiceActive) {
      stopVoice();
    } else {
      // Find the first voice channel and join it
      const voiceCh = Array.from(channels.values()).find(ch =>
        ch.name && (ch.name.toLowerCase().includes('voice') || ch.name.toLowerCase().includes('afk'))
      );
      if (voiceCh) {
        joinVoiceChannel(voiceCh.id);
      } else {
        addActivityMessage('No voice channels available');
      }
    }
  });
  muteBtn.addEventListener('click', toggleMute);
  deafenBtn.addEventListener('click', toggleDeafen);

})();
