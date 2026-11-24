import {
  searchQuickOpenItems,
  type QuickOpenItem,
  type QuickOpenResultItem,
} from '@sunrise/shared';

export interface QuickOpenIndex {
  readonly search: (query: string, limit?: number) => QuickOpenResultItem[];
  readonly updateItems: (items: readonly QuickOpenItem[]) => void;
  readonly size: () => number;
}

export function createQuickOpenIndex(initialItems: readonly QuickOpenItem[]): QuickOpenIndex {
  let corpus: readonly QuickOpenItem[] = [...initialItems];

  return {
    search: (query, limit = 25): QuickOpenResultItem[] =>
      searchQuickOpenItems(corpus, query, limit),
    updateItems: (nextItems): void => {
      corpus = [...nextItems];
    },
    size: (): number => corpus.length,
  };
}
