/* ArtifactGallery.tsx — one mission's full proof-artifact gallery,
   dispatching each ProofArtifact kind to its own renderer (spec: "the
   heart" of the report page). Honest empty state when the mission attached
   no proofs at all — never a fabricated placeholder.
*/

import { useI18n } from '../../../i18n';
import type { ProofArtifact } from '../../../lib/agents/types';
import { ArtifactThumbnail } from './ArtifactThumbnail';
import { ArtifactChip } from './ArtifactChip';
import { BehaviorDiffPanel } from './BehaviorDiffPanel';

interface ArtifactGalleryProps {
  artifacts: readonly ProofArtifact[];
}

type ScreenshotArtifact = Extract<ProofArtifact, { kind: 'screenshot' }>;
type ChipArtifact = Extract<ProofArtifact, { kind: 'test_run' | 'command_output' | 'e2e_recording' }>;
type DiffArtifact = Extract<ProofArtifact, { kind: 'behavior_diff' }>;

function isScreenshot(a: ProofArtifact): a is ScreenshotArtifact {
  return a.kind === 'screenshot';
}
function isChip(a: ProofArtifact): a is ChipArtifact {
  return a.kind === 'test_run' || a.kind === 'command_output' || a.kind === 'e2e_recording';
}
function isDiff(a: ProofArtifact): a is DiffArtifact {
  return a.kind === 'behavior_diff';
}

export function ArtifactGallery({ artifacts }: ArtifactGalleryProps) {
  const { t } = useI18n();

  if (artifacts.length === 0) {
    return (
      <div data-testid="artifact-gallery-empty" style={{ fontSize: 11.5, color: 'var(--color-text-ghost)' }}>
        {t('report.artifact.emptyTitle')}
        <div style={{ fontSize: 10.5, color: 'var(--color-text-disabled)', marginTop: 2 }}>
          {t('report.artifact.emptyHint')}
        </div>
      </div>
    );
  }

  const screenshots = artifacts.filter(isScreenshot);
  const chips = artifacts.filter(isChip);
  const diffs = artifacts.filter(isDiff);

  return (
    <div data-testid="artifact-gallery" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {screenshots.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {screenshots.map((s, i) => (
            <ArtifactThumbnail key={`${s.path}-${i}`} path={s.path} label={s.label} />
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {chips.map((c, i) => (
            <ArtifactChip key={`${c.kind}-${i}`} artifact={c} />
          ))}
        </div>
      )}
      {diffs.map((d, i) => (
        <BehaviorDiffPanel key={i} artifact={d} />
      ))}
    </div>
  );
}
