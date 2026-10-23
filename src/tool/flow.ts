// 批量流程：读表 → 读取店铺当前数据 → 对比 → 按商品提交 → 导出结果。
// 只经过传入的读写函数和请求客户端访问外部，便于用假文件系统和录制响应测试。
import type { RunContext } from '../kit/types';
import { ShopeeError, type ShopeeClient } from './api';
import { RESULT_HEADER, buildJobs, exportFileName, parseRows, resultRows, settleJob, type DiffRow, type InputRow, type Outcome, type RowResult } from './core';
import { readTable, writeResultXlsx } from './xlsx';

export type Io = Pick<RunContext, 'readFile' | 'writeFile' | 'join'>;

export interface LoadedTable { path: string; name: string; rows: InputRow[] }

export async function loadTable(io: Io, path: string, site: string): Promise<LoadedTable> {
  const name = path.split(/[\\/]/).pop() || path;
  if (!/\.(xlsx|xls|csv|txt)$/i.test(name)) throw new Error(`「${name}」不是表格，支持 .xlsx 和 .csv`);
  const { header, rows } = await readTable(await io.readFile(path), name);
  if (!rows.length) throw new Error('表格里只有表头，没有数据行');
  return { path, name, rows: parseRows(header, rows, site) };
}

export interface SubmitProgress { done: number; total: number }

/** 逐个任务提交：每个任务前等限速器；平台返回的成功 / 失败按规格回填；授权失效时停下，剩余行保持「未提交」 */
export async function submitAll(
  client: ShopeeClient, diff: DiffRow[], includeBig: boolean, wait: () => Promise<void>,
  o: { onProgress?: (p: SubmitProgress) => void; stopped?: () => boolean; only?: Set<number> } = {},
): Promise<{ results: Map<number, RowResult>; stoppedBy?: string }> {
  const jobs = buildJobs(diff, includeBig, o.only);
  const results = new Map<number, RowResult>();
  let done = 0;
  let stoppedBy: string | undefined;
  for (const job of jobs) {
    if (o.stopped?.()) break;
    let resp = null;
    let err: string | undefined;
    try {
      await wait();
      resp = job.kind === 'price' ? await client.updatePrice(job.body as never) : await client.updateStock(job.body as never);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      if (e instanceof ShopeeError && (e.code === 'invalid_access_token' || e.code === 'error_auth')) stoppedBy = err;
    }
    for (const [line, out] of settleJob(job, diff, resp, err) as Map<number, Outcome>) {
      const cur = results.get(line) ?? {};
      results.set(line, { ...cur, [job.kind]: out });
    }
    o.onProgress?.({ done: ++done, total: jobs.length });
    if (stoppedBy) break;
  }
  return { results, stoppedBy };
}

/** 导出到原文件所在文件夹，返回导出路径 */
export async function exportResult(io: Io, t: LoadedTable, diff: DiffRow[], results: Map<number, RowResult>, includeBig: boolean, submitted: boolean, now = Date.now()) {
  const dir = t.path.slice(0, Math.max(t.path.lastIndexOf('/'), t.path.lastIndexOf('\\')));
  const out = await io.join(dir, exportFileName(now));
  await io.writeFile(out, await writeResultXlsx(RESULT_HEADER, resultRows(diff, results, includeBig, submitted), RESULT_HEADER.indexOf('结果')));
  return out;
}
