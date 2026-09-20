export const IPC_CHANNELS = {
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

export const HELPER_ACTIONS = {
  minimize: 'minimize',
  restore: 'restore',
  ping: 'ping',
  shutdown: 'shutdown',
};

export const HELPER_MESSAGES = {
  ready: 'ready',
};

export const GUARDIAN_REQUESTS = {
  bootstrap: 'bootstrap',
  getState: 'get-state',
  resetSession: 'reset-session',
  updatePreferences: 'update-preferences',
  getCurrentContext: 'get-current-context',
  getCandidateWindow: 'get-candidate-window',
  listOpenWindows: 'list-open-windows',
  startSession: 'start-session',
  endSession: 'end-session',
};

export const GUARDIAN_MESSAGES = {
  response: 'response',
  state: 'state',
  violation: 'violation',
  ready: 'ready',
};
