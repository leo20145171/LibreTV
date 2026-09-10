import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { checkLiveUrlAllowed, checkUpstreamAllowed, isValidProxyUrl } from '@/lib/ssrf';
import { fetchUpstream } from '@/lib/fetch-utils';
import { parseSourceListPayload } from '@/lib/source-list';
import type { SourceListPayload } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 拉取远程数据源订阅。
 * 接受三种形态：
 * 1. 完整格式：{ name?, sources: [点播源], liveSources: [直播源] }
 * 2. 老格式：只有 sources（或裸数组），仅点播
 * 3. 纯直播订阅：只有 liveSources
 *
 * 点播源与直播源的地址放行策略不同（点播一律拒绝内网，直播可用 LIVE_ALLOW_PRIVATE 放行），
 * 因此两类分别校验，不能共用一把尺子。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const requestUrl = new URL(req.url);
  const target = (requestUrl.searchParams.get('url') || '').trim();
  if (!/^https?:\/\//.test(target)) {
    return NextResponse.json({ error: '无效的订阅地址' }, { status: 400 });
  }

  const verdict = await checkUpstreamAllowed(target);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 403 });
  }

  try {
    const res = await fetchUpstream(target, { timeoutMs: 8000, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return NextResponse.json({ error: `订阅地址返回 HTTP ${res.status}` }, { status: 502 });
    }
    const json: unknown = await res.json();

    let parsed;
    try {
      parsed = parseSourceListPayload(json);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : '订阅内容格式不正确' },
        { status: 400 }
      );
    }

    // 点播源：拒绝非公网地址（DNS 层校验在搜索/详情请求时另有兜底）
    const sources = parsed.sources.filter((s) => isValidProxyUrl(s.url));

    // 直播源：按直播策略校验，EPG 地址非法时丢弃该字段而非整条源
    const checkedLive = await Promise.all(
      parsed.liveSources.map(async (s) => {
        if (!(await checkLiveUrlAllowed(s.url)).ok) return null;
        if (s.epg && !(await checkLiveUrlAllowed(s.epg)).ok) return { ...s, epg: undefined };
        return s;
      })
    );

    const payload: SourceListPayload = {
      name: parsed.name,
      sources,
      liveSources: checkedLive.filter((s): s is NonNullable<typeof s> => s !== null),
    };

    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '订阅拉取失败' },
      { status: 502 }
    );
  }
}
