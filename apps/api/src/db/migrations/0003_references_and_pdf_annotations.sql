CREATE UNIQUE INDEX IF NOT EXISTS uq_project_files_active_sibling
  ON project_files (
    project_id,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    LOWER(name)
  )
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_project_files_project_id_id'
  ) THEN
    ALTER TABLE project_files
      ADD CONSTRAINT uq_project_files_project_id_id UNIQUE (project_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS project_references (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cite_key TEXT NOT NULL,
  title TEXT NOT NULL,
  authors JSONB NOT NULL DEFAULT '[]'::jsonb,
  year INTEGER CHECK (year IS NULL OR (year >= 1450 AND year <= 2100)),
  journal TEXT,
  published TEXT,
  doi TEXT,
  url TEXT,
  abstract TEXT,
  volume TEXT,
  issue TEXT,
  pages TEXT,
  citation_count INTEGER CHECK (citation_count IS NULL OR citation_count >= 0),
  pdf_url TEXT,
  local_pdf_file_id UUID,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  source_provider TEXT NOT NULL CHECK (
    source_provider IN ('openalex', 'crossref', 'pubmed', 'doi', 'pdf', 'bibtex', 'ris', 'manual')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_project_references_project_id_id UNIQUE (project_id, id),
  CONSTRAINT fk_project_references_local_pdf
    FOREIGN KEY (project_id, local_pdf_file_id)
    REFERENCES project_files (project_id, id)
    ON DELETE SET NULL (local_pdf_file_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_references_project_cite_key
  ON project_references (project_id, LOWER(cite_key));

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_references_project_doi
  ON project_references (project_id, doi)
  WHERE doi IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_references_project_updated
  ON project_references (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_references_local_pdf
  ON project_references (local_pdf_file_id)
  WHERE local_pdf_file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pdf_annotations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id UUID NOT NULL,
  reference_id UUID,
  page_number INTEGER NOT NULL CHECK (page_number >= 1 AND page_number <= 10000),
  selected_text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow' CHECK (
    color IN ('yellow', 'green', 'blue', 'pink', 'purple')
  ),
  rects JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pdf_annotations_file
    FOREIGN KEY (project_id, file_id)
    REFERENCES project_files (project_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pdf_annotations_reference
    FOREIGN KEY (project_id, reference_id)
    REFERENCES project_references (project_id, id)
    ON DELETE SET NULL (reference_id)
);

CREATE INDEX IF NOT EXISTS idx_pdf_annotations_project_file_page
  ON pdf_annotations (project_id, file_id, page_number);

CREATE INDEX IF NOT EXISTS idx_pdf_annotations_reference_id
  ON pdf_annotations (reference_id)
  WHERE reference_id IS NOT NULL;
