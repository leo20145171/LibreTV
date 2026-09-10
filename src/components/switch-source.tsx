'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SourceConfig, SearchResultItem } from '@/lib/types';
import { buildImageUrl, buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';

/**
 * 换源面板：跨源按标题搜索 → 匹配同名资源 → 并发测速（详情接口耗时）→ 按速度排序展示。
 * 切换时保留当前集数索引（旧版 switchToResource 逻辑的去 DOM 化重写）。
 */

interface Candidate {
  source: SourceConfig;
  result: SearchResultItem;
  ms?: number;
  ok?: boolean;
  episodes?: number;
}

export function SwitchSourceModal({
  currentTitle,
  currentSourceKey,
  currentVodId,
  currentIndex,
  onClose,
}: {
  currentTitle: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'searching' | 'testing' | 'done'>('searching');

  const sources = useMemo(
    () => store.selectedKeys.map((key) => resolveSource(store, key)).filter(Boolean) as SourceConfig[],
    [store]
  );

  useEffect(() => {
    // 弹窗打开期间锁定背景滚动
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1) 并行搜索所有选中源
      setPhase('searching');
      try {
        const { list } = await api.search(currentTitle, sources, false);
        if (cancelled) return;

        // 每个源取完全同名结果，否则取第一个
        const matched: Candidate[] = [];
        for (const s of sources) {
          const hits = list.filter((r) => r.sourceKey === s.key);
          const exact = hits.find((r) => r.name === currentTitle) || hits[0];
          if (exact) matched.push({ source: s, result: exact });
        }

        // 2) 并发测速（详情接口耗时）并获取集数
        setPhase('testing');
        await Promise.all(
          matched.map(async (c) => {
            const r = await api.detailSpeed(c.result.vodId, c.source);
            if (cancelled) return;
            c.ok = r.ok;
            c.ms = r.ms;
            c.episodes = r.detail?.episodes.length ?? 0;
          })
        );
        if (cancelled) return;
        setCandidates(matched);
        setPhase('done');
      } catch (err) {
        if (!cancelled) {
          toast(err instanceof Error ? err.message : '换源搜索失败', 'error');
          setPhase('done');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTitle]);

  const sorted = [...candidates].sort((a, b) => {
    const aCurrent = a.source.key === currentSourceKey && String(a.result.vodId) === String(currentVodId);
    const bCurrent = b.source.key === currentSourceKey && String(b.result.vodId) === String(currentVodId);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const msA = a.ok ? a.ms ?? 99_999 : 99_999;
    const msB = b.ok ? b.ms ?? 99_999 : 99_999;
    return msA - msB;
  });

  const switchTo = (c: Candidate) => {
    if (!c.episodes) {
      toast('该源无可用播放资源', 'warning');
      return;
    }
    const targetIndex = currentIndex < c.episodes ? currentIndex : 0;
    onClose(); // 先关闭面板，避免路由参数变化后弹窗残留旧数据
    router.push(
      buildWatchUrl({
        sourceKey: c.source.key,
        vodId: c.result.vodId,
        index: targetIndex,
        title: c.result.name || currentTitle,
        sourceUrl: c.source.url,
        detail: c.source.detail,
      })
    );
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl p-5 animate-slide-up" role="dialog" aria-modal>
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate">{currentTitle}</h2>
            <p className="text-xs text-faint">
              {phase === 'searching' ? '正在搜索各资源...' : phase === 'testing' ? '正在测试各资源速率...' : `共 ${sorted.length} 个可用资源`}
            </p>
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {phase !== 'done' ? (
          <div className="flex flex-col items-center py-10 gap-3">
            <div className="h-8 w-8 rounded-full border-4 border-line border-t-accent animate-spin" />
            <p className="text-sm text-muted">{phase === 'searching' ? '搜索各资源中...' : '测速中...'}</p>
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-center text-sm text-faint py-8">其他点播源未找到同名资源</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {sorted.map((c) => {
              const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
              const img = buildImageUrl(c.result.pic, store.imageProxyMode, store.customImageProxy);
              return (
                <button
                  key={c.source.key}
                  className={cn('text-left group relative rounded-lg overflow-hidden bg-card transition-transform', !isCurrent && 'hover:scale-[1.03] cursor-pointer', isCurrent && 'cursor-default')}
                  onClick={() => !isCurrent && switchTo(c)}
                  disabled={isCurrent}
                >
                  <div className="relative aspect-[2/3] bg-chip">
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt={c.result.name} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-faint text-xs">无封面</div>
                    )}
                    <span
                      className={cn(
                        'absolute top-1.5 right-1.5 tag',
                        !c.ok ? 'bg-red-500/80 text-white' : c.ms! > 2000 ? 'bg-yellow-600/80 text-white' : 'bg-green-600/80 text-white'
                      )}
                    >
                      {!c.ok ? '失败' : `${c.ms}ms`}
                    </span>
                    {isCurrent && (
                      <span className="absolute inset-x-0 bottom-0 bg-accent/90 text-white text-xs text-center py-1">当前播放</span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-medium text-content truncate">{c.source.name}</div>
                    <div className="text-[10px] text-faint mt-0.5">{c.episodes ? `${c.episodes} 集` : '无资源'}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
