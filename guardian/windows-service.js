import path from 'node:path';
import activeWindow from 'active-win';
import windowManagerPackage from 'node-window-manager';
import { createEmptyActiveContext } from '../shared/models.js';

const { windowManager } = windowManagerPackage;

export class WindowsService {
  captureSystemContext() {
    const current = activeWindow.sync();
    if (!current) {
      return createEmptyActiveContext();
    }

    const processName = current.owner?.name ?? '';
    const processPath = current.owner?.path ?? '';
    return {
      timestamp: new Date().toISOString(),
      source: 'windows',
      title: current.title ?? '',
      windowId: current.id ?? null,
      processId: current.owner?.processId ?? null,
      processName,
      processPath,
      confidence: 0.7,
    };
  }

  minimizeWindow(windowId) {
    const win = this.#findWindow(windowId);
    if (!win) {
      return { windowId, dispatched: false, error: 'window-not-found' };
    }

    try {
      win.minimize();
      return { windowId, dispatched: true };
    } catch (error) {
      return { windowId, dispatched: false, error: error?.message || 'minimize-failed' };
    }
  }

  listWindows() {
    return windowManager
      .getWindows()
      .filter((candidate) => candidate.isWindow())
      .map((candidate) => {
        const processPath = candidate.path || '';
        return {
          id: candidate.id,
          title: candidate.getTitle() || '',
          processId: candidate.processId ?? null,
          processPath,
          processName: processPath ? path.win32.basename(processPath) : '',
        };
      })
      .filter((entry) => entry.title || entry.processPath);
  }

  restoreWindow(windowId) {
    const win = this.#findWindow(windowId);
    if (!win) {
      return false;
    }

    try {
      win.restore();
      win.bringToTop();
      return true;
    } catch {
      return false;
    }
  }

  #findWindow(windowId) {
    if (windowId == null) {
      return null;
    }

    return windowManager.getWindows().find((candidate) => candidate.id === windowId && candidate.isWindow());
  }
}

export default WindowsService;
