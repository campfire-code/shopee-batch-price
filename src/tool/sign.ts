// Shopee Open API v2 签名（官方开发者指南「API calls → Signature calculation」）：
// 1. 按固定顺序拼接基础串：
//    店铺接口（Shop API）：partner_id + 接口路径 + timestamp + access_token + shop_id
//    公共接口（Public API）：partner_id + 接口路径 + timestamp
//    接口路径不含域名，例如 /api/v2/product/update_price
// 2. 用 partner key 作为密钥，对基础串做 HMAC-SHA256，结果取小写十六进制。
// 用浏览器自带的 Web Crypto 计算，桌面端与测试环境（Node 20+）都可用。

const enc = new TextEncoder();

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 基础串：有 accessToken 与 shopId 时按店铺接口拼接，否则按公共接口拼接 */
export function signBase(partnerId: string | number, path: string, timestamp: number, accessToken?: string, shopId?: string | number): string {
  const base = `${partnerId}${path}${timestamp}`;
  return accessToken != null && shopId != null ? `${base}${accessToken}${shopId}` : base;
}

export function sign(partnerKey: string, partnerId: string | number, path: string, timestamp: number, accessToken?: string, shopId?: string | number) {
  return hmacSha256Hex(partnerKey, signBase(partnerId, path, timestamp, accessToken, shopId));
}
