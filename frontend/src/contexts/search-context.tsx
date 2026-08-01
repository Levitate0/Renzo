"use client";

// ---------------------------------------------------------------------------
// Global search state. In the old app typing in the topbar search replaced the
// discover grid with results (doSearch(), app.js:697). The browse agent
// consumes this context on `/`: when `active` is true it renders
// GET /discover/search?q=<debouncedQuery>&type=<searchType> instead of the
// browse rows. The topbar search box writes here (320ms debounce, old value).
// ---------------------------------------------------------------------------

import React, { createContext, useCallback, useContext, useState } from "react";
import { useDebounce } from "use-debounce";

export type SearchType = "" | "series" | "movie";

interface SearchContextValue {
  /** Raw input value (undebounced — bind the topbar input to this). */
  query: string;
  setQuery: (q: string) => void;
  /** Debounced (320ms) — fetch results from this. */
  debouncedQuery: string;
  searchType: SearchType;
  setSearchType: (t: SearchType) => void;
  /** True when search results should replace the discover grid. */
  active: boolean;
  clearSearch: () => void;
}

const SearchContext = createContext<SearchContextValue | undefined>(undefined);

// Set right before the search box navigates to `/` so the remounted topbar
// input can restore focus (pages remount the shell on route change).
let focusPending = false;
export function markSearchFocusPending(): void {
  focusPending = true;
}
export function consumeSearchFocusPending(): boolean {
  const v = focusPending;
  focusPending = false;
  return v;
}

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState<SearchType>("");
  const [debouncedQuery] = useDebounce(query, 320);

  const clearSearch = useCallback(() => setQuery(""), []);

  return (
    <SearchContext.Provider
      value={{
        query,
        setQuery,
        debouncedQuery,
        searchType,
        setSearchType,
        active: debouncedQuery.trim().length > 0,
        clearSearch,
      }}
    >
      {children}
    </SearchContext.Provider>
  );
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useSearch must be used within SearchProvider");
  return ctx;
}
