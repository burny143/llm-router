// agent-tab.js
// Renderer-side controller for the "Agent" tab. Wrapped in an IIFE so its
// top-level names never collide with renderer.js's own top-level `const`/`let`
// declarations — both files are loaded as classic (non-module) <script> tags
// sharing one global scope.
(function () {
  const api = window.api;

  // --- State ---------------------------------------------------------------
  let mode = 'global';
  let projectRoot = null;
  let uploadedFiles = [];   // [{ filename, path, content, binary }]
  let sending = false;
  let currentAssistantBubble = null; // element being appended to for the in-flight turn
  let pendingApprovalId = null;

  // --- NEW: diff preview ---
  let pendingDiffId = null;

  // --- NEW: slash commands ---
  let paletteActiveIndex = 0;

  // --- DOM refs --------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  const modeLight = el('agentModeLight');
  const modeLabel = el('agentModeLabel');
  const selectFolderBtn = el('agentSelectFolderBtn');
  const clearFolderBtn = el('agentClearFolderBtn');
  const modelDropdown = el('agentModelDropdown');
  const modelLockToggle = el('agentModelLockToggle');
  const refreshFilesBtn = el('agentRefreshFilesBtn');
  const fileTreeEl = el('agentFileTree');
  const uploadFileBtn = el('agentUploadFileBtn');
  const uploadChipsEl = el('agentUploadChips');

  const messagesEl = el('agentMessages');
  const inputEl = el('agentInput');
  const sendBtn = el('agentSendBtn');
  const stopBtn = el('agentStopBtn');
  const approvalModal = el('agentApprovalModal');
  const approvalTitle = el('agentApprovalTitle');
  const approvalDetails = el('agentApprovalDetails');
  const approveBtn = el('agentApproveBtn');
  const denyBtn = el('agentDenyBtn');

  // --- NEW: diff preview ---
  const diffModal = el('agentDiffModal');
  const diffTitle = el('agentDiffTitle');
  const diffPathEl = el('agentDiffPath');
  const diffBodyEl = el('agentDiffBody');
  const diffAcceptBtn = el('agentDiffAcceptBtn');
  const diffRejectBtn = el('agentDiffRejectBtn');

  const filePreviewModal = el('agentFilePreviewModal');
  const filePreviewTitle = el('agentFilePreviewTitle');
  const filePreviewBody = el('agentFilePreviewBody');
  const filePreviewCloseBtn = el('agentFilePreviewCloseBtn');

  // --- Agent settings toggles (stream / always-approve writes) ---
  const streamToggle = el('agentStreamToggle');
  const alwaysApproveToggle = el('agentAlwaysApproveToggle');

  // --- NEW: agent-side timeout / token limits ---
  const timeoutMsInput = el('agentTimeoutMs');
  const maxOutputTokensInput = el('agentMaxOutputTokens');
  const maxInputTokensInput = el('agentMaxInputTokens');
  // --- NEW: agent-loop auto-continuation (FINISHED sentinel) ---
  const followupIntervalMsInput = el('agentFollowupIntervalMs');
  const maxFollowupsInput = el('agentMaxFollowups');
  // --- NEW: heartbeat logging ---
  const heartbeatIntervalMsInput = el('agentHeartbeatIntervalMs');
  // --- NEW: overall per-turn wall-clock cap ---
  const runTimeoutMsInput = el('agentRunTimeoutMs');

  // --- NEW: slash commands / undo ---
  const paletteBtn = el('agentPaletteBtn');
  const paletteModal = el('agentPaletteModal');
  const paletteInput = el('agentPaletteInput');
  const paletteList = el('agentPaletteList');
  const undoBtn = el('agentUndoBtn');
  const fileSearchInput = el('agentFileSearchInput');

  // --- NEW: task-progress panel ---
  const taskProgressEl = el('agentTaskProgress');
  const chatTabsEl = el('agentChatTabs');

  // --- NEW: agent-loop auto-continuation status badge ---
  const loopStatusEl = el('agentLoopStatus');
  function setLoopStatus(text, kind) {
    if (!loopStatusEl) return;
    if (!text) {
      loopStatusEl.style.display = 'none';
      loopStatusEl.textContent = '';
      loopStatusEl.className = 'agent-loop-status';
      return;
    }
    loopStatusEl.style.display = 'inline-block';
    loopStatusEl.textContent = text;
    loopStatusEl.className = 'agent-loop-status' + (kind ? ' ' + kind : '');
  }

  // --- Rendering helpers -------------------------------------------------------
  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'agent-msg agent-msg-user';
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollMessagesToBottom();
  }

  function startAssistantBubble() {
    const div = document.createElement('div');
    div.className = 'agent-msg agent-msg-assistant';
    div.textContent = '';
    messagesEl.appendChild(div);
    currentAssistantBubble = div;
    scrollMessagesToBottom();
    return div;
  }

  function appendAssistantText(text) {
    if (!currentAssistantBubble) startAssistantBubble();
    currentAssistantBubble.textContent += (currentAssistantBubble.textContent ? '\n' : '') + text;
    scrollMessagesToBottom();
  }

  // --- NEW: streaming support ---
  // Token-level counterparts to startAssistantBubble/appendAssistantText.
  // Tokens are appended raw (no inserted newline) since they're sub-message
  // fragments, and a blinking cursor node is kept as the bubble's last child
  // while the stream is in flight.
  function startStreamingBubble() {
    const div = startAssistantBubble();
    const cursor = document.createElement('span');
    cursor.className = 'agent-stream-cursor';
    cursor.textContent = '\u258c'; // block cursor glyph, blinking via CSS
    div.appendChild(cursor);
    div._streamCursor = cursor;
    return div;
  }

  function appendStreamToken(token) {
    if (!currentAssistantBubble || !currentAssistantBubble._streamCursor) startStreamingBubble();
    const cursor = currentAssistantBubble._streamCursor;
    const textNode = document.createTextNode(token);
    currentAssistantBubble.insertBefore(textNode, cursor);
    scrollMessagesToBottom();
  }

function endStreamingBubble(fullText) {
  if (currentAssistantBubble && currentAssistantBubble._streamCursor) {
    currentAssistantBubble._streamCursor.remove();
    delete currentAssistantBubble._streamCursor;
  }

  // Safety net: remove any lingering cursor nodes that weren't cleaned up
  // (e.g. if onAgentStreamEnd didn't fire for a previous turn).
  document.querySelectorAll('.agent-stream-cursor').forEach(node => node.remove());

  // fullText is authoritative (covers cases where the backend's final
  // content differs slightly from the concatenated tokens); reconcile.
  if (currentAssistantBubble && typeof fullText === 'string') {
    const cursor = currentAssistantBubble._streamCursor;
    currentAssistantBubble.textContent = fullText;
    // Preserve cursor reference removal if we just cleared the bubble
    if (cursor) cursor.remove();
  }
}

  function addToolCard(id, name, args) {
    const card = document.createElement('div');
    card.className = 'agent-tool-card';
    card.dataset.toolId = id;

    card.innerHTML =
      '<div class="agent-tool-card-header">' +
        '<span class="agent-tool-card-title"><span class="agent-tool-caret">▾</span>🔧 ' + escapeHtml(name || 'tool') + '</span>' +
        '<span class="agent-tool-status">running…</span>' +
      '</div>' +
      '<div class="agent-tool-body">' +
        '<pre class="agent-tool-args">' + escapeHtml(JSON.stringify(args || {}, null, 2)) + '</pre>' +
        '<pre class="agent-tool-result" style="display:none;"></pre>' +
      '</div>';

    card.querySelector('.agent-tool-card-header').addEventListener('click', () => {
      card.classList.toggle('agent-tool-collapsed');
    });

    messagesEl.appendChild(card);

    // A tool result following this closes the current assistant bubble (a
    // new one starts if the model replies again after the tool result).
    currentAssistantBubble = null;
    scrollMessagesToBottom();
  }

  function updateToolCard(id, result) {
    const card = messagesEl.querySelector('.agent-tool-card[data-tool-id="' + id + '"]');
    if (!card) return;

    const status = card.querySelector('.agent-tool-status');
    const resultEl = card.querySelector('.agent-tool-result');
    const ok = result && (result.ok === undefined || result.ok);

    status.textContent = ok ? 'done' : 'failed';
    status.className = 'agent-tool-status ' + (ok ? 'ok' : 'fail');

    resultEl.style.display = 'block';
    resultEl.textContent = typeof result === 'string' ? result : (result.message || JSON.stringify(result));
    scrollMessagesToBottom();
  }

  function addSystemNote(text, isError) {
    const div = document.createElement('div');
    div.className = 'agent-msg ' + (isError ? 'agent-msg-error' : 'agent-msg-system');
    div.textContent = text;
    messagesEl.appendChild(div);
    currentAssistantBubble = null;
    scrollMessagesToBottom();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- FIX: replacement for window.confirm() ----------------------------------
  // window.confirm()/alert() are synchronous, OS-native modal dialogs. In
  // Electron they run outside the normal BrowserWindow message/hit-test loop,
  // and returning focus from them to the renderer is unreliable — after the
  // user clicks OK, mouse input can land on stale hit-test state, leaving
  // native form controls (in particular <select> elements and, on some
  // platforms, text <input>s) unresponsive to clicks until the window loses
  // and regains focus. That's the "textbox and dropdown do nothing after
  // clicking OK" behavior. Building the confirmation as normal in-page DOM
  // (same pattern as approvalModal/diffModal elsewhere in this file) keeps
  // everything inside the regular renderer event loop, so no hit-test state
  // gets stranded. This resolves to a Promise<boolean> so callers can
  // `if (!(await confirmDialog(...))) return;` exactly like window.confirm().
  function confirmDialog(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'agent-confirm-overlay';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,0.45);';

      const box = document.createElement('div');
      box.className = 'agent-confirm-box';
      box.style.cssText =
        'background:var(--agent-modal-bg,#1e1e1e);color:var(--agent-modal-fg,#eee);' +
        'max-width:420px;width:90%;padding:20px;border-radius:8px;' +
        'box-shadow:0 8px 30px rgba(0,0,0,0.5);font-size:14px;line-height:1.4;';

      const msgEl = document.createElement('div');
      msgEl.textContent = message;
      msgEl.style.marginBottom = '16px';
      box.appendChild(msgEl);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.textContent = 'OK';

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function cleanup(result) {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        resolve(result);
      }

      function onKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
        else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
      }

      cancelBtn.addEventListener('click', () => cleanup(false));
      okBtn.addEventListener('click', () => cleanup(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      document.addEventListener('keydown', onKeydown, true);

      okBtn.focus();
    });
  }

  // --- NEW: per-project cached chat sessions ---------------------------------
  // Replays a session's cached OpenAI-format message history into the chat
  // pane: user messages -> user bubbles, assistant text -> assistant bubbles,
  // tool results -> compact system notes (tool_name: ok/failed). Assistant
  // messages that only carry tool_calls (no content) render nothing of their
  // own — the following tool-result note stands in for them, matching how a
  // live turn looks today.
  function renderMessagesFromHistory(messages) {
    messagesEl.innerHTML = '';
    currentAssistantBubble = null;

    const byId = {}; // tool_call_id -> { name }
    (messages || []).forEach((m) => {
      if (Array.isArray(m.tool_calls)) {
        m.tool_calls.forEach((tc) => {
          byId[tc.id] = { name: (tc.function && tc.function.name) || 'tool' };
        });
      }
    });

    (messages || []).forEach((m) => {
      if (m.role === 'user') {
        addUserMessage(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      } else if (m.role === 'assistant') {
        if (m.content) {
          startAssistantBubble();
          appendAssistantText(m.content);
        }
        currentAssistantBubble = null;
      } else if (m.role === 'tool') {
        const info = byId[m.tool_call_id] || {};
        let ok = true;
        try {
          const parsed = JSON.parse(m.content);
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) ok = !!parsed.ok;
        } catch (_) { /* plain string result — assume ok */ }
        addSystemNote(`${info.name || 'tool'}: ${ok ? 'ok' : 'failed'}`);
      }
    });

    if (!messages || messages.length === 0) {
      addSystemNote('(no messages yet in this chat)');
    }
    scrollMessagesToBottom();
  }

  // Renders the tab strip above the message list: "Global" always present,
  // plus one tab per project the agent has ever switched into (cached on the
  // main-process side — nothing is persisted here in the renderer). Each tab
  // also gets a small clear-history icon so cache/history can be reset per
  // tab without switching into it or losing the tab itself.
  async function refreshChatTabs() {
    if (!chatTabsEl || !api.agentGetChatSessions) return;
    let sessions = [];
    try { sessions = await api.agentGetChatSessions(); } catch (_) { sessions = []; }

    chatTabsEl.innerHTML = '';
    const activeKey = mode === 'project' && projectRoot ? projectRoot : 'global';

    sessions.forEach((s) => {
      const wrap = document.createElement('span');
      wrap.className = 'agent-chat-tab-wrap' + (s.key === activeKey ? ' active' : '');

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'agent-chat-tab' + (s.key === activeKey ? ' active' : '');
      tab.textContent = s.label + (s.messageCount ? ` (${s.messageCount})` : '');
      tab.title = s.key === 'global' ? 'Global' : s.key;
      tab.addEventListener('click', async () => {
        if (s.key === activeKey) return;
        try {
          const result = await api.agentSwitchChat(s.key);
          applyMode(result.mode, result.projectRoot);
          renderMessagesFromHistory(result.messages);
          setUndoEnabled(false);
        } catch (err) {
          addSystemNote('Could not switch chat: ' + err.message, true);
        }
      });
      wrap.appendChild(tab);

      if (api.agentClearChat) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'agent-chat-tab-clear';
        clearBtn.title = 'Clear cache/history for ' + s.label;
        clearBtn.textContent = '🗑';
        clearBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); // don't also trigger the tab's own switch handler
          if (!(await confirmDialog(`Clear cached history for "${s.label}"? This can't be undone.`))) return;
          try {
            const result = await api.agentClearChat(s.key);
            if (result && result.isActive) {
              renderMessagesFromHistory([]);
              setUndoEnabled(false);
              addSystemNote('(chat history cleared)');
            }
            refreshChatTabs();
          } catch (err) {
            addSystemNote('Could not clear chat: ' + err.message, true);
          }
        });
        wrap.appendChild(clearBtn);
      }

      chatTabsEl.appendChild(wrap);
    });
  }

  // --- Mode / top bar ----------------------------------------------------------
  function applyMode(newMode, newProjectRoot) {
    mode = newMode;
    projectRoot = newProjectRoot || null;

    modeLight.className = 'agent-status-light ' + mode;

    if (mode === 'project') {
      modeLabel.textContent = (projectRoot || '').split(/[\/\\]/).pop() || projectRoot;
      modeLabel.title = projectRoot;
      clearFolderBtn.style.display = 'inline-block';
      refreshFilesBtn.style.display = 'inline-block';
      refreshProjectFiles();
    } else {
      modeLabel.textContent = 'Global Agent';
      modeLabel.title = '';
      clearFolderBtn.style.display = 'none';
      refreshFilesBtn.style.display = 'none';
      fileTreeEl.innerHTML = '<div class="agent-empty-hint">No project selected — using Global mode. Select a folder to give the agent file/shell access.</div>';
    }

    refreshChatTabs();
  }

  // Extensions shown with a slightly different icon; everything else falls
  // back to a generic file glyph. Purely cosmetic — no behavior depends on it.
  const FILE_ICONS = {
    js: '📄', ts: '📄', jsx: '📄', tsx: '📄', json: '🧾', md: '📝', css: '🎨',
    html: '🌐', py: '🐍', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️'
  };

  function iconForFile(name) {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return FILE_ICONS[ext] || '📄';
  }

  // Builds a nested { __files: [...], subdirs: { name: node } } tree from a
  // flat list of "a/b/c.js"-style relative paths.
  function buildFileTree(paths) {
    const root = { subdirs: {}, files: [] };

    paths.forEach((relPath) => {
      const parts = relPath.split(/[\/\\]/);
      let node = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts[i];
        if (!node.subdirs[dir]) node.subdirs[dir] = { subdirs: {}, files: [] };
        node = node.subdirs[dir];
      }

      node.files.push({ name: parts[parts.length - 1], relPath });
    });

    return root;
  }

  function renderFileTreeNode(node, container, depth) {
    Object.keys(node.subdirs).sort().forEach((dirName) => {
      const dirRow = document.createElement('div');
      dirRow.className = 'agent-dir-row';

      const caret = document.createElement('span');
      caret.className = 'agent-dir-caret';
      caret.textContent = '▾';

      const label = document.createElement('span');
      label.textContent = '📁 ' + dirName;

      dirRow.appendChild(caret);
      dirRow.appendChild(label);

      const childrenEl = document.createElement('div');
      childrenEl.className = 'agent-dir-children';

      renderFileTreeNode(node.subdirs[dirName], childrenEl, depth + 1);

      dirRow.addEventListener('click', () => {
        const collapsed = childrenEl.classList.toggle('agent-dir-children-collapsed');
        caret.classList.toggle('agent-dir-collapsed', collapsed);
      });

      container.appendChild(dirRow);
      container.appendChild(childrenEl);
    });

    node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
      const row = document.createElement('div');
      row.className = 'agent-file-row';
      row.title = f.relPath;

      const icon = document.createElement('span');
      icon.className = 'agent-file-row-icon';
      icon.textContent = iconForFile(f.name);

      const label = document.createElement('span');
      label.textContent = f.name;

      row.appendChild(icon);
      row.appendChild(label);

      row.addEventListener('click', () => openFilePreview(f.relPath));
      container.appendChild(row);
    });
  }

  async function openFilePreview(relPath) {
    filePreviewTitle.textContent = relPath;
    filePreviewBody.textContent = 'Loading…';
    filePreviewModal.style.display = 'flex';

    try {
      const content = await api.readProjectFile(relPath);
      filePreviewBody.textContent = content;
    } catch (err) {
      filePreviewBody.textContent = 'Could not read file: ' + err.message;
    }
  }

  filePreviewCloseBtn.addEventListener('click', () => { filePreviewModal.style.display = 'none'; });
  filePreviewModal.addEventListener('click', (e) => { if (e.target === filePreviewModal) filePreviewModal.style.display = 'none'; });

  async function refreshProjectFiles() {
    if (mode !== 'project') return;

    fileTreeEl.innerHTML = '<div class="agent-empty-hint">Loading…</div>';

    try {
      const files = await api.getProjectFiles();

      if (!files.length) {
        fileTreeEl.innerHTML = '<div class="agent-empty-hint">(empty project)</div>';
        return;
      }

      const summary = document.createElement('div');
      summary.className = 'agent-file-summary';
      summary.textContent = files.length + ' file(s)' + (files.length > 500 ? ' (showing first 500)' : '');

      const list = document.createElement('div');
      list.className = 'agent-file-list';

      const tree = buildFileTree(files.slice(0, 500));
      renderFileTreeNode(tree, list, 0);

      fileTreeEl.innerHTML = '';
      fileTreeEl.appendChild(summary);
      fileTreeEl.appendChild(list);
    } catch (err) {
      fileTreeEl.innerHTML = '<div class="agent-empty-hint">' + escapeHtml(err.message) + '</div>';
    }
  }

  selectFolderBtn.addEventListener('click', async () => {
    try {
      const result = await api.selectProjectFolder();
      if (!result || !result.projectRoot) return; // user cancelled

      // agent:mode-changed event (below) also fires and will call applyMode;
      // this covers the case where events aren't wired yet at click-time.
      applyMode('project', result.projectRoot);
      renderMessagesFromHistory(result.messages);
      setUndoEnabled(false);
    } catch (err) {
      addSystemNote('Could not select folder: ' + err.message, true);
    }
  });

  clearFolderBtn.addEventListener('click', async () => {
    // This now removes the project's cached chat session/tab entirely (not
    // just switches away from it — see clearProjectFolder in
    // agent-controller.js), so confirm before doing something irreversible.
    const label = (projectRoot || '').split(/[\/\\]/).pop() || projectRoot || 'this project';
    if (!(await confirmDialog(`Turn off "${label}" and clear its cached chat history? This can't be undone.`))) return;
    try {
      const result = await api.clearProjectFolder();
      applyMode('global', null);
      renderMessagesFromHistory(result && result.messages);
      setUndoEnabled(false);
    } catch (err) {
      addSystemNote('Could not clear folder: ' + err.message, true);
    }
  });

  refreshFilesBtn.addEventListener('click', refreshProjectFiles);

  if (api.onAgentModeChanged) {
    api.onAgentModeChanged((data) => applyMode(data.mode, data.projectRoot));
  }

  // --- Model dropdown (reuses the existing known-OK priority-override channel,
  // so picking a model here actually pins routing for every request, agent or not) ---
  async function populateModelDropdown() {
    let known = [];
    try { known = await api.getKnownOk(); } catch (_) { known = []; }

    let saved = {};
    try { saved = await api.getAgentConfig(); } catch (_) { saved = {}; }

    // Authoritative pin/lock state from the backend, not the agent-config
    // snapshot — the backend can auto-clear a pin mid-session on failure,
    // and this is what makes the dropdown actually reflect that instead of
    // silently continuing to show a model that's no longer pinned.
    let priorityState = {};
    try { priorityState = await api.getPriorityState(); } catch (_) { priorityState = {}; }
    const activeKey = priorityState.priorityOverrideKey || '';

    modelDropdown.innerHTML = '<option value="">Auto (known-OK routing)</option>';
    const seenKeys = new Set(['']);

    known.forEach((k) => {
      const key = k.provider + '::' + k.model;
      seenKeys.add(key);
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = k.provider + ' / ' + k.model;
      modelDropdown.appendChild(opt);
    });

    // A locked pin can point at a model that has since fallen out of the
    // known-OK list (e.g. it failed but the lock kept it pinned "for this
    // request only" — see proxy-server.js's learnFailure). Setting
    // modelDropdown.value to a key with no matching <option> makes the
    // native <select> render as blank/empty instead of showing anything,
    // which is the "dropdown going blank" bug — always add the active key
    // as an option (even if not in `known`) so the select always has
    // something real to display.
    if (activeKey && !seenKeys.has(activeKey)) {
      const sep = activeKey.indexOf('::');
      const provider = sep >= 0 ? activeKey.slice(0, sep) : activeKey;
      const model = sep >= 0 ? activeKey.slice(sep + 2) : '';
      const opt = document.createElement('option');
      opt.value = activeKey;
      opt.textContent = provider + (model ? ' / ' + model : '') + ' (pinned, offline)';
      modelDropdown.appendChild(opt);
    }

    modelDropdown.value = activeKey || (saved.selectedModel || '');
    if (modelLockToggle) {
      modelLockToggle.checked = !!priorityState.priorityLocked;
      modelLockToggle.disabled = !activeKey;
    }
  }

  modelDropdown.addEventListener('change', async () => {
    const key = modelDropdown.value || null;
    if (modelLockToggle) modelLockToggle.disabled = !key;
    try {
      if (api.setPriorityOverride) await api.setPriorityOverride(key, modelLockToggle ? modelLockToggle.checked : false);
      await api.saveAgentConfig({ selectedModel: key });
    } catch (err) {
      addSystemNote('Could not set model: ' + err.message, true);
    }
  });

  if (modelLockToggle) {
    modelLockToggle.addEventListener('change', async () => {
      try { await api.setPriorityOverride(modelDropdown.value || null, modelLockToggle.checked); }
      catch (err) { addSystemNote('Could not set lock: ' + err.message, true); }
    });
  }

  // Live resync: same PRIORITY_STATE_CHANGED broadcast the Proxy Control tab
  // listens to, so a pin cleared from either tab (or auto-cleared by the
  // backend after a failure) is reflected here immediately.
  if (api.onPriorityStateChanged) {
    api.onPriorityStateChanged(() => { populateModelDropdown(); });
  }

  // --- Settings toggles: stream responses / quick approval ---
  async function loadSettingsToggles() {
    let saved = {};
    try { saved = await api.getAgentConfig(); } catch (_) { saved = {}; }

    streamToggle.checked = saved.streamResponses !== false; // default true
    alwaysApproveToggle.checked = !!saved.alwaysApproveWrites; // default false

    // Agent-side timeout / token limits (fall back to defaults if unset)
    timeoutMsInput.value = (saved.agentTimeoutMs && saved.agentTimeoutMs > 0) ? saved.agentTimeoutMs : 60000;
    maxOutputTokensInput.value = (saved.agentMaxOutputTokens && saved.agentMaxOutputTokens > 0) ? saved.agentMaxOutputTokens : 8192;
    maxInputTokensInput.value = (saved.agentMaxInputTokens && saved.agentMaxInputTokens > 0) ? saved.agentMaxInputTokens : 128000;
    // --- NEW: agent-loop auto-continuation (FINISHED sentinel) ---
    followupIntervalMsInput.value = (saved.agentFollowupIntervalMs && saved.agentFollowupIntervalMs > 0) ? saved.agentFollowupIntervalMs : 1000;
    maxFollowupsInput.value = (saved.agentMaxFollowups && saved.agentMaxFollowups > 0) ? saved.agentMaxFollowups : 20;
    // --- NEW: heartbeat logging --- 0 is a valid, meaningful value here
    // (disabled), so check specifically for null/undefined rather than
    // falsy/>0 like the other fields above.
    heartbeatIntervalMsInput.value = (saved.agentHeartbeatIntervalMs != null) ? saved.agentHeartbeatIntervalMs : 60000;
    // --- NEW: overall per-turn wall-clock cap ---
    runTimeoutMsInput.value = (saved.agentRunTimeoutMs && saved.agentRunTimeoutMs > 0) ? saved.agentRunTimeoutMs : 900000;
  }

  streamToggle.addEventListener('change', async () => {
    try { await api.saveAgentConfig({ streamResponses: streamToggle.checked }); }
    catch (err) { addSystemNote('Could not save setting: ' + err.message, true); }
  });

  alwaysApproveToggle.addEventListener('change', async () => {
    try { await api.saveAgentConfig({ alwaysApproveWrites: alwaysApproveToggle.checked }); }
    catch (err) { addSystemNote('Could not save setting: ' + err.message, true); }
  });

  // --- NEW: agent-side timeout / token-limit inputs ---
  timeoutMsInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(timeoutMsInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentTimeoutMs: val }); }
    catch (err) { addSystemNote('Could not save timeout: ' + err.message, true); }
  });

  maxOutputTokensInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(maxOutputTokensInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentMaxOutputTokens: val }); }
    catch (err) { addSystemNote('Could not save max output tokens: ' + err.message, true); }
  });

  maxInputTokensInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(maxInputTokensInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentMaxInputTokens: val }); }
    catch (err) { addSystemNote('Could not save max input tokens: ' + err.message, true); }
  });

  // --- NEW: agent-loop auto-continuation (FINISHED sentinel) ---
  followupIntervalMsInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(followupIntervalMsInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentFollowupIntervalMs: val }); }
    catch (err) { addSystemNote('Could not save follow-up wait: ' + err.message, true); }
  });

  maxFollowupsInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(maxFollowupsInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentMaxFollowups: val }); }
    catch (err) { addSystemNote('Could not save max follow-ups: ' + err.message, true); }
  });

  // --- NEW: heartbeat logging ---
  heartbeatIntervalMsInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(heartbeatIntervalMsInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentHeartbeatIntervalMs: val }); }
    catch (err) { addSystemNote('Could not save heartbeat interval: ' + err.message, true); }
  });

  // --- NEW: overall per-turn wall-clock cap ---
  runTimeoutMsInput.addEventListener('change', async () => {
    const val = Math.max(0, parseInt(runTimeoutMsInput.value, 10) || 0);
    try { await api.saveAgentConfig({ agentRunTimeoutMs: val }); }
    catch (err) { addSystemNote('Could not save run timeout: ' + err.message, true); }
  });

  // --- Upload files --------------------------------------------------------------
  function renderUploadChips() {
    uploadChipsEl.innerHTML = '';

    uploadedFiles.forEach((f, i) => {
      const chip = document.createElement('span');
      chip.className = 'agent-chip';
      chip.textContent = f.filename + ' ✕';
      chip.title = f.binary ? 'Could not read as text' : '';

      chip.addEventListener('click', () => {
        uploadedFiles.splice(i, 1);
        renderUploadChips();
      });

      uploadChipsEl.appendChild(chip);
    });
  }

  uploadFileBtn.addEventListener('click', async () => {
    try {
      const result = await api.uploadFile();
      if (!result) return; // user cancelled
      uploadedFiles.push(result);
      renderUploadChips();
    } catch (err) {
      addSystemNote('Upload failed: ' + err.message, true);
    }
  });

  // --- Approval modal ----------------------------------------------------------------
  if (api.onAgentApprovalRequest) {
    api.onAgentApprovalRequest((data) => {
      pendingApprovalId = data.id;
      approvalTitle.textContent = data.action === 'run_command' ? 'Run shell command?' : 'Write file?';
      approvalDetails.textContent = JSON.stringify(data.details, null, 2);
      approvalModal.style.display = 'flex';
    });
  }

  approveBtn.addEventListener('click', async () => {
    if (!pendingApprovalId) return;
    await api.agentApprovalResponse(pendingApprovalId, true);
    pendingApprovalId = null;
    approvalModal.style.display = 'none';
  });

  denyBtn.addEventListener('click', async () => {
    if (!pendingApprovalId) return;
    await api.agentApprovalResponse(pendingApprovalId, false);
    pendingApprovalId = null;
    approvalModal.style.display = 'none';
  });

  // --- NEW: diff preview ------------------------------------------------------------
  // The main process already computes the line-level diff (see diffLines in
  // agent-controller.js); this just renders the { type, text } rows it sends
  // over IPC as color-coded monospace lines.
  function renderDiffRows(rows) {
    diffBodyEl.innerHTML = '';

    if (!Array.isArray(rows) || !rows.length) {
      diffBodyEl.innerHTML = '<div class="agent-empty-hint">(no changes)</div>';
      return;
    }

    const frag = document.createDocumentFragment();

    rows.forEach((row) => {
      const line = document.createElement('div');
      const prefix = row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  ';
      line.className = 'agent-diff-line agent-diff-line-' + row.type;
      line.textContent = prefix + row.text;
      frag.appendChild(line);
    });

    diffBodyEl.appendChild(frag);
  }

  if (api.onAgentDiffPreview) {
    api.onAgentDiffPreview((data) => {
      pendingDiffId = data.id;

      diffPathEl.innerHTML = escapeHtml(data.path || '') +
        (data.isNewFile ? '<span class="agent-diff-newfile-badge">New file</span>' : '');

      diffTitle.textContent = data.isNewFile ? 'Create new file?' : 'Review changes before writing?';

      if (data.isNewFile) {
        // Full-content preview for brand-new files (nothing to diff against).
        renderDiffRows(String(data.newContent || '').split('\n').map((text) => ({ type: 'add', text })));
      } else {
        renderDiffRows(data.diff);
      }

      diffModal.style.display = 'flex';
    });
  }

  diffAcceptBtn.addEventListener('click', async () => {
    if (!pendingDiffId) return;
    await api.agentDiffResponse(pendingDiffId, true);
    pendingDiffId = null;
    diffModal.style.display = 'none';
  });

  diffRejectBtn.addEventListener('click', async () => {
    if (!pendingDiffId) return;
    await api.agentDiffResponse(pendingDiffId, false);
    pendingDiffId = null;
    diffModal.style.display = 'none';
  });

  // --- Chat: send / stop / streaming events -------------------------------------------
  function setSending(isSending) {
    sending = isSending;
    inputEl.disabled = isSending;
    sendBtn.style.display = isSending ? 'none' : 'inline-block';
    stopBtn.style.display = isSending ? 'inline-block' : 'none';
  }

  async function sendMessage() {
    const originalText = inputEl.value;
    const text = originalText.trim();

    if (!text && !uploadedFiles.length) return;
    if (sending) return;

    addUserMessage(text || '(attached files only)');

    const filesToSend = uploadedFiles;
    uploadedFiles = [];
    renderUploadChips();
    inputEl.value = '';

    setSending(true);
    currentAssistantBubble = null;
    setLoopStatus('Working…', 'working');

    try {
      await api.agentSendMessage(text, filesToSend);
    } catch (err) {
      uploadedFiles = filesToSend.concat(uploadedFiles);
      renderUploadChips();
      inputEl.value = originalText;
      addSystemNote('Failed to send: ' + err.message, true);
      setSending(false);
      setLoopStatus(null);
    }
  }

  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();

      // --- NEW: slash commands --- expand in place first; the user gets a
      // chance to edit the expanded prompt and press Enter again to send it,
      // matching the spec ("replaced ... which can be further edited before sending").
      if (tryExpandSlashCommand()) return;
      sendMessage();
    }
  });

  stopBtn.addEventListener('click', async () => {
    try { await api.stopAgentSession(); } catch (_) { /* best-effort */ }
  });

  if (api.onAgentStreamChunk) {
    // Turn-level fallback — active when streaming is off (or if the main
    // process is running an older build without the token events below).
    api.onAgentStreamChunk((data) => { if (data && data.text) appendAssistantText(data.text); });
  }

  // --- NEW: streaming support ---
  if (api.onAgentStreamStart) {
    api.onAgentStreamStart(() => { startStreamingBubble(); });
  }

  if (api.onAgentStreamToken) {
    api.onAgentStreamToken((data) => { if (data && data.token) appendStreamToken(data.token); });
  }

  if (api.onAgentStreamEnd) {
    api.onAgentStreamEnd((data) => { endStreamingBubble(data && data.fullText); });
  }

  // --- NEW: task-progress panel ----------------------------------------------------------
  // Mirrors the agent's activity in the sidebar Task Progress list, distinct
  // from the chat tool cards above. Shows active tools (spinner), per-request
  // token usage, and an end-of-turn summary line.
  //
  // Raw backend tool function names (list_directory, read_file, ...) aren't
  // meaningful to a user watching the sidebar — this maps each known tool to
  // a short, human-readable TODO-style label. Unknown/future tool names fall
  // back to the raw name so nothing silently disappears.
   const TOOL_TASK_LABELS = {
    list_directory: 'List',
    read_file: 'Read',
    write_file: 'Write',
    search_code: 'Search',
    run_command: 'Run',
    scratchpad_write: 'Save'
  };

  // Extract a short subject (file/folder path) from tool args for compact display.
  function taskSubjectFor(name, args) {
    if (!args) return '';
    if (name === 'list_directory' || name === 'read_file' || name === 'write_file' || name === 'search_code') {
      return args.path || '';
    }
    if (name === 'run_command') {
      return args.command ? 'cmd: ' + (args.command.length > 30 ? args.command.slice(0, 30) + '…' : args.command) : '';
    }
    if (name === 'scratchpad_write') {
      return args.path || '';
    }
    return '';
  }

  function taskLabelFor(toolName) {
    return TOOL_TASK_LABELS[toolName] || toolName || 'Working';
  }

  function resetTaskProgress() {
    if (!taskProgressEl) return;
    taskProgressEl.innerHTML = '<div class="agent-task-progress-empty">Idle</div>';
  }

  // Store args so completeTaskProgressEntry can extract a subject path
  const taskArgs = new Map();

  function addTaskProgressEntry(id, label, args) {
    if (!taskProgressEl) return;
    const subject = taskSubjectFor(label, args);
    taskArgs.set(id, { label, subject });
    const empty = taskProgressEl.querySelector('.agent-task-progress-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'agent-progress-item';
    row.dataset.taskId = id;
    // Compact: "Read - src/foo.js" then "⏳" spinner, result replaces spinner
    const displayText = subject ? (label + ' — ' + subject) : label;
    row.innerHTML =
      '<span class="agent-progress-label">' + escapeHtml(displayText) + '</span>' +
      '<span class="agent-progress-spinner">⏳</span>' +
      '<span class="agent-progress-result" style="display:none;"></span>';
    taskProgressEl.appendChild(row);
  }

  function completeTaskProgressEntry(id, resultText) {
    if (!taskProgressEl) return;
    const row = taskProgressEl.querySelector('.agent-progress-item[data-task-id="' + id + '"]');
    if (!row) return;
    row.querySelector('.agent-progress-spinner').style.display = 'none';
    const resultEl = row.querySelector('.agent-progress-result');
    resultEl.style.display = 'inline';
    const ok = resultText && resultText.ok;
    // Show concise status: "✓ ok" or "✗ failed" with a shortened error
    let text = ok ? '✓ ok' : '✗ failed';
    if (resultText && !ok && resultText.message) {
      const msg = resultText.message.length > 60 ? resultText.message.slice(0, 60) + '…' : resultText.message;
      text += ' — ' + msg;
    }
    resultEl.textContent = text;
    taskArgs.delete(id);
  }

  function addTokenUsageEntry(usage) {
    if (!taskProgressEl) return;
    const { prompt, completion, total, estimated } = usage || {};
    if (prompt == null && completion == null) return;
    const empty = taskProgressEl.querySelector('.agent-task-progress-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'agent-progress-item agent-progress-usage';
    row.textContent = 'tokens: ' + [
      prompt != null ? 'in ' + prompt : '',
      completion != null ? 'out ' + completion : '',
      total != null ? 'total ' + total : ''
    ].filter(Boolean).join(' · ') + (estimated ? ' (estimated)' : '');
    taskProgressEl.appendChild(row);
  }

  function addTurnSummary(text) {
    if (!taskProgressEl) return;
    const empty = taskProgressEl.querySelector('.agent-task-progress-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'agent-progress-item agent-progress-summary';
    row.textContent = '✓ ' + (text || 'turn complete');
    taskProgressEl.appendChild(row);
  }

  if (api.onAgentToolList) {
    // This event only reports which tools are OFFERED to the model for the
    // turn — it fires with the same fixed set every time (all tools available
    // in the current mode), not what the model actually intends to do. Using
    // it to render a "plan" was misleading (a static checklist that never
    // changed). The real, model-driven feed is the live AGENT_TOOL_START /
    // AGENT_TOOL_RESULT entries below — those only appear when the model
    // actually calls that tool, in the order it calls them. So this handler
    // just resets the panel for the new turn and otherwise does nothing.
    api.onAgentToolList(() => {
      resetTaskProgress();
    });
  }

  if (api.onAgentTokenUsage) {
    api.onAgentTokenUsage((data) => addTokenUsageEntry(data.usage));
  }

  // Live task tracking: each tool call gets a row that flips from "running"
  // to its result as the agent works. (Also drives the chat-side tool cards.)
  if (api.onAgentToolStart) {
    api.onAgentToolStart((data) => {
      addToolCard(data.id, data.name, data.args);
      addTaskProgressEntry(data.id, taskLabelFor(data.name), data.args);
    });
  }
  if (api.onAgentToolResult) {
    api.onAgentToolResult((data) => {
      updateToolCard(data.id, data.result);
      completeTaskProgressEntry(data.id, data.result);
    });
  }

  if (api.onAgentDone) {
    api.onAgentDone((data) => {
      setSending(false);
      addTurnSummary(data && data.stoppedReason === 'step-limit-reached'
        ? 'agent hit tool-call limit — send a follow-up to continue'
        : 'turn complete');
      if (data && data.aborted) {
        setLoopStatus(null);
        addSystemNote('(stopped by user)');
      } else if (data && data.stoppedReason === 'step-limit-reached') {
        setLoopStatus(null);
        addSystemNote('(agent hit its per-turn tool-call limit — send a follow-up to continue)');
      } else {
        // --- NEW: agent-loop auto-continuation --- briefly show "Finished"
        // then clear the badge, matching the spec's status-change list.
        setLoopStatus('Finished', 'finished');
        setTimeout(() => setLoopStatus(null), 2000);
      }
      refreshChatTabs();
    });
  }

  if (api.onAgentError) {
    api.onAgentError((data) => {
      // --- NEW: keep-alive notices ---
      // Several non-fatal notices (retry attempts, a granted step-limit
      // extension) are sent through this same channel so they show up in the
      // conversation log, but they must NOT end the "agent is working" UI
      // state the way a real fatal error does.
      if (data && data.recoverable) {
        // --- NEW: agent-loop auto-continuation --- a distinct status badge
        // for auto-follow-ups instead of (or in addition to) a system note,
        // so "Auto-follow-up N/M" is visible without scrolling the chat log.
        if (data.autoFollowup) {
          setLoopStatus(`Auto-follow-up ${data.iteration}/${data.maxFollowups}`, 'followup');
        }
        addSystemNote(data.message);
        return;
      }
      setSending(false);
      setLoopStatus(null);
      addSystemNote('Error: ' + data.message, true);
    });
  }

  // --- NEW: undo ---------------------------------------------------------------------
  function setUndoEnabled(canUndo) {
    undoBtn.disabled = !canUndo;
  }

  if (api.onAgentUndoState) {
    api.onAgentUndoState((data) => setUndoEnabled(!!(data && data.canUndo)));
  }

  async function undoLastChange() {
    if (undoBtn.disabled) return;

    try {
      const result = await api.agentUndoLastWrite();
      if (result && result.ok) {
        addSystemNote('Undo: ' + result.message);
      } else {
        addSystemNote((result && result.message) || 'Nothing to undo.', !result || !result.ok);
      }
    } catch (err) {
      addSystemNote('Undo failed: ' + err.message, true);
    }
  }

  undoBtn.addEventListener('click', undoLastChange);

  // --- NEW: slash commands -----------------------------------------------------------
  // Expanded into a fuller prompt when the user hits Enter on a recognized
  // "/command" (optionally followed by an argument, e.g. "/edit src/foo.js").
  // The expansion replaces the input text (still editable before sending) and
  // a system note records which command was used.
  const SLASH_COMMANDS = [
    { cmd: '/explain', desc: 'Explain the following code in detail', expand: (arg) => 'Explain the following code in detail:' + (arg ? ' ' + arg : '') },
    { cmd: '/fix', desc: 'Identify and fix bugs, showing the corrected version', expand: (arg) => 'Identify and fix any bugs in the following code. Provide the corrected version:' + (arg ? ' ' + arg : '') },
    { cmd: '/search', desc: 'Search the project for a query and summarize results', expand: (arg) => `Search the project for "${arg || ''}" and summarize what you find (use the search_code tool).` },
    { cmd: '/test', desc: 'Write unit tests for the following code', expand: (arg) => 'Write unit tests for the following code:' + (arg ? ' ' + arg : '') },
    { cmd: '/edit', desc: 'Read a file and suggest improvements (diff before applying)', expand: (arg) => `Read the file ${arg || '<file>'} and suggest improvements. Show the diff before applying any change.` },
    { cmd: '/newfile', desc: 'Create a new file with a description', expand: (arg) => `Create a new file at ${arg || '<path>'} with the following description:` },
    { cmd: '/commit', desc: 'Generate a commit message summarizing current changes', expand: () => 'Generate a Git commit message summarizing the current changes in this project.' }
  ];

  function parseSlashCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    const match = SLASH_COMMANDS.find((c) => c.cmd === cmd);
    return match ? { match, arg } : null;
  }

  // Returns true if it expanded the input in place (caller should not send yet).
  function tryExpandSlashCommand() {
    const parsed = parseSlashCommand(inputEl.value);
    if (!parsed) return false;

    inputEl.value = parsed.match.expand(parsed.arg);
    addSystemNote('Command: ' + parsed.match.cmd + (parsed.arg ? ' ' + parsed.arg : ''));
    return true;
  }

  // --- NEW: slash commands --- command palette (Ctrl+K) ---
  function openPalette(prefill) {
    paletteInput.value = prefill || '';
    paletteActiveIndex = 0;
    renderPalette();
    paletteModal.style.display = 'flex';
    setTimeout(() => paletteInput.focus(), 0);
  }

  function closePalette() {
    paletteModal.style.display = 'none';
  }

  function filteredCommands() {
    const q = paletteInput.value.trim().toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => c.cmd.includes(q) || c.desc.toLowerCase().includes(q));
  }

  function renderPalette() {
    const matches = filteredCommands();
    paletteList.innerHTML = '';

    if (!matches.length) {
      paletteList.innerHTML = '<div class="agent-empty-hint">No matching commands.</div>';
      return;
    }

    if (paletteActiveIndex >= matches.length) paletteActiveIndex = 0;

    matches.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'agent-palette-item' + (i === paletteActiveIndex ? ' agent-palette-active' : '');

      row.innerHTML =
        '<span class="agent-palette-cmd">' + escapeHtml(c.cmd) + '</span>' +
        '<span class="agent-palette-desc">' + escapeHtml(c.desc) + '</span>';

      row.addEventListener('click', () => selectPaletteCommand(c));
      paletteList.appendChild(row);
    });
  }

  function selectPaletteCommand(c) {
    inputEl.value = c.cmd + ' ';
    closePalette();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }

  paletteInput.addEventListener('input', () => { paletteActiveIndex = 0; renderPalette(); });

  paletteInput.addEventListener('keydown', (e) => {
    const matches = filteredCommands();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteActiveIndex = Math.min(paletteActiveIndex + 1, matches.length - 1);
      renderPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteActiveIndex = Math.max(paletteActiveIndex - 1, 0);
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[paletteActiveIndex]) selectPaletteCommand(matches[paletteActiveIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });

  paletteBtn.addEventListener('click', () => openPalette());
  paletteModal.addEventListener('click', (e) => { if (e.target === paletteModal) closePalette(); });

  // --- NEW: keyboard shortcuts ---------------------------------------------------------
  // Ctrl+Enter: send · Ctrl+L: clear chat · Ctrl+Shift+F: focus file search ·
  // Ctrl+K: command palette · Ctrl+Z: undo last change.
  // Enter-without-shift already sends (existing behavior below); this global
  // listener covers the modifier-based shortcuts everywhere in the tab,
  // including when focus isn't in the chat input.
  document.addEventListener('keydown', (e) => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    if (!ctrlOrCmd) return;

    const key = e.key.toLowerCase();

    if (key === 'k') {
      e.preventDefault();
      if (paletteModal.style.display === 'flex') closePalette();
      else openPalette();
    } else if (key === 'l') {
      e.preventDefault();
      messagesEl.innerHTML = '';
      currentAssistantBubble = null;
      addSystemNote('(chat cleared)');
    } else if (key === 'f' && e.shiftKey) {
      e.preventDefault();
      if (fileSearchInput) fileSearchInput.focus();
    } else if (key === 'z') {
      e.preventDefault();
      undoLastChange();
    }
    // NOTE: Enter/Ctrl+Enter while focused in the chat input is handled
    // exclusively by inputEl's own 'keydown' listener above — do not add a
    // sendMessage() branch here, or messages will be sent twice.
  });

  // --- NEW: keyboard shortcuts --- sidebar file filter (client-side, no IPC) ---
  if (fileSearchInput) {
    fileSearchInput.addEventListener('input', () => {
      const q = fileSearchInput.value.trim().toLowerCase();
      const rows = fileTreeEl.querySelectorAll('.agent-file-row');

      rows.forEach((row) => {
        const match = !q || row.textContent.toLowerCase().includes(q);
        row.classList.toggle('agent-file-row-hidden', !match);

        // A match nested inside a collapsed directory would otherwise stay
        // invisible — expand every ancestor .agent-dir-children so search
        // results are actually visible regardless of prior collapse state.
        if (match && q) {
          let ancestor = row.parentElement;

          while (ancestor && ancestor !== fileTreeEl) {
            if (ancestor.classList.contains('agent-dir-children')) {
              ancestor.classList.remove('agent-dir-children-collapsed');

              const dirRow = ancestor.previousElementSibling;
              const caret = dirRow && dirRow.querySelector('.agent-dir-caret');
              if (caret) caret.classList.remove('agent-dir-collapsed');
            }

            ancestor = ancestor.parentElement;
          }
        }
      });
    });
  }

  // --- Init ------------------------------------------------------------------------
  async function init() {
    try {
      const modeInfo = await api.getAgentMode();
      applyMode(modeInfo.mode, modeInfo.projectRoot);
      setUndoEnabled(!!modeInfo.canUndo); // --- NEW: undo ---
    } catch (_) { applyMode('global', null); }

    await populateModelDropdown();
    await loadSettingsToggles();

    try {
      const session = await api.startAgentSession();
      renderMessagesFromHistory(session && session.messages);
    } catch (_) { /* best-effort */ }

    refreshChatTabs();
  }

  init();
})();