// 截图与预览用的示例数据（不会进入正式运行）。店名、商品名均为虚构。
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
  [1001, mk(1001, '316 不锈钢保温杯 500 毫升', [[0, '20310-01', '', 39.9, 120]])],
  [1002, mk(1002, '加厚帆布购物袋', [[11, '20422-S', '小号', 19.9, 60], [12, '20422-L', '大号', 25.9, 35]])],
  [1003, mk(1003, '桌面折叠手机支架', [[0, '20518-01', '', 12.5, 300]])],
  [1004, mk(1004, '快充编织数据线 2 米', [[0, '20633-02', '', 8.9, 0]])],
  [1005, mk(1005, '桌面收纳盒三件套', [[0, '20745-03', '', 15, 48]])],
  [1006, mk(1006, '硅胶防滑杯垫', [[0, '20861-01', '', 6.5, 210]])],
  [1007, mk(1007, '可折叠洗衣篮', [[0, '20977-05', '', 22, 75]])],
]);
const input = (line: number, itemId: number | null, modelId: number | null, price: number | null, stock: number | null, error?: string): InputRow =>
  ({ line, itemId, modelId, modelSku: '', location: '', newPrice: price, newStock: stock, error });
const inputs = [
  input(2, 1001, null, 35.9, 150), input(3, 1002, 11, 21.9, null), input(4, 1002, 12, 23.9, 50), input(5, 1003, null, 24.9, null),
  input(6, 1004, null, null, 200), input(7, 1005, null, 15, 60), input(8, 1006, null, 7.2, 180), input(9, 1007, null, 18.5, 90), input(10, 9999, null, 10, null),
];
const diff: DiffRow[] = buildDiff(inputs, snap);
const results = new Map<number, RowResult>();

export const demo: DemoState = {
  cred: { ...EMPTY_CRED, env: 'test_sg', site: 'MY', partnerId: '1000001', partnerKey: 'preview-key', shopId: '900001', accessToken: 'preview-token', refreshToken: 'preview-refresh', expireAt: Date.now() + 3 * 3600_000, refreshExpireAt: Date.now() + 29 * 86400_000 },
  table: { path: '/店铺运营/大促改价表.xlsx', name: '大促改价表.xlsx', rows: inputs },
  diff, results, stage: 'loaded',
};
