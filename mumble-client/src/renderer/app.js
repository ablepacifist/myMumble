/**
 * MumbleChat — Renderer application logic.
 *
 * Communicates with the main process via window.mumble (exposed by preload.js).
 * Handles the Discord-like UI, voice capture/playback via AudioWorklet.
 */
(function () {
  'use strict';

  // ── State ──
  let username = '';
  let userId = null;
  let isAdmin = false;
  let mySession = null;
  let currentChannelId = 0;
  const channels = new Map();
  const users = new Map();
  const seenMessageIds = new Set();
  let collapsedCategories = new Set();
  let memberListVisible = true;
  let lastMessageAuthor = null;
  let lastMessageTime = 0;

  const DEFAULT_AVATAR = 'assets/default.jpg';

  // Voice settings
  let voiceSettings = loadVoiceSettings();

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const loginScreen = $('#login-screen');
  const chatScreen = $('#chat-screen');
  const serverInput = $('#server-input');
  const portInput = $('#port-input');
  const usernameInput = $('#username-input');
  const loginBtn = $('#login-btn');
  const loginError = $('#login-error');
  const channelTree = $('#channel-tree');
  const myUsername = $('#my-username');
  const channelHeader = $('#current-channel-name');
  const channelHash = $('.channel-hash');
  const messagesEl = $('#messages');
  const msgContainer = $('#messages-container');
  const messageInput = $('#message-input');
  const sendBtn = $('#send-btn');
  const statusDot = $('#connection-status');
  const channelDialog = $('#channel-dialog');
  const channelNameInput = $('#channel-name-input');
  const channelCategorySelect = $('#channel-category-select');
  const channelSaveBtn = $('#channel-save-btn');
  const channelCancelBtn = $('#channel-cancel-btn');
  const membersToggle = $('#members-toggle');
  const memberList = $('#member-list');
  const memberListContent = $('#member-list-content');
  const settingsBtn = $('#settings-btn');
  const settingsModal = $('#settings-modal');
  const settingsClose = $('#settings-close');
  const settingsLogout = $('#settings-logout');
  const muteBtn = $('#mute-btn');
  const deafenBtn = $('#deafen-btn');
  const headerVoiceBtn = $('#header-voice-btn');
  const voiceInputDevice = $('#voice-input-device');
  const voiceOutputDevice = $('#voice-output-device');
  const voiceInputVolume = $('#voice-input-volume');
  const voiceOutputVolume = $('#voice-output-volume');
  const voiceVadThreshold = $('#voice-vad-threshold');
  const voiceEchoCancel = $('#voice-echo-cancel');
  const voiceNoiseSuppress = $('#voice-noise-suppress');
  const voiceAutoGain = $('#voice-auto-gain');
  const voiceInputVolumeVal = $('#voice-input-volume-val');
  const voiceOutputVolumeVal = $('#voice-output-volume-val');
  const voiceVadThresholdVal = $('#voice-vad-threshold-val');
  const voiceTestBtn = $('#voice-test-btn');
  const voiceTestMeter = $('#voice-test-meter');
  const appearanceFontSize = $('#appearance-font-size');
  const appearanceCompact = $('#appearance-compact');

  // ── Helpers ──
  function setStatus(state) {
    statusDot.className = 'status-dot ' + state;
    statusDot.title = state.charAt(0).toUpperCase() + state.slice(1);
  }

  function showError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  }

  function hideError() { loginError.classList.add('hidden'); }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function stripHtml(str) {
    return str.replace(/<[^>]+>/g, '').trim();
  }

  function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today at ' + time;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday at ' + time;
    return d.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' ' + time;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { msgContainer.scrollTop = msgContainer.scrollHeight; });
  }

  // ── Voice Settings ──
  function loadVoiceSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('voiceSettings'));
      return Object.assign({
        inputDeviceId: 'default', outputDeviceId: 'default',
        inputVolume: 100, outputVolume: 100, vadThreshold: 200,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      }, s || {});
    } catch (_) {
      return { inputDeviceId: 'default', outputDeviceId: 'default', inputVolume: 100, outputVolume: 100, vadThreshold: 200, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    }
  }

  function saveVoiceSettings() {
    localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
  }

  // ── Screen switching ──
  function switchToChat() {
    loginScreen.classList.remove('active');
    chatScreen.classList.add('active');
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
    myUsername.textContent = username;
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
    lastMessageAuthor = null;
    lastMessageTime = 0;
    seenMessageIds.clear();
  }

  // ── Connection ──
  async function connect() {
    hideError();
    const host = serverInput.value.trim() || '127.0.0.1';
    const port = parseInt(portInput.value) || 64738;
    const name = usernameInput.value.trim();

    if (!name || name.length < 2) {
      showError('Username must be at least 2 characters');
      return;
    }

    username = name;
    setStatus('connecting');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Connecting...';

    try {
      const result = await window.mumble.connect({ host, port, username: name });
      if (!result.success) {
        showError(result.error || 'Connection failed');
        setStatus('disconnected');
        loginBtn.disabled = false;
        loginBtn.textContent = 'Connect';
        return;
      }
      mySession = result.session;
    } catch (err) {
      showError(err.message || 'Connection failed');
      setStatus('disconnected');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Connect';
    }
  }

  function disconnect() {
    stopVoice();
    window.mumble.disconnect();
    username = '';
    userId = null;
    mySession = null;
    switchToLogin();
    setStatus('disconnected');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Connect';
  }

  // ── IPC Event Handlers ──
  window.mumble.on('mumble:ready', (data) => {
    setStatus('connected');
    mySession = data.session;
    userId = data.userId;
    username = data.username || username;
    isAdmin = !!data.isAdmin;
    myUsername.textContent = username;
    switchToChat();
    addSystemMessage('Connected to Mumble server');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Connect';

    // Load history for default channel
    loadHistory(currentChannelId);
  });

  window.mumble.on('mumble:channel-state', (ch) => {
    channels.set(ch.id, { ...channels.get(ch.id), ...ch });
    renderChannels();
    renderMembers();

    // Select first non-root channel if we haven't selected one
    if (currentChannelId === 0 && ch.id > 0) {
      currentChannelId = ch.id;
      updateChannelHeader();
      renderChannels();
      loadHistory(currentChannelId);
    }
  });

  window.mumble.on('mumble:channel-remove', (id) => {
    channels.delete(id);
    renderChannels();
  });

  window.mumble.on('mumble:user-state', (user) => {
    users.set(user.session, { ...users.get(user.session), ...user });
    renderMembers();
    renderChannels();
  });

  window.mumble.on('mumble:user-remove', (data) => {
    const user = users.get(data.session);
    users.delete(data.session);
    renderMembers();
    renderChannels();
    if (data.name) addSystemMessage(`${data.name} left`);
  });

  window.mumble.on('mumble:text-message', (msg) => {
    // Parse the Mumble HTML format: <b>Username:</b> message
    let senderName = msg.senderName || 'Unknown';
    let text = msg.message || '';

    // Strip <b>Username:</b> prefix if present
    const match = text.match(/^<b>([^<]+):<\/b>\s*(.*)/s);
    if (match) {
      senderName = match[1];
      text = match[2];
    }

    // Don't show our own messages (we already added them locally)
    if (msg.actor === mySession) return;

    addChatMessage({
      username: senderName,
      text: stripHtml(text),
      timestamp: new Date().toISOString(),
    });
  });

  window.mumble.on('mumble:audio-data', (data) => {
    handleAudioFromServer(data);
  });

  window.mumble.on('mumble:error', (err) => {
    console.error('[Mumble] Error:', err);
    addSystemMessage('Error: ' + err);
  });

  window.mumble.on('mumble:disconnected', () => {
    setStatus('disconnected');
    addSystemMessage('Disconnected from server');
    stopVoice();
  });

  // ── Channel Header ──
  function updateChannelHeader() {
    const ch = channels.get(currentChannelId);
    const name = ch ? ch.name : 'general';
    channelHeader.textContent = name;
    channelHash.textContent = '#';
    messageInput.placeholder = `Message #${name}`;
  }

  // ── Channel Tree ──
  function renderChannels() {
    channelTree.innerHTML = '';

    const allChannels = Array.from(channels.values());
    const rootChannels = [];
    const categoryChildren = new Map();

    allChannels.forEach((ch) => {
      if (ch.id === 0) return; // Skip Root
      const pid = ch.parentId || 0;
      if (pid === 0) {
        rootChannels.push(ch);
      } else {
        if (!categoryChildren.has(pid)) categoryChildren.set(pid, []);
        categoryChildren.get(pid).push(ch);
      }
    });

    const categories = rootChannels.filter((ch) => categoryChildren.has(ch.id));
    const standaloneChannels = rootChannels.filter((ch) => !categoryChildren.has(ch.id));

    // Standalone channels first
    standaloneChannels.sort((a, b) => a.id - b.id).forEach((ch) => {
      channelTree.appendChild(createChannelItem(ch));
    });

    // Categories
    categories.sort((a, b) => a.id - b.id).forEach((cat) => {
      const isCollapsed = collapsedCategories.has(cat.id);

      const header = document.createElement('div');
      header.className = 'category-header' + (isCollapsed ? ' collapsed' : '');
      header.innerHTML = `
        <svg class="category-arrow" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        <span class="category-label">${escapeHtml(cat.name)}</span>
        ${isAdmin ? '<div class="category-actions"><button class="category-action-btn" title="Create Channel">+</button></div>' : ''}
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

      const childContainer = document.createElement('div');
      childContainer.className = 'category-channels';
      if (!isCollapsed) {
        (categoryChildren.get(cat.id) || []).sort((a, b) => a.id - b.id).forEach((ch) => {
          childContainer.appendChild(createChannelItem(ch));
        });
      }
      channelTree.appendChild(childContainer);
    });

    // Category select for dialog
    channelCategorySelect.innerHTML = '<option value="0">No Category (Root)</option>';
    categories.forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.name;
      channelCategorySelect.appendChild(opt);
    });
  }

  function createChannelItem(ch) {
    const parentCh = channels.get(ch.parentId);
    const isUnderVoiceCategory = parentCh && parentCh.name && parentCh.name.toLowerCase().includes('voice');
    const isVoice = isUnderVoiceCategory || (ch.name && (ch.name.toLowerCase().includes('voice') || ch.name.toLowerCase().includes('walky')));
    const icon = isVoice ? '🔊' : '#';

    const item = document.createElement('div');
    item.className = 'channel-item' + (!isVoice && ch.id === currentChannelId ? ' active' : '') + (isVoice ? ' voice-channel' : '');

    // Check if current user is in this voice channel
    if (isVoice && voiceActive && currentVoiceChannelId === ch.id) {
      item.classList.add('active');
    }

    item.innerHTML = `
      <span class="channel-icon-text">${icon}</span>
      <span class="channel-name">${escapeHtml(ch.name || 'Unnamed')}</span>
      ${isAdmin ? '<div class="channel-actions"><button class="channel-action-btn" title="Delete">&times;</button></div>' : ''}
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.channel-action-btn')) {
        e.stopPropagation();
        if (confirm(`Delete #${ch.name}?`)) {
          window.mumble.removeChannel(ch.id);
        }
        return;
      }
      if (isVoice) {
        joinVoiceChannel(ch.id);
      } else {
        joinChannel(ch.id);
      }
    });

    // Show voice users under voice channels
    if (isVoice) {
      const voiceUsers = Array.from(users.values()).filter((u) => u.channelId === ch.id);
      const container = document.createElement('div');
      container.appendChild(item);
      if (voiceUsers.length > 0) {
        const userList = document.createElement('div');
        userList.className = 'voice-channel-users';
        voiceUsers.forEach((u) => {
          const vu = document.createElement('div');
          vu.className = 'voice-user';
          vu.innerHTML = `<img class="avatar" src="${DEFAULT_AVATAR}" alt="" style="width:24px;height:24px;border-radius:50%"><span>${escapeHtml(u.name || 'Unknown')}</span>`;
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

  // ── Member List ──
  function renderMembers() {
    memberListContent.innerHTML = '';

    const allUsers = Array.from(users.values())
      .filter((u) => u.name && u.name !== 'SuperUser')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (allUsers.length > 0) {
      addMemberCategory(`Online — ${allUsers.length}`);
      allUsers.forEach((u) => {
        const ch = channels.get(u.channelId);
        addMemberItem(u.name, true, ch ? ch.name : '');
      });
    }
  }

  function addMemberCategory(text) {
    const div = document.createElement('div');
    div.className = 'member-category';
    div.textContent = text;
    memberListContent.appendChild(div);
  }

  function addMemberItem(name, online, status) {
    const div = document.createElement('div');
    div.className = 'member-item' + (online ? ' online' : '');
    div.innerHTML = `
      <img class="avatar avatar-sm" src="${DEFAULT_AVATAR}" alt="">
      <div class="member-item-info">
        <div class="member-item-name">${escapeHtml(name)}</div>
        ${status ? `<div class="member-item-status">${escapeHtml(status)}</div>` : ''}
      </div>
    `;
    memberListContent.appendChild(div);
  }

  // ── Join Channel ──
  let currentVoiceChannelId = null;

  function joinChannel(chId) {
    currentChannelId = chId;
    lastMessageAuthor = null;
    lastMessageTime = 0;
    seenMessageIds.clear();
    messagesEl.innerHTML = '';

    messageInput.disabled = false;
    sendBtn.disabled = false;
    updateChannelHeader();
    renderChannels();
    loadHistory(chId);
  }

  function joinVoiceChannel(chId) {
    if (voiceActive && currentVoiceChannelId === chId) {
      stopVoice();
      return;
    }
    currentVoiceChannelId = chId;
    if (voiceActive) {
      // Move to different voice channel
      window.mumble.moveChannel(chId);
      addSystemMessage(`🔊 Moved to ${channels.get(chId)?.name || 'voice channel'}`);
      renderChannels();
    } else {
      startVoice(chId);
    }
  }

  async function loadHistory(channelId) {
    try {
      const messages = await window.mumble.getHistory({ channelId, limit: 50 });
      if (messages && messages.length > 0) {
        addSystemMessage(`— Loaded ${messages.length} previous messages —`);
        messages
          .sort((a, b) => {
            const tA = new Date(a.createdAt || a.sentAt || a.timestamp || 0).getTime();
            const tB = new Date(b.createdAt || b.sentAt || b.timestamp || 0).getTime();
            return tA - tB;
          })
          .forEach((m) => {
            addChatMessage({
              username: m.senderName || m.username || 'Unknown',
              text: m.content || m.text || '',
              timestamp: m.createdAt || m.sentAt || m.timestamp || new Date().toISOString(),
            }, true);
          });
        scrollToBottom();
      }
    } catch (_) {}
  }

  // ── Chat Messages ──
  function dedupKey(name, text) {
    return (name || '').toLowerCase() + '|' + (text || '').toLowerCase().trim();
  }

  function addChatMessage(msg, isHistory) {
    const key = msg.id ? String(msg.id) : dedupKey(msg.username, msg.text);
    if (seenMessageIds.has(key)) return;
    seenMessageIds.add(key);

    const author = msg.username || 'Unknown';
    const time = msg.timestamp || new Date().toISOString();
    const timeMs = new Date(time).getTime();
    const cleanText = stripHtml(msg.text || '');

    const showHeader = author !== lastMessageAuthor || (timeMs - lastMessageTime) > 7 * 60 * 1000;

    const div = document.createElement('div');
    div.className = 'message' + (showHeader ? ' has-header' : '');

    if (showHeader) {
      div.innerHTML = `
        <div class="message-avatar"><img class="avatar avatar-md" src="${DEFAULT_AVATAR}" alt=""></div>
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

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.innerHTML = `<div class="message-body"><div class="message-text">${escapeHtml(text)}</div></div>`;
    messagesEl.appendChild(div);
    lastMessageAuthor = null;
    lastMessageTime = 0;
    const threshold = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
    if (threshold < 150) scrollToBottom();
  }

  // ── Send Message ──
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || currentChannelId === 0) return;

    // Show locally immediately
    addChatMessage({ username, text, timestamp: new Date().toISOString() });

    // Send via IPC → main process → Mumble + Lexicon
    window.mumble.sendText({ channelIds: [currentChannelId], message: text });

    messageInput.value = '';
    messageInput.focus();
  }

  // ── Voice Chat ──
  let audioContext = null;
  let voiceWorklet = null;
  let micStream = null;
  let voiceActive = false;
  let isMuted = false;
  let isDeafened = false;
  let gainNode = null;

  async function startVoice(voiceChannelId) {
    if (voiceActive) return;

    try {
      addSystemMessage('🎤 Requesting microphone access...');

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
      addSystemMessage('🎤 Connecting to voice...');

      audioContext = new AudioContext({ sampleRate: 48000 });
      await audioContext.audioWorklet.addModule('./voice-processor.js');

      voiceWorklet = new AudioWorkletNode(audioContext, 'voice-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });

      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(voiceWorklet);

      gainNode = audioContext.createGain();
      gainNode.gain.value = voiceSettings.outputVolume / 100;
      voiceWorklet.connect(gainNode);
      gainNode.connect(audioContext.destination);

      const vadThreshold = voiceSettings.vadThreshold;
      const inputVolumeScale = voiceSettings.inputVolume / 100;
      const FRAME_SIZE = 960;
      const SEND_RING_SIZE = FRAME_SIZE * 6;
      const sendRing = new Int16Array(SEND_RING_SIZE);
      const sendFrame = new Int16Array(FRAME_SIZE);
      let sendWPos = 0;
      let sendRPos = 0;
      let sendBuffered = 0;

      voiceWorklet.port.onmessage = (e) => {
        if (e.data.type === 'capture') {
          const incoming = e.data.samples;

          if (inputVolumeScale !== 1) {
            for (let i = 0; i < incoming.length; i++) {
              incoming[i] = Math.max(-32768, Math.min(32767, Math.round(incoming[i] * inputVolumeScale)));
            }
          }

          for (let i = 0; i < incoming.length; i++) {
            sendRing[sendWPos] = incoming[i];
            sendWPos = (sendWPos + 1) % SEND_RING_SIZE;
          }
          sendBuffered += incoming.length;

          while (sendBuffered >= FRAME_SIZE) {
            for (let i = 0; i < FRAME_SIZE; i++) {
              sendFrame[i] = sendRing[sendRPos];
              sendRPos = (sendRPos + 1) % SEND_RING_SIZE;
            }
            sendBuffered -= FRAME_SIZE;

            // VAD
            let sumSq = 0;
            for (let i = 0; i < FRAME_SIZE; i++) sumSq += sendFrame[i] * sendFrame[i];
            const rms = Math.sqrt(sumSq / FRAME_SIZE);
            if (rms < vadThreshold) continue;

            // Send PCM to main process for Opus encoding
            window.mumble.sendAudio(sendFrame.buffer.slice(0));
          }
        }
      };

      // Move to voice channel in Mumble
      if (voiceChannelId) {
        window.mumble.moveChannel(voiceChannelId);
      }

      voiceActive = true;
      showVoiceStatus(true);
      addSystemMessage('🎤 Voice connected!' + (voiceChannelId ? ` (${channels.get(voiceChannelId)?.name || 'Voice'})` : ''));
      renderChannels();
    } catch (err) {
      let errorMsg = err.message || 'Unknown error';
      if (err.name === 'NotAllowedError') errorMsg = 'Microphone permission denied.';
      else if (err.name === 'NotFoundError') errorMsg = 'No microphone found.';
      addSystemMessage('🎤 Voice error: ' + errorMsg);
      stopVoice();
    }
  }

  function handleAudioFromServer(data) {
    if (!voiceWorklet || isDeafened) return;
    // data is a Buffer/ArrayBuffer from main process containing Int16LE PCM
    const int16 = new Int16Array(data instanceof ArrayBuffer ? data : data.buffer || data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    voiceWorklet.port.postMessage({ type: 'playback', samples: float32 }, [float32.buffer]);
  }

  function stopVoice() {
    voiceActive = false;
    currentVoiceChannelId = null;
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (voiceWorklet) { voiceWorklet.disconnect(); voiceWorklet = null; }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    isMuted = false;
    isDeafened = false;
    updateMuteDeafenUI();
    showVoiceStatus(false);
    addSystemMessage('Voice disconnected');
    renderChannels();
  }

  function showVoiceStatus(connected) {
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
    if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
    if (voiceWorklet) voiceWorklet.port.postMessage({ type: 'mute', muted: isMuted });
    window.mumble.setSelfMute(isMuted);
    updateMuteDeafenUI();
    addSystemMessage(isMuted ? '🔇 Microphone muted' : '🎤 Microphone unmuted');
  }

  function toggleDeafen() {
    if (!voiceActive) return;
    isDeafened = !isDeafened;
    if (isDeafened && !isMuted) toggleMute();
    if (!isDeafened && isMuted) toggleMute();
    window.mumble.setSelfDeaf(isDeafened);
    updateMuteDeafenUI();
    addSystemMessage(isDeafened ? '🔇 Deafened' : '🔊 Undeafened');
  }

  // ── Settings ──
  function openSettings(tab) {
    settingsModal.classList.remove('hidden');
    switchSettingsTab(tab || 'voice');
    populateAudioDevices();
    syncVoiceSettingsUI();
    loadConnectionSettings();
  }

  function closeSettings() {
    settingsModal.classList.add('hidden');
    stopVoiceTest();
  }

  function switchSettingsTab(tabName) {
    document.querySelectorAll('.settings-nav-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === tabName));
    document.querySelectorAll('.settings-tab').forEach((el) => el.classList.toggle('active', el.id === 'tab-' + tabName));
  }

  async function populateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      voiceInputDevice.innerHTML = '<option value="default">Default</option>';
      voiceOutputDevice.innerHTML = '<option value="default">Default</option>';
      devices.forEach((d) => {
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
    } catch (_) {}
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

  async function loadConnectionSettings() {
    try {
      const config = await window.mumble.getConfig();
      $('#settings-host').value = config.mumbleHost || '';
      $('#settings-port').value = config.mumblePort || '';
      $('#settings-lexicon').value = config.lexiconUrl || '';
    } catch (_) {}
  }

  // Voice test
  let testStream = null;
  let testContext = null;
  let testAnalyser = null;
  let testRaf = null;

  function startVoiceTest() {
    stopVoiceTest();
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: voiceSettings.inputDeviceId !== 'default' ? { exact: voiceSettings.inputDeviceId } : undefined },
    }).then((stream) => {
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
        meterFill.style.width = Math.min(100, (avg / 128) * 100) + '%';
        testRaf = requestAnimationFrame(tick);
      }
      tick();
      voiceTestBtn.textContent = 'Stop Test';
    }).catch((e) => console.error('[VoiceTest]', e));
  }

  function stopVoiceTest() {
    if (testRaf) { cancelAnimationFrame(testRaf); testRaf = null; }
    if (testStream) { testStream.getTracks().forEach((t) => t.stop()); testStream = null; }
    if (testContext) { testContext.close().catch(() => {}); testContext = null; }
    const meterFill = voiceTestMeter.querySelector('.voice-meter-fill');
    if (meterFill) meterFill.style.width = '0%';
    voiceTestBtn.textContent = 'Test Microphone';
  }

  // ── Event Listeners ──
  loginBtn.addEventListener('click', connect);
  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  serverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  membersToggle.addEventListener('click', () => {
    memberListVisible = !memberListVisible;
    memberList.classList.toggle('hidden-panel', !memberListVisible);
    membersToggle.classList.toggle('active', memberListVisible);
  });

  channelCancelBtn.addEventListener('click', () => channelDialog.classList.add('hidden'));
  channelSaveBtn.addEventListener('click', () => {
    const name = channelNameInput.value.trim();
    if (name) {
      const parentId = parseInt(channelCategorySelect.value) || 0;
      window.mumble.createChannel({ parentId, name });
      channelDialog.classList.add('hidden');
    }
  });
  channelNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') channelSaveBtn.click();
    if (e.key === 'Escape') channelCancelBtn.click();
  });

  settingsBtn.addEventListener('click', () => openSettings('voice'));
  settingsClose.addEventListener('click', closeSettings);
  settingsLogout.addEventListener('click', () => { closeSettings(); disconnect(); });
  document.querySelector('.modal-backdrop')?.addEventListener('click', closeSettings);
  document.querySelectorAll('.settings-nav-item[data-tab]').forEach((el) => {
    el.addEventListener('click', () => switchSettingsTab(el.dataset.tab));
  });

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

  appearanceFontSize.addEventListener('change', () => {
    const sizes = { small: '13px', normal: '15px', large: '18px' };
    document.documentElement.style.fontSize = sizes[appearanceFontSize.value] || '15px';
    localStorage.setItem('fontSize', appearanceFontSize.value);
  });
  appearanceCompact.addEventListener('change', () => {
    document.body.classList.toggle('compact-mode', appearanceCompact.checked);
    localStorage.setItem('compactMode', appearanceCompact.checked);
  });

  // Save connection settings
  $('#settings-save-conn')?.addEventListener('click', () => {
    window.mumble.setConfig({
      mumbleHost: $('#settings-host').value,
      mumblePort: parseInt($('#settings-port').value) || 64738,
      lexiconUrl: $('#settings-lexicon').value,
    });
    addSystemMessage('Connection settings saved (reconnect to apply)');
  });

  headerVoiceBtn.addEventListener('click', () => {
    if (voiceActive) {
      stopVoice();
    } else {
      const voiceCh = Array.from(channels.values()).find((ch) =>
        ch.name && (ch.name.toLowerCase().includes('voice') || ch.name.toLowerCase().includes('walky'))
      );
      if (voiceCh) joinVoiceChannel(voiceCh.id);
      else addSystemMessage('No voice channels available');
    }
  });

  muteBtn.addEventListener('click', toggleMute);
  deafenBtn.addEventListener('click', toggleDeafen);

  // Load saved appearance
  const savedFontSize = localStorage.getItem('fontSize');
  if (savedFontSize) {
    appearanceFontSize.value = savedFontSize;
    const sizes = { small: '13px', normal: '15px', large: '18px' };
    document.documentElement.style.fontSize = sizes[savedFontSize] || '15px';
  }
  if (localStorage.getItem('compactMode') === 'true') {
    appearanceCompact.checked = true;
    document.body.classList.add('compact-mode');
  }

  // Load saved connection config into login form
  window.mumble.getConfig().then((config) => {
    if (config.mumbleHost) serverInput.value = config.mumbleHost;
    if (config.mumblePort) portInput.value = config.mumblePort;
  }).catch(() => {});

  usernameInput.focus();
})();
