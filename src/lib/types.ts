// 采集站（Apple CMS 资源站）描述
export interface SourceConfig {
  /** 唯一标识，如 "custom_0"；内置源直接用短名 */
  key: string;
  name: string;
  /** API 根地址，如 https://example.com/api.php/provide/vod */
  url: string;
  /** 可选：详情页根地址（部分源需要爬详情页提取 m3u8） */
  detail?: string;
  isAdult?: boolean;
}

export interface SearchResultItem {
  sourceKey: string;
  sourceName: string;
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  /** 自定义源的 API 地址，详情请求需要 */
  sourceUrl?: string;
  isAdult?: boolean;
}

export interface VideoInfo {
  title?: string;
  cover?: string;
  desc?: string;
  typeName?: string;
  year?: string;
  area?: string;
  director?: string;
  actor?: string;
  remarks?: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
}

export interface VideoDetail {
  episodes: string[];
  videoInfo: VideoInfo;
}

export interface DoubanItem {
  id: string;
  title: string;
  cover: string;
  rating?: string;
  isTv?: boolean;
}

export interface SourceSearchOutcome {
  sourceKey: string;
  ok: boolean;
  list: SearchResultItem[];
  error?: string;
}

// —— API 响应结构 ——

export interface SearchResponse {
  list: SearchResultItem[];
  failures: { sourceKey: string; error: string }[];
}

export interface DoubanResponse {
  items: DoubanItem[];
}

export interface BangumiCalendarDay {
  /** 1=周一 … 7=周日 */
  weekday: number;
  items: DoubanItem[];
}

export interface BangumiCalendarResponse {
  days: BangumiCalendarDay[];
}

export interface AuthStatusResponse {
  /** 服务器是否配置了 PASSWORD */
  passwordRequired: boolean;
  /** 当前会话是否已验证 */
  verified: boolean;
  version: string;
  /** 部署者通过 DEFAULT_SOURCES 环境变量预置的采集站（未配置时为空数组） */
  defaultSources: SourceConfig[];
  /** 部署者通过 DEFAULT_LIVE_SOURCES 环境变量预置的直播源（未配置时为空数组） */
  defaultLiveSources: LiveSourceConfig[];
  /** 部署者通过 DEFAULT_SUBSCRIPTIONS 环境变量预置的 SourceList 订阅链接（未配置时为空数组） */
  defaultSubscriptions: { url: string; name?: string }[];
}

// —— 直播 / IPTV ——

/** 直播源（M3U 订阅）配置 */
export interface LiveSourceConfig {
  key: string;
  name: string;
  /** M3U 订阅地址 */
  url: string;
  /** 可选：XMLTV 节目单地址 */
  epg?: string;
}

/** 单个直播频道（由 M3U 解析得到） */
export interface LiveChannel {
  /** tvg-id 优先，缺失时由 URL 生成的稳定短 id */
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  /** M3U 的 tvg-name 属性（原始台名） */
  rawName?: string;
}

export interface LivePlaylistResponse {
  /** 订阅名（M3U 无名时为空） */
  name?: string;
  channels: LiveChannel[];
  groups: string[];
}

/** 单条节目单条目（XMLTV programme） */
export interface EpgProgram {
  channelId: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  stop: number;
  title: string;
  desc?: string;
}

export interface LiveEpgResponse {
  channelId: string;
  current?: EpgProgram;
  next?: EpgProgram;
  programs: EpgProgram[];
}

// —— 数据源订阅 ——

/**
 * 远程订阅（LibreTV-SourceList JSON）解析结果。
 * `sources` 为点播源（Apple CMS 采集站），`liveSources` 为直播源（M3U + 可选 EPG）。
 * 老格式订阅只有 `sources`，此时 `liveSources` 为空数组。
 */
export interface SourceListPayload {
  /** 订阅列表自带名称 */
  name?: string;
  sources: Omit<SourceConfig, 'key'>[];
  liveSources: Omit<LiveSourceConfig, 'key'>[];
}
