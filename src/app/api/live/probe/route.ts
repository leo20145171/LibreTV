import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { fetchUpstreamWithMeta } from '@/lib/fetch-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 直播频道批量测活（分片级）。
 * POST /api/live/probe  body: { urls: string[] }
 *
 * 单级「manifest 可访问」不足以判断可播：大量 IPTV 源 manifest 正常但
 * 分片请求被拒（token/Referer 校验、源瞬断）。因此探测追到真实分片：
 *
 *   m3u8 → [master playlist → 第一个 variant] → media playlist → 第一个分片
 *   分片以 Range: bytes=0-1 请求，收到响应头即 cancel body，不下载媒体数据。
 *
 * 非 m3u8（FLV 等）维持单级探测。结果 level 标识探测深度：
 *   segment=分片级（最可信）/ manifest=仅 manifest 级 / head=单级直探
 * 200/206 响应头视为可达；仍不保证编码可解码（H.265 等）。
 */

const MAX_URLS = 50;
const CONCURRENCY = 8;
const TIMEOUT_MS = 5000;
const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface ProbeOutcome {
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
}

/** 请求一个资源，拿到响应头即断开 body；返回 ok、状态码与重定向后的最终 URL */
async function fetchHeadersOnly(url: string): Promise<{ ok: boolean; status: number; text?: string; finalUrl: string }> {
  const { res, finalUrl } = await fetchUpstreamWithMeta(url, {
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-1' },
  });
  const ok = res.ok;
  const status = res.status;
  const contentType = res.headers.get('content-type') || '';
  const looksLikeM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    url.toLowerCase().split('?')[0].endsWith('.m3u8');
  let text: string | undefined;
  if (looksLikeM3u8) {
    // m3u8 是小文本，读取以供解析；分片则不读取
    text = await res.text();
  } else if (res.body) {
    try { await res.body.cancel(); } catch { /* 忽略 */ }
  }
  return { ok, status, text, finalUrl };
}

/** 从 media playlist 中取第一个分片/初始化段 URL */
function firstSegmentUrl(content: string, baseUrl: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) return new URL(m[1], baseUrl).href;
      continue;
    }
    if (line.startsWith('#')) continue;
    return new URL(line, baseUrl).href;
  }
  return undefined;
}

/** 从 master playlist 中取第一个 variant 的地址（无 STREAM-INF 则视为 media playlist 返回 null） */
function firstVariantUrl(content: string, baseUrl: string): string | undefined | null {
  if (!content.includes('#EXT-X-STREAM-INF')) return null;
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next) continue;
        if (next.startsWith('#')) continue;
        return new URL(next, baseUrl).href;
      }
    }
  }
  return undefined;
}

/** 两级探测：manifest →（master 时穿透 variant）→ 分片 */
async function probeOne(url: string): Promise<ProbeOutcome> {
  const start = performance.now();
  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) return { url, ok: false, error: verdict.reason };

  try {
    // 第一级：入口地址
    const entry = await fetchHeadersOnly(url);
    if (!entry.ok) {
      return { url, ok: false, status: entry.status, ms: elapsed(start), error: `入口响应 ${entry.status}` };
    }
    // 非 m3u8（FLV/TS 直链）：单级判定
    if (!entry.text) {
      return { url, ok: true, status: entry.status, ms: elapsed(start), level: 'head' };
    }

    // 第二级：media playlist（master 则先穿透 variant）。
    // 相对地址一律以重定向后的最终 URL 为 base（gslb 调度源 302 后路径会变）
    let mediaUrl = entry.finalUrl;
    let mediaText = entry.text;
    const variant = firstVariantUrl(entry.text, entry.finalUrl);
    if (variant === undefined) {
      return { url, ok: false, ms: elapsed(start), error: 'playlist 中没有可用的流地址' };
    }
    if (variant !== null) {
      const variantVerdict = await checkUpstreamAllowed(variant);
      if (!variantVerdict.ok) {
        return { url, ok: false, ms: elapsed(start), error: `子播放列表被拒绝: ${variantVerdict.reason}` };
      }
      const variantRes = await fetchHeadersOnly(variant);
      if (!variantRes.ok || !variantRes.text) {
        return { url, ok: false, status: variantRes.status, ms: elapsed(start), error: `子播放列表响应 ${variantRes.status}` };
      }
      mediaUrl = variantRes.finalUrl;
      mediaText = variantRes.text;
    }
    const mediaVerdict = await checkUpstreamAllowed(mediaUrl);
    if (!mediaVerdict.ok) {
      return { url, ok: false, ms: elapsed(start), error: `播放列表被拒绝: ${mediaVerdict.reason}` };
    }

    // 第三级：分片
    const segmentUrl = firstSegmentUrl(mediaText, mediaUrl);
    if (!segmentUrl) {
      // 空 media playlist（直播源刚启动/无分片）视为 manifest 级通过
      return { url, ok: true, status: entry.status, ms: elapsed(start), level: 'manifest' };
    }
    const segmentVerdict = await checkUpstreamAllowed(segmentUrl);
    if (!segmentVerdict.ok) {
      return { url, ok: false, ms: elapsed(start), error: `分片地址被拒绝: ${segmentVerdict.reason}` };
    }
    const segment = await fetchHeadersOnly(segmentUrl);
    return {
      url,
      ok: segment.ok,
      status: segment.status,
      ms: elapsed(start),
      level: 'segment',
      error: segment.ok ? undefined : `分片响应 ${segment.status}`,
    };
  } catch (err) {
    return {
      url,
      ok: false,
      ms: elapsed(start),
      error: err instanceof Error ? err.message : '探测失败',
    };
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { urls?: unknown };
  try {
    body = (await req.json()) as { urls?: unknown };
  } catch {
    return jsonError('无效请求体', 400);
  }
  if (!Array.isArray(body.urls)) return jsonError('urls 必须为字符串数组', 400);

  const urls = [...new Set(
    body.urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
  )].slice(0, MAX_URLS);
  if (urls.length === 0) return NextResponse.json({ results: [] });

  // 简单并发池：固定 worker 数从游标取任务
  const outcomes = new Map<string, ProbeOutcome>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      outcomes.set(url, await probeOne(url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));

  return NextResponse.json(
    { results: urls.map((u) => outcomes.get(u)!) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
