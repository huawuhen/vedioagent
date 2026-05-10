// AI Video Agent — prototype controller (iteration 3)
// Project / Session layering + project-level asset repository with versions.

(function () {
  const M = window.MOCK;

  const TASK_ICONS    = { video: 'video', image: 'image', text: 'file-text', audio: 'music' };
  const BALANCE_ICONS = { video: 'gem',   image: 'sparkles', text: 'hash',   audio: 'volume-2' };

  // Custom skills added by user uploads / creation
  // Schema: { id, label, prompt, builtin:false, createdAt }
  let customSkills = [];

  // ─── Demo mode (for GitHub Pages public demo) ──────────────────────
  // When true: callLLM bypasses real DeepSeek API, returns canned responses
  // with simulated streaming so the UI feels "AI working" without any network.
  let APP_CONFIG = { mockMode: true, provider: 'mock', persistence: 'localStorage' };
  let MOCK_MODE = true;

  async function loadAppConfig() {
    try {
      const resp = await fetch('/api/config', { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error('config request failed');
      APP_CONFIG = await resp.json();
      MOCK_MODE = !!APP_CONFIG.mockMode;
    } catch (e) {
      APP_CONFIG = { mockMode: true, provider: 'mock', persistence: 'localStorage' };
      MOCK_MODE = true;
      console.warn('[config] using local mock fallback', e);
    }
  }

  async function apiJson(path, options = {}) {
    const resp = await fetch(path, {
      ...options,
      headers: {
        'Accept': 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || data.message || ('HTTP ' + resp.status));
    return data;
  }

  // ───── LLM API infrastructure ─────
  const skillCache = {};

  async function loadSkillPrompt(filename) {
    if (skillCache[filename]) return skillCache[filename];
    const resp = await fetch('skills/' + filename);
    if (!resp.ok) throw new Error('无法加载技能文件: ' + filename);
    const text = await resp.text();
    skillCache[filename] = text;
    return text;
  }

  function getApiKey() {
    return localStorage.getItem('deepseek_api_key') || '';
  }

  function setApiKey(key) {
    localStorage.setItem('deepseek_api_key', key);
  }

  function requireApiKey() {
    return new Promise(resolve => {
      const existing = getApiKey();
      if (existing) { resolve(existing); return; }
      showApiKeyDialog().then(resolve);
    });
  }

  function showApiKeyDialog() {
    return new Promise(resolve => {
      const mask = $('#apiKeyMask');
      const input = $('#apiKeyInput');
      input.value = getApiKey();
      mask.classList.add('show');
      setTimeout(() => input.focus(), 50);
      const cleanup = (val) => {
        mask.classList.remove('show');
        $('#apiKeySave').onclick = null;
        $('#apiKeyCancel').onclick = null;
        resolve(val);
      };
      $('#apiKeySave').onclick = () => {
        const key = input.value.trim();
        if (key) { setApiKey(key); cleanup(key); }
        else toast('请输入有效的 API Key');
      };
      $('#apiKeyCancel').onclick = () => cleanup('');
      input.onkeydown = (e) => { if (e.key === 'Enter') $('#apiKeySave').click(); };
    });
  }

  // Mock LLM call for demo mode — simulates streaming without real API
  function mockChunkText(text, size) {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }
  function mockPickResponse(systemPrompt, userMessage, opts) {
    const sys = String(systemPrompt || '');
    const user = String(userMessage || '');
    // 1) AI 提升（prompt 改写）— take user's existing prompt and add cinematic qualifiers
    if (/优化|改写|提升|prompt 工程师|提示词专家/i.test(sys) || opts?.taskKind === 'upgrade') {
      // Try multiple patterns: "## 用户当前 prompt\nXXX", "当前提示词：XXX", or fallback to first paragraph
      let original = '';
      const m1 = user.match(/##\s*用户当前\s*prompt\s*\n+([\s\S]+?)(?:\n##|\n\n##|$)/i);
      const m2 = user.match(/当前提示词[:：]?\s*([\s\S]+?)(?:\n\n|$)/);
      if (m1) original = m1[1].trim();
      else if (m2) original = m2[1].trim();
      else original = user.trim().split(/\n\s*\n/)[0].slice(0, 200);
      // Strip any trailing instruction lines like "## 请输出..."
      original = original.replace(/##\s*请输出[\s\S]*$/i, '').trim();
      return `${original}，电影质感，胶片颗粒感，9:16 竖屏，悬疑氛围，强细节写实，光影层次丰富，冷蓝主光暖色点缀。`;
    }
    // 2) 剧本拆解技能
    if (/剧本拆解|breakdown/i.test(sys)) {
      return '【风格指南】\n艺术风格：写实悬疑电影质感\n色彩基调：冷蓝偏灰\n\n【主要角色】（演示数据，详情见已生成的拆解 V2 文档）\n\n【关键场景】（演示数据）\n\n【关键道具】（演示数据）';
    }
    // 3) 分镜脚本技能
    if (/分镜|storyboard/i.test(sys)) {
      return '【片名】演示分镜\n【时长】6 分钟\n【镜头总数】14\n\n（演示数据，详情见已生成的分镜脚本 V2 文档）';
    }
    // 4) 默认
    return '收到。基于你的需求，已经为你完成了相应的处理。详情见下方资产卡片。';
  }
  async function mockCallLLM(systemPrompt, userMessage, onChunk, opts = {}) {
    const response = mockPickResponse(systemPrompt, userMessage, opts);
    const chunks = mockChunkText(response, 12);
    let acc = '';
    for (const c of chunks) {
      await new Promise(r => setTimeout(r, 60 + Math.random() * 40));
      acc += c;
      // Match real callLLM signature: (fullText, delta)
      if (onChunk) {
        try { onChunk(acc, c); } catch (e) { /* swallow */ }
      }
    }
    return { text: response, usage: null, mock: true };
  }

  async function callLLM(systemPrompt, userMessage, onChunk, opts = {}) {
    if (MOCK_MODE) return mockCallLLM(systemPrompt, userMessage, onChunk, opts);
    const data = await apiJson('/api/llm', {
      method: 'POST',
      body: JSON.stringify({ systemPrompt, userMessage, opts })
    });
    if (!data.text || !String(data.text).trim()) throw new Error('API 返回空响应，请重试');
    if (onChunk) onChunk(data.text, data.text);
    return data;
  }

  // Deep-clone projects so mutations don't touch MOCK source
  const state = {
    projects: M.projects.map(p => ({
      ...p,
      sessions: p.sessions.map(s => ({ ...s, messages: s.messages.map(m => ({ ...m })) })),
      assets: {
        text:  (p.assets.text  || []).map(a => ({ ...a, annotations: (a.annotations || []).map(an => ({ ...an })) })),
        image: (p.assets.image || []).map(a => ({ ...a, annotations: (a.annotations || []).map(an => ({ ...an })) })),
        video: (p.assets.video || []).map(a => ({ ...a, annotations: (a.annotations || []).map(an => ({ ...an })) })),
        audio: (p.assets.audio || []).map(a => ({ ...a, annotations: (a.annotations || []).map(an => ({ ...an })) }))
      },
      folders: (p.folders || []).map(f => ({ ...f })),
      sessionFolders: (p.sessionFolders || []).map(f => ({ ...f }))
    })),
    currentProjectId: M.projects[0].id,
    currentSessionId: M.projects[0].sessions[0].id,
    expandedProjects: new Set([M.projects[0].id]),
    refMaterials: [],
    controls: {
      task: 'video',
      model: M.MODELS.video[0],
      refMode: '全能参考',
      ratio: M.RATIO_SHAPES.video[1],          // '16:9'
      resolution: M.RESOLUTIONS.video[0],      // '720P'
      duration: M.DURATIONS.video[1]           // '5s'
    },
    frames: { first: null, last: null },
    leftCollapsed: false,
    user: { name: 'Bruce' },
    skill: 'script-breakdown',
    tokenUsage: 0,
    annotations: [],
    rightPanelOpen: false,
    rightPanelTab: 'files',                     // 'files' | 'browser'
    rightPanelMaxed: false,
    libraryUI: {
      selectedFolderId: 'f_default',
      expandedFolders: new Set(['f_default']),
      searchQuery: '',
      selectedAssetId: null,
      splitRatio: 0.6,
      treeCollapsed: false,                     // default: tree visible; user can collapse via «
      multiSelect: { active: false, selected: new Set() }
    },
    expandedSessionFolders: new Set(),
    messageFilter: 'all',                       // 'all' | 'today' | '7d' | '30d' | 'custom'
    messageFilterRange: { from: null, to: null }, // ISO date strings 'YYYY-MM-DD'
    favoritePrompts: [],                        // [{ name, prompt, imageSrc?, createdAt }]
    composedAnnotations: [],                    // [{ assetId, annotationId, text, assetSrc }]
    composedExamples: [],                       // [{ name, prompt, imageSrc? }]
    openRpTabs: new Set()                       // dynamic tabs in right panel: 'skills' | 'examples'
  };

  // ───── folders & persistence (Phase 1: data scaffolding) ─────
  const PERSIST_KEY = 'va_state_v1';
  const PERSIST_VERSION = 5;
  const USER_ASSET_LIMIT = 200;
  const ASSET_TYPES = ['text', 'image', 'video', 'audio'];

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function migrateProjects() {
    state.projects.forEach(p => {
      // Asset folders
      if (!Array.isArray(p.folders) || p.folders.length === 0) {
        p.folders = [{ id: 'f_default', name: '默认', parentId: null, createdAt: Date.now(), isDefault: true }];
      } else if (!p.folders.find(f => f.id === 'f_default')) {
        p.folders.unshift({ id: 'f_default', name: '默认', parentId: null, createdAt: Date.now(), isDefault: true });
      }
      ASSET_TYPES.forEach(type => {
        (p.assets[type] || []).forEach(a => { if (!a.folderId) a.folderId = 'f_default'; });
      });

      // Session folders — only an archive folder per project; remove legacy sf_default
      if (!Array.isArray(p.sessionFolders)) p.sessionFolders = [];
      // Drop legacy sf_default folder
      p.sessionFolders = p.sessionFolders.filter(f => f.id !== 'sf_default');
      // Ensure sf_archive exists
      if (!p.sessionFolders.find(f => f.id === 'sf_archive')) {
        p.sessionFolders.push({ id: 'sf_archive', name: '归档', parentId: null, isArchive: true, createdAt: Date.now() });
      }
      // Session type + folderId migration
      (p.sessions || []).forEach(s => {
        if (!s.type) s.type = s.defaultTask || 'text';
        // Legacy sf_default → root level (null)
        if (s.folderId === 'sf_default') s.folderId = null;
        // Legacy archived flag → move to sf_archive
        if (s.archived === true) {
          s.folderId = 'sf_archive';
          delete s.archived;
        }
      });
    });
  }

  function validateFolderRefs() {
    state.projects.forEach(p => {
      const ids = new Set(p.folders.map(f => f.id));
      p.folders.forEach(f => { if (f.parentId && !ids.has(f.parentId)) f.parentId = null; });
      ASSET_TYPES.forEach(type => {
        (p.assets[type] || []).forEach(a => { if (!ids.has(a.folderId)) a.folderId = 'f_default'; });
      });
      const sfIds = new Set(p.sessionFolders.map(f => f.id));
      p.sessionFolders.forEach(f => { if (f.parentId && !sfIds.has(f.parentId)) f.parentId = null; });
      // Sessions: folderId can be null (root), sf_archive, or any user folder
      (p.sessions || []).forEach(s => {
        if (s.folderId && !sfIds.has(s.folderId)) s.folderId = null;
      });
    });
  }

  function buildPersistSnapshot() {
    return {
      version: PERSIST_VERSION,
      ui: {
        splitRatio: state.libraryUI.splitRatio || 0.6,
        rightPanelTab: state.rightPanelTab || 'files',
        libTreeCollapsed: !!state.libraryUI.treeCollapsed
      },
      favoritePrompts: state.favoritePrompts || [],
      customSkills: customSkills || [],
      projects: state.projects.map(p => {
        const assetFolderMap = {};
        const assetNameMap = {};
        const assetAnnotationsMap = {};
        const userCreatedAssets = [];
        ASSET_TYPES.forEach(type => {
          const mockAssets = (M.projects.find(mp => mp.id === p.id)?.assets[type]) || [];
          (p.assets[type] || []).forEach(a => {
            if (a.folderId && a.folderId !== 'f_default') assetFolderMap[a.id] = a.folderId;
            if (a._userCreated) {
              userCreatedAssets.push({ ...a, _type: type });
            } else {
              const orig = mockAssets.find(m => m.id === a.id);
              if (orig && a.name !== orig.name) assetNameMap[a.id] = a.name;
              // Persist annotations on built-in assets if added/modified vs. mock baseline
              const origAnns = (orig?.annotations || []);
              const liveAnns = (a.annotations || []);
              const changed = liveAnns.length !== origAnns.length || liveAnns.some((x, i) => !origAnns[i] || x.id !== origAnns[i].id);
              if (changed) assetAnnotationsMap[a.id] = liveAnns;
            }
          });
        });
        // Sessions: persist as full snapshot (lightweight — id/name/type/folderId only for built-ins; full for user-created)
        const mockSessionIds = new Set((M.projects.find(mp => mp.id === p.id)?.sessions || []).map(s => s.id));
        const sessionMeta = {};       // id → {name?, folderId?} for built-in sessions (only if changed)
        const userSessions = [];       // full session for user-created
        (p.sessions || []).forEach(s => {
          if (mockSessionIds.has(s.id)) {
            const orig = M.projects.find(mp => mp.id === p.id).sessions.find(o => o.id === s.id);
            const meta = {};
            if (orig.name !== s.name) meta.name = s.name;
            if (s.folderId && s.folderId !== 'sf_default') meta.folderId = s.folderId;
            if (s.archived) meta.archived = true;
            if (Object.keys(meta).length) sessionMeta[s.id] = meta;
          } else {
            userSessions.push({ id: s.id, name: s.name, type: s.type, defaultTask: s.defaultTask, folderId: s.folderId, refs: s.refs || [], messages: s.messages || [] });
          }
        });
        return {
          id: p.id, folders: p.folders, assetFolderMap, assetNameMap, assetAnnotationsMap, userCreatedAssets,
          sessionFolders: p.sessionFolders, sessionMeta, userSessions,
          archived: p.archived, name: p.name === (M.projects.find(mp => mp.id === p.id)?.name) ? undefined : p.name
        };
      })
    };
  }

  let _persistTimer = null;
  function persistState() {
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(_doPersist, 300);
  }

  function _doPersist() {
    let snapshot;
    try { snapshot = buildPersistSnapshot(); } catch (e) { console.warn('[persist] snapshot failed', e); return; }

    // cap userCreatedAssets per project
    snapshot.projects.forEach(p => {
      if (p.userCreatedAssets.length > USER_ASSET_LIMIT) {
        p.userCreatedAssets.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        p.userCreatedAssets = p.userCreatedAssets.slice(-USER_ASSET_LIMIT);
      }
    });

    const tryWrite = () => localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
    if (APP_CONFIG.persistence !== 'localStorage') {
      apiJson('/api/state', {
        method: 'PUT',
        body: JSON.stringify(snapshot)
      }).catch(e => console.warn('[persist] server write failed', e));
    }
    try {
      tryWrite();
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        snapshot.projects.forEach(p => {
          p.userCreatedAssets.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          p.userCreatedAssets = p.userCreatedAssets.slice(-Math.max(50, Math.floor(p.userCreatedAssets.length / 2)));
        });
        try { tryWrite(); } catch (e2) { console.warn('[persist] quota exceeded after eviction', e2); }
      } else {
        console.warn('[persist] write failed', e);
      }
    }
  }

  async function loadPersistedState() {
    let raw;
    try {
      if (APP_CONFIG.persistence !== 'localStorage') {
        const data = await apiJson('/api/state');
        if (data && data.state) raw = JSON.stringify(data.state);
      }
    } catch (e) {
      console.warn('[persist] server read failed; trying localStorage', e);
    }
    try { raw = raw || localStorage.getItem(PERSIST_KEY); } catch (e) { console.warn('[persist] read failed', e); return; }
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { console.warn('[persist] corrupt JSON', e); return; }
    if (!parsed || parsed.version !== PERSIST_VERSION || !Array.isArray(parsed.projects)) return;

    if (parsed.ui) {
      if (typeof parsed.ui.splitRatio === 'number') state.libraryUI.splitRatio = parsed.ui.splitRatio;
      if (parsed.ui.rightPanelTab === 'files' || parsed.ui.rightPanelTab === 'browser') state.rightPanelTab = parsed.ui.rightPanelTab;
      if (typeof parsed.ui.libTreeCollapsed === 'boolean') state.libraryUI.treeCollapsed = parsed.ui.libTreeCollapsed;
    }

    if (Array.isArray(parsed.favoritePrompts)) state.favoritePrompts = parsed.favoritePrompts;
    if (Array.isArray(parsed.customSkills)) customSkills = parsed.customSkills;

    parsed.projects.forEach(persisted => {
      const proj = state.projects.find(p => p.id === persisted.id);
      if (!proj) return;

      if (Array.isArray(persisted.folders) && persisted.folders.length > 0) {
        proj.folders = persisted.folders.map(f => ({ ...f }));
        if (!proj.folders.find(f => f.id === 'f_default')) {
          proj.folders.unshift({ id: 'f_default', name: '默认', parentId: null, createdAt: Date.now(), isDefault: true });
        }
      }

      const folderIds = new Set(proj.folders.map(f => f.id));
      const map = persisted.assetFolderMap || {};
      const nameMap = persisted.assetNameMap || {};
      const annMap = persisted.assetAnnotationsMap || {};
      ASSET_TYPES.forEach(type => {
        (proj.assets[type] || []).forEach(a => {
          if (map[a.id] && folderIds.has(map[a.id])) a.folderId = map[a.id];
          if (nameMap[a.id]) a.name = nameMap[a.id];
          if (annMap[a.id]) a.annotations = annMap[a.id];
        });
      });

      const existingIds = new Set();
      ASSET_TYPES.forEach(type => (proj.assets[type] || []).forEach(a => existingIds.add(a.id)));
      (persisted.userCreatedAssets || []).forEach(ua => {
        if (existingIds.has(ua.id)) return;
        const t = ua._type;
        if (!ASSET_TYPES.includes(t)) return;
        const { _type, ...rest } = ua;
        if (!folderIds.has(rest.folderId)) rest.folderId = 'f_default';
        rest._userCreated = true;
        if (!proj.assets[t]) proj.assets[t] = [];
        proj.assets[t].push(rest);
      });

      // ── session folders + sessions
      if (Array.isArray(persisted.sessionFolders) && persisted.sessionFolders.length > 0) {
        proj.sessionFolders = persisted.sessionFolders.map(f => ({ ...f })).filter(f => f.id !== 'sf_default');
      }
      if (!proj.sessionFolders) proj.sessionFolders = [];
      if (!proj.sessionFolders.find(f => f.isArchive)) {
        proj.sessionFolders.push({ id: 'sf_archive', name: '归档', parentId: null, isArchive: true, createdAt: Date.now() });
      }
      const sfIds = new Set((proj.sessionFolders || []).map(f => f.id));
      const sessionMeta = persisted.sessionMeta || {};
      (proj.sessions || []).forEach(s => {
        const meta = sessionMeta[s.id];
        if (!meta) return;
        if (meta.name) s.name = meta.name;
        if (meta.folderId === null || (meta.folderId && sfIds.has(meta.folderId))) s.folderId = meta.folderId;
        else if (meta.folderId === 'sf_default') s.folderId = null;
      });
      const existingSessionIds = new Set((proj.sessions || []).map(s => s.id));
      (persisted.userSessions || []).forEach(us => {
        if (existingSessionIds.has(us.id)) return;
        const folderId = (us.folderId == null || us.folderId === 'sf_default') ? null
          : (sfIds.has(us.folderId) ? us.folderId : null);
        proj.sessions.push({ ...us, folderId, _userCreated: true });
      });

      if (persisted.name) proj.name = persisted.name;
      if (persisted.archived) proj.archived = true;
    });
  }

  // ───── helpers ─────
  const $  = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const escapeWithMentions = s => escape(s)
    .replace(/(@[一-龥\w]+(?:\(v\d+\))?)/g, '<span class="text-indigo-600">$1</span>')
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  const icon = (name, extra = '') => `<i data-lucide="${name}"${extra ? ' class="' + extra + '"' : ''}></i>`;

  function renderIcons() {
    if (window.lucide && window.lucide.createIcons) {
      try { window.lucide.createIcons(); } catch (e) { /* noop */ }
    }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  function renderProfile() {
    $('#profileName').textContent = state.user ? state.user.name : '未登录';
  }

  function toggleProfileMenu(force) {
    const menu = $('#profileMenu');
    const show = force != null ? force : !menu.classList.contains('show');
    menu.classList.toggle('show', show);
  }

  function loginDialog() {
    return new Promise(resolve => {
      const mask = $('#loginMask');
      const u = $('#loginUsername');
      const p = $('#loginPassword');
      u.value = '';
      p.value = '';
      mask.classList.add('show');
      setTimeout(() => u.focus(), 50);
      const close = (val) => {
        mask.classList.remove('show');
        $('#loginSubmit').onclick = null;
        $('#loginCancel').onclick = null;
        mask.onclick = null;
        u.onkeydown = null;
        p.onkeydown = null;
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const submit = () => {
        const name = u.value.trim();
        const pwd = p.value;
        if (!name) { u.focus(); toast('请输入账号'); return; }
        if (!pwd)  { p.focus(); toast('请输入密码'); return; }
        close({ name });
      };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      $('#loginSubmit').onclick = submit;
      $('#loginCancel').onclick = () => close(null);
      mask.onclick = (e) => { if (e.target === mask) close(null); };
      const enterToSubmit = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      u.onkeydown = enterToSubmit;
      p.onkeydown = enterToSubmit;
      document.addEventListener('keydown', onKey);
    });
  }

  async function onProfileClick() {
    if (state.user) {
      toggleProfileMenu();
    } else {
      const result = await loginDialog();
      if (result) {
        state.user = { name: result.name };
        renderProfile();
        toast('登录成功');
      }
    }
  }

  function logout() {
    state.user = null;
    toggleProfileMenu(false);
    renderProfile();
    toast('已退出登录');
  }

  function confirmDialog({ title = '确认操作', message = '', okText = '确认', cancelText = '取消' } = {}) {
    return new Promise(resolve => {
      const mask = $('#confirmMask');
      $('#confirmTitle').textContent = title;
      $('#confirmMessage').textContent = message;
      $('#confirmOk').textContent = okText;
      $('#confirmCancel').textContent = cancelText;
      mask.classList.add('show');
      const close = (val) => {
        mask.classList.remove('show');
        $('#confirmOk').onclick = null;
        $('#confirmCancel').onclick = null;
        mask.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
        else if (e.key === 'Enter') close(true);
      };
      $('#confirmOk').onclick = () => close(true);
      $('#confirmCancel').onclick = () => close(false);
      mask.onclick = (e) => { if (e.target === mask) close(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  const currentProject = () => state.projects.find(p => p.id === state.currentProjectId);
  const currentSession = () => {
    const p = currentProject();
    return p ? p.sessions.find(s => s.id === state.currentSessionId) : null;
  };
  const sessionName = (projectId, sessionId) => {
    const p = state.projects.find(x => x.id === projectId);
    const s = p?.sessions.find(x => x.id === sessionId);
    return s ? s.name : '';
  };

  // ───── left panel · nested projects/sessions ─────
  function renderProjects() {
    const list = $('#projectList');
    list.innerHTML = '';
    state.projects.filter(p => !p.archived).forEach(p => {
      const expanded = state.expandedProjects.has(p.id);
      const isCurrentProj = p.id === state.currentProjectId;

      const isExample = p.id === 'p_drama';
      const projRow = el('div', 'project-row' + (isCurrentProj ? ' current' : ''));
      projRow.innerHTML =
        `${icon(expanded ? 'chevron-down' : 'chevron-right', 'chev')}` +
        `${icon('folder')}` +
        `<span class="truncate flex-1 row-name">${escape(p.name)}</span>` +
        (isExample ? `<span class="example-badge" title="示例项目，演示三步工作流">示例</span>` : '') +
        `<div class="row-actions">` +
          `<button class="row-action" data-act="addnew" title="新建子文件夹/会话">${icon('plus')}</button>` +
          `<button class="row-action" data-act="rename" title="重命名">${icon('pencil')}</button>` +
          `<button class="row-action" data-act="archive" title="归档">${icon('archive')}</button>` +
        `</div>`;
      projRow.onclick = () => toggleProject(p.id);
      projRow.querySelector('[data-act="rename"]').onclick = (e) => {
        e.stopPropagation();
        startRename(projRow.querySelector('.row-name'), p.name, v => { p.name = v; renderProjects(); renderHeader(); });
      };
      projRow.querySelector('[data-act="archive"]').onclick = (e) => {
        e.stopPropagation();
        archiveProject(p.id);
      };
      projRow.querySelector('[data-act="addnew"]').onclick = (e) => {
        e.stopPropagation();
        state.expandedProjects.add(p.id);
        openCreateMenu(e.currentTarget, p.id, null);
      };
      list.appendChild(projRow);

      if (expanded) {
        // 1. Root-level sessions (folderId == null/undefined, not archived/in-folder)
        const rootSessions = (p.sessions || []).filter(s => !s.folderId);
        rootSessions.forEach(s => renderSessionRow(list, p, s, 1));

        // 2. User-created folders (excluding archive)
        const userFolders = (p.sessionFolders || [])
          .filter(f => !f.isArchive && (f.parentId || null) === null);
        if (rootSessions.length > 0 && userFolders.length > 0) {
          renderSidebarDivider(list);
        }
        userFolders.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        userFolders.forEach(folder => renderSessionFolderTreeNode(list, p, folder, 1));

        // 3. Empty-state hint — only when project root has 0 sessions + 0 user folders
        if (rootSessions.length === 0 && userFolders.length === 0) {
          renderEmptyCreateHint(list, p.id, null, 1);
        }

        // 4. Archive folder always at bottom
        const archive = (p.sessionFolders || []).find(f => f.isArchive);
        if (archive) {
          if (rootSessions.length > 0 || userFolders.length > 0) renderSidebarDivider(list);
          renderSessionFolderTreeNode(list, p, archive, 1);
        }
      }
    });
    renderIcons();
  }

  function renderSidebarDivider(list) {
    const d = el('div', 'sidebar-divider');
    list.appendChild(d);
  }

  function renderSessionFolderTreeNode(list, project, folder, depth) {
    renderSessionFolderRow(list, project, folder, depth);
    if (state.expandedSessionFolders.has(folder.id)) {
      // Subfolders first (excluding archive — archive can't have children)
      const children = (project.sessionFolders || [])
        .filter(f => !f.isArchive && f.parentId === folder.id)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      children.forEach(c => renderSessionFolderTreeNode(list, project, c, depth + 1));
      // Sessions in this folder
      const sessionsInFolder = (project.sessions || []).filter(s => s.folderId === folder.id);
      sessionsInFolder.forEach(s => renderSessionRow(list, project, s, depth + 1));
      // Empty-state hint inside non-archive folders only when no children at all
      if (!folder.isArchive && children.length === 0 && sessionsInFolder.length === 0) {
        renderEmptyCreateHint(list, project.id, folder.id, depth + 1);
      }
    }
  }

  function renderSessionFolderRow(list, project, folder, depth) {
    const expanded = state.expandedSessionFolders.has(folder.id);
    const isArchive = folder.isArchive;
    const row = el('div', 'sf-row' + (isArchive ? ' is-archive' : ''));
    row.style.paddingLeft = (4 + depth * 14) + 'px';
    row.dataset.folderId = folder.id;
    const folderIcon = isArchive ? 'archive' : (expanded ? 'folder-open' : 'folder');
    row.innerHTML =
      `<i data-lucide="chevron-right" class="sf-chev${expanded ? ' expanded' : ''}"></i>` +
      `<i data-lucide="${folderIcon}" class="sf-icon${isArchive ? ' is-archive' : ''}"></i>` +
      `<span class="truncate flex-1 row-name">${escape(folder.name)}</span>` +
      (isArchive ? '' :
        `<div class="row-actions">` +
          `<button class="row-action" data-act="addnew" title="新建子文件夹/会话">${icon('plus')}</button>` +
          `<button class="row-action" data-act="rename" title="重命名">${icon('pencil')}</button>` +
          `<button class="row-action" data-act="archivefolder" title="归档此文件夹">${icon('archive')}</button>` +
          `<button class="row-action" data-act="delete" title="删除">${icon('trash-2')}</button>` +
        `</div>`
      );
    row.onclick = (e) => {
      e.stopPropagation();
      if (expanded) state.expandedSessionFolders.delete(folder.id);
      else state.expandedSessionFolders.add(folder.id);
      renderProjects();
    };
    if (!isArchive) {
      row.querySelector('[data-act="addnew"]').onclick = (e) => {
        e.stopPropagation();
        state.expandedSessionFolders.add(folder.id);
        openCreateMenu(e.currentTarget, project.id, folder.id);
      };
      row.querySelector('[data-act="rename"]').onclick = (e) => {
        e.stopPropagation();
        startRename(row.querySelector('.row-name'), folder.name, v => { folder.name = v; renderProjects(); persistState(); });
      };
      row.querySelector('[data-act="archivefolder"]').onclick = (e) => {
        e.stopPropagation();
        archiveSessionFolder(project, folder.id);
      };
      row.querySelector('[data-act="delete"]').onclick = (e) => {
        e.stopPropagation();
        deleteSessionFolder(project, folder.id);
      };
    }
    list.appendChild(row);
  }

  function renderSessionRow(list, project, s, depth) {
    const active = project.id === state.currentProjectId && s.id === state.currentSessionId;
    const isArchived = s.folderId === 'sf_archive';
    const sRow = el('div', 'session-row' + (active ? ' active' : '') + (isArchived ? ' is-archived' : ''));
    sRow.style.paddingLeft = (10 + depth * 14) + 'px';
    const typeIcon = SESSION_TYPE_ICON[s.type] || 'message-circle';
    const typeTitle = '类型：' + (SESSION_TYPE_LABEL[s.type] || s.type || '文本');
    const archiveBtn = isArchived
      ? `<button class="row-action" data-act="unarchive" title="移出归档">${icon('archive-restore')}</button>`
      : `<button class="row-action" data-act="archive" title="归档">${icon('archive')}</button>`;
    sRow.innerHTML =
      `<i data-lucide="${typeIcon}" class="session-type-icon" title="${typeTitle}"></i>` +
      `<span class="truncate flex-1 row-name">${escape(s.name)}</span>` +
      `<div class="row-actions">` +
        `<button class="row-action" data-act="rename" title="重命名">${icon('pencil')}</button>` +
        archiveBtn +
      `</div>`;
    sRow.onclick = (e) => { e.stopPropagation(); switchSession(project.id, s.id); };
    sRow.querySelector('[data-act="rename"]').onclick = (e) => {
      e.stopPropagation();
      startRename(sRow.querySelector('.row-name'), s.name, v => { s.name = v; renderProjects(); renderHeader(); persistState(); });
    };
    const archiveActBtn = sRow.querySelector('[data-act="archive"]');
    if (archiveActBtn) archiveActBtn.onclick = (e) => {
      e.stopPropagation();
      archiveSession(project.id, s.id);
    };
    const unarchiveBtn = sRow.querySelector('[data-act="unarchive"]');
    if (unarchiveBtn) unarchiveBtn.onclick = (e) => {
      e.stopPropagation();
      unarchiveSession(project.id, s.id);
    };
    list.appendChild(sRow);
  }

  function renderEmptyCreateHint(list, projectId, parentFolderId, depth) {
    const hint = el('div', 'create-hint-row');
    hint.style.marginLeft = (10 + depth * 14) + 'px';
    hint.innerHTML = `${icon('plus')}<span>新建子文件夹 / 会话</span>`;
    hint.onclick = (e) => {
      e.stopPropagation();
      openCreateMenu(hint, projectId, parentFolderId);
    };
    list.appendChild(hint);
  }

  function openCreateMenu(anchor, projectId, parentFolderId) {
    closeCreateMenu();
    const menu = document.createElement('div');
    menu.className = 'session-type-picker create-menu';
    menu.innerHTML = `
      <button data-act="folder"><i data-lucide="folder-plus"></i><span>新建子文件夹</span></button>
      <div class="create-menu-sep"></div>
      <button data-act="session" data-type="text"><i data-lucide="message-circle"></i><span>新建文本会话</span></button>
      <button data-act="session" data-type="image"><i data-lucide="image"></i><span>新建图片会话</span></button>
      <button data-act="session" data-type="video"><i data-lucide="video"></i><span>新建视频会话</span></button>
    `;
    document.body.appendChild(menu);
    _createMenuEl = menu;
    renderIcons();

    const r = anchor.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 4;
    if (left + 200 > window.innerWidth) left = window.innerWidth - 208;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    const project = state.projects.find(p => p.id === projectId);
    menu.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'folder' && project) {
          createSessionFolderInline(project, parentFolderId);
        } else if (act === 'session') {
          addSession(projectId, b.dataset.type, parentFolderId);
        }
        closeCreateMenu();
      };
    });

    setTimeout(() => {
      const onDocClick = (e) => {
        if (!menu.contains(e.target)) {
          closeCreateMenu();
          document.removeEventListener('mousedown', onDocClick, true);
        }
      };
      document.addEventListener('mousedown', onDocClick, true);
      const onKey = (e) => {
        if (e.key === 'Escape') {
          closeCreateMenu();
          document.removeEventListener('keydown', onKey, true);
        }
      };
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  let _createMenuEl = null;
  function closeCreateMenu() {
    if (_createMenuEl) { _createMenuEl.remove(); _createMenuEl = null; }
  }

  function newSfId() {
    return 'sf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function createSessionFolderInline(project, parentId) {
    const folder = { id: newSfId(), name: '新建文件夹', parentId: parentId || null, createdAt: Date.now() };
    project.sessionFolders.push(folder);
    if (parentId) state.expandedSessionFolders.add(parentId);
    renderProjects();
    setTimeout(() => {
      const row = document.querySelector(`.sf-row[data-folder-id="${folder.id}"] .row-name`);
      if (row) startRename(row, folder.name, v => { folder.name = v; renderProjects(); persistState(); });
    }, 30);
  }

  async function deleteSessionFolder(project, folderId) {
    const folder = project.sessionFolders.find(f => f.id === folderId);
    if (!folder || folder.isArchive) return;
    // Collect descendant folder ids
    const ids = new Set([folderId]);
    let added = true;
    while (added) {
      added = false;
      project.sessionFolders.forEach(f => {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); added = true; }
      });
    }
    const sessionCount = (project.sessions || []).filter(s => ids.has(s.folderId)).length;
    const ok = await confirmDialog({
      title: '删除文件夹「' + folder.name + '」?',
      message: '该文件夹及子文件夹下的 ' + sessionCount + ' 个会话将移到项目根级。',
      okText: '删除', cancelText: '取消'
    });
    if (!ok) return;
    (project.sessions || []).forEach(s => { if (ids.has(s.folderId)) s.folderId = null; });
    project.sessionFolders = project.sessionFolders.filter(f => !ids.has(f.id));
    renderProjects();
    persistState();
    toast('已删除');
  }

  async function archiveSessionFolder(project, folderId) {
    const folder = (project.sessionFolders || []).find(f => f.id === folderId);
    if (!folder || folder.isArchive) return;
    const hasChildFolder = (project.sessionFolders || []).some(f => f.parentId === folderId);
    if (hasChildFolder) {
      toast('请先归档或删除子文件夹');
      return;
    }
    const sessions = (project.sessions || []).filter(s => s.folderId === folderId);
    const ok = await confirmDialog({
      title: '归档文件夹「' + folder.name + '」?',
      message: '该文件夹下 ' + sessions.length + ' 个会话将移入归档，文件夹将被移除。',
      okText: '归档', cancelText: '取消'
    });
    if (!ok) return;
    sessions.forEach(s => { s.folderId = 'sf_archive'; });
    project.sessionFolders = project.sessionFolders.filter(f => f.id !== folderId);
    state.expandedSessionFolders.delete(folderId);
    state.expandedSessionFolders.add('sf_archive');
    if (state.currentSessionId && sessions.some(s => s.id === state.currentSessionId)) {
      const next = (project.sessions || []).find(s => s.folderId !== 'sf_archive');
      state.currentSessionId = next ? next.id : null;
      renderHeader();
      renderMessages();
      renderAttachArea();
      rebuildDropdowns();
    }
    renderProjects();
    persistState();
    toast('已归档');
  }

  function startRename(nameEl, currentName, onSave) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'inline-rename ' + nameEl.className;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== currentName) onSave(v);
      else renderProjects();
    };
    input.onblur = () => finish(true);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    input.onclick = (e) => e.stopPropagation();
  }

  async function archiveSession(projectId, sessionId) {
    const p = state.projects.find(x => x.id === projectId);
    if (!p) return;
    const s = p.sessions.find(x => x.id === sessionId);
    if (!s || s.folderId === 'sf_archive') return;
    const ok = await confirmDialog({
      title: '归档会话',
      message: `确认将会话「${s.name}」移到归档?可在归档文件夹里随时还原。`,
      okText: '归档'
    });
    if (!ok) return;
    s.folderId = 'sf_archive';
    state.expandedSessionFolders.add('sf_archive');
    if (state.currentSessionId === sessionId) {
      // Switch to first non-archived session, or null
      const next = p.sessions.find(x => x.folderId !== 'sf_archive' && x.id !== sessionId);
      state.currentSessionId = next ? next.id : null;
    }
    renderProjects();
    renderHeader();
    renderMessages();
    renderAttachArea();
    rebuildDropdowns();
    persistState();
    toast('已归档');
  }

  function unarchiveSession(projectId, sessionId) {
    const p = state.projects.find(x => x.id === projectId);
    if (!p) return;
    const s = p.sessions.find(x => x.id === sessionId);
    if (!s) return;
    s.folderId = null;
    renderProjects();
    persistState();
    toast('已移出归档');
  }

  async function archiveProject(projectId) {
    const p = state.projects.find(x => x.id === projectId);
    if (!p) return;
    if (state.projects.filter(x => !x.archived).length <= 1) { toast('至少保留一个项目'); return; }
    const ok = await confirmDialog({
      title: '归档项目',
      message: `确认将项目「${p.name}」归档?项目下所有会话都会一并隐藏。`,
      okText: '归档'
    });
    if (!ok) return;
    p.archived = true;
    state.expandedProjects.delete(projectId);
    if (state.currentProjectId === projectId) {
      const nextP = state.projects.find(x => !x.archived);
      if (nextP) {
        state.currentProjectId = nextP.id;
        const nextS = nextP.sessions.find(x => !x.archived);
        state.currentSessionId = nextS ? nextS.id : null;
        state.expandedProjects.add(nextP.id);
      }
    }
    renderProjects();
    renderHeader();
    renderMessages();
    renderAttachArea();
    toast('已归档');
  }

  function toggleProject(pid) {
    if (state.expandedProjects.has(pid)) {
      state.expandedProjects.delete(pid);
      renderProjects();
    } else {
      state.expandedProjects.add(pid);
      const p = state.projects.find(x => x.id === pid);
      if (p && p.sessions.length) {
        state.currentProjectId = pid;
        state.currentSessionId = p.sessions[0].id;
      }
      renderProjects();
      renderHeader();
      renderMessages();
    }
  }

  function switchSession(projectId, sessionId) {
    state.currentProjectId = projectId;
    state.currentSessionId = sessionId;
    state.refMaterials = [];
    state.frames = { first: null, last: null };
    state.messageFilter = 'all';
    state.messageFilterRange = { from: null, to: null };
    state.composedAnnotations = [];
    state.composedExamples = [];
    updateMsgTimeFilterLabel();
    // Sync controls.task to session.type (locked per session)
    const sess = currentSession();
    if (sess && sess.type) {
      state.controls.task = sess.type;
      // Reset model/skill to first available for this type
      const models = M.MODELS[sess.type] || [];
      if (models.length && !models.includes(state.controls.model)) state.controls.model = models[0];
    }
    renderProjects();
    renderHeader();
    renderMessages();
    renderAttachArea();
    if (typeof rebuildDropdowns === 'function') rebuildDropdowns();
    if (typeof renderComposerWorkbench === 'function') renderComposerWorkbench();
    setTimeout(syncControlsCompact, 50);
  }

  const SESSION_TYPE_LABEL = { text: '文本', image: '图片', video: '视频' };
  const SESSION_TYPE_ICON  = { text: 'message-circle', image: 'image', video: 'video' };

  function addSession(projectId, type, folderId) {
    const p = state.projects.find(x => x.id === projectId);
    if (!p || !type) return;
    const newSession = {
      id: 's_' + Date.now(),
      name: `会话${p.sessions.length + 1} · ${SESSION_TYPE_LABEL[type] || '新会话'}`,
      stage: 'custom',
      defaultTask: type,
      type,
      folderId: folderId == null ? null : folderId,
      refs: [],
      messages: [],
      _userCreated: true
    };
    p.sessions.push(newSession);
    state.expandedProjects.add(projectId);
    switchSession(projectId, newSession.id);
    persistState();
  }

  function addProject() {
    const id = 'p_' + Date.now();
    const newProject = {
      id, name: '新项目', templateId: 'blank', createdAt: Date.now(),
      sessions: [],
      assets: { text: [], image: [], video: [], audio: [] },
      folders: [{ id: 'f_default', name: '默认', parentId: null, isDefault: true, createdAt: Date.now() }],
      sessionFolders: [{ id: 'sf_archive', name: '归档', parentId: null, isArchive: true, createdAt: Date.now() }]
    };
    state.projects.unshift(newProject);
    state.expandedProjects.add(id);
    state.currentProjectId = id;
    state.currentSessionId = null;
    renderProjects();
    renderHeader();
    renderMessages();
    rebuildDropdowns();
    persistState();
  }

  // ───── center · header + messages ─────
  function renderHeader() {
    const proj = currentProject();
    const sess = currentSession();
    const name = proj ? proj.name : '新聊天';
    const sub = sess ? `<span class="title-sep">/</span><span class="title-sub">${escape(sess.name)}</span>` : '';
    $('#projectTitle').innerHTML = `<span>${escape(name)}</span>${sub}`;
  }

  const MSG_FILTER_OPTIONS = [
    { id: 'all',   label: '全部' },
    { id: 'today', label: '今天' },
    { id: '7d',    label: '最近 7 天' },
    { id: '30d',   label: '最近 30 天' }
  ];

  function isMessageInRange(m, filter) {
    if (filter === 'all') return true;
    if (!m.createdAt) return true;
    if (filter === 'custom') {
      const r = state.messageFilterRange || { from: null, to: null };
      if (!r.from && !r.to) return true;
      if (r.from) {
        const fromTs = new Date(r.from + 'T00:00:00').getTime();
        if (m.createdAt < fromTs) return false;
      }
      if (r.to) {
        const toTs = new Date(r.to + 'T23:59:59.999').getTime();
        if (m.createdAt > toTs) return false;
      }
      return true;
    }
    const day = 86400000;
    const cutoff = Date.now() - (filter === 'today' ? day : filter === '7d' ? 7 * day : 30 * day);
    return m.createdAt > cutoff;
  }

  function fmtDateShort(iso) {
    if (!iso) return '...';
    const parts = iso.split('-');
    return parts.length === 3 ? `${parts[1]}/${parts[2]}` : iso;
  }

  function updateMsgTimeFilterLabel() {
    const label = $('#msgTimeFilterLabel');
    if (label) {
      if (state.messageFilter === 'custom') {
        const r = state.messageFilterRange || {};
        label.textContent = `${fmtDateShort(r.from)} ~ ${fmtDateShort(r.to)}`;
      } else {
        const opt = MSG_FILTER_OPTIONS.find(o => o.id === state.messageFilter) || MSG_FILTER_OPTIONS[0];
        label.textContent = opt.label;
      }
    }
    const dd = $('#msgTimeFilterDd');
    if (dd) dd.style.display = currentSession() ? '' : 'none';
  }

  function buildMsgTimeFilterMenu() {
    const menu = $('#msgTimeFilterMenu');
    if (!menu) return;
    const today = new Date().toISOString().slice(0, 10);
    const r = state.messageFilterRange || { from: null, to: null };
    menu.innerHTML = '';

    // Custom date range row
    const rangeRow = document.createElement('div');
    rangeRow.className = 'custom-range-row';
    rangeRow.innerHTML =
      `<input type="date" id="msgFilterFrom" value="${r.from || ''}" max="${today}" placeholder="开始日期"/>` +
      `<span class="dash">−</span>` +
      `<input type="date" id="msgFilterTo" value="${r.to || ''}" max="${today}" placeholder="结束日期"/>`;
    rangeRow.onclick = (e) => e.stopPropagation();
    menu.appendChild(rangeRow);
    rangeRow.querySelector('#msgFilterFrom').onchange = (e) => {
      state.messageFilterRange.from = e.target.value || null;
      state.messageFilter = (state.messageFilterRange.from || state.messageFilterRange.to) ? 'custom' : 'all';
      updateMsgTimeFilterLabel();
      buildMsgTimeFilterMenu();
      renderMessages();
    };
    rangeRow.querySelector('#msgFilterTo').onchange = (e) => {
      state.messageFilterRange.to = e.target.value || null;
      state.messageFilter = (state.messageFilterRange.from || state.messageFilterRange.to) ? 'custom' : 'all';
      updateMsgTimeFilterLabel();
      buildMsgTimeFilterMenu();
      renderMessages();
    };

    // Separator
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);

    // Preset list
    MSG_FILTER_OPTIONS.forEach(o => {
      const b = document.createElement('button');
      const isActive = state.messageFilter === o.id;
      const checkHTML = isActive ? `<i data-lucide="check" class="check-mark"></i>` : '';
      b.innerHTML = `<span class="flex-1">${o.label}</span>${checkHTML}`;
      if (isActive) b.classList.add('selected');
      b.onclick = (e) => {
        e.stopPropagation();
        state.messageFilter = o.id;
        state.messageFilterRange = { from: null, to: null };
        updateMsgTimeFilterLabel();
        buildMsgTimeFilterMenu();
        closeDropdowns();
        renderMessages();
      };
      menu.appendChild(b);
    });
    renderIcons();
  }

  function renderMessages() {
    const list = $('#messageList');
    list.innerHTML = '';
    const sess = currentSession();
    list.classList.toggle('text-mode', !!(sess && sess.type === 'text'));
    updateMsgTimeFilterLabel();
    if (!sess) {
      // Empty project state (no current session)
      const empty = el('div', 'center-empty');
      empty.innerHTML =
        `<i data-lucide="message-square-plus"></i>` +
        `<div class="center-empty-title">还没有会话</div>` +
        `<div class="center-empty-sub">点左侧 <span class="kbd">＋ 新建会话</span> 选类型开始</div>`;
      list.appendChild(empty);
      renderIcons();
      return;
    }
    if (!sess.messages.length) {
      renderIcons();
      return;
    }
    // Auto-stamp createdAt for any message lacking one (live-pushed messages get "now")
    sess.messages.forEach(m => { if (!m.createdAt) m.createdAt = Date.now(); });
    const filtered = sess.messages.filter(m => isMessageInRange(m, state.messageFilter));
    if (filtered.length === 0) {
      const empty = el('div', 'center-empty');
      empty.innerHTML =
        `<i data-lucide="calendar-x"></i>` +
        `<div class="center-empty-title">该时间范围无消息</div>` +
        `<div class="center-empty-sub"><button class="link-btn" id="resetMsgFilter">切换到全部</button></div>`;
      list.appendChild(empty);
      renderIcons();
      const reset = $('#resetMsgFilter');
      if (reset) reset.onclick = () => {
        state.messageFilter = 'all';
        updateMsgTimeFilterLabel();
        buildMsgTimeFilterMenu();
        renderMessages();
      };
      return;
    }
    const isVisualSession = sess.type === 'image' || sess.type === 'video';
    let pendingReq = null;
    filtered.forEach((m, idx) => {
      if (!m._mid) m._mid = 'm_' + idx + '_' + Math.random().toString(36).slice(2, 6);
      if (isVisualSession) {
        if (m.role === 'user') {
          // Capture request context for following result cards (header data); don't render standalone
          pendingReq = m.request || {
            text: m.text || '',
            refs: [],
            model: state.controls.model,
            ratio: sess.type === 'image' ? state.controls.ratio : null,
            duration: sess.type === 'video' ? state.controls.duration : null
          };
        } else if (m.role === 'ref') {
          // Skip — ref attachments fold into the next JiMeng card header (best effort)
        } else if (m.role === 'ai') {
          if (m.result) {
            list.appendChild(renderJiMengCard(pendingReq, m));
          } else if (m.taskCard) {
            list.appendChild(renderTaskCard(m.taskCard));
          } else if (m.text) {
            list.appendChild(el('div', 'msg-bubble msg-ai', escapeWithMentions(m.text)));
          }
        }
      } else if (m.role === 'user') {
        if (m.request) list.appendChild(renderRequestCard(m.request));
        else list.appendChild(el('div', 'msg-bubble msg-user', escapeWithMentions(m.text || '')));
      } else if (m.role === 'ref') {
        list.appendChild(el('div', 'msg-bubble msg-ref',
          `${icon('paperclip')}<span>引用: <span class="font-medium">${escape(m.label)}</span></span>`));
      } else {
        if (m.text) list.appendChild(el('div', 'msg-bubble msg-ai', escapeWithMentions(m.text)));
        if (m.taskCard) list.appendChild(renderTaskCard(m.taskCard));
        if (m.result) list.appendChild(renderResultCard(m.result, idx, m));
        if (m.docCard) list.appendChild(renderDocCard(m.docCard, m));
        if (m.textGen) list.appendChild(renderTextGenCard(m.textGen));
        if (m.skillFile) list.appendChild(renderSkillFileCard(m.skillFile));
        if (m.qaCard) { const d = el('div', 'msg-bubble msg-ai', ''); d.innerHTML = m.qaCard; list.appendChild(d); }
      }
    });
    const area = $('#messageArea');
    area.scrollTop = area.scrollHeight;
    renderIcons();
  }

  const TASK_LABEL_MAP = { video: '视频生成', image: '图片生成', text: '文本生成', edit: '编辑视频' };

  function renderRequestCard(req) {
    const wrap = el('div', 'req-card');
    const thumbs = (req.refs || []).slice(0, 3).map(r => {
      const src = r.src || r.thumb || 'assets/placeholder-image-h.svg';
      return `<img class="req-thumb" src="${src}" alt="" />`;
    }).join('');
    const framePics = [];
    if (req.frames?.first) framePics.push(req.frames.first);
    if (req.frames?.last)  framePics.push(req.frames.last);
    const frameThumbs = framePics.map(s => `<img class="req-thumb" src="${s}" alt="" />`).join('');
    const thumbsHtml = (thumbs + frameThumbs)
      ? `<div class="req-thumbs">${thumbs + frameThumbs}</div>`
      : '';

    const chips = (req.refs || []).map((r, i) => {
      const name = r.name || (r.type === 'video' ? `视频${i+1}` : `图片${i+1}`);
      const img = r.src ? `<img src="${r.src}" alt="" />` : icon(r.type === 'video' ? 'film' : 'image');
      return `<span class="req-chip">${img}<span>@${escape(name)}</span></span>`;
    }).join('');

    const metaParts = [];
    if (req.model)    metaParts.push(escape(req.model));
    if (req.skill)    metaParts.push(escape(req.skill));
    if (req.duration) metaParts.push(escape(req.duration));
    if (req.ratio)    metaParts.push(escape(req.ratio) + (req.resolution ? ` ${escape(req.resolution)}` : ''));
    const metaHtml = metaParts.length
      ? metaParts.map(p => `<span>${p}</span>`).join('<span class="dot"></span>')
      : '';

    wrap.innerHTML =
      thumbsHtml +
      `<div class="req-body">` +
        `<div class="req-head">` +
          `<span class="req-task">${escape(TASK_LABEL_MAP[req.task] || '生成')}</span>` +
          chips +
          (req.text ? `<span style="color:#9ca3af">:</span>` : '') +
        `</div>` +
        (req.text ? `<div class="req-text">${escapeWithMentions(req.text)}</div>` : '') +
        `<div class="req-meta">${metaHtml}${metaHtml ? '<span class="dot"></span>' : ''}<span class="req-detail">详细信息${icon('info')}</span></div>` +
      `</div>`;
    return wrap;
  }

  function renderResultCard(result, msgIdx, message) {
    const wrap = el('div', 'result-wrap');
    const ratio = result.ratio || '16:9';
    const shape = ratio === '9:16' ? 'portrait' : (ratio === '1:1' ? 'square' : '');
    const card = el('div', 'result-card ' + shape + (result.status === 'running' ? ' running' : ''));

    if (result.status === 'running') {
      card.innerHTML = `<div class="spinner"></div><span>生成中…</span>`;
      if (!result._scheduled) {
        result._scheduled = true;
        setTimeout(() => {
          result.status = 'done';
          // Auto-archive on running → done transition
          if (message && !message.assetId) {
            const t = result.type === 'video' ? 'video' : 'image';
            archiveAsChatAsset(t, result, currentSession()?.id, message);
          }
          renderMessages();
        }, 1800);
      }
    } else {
      const media = result.type === 'video'
        ? `<img src="${result.src}" alt="" />`
        : `<img src="${result.src}" alt="" />`;
      const isSaved = message && message.assetId;
      const saveBtn = message ? `<button class="ov-btn chat-save-btn${isSaved ? '' : ' muted'}" title="${isSaved ? '已归档 · 点击重新分类' : '保存到文件夹'}">${icon('folder-input')}</button>` : '';
      card.innerHTML =
        media +
        `<div class="result-overlay-top">` +
          saveBtn +
          `<button class="ov-btn" title="下载">${icon('download')}</button>` +
        `</div>` +
        (result.type === 'video'
          ? `<div class="result-timer">${icon('play')}<span>00:00 / ${escape(result.duration || '00:04')}</span></div>`
          : '');
      const sb = card.querySelector('.chat-save-btn');
      if (sb && message) sb.onclick = (e) => { e.stopPropagation(); openChatSavePopover(sb, message._mid); };
    }

    const actions = el('div', 'result-actions');
    actions.innerHTML =
      `<button class="result-btn">${icon('edit-3')}<span>重新编辑</span></button>` +
      `<button class="result-btn">${icon('refresh-cw')}<span>再次生成</span></button>`;
    actions.querySelectorAll('.result-btn').forEach(b => b.onclick = () => toast('mock'));

    wrap.appendChild(card);
    if (result.status !== 'running') wrap.appendChild(actions);
    return wrap;
  }

  function formatDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ── Document text-selection annotation toolbar + popover
  let _docSelToolbar = null;
  let _docSelPopover = null;
  let _docSelGlobalCleanupBound = false;
  function hideDocSelToolbar() {
    // Defensively remove ALL toolbars, not just the tracked one (handles orphans)
    document.querySelectorAll('.doc-sel-toolbar').forEach(el => el.remove());
    _docSelToolbar = null;
  }
  function hideDocSelPopover() {
    document.querySelectorAll('.doc-sel-popover').forEach(el => el.remove());
    _docSelPopover = null;
  }

  function ensureDocSelGlobalCleanup() {
    if (_docSelGlobalCleanupBound) return;
    _docSelGlobalCleanupBound = true;
    // Selection collapsed (user clicked elsewhere or pressed Esc) → hide toolbar
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        if (_docSelToolbar) hideDocSelToolbar();
      }
    });
    // Mousedown outside both toolbar AND popover AND any doc-content → hide toolbar
    document.addEventListener('mousedown', (e) => {
      if (!_docSelToolbar && !_docSelPopover) return;
      if (e.target.closest('.doc-sel-toolbar')) return;
      if (e.target.closest('.doc-sel-popover')) return;
      if (e.target.closest('.doc-content')) return;
      hideDocSelToolbar();
    }, true);
  }

  function bindDocSelectionAnnotation(docEl, asset, type) {
    ensureDocSelGlobalCleanup();
    docEl.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) { hideDocSelToolbar(); return; }
        const text = sel.toString().trim();
        if (!text) { hideDocSelToolbar(); return; }
        const anchor = sel.anchorNode;
        if (!anchor || !docEl.contains(anchor)) { hideDocSelToolbar(); return; }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) { hideDocSelToolbar(); return; }
        showDocSelToolbar(rect, text, asset, type);
      }, 10);
    });
  }

  function showDocSelToolbar(rect, text, asset, type) {
    hideDocSelToolbar();
    hideDocSelPopover();
    const tb = document.createElement('div');
    tb.className = 'doc-sel-toolbar';
    tb.innerHTML = `${icon('pin')}<span>添加批注</span>`;
    document.body.appendChild(tb);
    _docSelToolbar = tb;
    renderIcons();
    const tbRect = tb.getBoundingClientRect();
    let top = rect.top - tbRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    let left = rect.left + (rect.width - tbRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tbRect.width - 8));
    tb.style.top = top + 'px';
    tb.style.left = left + 'px';
    tb.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      hideDocSelToolbar();
      showDocSelPopover(rect, text, asset, type);
    };
  }

  function showDocSelPopover(rect, quote, asset, type) {
    hideDocSelPopover();
    const truncated = quote.length > 80 ? quote.slice(0, 80) + '…' : quote;
    const MAX_IMAGES = 3;
    const MAX_BYTES = 2 * 1024 * 1024; // 2MB
    const ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const images = []; // local state, base64 dataURL strings
    const pop = document.createElement('div');
    pop.className = 'doc-sel-popover';
    pop.innerHTML =
      `<div class="dsp-quote">"${escape(truncated)}"</div>` +
      `<textarea class="dsp-input" rows="3" placeholder="输入批注内容…可粘贴图片" maxlength="200"></textarea>` +
      `<div class="dsp-images" id="dspImgList"></div>` +
      `<div class="dsp-attach">` +
        `<button class="dsp-attach-btn" data-act="attach" type="button">${icon('paperclip')}<span>添加图片</span></button>` +
        `<span class="dsp-attach-count" data-role="count">0/${MAX_IMAGES}</span>` +
      `</div>` +
      `<div class="dsp-foot">` +
        `<button class="dsp-btn cancel" data-act="cancel">取消</button>` +
        `<button class="dsp-btn primary" data-act="confirm" disabled>添加批注</button>` +
      `</div>` +
      `<input type="file" data-role="file-input" accept="${ACCEPT_TYPES.join(',')}" multiple style="display:none"/>`;
    document.body.appendChild(pop);
    _docSelPopover = pop;
    renderIcons();

    const positionPopover = () => {
      const popRect = pop.getBoundingClientRect();
      let top = rect.bottom + 8;
      if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
      let left = rect.left;
      if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
      pop.style.top = Math.max(8, top) + 'px';
      pop.style.left = Math.max(8, left) + 'px';
    };
    positionPopover();

    const input = pop.querySelector('.dsp-input');
    const confirmBtn = pop.querySelector('[data-act="confirm"]');
    const attachBtn = pop.querySelector('[data-act="attach"]');
    const countEl = pop.querySelector('[data-role="count"]');
    const imgListEl = pop.querySelector('#dspImgList');
    const fileInput = pop.querySelector('[data-role="file-input"]');

    const updateConfirmState = () => {
      confirmBtn.disabled = !(input.value.trim() || images.length > 0);
    };
    const renderImages = () => {
      imgListEl.innerHTML = images.map((src, idx) =>
        `<div class="dsp-img-thumb"><img src="${escape(src)}" alt="批注图"/>` +
        `<button class="dsp-img-rm" data-idx="${idx}" type="button" title="移除">×</button></div>`
      ).join('');
      countEl.textContent = `${images.length}/${MAX_IMAGES}`;
      attachBtn.disabled = images.length >= MAX_IMAGES;
      imgListEl.querySelectorAll('.dsp-img-rm').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const i = Number(btn.getAttribute('data-idx'));
          images.splice(i, 1);
          renderImages();
          updateConfirmState();
          positionPopover();
        };
      });
      positionPopover();
    };

    const tryAddFile = (file) => {
      if (!file) return;
      if (images.length >= MAX_IMAGES) { toast(`最多 ${MAX_IMAGES} 张图`); return; }
      if (!ACCEPT_TYPES.includes(file.type)) { toast('仅支持 jpg / png / webp'); return; }
      if (file.size > MAX_BYTES) { toast('单张不超过 2MB'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (images.length >= MAX_IMAGES) return;
        images.push(reader.result);
        renderImages();
        updateConfirmState();
      };
      reader.onerror = () => toast('图片读取失败');
      reader.readAsDataURL(file);
    };

    attachBtn.onclick = (e) => { e.stopPropagation(); fileInput.click(); };
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files || []);
      files.forEach(tryAddFile);
      fileInput.value = '';
    };
    pop.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let handled = false;
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { tryAddFile(f); handled = true; }
        }
      }
      if (handled) e.preventDefault();
    });

    input.addEventListener('input', updateConfirmState);
    setTimeout(() => input.focus(), 0);

    pop.querySelector('[data-act="cancel"]').onclick = (e) => { e.stopPropagation(); hideDocSelPopover(); };
    confirmBtn.onclick = (e) => {
      e.stopPropagation();
      const text = input.value.trim();
      if (!text && images.length === 0) return;
      asset.annotations = asset.annotations || [];
      const ann = {
        id: 'an_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        text,
        quote: truncated,
        createdAt: Date.now(),
        author: (state.user && state.user.name) || '我',
        _isNew: true
      };
      if (images.length) ann.images = images.slice();
      asset.annotations.push(ann);
      try {
        if (typeof persistState === 'function') persistState();
      } catch (err) {
        // localStorage quota exceeded — keep annotation in-memory but warn
        toast('存储空间不足，图片仅本次会话有效');
      }
      hideDocSelPopover();
      window.getSelection?.()?.removeAllRanges?.();
      renderAssetDetailInPane(asset, type);
      toast('已添加批注');
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        hideDocSelPopover();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => {
      const onDoc = (ev) => {
        if (!pop.contains(ev.target)) {
          hideDocSelPopover();
          document.removeEventListener('mousedown', onDoc, true);
        }
      };
      document.addEventListener('mousedown', onDoc, true);
    }, 0);
  }

  function openAddAnnotationModal(asset, onSaved) {
    const existing = document.querySelector('.fav-modal-overlay');
    if (existing) existing.remove();

    const MAX_IMAGES = 3;
    const MAX_BYTES = 2 * 1024 * 1024;
    const ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const images = [];

    const overlay = document.createElement('div');
    overlay.className = 'fav-modal-overlay';
    overlay.innerHTML = `
      <div class="fav-modal">
        <div class="fav-modal-head">
          <span class="fav-modal-title">给「${escape(asset.name || '资产')}」加批注</span>
          <span class="fav-modal-close" data-act="close">${icon('x')}</span>
        </div>
        <div class="fav-modal-body">
          <div class="fav-modal-hint">描述你想调整的地方，可附参考图；AI 之后会帮你改写提示词</div>
          <textarea class="fav-modal-input" id="annTextInput" placeholder="例如：光线太暗，应该从左上方打过来" rows="3" maxlength="200" style="resize:vertical; min-height:72px; line-height:1.55;"></textarea>
          <div class="dsp-images" data-role="img-list"></div>
          <div class="dsp-attach">
            <button class="dsp-attach-btn" data-act="attach" type="button">${icon('paperclip')}<span>添加图片</span></button>
            <span class="dsp-attach-count" data-role="count">0/${MAX_IMAGES}</span>
          </div>
          <input type="file" data-role="file-input" accept="${ACCEPT_TYPES.join(',')}" multiple style="display:none"/>
        </div>
        <div class="fav-modal-foot">
          <button class="fav-modal-btn cancel" data-act="cancel">取消</button>
          <button class="fav-modal-btn primary" data-act="confirm" disabled>确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    renderIcons();

    const input = overlay.querySelector('#annTextInput');
    const confirmBtn = overlay.querySelector('[data-act="confirm"]');
    const attachBtn = overlay.querySelector('[data-act="attach"]');
    const countEl = overlay.querySelector('[data-role="count"]');
    const imgListEl = overlay.querySelector('[data-role="img-list"]');
    const fileInput = overlay.querySelector('[data-role="file-input"]');

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const updateBtnState = () => {
      confirmBtn.disabled = !(input.value.trim() || images.length > 0);
    };
    const renderImages = () => {
      imgListEl.innerHTML = images.map((src, idx) =>
        `<div class="dsp-img-thumb"><img src="${escape(src)}" alt="批注图"/>` +
        `<button class="dsp-img-rm" data-idx="${idx}" type="button" title="移除">×</button></div>`
      ).join('');
      countEl.textContent = `${images.length}/${MAX_IMAGES}`;
      attachBtn.disabled = images.length >= MAX_IMAGES;
      imgListEl.querySelectorAll('.dsp-img-rm').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const i = Number(btn.getAttribute('data-idx'));
          images.splice(i, 1);
          renderImages();
          updateBtnState();
        };
      });
    };
    const tryAddFile = (file) => {
      if (!file) return;
      if (images.length >= MAX_IMAGES) { toast(`最多 ${MAX_IMAGES} 张图`); return; }
      if (!ACCEPT_TYPES.includes(file.type)) { toast('仅支持 jpg / png / webp'); return; }
      if (file.size > MAX_BYTES) { toast('单张不超过 2MB'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (images.length >= MAX_IMAGES) return;
        images.push(reader.result);
        renderImages();
        updateBtnState();
      };
      reader.onerror = () => toast('图片读取失败');
      reader.readAsDataURL(file);
    };

    attachBtn.onclick = (e) => { e.stopPropagation(); fileInput.click(); };
    fileInput.onchange = () => {
      Array.from(fileInput.files || []).forEach(tryAddFile);
      fileInput.value = '';
    };
    overlay.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let handled = false;
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { tryAddFile(f); handled = true; }
        }
      }
      if (handled) e.preventDefault();
    });

    input.addEventListener('input', updateBtnState);
    setTimeout(() => input.focus(), 0);

    overlay.querySelector('[data-act="close"]').onclick = close;
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    confirmBtn.onclick = () => {
      const text = input.value.trim();
      if (!text && images.length === 0) return;
      asset.annotations = asset.annotations || [];
      const ann = {
        id: 'an_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        text,
        createdAt: Date.now(),
        author: (state.user && state.user.name) || '我',
        _isNew: true
      };
      if (images.length) ann.images = images.slice();
      asset.annotations.push(ann);
      try {
        if (typeof persistState === 'function') persistState();
      } catch (err) {
        toast('存储空间不足，图片仅本次会话有效');
      }
      toast('已添加批注');
      close();
      if (onSaved) onSaved();
    };
  }

  function openFavoriteModal(prompt, imageSrc) {
    const existing = document.querySelector('.fav-modal-overlay');
    if (existing) existing.remove();

    const promptText = prompt || '';
    const defaultName = (promptText.split(/[，。！？\n]/)[0] || '未命名示例').slice(0, 20);

    const overlay = document.createElement('div');
    overlay.className = 'fav-modal-overlay';
    overlay.innerHTML = `
      <div class="fav-modal">
        <div class="fav-modal-head">
          <span class="fav-modal-title">收藏为提示词示例</span>
          <span class="fav-modal-close" data-act="close">${icon('x')}</span>
        </div>
        <div class="fav-modal-body">
          <div class="fav-modal-hint">给这个示例起个名字便于以后查找</div>
          <input type="text" class="fav-modal-input" id="favNameInput" value="${escape(defaultName)}" placeholder="示例名称" maxlength="40"/>
        </div>
        <div class="fav-modal-foot">
          <button class="fav-modal-btn cancel" data-act="cancel">取消</button>
          <button class="fav-modal-btn primary" data-act="confirm">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    renderIcons();

    const input = overlay.querySelector('#favNameInput');
    const confirmBtn = overlay.querySelector('[data-act="confirm"]');
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && document.activeElement === input) {
        e.preventDefault();
        if (!confirmBtn.disabled) confirmBtn.click();
      }
    };
    document.addEventListener('keydown', onKey);

    const updateBtnState = () => {
      confirmBtn.disabled = !input.value.trim();
    };
    input.addEventListener('input', updateBtnState);
    input.focus();
    input.select();

    overlay.querySelector('[data-act="close"]').onclick = close;
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    confirmBtn.onclick = () => {
      const name = input.value.trim();
      if (!name) return;
      state.favoritePrompts.push({ name, prompt: promptText, imageSrc: imageSrc || null, createdAt: Date.now() });
      if (typeof persistState === 'function') persistState();
      toast(`已收藏「${name}」`);
      close();
    };
  }

  function renderJiMengCard(reqCtx, aiMsg) {
    const result = aiMsg.result;
    const ratio = result.ratio || '16:9';
    const shape = ratio === '9:16' ? 'portrait' : (ratio === '1:1' ? 'square' : 'landscape');
    const sess = currentSession();
    const isVideo = result.type === 'video';
    const wrap = el('div', 'jm-wrap');

    // ── Header (refs + prompt only)
    const refs = (reqCtx && reqCtx.refs) || [];
    const thumbsHTML = refs.length
      ? `<div class="jm-thumbs">${refs.slice(0, 4).map(r =>
          `<img class="jm-thumb" src="${escape(r.src || 'assets/placeholder-image-h.svg')}" alt="" title="${escape(r.name || '')}"/>`
        ).join('')}</div>`
      : '';
    const promptText = (reqCtx && reqCtx.text) || '';
    const headerHTML = (thumbsHTML || promptText)
      ? `<div class="jm-header">` +
          thumbsHTML +
          `<div class="jm-header-body">` +
            (promptText ? `<div class="jm-prompt">${escapeWithMentions(promptText)}</div>` : '') +
          `</div>` +
        `</div>`
      : '';

    // ── Body (image/video)
    let bodyHTML;
    if (result.status === 'running') {
      bodyHTML = `<div class="jm-body running"><div class="spinner"></div><span>生成中…</span></div>`;
    } else {
      bodyHTML = `<div class="jm-body ${shape}">` +
        `<img src="${escape(result.src)}" alt=""/>` +
        (isVideo
          ? `<div class="jm-timer">${icon('play')}<span>00:00 / ${escape(result.duration || '00:04')}</span></div>`
          : '') +
      `</div>`;
    }

    // ── Bottom info row (model · ratio · resolution · [duration] · createdAt)
    const defaultModel = (sess && sess.type === 'image') ? 'GPT Image 2' : 'Seedance 2.0';
    const model = (reqCtx && reqCtx.model) || defaultModel;
    const resolution = (reqCtx && reqCtx.resolution) || '720P';
    const ratioVal = result.ratio || '16:9';
    const duration = result.duration || '5s';
    const createdAtStr = formatDateTime(aiMsg.createdAt || Date.now());
    const pair = (k, v) => `<span><span class="k">${k}</span><span class="v">${escape(v)}</span></span>`;
    const sep = `<span class="sep">·</span>`;
    const infoParts = [
      pair('模型', model),
      pair('比例', ratioVal),
      pair('分辨率', resolution)
    ];
    if (isVideo) infoParts.push(pair('秒数', duration));
    infoParts.push(pair('生成时间', createdAtStr));
    const infoRowHTML = result.status !== 'running'
      ? `<div class="jm-info-row">${infoParts.join(sep)}</div>`
      : '';

    // ── Actions (outside card)
    const actionsHTML = result.status !== 'running'
      ? `<div class="jm-actions">` +
          `<button class="jm-btn" data-act="reedit">${icon('edit-3')}<span>重新编辑</span></button>` +
          `<button class="jm-btn" data-act="regen">${icon('refresh-cw')}<span>再次生成</span></button>` +
          `<button class="jm-btn" data-act="favorite">${icon('star')}<span>收藏为提示词示例</span></button>` +
          `<button class="jm-btn" data-act="save-to-folder">${icon('folder-input')}<span>移动到文件夹</span></button>` +
        `</div>`
      : '';

    wrap.innerHTML = `<div class="jm-card">${headerHTML}${bodyHTML}${infoRowHTML}</div>${actionsHTML}`;

    // Schedule running → done
    if (result.status === 'running' && !result._scheduled) {
      result._scheduled = true;
      setTimeout(() => {
        result.status = 'done';
        if (aiMsg && !aiMsg.assetId) {
          archiveAsChatAsset(isVideo ? 'video' : 'image', result, currentSession()?.id, aiMsg);
        }
        renderMessages();
      }, 1800);
    }
    wrap.querySelectorAll('.jm-btn').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'favorite') openFavoriteModal(promptText, result.src);
        else if (act === 'save-to-folder') {
          const mid = aiMsg?._mid;
          if (mid) openChatSavePopover(b, mid);
          else toast('该消息暂无可关联的资产');
        }
        else toast('mock');
      };
    });

    return wrap;
  }

  function renderTaskCard(card) {
    const pct = Math.round(card.done / card.total * 100);
    const statusText = card.status === 'done' ? card.label + ' · 已完成' : `${card.label} · ${card.done}/${card.total}`;
    const statusIcon  = card.status === 'done' ? 'check-circle-2' : 'loader';
    const statusColor = card.status === 'done' ? 'text-emerald-600' : 'text-indigo-600';
    const node = el('div', 'task-card');
    node.innerHTML =
      `<div class="flex items-center justify-between gap-3">
        <span class="font-medium text-gray-800 truncate">${escape(statusText)}</span>
        <span class="inline-flex items-center gap-1 text-xs ${statusColor}">${icon(statusIcon)}${card.status === 'done' ? '完成' : '生成中'}</span>
      </div>
      <div class="progress"><div style="width:${pct}%;"></div></div>`;
    if (card.status === 'running' && !card._scheduled) {
      card._scheduled = true;
      setTimeout(() => {
        card.done = card.total;
        card.status = 'done';
        renderMessages();
      }, 2000);
    }
    return node;
  }


  // ───── unified attach area (top-left of textarea) ─────
  const FRAME_PLACEHOLDERS = { first: 'assets/placeholder-image-h.svg', last: 'assets/placeholder-image-h.svg' };

  function isFramesMode() {
    const modes = M.MODEL_REF_MODES[state.controls.model] || [];
    const taskHasRefMode = (M.CONTROL_MATRIX[state.controls.task] || []).includes('refMode');
    return taskHasRefMode && modes.includes('首尾帧') && state.controls.refMode === '首尾帧';
  }

  function renderAttachArea() {
    const area = $('#attachArea');
    if (!area) return;
    area.innerHTML = '';

    if (isFramesMode()) {
      ['first', 'last'].forEach((slot, i) => {
        const src = state.frames[slot];
        const label = slot === 'first' ? '首帧' : '尾帧';
        const card = el('div', 'attach-card' + (src ? ' filled' : ''));
        if (src) {
          card.innerHTML = `<img src="${src}" alt="${label}" /><span class="x">${icon('x')}</span>`;
          card.querySelector('.x').onclick = (e) => {
            e.stopPropagation();
            state.frames[slot] = null;
            renderAttachArea();
            updateSendBtn();
          };
        } else {
          card.innerHTML = `${icon('plus')}<span>${label}</span>`;
          card.onclick = () => {
            state.frames[slot] = FRAME_PLACEHOLDERS[slot];
            renderAttachArea();
            updateSendBtn();
          };
        }
        area.appendChild(card);
        if (i === 0) area.appendChild(el('div', 'attach-arrow', icon('arrow-left-right')));
      });
      renderIcons();
      return;
    }

    // Normal mode: inline horizontal row — all thumbs visible + trailing + card
    state.refMaterials.forEach((r, i) => {
      const card = el('div', 'attach-card filled');
      card.title = r.name || '附件';
      if (r.type === 'image' && r.src) {
        card.innerHTML = `<img src="${r.src}" alt="${escape(r.name || '')}" />`;
      } else if (r.type === 'video') {
        card.innerHTML = icon('film');
      } else if (r.type === 'text') {
        card.innerHTML = icon('file-text');
      } else {
        card.innerHTML = icon('paperclip');
      }
      const x = el('span', 'x', icon('x'));
      x.onclick = (e) => {
        e.stopPropagation();
        state.refMaterials.splice(i, 1);
        renderAttachArea();
        updateSendBtn();
      };
      card.appendChild(x);
      area.appendChild(card);
    });

    if (state.refMaterials.length < 12) {
      const plus = el('div', 'attach-card');
      if (state.refMaterials.length === 0) {
        plus.innerHTML = `${icon('plus')}<span>参考内容</span>`;
      } else {
        plus.innerHTML = `${icon('plus')}<span>参考</span><span class="count">${state.refMaterials.length}/12</span>`;
      }
      plus.onclick = (e) => { e.stopPropagation(); openReferenceFilePicker(); };
      area.appendChild(plus);
    }

    renderIcons();
    // Scroll to end so newly-added card is visible + refresh arrows
    requestAnimationFrame(() => {
      area.scrollLeft = area.scrollWidth;
      updateScrollArrows();
    });
  }

  function updateScrollArrows() {
    const area = $('#attachArea');
    if (!area) return;
    const canLeft  = area.scrollLeft > 2;
    const canRight = area.scrollLeft + area.clientWidth < area.scrollWidth - 2;
    $('#scrollLeft')?.classList.toggle('show', canLeft);
    $('#scrollRight')?.classList.toggle('show', canRight);
  }

  const REF_ACCEPT = [
    '.txt', '.md', '.markdown', '.json', '.csv', '.doc', '.docx', '.pdf',
    'text/plain', 'text/markdown', 'application/json', 'text/csv',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'
  ];
  const TEXT_FILE_TYPES = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv']);
  const TEXT_FILE_EXTS = /\.(txt|md|markdown|json|csv)$/i;
  const REF_FILE_MAX_BYTES = 25 * 1024 * 1024;

  function refKindFromFile(file) {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    if (TEXT_FILE_TYPES.has(file.type) || TEXT_FILE_EXTS.test(file.name)) return 'text';
    if (/(\.docx?|\.pdf)$/i.test(file.name) || /pdf|word/.test(file.type)) return 'text';
    return 'generic';
  }

  function ensureReferenceFileInput() {
    let input = $('#referenceFileInput');
    if (input) return input;
    input = document.createElement('input');
    input.id = 'referenceFileInput';
    input.type = 'file';
    input.multiple = true;
    input.accept = REF_ACCEPT.join(',');
    input.style.display = 'none';
    input.onchange = () => {
      const files = Array.from(input.files || []);
      addReferenceFiles(files);
      input.value = '';
    };
    document.body.appendChild(input);
    return input;
  }

  function openReferenceFilePicker() {
    ensureReferenceFileInput().click();
  }

  async function addReferenceFiles(files) {
    if (!files || files.length === 0) return;
    const remaining = 12 - state.refMaterials.length;
    if (remaining <= 0) { toast('最多 12 个附件'); return; }
    const selected = files.slice(0, remaining);
    if (files.length > remaining) toast('最多 12 个附件，已添加前 ' + remaining + ' 个');

    for (const file of selected) {
      if (file.size > REF_FILE_MAX_BYTES) {
        toast(file.name + ' 超过 25MB，已跳过');
        continue;
      }
      try {
        const type = refKindFromFile(file);
        const ref = {
          id: newId('ref'),
          type,
          name: file.name,
          mime: file.type || '',
          size: file.size,
          uploadedAt: Date.now()
        };
        if (type === 'image' || type === 'video' || type === 'audio') {
          ref.src = await readFileAsDataURL(file);
        } else if (TEXT_FILE_TYPES.has(file.type) || TEXT_FILE_EXTS.test(file.name)) {
          ref.body = await readFileAsText(file);
          ref.src = 'assets/placeholder-image-h.svg';
        } else {
          ref.body = `【已上传文件】${file.name}\n文件类型：${file.type || '未知'}\n大小：${Math.ceil(file.size / 1024)}KB\n\n当前版本已记录文件名和元数据；PDF/DOC/DOCX 正文解析建议在后端接入专用解析服务。`;
          ref.src = 'assets/placeholder-image-h.svg';
        }
        state.refMaterials.push(ref);
      } catch (err) {
        console.warn('[upload] failed', file.name, err);
        toast(file.name + ' 读取失败');
      }
    }
    renderAttachArea();
    updateSendBtn();
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsText(file);
    });
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  function buildTextWithUploadedDocs(text) {
    const docs = state.refMaterials.filter(r => r.type === 'text' && r.body);
    if (docs.length === 0) return text;
    const docText = docs.map((r, i) => {
      const body = String(r.body || '').slice(0, 12000);
      const clipped = String(r.body || '').length > 12000 ? '\n\n【内容已截断】' : '';
      return `## 上传文档 ${i + 1}: ${r.name}\n${body}${clipped}`;
    }).join('\n\n');
    return `${text || '请处理上传文档'}\n\n${docText}`.trim();
  }

  // ───── dropdowns (input controls) ─────
  function buildDropdown(key, options, getLabel = v => v, getIcon = null) {
    const menu = $(`#${key}Menu`);
    menu.innerHTML = '';
    options.forEach(opt => {
      const b = document.createElement('button');
      const ic = getIcon ? getIcon(opt) : null;
      b.innerHTML = (ic ? icon(ic) : '') + `<span>${escape(getLabel(opt))}</span>`;
      if (state.controls[key] === opt) b.classList.add('selected');
      b.onclick = (e) => {
        e.stopPropagation();
        state.controls[key] = opt;
        $(`#${key}Label`).textContent = getLabel(opt);
        if (key === 'task') onTaskChange();
        else if (key === 'model') onModelChange();
        else {
          buildDropdown(key, options, getLabel, getIcon);
          if (key === 'refMode') { renderAttachArea(); updateSendBtn(); }
          if (key === 'duration') updateBalance();
        }
        closeDropdowns();
        renderIcons();
      };
      menu.appendChild(b);
    });
  }

  function rebuildDropdowns() {
    const task = state.controls.task;
    buildDropdown('model', M.MODELS[task] || []);
    buildDropdown('refMode', M.MODEL_REF_MODES[state.controls.model] || []);
    buildDropdown('duration', M.DURATIONS[task] || []);
    buildRatioPicker(task);

    if (task === 'text') {
      buildSkillDropdown();
      const sk = getAllSkills().find(s => s.id === state.skill);
      if (sk) $('#skillLabel').textContent = sk.label;
      updateTokenUsage(0);
    }

    $('#modelLabel').textContent = state.controls.model;
    $('#refModeLabel').textContent = state.controls.refMode;
    $('#durationLabel').textContent = state.controls.duration;
    updateRatioLabel();

    const taskIconEl = $('#taskIcon');
    if (taskIconEl) {
      const parent = taskIconEl.parentElement;
      const fresh = document.createElement('i');
      fresh.id = 'taskIcon';
      fresh.setAttribute('data-lucide', SESSION_TYPE_ICON[task] || 'message-circle');
      parent.replaceChild(fresh, taskIconEl);
    }

    applyControlMatrix();
    updateBalance();
    renderAttachArea();
    renderIcons();
  }

  function applyControlMatrix() {
    const visible = new Set(M.CONTROL_MATRIX[state.controls.task] || []);
    visible.add('model');
    // refMode visibility also requires current model to support some modes
    const modes = M.MODEL_REF_MODES[state.controls.model] || [];
    if (!modes.length) visible.delete('refMode');
    document.querySelectorAll('[class*="ctl-"]').forEach(node => {
      const key = [...node.classList].find(c => c.startsWith('ctl-'))?.slice(4);
      if (!key) return;
      node.style.display = visible.has(key) ? '' : 'none';
    });

    // Hide entire control row if no current session (empty project)
    const sess = currentSession();
    const row = document.querySelector('.controls-row');
    const inputCard = document.querySelector('.input-card');
    if (row) row.style.visibility = sess ? '' : 'hidden';
    if (inputCard) inputCard.classList.toggle('no-session', !sess);
  }

  function syncControlsCompact() {
    const row = document.querySelector('.controls-row');
    if (!row) return;
    const rp = $('#rightPanel');
    const rpVisible = rp && rp.style.display !== 'none';
    if (!rpVisible) { row.classList.remove('compact'); return; }
    const centerW = row.closest('main')?.offsetWidth || 999;
    row.classList.toggle('compact', centerW < 580);
  }

  function onTaskChange() {
    const task = state.controls.task;
    state.controls.model = (M.MODELS[task] || [''])[0];
    state.controls.ratio = (M.RATIO_SHAPES[task] || ['16:9'])[0];
    state.controls.resolution = (M.RESOLUTIONS[task] || [''])[0];
    state.controls.duration = (M.DURATIONS[task] || [''])[0];
    const modes = M.MODEL_REF_MODES[state.controls.model] || [];
    state.controls.refMode = modes[0] || '全能参考';
    state.frames = { first: null, last: null };
    if (task === 'text') {
      state.skill = 'script-breakdown';
      state.tokenUsage = 0;
    }
    updatePlaceholder();
    rebuildDropdowns();
  }

  function updatePlaceholder() {
    const ta = $('#promptInput');
    if (!ta) return;
    if (state.controls.task === 'text') {
      ta.placeholder = '上传 1-3 个文档素材,输入文字描述你的需求。例如:上传剧本后选择技能进行处理';
    } else {
      ta.placeholder = '上传 1-12 个参考素材,输入文字,自由组合图、文、音、视频多元素。例如:@图片1 模仿动作';
    }
  }

  function onModelChange() {
    const modes = M.MODEL_REF_MODES[state.controls.model] || [];
    if (!modes.includes(state.controls.refMode)) {
      state.controls.refMode = modes[0] || '全能参考';
    }
    if (state.controls.refMode !== '首尾帧') {
      state.frames = { first: null, last: null };
    }
    rebuildDropdowns();
  }

  // ───── ratio + resolution picker ─────
  function buildRatioPicker(task) {
    const ratios = M.RATIO_SHAPES[task] || [];
    const resolutions = M.RESOLUTIONS[task] || [];
    const rEl = $('#rpRatios');
    const resEl = $('#rpResolutions');
    if (!rEl || !resEl) return;

    // Build ratio option buttons with proportional shape
    rEl.innerHTML = '';
    ratios.forEach(r => {
      const [w, h] = r.split(':').map(Number);
      // Equal-area scaling: each shape has the same "visual weight"
      const targetArea = 280;
      const aspect = w / h;
      let rw = Math.sqrt(targetArea * aspect);
      let rh = Math.sqrt(targetArea / aspect);
      // Cap within the 30x26 box so wide/tall extremes don't overflow
      const maxW = 26, maxH = 22;
      const clamp = Math.min(1, maxW / rw, maxH / rh);
      rw = Math.round(rw * clamp);
      rh = Math.round(rh * clamp);
      const btn = document.createElement('div');
      btn.className = 'ratio-option' + (r === state.controls.ratio ? ' selected' : '');
      btn.innerHTML =
        `<div class="ratio-shape-box"><div class="ratio-shape" style="width:${rw}px;height:${rh}px;"></div></div>` +
        `<div class="ratio-label">${r}</div>`;
      btn.onclick = (e) => {
        e.stopPropagation();
        state.controls.ratio = r;
        buildRatioPicker(task);
        updateRatioLabel();
      };
      rEl.appendChild(btn);
    });

    resEl.innerHTML = '';
    resolutions.forEach(res => {
      const btn = document.createElement('div');
      btn.className = 'res-option' + (res === state.controls.resolution ? ' selected' : '');
      btn.textContent = res;
      btn.onclick = (e) => {
        e.stopPropagation();
        state.controls.resolution = res;
        buildRatioPicker(task);
        updateRatioLabel();
      };
      resEl.appendChild(btn);
    });
  }

  function updateRatioLabel() {
    const r = state.controls.ratio || '';
    const res = state.controls.resolution || '';
    $('#ratioLabel').textContent = res ? `${r} | ${res}` : r;
  }

  function computeCost() {
    const task = state.controls.task;
    const model = state.controls.model || '';
    if (task === 'video') {
      const secs = parseInt(String(state.controls.duration || '5').replace(/\D/g, ''), 10) || 5;
      const perSec = /fast/i.test(model) ? 1 : 2;
      return secs * perSec;
    }
    if (task === 'image') {
      if (/pro/i.test(model))        return 6;
      if (/midjourney/i.test(model)) return 5;
      return 4;
    }
    return 0;
  }

  function updateBalance() {
    $('#balanceLabel').textContent = computeCost();
    const pill = $('#balancePill');
    pill.setAttribute('title', '本次生成消耗的积分');
    const ic = pill.querySelector('i, svg');
    if (ic && ic.getAttribute('data-lucide') !== 'gem') {
      const fresh = document.createElement('i');
      fresh.setAttribute('data-lucide', 'gem');
      pill.replaceChild(fresh, ic);
    }
  }

  function closeDropdowns() {
    $$('.dropdown.open').forEach(d => d.classList.remove('open'));
    toggleProfileMenu(false);
    closeCreateMenu();
  }

  // ───── send ─────
  const PROMPT_MAX_H = 640;
  function autoResizePrompt() {
    const ta = $('#promptInput');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, PROMPT_MAX_H) + 'px';
  }

  function updateSendBtn() {
    const hasText = $('#promptInput').value.trim().length > 0;
    const hasRefs = state.refMaterials.length > 0;
    const hasFrames = !!(state.frames.first || state.frames.last);
    const hasAnnotations = state.annotations.length > 0;
    $('#sendBtn').classList.toggle('disabled', !(hasText || hasRefs || hasFrames || hasAnnotations));
  }

  const VIDEO_MOCK_POOL = ['assets/placeholder-video-h.svg'];
  const IMAGE_MOCK_POOL = ['assets/placeholder-image-h.svg'];

  function send() {
    const input = $('#promptInput');
    const text = input.value.trim();
    const hasFrames = !!(state.frames.first || state.frames.last);
    const hasAnnotations = state.annotations.length > 0;
    if (!text && state.refMaterials.length === 0 && !hasFrames && !hasAnnotations) return;
    const sess = currentSession();
    if (!sess) return;

    const task = state.controls.task;
    const refs = state.refMaterials.map((r, i) => ({
      type: r.type || 'image',
      src:  r.src || 'assets/placeholder-image-h.svg',
      name: r.name || (r.type === 'video' ? `视频${i+1}` : `图片${i+1}`)
    }));
    const textWithUploads = task === 'text' ? buildTextWithUploadedDocs(text) : text;

    if (task === 'text') {
      const sk = getAllSkills().find(s => s.id === state.skill);
      const skillLabel = sk ? sk.label : '技能';

      if (state._skillCreationMode) {
        sess.messages.push({ role: 'user', text: textWithUploads || '请生成技能' });
        const skillName = textWithUploads.match(/["""](.+?)["""]/) ? textWithUploads.match(/["""](.+?)["""]/)[1] : '角色分析';
        sess.messages.push({ role: 'ai', text: `已根据你的描述生成技能「${skillName}」，请下载后通过「上传技能」导入使用。`, skillFile: skillName });
        state._skillCreationMode = false;
      } else if (hasAnnotations) {
        const annText = state.annotations.map((a, i) => `批注${i+1}: "${a.quote.substring(0, 40)}..." → ${a.comment}`).join('\n');
        sess.messages.push({
          role: 'user',
          request: { task, text: (textWithUploads ? textWithUploads + '\n\n' : '') + annText, refs, model: state.controls.model, skill: skillLabel }
        });
        const doc = M.TEXT_DOC_MOCK;
        const newVersion = (doc.version || 1) + 1;
        const updatedDoc = { ...doc, version: newVersion, updateNote: `已根据 ${state.annotations.length} 条批注更新` };
        sess.messages.push({
          role: 'ai',
          text: `已根据你的 ${state.annotations.length} 条批注更新了文档。`,
          docCard: updatedDoc
        });
        state.annotations = [];
        updateAnnotationChip();
        updateTokenUsage(Math.floor(Math.random() * 8000) + 3000);
      } else if (state.skill === 'storyboard' && !state._storyboardQA) {
        sess.messages.push({
          role: 'user',
          request: { task, text: textWithUploads, refs, model: state.controls.model, skill: skillLabel }
        });
        startStoryboardQA(textWithUploads);
      } else {
        sess.messages.push({
          role: 'user',
          request: { task, text: textWithUploads, refs, model: state.controls.model, skill: skillLabel }
        });
        const genMsg = { role: 'ai', textGen: { pct: 0, skillLabel, model: state.controls.model } };
        sess.messages.push(genMsg);
        renderMessages();
        executeSkill(state.skill, textWithUploads, sess, genMsg, skillLabel);
      }
    } else {
      sess.messages.push({
        role: 'user',
        request: {
          task,
          text,
          refs,
          frames: hasFrames ? { ...state.frames } : null,
          model: state.controls.model,
          duration: task === 'video' ? state.controls.duration : null,
          ratio: state.controls.ratio,
          resolution: state.controls.resolution
        }
      });

      const pool = task === 'image' ? IMAGE_MOCK_POOL : VIDEO_MOCK_POOL;
      const src  = pool[Math.floor(Math.random() * pool.length)];
      const secs = parseInt((state.controls.duration || '4').replace(/\D/g, ''), 10) || 4;
      const timerLabel = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      sess.messages.push({
        role: 'ai',
        result: {
          type: task === 'image' ? 'image' : 'video',
          src,
          duration: task === 'video' ? timerLabel : null,
          ratio: state.controls.ratio,
          status: 'running'
        }
      });
    }

    input.value = '';
    state.refMaterials = [];
    state.frames = { first: null, last: null };
    state.composedAnnotations = [];
    state.composedExamples = [];
    renderAttachArea();
    autoResizePrompt();
    updateSendBtn();
    renderMessages();
    renderComposerWorkbench();
  }

  // ───── skill execution ─────
  async function executeSkill(skillId, userText, sess, genMsg, skillLabel) {
    try {
      let systemPrompt;
      if (skillId === 'script-breakdown') {
        systemPrompt = await loadSkillPrompt('剧本拆解.md');
      } else if (skillId === 'storyboard') {
        systemPrompt = await loadSkillPrompt('分镜脚本.md');
        const qa = state._storyboardQA;
        if (qa) {
          systemPrompt = systemPrompt
            .replace('{projectType}', qa.projectType || '')
            .replace('{aspectRatio}', qa.aspectRatio || '')
            .replace('{styleRef}', qa.styleRef || '')
            .replace('{episodes}', qa.episodes || '1')
            .replace('{duration}', qa.duration || '60s');
        }
      } else {
        genMsg.textGen.pct = 100;
        const idx = sess.messages.indexOf(genMsg);
        if (idx >= 0) sess.messages.splice(idx, 1);
        sess.messages.push({ role: 'ai', text: '该技能暂未配置 Prompt 文件。' });
        renderMessages();
        return;
      }

      const { text: resultText, usage } = await callLLM(systemPrompt, userText, (fullSoFar) => {
        const len = fullSoFar.length;
        genMsg.textGen.pct = Math.min(95, Math.floor(len / 100));
        renderMessages();
      });

      const idx = sess.messages.indexOf(genMsg);
      if (idx >= 0) sess.messages.splice(idx, 1);

      let parsed;
      try { parsed = JSON.parse(resultText); } catch (e) {
        const preview = resultText.substring(0, 300);
        sess.messages.push({ role: 'ai', text: '返回数据解析失败（非合法 JSON），请重试。\n\n原始输出预览：\n' + preview + (resultText.length > 300 ? '...' : '') });
        toast('JSON 解析失败');
        renderMessages();
        return;
      }

      if (!parsed || typeof parsed !== 'object') {
        sess.messages.push({ role: 'ai', text: '返回数据格式异常，请重试。' });
        toast('数据格式异常');
        renderMessages();
        return;
      }

      const doc = {
        title: skillId === 'script-breakdown' ? '剧本拆解报告' : '分镜脚本',
        version: 1,
        type: skillId,
        data: parsed,
        content: ''
      };

      const docMsg = {
        role: 'ai',
        text: `基于您上传的剧本，已完成${skillLabel}分析。`,
        docCard: doc
      };
      sess.messages.push(docMsg);
      archiveAsChatAsset('text', doc, sess.id, docMsg);

      if (usage) {
        updateTokenUsage(usage.total_tokens || 0);
      }

      renderMessages();
      state._storyboardQA = null;
    } catch (err) {
      const idx = sess.messages.indexOf(genMsg);
      if (idx >= 0) sess.messages.splice(idx, 1);
      const errMsg = err.message || '未知错误';
      sess.messages.push({ role: 'ai', text: '生成失败：' + errMsg });
      toast(errMsg.length > 30 ? errMsg.substring(0, 30) + '...' : errMsg);
      renderMessages();
    }
  }

  // ───── storyboard Q&A flow ─────
  const STORYBOARD_STEPS = [
    { key: 'projectType', label: '项目类型', options: ['短剧', '短视频', '广告片', '宣传片', '动画', '纪录片'] },
    { key: 'aspectRatio', label: '画幅比例', options: ['9:16 竖屏', '16:9 横屏', '1:1 方屏', '4:3', '21:9 宽银幕'] },
    { key: 'styleRef', label: '风格偏好', dynamic: true },
    { key: 'plan', label: '产出计划', compound: true }
  ];

  function startStoryboardQA(scriptText) {
    const sess = currentSession();
    state._storyboardQA = { step: 0, scriptText, answers: {} };
    renderStoryboardQuestion(sess);
  }

  function renderStoryboardQuestion(sess) {
    const qa = state._storyboardQA;
    if (!qa) return;
    const step = STORYBOARD_STEPS[qa.step];
    if (!step) return;

    if (step.dynamic && !qa._styleOptions) {
      sess.messages.push({ role: 'ai', textGen: { pct: 0, skillLabel: '分析风格...', model: state.controls.model } });
      renderMessages();
      fetchStyleRecommendations(qa.scriptText, sess);
      return;
    }

    let html = `<div class="qa-card"><div class="qa-title">${step.label}</div>`;
    if (step.compound) {
      html += `<div class="qa-compound">
        <div class="qa-field"><label>集数</label><input type="number" class="qa-input" data-qa="episodes" value="1" min="1" max="100" /></div>
        <div class="qa-field"><label>每集时长</label>
          <div class="qa-options" data-qa="duration">
            ${['30s','60s','90s','120s','180s','300s'].map(d => `<button class="qa-option-btn" data-val="${d}">${d}</button>`).join('')}
          </div>
          <input type="text" class="qa-input qa-input-sm" data-qa="durationCustom" placeholder="或输入自定义时长 (如 45s)" />
        </div>
        <button class="qa-confirm-btn">确认</button>
      </div>`;
    } else {
      const opts = step.dynamic ? (qa._styleOptions || []) : step.options;
      html += `<div class="qa-options">`;
      opts.forEach(o => { html += `<button class="qa-option-btn" data-val="${o}">${o}</button>`; });
      html += `</div>`;
      if (step.dynamic) {
        html += `<input type="text" class="qa-input qa-input-full" data-qa="customStyle" placeholder="或输入自定义风格描述" />`;
        html += `<button class="qa-custom-submit" style="display:none;">确认自定义风格</button>`;
      }
    }
    html += `</div>`;

    if (qa.step > 0) {
      html += `<div class="qa-back" data-back="true">← 返回上一步</div>`;
    }

    sess.messages.push({ role: 'ai', qaCard: html, _qaStep: qa.step });
    renderMessages();
    bindQAEvents();
  }

  function bindQAEvents() {
    document.querySelectorAll('.qa-option-btn').forEach(btn => {
      btn.onclick = (e) => {
        const val = e.target.dataset.val;
        handleQAAnswer(val);
      };
    });
    document.querySelectorAll('.qa-back').forEach(btn => {
      btn.onclick = () => goBackQA();
    });
    const customInput = document.querySelector('.qa-input-full[data-qa="customStyle"]');
    const customSubmit = document.querySelector('.qa-custom-submit');
    if (customInput && customSubmit) {
      customInput.addEventListener('input', () => {
        customSubmit.style.display = customInput.value.trim() ? '' : 'none';
      });
      customSubmit.onclick = () => {
        const val = customInput.value.trim();
        if (val) handleQAAnswer(val);
      };
      customInput.onkeydown = (e) => { if (e.key === 'Enter' && customInput.value.trim()) handleQAAnswer(customInput.value.trim()); };
    }
    const confirmBtn = document.querySelector('.qa-confirm-btn');
    if (confirmBtn) {
      confirmBtn.onclick = () => {
        const episodes = document.querySelector('.qa-input[data-qa="episodes"]')?.value || '1';
        const durBtns = document.querySelectorAll('.qa-options[data-qa="duration"] .qa-option-btn.selected');
        const durCustom = document.querySelector('.qa-input-sm[data-qa="durationCustom"]')?.value?.trim();
        const duration = durCustom || (durBtns.length ? durBtns[0].dataset.val : '60s');
        handleQAPlanAnswer(episodes, duration);
      };
      document.querySelectorAll('.qa-options[data-qa="duration"] .qa-option-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          document.querySelectorAll('.qa-options[data-qa="duration"] .qa-option-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        };
      });
    }
  }

  function handleQAAnswer(val) {
    const qa = state._storyboardQA;
    if (!qa) return;
    const step = STORYBOARD_STEPS[qa.step];
    qa.answers[step.key] = val;
    qa[step.key] = val;
    qa.step++;
    const sess = currentSession();
    if (qa.step >= STORYBOARD_STEPS.length) {
      showStoryboardConfirm(sess);
    } else {
      renderStoryboardQuestion(sess);
    }
  }

  function handleQAPlanAnswer(episodes, duration) {
    const qa = state._storyboardQA;
    if (!qa) return;
    qa.episodes = episodes;
    qa.duration = duration;
    qa.answers.plan = episodes + ' 集 × ' + duration;
    qa.step = STORYBOARD_STEPS.length;
    showStoryboardConfirm(currentSession());
  }

  function goBackQA() {
    const qa = state._storyboardQA;
    if (!qa || qa.step <= 0) return;
    const sess = currentSession();
    // Remove last QA card message
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      if (sess.messages[i].qaCard !== undefined || sess.messages[i]._qaConfirm) {
        sess.messages.splice(i, 1);
        break;
      }
    }
    qa.step--;
    renderStoryboardQuestion(sess);
  }

  function showStoryboardConfirm(sess) {
    const qa = state._storyboardQA;
    const summary = `
      <div class="qa-card qa-confirm">
        <div class="qa-title">确认配置</div>
        <div class="qa-summary">
          <div class="qa-row"><span>项目类型</span><span>${qa.projectType || '-'}</span></div>
          <div class="qa-row"><span>画幅比例</span><span>${qa.aspectRatio || '-'}</span></div>
          <div class="qa-row"><span>风格偏好</span><span>${qa.styleRef || '-'}</span></div>
          <div class="qa-row"><span>产出计划</span><span>${qa.episodes || 1} 集 × ${qa.duration || '60s'}</span></div>
        </div>
        <div class="qa-confirm-actions">
          <button class="qa-confirm-go">确认生成分镜</button>
          <button class="qa-confirm-edit">修改配置</button>
        </div>
      </div>`;
    sess.messages.push({ role: 'ai', qaCard: summary, _qaConfirm: true });
    renderMessages();

    document.querySelector('.qa-confirm-go')?.addEventListener('click', () => {
      const sess2 = currentSession();
      const genMsg = { role: 'ai', textGen: { pct: 0, skillLabel: '分镜脚本', model: state.controls.model } };
      sess2.messages.push(genMsg);
      renderMessages();
      executeSkill('storyboard', qa.scriptText, sess2, genMsg, '分镜脚本');
    });
    document.querySelector('.qa-confirm-edit')?.addEventListener('click', () => {
      goBackQA();
    });
  }

  async function fetchStyleRecommendations(scriptText, sess) {
    const qa = state._storyboardQA;
    try {
      const stylePrompt = `你是一位影视风格顾问。分析以下剧本的题材、情绪和叙事特点，推荐 3-4 个最适合的视觉风格方向。

请以 JSON 格式返回：
{"styles": ["风格1", "风格2", "风格3"]}

每个风格用简短的中文描述（4-8字），如"悬疑暗黑写实"、"温暖治愈日系"、"赛博朋克霓虹"等。`;

      const { text } = await callLLM(stylePrompt, scriptText.substring(0, 4000), null, { timeoutMs: 60000 });
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { parsed = {}; }
      const styles = Array.isArray(parsed.styles) ? parsed.styles.filter(s => typeof s === 'string' && s.trim()) : [];
      qa._styleOptions = styles.length > 0 ? styles : ['悬疑暗黑', '写实电影', '唯美文艺', '明快现代'];

      for (let i = sess.messages.length - 1; i >= 0; i--) {
        if (sess.messages[i].textGen) { sess.messages.splice(i, 1); break; }
      }
      renderStoryboardQuestion(sess);
    } catch (e) {
      qa._styleOptions = ['悬疑暗黑', '写实电影', '唯美文艺', '明快现代'];
      for (let i = sess.messages.length - 1; i >= 0; i--) {
        if (sess.messages[i].textGen) { sess.messages.splice(i, 1); break; }
      }
      toast('风格推荐失败，已使用默认选项');
      renderStoryboardQuestion(sess);
    }
  }

  // ───── skill dropdown ─────
  function getAllSkills() {
    const builtins = M.TEXT_SKILLS.filter(s => !s.isCreate && !s.isUpload);
    const custom = customSkills.map(s => ({ ...s, custom: true }));
    return [...builtins, ...custom];
  }

  function buildSkillDropdown() {
    const menu = $('#skillMenu');
    if (!menu) return;
    menu.innerHTML = '';
    const allSkills = getAllSkills();
    allSkills.forEach(sk => {
      const b = document.createElement('button');
      const label = sk.label + (sk.custom ? ' <span style="font-size:10px;color:#9ca3af;margin-left:4px;">[自定义]</span>' : '');
      b.innerHTML = `${icon('zap')}<span>${label}</span>`;
      if (state.skill === sk.id) b.classList.add('selected');
      b.onclick = (e) => {
        e.stopPropagation();
        state.skill = sk.id;
        $('#skillLabel').textContent = sk.label;
        buildSkillDropdown();
        closeDropdowns();
      };
      menu.appendChild(b);
    });

    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--line);margin:4px 0;';
    menu.appendChild(sep);

    const manageBtn = document.createElement('button');
    manageBtn.innerHTML = `${icon('settings')}<span>管理技能</span>`;
    manageBtn.onclick = (e) => {
      e.stopPropagation();
      closeDropdowns();
      openRpTab('skills');
    };
    menu.appendChild(manageBtn);
  }

  function startSkillCreation() {
    const sess = currentSession();
    if (!sess) return;
    sess.messages.push({ role: 'ai', text: '你想创建什么样的技能？请描述：\n\n· 技能的用途和目标\n· 期望的输入和输出格式\n· 任何特殊要求\n\n我会根据你的描述生成一个技能文件。' });
    state._skillCreationMode = true;
    renderMessages();
  }

  function uploadSkill() {
    const name = '自定义技能' + (customSkills.length + 1);
    customSkills.push({ id: 'custom_' + Date.now(), label: name, prompt: '', builtin: false, createdAt: Date.now() });
    state.skill = customSkills[customSkills.length - 1].id;
    persistState();
    $('#skillLabel').textContent = name;
    buildSkillDropdown();
    toast('技能已导入: ' + name);
  }

  // ───── token usage indicator ─────
  function drawTokenRing(usage, limit) {
    const canvas = $('#tokenRing');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const s = 20, c = s / 2, r = 7, lw = 2.5;
    ctx.clearRect(0, 0, s, s);
    const pct = Math.min(usage / limit, 1);
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = lw;
    ctx.stroke();
    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
      ctx.strokeStyle = pct > 0.8 ? '#ef4444' : pct > 0.6 ? '#f59e0b' : '#9ca3af';
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    const pill = $('#tokenPill');
    if (pill) {
      pill.classList.toggle('warn', pct > 0.6 && pct <= 0.8);
      pill.classList.toggle('danger', pct > 0.8);
    }
  }

  function updateTokenUsage(delta) {
    state.tokenUsage = Math.max(0, Math.min(state.tokenUsage + delta, M.TEXT_TOKEN_LIMIT));
    const label = state.tokenUsage >= 1000 ? Math.round(state.tokenUsage / 1000) + 'K' : String(state.tokenUsage);
    const el = $('#tokenLabel');
    if (el) el.textContent = label;
    drawTokenRing(state.tokenUsage, M.TEXT_TOKEN_LIMIT);
  }

  function compressContext() {
    const pill = $('#tokenPill');
    if (pill) pill.style.transition = 'opacity .3s';
    state.tokenUsage = 0;
    updateTokenUsage(0);
    toast('上下文已压缩并清空');
  }

  // ───── right panel (tabbed: files / browser) ─────
  function openRightPanelMode() {
    state.rightPanelOpen = true;
    const panel = $('#rightPanel');
    panel.style.display = '';
    panel.style.width = '';
    panel.style.minWidth = '';
    $('#rpEdgeHandle').style.display = 'none';
    renderRpTabbar();
    setRightPanelTab(state.rightPanelTab || 'files');
    if (state.rightPanelTab === 'files') renderLibrary();
    renderIcons();
    setTimeout(syncControlsCompact, 50);
  }

  function closeRightPanel() {
    state.rightPanelOpen = false;
    if (state.rightPanelMaxed) toggleMaxed();
    const panel = $('#rightPanel');
    panel.style.display = 'none';
    $('#rpEdgeHandle').style.display = '';
    syncControlsCompact();
  }

  function toggleRightPanel() {
    if (state.rightPanelOpen) closeRightPanel();
    else openRightPanelMode();
  }

  function setRightPanelTab(tab) {
    state.rightPanelTab = tab;
    document.querySelectorAll('.rp-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const filesPane = $('#rpFilesPane');
    const browserPane = $('#rpBrowserPane');
    const skillsPane = $('#rpSkillsPane');
    const examplesPane = $('#rpExamplesPane');
    if (filesPane) filesPane.style.display = tab === 'files' ? '' : 'none';
    if (browserPane) browserPane.style.display = tab === 'browser' ? '' : 'none';
    if (skillsPane) skillsPane.style.display = tab === 'skills' ? 'flex' : 'none';
    if (examplesPane) examplesPane.style.display = tab === 'examples' ? 'flex' : 'none';
    if (tab === 'skills') renderSkillsPane();
    else if (tab === 'examples') renderExamplesPane();
    if (tab === 'files') {
      renderLibrary();
    }
  }

  // ───── Right-panel dynamic tabs (skills / examples management) ─────
  function renderRpTabbar() {
    const wrap = $('#rpTabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    const mkTab = (id, label, lucide, closable) => {
      const btn = document.createElement('button');
      btn.className = 'rp-tab';
      btn.type = 'button';
      btn.dataset.tab = id;
      if (state.rightPanelTab === id) btn.classList.add('active');
      btn.innerHTML = `<i data-lucide="${lucide}"></i><span>${escape(label)}</span>` +
        (closable ? `<span class="rp-tab-close" data-close="${id}" title="关闭">&times;</span>` : '');
      btn.onclick = (e) => {
        if (e.target.closest('.rp-tab-close')) return;
        setRightPanelTab(id);
      };
      const cls = btn.querySelector('.rp-tab-close');
      if (cls) cls.onclick = (ev) => { ev.stopPropagation(); closeRpTab(id); };
      wrap.appendChild(btn);
    };
    mkTab('files', '文件', 'folder', false);
    if (state.openRpTabs && state.openRpTabs.has('skills')) mkTab('skills', '技能', 'zap', true);
    if (state.openRpTabs && state.openRpTabs.has('examples')) mkTab('examples', '示例', 'star', true);
    renderIcons();
  }

  function openRpTab(tabId) {
    if (!state.openRpTabs) state.openRpTabs = new Set();
    state.openRpTabs.add(tabId);
    if (!state.rightPanelOpen) openRightPanelMode();
    setRightPanelTab(tabId);
    renderRpTabbar();
  }

  function closeRpTab(tabId) {
    if (!state.openRpTabs) return;
    state.openRpTabs.delete(tabId);
    if (state.rightPanelTab === tabId) setRightPanelTab('files');
    renderRpTabbar();
  }

  function renderSkillsPane() {
    const list = $('#rpSkillsList');
    if (!list) return;
    const builtins = (M.TEXT_SKILLS || []).filter(s => !s.isCreate && !s.isUpload);
    list.innerHTML = '';
    builtins.forEach(sk => {
      const row = document.createElement('div');
      row.className = 'manage-row';
      row.innerHTML = `<i data-lucide="zap" class="manage-row-icon"></i>` +
        `<div class="manage-row-main"><div class="manage-row-name">${escape(sk.label)}</div>` +
        `<div class="manage-row-meta">内置技能</div></div>` +
        `<span class="manage-row-badge">内置</span>`;
      list.appendChild(row);
    });
    customSkills.forEach((sk, idx) => {
      const row = document.createElement('div');
      row.className = 'manage-row';
      const promptPreview = (sk.prompt || '').slice(0, 60).replace(/\s+/g, ' ');
      row.innerHTML = `<i data-lucide="zap" class="manage-row-icon"></i>` +
        `<div class="manage-row-main"><div class="manage-row-name">${escape(sk.label || '未命名')}</div>` +
        `<div class="manage-row-meta">${escape(promptPreview || '点编辑添加内容')}</div></div>` +
        `<div class="manage-row-actions">` +
          `<button class="manage-row-action" data-act="edit" title="编辑">${icon('pencil')}</button>` +
          `<button class="manage-row-action danger" data-act="delete" title="删除">${icon('trash-2')}</button>` +
        `</div>`;
      row.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openSkillEditModal(idx); };
      row.querySelector('[data-act="delete"]').onclick = async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({ title: '删除技能', body: `确定删除「${escape(sk.label)}」？` });
        if (!ok) return;
        if (state.skill === sk.id) state.skill = (M.TEXT_SKILLS[0] && M.TEXT_SKILLS[0].id) || null;
        customSkills.splice(idx, 1);
        persistState();
        renderSkillsPane();
        if (typeof buildSkillDropdown === 'function') buildSkillDropdown();
      };
      list.appendChild(row);
    });
    if (customSkills.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'manage-pane-empty';
      empty.textContent = '还没有自定义技能。点下方"新建/上传"开始。';
      list.appendChild(empty);
    }
    renderIcons();
    $('#rpSkillUploadBtn').onclick = () => {
      uploadSkill();
      renderSkillsPane();
    };
  }

  function renderExamplesPane() {
    const list = $('#rpExamplesList');
    if (!list) return;
    const items = state.favoritePrompts || [];
    list.innerHTML = '';
    items.forEach((ex, idx) => {
      const row = document.createElement('div');
      row.className = 'manage-row';
      const thumb = ex.imageSrc
        ? `<img class="manage-row-thumb" src="${escape(ex.imageSrc)}" alt=""/>`
        : `<div class="manage-row-thumb manage-row-thumb-empty">${icon('image')}</div>`;
      const promptPreview = (ex.prompt || '').slice(0, 60).replace(/\s+/g, ' ');
      row.innerHTML = thumb +
        `<div class="manage-row-main"><div class="manage-row-name">${escape(ex.name || '未命名')}</div>` +
        `<div class="manage-row-meta">${escape(promptPreview)}</div></div>` +
        `<div class="manage-row-actions">` +
          `<button class="manage-row-action" data-act="edit" title="编辑">${icon('pencil')}</button>` +
          `<button class="manage-row-action danger" data-act="delete" title="删除">${icon('trash-2')}</button>` +
        `</div>`;
      row.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openExampleEditModal(idx); };
      row.querySelector('[data-act="delete"]').onclick = async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({ title: '删除示例', body: `确定删除「${escape(ex.name)}」？` });
        if (!ok) return;
        state.favoritePrompts.splice(idx, 1);
        persistState();
        renderExamplesPane();
      };
      list.appendChild(row);
    });
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'manage-pane-empty';
      empty.textContent = '还没有收藏的提示词示例。去图片/视频卡上点 ⭐ 收藏一些吧。';
      list.appendChild(empty);
    }
    renderIcons();
  }

  function openSkillEditModal(idx) {
    const sk = customSkills[idx];
    if (!sk) return;
    openManageEditModal({
      title: '编辑技能',
      nameValue: sk.label || '',
      contentValue: sk.prompt || '',
      contentLabel: '技能内容（system prompt）',
      onSave: (name, content) => {
        sk.label = name;
        sk.prompt = content;
        persistState();
        renderSkillsPane();
        if (typeof buildSkillDropdown === 'function') buildSkillDropdown();
      }
    });
  }

  function openExampleEditModal(idx) {
    const ex = state.favoritePrompts[idx];
    if (!ex) return;
    openManageEditModal({
      title: '编辑示例',
      nameValue: ex.name || '',
      contentValue: ex.prompt || '',
      contentLabel: '提示词内容',
      onSave: (name, content) => {
        ex.name = name;
        ex.prompt = content;
        persistState();
        renderExamplesPane();
      }
    });
  }

  function openManageEditModal({ title, nameValue, contentValue, contentLabel, onSave }) {
    document.querySelector('.fav-modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'fav-modal-overlay';
    overlay.innerHTML = `
      <div class="fav-modal" style="width:520px;">
        <div class="fav-modal-head">
          <span class="fav-modal-title">${escape(title)}</span>
          <span class="fav-modal-close" data-act="close">${icon('x')}</span>
        </div>
        <div class="fav-modal-body">
          <div class="fav-modal-field-label">名称</div>
          <input type="text" class="fav-modal-input" id="manageNameInput" maxlength="60" value="${escape(nameValue)}"/>
          <div class="fav-modal-field-label" style="margin-top:6px;">${escape(contentLabel)}</div>
          <textarea class="fav-modal-input" id="manageContentInput" rows="8" style="resize:vertical; min-height:140px; line-height:1.55; font-family:inherit;">${escape(contentValue)}</textarea>
        </div>
        <div class="fav-modal-foot">
          <button class="fav-modal-btn cancel" data-act="cancel">取消</button>
          <button class="fav-modal-btn primary" data-act="confirm">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    renderIcons();
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-act="close"]').onclick = close;
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('[data-act="confirm"]').onclick = () => {
      const name = overlay.querySelector('#manageNameInput').value.trim();
      const content = overlay.querySelector('#manageContentInput').value;
      if (!name) { toast('请输入名称'); return; }
      onSave(name, content);
      toast('已保存');
      close();
    };
    setTimeout(() => overlay.querySelector('#manageNameInput').focus(), 0);
  }

  function toggleMaxed() {
    state.rightPanelMaxed = !state.rightPanelMaxed;
    const panel = $('#rightPanel');
    const main = document.querySelector('main');
    panel.classList.toggle('maxed', state.rightPanelMaxed);
    if (main) main.classList.toggle('maxed-hidden', state.rightPanelMaxed);
    const icon = $('#rpMaxBtn i, #rpMaxBtn svg');
    const btn = $('#rpMaxBtn');
    if (btn) {
      btn.title = state.rightPanelMaxed ? '还原' : '最大化';
      btn.innerHTML = `<i data-lucide="${state.rightPanelMaxed ? 'minimize-2' : 'maximize-2'}"></i>`;
    }
    renderIcons();
  }

  function renderDocContent(doc) {
    const body = $('#rpBody');
    if (!body) return;

    if (doc.mediaType === 'image' || doc.mediaType === 'video') {
      const mediaTag = doc.mediaType === 'video'
        ? `<video src="${escape(doc.mediaSrc || '')}" controls poster="${escape(doc.poster || '')}"></video>`
        : `<img src="${escape(doc.mediaSrc || '')}" alt="${escape(doc.title || '')}" />`;
      const promptSection = doc.prompt
        ? `<div class="asset-detail-section">
            <div class="asset-detail-section-title"><i data-lucide="sparkles"></i><span>${doc.mediaType === 'image' ? '图像提示词' : '生成提示词'}</span></div>
            <div class="asset-detail-prompt-block">
              <div class="asset-detail-prompt-text">${escape(doc.prompt)}</div>
              <button class="asset-detail-prompt-copy" data-prompt="${escape(doc.prompt)}">复制</button>
            </div>
          </div>`
        : `<div class="asset-detail-section">
            <div class="asset-detail-section-title"><i data-lucide="sparkles"></i><span>${doc.mediaType === 'image' ? '图像提示词' : '生成提示词'}</span></div>
            <div class="asset-detail-prompt-empty">— 暂无提示词记录 —</div>
          </div>`;

      const metaRows = [];
      metaRows.push(`<div class="asset-detail-meta-row"><span class="asset-detail-meta-label">类型</span><span class="asset-detail-meta-value">${doc.mediaType === 'image' ? '图片' : '视频'}${doc.version ? ' · V' + doc.version : ''}</span></div>`);
      if (doc.duration) metaRows.push(`<div class="asset-detail-meta-row"><span class="asset-detail-meta-label">时长</span><span class="asset-detail-meta-value">${escape(doc.duration)}</span></div>`);
      if (doc.createdAtLabel) metaRows.push(`<div class="asset-detail-meta-row"><span class="asset-detail-meta-label">创建</span><span class="asset-detail-meta-value">${escape(doc.createdAtLabel)}</span></div>`);
      if (doc.sourceSessionLabel) metaRows.push(`<div class="asset-detail-meta-row"><span class="asset-detail-meta-label">来源</span><span class="asset-detail-meta-value asset-detail-meta-link" data-jump-asset="${escape(doc._assetId || '')}">${escape(doc.sourceSessionLabel)}</span></div>`);

      body.innerHTML = `<div class="asset-detail">
        <div class="asset-detail-media-wrap">
          <div class="asset-detail-media">${mediaTag}</div>
        </div>
        ${promptSection}
        <div class="asset-detail-section">
          <div class="asset-detail-section-title"><i data-lucide="info"></i><span>详情</span></div>
          <div class="asset-detail-meta-card">${metaRows.join('')}</div>
        </div>
      </div>`;

      // Wire copy button for prompt
      body.querySelector('.asset-detail-prompt-copy')?.addEventListener('click', (e) => {
        const text = e.currentTarget.dataset.prompt || '';
        navigator.clipboard.writeText(text).then(() => toast('已复制提示词')).catch(() => toast('复制失败'));
      });
      // Wire jump-to-source link
      body.querySelector('[data-jump-asset]')?.addEventListener('click', (e) => {
        const assetId = e.currentTarget.dataset.jumpAsset;
        const proj = currentProject();
        if (!proj || !assetId) return;
        const found = findAsset(proj, assetId);
        if (found) jumpToAssetSource(found.asset);
      });
      renderIcons();
      return;
    }

    let md = doc.content || '';
    if (doc.type === 'script-breakdown' && doc.data) md = breakdownToMarkdown(doc.data);
    else if (doc.type === 'storyboard' && doc.data) md = storyboardToMarkdown(doc.data);

    body.innerHTML = `<div class="doc-content" id="docContent">${renderMarkdown(md)}</div>`;
    bindCopyPromptButtons();
    applyAnnotationHighlights();
  }

  function renderMarkdown(md) {
    const lines = md.split('\n');
    let html = '', inPrompt = false, promptText = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('```prompt')) { inPrompt = true; promptText = ''; continue; }
      if (inPrompt && trimmed === '```') {
        inPrompt = false;
        const escaped = escape(promptText.trim());
        html += `<div class="prompt-block"><div class="prompt-label">图像提示词</div><div class="prompt-text">${escaped}</div><button class="prompt-copy" data-prompt="${escaped}">复制</button></div>`;
        continue;
      }
      if (inPrompt) { promptText += (promptText ? '\n' : '') + line; continue; }
      if (!trimmed) { html += '<div class="md-blank">&nbsp;</div>'; continue; }
      if (trimmed.startsWith('### ')) { html += `<h3 class="md-h3">${escape(trimmed.slice(4))}</h3>`; continue; }
      if (trimmed.startsWith('## ')) { html += `<h2 class="md-h2">${escape(trimmed.slice(3))}</h2>`; continue; }
      if (trimmed.startsWith('# ')) { html += `<h1 class="md-h1">${escape(trimmed.slice(2))}</h1>`; continue; }
      if (trimmed === '---' || trimmed === '────') { html += '<hr class="doc-divider"/>'; continue; }

      // 【XXX】 section heading
      const secMatch = trimmed.match(/^【([^】]+)】\s*$/);
      if (secMatch) {
        const name = secMatch[1].trim();
        html += `<div class="md-section-head"><span>${escape(name)}</span></div>`;
        continue;
      }
      // 场景XX · ... — scene line with badge
      const sceneMatch = trimmed.match(/^(场景\d+)\s*[·•]\s*(.+)$/);
      if (sceneMatch) {
        html += `<div class="md-scene"><span class="badge">${escape(sceneMatch[1])}</span><span>${escape(sceneMatch[2])}</span></div>`;
        continue;
      }
      // · or • bullet — possibly with key·value pattern inside
      const bulletMatch = trimmed.match(/^[·•]\s+(.+)$/);
      if (bulletMatch) {
        const inner = bulletMatch[1];
        const kvMatch = inner.match(/^([一-龥A-Za-z\w ]{1,8})[:：]\s*(.+)$/);
        if (kvMatch) {
          html += `<div class="md-bullet md-kv"><span class="k">${escape(kvMatch[1].trim())}</span><span class="sep">·</span><span class="v">${escape(kvMatch[2].trim())}</span></div>`;
        } else {
          html += `<div class="md-bullet"><span>${escape(inner)}</span></div>`;
        }
        continue;
      }
      // 角色名（属性属性...） — character card line
      const charMatch = trimmed.match(/^([一-龥A-Za-z]{2,8})（([^）]+)）\s*$/);
      if (charMatch) {
        html += `<div class="md-character"><strong>${escape(charMatch[1])}</strong><span class="muted">（${escape(charMatch[2])}）</span></div>`;
        continue;
      }
      // 字段：值 — top-level kv (not bullet)
      const topKvMatch = trimmed.match(/^([一-龥A-Za-z\w ]{1,8})[:：]\s*(.+)$/);
      if (topKvMatch) {
        html += `<div class="md-kv"><span class="k">${escape(topKvMatch[1].trim())}</span><span class="sep">·</span><span class="v">${escape(topKvMatch[2].trim())}</span></div>`;
        continue;
      }

      const boldReplaced = escape(trimmed).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += `<div class="md-line">${boldReplaced}</div>`;
    }
    return html;
  }

  function breakdownToMarkdown(data) {
    const lines = [];
    if (data.styleGuide) {
      const sg = data.styleGuide;
      lines.push('## 风格指南', '');
      if (sg.artStyle) lines.push(`**艺术风格：** ${sg.artStyle}`);
      if (sg.colorGrading) lines.push(`**色彩基调：** ${sg.colorGrading}`);
      if (sg.era) lines.push(`**时代背景：** ${sg.era}`);
      if (sg.negativePrompts) lines.push(`**排除项：** ${sg.negativePrompts}`);
      lines.push('');
    }
    if (data.characters?.length) {
      lines.push(`## 角色（${data.characters.length}）`, '');
      data.characters.forEach(ch => {
        lines.push(`### ${ch.name}（${ch.role || ''}）`, '');
        if (ch.gender || ch.age) lines.push(`**性别/年龄：** ${ch.gender || ''} · ${ch.age || ''}`);
        if (ch.appearance) lines.push(`**外貌：** ${ch.appearance}`);
        if (ch.costume) lines.push(`**服装：** ${ch.costume}`);
        if (ch.personality) lines.push(`**性格：** ${ch.personality}`);
        if (ch.scenes?.length) lines.push(`**出场：** ${ch.scenes.join('、')}`);
        if (ch.imagePrompt) { lines.push('', '```prompt', ch.imagePrompt, '```'); }
        lines.push('');
      });
    }
    if (data.scenes?.length) {
      lines.push(`## 场景（${data.scenes.length}）`, '');
      data.scenes.forEach(sc => {
        lines.push(`### ${sc.name}`, '');
        if (sc.intExt || sc.timeOfDay) lines.push(`**内/外：** ${sc.intExt || ''} · ${sc.timeOfDay || ''}`);
        if (sc.colorPalette) lines.push(`**色彩：** ${sc.colorPalette}`);
        if (sc.lighting) lines.push(`**光线：** ${sc.lighting}`);
        if (sc.atmosphere) lines.push(`**氛围：** ${sc.atmosphere}`);
        if (sc.keyElements?.length) lines.push(`**陈设：** ${sc.keyElements.join('、')}`);
        if (sc.imagePrompt) { lines.push('', '```prompt', sc.imagePrompt, '```'); }
        lines.push('');
      });
    }
    if (data.props?.length) {
      lines.push(`## 道具（${data.props.length}）`, '');
      data.props.forEach(pr => {
        lines.push(`### ${pr.name}（${pr.category || ''}）`, '');
        if (pr.appearance) lines.push(`**外观：** ${pr.appearance}`);
        if (pr.material) lines.push(`**材质：** ${pr.material}`);
        if (pr.narrativeRole) lines.push(`**功能：** ${pr.narrativeRole}`);
        if (pr.scenes?.length) lines.push(`**出现：** ${pr.scenes.join('、')}`);
        if (pr.imagePrompt) { lines.push('', '```prompt', pr.imagePrompt, '```'); }
        lines.push('');
      });
    }
    return lines.join('\n');
  }

  function storyboardToMarkdown(data) {
    const lines = [];
    if (data.meta) {
      const m = data.meta;
      lines.push(`## 分镜脚本`, '');
      lines.push(`${m.projectType || ''} · ${m.aspectRatio || ''} · ${m.styleRef || ''} · ${m.episodes || 1}集 × ${m.duration || ''} · 共${m.totalShots || 0}镜`, '');
    }
    if (data.scenes?.length) {
      data.scenes.forEach(scene => {
        lines.push(`## ${scene.name}`, '');
        (scene.shots || []).forEach(shot => {
          lines.push(`### ${shot.id || ''} ｜ ${shot.shotSize || ''} · ${shot.cameraMovement || ''} · ${shot.cameraAngle || ''} · ${shot.duration || ''} · ${shot.transition || ''}`, '');
          if (shot.description) lines.push(shot.description);
          if (shot.action) lines.push(`**动作：** ${shot.action}`);
          if (shot.dialogue) lines.push(`**对白：** ${shot.dialogue}`);
          if (shot.sound) lines.push(`**音效：** ${shot.sound}`);
          if (shot.notes) lines.push(`**备注：** ${shot.notes}`);
          if (shot.imagePrompt) { lines.push('', '```prompt', shot.imagePrompt, '```'); }
          lines.push('');
        });
      });
    }
    return lines.join('\n');
  }

  function bindCopyPromptButtons() {
    document.querySelectorAll('.prompt-copy').forEach(btn => {
      btn.onclick = () => {
        const text = btn.dataset.prompt;
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1500);
        }).catch(() => toast('复制失败'));
      };
    });
  }

  function applyAnnotationHighlights() {
    // Re-apply highlights for existing annotations
    if (!state.annotations.length) return;
    const content = $('#docContent');
    if (!content) return;
    state.annotations.forEach((ann, idx) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const pos = node.textContent.indexOf(ann.quote.substring(0, 20));
        if (pos >= 0) {
          const parent = node.parentElement;
          if (!parent.classList.contains('ann-highlight')) {
            parent.classList.add('ann-highlight');
            const badge = document.createElement('span');
            badge.className = 'ann-badge';
            badge.textContent = '批注' + (idx + 1);
            parent.appendChild(badge);
          }
          break;
        }
      }
    });
  }

  function renderAnnotationsSummary() {
    const wrap = $('#rpAnnotations');
    const list = $('#rpAnnList');
    if (!wrap || !list) return;
    if (!state.annotations.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    list.innerHTML = '';
    state.annotations.forEach((ann, idx) => {
      const item = el('div', 'rp-ann-item');
      item.innerHTML =
        `<span class="ann-idx">批注 ${idx + 1}</span>` +
        `<span class="ann-quoted">"${escape(ann.quote.substring(0, 50))}${ann.quote.length > 50 ? '...' : ''}"</span>` +
        `<span class="ann-comment">${escape(ann.comment)}</span>`;
      list.appendChild(item);
    });
  }

  function exportDoc(format) {
    const proj = currentProject();
    const sel = state.libraryUI.selectedAssetId;
    if (!proj || !sel) return;
    const found = findAsset(proj, sel);
    if (!found || found.type !== 'text') return;
    const doc = { title: found.asset.name, version: found.asset.version, content: found.asset.body, type: 'plain-doc' };
    const title = doc.title || '文档';

    let md = '';
    if (doc.type === 'script-breakdown' && doc.data) md = breakdownToMarkdown(doc.data);
    else if (doc.type === 'storyboard' && doc.data) md = storyboardToMarkdown(doc.data);
    else md = doc.content || '';

    let header = `# ${title}`;
    if (doc.version) header += ` V${doc.version}`;
    const fullMd = header + '\n\n' + md;

    let content;
    if (format === 'md') {
      content = fullMd;
    } else {
      content = fullMd
        .replace(/^```prompt\s*$/gm, '【图像提示词】')
        .replace(/^```\s*$/gm, '')
        .replace(/^---\s*$/gm, '────────────────────')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1');
    }

    const ext = format === 'md' ? '.md' : '.txt';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = title + ext;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出 ' + title + ext);
    closeDropdowns();
  }

  function updateAnnotationChip() {
    // Legacy name kept; delegates to unified workbench renderer
    renderComposerWorkbench();
    updateSendBtn();
  }

  function clearAnnotations() {
    state.annotations = [];
    updateAnnotationChip();
    renderAnnotationsSummary();
    if (state.rightPanelOpen && state.rightPanelTab === 'files') renderLibrary();
  }

  // Shared handler for "加到对话框": checks cross-session, prompts switch if needed
  async function addAnnotationToComposer(asset, ann, type) {
    if (!ann) return;
    if (state.composedAnnotations.find(x => x.annotationId === ann.id)) return;
    // Cross-session check — if asset belongs to a different session, ask before switching
    if (asset.sourceSessionId && asset.sourceSessionId !== state.currentSessionId) {
      const found = findSessionById(asset.sourceSessionId);
      if (!found) {
        toast('该资产的来源会话已不存在');
        return;
      }
      const ok = await confirmDialog({
        title: '切换到来源会话',
        message: `批注的来源是「${found.session.name}」，是否切换到那个会话并把批注加到输入框？`,
        okText: '切换并加到',
        cancelText: '取消'
      });
      if (!ok) return;
      switchSession(found.project.id, found.session.id);
    }
    state.composedAnnotations.push({
      assetId: asset.id,
      annotationId: ann.id,
      text: ann.text,
      quote: ann.quote || null,
      assetSrc: asset.src || null
    });
    renderComposerWorkbench();
    renderAssetDetailInPane(asset, type);
    toast('已加到对话框');
  }

  function renderComposerWorkbench() {
    const wb = $('#composerWorkbench');
    if (!wb) return;
    const sess = currentSession();
    if (!sess) { wb.style.display = 'none'; wb.innerHTML = ''; return; }

    const isVisual = sess.type === 'image' || sess.type === 'video';
    const parts = [];

    // Annotation chips — visible in ALL session types (text/image/video) so user sees
    // what's currently attached as input material before sending
    (state.composedAnnotations || []).forEach((a, idx) => {
      let label;
      if (a.quote) {
        const q = (a.quote || '').slice(0, 6) + ((a.quote || '').length > 6 ? '…' : '');
        const t = (a.text || '').slice(0, 10) + ((a.text || '').length > 10 ? '…' : '');
        label = `「${q}」${t}`;
      } else {
        label = (a.text || '').slice(0, 18) + ((a.text || '').length > 18 ? '…' : '');
      }
      const tipText = a.quote ? `引用：${a.quote}\n批注：${a.text}` : a.text || '';
      parts.push(
        `<span class="wb-chip wb-annotation" title="${escape(tipText)}">` +
          `${icon('pin')}<span class="wb-chip-label">${escape(label)}</span>` +
          `<span class="wb-chip-x" data-act="rm-ann" data-idx="${idx}">&times;</span>` +
        `</span>`
      );
    });

    if (isVisual) {
      // Spacer pushes examples + AI 提升 to the right
      parts.push(`<span class="wb-spacer"></span>`);
      // Examples chip — sits next to AI 提升
      const exCount = (state.composedExamples || []).length;
      const exLabel = exCount > 0 ? `示例 ${exCount}` : '加示例';
      parts.push(
        `<span class="wb-chip wb-example clickable" data-act="open-examples">` +
          `${icon('star')}<span class="wb-chip-label">${exLabel}</span>` +
          (exCount > 0 ? `<span class="wb-chip-x" data-act="rm-examples">&times;</span>` : '') +
        `</span>`
      );
      // AI 提升 button (right-most)
      const promptHasContent = ($('#promptInput')?.value || '').trim().length > 0;
      const annCount = (state.composedAnnotations || []).length;
      const canUpgrade = promptHasContent || annCount > 0 || exCount > 0;
      parts.push(
        `<button class="wb-ai-btn" data-act="ai-upgrade"${canUpgrade ? '' : ' disabled'}>` +
          `${icon('sparkles')}<span>AI 提升</span>` +
        `</button>`
      );
    }

    if (parts.length === 0) { wb.style.display = 'none'; wb.innerHTML = ''; return; }
    wb.style.display = '';
    wb.innerHTML = parts.join('');
    renderIcons();

    // Bind handlers
    wb.querySelectorAll('[data-act="rm-ann"]').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const i = parseInt(el.dataset.idx, 10);
        state.composedAnnotations.splice(i, 1);
        renderComposerWorkbench();
      };
    });
    const exClickEl = wb.querySelector('[data-act="open-examples"]');
    if (exClickEl) exClickEl.onclick = (e) => {
      e.stopPropagation();
      if (e.target.closest('[data-act="rm-examples"]')) return;
      openExamplePicker(exClickEl);
    };
    const rmExEl = wb.querySelector('[data-act="rm-examples"]');
    if (rmExEl) rmExEl.onclick = (e) => {
      e.stopPropagation();
      state.composedExamples = [];
      renderComposerWorkbench();
    };
    const aiBtn = wb.querySelector('[data-act="ai-upgrade"]');
    if (aiBtn) aiBtn.onclick = (e) => {
      e.stopPropagation();
      if (aiBtn.disabled) return;
      aiUpgradePrompt();
    };
    const docAnnsEl = wb.querySelector('[data-act="open-doc-anns"]');
    if (docAnnsEl) docAnnsEl.onclick = (e) => {
      e.stopPropagation();
      if (e.target.closest('[data-act="clear-doc-anns"]')) return;
      // legacy: scroll to doc annotation list (existing behavior)
      renderAnnotationsSummary();
      const summary = $('#annotationsSummary');
      if (summary) summary.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    const clearAnnsEl = wb.querySelector('[data-act="clear-doc-anns"]');
    if (clearAnnsEl) clearAnnsEl.onclick = (e) => {
      e.stopPropagation();
      clearAnnotations();
    };
  }

  let _examplePickerEl = null;
  function closeExamplePicker() {
    if (_examplePickerEl) { _examplePickerEl.remove(); _examplePickerEl = null; }
  }
  function openExamplePicker(anchor) {
    closeExamplePicker();
    const examples = state.favoritePrompts || [];
    const selectedIds = new Set((state.composedExamples || []).map(e => e.createdAt + '_' + e.name));
    const popover = document.createElement('div');
    popover.className = 'example-picker';
    let bodyHTML;
    if (examples.length === 0) {
      bodyHTML = `<div class="ex-empty">还没有收藏的提示词示例。<br/>去图片/视频卡上点 ⭐ 收藏一些吧。</div>`;
    } else {
      bodyHTML = examples.map(e => {
        const id = e.createdAt + '_' + e.name;
        const checked = selectedIds.has(id) ? 'checked' : '';
        const thumb = e.imageSrc
          ? `<img class="ex-thumb" src="${escape(e.imageSrc)}" alt=""/>`
          : `<div class="ex-thumb-empty">${icon('image')}</div>`;
        const promptPreview = (e.prompt || '').slice(0, 30) + ((e.prompt || '').length > 30 ? '…' : '');
        return `<label class="ex-item">
          <input type="checkbox" class="ex-check" data-id="${escape(id)}" ${checked}/>
          ${thumb}
          <div class="ex-text">
            <div class="ex-name">${escape(e.name)}</div>
            <div class="ex-prompt">${escape(promptPreview)}</div>
          </div>
        </label>`;
      }).join('');
    }
    popover.innerHTML = `
      <div class="ex-head">选择参考的提示词示例（可多选）</div>
      <div class="ex-body">${bodyHTML}</div>
      <div class="ex-foot">
        ${examples.length > 0 ? `<span class="ex-count">已选 <strong id="exSelectedCount">${selectedIds.size}</strong> 项</span>` : '<span class="ex-count"></span>'}
        <button class="ex-manage-link" data-act="manage" type="button">${icon('settings')}<span>管理</span></button>
        ${examples.length > 0 ? `
        <button class="ex-btn cancel" data-act="cancel">取消</button>
        <button class="ex-btn primary" data-act="apply">应用</button>
        ` : `<button class="ex-btn cancel" data-act="cancel">关闭</button>`}
      </div>
    `;
    document.body.appendChild(popover);
    _examplePickerEl = popover;
    renderIcons();

    // Position above anchor
    const r = anchor.getBoundingClientRect();
    let left = r.left;
    let top = r.top - popover.offsetHeight - 6;
    if (top < 8) top = r.bottom + 6;
    if (left + popover.offsetWidth > window.innerWidth - 8) {
      left = window.innerWidth - popover.offsetWidth - 8;
    }
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';

    const updateCount = () => {
      const c = popover.querySelectorAll('.ex-check:checked').length;
      const el = popover.querySelector('#exSelectedCount');
      if (el) el.textContent = c;
    };
    popover.querySelectorAll('.ex-check').forEach(cb => cb.addEventListener('change', updateCount));

    popover.querySelector('[data-act="cancel"]')?.addEventListener('click', (e) => { e.stopPropagation(); closeExamplePicker(); });
    popover.querySelector('[data-act="manage"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeExamplePicker();
      openRpTab('examples');
    });
    popover.querySelector('[data-act="apply"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const checkedIds = new Set([...popover.querySelectorAll('.ex-check:checked')].map(cb => cb.dataset.id));
      state.composedExamples = examples.filter(e => checkedIds.has(e.createdAt + '_' + e.name));
      closeExamplePicker();
      renderComposerWorkbench();
    });

    // Close on outside click
    setTimeout(() => {
      const onDocClick = (e) => {
        if (!popover.contains(e.target) && !anchor.contains(e.target)) {
          closeExamplePicker();
          document.removeEventListener('mousedown', onDocClick, true);
        }
      };
      document.addEventListener('mousedown', onDocClick, true);
    }, 0);
  }

  async function aiUpgradePrompt() {
    const input = $('#promptInput');
    if (!input) return;
    const currentPrompt = input.value.trim();
    const anns = state.composedAnnotations || [];
    const examples = state.composedExamples || [];

    if (!currentPrompt && anns.length === 0 && examples.length === 0) {
      toast('需要 prompt、批注或示例至少其一');
      return;
    }

    // Build the user-message text input for LLM
    const parts = [];
    parts.push('## 用户当前 prompt');
    parts.push(currentPrompt || '（空）');
    if (anns.length > 0) {
      parts.push('\n## 用户的调整诉求（针对生成图片的批注）');
      anns.forEach((a, i) => {
        if (a.quote) parts.push(`${i + 1}. (针对"${a.quote}") ${a.text}`);
        else parts.push(`${i + 1}. ${a.text}`);
      });
    }
    if (examples.length > 0) {
      parts.push('\n## 用户参考的优秀提示词示例（请模仿其结构、用词、详细度）');
      examples.forEach((e, i) => parts.push(`${i + 1}. 【${e.name}】 ${e.prompt}`));
    }
    parts.push('\n## 请输出');
    parts.push('一段改写后的新 prompt。仅输出 prompt 文本本身，不要任何解释、不要前缀、不要 markdown。');
    const userText = parts.join('\n');

    const systemPrompt = `你是图像/视频提示词工程专家。基于用户提供的当前 prompt、调整诉求、参考示例，输出一段改写后的、更准确、更细节、与示例风格一致的新 prompt。

要求：
1. 保留用户原 prompt 的核心意图
2. 充分融入所有调整诉求
3. 模仿参考示例的结构、用词风格、详细度
4. 输出仅 prompt 文本本身，无解释、无前缀、无 markdown 标记
5. 用中文输出`;

    // Collect images (annotation source assets + example imageSrc)
    const images = [];
    anns.forEach(a => { if (a.assetSrc) images.push(a.assetSrc); });
    examples.forEach(e => { if (e.imageSrc) images.push(e.imageSrc); });

    // UI: button loading state
    const btn = document.querySelector('.wb-ai-btn');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    const originalPrompt = input.value;
    input.value = '';
    autoResizePrompt();

    try {
      await callLLM(systemPrompt, userText, (fullText) => {
        input.value = fullText;
        autoResizePrompt();
      }, {
        noJsonFormat: true,
        images,
        temperature: 0.7,
        maxTokens: 2048
      });
      // On success: clear workbench
      state.composedAnnotations = [];
      state.composedExamples = [];
      renderComposerWorkbench();
      updateSendBtn();
      toast('已改写 · 原版可 Ctrl+Z 撤销');
    } catch (e) {
      // Revert textarea on error
      input.value = originalPrompt;
      autoResizePrompt();
      updateSendBtn();
      toast('AI 提升失败：' + (e.message || '未知错误'));
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }

  // ───── document card rendering ─────
  function renderDocCard(doc, message) {
    const wrap = el('div', 'doc-card-wrap');
    const inner = el('div', 'doc-card-inner');
    const isSaved = message && message.assetId;
    // Look up current asset name (handles renames after archival)
    let displayTitle = doc.title;
    if (isSaved && currentProject) {
      const proj = currentProject();
      if (proj) {
        const found = findAsset(proj, message.assetId);
        if (found && found.asset.name) displayTitle = found.asset.name;
      }
    }
    const saveBtn = message ? `<button class="chat-save-btn doc-card-save${isSaved ? '' : ' muted'}" title="${isSaved ? '已归档 · 点击重新分类' : '保存到文件夹'}">${icon('folder-input')}</button>` : '';
    inner.innerHTML =
      `<div class="doc-card-thumb">${icon('file-text')}</div>` +
      `<div class="doc-card-info">` +
        `<div class="doc-card-title">${escape(displayTitle)}</div>` +
        `<div class="doc-card-meta">Document${doc.version ? ' · V' + doc.version : ''}${doc.updateNote ? ' · ' + escape(doc.updateNote) : ''}</div>` +
      `</div>` +
      (saveBtn ? `<div class="doc-card-actions">${saveBtn}</div>` : '');
    inner.onclick = (e) => {
      if (e.target.closest('.chat-save-btn')) return;
      // Route to Files tab + select archived asset (auto-archive if needed)
      let assetId = isSaved ? message.assetId : null;
      if (!assetId && message) {
        const archived = archiveAsChatAsset('text', doc, currentSession()?.id, message);
        assetId = archived?.id;
      }
      if (!assetId) return;
      openRightPanelMode();
      setRightPanelTab('files');
      // Find the folder this asset belongs to and switch to it
      const proj = currentProject();
      const found = proj ? findAsset(proj, assetId) : null;
      if (found && found.asset.folderId) {
        state.libraryUI.selectedFolderId = found.asset.folderId;
        state.libraryUI.expandedFolders.add(found.asset.folderId);
        renderFolderTree();
        renderFolderCardGrid();
      }
      selectAsset(assetId);
    };
    const sb = inner.querySelector('.chat-save-btn');
    if (sb && message) sb.onclick = (e) => { e.stopPropagation(); openChatSavePopover(sb, message._mid); };
    wrap.appendChild(inner);
    return wrap;
  }

  function renderTextGenCard(info) {
    const card = el('div', 'text-gen-card');
    card.innerHTML =
      `<div class="tg-header"><div class="spinner"></div><span>正在生成文档...</span></div>` +
      `<div class="tg-bar"><div style="width:${info.pct || 0}%;"></div></div>` +
      `<div class="tg-meta">${escape(info.skillLabel || '')} · ${escape(info.model || '')}</div>`;
    return card;
  }

  function renderSkillFileCard(name) {
    const wrap = el('div', 'doc-card-wrap');
    const inner = el('div', 'skill-card-inner');
    inner.innerHTML =
      `<div class="skill-card-header">${icon('zap')}<span>${escape(name)}.skill</span></div>` +
      `<div class="skill-card-meta">自定义技能 · 刚刚生成</div>` +
      `<button class="skill-card-dl">${icon('download')}<span>下载技能</span></button>`;
    inner.querySelector('.skill-card-dl').onclick = (e) => {
      e.stopPropagation();
      const blob = new Blob([JSON.stringify({ name, prompt: '自定义技能模板', format: 'structured' }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name + '.skill';
      a.click();
      URL.revokeObjectURL(url);
      toast('已下载: ' + name + '.skill');
    };
    wrap.appendChild(inner);
    return wrap;
  }

  // ───── panel collapse ─────
  function applyPanelStates() {
    $('#leftPanel').classList.toggle('panel-collapsed', state.leftCollapsed);
    $('#collapsedLeftChrome').style.display = state.leftCollapsed ? '' : 'none';
    document.body.classList.toggle('is-left-collapsed', !!state.leftCollapsed);
    // Right panel: edge handle visible iff panel is closed
    const panel = $('#rightPanel');
    const handle = $('#rpEdgeHandle');
    if (panel && handle) {
      panel.style.display = state.rightPanelOpen ? '' : 'none';
      handle.style.display = state.rightPanelOpen ? 'none' : '';
    }
    setTimeout(syncControlsCompact, 50);
  }

  // ───── library: folders, tree, cards, popovers ─────
  function findFolder(project, folderId) {
    return project.folders.find(f => f.id === folderId);
  }

  function buildFolderTree(folders) {
    const byParent = new Map();
    folders.forEach(f => {
      const k = f.parentId || '__root__';
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(f);
    });
    byParent.forEach(arr => arr.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    }));
    return byParent;
  }

  function descendantIds(project, folderId) {
    const ids = new Set();
    const stack = [folderId];
    while (stack.length) {
      const cur = stack.pop();
      ids.add(cur);
      project.folders.forEach(f => { if (f.parentId === cur) stack.push(f.id); });
    }
    return ids;
  }

  function countAssetsInFolders(project, folderIds) {
    let n = 0;
    ASSET_TYPES.forEach(type => {
      (project.assets[type] || []).forEach(a => { if (folderIds.has(a.folderId)) n++; });
    });
    return n;
  }

  function renderLibrary() {
    const proj = currentProject();
    if (!proj) return;
    if (!findFolder(proj, state.libraryUI.selectedFolderId)) {
      state.libraryUI.selectedFolderId = 'f_default';
    }
    state.libraryUI.expandedFolders.add('f_default');
    applyLibTreeCollapsedState();
    renderFolderTree();
    renderFolderCardGrid();
    // Restore selection if any
    if (state.libraryUI.selectedAssetId) {
      const found = findAsset(proj, state.libraryUI.selectedAssetId);
      if (found) {
        expandLowerPane();
        renderAssetDetailInPane(found.asset, found.type);
      } else {
        state.libraryUI.selectedAssetId = null;
        collapseLowerPane();
      }
    } else {
      collapseLowerPane();
    }
  }

  function renderFolderTree() {
    const proj = currentProject();
    if (!proj) return;
    const tree = $('#libTree');
    if (!tree) return;
    tree.innerHTML = '';

    const byParent = buildFolderTree(proj.folders);
    const expanded = state.libraryUI.expandedFolders;
    const selected = state.libraryUI.selectedFolderId;

    function renderNode(folder, depth) {
      const children = byParent.get(folder.id) || [];
      const hasChildren = children.length > 0;
      const isExpanded = expanded.has(folder.id);

      const row = document.createElement('div');
      row.className = 'folder-row' + (selected === folder.id ? ' active' : '');
      row.style.paddingLeft = (4 + depth * 14) + 'px';
      row.dataset.folderId = folder.id;

      const chevron = document.createElement('i');
      chevron.setAttribute('data-lucide', 'chevron-right');
      chevron.className = 'folder-chevron' + (hasChildren ? '' : ' empty') + (isExpanded ? ' expanded' : '');
      chevron.onclick = (e) => {
        e.stopPropagation();
        if (!hasChildren) return;
        if (isExpanded) expanded.delete(folder.id);
        else expanded.add(folder.id);
        renderFolderTree();
      };
      row.appendChild(chevron);

      const folderIcon = document.createElement('i');
      folderIcon.setAttribute('data-lucide', folder.isDefault ? 'folder-heart' : 'folder');
      folderIcon.className = 'folder-icon';
      row.appendChild(folderIcon);

      const name = document.createElement('span');
      name.className = 'folder-name';
      name.textContent = folder.name;
      row.appendChild(name);

      if (folder.isDefault) {
        const lock = document.createElement('i');
        lock.setAttribute('data-lucide', 'lock');
        lock.className = 'folder-lock';
        lock.title = '默认文件夹';
        row.appendChild(lock);
      }

      const actions = document.createElement('div');
      actions.className = 'folder-actions';
      const moreBtn = document.createElement('button');
      moreBtn.className = 'icon-btn folder-more-btn';
      moreBtn.title = '更多';
      moreBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';
      moreBtn.onclick = (e) => { e.stopPropagation(); openFolderMenu(moreBtn, folder); };
      actions.appendChild(moreBtn);
      row.appendChild(actions);

      row.onclick = () => {
        const wasSelected = state.libraryUI.selectedFolderId === folder.id;
        state.libraryUI.selectedFolderId = folder.id;
        deselectAsset();
        // Row-click toggle behavior (Notion / Linear style):
        // - first click on a collapsed folder → select + expand
        // - re-click on already-selected expanded folder → collapse (keeps select)
        // - clicking another already-expanded folder → keep it expanded, just switch select
        // - chevron click is a separate handler that toggles independently of select
        if (hasChildren) {
          if (!isExpanded) state.libraryUI.expandedFolders.add(folder.id);
          else if (wasSelected) state.libraryUI.expandedFolders.delete(folder.id);
        }
        renderFolderTree();
        renderFolderCardGrid();
      };

      tree.appendChild(row);

      if (isExpanded) {
        children.forEach(child => renderNode(child, depth + 1));
      }
    }

    const roots = byParent.get('__root__') || [];
    roots.forEach(root => renderNode(root, 0));

    renderIcons();
  }

  function createFolderInline(parentId) {
    const proj = currentProject();
    if (!proj) return;
    if (parentId) state.libraryUI.expandedFolders.add(parentId);
    const newFolder = { id: newId('f'), name: '新建文件夹', parentId: parentId || null, createdAt: Date.now() };
    proj.folders.push(newFolder);
    state.libraryUI.selectedFolderId = newFolder.id;
    renderFolderTree();
    setTimeout(() => startFolderRename(newFolder.id, true), 30);
  }

  function startFolderRename(folderId, isNew) {
    const proj = currentProject();
    if (!proj) return;
    const folder = findFolder(proj, folderId);
    if (!folder || folder.isDefault) return;
    const row = document.querySelector('.folder-row[data-folder-id="' + folderId + '"]');
    if (!row) return;
    const nameEl = row.querySelector('.folder-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = folder.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = (save) => {
      const v = input.value.trim();
      if (save && v && v !== folder.name) {
        folder.name = v;
        persistState();
      } else if (isNew && !v) {
        proj.folders = proj.folders.filter(f => f.id !== folderId);
        if (state.libraryUI.selectedFolderId === folderId) state.libraryUI.selectedFolderId = 'f_default';
      }
      renderFolderTree();
      renderFolderCardGrid();
    };

    input.onblur = () => commit(true);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { input.value = folder.name; input.blur(); }
    };
  }

  function safeFileName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').trim() || 'file';
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  function triggerSrcDownload(src, filename) {
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);
  }

  function buildAssetFileName(asset) {
    const base = safeFileName(asset.name) + (asset.version ? '_v' + asset.version : '');
    if (asset.type === 'text') return base + '.md';
    // For media: try to keep original extension from src
    const m = (asset.src || '').match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
    const ext = m ? m[1] : (asset.type === 'image' ? 'png' : 'mp4');
    return base + '.' + ext;
  }

  async function downloadFolder(folderId) {
    const proj = currentProject();
    if (!proj) return;
    const folder = findFolder(proj, folderId);
    if (!folder) return;
    const ids = descendantIds(proj, folderId);
    const items = [];
    ASSET_TYPES.forEach(type => {
      (proj.assets[type] || []).forEach(a => { if (ids.has(a.folderId)) items.push(a); });
    });
    if (items.length === 0) { toast('文件夹为空'); return; }

    if (items.length > 1) {
      const ok = await confirmDialog({
        title: '批量下载「' + folder.name + '」?',
        message: '将下载 ' + items.length + ' 个文件，浏览器可能会提示是否允许多文件下载。',
        okText: '开始下载', cancelText: '取消'
      });
      if (!ok) return;
    }

    let count = 0;
    for (const asset of items) {
      const filename = buildAssetFileName(asset);
      try {
        if (asset.type === 'text') {
          const header = '# ' + (asset.name || '文档') + (asset.version ? ' V' + asset.version : '') + '\n\n';
          const blob = new Blob([header + (asset.body || '')], { type: 'text/markdown;charset=utf-8' });
          triggerBlobDownload(blob, filename);
        } else if (asset.src) {
          triggerSrcDownload(asset.src, filename);
        }
        count++;
        await new Promise(r => setTimeout(r, 220));
      } catch (e) {
        console.warn('[download] failed for', asset.id, e);
      }
    }
    toast('已下载 ' + count + ' 个文件');
  }

  async function deleteFolder(folderId) {
    const proj = currentProject();
    if (!proj) return;
    const folder = findFolder(proj, folderId);
    if (!folder || folder.isDefault) return;
    const ids = descendantIds(proj, folderId);
    const fileCount = countAssetsInFolders(proj, ids);
    const folderCount = ids.size;
    const msg = '该文件夹' + (folderCount > 1 ? '及其 ' + (folderCount - 1) + ' 个子文件夹' : '') +
      '下的 ' + fileCount + ' 个文件将移动到「默认」。';
    const ok = await confirmDialog({ title: '删除文件夹「' + folder.name + '」？', message: msg, okText: '删除', cancelText: '取消' });
    if (!ok) return;

    ASSET_TYPES.forEach(type => {
      (proj.assets[type] || []).forEach(a => { if (ids.has(a.folderId)) a.folderId = 'f_default'; });
    });
    proj.folders = proj.folders.filter(f => !ids.has(f.id));
    if (ids.has(state.libraryUI.selectedFolderId)) state.libraryUI.selectedFolderId = 'f_default';

    persistState();
    renderLibrary();
    toast('已删除');
  }

  function renderBreadcrumb() {
    const proj = currentProject();
    const el = $('#libBreadcrumb');
    if (!el || !proj) return;
    const folder = findFolder(proj, state.libraryUI.selectedFolderId);
    if (!folder) { el.textContent = ''; return; }
    const chain = [];
    let cur = folder;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? findFolder(proj, cur.parentId) : null;
    }
    el.innerHTML = chain.map((f, i) => {
      const isLast = i === chain.length - 1;
      return '<span class="' + (isLast ? 'crumb' : '') + '">' + escape(f.name) + '</span>' +
             (isLast ? '' : '<span class="crumb-sep">/</span>');
    }).join('');
  }

  function renderFolderCardGrid() {
    const proj = currentProject();
    const grid = $('#libGrid');
    const empty = $('#libEmpty');
    const breadcrumb = $('#libBreadcrumb');
    if (!proj || !grid) return;

    const query = (state.libraryUI.searchQuery || '').trim().toLowerCase();
    const items = [];

    if (query) {
      // Search across all assets in current project — name + body + prompt + annotation text
      ASSET_TYPES.forEach(type => {
        (proj.assets[type] || []).forEach(a => {
          const name = (a.name || '').toLowerCase();
          const body = (a.body || '').toLowerCase();
          const prompt = (a.prompt || '').toLowerCase();
          const anns = (a.annotations || []);
          const annHit = anns.find(an => (an.text || '').toLowerCase().includes(query));
          let hitField = null, hitText = null;
          if (name.includes(query)) { hitField = 'name'; }
          else if (annHit) { hitField = 'annotation'; hitText = annHit.text; }
          else if (prompt.includes(query)) { hitField = 'prompt'; hitText = a.prompt; }
          else if (body.includes(query)) { hitField = 'body'; hitText = a.body; }
          if (hitField) {
            items.push({ asset: a, hitField, hitText });
          }
        });
      });
      if (breadcrumb) breadcrumb.innerHTML = `<span class="crumb">搜索结果</span><span class="crumb-sep">·</span><span>${items.length} 项匹配「${escape(query)}」</span>`;
    } else {
      const folderId = state.libraryUI.selectedFolderId;
      ASSET_TYPES.forEach(type => {
        (proj.assets[type] || []).forEach(a => { if (a.folderId === folderId) items.push({ asset: a }); });
      });
      renderBreadcrumb();
    }
    items.sort((a, b) => (b.asset.createdAt || 0) - (a.asset.createdAt || 0));

    if (items.length === 0) {
      grid.innerHTML = '';
      if (empty) {
        empty.style.display = '';
        empty.textContent = query ? '没有匹配的文件' : '此文件夹暂无文件';
      }
      return;
    }
    if (empty) empty.style.display = 'none';

    grid.innerHTML = items.map(it => renderAssetCard(it.asset, query, it.hitField, it.hitText)).join('');
    bindCardEvents();
    renderIcons();
  }

  function applyLibTreeCollapsedState() {
    const wrap = $('#libTreeWrap');
    const rail = $('#libTreeRail');
    const collapsed = !!state.libraryUI.treeCollapsed;
    if (wrap) wrap.style.display = collapsed ? 'none' : '';
    if (rail) rail.style.display = collapsed ? '' : 'none';
  }

  function highlightQuery(text, query) {
    if (!query) return escape(text);
    const safe = escape(text);
    const safeQuery = escape(query);
    const re = new RegExp(safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, m => `<mark class="card-hit-mark">${m}</mark>`);
  }

  function buildHitSnippet(text, query, maxLen = 60) {
    if (!text || !query) return '';
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return escape(text.slice(0, maxLen));
    const start = Math.max(0, idx - 12);
    const end = Math.min(text.length, idx + query.length + maxLen - 12);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return highlightQuery(snippet, query);
  }

  function renderAssetCard(asset, query, hitField, hitText) {
    const ver = asset.version ? `<span class="card-version">V${asset.version}</span>` : '';
    const menuBtn = `<button class="card-menu-btn" data-asset-id="${asset.id}" data-asset-type="${asset.type}" title="更多"><i data-lucide="more-horizontal"></i></button>`;

    const time = formatRelativeTime(asset.createdAt);
    const source = sourceSessionLabel(asset.sourceSessionId);
    const metaParts = [];
    if (time) metaParts.push(escape(time));
    if (source) metaParts.push(escape(source));
    const metaRow = metaParts.length
      ? `<div class="card-meta">${metaParts.join(' · ')}</div>`
      : '';

    // Search hit snippet
    let hitRow = '';
    if (query && hitField && hitField !== 'name') {
      const snippet = buildHitSnippet(hitText || '', query);
      const labelMap = { annotation: '批注', prompt: '提示词', body: '内容' };
      hitRow = snippet
        ? `<div class="card-hit"><span class="card-hit-label">${labelMap[hitField] || ''}：</span>${snippet}</div>`
        : '';
    }

    const nameHTML = query && hitField === 'name'
      ? highlightQuery(asset.name || '未命名', query)
      : escape(asset.name || '未命名');

    if (asset.type === 'text') {
      const excerpt = (asset.body || '').substring(0, 160);
      const verDoc = asset.version ? `<span class="card-doc-version">V${asset.version}</span>` : '';
      return `<div class="lib-card lib-card-doc${asset._isNew ? ' is-new' : ''}" data-asset-id="${asset.id}" data-asset-type="text">
        ${menuBtn}
        <div class="card-doc-head">
          <i data-lucide="file-text" class="card-doc-icon"></i>
          <span class="card-doc-name">${nameHTML}</span>
          ${verDoc}
        </div>
        <div class="card-doc-excerpt">${escape(excerpt)}</div>
        <div class="card-doc-meta"><span>${escape(time)}</span><span>${escape(source || '')}</span></div>
        ${hitRow}
      </div>`;
    }

    if (asset.type === 'image') {
      return `<div class="lib-card lib-card-image${asset._isNew ? ' is-new' : ''}" data-asset-id="${asset.id}" data-asset-type="image">
        ${menuBtn}
        <img class="card-thumb" src="${escape(asset.src || '')}" alt="${escape(asset.name || '')}" />
        <div class="card-foot"><span class="card-name">${nameHTML}</span>${ver}</div>
        ${metaRow}
        ${hitRow}
      </div>`;
    }

    if (asset.type === 'video') {
      const dur = asset.duration ? `<span class="card-duration">${escape(asset.duration)}</span>` : '';
      return `<div class="lib-card lib-card-video${asset._isNew ? ' is-new' : ''}" data-asset-id="${asset.id}" data-asset-type="video">
        ${menuBtn}
        <div class="card-thumb-wrap">
          <img class="card-thumb" src="${escape(asset.src || '')}" alt="${escape(asset.name || '')}" />
          <div class="card-play"><i data-lucide="play"></i></div>
          ${dur}
        </div>
        <div class="card-foot"><span class="card-name">${nameHTML}</span>${ver}</div>
        ${metaRow}
        ${hitRow}
      </div>`;
    }
    return '';
  }

  function sourceSessionLabel(sessionId) {
    if (!sessionId) return '';
    for (const p of state.projects) {
      const s = p.sessions.find(s => s.id === sessionId);
      if (s) return s.name;
    }
    return '';
  }

  function findSessionById(sessionId) {
    if (!sessionId) return null;
    for (const p of state.projects) {
      const s = p.sessions.find(s => s.id === sessionId);
      if (s) return { project: p, session: s };
    }
    return null;
  }

  function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  function findAsset(project, assetId) {
    for (const type of ASSET_TYPES) {
      const a = (project.assets[type] || []).find(x => x.id === assetId);
      if (a) return { asset: a, type };
    }
    return null;
  }

  function bindCardEvents() {
    const cardsContainer = document.querySelector('.lib-cards');
    if (cardsContainer) cardsContainer.classList.toggle('multi-mode', state.libraryUI.multiSelect.active);

    document.querySelectorAll('.lib-card').forEach(el => {
      const assetId = el.dataset.assetId;
      // Inject multi-select mark element if missing
      if (!el.querySelector('.ms-mark')) {
        const mark = document.createElement('div');
        mark.className = 'ms-mark';
        mark.innerHTML = icon('check');
        el.appendChild(mark);
      }
      // Reflect selected state
      el.classList.toggle('ms-selected', state.libraryUI.multiSelect.selected.has(assetId));

      el.onclick = (e) => {
        if (e.target.closest('.card-menu-btn')) return;
        // Cmd/Ctrl+click → multi-select toggle
        if (e.metaKey || e.ctrlKey) {
          toggleMultiSelectAsset(assetId);
          return;
        }
        // If multi-mode active, plain click also toggles (intuitive)
        if (state.libraryUI.multiSelect.active) {
          toggleMultiSelectAsset(assetId);
          return;
        }
        selectAsset(assetId);
      };
      // Drag to chat composer
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        const type = el.dataset.assetType;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-vedioagent-asset', JSON.stringify({ assetId, type }));
        e.dataTransfer.setData('text/plain', assetId);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });
    document.querySelectorAll('.card-menu-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openCardOverflowMenu(btn);
      };
    });
    // Mark currently selected card (single-select)
    const sel = state.libraryUI.selectedAssetId;
    if (sel) {
      document.querySelectorAll('.lib-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.assetId === sel);
      });
    }
    renderIcons();
  }

  function toggleMultiSelectAsset(assetId) {
    const ms = state.libraryUI.multiSelect;
    if (ms.selected.has(assetId)) ms.selected.delete(assetId);
    else ms.selected.add(assetId);
    if (ms.selected.size > 0 && !ms.active) ms.active = true;
    if (ms.selected.size === 0) ms.active = false;
    renderMultiSelectBar();
    bindCardEvents();
  }

  function exitMultiSelect() {
    state.libraryUI.multiSelect.active = false;
    state.libraryUI.multiSelect.selected.clear();
    renderMultiSelectBar();
    bindCardEvents();
  }

  function renderMultiSelectBar() {
    const bar = $('#libMultiBar');
    if (!bar) return;
    const ms = state.libraryUI.multiSelect;
    if (!ms.active) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = '';
    bar.innerHTML =
      `<span class="ms-count">已选 ${ms.selected.size} 项</span>` +
      `<button class="ms-btn" data-act="select-all">${icon('check-square')}<span>全选</span></button>` +
      `<button class="ms-btn" data-act="download">${icon('download')}<span>下载</span></button>` +
      `<button class="ms-btn danger" data-act="delete">${icon('trash-2')}<span>删除</span></button>` +
      `<button class="ms-close" data-act="exit" title="退出多选">${icon('x')}</button>`;
    renderIcons();

    bar.querySelector('[data-act="select-all"]').onclick = () => {
      document.querySelectorAll('.lib-card').forEach(c => {
        ms.selected.add(c.dataset.assetId);
      });
      renderMultiSelectBar();
      bindCardEvents();
    };
    bar.querySelector('[data-act="download"]').onclick = () => {
      toast(`下载 ${ms.selected.size} 项 (mock)`);
    };
    bar.querySelector('[data-act="delete"]').onclick = async () => {
      const count = ms.selected.size;
      const ok = await confirmDialog({
        title: '删除选中项',
        message: `确认删除 ${count} 项资产？此操作不可撤销。`,
        okText: '删除', cancelText: '取消'
      });
      if (!ok) return;
      const proj = currentProject();
      if (proj) {
        ms.selected.forEach(id => {
          ASSET_TYPES.forEach(t => {
            proj.assets[t] = (proj.assets[t] || []).filter(a => a.id !== id);
          });
        });
      }
      exitMultiSelect();
      renderFolderCardGrid();
      persistState();
      toast(`已删除 ${count} 项`);
    };
    bar.querySelector('[data-act="exit"]').onclick = exitMultiSelect;
  }

  function bindLibDivider() {
    const divider = $('#libDivider');
    const upper = $('#libUpper');
    const lower = $('#libLower');
    const pane = $('#rpFilesPane');
    if (!divider || !upper || !lower || !pane) return;

    let dragging = false;
    let startY = 0;
    let startUpperH = 0;
    let totalH = 0;

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startUpperH = upper.offsetHeight;
      const lowerH = lower.offsetHeight;
      totalH = startUpperH + lowerH;
      divider.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const newUpperH = startUpperH + dy;
      const ratio = Math.max(0.2, Math.min(0.85, newUpperH / totalH));
      upper.style.flex = ratio + ' 1 0';
      lower.style.flex = (1 - ratio) + ' 1 0';
      state.libraryUI.splitRatio = ratio;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistState();
    });
  }

  function bindLibrarySearch() {
    const input = $('#libSearchInput');
    const clear = $('#libSearchClear');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.libraryUI.searchQuery = input.value;
        if (clear) clear.style.display = input.value ? '' : 'none';
        deselectAsset();
        renderFolderCardGrid();
      }, 150);
    });
    if (clear) clear.addEventListener('click', () => {
      input.value = '';
      state.libraryUI.searchQuery = '';
      clear.style.display = 'none';
      deselectAsset();
      renderFolderCardGrid();
      input.focus();
    });
  }

  function bindComposerDropTarget() {
    const card = document.querySelector('.input-card');
    if (!card) return;
    let depth = 0;
    card.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('application/x-vedioagent-asset')) return;
      e.preventDefault();
      depth++;
      card.classList.add('drag-target');
    });
    card.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-vedioagent-asset')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    card.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) card.classList.remove('drag-target');
    });
    card.addEventListener('drop', (e) => {
      const data = e.dataTransfer.getData('application/x-vedioagent-asset');
      if (!data) return;
      e.preventDefault();
      depth = 0;
      card.classList.remove('drag-target');
      try {
        const { assetId, type } = JSON.parse(data);
        addAssetAsRef(assetId, type);
      } catch (err) { /* noop */ }
    });
  }

  function addAssetAsRef(assetId, type) {
    const proj = currentProject();
    if (!proj) return;
    const found = findAsset(proj, assetId);
    if (!found) return;
    const a = found.asset;
    if (state.refMaterials.length >= 12) { toast('最多 12 个附件'); return; }
    // Avoid dupes
    if (state.refMaterials.some(r => r.assetId === assetId)) { toast('已添加过'); return; }
    state.refMaterials.push({
      id: 'r_' + Date.now(),
      assetId: a.id,
      type: a.type,
      name: a.name || '',
      src: a.src || '',
      version: a.version
    });
    renderAttachArea();
    updateSendBtn();
    toast('已添加到参考');
  }

  function selectAsset(assetId) {
    const proj = currentProject();
    if (!proj) return;
    const found = findAsset(proj, assetId);
    if (!found) return;
    state.libraryUI.selectedAssetId = assetId;
    expandLowerPane();
    renderAssetDetailInPane(found.asset, found.type);
    // Highlight selected card
    document.querySelectorAll('.lib-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.assetId === assetId);
    });
    persistState();
  }

  function deselectAsset() {
    state.libraryUI.selectedAssetId = null;
    collapseLowerPane();
    document.querySelectorAll('.lib-card.selected').forEach(c => c.classList.remove('selected'));
    persistState();
  }

  function expandLowerPane() {
    const lower = $('#libLower');
    if (!lower) return;
    lower.style.display = '';
    // Use rAF so the transition runs from translateX(100%) → 0
    requestAnimationFrame(() => { lower.classList.add('is-open'); });
  }

  function collapseLowerPane() {
    const lower = $('#libLower');
    if (!lower) return;
    lower.classList.remove('is-open');
    // Wait for slide-out, then hide from layout to avoid intercepting events
    setTimeout(() => {
      if (!lower.classList.contains('is-open')) lower.style.display = 'none';
    }, 260);
  }

  function renderAssetDetailInPane(asset, type) {
    const titleEl = $('#libLowerTitle');
    const versionEl = $('#libLowerVersion');
    const body = $('#libLowerBody');
    if (!body) return;

    if (titleEl) titleEl.textContent = asset.name || (type === 'text' ? '文档' : type === 'image' ? '图片' : '视频');
    if (versionEl) versionEl.textContent = asset.version ? 'V' + asset.version : '';

    if (type === 'image' || type === 'video') {
      // ── JiMeng-style unified card (consistent with chat area)
      const isVideo = type === 'video';
      const ratio = '9:16';                              // assume portrait for drama; could be inferred per-asset later
      const shape = isVideo || asset.src?.includes('placeholder-image-v') || asset.src?.includes('placeholder-video-v')
        ? 'portrait' : 'landscape';
      const mediaTag = isVideo
        ? `<video src="${escape(asset.src || '')}" controls></video>`
        : `<img src="${escape(asset.src || '')}" alt="${escape(asset.name || '')}" />`;

      const promptHeader = asset.prompt
        ? `<div class="jm-header">
            <div class="jm-header-body">
              <div class="jm-prompt jm-prompt-full">${escape(asset.prompt)}</div>
            </div>
            <button class="jm-prompt-copy" data-prompt="${escape(asset.prompt)}" title="复制提示词">${icon('copy')}</button>
          </div>`
        : '';

      const bodyHTML = `<div class="jm-body ${shape}">${mediaTag}</div>`;

      const defaultModel = isVideo ? 'Seedance 2.0' : 'GPT Image 2';
      const model = defaultModel;
      const resolution = '720P';
      const sourceLabel = sourceSessionLabel(asset.sourceSessionId);
      const timeStr = formatDateTime(asset.createdAt);
      const pair = (k, v, extraCls) => `<span><span class="k">${k}</span><span class="v${extraCls ? ' ' + extraCls : ''}">${v}</span></span>`;
      const sep = `<span class="sep">·</span>`;
      const infoParts = [
        pair('模型', escape(model)),
        pair('比例', ratio),
        pair('分辨率', resolution)
      ];
      if (isVideo && asset.duration) infoParts.push(pair('秒数', escape(asset.duration)));
      if (timeStr) infoParts.push(pair('生成时间', escape(timeStr)));
      if (sourceLabel) {
        infoParts.push(`<span><span class="k">来源</span><span class="v jm-source-link" data-jump-asset="${escape(asset.id)}">${escape(sourceLabel)}</span></span>`);
      }
      const infoRowHTML = `<div class="jm-info-row">${infoParts.join(sep)}</div>`;

      const actionsHTML = `<div class="jm-actions">
        <button class="jm-btn" data-act="reedit">${icon('edit-3')}<span>重新编辑</span></button>
        <button class="jm-btn" data-act="regen">${icon('refresh-cw')}<span>再次生成</span></button>
        <button class="jm-btn" data-act="favorite">${icon('star')}<span>收藏为提示词示例</span></button>
        <button class="jm-btn" data-act="save-to-folder">${icon('folder-input')}<span>移动到文件夹</span></button>
      </div>`;

      const cardHTML = `<div class="jm-wrap jm-detail-wrap">
        <div class="jm-card">${promptHeader}${bodyHTML}${infoRowHTML}</div>
        ${actionsHTML}
      </div>`;

      const annList = asset.annotations || [];
      const sortedAnns = [...annList].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const annHtml = sortedAnns.length === 0
        ? `<div class="asset-detail-annotation-empty">还没有批注。选中提示词文字 → "添加批注"，或点 <strong>+</strong> 写整篇批注。</div>`
        : sortedAnns.map((a) => {
            const inComposer = !!(state.composedAnnotations || []).find(c => c.annotationId === a.id);
            const newClass = a._isNew ? ' is-new' : '';
            const addBtn = inComposer
              ? `<button class="ann-add-btn added" disabled>${icon('check')}<span>已加</span></button>`
              : `<button class="ann-add-btn" data-act="add-to-composer" data-ann-id="${escape(a.id)}">${icon('arrow-right')}<span>加到对话框</span></button>`;
            const authorName = a.author || ((state.user && state.user.name) || '我');
            const quoteHTML = a.quote ? `<div class="ann-quote">"${escape(a.quote)}"</div>` : '';
            const imagesHTML = (a.images && a.images.length)
              ? `<div class="ann-images">${a.images.map((src, i) =>
                  `<img class="ann-img-thumb" src="${escape(src)}" data-ann-id="${escape(a.id)}" data-img-idx="${i}" alt="批注图"/>`
                ).join('')}</div>`
              : '';
            return `<div class="asset-detail-annotation-item${newClass}" data-ann-id="${escape(a.id)}">` +
              quoteHTML +
              `<div class="ann-text">${escape(a.text || '')}</div>` +
              imagesHTML +
              `<div class="ann-row">` +
                `<span class="ann-author">${escape(authorName)}</span>` +
                `<span class="ann-meta-sep">·</span>` +
                `<span class="ann-time">${escape(formatRelativeTime(a.createdAt) || '')}</span>` +
                `<span class="ann-spacer"></span>` +
                addBtn +
                `<button class="ann-delete" data-ann-id="${escape(a.id)}" title="删除批注">${icon('trash-2')}</button>` +
              `</div>` +
            `</div>`;
          }).join('');
      const annSection =
        `<div class="asset-detail-section">
          <div class="asset-detail-section-title">
            <i data-lucide="pin"></i><span>批注</span>${annList.length > 0 ? `<span class="asset-detail-count-badge">${annList.length}</span>` : ''}
            <button class="asset-detail-section-action icon-only" data-act="add-annotation" title="添加整篇批注">${icon('plus')}</button>
          </div>
          <div class="asset-detail-annotation-list">${annHtml}</div>
        </div>`;

      // Layout: JiMeng card (prompt + media + info) → actions → annotations
      body.innerHTML = `<div class="asset-detail">
        ${cardHTML}
        ${annSection}
      </div>`;

      // Bind prompt text-selection annotation (only the prompt text, not info row)
      const promptEl = body.querySelector('.jm-prompt-full');
      if (promptEl) bindDocSelectionAnnotation(promptEl, asset, type);

      // Copy prompt
      body.querySelector('.jm-prompt-copy')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = e.currentTarget.dataset.prompt || '';
        navigator.clipboard.writeText(text).then(() => toast('已复制提示词')).catch(() => toast('复制失败'));
      });
      // Source-session jump
      body.querySelector('[data-jump-asset]')?.addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.jumpAsset;
        const proj = currentProject();
        if (!proj) return;
        const f = findAsset(proj, id);
        if (f) jumpToAssetSource(f.asset);
      });
      // Action buttons (reedit / regen / favorite)
      body.querySelectorAll('.jm-btn').forEach(b => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const act = b.dataset.act;
          if (act === 'favorite') {
            openFavoriteModal(asset.prompt || '', asset.src || null);
            return;
          }
          if (act === 'save-to-folder') {
            openMovePopover(b, asset.id, type);
            return;
          }
          // For reedit / regen: ensure user is in the asset's source session
          if (asset.sourceSessionId && asset.sourceSessionId !== state.currentSessionId) {
            const found = findSessionById(asset.sourceSessionId);
            if (!found) {
              toast('该资产的来源会话已不存在');
              return;
            }
            const actLabel = act === 'reedit' ? '重新编辑' : '再次生成';
            const ok = await confirmDialog({
              title: '切换到来源会话',
              message: `${actLabel}需要在原会话「${found.session.name}」中进行。是否切换？`,
              okText: '切换并' + (act === 'reedit' ? '编辑' : '生成'),
              cancelText: '取消'
            });
            if (!ok) return;
            switchSession(found.project.id, found.session.id);
          }
          // Execute action (mock — prefill / toast only)
          if (act === 'reedit') {
            const ta = $('#promptInput');
            if (ta && asset.prompt) {
              ta.value = asset.prompt;
              ta.focus();
              if (typeof autoResizePrompt === 'function') autoResizePrompt();
              if (typeof updateSendBtn === 'function') updateSendBtn();
              if (typeof renderComposerWorkbench === 'function') renderComposerWorkbench();
              toast('已填入提示词，可编辑后发送');
            } else {
              toast('该资产无提示词记录');
            }
          } else if (act === 'regen') {
            toast('再次生成 (mock)');
          }
        };
      });

      // Annotation handlers
      body.querySelector('[data-act="add-annotation"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddAnnotationModal(asset, () => {
          // re-render this asset detail after save
          renderAssetDetailInPane(asset, type);
        });
      });
      // Per-row "加到对话框" buttons
      body.querySelectorAll('[data-act="add-to-composer"]').forEach(b => {
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = b.dataset.annId;
          const ann = (asset.annotations || []).find(a => a.id === id);
          addAnnotationToComposer(asset, ann, type);
        });
      });
      // Annotation image thumbnails → lightbox preview
      body.querySelectorAll('.ann-img-thumb').forEach(img => {
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          openLightbox('image', img.getAttribute('src') || '', '批注图');
        });
      });
      // Delete annotation
      body.querySelectorAll('.ann-delete').forEach(b => {
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = b.dataset.annId;
          asset.annotations = (asset.annotations || []).filter(a => a.id !== id);
          // Also remove from composer if present
          state.composedAnnotations = state.composedAnnotations.filter(c => c.annotationId !== id);
          renderComposerWorkbench();
          renderAssetDetailInPane(asset, type);
          if (typeof persistState === 'function') persistState();
        });
      });
      // Auto-scroll to and consume "is-new" flag on freshly created annotation
      const newRow = body.querySelector('.asset-detail-annotation-item.is-new');
      if (newRow) {
        setTimeout(() => {
          newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 80);
        // Clear the flag after the animation so it doesn't re-trigger
        setTimeout(() => {
          const id = newRow.dataset.annId;
          const ann = (asset.annotations || []).find(a => a.id === id);
          if (ann) delete ann._isNew;
        }, 1800);
      }
    } else if (type === 'text') {
      const md = asset.body || '';
      // Info row data
      const sourceLabel = sourceSessionLabel(asset.sourceSessionId);
      const timeStr = formatRelativeTime(asset.createdAt);
      const pair = (k, v, extraCls) => `<span><span class="k">${k}</span><span class="v${extraCls ? ' ' + extraCls : ''}">${v}</span></span>`;
      const sep = `<span class="sep">·</span>`;
      const infoParts = [pair('类型', '文档')];
      if (asset.version) infoParts.push(pair('版本', 'V' + asset.version));
      if (timeStr) infoParts.push(pair('创建', escape(timeStr)));
      if (sourceLabel) infoParts.push(`<span><span class="k">来源</span><span class="v jm-source-link" data-jump-asset="${escape(asset.id)}">${escape(sourceLabel)}</span></span>`);
      const infoRowHTML = `<div class="jm-info-row">${infoParts.join(sep)}</div>`;

      const actionsHTML = `<div class="jm-actions">
        <button class="jm-btn" data-act="copy-doc">${icon('clipboard')}<span>复制全文</span></button>
        <button class="jm-btn" data-act="download-doc">${icon('download')}<span>下载文档</span></button>
      </div>`;

      // Annotation list (reuse same structure as image/video, with optional quote line)
      const annList = asset.annotations || [];
      const sortedAnns = [...annList].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const annHtml = sortedAnns.length === 0
        ? `<div class="asset-detail-annotation-empty">还没有批注。选中文字 → "添加批注"，或点 <strong>+</strong> 写整篇批注。</div>`
        : sortedAnns.map((a) => {
            const inComposer = !!(state.composedAnnotations || []).find(c => c.annotationId === a.id);
            const newClass = a._isNew ? ' is-new' : '';
            const addBtn = inComposer
              ? `<button class="ann-add-btn added" disabled>${icon('check')}<span>已加</span></button>`
              : `<button class="ann-add-btn" data-act="add-to-composer" data-ann-id="${escape(a.id)}">${icon('arrow-right')}<span>加到对话框</span></button>`;
            const authorName = a.author || ((state.user && state.user.name) || '我');
            const quoteHTML = a.quote ? `<div class="ann-quote">"${escape(a.quote)}"</div>` : '';
            const imagesHTML = (a.images && a.images.length)
              ? `<div class="ann-images">${a.images.map((src, i) =>
                  `<img class="ann-img-thumb" src="${escape(src)}" data-ann-id="${escape(a.id)}" data-img-idx="${i}" alt="批注图"/>`
                ).join('')}</div>`
              : '';
            return `<div class="asset-detail-annotation-item${newClass}" data-ann-id="${escape(a.id)}">` +
              quoteHTML +
              `<div class="ann-text">${escape(a.text || '')}</div>` +
              imagesHTML +
              `<div class="ann-row">` +
                `<span class="ann-author">${escape(authorName)}</span>` +
                `<span class="ann-meta-sep">·</span>` +
                `<span class="ann-time">${escape(formatRelativeTime(a.createdAt) || '')}</span>` +
                `<span class="ann-spacer"></span>` +
                addBtn +
                `<button class="ann-delete" data-ann-id="${escape(a.id)}" title="删除批注">${icon('trash-2')}</button>` +
              `</div>` +
            `</div>`;
          }).join('');
      const annSection =
        `<div class="asset-detail-section">
          <div class="asset-detail-section-title">
            <i data-lucide="pin"></i><span>批注</span>${annList.length > 0 ? `<span class="asset-detail-count-badge">${annList.length}</span>` : ''}
            <button class="asset-detail-section-action icon-only" data-act="add-annotation" title="添加整篇批注">${icon('plus')}</button>
          </div>
          <div class="asset-detail-annotation-list">${annHtml}</div>
        </div>`;

      const cardHTML = `<div class="jm-wrap jm-detail-wrap">
        <div class="jm-card jm-card-doc">
          <div class="jm-body jm-body-doc"><div class="doc-content" id="docContent">${renderMarkdown(md)}</div></div>
          ${infoRowHTML}
        </div>
        ${actionsHTML}
      </div>`;

      body.innerHTML = `<div class="asset-detail">
        ${cardHTML}
        ${annSection}
      </div>`;

      // Bind text-selection annotation toolbar/popover
      const docContentEl = body.querySelector('.doc-content');
      if (docContentEl) bindDocSelectionAnnotation(docContentEl, asset, type);

      // Bind action buttons
      body.querySelectorAll('.jm-btn').forEach(b => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const act = b.dataset.act;
          if (act === 'copy-doc') {
            try { await navigator.clipboard.writeText(asset.body || ''); toast('已复制全文'); }
            catch (err) { toast('复制失败'); }
            return;
          }
          if (act === 'download-doc') {
            const blob = new Blob([asset.body || ''], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = (asset.name || '文档') + '.md';
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
            toast('已下载');
            return;
          }
          // reedit / regen — session check + switch
          if (asset.sourceSessionId && asset.sourceSessionId !== state.currentSessionId) {
            const found = findSessionById(asset.sourceSessionId);
            if (!found) { toast('该资产的来源会话已不存在'); return; }
            const actLabel = act === 'reedit' ? '重新编辑' : '再次生成';
            const ok = await confirmDialog({
              title: '切换到来源会话',
              message: `${actLabel}需要在原会话「${found.session.name}」中进行。是否切换？`,
              okText: '切换并' + (act === 'reedit' ? '编辑' : '生成'),
              cancelText: '取消'
            });
            if (!ok) return;
            switchSession(found.project.id, found.session.id);
          }
          if (act === 'reedit') {
            toast('已切换到来源会话，可继续编辑');
          } else if (act === 'regen') {
            toast('再次生成 (mock)');
          }
        };
      });
      // Source link
      body.querySelector('[data-jump-asset]')?.addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.jumpAsset;
        const proj = currentProject();
        if (!proj) return;
        const f = findAsset(proj, id);
        if (f) jumpToAssetSource(f.asset);
      });
      // Add annotation
      body.querySelector('[data-act="add-annotation"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddAnnotationModal(asset, () => renderAssetDetailInPane(asset, type));
      });
      // Per-row "加到对话框"
      body.querySelectorAll('[data-act="add-to-composer"]').forEach(b => {
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const id = b.dataset.annId;
          const ann = (asset.annotations || []).find(a => a.id === id);
          addAnnotationToComposer(asset, ann, type);
        });
      });
      // Annotation image thumbnails → lightbox preview
      body.querySelectorAll('.ann-img-thumb').forEach(img => {
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          openLightbox('image', img.getAttribute('src') || '', '批注图');
        });
      });
      // Delete annotation
      body.querySelectorAll('.ann-delete').forEach(b => {
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const id = b.dataset.annId;
          asset.annotations = (asset.annotations || []).filter(a => a.id !== id);
          state.composedAnnotations = state.composedAnnotations.filter(c => c.annotationId !== id);
          renderComposerWorkbench();
          renderAssetDetailInPane(asset, type);
          if (typeof persistState === 'function') persistState();
        });
      });
      // is-new pulse + scrollIntoView
      const newRow = body.querySelector('.asset-detail-annotation-item.is-new');
      if (newRow) {
        setTimeout(() => newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
        setTimeout(() => {
          const id = newRow.dataset.annId;
          const ann = (asset.annotations || []).find(a => a.id === id);
          if (ann) delete ann._isNew;
        }, 1800);
      }
      // Re-bind copy buttons inside doc (if any prompt blocks)
      bindCopyPromptButtons();
      applyAnnotationHighlights();
    }
    renderIcons();
  }

  function openLightbox(type, src, name) {
    const ov = $('#lightboxOverlay');
    const content = $('#lightboxContent');
    if (!ov || !content) return;
    if (type === 'image') {
      content.innerHTML = `<img src="${escape(src || '')}" alt="${escape(name || '')}" />`;
    } else if (type === 'video') {
      content.innerHTML = `<video src="${escape(src || '')}" controls autoplay></video>`;
    }
    ov.style.display = '';
    renderIcons();
  }

  function closeLightbox() {
    const ov = $('#lightboxOverlay');
    const content = $('#lightboxContent');
    if (!ov) return;
    ov.style.display = 'none';
    if (content) content.innerHTML = '';
  }

  let _overflowMenu = null;
  function closeOverflowMenu() {
    if (_overflowMenu) { _overflowMenu.remove(); _overflowMenu = null; }
  }

  function openFolderMenu(btn, folder) {
    closeOverflowMenu();
    const menu = document.createElement('div');
    menu.className = 'card-overflow-menu';
    const items = [
      `<button data-action="add-sub"><i data-lucide="plus"></i><span>新建子文件夹</span></button>`,
      `<button data-action="download"><i data-lucide="download"></i><span>批量下载</span></button>`
    ];
    if (!folder.isDefault) {
      items.push(`<button data-action="rename"><i data-lucide="pencil"></i><span>重命名</span></button>`);
      items.push(`<button data-action="delete" class="danger"><i data-lucide="trash-2"></i><span>删除</span></button>`);
    }
    menu.innerHTML = items.join('');
    document.body.appendChild(menu);
    _overflowMenu = menu;
    renderIcons();

    const rect = btn.getBoundingClientRect();
    let left = rect.right - 160;
    let top = rect.bottom + 4;
    if (left < 8) left = 8;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    menu.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const action = b.dataset.action;
        closeOverflowMenu();
        if (action === 'add-sub') createFolderInline(folder.id);
        else if (action === 'download') downloadFolder(folder.id);
        else if (action === 'rename') startFolderRename(folder.id);
        else if (action === 'delete') deleteFolder(folder.id);
      };
    });
  }

  function openCardOverflowMenu(btn) {
    closeOverflowMenu();
    const assetId = btn.dataset.assetId;
    const type = btn.dataset.assetType;
    const proj = currentProject();
    if (!proj) return;
    const found = findAsset(proj, assetId);
    if (!found) return;
    const asset = found.asset;

    const menu = document.createElement('div');
    menu.className = 'card-overflow-menu';
    menu.innerHTML = `
      <button data-action="rename"><i data-lucide="pencil"></i><span>重命名</span></button>
      <button data-action="move"><i data-lucide="folder-input"></i><span>移动到文件夹...</span></button>
      <button data-action="jump"><i data-lucide="arrow-up-right"></i><span>在原会话查看</span></button>
      <button data-action="delete" class="danger"><i data-lucide="trash-2"></i><span>删除</span></button>
    `;
    document.body.appendChild(menu);
    _overflowMenu = menu;
    renderIcons();

    const rect = btn.getBoundingClientRect();
    let left = rect.right - 160;
    let top = rect.bottom + 4;
    if (left < 8) left = 8;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    menu.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const action = b.dataset.action;
        closeOverflowMenu();
        if (action === 'rename') startAssetRename(assetId, type);
        else if (action === 'move') openMovePopover(btn, assetId, type);
        else if (action === 'jump') jumpToAssetSource(asset);
        else if (action === 'delete') deleteAsset(assetId, type);
      };
    });
  }

  function startAssetRename(assetId, type) {
    const proj = currentProject();
    if (!proj) return;
    const found = findAsset(proj, assetId);
    if (!found) return;
    const card = document.querySelector('.lib-card[data-asset-id="' + assetId + '"]');
    if (!card) return;
    const nameEl = card.querySelector('.card-doc-name, .card-name');
    if (!nameEl) return;
    const orig = found.asset.name || '';
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.style.cssText = 'flex:1;padding:2px 6px;font-size:13px;border:1px solid rgba(91,108,181,0.4);border-radius:4px;outline:none;background:#fff;width:100%;box-sizing:border-box;';
    input.value = orig;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    // Stop card click while editing
    input.onclick = (e) => e.stopPropagation();
    const commit = (save) => {
      const v = input.value.trim();
      if (save && v && v !== orig) {
        found.asset.name = v;
        persistState();
        toast('已重命名');
      }
      // Re-render to restore name span and update chat cards
      renderFolderCardGrid();
      renderMessages();
    };
    input.onblur = () => commit(true);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { input.value = orig; input.blur(); }
    };
  }

  async function deleteAsset(assetId, type) {
    const proj = currentProject();
    if (!proj) return;
    const found = findAsset(proj, assetId);
    if (!found) return;
    const ok = await confirmDialog({ title: '删除文件「' + (found.asset.name || '未命名') + '」?', message: '删除后无法恢复。', okText: '删除', cancelText: '取消' });
    if (!ok) return;
    proj.assets[found.type] = (proj.assets[found.type] || []).filter(a => a.id !== assetId);
    persistState();
    renderFolderCardGrid();
    toast('已删除');
  }

  function jumpToAssetSource(asset) {
    if (!asset.sourceSessionId) { toast('无原会话信息'); return; }
    for (const p of state.projects) {
      const s = p.sessions.find(s => s.id === asset.sourceSessionId);
      if (s) {
        state.currentProjectId = p.id;
        state.currentSessionId = s.id;
        state.expandedProjects.add(p.id);
        renderProjects();
        renderHeader();
        renderMessages();
        closeRightPanel();
        return;
      }
    }
    toast('原会话已不存在');
  }

  function openMovePopover(anchor, assetId, type) {
    const proj = currentProject();
    if (!proj) return;
    const found = findAsset(proj, assetId);
    if (!found) return;

    const pop = $('#movePopover');
    const list = $('#movePopoverList');
    if (!pop || !list) return;

    const byParent = buildFolderTree(proj.folders);
    const items = [];
    function traverse(folder, depth) {
      items.push({ folder, depth });
      (byParent.get(folder.id) || []).forEach(c => traverse(c, depth + 1));
    }
    (byParent.get('__root__') || []).forEach(r => traverse(r, 0));

    list.innerHTML = items.map(({ folder, depth }) => {
      const isCurrent = folder.id === found.asset.folderId;
      const folderIcon = folder.isDefault ? 'folder-heart' : 'folder';
      const lock = folder.isDefault ? `<i data-lucide="lock" class="folder-lock" title="默认文件夹"></i>` : '';
      const checkMark = isCurrent ? `<i data-lucide="check" class="move-current-mark" title="当前所在"></i>` : '';
      return `<div class="folder-row move-folder-row${isCurrent ? ' active' : ''}" data-folder-id="${folder.id}" style="padding-left:${4 + depth * 14}px;">
        <i data-lucide="chevron-right" class="folder-chevron empty"></i>
        <i data-lucide="${folderIcon}" class="folder-icon"></i>
        <span class="folder-name">${escape(folder.name)}</span>
        ${lock}
        ${checkMark}
      </div>`;
    }).join('');

    pop.style.display = '';
    renderIcons();

    const rect = anchor.getBoundingClientRect();
    let left = rect.right - 240;
    let top = rect.bottom + 6;
    if (left < 8) left = 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = rect.top - pop.offsetHeight - 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    list.querySelectorAll('.move-folder-row').forEach(it => {
      it.onclick = () => {
        const targetId = it.dataset.folderId;
        if (targetId !== found.asset.folderId) {
          found.asset.folderId = targetId;
          persistState();
          const targetFolder = findFolder(proj, targetId);
          toast('已移到「' + (targetFolder?.name || '') + '」');
          if (state.rightPanelOpen && state.rightPanelTab === 'files') renderFolderCardGrid();
        }
        closeMovePopover();
      };
    });
  }

  function closeMovePopover() {
    const pop = $('#movePopover');
    if (pop) pop.style.display = 'none';
  }

  // Save-button popover for chat cards (reuses #movePopover with a save context)
  function openChatSavePopover(anchor, messageId) {
    const proj = currentProject();
    if (!proj) return;
    const sess = currentSession();
    if (!sess) return;
    const msg = sess.messages.find(m => m._mid === messageId);
    if (!msg) return;
    if (!msg.assetId) {
      // Auto-archive on demand if not already archived (legacy chat cards from before persistence)
      if (msg.docCard) {
        const a = archiveAsChatAsset('text', msg.docCard, sess.id, msg);
        if (!a) return;
      } else if (msg.result) {
        const t = msg.result.type === 'video' ? 'video' : 'image';
        const a = archiveAsChatAsset(t, msg.result, sess.id, msg);
        if (!a) return;
      } else { return; }
    }
    openMovePopover(anchor, msg.assetId, '');
  }

  function archiveAsChatAsset(type, payload, sourceSessionId, message) {
    const proj = currentProject();
    if (!proj) return null;
    if (!ASSET_TYPES.includes(type)) return null;
    const id = newId('a_user');
    const asset = {
      id,
      name: payload.name || payload.title || (type === 'text' ? '文档' : type === 'image' ? '图片' : '视频'),
      type,
      version: payload.version || 1,
      sourceSessionId,
      createdAt: Date.now(),
      folderId: 'f_default',
      _userCreated: true
    };
    if (type === 'text') {
      // Persist body so survives refresh
      if (payload.data) {
        asset.body = (payload.type === 'script-breakdown') ? breakdownToMarkdown(payload.data)
                   : (payload.type === 'storyboard')     ? storyboardToMarkdown(payload.data)
                   : (payload.content || '');
      } else {
        asset.body = payload.content || '';
      }
      asset.docType = payload.type || 'plain-doc';
    } else if (type === 'image' || type === 'video') {
      asset.src = payload.src || '';
      if (payload.duration) asset.duration = payload.duration;
      if (payload.prompt) asset.prompt = payload.prompt;
    }
    if (!proj.assets[type]) proj.assets[type] = [];
    proj.assets[type].push(asset);
    if (message) message.assetId = id;
    asset._isNew = true;                                 // pulse highlight in lib
    setTimeout(() => { if (asset) delete asset._isNew; }, 2000);
    if (state.rightPanelOpen && state.rightPanelTab === 'files') {
      renderFolderCardGrid();
    }
    persistState();
    return asset;
  }

  // ───── init ─────
  async function init() {
    await loadAppConfig();
    migrateProjects();
    await loadPersistedState();
    validateFolderRefs();
    // Demo mode: seed favoritePrompts from mock if user has none persisted
    if (!state.favoritePrompts || state.favoritePrompts.length === 0) {
      if (Array.isArray(M.INITIAL_FAVORITES)) state.favoritePrompts = M.INITIAL_FAVORITES.slice();
    }

    // Sync task to current session's type (locked-per-session)
    const sess = currentSession();
    if (sess && sess.type) {
      state.controls.task = sess.type;
      const models = M.MODELS[sess.type] || [];
      if (models.length && !models.includes(state.controls.model)) state.controls.model = models[0];
    }

    renderProjects();
    renderHeader();
    renderMessages();
    rebuildDropdowns();
    buildMsgTimeFilterMenu();
    updateMsgTimeFilterLabel();
    updatePlaceholder();
    applyPanelStates();
    renderComposerWorkbench();

    $$('.dropdown > .pill').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const dd = btn.parentElement;
        const wasOpen = dd.classList.contains('open');
        closeDropdowns();
        if (!wasOpen) dd.classList.add('open');
      };
    });
    $('#ratioPicker')?.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', closeDropdowns);

    $('#textFxBtn').onclick = (e) => { e.stopPropagation(); toast('文字效果 (mock)'); };

    // Attach area scroll arrows
    const attachArea = $('#attachArea');
    attachArea?.addEventListener('scroll', updateScrollArrows, { passive: true });
    window.addEventListener('resize', updateScrollArrows);
    $('#scrollLeft')?.addEventListener('click', (e) => {
      e.stopPropagation();
      attachArea?.scrollBy({ left: -160, behavior: 'smooth' });
    });
    $('#scrollRight')?.addEventListener('click', (e) => {
      e.stopPropagation();
      attachArea?.scrollBy({ left: 160, behavior: 'smooth' });
    });

    $('#balancePill').onclick = () => toast('本次生成消耗 (mock)');
    $('#tokenPill')?.addEventListener('click', (e) => { e.stopPropagation(); compressContext(); });

    // Right panel: tab + pinned buttons + edge handle
    document.querySelectorAll('.rp-tab').forEach(b => {
      b.addEventListener('click', () => setRightPanelTab(b.dataset.tab));
    });
    $('#tabAdd')?.addEventListener('click', () => toast('暂不支持自定义 tab'));
    $('#rpToggleBtn')?.addEventListener('click', closeRightPanel);
    $('#rpMaxBtn')?.addEventListener('click', toggleMaxed);
    $('#rpEdgeHandle')?.addEventListener('click', openRightPanelMode);
    $('#libLowerCloseBtn')?.addEventListener('click', deselectAsset);
    bindLibDivider();

    // Right panel resize
    const rpHandle = $('#rpResizeHandle');
    if (rpHandle) {
      let dragging = false;
      rpHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        rpHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const panel = $('#rightPanel');
        const leftW = $('#leftPanel')?.offsetWidth || 0;
        const minCenter = 480;
        const maxW = window.innerWidth - leftW - minCenter;
        const newW = window.innerWidth - e.clientX;
        const clamped = Math.max(280, Math.min(newW, maxW));
        panel.style.width = clamped + 'px';
        panel.style.minWidth = clamped + 'px';
        syncControlsCompact();
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        rpHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }

    // (legacy #annotateFloat / #annotatePopover system removed — replaced by .doc-sel-toolbar/.doc-sel-popover)
    // Old #annChip handlers removed — workbench renders + binds dynamically via renderComposerWorkbench()

    $('#promptInput').addEventListener('input', () => { autoResizePrompt(); updateSendBtn(); renderComposerWorkbench(); });
    autoResizePrompt();
    $('#promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('#sendBtn').onclick = send;

    $('#newProjectBtn')?.addEventListener('click', addProject);

    $('#collapseLeftBtn').onclick = () => { state.leftCollapsed = true; applyPanelStates(); };
    $('#expandLeftBtn').onclick = () => { state.leftCollapsed = false; applyPanelStates(); };

    $('#profileBtn').onclick = (e) => { e.stopPropagation(); onProfileClick(); };
    $('#profileMenu').onclick = (e) => e.stopPropagation();
    $('#logoutBtn').onclick = (e) => { e.stopPropagation(); logout(); };
    $('#resetDemoBtn').onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: '恢复初始状态',
        message: '将清除本地所有自定义数据（用户创建的文件夹、批注、收藏等），重新加载到演示原始状态。此操作不可撤销。',
        okText: '清除并重新加载',
        cancelText: '取消'
      });
      if (!ok) return;
      try { localStorage.removeItem('va_state_v1'); } catch (_) {}
      if (APP_CONFIG.persistence !== 'localStorage') {
        try { await apiJson('/api/state', { method: 'DELETE' }); } catch (err) { console.warn('[persist] reset server state failed', err); }
      }
      location.reload();
    };
    renderProfile();

    // Library bindings
    $('#libAddRootBtn')?.addEventListener('click', () => createFolderInline(null));
    $('#libTreeCollapseBtn')?.addEventListener('click', () => {
      state.libraryUI.treeCollapsed = true;
      applyLibTreeCollapsedState();
      persistState();
    });
    $('#libTreeRail')?.addEventListener('click', () => {
      state.libraryUI.treeCollapsed = false;
      applyLibTreeCollapsedState();
      persistState();
    });
    $('#lightboxClose')?.addEventListener('click', closeLightbox);
    $('#lightboxOverlay')?.addEventListener('click', (e) => { if (e.target.id === 'lightboxOverlay') closeLightbox(); });
    bindLibrarySearch();
    bindComposerDropTarget();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('#lightboxOverlay').style.display !== 'none') closeLightbox();
        else if (_overflowMenu) closeOverflowMenu();
        else if (_createMenuEl) closeCreateMenu();
        else if (state.libraryUI.multiSelect.active) exitMultiSelect();
        else if ($('#movePopover').style.display !== 'none') closeMovePopover();
      }
    });
    document.addEventListener('click', (e) => {
      if (_overflowMenu && !_overflowMenu.contains(e.target)) closeOverflowMenu();
      if (_createMenuEl && !_createMenuEl.contains(e.target) && !e.target.closest('.create-hint-row') && !e.target.closest('[data-act="addnew"]')) closeCreateMenu();
      const pop = $('#movePopover');
      if (pop && pop.style.display !== 'none' && !pop.contains(e.target) && !e.target.closest('.card-menu-btn') && !e.target.closest('.chat-save-btn')) {
        closeMovePopover();
      }
    });

    renderIcons();

    // Preload skill prompts
    loadSkillPrompt('剧本拆解.md').catch(() => {});
    loadSkillPrompt('分镜脚本.md').catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
})();
