'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildImageUrl, cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import { useLiveProbe, type ProbeResult } from './use-live-probe';
import type { LiveChannel } from '@/lib/types';

/**
 * 直播频道侧栏：全部/收藏/最近三个视图 + 分组横向标签条 + 关键字搜索。
 * 支持批量测活：频道名前显示可达性状态点，可筛选「仅可用」。
 * 大列表渐进渲染（每次 300，点「加载更多」递增），避免数千频道一次性 DOM。
 */

const PAGE_SIZE = 300;

export interface LiveChannelItem extends LiveChannel {
  /** 来源订阅的 EPG 地址（用于节目单查询） */
  epg?: string;
  /** 所属直播源地址（M3U 订阅 URL），写入最近观看以便订阅删除时清理 */
  sourceUrl?: string;
}

interface ChannelListProps {
  channels: LiveChannelItem[];
  groups: string[];
  currentUrl: string;
  onSelect: (channel: LiveChannelItem) => void;
}

type View = 'all' | 'fav' | 'recent';

export function LiveChannelList({ channels, groups, currentUrl, onSelect }: ChannelListProps) {
  const store = useAppStore();
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [view, setView] = useState<View>('all');
  const [group, setGroup] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [onlyAlive, setOnlyAlive] = useState(false);
  const { results: probeResults, progress: probeProgress, probe, clear: clearProbe, isProbing, hint: probeHint } = useLiveProbe();

  const favSet = useMemo(() => new Set(store.liveFavorites), [store.liveFavorites]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list: LiveChannelItem[];
    if (view === 'fav') {
      list = channels.filter((c) => favSet.has(c.url));
    } else if (view === 'recent') {
      // 按最近观看时间倒序
      list = store.liveRecent
        .map((r) => channels.find((c) => c.url === r.url))
        .filter((c): c is LiveChannelItem => Boolean(c));
    } else {
      list = channels;
    }
    if (view !== 'recent') {
      if (group) list = list.filter((c) => c.group === group);
    }
    if (kw) {
      list = list.filter(
        (c) => c.name.toLowerCase().includes(kw) || (c.tvgId || '').toLowerCase().includes(kw)
      );
    }
    if (onlyAlive && probeResults.size > 0) {
      list = list.filter((c) => probeResults.get(c.url)?.ok === true);
    }
    return list;
  }, [channels, favSet, store.liveRecent, view, group, keyword, onlyAlive, probeResults]);

  const aliveCount = useMemo(
    () => (probeResults.size > 0 ? filtered.filter((c) => probeResults.get(c.url)?.ok === true).length : 0),
    [filtered, probeResults]
  );

  // 切换视图/分组/搜索时重置渐进渲染
  useEffect(() => setLimit(PAGE_SIZE), [view, group, keyword]);

  const visible = filtered.slice(0, limit);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 视图 tab */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-2 border-b border-line shrink-0">
        {(
          [
            ['all', `全部${channels.length ? ` ${channels.length}` : ''}`],
            ['fav', `收藏${store.liveFavorites.length ? ` ${store.liveFavorites.length}` : ''}`],
            ['recent', '最近'],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition-colors',
              view === v ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 搜索框 */}
      <div className="px-3 py-2 shrink-0">
        <input
          className="input w-full !py-1.5 text-xs"
          placeholder="搜索频道名称或 tvg-id..."
          value={keyword}
          maxLength={60}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {/* 测活工具条 */}
      <div className="flex items-center gap-1.5 px-3 pb-2 shrink-0 flex-wrap">
        <button
          className="btn-ghost !py-1 !px-2 text-xs"
          disabled={isProbing || filtered.length === 0}
          onClick={() => void probe(filtered)}
          title="轻量探测当前列表频道的可达性与延迟（每批 10 条并发探测，结果 6 小时内有效）"
        >
          ⚡ 测活
        </button>
        {isProbing && probeProgress && (
          <span className="text-[10px] text-faint">
            探测中 {probeProgress.done}/{probeProgress.total}
          </span>
        )}
        {probeHint && !isProbing && (
          <span className="text-[10px] text-faint">{probeHint}</span>
        )}
        {probeResults.size > 0 && !isProbing && (
          <>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                onlyAlive
                  ? 'bg-accent text-white border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setOnlyAlive((v) => !v)}
            >
              仅可用 {aliveCount}
            </button>
            <button
              className="text-[10px] text-faint hover:text-content transition-colors"
              onClick={() => {
                clearProbe();
                setOnlyAlive(false);
              }}
            >
              清除结果
            </button>
          </>
        )}
      </div>

      {/* 分组标签条（横向可滑动） */}
      {view === 'all' && groups.length > 0 && (
        <div className="px-3 pb-2 shrink-0">
          <div className="flex gap-1.5 overflow-x-auto scrollbar-thin pb-1">
            <GroupChip active={!group} label="全部分组" onClick={() => setGroup('')} />
            {groups.map((g) => (
              <GroupChip key={g} active={group === g} label={g} onClick={() => setGroup(g === group ? '' : g)} />
            ))}
          </div>
        </div>
      )}

      {/* 频道列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 pb-2">
        {visible.length === 0 ? (
          <p className="text-center text-xs text-faint py-10">
            {view === 'fav'
              ? '暂无收藏频道，点击频道右侧星标即可收藏'
              : view === 'recent'
                ? '暂无观看记录'
                : channels.length === 0
                  ? '暂无频道，请先在设置中添加直播源'
                  : onlyAlive && probeResults.size > 0
                    ? '没有探测到可用频道，可清除结果后重试'
                    : '没有匹配的频道'}
          </p>
        ) : (
          <ul className="space-y-1">
            {visible.map((c) => (
              <ChannelRow
                key={c.url}
                channel={c}
                active={c.url === currentUrl}
                isFav={favSet.has(c.url)}
                probe={probeResults.get(c.url)}
                logoUrl={buildImageUrl(c.logo, imageProxyMode, customImageProxy)}
                onSelect={() => onSelect(c)}
              />
            ))}
          </ul>
        )}
        {filtered.length > limit && (
          <button
            className="btn-ghost w-full mt-2 !py-1.5 text-xs"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
          >
            加载更多（剩余 {filtered.length - limit}）
          </button>
        )}
      </div>
    </div>
  );
}

function GroupChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        'shrink-0 px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors border',
        active
          ? 'bg-accent text-white border-accent'
          : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ChannelRow({
  channel,
  active,
  isFav,
  probe,
  logoUrl,
  onSelect,
}: {
  channel: LiveChannelItem;
  active: boolean;
  isFav: boolean;
  probe?: ProbeResult;
  logoUrl?: string;
  onSelect: () => void;
}) {
  const store = useAppStore();
  const ref = useRef<HTMLLIElement>(null);

  // 当前播放项自动滚入视区
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <li ref={ref}>
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'group flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer transition-colors relative',
          active ? 'bg-accent/10' : 'hover:bg-hover'
        )}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        {/* 当前播放高亮竖条 */}
        <span
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-accent transition-all duration-200',
            active ? 'h-5 opacity-100' : 'h-0 opacity-0'
          )}
        />
        {/* 台标 */}
        <div className="w-7 h-7 shrink-0 rounded bg-chip flex items-center justify-center overflow-hidden">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="w-full h-full object-contain"
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ) : (
            <span className="text-[10px] text-faint">{channel.name.slice(0, 1)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {probe && (
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  probe.ok ? 'bg-green-500' : 'bg-red-400'
                )}
                title={probe.ok ? `${probe.level === 'segment' ? '分片可用' : 'manifest 可用'} · ${probe.ms}ms` : probe.error || '不可用'}
              />
            )}
            <span className={cn('text-xs truncate', active ? 'text-accent font-medium' : 'text-content')}>
              {channel.name}
            </span>
          </div>
          {channel.group && (
            <div className="text-[10px] text-faint truncate">{channel.group}</div>
          )}
        </div>
        {/* 收藏星标 */}
        <button
          className={cn(
            'shrink-0 p-1 rounded transition-transform active:scale-125',
            isFav ? 'text-amber-400' : 'text-faint/50 opacity-0 group-hover:opacity-100 hover:text-amber-400'
          )}
          aria-label={isFav ? '取消收藏' : '收藏'}
          title={isFav ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            store.toggleLiveFavorite(channel.url);
          }}
        >
          <svg className="w-3.5 h-3.5" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
        </button>
      </div>
    </li>
  );
}
