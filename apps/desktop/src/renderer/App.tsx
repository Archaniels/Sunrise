import type { ReactElement } from 'react';

export interface SunriseShellProps {
  readonly version: string;
}

export function SunriseShell({ version }: SunriseShellProps): ReactElement {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <header className="border-b border-slate-800 pb-4">
        <h1 className="text-xl font-semibold">Sunrise Research Workspace</h1>
        <p className="text-sm text-slate-400">Desktop Shell v{version}</p>
      </header>
    </main>
  );
}
