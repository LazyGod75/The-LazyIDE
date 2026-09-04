/* ProjectSwitcherRow.tsx — multi-project overview row for the Rapport page:
   one pill per open project (only rendered when more than one project is
   open — spec §2). Default active pill matches whichever project the page
   was opened for.
*/

import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { basename } from '../../../lib/paths';
import { ProjectSwitcherPill } from './ProjectSwitcherPill';
import type { ProjectEntry } from '../../../app/AppContext';

interface ProjectSwitcherRowProps {
  projects: readonly ProjectEntry[];
  activeProjectId: string;
  onSelect: (projectId: string) => void;
}

export function ProjectSwitcherRow({ projects, activeProjectId, onSelect }: ProjectSwitcherRowProps) {
  if (projects.length <= 1) return null;

  return (
    <div data-testid="report-project-switcher" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {projects.map((p) => {
        const id = projectIdFromRoot(p.root);
        return (
          <ProjectSwitcherPill
            key={id}
            projectId={id}
            label={basename(p.root)}
            active={id === activeProjectId}
            onSelect={() => onSelect(id)}
          />
        );
      })}
    </div>
  );
}
