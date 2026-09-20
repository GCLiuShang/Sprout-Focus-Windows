const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = {
  invoke: {
    getState: 'forest:get-state',
    getSettings: 'forest:get-settings',
    saveSettings: 'forest:save-settings',
    listHistoryFiles: 'forest:list-history-files',
    readHistoryFile: 'forest:read-history-file',
    openHistoryFile: 'forest:open-history-file',
    openHistoryDirectory: 'forest:open-history-directory',
    resetSession: 'forest:reset-session',
    getCurrentContext: 'forest:get-current-context',
    getCandidateWindow: 'forest:get-candidate-window',
    listOpenWindows: 'forest:list-open-windows',
    getHelperStatus: 'forest:get-helper-status',
    startHelper: 'forest:start-helper',
    stopHelper: 'forest:stop-helper',
    startSession: 'forest:start-session',
    endSession: 'forest:end-session',
  },
  push: {
    state: 'forest:state',
    violation: 'forest:violation',
    helperStatus: 'forest:helper-status',
  },
};

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('forestApi', {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getState),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getSettings),
  saveSettings: (payload) => ipcRenderer.invoke(IPC_CHANNELS.invoke.saveSettings, payload),
  listHistoryFiles: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.listHistoryFiles),
  readHistoryFile: (fileName) => ipcRenderer.invoke(IPC_CHANNELS.invoke.readHistoryFile, fileName),
  openHistoryFile: (fileName) => ipcRenderer.invoke(IPC_CHANNELS.invoke.openHistoryFile, fileName),
  openHistoryDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.openHistoryDirectory),
  resetSession: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.resetSession),
  getCurrentContext: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getCurrentContext),
  getCandidateWindow: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getCandidateWindow),
  listOpenWindows: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.listOpenWindows),
  getHelperStatus: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getHelperStatus),
  startHelper: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.startHelper),
  stopHelper: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.stopHelper),
  startSession: (payload) => ipcRenderer.invoke(IPC_CHANNELS.invoke.startSession, payload),
  endSession: (payload) => ipcRenderer.invoke(IPC_CHANNELS.invoke.endSession, payload),
  subscribeState: (listener) => subscribe(IPC_CHANNELS.push.state, listener),
  subscribeViolation: (listener) => subscribe(IPC_CHANNELS.push.violation, listener),
  subscribeHelperStatus: (listener) => subscribe(IPC_CHANNELS.push.helperStatus, listener),
});
