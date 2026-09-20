export const MAX_RULE_SET_ITEMS = 50;
export const MAX_RULE_SETS = 50;

export function createEmptyActiveContext() {
  return {
    timestamp: new Date().toISOString(),
    source: 'windows',
    title: '',
    windowId: null,
    processId: null,
    processName: '',
    processPath: '',
    confidence: 0,
  };
}

export function createInitialSessionState() {
  return {
    status: 'idle',
    sessionMode: 'countdown',
    startedAt: null,
    endsAt: null,
    durationMinutes: 25,
    remainingMs: 0,
    elapsedMs: 0,
    violationCount: 0,
    violations: [],
    preciseItems: [],
    fuzzyPhrases: [],
    systemSafelistEnabled: true,
    recentPreciseItem: null,
    currentContext: createEmptyActiveContext(),
    exitProtection: {
      type: 'hold',
      holdToExitMs: 3000,
    },
    summary: null,
  };
}

export function createSystemSafelistRule({
  id,
  name,
  description = '',
  processPatterns = [],
  titlePatterns = [],
  enabled = true,
} = {}) {
  return {
    id: id || `system-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || '未命名系统规则',
    description,
    processPatterns,
    titlePatterns,
    enabled,
  };
}

export function getDefaultSystemSafelistRules() {
  return [
    createSystemSafelistRule({
      id: 'system-explorer',
      name: '资源管理器与任务栏',
      description: '放行 explorer.exe 承载的资源管理器、任务栏、开始菜单、系统托盘等壳窗口。',
      processPatterns: ['C:\\Windows\\explorer.exe', 'explorer.exe'],
    }),
    createSystemSafelistRule({
      id: 'system-shell-hosts',
      name: '开始菜单与系统壳宿主',
      description: '放行 ShellExperienceHost、StartMenuExperienceHost、SearchHost 等系统壳进程。',
      processPatterns: ['ShellExperienceHost.exe', 'StartMenuExperienceHost.exe', 'SearchHost.exe', 'SearchApp.exe'],
    }),
    createSystemSafelistRule({
      id: 'system-lock-screen',
      name: '锁屏与登录界面',
      description: '放行 LockApp 和登录相关系统界面。',
      processPatterns: ['LockApp.exe', 'LogonUI.exe'],
      titlePatterns: ['Windows 默认锁屏界面', '锁屏'],
    }),
    createSystemSafelistRule({
      id: 'system-settings-security',
      name: '系统设置与安全弹窗',
      description: '放行系统设置、UAC、安全与凭据确认相关窗口。',
      processPatterns: ['SystemSettings.exe', 'consent.exe', 'CredentialUIBroker.exe', 'SecurityHealthSystray.exe', 'taskmgr.exe'],
      titlePatterns: ['用户帐户控制', 'Windows 安全', '凭据', '安全'],
    }),
    createSystemSafelistRule({
      id: 'system-dialogs',
      name: '文件选择与系统对话框',
      description: '放行常见打开、保存、浏览文件夹、通知和系统对话框。',
      titlePatterns: ['打开', '另存为', '保存为', '选择文件', '浏览文件夹', '选择文件夹', '系统托盘溢出窗口'],
    }),
    createSystemSafelistRule({
      id: 'system-screenshot',
      name: '截图工具',
      description: '放行 Windows 截图工具（截图和草图、Snipping Tool）及截图相关覆盖层。',
      processPatterns: ['SnippingTool.exe', 'ScreenSketch.exe', 'ScreenClippingHost.exe', 'Snipaste.exe'],
      titlePatterns: ['截图和草图', 'Snipping Tool', '截图工具', 'Screen Snip', 'Snipaste', 'Paste UI', '贴图'],
    }),
  ];
}

export function createUserSafelistRule({
  id,
  name,
  description = '',
  processPatterns = [],
  titlePatterns = [],
  enabled = true,
  source = 'user',
  createdAt,
} = {}) {
  return {
    id: id || `user-safelist-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || '未命名白名单',
    description,
    processPatterns: Array.isArray(processPatterns) ? processPatterns.filter(Boolean) : [],
    titlePatterns: Array.isArray(titlePatterns) ? titlePatterns.filter(Boolean) : [],
    enabled: enabled !== false,
    source: source === 'violation' ? 'violation' : 'user',
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function getDefaultUserSafelistRules() {
  return [];
}

export function normalizeUserSafelistRules(input) {
  if (!Array.isArray(input)) {
    return getDefaultUserSafelistRules();
  }

  return input
    .filter((item) => item && typeof item === 'object')
    .map((item) => createUserSafelistRule(item))
    .filter((rule) => rule.processPatterns.length || rule.titlePatterns.length);
}

export function createPreciseItem({
  id,
  type = 'window',
  label,
  processPath = '',
  processName = '',
  title = '',
  windowId = null,
  createdAt,
} = {}) {
  return {
    id: id || `precise-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: type === 'process' ? 'process' : 'window',
    label: label || title || processName || '未命名条目',
    processPath: String(processPath || ''),
    processName: String(processName || ''),
    title: String(title || ''),
    windowId: windowId ?? null,
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function createPreciseRuleSet({
  id,
  name,
  color = '#4ade80',
  enabled = true,
  items = [],
  createdAt,
} = {}) {
  return {
    id: id || `precise-set-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || '未命名精准规则集',
    color,
    enabled: enabled !== false,
    items: (Array.isArray(items) ? items : [])
      .map((item) => createPreciseItem(item))
      .filter((item) => item.processPath || item.processName || item.title)
      .slice(0, MAX_RULE_SET_ITEMS),
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function createFuzzyPhrase({ id, text, mode = 'text', createdAt } = {}) {
  return {
    id: id || `phrase-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    text: String(text || '').trim(),
    mode: mode === 'regex' ? 'regex' : 'text',
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function createFuzzyRuleSet({
  id,
  name,
  color = '#a78bfa',
  enabled = true,
  phrases = [],
  createdAt,
} = {}) {
  return {
    id: id || `fuzzy-set-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || '未命名模糊规则集',
    color,
    enabled: enabled !== false,
    phrases: (Array.isArray(phrases) ? phrases : [])
      .map((phrase) => createFuzzyPhrase(phrase))
      .filter((phrase) => phrase.text)
      .slice(0, MAX_RULE_SET_ITEMS),
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function normalizePreciseRuleSets(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((set) => set && typeof set === 'object')
    .map((set) => createPreciseRuleSet(set))
    .filter((set) => set.items.length)
    .slice(0, MAX_RULE_SETS);
}

export function normalizeFuzzyRuleSets(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((set) => set && typeof set === 'object')
    .map((set) => createFuzzyRuleSet(set))
    .filter((set) => set.phrases.length)
    .slice(0, MAX_RULE_SETS);
}

export function buildRuleSetsFromLegacy({ categoryRules = [], lastRules = null } = {}) {
  const selectedCategoryIds = new Set((lastRules?.allowedCategories || []).map((item) => item?.id));
  const hasSelection = selectedCategoryIds.size > 0;

  const fuzzyRuleSets = (Array.isArray(categoryRules) ? categoryRules : [])
    .filter((category) => category && category.name && category.pattern)
    .map((category) => createFuzzyRuleSet({
      id: category.id,
      name: category.name,
      color: category.color,
      enabled: hasSelection ? selectedCategoryIds.has(category.id) : true,
      phrases: String(category.pattern)
        .split('|')
        .map((token) => token.trim())
        .filter(Boolean)
        .map((text) => createFuzzyPhrase({ text, mode: 'text' })),
    }))
    .filter((set) => set.phrases.length);

  const preciseItems = (lastRules?.allowedWindows || [])
    .filter((item) => item && (item.processPath || item.processName || item.initialTitle))
    .map((item) => createPreciseItem({
      id: item.id,
      type: item.scope === 'process' ? 'process' : 'window',
      label: item.label || item.initialTitle || item.processName || '未命名窗口',
      processPath: item.processPath || '',
      processName: item.processName || '',
      title: item.initialTitle || item.title || '',
      windowId: item.windowId ?? null,
    }));

  const preciseRuleSets = preciseItems.length
    ? [createPreciseRuleSet({
      id: 'precise-migrated',
      name: '已迁移窗口',
      color: '#38bdf8',
      enabled: true,
      items: preciseItems,
    })]
    : [];

  return { preciseRuleSets, fuzzyRuleSets };
}

export function formatRemaining(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDurationMinutes(totalMinutes = 0) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) {
    return `${rest} 分钟`;
  }

  if (rest === 0) {
    return `${hours} 小时`;
  }

  return `${hours} 小时 ${rest} 分钟`;
}
