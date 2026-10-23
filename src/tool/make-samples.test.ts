// 生成 samples/ 里的示例文件（只在设置了 MAKE_SAMPLES=1 时运行）
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';

export const SAMPLE_HEADER = ['商品ID', '规格ID', '规格货号', '仓库ID', '新价格', '新库存'];
export const SAMPLE_ROWS: (string | number)[][] = [
  [1001, '', '', '', 35.9, 150],
  [1002, 11, '', '', 21.9, ''],
  [1002, '', 'DEMO-BAG-L', '', 25.9, 40],
  [1003, '', '', '', 24.9, ''],
  [1004, '', '', '', '', 200],
  [1005, '', '', '', '16.50', 50],
  [1006, '', '', '', 'abc', ''],
];

it.runIf(process.env.MAKE_SAMPLES === '1')('生成示例文件', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('改价');
  ws.addRow(SAMPLE_HEADER).font = { bold: true };
  SAMPLE_ROWS.forEach((r) => ws.addRow(r));
  writeFileSync('samples/改价示例.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  writeFileSync('samples/改价示例.csv', '﻿' + [SAMPLE_HEADER, ...SAMPLE_ROWS].map((r) => r.join(',')).join('\n') + '\n');
});
