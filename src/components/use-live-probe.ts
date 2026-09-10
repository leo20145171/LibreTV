'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { LIVE_PROBE_TTL_MS, useAppStore, type LiveProbeEntry } from '@/lib/store';

/**
 * 直播频道批量测活 hook：
 * - 结果持久化到 store（liveProbeResults），6 小时内直接复用（LIVE_PROBE_TTL_MS）；
 * - 触发探测时只补测缺失或已过期的频道，全部仍有效则提示跳过；
 * - 服务端以 NDJSON 流式逐条返回，结果边测边写入列表（节流合并，避免高频 re-render）；
 * - 每批 CHUNK_SIZE 条并行 CHUNK_CONCURRENCY 批，服务端批内并发 16；
 * - 重新测活/清空时 abort 在途请求并作废上一轮（runId 比对）。
 */

export interface ProbeResult {
  ok: boolean;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  codec?: string;
}

const CHUNK_SIZE = 50;
/** 同时在途的批次数：与 CHUNK_SIZE 相乘即最大并发探测规模 */
const CHUNK_CONCURRENCY = 2;
const MAX_TARGETS = 400;
/** 流式结果的写回节流间隔：把高频到达的结果合并成一次 store 更新 */
const FLUSH_INTERVAL_MS = 200;

export function useLiveProbe() {
  const cache = useAppStore((s) => s.liveProbeResults);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [hint, setHint] = useState('');
  const runIdRef = useRef(0);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 3000);
  }, []);

  useEffect(() => () => {
    // 卸载时作废在途轮次并断开请求
    runIdRef.current++;
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    abortRef.current?.abort();
  }, []);

  // 仅暴露 6 小时内的结果，过期条目对 UI 不可见
  const results = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ProbeResult>();
    for (const [url, e] of Object.entries(cache)) {
      if (now - e.timestamp < LIVE_PROBE_TTL_MS) {
        map.set(url, { ok: e.ok, ms: e.ms, level: e.level, error: e.error, codec: e.codec });
      }
    }
    return map;
  }, [cache]);

  const clear = useCallback(() => {
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    useAppStore.getState().clearLiveProbeResults();
    setProgress(null);
  }, []);

  const probe = useCallback(
    async (targets: { url: string }[]) => {
      const urls = [...new Set(targets.map((t) => t.url))].slice(0, MAX_TARGETS);
      if (urls.length === 0) return;

      // 6 小时内已测过的直接复用，仅补测缺失或过期的频道
      const now = Date.now();
      const cached = useAppStore.getState().liveProbeResults;
      const stale = urls.filter((u) => {
        const e = cached[u];
        return !e || now - e.timestamp >= LIVE_PROBE_TTL_MS;
      });
      if (stale.length === 0) {
        showHint('测活结果 6 小时内有效，无需重测');
        return;
      }

      const runId = ++runIdRef.current;
      // 作废上一轮的在途请求，避免切换筛选/重复点击后旧结果继续写回
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const chunks: string[][] = [];
      for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
        chunks.push(stale.slice(i, i + CHUNK_SIZE));
      }
      setProgress({ done: 0, total: stale.length });

      let done = 0;
      let buffer: Record<string, LiveProbeEntry> = {};
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (runIdRef.current !== runId) return;
        if (Object.keys(buffer).length > 0) {
          const entries = buffer;
          buffer = {};
          useAppStore.getState().setLiveProbeResults(entries);
        }
        setProgress({ done: Math.min(done, stale.length), total: stale.length });
      };
      const scheduleFlush = () => {
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
      };

      let nextChunk = 0;
      const worker = async () => {
        for (;;) {
          if (runIdRef.current !== runId) return;
          const index = nextChunk++;
          if (index >= chunks.length) return;
          const chunk = chunks[index];
          const received = new Set<string>();
          try {
            await api.liveProbeStream(
              chunk,
              (r) => {
                received.add(r.url);
                if (runIdRef.current !== runId) return;
                buffer[r.url] = {
                  ok: r.ok,
                  ms: r.ms,
                  level: r.level,
                  error: r.error,
                  codec: r.codec,
                  timestamp: Date.now(),
                };
                done++;
                scheduleFlush();
              },
              controller.signal
            );
          } catch {
            // 整批失败/被取消：不写缓存，保持待测状态以便下次重试
          }
          // 流中途断开时未返回的目标：只补进度，不写缓存
          done += chunk.length - received.size;
          flush();
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker)
      );

      if (flushTimer) clearTimeout(flushTimer);
      if (runIdRef.current !== runId) return;
      flush();
      setProgress(null);
      if (abortRef.current === controller) abortRef.current = null;
    },
    [showHint]
  );

  return { results, progress, probe, clear, isProbing: progress !== null, hint };
}
