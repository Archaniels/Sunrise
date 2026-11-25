import type { Reference, ReferenceManagerViewState } from '@sunrise/shared';
import {
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { FileText, Paperclip, Search, Tag } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';

export interface ReferenceManagerViewProps {
  readonly viewState: ReferenceManagerViewState;
  readonly references: readonly Reference[];
  readonly availableTags: readonly string[];
  readonly onSelectReference: (referenceId: string) => void;
  readonly onChangeTag: (tag: string | null) => void;
  readonly onChangeSearch: (query: string) => void;
  readonly onUpdateNotes?: (referenceId: string, notes: string) => void;
  readonly onAttachPdf?: (referenceId: string) => void;
}

const referenceTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
});

type ReferenceColumnDef = ColumnDef<typeof referenceTableFeatures, Reference>;

function readControlValue(target: unknown): string {
  if (typeof target === 'object' && target !== null && 'value' in target) {
    const value = Reflect.get(target, 'value');
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function formatAuthorsSummary(ref: Reference): string {
  if (ref.authors.length === 0) {
    return 'Unknown';
  }
  const first = ref.authors[0]?.displayName ?? 'Unknown';
  return ref.authors.length > 1 ? `${first} et al.` : first;
}

export function ReferenceManagerView({
  viewState,
  references,
  availableTags,
  onSelectReference,
  onChangeTag,
  onChangeSearch,
  onUpdateNotes,
  onAttachPdf,
}: ReferenceManagerViewProps): ReactElement {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ReadonlyArray<ReferenceColumnDef>>(
    () => [
      {
        accessorKey: 'citeKey',
        header: 'Cite Key',
        cell: ({ row }) => (
          <span className="font-mono text-xs text-indigo-300">@{row.original.citeKey}</span>
        ),
      },
      {
        accessorKey: 'title',
        header: 'Title',
        cell: ({ row }) => (
          <button
            type="button"
            aria-pressed={row.original.id === viewState.selectedReferenceId}
            onClick={(event) => {
              event.stopPropagation();
              onSelectReference(row.original.id);
            }}
            className="text-left font-medium text-slate-100 hover:text-indigo-300 focus:underline focus:outline-none"
          >
            {row.original.title}
          </button>
        ),
      },
      {
        id: 'authors',
        header: 'Authors',
        cell: ({ row }) => (
          <span className="text-xs text-slate-300">{formatAuthorsSummary(row.original)}</span>
        ),
      },
      {
        accessorKey: 'year',
        header: 'Year',
        cell: ({ row }) => (
          <span className="text-xs text-slate-400">{row.original.year ?? 'n.d.'}</span>
        ),
      },
      {
        accessorKey: 'citationCount',
        header: 'Citations',
        cell: ({ row }) => (
          <span className="text-xs text-slate-400">{row.original.citationCount ?? '-'}</span>
        ),
      },
      {
        id: 'pdf',
        header: 'PDF',
        enableSorting: false,
        cell: ({ row }) => {
          const hasPdf = row.original.localPdfFileId !== null || row.original.pdfUrl !== null;
          return hasPdf ? (
            <FileText className="h-4 w-4 text-emerald-400" aria-label="PDF attached" />
          ) : (
            <span className="text-xs text-slate-500">None</span>
          );
        },
      },
    ],
    [onSelectReference, viewState.selectedReferenceId],
  );

  const tableData = useMemo(() => [...references], [references]);
  const table = useTable({
    features: referenceTableFeatures,
    data: tableData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
  });

  const selectedRef = references.find((item) => item.id === viewState.selectedReferenceId) ?? null;

  return (
    <div className="flex h-full flex-col gap-3 bg-slate-950 p-4 text-slate-100">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex flex-1 items-center">
          <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-slate-400" />
          <input
            type="search"
            aria-label="Filter project references"
            value={viewState.searchQuery}
            onChange={(event) => onChangeSearch(readControlValue(event.currentTarget))}
            placeholder="Search title, author, citeKey, DOI..."
            className="w-full rounded border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-3 text-sm text-slate-100"
          />
        </label>
        <div className="flex items-center gap-1">
          <Tag className="h-4 w-4 text-slate-400" />
          <button
            type="button"
            onClick={() => onChangeTag(null)}
            className={`rounded px-2 py-1 text-xs ${
              viewState.activeTag === null
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-900 text-slate-300'
            }`}
          >
            All
          </button>
          {availableTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onChangeTag(tag)}
              className={`rounded px-2 py-1 text-xs ${
                viewState.activeTag === tag
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-300'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded border border-slate-800">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-900 text-xs uppercase text-slate-400">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDirection = header.column.getIsSorted();
                  const ariaSort =
                    sortDirection === 'asc'
                      ? 'ascending'
                      : sortDirection === 'desc'
                        ? 'descending'
                        : canSort
                          ? 'none'
                          : undefined;
                  return (
                    <th key={header.id} aria-sort={ariaSort} className="px-3 py-2 font-semibold">
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex w-full items-center gap-1 text-left font-semibold uppercase hover:text-slate-200 focus:underline focus:outline-none"
                        >
                          <table.FlexRender header={header} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const isSelected = row.original.id === viewState.selectedReferenceId;
              return (
                <tr
                  key={row.id}
                  onClick={() => onSelectReference(row.original.id)}
                  className={`cursor-pointer border-b border-slate-800/70 ${
                    isSelected ? 'bg-indigo-950/60' : 'hover:bg-slate-900/70'
                  }`}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-top">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedRef !== null && (
        <section
          aria-label="Selected Reference Details"
          className="rounded border border-slate-800 bg-slate-900/70 p-3 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-white">{selectedRef.title}</h3>
              <p className="text-slate-400">
                @{selectedRef.citeKey} · {selectedRef.journal ?? 'Unpublished'} ·{' '}
                {selectedRef.doi ?? 'No DOI'}
              </p>
            </div>
            {!viewState.isReadOnly && onAttachPdf !== undefined && (
              <button
                type="button"
                onClick={() => onAttachPdf(selectedRef.id)}
                className="flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
              >
                <Paperclip className="h-3.5 w-3.5" />
                Attach PDF
              </button>
            )}
          </div>
          <label className="mt-2 block">
            <span className="text-slate-400">Research Notes</span>
            <textarea
              aria-label="Reference notes"
              readOnly={viewState.isReadOnly}
              value={selectedRef.notes}
              onChange={(event) =>
                onUpdateNotes?.(selectedRef.id, readControlValue(event.currentTarget))
              }
              rows={3}
              className="mt-1 w-full rounded border border-slate-800 bg-slate-950 p-2 text-xs text-slate-100"
            />
          </label>
        </section>
      )}
    </div>
  );
}
