/**
 * m3u8 处理：代理路径重写与广告分片过滤
 *
 * 鉴权说明：重构后代理走同源 httpOnly cookie 鉴权，
 * hls.js 拉取重写后的分片时浏览器自动携带 cookie，无需再往 URL 上拼接 token，
 * 从根本上修复旧版「重写分片丢失鉴权参数导致 401」的问题。
 */

/** 点播代理地址（查询串形式，路径形式会被 EdgeOne 等网关的 URL 归一化破坏，见 proxy-handlers.ts） */
export const PROXY_BASE = '/api/proxy?url=';
/** 直播流代理地址（查询串形式） */
export const LIVE_STREAM_BASE = '/api/live/stream?url=';

/** URI 已是本站代理地址（新旧两种形式：/api/proxy/…、/api/proxy?url=…、/api/live/stream/…、/api/live/stream?url=…）时不再二次改写 */
export function isProxiedUri(uri: string): boolean {
  return uri.startsWith('/api/proxy') || uri.startsWith('/api/live/stream');
}

export function makeAbsolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** 将 m3u8 中的地址改写为经过本站代理的地址（分片/key/map 同样改写）。
 *  prefix 可指定代理地址基座（直播流走 /api/live/stream?url=，点播默认 /api/proxy?url=） */
export function rewriteM3u8(
  content: string,
  baseUrl: string,
  depth = 0,
  prefix: string = PROXY_BASE
): string {
  if (depth > 5) return content;
  const lines = content.split('\n');
  const out = lines.map((line) => {
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
      return line.replace(/(URI=")([^"]+)(")/g, (m, p1: string, uri: string, p2: string) => {
        if (isProxiedUri(uri)) return m;
        return p1 + prefix + encodeURIComponent(makeAbsolute(uri, baseUrl)) + p2;
      });
    }
    if (line.startsWith('#') || line.trim() === '') return line;
    if (isProxiedUri(line)) return line;
    return prefix + encodeURIComponent(makeAbsolute(line, baseUrl));
  });
  return out.join('\n');
}

/**
 * 片头广告段判定上限。dytt 等采集站把固定一支广告（约 15-60s，10 片左右）
 * 作为首个 DISCONTINUITY 段混入所有视频；正片分段（每段 20-40s）与其结构相同，
 * 只能靠「位于片头 + 短小 + 之后仍有分段」这三个特征保守区分，超限即不动。
 */
const LEAD_AD_MAX_SECONDS = 90;
const LEAD_AD_MAX_SEGMENTS = 20;

/**
 * 剔除 m3u8 片头插入的广告段（整段移除分片，而不是像旧实现那样删除
 * #EXT-X-DISCONTINUITY 标记——实测 dytt 源每段 PTS 基准独立跳变，删标记会让
 * hls.js 把整条流当连续时间轴，视频丢帧、音频错位，出现「只闻广告声不见其画面」）。
 *
 * 保守判定（全部满足才剔除）：
 * 1. 首个分片之前存在 DISCONTINUITY（存在「片头插入段」结构）；
 * 2. 该段以下一个 DISCONTINUITY 结束，且其后仍有分段（否则无法与正片区分）；
 * 3. 段时长 ≤ 90s 且分片数 ≤ 20。
 *
 * 段内的 EXT-X-KEY / EXT-X-MAP 保留：若正片复用该解密/初始化配置，误删会导致
 * 无法解密；多声明一个 KEY 无副作用。剔除后新开头的 DISCONTINUITY（首分片之前
 * 没有「前文」）一并清掉。
 */
export function stripLeadAdGroup(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l: string) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const firstDisc = lines.findIndex(isDisc);
  if (firstDisc === -1) return m3u8Content;
  if (lines.slice(0, firstDisc).some(isSegment)) return m3u8Content;

  const nextDisc = lines.findIndex((l, i) => i > firstDisc && isDisc(l));
  if (nextDisc === -1) return m3u8Content;

  let seconds = 0;
  let count = 0;
  for (let i = firstDisc + 1; i < nextDisc; i++) {
    const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
    if (m) seconds += parseFloat(m[1]) || 0;
    else if (isSegment(lines[i])) count += 1;
  }
  if (count === 0 || count > LEAD_AD_MAX_SEGMENTS) return m3u8Content;
  if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return m3u8Content;

  const kept = lines.filter((l, i) => {
    if (i < firstDisc || i >= nextDisc) return true;
    const t = l.trim();
    return t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP');
  });
  const out: string[] = [];
  let seenSegment = false;
  for (const l of kept) {
    if (!seenSegment && isDisc(l)) continue;
    if (isSegment(l)) seenSegment = true;
    out.push(l);
  }
  return out.join('\n');
}

/**
 * 广告分片 URL 特征。暴风等采集云把中插广告放在明显的路径里
 * （实测：`/video/adjump/time/….ts`，"adjump" = ad jump），与正片分片
 * 的命名完全不同——这是比时长/位置可靠得多的识别信号。
 */
const AD_URL_PATTERN = /adjump|advert|\/ads?\//i;

function looksLikeAdUrl(line: string): boolean {
  return AD_URL_PATTERN.test(line.trim());
}

/**
 * 按 URL 特征剔除任意位置的 DISCONTINUITY 广告段（片头/中插均覆盖）。
 * 保守判定：段内**全部分片**都命中广告 URL 特征才整段剔除——只要混入一个
 * 正片分片就放过，避免按时长猜测带来的误伤（正常分段与中插广告时长重叠）。
 * 剔除时保留段前那个 DISCONTINUITY 作正片分段边界，因此不会出现双标记；
 * 段内 EXT-X-KEY / EXT-X-MAP 与片头逻辑同理保留。
 */
function stripMarkedAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l: string) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const drop = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let count = 0;
    let allAd = true;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        count += 1;
        if (!looksLikeAdUrl(lines[j])) allAd = false;
      }
      j += 1;
    }
    if (count > 0 && allAd) {
      drop[i] = true;
      for (let k = i + 1; k < j; k++) {
        const t = lines[k].trim();
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
        drop[k] = true;
      }
    }
    i = j;
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/**
 * 广告过滤总入口：先按 URL 特征剔除任意位置的广告段，再兜底处理
 * 「URL 无特征但位于片头」的插入段（dytt 式）。播放 loader 与下载解析共用。
 */
export function stripAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  return stripLeadAdGroup(stripMarkedAdGroups(m3u8Content));
}
