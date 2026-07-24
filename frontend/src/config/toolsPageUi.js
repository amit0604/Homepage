/**
 * UI copy for the public Help library page (apps gallery + man-page view).
 *
 * The Help library reads its content directly from the home-page apps (shortcuts).
 * Each tile opens an inline man-page with summary, use cases, and examples.
 */
export const toolsPageUi = {
  public: {
    pageTitle: 'Help library',
    pageLede:
      'Browse every app available from the home page and open its man-page for purpose, use cases, and examples.',
    loading: 'Loading…',
    emptyTitle: 'No apps yet',
    emptyHint: 'Admins can add apps under Admin → Shortcuts.',
    tileCta: 'Open man-page',
    closeModalAria: 'Close',
    searchPlaceholder: 'Filter apps by name, URL, or category...',
    allCategory: 'All',
    backToGallery: 'Back to gallery',
    openApp: 'Open app',
    summaryHeading: 'Summary',
    useCasesHeading: 'Use cases',
    examplesHeading: 'Examples',
    noSummary: 'No summary has been written for this app yet.',
    copyExample: 'Copy',
    noResults: 'No apps match your search.',
  },

  /** Fallback labels when API data is missing a title or category */
  fallbacks: {
    app: 'Untitled app',
    category: 'General',
  },
};
