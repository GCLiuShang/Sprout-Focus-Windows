import fs from 'node:fs/promises';
import path from 'node:path';
import { regenerateHistoryMarkdown, toLocalDateKey } from './history.js';
import {
  createEmptyActiveContext,
  createInitialSessionState,
  getDefaultSystemSafelistRules,
} from '../shared/models.js';
import { decideContext, isOwnAppContext } from './rules.js';
import { isSystemPath } from '../shared/rules-core.js';
import { WindowsService } from './windows-service.js';

const MONITOR_INTERVAL_MS = 350;
const CLOCK_INTERVAL_MS = 250;
const DUPLICATE_VIOLATION_WINDOW_MS = 8000;

export class GuardianRuntime {
  constructor({ send, logger = console, minimizer = null }) {
    this.send = send;
    this.logger = logger;
    this.minimizer = minimizer;
    this.windows = new WindowsService();
    this.state = createInitialSessionState();
    this.monitorTimer = null;
    this.clockTimer = null;
    this.lastExternalContext = null;
    this.contextTrackingTimer = null;
    this.logDir = null;
    this.historyDir = null;
    this.preferences = {
      autoWriteHistory: true,
      systemSafelistEnabled: true,
      systemSafelistRules: getDefaultSystemSafelistRules(),
      userSafelistRules: [],
    };
    this.lastViolation = { signature: '', at: 0 };
    this.adminInterceptActive = false;
    this.matchStats = {
      preciseHits: {},
      fuzzyHits: {},
    };
  }

  async bootstrap({ logDir, historyDir, preferences } = {}) {
    this.logDir = logDir || null;
    this.historyDir = historyDir || null;
    this.preferences = {
      ...this.preferences,
      ...(preferences || {}),
    };
    if (this.logDir) {
      await fs.mkdir(this.logDir, { recursive: true });
    }
    if (this.historyDir) {
      await fs.mkdir(this.historyDir, { recursive: true });
    }

    this.state.systemSafelistEnabled = this.preferences.systemSafelistEnabled !== false;
    await this.resolveCurrentContext();
    this.startContextTracking();
    this.send({ type: 'ready', payload: { ok: true } });
    return { ok: true };
  }

  async handle(request) {
    switch (request.type) {
      case 'bootstrap':
        return this.bootstrap(request.payload);
      case 'get-state':
        return this.getState();
      case 'reset-session':
        return this.resetSession();
      case 'update-preferences':
        return this.updatePreferences(request.payload);
      case 'get-current-context':
        return this.resolveCurrentContext();
      case 'get-candidate-window':
        return this.getCandidateWindow();
      case 'list-open-windows':
        return this.listOpenWindows();
      case 'start-session':
        return this.startSession(request.payload);
      case 'end-session':
        return this.endSession(request.payload?.reason ?? 'cancelled');
      default:
        throw new Error(`未知 guardian 请求：${request.type}`);
    }
  }

  getState() {
    return structuredClone(this.state);
  }

  async updatePreferences(payload = {}) {
    this.preferences = {
      ...this.preferences,
      ...(payload.preferences || payload || {}),
    };
    if (payload.historyDir) {
      this.historyDir = payload.historyDir;
      await fs.mkdir(this.historyDir, { recursive: true });
    }

    this.state.systemSafelistEnabled = this.preferences.systemSafelistEnabled !== false;
    this.sendState();
    return {
      ok: true,
      preferences: structuredClone(this.preferences),
      historyDir: this.historyDir,
    };
  }

  getCandidateWindow() {
    const context = this.lastExternalContext?.windowId
      ? structuredClone(this.lastExternalContext)
      : this.captureForegroundContext();
    return { context, isOwnApp: isOwnAppContext(context) };
  }

  listOpenWindows() {
    return this.windows.listWindows().map((entry) => ({
      ...entry,
      isSystem: isSystemPath(entry.processPath),
    }));
  }

  startContextTracking() {
    if (this.contextTrackingTimer) {
      return;
    }

    this.contextTrackingTimer = setInterval(() => {
      try {
        const ctx = this.windows.captureSystemContext();
        if (ctx?.windowId && !isOwnAppContext(ctx)) {
          this.lastExternalContext = ctx;
        }
      } catch (error) {
        this.logger.error(error);
      }
    }, 1000);
  }

  async resolveCurrentContext() {
    const context = this.captureForegroundContext();
    this.state.currentContext = context;
    this.sendState();
    return this.state.currentContext;
  }

  captureForegroundContext() {
    return this.windows.captureSystemContext() || createEmptyActiveContext();
  }

  async startSession(payload) {
    if (this.state.status === 'running') {
      throw new Error('已有专注会话在运行');
    }

    const sessionMode = payload?.sessionMode === 'countup' ? 'countup' : 'countdown';
    const durationMinutes = sessionMode === 'countdown'
      ? Number(payload?.durationMinutes || 25)
      : 0;
    const preciseItems = Array.isArray(payload?.preciseItems) ? payload.preciseItems : [];
    const fuzzyPhrases = Array.isArray(payload?.fuzzyPhrases) ? payload.fuzzyPhrases : [];
    if (!preciseItems.length && !fuzzyPhrases.length) {
      throw new Error('至少需要一个精准条目或模糊短语');
    }

    this.adminInterceptActive = payload?.useAdminIntercept === true;
    const now = Date.now();
    const endsAt = sessionMode === 'countdown' ? now + durationMinutes * 60_000 : null;
    const currentContext = await this.resolveCurrentContext();
    this.state = {
      ...createInitialSessionState(),
      status: 'running',
      sessionMode,
      startedAt: new Date(now).toISOString(),
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      durationMinutes,
      remainingMs: sessionMode === 'countdown' ? endsAt - now : 0,
      elapsedMs: 0,
      preciseItems,
      fuzzyPhrases,
      currentContext,
      recentPreciseItem: preciseItems[0] ?? null,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
      exitProtection: payload?.exitProtection ?? { type: 'hold', holdToExitMs: 3000 },
    };
    this.matchStats = {
      preciseHits: {},
      fuzzyHits: {},
    };

    await this.writeLog('session-started', {
      sessionMode,
      durationMinutes,
      preciseItems,
      fuzzyPhrases,
    });

    this.startLoops();
    this.sendState();
    return this.getState();
  }

  async endSession(reason = 'cancelled') {
    if (this.state.status !== 'running') {
      return this.getState();
    }

    this.stopLoops();
    this.adminInterceptActive = false;
    const endedAt = new Date().toISOString();
    const actualDurationMinutes = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(this.state.startedAt)) / 60_000));
    const primaryPrecise = this.derivePrimaryPrecise();
    const primaryFuzzy = this.derivePrimaryFuzzy();
    const summary = {
      sessionMode: this.state.sessionMode,
      startedAt: this.state.startedAt,
      endedAt,
      durationMinutes: actualDurationMinutes,
      actualDurationMinutes,
      plannedDurationMinutes: this.state.sessionMode === 'countdown' ? this.state.durationMinutes : null,
      violationCount: this.state.violationCount,
      violations: this.state.violations,
      preciseItems: this.state.preciseItems,
      fuzzyPhrases: this.state.fuzzyPhrases,
      primaryPrecise,
      primaryFuzzy,
      completionReason: reason,
    };

    this.state = {
      ...this.state,
      status: reason === 'completed' ? 'completed' : 'cancelled',
      remainingMs: 0,
      endsAt: endedAt,
      summary,
    };

    await this.writeLog('session-ended', summary);
    await this.writeHistory(summary);
    this.sendState();
    return this.getState();
  }

  async resetSession() {
    this.stopLoops();
    this.adminInterceptActive = false;
    this.state = {
      ...createInitialSessionState(),
      currentContext: this.state.currentContext,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
    };
    this.matchStats = {
      preciseHits: {},
      fuzzyHits: {},
    };
    this.sendState();
    return this.getState();
  }

  startLoops() {
    this.stopLoops();
    this.monitorTimer = setInterval(() => {
      this.monitorTick().catch((error) => {
        this.logger.error(error);
      });
    }, MONITOR_INTERVAL_MS);

    this.clockTimer = setInterval(() => {
      if (this.state.sessionMode === 'countup') {
        this.state.elapsedMs = Math.max(0, Date.now() - Date.parse(this.state.startedAt));
        this.sendState();
        return;
      }

      const remainingMs = Math.max(0, Date.parse(this.state.endsAt) - Date.now());
      this.state.remainingMs = remainingMs;
      if (remainingMs === 0 && this.state.status === 'running') {
        this.endSession('completed').catch((error) => this.logger.error(error));
      } else {
        this.sendState();
      }
    }, CLOCK_INTERVAL_MS);
  }

  stopLoops() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  shutdown() {
    this.stopLoops();
    if (this.contextTrackingTimer) {
      clearInterval(this.contextTrackingTimer);
      this.contextTrackingTimer = null;
    }
  }

  async monitorTick() {
    if (this.state.status !== 'running') {
      return;
    }

    const context = this.captureForegroundContext();
    this.state.currentContext = context;

    const decision = decideContext({
      context,
      preciseItems: this.state.preciseItems,
      fuzzyPhrases: this.state.fuzzyPhrases,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
      systemSafelistRules: this.preferences.systemSafelistRules || getDefaultSystemSafelistRules(),
      userSafelistRules: this.preferences.userSafelistRules || [],
    });

    if (decision.allowed) {
      if (decision.matchedPrecise) {
        this.state.recentPreciseItem = decision.matchedPrecise;
        this.trackMatch('preciseHits', decision.matchedPrecise.id);
      }

      if (decision.matchedFuzzy) {
        this.trackMatch('fuzzyHits', decision.matchedFuzzy.id);
      }

      this.sendState();
      return;
    }

    const signature = `${context.windowId}:${context.processPath || context.processName}:${decision.reason}`;
    const now = Date.now();
    const minimizeAttempted = Boolean(context.windowId);
    let minimizeResult;
    let minimizedVia;
    if (!minimizeAttempted) {
      minimizeResult = { windowId: context.windowId ?? null, dispatched: false, error: 'no-window' };
      minimizedVia = 'none';
    } else if (this.adminInterceptActive && this.minimizer?.isReady?.()) {
      minimizeResult = await this.minimizer.minimize(context.windowId);
      minimizedVia = 'helper';
      const recoverable = ['helper-not-ready', 'helper-timeout', 'helper-disconnected', 'helper-failed'];
      if (!minimizeResult?.dispatched && recoverable.includes(minimizeResult?.error)) {
        minimizeResult = this.windows.minimizeWindow(context.windowId);
        minimizedVia = 'local';
      }
    } else {
      minimizeResult = this.windows.minimizeWindow(context.windowId);
      minimizedVia = 'local';
    }
    const postContext = this.captureForegroundContext();
    this.state.currentContext = postContext;

    const stillForeground = Boolean(postContext?.windowId && postContext.windowId === context.windowId);

    const isDuplicate = signature === this.lastViolation.signature
      && now - this.lastViolation.at < DUPLICATE_VIOLATION_WINDOW_MS;

    this.lastViolation = stillForeground ? { signature, at: now } : { signature: '', at: 0 };

    if (isDuplicate) {
      this.sendState();
      return;
    }

    const violation = {
      id: `violation-${now}`,
      timestamp: new Date(now).toISOString(),
      title: context.title,
      processName: context.processName,
      processPath: context.processPath,
      windowId: context.windowId,
      reason: decision.reason,
      minimizedVia,
    };

    this.state.violationCount += 1;
    this.state.violations = [...this.state.violations, violation];
    await this.writeLog('violation', violation);

    this.send({
      type: 'violation',
      payload: violation,
    });
    this.sendState();
  }

  sendState() {
    this.send({
      type: 'state',
      payload: this.getState(),
    });
  }

  async writeLog(kind, payload) {
    if (!this.logDir) {
      return;
    }

    const file = path.join(this.logDir, `forest-${toLocalDateKey()}.jsonl`);
    const row = JSON.stringify({
      kind,
      timestamp: new Date().toISOString(),
      payload,
    });
    await fs.appendFile(file, `${row}\n`, 'utf8');
  }

  trackMatch(bucket, key) {
    if (!key) {
      return;
    }

    this.matchStats[bucket][key] = (this.matchStats[bucket][key] || 0) + 1;
  }

  derivePrimaryPrecise() {
    if (this.state.preciseItems.length > 0) {
      return this.state.preciseItems[0];
    }

    const [primaryId] = Object.entries(this.matchStats.preciseHits).sort((left, right) => right[1] - left[1])[0] || [];
    return this.state.preciseItems.find((item) => item.id === primaryId) || this.state.recentPreciseItem || null;
  }

  derivePrimaryFuzzy() {
    const [primaryId] = Object.entries(this.matchStats.fuzzyHits).sort((left, right) => right[1] - left[1])[0] || [];
    if (primaryId) {
      return this.state.fuzzyPhrases.find((item) => item.id === primaryId) || null;
    }

    if (this.state.fuzzyPhrases.length === 1) {
      return this.state.fuzzyPhrases[0];
    }

    return null;
  }

  async writeHistory(summary) {
    if (!this.preferences.autoWriteHistory || !this.historyDir || !this.logDir) {
      return;
    }

    const dateKey = toLocalDateKey(summary.endedAt || new Date());
    await regenerateHistoryMarkdown({
      logDir: this.logDir,
      historyDir: this.historyDir,
      dateKey,
    });
  }
}

export default GuardianRuntime;
