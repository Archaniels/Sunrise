import { DEFAULT_COLUMN_WIDTHS, type WorkspaceLayoutState } from '@sunrise/shared';
import type { ReactElement } from 'react';
import { WorkspaceShell } from './components/WorkspaceShell.js';

export interface SunriseShellProps {
  readonly version: string;
  readonly layout?: WorkspaceLayoutState;
}

const DEFAULT_SHELL_LAYOUT: WorkspaceLayoutState = {
  projectId: '00000000-0000-4000-8000-000000000000',
  activeCategory: 'overview',
  tabs: [],
  activeTabId: null,
  columns: DEFAULT_COLUMN_WIDTHS,
};

export function SunriseShell({ version, layout }: SunriseShellProps): ReactElement {
  return (
    <div data-sunrise-version={version}>
      <WorkspaceShell
        layout={layout ?? DEFAULT_SHELL_LAYOUT}
        connectivity="online"
        pendingDraftCount={0}
        onSelectCategory={() => undefined}
        onActivateTab={() => undefined}
        onCloseTab={() => undefined}
        onToggleRightSidebar={() => undefined}
      />
    </div>
  );
}
