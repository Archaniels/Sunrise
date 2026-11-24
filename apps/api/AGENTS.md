# apps/api — Scoped Governance (Cloud API Backend)

## Mandate

`apps/api` hosts Sunrise's cloud-first backend: authentication & RBAC, S3/MinIO file storage, PostgreSQL + `pgvector` persistence, federated literature search (OpenAlex, Crossref, PubMed), bibliography & CSL citation formatting, document persistence & export, BYOK envelope-encrypted key vault, Raven agent orchestration, Source Audit, background KB indexing (`pg-boss`), and pluggable isolated compute execution.

## Strict Layer Boundaries

- `src/controllers/` — Thin Fastify HTTP/SSE/WebSocket route handlers. Validate inputs with `packages/shared` Zod schemas, enforce auth/RBAC middleware, delegate to `src/services/`. Zero business logic or inline SQL.
- `src/services/` — Domain logic and orchestration as plain typed modules/functions. Zero wrapper classes and zero Fastify request/reply coupling.
- `src/db/` — Drizzle/PostgreSQL + `pgvector` migrations, transactions, and typed repositories only.

## Security & Reliability Invariants

- BYOK API keys MUST be AES-256-GCM envelope-encrypted at rest, never returned in plaintext, and never logged.
- Every project resource endpoint MUST verify authenticated membership and RBAC role (`owner | editor | viewer`).
- Compute execution MUST run inside resource-capped isolated containers/sandboxes and require explicit user approval when triggered by Raven.
- All external adapters (Postgres, S3, LLM providers, academic APIs, compute runners) MUST sit behind typed interfaces so unit/contract tests run deterministically without network or Docker.
