// 批量流程：假的请求函数 + 官方文档示例形式的响应（fixtures/），不访问真实网络；内存假文件系统。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { EMPTY_CRED, ENVS, ShopeeClient, authUrl, loadSnapshot, type Cred, type Fetcher } from './api';
import { buildDiff } from './core';
import { exportResult, loadTable, submitAll, type Io } from './flow';
import { hmacSha256Hex } from './sign';
import { readTable } from './xlsx';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8');
const NOW = 1_700_000_000_000;
const cred: Cred = { ...EMPTY_CRED, env: 'live_sg', site: 'MY', partnerId: '1000001', partnerKey: 'KEY_SECRET', shopId: '900001', accessToken: 'ACCESS_TOK', refreshToken: 'REFRESH_TOK', expireAt: NOW + 3600_000, refreshExpireAt: NOW + 20 * 86400_000 };

interface Call { url: URL; method: string; body: unknown }
function fake(routes: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const c = { url: new URL(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const h = routes[c.url.pathname];
    if (!h) throw new Error('未模拟的接口 ' + c.url.pathname);
    const r = h(c);
    return { status: 200, text: typeof r === 'string' ? r : JSON.stringify(r) };
  };
  return { fetcher, calls };
}
const ok = (response: unknown) => ({ error: '', message: '', request_id: 'r', response });
const noWait = async () => {};

const itemRoutes = {
  '/api/v2/product/get_item_base_info': (c: Call) => {
    const id = Number(c.url.searchParams.get('item_id_list'));
    if (id === 1001) return ok({ item_list: [{ item_id: 1001, item_name: '示例商品 · 保温杯', has_model: false, item_sku: 'DEMO-CUP', price_info: [{ currency: 'MYR', original_price: 39.9, current_price: 39.9 }], stock_info_v2: { seller_stock: [{ location_id: '-', stock: 120 }] } }] });
    if (id === 1002) return ok({ item_list: [{ item_id: 1002, item_name: '示例商品 · 帆布袋', has_model: true }] });
    return ok({ item_list: [] });
  },
  '/api/v2/product/get_model_list': () => ok({
    tier_variation: [{ name: '尺寸', option_list: [{ option: '小号' }, { option: '大号' }] }],
    model: [
      { model_id: 11, model_sku: 'DEMO-BAG-S', tier_index: [0], price_info: [{ currency: 'MYR', original_price: 19.9 }], stock_info_v2: { seller_stock: [{ stock: 60 }] } },
      { model_id: 12, model_sku: 'DEMO-BAG-L', tier_index: [1], price_info: [{ currency: 'MYR', original_price: 25.9 }], stock_info_v2: { seller_stock: [{ stock: 35 }] } },
    ],
  }),
};

describe('客户端与请求', () => {
  it('店铺接口请求：签名、查询参数、域名都正确，密钥不出现在请求里', async () => {
    const { fetcher, calls } = fake({ '/api/v2/product/update_price': () => JSON.parse(fx('doc-update_price')) });
    const client = new ShopeeClient(cred, fetcher, { now: () => NOW });
    const r = await client.updatePrice({ item_id: 1, price_list: [{ model_id: 0, original_price: 11.11 }] });
    expect(r.success_list?.[0].model_id).toBe(0);
    const c = calls[0];
    expect(c.url.origin).toBe(ENVS.live_sg.host);
    expect(c.method).toBe('POST');
    const q = c.url.searchParams;
    expect(q.get('partner_id')).toBe('1000001');
    expect(q.get('timestamp')).toBe(String(NOW / 1000));
    expect(q.get('shop_id')).toBe('900001');
    expect(q.get('sign')).toBe(await hmacSha256Hex('KEY_SECRET', `1000001/api/v2/product/update_price${NOW / 1000}ACCESS_TOK900001`));
    expect(c.url.toString()).not.toContain('KEY_SECRET');
    expect(JSON.stringify(c.body)).not.toContain('KEY_SECRET');
  });

  it('授权链接带 partner_id、redirect_uri 等参数', () => {
    const u = new URL(authUrl({ ...cred, env: 'live_cn', redirect: 'https://example.com/cb' }));
    expect(u.origin + u.pathname).toBe('https://open.shopee.cn/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ partner_id: '1000001', redirect_uri: 'https://example.com/cb', response_type: 'code', auth_type: 'seller' });
  });

  it('用授权码换令牌：公共接口签名不含令牌；保存新令牌并回调保存', async () => {
    const { fetcher, calls } = fake({ '/api/v2/auth/token/get': () => JSON.parse(fx('doc-refresh_access_token')) });
    let saved: Cred | null = null;
    const client = new ShopeeClient({ ...EMPTY_CRED, partnerId: '1000001', partnerKey: 'KEY_SECRET' }, fetcher, { now: () => NOW, onToken: (c) => void (saved = c) });
    const c = await client.getToken('CODE', 322300222, null);
    expect(calls[0].body).toEqual({ code: 'CODE', partner_id: 1000001, shop_id: 322300222 });
    expect(calls[0].url.searchParams.get('sign')).toBe(await hmacSha256Hex('KEY_SECRET', `1000001/api/v2/auth/token/get${NOW / 1000}`));
    expect(calls[0].url.searchParams.has('access_token')).toBe(false);
    expect(c).toMatchObject({ shopId: '322300222', accessToken: '71594a4c54537649697341796363674a', expireAt: NOW + 14400_000 });
    expect(saved).toBe(c);
  });

  it('主账号授权返回店铺列表时取第一个店铺；expire_in 异常按 4 小时', async () => {
    const { fetcher } = fake({ '/api/v2/auth/token/get': () => JSON.parse(fx('doc-get_access_token').replace('"message": ""', '"message": "",')) });
    const c = await new ShopeeClient({ ...EMPTY_CRED, partnerId: '1', partnerKey: 'k' }, fetcher, { now: () => NOW }).getToken('C', null, 5);
    expect(c.shopId).toBe('368765100');
    expect(c.shopIdList).toHaveLength(3);
    expect(c.expireAt).toBe(NOW + 4 * 3600_000);
  });

  it('令牌快过期时先刷新（用 refresh_token），新令牌立刻保存再发业务请求', async () => {
    const order: string[] = [];
    const { fetcher, calls } = fake({
      '/api/v2/auth/access_token/get': () => { order.push('refresh'); return JSON.parse(fx('doc-refresh_access_token')); },
      '/api/v2/product/update_price': () => { order.push('price'); return ok({ success_list: [{ model_id: 0 }] }); },
    });
    const saved: Cred[] = [];
    const client = new ShopeeClient({ ...cred, expireAt: NOW + 10_000 }, fetcher, { now: () => NOW, onToken: (c) => void saved.push(c) });
    await client.updatePrice({ item_id: 1, price_list: [{ model_id: 0, original_price: 5 }] });
    expect(order).toEqual(['refresh', 'price']);
    expect(calls[0].body).toEqual({ refresh_token: 'REFRESH_TOK', partner_id: 1000001, shop_id: 900001 });
    expect(saved[0].refreshToken).toBe('516c6b577753554375764a63704d7245');
    expect(calls[1].url.searchParams.get('access_token')).toBe('71594a4c54537649697341796363674a');
  });

  it('平台报错转成中文提示，授权失效时读取直接抛出', async () => {
    const { fetcher } = fake({ '/api/v2/product/get_item_base_info': () => ({ error: 'invalid_access_token', message: 'Invalid access_token', request_id: 'x' }) });
    const client = new ShopeeClient(cred, fetcher, { now: () => NOW });
    await expect(client.getItem(1)).rejects.toThrow('重新授权');
    await expect(loadSnapshot(client, [1, 2], noWait)).rejects.toThrow('重新授权');
  });
});

describe('读取 → 对比 → 提交 → 导出', () => {
  it('完整批量流程：部分成功、部分失败、大幅涨跌默认不提交', async () => {
    const submitted: unknown[] = [];
    const { fetcher } = fake({
      ...itemRoutes,
      '/api/v2/product/update_price': (c) => {
        submitted.push(['price', c.body]);
        const b = c.body as { item_id: number; price_list: { model_id: number }[] };
        return b.item_id === 1002
          ? ok({ success_list: [{ model_id: 11 }], failure_list: [{ model_id: 12, failed_reason: '价格低于最低限价' }] })
          : ok({ success_list: b.price_list.map((p) => ({ model_id: p.model_id })) });
      },
      '/api/v2/product/update_stock': (c) => { submitted.push(['stock', c.body]); return ok({ success_list: [{ model_id: 0 }] }); },
    });
    const client = new ShopeeClient(cred, fetcher, { now: () => NOW });
    const files = new Map<string, Uint8Array>();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('改价');
    [['商品ID', '规格ID', '规格货号', '新价格', '新库存'], [1001, '', '', 35.9, 150], [1002, 11, '', 21.9, ''], [1002, '', 'DEMO-BAG-L', 20.9, ''], [1001, '', '', 88, ''], [9999, '', '', 10, ''], ['x', '', '', 10, '']].forEach((r) => ws.addRow(r));
    files.set('/示例/改价.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
    const io: Io = { readFile: async (p) => files.get(p)!, writeFile: async (p, d) => void files.set(p, d), join: async (...p) => p.join('/') };

    const t = await loadTable(io, '/示例/改价.xlsx', 'MY');
    expect(t.rows).toHaveLength(6);
    expect(t.rows[5].error).toContain('纯数字');
    const snap = await loadSnapshot(client, [1001, 1002, 9999], noWait);
    expect(snap.get(1002)!.models.map((m) => m.name)).toEqual(['小号', '大号']);
    expect(snap.get(1001)!.models[0].stocks).toEqual([{ location: '', stock: 120 }]);
    const diff = buildDiff(t.rows, snap);
    expect(diff.map((d) => d.status)).toEqual(['change', 'change', 'change', 'error', 'error', 'error']);
    expect(diff[3].error).toContain('第 2 行'); // 同规格重复
    expect(diff[4].error).toContain('没有这个商品');

    const { results, stoppedBy } = await submitAll(client, diff, false, noWait);
    expect(stoppedBy).toBeUndefined();
    expect(submitted).toEqual([
      ['price', { item_id: 1001, price_list: [{ model_id: 0, original_price: 35.9 }] }],
      ['stock', { item_id: 1001, stock_list: [{ model_id: 0, seller_stock: [{ stock: 150 }] }] }],
      ['price', { item_id: 1002, price_list: [{ model_id: 11, original_price: 21.9 }, { model_id: 12, original_price: 20.9 }] }],
    ]);
    expect(results.get(2)).toEqual({ price: { ok: true }, stock: { ok: true } });
    expect(results.get(4)?.price).toEqual({ ok: false, reason: '价格低于最低限价' });

    const out = await exportResult(io, t, diff, results, false, true, new Date(2026, 9, 23, 9, 5).getTime());
    expect(out).toBe('/示例/虾皮改价结果-20261023-0905.xlsx');
    const back = await readTable(files.get(out)!, 'x.xlsx');
    expect(back.header.slice(-2)).toEqual(['结果', '说明']);
    expect(back.rows.map((r) => r[13])).toEqual(['成功', '成功', '失败', '有错误', '有错误', '有错误']);
    expect(back.rows[2][14]).toContain('价格低于最低限价');
  });

  it('授权失效：当前任务记失败并停止，后面的任务不再发送', async () => {
    let n = 0;
    const { fetcher } = fake({
      ...itemRoutes,
      '/api/v2/product/update_price': () => { n++; return { error: 'error_auth', message: 'x', request_id: 'r' }; },
    });
    const client = new ShopeeClient(cred, fetcher, { now: () => NOW });
    const snap = await loadSnapshot(client, [1001, 1002], noWait);
    const diff = buildDiff([
      { line: 2, itemId: 1001, modelId: null, modelSku: '', location: '', newPrice: 36, newStock: null },
      { line: 3, itemId: 1002, modelId: 11, modelSku: '', location: '', newPrice: 20, newStock: null },
    ], snap);
    const r = await submitAll(client, diff, false, noWait);
    expect(n).toBe(1);
    expect(r.stoppedBy).toContain('重新授权');
    expect(r.results.get(2)?.price?.ok).toBe(false);
    expect(r.results.has(3)).toBe(false);
  });

  it('点「停止」后不再发新请求', async () => {
    const { fetcher, calls } = fake(itemRoutes);
    const client = new ShopeeClient(cred, fetcher, { now: () => NOW });
    await loadSnapshot(client, [1001, 1002], noWait, undefined, () => calls.length >= 1);
    expect(calls).toHaveLength(1);
  });

  it('每次请求前都会等限速器', async () => {
    const { fetcher } = fake(itemRoutes);
    let waits = 0;
    await loadSnapshot(new ShopeeClient(cred, fetcher, { now: () => NOW }), [1001, 1002], async () => void waits++);
    expect(waits).toBe(3); // 1001 一次；1002 查商品 + 查规格
  });
});

describe('samples 示例表', () => {
  it('xlsx 与 csv 解析结果一致：7 行，只有第 8 行有问题', async () => {
    const io: Io = { readFile: async (p) => new Uint8Array(readFileSync(p)), writeFile: async () => {}, join: async (...p) => p.join('/') };
    const a = await loadTable(io, 'samples/改价示例.xlsx', 'MY');
    const b = await loadTable(io, 'samples/改价示例.csv', 'MY');
    expect(a.rows).toHaveLength(7);
    expect(b.rows).toEqual(a.rows);
    expect(a.rows.filter((r) => r.error).map((r) => r.line)).toEqual([8]);
    expect(a.rows[6].error).toContain('不是数字');
  });
});
