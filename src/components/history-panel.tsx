'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { Drawer } from './header';
import { db, clearAllHistory, removeHistory, upsertHistory, type HistoryEntry } from '@/lib/db';
import { buildWatchUrl, buildImageUrl, cn, formatRelativeTime, formatTime } from '@/lib/utils';
import { useToast } from './toast';
import { resolveSource, useAppStore } from '@/lib/store';

/**
 * 观看历史面板（IndexedDB 实时查询）。
 * 与旧版的区别：播放前按需重新拉取剧集详情，不再依赖历史记录里冗余存储的全集 URL。
 */

export function HistoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const history = useLiveQuery(() => db.history.orderBy('timestamp').reverse().limit(50).toArray(), [open]);
  const { toast } = useToast();

  return (
    <Drawer open={open} onClose={onClose} title="观看历史" width="max-w-lg">
      {!history ? (
        <p className="text-center text-faint py-8 text-sm">加载中...</p>
      ) : history.length === 0 ? (
        <p className="text-center text-faint py-8 text-sm">暂无观看记录</p>
      ) : (
        <>
          <div className="flex justify-end mb-2">
            <button
              className="text-xs text-faint hover:text-red-400 transition-colors"
              onClick={() => {
                clearAllHistory().then(() => toast('观看历史已清空', 'success'));
              }}
            >
              清空历史
            </button>
          </div>
          <ul className="space-y-2">
            {history.map((item) => (
              <HistoryItem key={`${item.sourceKey}_${item.vodId}`} item={item} />
            ))}
          </ul>
        </>
      )}
    </Drawer>
  );
}

function HistoryItem({ item }: { item: HistoryEntry }) {
  const store = useAppStore();
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);
  const pic = buildImageUrl(item.pic, store.imageProxyMode, store.customImageProxy);

  const hasPercent =
    item.playbackPosition > 10 && item.duration > 0 && item.playbackPosition < item.duration * 0.95;
  const percent = hasPercent ? Math.round((item.playbackPosition / item.duration) * 100) : 0;

  const href = buildWatchUrl({
    sourceKey: item.sourceKey,
    vodId: item.vodId,
    index: item.episodeIndex,
    title: item.title,
    sourceUrl: resolveSource(store, item.sourceKey)?.url,
    detail: resolveSource(store, item.sourceKey)?.detail,
  });

  return (
    <li className="relative group">
      <Link
        href={href}
        onClick={() => {
          // 点击即同步一次时间戳，置顶最近观看
          upsertHistory({ ...item, timestamp: Date.now() }).catch(() => {});
        }}
        className="block bg-card hover:bg-hover rounded-lg p-3 pr-10 transition-colors"
      >
        <div className="flex items-center gap-3">
          {pic && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pic}
              alt=""
              className="w-10 h-14 object-cover rounded bg-chip"
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-10 h-14 rounded bg-chip flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16m10-16v16M7 8h10M7 12h10" />
              </svg>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-content truncate">{item.title}</div>
            <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">
              {item.totalEpisodes > 0 && <span>第 {item.episodeIndex + 1}/{item.totalEpisodes} 集</span>}
              {hasPercent && <span>· {formatTime(item.playbackPosition)}</span>}
              <span>· {formatRelativeTime(item.timestamp)}</span>
            </div>
            {hasPercent && (
              <div className="mt-1.5 h-1 bg-hover rounded-full overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </div>
      </Link>
      <button
        className={cn(
          'absolute right-2 top-2 p-1.5 rounded-full text-faint hover:text-red-400',
          'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
        )}
        aria-label="删除记录"
        title="删除记录"
        onClick={() => {
          removeHistory(item.sourceKey, item.vodId).then(() => toast('已删除该记录', 'success'));
        }}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </li>
  );
}
