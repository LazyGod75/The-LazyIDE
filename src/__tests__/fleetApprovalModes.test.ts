import { describe, it, expect, beforeEach } from 'vitest';
import {
  getApprovalMode,
  setApprovalMode,
  fleetApprovalModes,
  _resetApprovalModesForTests,
} from '../lib/agents/approvalMode';

describe('fleet approval modes (B26)', () => {
  beforeEach(() => {
    _resetApprovalModesForTests();
  });

  it('propagates the global default to every open project without an override', async () => {
    await setApprovalMode('auto_green');
    expect(fleetApprovalModes(['C:/a', 'C:/b'])).toEqual({
      'C:/a': 'auto_green',
      'C:/b': 'auto_green',
    });
  });

  it('keeps a per-project override while siblings inherit the global default', async () => {
    await setApprovalMode('full_auto');
    await setApprovalMode('manual', 'C:/shop');
    expect(getApprovalMode('C:/shop')).toBe('manual');
    expect(getApprovalMode('C:/other')).toBe('full_auto');
    expect(fleetApprovalModes(['C:/shop', 'C:/other'])).toEqual({
      'C:/shop': 'manual',
      'C:/other': 'full_auto',
    });
  });

  it('matches a per-project override across drive-letter / slash variants (fleet canvas)', async () => {
    await setApprovalMode('auto_green', 'c:\\Users\\me\\Lazy');
    expect(getApprovalMode('C:/Users/me/Lazy')).toBe('auto_green');
    expect(getApprovalMode('C:\\Users\\me\\Lazy\\')).toBe('auto_green');
  });
});
