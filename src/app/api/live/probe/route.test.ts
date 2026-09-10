import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 测活接口单测：流式 NDJSON、codec 解析、内容校验、结果缓存、内网放行。
 * 上游一律用 mock fetch，不产生真实网络请求。
 */

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="hvc1.1.6.L93.B0,mp4a.40.2"',
  'media.m3u8',
  '',
].join('\n');

const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg1.ts', ''].join('\n');

const HTML = '<!doctype html><html><body>error</body></html>';

function jsonRes(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/** 按 URL 分发的上游 mock：master / media / segment 正常，fake 站返回 HTML */
function mockUpstream(): { fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/master.m3u8')) return jsonRes(MASTER, 'application/vnd.apple.mpegurl');
    if (url.includes('/media.m3u8')) return jsonRes(MEDIA, 'application/vnd.apple.mpegurl');
    if (url.includes('/seg1.ts')) {
      return new Response('binary', { status: 206, headers: { 'content-type': 'video/mp2t' } });
    }
    if (url.includes('/fake-page.m3u8')) return jsonRes(HTML, 'text/html; charset=utf-8');
    if (url.includes('/fake-stream.flv')) return jsonRes(HTML, 'text/html; charset=utf-8');
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn };
}

function makeRequest(urls: string[], stream: boolean): Request {
  const { token } = signSession();
  return new Request(`https://local.test/api/live/probe${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: JSON.stringify({ urls }),
  });
}

async function readNdjson(res: Response) {
  const text = await res.text();
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  delete process.env.PROXY_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/live/probe', () => {
  it('stream=1 以 NDJSON 逐条返回，并解析 master 的 CODECS', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://iptv.test/master.m3u8'], true));
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');

    const lines = await readNdjson(res);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      url: 'https://iptv.test/master.m3u8',
      ok: true,
      level: 'segment',
      codec: 'hvc1.1.6.L93.B0,mp4a.40.2',
    });
  });

  it('非流式请求保持原有 JSON 结构（向后兼容）', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://iptv.test/master.m3u8?json=1'], false));
    const data = (await res.json()) as { results: Record<string, unknown>[] };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ ok: true, level: 'segment' });
  });

  it('返回 HTML 的伪 m3u8 判为不可用', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://fake.test/fake-page.m3u8'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('不是有效的 m3u8');
  });

  it('返回 HTML 的伪直链判为不可用（content-type 校验）', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://fake.test/fake-stream.flv'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('不是流媒体');
  });

  it('成功结果命中服务端缓存，重复测活不再请求上游', async () => {
    const { fn } = mockUpstream();
    const url = 'https://iptv.test/master.m3u8?cache-check=1';
    // 必须读完流（读到 controller.close）才能确保首轮探测已完成
    const first = await POST(makeRequest([url], true));
    const [firstLine] = await readNdjson(first);
    expect(firstLine.ok).toBe(true);
    const callsAfterFirst = fn.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const res = await POST(makeRequest([url], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(true);
    expect(fn.mock.calls.length).toBe(callsAfterFirst);
  });

  it('未开启 LIVE_ALLOW_PRIVATE 时拒绝内网地址', async () => {
    mockUpstream();
    delete process.env.LIVE_ALLOW_PRIVATE;
    const res = await POST(makeRequest(['http://127.0.0.1:8080/live.m3u8'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('允许范围');
  });

  it('开启 LIVE_ALLOW_PRIVATE 后自建内网源可正常探测（与直播代理口径一致）', async () => {
    process.env.LIVE_ALLOW_PRIVATE = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes(MASTER, 'application/vnd.apple.mpegurl'))
    );
    try {
      const res = await POST(makeRequest(['http://192.168.1.10:8080/iptv/master.m3u8'], true));
      const [line] = await readNdjson(res);
      expect(line.ok).toBe(true);
    } finally {
      delete process.env.LIVE_ALLOW_PRIVATE;
    }
  });
});
