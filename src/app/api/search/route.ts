import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, filterAdultResults, filterRelevantResults, normalizeTitle, parseSearchList } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SearchResponse, SourceConfig, SourceSearchOutcome } from '@/lib/types';

export const runtime = 'nodejs';

interface SearchBody {
  wd: string;
  sources: SourceConfig[];
  filterAdult?: boolean;
}

/** 搜索结果短缓存：同一关键词 + 同一组源在 TTL 内直接返回（播放页返回搜索页等场景） */
const SEARCH_CACHE_TTL = 60 * 1000;

/** 缓存键：wd + 成人过滤 + 排序后的源地址集合 */
function searchCacheKey(wd: string, sources: SourceConfig[], filterAdult: boolean): string {
  const urls = sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|');
  let h = 5381;
  const str = `${wd}\n${filterAdult ? 1 : 0}\n${urls}`;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return `search:${h.toString(36)}`;
}

/**
 * 每个源最多抓取的页数（参考 LunaTV 的 SearchDownstreamMaxPage）。
 * 第一页响应会带回 pagecount（源站真实总页数），实际抓取页数 = min(pagecount, 该值)。
 * 默认 5；页与页之间并行请求，单页失败只丢弃该页。
 */
const SEARCH_MAX_PAGES = (() => {
  const n = parseInt(process.env.SEARCH_MAX_PAGES || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(50, Math.max(1, n));
})();

/**
 * 服务端聚合搜索：并行请求所有选中源，任一源失败不影响整体。
 * 每个源先取第一页并读取 pagecount，再并行抓取后续页（上限 SEARCH_MAX_PAGES）。
 * 旧版在浏览器里打满 N 个请求（暴露用户 IP、无法缓存、超时失控），现全部上移。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const wd = (body.wd || '').trim();
  if (!wd || wd.length > 100) {
    return NextResponse.json({ error: '搜索关键词无效' }, { status: 400 });
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }
  const sources = body.sources.slice(0, 50);

  const cacheKey = searchCacheKey(wd, sources, body.filterAdult !== false);
  const cached = getCache<SearchResponse>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const outcomes: SourceSearchOutcome[] = await Promise.all(
    sources.map(async (source): Promise<SourceSearchOutcome> => {
      if (!/^https?:\/\//.test(source.url || '')) {
        return { sourceKey: source.key, ok: false, list: [], error: '无效的源地址' };
      }
      // 用户可控地址发起服务端请求，必须先过 SSRF 校验（协议白名单 + 内网/保留地址）
      const verdict = await checkUpstreamAllowed(source.url);
      if (!verdict.ok) {
        return { sourceKey: source.key, ok: false, list: [], error: verdict.reason };
      }
      const base = source.url.replace(/\/+$/, '');
      const fetchPage = async (page: number) => {
        const api = `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${page}`;
        const res = await fetchUpstream(api, {
          timeoutMs: 8000,
          headers: cmsRequestHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      try {
        const first = await fetchPage(1);
        const list = parseSearchList(first, source);
        // 源站真实总页数与配置上限取较小者；pagecount 缺失或非法时视为 1 页
        const rawPageCount = parseInt(String((first as { pagecount?: unknown }).pagecount ?? '1'), 10);
        const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, SEARCH_MAX_PAGES);
        if (pageCount > 1) {
          const extraPages = await Promise.all(
            Array.from({ length: pageCount - 1 }, (_, i) => i + 2).map(async (page) => {
              try {
                return parseSearchList(await fetchPage(page), source);
              } catch {
                return [];
              }
            })
          );
          list.push(...extraPages.flat());
        }
        return { sourceKey: source.key, ok: true, list };
      } catch (err) {
        return {
          sourceKey: source.key,
          ok: false,
          list: [],
          error: err instanceof Error ? err.message : '请求失败',
        };
      }
    })
  );

  // 合并 + 跨源去重（同源同 vodId 视为重复）
  const seen = new Set<string>();
  let list = outcomes.flatMap((o) => o.list).filter((item) => {
    const key = `${item.sourceKey}_${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  list = filterAdultResults(list, body.filterAdult !== false);
  // 部分源站做分词/OR 模糊搜索（搜「摔跤吧！爸爸」返回一堆「爸爸XXX」），按关键词过滤
  list = filterRelevantResults(list, wd);

  // 精确命中（忽略标点差异）排在最前，其余按名称（与旧版一致），名称相同按源名
  const exact = normalizeTitle(wd);
  list.sort((a, b) => {
    const aExact = normalizeTitle(a.name || '') === exact ? 0 : 1;
    const bExact = normalizeTitle(b.name || '') === exact ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const nameCompare = (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceName || '').localeCompare(b.sourceName || '', 'zh-Hans-CN');
  });

  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败' }));

  const payload: SearchResponse = { list, failures };
  setCache(cacheKey, payload, SEARCH_CACHE_TTL);
  return NextResponse.json(payload);
}
