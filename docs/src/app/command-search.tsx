"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface PagefindResultData {
  url: string;
  excerpt: string;
  meta: {
    title?: string;
  };
  sub_results?: Array<{
    url: string;
    title: string;
    excerpt: string;
  }>;
}

interface PagefindClient {
  search: (query: string) => Promise<{
    results: Array<{ data: () => Promise<PagefindResultData> }>;
  }>;
}

interface SearchResult {
  url: string;
  group: string;
  title: string;
  excerpt: string;
}

let pagefindClient: PagefindClient | undefined;

function detectMacPlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  );
}

function stripMarkup(value: string) {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function normalizeResultUrl(url: string) {
  return url.replace(/\.html$/, "").replace(/\.html#/, "#") || "/";
}

async function loadPagefind() {
  if (!pagefindClient) {
    const pagefindUrl = "/_pagefind/pagefind.js";
    pagefindClient = (await import(
      /* webpackIgnore: true */ pagefindUrl
    )) as PagefindClient;
  }

  return pagefindClient;
}

async function searchDocumentation(query: string) {
  const client = await loadPagefind();
  const response = await client.search(query);
  const pages = await Promise.all(
    response.results.slice(0, 12).map((result) => result.data()),
  );

  return pages.flatMap<SearchResult>((page) => {
    const group = page.meta.title || "Documentation";
    const sections = page.sub_results?.length
      ? page.sub_results
      : [
          {
            url: page.url,
            title: group,
            excerpt: page.excerpt,
          },
        ];

    return sections.map((section) => ({
      url: normalizeResultUrl(section.url),
      group,
      title: section.title || group,
      excerpt: stripMarkup(section.excerpt),
    }));
  });
}

export function CommandSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestIdRef = useRef(0);
  const resultsId = useId();
  const pathname = usePathname();
  const router = useRouter();

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setResults([]);
    setError("");
    setActiveIndex(0);
  }, []);

  const openSearch = useCallback(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setIsOpen(true);
  }, []);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      closeSearch();

      if (result.url.startsWith("#")) {
        window.location.hash = result.url;
        return;
      }

      router.push(result.url);
    },
    [closeSearch, router],
  );

  useEffect(() => {
    setIsMounted(true);
    setIsMac(detectMacPlatform());
  }, []);

  useEffect(() => {
    closeSearch();
  }, [closeSearch, pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const platformModifier = isMac ? event.metaKey : event.ctrlKey;

      if (platformModifier && event.key.toLowerCase() === "k") {
        if (!triggerRef.current?.getClientRects().length) {
          return;
        }

        event.preventDefault();
        openSearch();
        return;
      }

      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        closeSearch();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeSearch, isMac, isOpen, openSearch]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    const requestId = ++requestIdRef.current;

    if (!trimmedQuery) {
      setResults([]);
      setError("");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError("");

    const timeout = window.setTimeout(async () => {
      try {
        const nextResults = await searchDocumentation(trimmedQuery);
        if (requestId !== requestIdRef.current) {
          return;
        }

        setResults(nextResults);
        setActiveIndex(0);
      } catch {
        if (requestId === requestIdRef.current) {
          setResults([]);
          setError("Search index is unavailable. Run the docs build and try again.");
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [query]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="command-search-trigger"
        aria-label={`Search documentation (${isMac ? "Command" : "Control"} K)`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        onClick={openSearch}
      >
        <span className="command-search-trigger__label">
          <Search aria-hidden="true" />
          <span>Search</span>
        </span>
        <kbd className="command-search-trigger__shortcut">
          <span>{isMac ? "⌘" : "Ctrl"}</span>
          <span>K</span>
        </kbd>
      </button>

      {isMounted && isOpen
        ? createPortal(
            <div
              className="command-search-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeSearch();
                }
              }}
            >
              <div
                className="command-search-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Search documentation"
              >
                <div className="command-search-dialog__input-row">
                  <Search
                    className="command-search-dialog__icon"
                    aria-hidden="true"
                  />
                  <input
                    autoFocus
                    type="search"
                    role="combobox"
                    className="command-search-dialog__input"
                    value={query}
                    placeholder="Search documentation..."
                    aria-label="Search documentation"
                    aria-expanded={Boolean(query)}
                    aria-controls={resultsId}
                    aria-activedescendant={
                      results.length ? `${resultsId}-${activeIndex}` : undefined
                    }
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && results.length) {
                        event.preventDefault();
                        setActiveIndex((index) => (index + 1) % results.length);
                      } else if (event.key === "ArrowUp" && results.length) {
                        event.preventDefault();
                        setActiveIndex(
                          (index) => (index - 1 + results.length) % results.length,
                        );
                      } else if (event.key === "Enter" && results[activeIndex]) {
                        event.preventDefault();
                        navigateToResult(results[activeIndex]);
                      }
                    }}
                  />
                  <kbd className="command-search-dialog__escape">Esc</kbd>
                </div>

                {query ? (
                  <div
                    id={resultsId}
                    className="command-search-dialog__results"
                    role="listbox"
                    aria-label="Search results"
                  >
                    {isLoading ? (
                      <p className="command-search-dialog__status">Searching...</p>
                    ) : error ? (
                      <p className="command-search-dialog__status command-search-dialog__status--error">
                        {error}
                      </p>
                    ) : results.length ? (
                      results.map((result, index) => (
                        <button
                          key={`${result.url}-${index}`}
                          id={`${resultsId}-${index}`}
                          type="button"
                          role="option"
                          aria-selected={index === activeIndex}
                          className="command-search-result"
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => navigateToResult(result)}
                        >
                          <span className="command-search-result__group">
                            {result.group}
                          </span>
                          <strong>{result.title}</strong>
                          <span className="command-search-result__excerpt">
                            {result.excerpt}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="command-search-dialog__status">
                        No results found.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
