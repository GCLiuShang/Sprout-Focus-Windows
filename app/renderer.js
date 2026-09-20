import {
  MAX_RULE_SET_ITEMS,
  MAX_RULE_SETS,
  buildRuleSetsFromLegacy,
  createFuzzyPhrase,
  createFuzzyRuleSet,
  createPreciseItem,
  createPreciseRuleSet,
  createUserSafelistRule,
  normalizeFuzzyRuleSets,
  normalizePreciseRuleSets,
} from '../shared/models.js';

const api = window.forestApi;
const initialRuleSets = loadRuleSets();
const state = {
  session: null,
  settings: null,
  currentContext: null,
  preciseRuleSets: initialRuleSets.preciseRuleSets,
  fuzzyRuleSets: initialRuleSets.fuzzyRuleSets,
  sessionMode: 'countdown',
  exitDifficulty: 'easy',
  challengeTimer: null,
  historyFiles: [],
  selectedHistoryFile: null,
  historyContent: '',
  dashboardDays: [],
  selectedDashboardDay: null,
  editingWhitelistRuleId: null,
  candidate: null,
  candidateType: 'window',
  candidateTimer: null,
  helperStatus: 'off',
  pendingAdminStart: null,
  starting: false,
  rulesetEditor: null,
};

const __elCache = new Map();
const el = (id) => {
  let cached = __elCache.get(id);
  if (!cached || !document.contains(cached)) {
    cached = document.getElementById(id);
    if (cached) __elCache.set(id, cached);
  }
  return cached;
};

function setEmptyVisible(element, visible) {
  if (element) {
    element.style.display = visible ? '' : 'none';
  }
}

function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function migrateLegacyRuleSetsIfNeeded() {
  try {
    if (localStorage.getItem('sprout-rules-migrated') === '1') {
      return false;
    }

    const categoryRules = readJson('forest-category-rules');
    const lastRules = readJson('sprout-last-rules');
    const migrated = buildRuleSetsFromLegacy({
      categoryRules: Array.isArray(categoryRules) ? categoryRules : [],
      lastRules,
    });

    writeJson('sprout-precise-rulesets', migrated.preciseRuleSets);
    writeJson('sprout-fuzzy-rulesets', migrated.fuzzyRuleSets);
    return migrated.preciseRuleSets.length > 0 || migrated.fuzzyRuleSets.length > 0;
  } finally {
    localStorage.setItem('sprout-rules-migrated', '1');
    localStorage.removeItem('forest-category-rules');
    localStorage.removeItem('sprout-last-rules');
  }
}

function loadRuleSets() {
  try {
    migrateLegacyRuleSetsIfNeeded();
  } catch {
    // ignore migration failures
  }
  return {
    preciseRuleSets: normalizePreciseRuleSets(readJson('sprout-precise-rulesets')),
    fuzzyRuleSets: normalizeFuzzyRuleSets(readJson('sprout-fuzzy-rulesets')),
  };
}

function persistPreciseRuleSets() {
  writeJson('sprout-precise-rulesets', state.preciseRuleSets);
}

function persistFuzzyRuleSets() {
  writeJson('sprout-fuzzy-rulesets', state.fuzzyRuleSets);
}

function enabledPreciseItems() {
  return state.preciseRuleSets
    .filter((set) => set.enabled)
    .flatMap((set) => set.items.map((item) => ({ ...item, setId: set.id, setName: set.name, setColor: set.color })));
}

function enabledFuzzyPhrases() {
  return state.fuzzyRuleSets
    .filter((set) => set.enabled)
    .flatMap((set) => set.phrases.map((phrase) => ({ ...phrase, setId: set.id, setName: set.name, setColor: set.color })));
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function formatDurationMinutes(minutes) {
  const safe = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours <= 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function summarizeRules() {
  const parts = [];
  const preciseCount = enabledPreciseItems().length;
  const fuzzyCount = enabledFuzzyPhrases().length;
  if (preciseCount) parts.push(`${preciseCount} 个精准条目`);
  if (fuzzyCount) parts.push(`${fuzzyCount} 个模糊短语`);
  return parts;
}

function formatContextMeta(current = {}) {
  const parts = [];
  if (current.processName) parts.push(current.processName);
  if (current.windowId != null) parts.push(`窗口 ${current.windowId}`);
  return parts.join(' · ') || '—';
}

function formatContextDetail(current = {}) {
  return current.processPath || '—';
}

function showToast(message, tone = 'normal') {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.toggle('danger', tone === 'danger');
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function syncDrawerScrollLock() {
  const anyOpen = ['rules', 'history', 'settings', 'dashboard']
    .some((name) => !el(`${name}-drawer-overlay`)?.classList.contains('hidden'));
  document.body.classList.toggle('drawer-open', anyOpen);
}

function openDrawer(name) {
  const overlay = el(`${name}-drawer-overlay`);
  if (!overlay) return;
  overlay.classList.remove('hidden', 'closing');
  syncDrawerScrollLock();
  if (name === 'rules') {
    renderRulesSummary();
    renderPreciseRuleSets();
    renderFuzzyRuleSets();
    startCandidatePolling();
  }
}

function closeDrawer(name) {
  const overlay = el(`${name}-drawer-overlay`);
  if (!overlay || overlay.classList.contains('hidden') || overlay.classList.contains('closing')) {
    return;
  }

  const drawer = overlay.querySelector('.drawer');
  const finish = () => {
    overlay.classList.add('hidden');
    overlay.classList.remove('closing');
    syncDrawerScrollLock();
    if (drawer) drawer.removeEventListener('animationend', finish);
  };

  overlay.classList.add('closing');
  if (drawer) {
    drawer.addEventListener('animationend', finish);
    setTimeout(finish, 320);
  } else {
    finish();
  }

  if (name === 'rules') {
    renderCompactRuleSummary();
    renderDraftSummary();
    stopCandidatePolling();
  }
}

function switchRulesTab(name) {
  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  ['precise', 'fuzzy'].forEach((tab) => {
    el(`drawer-tab-${tab}`)?.classList.toggle('hidden', tab !== name);
  });
  const tabs = el('rules-drawer')?.querySelector('.drawer-tabs');
  if (tabs) tabs.style.setProperty('--tab-index', name === 'fuzzy' ? '1' : '0');
}

const CANDIDATE_POLL_MS = 1000;

function startCandidatePolling() {
  stopCandidatePolling();
  refreshCandidateWindow();
  state.candidateTimer = setInterval(refreshCandidateWindow, CANDIDATE_POLL_MS);
}

function stopCandidatePolling() {
  if (state.candidateTimer) {
    clearInterval(state.candidateTimer);
    state.candidateTimer = null;
  }
}

async function refreshCandidateWindow() {
  if (!api) return;
  try {
    const payload = await api.getCandidateWindow();
    state.candidate = payload?.context || null;
  } catch {
    state.candidate = null;
  }
  renderCandidateWindow(state.candidate);
}

function renderCandidateWindow(context) {
  el('candidate-title').textContent = context?.title || '等待检测';
  el('candidate-meta').textContent = formatContextMeta(context || {});
  el('candidate-detail').textContent = formatContextDetail(context || {});
  el('candidate-refresh-state').textContent = context?.windowId ? '已检测到窗口' : '等待检测';
  el('candidate-rule-preview').textContent = context?.windowId
    ? describeCandidateItem(context, state.candidateType)
    : '—';
  const addBtn = el('candidate-add-btn');
  if (addBtn) addBtn.disabled = !context?.windowId;
  renderCandidateTypeSwitch();
  renderPreciseTargetOptions();
}

function renderCandidateTypeSwitch() {
  document.querySelectorAll('#candidate-type-switch .mode-switch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === state.candidateType);
  });
}

function describeCandidateItem(context, type) {
  if (type === 'process') {
    return `类型：进程\n进程路径：${context.processPath || '—'}\n进程名：${context.processName || '—'}`;
  }
  return `类型：窗口\n进程路径：${context.processPath || '—'}\n标题：${context.title || '—'}`;
}

function renderPreciseTargetOptions() {
  const select = el('precise-target-set');
  if (!select) return;
  const previous = select.value;
  const frag = document.createDocumentFragment();
  state.preciseRuleSets.forEach((set) => {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = set.name;
    frag.appendChild(option);
  });
  const createOpt = document.createElement('option');
  createOpt.value = '__new__';
  createOpt.textContent = '＋ 新建规则集…';
  frag.appendChild(createOpt);
  select.replaceChildren(frag);
  if (previous && Array.from(select.options).some((option) => option.value === previous)) {
    select.value = previous;
  }
}

function resolveTargetSetId(side, selectId) {
  const select = el(selectId);
  if (!select) return null;
  if (select.value === '__new__') {
    openRulesetEditor(side, null, (created) => {
      select.value = created.id;
    });
    return null;
  }
  return select.value || null;
}

function addPreciseFromCandidate() {
  const context = state.candidate;
  if (!context?.windowId) {
    showToast('暂无可加入的窗口', 'danger');
    return;
  }
  const setId = resolveTargetSetId('precise', 'precise-target-set');
  if (!setId) return;
  const set = state.preciseRuleSets.find((item) => item.id === setId);
  if (!set) return;
  if (set.items.length >= MAX_RULE_SET_ITEMS) {
    showToast(`每个规则集最多 ${MAX_RULE_SET_ITEMS} 条`, 'danger');
    return;
  }

  const item = createPreciseItem({
    type: state.candidateType,
    label: context.title || context.processName || '未命名条目',
    processPath: context.processPath || '',
    processName: context.processName || '',
    title: state.candidateType === 'window' ? (context.title || '') : '',
    windowId: context.windowId ?? null,
  });
  const duplicate = set.items.some((existing) => existing.type === item.type
    && (existing.processPath || '').toLowerCase() === item.processPath.toLowerCase()
    && (item.type === 'process' || (existing.title || '') === item.title));
  if (duplicate) {
    showToast('该条目已存在于这个规则集中');
    return;
  }

  set.items.push(item);
  persistPreciseRuleSets();
  renderPreciseRuleSets();
  renderRulesSummary();
  renderContext(context);
  showToast(`已加入「${set.name}」：${item.label}`);
}

function addPreciseManual() {
  const input = el('precise-manual-input');
  const value = input.value.trim();
  if (!value) {
    showToast('请输入进程名或完整路径', 'danger');
    return;
  }
  const setId = resolveTargetSetId('precise', 'precise-target-set');
  if (!setId) return;
  const set = state.preciseRuleSets.find((item) => item.id === setId);
  if (!set) return;
  if (set.items.length >= MAX_RULE_SET_ITEMS) {
    showToast(`每个规则集最多 ${MAX_RULE_SET_ITEMS} 条`, 'danger');
    return;
  }

  const isPath = value.includes('\\') || value.includes('/');
  set.items.push(createPreciseItem({
    type: 'process',
    label: value,
    processPath: isPath ? value : '',
    processName: isPath ? '' : value,
  }));
  input.value = '';
  persistPreciseRuleSets();
  renderPreciseRuleSets();
  renderRulesSummary();
  showToast(`已添加进程规则：${value}`);
}

function removePreciseItem(setId, itemId) {
  const set = state.preciseRuleSets.find((item) => item.id === setId);
  if (!set) return;
  set.items = set.items.filter((item) => item.id !== itemId);
  persistPreciseRuleSets();
  renderPreciseRuleSets();
  renderRulesSummary();
}

function addFuzzyPhrase(setId, text, mode = 'text') {
  const set = state.fuzzyRuleSets.find((item) => item.id === setId);
  const value = String(text || '').trim();
  if (!set || !value) return;
  if (set.phrases.length >= MAX_RULE_SET_ITEMS) {
    showToast(`每个规则集最多 ${MAX_RULE_SET_ITEMS} 条`, 'danger');
    return;
  }
  if (set.phrases.some((phrase) => phrase.text === value && phrase.mode === mode)) {
    showToast('该短语已存在于这个规则集中');
    return;
  }
  if (mode === 'regex') {
    try {
      new RegExp(value, 'i');
    } catch {
      showToast('正则表达式无效', 'danger');
      return;
    }
  }
  set.phrases.push(createFuzzyPhrase({ text: value, mode }));
  persistFuzzyRuleSets();
  renderFuzzyRuleSets();
  renderRulesSummary();
}

function removeFuzzyPhrase(setId, phraseId) {
  const set = state.fuzzyRuleSets.find((item) => item.id === setId);
  if (!set) return;
  set.phrases = set.phrases.filter((phrase) => phrase.id !== phraseId);
  persistFuzzyRuleSets();
  renderFuzzyRuleSets();
  renderRulesSummary();
}

function toggleFuzzyPhraseMode(setId, phraseId) {
  const set = state.fuzzyRuleSets.find((item) => item.id === setId);
  const phrase = set?.phrases.find((item) => item.id === phraseId);
  if (!phrase) return;
  if (phrase.mode === 'text') {
    try {
      new RegExp(phrase.text, 'i');
    } catch {
      showToast('该短语不是合法正则，无法切换', 'danger');
      return;
    }
    phrase.mode = 'regex';
  } else {
    phrase.mode = 'text';
  }
  persistFuzzyRuleSets();
  renderFuzzyRuleSets();
}

function toggleRuleSet(side, id) {
  const list = side === 'precise' ? state.preciseRuleSets : state.fuzzyRuleSets;
  const set = list.find((item) => item.id === id);
  if (!set) return;
  set.enabled = !set.enabled;
  (side === 'precise' ? persistPreciseRuleSets : persistFuzzyRuleSets)();
  (side === 'precise' ? renderPreciseRuleSets : renderFuzzyRuleSets)();
  renderRulesSummary();
}

function deleteRuleSet(side, id) {
  if (side === 'precise') {
    state.preciseRuleSets = state.preciseRuleSets.filter((set) => set.id !== id);
    persistPreciseRuleSets();
    renderPreciseRuleSets();
  } else {
    state.fuzzyRuleSets = state.fuzzyRuleSets.filter((set) => set.id !== id);
    persistFuzzyRuleSets();
    renderFuzzyRuleSets();
  }
  renderRulesSummary();
}

function openRulesetEditor(side, set, onCreated) {
  if (!set && side) {
    const list = side === 'precise' ? state.preciseRuleSets : state.fuzzyRuleSets;
    if (list.length >= MAX_RULE_SETS) {
      showToast(`最多 ${MAX_RULE_SETS} 个规则集`, 'danger');
      return;
    }
  }
  state.rulesetEditor = { side, id: set?.id || null, onCreated: typeof onCreated === 'function' ? onCreated : null };
  el('ruleset-editor-title').textContent = set ? '编辑规则集' : '新建规则集';
  el('ruleset-name-input').value = set?.name || '';
  const color = set?.color || (side === 'fuzzy' ? '#a78bfa' : '#4ade80');
  el('ruleset-color-input').value = color;
  el('ruleset-color-hex').textContent = color;
  el('ruleset-editor-error').classList.add('hidden');
  el('ruleset-editor-overlay').classList.remove('hidden');
  el('ruleset-name-input').focus();
}

function closeRulesetEditor() {
  el('ruleset-editor-overlay').classList.add('hidden');
  state.rulesetEditor = null;
}

function saveRulesetEditor() {
  const editor = state.rulesetEditor;
  if (!editor) return;
  const name = el('ruleset-name-input').value.trim();
  const color = el('ruleset-color-input').value;
  if (!name) {
    el('ruleset-editor-error').classList.remove('hidden');
    return;
  }

  const list = editor.side === 'precise' ? state.preciseRuleSets : state.fuzzyRuleSets;
  if (editor.id) {
    const set = list.find((item) => item.id === editor.id);
    if (set) {
      set.name = name;
      set.color = color;
    }
  } else {
    const created = editor.side === 'precise'
      ? createPreciseRuleSet({ name, color })
      : createFuzzyRuleSet({ name, color });
    list.push(created);
    if (editor.onCreated) editor.onCreated(created);
  }

  (editor.side === 'precise' ? persistPreciseRuleSets : persistFuzzyRuleSets)();
  (editor.side === 'precise' ? renderPreciseRuleSets : renderFuzzyRuleSets)();
  renderRulesSummary();
  closeRulesetEditor();
}

function renderRuleSetCard(side, set) {
  const card = document.createElement('div');
  card.className = `ruleset-card ${set.enabled ? 'enabled' : ''}`;
  card.dataset.setId = set.id;
  card.dataset.side = side;
  card.style.setProperty('--ruleset-color', set.color);

  const head = document.createElement('div');
  head.className = 'ruleset-head';
  const count = side === 'precise' ? set.items.length : set.phrases.length;
  head.innerHTML = `<span class="color-dot" style="background:${escapeHTML(set.color)}"></span><span class="ruleset-name">${escapeHTML(set.name)}</span><span class="ruleset-count">${count}/${MAX_RULE_SET_ITEMS}</span>`;

  const toggle = document.createElement('label');
  toggle.className = 'ruleset-toggle';
  toggle.innerHTML = `<input type="checkbox" ${set.enabled ? 'checked' : ''}><span class="track"></span>`;
  toggle.querySelector('input').addEventListener('change', () => toggleRuleSet(side, set.id));
  head.appendChild(toggle);

  const editBtn = document.createElement('button');
  editBtn.className = 'ruleset-icon-btn';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => openRulesetEditor(side, set));
  const delBtn = document.createElement('button');
  delBtn.className = 'ruleset-icon-btn';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', () => deleteRuleSet(side, set.id));
  head.appendChild(editBtn);
  head.appendChild(delBtn);
  card.appendChild(head);

  const items = document.createElement('div');
  items.className = 'ruleset-items';
  if (side === 'precise') {
    if (!set.items.length) {
      const hint = document.createElement('p');
      hint.className = 'ruleset-empty-hint';
      hint.textContent = '空规则集，请从上方加入窗口或手动添加进程。';
      items.appendChild(hint);
    }
    set.items.forEach((item) => {
      const chip = document.createElement('span');
      chip.className = 'ruleset-item';
      const badge = document.createElement('span');
      badge.className = 'type-badge';
      badge.textContent = item.type === 'process' ? '进程' : '窗口';
      chip.appendChild(badge);
      const text = document.createElement('span');
      text.className = 'ruleset-item-text clamp-2';
      text.textContent = item.label || item.title || item.processName || '未命名条目';
      chip.appendChild(text);
      const remove = document.createElement('button');
      remove.className = 'remove-btn';
      remove.textContent = '×';
      remove.addEventListener('click', () => removePreciseItem(set.id, item.id));
      chip.appendChild(remove);
      items.appendChild(chip);
    });
  } else {
    if (!set.phrases.length) {
      const hint = document.createElement('p');
      hint.className = 'ruleset-empty-hint';
      hint.textContent = '空规则集，请在下方输入短语。';
      items.appendChild(hint);
    }
    set.phrases.forEach((phrase) => {
      const chip = document.createElement('span');
      chip.className = 'ruleset-item';
      const text = document.createElement('span');
      text.className = 'ruleset-item-text clamp-2';
      text.textContent = phrase.text;
      chip.appendChild(text);
      const mode = document.createElement('span');
      mode.className = 'mode-badge';
      mode.textContent = phrase.mode === 'regex' ? '正则' : '文本';
      mode.title = '点击切换 文本/正则';
      mode.addEventListener('click', () => toggleFuzzyPhraseMode(set.id, phrase.id));
      chip.appendChild(mode);
      const remove = document.createElement('button');
      remove.className = 'remove-btn';
      remove.textContent = '×';
      remove.addEventListener('click', () => removeFuzzyPhrase(set.id, phrase.id));
      chip.appendChild(remove);
      items.appendChild(chip);
    });
  }
  card.appendChild(items);

  if (side === 'fuzzy') {
    const addRow = document.createElement('div');
    addRow.className = 'ruleset-add-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '输入短语后回车添加';
    const regexLabel = document.createElement('label');
    regexLabel.className = 'setting-switch';
    regexLabel.innerHTML = '<input type="checkbox"><span>高级正则</span>';
    const regexInput = regexLabel.querySelector('input');
    const addBtn = document.createElement('button');
    addBtn.className = 'btn small primary';
    addBtn.textContent = '添加短语';
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      addFuzzyPhrase(set.id, value, regexInput.checked ? 'regex' : 'text');
      input.value = '';
      regexInput.checked = false;
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    addRow.appendChild(input);
    addRow.appendChild(regexLabel);
    addRow.appendChild(addBtn);
    card.appendChild(addRow);
  }

  return card;
}

function renderPreciseRuleSets() {
  const list = el('precise-ruleset-list');
  if (!list) return;
  const empty = el('precise-ruleset-empty');
  setEmptyVisible(empty, state.preciseRuleSets.length === 0);
  const frag = document.createDocumentFragment();
  state.preciseRuleSets.forEach((set, index) => {
    const card = renderRuleSetCard('precise', set);
    card.style.setProperty('--i', index);
    frag.appendChild(card);
  });
  list.replaceChildren(frag);
  renderPreciseTargetOptions();
}

function renderFuzzyRuleSets() {
  const list = el('fuzzy-ruleset-list');
  if (!list) return;
  const empty = el('fuzzy-ruleset-empty');
  setEmptyVisible(empty, state.fuzzyRuleSets.length === 0);
  const frag = document.createDocumentFragment();
  state.fuzzyRuleSets.forEach((set, index) => {
    const card = renderRuleSetCard('fuzzy', set);
    card.style.setProperty('--i', index);
    frag.appendChild(card);
  });
  list.replaceChildren(frag);
}

function renderRulesSummary() {
  const container = el('drawer-active-summary');
  if (!container) return;
  const frag = document.createDocumentFragment();

  const addGroup = (label, sets) => {
    const row = document.createElement('div');
    row.className = 'drawer-summary-row';
    const lbl = document.createElement('span');
    lbl.className = 'drawer-summary-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    const wrap = document.createElement('div');
    wrap.className = 'drawer-summary-chips';
    if (!sets.length) {
      const chip = document.createElement('span');
      chip.className = 'drawer-summary-chip';
      chip.textContent = '无';
      wrap.appendChild(chip);
    } else {
      sets.forEach((set) => {
        const chip = document.createElement('span');
        chip.className = 'drawer-summary-chip';
        const dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.style.background = escapeHTML(set.color);
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(set.name));
        wrap.appendChild(chip);
      });
    }
    row.appendChild(wrap);
    frag.appendChild(row);
  };

  addGroup('精准', state.preciseRuleSets.filter((set) => set.enabled));
  addGroup('模糊', state.fuzzyRuleSets.filter((set) => set.enabled));
  container.replaceChildren(frag);
}

async function refreshOpenWindows() {
  const container = el('fuzzy-open-windows');
  if (!container) return;
  try {
    const windows = await api.listOpenWindows();
    const empty = el('fuzzy-open-windows-empty');
    setEmptyVisible(empty, windows.length === 0);
    const frag = document.createDocumentFragment();
    windows.slice(0, 40).forEach((window, index) => {
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.style.setProperty('--i', index);
      row.innerHTML = `<div class="rule-main"><strong>${escapeHTML(window.title || window.processName || '未命名窗口')}</strong><p class="muted small">${escapeHTML(window.processPath || '')}</p></div>`;
      const actions = document.createElement('div');
      actions.className = 'rule-actions';
      const suggestions = [];
      const proc = (window.processName || '').replace(/\.exe$/i, '');
      if (proc) suggestions.push(proc);
      const titleFragment = (window.title || '').split(/[-–|·]/)[0]?.trim();
      if (titleFragment && titleFragment !== proc && titleFragment.length <= 30) suggestions.push(titleFragment);
      suggestions.slice(0, 2).forEach((text) => {
        const btn = document.createElement('button');
        btn.className = 'btn small ghost';
        btn.textContent = `+ ${text}`;
        btn.addEventListener('click', () => addFuzzyFromWindow(text));
        actions.appendChild(btn);
      });
      row.appendChild(actions);
      frag.appendChild(row);
    });
    container.replaceChildren(frag);
  } catch (error) {
    showToast(error.message || '读取窗口失败', 'danger');
  }
}

function addFuzzyFromWindow(text) {
  if (!state.fuzzyRuleSets.length) {
    showToast('请先新建一个模糊规则集');
    openRulesetEditor('fuzzy', null);
    return;
  }
  const target = state.fuzzyRuleSets.find((set) => set.enabled) || state.fuzzyRuleSets[0];
  addFuzzyPhrase(target.id, text, 'text');
  showToast(`已加入「${target.name}」：${text}`);
}

function updateHeroIdleTimer() {
  if (state.sessionMode === 'countup') {
    el('hero-idle-timer').textContent = '00:00';
  } else {
    const minutes = Number(el('duration-minutes')?.value || 25);
    el('hero-idle-timer').textContent = `${String(minutes).padStart(2, '0')}:00`;
  }
}

function renderSessionModeSwitch() {
  const mode = state.sessionMode || 'countdown';
  document.querySelectorAll('#session-mode-switch .mode-switch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  el('duration-minutes').closest('.duration-picker').classList.toggle('hidden', mode === 'countup');
}

function renderFocusView() {
  const status = state.session?.status || 'idle';
  const headings = { idle: '准备专注', running: '专注中...', completed: '专注完成', cancelled: '专注结束' };
  el('main-heading').textContent = headings[status] || '准备专注';
  document.body.classList.toggle('focus-mode', status === 'running');
  el('live-context-panel').classList.toggle('hidden', status !== 'running');
  el('violations-panel').classList.toggle('hidden', status === 'idle');
  el('edit-rules-btn').classList.toggle('hidden', status !== 'idle');
  renderCompactRuleSummary();
}

function renderCompactRuleSummary() {
  const parts = summarizeRules();
  const preciseSets = state.preciseRuleSets.filter((set) => set.enabled);
  const fuzzySets = state.fuzzyRuleSets.filter((set) => set.enabled);
  const hasRules = enabledPreciseItems().length > 0 || enabledFuzzyPhrases().length > 0;
  const summaryText = hasRules ? parts.join(' · ') : '尚未配置规则';

  const chips = el('rule-summary-chips');
  const currentHash = preciseSets.map((set) => `${set.id}:${set.name}`).join(',') + '|' + fuzzySets.map((set) => `${set.id}:${set.name}`).join(',');
  if (chips.dataset.rulesHash !== currentHash) {
    el('rule-summary-text').textContent = summaryText;

    const frag = document.createDocumentFragment();
    preciseSets.forEach((set) => {
      frag.appendChild(makeChip(set.name, { color: set.color }));
    });
    fuzzySets.forEach((set) => {
      frag.appendChild(makeChip(set.name, { category: true, color: set.color }));
    });
    chips.replaceChildren(frag);
    chips.dataset.rulesHash = currentHash;
  }

  const startBtn = el('start-session-btn');
  if (startBtn) updateStartButton();
  const hint = el('hero-rules-hint');
  if (hint) hint.classList.toggle('hidden', hasRules);
  renderSessionModeSwitch();
}

function renderDraftSummary() {
  const preciseCount = enabledPreciseItems().length;
  const fuzzyCount = enabledFuzzyPhrases().length;
  el('draft-precise-count').textContent = String(preciseCount);
  el('draft-fuzzy-count').textContent = String(fuzzyCount);
  el('draft-system-safelist').textContent = state.settings?.systemSafelistEnabled === false ? '关' : '开';
}

function renderContext(context) {
  state.currentContext = context || state.currentContext;
  const current = state.currentContext || {};
  const title = current.title || '等待检测';
  const meta = formatContextMeta(current);
  const detail = formatContextDetail(current);
  el('live-context-title').textContent = title;
  el('live-context-meta').textContent = meta;
  el('live-context-detail').textContent = detail;
  el('context-json').textContent = JSON.stringify(current, null, 2);
}

function makeChip(label, options = {}) {
  const chip = document.createElement('div');
  chip.className = `chip ${options.category ? 'category-chip' : ''} ${options.color ? 'has-color' : ''}`.trim();
  if (options.color) {
    chip.style.setProperty('--chip-color', options.color);
  }
  const span = document.createElement('span');
  span.textContent = label;
  chip.appendChild(span);
  if (options.onRemove) {
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.addEventListener('click', options.onRemove);
    chip.appendChild(btn);
  }
  return chip;
}

function renderSystemSafelist(rules = []) {
  const list = el('system-safelist-list');
  const frag = document.createDocumentFragment();
  rules.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <div class="rule-main">
        <h4>${escapeHTML(rule.name)}</h4>
        <p class="muted small">${escapeHTML(rule.description) || '系统关键窗口保护'}</p>
        <p class="muted small">进程：${escapeHTML((rule.processPatterns || []).join(' | ')) || '—'}</p>
        <p class="muted small">标题：${escapeHTML((rule.titlePatterns || []).join(' | ')) || '—'}</p>
      </div>
      <div class="rule-actions"><button class="btn ghost" disabled>默认锁定</button></div>
    `;
    frag.appendChild(row);
  });
  list.replaceChildren(frag);
}

function splitPatterns(text) {
  return String(text || '')
    .split('|')
    .map((token) => token.trim())
    .filter(Boolean);
}

function renderUserSafelist(rules = []) {
  const list = el('user-safelist-list');
  if (!list) return;
  const empty = el('user-safelist-empty');
  if (empty) setEmptyVisible(empty, rules.length === 0);

  const frag = document.createDocumentFragment();
  rules.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.userSafelistId = rule.id;
    row.innerHTML = `
      <div class="rule-main">
        <h4>${escapeHTML(rule.name)}</h4>
        <p class="muted small">进程：${escapeHTML((rule.processPatterns || []).join(' | ')) || '—'}</p>
        <p class="muted small">标题：${escapeHTML((rule.titlePatterns || []).join(' | ')) || '—'}</p>
      </div>
      <div class="rule-actions">
        <button class="btn small ghost" data-action="edit">编辑</button>
        <button class="btn small ghost" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openUserWhitelistModal({ rule }));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => removeUserSafelistRule(rule.id));
    frag.appendChild(row);
  });
  list.replaceChildren(frag);
}

async function persistUserSafelistRules(rules, tip) {
  try {
    state.settings = await api.saveSettings({ userSafelistRules: rules });
    renderUserSafelist(state.settings.userSafelistRules || []);
    if (tip) showToast(tip);
  } catch (error) {
    showToast(error.message || '保存用户白名单失败', 'danger');
  }
}

function openUserWhitelistModal({ rule = null, violation = null } = {}) {
  const overlay = el('whitelist-rule-overlay');
  if (!overlay) return;
  el('whitelist-name-input').value = rule?.name || violation?.processName || violation?.title || '';
  el('whitelist-process-input').value = (rule?.processPatterns || []).join('|')
    || (violation ? (violation.processPath || violation.processName || '') : '');
  el('whitelist-title-input').value = (rule?.titlePatterns || []).join('|') || '';
  el('whitelist-error').classList.add('hidden');
  state.editingWhitelistRuleId = rule?.id || null;
  overlay.classList.remove('hidden');
  el('whitelist-name-input').focus();
}

function closeUserWhitelistModal() {
  el('whitelist-rule-overlay').classList.add('hidden');
  state.editingWhitelistRuleId = null;
}

async function saveUserWhitelistModal() {
  const name = el('whitelist-name-input').value.trim();
  const processPatterns = splitPatterns(el('whitelist-process-input').value);
  const titlePatterns = splitPatterns(el('whitelist-title-input').value);
  if (!processPatterns.length && !titlePatterns.length) {
    el('whitelist-error').classList.remove('hidden');
    return;
  }

  const existing = Array.isArray(state.settings?.userSafelistRules) ? state.settings.userSafelistRules : [];
  const list = existing.map((rule) => ({ ...rule }));
  if (state.editingWhitelistRuleId) {
    const index = list.findIndex((rule) => rule.id === state.editingWhitelistRuleId);
    if (index >= 0) {
      list[index] = { ...list[index], name: name || list[index].name, processPatterns, titlePatterns };
    }
  } else {
    list.push(createUserSafelistRule({ name: name || '未命名白名单', processPatterns, titlePatterns }));
  }

  await persistUserSafelistRules(list, '用户白名单已保存');
  closeUserWhitelistModal();
}

async function removeUserSafelistRule(id) {
  const list = (state.settings?.userSafelistRules || []).filter((rule) => rule.id !== id);
  await persistUserSafelistRules(list, '已删除用户白名单规则');
}

function renderViolations(violations = [], targetId, emptyId) {
  const list = el(targetId);
  const currentHash = violations.length + '-' + (violations[violations.length - 1]?.timestamp || '');
  if (list.dataset.vHash === currentHash) return;
  list.dataset.vHash = currentHash;

  const empty = emptyId ? el(emptyId) : null;
  if (empty) setEmptyVisible(empty, violations.length === 0);
  if (!violations.length && !emptyId) {
    list.innerHTML = '<div class="empty">本轮没有违规。</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  violations.slice().reverse().forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'timeline-item';
    row.style.setProperty('--i', index);
    row.innerHTML = `
      <h4>${escapeHTML(item.title || item.processName || '未知窗口')}</h4>
      <p class="muted small">${escapeHTML(formatWhen(item.timestamp))} · ${escapeHTML(item.reason || '发现违规，已尝试拦截')}</p>
      <p class="muted small">${escapeHTML(item.processPath || '无附加信息')}</p>
    `;
    const addBtn = document.createElement('button');
    addBtn.className = 'btn small ghost';
    addBtn.textContent = '加入用户白名单';
    addBtn.addEventListener('click', () => openUserWhitelistModal({ violation: item }));
    row.appendChild(addBtn);
    frag.appendChild(row);
  });
  list.replaceChildren(frag);
}

function renderFocusState(session) {
  const idle = el('focus-state-idle');
  const running = el('focus-state-running');
  const result = el('focus-state-result');
  const resultSummaryGrid = el('result-summary-grid');
  
  const status = (!session || session.status === 'idle') ? 'idle' : session.status;
  if (idle.classList.contains('active') && status !== 'idle') idle.classList.remove('active');
  if (running.classList.contains('active') && status !== 'running') running.classList.remove('active');
  if (result.classList.contains('active') && (status === 'idle' || status === 'running')) {
    result.classList.remove('active');
    resultSummaryGrid.classList.add('hidden');
  }

  if (status === 'idle') {
    hideExitChallenge();
    el('latest-violation-title').textContent = '暂无';
    el('latest-violation-reason').textContent = '还没有拦截记录。';
    if (!idle.classList.contains('active')) idle.classList.add('active');
    updateHeroIdleTimer();
    return;
  }

  if (status === 'running') {
    if (!running.classList.contains('active')) running.classList.add('active');
    el('running-timer').textContent = session.sessionMode === 'countup'
      ? formatClock(session.elapsedMs)
      : formatTime(session.remainingMs);
    el('running-subtitle').textContent = `${session.sessionMode === 'countup' ? '正计时中' : '正在守住你这轮允许规则'} · 精准 ${session.preciseItems.length} 条，模糊 ${session.fuzzyPhrases.length} 条`;
    el('metric-violations').textContent = String(session.violationCount || 0);
    el('metric-allowed-windows').textContent = String(session.preciseItems.length || 0);
    el('metric-allowed-categories').textContent = String(session.fuzzyPhrases.length || 0);
    const latest = (session.violations || []).slice(-1)[0];
    el('latest-violation-title').textContent = latest?.title || latest?.processName || '暂无';
    el('latest-violation-reason').textContent = latest ? `${latest.reason} · ${formatWhen(latest.timestamp)}` : '还没有拦截记录。';
    return;
  }

  hideExitChallenge();
  if (!result.classList.contains('active')) {
    result.classList.add('active');
    resultSummaryGrid.classList.remove('hidden');
  }
  
  const summary = session.summary || {};
  const reasonMap = { completed: '倒计时结束', cancelled: '手动结束' };
  const actualDurationMinutes = Number(summary.actualDurationMinutes ?? summary.durationMinutes ?? 0);
  const plannedDurationMinutes = Number(summary.plannedDurationMinutes ?? 0);
  el('result-title').textContent = session.status === 'completed' ? '本轮专注完成' : '本轮专注已结束';
  const planNote = (summary.sessionMode !== 'countup' && plannedDurationMinutes && plannedDurationMinutes !== actualDurationMinutes)
    ? `计划 ${formatDurationMinutes(plannedDurationMinutes)}`
    : '';
  el('result-subtitle').textContent = planNote;
  el('result-subtitle').classList.toggle('hidden', !planNote);
  el('result-duration').textContent = formatDurationMinutes(actualDurationMinutes);
  el('result-violations').textContent = String(summary.violationCount || 0);
  el('result-reason').textContent = reasonMap[summary.completionReason] || '—';
  const latest = (summary.violations || []).slice(-1)[0];
  el('latest-violation-title').textContent = latest?.title || latest?.processName || '暂无';
  el('latest-violation-reason').textContent = latest ? `${latest.reason} · ${formatWhen(latest.timestamp)}` : '还没有拦截记录。';
}

function renderSummaryLists(summary) {
  const windows = el('result-windows');
  const categories = el('result-categories');

  const currentHash = (summary.preciseItems?.length || 0) + '|' + (summary.fuzzyPhrases?.length || 0);
  if (windows.dataset.sHash === currentHash) return;
  windows.dataset.sHash = currentHash;

  if (!(summary.preciseItems || []).length) {
    windows.innerHTML = '<div class="empty">没有精准条目</div>';
  } else {
    const wFrag = document.createDocumentFragment();
    summary.preciseItems.forEach((item) => wFrag.appendChild(makeChip(item.label || item.title || item.processName || '未命名条目', { color: item.setColor })));
    windows.replaceChildren(wFrag);
  }

  if (!(summary.fuzzyPhrases || []).length) {
    categories.innerHTML = '<div class="empty">没有模糊短语</div>';
  } else {
    const cFrag = document.createDocumentFragment();
    summary.fuzzyPhrases.forEach((item) => cFrag.appendChild(makeChip(item.text, { category: true, color: item.setColor })));
    categories.replaceChildren(cFrag);
  }
}

function renderSession(session) {
  state.session = session;
  if (session?.status === 'running') {
    state.sessionMode = session.sessionMode || state.sessionMode || 'countdown';
  }
  renderContext(session.currentContext);
  renderFocusState(session);
  renderViolations(session.violations || [], 'violations-list', 'violations-empty');
  renderViolations(session.violations || (session.summary?.violations) || [], 'violations-result-list', 'violations-result-empty');
  renderSummaryLists(session.summary || {
    preciseItems: session.preciseItems,
    fuzzyPhrases: session.fuzzyPhrases,
  });
  renderFocusView();
}
function renderHelperStatus() {
  const statusEl = el('admin-helper-status');
  if (!statusEl) return;
  if (state.helperStatus === 'ready') {
    statusEl.textContent = '管理员拦截：已开启（helper 就绪）';
  } else if (state.helperStatus === 'launching') {
    statusEl.textContent = '管理员拦截：正在请求授权…';
  } else if (state.helperStatus === 'missing') {
    statusEl.textContent = '管理员拦截：开启失败（未获管理员授权）';
  } else {
    statusEl.textContent = '管理员拦截：关';
  }
}

async function refreshHelperStatus() {
  try {
    const payload = await api.getHelperStatus();
    state.helperStatus = payload?.status || 'off';
  } catch {
    state.helperStatus = 'off';
  }
  renderHelperStatus();
}

function renderAdminInterceptSettings() {
  const promptInput = el('admin-intercept-prompt-input');
  const enabledInput = el('admin-intercept-enabled-input');
  const disabledHint = el('admin-intercept-disabled-hint');
  if (!promptInput || !enabledInput) return;

  const showPrompt = state.settings?.adminInterceptPrompt !== false;
  promptInput.checked = !showPrompt;
  enabledInput.checked = state.settings?.adminIntercept === 'on';
  enabledInput.disabled = showPrompt;
  if (disabledHint) disabledHint.classList.toggle('hidden', !showPrompt);

  renderHelperStatus();
}

async function loadSettings() {
  state.settings = await api.getSettings();
  el('history-dir-input').value = state.settings.historyDir || '';
  el('auto-write-history-input').checked = state.settings.autoWriteHistory !== false;
  el('system-safelist-enabled-input').checked = state.settings.systemSafelistEnabled !== false;
  el('open-at-login-input').checked = !!state.settings.openAtLogin;
  el('silent-start-input').checked = !!state.settings.silentStart;
  el('exit-difficulty-input').value = state.settings.exitDifficulty || 'easy';
  state.exitDifficulty = state.settings.exitDifficulty || 'easy';
  renderSystemSafelist(state.settings.systemSafelistRules || []);
  renderUserSafelist(state.settings.userSafelistRules || []);
  await refreshHelperStatus();
  renderAdminInterceptSettings();
  renderDraftSummary();
}

async function saveSettings() {
  const patch = {
    historyDir: el('history-dir-input').value.trim() || state.settings?.historyDir || '',
    autoWriteHistory: el('auto-write-history-input').checked,
    systemSafelistEnabled: el('system-safelist-enabled-input').checked,
    openAtLogin: el('open-at-login-input').checked,
    silentStart: el('silent-start-input').checked,
    exitDifficulty: el('exit-difficulty-input').value,
  };
  state.settings = await api.saveSettings(patch);
  state.exitDifficulty = state.settings.exitDifficulty || 'easy';
  renderSystemSafelist(state.settings.systemSafelistRules || []);
  renderAdminInterceptSettings();
  renderDraftSummary();
  showToast('设置已保存');
  await refreshHistoryFiles();
}

async function refreshHistoryFiles() {
  const files = await api.listHistoryFiles();
  state.historyFiles = files.slice(0, 3);
  if (state.selectedHistoryFile && !state.historyFiles.some((file) => file.fileName === state.selectedHistoryFile)) {
    state.selectedHistoryFile = null;
  }
  const list = el('history-files-list');
  setEmptyVisible(el('history-files-empty'), state.historyFiles.length === 0);
  const frag = document.createDocumentFragment();
  state.historyFiles.forEach((file) => {
    const row = document.createElement('div');
    row.className = `history-file ${state.selectedHistoryFile === file.fileName ? 'active' : ''}`;
    const btn = document.createElement('button');
    btn.innerHTML = `<h4>${escapeHTML(file.fileName)}</h4><p class="muted small">${escapeHTML(formatWhen(file.modifiedAt))}</p>`;
    btn.addEventListener('click', () => loadHistoryFile(file.fileName));
    const openBtn = document.createElement('button');
    openBtn.className = 'history-open-btn';
    openBtn.type = 'button';
    openBtn.title = '打开这个 Markdown 文件';
    openBtn.setAttribute('aria-label', `打开 ${escapeHTML(file.fileName)}`);
    openBtn.textContent = '↗';
    openBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await api.openHistoryFile(file.fileName);
    });
    row.appendChild(btn);
    row.appendChild(openBtn);
    frag.appendChild(row);
  });
  list.replaceChildren(frag);

  if (!state.selectedHistoryFile && state.historyFiles.length) {
    await loadHistoryFile(state.historyFiles[0].fileName);
  }
}

async function loadHistoryFile(fileName) {
  const payload = await api.readHistoryFile(fileName);
  state.selectedHistoryFile = payload.fileName;
  state.historyContent = payload.content;
  el('history-preview-title').textContent = payload.fileName;
  el('history-preview').textContent = payload.content;
  document.querySelectorAll('.history-file').forEach((node) => {
    node.classList.toggle('active', node.textContent.includes(payload.fileName));
  });
}

function parseChineseDurationToMinutes(text = '') {
  const value = String(text).trim();
  if (!value) return 0;
  const hours = Number((value.match(/(\d+)\s*小时/) || [])[1] || 0);
  const minutes = Number((value.match(/(\d+)\s*分钟/) || [])[1] || 0);
  if (hours || minutes) {
    return hours * 60 + minutes;
  }
  return Number((value.match(/(\d+)/) || [])[1] || 0);
}

function parseDashboardDayFromMarkdown(fileName, content) {
  const dateKey = String(fileName || '').replace(/\.md$/i, '');
  const totalDurationText = (content.match(/当日总专注时长：([^\r\n]+)/) || [])[1] || '';
  const totalSessions = Number((content.match(/当日总会话数：(\d+)/) || [])[1] || 0);
  const totalViolations = Number((content.match(/当日总违规次数：(\d+)/) || [])[1] || 0);
  const sessions = content
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## ') && !line.startsWith('## 当日摘要'))
    .map((line) => line.replace(/^##\s+/, '').trim());

  return {
    dateKey,
    totalMinutes: parseChineseDurationToMinutes(totalDurationText),
    totalSessions,
    totalViolations,
    sessions,
  };
}

function renderDashboardSummary(days = []) {
  state.dashboardDays = days;
  const totalMinutes = days.reduce((sum, day) => sum + Number(day.totalMinutes || 0), 0);
  const totalSessions = days.reduce((sum, day) => sum + Number(day.totalSessions || 0), 0);
  const totalViolations = days.reduce((sum, day) => sum + Number(day.totalViolations || 0), 0);
  el('dashboard-total-hours').textContent = `${(totalMinutes / 60).toFixed(1)} h`;
  el('dashboard-total-sessions').textContent = String(totalSessions);
  el('dashboard-total-violations').textContent = String(totalViolations);

  const list = el('dashboard-days-list');
  setEmptyVisible(el('dashboard-days-empty'), days.length === 0);
  const frag = document.createDocumentFragment();
  days.forEach((day) => {
    const row = document.createElement('div');
    row.className = `dashboard-day-item ${state.selectedDashboardDay === day.dateKey ? 'active' : ''}`;
    const btn = document.createElement('button');
    btn.innerHTML = `<h4>${escapeHTML(day.dateKey)}</h4><p class="muted small">${escapeHTML(day.totalMinutes)} 分钟 · ${escapeHTML(day.totalSessions)} 次会话 · 违规 ${escapeHTML(day.totalViolations)} 次</p>`;
    btn.addEventListener('click', () => {
      state.selectedDashboardDay = day.dateKey;
      renderDashboardSummary(state.dashboardDays);
      renderDashboardDetail(day);
    });
    row.appendChild(btn);
    frag.appendChild(row);
  });
  list.replaceChildren(frag);

  if (!days.some((day) => day.dateKey === state.selectedDashboardDay)) {
    state.selectedDashboardDay = null;
  }
  if (!state.selectedDashboardDay && days.length) {
    state.selectedDashboardDay = days[0].dateKey;
  }
  const selected = days.find((day) => day.dateKey === state.selectedDashboardDay) || days[0] || null;
  renderDashboardDetail(selected);
}

function renderDashboardDetail(day) {
  el('dashboard-detail-title').textContent = day?.dateKey || '未选择日期';
  const empty = el('dashboard-detail-empty');
  const body = el('dashboard-detail-body');

  if (!day) {
    empty.classList.remove('hidden');
    body.classList.add('hidden');
    body.innerHTML = '';
    return;
  }

  empty.classList.add('hidden');
  body.classList.remove('hidden');

  const frag = document.createDocumentFragment();
  const summary = document.createElement('div');
  summary.className = 'rule-row';
  summary.innerHTML = `<div class="rule-main"><h4>${escapeHTML(day.dateKey)}</h4><p class="muted small">总专注 ${escapeHTML(day.totalMinutes)} 分钟 · ${escapeHTML(day.totalSessions)} 次会话 · 违规 ${escapeHTML(day.totalViolations)} 次</p></div>`;
  frag.appendChild(summary);

  if (!day.sessions?.length) {
    const noSessions = document.createElement('div');
    noSessions.className = 'empty';
    noSessions.textContent = '当天没有可展示的 session 明细。';
    frag.appendChild(noSessions);
  } else {
    day.sessions.forEach((sessionTitle) => {
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML = `<div class="rule-main"><p>${escapeHTML(sessionTitle)}</p></div>`;
      frag.appendChild(row);
    });
  }
  body.replaceChildren(frag);
}

async function refreshDashboard(showTip = false) {
  if (!api) return;
  try {
    state.dashboardDays = [];
    state.selectedDashboardDay = null;
    const files = await api.listHistoryFiles();
    const recentFiles = files.slice(0, 7);
    const payloads = await Promise.all(recentFiles.map((file) => api.readHistoryFile(file.fileName)));
    const days = payloads.map((payload) => parseDashboardDayFromMarkdown(payload.fileName, payload.content));
    renderDashboardSummary(days);
    if (showTip) {
      showToast(days.length ? '看板已刷新' : '看板暂无历史数据');
    }
  } catch (error) {
    console.error(error);
    showToast('刷新看板失败', 'danger');
  }
}

async function refreshCurrentContext(showTip = false) {
  if (!api) return;
  try {
    const context = await api.getCurrentContext();
    renderContext(context);
    if (showTip) {
      showToast('已刷新当前上下文');
    }
  } catch (error) {
    if (showTip) {
      showToast(error.message || '刷新失败', 'danger');
    }
  }
}

async function refreshInitialState() {
  if (!api) {
    showToast('preload 注入失败', 'danger');
    return;
  }

  try {
    const [session, context] = await Promise.all([api.getState(), api.getCurrentContext()]);
    if (session?.status === 'running') {
      state.sessionMode = session.sessionMode || state.sessionMode || 'countdown';
    }
    renderSession(session);
    renderContext(context);
    renderPreciseRuleSets();
    renderFuzzyRuleSets();
    renderRulesSummary();
    await loadSettings();
    await refreshHistoryFiles();
  } catch (error) {
    console.error(error);
    showToast('初始化状态失败，请稍后重试', 'danger');
  }
}

function getRequestedDurationMinutes() {
  return state.sessionMode === 'countup'
    ? 0
    : Number(el('duration-minutes').value || 25);
}

function hasEnabledRules() {
  return enabledPreciseItems().length > 0 || enabledFuzzyPhrases().length > 0;
}

function updateStartButton() {
  const btn = el('start-session-btn');
  if (!btn) return;
  btn.disabled = state.starting || !hasEnabledRules();
}

function setStarting(value) {
  state.starting = value;
  updateStartButton();
  el('start-lock-overlay')?.classList.toggle('hidden', !value);
  document.body.classList.toggle('is-starting', value);
}

async function beginSession({ durationMinutes, useAdminIntercept = false }) {
  setStarting(true);
  try {
    const session = await api.startSession({
      sessionMode: state.sessionMode,
      durationMinutes,
      preciseItems: enabledPreciseItems(),
      fuzzyPhrases: enabledFuzzyPhrases(),
      exitProtection: { type: 'typing' },
      useAdminIntercept,
    });
    renderSession(session);
    showToast('专注已开始');
  } catch (error) {
    showToast(error.message || '开始专注失败', 'danger');
  } finally {
    setStarting(false);
  }
}

async function requestElevation() {
  if (state.helperStatus === 'ready') {
    return true;
  }
  state.helperStatus = 'launching';
  renderHelperStatus();
  showToast('正在请求管理员授权…');
  try {
    const result = await api.startHelper();
    state.helperStatus = result?.status || 'missing';
  } catch {
    state.helperStatus = 'missing';
  }
  renderHelperStatus();
  if (state.helperStatus !== 'ready') {
    showToast('未获得管理员授权，已取消本轮启动', 'danger');
    return false;
  }
  return true;
}

async function handleStartSession() {
  if (state.starting) {
    return;
  }

  const durationMinutes = getRequestedDurationMinutes();
  if (!hasEnabledRules()) {
    showToast('请至少启用一个规则集并添加条目', 'danger');
    return;
  }

  const settings = state.settings || {};
  const promptSuppressed = settings.adminInterceptPrompt === false;

  if (promptSuppressed) {
    if (settings.adminIntercept === 'on') {
      setStarting(true);
      if (!(await requestElevation())) {
        setStarting(false);
        return;
      }
      await beginSession({ durationMinutes, useAdminIntercept: true });
      return;
    }
    await beginSession({ durationMinutes, useAdminIntercept: false });
    return;
  }

  state.pendingAdminStart = { durationMinutes };
  el('admin-intercept-remember-input').checked = false;
  setStarting(true);
  el('admin-intercept-overlay').classList.remove('hidden');
}

async function resolveAdminPrompt(enable) {
  const remember = el('admin-intercept-remember-input').checked;
  el('admin-intercept-overlay').classList.add('hidden');
  const durationMinutes = state.pendingAdminStart?.durationMinutes ?? getRequestedDurationMinutes();
  state.pendingAdminStart = null;

  if (remember) {
    state.settings = await api.saveSettings({
      adminIntercept: enable ? 'on' : 'off',
      adminInterceptPrompt: false,
    });
    renderAdminInterceptSettings();
  }

  if (enable) {
    setStarting(true);
    if (!(await requestElevation())) {
      setStarting(false);
      return;
    }
    await beginSession({ durationMinutes, useAdminIntercept: true });
    return;
  }

  await beginSession({ durationMinutes, useAdminIntercept: false });
}

async function stopSession() {
  try {
    const session = await api.endSession({ reason: 'cancelled' });
    renderSession(session);
    await api.stopHelper();
    await refreshHistoryFiles();
    showToast('已结束本轮专注');
  } catch (error) {
    showToast(error.message || '结束专注失败', 'danger');
  }
}

async function backToRules() {
  const summary = state.session?.summary || {};
  state.sessionMode = summary.sessionMode || state.sessionMode || 'countdown';
  try {
    const idle = await api.resetSession();
    renderSession(idle);
    state.sessionMode = summary.sessionMode || state.sessionMode || 'countdown';
    updateHeroIdleTimer();
    renderSessionModeSwitch();
    renderPreciseRuleSets();
    renderFuzzyRuleSets();
    renderRulesSummary();
    showToast('规则已保留，可以开始新专注');
  } catch (error) {
    console.error(error);
    showToast(error.message || '重置失败', 'danger');
  }
}

const CHALLENGE_MEDIUM_BASE = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz`-=[]/.,:;<>?!@#$%^&*()_+\'"';
const CHALLENGE_HARD_POOL = '龘靐齉齾爩鱻麤龗灪龖厵滟爨癵籱饢驫鸜麷顟顠饙騳饐';

function generateChallenge(difficulty) {
  if (difficulty === 'hard') {
    let s = '';
    while (s.length < 3) {
      const ch = CHALLENGE_HARD_POOL[Math.floor(Math.random() * CHALLENGE_HARD_POOL.length)];
      if (!s.includes(ch)) s += ch;
    }
    return { phrase: s, seconds: 15 };
  }
  if (difficulty === 'medium') {
    const len = 8 + Math.floor(Math.random() * 3);
    let s = '';
    for (let i = 0; i < len; i += 1) {
      s += CHALLENGE_MEDIUM_BASE[Math.floor(Math.random() * CHALLENGE_MEDIUM_BASE.length)];
    }
    return { phrase: s, seconds: 20 };
  }
  return { phrase: '我要暂停专注', seconds: 20 };
}

function showExitChallenge() {
  if (state.session?.status !== 'running') return;
  const { phrase, seconds } = generateChallenge(state.exitDifficulty || 'easy');
  el('challenge-phrase').textContent = phrase;
  el('challenge-input').value = '';
  el('challenge-error').classList.add('hidden');
  el('challenge-countdown').textContent = seconds;
  el('challenge-confirm-btn').disabled = false;
  el('exit-challenge-overlay').classList.remove('hidden');
  el('challenge-input').focus();

  let remaining = seconds;
  if (state.challengeTimer) clearInterval(state.challengeTimer);
  state.challengeTimer = setInterval(() => {
    remaining -= 1;
    el('challenge-countdown').textContent = remaining;
    if (remaining <= 0) {
      clearInterval(state.challengeTimer);
      state.challengeTimer = null;
      el('challenge-confirm-btn').disabled = true;
      el('challenge-error').textContent = '时间到，请重新尝试。';
      el('challenge-error').classList.remove('hidden');
    }
  }, 1000);
}

function hideExitChallenge() {
  el('exit-challenge-overlay').classList.add('hidden');
  if (state.challengeTimer) {
    clearInterval(state.challengeTimer);
    state.challengeTimer = null;
  }
  el('challenge-confirm-btn').disabled = false;
}

async function confirmExitChallenge() {
  if (el('challenge-confirm-btn').disabled) {
    el('challenge-error').textContent = '时间到，请重新尝试。';
    el('challenge-error').classList.remove('hidden');
    return;
  }
  const phrase = el('challenge-phrase').textContent;
  const input = el('challenge-input').value;
  if (input !== phrase) {
    el('challenge-error').textContent = '内容不匹配，请重新输入。';
    el('challenge-error').classList.remove('hidden');
    el('challenge-input').value = '';
    el('challenge-input').focus();
    return;
  }
  hideExitChallenge();
  await stopSession();
}
function bindEvents() {
  el('edit-rules-btn').addEventListener('click', () => openDrawer('rules'));
  el('close-rules-drawer').addEventListener('click', () => closeDrawer('rules'));
  el('open-dashboard-btn').addEventListener('click', () => {
    openDrawer('dashboard');
    refreshDashboard(false);
  });
  el('open-history-btn').addEventListener('click', () => {
    openDrawer('history');
    refreshHistoryFiles();
  });
  el('close-history-drawer').addEventListener('click', () => closeDrawer('history'));
  el('open-settings-btn').addEventListener('click', () => openDrawer('settings'));
  el('close-settings-drawer').addEventListener('click', () => closeDrawer('settings'));
  el('close-dashboard-drawer').addEventListener('click', () => closeDrawer('dashboard'));

  ['rules', 'history', 'settings', 'dashboard'].forEach((name) => {
    el(`${name}-drawer-overlay`).addEventListener('click', (event) => {
      if (event.target === el(`${name}-drawer-overlay`)) closeDrawer(name);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!el('ruleset-editor-overlay').classList.contains('hidden')) {
        closeRulesetEditor();
        return;
      }
      ['rules', 'history', 'settings', 'dashboard'].forEach((name) => {
        if (!el(`${name}-drawer-overlay`).classList.contains('hidden')) closeDrawer(name);
      });
    }
  });

  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchRulesTab(btn.dataset.tab));
  });

  el('candidate-add-btn')?.addEventListener('click', addPreciseFromCandidate);
  document.querySelectorAll('#candidate-type-switch .mode-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.candidateType = btn.dataset.type === 'process' ? 'process' : 'window';
      renderCandidateTypeSwitch();
      if (state.candidate) {
        el('candidate-rule-preview').textContent = describeCandidateItem(state.candidate, state.candidateType);
      }
    });
  });
  el('precise-manual-add-btn')?.addEventListener('click', addPreciseManual);
  el('precise-manual-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addPreciseManual();
  });
  el('precise-add-set-btn')?.addEventListener('click', () => openRulesetEditor('precise', null));
  el('fuzzy-add-set-btn')?.addEventListener('click', () => openRulesetEditor('fuzzy', null));
  el('refresh-open-windows-btn')?.addEventListener('click', refreshOpenWindows);
  el('ruleset-editor-cancel-btn')?.addEventListener('click', closeRulesetEditor);
  el('ruleset-editor-save-btn')?.addEventListener('click', saveRulesetEditor);
  el('ruleset-color-input')?.addEventListener('input', (event) => {
    el('ruleset-color-hex').textContent = event.target.value;
  });
  el('ruleset-editor-overlay')?.addEventListener('click', (event) => {
    if (event.target === el('ruleset-editor-overlay')) closeRulesetEditor();
  });

  el('start-session-btn').addEventListener('click', handleStartSession);
  el('back-to-rules-btn').addEventListener('click', backToRules);
  el('duration-minutes').addEventListener('input', updateHeroIdleTimer);
  document.querySelectorAll('#session-mode-switch .mode-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sessionMode = btn.dataset.mode === 'countup' ? 'countup' : 'countdown';
      updateHeroIdleTimer();
      renderSessionModeSwitch();
    });
  });

  el('refresh-context-btn').addEventListener('click', () => refreshCurrentContext(true));

  el('refresh-history-btn').addEventListener('click', refreshHistoryFiles);
  el('refresh-dashboard-btn').addEventListener('click', () => refreshDashboard(true));
  el('open-history-dir-btn').addEventListener('click', async () => {
    await api.openHistoryDirectory();
  });

  el('save-settings-btn').addEventListener('click', saveSettings);

  el('add-user-safelist-btn')?.addEventListener('click', () => openUserWhitelistModal());
  el('whitelist-cancel-btn')?.addEventListener('click', closeUserWhitelistModal);
  el('whitelist-save-btn')?.addEventListener('click', saveUserWhitelistModal);
  el('whitelist-rule-overlay')?.addEventListener('click', (event) => {
    if (event.target === el('whitelist-rule-overlay')) closeUserWhitelistModal();
  });
  el('admin-intercept-no-btn')?.addEventListener('click', () => resolveAdminPrompt(false));
  el('admin-intercept-yes-btn')?.addEventListener('click', () => resolveAdminPrompt(true));
  el('admin-intercept-prompt-input')?.addEventListener('change', async (event) => {
    state.settings = await api.saveSettings({ adminInterceptPrompt: !event.target.checked });
    renderAdminInterceptSettings();
  });
  el('admin-intercept-enabled-input')?.addEventListener('change', async (event) => {
    state.settings = await api.saveSettings({ adminIntercept: event.target.checked ? 'on' : 'off' });
    renderAdminInterceptSettings();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el('whitelist-rule-overlay')?.classList.contains('hidden')) {
      closeUserWhitelistModal();
    }
  });

  el('exit-challenge-btn').addEventListener('click', showExitChallenge);
  el('challenge-cancel-btn').addEventListener('click', hideExitChallenge);
  el('challenge-confirm-btn').addEventListener('click', confirmExitChallenge);
  el('challenge-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmExitChallenge();
  });

  if (!api) return;
  api.subscribeState(async (session) => {
    const previousStatus = state.session?.status;

    if (previousStatus === 'running' && (session.status === 'completed' || session.status === 'cancelled')) {
      void api.stopHelper();
      await refreshHistoryFiles();
      if (!el('dashboard-drawer-overlay').classList.contains('hidden')) {
        await refreshDashboard();
      }
    }

    renderSession(session);
  });
  api.subscribeViolation((violation) => {
    const target = violation.title || violation.processName || '未知窗口';
    showToast(`发现违规：${target}（已尝试拦截）`, 'danger');
  });
  api.subscribeHelperStatus((payload) => {
    state.helperStatus = payload?.status || 'off';
    renderHelperStatus();
  });
}

bindEvents();
refreshInitialState();
setInterval(() => {
  if (state.session?.status !== 'running') {
    refreshCurrentContext(false);
  }
}, 4000);
