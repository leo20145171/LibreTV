'use client';

import { useEffect, useState } from 'react';
import { Drawer } from './header';
import { subKeyPrefix, useAppStore } from '@/lib/store';
import { useToast } from './toast';
import { formatRelativeTime, validateSourceUrl, cn } from '@/lib/utils';
import { exportConfig, importConfig } from '@/lib/db';
import { useAuth } from './auth';
import { api } from '@/lib/client-api';
import { syncSourceSubscription } from '@/lib/subscription-sync';
import { LiveSourceManager } from './live-source-manager';

/**
 * 设置抽屉：顶部 Tab 分类（点播源 / 直播源 / 播放设置 / 订阅与配置），
 * 每次只渲染一类内容，避免源很多时长距离滚动。
 */

type TestState =
  | { status: 'loading' }
  | { status: 'done'; ok: boolean; ms?: number; count?: number; error?: string };

type SettingsTab = 'sources' | 'live' | 'playback' | 'config';

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'sources', label: '点播源' },
  { id: 'live', label: '直播源' },
  { id: 'playback', label: '播放设置' },
  { id: 'config', label: '订阅与配置' },
];

export function SourceManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useAppStore();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  // Tab 选中态不持久化：每次打开抽屉回到「点播源」
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('sources');

  const runTest = async (key: string, url: string) => {
    setTests((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    try {
      const r = await api.testSource(url);
      setTests((prev) => ({
        ...prev,
        [key]: r.ok
          ? { status: 'done', ok: true, ms: r.ms, count: r.count }
          : { status: 'done', ok: false, error: r.error },
      }));
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [key]: { status: 'done', ok: false, error: err instanceof Error ? err.message : '测试失败' },
      }));
    }
  };

  const testButton = (key: string, url: string) => {
    const t = tests[key];
    return (
      <span className="flex items-center gap-1 shrink-0">
        {t?.status === 'done' && (
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded',
              t.ok ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-red-500/15 text-red-500'
            )}
            title={t.ok ? `响应 ${t.ms}ms，搜索到 ${t.count ?? 0} 条` : t.error}
          >
            {t.ok ? `✓ ${t.ms}ms` : `✗ ${t.error?.slice(0, 12) || '失败'}`}
          </span>
        )}
        <button
          className={cn(
            'rounded-md p-1.5 transition-colors disabled:opacity-40',
            t?.status === 'done' && !t.ok ? 'text-red-400' : 'text-muted hover:text-accent hover:bg-hover'
          )}
          disabled={t?.status === 'loading'}
          onClick={() => runTest(key, url)}
          aria-label="测试此源"
          title="测试可用性（搜索耗时与结果量）"
        >
          {t?.status === 'loading' ? '…' : '⚡'}
        </button>
      </span>
    );
  };

  return (
    <Drawer open={open} onClose={onClose} title="设置">
      {/* 分类 Tab 条：-mt-4 抵消内容容器的上内边距使其贴合标题栏；sticky 吸附在标题栏下方（标题栏高 60px + 1px 边框） */}
      <div className="sticky top-[61px] z-10 -mx-4 -mt-4 px-4 pt-3 pb-2.5 bg-surface-raised border-b border-line flex gap-1">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition-colors',
              settingsTab === tab.id
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setSettingsTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {settingsTab === 'sources' && (
      <>
      <section className="mb-6 pt-5">
        <SectionTitle
          title="点播源"
          extra={
            <button className="btn-primary !py-1 !px-2.5 text-xs" onClick={() => setEditing('__new__')}>
              + 添加 API
            </button>
          }
        />
        <SourceForm
          visible={editing === '__new__'}
          onCancel={() => setEditing(null)}
          onSubmit={(data) => {
            store.addCustomApi(data);
            setEditing(null);
          }}
        />
        {store.customAPIs.length === 0 && store.envSources.length === 0 && editing !== '__new__' ? (
          <EmptySourceGuide onAdd={() => setEditing('__new__')} />
        ) : (
          <>
            {/* 源很多时限高内滚，避免 tab 内长滚 */}
            <div className="max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
            {store.envSources.length > 0 && (
              <ul className="space-y-2 mb-2">
                {store.envSources.map((api) => (
                  <li key={api.key} className="bg-card rounded-lg p-3 transition-colors hover:bg-hover/50">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[#2563eb]"
                        checked={store.selectedKeys.includes(api.key)}
                        onChange={() => store.toggleSourceSelected(api.key)}
                        disabled={!!api.isAdult && store.yellowFilter}
                        title={api.isAdult && store.yellowFilter ? '成人内容过滤开启中，需先关闭过滤才能启用此源' : undefined}
                        aria-label={`选择 ${api.name}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-content truncate">
                          {api.name}
                          {api.isAdult && <span className="text-pink-400 text-xs ml-1">(18+)</span>}
                          {api.isAdult && store.yellowFilter && (
                            <span className="text-[10px] text-faint ml-1">过滤开启中，需关闭后才能启用</span>
                          )}
                          <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                            部署者预置
                          </span>
                        </div>
                        <div className="text-xs text-faint truncate">{api.url}</div>
                      </div>
                      {testButton(api.key, api.url)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <ul className="space-y-2">
            {store.customAPIs.map((api) => {
              const fromSubscription = api.key.startsWith('sub_');
              return (
              <li key={api.key} className="bg-card rounded-lg p-3 transition-colors hover:bg-hover/50">
                {editing === api.key ? (
                  <SourceForm
                    visible
                    initial={api}
                    onCancel={() => setEditing(null)}
                    onSubmit={(data) => {
                      store.updateCustomApi(api.key, data);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#2563eb]"
                      checked={store.selectedKeys.includes(api.key)}
                      onChange={() => store.toggleSourceSelected(api.key)}
                      disabled={!!api.isAdult && store.yellowFilter}
                      title={api.isAdult && store.yellowFilter ? '成人内容过滤开启中，需先关闭过滤才能启用此源' : undefined}
                      aria-label={`选择 ${api.name}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-content truncate">
                        {api.name}
                        {api.isAdult && <span className="text-pink-400 text-xs ml-1">(18+)</span>}
                        {api.isAdult && store.yellowFilter && (
                          <span className="text-[10px] text-faint ml-1">过滤开启中，需关闭后才能启用</span>
                        )}
                        {fromSubscription && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle"
                            title="来自数据源订阅，重新同步时此源的名称/地址会以订阅内容为准"
                          >
                            订阅
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-faint truncate">{api.url}</div>
                    </div>
                    {testButton(api.key, api.url)}
                    {fromSubscription ? (
                      // 订阅源由远端列表管理：编辑会被下次同步覆盖，删除会复活，引导到订阅区操作
                      <>
                        <button
                          className="rounded-md p-1.5 text-muted/40"
                          aria-label="订阅源不可单独编辑"
                          title="该源来自订阅，编辑修改会在下次同步时被覆盖；如需调整请修改远端订阅列表后重新同步"
                          onClick={() => toast('订阅源以远端列表为准；请修改远端订阅内容后重新同步', 'info')}
                        >
                          ✎
                        </button>
                        <button
                          className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-red-400"
                          onClick={() => {
                            store.removeCustomApi(api.key);
                            toast('已移除；注意：重新同步订阅时该源会恢复', 'info');
                          }}
                          aria-label="删除"
                          title="移除此源（重新同步订阅时会恢复）"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-accent"
                          onClick={() => setEditing(api.key)}
                          aria-label="编辑"
                        >
                          ✎
                        </button>
                        <button
                          className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-red-400"
                          onClick={() => store.removeCustomApi(api.key)}
                          aria-label="删除"
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
              );
            })}
            </ul>
            </div>
          </>
        )}
      </section>
      </>
      )}

      {settingsTab === 'live' && <LiveSourceManager />}

      {settingsTab === 'playback' && (
      <>
      <section className="mb-6 pt-5">
        <SectionTitle title="播放与过滤" />
        <div className="space-y-3">
          <ToggleRow
            label="成人内容过滤"
            description="过滤“伦理片”等分类的结果"
            checked={store.yellowFilter}
            onChange={(v) => store.updateSettings({ yellowFilter: v })}
          />
          <ToggleRow
            label="广告过滤"
            description="过滤 m3u8 中的广告分片"
            checked={store.adFilter}
            onChange={(v) => store.updateSettings({ adFilter: v })}
          />
          <ToggleRow
            label="自动连播"
            description="单集播放结束后自动播放下一集"
            checked={store.autoplayNext}
            onChange={(v) => store.updateSettings({ autoplayNext: v })}
          />
          <ToggleRow
            label="首页推荐"
            description="在首页展示推荐内容"
            checked={store.doubanEnabled}
            onChange={(v) => store.updateSettings({ doubanEnabled: v })}
          />
          <SelectRow
            label="推荐数据源"
            value={store.recommendSource}
            onChange={(v) => store.updateSettings({ recommendSource: v as 'douban' | 'bangumi' | 'hot-list' })}
            options={[
              { value: 'douban', label: '豆瓣（电影/剧集）' },
              { value: 'bangumi', label: 'Bangumi 新番放送' },
              { value: 'hot-list', label: '影视榜单（豆瓣周榜/百度热播）' },
            ]}
          />
        </div>
      </section>

      <section className="mb-6 border-t border-line pt-5">
        <SectionTitle title="封面图加载" />
        <div className="space-y-2">
          <SelectRow
            label="加载方式"
            value={store.imageProxyMode}
            onChange={(v) => store.updateSettings({ imageProxyMode: v as 'direct' | 'proxy' | 'custom' })}
            options={[
              { value: 'direct', label: '直连' },
              { value: 'proxy', label: '内置代理（默认）' },
              { value: 'custom', label: '自定义代理' },
            ]}
          />
          {store.imageProxyMode === 'custom' && (
            <input
              className="input w-full"
              placeholder="代理模板，如 https://p.example.com/?url={url}"
              value={store.customImageProxy}
              onChange={(e) => store.updateSettings({ customImageProxy: e.target.value })}
            />
          )}
          <p className="text-xs text-faint">豆瓣封面在某些网络下直连会被拒绝，可切换为内置代理。</p>
        </div>
      </section>
      </>
      )}

      {settingsTab === 'config' && (
      <>
        <SourceSubscriptions />
        <section className="mb-6 pt-5 border-t border-line">
          <SectionTitle title="配置" />
          <ConfigIoButtons />
        </section>
      </>
      )}
    </Drawer>
  );
}

/**
 * 数据源订阅 / 分享：
 * - 订阅：填入远程 LibreTV-SourceList JSON 地址，一次拉取点播源与直播源，可随时重新同步；
 * - 分享：把当前点播源 + 直播源导出为同格式 JSON 文件，托管到任意位置即可被他人订阅。
 */
function SourceSubscriptions() {
  const store = useAppStore();
  const { toast } = useToast();
  const [subUrl, setSubUrl] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);

  const sync = async (url: string) => {
    setSyncing(url);
    try {
      const { vodCount, liveCount } = await syncSourceSubscription(url);
      toast(`已同步 ${vodCount} 个点播源、${liveCount} 个直播源`, 'success');
      setSubUrl('');
    } catch (err) {
      toast(err instanceof Error ? err.message : '订阅同步失败', 'error');
    } finally {
      setSyncing(null);
    }
  };

  const addAndSync = () => {
    const url = subUrl.trim();
    if (!validateSourceUrl(url)) {
      toast('订阅地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    void sync(url);
  };

  const exportSources = () => {
    const all = [...store.envSources, ...store.customAPIs];
    const seen = new Set<string>();
    const sources = all
      .filter((s) => {
        const u = s.url.replace(/\/+$/, '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map(({ name, url, detail, isAdult }) => ({ name, url, detail, isAdult }));

    // 直播源：预置 + 手动 + 订阅导入，按 URL 去重
    const liveSeen = new Set<string>();
    const liveSources = [...store.liveEnvSources, ...store.liveSubscriptions]
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    const payload = { name: 'LibreTV-SourceList', version: 2, exportedAt: Date.now(), sources, liveSources };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LibreTV-SourceList_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${sources.length} 个点播源、${liveSources.length} 个直播源，托管后即可被他人订阅`, 'success');
  };

  return (
    <section className="mb-6 pt-5">
      <SectionTitle
        title="数据源订阅 / 分享"
        extra={
          <button
            className="btn-ghost !py-1 !px-2.5 text-xs"
            onClick={exportSources}
            disabled={
              store.customAPIs.length + store.envSources.length + store.liveSubscriptions.length + store.liveEnvSources.length ===
              0
            }
          >
            导出数据源
          </button>
        }
      />
      <div className="flex gap-2 mb-2">
        <input
          className="input w-full"
          placeholder="订阅地址（LibreTV-SourceList JSON 的 URL）"
          value={subUrl}
          onChange={(e) => setSubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAndSync();
          }}
        />
        <button className="btn-primary !py-1.5 text-xs shrink-0" disabled={!subUrl.trim() || syncing !== null} onClick={addAndSync}>
          订阅
        </button>
      </div>
      {store.subscriptions.length === 0 ? (
        <p className="text-xs text-faint">
          一份订阅可同时下发点播源与直播源；「导出数据源」生成的 JSON 托管到任意 URL 即可分享给他人订阅。
        </p>
      ) : (
        <ul className="space-y-2 max-h-[30vh] overflow-y-auto scrollbar-thin pr-1">
          {store.subscriptions.map((sub) => {
            const vodCount = store.customAPIs.filter((a) => a.key.startsWith(subKeyPrefix(sub.url))).length;
            const liveCount = store.liveSubscriptions.filter((s) => s.fromSubscription === sub.url).length;
            return (
            <li key={sub.url} className="bg-card rounded-lg p-3 transition-colors hover:bg-hover/50">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-content truncate">{sub.name || hostnameOf(sub.url)}</div>
                  <div className="text-xs text-faint truncate">
                    {sub.url}
                    {sub.lastSync && ` · 同步于 ${formatRelativeTime(sub.lastSync)}`}
                  </div>
                  <div className="mt-1 flex gap-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">点播 {vodCount}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">直播 {liveCount}</span>
                  </div>
                </div>
                <button
                  className="rounded-md p-1.5 shrink-0 text-muted transition-colors hover:bg-hover hover:text-accent disabled:opacity-40"
                  disabled={syncing === sub.url}
                  onClick={() => sync(sub.url)}
                  aria-label="重新同步"
                  title="重新同步（以远端列表为准，整体替换该订阅名下的点播源与直播源）"
                >
                  {syncing === sub.url ? '…' : '⟳'}
                </button>
                <button
                  className="rounded-md p-1.5 shrink-0 text-muted transition-colors hover:bg-hover hover:text-red-400"
                  onClick={() => store.removeSubscription(sub.url)}
                  aria-label="删除订阅"
                  title="删除订阅及其导入的点播源与直播源（保留收藏的频道）"
                >
                  ✕
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function SectionTitle({ title, extra }: { title: string; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <h3 className="text-sm font-semibold text-content">{title}</h3>
      {extra}
    </div>
  );
}

function EmptySourceGuide({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="border border-dashed border-line rounded-lg p-5 text-center">
      <p className="text-sm text-muted mb-1">还没有添加任何点播源</p>
      <p className="text-xs text-faint mb-3">
        添加一个 Apple CMS 采集站 API 即可开始搜索影片；也可到「订阅与配置」一次导入点播源与直播源
      </p>
      <button className="btn-primary text-xs" onClick={onAdd}>
        添加第一个点播源
      </button>
    </div>
  );
}

function SourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  onCancel: () => void;
  onSubmit: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [isAdult, setIsAdult] = useState(initial?.isAdult ?? false);
  const { toast } = useToast();

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setUrl(initial?.url ?? '');
      setDetail(initial?.detail ?? '');
      setIsAdult(initial?.isAdult ?? false);
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    const n = name.trim();
    const u = url.trim().replace(/\/+$/, '');
    if (!n || !u) {
      toast('请输入 API 名称和链接', 'warning');
      return;
    }
    if (!validateSourceUrl(u)) {
      toast('API 链接需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    onSubmit({ name: n, url: u, detail: detail.trim() || undefined, isAdult });
  };

  return (
    <div className="space-y-2 border border-line rounded-lg p-3 bg-chip">
      <input className="input w-full" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        className="input w-full"
        placeholder="API 地址，如 https://example.com/api.php/provide/vod"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="input w-full"
        placeholder="详情页地址（可选），如 https://example.com"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" className="h-3.5 w-3.5 accent-pink-500" checked={isAdult} onChange={(e) => setIsAdult(e.target.checked)} />
        标记为成人内容源（受成人过滤控制）
      </label>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost !py-1 text-xs" onClick={onCancel}>
          取消
        </button>
        <button className="btn-primary !py-1 text-xs" onClick={submit}>
          {initial ? '更新' : '添加'}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <div className="min-w-0">
        <div className="text-sm text-content">{label}</div>
        <div className="text-xs text-faint">{description}</div>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={cn(
          'relative h-[22px] w-10 shrink-0 rounded-full transition-colors duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          checked ? 'bg-accent' : 'bg-chip ring-1 ring-inset ring-line'
        )}
        onClick={() => onChange(!checked)}
      >
        <span
          className={cn(
            'absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out',
            checked ? 'translate-x-[18px]' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  );
}

function SelectRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-content">{label}</span>
      <div className="relative">
        <select
          className="input !py-1.5 !pl-2.5 !pr-7 cursor-pointer appearance-none text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  );
}

function ConfigIoButtons() {
  const { toast } = useToast();
  const { verified, openLogin } = useAuth();

  const doExport = async () => {
    if (verified === false) {
      openLogin();
      return;
    }
    try {
      const json = await exportConfig();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LibreTV-Settings_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('配置已导出', 'success');
    } catch {
      toast('导出失败', 'error');
    }
  };

  const doImport = async (file: File) => {
    try {
      const content = await file.text();
      await importConfig(content);
      toast('配置导入成功，即将刷新页面', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  return (
    <div className="flex gap-2">
      <button className="btn-ghost flex-1 text-xs" onClick={doExport}>
        导出配置
      </button>
      <label className="btn-ghost flex-1 text-xs cursor-pointer">
        导入配置
        <input
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImport(f);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
