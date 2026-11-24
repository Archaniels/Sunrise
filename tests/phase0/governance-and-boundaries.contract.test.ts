import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PhaseTrackerSchema } from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const FORBIDDEN_SHARED_IMPORTS = [
  'node:',
  'fs',
  'path',
  'crypto',
  'child_process',
  'os',
  'http',
  'https',
  'electron',
  'react',
  'react-dom',
  'pg',
  'fastify',
  'drizzle-orm',
];

function collectTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      results.push(fullPath);
    }
  }
  return results;
}

function collectAnyTypeNodes(node: ts.Node, findings: string[]): void {
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    findings.push(`any:${node.getStart()}`);
  }
  ts.forEachChild(node, (child) => {
    collectAnyTypeNodes(child, findings);
  });
}

function findCommentsAndAnyKeywords(filePath: string, sourceText: string): string[] {
  const findings: string[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      findings.push(`comment:${scanner.getTokenPos()}`);
    }
    token = scanner.scan();
  }
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true);
  collectAnyTypeNodes(sourceFile, findings);
  return findings;
}

function extractModuleSpecifiers(filePath: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

interface PackageJsonShape {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface AllowlistShape {
  readonly approvedPhases: Readonly<
    Record<string, { readonly packages: Readonly<Record<string, string>> }>
  >;
}

describe('Phase 0 governance, allowlist, and static boundary hygiene', () => {
  it('has required root and scoped AGENTS.md governance files and ROADMAP.md', () => {
    const requiredFiles = [
      'AGENTS.md',
      'packages/shared/AGENTS.md',
      'apps/desktop/AGENTS.md',
      'apps/api/AGENTS.md',
      'allowed-dependencies.json',
      'ROADMAP.md',
      'docs/status/phases.json',
      '.env.example',
    ];
    for (const rel of requiredFiles) {
      expect(existsSync(join(REPO_ROOT, rel)), `Missing required file: ${rel}`).toBe(true);
    }
  });

  it('validates docs/status/phases.json against PhaseTrackerSchema with 8 phases and 31 sub-phases', () => {
    const raw = readFileSync(join(REPO_ROOT, 'docs/status/phases.json'), 'utf8');
    const parsed = PhaseTrackerSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const subPhaseCount = parsed.data.phases.reduce(
        (total, phase) => total + phase.subPhases.length,
        0,
      );
      expect(subPhaseCount).toBe(31);
      expect(parsed.data.activePhase).toBe(0);
    }
  });

  it('ensures every declared package across workspaces is approved in allowed-dependencies.json', () => {
    const allowlistRaw = readFileSync(join(REPO_ROOT, 'allowed-dependencies.json'), 'utf8');
    const allowlist = JSON.parse(allowlistRaw) as AllowlistShape;
    const approvedPackages = new Set<string>();
    for (const phaseEntry of Object.values(allowlist.approvedPhases)) {
      for (const pkgName of Object.keys(phaseEntry.packages)) {
        approvedPackages.add(pkgName);
      }
    }

    const packageJsonPaths = [
      'package.json',
      'packages/shared/package.json',
      'apps/api/package.json',
      'apps/desktop/package.json',
    ];

    for (const relPath of packageJsonPaths) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8')) as PackageJsonShape;
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [depName, versionRange] of Object.entries(allDeps)) {
        if (versionRange.startsWith('workspace:')) {
          continue;
        }
        expect(
          approvedPackages.has(depName),
          `Unapproved dependency "${depName}" found in ${relPath}`,
        ).toBe(true);
      }
    }
  });

  it('enforces zero Node, Electron, React, or DB imports in packages/shared/src', () => {
    const sharedFiles = collectTypeScriptFiles(join(REPO_ROOT, 'packages/shared/src'));
    expect(sharedFiles.length).toBeGreaterThan(0);

    for (const filePath of sharedFiles) {
      const text = readFileSync(filePath, 'utf8');
      const specifiers = extractModuleSpecifiers(filePath, text);
      for (const specifier of specifiers) {
        const isForbidden = FORBIDDEN_SHARED_IMPORTS.some(
          (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`) || specifier.startsWith('node:'),
        );
        expect(isForbidden, `Forbidden import "${specifier}" in ${filePath}`).toBe(false);
      }
    }
  });

  it('enforces zero comments and zero any keywords across Stage 1 contracts and tests', () => {
    const auditedFiles = [
      ...collectTypeScriptFiles(join(REPO_ROOT, 'packages/shared/src')),
      ...collectTypeScriptFiles(join(REPO_ROOT, 'tests/phase0')),
    ];
    expect(auditedFiles.length).toBeGreaterThan(0);

    for (const filePath of auditedFiles) {
      const text = readFileSync(filePath, 'utf8');
      const findings = findCommentsAndAnyKeywords(filePath, text);
      expect(findings, `Static hygiene violations in ${filePath}: ${findings.join(', ')}`).toEqual(
        [],
      );
    }
  });
});
