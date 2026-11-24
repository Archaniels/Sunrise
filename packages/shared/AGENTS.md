# packages/shared — Scoped Governance

## Mandate
`packages/shared` is the single source of truth for cross-process and cross-service contracts between `apps/desktop` and `apps/api`.

## Allowed
- Pure TypeScript types and interfaces.
- Zod schemas for IPC channels, HTTP/SSE/WebSocket DTOs, domain entities, diff proposals, Source Audit verdicts, and status trackers.
- Pure deterministic helper functions with zero I/O or runtime platform dependencies.

## Strictly Forbidden
- Any import of Node.js built-ins (`node:*`, `fs`, `path`, `crypto`, `process`, etc.).
- Any import of `electron`, `react`, `react-dom`, DOM APIs, or database/HTTP clients.
- Any `any`, unsafe cast, `@ts-ignore`, `eslint-disable`, or general comments (`//`, `/* */`).
