import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX, buildDiff, buildJobs, createLimiter, diffStats, finalState, mapColumns, parseRedirect, parseRows, priceDecimals, settleJob, resultRows,
  type InputRow, type ItemInfo, type Snapshot,
} from './core';

const H = ['商品ID', '规格ID', '规格货号', '仓库ID', '新价格', '新库存'];
const item = (id: number, models: Partial<ItemInfo['models'][number]>[], hasModel = true): ItemInfo => ({
  itemId: id, name: `示例商品${id}`, hasModel,
  models: models.map((m, i) => ({ modelId: i + 1, sku: '', name: '', price: 100, currency: 'MYR', stocks: [{ location: '', stock: 10 }], ...m })),
});
const snapOf = (...items: ItemInfo[]): Snapshot => new Map(items.map((i) => [i.itemId, i]));
const rowOf = (o: Partial<InputRow>): InputRow => ({ line: 2, itemId: 1, modelId: null, modelSku: '', location: '', newPrice: null, newStock: null, ...o });

describe('表格解析', () => {
  it('中文表头与英文别名都能识别，顺序任意', () => {
    expect(mapColumns(['Item_ID', '新库存', 'Model ID', '新价格'])).toMatchObject({ itemId: 0, newStock: 1, modelId: 2, newPrice: 3 });
  });
  it('缺少商品ID列、缺少价格库存列都会报错', () => {
    expect(() => parseRows(['名称', '新价格'], [], 'MY')).toThrow('商品ID');
    expect(() => parseRows(['商品ID'], [], 'MY')).toThrow('新价格');
  });
  it('正常行：留空表示不改；Excel 的 123.0 与带千分位的数字能解析', () => {
    const r = parseRows(H, [['1001.0', '', '', '', '1,299.50', ''], [1002, 11, '', '', '', 40]], 'MY');
    expect(r[0]).toMatchObject({ line: 2, itemId: 1001, newPrice: 1299.5, newStock: null });
    expect(r[1]).toMatchObject({ line: 3, itemId: 1002, modelId: 11, newPrice: null, newStock: 40 });
    expect(r.every((x) => !x.error)).toBe(true);
  });
  it('问题行写明原因：缺ID、非数字、价格<=0、库存小数、都没填', () => {
    const r = parseRows(H, [['', '', '', '', 5, ''], ['abc', '', '', '', 5, ''], [1, '', '', '', 0, ''], [1, '', '', '', '', 1.5], [1, '', '', '', '', '']], 'MY');
    expect(r[0].error).toContain('缺少商品ID');
    expect(r[1].error).toContain('纯数字');
    expect(r[2].error).toContain('大于 0');
    expect(r[3].error).toContain('不小于 0 的整数');
    expect(r[4].error).toContain('都没填');
  });
  it('价格小数位按站点：MY 最多两位，TW 只能整数', () => {
    expect(priceDecimals('MY')).toBe(2);
    expect(priceDecimals('TW')).toBe(0);
    expect(parseRows(H, [[1, '', '', '', 9.999, '']], 'MY')[0].error).toContain('两位小数');
    expect(parseRows(H, [[1, '', '', '', 9.5, '']], 'TW')[0].error).toContain('整数');
    expect(parseRows(H, [[1, '', '', '', 9, '']], 'TW')[0].error).toBeUndefined();
  });
});

describe('对比', () => {
  it('单规格商品：不填规格ID 直接匹配；填了规格ID 报错', () => {
    const snap = snapOf(item(1, [{ modelId: 0 }], false));
    expect(buildDiff([rowOf({ newPrice: 90 })], snap)[0]).toMatchObject({ status: 'change', modelId: 0, oldPrice: 100, priceChanged: true });
    expect(buildDiff([rowOf({ modelId: 5, newPrice: 90 })], snap)[0].error).toContain('没有规格');
  });
  it('多规格商品：必须指明规格；规格货号重复会报错；可按货号匹配', () => {
    const snap = snapOf(item(1, [{ sku: 'A' }, { sku: 'B' }, { sku: 'B' }]));
    expect(buildDiff([rowOf({ newPrice: 90 })], snap)[0].error).toContain('多个规格');
    expect(buildDiff([rowOf({ modelSku: 'B', newPrice: 90 })], snap)[0].error).toContain('2 个规格');
    expect(buildDiff([rowOf({ modelSku: 'A', newPrice: 90 })], snap)[0]).toMatchObject({ modelId: 1, status: 'change' });
    expect(buildDiff([rowOf({ modelId: 9, newPrice: 90 })], snap)[0].error).toContain('规格ID 9');
  });
  it('无变化、涨跌幅与大幅标记（超过 50%）', () => {
    const snap = snapOf(item(1, [{}, {}, {}]));
    const d = buildDiff([rowOf({ modelId: 1, newPrice: 100, newStock: 10 }), rowOf({ line: 3, modelId: 2, newPrice: 160 }), rowOf({ line: 4, modelId: 3, newPrice: 40 })], snap);
    expect(d[0].status).toBe('same');
    expect(d[1]).toMatchObject({ pricePct: 0.6, big: true });
    expect(d[2]).toMatchObject({ pricePct: -0.6, big: true });
    expect(diffStats(d)).toMatchObject({ change: 2, same: 1, error: 0, big: 2 });
  });
  it('同一规格重复出现、读不到商品、读取失败都标成有错误', () => {
    const snap = snapOf(item(1, [{}]), { ...item(2, []), error: '店铺里没有这个商品（或商品已删除）' });
    const d = buildDiff([rowOf({ modelId: 1, newPrice: 90 }), rowOf({ line: 3, modelId: 1, newPrice: 80 }), rowOf({ line: 4, itemId: 2, newPrice: 1 }), rowOf({ line: 5, itemId: 3, newPrice: 1 })], snap);
    expect(d[1].error).toContain('第 2 行');
    expect(d[2].error).toContain('没有这个商品');
    expect(d[3].error).toContain('没有读到');
  });
  it('多仓库库存必须指定仓库ID，指定后按该仓库对比', () => {
    const snap = snapOf(item(1, [{ stocks: [{ location: 'A', stock: 5 }, { location: 'B', stock: 7 }] }]));
    expect(buildDiff([rowOf({ modelId: 1, newStock: 9 })], snap)[0].error).toContain('2 个仓库');
    expect(buildDiff([rowOf({ modelId: 1, location: 'B', newStock: 9 })], snap)[0]).toMatchObject({ oldStock: 7, status: 'change' });
    expect(buildDiff([rowOf({ modelId: 1, location: 'C', newStock: 9 })], snap)[0].error).toContain('仓库「C」');
  });
});

describe('分组与回填', () => {
  const snap = snapOf(item(1, [{}, {}]), item(2, [{ modelId: 0 }], false));
  const diff = buildDiff([rowOf({ modelId: 1, newPrice: 90, newStock: 20 }), rowOf({ line: 3, modelId: 2, newPrice: 300 }), rowOf({ line: 4, itemId: 2, newStock: 1 })], snap);
  it('按商品分组：每个商品一次改价、一次改库存；大幅涨跌默认不提交，勾选后才提交', () => {
    const jobs = buildJobs(diff, false);
    expect(jobs.map((j) => [j.kind, (j.body as { item_id: number }).item_id, j.lines])).toEqual([['price', 1, [2]], ['stock', 1, [2]], ['stock', 2, [4]]]);
    expect(jobs[0].body).toEqual({ item_id: 1, price_list: [{ model_id: 1, original_price: 90 }] });
    expect(jobs[1].body).toEqual({ item_id: 1, stock_list: [{ model_id: 1, seller_stock: [{ stock: 20 }] }] });
    expect(buildJobs(diff, true)[0].lines).toEqual([2, 3]);
  });
  it(`一个商品超过 ${BATCH_MAX} 个规格时拆成多次`, () => {
    const many = item(1, Array.from({ length: 120 }, () => ({})));
    const d = buildDiff(Array.from({ length: 120 }, (_, i) => rowOf({ line: i + 2, modelId: i + 1, newPrice: 101 })), snapOf(many));
    expect(buildJobs(d, false).map((j) => j.lines.length)).toEqual([50, 50, 20]);
  });
  it('指定仓库时库存请求带 location_id', () => {
    const s = snapOf(item(1, [{ stocks: [{ location: 'B', stock: 7 }] }]));
    const d = buildDiff([rowOf({ modelId: 1, location: 'B', newStock: 9 })], s);
    expect(buildJobs(d, false)[0].body).toEqual({ item_id: 1, stock_list: [{ model_id: 1, seller_stock: [{ location_id: 'B', stock: 9 }] }] });
  });
  it('按 success_list / failure_list 回填；整体报错时全部失败；没返回的算失败', () => {
    const job = buildJobs(diff, true)[0];
    const out = settleJob(job, diff, { success_list: [{ model_id: 1 }], failure_list: [{ model_id: 2, failed_reason: '价格不合规' }] });
    expect(out.get(2)).toEqual({ ok: true });
    expect(out.get(3)).toEqual({ ok: false, reason: '价格不合规' });
    expect(settleJob(job, diff, null, '网络中断').get(2)).toEqual({ ok: false, reason: '网络中断' });
    expect(settleJob(job, diff, { success_list: [] }).get(2)?.reason).toContain('没有返回');
  });
  it('行最终状态与导出行', () => {
    const res = new Map([[2, { price: { ok: true }, stock: { ok: false, reason: '库存不足' } }]]);
    expect(finalState(diff[0], res.get(2), false, true)).toBe('部分失败');
    expect(finalState(diff[1], undefined, false, true)).toBe('未提交');
    const out = resultRows(diff, res, false, true);
    expect(out[0].slice(-2)).toEqual(['部分失败', '改库存：库存不足']);
    expect(out[1].slice(-2)).toEqual(['未提交', '涨跌幅超过 50%，未勾选提交']);
  });
});

describe('限速与授权回跳', () => {
  it('限速器按间隔等待', async () => {
    let t = 0;
    const waits: number[] = [];
    const lim = createLimiter(2, async (ms) => { waits.push(ms); t += ms; }, () => t);
    await lim(); await lim(); await lim();
    expect(waits).toEqual([500, 500]);
  });
  it('解析授权回跳网址：店铺 / 主账号 / 缺参数', () => {
    expect(parseRedirect('https://open.shopee.com/?code=abc123&shop_id=900001')).toEqual({ code: 'abc123', shopId: 900001, mainAccountId: null });
    expect(parseRedirect('https://x.example/cb?code=c&main_account_id=77')).toEqual({ code: 'c', shopId: null, mainAccountId: 77 });
    expect(() => parseRedirect('https://x.example/cb?shop_id=1')).toThrow('code');
    expect(() => parseRedirect('https://x.example/cb?code=c')).toThrow('shop_id');
    expect(() => parseRedirect('')).toThrow('粘贴');
  });
});
