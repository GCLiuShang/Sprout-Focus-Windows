import fs from 'node:fs';
import net from 'node:net';
import windowManagerPackage from 'node-window-manager';
import { HELPER_ACTIONS, HELPER_MESSAGES } from '../shared/ipc.js';

const { windowManager } = windowManagerPackage;

function readTokenFromFile(tokenFile) {
  if (!tokenFile) {
    return '';
  }
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function findWindow(windowId) {
  if (windowId == null) {
    return null;
  }
  return windowManager.getWindows().find((candidate) => candidate.id === windowId && candidate.isWindow()) || null;
}

function minimizeWindow(windowId) {
  const win = findWindow(windowId);
  if (!win) {
    return { dispatched: false, error: 'window-not-found' };
  }

  try {
    win.minimize();
    return { dispatched: true };
  } catch (error) {
    return { dispatched: false, error: error?.message || 'minimize-failed' };
  }
}

function restoreWindow(windowId) {
  const win = findWindow(windowId);
  if (!win) {
    return { dispatched: false, error: 'window-not-found' };
  }

  try {
    win.restore();
    win.bringToTop();
    return { dispatched: true };
  } catch (error) {
    return { dispatched: false, error: error?.message || 'restore-failed' };
  }
}

export function startHelper({ pipeName, token, tokenFile, logger = console, onFatal } = {}) {
  const resolvedToken = token || readTokenFromFile(tokenFile);
  if (!pipeName || !resolvedToken) {
    onFatal?.('missing-config');
    return () => {};
  }

  let socket = null;
  let buffer = '';
  let closed = false;

  const stop = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      socket?.end();
    } catch {
      // ignore
    }
  };

  const handleRequest = (request) => {
    const { id, action, payload } = request || {};
    switch (action) {
      case HELPER_ACTIONS.minimize:
        return { id, ok: true, result: minimizeWindow(payload?.windowId) };
      case HELPER_ACTIONS.restore:
        return { id, ok: true, result: restoreWindow(payload?.windowId) };
      case HELPER_ACTIONS.ping:
        return { id, ok: true, result: { pid: process.pid, now: Date.now() } };
      case HELPER_ACTIONS.shutdown:
        setImmediate(stop);
        return { id, ok: true };
      default:
        return { id, ok: false, error: `unknown-action:${action}` };
    }
  };

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) {
        continue;
      }

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }

      try {
        const response = handleRequest(request);
        if (response && socket) {
          socket.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        if (socket) {
          socket.write(`${JSON.stringify({ id: request?.id, ok: false, error: error?.message || 'helper-error' })}\n`);
        }
      }
    }
  };

  const connect = () => {
    if (closed) {
      return;
    }

    logger.info?.('[sprout-helper] connecting', { pipeName });
    socket = net.connect(pipeName);
    socket.on('connect', () => {
      logger.info?.('[sprout-helper] connected, sending ready');
      socket.write(`${JSON.stringify({ type: HELPER_MESSAGES.ready, token: resolvedToken, pid: process.pid })}\n`);
    });
    socket.on('data', onData);
    socket.on('error', (error) => {
      logger.error?.('[sprout-helper] socket error', error?.message || error);
    });
    socket.on('close', () => {
      if (!closed) {
        closed = true;
        onFatal?.('pipe-closed');
      }
    });
  };

  connect();
  return stop;
}

export default startHelper;
