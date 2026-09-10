'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { RecommendSection } from '@/components/douban-section';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { useAppStore, resolveSource } from '@/lib/store';
import { api } from '@/lib/client-api';
import type { SearchResultItem } from '@/lib/types';
import { addSearchHistory, db, removeSearchHistory } from '@/lib/db';
import { cn, validateSourceUrl } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { useAuth } from '@/components/auth';

/**
 * 首页：搜索（URL ?s= 驱动，可后退/分享）+ 豆瓣推荐。
 * 搜索状态由 React Query 管理，失败源在结果区顶部以非阻塞方式展示。
 */
export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const { version } = useAuth();
  const urlQuery = searchParams.get('s') || '';
  const store = useAppStore();
  const [input, setInput] = useState(urlQuery);
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // URL 驱动搜索：?s= 变化时回填输入框
  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  const selectedSources = useMemo(
    () =>
      store.selectedKeys
        .map((key) => resolveSource(store, key))
        .filter((s): s is NonNullable<typeof s> => Boolean(s) && validateSourceUrl(s!.url)),
    [store]
  );

  const searchQuery = useQuery({
    queryKey: ['search', urlQuery, store.selectedKeys, store.yellowFilter],
    // 与 runSearch 的截断规则保持一致：顶栏搜索 / 手动构造长链接不会绕过上限
    queryFn: ({ signal }) => api.search(urlQuery.slice(0, 100), selectedSources, store.yellowFilter, signal),
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    // 5 分钟内从播放页返回时直接使用缓存，不重新搜索（服务端另有 60s 结果缓存兜底）
    staleTime: 300_000,
  });

  const searchHistory = useQuery({
    queryKey: ['searchHistory'],
    queryFn: () => db.searchHistory.orderBy('timestamp').reverse().limit(10).toArray(),
  });

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
    addSearchHistory(query).catch(() => {});
  };

  const list = useMemo(() => searchQuery.data?.list ?? [], [searchQuery.data]);
  const failures = searchQuery.data?.failures ?? [];
  // 跨源同名聚合：同名影片合并为一张卡片，展开后可选择具体来源
  const groups = useMemo(() => aggregateResults(list), [list]);
  // 失败源显示友好名称而非裸 key
  const failureNames = failures.map(
    (f) =>
      store.customAPIs.find((a) => a.key === f.sourceKey)?.name ??
      store.envSources.find((a) => a.key === f.sourceKey)?.name ??
      f.sourceKey
  );

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="relative flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {/* 首屏氛围渐变 */}
        {!urlQuery && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] -z-10"
            style={{
              background:
                'radial-gradient(60% 60% at 50% 0%, rgba(35,173,229,0.10) 0%, rgba(35,173,229,0.03) 45%, transparent 75%)',
            }}
          />
        )}

        {/* 搜索区 */}
        <section className={cn('flex flex-col items-center', urlQuery ? 'mb-6' : 'mt-10 mb-14')}>
          {!urlQuery && (
            <header className="text-center mb-6">
              <h1 className="text-4xl sm:text-5xl font-bold brand-gradient">LibreTV</h1>
            </header>
          )}
          {urlQuery && <h1 className="sr-only">LibreTV 视频搜索</h1>}
          <form
            className="w-full max-w-2xl flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(input);
            }}
          >
            <div className="relative flex-1">
              <input
                ref={inputRef}
                className="input w-full h-11 pr-10"
                placeholder="输入影片名称..."
                value={input}
                maxLength={100}
                onChange={(e) => setInput(e.target.value)}
                aria-label="搜索影片"
              />
              {input && (
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-content"
                  onClick={() => {
                    setInput('');
                    inputRef.current?.focus();
                  }}
                  aria-label="清空"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <button type="submit" className="btn-primary h-11 px-5">
              搜索
            </button>
          </form>

          {/* 最近搜索 */}
          {(searchHistory.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-3 justify-center">
              <span className="text-xs text-faint">最近搜索:</span>
              {searchHistory.data!.map((h) => (
                <span key={h.text} className="inline-flex items-center bg-card rounded-full text-xs">
                  <button
                    className="pl-2.5 pr-1 py-1 text-content hover:text-accent"
                    onClick={() => {
                      setInput(h.text);
                      runSearch(h.text);
                    }}
                  >
                    {h.text}
                  </button>
                  <button
                    className="pr-2 py-1 text-faint hover:text-red-400"
                    aria-label={`删除搜索记录 ${h.text}`}
                    onClick={() => removeSearchHistory(h.text).then(() => searchHistory.refetch())}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* 搜索结果 */}
        {urlQuery && (
          <section aria-label="搜索结果" className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm text-muted">
                “<span className="text-content">{urlQuery}</span>” 的搜索结果
                {searchQuery.data && (
                  <span className="text-faint">
                    （{groups.length} 部影片 · {list.length} 条结果{failures.length > 0 && `，${failures.length} 个源失败`}）
                  </span>
                )}
              </h2>
            </div>

            {failures.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                部分点播源请求失败：{failureNames.join('、')}
              </div>
            )}

            {searchQuery.isLoading ? (
              <ResultsSkeleton />
            ) : selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={store.customAPIs.length > 0 || store.envSources.length > 0} />
            ) : list.length === 0 ? (
              <div className="text-center py-16">
                <svg className="mx-auto h-10 w-10 text-faint mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h3 className="text-base text-muted">没有找到匹配的结果</h3>
                <p className="text-sm text-faint mt-1">请尝试其他关键词或更换点播源</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                {groups.map((group) => (
                  <AggregatedCard
                    key={group.key}
                    group={group}
                    onOpen={(item) => setDetailItem(item)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* 首页推荐（有搜索时隐藏） */}
        {!urlQuery && (
          <RecommendSection
            onPick={(title) => {
              setInput(title);
              runSearch(title);
            }}
          />
        )}
      </main>

      <footer className="border-t border-line py-4">
        <p className="text-center text-xs text-faint">
          <a
            href="https://github.com/LibreSpark/LibreTV"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-accent"
          >
            LibreTV
          </a>
          {version ? ` v${version} · ` : ' '}
          数据来源为第三方公开接口，本站不存储任何视频文件
        </p>
      </footer>

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card h-28 animate-pulse bg-card" />
      ))}
    </div>
  );
}

/** 无点播源 / 未勾选点播源时的引导（替代旧版首屏静默空白） */
function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">{hasSources ? '尚未勾选点播源' : '先添加一个点播源'}</h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>点击右上角「设置」，勾选要参与搜索的点播源后重新搜索。</>
        ) : (
          <>
            LibreTV 不内置任何采集站。点击右上角「设置 → 添加 API」，填入一个
            Apple CMS 采集站地址（如 <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>），
            勾选后即可开始搜索。
          </>
        )}
      </p>
    </div>
  );
}
