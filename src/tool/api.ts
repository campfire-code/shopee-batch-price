// Shopee Open API v2 客户端：只封装本工具用到的接口。请求函数从外部注入，测试时换成录制 / 模拟的响应。
// 接口地址、参数、域名均取自 Shopee 开放平台官方文档（open.shopee.com 开发者指南「API calls」「Authorization and Authentication」
// 与接口文档 v2.product.get_item_base_info / get_model_list / update_price / update_stock、v2.public.get_access_token / refresh_access_token）。
import { sign } from './sign';
import type { ItemInfo, ModelInfo, PriceReq, Snapshot, StockLoc, StockReq } from './core';

export type EnvId = 'live_cn' | 'live_sg' | 'live_br' | 'test_sg' | 'test_cn';
/** 接口域名与授权页地址：官方开发者指南 API domains 与授权链接表 */
export const ENVS: Record<EnvId, { label: string; host: string; auth: string }> = {
  live_cn: { label: '正式环境 · 中国大陆', host: 'https://openplatform.shopee.cn', auth: 'https://open.shopee.cn/auth' },
  live_sg: { label: '正式环境 · 全球（新加坡）', host: 'https://partner.shopeemobile.com', auth: 'https://open.shopee.com/auth' },
  live_br: { label: '正式环境 · 巴西', host: 'https://openplatform.shopee.com.br', auth: 'https://open.shopee.com.br/auth' },
  test_sg: { label: '沙箱 · 全球', host: 'https://openplatform.sandbox.test-stable.shopee.sg', auth: 'https://open.sandbox.test-stable.shopee.com/auth' },
  test_cn: { label: '沙箱 · 中国大陆', host: 'https://openplatform.test-stable.shopee.cn', auth: 'https://open.sandbox.test-stable.shopee.cn/auth' },
};

export interface Cred {
  env: EnvId;
  partnerId: string;
  partnerKey: string;
  site: string;
  redirect: string;
  shopId: string;
  accessToken: string;
  refreshToken: string;
  /** access_token 到期时间（毫秒） */
  expireAt: number;
  /** refresh_token 到期时间（毫秒，官方说明 30 天） */
  refreshExpireAt: number;
  /** 用主账号授权时返回的店铺列表 */
  shopIdList?: number[];
}

export const EMPTY_CRED: Cred = { env: 'live_cn', partnerId: '', partnerKey: '', site: 'MY', redirect: 'https://open.shopee.com', shopId: '', accessToken: '', refreshToken: '', expireAt: 0, refreshExpireAt: 0 };

export const appReady = (c: Cred) => /^\d+$/.test(c.partnerId) && c.partnerKey.length > 0;
export const shopReady = (c: Cred) => appReady(c) && /^\d+$/.test(c.shopId) && (c.accessToken.length > 0 || c.refreshToken.length > 0);

/** 生成授权链接（官方开发者指南：固定授权地址 + partner_id、auth_type、redirect_uri、response_type=code） */
export function authUrl(c: Cred, state?: string) {
  const u = new URL(ENVS[c.env].auth);
  u.searchParams.set('partner_id', c.partnerId);
  u.searchParams.set('auth_type', 'seller');
  u.searchParams.set('redirect_uri', c.redirect);
  u.searchParams.set('response_type', 'code');
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

export type Fetcher = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>;

export class ShopeeError extends Error {
  constructor(public code: string, message: string, public requestId?: string) {
    super(message);
  }
}

const HINTS: Record<string, string> = {
  invalid_access_token: '店铺令牌无效或已过期，请到「店铺授权」重新授权',
  error_auth: '店铺授权失效，请到「店铺授权」重新授权',
};

const ACCESS_TTL = 4 * 3600_000;
const REFRESH_TTL = 30 * 24 * 3600_000;

export class ShopeeClient {
  private now: () => number;
  constructor(public cred: Cred, private fetcher: Fetcher, private opts: { now?: () => number; onToken?: (c: Cred) => void | Promise<void> } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  private async request<T>(path: string, method: 'GET' | 'POST', o: { query?: Record<string, string | number>; body?: unknown; shop?: boolean }): Promise<T> {
    const c = this.cred;
    if (!appReady(c)) throw new Error('还没有填写 Partner ID 和 Partner Key');
    const full = `/api/v2${path}`;
    const ts = Math.floor(this.now() / 1000);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) q.set(k, String(v));
    q.set('partner_id', c.partnerId);
    q.set('timestamp', String(ts));
    if (o.shop) {
      q.set('access_token', c.accessToken);
      q.set('shop_id', c.shopId);
    }
    q.set('sign', await sign(c.partnerKey, c.partnerId, full, ts, o.shop ? c.accessToken : undefined, o.shop ? c.shopId : undefined));
    const res = await this.fetcher(`${ENVS[c.env].host}${full}?${q}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new ShopeeError('http', `平台返回了无法识别的内容（HTTP ${res.status}）`);
    }
    const err = typeof json.error === 'string' ? json.error : '';
    if (err && err !== '-') {
      const msg = typeof json.message === 'string' ? json.message : '';
      throw new ShopeeError(err, `${HINTS[err] || msg || err}（${err}）`, json.request_id as string | undefined);
    }
    if (res.status >= 400) throw new ShopeeError('http', `请求失败（HTTP ${res.status}）`);
    return json as T;
  }

  /** 店铺接口调用前：令牌快过期就先刷新（refresh_token 只能用一次，新令牌立刻保存） */
  private async shop<T>(path: string, method: 'GET' | 'POST', o: { query?: Record<string, string | number>; body?: unknown }) {
    if (!shopReady(this.cred)) throw new Error('还没有完成店铺授权');
    if (!this.cred.accessToken || this.cred.expireAt - 60_000 < this.now()) await this.refresh();
    return this.request<T>(path, method, { ...o, shop: true });
  }

  private async saveToken(r: { access_token: string; refresh_token: string; expire_in?: number }, patch: Partial<Cred>) {
    const now = this.now();
    // 官方说明 access_token 有效期 4 小时；expire_in 为秒数，异常时按 4 小时计
    const ttl = r.expire_in && r.expire_in > 0 && r.expire_in <= 86400 ? r.expire_in * 1000 : ACCESS_TTL;
    this.cred = { ...this.cred, ...patch, accessToken: r.access_token, refreshToken: r.refresh_token, expireAt: now + ttl, refreshExpireAt: now + REFRESH_TTL };
    await this.opts.onToken?.(this.cred);
    return this.cred;
  }

  /** v2.public.get_access_token：用授权回跳里的 code 换取令牌 */
  async getToken(code: string, shopId: number | null, mainAccountId: number | null) {
    const body: Record<string, string | number> = { code, partner_id: Number(this.cred.partnerId) };
    if (shopId != null) body.shop_id = shopId;
    if (mainAccountId != null) body.main_account_id = mainAccountId;
    const r = await this.request<{ access_token: string; refresh_token: string; expire_in?: number; shop_id_list?: number[] }>('/auth/token/get', 'POST', { body });
    const list = r.shop_id_list ?? [];
    const sid = shopId ?? (list.length ? list[0] : null);
    if (sid == null) throw new Error('授权成功但没有返回店铺，请确认授权的是店铺账号');
    return this.saveToken(r, { shopId: String(sid), shopIdList: list.length ? list : undefined });
  }

  /** v2.public.refresh_access_token：用 refresh_token 换新的 access_token 与 refresh_token */
  async refresh() {
    if (!this.cred.refreshToken) throw new Error('店铺令牌已过期，且没有刷新令牌，请重新授权');
    const r = await this.request<{ access_token: string; refresh_token: string; expire_in?: number }>('/auth/access_token/get', 'POST', {
      body: { refresh_token: this.cred.refreshToken, partner_id: Number(this.cred.partnerId), shop_id: Number(this.cred.shopId) },
    });
    return this.saveToken(r, {});
  }

  /** v2.product.get_item_base_info（一次查一个商品） */
  async getItem(itemId: number) {
    const r = await this.shop<{ response?: { item_list?: RawItem[] } }>('/product/get_item_base_info', 'GET', { query: { item_id_list: itemId } });
    return r.response?.item_list?.find((x) => x.item_id === itemId) ?? null;
  }

  /** v2.product.get_model_list */
  async getModels(itemId: number) {
    const r = await this.shop<{ response?: RawModels }>('/product/get_model_list', 'GET', { query: { item_id: itemId } });
    return r.response ?? { model: [], tier_variation: [] };
  }

  /** v2.product.update_price */
  async updatePrice(body: PriceReq) {
    const r = await this.shop<{ response?: UpdateResp }>('/product/update_price', 'POST', { body });
    return r.response ?? {};
  }

  /** v2.product.update_stock */
  async updateStock(body: StockReq) {
    const r = await this.shop<{ response?: UpdateResp }>('/product/update_stock', 'POST', { body });
    return r.response ?? {};
  }
}

export interface UpdateResp { success_list?: { model_id: number }[]; failure_list?: { model_id: number; failed_reason?: string }[] }

interface RawPrice { currency?: string; original_price?: number; current_price?: number }
interface RawStock { seller_stock?: { location_id?: string; stock?: number }[] }
export interface RawItem { item_id: number; item_name?: string; item_sku?: string; has_model?: boolean; item_status?: string; price_info?: RawPrice[]; stock_info_v2?: RawStock }
export interface RawModels {
  tier_variation?: { name?: string; option_list?: { option?: string }[] }[];
  model?: { model_id: number; model_sku?: string; tier_index?: number[]; price_info?: RawPrice[]; stock_info_v2?: RawStock }[];
}

const stocksOf = (s?: RawStock): StockLoc[] => (s?.seller_stock ?? []).map((x) => ({ location: x.location_id && x.location_id !== '-' ? x.location_id : '', stock: Number(x.stock ?? 0) }));

export function toItemInfo(item: RawItem, models: RawModels | null): ItemInfo {
  const base = { itemId: item.item_id, name: item.item_name ?? '', hasModel: Boolean(item.has_model) };
  if (!item.has_model || !models) {
    const p = item.price_info?.[0];
    return { ...base, hasModel: false, models: [{ modelId: 0, sku: item.item_sku ?? '', name: '', price: p?.original_price ?? null, currency: p?.currency ?? '', stocks: stocksOf(item.stock_info_v2) }] };
  }
  const tiers = models.tier_variation ?? [];
  const list: ModelInfo[] = (models.model ?? []).map((m) => {
    const p = m.price_info?.[0];
    const name = (m.tier_index ?? []).map((idx, t) => tiers[t]?.option_list?.[idx]?.option ?? '').filter(Boolean).join(' / ');
    return { modelId: m.model_id, sku: m.model_sku ?? '', name, price: p?.original_price ?? null, currency: p?.currency ?? '', stocks: stocksOf(m.stock_info_v2) };
  });
  return { ...base, models: list };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 逐个商品读取当前价格与库存（每次请求前等限速器） */
export async function loadSnapshot(client: ShopeeClient, itemIds: number[], wait: () => Promise<void>, onStep?: (done: number) => void, stopped?: () => boolean): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  let done = 0;
  for (const id of itemIds) {
    if (stopped?.()) break;
    try {
      await wait();
      const item = await client.getItem(id);
      if (!item) snap.set(id, { itemId: id, name: '', hasModel: false, models: [], error: '店铺里没有这个商品（或商品已删除）' });
      else {
        let models: RawModels | null = null;
        if (item.has_model) {
          await wait();
          models = await client.getModels(id);
        }
        snap.set(id, toItemInfo(item, models));
      }
    } catch (e) {
      // 授权类错误所有商品都会失败，直接抛出让界面提示重新授权
      if (e instanceof ShopeeError && HINTS[e.code]) throw e;
      snap.set(id, { itemId: id, name: '', hasModel: false, models: [], error: `读取失败：${errText(e)}` });
    }
    onStep?.(++done);
  }
  return snap;
}
