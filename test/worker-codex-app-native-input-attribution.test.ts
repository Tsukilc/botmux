import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { normalizeCodexAppLifecycleEvent } from '../src/services/codex-app-runner-protocol.js';
import { committedCodexAppSequence } from '../src/utils/codex-app-dispatch-ledger.js';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const temporaryMarkers: string[] = [];
afterEach(() => { for (const path of temporaryMarkers.splice(0)) rmSync(path, { recursive: true, force: true }); });

function harness() {
  const caller = (id: string) => ({
    requestLarkAppId: 'cli_native_input', requestUserOpenId: id, senderType: 'user' as const,
  });
  const originalCaller = caller('ou_original');
  const nextCaller = caller('ou_next');
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'finished', caller: originalCaller });
  authority.markStarted({ turnId: 'finished', caller: originalCaller });
  const queue = new CodexAppTurnDispatchQueue();
  queue.reserve('next', 7, 'dispatch-next');
  queue.reserve('later', 8, 'dispatch-later');
  const terminals = new TurnTerminalDeduper();
  terminals.claim('native-session', 'finished', undefined, 'completed');
  const markerSnapshots: Array<{ turnId: string; queued: string[] }> = [];
  const published: Array<ReturnType<ActiveTurnAuthority['snapshot']>> = [];
  const scope: Record<string, any> = {
    sessionId: 'native-session', lastInitConfig: { cliId: 'codex-app' }, isCodexAppCliId,
    currentBotmuxTurnId: 'finished', currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: originalCaller.requestUserOpenId,
    queuedTypeAheadTurns: [
      { turnId: 'next', dispatchAttempt: 7, trustedCaller: nextCaller, trustedController: nextCaller,
        turnCallerOpenId: nextCaller.requestUserOpenId },
      { turnId: 'later', dispatchAttempt: 8, trustedCaller: nextCaller },
    ],
    activeTurnAuthority: authority, codexAppTurnDispatchQueue: queue,
    emittedTurnTerminals: terminals, retiredTurnIds: new Set<string>(),
    codexAppControlProven: true, codexAppControlFatal: false,
    codexAppRunnerProcessIdentity: { launcherPid: 123 }, codexAppEngineIdentity: undefined,
    codexAppControlStateValue: { status: 'active', identities: [{ generation: 'g-current' }] },
    codexAppGenerationCommits: [], codexAppCompletionAwaitingFinal: false,
    closeRequested: false, cliRestartInProgress: false,
    hasCurrentSessionRuntime: () => true,
    syncQueuedTurnsFromMarkerDisk: vi.fn(() => false),
    setCaptureIdentity: (turnId: string, attempt?: number, callerOpenId?: string) => {
      scope.currentBotmuxTurnId = turnId;
      scope.currentBotmuxDispatchAttempt = attempt;
      scope.currentBotmuxCallerOpenId = callerOpenId;
    },
    writeCliPidMarker: vi.fn(() => markerSnapshots.push({
      turnId: scope.currentBotmuxTurnId,
      queued: scope.queuedTypeAheadTurns.map((entry: { turnId: string }) => entry.turnId),
    })),
    publishSandboxRelayCapability: vi.fn(() => published.push(authority.snapshot())),
    markTurnRetired: (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); },
    rememberQueuedTurnAdvanceForPendingReady: vi.fn(),
    releaseActiveTurnAuthority: (_reason: string, exact: { turnId: string; dispatchAttempt?: number }) =>
      !!authority.releaseExact(exact),
    adoptActiveTurnWhenIsolationOff: () => false,
    committedCodexAppSequence, normalizeCodexAppLifecycleEvent,
    submittedCodexAppReplyTurnIds: new Set<string>(),
    pendingCodexAppSteerAckIds: new Map<string, string>(), acknowledgedCodexAppSteers: new Set<string>(),
    rememberBounded: (set: Set<string>, value: string) => set.add(value),
    rememberBoundedMap: (map: Map<string, string>, key: string, value: string) => map.set(key, value),
    log: vi.fn(), cliName: () => 'Codex App', shortCorrelationId: (id?: string) => id,
    send: vi.fn(),
  };
  for (const name of ['turnAuthorityIdentity', 'markActiveTurnStarted', 'turnTerminalEmitted',
    'dropQueuedTurnRecord', 'releaseTerminatedActiveTurnAuthority', 'markReplyInputConsumed',
    'advanceQueuedTypeAheadTurn', 'codexAppInputControlIsCurrent', 'acceptCodexAppStartedInput']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  const apply = loadWorkerFunction<(...args: any[]) => Promise<boolean>>('handleTrustedCodexAppMarker', scope);
  const control = { generation: 'g-current', seq: 12 };
  const start = (turnId = 'next', ctl: typeof control | undefined = control) =>
    apply('lifecycle', { kind: 'turn_started', atMs: 1, replyTurnId: turnId, appTurnId: `app-${turnId}` }, ctl);
  return { scope, authority, queue, terminals, markerSnapshots, published, control, start, apply, nextCaller, originalCaller };
}

function realMarkers(h: ReturnType<typeof harness>, diskTurn = 'finished', rpcDiskTurn?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-native-input-marker-'));
  temporaryMarkers.push(dir);
  const write = (pid: string, turnId: string) => {
    const path = join(dir, pid);
    writeFileSync(path, JSON.stringify({ sessionId: 'native-session', turnId,
      dispatchAttempt: turnId === 'later' ? 8 : undefined, procStart: 'fixture-start' }));
    return path;
  };
  Object.assign(h.scope, {
    cliPidMarker: write('123', diskTurn),
    rpcEnginePidMarker: rpcDiskTurn ? write('456', rpcDiskTurn) : undefined,
    existsSync, readFileSync, atomicWriteFileSync, withFileLockSync, basename,
    heldPidMarkerPaths: new Set<string>(), readProcessStartIdentity: () => 'fixture-start',
    markerIdentityTurnId: (value: unknown) => typeof value === 'string' ? value : undefined,
    sandboxRelayCapability: undefined, process: { env: {} },
  });
  for (const name of ['withPidMarkerLock', 'retireTerminatedMarkerTurn', 'markerQueuedTurnStillLive', 'writeCliPidMarker']) {
    h.scope[name] = loadWorkerFunction(name, h.scope);
  }
  // Use the real adopter, not a permanent no-op, so an accidental native-path
  // sync can actually steal the later disk head and fail these assertions.
  h.scope.syncQueuedTurnsFromMarkerDisk = vi.fn(loadWorkerFunction('syncQueuedTurnsFromMarkerDisk', h.scope));
  return h.scope.cliPidMarker as string;
}

describe('Codex App native input attribution without an idle edge', () => {
  it('promotes the exact next reservation after automatic final delivery, before the write promise returns', async () => {
    const h = harness();
    // No explicit-send final marker and no post-write submitted-id set entry.
    expect(h.scope.submittedCodexAppReplyTurnIds.size).toBe(0);
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('next');
    expect(h.scope.currentBotmuxDispatchAttempt).toBe(7);
    expect(h.scope.queuedTypeAheadTurns.map((entry: { turnId: string }) => entry.turnId)).toEqual(['later']);
    expect(h.authority.snapshot()).toMatchObject({ turnId: 'next', dispatchAttempt: 7,
      caller: h.nextCaller, controller: h.nextCaller });
    expect(h.published).toHaveLength(1);
    expect(h.markerSnapshots.at(-1)?.turnId).toBe('next');
    expect(h.queue.size(), 'native start does not settle the final FIFO').toBe(2);
  });

  it('advances successive native turns without requiring prompt-ready or an explicit final send', async () => {
    const h = harness();
    await h.start();
    h.queue.settleFinal({ turnId: 'next' });
    h.terminals.claim('native-session', 'next', 7, 'completed');
    await h.start('later', { ...h.control, seq: 20 });
    expect(h.scope.currentBotmuxTurnId).toBe('later');
    expect(h.scope.currentBotmuxDispatchAttempt).toBe(8);
    expect(h.scope.queuedTypeAheadTurns).toEqual([]);
    expect(h.authority.snapshot()?.turnId).toBe('later');
    expect(h.queue.size()).toBe(1);
  });

  it('does not advance twice for a repeated start while the same reservation is active', async () => {
    const h = harness();
    await h.start();
    await h.start('next', { ...h.control, seq: 13 });
    expect(h.published).toHaveLength(1);
    expect(h.scope.currentBotmuxTurnId).toBe('next');
    expect(h.queue.size()).toBe(2);
  });

  it('accepts an independent Goal-root dispatch on an already existing native turn', async () => {
    const h = harness();
    await h.apply('lifecycle', { kind: 'turn_started', atMs: 1,
      replyTurnId: 'next', appTurnId: 'already-running-native-goal' }, h.control);
    expect(h.scope.currentBotmuxTurnId).toBe('next');
    expect(h.authority.snapshot()).toMatchObject({ turnId: 'next', dispatchAttempt: 7, caller: h.nextCaller });
    expect(h.queue.size()).toBe(2);
  });

  it('does not give an autonomous native Goal notification a queued caller identity', async () => {
    const h = harness();
    await h.apply('lifecycle', { kind: 'turn_started', atMs: 1,
      appTurnId: 'already-running-native-goal' }, h.control);
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.writeCliPidMarker).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'later'])('ignores a start that does not match the immutable FIFO head: %s', async turnId => {
    const h = harness();
    await h.start(turnId);
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.writeCliPidMarker).not.toHaveBeenCalled();
    expect(h.queue.size()).toBe(2);
  });

  it('does not replace an unfinished current execution', async () => {
    const h = harness();
    h.scope.currentBotmuxTurnId = 'still-running';
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('still-running');
    expect(h.scope.queuedTypeAheadTurns[0].inputConsumed).toBeUndefined();
    expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });

  it('ignores a native start that arrives after the exact target was cancelled', async () => {
    const h = harness();
    h.terminals.claim('native-session', 'next', 7, 'cancelled');
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.writeCliPidMarker).not.toHaveBeenCalled();
  });

  it('cannot select a different attempt for a matching reply id', async () => {
    const h = harness();
    h.scope.queuedTypeAheadTurns[0].dispatchAttempt = 8;
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });

  it('does not steal another nonterminal authority while repairing a stale marker', async () => {
    const h = harness();
    h.authority.clear();
    h.authority.reserve({ turnId: 'manual-intervention', caller: h.originalCaller });
    h.authority.markStarted({ turnId: 'manual-intervention', caller: h.originalCaller });
    await h.start();
    expect(h.authority.snapshot()?.turnId).toBe('manual-intervention');
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
  });

  it('updates a real owned marker from the finished turn to the exact native-started turn', async () => {
    const h = harness(); const path = realMarkers(h);
    await h.start();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ turnId: 'next', dispatchAttempt: 7,
      trustedCaller: h.nextCaller, queuedTurns: [{ turnId: 'later', dispatchAttempt: 8 }] });
    expect(h.scope.syncQueuedTurnsFromMarkerDisk).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects an advanced %s RPC-marker head before any adopting sync or identity write', async rpcConflict => {
    const h = harness();
    const path = realMarkers(h, rpcConflict ? 'finished' : 'later', rpcConflict ? 'later' : undefined);
    const before = readFileSync(path, 'utf8');
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.queuedTypeAheadTurns.map((entry: { turnId: string }) => entry.turnId)).toEqual(['next', 'later']);
    expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
    expect(h.scope.syncQueuedTurnsFromMarkerDisk).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.each([
    ['closing', { closeRequested: true }],
    ['restarting', { cliRestartInProgress: true }],
    ['unproven', { codexAppControlProven: false }],
    ['fenced', { codexAppControlFatal: true }],
    ['awaiting prior final', { codexAppCompletionAwaitingFinal: true }],
    ['replaced runtime', { hasCurrentSessionRuntime: () => false }],
    ['another CLI', { lastInitConfig: { cliId: 'claude-code' } }],
  ])('does not publish identity while %s', async (_label, change) => {
    const h = harness(); Object.assign(h.scope, change);
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.writeCliPidMarker).not.toHaveBeenCalled();
  });

  it('rejects a stale generation and an already committed signed sequence', async () => {
    const h = harness();
    await h.start('next', { generation: 'g-old', seq: 12 });
    h.scope.codexAppGenerationCommits = [{ generation: 'g-current', committedThrough: 12 }];
    await h.start();
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });

  it('does not treat an unsigned lifecycle call as consumption proof', async () => {
    const h = harness();
    await h.apply('lifecycle', { kind: 'turn_started', atMs: 1, replyTurnId: 'next', appTurnId: 'app-next' });
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.scope.writeCliPidMarker).not.toHaveBeenCalled();
  });

  it('marks an accepted steer consumed without taking over execution or its caller', async () => {
    const h = harness();
    h.scope.emittedTurnTerminals = new TurnTerminalDeduper();
    h.scope.submittedCodexAppReplyTurnIds.add('next');
    await h.apply('lifecycle', { kind: 'steer_attempt', atMs: 1, replyTurnId: 'next', appTurnId: 'app-active' }, h.control);
    await h.apply('lifecycle', { kind: 'steer_accepted', atMs: 2, replyTurnId: 'next', appTurnId: 'app-active' }, { ...h.control, seq: 13 });
    expect(h.scope.queuedTypeAheadTurns[0].inputConsumed).toBe(true);
    expect(h.scope.currentBotmuxTurnId).toBe('finished');
    expect(h.authority.snapshot()).toMatchObject({ turnId: 'finished', caller: h.originalCaller });
    expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
    expect(h.queue.size()).toBe(2);
  });
});
