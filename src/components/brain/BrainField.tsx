/* Label + children stack for Brain GitHub dialog fields. */

import type { ReactNode } from 'react';
import { BRAIN_FIELD_LABEL } from './brainDialogFields';

export function BrainField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={BRAIN_FIELD_LABEL}>{label}</label>
      {children}
    </div>
  );
}
