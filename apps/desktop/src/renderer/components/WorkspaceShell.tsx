import {
  SIDEBAR_CATEGORIES,
  type ConnectivityStatus,
  type FilePreviewResponse,
  type SidebarCategory,
  type WorkspaceLayoutState,
} from '@sunrise/shared';
import {
  BookOpen,
  Database,
  FileText,
  FolderOpen,
  Image,
  LayoutGrid,
  Sparkles,
  Terminal,
  WifiOff,
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FilePreviewPane } from './FilePreviewPane.js';

export interface WorkspaceShellProps {
  readonly layout: WorkspaceLayoutState;
  readonly connectivity: ConnectivityStatus;
  readonly pendingDraftCount: number;
  readonly activePreview?: {
    readonly fileName: string;
    readonly preview: FilePreviewResponse;
  };
  readonly onSelectCategory: (category: SidebarCategory) => void;
  readonly onActivateTab: (tabId: string) => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onToggleRightSidebar: () => void;
}

const CATEGORY_LABELS: Readonly<Record<SidebarCategory, string>> = {
  overview: 'Overview',
  references: 'References',
  data: 'Data',
  analysis: 'Analysis',
  reports: 'Reports',
  figures: 'Figures',
  all_files: 'All Files',
};

function renderCategoryIcon(category: SidebarCategory): ReactElement {
  switch (category) {
    case 'overview':
      return <LayoutGrid className="h-4 w-4" />;
    case 'references':
      return <BookOpen className="h-4 w-4" />;
    case 'data':
      return <Database className="h-4 w-4" />;
    case 'analysis':
      return <Terminal className="h-4 w-4" />;
    case 'reports':
      return <FileText className="h-4 w-4" />;
    case 'figures':
      return <Image className="h-4 w-4" />;
    case 'all_files':
      return <FolderOpen className="h-4 w-4" />;
  }
}

export function WorkspaceShell({
  layout,
  connectivity,
  pendingDraftCount,
  activePreview,
  onSelectCategory,
  onActivateTab,
  onCloseTab,
  onToggleRightSidebar,
}: WorkspaceShellProps): ReactElement {
  const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      {connectivity !== 'online' && (
        <div
          role="status"
          className="flex items-center justify-between border-b border-amber-700 bg-amber-950/80 px-4 py-2 text-xs text-amber-200"
        >
          <span className="flex items-center gap-2">
            <WifiOff className="h-4 w-4" />
            Offline read-only mode active ({pendingDraftCount} local draft(s) queued for safe sync)
          </span>
        </div>
      )}

      <PanelGroup direction="horizontal" className="flex-1">
        {!layout.columns.leftCollapsed && (
          <>
            <Panel defaultSize={20} minSize={14} maxSize={35}>
              <aside
                aria-label="Project Artifacts"
                className="h-full border-r border-slate-800 p-3"
              >
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Project Artifacts
                </p>
                <nav className="flex flex-col gap-1">
                  {SIDEBAR_CATEGORIES.map((category) => {
                    const isActive = layout.activeCategory === category;
                    return (
                      <button
                        key={category}
                        type="button"
                        onClick={() => onSelectCategory(category)}
                        className={`flex items-center gap-2 rounded px-3 py-2 text-left text-sm ${
                          isActive
                            ? 'bg-indigo-600/20 text-indigo-200'
                            : 'text-slate-300 hover:bg-slate-900'
                        }`}
                      >
                        {renderCategoryIcon(category)}
                        <span>{CATEGORY_LABELS[category]}</span>
                      </button>
                    );
                  })}
                </nav>
              </aside>
            </Panel>
            <PanelResizeHandle className="w-1 bg-slate-800 hover:bg-indigo-500" />
          </>
        )}

        <Panel minSize={35}>
          <section aria-label="Dynamic Workspace" className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 px-2">
              <div role="tablist" className="flex items-center gap-1 overflow-x-auto py-1">
                {layout.tabs.map((tab) => {
                  const selected = tab.id === layout.activeTabId;
                  return (
                    <div
                      key={tab.id}
                      role="tab"
                      aria-selected={selected}
                      className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs ${
                        selected ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900'
                      }`}
                    >
                      <button type="button" onClick={() => onActivateTab(tab.id)}>
                        {tab.title}
                        {tab.isReadOnly ? ' (Read-Only)' : ''}
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${tab.title}`}
                        onClick={() => onCloseTab(tab.id)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={onToggleRightSidebar}
                className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-900"
              >
                {layout.columns.rightCollapsed ? 'Show Raven' : 'Hide Raven'}
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              {activePreview ? (
                <FilePreviewPane
                  fileName={activePreview.fileName}
                  preview={activePreview.preview}
                />
              ) : activeTab ? (
                <div className="p-6">
                  <h2 className="text-lg font-medium">{activeTab.title}</h2>
                  <p className="text-xs text-slate-400">Active View: {activeTab.viewType}</p>
                </div>
              ) : (
                <div className="p-6 text-sm text-slate-400">
                  Select an artifact or press Ctrl+P to Quick Open.
                </div>
              )}
            </div>
          </section>
        </Panel>

        {!layout.columns.rightCollapsed && (
          <>
            <PanelResizeHandle className="w-1 bg-slate-800 hover:bg-indigo-500" />
            <Panel defaultSize={25} minSize={18} maxSize={40}>
              <aside
                aria-label="Raven AI Assistant"
                className="h-full border-l border-slate-800 p-4"
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-indigo-300">
                  <Sparkles className="h-4 w-4" />
                  <span>Raven Research Copilot</span>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  Explicit context controls and reviewable diff proposals activate in Phase 4.
                </p>
              </aside>
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}
