'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { LIVE_PROBE_TTL_MS, useAppStore, type LiveProbeEntry } from '@/lib/store';

/**
 * 直播频道批量测活 hook：
 * - 结果持久化到 store（liveProbeResults），6 小时内直接复用（LIVE_PROBE_TTL_MS）；
 * - 触发探测时只补测缺失或已过期的频道，全部仍有效则提示跳过；
 * - 目标列表分批（每批 10 条）顺序发给 /api/live/probe，服务端批内并发 8；
 * - 再次调用自动作废上一轮（runId 比对），clear 重置。
 */

export interface ProbeResult {
  ok: boolean;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
}

const CHUNK_SIZE = 10;
const MAX_TARGETS = 400;

export function useLiveProbe() {
  const cache = useAppStore((s) => s.liveProbeResults);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [hint, setHint] = useState('');
  const runIdRef = useRef(0);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 3000);
  }, []);

  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, []);

  // 仅暴露 6 小时内的结果，过期条目对 UI 不可见
  const results = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ProbeResult>();
    for (const [url, e] of Object.entries(cache)) {
      if (now - e.timestamp < LIVE_PROBE_TTL_MS) {
        map.set(url, { ok: e.ok, ms: e.ms, level: e.level, error: e.error });
      }
    }
    return map;
  }, [cache]);

  const clear = useCallback(() => {
    runIdRef.current++;
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
      setProgress({ done: 0, total: stale.length });

      const writeToCache = (entries: Record<string, LiveProbeEntry>) => {
        if (runIdRef.current !== runId) return;
        useAppStore.getState().setLiveProbeResults(entries);
      };

      for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
        if (runIdRef.current !== runId) return;
        const chunk = stale.slice(i, i + CHUNK_SIZE);
        try {
          const { results: list } = await api.liveProbe(chunk);
          const entries: Record<string, LiveProbeEntry> = {};
          for (const r of list) {
            entries[r.url] = { ok: r.ok, ms: r.ms, level: r.level, error: r.error, timestamp: Date.now() };
          }
          writeToCache(entries);
        } catch {
          // 整批请求失败（网络断开等）：不写缓存，保持待测状态以便下次重试
        }
        if (runIdRef.current !== runId) return;
        setProgress({ done: Math.min(i + CHUNK_SIZE, stale.length), total: stale.length });
      }
      if (runIdRef.current !== runId) return;
      setProgress(null);
    },
    [showHint]
  );

  return { results, progress, probe, clear, isProbing: progress !== null, hint };
}
