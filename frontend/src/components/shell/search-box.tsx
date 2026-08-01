"use client";

// Topbar search — writes to the search context (320ms debounce there); search
// results replace the discover grid on `/`, so typing anywhere navigates home
// first (old doSearch() called switchTab("discover")). ⌘K / Ctrl-K focuses the
// box from any page. Type select filters series/movies (old #searchType).

import { Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import React, { useEffect, useRef } from "react";

import {
  consumeSearchFocusPending,
  markSearchFocusPending,
  useSearch,
  type SearchType,
} from "@/contexts/search-context";

export function SearchBox() {
  const { query, setQuery, searchType, setSearchType } = useSearch();
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);

  const goDiscover = () => {
    if (pathname !== "/") {
      markSearchFocusPending();
      router.push("/");
    }
  };

  // ⌘K / Ctrl-K focuses search (and jumps to discover, like the old app).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (pathname !== "/") {
          markSearchFocusPending();
          router.push("/");
        }
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [pathname, router]);

  // The shell remounts on navigation (pages wrap themselves in AppShell), so
  // restore focus after a typing-triggered jump to `/`.
  useEffect(() => {
    if (consumeSearchFocusPending()) inputRef.current?.focus();
  }, []);

  return (
    <div className="search flex min-w-0 items-center gap-2">
      <div className="search-box relative flex items-center">
        <Search className="search-ic pointer-events-none absolute left-2.5 h-4 w-4 text-muted-foreground" />
        <input
          id="search"
          ref={inputRef}
          type="search"
          name="renzo-search"
          placeholder="Search anime…"
          aria-label="Search anime"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim()) goDiscover();
          }}
          className="h-9 w-36 rounded-full border border-border bg-card pl-8 pr-10 text-sm outline-none transition-colors focus:border-ring focus:bg-background sm:w-48 xl:w-64 [&::-webkit-search-cancel-button]:appearance-none"
        />
        <kbd className="kbd pointer-events-none absolute right-2.5 hidden items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground xl:inline-flex">
          ⌘K
        </kbd>
      </div>
      <select
        id="searchType"
        title="Type"
        value={searchType}
        onChange={(e) => {
          setSearchType(e.target.value as SearchType);
          if (query.trim()) goDiscover();
        }}
        className="hidden h-9 shrink-0 rounded-full border border-border bg-card px-2.5 text-sm text-muted-foreground outline-none focus:border-ring md:block"
      >
        <option value="">All</option>
        <option value="series">Series</option>
        <option value="movie">Movies</option>
      </select>
    </div>
  );
}
