'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SearchResultItem, VideoDetail } from '@/lib/types';
import { buildImageUrl, buildWatchUrl } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { cn } from '@/lib/utils';
import { addSearchHistory } from '@/lib/db';

/**
 * 详情弹窗：剧集列表 + 排序 + 复制链接。
 * 剧集点击 → /watch 路由（URL 携带定位参数，可分享、可后退）。
 */

export function DetailModal({ item, onClose }: { item: SearchResultItem | null; onClose: () => void }) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reversed, setReversed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const poster = buildImageUrl(item?.pic, store.imageProxyMode, store.customImageProxy);

  useEffect(() => setPosterFailed(false), [poster]);

  // 弹窗打开期间锁定背景滚动
  useEffect(() => {
    if (!item) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [item]);

  useEffect(() => {
    if (!item) {
      setDetail(null);
      setError('');
      return;
    }
    const source = resolveSource(store, item.sourceKey, {
      url: item.sourceUrl,
      name: item.sourceName,
    });
    if (!source) {
      setError('点播源配置不存在（可能已被删除），请在设置中重新添加');
      return;
    }
    setLoading(true);
    setError('');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    api
      .detail(item.vodId, source, controller.signal)
      .then((d) => setDetail(d))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : '获取详情失败');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose]);

  if (!item) return null;

  const episodes = detail ? (reversed ? [...detail.episodes].reverse() : detail.episodes) : [];
  const info = detail?.videoInfo;

  const play = (index: number) => {
    if (!detail || !detail.episodes[index]) return;
    addSearchHistory(item.name).catch(() => {});
    router.push(
      buildWatchUrl({
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        index,
        title: item.name,
        sourceUrl: item.sourceUrl,
      })
    );
  };

  const copyLinks = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.episodes.join('\n'));
      toast('播放链接已复制', 'success');
    } catch {
      toast('复制失败，请检查浏览器权限', 'error');
    }
  };

  const metaRows = [
    info?.typeName && ['类型', info.typeName],
    info?.year && ['年份', info.year],
    info?.area && ['地区', info.area],
    info?.director && ['导演', info.director],
    info?.actor && ['主演', info.actor],
    info?.remarks && ['备注', info.remarks],
  ].filter(Boolean) as [string, string][];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl animate-slide-up" role="dialog" aria-modal>
        <div className="flex items-start justify-between gap-4 p-5 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content break-words">{item.name}</h2>
            <span className="text-sm text-faint">{item.sourceName}</span>
          </div>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover shrink-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 pt-4">
          {loading && (
            <div className="flex flex-col items-center py-10 gap-3">
              <div className="h-8 w-8 rounded-full border-4 border-line border-t-accent animate-spin" />
              <p className="text-sm text-muted">正在获取剧集信息...</p>
            </div>
          )}

          {!loading && error && (
            <div className="text-center py-8">
              <div className="text-red-400 mb-1.5">❌ 获取失败</div>
              <div className="text-sm text-faint">{error}</div>
            </div>
          )}

          {!loading && !error && detail && (
            <>
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                {poster && !posterFailed && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={poster}
                    alt={item.name}
                    className="w-24 sm:w-32 aspect-[2/3] object-cover rounded-lg bg-chip shrink-0 self-center sm:self-start"
                    onError={() => setPosterFailed(true)}
                  />
                )}
                <div className="min-w-0 space-y-3">
                  {metaRows.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                      {metaRows.map(([k, v]) => (
                        <div key={k} className="truncate">
                          <span className="text-faint">{k}:</span>{' '}
                          <span className="text-content">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {info?.desc && (
                    <p className="text-sm text-muted leading-relaxed line-clamp-3">{info.desc}</p>
                  )}
                </div>
              </div>

              {episodes.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-ghost !py-1.5 text-xs"
                        onClick={() => setReversed((v) => !v)}
                        aria-label={reversed ? '切换为正序' : '切换为倒序'}
                      >
                        <svg className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        {reversed ? '正序排列' : '倒序排列'}
                      </button>
                      <span className="text-sm text-faint">共 {episodes.length} 集</span>
                    </div>
                    <button className="btn-primary !py-1.5 text-xs" onClick={copyLinks}>
                      复制链接
                    </button>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2 max-h-[40vh] overflow-y-auto scrollbar-thin pr-1">
                    {episodes.map((_, i) => {
                      const realIndex = reversed ? detail.episodes.length - 1 - i : i;
                      return (
                        <button
                          key={realIndex}
                          className="btn-ghost !px-1 text-center"
                          onClick={() => play(realIndex)}
                        >
                          {realIndex + 1}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="text-center py-8">
                  <div className="text-red-400 mb-1.5">❌ 未找到播放资源</div>
                  <div className="text-sm text-faint">该视频可能暂时无法播放，请尝试其他视频</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
