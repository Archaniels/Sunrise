# Sunrise — Root Engineering Governance (Electron Software Factory)

Sunrise is a **Full-Stack AI Research Workspace** built as a TypeScript monorepo combining a **Cloud-First Backend** (`apps/api`) with a **Hardened Electron Desktop Wrapper** (`apps/desktop`) and **Pure Shared Contracts** (`packages/shared`).

## 1. Product Invariants

- **The Researcher Remains the Author:** Raven never silently overwrites user documents. Every document edit must pass through a typed reviewable diff proposal (`[Accept]` / `[Reject]`).
- **Three-Column Interaction Model:** Left (Project Artifacts), Center (Dynamic Workspace), Right (Raven AI Assistant), Foundation (Cloud Storage + Compute via Electron).
- **BYOK-Only with Envelope-Encrypted Cloud Vault:** Users supply OpenAI, Anthropic, or Gemini keys. Keys are envelope-encrypted at rest (`AES-256-GCM`), never returned in plaintext, and never logged.
- **Tiered Agent Approval:** Read-only tools auto-run; document edits always produce inline diff proposals; side-effecting operations (code execution, file writes/deletes, saving references) require explicit user approval.

## 2. Monorepo Boundaries

Load ONLY the scoped `AGENTS.md` matching the workspace you are touching:
- `packages/shared/AGENTS.md` — Pure TS types, Zod schemas, IPC/API/DTO contracts (zero Node, Electron, DOM, React, or DB imports).
- `apps/desktop/AGENTS.md` — Electron Main (`controllers/`, `services/`, `db/`), Preload (`contextBridge` only), Renderer (React UI).
- `apps/api/AGENTS.md` — Cloud API (`controllers/`, `services/`, `db/`), Postgres + `pgvector`, S3/MinIO, BYOK Vault, Raven Agent, Pluggable Compute Runner.

## 3. Static Quality & Security Standards

All TypeScript code, contracts, and tests MUST satisfy:
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- Zero `any`, zero unsafe casts (`as unknown as ...`), zero `@ts-ignore`, zero `@ts-expect-error`, zero `eslint-disable`.
- Zero general comments (`//`, `/* */`, `TODO`, `FIXME`) in source, contract, and test files. Code and names must be self-documenting.
- Cyclomatic complexity cap: `<= 10` per function; max nesting depth `<= 3`.
- Dependency governance: Every installed package MUST be listed in `allowed-dependencies.json`. Unallowlisted dependencies require explicit Human Gate approval before installation.

## 4. Electron Software Factory Stages

Every sub-phase in `ROADMAP.md` executes strictly in order:
1. **Stage 1 — Horizon (Contracts & Failing Tests):** Define schemas/contracts in `packages/shared/` and write executable failing tests in `tests/`. Zero production code.
2. **Human Gate — Mayflower & Owner:** Approve contracts, failing tests, and any `allowed-dependencies.json` delta.
3. **Stage 2 — Indigo (Implementation):** Implement production code to make all Stage 1 tests pass and satisfy `pnpm verify`.
4. **Stage 3 — Nex (Verification & Audit):** Independent verification of tests, failure modes, security, accessibility, and performance.

## 5. Status Reporting Protocol

Both AI agents and developers MUST keep `ROADMAP.md` and `docs/status/phases.json` synchronized at every stage transition. Run `pnpm verify` before claiming any sub-phase complete.
