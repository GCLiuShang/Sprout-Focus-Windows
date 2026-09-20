import { decideContext as decideContextCore } from '../shared/rules-core.js';

export function isOwnAppContext(context) {
  if (context?.processId && Number(context.processId) === process.pid) {
    return true;
  }
  const processPath = String(context?.processPath || '').toLowerCase();
  const processName = String(context?.processName || '').toLowerCase();
  const title = String(context?.title || '').toLowerCase();
  return processPath.includes('sprout')
    || title.includes('sprout')
    || (processName === 'electron.exe' && processPath.includes('electron\\dist'));
}

export function decideContext(args) {
  if (isOwnAppContext(args?.context)) {
    return {
      allowed: true,
      reason: 'Sprout 自身界面允许前台显示',
      matchedPrecise: null,
      matchedFuzzy: null,
      matchedSystemRule: null,
      matchedUserRule: null,
    };
  }

  return decideContextCore(args);
}

export default decideContext;
