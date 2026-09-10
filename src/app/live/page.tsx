'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { Header } from '@/components/header';
import { LivePlayer } from '@/components/live-player';
import { LiveChannelList, type LiveChannelItem } from '@/components/live-channel-list';
import { LiveEpgPanel } from '@/components/live-epg-panel';
import { useAuth } from '@/components/auth';
import { allLiveSources, useAppStore } from '@/lib/store';
import { buildImageUrl, cn } from '@/lib/utils';

/**
 * 直播页：左侧播放器 + 频道信息 + 节目单；右侧频道侧栏。
 * 状态由 URL 驱动（?url=&name=&group=&tvgId=&epg=），支持频道深链与刷新保持。
 */
export default function LivePage() {
  return (
    <Suspense>
      <LiveContent />
    </Suspense>
  );
}

/** 复制文本到剪贴板：优先 Clipboard API，http 环境降级 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function LiveContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { verified } = useAuth();
  const [copied, setCopied] = useState(false);

  // 仅聚合已启用的直播源（设置 → 直播源中的勾选状态）
  const sources = useMemo(() => {
    const selected = new Set(store.liveSelectedUrls);
    return allLiveSources(store).filter((s) => selected.has(s.url));
  }, [store]);

  // 聚合全部直播源的 M3U 解析结果（单源失败不影响整体）
  const playlistsQuery = useQuery({
    queryKey: ['livePlaylists', sources.map((s) => s.url).join('|')],
    queryFn: async () => {
      const results = await Promise.allSettled(sources.map((s) => api.livePlaylist(s.url)));
      return sources.map((source, i) => ({ source, result: results[i] }));
    },
    enabled: verified && sources.length > 0,
    staleTime: 10 * 60_000,
  });

  const { channels, groups, failedCount } = useMemo(() => {
    const list: LiveChannelItem[] = [];
    const seen = new Set<string>();
    let failed = 0;
    for (const { source, result } of playlistsQuery.data ?? []) {
      if (result.status !== 'fulfilled') {
        failed++;
        continue;
      }
      for (const c of result.value.channels) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        list.push({ ...c, epg: source.epg, sourceUrl: source.url });
      }
    }
    const groups = [...new Set(list.map((c) => c.group).filter((g): g is string => Boolean(g)))].sort(
      (a, b) => a.localeCompare(b, 'zh')
    );
    return { channels: list, groups, failedCount: failed };
  }, [playlistsQuery.data]);

  // 当前频道：优先取列表内完整对象（含台标），否则由 URL 参数重建
  const currentUrl = searchParams.get('url') || '';
  const currentChannel = useMemo(() => {
    const found = channels.find((c) => c.url === currentUrl);
    if (found) return found;
    if (!currentUrl) return undefined;
    return {
      id: searchParams.get('tvgId') || currentUrl,
      url: currentUrl,
      name: searchParams.get('name') || '未知频道',
      group: searchParams.get('group') || undefined,
      tvgId: searchParams.get('tvgId') || undefined,
      epg: searchParams.get('epg') || undefined,
    } as LiveChannelItem;
  }, [channels, currentUrl, searchParams]);

  const selectChannel = useCallback(
    (c: LiveChannelItem) => {
      const sp = new URLSearchParams({ url: c.url, name: c.name });
      if (c.group) sp.set('group', c.group);
      if (c.tvgId) sp.set('tvgId', c.tvgId);
      if (c.epg) sp.set('epg', c.epg);
      router.replace(`/live?${sp.toString()}`, { scroll: false });
      store.addLiveRecent({
        url: c.url,
        name: c.name,
        logo: c.logo,
        group: c.group,
        tvgId: c.tvgId,
        epg: c.epg,
        sourceUrl: c.sourceUrl,
      });
    },
    [router, store]
  );

  if (!verified) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-faint text-sm">等待访问验证...</p>
        </div>
      </div>
    );
  }

  const logo = buildImageUrl(currentChannel?.logo, imageProxyMode, customImageProxy);

  return (
    <div className="min-h-screen flex flex-col">
      <Header showSearch />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* 主栏：播放器 + 信息条 + 节目单 */}
          <div className="min-w-0">
            <div className="aspect-video bg-black rounded-lg overflow-hidden">
              {currentUrl ? (
                <LivePlayer url={currentUrl} title={currentChannel?.name || '直播'} />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-black">
                  <span className="live-dot" />
                  <p className="text-white/60 text-sm">
                    {sources.length === 0
                      ? store.liveEnvSources.length + store.liveSubscriptions.length > 0
                        ? '所有直播源均已停用，请在设置中勾选启用'
                        : '请先在设置中添加直播源（M3U 订阅）'
                      : playlistsQuery.isLoading
                        ? '频道列表加载中...'
                        : '从右侧选择一个频道开始观看'}
                  </p>
                </div>
              )}
            </div>

            {/* 频道信息条 */}
            {currentChannel && (
              <div className="bg-surface-raised border border-line rounded-lg p-3 mt-3 flex items-center gap-3">
                <div className="w-10 h-10 shrink-0 rounded bg-chip flex items-center justify-center overflow-hidden">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="" className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-xs text-faint">{currentChannel.name.slice(0, 1)}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="live-dot shrink-0" />
                    <h1 className="text-sm font-semibold text-content truncate">{currentChannel.name}</h1>
                    {currentChannel.group && (
                      <span className="tag bg-chip text-faint shrink-0">{currentChannel.group}</span>
                    )}
                  </div>
                  <p className="text-xs text-faint truncate mt-0.5">{currentChannel.url}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className={cn(
                      'rounded-md p-2 transition-colors',
                      store.liveFavorites.includes(currentChannel.url)
                        ? 'text-amber-400'
                        : 'text-muted hover:text-amber-400 hover:bg-hover'
                    )}
                    aria-label="收藏"
                    title="收藏"
                    onClick={() => store.toggleLiveFavorite(currentChannel.url)}
                  >
                    <svg
                      className="w-4 h-4"
                      fill={store.liveFavorites.includes(currentChannel.url) ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                      />
                    </svg>
                  </button>
                  <button
                    className="rounded-md p-2 text-muted hover:text-accent hover:bg-hover transition-colors"
                    aria-label="复制播放地址"
                    title="复制播放地址"
                    onClick={async () => {
                      const ok = await copyText(currentChannel.url);
                      if (ok) {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }
                    }}
                  >
                    {copied ? (
                      <span className="text-[10px] text-green-500">已复制</span>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* 节目单 */}
            {currentChannel && (
              <section className="bg-surface-raised border border-line rounded-lg p-3 mt-3">
                <h2 className="text-sm font-semibold text-content mb-2.5">节目单</h2>
                <LiveEpgPanel epgUrl={currentChannel.epg} tvgId={currentChannel.tvgId} />
              </section>
            )}
          </div>

          {/* 侧栏：频道列表 */}
          <aside className="bg-surface-raised border border-line rounded-lg flex flex-col lg:sticky lg:top-20 h-[70vh] lg:h-[calc(100vh-6.5rem)] overflow-hidden">
            {playlistsQuery.isLoading && channels.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="h-9 w-9 rounded-full border-4 border-line border-t-accent animate-spin" />
              </div>
            ) : (
              <LiveChannelList
                channels={channels}
                groups={groups}
                currentUrl={currentUrl}
                onSelect={selectChannel}
              />
            )}
            {(failedCount > 0 || sources.length === 0) && (
              <p className="text-[10px] text-faint px-3 py-1.5 border-t border-line shrink-0">
                {sources.length === 0
                  ? store.liveEnvSources.length + store.liveSubscriptions.length > 0
                    ? '所有直播源均已停用，请在设置中勾选启用'
                    : '暂无直播源，请在设置 → 直播源中添加'
                  : `${failedCount > 0 ? `${failedCount} 个订阅拉取失败 · ` : ''}共 ${sources.length} 个已启用源`}
              </p>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
