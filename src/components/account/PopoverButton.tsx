/* PopoverButton — shared button styling used by AccountPopover.tsx and its
   extracted children (TopupForm.tsx, UpgradeProPlusButton.tsx). Split out
   of AccountPopover.tsx to avoid a circular import between it and those
   children (both need this button; AccountPopover.tsx also renders them).
*/

export interface PopoverButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  testId?: string;
}

export function PopoverButton({ children, onClick, primary, disabled, testId }: PopoverButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{
        background: primary ? 'rgba(124,92,255,0.15)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${primary ? 'rgba(124,92,255,0.4)' : 'var(--color-border)'}`,
        borderRadius: 6,
        padding: '7px 10px',
        fontSize: 11,
        fontWeight: 600,
        color: primary ? '#A78BFF' : 'rgba(255,255,255,0.7)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'inherit',
        textAlign: 'left',
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => {
        if (disabled) return;
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = primary ? 'rgba(124,92,255,0.24)' : 'rgba(255,255,255,0.08)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = primary ? 'rgba(124,92,255,0.15)' : 'rgba(255,255,255,0.04)';
      }}
    >
      {children}
    </button>
  );
}
