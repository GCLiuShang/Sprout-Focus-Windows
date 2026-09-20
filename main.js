import fs from 'node:fs/promises';
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS, GUARDIAN_MESSAGES, GUARDIAN_REQUESTS } from './shared/ipc.js';
import { createInitialSessionState, formatRemaining, getDefaultSystemSafelistRules, normalizeUserSafelistRules } from './shared/models.js';
import { HelperBridge } from './guardian/helper-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readArgValue(prefix) {
  const match = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return match ? match.slice(prefix.length + 1) : '';
}

async function createFileLogger(dir, fileName) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const write = (level, parts) => {
    const text = parts
      .map((part) => {
        if (part instanceof Error) return part.stack || part.message;
        if (part && typeof part === 'object') {
          try {
            return JSON.stringify(part);
          } catch {
            return String(part);
          }
        }
        return String(part);
      })
      .join(' ');
    fs.appendFile(file, `[${new Date().toISOString()}] ${level} ${text}\n`, 'utf8').catch(() => {});
  };
  return {
    info: (...parts) => write('INFO', parts),
    error: (...parts) => write('ERROR', parts),
    log: (...parts) => write('LOG', parts),
  };
}

const isHelperMode = process.argv.includes('--guardian-helper');
const helperPipeName = readArgValue('--helper-pipe');
const helperTokenFile = readArgValue('--helper-token-file');

const localAppDataRoot = app.isPackaged ? 'Sprout' : 'Sprout-dev';
const localAppDataDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, localAppDataRoot)
  : path.join(__dirname, '.sprout-local');
const activeDataDir = isHelperMode ? path.join(localAppDataDir, 'helper') : localAppDataDir;
const userDataDirOverride = path.join(activeDataDir, 'user-data');
const sessionDataDirOverride = path.join(activeDataDir, 'session-data');
const diskCacheDirOverride = path.join(activeDataDir, 'cache');

app.setPath('userData', userDataDirOverride);
app.setPath('sessionData', sessionDataDirOverride);
app.commandLine.appendSwitch('disk-cache-dir', diskCacheDirOverride);

if (isHelperMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

function mergeSafelistRules(defaults, stored) {
  if (!Array.isArray(stored) || !stored.length) {
    return defaults;
  }

  const storedById = new Map(stored.filter((rule) => rule && typeof rule === 'object').map((rule) => [rule.id, rule]));
  const merged = defaults.map((rule) => storedById.get(rule.id) || rule);
  const defaultIds = new Set(defaults.map((rule) => rule.id));
  stored.forEach((rule) => {
    if (rule && typeof rule === 'object' && !defaultIds.has(rule.id)) {
      merged.push(rule);
    }
  });
  return merged;
}

class SettingsStore {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'settings.json');
    this.settings = null;
  }

  getDefaults() {
    return {
      historyDir: path.join(app.getPath('documents'), 'Sprout', 'history'),
      autoWriteHistory: true,
      systemSafelistEnabled: true,
      exitDifficulty: 'easy',
      openAtLogin: false,
      silentStart: false,
      systemSafelistRules: getDefaultSystemSafelistRules(),
      userSafelistRules: [],
      adminIntercept: 'off',
      adminInterceptPrompt: true,
    };
  }

  normalizeSettings(input = {}) {
    const defaults = this.getDefaults();
    const exitDifficulty = ['easy', 'medium', 'hard'].includes(input?.exitDifficulty)
      ? input.exitDifficulty
      : defaults.exitDifficulty;
    return {
      historyDir: String(input?.historyDir || '').trim() || defaults.historyDir,
      openAtLogin: !!input?.openAtLogin,
      silentStart: !!input?.silentStart,
      autoWriteHistory: input?.autoWriteHistory !== false,
      systemSafelistEnabled: input?.systemSafelistEnabled !== false,
      exitDifficulty,
      systemSafelistRules: mergeSafelistRules(defaults.systemSafelistRules, input?.systemSafelistRules),
      userSafelistRules: normalizeUserSafelistRules(input?.userSafelistRules),
      adminIntercept: ['on', 'off'].includes(input?.adminIntercept) ? input.adminIntercept : 'off',
      adminInterceptPrompt: input?.adminInterceptPrompt !== undefined
        ? input.adminInterceptPrompt !== false
        : input?.adminInterceptPinned !== true,
    };
  }

  async load() {
    if (this.settings) {
      return this.settings;
    }

    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const stored = JSON.parse(raw);
      this.settings = this.normalizeSettings(stored);
      if (JSON.stringify(this.settings) !== JSON.stringify(stored)) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('读取设置失败', error);
      }
      this.settings = this.normalizeSettings();
      await this.save(this.settings);
    }

    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: this.settings.openAtLogin,
        args: this.settings.silentStart ? ['--hidden'] : [],
      });
    }

    await fs.mkdir(this.settings.historyDir, { recursive: true });
    return this.settings;
  }

  async save(patch = {}) {
    const current = await this.load();
    this.settings = this.normalizeSettings({
      ...current,
      ...patch,
    });
    
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: this.settings.openAtLogin,
        args: this.settings.silentStart ? ['--hidden'] : [],
      });
    }
    
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
    await fs.mkdir(this.settings.historyDir, { recursive: true });
    return this.settings;
  }
}

class GuardianBridge {
  constructor() {
    this.runtime = null;
    this.started = false;
    this.startPromise = null;
    this.bootstrapPayload = null;
    this.onPush = null;
    this.minimizer = null;
    this.state = createInitialSessionState();
  }

  setMinimizer(minimizer) {
    this.minimizer = minimizer;
  }

  async start(bootstrapPayload, onPush) {
    this.bootstrapPayload = bootstrapPayload || this.bootstrapPayload;
    this.onPush = onPush || this.onPush;
    return this.#ensureStarted();
  }

  async request(type, payload = {}) {
    await this.#ensureStarted();
    return this.runtime.handle({ type, payload });
  }

  stop() {
    if (this.runtime) {
      this.runtime.shutdown();
    }
    this.started = false;
    this.startPromise = null;
  }

  async #ensureStarted() {
    if (this.started) {
      return { ok: true };
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.bootstrapPayload) {
      throw new Error('guardian 尚未配置启动参数');
    }

    if (!this.runtime) {
      const { GuardianRuntime } = await import('./guardian/runtime.js');
      this.runtime = new GuardianRuntime({
        send: (message) => this.#handleMessage(message),
        logger: console,
        minimizer: this.minimizer,
      });
    }

    this.startPromise = this.runtime.handle({
      type: GUARDIAN_REQUESTS.bootstrap,
      payload: this.bootstrapPayload,
    }).then((result) => {
      this.started = true;
      return result;
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  #handleMessage(message) {
    if (message.type === GUARDIAN_MESSAGES.state) {
      this.state = message.payload;
      this.onPush?.('state', message.payload);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.violation) {
      this.onPush?.('violation', message.payload);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.ready) {
      this.onPush?.('state', this.state);
    }
  }
}

let mainWindow = null;
let tray = null;
let forceQuit = false;
const guardian = new GuardianBridge();
let helperBridge = null;
let settingsStore = null;
let appSettings = null;
let lastSessionStatus = 'idle';

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }

  refreshTrayMenu();
}

function createWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 980,
    minHeight: 700,
    title: 'Sprout',
    icon: path.join(__dirname, 'app', 'icon.ico'),
    backgroundColor: '#0f172a',
    show: !startHidden,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

  mainWindow.on('close', (event) => {
    if (forceQuit) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });
}

function ensureWindowVisible() {
  if (!mainWindow) {
    createWindow();
  }

  mainWindow.show();
  mainWindow.focus();
}

function notifySessionCompleted(state) {
  const durationMinutes = Number(state?.summary?.actualDurationMinutes ?? state?.summary?.durationMinutes ?? 0);
  const body = durationMinutes > 0
    ? `本轮专注已完成，共 ${durationMinutes} 分钟。`
    : '本轮专注已完成。';

  shell.beep();
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: 'Sprout',
    body,
    silent: false,
  });
  notification.on('click', () => ensureWindowVisible());
  notification.show();
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  const state = guardian.state || createInitialSessionState();
  const contextLabel = state.currentContext?.title || state.currentContext?.processName || '等待前台窗口';
  const statusLabel = state.status === 'running' ? `专注中 ${formatRemaining(state.remainingMs)}` : 'Sprout';
  const menu = Menu.buildFromTemplate([
    {
      label: `${statusLabel} · ${contextLabel}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开主界面',
      click: () => ensureWindowVisible(),
    },
    {
      label: '尝试退出会话',
      click: () => ensureWindowVisible(),
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        if (guardian.state?.status === 'running') {
          const options = {
            type: 'warning',
            buttons: ['取消', '仍要退出'],
            defaultId: 0,
            cancelId: 0,
            message: '当前正在专注中，确定要退出 Sprout 吗？',
          };
          const choice = mainWindow && !mainWindow.isDestroyed()
            ? dialog.showMessageBoxSync(mainWindow, options)
            : dialog.showMessageBoxSync(options);
          if (choice !== 1) {
            return;
          }
        }
        forceQuit = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(state.status === 'running' ? `Sprout ${formatRemaining(state.remainingMs)}` : 'Sprout');
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'app', 'icon.ico'));
  if (image.isEmpty()) {
    console.warn('未找到 app/icon.ico（可运行 npm run build:icon 生成），跳过托盘图标。');
    return;
  }

  tray = new Tray(image);
  tray.on('click', () => ensureWindowVisible());
  refreshTrayMenu();
}

if (isHelperMode) {
  app.whenReady().then(async () => {
    const logger = await createFileLogger(activeDataDir, 'helper.log');
    logger.info('helper process start', {
      pid: process.pid,
      pipe: helperPipeName || '(missing)',
      hasToken: Boolean(helperTokenFile),
      argv: process.argv,
    });

    process.on('uncaughtException', (error) => {
      logger.error('uncaughtException', error);
      app.quit();
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandledRejection', reason);
    });

    try {
      const { startHelper } = await import('./guardian/helper.js');
      startHelper({
        pipeName: helperPipeName,
        tokenFile: helperTokenFile,
        logger,
        onFatal: (reason) => {
          logger.error('helper fatal', reason);
          app.quit();
        },
      });
      logger.info('helper started');
    } catch (error) {
      logger.error('helper import failed', error);
      app.quit();
    }
  });
  app.on('window-all-closed', (event) => event.preventDefault());
} else {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', (event, commandLine) => {
      ensureWindowVisible();
    });

    app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  settingsStore = new SettingsStore(userDataDir);
  appSettings = await settingsStore.load();
  const logDir = path.join(userDataDir, 'logs');
  const guardianBootstrap = {
    logDir,
    historyDir: appSettings.historyDir,
    preferences: {
      autoWriteHistory: appSettings.autoWriteHistory,
      systemSafelistEnabled: appSettings.systemSafelistEnabled,
      systemSafelistRules: appSettings.systemSafelistRules,
      userSafelistRules: appSettings.userSafelistRules,
    },
  };
  const onGuardianPush = (kind, payload) => {
    if (kind === 'state') {
      const previousStatus = lastSessionStatus;
      lastSessionStatus = payload?.status || 'idle';
      broadcast(IPC_CHANNELS.push.state, payload);
      if (previousStatus === 'running' && payload?.status === 'completed') {
        notifySessionCompleted(payload);
      }
    } else if (kind === 'violation') {
      broadcast(IPC_CHANNELS.push.violation, payload);
    }
  };

  helperBridge = new HelperBridge({
    exePath: process.execPath,
    appArgs: app.isPackaged ? [] : [app.getAppPath()],
    tokenFile: path.join(userDataDir, 'helper-token'),
    logger: console,
    onStatus: (status) => broadcast(IPC_CHANNELS.push.helperStatus, { status }),
  });
  guardian.setMinimizer(helperBridge);

  ipcMain.handle(IPC_CHANNELS.invoke.getState, async () => guardian.request(GUARDIAN_REQUESTS.getState));
  ipcMain.handle(IPC_CHANNELS.invoke.getSettings, async () => settingsStore.load());
  ipcMain.handle(IPC_CHANNELS.invoke.saveSettings, async (_event, patch) => {
    appSettings = await settingsStore.save(patch);
    await guardian.request(GUARDIAN_REQUESTS.updatePreferences, {
      preferences: {
        autoWriteHistory: appSettings.autoWriteHistory,
        systemSafelistEnabled: appSettings.systemSafelistEnabled,
        systemSafelistRules: appSettings.systemSafelistRules,
        userSafelistRules: appSettings.userSafelistRules,
      },
      historyDir: appSettings.historyDir,
    });
    return appSettings;
  });
  ipcMain.handle(IPC_CHANNELS.invoke.listHistoryFiles, async () => {
    const settings = await settingsStore.load();
    await fs.mkdir(settings.historyDir, { recursive: true });
    const entries = await fs.readdir(settings.historyDir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const fullPath = path.join(settings.historyDir, entry.name);
        const stat = await fs.stat(fullPath);
        return {
          fileName: entry.name,
          fullPath,
          modifiedAt: stat.mtime.toISOString(),
        };
      }));
    return files.sort((left, right) => right.fileName.localeCompare(left.fileName));
  });
  ipcMain.handle(IPC_CHANNELS.invoke.readHistoryFile, async (_event, fileName) => {
    const settings = await settingsStore.load();
    const safeName = path.basename(fileName || '');
    const fullPath = path.join(settings.historyDir, safeName);
    const content = await fs.readFile(fullPath, 'utf8');
    return { fileName: safeName, fullPath, content };
  });
  ipcMain.handle(IPC_CHANNELS.invoke.openHistoryFile, async (_event, fileName) => {
    const settings = await settingsStore.load();
    const safeName = path.basename(fileName || '');
    const fullPath = path.join(settings.historyDir, safeName);
    return shell.openPath(fullPath);
  });
  ipcMain.handle(IPC_CHANNELS.invoke.openHistoryDirectory, async () => {
    const settings = await settingsStore.load();
    await fs.mkdir(settings.historyDir, { recursive: true });
    return shell.openPath(settings.historyDir);
  });
  ipcMain.handle(IPC_CHANNELS.invoke.resetSession, async () => guardian.request(GUARDIAN_REQUESTS.resetSession));
  ipcMain.handle(IPC_CHANNELS.invoke.getCurrentContext, async () => guardian.request(GUARDIAN_REQUESTS.getCurrentContext));
  ipcMain.handle(IPC_CHANNELS.invoke.getCandidateWindow, async () => guardian.request(GUARDIAN_REQUESTS.getCandidateWindow));
  ipcMain.handle(IPC_CHANNELS.invoke.listOpenWindows, async () => guardian.request(GUARDIAN_REQUESTS.listOpenWindows));
  ipcMain.handle(IPC_CHANNELS.invoke.getHelperStatus, async () => ({ status: helperBridge.status }));
  ipcMain.handle(IPC_CHANNELS.invoke.startHelper, async () => {
    const result = await helperBridge.ensureStarted();
    return { status: helperBridge.status, ...result };
  });
  ipcMain.handle(IPC_CHANNELS.invoke.stopHelper, async () => {
    await helperBridge.stop();
    return { status: helperBridge.status };
  });
  ipcMain.handle(IPC_CHANNELS.invoke.startSession, async (_event, payload) => {
    if (guardian.state?.status === 'running') {
      return guardian.request(GUARDIAN_REQUESTS.getState);
    }
    return guardian.request(GUARDIAN_REQUESTS.startSession, payload);
  });
  ipcMain.handle(IPC_CHANNELS.invoke.endSession, async (_event, payload) => guardian.request(GUARDIAN_REQUESTS.endSession, payload));

  const shouldStartHidden = app.isPackaged && !!appSettings.silentStart && process.argv.includes('--hidden');
  createWindow(shouldStartHidden);
  createTray();

  await guardian.start(guardianBootstrap, onGuardianPush).catch((error) => {
    console.error('guardian 启动失败', error);
    if (Notification.isSupported()) {
      new Notification({ title: 'Sprout', body: '后台守卫启动失败，请查看日志。' }).show();
    }
  });
});

    app.on('window-all-closed', (event) => {
      if (!forceQuit) {
        event.preventDefault();
      }
    });

    app.on('before-quit', () => {
      forceQuit = true;
      helperBridge?.stop();
      guardian.stop();
    });
  }
}
