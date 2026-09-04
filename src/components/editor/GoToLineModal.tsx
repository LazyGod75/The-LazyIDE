import { useState, useRef, useEffect } from 'react';

interface GoToLineModalProps {
  lineCount: number;
  onGo: (line: number) => void;
  onClose: () => void;
}

export function GoToLineModal({ lineCount, onGo, onClose }: GoToLineModalProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const line = parseInt(value, 10);
    if (!isNaN(line) && line >= 1 && line <= lineCount) {
      onGo(line);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#1C1C2A',
          border: '1px solid rgba(124,92,255,0.3)',
          borderRadius: 10,
          padding: 20,
          minWidth: 320,
          boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: '#D5D8E0', marginBottom: 12 }}>
          Go to Line
        </div>
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={lineCount}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          placeholder={`Line number (1-${lineCount})`}
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(124,92,255,0.2)',
            borderRadius: 6,
            padding: '8px 12px',
            color: '#D5D8E0',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: '6px 14px',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{
              background: 'rgba(124,92,255,0.15)',
              border: '1px solid rgba(124,92,255,0.3)',
              borderRadius: 6,
              padding: '6px 14px',
              color: '#A78BFF',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            Go
          </button>
        </div>
      </div>
    </div>
  );
}
