/* Parse the custom top-up input on Settings > Account. */

import type { AccountBilling } from './useAccountBilling';

export function submitCustomTopup(billing: AccountBilling): void {
  const amt = parseFloat(billing.topupInput);
  if (!Number.isNaN(amt) && amt >= 1 && amt <= 500) {
    void billing.handleTopup(amt);
    return;
  }
  billing.toast(billing.t('settings.billing.topupRangeError'), 'error');
}
