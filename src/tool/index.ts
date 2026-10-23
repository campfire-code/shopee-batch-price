// 工具声明：虾皮批量改价改库存（自定义界面；请求只发往 Shopee 开放平台官方接口）。
import { Store } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'e13',
  name: '虾皮批量改价改库存',
  tagline: '走 Shopee 官方接口：用表格一次改多个商品的价格和库存，先和店铺当前数据对比，确认后再提交，并导出每一行的结果。',
  icon: Store,
  category: '电商运营',
  type: 'data',
  mode: 'custom',
  mainLabel: '改价改库存',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
