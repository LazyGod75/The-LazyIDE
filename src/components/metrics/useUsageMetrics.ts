/* useUsageMetrics — subscribes to usageHistory and returns live WindowMetrics */

import { useState, useEffect } from 'react';
import {
  getWindowMetrics,
  subscribeUsageHistory,
  type UsageWindow,
  type WindowMetrics,
} from '../../lib/models/usageHistory';

export function useUsageMetrics(window: UsageWindow): WindowMetrics {
  const [metrics, setMetrics] = useState<WindowMetrics>(() =>
    getWindowMetrics(window),
  );

  useEffect(() => {
    // Recompute immediately when window changes
    setMetrics(getWindowMetrics(window));

    const unsub = subscribeUsageHistory(() => {
      setMetrics(getWindowMetrics(window));
    });

    return unsub;
  }, [window]);

  return metrics;
}
