// 店铺凭据只保存在本机设置文件 settings.json（键 cred.e13），不上传、不写日志。
import { settingsStore } from '../kit/platform';
import { EMPTY_CRED, type Cred } from './api';

const KEY = 'cred.e13';

export async function loadCred(): Promise<Cred> {
  try {
    const v = await (await settingsStore()).get<Partial<Cred>>(KEY);
    return { ...EMPTY_CRED, ...(v ?? {}) };
  } catch {
    return EMPTY_CRED;
  }
}

export async function saveCred(c: Cred): Promise<void> {
  try {
    await (await settingsStore()).set(KEY, c);
  } catch {
    // 预览页里没有本机设置文件，忽略
  }
}

export async function clearCred(): Promise<void> {
  await saveCred(EMPTY_CRED);
}
