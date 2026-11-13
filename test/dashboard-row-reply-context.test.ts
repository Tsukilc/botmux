import { describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  composeRowFromActive,
  composeRowFromClosed,
  composeRowFromPersistedActive,
  type SessionRow,
} from '../src/core/dashboard-rows.js';
import { selectReplyMessageId } from '../src/core/reply-message.js';

const messageId = 'om_previous_input';

function session(cliId: 'codex-app' | 'claude-code'): Session {
  return {
    sessionId: 'session-reply-routing',
    larkAppId: 'cli_test',
    cliId,
    chatId: 'oc_test',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'chat',
    title: 'reply routing',
    status: 'active',
    createdAt: '2026-11-13T00:00:00.000Z',
    turnReplyContexts: {
      [messageId]: {
        target: { mode: 'plain', chatId: 'oc_test' },
        sourceMessageId: messageId,
        quoteTargetId: messageId,
        inThread: false,
      },
    },
  } as Session;
}

const composers: Array<[string, (s: Session, includeTurnReplyContexts?: boolean) => SessionRow]> = [
  ['active', (s, includeTurnReplyContexts) => composeRowFromActive({
    session: s,
    larkAppId: s.larkAppId,
    chatId: s.chatId,
    chatType: 'group',
    scope: 'chat',
    worker: null,
    workerPort: null,
    spawnedAt: 0,
    lastMessageAt: 0,
  } as unknown as DaemonSession, { includeTokenUsage: false, includeTurnReplyContexts })],
  ['persisted active', (s, includeTurnReplyContexts) => composeRowFromPersistedActive(s, {
    includeTokenUsage: false, includeTurnReplyContexts,
  })],
  ['closed', (s, includeTurnReplyContexts) => composeRowFromClosed({ ...s, status: 'closed' }, {
    includeTokenUsage: false, includeTurnReplyContexts,
  })],
];

describe.each(composers)('%s session reply addressing over IPC', (_name, compose) => {
  it.each(['codex-app', 'claude-code'] as const)('retains an incoming reply anchor for %s', cliId => {
    // 模拟 daemon 的 JSON 响应，再使用 CLI 的真实回复目标校验。
    const row = JSON.parse(JSON.stringify(compose(session(cliId), true)));

    expect(selectReplyMessageId(row, 'om_execution', null, messageId)).toBe(messageId);
    expect(row.turnReplyContexts[messageId].target).toEqual({ mode: 'plain', chatId: 'oc_test' });
    expect(() => selectReplyMessageId(row, 'om_execution', null, 'om_unknown')).toThrow();
  });

  it('does not publish incoming message context on list and event rows', () => {
    const row = JSON.parse(JSON.stringify(compose(session('codex-app'))));

    expect(row.turnReplyContexts).toBeUndefined();
    expect(() => selectReplyMessageId(row, 'om_execution', null, messageId)).toThrow();
  });

  it('does not invent retained input for a session without reply context', () => {
    const s = session('codex-app');
    delete s.turnReplyContexts;
    const row = JSON.parse(JSON.stringify(compose(s, true)));

    expect(row.turnReplyContexts).toBeUndefined();
    expect(() => selectReplyMessageId(row, 'om_execution', null, messageId)).toThrow();
  });
});
