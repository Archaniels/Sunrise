import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function lintVirtualFile(relativePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintText(code, {
    filePath: resolve(REPO_ROOT, relativePath),
  });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId ?? 'unknown-rule'),
  );
}

describe('Phase 0.1 ESLint boundary and static hygiene enforcement', () => {
  it('blocks renderer imports of Node built-ins and Electron', async () => {
    const fsRules = await lintVirtualFile(
      'apps/desktop/src/renderer/violation-fs.ts',
      "import { readFileSync } from 'node:fs';\nexport const fn = readFileSync;\n",
    );
    expect(fsRules).toContain('no-restricted-imports');

    const electronRules = await lintVirtualFile(
      'apps/desktop/src/renderer/violation-electron.ts',
      "import { ipcRenderer } from 'electron';\nexport const ipc = ipcRenderer;\n",
    );
    expect(electronRules).toContain('no-restricted-imports');
  });

  it('blocks shared imports of Node built-ins and framework packages', async () => {
    const sharedNodeRules = await lintVirtualFile(
      'packages/shared/src/violation-node.ts',
      "import { join } from 'node:path';\nexport const p = join;\n",
    );
    expect(sharedNodeRules).toContain('no-restricted-imports');

    const sharedReactRules = await lintVirtualFile(
      'packages/shared/src/violation-react.ts',
      "import React from 'react';\nexport const r = React;\n",
    );
    expect(sharedReactRules).toContain('no-restricted-imports');
  });

  it('blocks API controllers from importing DB modules and API services from importing Fastify', async () => {
    const controllerDbRules = await lintVirtualFile(
      'apps/api/src/controllers/violation-db.ts',
      "import { createPostgresProbe } from '../db/probes.js';\nexport const probe = createPostgresProbe;\n",
    );
    expect(controllerDbRules).toContain('no-restricted-imports');

    const serviceFastifyRules = await lintVirtualFile(
      'apps/api/src/services/violation-fastify.ts',
      "import fastify from 'fastify';\nexport const app = fastify;\n",
    );
    expect(serviceFastifyRules).toContain('no-restricted-imports');
  });

  it('blocks desktop main controllers from importing local DB modules', async () => {
    const desktopControllerDbRules = await lintVirtualFile(
      'apps/desktop/src/main/controllers/violation-db.ts',
      "import { cache } from '../db/cache.js';\nexport const value = cache;\n",
    );
    expect(desktopControllerDbRules).toContain('no-restricted-imports');
  });

  it('rejects general comments, explicit any, and non-null assertions', async () => {
    const commentRules = await lintVirtualFile(
      'apps/api/src/services/violation-comment.ts',
      'export const x = 1;\n// forbidden comment\n',
    );
    expect(commentRules).toContain('sunrise/no-comments');

    const anyRules = await lintVirtualFile(
      'apps/api/src/services/violation-any.ts',
      'export function identity(value: any): unknown {\n  return value;\n}\n',
    );
    expect(anyRules).toContain('@typescript-eslint/no-explicit-any');

    const nonNullRules = await lintVirtualFile(
      'apps/api/src/services/violation-non-null.ts',
      'export function unwrap(value: string | undefined): string {\n  return value!;\n}\n',
    );
    expect(nonNullRules).toContain('@typescript-eslint/no-non-null-assertion');
  });
});
