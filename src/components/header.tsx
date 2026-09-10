'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { cn } from '@/lib/utils';

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');

  return (
    <>
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" aria-label="LibreTV 首页" className="flex items-center shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-512.png" alt="LibreTV" className="w-7 h-7 rounded-lg" />
          </Link>

          {showSearch && (
            <form
              className="flex-1 max-w-xl hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                if (query.trim()) router.push(`/?s=${encodeURIComponent(query.trim())}`);
              }}
            >
              <input
                className="input w-full h-9"
                placeholder="搜索影片..."
                value={query}
                maxLength={100}
                onChange={(e) => setQuery(e.target.value)}
              />
            </form>
          )}

          <div className="flex-1 sm:hidden" />

          <nav className="flex items-center gap-1 ml-auto">
            <HeaderLink href="/live" active={pathname === '/live'}>
              直播
            </HeaderLink>
            <HeaderLink href="/about" active={pathname === '/about'}>
              关于
            </HeaderLink>
            <ThemeToggle />
            <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </IconButton>
            <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </IconButton>
          </nav>
        </div>
      </header>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}

function HeaderLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-2.5 py-1.5 rounded-md text-sm transition-colors',
        active ? 'text-content bg-hover' : 'text-muted hover:text-content'
      )}
    >
      {children}
    </Link>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 面板通用骨架：右侧抽屉 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} />
      <div
        ref={ref}
        className={cn(
          'absolute right-0 top-0 h-full w-full bg-surface-raised border-l border-line overflow-y-auto scrollbar-thin animate-slide-up',
          width
        )}
        role="dialog"
        aria-label={title}
      >
        <div className="sticky top-0 bg-surface-raised px-4 py-3.5 border-b border-line flex items-center justify-between z-10">
          <h2 className="font-semibold text-content">{title}</h2>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover"
            onClick={onClose}
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
