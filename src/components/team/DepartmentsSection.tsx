/* DepartmentsSection — admin-only department management.
   Lists existing departments (name + slug) and exposes an inline create form.
   Slug is auto-suggested from the name (lowercased) until the admin edits it.
   Shown inside OrgDashboard above the credits section.
*/

import { useState } from 'react';
import { createDepartment } from '../../lib/teams/orgApi';
import type { Department } from '../../lib/teams/types';
import { Spinner, EmptyState } from '../ui';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';

// ── Props ─────────────────────────────────────────────────────────

interface DepartmentsSectionProps {
  orgId: string;
  isAdmin: boolean;
  departments: Department[];
  onRefetch: () => void;
}

// ── Slug helper ───────────────────────────────────────────────────

/** Derive a URL-safe, lowercase slug from a free-text name. */
function slugifyDeptName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Section title (same pattern as OrgDashboard / CreditsSection) ──

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 14px 8px',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
        }}
      >
        {children}
      </span>
      {count !== undefined && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--color-text-ghost)',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 99,
            padding: '1px 7px',
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

// ── Department row ─────────────────────────────────────────────────

function DepartmentRow({ dept }: { dept: Department }) {
  return (
    <div
      data-testid="dept-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border-3)',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: 'rgba(124,92,255,0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          flexShrink: 0,
        }}
      >
        🏷
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {dept.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-ghost)', marginTop: 1, fontFamily: 'var(--font-mono)' }}>
          {dept.slug}
        </div>
      </div>
    </div>
  );
}

// ── Create form ────────────────────────────────────────────────────

function CreateDeptForm({ orgId, onRefetch }: { orgId: string; onRefetch: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);

  const effectiveSlug = slugEdited ? slug : slugifyDeptName(name);
  const canSubmit = name.trim() !== '' && effectiveSlug !== '' && !creating;

  function handleName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugifyDeptName(value));
  }

  function handleSlug(value: string) {
    setSlugEdited(true);
    setSlug(slugifyDeptName(value));
  }

  async function handleCreate() {
    if (!canSubmit) return;
    setCreating(true);
    const result = await createDepartment(orgId, effectiveSlug, name.trim());
    setCreating(false);
    if (result.success) {
      toast(t('team.depts.created'), 'success');
      setName('');
      setSlug('');
      setSlugEdited(false);
      onRefetch();
    } else {
      toast(result.error, 'error');
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px',
    background: 'var(--color-panel-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    color: 'var(--color-text)',
    fontSize: 12,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      style={{
        padding: '12px 14px',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor="dept-name" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {t('team.depts.nameLabel')}
        </label>
        <input
          id="dept-name"
          type="text"
          value={name}
          onChange={(e) => handleName(e.target.value)}
          placeholder={t('team.depts.namePlaceholder')}
          data-testid="dept-name-input"
          style={inputStyle}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor="dept-slug" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {t('team.depts.slugLabel')}
        </label>
        <input
          id="dept-slug"
          type="text"
          value={effectiveSlug}
          onChange={(e) => handleSlug(e.target.value)}
          placeholder={t('team.depts.slugPlaceholder')}
          data-testid="dept-slug-input"
          style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
        />
        <span style={{ fontSize: 10, color: 'var(--color-text-ghost)' }}>
          {t('team.depts.slugHint')}
        </span>
      </div>
      <div>
        <button
          onClick={handleCreate}
          disabled={!canSubmit}
          data-testid="create-dept-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 16px',
            borderRadius: 8,
            border: '1px solid rgba(124,92,255,0.4)',
            background: canSubmit ? 'rgba(124,92,255,0.12)' : 'rgba(124,92,255,0.04)',
            color: 'var(--color-accent-pale)',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'inherit',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.6,
          }}
        >
          {creating && <Spinner size={12} color="#fff" />}
          + {t('team.depts.submit')}
        </button>
      </div>
    </div>
  );
}

// ── DepartmentsSection ─────────────────────────────────────────────

export function DepartmentsSection({ orgId, isAdmin, departments, onRefetch }: DepartmentsSectionProps) {
  const { t } = useI18n();

  if (!isAdmin) return null;

  return (
    <div
      data-testid="departments-section"
      style={{
        margin: '12px 16px 0',
        background: 'var(--color-panel)',
        borderRadius: 10,
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <SectionTitle count={departments.length}>
        {t('team.depts.title')}
      </SectionTitle>

      {departments.length === 0 ? (
        <EmptyState icon="🏷" title={t('team.depts.empty')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {departments.map((d) => (
            <DepartmentRow key={d.id} dept={d} />
          ))}
        </div>
      )}

      <CreateDeptForm orgId={orgId} onRefetch={onRefetch} />
    </div>
  );
}
