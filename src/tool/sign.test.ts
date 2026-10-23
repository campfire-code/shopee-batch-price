import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sign, signBase } from './sign';

describe('签名', () => {
  it('HMAC-SHA256 与 RFC 4231 测试用例 2 一致', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('与上游 congminh1254/shopee-sdk 的签名单元测试示例值一致', async () => {
    // 上游 src/__tests__/utils/signature.test.ts：密钥 test_partner_key，各段直接拼接
    const base = ['/api/v2/auth/token/get', '123456', 'test_partner_id', 'test_shop_id', 'test_main_account_id'].join('');
    expect(await hmacSha256Hex('test_partner_key', base)).toBe('37c864bd9821ff5f2c2f46b2faca14eb1811a718d1fdc6dcf383cba7c74bf9e9');
  });

  it('店铺接口基础串与官方指南示例一致', () => {
    // 官方指南示例：partner_id 2001887，/api/v2/shop/get_shop_info，1655714431，access_token，shop_id 14701711
    expect(signBase(2001887, '/api/v2/shop/get_shop_info', 1655714431, '59777174636562737266615546704c6d', 14701711))
      .toBe('2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711');
  });

  it('公共接口基础串与官方指南示例一致', () => {
    expect(signBase(2001887, '/api/v2/public/get_shops_by_partner', 1655714431)).toBe('2001887/api/v2/public/get_shops_by_partner1655714431');
  });

  it('sign 等于对基础串做 HMAC，结果为 64 位小写十六进制', async () => {
    const s = await sign('k', 1, '/api/v2/product/update_price', 1700000000, 'tok', 9);
    expect(s).toBe(await hmacSha256Hex('k', '1/api/v2/product/update_price1700000000tok9'));
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });
});
