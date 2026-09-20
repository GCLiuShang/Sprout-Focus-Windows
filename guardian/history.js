import fs from 'node:fs/promises';
import path from 'node:path';
import { formatDurationMinutes } from '../shared/models.js';

export function toLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toLocalDateTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function toLocalTime(value) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

async function readJsonlSummaries(logFile) {
  try {
    const raw = await fs.readFile(logFile, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row?.kind === 'session-ended' && row.payload)
      .map((row) => row.payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function pickTopSession(sessions, selector) {
  return [...sessions].sort((left, right) => {
    const leftValue = selector(left);
    const rightValue = selector(right);
    return rightValue - leftValue;
  })[0] ?? null;
}

function sessionDurationMinutes(session) {
  return Number(session.actualDurationMinutes ?? session.durationMinutes ?? 0);
}

export function summarizeDay(dateKey, sessions) {
  const totalMinutes = sessions.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
  const totalViolations = sessions.reduce((sum, session) => sum + Number(session.violationCount || 0), 0);
  const topPreciseSession = pickTopSession(sessions.filter((session) => session.primaryPrecise?.label), sessionDurationMinutes);
  const topFuzzySession = pickTopSession(sessions.filter((session) => session.primaryFuzzy?.text || session.primaryFuzzy?.setName), sessionDurationMinutes);

  return {
    dateKey,
    totalMinutes,
    totalSessions: sessions.length,
    totalViolations,
    topPreciseSession,
    topFuzzySession,
  };
}

function formatPrecise(item) {
  if (!item) {
    return '未记录';
  }
  return item.label || item.title || item.processName || '未记录';
}

function formatFuzzy(item) {
  if (!item) {
    return '未分类';
  }
  return item.setName || item.text || '未分类';
}

function renderList(title, items, formatter) {
  if (!items?.length) {
    return `- ${title}：无`;
  }

  return `- ${title}：${items.map(formatter).join('，')}`;
}

function renderViolations(violations = []) {
  if (!violations.length) {
    return '- 违规时间线：无';
  }

  return [
    '- 违规时间线：',
    ...violations.map((violation) => `  - ${toLocalTime(violation.timestamp)} · ${violation.title || violation.processName || '未知窗口'} · ${violation.reason}${violation.processPath ? ` · ${violation.processPath}` : ''}`),
  ].join('\n');
}

export function renderDayMarkdown(daySummary, sessions) {
  const lines = [
    `# ${daySummary.dateKey} 专注记录`,
    '',
    `> 生成时间：${toLocalDateTime(new Date())}`,
    '',
    '## 当日摘要',
    '',
    `- 当日总专注时长：${formatDurationMinutes(daySummary.totalMinutes)}`,
    `- 当日总会话数：${daySummary.totalSessions}`,
    `- 当日总违规次数：${daySummary.totalViolations}`,
    `- 单窗口最长 session：${daySummary.topPreciseSession ? `${formatPrecise(daySummary.topPreciseSession.primaryPrecise)} · ${formatDurationMinutes(daySummary.topPreciseSession.durationMinutes)}` : '暂无'}`,
    `- 单分类最长 session：${daySummary.topFuzzySession ? `${formatFuzzy(daySummary.topFuzzySession.primaryFuzzy)} · ${formatDurationMinutes(daySummary.topFuzzySession.durationMinutes)}` : '暂无'}`,
    '',
  ];

  sessions.forEach((session) => {
    const actualDuration = sessionDurationMinutes(session);
    const plannedDuration = Number(session.plannedDurationMinutes ?? session.durationMinutes ?? actualDuration);
    const durationLabel = plannedDuration && plannedDuration !== actualDuration
      ? `${formatDurationMinutes(actualDuration)}（计划 ${formatDurationMinutes(plannedDuration)}）`
      : formatDurationMinutes(actualDuration);
    const title = `${toLocalTime(session.startedAt)} - ${toLocalTime(session.endedAt)} · ${durationLabel}`;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(`- 开始时间：${toLocalDateTime(session.startedAt)}`);
    lines.push(`- 结束时间：${toLocalDateTime(session.endedAt)}`);
    lines.push(`- 模式：${session.sessionMode === 'countup' ? '正计时' : '倒计时'}`);
    lines.push(`- 实际时长：${formatDurationMinutes(actualDuration)}`);
    if (plannedDuration) {
      lines.push(`- 计划时长：${formatDurationMinutes(plannedDuration)}`);
    }
    lines.push(`- 结束原因：${session.completionReason === 'completed' ? '倒计时结束' : '手动结束'}`);
    lines.push(`- 违规次数：${session.violationCount || 0}`);
    lines.push(renderList('精准规则', session.preciseItems, (item) => item.label || item.title || item.processName || '未命名条目'));
    lines.push(renderList('模糊短语', session.fuzzyPhrases, (item) => item.text || '未命名短语'));
    lines.push(renderViolations(session.violations));
    lines.push('');
  });

  return lines.join('\n').trim() + '\n';
}

export async function regenerateHistoryMarkdown({ logDir, historyDir, dateKey }) {
  const logFile = path.join(logDir, `forest-${dateKey}.jsonl`);
  const sessions = await readJsonlSummaries(logFile);
  const daySummary = summarizeDay(dateKey, sessions);
  await fs.mkdir(historyDir, { recursive: true });
  const markdown = renderDayMarkdown(daySummary, sessions);
  const historyFile = path.join(historyDir, `${dateKey}.md`);
  await fs.writeFile(historyFile, markdown, 'utf8');
  return { historyFile, sessions, daySummary };
}
