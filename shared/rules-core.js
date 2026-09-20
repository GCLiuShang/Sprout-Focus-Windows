import { getDefaultSystemSafelistRules } from './models.js';

const SYSTEM_PATH_PREFIXES = [
  'c:\\windows\\system32\\',
  'c:\\windows\\syswow64\\',
  'c:\\windows\\winsxs\\',
  'c:\\windows\\immersivecontrolpanel\\',
  'c:\\windows\\systemapps\\',
];

export function normalize(value = '') {
  return String(value || '').toLowerCase();
}

export function includesAny(text, patterns = []) {
  const target = normalize(text);
  return patterns.some((pattern) => target.includes(normalize(pattern)));
}

export function isSystemPath(processPath) {
  const target = normalize(processPath).replace(/\//g, '\\');
  return SYSTEM_PATH_PREFIXES.some((prefix) => target.startsWith(prefix));
}

function matchPatternRule(context, rules, { enabled = true } = {}) {
  if (!enabled || !context) {
    return null;
  }

  for (const rule of rules) {
    if (!rule?.enabled) {
      continue;
    }

    const processPatterns = rule.processPatterns || [];
    const titlePatterns = rule.titlePatterns || [];
    if (!processPatterns.length && !titlePatterns.length) {
      continue;
    }

    const matchesProcess = !processPatterns.length
      || includesAny(context.processPath, processPatterns)
      || includesAny(context.processName, processPatterns);
    const matchesTitle = !titlePatterns.length || includesAny(context.title, titlePatterns);

    if (matchesProcess && matchesTitle) {
      return rule;
    }
  }

  return null;
}

export function matchUserSafelist(context, rules = []) {
  return matchPatternRule(context, rules);
}

export function matchSystemRule(context, rules = [], enabled = true) {
  return matchPatternRule(context, rules, { enabled });
}

export function preciseItemMatches(item, context) {
  if (!item || !context) {
    return false;
  }

  if (item.type === 'process') {
    const samePath = Boolean(
      item.processPath
      && context.processPath
      && item.processPath.toLowerCase() === context.processPath.toLowerCase(),
    );
    if (samePath) {
      return true;
    }
    return Boolean(
      item.processName
      && context.processName
      && item.processName.toLowerCase() === context.processName.toLowerCase(),
    );
  }

  if (item.windowId != null && context.windowId != null && item.windowId === context.windowId) {
    return true;
  }

  const samePath = Boolean(item.processPath && context.processPath && item.processPath.toLowerCase() === context.processPath.toLowerCase());
  const sameTitle = Boolean(item.title && context.title && item.title.trim() === context.title.trim());
  return samePath && sameTitle;
}

export function fuzzyPhraseMatches(phrase, context) {
  if (!phrase?.text) {
    return false;
  }

  const haystack = [
    context?.title,
    context?.processName,
    context?.processPath,
  ]
    .filter(Boolean)
    .join(' || ');

  if (!haystack) {
    return false;
  }

  if (phrase.mode === 'regex') {
    try {
      return new RegExp(phrase.text, 'i').test(haystack);
    } catch {
      return false;
    }
  }

  return haystack.toLowerCase().includes(phrase.text.toLowerCase());
}

export function decideContext({
  context,
  preciseItems = [],
  fuzzyPhrases = [],
  systemSafelistEnabled = true,
  systemSafelistRules = getDefaultSystemSafelistRules(),
  userSafelistRules = [],
}) {
  if (!context?.windowId) {
    return {
      allowed: true,
      reason: '未检测到有效前台窗口',
      matchedPrecise: null,
      matchedFuzzy: null,
      matchedSystemRule: null,
      matchedUserRule: null,
    };
  }

  const matchedUserRule = matchUserSafelist(context, userSafelistRules);
  if (matchedUserRule) {
    return {
      allowed: true,
      reason: `命中用户白名单 ${matchedUserRule.name}`,
      matchedPrecise: null,
      matchedFuzzy: null,
      matchedSystemRule: null,
      matchedUserRule,
    };
  }

  const matchedSystemRule = matchSystemRule(context, systemSafelistRules, systemSafelistEnabled);
  if (matchedSystemRule) {
    return {
      allowed: true,
      reason: `命中系统安全白名单 ${matchedSystemRule.name}`,
      matchedPrecise: null,
      matchedFuzzy: null,
      matchedSystemRule,
      matchedUserRule: null,
    };
  }

  if (systemSafelistEnabled && isSystemPath(context.processPath)) {
    const heuristicRule = { id: 'heuristic-system-path', name: '系统目录（启发式）' };
    return {
      allowed: true,
      reason: `命中系统目录启发式 ${context.processName || context.processPath || '系统进程'}`,
      matchedPrecise: null,
      matchedFuzzy: null,
      matchedSystemRule: heuristicRule,
      matchedUserRule: null,
    };
  }

  const matchedPrecise = preciseItems.find((item) => preciseItemMatches(item, context));
  if (matchedPrecise) {
    return {
      allowed: true,
      reason: `命中精准规则 ${matchedPrecise.setName || matchedPrecise.label || ''}`.trim(),
      matchedPrecise,
      matchedFuzzy: null,
      matchedSystemRule: null,
      matchedUserRule: null,
    };
  }

  const matchedFuzzy = fuzzyPhrases.find((phrase) => fuzzyPhraseMatches(phrase, context));
  if (matchedFuzzy) {
    return {
      allowed: true,
      reason: `命中模糊规则 ${matchedFuzzy.setName || matchedFuzzy.text}`,
      matchedPrecise: null,
      matchedFuzzy,
      matchedSystemRule: null,
      matchedUserRule: null,
    };
  }

  return {
    allowed: false,
    reason: '当前窗口未命中任何精准或模糊规则',
    matchedPrecise: null,
    matchedFuzzy: null,
    matchedSystemRule: null,
    matchedUserRule: null,
  };
}

export default decideContext;
