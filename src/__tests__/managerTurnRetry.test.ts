import { describe, expect, it } from 'vitest';
import {
  appendTurnRetryMessages,
  assembleManagerTurnResponseText,
  collectInvalidActionReasons,
  firstTurnPartial,
  formatZeroActionNudgeLog,
  nudgeFailedOutcome,
  resolveManagerTurnMode,
  eligibleRepairMode,
  shouldNudgeZeroActions,
  shouldRetryInvalidActions,
  showNudgeFailureNotice,
  applyRepairedActions,
  stripUnexecutedActionClaims,
  zeroActionNudgeUserContent,
  isSubstantialInformationalReply,
} from '../lib/agents/managerTurnRetry.js';
import type { ManagerMessage } from '../lib/agents/types.js';

describe('resolveManagerTurnMode', () => {
  it('honors cli override with the native engine mode, not the ambient raw mode', () => {
    expect(resolveManagerTurnMode('managed', 'cli', 'claude-code')).toBe('claude-code');
  });

  it('maps pro override onto the managed rail', () => {
    expect(resolveManagerTurnMode('claude-code', 'pro', 'claude-code')).toBe('managed');
  });

  it('keeps the ambient mode when no override is set', () => {
    expect(resolveManagerTurnMode('codex', undefined, 'claude-code')).toBe('codex');
  });
});

describe('shouldNudgeZeroActions', () => {
  const base = {
    announcementNudged: false,
    turn: 0,
    maxTurns: 3,
    userAskedForAction: true,
    isClarifying: false,
  };

  it('nudges once when the user asked for an action and the reply is not a question', () => {
    expect(shouldNudgeZeroActions(base)).toBe(true);
  });

  it('does not nudge twice in the same call', () => {
    expect(shouldNudgeZeroActions({ ...base, announcementNudged: true })).toBe(false);
  });

  it('does not nudge on the last allowed turn', () => {
    expect(shouldNudgeZeroActions({ ...base, turn: 2 })).toBe(false);
  });

  it('does not nudge a substantial informational reply even if the user text looked like an order', () => {
    expect(shouldNudgeZeroActions({ ...base, isSubstantialInfo: true })).toBe(false);
  });
});

describe('zero-action nudge copy', () => {
  it('keeps the generic log when the block is missing', () => {
    expect(formatZeroActionNudgeLog(1, null, 'Je supprime M16.')).toBe(
      '[managerEngine] turn 1: user asked for an action but the reply emitted no <lazy_actions> block — issuing one corrective nudge (never repeated within this call): "Je supprime M16."',
    );
  });

  it('keeps the parse-failure log when a block opened but JSON failed', () => {
    expect(formatZeroActionNudgeLog(1, 'its content is not valid JSON (boom)', 'Je supprime M16.')).toBe(
      '[managerEngine] turn 1: <lazy_actions> block opened but unparseable (its content is not valid JSON (boom)) — issuing one corrective nudge with the specific reason (never repeated within this call): "Je supprime M16."',
    );
  });

  it('returns the announcement nudge message when there is no parse failure', () => {
    expect(zeroActionNudgeUserContent(null, 'NUDGE')).toBe('NUDGE');
  });

  it('asks for syntactically valid JSON when a block was opened', () => {
    const content = zeroActionNudgeUserContent('its content is not valid JSON (boom)', 'NUDGE');
    expect(content).toContain('its content is not valid JSON (boom)');
    expect(content).toContain('<lazy_actions>[{"type":"archive_mission","missionId":"M12"}]</lazy_actions>');
    expect(content).not.toBe('NUDGE');
  });
});

describe('collectInvalidActionReasons', () => {
  it('returns an empty list when every raw action is structurally valid', () => {
    expect(collectInvalidActionReasons([{ type: 'stop_mission', missionId: 'M1' }])).toEqual([]);
  });

  it('labels a missing-field action with its type', () => {
    expect(collectInvalidActionReasons([{ type: 'stop_mission' }])).toEqual([
      'Action "stop_mission": missing or non-string "missionId"',
    ]);
  });

  it('labels a non-object action as unknown', () => {
    const reasons = collectInvalidActionReasons([null]);
    expect(reasons[0]).toMatch(/^Action "\(unknown\)": /);
  });
});

describe('appendTurnRetryMessages', () => {
  it('appends the assistant raw reply then the user correction', () => {
    const apiMessages: ManagerMessage[] = [];
    let n = 0;
    appendTurnRetryMessages(apiMessages, 'raw', 'fix it', () => `id-${++n}`);
    expect(apiMessages).toHaveLength(2);
    expect(apiMessages[0]).toMatchObject({ id: 'id-1', role: 'assistant', content: 'raw' });
    expect(apiMessages[1]).toMatchObject({ id: 'id-2', role: 'user', content: 'fix it' });
  });
});

describe('eligibleRepairMode', () => {
  it('returns the resolved mode when a failed nudge still has budget', () => {
    expect(eligibleRepairMode(true, 3, 3, 'managed')).toBe('managed');
    expect(eligibleRepairMode(true, 4, 3, 'managed')).toBeUndefined();
    expect(eligibleRepairMode(false, 1, 3, 'managed')).toBeUndefined();
    expect(eligibleRepairMode(true, 1, 3, undefined)).toBeUndefined();
  });
});

describe('assembleManagerTurnResponseText', () => {
  it('returns the model text when there is no failure notice', () => {
    expect(assembleManagerTurnResponseText('OK', false, '[system] nope')).toBe('OK');
  });

  it('prepends the notice alongside non-empty model text', () => {
    expect(assembleManagerTurnResponseText('OK', true, '[system] nope')).toBe('[system] nope\n\nOK');
  });

  it('degrades to the notice alone when the model text is blank', () => {
    expect(assembleManagerTurnResponseText('   ', true, '[system] nope')).toBe('[system] nope');
  });

  it('keeps a long analysis intact instead of prefixing the stall notice', () => {
    const analysis = 'Sources réellement vues. '.repeat(40);
    expect(analysis.length).toBeGreaterThan(500);
    expect(isSubstantialInformationalReply(analysis)).toBe(true);
    expect(assembleManagerTurnResponseText(analysis, true, '[system] nope')).toBe(analysis);
  });

  it('drops an unexecuted launch claim so the user never sees "je lance" without an action', () => {
    expect(stripUnexecutedActionClaims('Je lance SolariTest sur https://example.com.')).toBe('');
    expect(stripUnexecutedActionClaims("I'll launch the bot now.")).toBe('');
    expect(assembleManagerTurnResponseText(
      'Je lance maintenant SolariTest via le navigateur cloud.',
      true,
      '[system] nope',
    )).toBe('[system] nope');
  });

  it('keeps a real non-announcement reply alongside the failure notice', () => {
    expect(assembleManagerTurnResponseText('OK', true, '[system] nope')).toBe('[system] nope\n\nOK');
    expect(stripUnexecutedActionClaims('Le projet n’a pas de bot nommé SolariTest.')).toContain('SolariTest');
  });
});

describe('firstTurnPartial / retry / nudge outcome', () => {
  it('keeps onPartial only for turn 0', () => {
    const fn = () => undefined;
    expect(firstTurnPartial(0, fn)).toBe(fn);
    expect(firstTurnPartial(1, fn)).toBeUndefined();
  });

  it('retries invalid actions only before the last turn', () => {
    expect(shouldRetryInvalidActions(1, 3)).toBe(true);
    expect(shouldRetryInvalidActions(2, 3)).toBe(false);
  });

  it('treats a nudged zero-action non-question as a failed nudge', () => {
    expect(nudgeFailedOutcome(true, 0, false)).toBe(true);
    expect(nudgeFailedOutcome(true, 0, true)).toBe(false);
    expect(nudgeFailedOutcome(true, 1, false)).toBe(false);
    expect(nudgeFailedOutcome(false, 0, false)).toBe(false);
  });

  it('shows the failure notice only when repair also failed', () => {
    expect(showNudgeFailureNotice(true, false)).toBe(true);
    expect(showNudgeFailureNotice(true, true)).toBe(false);
    expect(showNudgeFailureNotice(false, false)).toBe(false);
  });

  it('applies repaired actions only when the repair list is non-empty', () => {
    expect(applyRepairedActions(['a'], [])).toEqual({ actions: ['a'], recovered: false });
    expect(applyRepairedActions(['a'], ['b'])).toEqual({ actions: ['b'], recovered: true });
  });
});
