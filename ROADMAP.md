# Sunrise — Master Implementation Roadmap & Status Report

**Current Stage:** Phase 0 — Complete (Nex Stage 3/4 PASS; ready for Phase 1 Stage 1)  
**Machine-Readable Tracker:** `docs/status/phases.json`  
**Architecture Specification:** `docs/architecture/sunrise-architecture.md`

## Phase & Sub-Phase Status Matrix

| Phase | Sub-Phase | Objective                                                | Stage 1 (Horizon) | Human Gate | Stage 2 (Indigo) | Stage 3 (Nex) | Status          |
| ----- | --------- | -------------------------------------------------------- | ----------------- | ---------- | ---------------- | ------------- | --------------- |
| **0** | `0.1`     | Governance, Monorepo, Boundary Lint & Allowlist          | `[x]`             | `[x]`      | `[x]`            | `[x]`         | Done (Verified) |
| **0** | `0.2`     | Docker Compose (Postgres+pgvector, MinIO) & Migrations   | `[x]`             | `[x]`      | `[x]`            | `[x]`         | Done (Verified) |
| **0** | `0.3`     | Hardened Electron Shell & Typed IPC Baseline             | `[x]`             | `[x]`      | `[x]`            | `[x]`         | Done (Verified) |
| **0** | `0.4`     | Unified Verification Script & Status Tracker             | `[x]`             | `[x]`      | `[x]`            | `[x]`         | Done (Verified) |
| **1** | `1.1`     | Auth, RBAC Project Sharing & OS Keychain Session         | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **1** | `1.2`     | 3-Column Workspace Shell & Dynamic Artifact Tabs         | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **1** | `1.3`     | S3 File Explorer, Native OS Bridge & Previews            | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **1** | `1.4`     | Quick Open (`Ctrl+P`) & Offline Read-Only Cache/Drafts   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **2** | `2.1`     | Federated Literature Search (OpenAlex/Crossref/PubMed)   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **2** | `2.2`     | Project Bibliography DB & Reference Manager UI           | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **2** | `2.3`     | DOI, BibTeX/RIS & Deterministic PDF Metadata Ingestion   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **2** | `2.4`     | Integrated Academic PDF Viewer (`pdf.js`) & Highlights   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **3** | `3.1`     | TipTap Academic Editor, Comments, Autosave & Snapshots   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **3** | `3.2`     | Inline `@` Search-and-Insert & `[@citekey]` Parsing      | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **3** | `3.3`     | CSL Engine (APA/IEEE/MLA) & Auto-Updating Bibliography   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **3** | `3.4`     | Live LaTeX (KaTeX) & DOCX/PDF/MD/LaTeX Import-Export     | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **4** | `4.1`     | BYOK Envelope-Encrypted Vault & Multi-Provider Router    | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **4** | `4.2`     | Raven Sidebar, Explicit Context Pills & SSE Streaming    | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **4** | `4.3`     | Academic Action Buttons & Tiered Tool Approval Engine    | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **4** | `4.4`     | Reviewable Inline Diff Proposals (`[Accept]`/`[Reject]`) | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **5** | `5.1`     | Background PDF/Doc Extraction, Chunking & `pgvector` KB  | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **5** | `5.2`     | Hybrid Semantic Search & File/Page Deep-Link Citations   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **5** | `5.3`     | Source Audit Reviewer & Citation Fabrication Guardrails  | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **6** | `6.1`     | Pluggable Compute Runner (Docker Jupyter + DuckDB + E2B) | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **6** | `6.2`     | CSV/XLSX Data Grid & Code / Jupyter Notebook Editor      | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **6** | `6.3`     | Mermaid Split-Pane Diagram Editor & SVG/PNG Export       | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **6** | `6.4`     | Unified Figure Artifact Lifecycle & Document Insertion   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **7** | `7.1`     | Interactive Literature Map (OpenAlex Graph + Clusters)   | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **7** | `7.2`     | End-to-End Researcher Lifecycle Integration Suites       | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **7** | `7.3`     | Security, Performance & Accessibility Hardening Audit    | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |
| **7** | `7.4`     | Electron Installers, Cloud Deployment & Ops Runbooks     | `[ ]`             | `[ ]`      | `[ ]`            | `[ ]`         | Not Started     |

## Phase Milestones Summary

- **Phase 0:** Factory Foundation, Monorepo, Docker Compose Infrastructure & Hardened Electron IPC Baseline.
- **Phase 1:** Auth, RBAC Project Sharing, 3-Column Workspace Shell, S3 File Explorer, `Ctrl+P` Quick Open & Offline Resilience.
- **Phase 2:** Federated Literature Search (OpenAlex/Crossref/PubMed), Project Bibliography DB, DOI/BibTeX/RIS/PDF Ingestion & `pdf.js` Viewer.
- **Phase 3:** TipTap Academic Editor, Inline `@` Citations, CSL Formatter (APA/IEEE/MLA), Live LaTeX (KaTeX) & PDF/DOCX/MD/LaTeX Export.
- **Phase 4:** Raven AI Copilot, BYOK Envelope Vault, Explicit Context Pills, Action Buttons, Tiered Approval & Reviewable Diffs.
- **Phase 5:** Project Knowledge Base (`pgvector` RAG), Hybrid Semantic Search with File/Page Citations & Source Audit Reviewer.
- **Phase 6:** Isolated Cloud Compute (Docker Jupyter + DuckDB + E2B Interface), Data Grid, Notebooks, Mermaid Diagrams & Unified Figure Artifacts.
- **Phase 7:** OpenAlex Interactive Literature Map, Cross-Feature E2E Verification, Security/Performance/A11y Audit & Release Packaging.
