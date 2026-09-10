'use client';

import { api } from './client-api';
import { useAppStore } from './store';

/**
 * SourceList 订阅同步核心逻辑，供两处复用：
 * - source-manager：用户在设置抽屉中手动添加/重新同步（UI 层加 toast 反馈）；
 * - providers：部署者通过 DEFAULT_SUBSCRIPTIONS 预置的订阅，启动时自动导入与静默重同步。
 *
 * applySubscriptionSources / applySubscriptionLive 均按订阅前缀整体替换且保留
 * 用户勾选状态，同步失败时不调用即无副作用——旧数据自动保留。
 */
export interface SubscriptionSyncResult {
  name?: string;
  vodCount: number;
  liveCount: number;
}

export async function syncSourceSubscription(url: string): Promise<SubscriptionSyncResult> {
  const { name, sources, liveSources } = await api.fetchSourceList(url);
  if (sources.length === 0 && liveSources.length === 0) {
    throw new Error('订阅内容为空');
  }
  const store = useAppStore.getState();
  const vodCount = store.applySubscriptionSources(url, sources);
  const liveCount = store.applySubscriptionLive(url, liveSources);
  // 仅对本订阅实际导入的直播源记录同步时间：
  // 被其他订阅/手动源占用而未导入的 M3U，其 name/epg/lastSync 不得被本订阅覆盖
  const importedLiveUrls = new Set(
    useAppStore.getState().liveSubscriptions
      .filter((s) => s.fromSubscription === url)
      .map((s) => s.url)
  );
  for (const s of liveSources) {
    if (importedLiveUrls.has(s.url)) store.markLiveSynced(s.url, s.name, s.epg);
  }
  store.addSubscription(url, name);
  store.markSubscriptionSynced(url, name);
  return { name, vodCount, liveCount };
}

/** 预置订阅超过该间隔未同步时，启动阶段静默刷新一次 */
const ENV_SUB_RESYNC_MS = 24 * 60 * 60 * 1000;

/**
 * 部署者通过 DEFAULT_SUBSCRIPTIONS 预置的订阅：启动时自动导入与静默刷新。
 *
 * seen 标记（envSubsSeen）仅在同步成功后写入：
 * - 同步成功 → 标记 seen，用户此后删除该订阅不会被自动加回；
 * - 同步失败 → 不标记，下次启动自动重试，已导入的旧数据保持不动。
 * 已存在的订阅超过 24h 未同步时静默刷新（成功过但 seen 机制上线前的旧数据也会借此补标）。
 */
export async function syncEnvSubscriptions(subs: { url: string; name?: string }[]): Promise<void> {
  for (const sub of subs) {
    const store = useAppStore.getState();
    try {
      const existing = store.subscriptions.find((s) => s.url === sub.url);
      if (existing) {
        if (existing.lastSync && Date.now() - existing.lastSync < ENV_SUB_RESYNC_MS) {
          store.markEnvSubsSeen([sub.url]);
          continue;
        }
        await syncSourceSubscription(sub.url);
      } else {
        // 已成功过且被用户删除的预置订阅：尊重用户选择，不再加回
        if (store.envSubsSeen.includes(sub.url)) continue;
        await syncSourceSubscription(sub.url);
      }
      useAppStore.getState().markEnvSubsSeen([sub.url]);
    } catch (err) {
      console.warn('[LibreTV] 预置订阅同步失败（下次启动将重试）：', sub.url, err instanceof Error ? err.message : err);
    }
  }
}
