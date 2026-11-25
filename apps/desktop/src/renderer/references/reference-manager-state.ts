import {
  canRoleMutateReferences,
  ReferenceManagerViewStateSchema,
  type ProjectRole,
  type Reference,
  type ReferenceManagerViewState,
  type ReferenceSortField,
  type SortOrder,
} from '@sunrise/shared';

export interface ReferenceManagerController {
  readonly getState: () => ReferenceManagerViewState;
  readonly selectReference: (referenceId: string | null) => ReferenceManagerViewState;
  readonly setActiveTag: (tag: string | null) => ReferenceManagerViewState;
  readonly setSearchQuery: (query: string) => ReferenceManagerViewState;
  readonly setSorting: (
    sortBy: ReferenceSortField,
    sortOrder: SortOrder,
  ) => ReferenceManagerViewState;
  readonly filterReferences: (references: readonly Reference[]) => Reference[];
}

function matchesSearchQuery(ref: Reference, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  const fields = [
    ref.title,
    ref.citeKey,
    ref.journal ?? '',
    ref.doi ?? '',
    ref.notes,
    ...ref.tags,
    ...ref.authors.map((author) => `${author.displayName} ${author.family}`),
  ];
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function compareByField(a: Reference, b: Reference, sortBy: ReferenceSortField): number {
  switch (sortBy) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'year':
      return (a.year ?? -1) - (b.year ?? -1);
    case 'citationCount':
      return (a.citationCount ?? -1) - (b.citationCount ?? -1);
    case 'createdAt':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updatedAt':
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}

export function createReferenceManagerController(
  projectId: string,
  role: ProjectRole,
): ReferenceManagerController {
  let state: ReferenceManagerViewState = ReferenceManagerViewStateSchema.parse({
    projectId,
    selectedReferenceId: null,
    activeTag: null,
    searchQuery: '',
    sortBy: 'updatedAt',
    sortOrder: 'desc',
    isReadOnly: !canRoleMutateReferences(role),
  });

  const snapshot = (): ReferenceManagerViewState => ({ ...state });

  return {
    getState: snapshot,

    selectReference: (referenceId): ReferenceManagerViewState => {
      state = ReferenceManagerViewStateSchema.parse({
        ...state,
        selectedReferenceId: referenceId,
      });
      return snapshot();
    },

    setActiveTag: (tag): ReferenceManagerViewState => {
      const normalized = tag !== null && tag.trim().length > 0 ? tag.trim() : null;
      state = ReferenceManagerViewStateSchema.parse({
        ...state,
        activeTag: normalized,
      });
      return snapshot();
    },

    setSearchQuery: (query): ReferenceManagerViewState => {
      state = ReferenceManagerViewStateSchema.parse({
        ...state,
        searchQuery: query.slice(0, 300),
      });
      return snapshot();
    },

    setSorting: (sortBy, sortOrder): ReferenceManagerViewState => {
      state = ReferenceManagerViewStateSchema.parse({
        ...state,
        sortBy,
        sortOrder,
      });
      return snapshot();
    },

    filterReferences: (references): Reference[] => {
      const activeTagLower = state.activeTag?.toLowerCase() ?? null;
      const filtered = references.filter((ref) => {
        if (activeTagLower !== null) {
          const hasTag = ref.tags.some((tag) => tag.toLowerCase() === activeTagLower);
          if (!hasTag) {
            return false;
          }
        }
        return matchesSearchQuery(ref, state.searchQuery);
      });
      const factor = state.sortOrder === 'asc' ? 1 : -1;
      return [...filtered].sort((a, b) => compareByField(a, b, state.sortBy) * factor);
    },
  };
}
