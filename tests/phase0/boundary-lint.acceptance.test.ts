import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface RootPackageShape {
  readonly scripts?: Readonly<Record<string, string>>;
}

describe('Phase 0.1 and 0.4 ESLint boundary enforcement and verification pipeline acceptance', () => {
  it('provides eslint.config.mjs enforcing cross-layer import bans, complexity cap, and no-explicit-any', () => {
    const eslintPath = join(REPO_ROOT, 'eslint.config.mjs');
    expect(existsSync(eslintPath), 'Missing eslint.config.mjs at repository root').toBe(true);

    const content = readFileSync(eslintPath, 'utf8');
    expect(content).toContain('no-restricted-imports');
    expect(content).toContain('complexity');
    expect(content).toContain('no-explicit-any');
    expect(content).toContain('apps/desktop/src/renderer');
    expect(content).toContain('packages/shared');
  });

  it('wires lint, typecheck, and test into root verify script', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootPackageShape;
    const verifyScript = pkg.scripts?.['verify'] ?? '';
    expect(verifyScript).toContain('lint');
    expect(verifyScript).toContain('typecheck');
    expect(verifyScript).toContain('test');
  });
});
