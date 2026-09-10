import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
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
 *
 * 性能与准确性要点：
 * - 每个频道有整体时间预算（URL_BUDGET_MS），三级探测共享，避免逐级 5s 叠加成长尾；
 * - 结果带短 TTL 缓存（成功 10min / 失败 2min），多用户重复测活不再重复打上游；
 * - 请求带源站 Referer，消除「源校验 Referer 导致的可播却测不通」假阴性；
 * - 校验 m3u8 的 #EXTM3U 前缀与直链的 content-type，剔除 200 的 HTML/JSON 错误页；
 * - master playlist 解析 CODECS 一并返回，前端据此提示 H.265 等浏览器无法解码的情况；
 * - 走直播侧 SSRF 口径（allowPrivate）：LIVE_ALLOW_PRIVATE=1 时自建内网 IPTV 同样能测通；
 * - `?stream=1` 以 NDJSON 逐条推送结果（命中缓存的立即返回），前端状态点可边测边亮；
 *   不带该参数时仍返回整批 JSON，保持向后兼容。
 */

const MAX_URLS = 50;
const CONCURRENCY = 16;
/** 单个频道三级探测的总预算（含 SSRF 校验与各级请求） */
const URL_BUDGET_MS = 6000;
/** 分片级最长等待：分片只需响应头，超时说明源不可用 */
const SEGMENT_TIMEOUT_MS = 2500;
/** 结果缓存：成功结果稳定，失败可能是瞬断，分开设置 */
const CACHE_TTL_OK_MS = 10 * 60 * 1000;
const CACHE_TTL_FAIL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;
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
  /** master playlist 的 CODECS 属性（如 hvc1.1.6.L93.B0,mp4a.40.2），用于前端提示编码兼容性 */
  codec?: string;
}

interface FetchHeadResult {
  ok: boolean;
  status: number;
  text?: string;
  finalUrl: string;
  contentType: string;
  isM3u8: boolean;
}

/** 明显的网页/接口响应（200 的 HTML/JSON 错误页不能当成流） */
function isWebPageType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('application/json') ||
    ct.includes('text/xml') ||
    ct.includes('application/xml')
  );
}

/** 源站 Referer：部分 IPTV 源校验 Referer 才放行列表/分片，缺失会误判为不可用 */
function refererOf(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return undefined;
  }
}

/** 请求一个资源，拿到响应头即断开 body（m3u8 额外读取文本以供解析） */
async function fetchHeadersOnly(
  url: string,
  timeoutMs: number,
  referer?: string
): Promise<FetchHeadResult> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*',
    Range: 'bytes=0-1',
  };
  if (referer) headers.Referer = referer;

  // allowPrivate：与直播流代理同一把尺子，LIVE_ALLOW_PRIVATE=1 时自建内网 IPTV 才能测通；
  // fetchUpstreamWithMeta 内部逐跳做 SSRF 校验，此处不再重复预检（省一次 DNS 解析）
  const { res, finalUrl } = await fetchUpstreamWithMeta(url, {
    timeoutMs,
    retries: 0,
    headers,
    allowPrivate: true,
  });
  const contentType = res.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    url.toLowerCase().split('?')[0].endsWith('.m3u8');

  let text: string | undefined;
  if (isM3u8) {
    // m3u8 是小文本，读取以供解析；分片则不读取
    text = await res.text();
  } else if (res.body) {
    try { await res.body.cancel(); } catch { /* 忽略 */ }
  }
  return { ok: res.ok, status: res.status, text, finalUrl, contentType, isM3u8 };
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

/** 提取 master playlist 的 CODECS 属性 */
function extractCodecs(content: string): string | undefined {
  const m = content.match(/CODECS="([^"]+)"/i);
  return m?.[1]?.trim() || undefined;
}

const HEADER_OK = /^#EXTM3U/;

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

/** 两级探测：manifest →（master 时穿透 variant）→ 分片 */
async function probeOne(url: string): Promise<ProbeOutcome> {
  const start = performance.now();
  const deadline = start + URL_BUDGET_MS;
  const remaining = () => deadline - performance.now();

  const referer = refererOf(url);
  const timeout = () => Math.max(500, Math.round(remaining()));

  try {
    // 第一级：入口地址
    const entry = await fetchHeadersOnly(url, timeout(), referer);
    if (!entry.ok) {
      return { url, ok: false, status: entry.status, ms: elapsed(start), error: `入口响应 ${entry.status}` };
    }

    // 非 m3u8（FLV/TS 直链）：拒绝明显的网页/接口响应，其余单级判定
    if (!entry.isM3u8) {
      if (isWebPageType(entry.contentType)) {
        return {
          url,
          ok: false,
          status: entry.status,
          ms: elapsed(start),
          error: `返回内容不是流媒体（${entry.contentType.split(';')[0]}）`,
        };
      }
      return { url, ok: true, status: entry.status, ms: elapsed(start), level: 'head' };
    }

    // m3u8 必须含 #EXTM3U 头，否则是伪装的 HTML/错误页
    const entryText = (entry.text || '').replace(/^\uFEFF/, '').trimStart();
    if (!HEADER_OK.test(entryText)) {
      return { url, ok: false, status: entry.status, ms: elapsed(start), error: '返回内容不是有效的 m3u8' };
    }

    // 第二级：media playlist（master 则先穿透 variant）。
    // 相对地址一律以重定向后的最终 URL 为 base（gslb 调度源 302 后路径会变）
    let mediaUrl = entry.finalUrl;
    let mediaText = entryText;
    let codec = extractCodecs(entryText);
    const variant = firstVariantUrl(entryText, entry.finalUrl);
    if (variant === undefined) {
      return { url, ok: false, ms: elapsed(start), error: 'playlist 中没有可用的流地址' };
    }
    if (variant !== null) {
      const variantRes = await fetchHeadersOnly(variant, timeout(), referer);
      const variantText = (variantRes.text || '').replace(/^\uFEFF/, '').trimStart();
      if (!variantRes.ok || !HEADER_OK.test(variantText)) {
        return {
          url,
          ok: false,
          status: variantRes.status,
          ms: elapsed(start),
          error: `子播放列表响应 ${variantRes.status}`,
        };
      }
      mediaUrl = variantRes.finalUrl;
      mediaText = variantText;
      codec = codec ?? extractCodecs(variantText);
    }

    // 第三级：分片
    const segmentUrl = firstSegmentUrl(mediaText, mediaUrl);
    if (!segmentUrl) {
      // 空 media playlist（直播源刚启动/无分片）视为 manifest 级通过
      return { url, ok: true, status: entry.status, ms: elapsed(start), level: 'manifest', codec };
    }
    const segmentStart = performance.now();
    const segment = await fetchHeadersOnly(segmentUrl, Math.min(timeout(), SEGMENT_TIMEOUT_MS), referer);
    // ms 只统计分片往返：三级累计耗时当作「延迟」对用户没有参考意义
    const segmentMs = elapsed(segmentStart);
    return {
      url,
      ok: segment.ok,
      status: segment.status,
      ms: segmentMs,
      level: 'segment',
      codec,
      error: segment.ok ? undefined : `分片响应 ${segment.status}`,
    };
  } catch (err) {
    const timedOut = performance.now() >= deadline;
    return {
      url,
      ok: false,
      ms: elapsed(start),
      error: timedOut ? `探测超时（${URL_BUDGET_MS}ms）` : err instanceof Error ? err.message : '探测失败',
    };
  }
}

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  // 禁用反代缓冲，保证每条结果立即到达客户端
  'X-Accel-Buffering': 'no',
};

/**
 * 流式测活：命中缓存的结果立即推送，其余探测完成一条推一条（NDJSON）。
 * 相比整批等待最慢的一条，前端状态点可以边测边亮。
 * 客户端断开（切筛选/关页）时 req.signal 触发，worker 停止且不再写入。
 */
function ndjsonResponse(urls: string[], reqSignal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const cachedOutcomes: ProbeOutcome[] = [];
  const pending: string[] = [];
  for (const u of urls) {
    const hit = cacheGet(u);
    if (hit) cachedOutcomes.push(hit);
    else pending.push(u);
  }

  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (o: ProbeOutcome) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* 已关闭 */ }
      };
      reqSignal.addEventListener('abort', () => { closed = true; }, { once: true });

      for (const o of cachedOutcomes) send(o);

      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          if (closed || reqSignal.aborted) return;
          const url = pending[cursor++];
          const outcome = await probeOne(url);
          if (closed || reqSignal.aborted) return;
          cacheSet(url, outcome);
          send(outcome);
        }
      };
      void Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
        .then(finish)
        .catch(finish);
    },
    cancel() {
      // 客户端主动断开
      closed = true;
    },
  });

  return new NextResponse(stream, { headers: NDJSON_HEADERS });
}

/** 结果短 TTL 缓存：成功 10min、失败 2min，避免多用户重复测活打爆上游 */
const probeCache = new Map<string, { outcome: ProbeOutcome; expiresAt: number }>();

function cacheGet(url: string): ProbeOutcome | undefined {
  const entry = probeCache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    probeCache.delete(url);
    return undefined;
  }
  return entry.outcome;
}

function cacheSet(url: string, outcome: ProbeOutcome): void {
  if (probeCache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of probeCache) {
      if (now > v.expiresAt) probeCache.delete(k);
    }
    if (probeCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = probeCache.keys().next().value;
      if (oldest !== undefined) probeCache.delete(oldest);
    }
  }
  probeCache.set(url, {
    outcome,
    expiresAt: Date.now() + (outcome.ok ? CACHE_TTL_OK_MS : CACHE_TTL_FAIL_MS),
  });
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
  const stream = new URL(req.url).searchParams.get('stream') === '1';
  if (urls.length === 0) {
    return stream
      ? new NextResponse('', { headers: NDJSON_HEADERS })
      : NextResponse.json({ results: [] });
  }

  if (stream) return ndjsonResponse(urls, req.signal);

  const outcomes = new Map<string, ProbeOutcome>();
  // 先命中缓存，减少需要真实探测的目标
  const pending: string[] = [];
  for (const u of urls) {
    const hit = cacheGet(u);
    if (hit) outcomes.set(u, hit);
    else pending.push(u);
  }

  // 简单并发池：固定 worker 数从游标取任务（单线程内 cursor++ 无 await 间隙，无竞态）
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const url = pending[cursor++];
      const outcome = await probeOne(url);
      cacheSet(url, outcome);
      outcomes.set(url, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  return NextResponse.json(
    { results: urls.map((u) => outcomes.get(u)!) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
