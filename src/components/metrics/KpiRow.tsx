/* KpiRow — responsive flex row for KPI tiles */

import React from 'react';

interface KpiRowProps {
  children: React.ReactNode;
}

export function KpiRow({ children }: KpiRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'stretch',
      }}
    >
      {children}
    </div>
  );
}
