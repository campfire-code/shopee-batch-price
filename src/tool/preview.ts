// 截图与预览用的示例数据（不会进入正式运行）。店名、商品名均为虚构的「示例」。
import { buildDiff, type DiffRow, type InputRow, type ItemInfo, type RowResult } from './core';
import { EMPTY_CRED } from './api';
import type { DemoState } from './Main';

export const rows = () => [];
export const params = {};

const mk = (id: number, name: string, models: [number, string, string, number, number][]): ItemInfo => ({
  itemId: id, name, hasModel: models.length > 1 || models[0][0] !== 0,
  models: models.map(([modelId, sku, mname, price, stock]) => ({ modelId, sku, name: mname, price, currency: 'MYR', stocks: [{ location: '', stock }] })),
});
const snap = new Map<number, ItemInfo>([
  [1001, mk(1001, '示例商品 · 保温杯 500ml', [[0, 'DEMO-CUP', '', 39.9, 120]])],
  [1002, mk(1002, '示例商品 · 帆布袋', [[11, 'DEMO-BAG-S', '小号', 19.9, 60], [12, 'DEMO-BAG-L', '大号', 25.9, 35]])],
  [1003, mk(1003, '示例商品 · 手机支架', [[0, 'DEMO-STAND', '', 12.5, 300]])],
  [1004, mk(1004, '示例商品 · 数据线', [[0, 'DEMO-CABLE', '', 8.9, 0]])],
  [1005, mk(1005, '示例商品 · 收纳盒', [[0, 'DEMO-BOX', '', 15, 48]])],
]);
const input = (line: number, itemId: number | null, modelId: number | null, price: number | null, stock: number | null, error?: string): InputRow =>
  ({ line, itemId, modelId, modelSku: '', location: '', newPrice: price, newStock: stock, error });
const inputs = [
  input(2, 1001, null, 35.9, 150), input(3, 1002, 11, 21.9, null), input(4, 1003, null, 24.9, null),
  input(5, 1004, null, null, 200), input(6, 9999, null, 10, null),
];
const diff: DiffRow[] = buildDiff(inputs, snap);
const results = new Map<number, RowResult>();

export const demo: DemoState = {
  cred: { ...EMPTY_CRED, env: 'test_sg', site: 'MY', partnerId: '1000001', partnerKey: 'demo', shopId: '900001', accessToken: 'demo', refreshToken: 'demo', expireAt: Date.now() + 3 * 3600_000, refreshExpireAt: Date.now() + 29 * 86400_000 },
  table: { path: '/示例/改价示例.xlsx', name: '改价示例.xlsx', rows: inputs },
  diff, results, stage: 'loaded',
};
