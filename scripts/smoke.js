import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { regenerateHistoryMarkdown } from '../guardian/history.js';
import { GuardianRuntime } from '../guardian/runtime.js';
import { decideContext } from '../guardian/rules.js';
import { IPC_CHANNELS } from '../shared/ipc.js';
import { fuzzyPhraseMatches, isSystemPath, matchSystemRule, matchUserSafelist, preciseItemMatches } from '../shared/rules-core.js';
import {
  MAX_RULE_SET_ITEMS,
  buildRuleSetsFromLegacy,
  createFuzzyPhrase,
  createInitialSessionState,
  createPreciseItem,
  createUserSafelistRule,
  getDefaultSystemSafelistRules,
  normalizeUserSafelistRules,
} from '../shared/models.js';

function preciseFromContext(context, type = 'window') {
  return createPreciseItem({
    type,
    label: context.title || context.processName || '未命名条目',
    processPath: context.processPath,
    processName: context.processName,
    title: type === 'window' ? context.title : '',
    windowId: context.windowId,
  });
}

const initialState = createInitialSessionState();
assert.equal(Array.isArray(initialState.preciseItems), true);
assert.equal(Array.isArray(initialState.fuzzyPhrases), true);
assert.equal('allowedWindows' in initialState, false);
assert.equal('allowedCategories' in initialState, false);
assert.equal(initialState.sessionMode, 'countdown');
assert.equal(initialState.elapsedMs, 0);
assert.equal(MAX_RULE_SET_ITEMS, 50);

const legacy = buildRuleSetsFromLegacy({
  categoryRules: [
    { id: 'cat-ai', name: 'AI', color: '#a78bfa', pattern: 'Claude|ChatGPT|Gemini' },
    { id: 'cat-old', name: 'Old', color: '#ffffff', pattern: 'Foo' },
  ],
  lastRules: {
    allowedWindows: [{ id: 'w1', scope: 'process', label: 'Code', processPath: 'C:/Code.exe', processName: 'Code', windowId: 1 }],
    allowedCategories: [{ id: 'cat-ai' }],
  },
});
const migratedAi = legacy.fuzzyRuleSets.find((set) => set.id === 'cat-ai');
assert.equal(migratedAi?.enabled, true);
assert.equal(migratedAi.phrases.map((phrase) => phrase.text).join('|'), 'Claude|ChatGPT|Gemini');
assert.equal(legacy.fuzzyRuleSets.find((set) => set.id === 'cat-old')?.enabled, false);
assert.equal(legacy.preciseRuleSets[0]?.items[0]?.type, 'process');

const windowContext = {
  timestamp: new Date().toISOString(),
  source: 'windows',
  title: 'Visual Studio Code',
  windowId: 101,
  processId: 1,
  processName: 'Code',
  processPath: 'C:/Program Files/Microsoft VS Code/Code.exe',
  confidence: 0.7,
};

const windowItem = preciseFromContext(windowContext, 'window');
assert.equal(preciseItemMatches(windowItem, windowContext), true);
const decision = decideContext({
  context: windowContext,
  preciseItems: [windowItem],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
});
assert.equal(decision.allowed, true);
assert.equal(decision.matchedPrecise?.id, windowItem.id);

const processItem = preciseFromContext(windowContext, 'process');
assert.equal(processItem.type, 'process');
const processScopeDecision = decideContext({
  context: {
    ...windowContext,
    windowId: 999,
    title: 'settings.json - Visual Studio Code',
  },
  preciseItems: [processItem],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
});
assert.equal(processScopeDecision.allowed, true);
assert.equal(processScopeDecision.matchedPrecise?.id, processItem.id);

const titleChangedDecision = decideContext({
  context: {
    ...windowContext,
    windowId: 555,
    title: 'other.ts - Visual Studio Code',
  },
  preciseItems: [windowItem],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
});
assert.equal(titleChangedDecision.allowed, false);

const fuzzyText = createFuzzyPhrase({ text: 'Claude', mode: 'text' });
assert.equal(fuzzyPhraseMatches(fuzzyText, { title: 'Claude - Project draft', processName: 'msedge.exe', processPath: 'C:/Edge/msedge.exe' }), true);
const categoryDecision = decideContext({
  context: {
    ...windowContext,
    title: 'Claude - Project draft',
    processName: 'msedge.exe',
    processPath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  },
  preciseItems: [],
  fuzzyPhrases: [fuzzyText],
  systemSafelistEnabled: true,
});
assert.equal(categoryDecision.allowed, true);
assert.equal(categoryDecision.matchedFuzzy?.id, fuzzyText.id);

const fuzzyRegex = createFuzzyPhrase({ text: 'Chat(GPT|Bot)', mode: 'regex' });
const regexDecision = decideContext({
  context: {
    ...windowContext,
    title: 'ChatGPT - new chat',
    processName: 'msedge.exe',
    processPath: 'C:/Edge/msedge.exe',
  },
  preciseItems: [],
  fuzzyPhrases: [fuzzyRegex],
  systemSafelistEnabled: true,
});
assert.equal(regexDecision.allowed, true);
const brokenRegex = createFuzzyPhrase({ text: '([unclosed', mode: 'regex' });
assert.equal(fuzzyPhraseMatches(brokenRegex, windowContext), false);

const systemDecision = decideContext({
  context: {
    ...windowContext,
    title: 'Windows 资源管理器',
    processName: 'explorer.exe',
    processPath: 'C:/Windows/explorer.exe',
  },
  preciseItems: [],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
});
assert.equal(systemDecision.allowed, true);
assert.equal(Boolean(systemDecision.matchedSystemRule), true);

const blockedDecision = decideContext({
  context: {
    ...windowContext,
    title: 'Bilibili - 首页',
    processName: 'msedge.exe',
    processPath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  },
  preciseItems: [],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
});
assert.equal(blockedDecision.allowed, false);

const shellHostContext = {
  ...windowContext,
  title: '快速设置',
  processName: 'ShellHost.exe',
  processPath: 'C:/Windows/System32/ShellHost.exe',
};
assert.equal(isSystemPath(shellHostContext.processPath), true);
const heuristicDecision = decideContext({
  context: shellHostContext,
  preciseItems: [],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
});
assert.equal(heuristicDecision.allowed, true);
assert.equal(heuristicDecision.matchedSystemRule?.id, 'heuristic-system-path');

const userRule = createUserSafelistRule({ name: '我的工具', processPatterns: ['MyTool'] });
const userDecision = decideContext({
  context: {
    ...windowContext,
    title: 'MyTool Panel',
    processName: 'MyTool.exe',
    processPath: 'D:/Apps/MyTool.exe',
  },
  preciseItems: [],
  fuzzyPhrases: [],
  systemSafelistEnabled: true,
  userSafelistRules: [userRule],
});
assert.equal(userDecision.allowed, true);
assert.equal(userDecision.matchedUserRule?.id, userRule.id);
assert.equal(matchUserSafelist({ ...windowContext, processName: 'MyTool.exe' }, [userRule])?.id, userRule.id);

const explorerSafelist = matchSystemRule(
  { ...windowContext, processName: 'explorer.exe', processPath: 'C:/Windows/explorer.exe' },
  getDefaultSystemSafelistRules(),
  true,
);
assert.equal(explorerSafelist?.id, 'system-explorer');

assert.deepEqual(
  normalizeUserSafelistRules([{ name: 'empty', processPatterns: [], titlePatterns: [] }]),
  [],
);

const runtimeEvents = [];
const runtime = new GuardianRuntime({
  send: (message) => runtimeEvents.push(message),
  logger: console,
});
const violationContext = {
  timestamp: new Date().toISOString(),
  source: 'windows',
  title: 'Distraction Window',
  windowId: 201,
  processId: 9,
  processName: 'DistractionApp',
  processPath: 'C:/Apps/DistractionApp.exe',
  confidence: 0.7,
};
const postContext = {
  timestamp: new Date().toISOString(),
  source: 'windows',
  title: 'Visual Studio Code',
  windowId: 101,
  processId: 1,
  processName: 'Code',
  processPath: 'C:/Program Files/Microsoft VS Code/Code.exe',
  confidence: 0.7,
};
let captureCount = 0;
runtime.windows = {
  captureSystemContext() {
    captureCount += 1;
    return captureCount === 1 ? violationContext : postContext;
  },
  minimizeWindow(windowId) {
    return { windowId, dispatched: true };
  },
  restoreWindow() {
    return true;
  },
};
runtime.state = {
  ...createInitialSessionState(),
  status: 'running',
  preciseItems: [preciseFromContext(postContext)],
  fuzzyPhrases: [],
};
await runtime.monitorTick();
assert.equal(runtime.state.currentContext.windowId, postContext.windowId);
assert.equal(runtime.state.violations.length, 1);
assert.equal(runtime.state.violations[0].minimizedVia, 'local');
assert.equal('outcome' in runtime.state.violations[0], false);
assert.equal('restoredAllowedWindow' in runtime.state.violations[0], false);
assert.equal('suppressedBySystemSafelist' in runtime.state.violations[0], false);
assert.equal(typeof runtime.state.violations[0].windowId, 'number');
assert.equal(typeof runtime.state.violations[0].reason, 'string');
await runtime.monitorTick();
assert.equal(runtime.state.violations.length, 1);

function createGateRuntime(adminInterceptActive) {
  const gate = new GuardianRuntime({ send: () => {}, logger: console });
  gate.minimizer = { isReady: () => true, minimize: async (windowId) => ({ windowId, dispatched: true }) };
  let captureIndex = 0;
  gate.windows = {
    captureSystemContext() {
      captureIndex += 1;
      return captureIndex === 1 ? violationContext : postContext;
    },
    minimizeWindow(windowId) {
      return { windowId, dispatched: true };
    },
    restoreWindow() {
      return true;
    },
  };
  gate.state = {
    ...createInitialSessionState(),
    status: 'running',
    preciseItems: [preciseFromContext(postContext)],
    fuzzyPhrases: [],
  };
  gate.adminInterceptActive = adminInterceptActive;
  return gate;
}

const localGateRuntime = createGateRuntime(false);
await localGateRuntime.monitorTick();
assert.equal(localGateRuntime.state.violations.length, 1);
assert.equal(localGateRuntime.state.violations[0].minimizedVia, 'local');

const helperGateRuntime = createGateRuntime(true);
await helperGateRuntime.monitorTick();
assert.equal(helperGateRuntime.state.violations.length, 1);
assert.equal(helperGateRuntime.state.violations[0].minimizedVia, 'helper');

const countupRuntime = new GuardianRuntime({
  send: () => {},
  logger: console,
});
countupRuntime.windows = {
  captureSystemContext() {
    return postContext;
  },
  minimizeWindow() {
    return { windowId: postContext.windowId, dispatched: true };
  },
  restoreWindow() {
    return true;
  },
};
const countupState = await countupRuntime.startSession({
  sessionMode: 'countup',
  preciseItems: [preciseFromContext(postContext)],
  fuzzyPhrases: [],
});
assert.equal(countupState.sessionMode, 'countup');
assert.equal(countupState.durationMinutes, 0);
assert.equal(countupState.endsAt, null);
const endedCountup = await countupRuntime.endSession('cancelled');
assert.equal(endedCountup.summary.sessionMode, 'countup');
assert.equal(endedCountup.summary.plannedDurationMinutes, null);

const tempRoot = await fs.mkdtemp(path.join(process.cwd(), 'tmp-forest-history-'));
const logDir = path.join(tempRoot, 'logs');
const historyDir = path.join(tempRoot, 'history');
await fs.mkdir(logDir, { recursive: true });
await fs.writeFile(
  path.join(logDir, 'forest-2026-03-18.jsonl'),
  `${JSON.stringify({ kind: 'session-ended', payload: {
    startedAt: '2026-03-18T01:00:00.000Z',
    endedAt: '2026-03-18T01:25:00.000Z',
    durationMinutes: 25,
    actualDurationMinutes: 12,
    plannedDurationMinutes: 25,
    violationCount: 2,
    violations: [],
    preciseItems: [{ id: 'p1', type: 'window', label: 'Visual Studio Code' }],
    fuzzyPhrases: [{ id: 'f1', text: 'ChatGPT', setName: 'AI' }],
    primaryPrecise: { id: 'p1', label: 'Visual Studio Code' },
    primaryFuzzy: { id: 'f1', text: 'ChatGPT', setName: 'AI' },
    completionReason: 'completed',
  } })}\n`,
  'utf8',
);
const historyResult = await regenerateHistoryMarkdown({ logDir, historyDir, dateKey: '2026-03-18' });
const markdown = await fs.readFile(historyResult.historyFile, 'utf8');
assert.equal(markdown.includes('## 当日摘要'), true);
assert.equal(markdown.includes('## '), true);
assert.equal(markdown.includes('Visual Studio Code'), true);
assert.equal(markdown.includes('实际时长：12 分钟'), true);
assert.equal(markdown.includes('计划时长：25 分钟'), true);
assert.equal(markdown.includes('模式：倒计时'), true);
assert.equal(markdown.includes('模糊短语'), true);
assert.equal(markdown.includes('允许域名'), false);

const preloadSource = await fs.readFile(new URL('../app/preload.cjs', import.meta.url), 'utf8');
const allChannels = [
  ...Object.values(IPC_CHANNELS.invoke),
  ...Object.values(IPC_CHANNELS.push),
];
const missingChannels = allChannels.filter((channel) => !preloadSource.includes(channel));
assert.deepEqual(missingChannels, []);

console.log('smoke 通过');
