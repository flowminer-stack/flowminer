import { useState, useRef, useEffect, Fragment, useCallback } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Menu,
  Search,
  ChevronRight,
  User,
  Settings,
  LogOut,
  Sun,
  Moon,
  FolderKanban,
  FileText,
  Activity,
  Sparkles,
} from 'lucide-react';
import { useAuthStore, useUIStore } from '@/store';
import { search as searchApi } from '@/api/client';
import type { SearchResult } from '@/types';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

function useBreadcrumbs(): BreadcrumbItem[] {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);
  const crumbs: BreadcrumbItem[] = [];

  let currentPath = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    currentPath += `/${segment}`;

    const label = segment
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const isId = /^[0-9a-f]{8}-/.test(segment) || segment.length > 20;

    if (isId) {
      // Skip trailing ID segments — the page heading already shows the resource name.
      // For non-final IDs (e.g. /projects/:id/something) still show a truncated label.
      if (i === segments.length - 1) continue;
      crumbs.push({ label: segment.slice(0, 8) + '…', path: currentPath });
    } else if (i < segments.length - 1) {
      crumbs.push({ label, path: currentPath });
    } else {
      crumbs.push({ label });
    }
  }

  return crumbs;
}

const resultTypeIcon = {
  project: FolderKanban,
  event_log: FileText,
  activity: Activity,
};

const resultTypeLabel = {
  project: 'Projects',
  event_log: 'Event Logs',
  activity: 'Activities',
};

function resultPath(result: SearchResult): string {
  if (result.type === 'project') return `/projects/${result.id}`;
  if (result.type === 'event_log') return `/process/${result.id}`;
  return result.parent_id ? `/process/${result.parent_id}` : '/projects';
}

function groupResults(results: SearchResult[]): [string, SearchResult[]][] {
  const groups: Record<string, SearchResult[]> = {};
  for (const r of results) {
    const key = resultTypeLabel[r.type];
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  return Object.entries(groups);
}

export default function Header() {
  const navigate = useNavigate();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const breadcrumbs = useBreadcrumbs();

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setUserMenuOpen(false);
      }
      if (
        searchRef.current &&
        !searchRef.current.contains(event.target as Node)
      ) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (!value.trim()) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    debounceTimer.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const response = await searchApi.query(value.trim());
        setSearchResults(response.results);
        setSearchOpen(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchOpen(false);
      searchInputRef.current?.blur();
    }
  };

  const handleResultClick = (result: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    navigate(resultPath(result));
  };

  const initials = user?.full_name
    ? user.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '??';

  const handleLogout = () => {
    setUserMenuOpen(false);
    logout();
    navigate('/login');
  };

  const grouped = groupResults(searchResults);

  return (
    <header className="sticky top-0 z-30 flex h-[52px] items-center gap-3 border-b border-line/70 bg-surface-0/90 px-4 backdrop-blur-xl">
      {/* Mobile menu toggle */}
      <button
        onClick={toggleSidebar}
        className="rounded-lg p-1.5 text-fg-muted hover:bg-tint hover:text-fg transition-colors lg:hidden"
      >
        <Menu size={17} />
      </button>

      {/* Breadcrumbs */}
      <nav className="hidden items-center gap-1 text-[13px] lg:flex min-w-0 flex-1">
        {breadcrumbs.map((crumb, index) => (
          <Fragment key={index}>
            {index > 0 && (
              <ChevronRight size={12} className="text-fg-ghost shrink-0" />
            )}
            {crumb.path ? (
              <Link
                to={crumb.path}
                className="text-fg-muted transition-colors hover:text-fg truncate max-w-[160px]"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="font-semibold text-fg truncate max-w-[200px]">{crumb.label}</span>
            )}
          </Fragment>
        ))}
      </nav>

      {/* Spacer (mobile) */}
      <div className="flex-1 lg:hidden" />

      {/* Search */}
      <div className="relative" ref={searchRef}>
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none"
        />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search…"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => { if (searchResults.length > 0) setSearchOpen(true); }}
          className="h-8 w-44 rounded-lg border border-line bg-surface-1 pl-7 pr-7 text-[12px] text-fg placeholder-fg-faint outline-none transition-all focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:w-56 md:w-48 md:focus:w-64"
          style={{ boxShadow: 'var(--shadow-xs)' }}
        />
        {!searchQuery && (
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line bg-surface-2 px-1 py-px text-[10px] font-medium text-fg-faint">
            /
          </kbd>
        )}

        {/* Search dropdown */}
        {searchOpen && (
          <div className="absolute right-0 top-full mt-2 w-80 animate-fade-in rounded-xl border border-line bg-surface-2 overflow-hidden"
            style={{ boxShadow: 'var(--shadow-lg)' }}>
            {searchLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-fg-muted">
                No results for "<span className="text-fg">{searchQuery}</span>"
              </div>
            ) : (
              <div className="py-1.5">
                {grouped.map(([groupLabel, items]) => (
                  <div key={groupLabel}>
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                      {groupLabel}
                    </div>
                    {items.map((result) => {
                      const Icon = resultTypeIcon[result.type];
                      return (
                        <button
                          key={`${result.type}-${result.id}`}
                          onClick={() => handleResultClick(result)}
                          className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-tint"
                        >
                          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-3">
                            <Icon size={12} className="text-fg-muted" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-fg">
                              {result.name}
                            </p>
                            {(result.description || result.parent_name) && (
                              <p className="truncate text-[11px] text-fg-muted mt-0.5">
                                {result.parent_name
                                  ? `in ${result.parent_name}`
                                  : result.description}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ask AI toggle */}
      <button
        onClick={() => useUIStore.getState().toggleAiChat()}
        className="flex items-center gap-1.5 rounded-lg border border-accent/30 px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/10"
        title="Ask AI about this event log"
      >
        <Sparkles size={13} />
        <span className="hidden sm:inline">Ask AI</span>
      </button>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-tint hover:text-fg"
        title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      >
        {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
      </button>

      {/* User menu */}
      <div className="relative" ref={userMenuRef}>
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-tint"
          title={user?.full_name}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-[11px] font-bold text-accent">
            {initials}
          </div>
        </button>

        {userMenuOpen && (
          <div className="absolute right-0 top-full mt-2 w-52 animate-fade-in rounded-xl border border-line bg-surface-2 overflow-hidden"
            style={{ boxShadow: 'var(--shadow-lg)' }}>
            <div className="border-b border-line/60 px-4 py-3">
              <p className="text-[13px] font-semibold text-fg truncate">
                {user?.full_name}
              </p>
              <p className="text-[12px] text-fg-muted truncate mt-0.5">{user?.email}</p>
            </div>
            <div className="py-1.5">
              <button
                onClick={() => { setUserMenuOpen(false); navigate('/settings'); }}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-[13px] text-fg-muted transition-colors hover:bg-tint hover:text-fg"
              >
                <User size={13} className="shrink-0" />
                Profile
              </button>
              <button
                onClick={() => { setUserMenuOpen(false); navigate('/settings'); }}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-[13px] text-fg-muted transition-colors hover:bg-tint hover:text-fg"
              >
                <Settings size={13} className="shrink-0" />
                Settings
              </button>
            </div>
            <div className="border-t border-line/60 py-1.5">
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-[13px] text-danger transition-colors hover:bg-danger/10"
              >
                <LogOut size={13} className="shrink-0" />
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
