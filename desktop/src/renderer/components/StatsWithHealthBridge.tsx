import React from 'react';
import { MarketplaceStatsProvider } from '../state/marketplace-stats-context';
import { useWorkerHealth } from '../state/worker-health-context';

// Bridge: reads reportResult from WorkerHealthContext and passes it to MarketplaceStatsProvider.
// Must be a child of WorkerHealthProvider and parent of anything that consumes useMarketplaceStats().
export function StatsWithHealthBridge({ children }: { children: React.ReactNode }) {
  const { reportResult } = useWorkerHealth();
  return (
    <MarketplaceStatsProvider onNetworkResult={reportResult}>
      {children}
    </MarketplaceStatsProvider>
  );
}
