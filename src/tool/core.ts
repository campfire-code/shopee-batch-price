// 纯函数：表格解析与校验、差异计算、按商品分组提交、结果回填、限速器、授权回跳地址解析。
// 不依赖界面和本机能力，便于单元测试。

export type Cell = string | number | boolean | Date | null;

// ---------- 站点与价格精度 ----------

/** 官方接口文档 v2.product.update_price：SG/MY/BR/MX/PL/ES/AR 可以设两位小数，其他站点只能设整数 */
export const DECIMAL_SITES = ['SG', 'MY', 'BR', 'MX', 'PL', 'ES', 'AR'];
export const SITES: [string, string][] = [
  ['SG', '新加坡 SG'], ['MY', '马来西亚 MY'], ['TW', '台湾 TW'], ['TH', '泰国 TH'], ['VN', '越南 VN'], ['ID', '印尼 ID'], ['PH', '菲律宾 PH'],
  ['BR', '巴西 BR'], ['MX', '墨西哥 MX'], ['CO', '哥伦比亚 CO'], ['CL', '智利 CL'], ['PL', '波兰 PL'], ['ES', '西班牙 ES'], ['AR', '阿根廷 AR'],
];
export const priceDecimals = (site: string) => (DECIMAL_SITES.includes(site) ? 2 : 0);

// ---------- 输入表格 ----------

export interface InputRow {
  /** Excel 里的行号（表头是第 1 行） */
  line: number;
  itemId: number | null;
  modelId: number | null;
  modelSku: string;
  location: string;
  newPrice: number | null;
  newStock: number | null;
  error?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-（）()：:]/g, '');
const ALIASES: Record<'itemId' | 'modelId' | 'modelSku' | 'location' | 'newPrice' | 'newStock', string[]> = {
  itemId: ['商品ID', '商品编号', 'item_id', 'itemid', '商品id'],
  modelId: ['规格ID', 'model_id', 'modelid', '变体ID'],
  modelSku: ['规格货号', '货号', 'model_sku', 'sku', '卖家SKU'],
  location: ['仓库ID', 'location_id', '仓库编号'],
  newPrice: ['新价格', '新原价', 'original_price', 'new_price', '价格'],
  newStock: ['新库存', 'new_stock', 'stock', '库存'],
};

/** 按表头找列：返回各字段所在列号（找不到为 -1） */
export function mapColumns(header: string[]) {
  const h = header.map((x) => norm(String(x ?? '')));
  const find = (names: string[]) => {
    for (const n of names) {
      const i = h.indexOf(norm(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  return Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, find(v)])) as Record<keyof typeof ALIASES, number>;
}

const str = (v: Cell | undefined) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim());
const isBlank = (v: Cell | undefined) => str(v) === '';

function parseId(v: Cell | undefined): number | null | 'bad' {
  const s = str(v).replace(/\.0+$/, '');
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'bad';
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 'bad';
}

function parseNum(v: Cell | undefined): number | null | 'bad' {
  if (isBlank(v)) return null;
  const s = typeof v === 'number' ? String(v) : str(v).replace(/[,，\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'bad';
  return Number(s);
}

const decimalsOf = (n: number) => {
  const s = String(n);
  return s.includes('.') ? s.split('.')[1].length : 0;
};

/** 解析表格为改动行：留空的价格 / 库存表示不改；有问题的行写进 error */
export function parseRows(header: string[], rows: Cell[][], site: string): InputRow[] {
  const col = mapColumns(header);
  if (col.itemId < 0) throw new Error('表头里没有「商品ID」列（也可写 item_id）');
  if (col.newPrice < 0 && col.newStock < 0) throw new Error('表头里没有「新价格」或「新库存」列');
  const dec = priceDecimals(site);
  return rows.map((r, i) => {
    const get = (c: number) => (c >= 0 ? r[c] : null);
    const row: InputRow = { line: i + 2, itemId: null, modelId: null, modelSku: str(get(col.modelSku)), location: str(get(col.location)), newPrice: null, newStock: null };
    const errs: string[] = [];
    const item = parseId(get(col.itemId));
    if (item === 'bad') errs.push('商品ID 应为纯数字');
    else if (item == null) errs.push('缺少商品ID');
    else row.itemId = item;
    const model = parseId(get(col.modelId));
    if (model === 'bad') errs.push('规格ID 应为纯数字');
    else row.modelId = model;
    const price = parseNum(get(col.newPrice));
    if (price === 'bad') errs.push('新价格不是数字');
    else if (price != null) {
      if (price <= 0) errs.push('新价格必须大于 0');
      else if (decimalsOf(price) > dec) errs.push(dec ? '新价格最多两位小数' : '该站点价格只能是整数');
      row.newPrice = price;
    }
    const stock = parseNum(get(col.newStock));
    if (stock === 'bad') errs.push('新库存不是数字');
    else if (stock != null) {
      if (stock < 0 || !Number.isInteger(stock)) errs.push('新库存应为不小于 0 的整数');
      row.newStock = stock;
    }
    if (price == null && stock == null) errs.push('新价格和新库存都没填');
    if (errs.length) row.error = errs.join('；');
    return row;
  });
}

// ---------- 店铺当前数据（查询接口的结果整理） ----------

export interface StockLoc { location: string; stock: number }
export interface ModelInfo {
  modelId: number;
  sku: string;
  name: string;
  price: number | null;
  currency: string;
  stocks: StockLoc[];
}
export interface ItemInfo {
  itemId: number;
  name: string;
  hasModel: boolean;
  models: ModelInfo[];
  error?: string;
}
export type Snapshot = Map<number, ItemInfo>;

// ---------- 差异 ----------

export type DiffStatus = 'change' | 'same' | 'error';
export interface DiffRow {
  line: number;
  itemId: number | null;
  modelId: number | null;
  itemName: string;
  modelName: string;
  sku: string;
  location: string;
  currency: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldStock: number | null;
  newStock: number | null;
  priceChanged: boolean;
  stockChanged: boolean;
  /** 价格涨跌幅（0.6 表示涨 60%），算不出来为 null */
  pricePct: number | null;
  /** 涨跌幅超过 50%，需要额外勾选才提交 */
  big: boolean;
  status: DiffStatus;
  error?: string;
}

export const BIG_CHANGE = 0.5;
const sumStock = (s: StockLoc[]) => s.reduce((a, x) => a + x.stock, 0);

export function buildDiff(rows: InputRow[], snap: Snapshot): DiffRow[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const d: DiffRow = {
      line: r.line, itemId: r.itemId, modelId: r.modelId, itemName: '', modelName: '', sku: r.modelSku, location: r.location, currency: '',
      oldPrice: null, newPrice: r.newPrice, oldStock: null, newStock: r.newStock, priceChanged: false, stockChanged: false, pricePct: null, big: false, status: 'error',
    };
    const fail = (e: string) => ({ ...d, status: 'error' as const, error: e });
    if (r.error) return fail(r.error);
    const item = snap.get(r.itemId!);
    if (!item) return fail('没有读到这个商品的当前数据');
    d.itemName = item.name;
    if (item.error) return fail(item.error);
    let model: ModelInfo | undefined;
    if (!item.hasModel) {
      if (r.modelId) return fail('这个商品没有规格，规格ID 请留空或填 0');
      model = item.models[0];
    } else if (r.modelId) {
      model = item.models.find((m) => m.modelId === r.modelId);
      if (!model) return fail(`商品下没有规格ID ${r.modelId}`);
    } else if (r.modelSku) {
      const hits = item.models.filter((m) => m.sku === r.modelSku);
      if (hits.length > 1) return fail(`有 ${hits.length} 个规格的货号都是「${r.modelSku}」，请改填规格ID`);
      model = hits[0];
      if (!model) return fail(`商品下没有货号为「${r.modelSku}」的规格`);
    } else return fail('这个商品有多个规格，请填写规格ID 或规格货号');
    if (!model) return fail('没有读到规格数据');
    d.modelId = model.modelId;
    d.modelName = model.name;
    d.sku = model.sku;
    d.currency = model.currency;
    const key = `${item.itemId}:${model.modelId}`;
    if (seen.has(key)) return fail(`与第 ${seen.get(key)} 行是同一个规格，重复了`);
    seen.set(key, r.line);
    d.oldPrice = model.price;
    if (r.newStock != null) {
      if (r.location) {
        const loc = model.stocks.find((s) => s.location === r.location);
        if (!loc && model.stocks.some((s) => s.location)) return fail(`该规格没有仓库「${r.location}」`);
        d.oldStock = loc ? loc.stock : sumStock(model.stocks);
      } else {
        const locs = model.stocks.filter((s) => s.location);
        if (locs.length > 1) return fail(`该规格分布在 ${locs.length} 个仓库，请在「仓库ID」列指定改哪个`);
        d.location = locs[0]?.location ?? '';
        d.oldStock = sumStock(model.stocks);
      }
    } else d.oldStock = sumStock(model.stocks);
    d.priceChanged = r.newPrice != null && r.newPrice !== d.oldPrice;
    d.stockChanged = r.newStock != null && r.newStock !== d.oldStock;
    if (d.priceChanged && d.oldPrice) {
      d.pricePct = (r.newPrice! - d.oldPrice) / d.oldPrice;
      d.big = Math.abs(d.pricePct) > BIG_CHANGE;
    }
    d.status = d.priceChanged || d.stockChanged ? 'change' : 'same';
    return d;
  });
}

export function diffStats(rows: DiffRow[]) {
  return {
    total: rows.length,
    change: rows.filter((r) => r.status === 'change').length,
    same: rows.filter((r) => r.status === 'same').length,
    error: rows.filter((r) => r.status === 'error').length,
    big: rows.filter((r) => r.status === 'change' && r.big).length,
  };
}

// ---------- 提交 ----------

/** 官方文档：price_list / stock_list 每次 1 到 50 条 */
export const BATCH_MAX = 50;

export interface PriceReq { item_id: number; price_list: { model_id: number; original_price: number }[] }
export interface StockReq { item_id: number; stock_list: { model_id: number; seller_stock: { location_id?: string; stock: number }[] }[] }
export interface Job { kind: 'price' | 'stock'; body: PriceReq | StockReq; lines: number[] }

/** 要提交的行：有变化、未出错；涨跌幅超 50% 的行只有勾选了才提交 */
export const willSubmit = (r: DiffRow, includeBig: boolean) => r.status === 'change' && (includeBig || !r.big);

/** 按商品分组，每个商品一次改价、一次改库存（超过 50 个规格再拆分） */
export function buildJobs(rows: DiffRow[], includeBig: boolean, only?: Set<number>): Job[] {
  const jobs: Job[] = [];
  const byItem = new Map<number, DiffRow[]>();
  for (const r of rows) {
    if (!willSubmit(r, includeBig) || (only && !only.has(r.line))) continue;
    const list = byItem.get(r.itemId!) ?? [];
    list.push(r);
    byItem.set(r.itemId!, list);
  }
  for (const [itemId, list] of byItem) {
    const prices = list.filter((r) => r.priceChanged);
    const stocks = list.filter((r) => r.stockChanged);
    for (let i = 0; i < prices.length; i += BATCH_MAX) {
      const part = prices.slice(i, i + BATCH_MAX);
      jobs.push({ kind: 'price', lines: part.map((r) => r.line), body: { item_id: itemId, price_list: part.map((r) => ({ model_id: r.modelId!, original_price: r.newPrice! })) } });
    }
    for (let i = 0; i < stocks.length; i += BATCH_MAX) {
      const part = stocks.slice(i, i + BATCH_MAX);
      jobs.push({
        kind: 'stock', lines: part.map((r) => r.line),
        body: { item_id: itemId, stock_list: part.map((r) => ({ model_id: r.modelId!, seller_stock: [r.location ? { location_id: r.location, stock: r.newStock! } : { stock: r.newStock! }] })) },
      });
    }
  }
  return jobs;
}

export type Outcome = { ok: boolean; reason?: string };
export interface RowResult { price?: Outcome; stock?: Outcome }

/** 接口返回的 success_list / failure_list 按规格ID 回填到行 */
export function settleJob(job: Job, rows: DiffRow[], resp: { success_list?: { model_id: number }[]; failure_list?: { model_id: number; failed_reason?: string }[] } | null, err?: string): Map<number, Outcome> {
  const out = new Map<number, Outcome>();
  const byLine = new Map(rows.map((r) => [r.line, r]));
  for (const line of job.lines) {
    if (err != null) { out.set(line, { ok: false, reason: err }); continue; }
    const mid = byLine.get(line)!.modelId;
    const f = resp?.failure_list?.find((x) => x.model_id === mid);
    if (f) out.set(line, { ok: false, reason: f.failed_reason || '平台未说明原因' });
    else if (resp?.success_list?.some((x) => x.model_id === mid)) out.set(line, { ok: true });
    else out.set(line, { ok: false, reason: '平台没有返回这个规格的结果，请到卖家中心核对' });
  }
  return out;
}

export type FinalState = '成功' | '部分失败' | '失败' | '未提交' | '无变化' | '有错误' | '待提交';

export function finalState(r: DiffRow, res: RowResult | undefined, includeBig: boolean, submitted: boolean): FinalState {
  if (r.status === 'error') return '有错误';
  if (r.status === 'same') return '无变化';
  if (!willSubmit(r, includeBig) && !res) return '未提交';
  if (!res || (r.priceChanged && !res.price) || (r.stockChanged && !res.stock)) return submitted ? '未提交' : '待提交';
  const parts = [r.priceChanged ? res.price! : null, r.stockChanged ? res.stock! : null].filter(Boolean) as Outcome[];
  const ok = parts.filter((p) => p.ok).length;
  return ok === parts.length ? '成功' : ok === 0 ? '失败' : '部分失败';
}

export function failReason(res: RowResult | undefined) {
  const out: string[] = [];
  if (res?.price && !res.price.ok) out.push(`改价：${res.price.reason}`);
  if (res?.stock && !res.stock.ok) out.push(`改库存：${res.stock.reason}`);
  return out.join('；');
}

// ---------- 导出 ----------

export const RESULT_HEADER = ['行号', '商品ID', '规格ID', '商品名称', '规格', '规格货号', '仓库ID', '币种', '原价格', '新价格', '涨跌幅', '原库存', '新库存', '结果', '说明'];

export const fmtPct = (p: number | null) => (p == null ? '' : `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`);

export function resultRows(rows: DiffRow[], results: Map<number, RowResult>, includeBig: boolean, submitted: boolean): Cell[][] {
  return rows.map((r) => {
    const res = results.get(r.line);
    const st = finalState(r, res, includeBig, submitted);
    const note = st === '有错误' ? r.error ?? '' : st === '未提交' && r.big && !includeBig ? '涨跌幅超过 50%，未勾选提交' : failReason(res);
    return [r.line, r.itemId, r.modelId, r.itemName, r.modelName, r.sku, r.location, r.currency, r.oldPrice, r.newPrice, fmtPct(r.pricePct), r.oldStock, r.newStock, st, note];
  });
}

export function exportFileName(now: number) {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `虾皮改价结果-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
}

// ---------- 限速 ----------

/** 每秒最多 perSec 次：每次调用前 await limiter()，自动等到下一个可用时间点 */
export function createLimiter(perSec: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), now: () => number = () => Date.now()) {
  const gap = 1000 / Math.max(0.1, perSec);
  let next = 0;
  return async () => {
    const t = now();
    const wait = Math.max(0, next - t);
    next = Math.max(t, next) + gap;
    if (wait > 0) await sleep(wait);
  };
}

/** 界面可选的速度；Shopee 接口文档未公布这几个接口的具体限流，以平台为准 */
export const RATE_OPTIONS: [number, string][] = [[1, '每秒 1 次'], [2, '每秒 2 次（推荐）'], [5, '每秒 5 次'], [10, '每秒 10 次']];

// ---------- 授权 ----------

/** 解析授权完成后浏览器跳转到的地址：取出 code 与 shop_id（或 main_account_id） */
export function parseRedirect(input: string): { code: string; shopId: number | null; mainAccountId: number | null } {
  const s = input.trim();
  if (!s) throw new Error('请粘贴授权完成后浏览器地址栏里的完整网址');
  let q: URLSearchParams;
  try {
    q = new URL(s).searchParams;
  } catch {
    q = new URLSearchParams(s.includes('?') ? s.slice(s.indexOf('?') + 1) : s);
  }
  const code = q.get('code') ?? '';
  if (!code) throw new Error('网址里没有 code 参数，请确认已在授权页点了「确认授权」，并复制跳转后的完整网址');
  const num = (k: string) => (q.get(k) && /^\d+$/.test(q.get(k)!) ? Number(q.get(k)) : null);
  const shopId = num('shop_id');
  const mainAccountId = num('main_account_id');
  if (shopId == null && mainAccountId == null) throw new Error('网址里没有 shop_id，请确认授权的是店铺');
  return { code, shopId, mainAccountId };
}
