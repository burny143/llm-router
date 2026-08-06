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
  let globalSkills = [];
  let projectSkills = [];
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
  const addSkillBtn = el('agentAddSkillBtn');
  const skillsListEl = el('agentSkillsList');
  const addMcpBtn = el('agentAddMcpBtn');
  const mcpListEl = el('agentMcpList');
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

  // --- NEW: slash commands / undo ---
  const paletteBtn = el('agentPaletteBtn');
  const paletteModal = el('agentPaletteModal');
  const paletteInput = el('agentPaletteInput');
  const paletteList = el('agentPaletteList');
  const undoBtn = el('agentUndoBtn');
  const fileSearchInput = el('agentFileSearchInput');

  const skillModal = el('agentSkillModal');
  const skillModalTitle = el('agentSkillModalTitle');
  const skillNameInput = el('agentSkillName');
  const skillDescInput = el('agentSkillDescription');
  const skillPromptInput = el('agentSkillPrompt');
  const skillSaveBtn = el('agentSkillSaveBtn');
  const skillCancelBtn = el('agentSkillCancelBtn');

  const mcpModal = el('agentMcpModal');
  const mcpNameInput = el('agentMcpName');
  const mcpTransportSelect = el('agentMcpTransport');
  const mcpCommandRow = el('agentMcpCommandRow');
  const mcpCommandInput = el('agentMcpCommand');
  const mcpUrlRow = el('agentMcpUrlRow');
  const mcpUrlInput = el('agentMcpUrl');
  const mcpSaveBtn = el('agentMcpSaveBtn');
  const mcpCancelBtn = el('agentMcpCancelBtn');

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

    // fullText is authoritative (covers cases where the backend's final
    // content differs slightly from the concatenated tokens); reconcile.
    if (currentAssistantBubble && typeof fullText === 'string') {
      currentAssistantBubble.textContent = fullText;
    }
  }

  // Short, human-readable label for a tool call card / task tracker row
  // (e.g. "📄 readme.md" instead of the full JSON args blob).
  function getToolSummary(name, args) {
    const a = args || {};
    const base = String(name || 'tool');
    switch (base) {
      case 'read_file': {
        const f = String(a.path || '').split(/[\/\\]/).pop();
        return '📄 ' + (f || base);
      }
      case 'write_file':
      case 'edit_file': {
        const f = String(a.path || '').split(/[\/\\]/).pop();
        return '✏️ ' + (f || base);
      }
      case 'run_command':
        return '💻 ' + String(a.command || '').slice(0, 60);
      case 'search_in_project':
        return '🔍 ' + String(a.query || a.pattern || '').slice(0, 60);
      case 'list_files':
      case 'get_project_files':
        return '📁 ' + (a.path || '/');
      default:
        return '🔧 ' + base;
    }
  }

  function addToolCard(id, name, args) {
    const card = document.createElement('div');
    card.className = 'agent-tool-card';
    card.dataset.toolId = id;

    const argsStr = JSON.stringify(args || {}, null, 2);
    // Very large arg payloads (read_file of a big source file, search results,
    // etc.) clutter the thread — start those collapsed so the header summary
    // is what shows until the user expands them.
    if (argsStr.length > 300) card.classList.add('agent-tool-collapsed');

    card.innerHTML =
      '<div class="agent-tool-card-header">' +
        '<span class="agent-tool-card-title"><span class="agent-tool-caret">▾</span> ' + escapeHtml(getToolSummary(name, args)) + '</span>' +
        '<span class="agent-tool-status">running…</span>' +
      '</div>' +
      '<div class="agent-tool-body">' +
        '<pre class="agent-tool-args">' + escapeHtml(argsStr) + '</pre>' +
        '<pre class="agent-tool-result" style="display:none;"></pre>' +
      '</div>';

    card.querySelector('.agent-tool-card-header').addEventListener('click', () => {
      card.classList.toggle('agent-tool-collapsed');
    });

    messagesEl.appendChild(card);
    addTaskTrackerItem(id, getToolSummary(name, args));

    // A tool result following this closes the current assistant bubble (a
    // new one starts if the model replies again after the tool result).
    currentAssistantBubble = null;
    scrollMessagesToBottom();
  }

  // --- Task tracker (floating bottom-left overlay) --------------------------
  // Mirrors active tool calls while the agent is working; rows get a spinner
  // while running and are removed once the tool result arrives.
  let taskTrackerEl = null;
  const taskTrackerRows = new Map(); // toolId -> { row, labelEl }

  function ensureTaskTracker() {
    if (taskTrackerEl && document.body.contains(taskTrackerEl)) return taskTrackerEl;
    taskTrackerEl = document.createElement('div');
    taskTrackerEl.className = 'agent-task-tracker';
    taskTrackerEl.setAttribute('aria-label', 'Agent tasks');
    document.body.appendChild(taskTrackerEl);
    return taskTrackerEl;
  }

  function addTaskTrackerItem(id, label) {
    const tracker = ensureTaskTracker();
    if (!id || taskTrackerRows.has(id)) return;
    const row = document.createElement('div');
    row.className = 'agent-task-tracker-row';
    row.innerHTML =
      '<span class="task-spinner"></span>' +
      '<span class="agent-task-tracker-label"></span>';
    row.querySelector('.agent-task-tracker-label').textContent = label || '…';
    tracker.appendChild(row);
    taskTrackerRows.set(id, { row, labelEl: row.querySelector('.agent-task-tracker-label') });
    tracker.classList.add('has-tasks');
  }

  function updateTaskTrackerItem(id, done, label) {
    const entry = taskTrackerRows.get(id);
    if (!entry) return;
    if (typeof label === 'string') entry.labelEl.textContent = label;
    if (done) {
      entry.row.classList.add('done');
      entry.row.querySelector('.task-spinner').remove();
      // Briefly keep the finished row visible, then remove it entirely.
      setTimeout(() => {
        entry.row.remove();
        taskTrackerRows.delete(id);
        const tracker = taskTrackerEl;
        if (tracker && tracker.children.length === 0) tracker.classList.remove('has-tasks');
      }, 1200);
    }
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
    updateTaskTrackerItem(id, true);
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

  function parseCommandString(command) {
    const parts = String(command || '').trim().match(/(?:[^\s"]+|"[^"]*")/g) || [];
    return parts.map(p => p.replace(/^"|"$/g, ''));
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

    renderSkills();
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
      const chosen = await api.selectProjectFolder();
      if (!chosen) return; // user cancelled

      // agent:mode-changed event (below) also fires and will call applyMode;
      // this covers the case where events aren't wired yet at click-time.
      applyMode('project', chosen);
    } catch (err) {
      addSystemNote('Could not select folder: ' + err.message, true);
    }
  });

  clearFolderBtn.addEventListener('click', async () => {
    try {
      await api.clearProjectFolder();
      applyMode('global', null);
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
  }

  streamToggle.addEventListener('change', async () => {
    try { await api.saveAgentConfig({ streamResponses: streamToggle.checked }); }
    catch (err) { addSystemNote('Could not save setting: ' + err.message, true); }
  });

  alwaysApproveToggle.addEventListener('change', async () => {
    try { await api.saveAgentConfig({ alwaysApproveWrites: alwaysApproveToggle.checked }); }
    catch (err) { addSystemNote('Could not save setting: ' + err.message, true); }
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

  // --- Skills --------------------------------------------------------------------
  // Global skills are stored in agent-config.json and are fully editable here.
  // Project skills load read-only from the project's own .agent/skills.json
  // (see agent-controller.js's SAVE_SKILLS handler) — there's no IPC path to
  // write them from the UI, so they're shown but not editable, with a tooltip
  // explaining why rather than offering buttons that would silently no-op.
  let editingSkillId = null; // null => "add" mode; otherwise the global skill being edited

  function renderSkillRow(s, isProject) {
    const row = document.createElement('div');
    row.className = 'agent-list-row';

    const label = document.createElement('span');
    label.textContent = s.name;
    label.title = s.description || '';
    row.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'agent-skill-row-actions';

    if (isProject) {
      const lock = document.createElement('span');
      lock.textContent = '🔒';
      lock.title = 'Project skills are read-only here — edit .agent/skills.json in the project folder.';
      actions.appendChild(lock);
    } else {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = s.enabled !== false;
      toggle.title = 'Enabled';

      toggle.addEventListener('change', async () => {
        const updated = globalSkills.map((g) => g.id === s.id ? { ...g, enabled: toggle.checked } : g);
        globalSkills = updated;
        try { await api.saveSkills(globalSkills); } catch (err) { addSystemNote('Could not save skills: ' + err.message, true); }
      });

      actions.appendChild(toggle);

      const editBtn = document.createElement('button');
      editBtn.className = 'agent-skill-icon-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit skill';
      editBtn.addEventListener('click', () => openSkillModal(s));
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'agent-skill-icon-btn';
      deleteBtn.textContent = '🗑';
      deleteBtn.title = 'Delete skill';

      deleteBtn.addEventListener('click', async () => {
        globalSkills = globalSkills.filter((g) => g.id !== s.id);
        try { await api.saveSkills(globalSkills); renderSkills(); } catch (err) { addSystemNote('Could not delete skill: ' + err.message, true); }
      });

      actions.appendChild(deleteBtn);
    }

    row.appendChild(actions);
    return row;
  }

  function renderSkills() {
    skillsListEl.innerHTML = '';

    if (!globalSkills.length && !(mode === 'project' && projectSkills.length)) {
      skillsListEl.innerHTML = '<div class="agent-empty-hint">No skills yet.</div>';
      return;
    }

    const globalHeader = document.createElement('div');
    globalHeader.className = 'agent-sub-list-header';
    globalHeader.textContent = 'Global';
    skillsListEl.appendChild(globalHeader);

    if (!globalSkills.length) {
      skillsListEl.insertAdjacentHTML('beforeend', '<div class="agent-empty-hint">No global skills yet.</div>');
    } else {
      globalSkills.forEach((s) => skillsListEl.appendChild(renderSkillRow(s, false)));
    }

    if (mode === 'project') {
      const projectHeader = document.createElement('div');
      projectHeader.className = 'agent-sub-list-header';
      projectHeader.textContent = 'Project (' + (projectSkills.length ? projectSkills.length : 'none') + ')';
      skillsListEl.appendChild(projectHeader);

      if (projectSkills.length) {
        projectSkills.forEach((s) => skillsListEl.appendChild(renderSkillRow(s, true)));
      }
    }
  }

  async function loadSkills() {
    try {
      const res = await api.getSkills();
      globalSkills = res.global || [];
      projectSkills = res.project || [];
    } catch (_) { globalSkills = []; projectSkills = []; }

    renderSkills();
  }

  function openSkillModal(existing) {
    editingSkillId = existing ? existing.id : null;
    skillModalTitle.textContent = existing ? 'Edit Skill' : 'Add Skill';
    skillNameInput.value = existing ? existing.name : '';
    skillDescInput.value = existing ? (existing.description || '') : '';
    skillPromptInput.value = existing ? (existing.prompt || '') : '';
    skillModal.style.display = 'flex';
  }

  addSkillBtn.addEventListener('click', () => openSkillModal(null));
  skillCancelBtn.addEventListener('click', () => { skillModal.style.display = 'none'; editingSkillId = null; });

  skillSaveBtn.addEventListener('click', async () => {
    const name = skillNameInput.value.trim();
    if (!name) return;

    const fields = {
      name,
      description: skillDescInput.value.trim(),
      prompt: skillPromptInput.value.trim()
    };

    if (editingSkillId) {
      globalSkills = globalSkills.map((g) => g.id === editingSkillId ? { ...g, ...fields } : g);
    } else {
      globalSkills = [...globalSkills, { id: 'skill-' + Date.now(), ...fields, enabled: true }];
    }

    try {
      await api.saveSkills(globalSkills);
      renderSkills();
      skillModal.style.display = 'none';
      editingSkillId = null;
    } catch (err) {
      addSystemNote('Could not save skill: ' + err.message, true);
    }
  });

  // --- MCP servers -----------------------------------------------------------------
  async function renderMcp() {
    let servers = [];
    try { servers = await api.getMcpStatus(); } catch (_) { servers = []; }

    mcpListEl.innerHTML = '';

    if (!servers.length) {
      mcpListEl.innerHTML = '<div class="agent-empty-hint">No MCP servers connected.</div>';
      return;
    }

    servers.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'agent-list-row agent-mcp-row';

      const label = document.createElement('span');
      label.className = 'agent-mcp-row-label';

      const status = s.status || 'connected';

      const dot = document.createElement('span');
      dot.className = 'agent-mcp-status-dot ' + (status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'error');
      dot.title = status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : ('Connection failed' + (s.statusMessage ? ': ' + s.statusMessage : ''));

      label.appendChild(dot);

      const text = document.createElement('span');
      text.textContent = (s.scope === 'project' ? '📁 ' : '') + s.name + ' (' + s.transport + ')';
      text.title = status === 'error' && s.statusMessage ? s.statusMessage : ((s.tools || []).join(', ') || 'no tools listed');

      label.appendChild(text);
      row.appendChild(label);
      mcpListEl.appendChild(row);
    });
  }

  addMcpBtn.addEventListener('click', () => {
    mcpNameInput.value = '';
    mcpCommandInput.value = '';
    mcpUrlInput.value = '';
    mcpTransportSelect.value = 'stdio';
    mcpCommandRow.style.display = 'block';
    mcpUrlRow.style.display = 'none';
    mcpModal.style.display = 'flex';
  });

  mcpTransportSelect.addEventListener('change', () => {
    const isHttp = mcpTransportSelect.value === 'http';
    mcpCommandRow.style.display = isHttp ? 'none' : 'block';
    mcpUrlRow.style.display = isHttp ? 'block' : 'none';
  });

  mcpCancelBtn.addEventListener('click', () => { mcpModal.style.display = 'none'; });

  mcpSaveBtn.addEventListener('click', async () => {
    const name = mcpNameInput.value.trim();
    if (!name) return;

    const transport = mcpTransportSelect.value;
    const commandParts = parseCommandString(mcpCommandInput.value.trim());

    const cfg = transport === 'http'
      ? { name, transport: 'http', url: mcpUrlInput.value.trim() }
      : { name, transport: 'stdio', command: commandParts[0] || '', args: commandParts.slice(1) };

    try {
      const current = await api.getAgentConfig();
      const globalMcpServers = [...(current.globalMcpServers || []), cfg];

      // Close the modal before awaiting the save: saveAgentConfig reconnects
      // every global MCP server, and any unresponsive one adds up to ~15-30s
      // of timeout. Awaiting it first kept the full-viewport modal overlay up
      // the whole time, blocking clicks to everything behind it. Fire the
      // save, close immediately, and poll renderMcp to reflect status as it
      // resolves.
      mcpModal.style.display = 'none';

      api.saveAgentConfig({ globalMcpServers }).catch(err => {
        addSystemNote('Could not add MCP server: ' + err.message, true);
      });

      let polls = 0;
      const pollInterval = setInterval(async () => {
        polls += 1;
        await renderMcp();
        if (polls >= 8) clearInterval(pollInterval);
      }, 1000);
    } catch (err) {
      addSystemNote('Could not add MCP server: ' + err.message, true);
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

    try {
      await api.agentSendMessage(text, filesToSend);
    } catch (err) {
      uploadedFiles = filesToSend.concat(uploadedFiles);
      renderUploadChips();
      inputEl.value = originalText;
      addSystemNote('Failed to send: ' + err.message, true);
      setSending(false);
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

  if (api.onAgentToolStart) {
    api.onAgentToolStart((data) => addToolCard(data.id, data.name, data.args));
  }

  if (api.onAgentToolResult) {
    api.onAgentToolResult((data) => updateToolCard(data.id, data.result));
  }

  if (api.onAgentDone) {
    api.onAgentDone((data) => {
      setSending(false);
      if (data && data.aborted) addSystemNote('(stopped by user)');
      if (data && data.stoppedReason === 'step-limit-reached') addSystemNote('(agent hit its per-turn tool-call limit — send a follow-up to continue)');
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
        addSystemNote(data.message);
        return;
      }
      setSending(false);
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

    await loadSkills();
    await renderMcp();
    await populateModelDropdown();
    await loadSettingsToggles();

    try { await api.startAgentSession(); } catch (_) { /* best-effort */ }
  }

  init();
})();