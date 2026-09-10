import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed } from '@/lib/ssrf';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { parseM3u } from '@/lib/m3u-parser';
import type { LivePlaylistResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(url: string): string {
  return `live:playlist:${url}`;
}

function extractPlaylistName(content: string): string | undefined {
  const m = content.match(/^#PLAYLIST:(.+)$/m);
  const name = m?.[1]?.trim();
  return name || undefined;
}

/** 反序列化为 M3U 文本（订阅导出用） */
function toM3uText(playlist: LivePlaylistResponse): string {
  const esc = (s: string) => s.replace(/"/g, "'");
  const lines = ['#EXTM3U'];
  if (playlist.name) lines.push(`#PLAYLIST:${playlist.name}`);
  for (const c of playlist.channels) {
    const attrs = [
      `tvg-id="${esc(c.tvgId || c.id)}"`,
      c.rawName ? `tvg-name="${esc(c.rawName)}"` : '',
      c.logo ? `tvg-logo="${esc(c.logo)}"` : '',
      `group-title="${esc(c.group || '')}"`,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${c.name}`);
    lines.push(c.url);
  }
  return lines.join('\n');
}

/**
 * 拉取并解析 M3U 直播订阅。
 * GET /api/live/playlist?url=<m3u>&force=1&format=json|m3u
 * - 服务端缓存 10 分钟，force=1 跳过缓存强制刷新；
 * - format=m3u 返回解析后的标准 M3U 文本（订阅导出）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = sp.get('url')?.trim();
  if (!url) return jsonError('缺少 url 参数', 400);
  const format = sp.get('format') || 'json';
  const force = sp.get('force') === '1';

  // 直播专用校验：默认拒绝内网，部署者可设 LIVE_ALLOW_PRIVATE=1 放行自建 IPTV
  const verdict = await checkLiveUrlAllowed(url);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  let playlist: LivePlaylistResponse | undefined = force ? undefined : getCache(cacheKey(url));
  if (!playlist) {
    let text: string;
    try {
      const res = await fetchUpstream(url, { timeoutMs: 15000, retries: 1 });
      if (!res.ok) {
        return jsonError(`订阅地址请求失败: ${res.status}`, 502);
      }
      text = await res.text();
    } catch (err) {
      return jsonError(`订阅地址请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }

    const channels = parseM3u(text, url);
    const groups = [...new Set(channels.map((c) => c.group).filter((g): g is string => Boolean(g)))].sort(
      (a, b) => a.localeCompare(b, 'zh')
    );
    playlist = { name: extractPlaylistName(text), channels, groups };
    setCache(cacheKey(url), playlist, CACHE_TTL_MS);
  }

  if (format === 'm3u') {
    return new NextResponse(toM3uText(playlist), {
      headers: {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json(playlist, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
