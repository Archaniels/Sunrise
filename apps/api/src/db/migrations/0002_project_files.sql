CREATE TABLE IF NOT EXISTS project_files (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES project_files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  virtual_path TEXT NOT NULL,
  is_folder BOOLEAN NOT NULL DEFAULT FALSE,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  s3_key TEXT,
  checksum_sha256 TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_files_project_parent ON project_files(project_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_project_files_project_deleted ON project_files(project_id, deleted_at);
