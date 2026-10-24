// 虾皮批量改价改库存：两个页面——「改价改库存」（选表 → 读当前数据 → 对比 → 提交 → 导出）与「店铺授权」。
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, ExternalLink, FileSpreadsheet, KeyRound, Loader2, Play, RefreshCw, Download, ShieldCheck, Trash2 } from 'lucide-react';
import type { RunContext } from '../kit/types';
import { httpFetch, openLink, pickFiles, reveal } from '../kit/platform';
import { useDroppedFiles } from '../kit/parts';
import {
  RATE_OPTIONS, SITES, createLimiter, diffStats, buildDiff, buildJobs, failReason, finalState, fmtPct, willSubmit,
  type DiffRow, type RowResult,
} from './core';
import { ENVS, ShopeeClient, appReady, authUrl, loadSnapshot, shopReady, type Cred, type Fetcher } from './api';
import { exportResult, loadTable, submitAll, type LoadedTable } from './flow';
import { parseRedirect } from './core';
import { clearCred, loadCred, saveCred } from './store';
import './tool.css';

type Ctx = Pick<RunContext, 'readFile' | 'writeFile' | 'join'> & Partial<RunContext>;
type Tab = 'work' | 'auth';
type Stage = 'empty' | 'parsed' | 'loading' | 'loaded' | 'submitting' | 'done';
type Notice = { kind: 'ok' | 'err'; text: string; path?: string } | null;

const fetcher: Fetcher = async (url, init) => {
  const r = await httpFetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: r.status, text: await r.text() };
};

const siteName = (k: string) => SITES.find(([c]) => c === k)?.[1] ?? k;
const money = (n: number | null, cur: string) => (n == null ? '—' : `${cur ? cur + ' ' : ''}${n}`);
const expireText = (at: number, now: number) => {
  if (!at) return '未授权';
  const m = Math.round((at - now) / 60000);
  return m <= 0 ? '已过期，使用时会自动刷新' : m < 120 ? `约 ${m} 分钟后过期（过期自动刷新）` : `约 ${Math.round(m / 60)} 小时后过期（过期自动刷新）`;
};

export interface DemoState { cred: Cred; table: LoadedTable; diff: DiffRow[]; results?: Map<number, RowResult>; stage: Stage }

export function Main({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<Tab>('work');
  const [cred, setCred] = useState<Cred | null>(null);
  const [table, setTable] = useState<LoadedTable | null>(null);
  const [diff, setDiff] = useState<DiffRow[]>([]);
  const [results, setResults] = useState<Map<number, RowResult>>(new Map());
  const [stage, setStage] = useState<Stage>('empty');
  const [progress, setProgress] = useState('');
  const [rate, setRate] = useState(2);
  const [includeBig, setIncludeBig] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(Date.now());
  const stopRef = useRef(false);
  const credRef = useRef<Cred | null>(null);
  credRef.current = cred;

  useEffect(() => {
    if (location.pathname.endsWith('preview.html')) {
      import('./preview').then((m) => {
        const d = m.demo;
        setCred(d.cred); setTable(d.table); setDiff(d.diff); setResults(d.results ?? new Map()); setStage(d.stage); setTab('work');
      });
      return;
    }
    loadCred().then((c) => { setCred(c); if (!shopReady(c)) setTab('auth'); });
  }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);

  const updateCred = (c: Cred) => { setCred(c); void saveCred(c); };
  const client = () => new ShopeeClient(credRef.current!, fetcher, { onToken: updateCred });

  const busy = stage === 'loading' || stage === 'submitting';
  const loadFile = async (path: string) => {
    if (busy || !cred) return;
    try {
      const t = await loadTable(ctx as Ctx, path, cred.site);
      setTable(t); setDiff([]); setResults(new Map()); setStage('parsed'); setConfirming(false);
      const bad = t.rows.filter((r) => r.error).length;
      setNotice({ kind: bad ? 'err' : 'ok', text: `读到 ${t.rows.length} 行${bad ? `，其中 ${bad} 行有问题（不会提交），见下表` : ''}。下一步点「读取店铺当前数据」。` });
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };
  const hover = useDroppedFiles((paths) => { if (tab === 'work') void loadFile(paths[0]); });
  const pick = async () => { const p = await pickFiles(['xlsx', 'csv'], '表格'); if (p[0]) await loadFile(p[0]); };

  const readCurrent = async () => {
    if (!table || !cred) return;
    if (!shopReady(cred)) { setTab('auth'); setNotice({ kind: 'err', text: '还没有完成店铺授权，请先在「店铺授权」页完成授权' }); return; }
    stopRef.current = false; setStage('loading'); setNotice(null); setConfirming(false);
    const ids = [...new Set(table.rows.filter((r) => !r.error && r.itemId != null).map((r) => r.itemId!))];
    try {
      const snap = await loadSnapshot(client(), ids, createLimiter(rate), (n) => setProgress(`正在读取商品 ${n} / ${ids.length}`), () => stopRef.current);
      setDiff(buildDiff(table.rows, snap)); setResults(new Map()); setStage('loaded');
    } catch (e) {
      setStage('parsed'); setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const submit = async () => {
    if (!cred) return;
    stopRef.current = false; setStage('submitting'); setConfirming(false); setNotice(null);
    const res = await submitAll(client(), diff, includeBig, createLimiter(rate), {
      onProgress: (p) => setProgress(`正在提交 ${p.done} / ${p.total}`), stopped: () => stopRef.current,
    });
    setResults(res.results); setStage('done');
    const rows = diff.map((r) => finalState(r, res.results.get(r.line), includeBig, true));
    const n = (s: string) => rows.filter((x) => x === s).length;
    setNotice({ kind: n('失败') + n('部分失败') + n('未提交') > 0 && res.stoppedBy ? 'err' : n('失败') + n('部分失败') ? 'err' : 'ok', text: `提交完成：成功 ${n('成功')} 行，失败 ${n('失败') + n('部分失败')} 行${res.stoppedBy ? `。${res.stoppedBy}，已停止，其余行未提交` : ''}。` });
  };

  const doExport = async () => {
    if (!table) return;
    try {
      const p = await exportResult(ctx as Ctx, table, diff, results, includeBig, stage === 'done');
      setNotice({ kind: 'ok', text: `已导出到 ${p}`, path: p });
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const stats = useMemo(() => diffStats(diff), [diff]);
  const jobs = useMemo(() => buildJobs(diff, includeBig), [diff, includeBig]);
  const toSubmit = diff.filter((r) => willSubmit(r, includeBig)).length;
  const items = new Set(jobs.map((j) => (j.body as { item_id: number }).item_id)).size;

  if (!cred) return <div className="sb-root"><span className="k-muted">正在读取本机设置…</span></div>;
  const ready = shopReady(cred);
  return (
    <div className={`sb-root${hover ? ' sb-hover' : ''}`}>
      <div className="sb-tabs" role="tablist" aria-label="功能">
        <button role="tab" aria-selected={tab === 'work'} className={`k-chip${tab === 'work' ? ' on' : ''}`} onClick={() => setTab('work')}>改价改库存</button>
        <button role="tab" aria-selected={tab === 'auth'} className={`k-chip${tab === 'auth' ? ' on' : ''}`} onClick={() => setTab('auth')}>店铺授权</button>
        <span className="b-sp" />
        <span className={`sb-conn${ready ? ' ok' : ''}`}>
          {ready ? <><ShieldCheck size={14} />店铺 {cred.shopId} · {siteName(cred.site)} · {ENVS[cred.env].label}</> : <><KeyRound size={14} />未授权店铺</>}
        </span>
      </div>
      {notice && (
        <div className={`k-notice ${notice.kind}`} role="status">
          <span>{notice.text}</span>
          {notice.path && <button className="k-btn ghost" onClick={() => void reveal(notice.path!)}>在文件夹中显示</button>}
        </div>
      )}
      {tab === 'auth' ? (
        <AuthPage cred={cred} now={now} onChange={updateCred} makeClient={client} setNotice={setNotice} onDone={() => setTab('work')} />
      ) : (
        <div className="sb-work">
          <section className="sb-bar">
            <button className="k-btn" onClick={() => void pick()} disabled={busy}><FileSpreadsheet size={15} />{table ? '换一个表格' : '选择表格'}</button>
            <span className="sb-file k-num">{table ? `${table.name} · ${table.rows.length} 行` : '把 xlsx 或 csv 表格拖进窗口，或点左侧选择'}</span>
            <span className="b-sp" />
            <label className="sb-inline">请求速度
              <select className="k-input sb-sel" value={rate} onChange={(e) => setRate(Number(e.target.value))} disabled={busy}>
                {RATE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {busy
              ? <button className="k-btn" onClick={() => { stopRef.current = true; }}>停止</button>
              : <button className="k-btn primary" disabled={!table} onClick={() => void readCurrent()}>{stage === 'empty' || stage === 'parsed' ? <Play size={15} /> : <RefreshCw size={15} />}读取店铺当前数据</button>}
          </section>
          {busy && <div className="sb-progress"><Loader2 size={15} className="k-spin" />{progress}</div>}
          {!table && <Empty />}
          {table && stage === 'parsed' && <ParsedTable table={table} />}
          {diff.length > 0 && (
            <>
              <Hero rows={diff} stats={stats} includeBig={includeBig} />
              <Ruler rows={diff} results={results} includeBig={includeBig} submitted={stage === 'done'} />
              <section className="sb-dock">
                {stats.big > 0 && (
                  <label className="sb-check"><input type="checkbox" checked={includeBig} disabled={busy || stage === 'done'} onChange={(e) => setIncludeBig(e.target.checked)} />
                    我已核对，涨跌超过 50% 的 {stats.big} 行也一起提交</label>
                )}
                <span className="b-sp" />
                {stage === 'done' || stage === 'loaded' ? <button className="k-btn" onClick={() => void doExport()}><Download size={15} />导出结果表</button> : null}
                {stage === 'loaded' && !confirming && <button className="k-btn primary" disabled={!toSubmit} onClick={() => setConfirming(true)}>提交 {toSubmit} 行改动</button>}
                {stage === 'loaded' && confirming && (
                  <span className="sb-confirm">
                    将向店铺真实修改 {items} 个商品、共 {toSubmit} 行，提交后无法撤销。
                    <button className="k-btn" onClick={() => setConfirming(false)}>取消</button>
                    <button className="k-btn primary" onClick={() => void submit()}><Check size={15} />确认提交</button>
                  </span>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <section className="sb-empty">
      <svg className="sb-art" viewBox="0 0 560 150" role="img" aria-label="示意图：改价表对照店铺现价，在价格标尺上核对后提交">
        <rect x="8" y="30" width="116" height="90" rx="10" className="a-box" />
        <path d="M24 56h84M24 76h84M24 96h56" className="a-line" />
        <rect x="222" y="30" width="116" height="90" rx="10" className="a-box" />
        <path d="M240 75h80" className="a-axis" />
        <path d="M280 62v26" className="a-tick" />
        <circle cx="304" cy="75" r="6" className="a-dot up" />
        <circle cx="256" cy="75" r="6" className="a-dot down" />
        <rect x="436" y="30" width="116" height="90" rx="10" className="a-box" />
        <path d="M452 56h84M452 76h84M452 96h84" className="a-line" />
        <path d="M436 52h116" className="a-roof" />
        <path d="M130 75h86M344 75h86" className="a-flow" />
        <path d="M210 69l8 6-8 6M424 69l8 6-8 6" className="a-flow" />
        <text x="66" y="142" textAnchor="middle" className="a-cap">改价表</text>
        <text x="280" y="142" textAnchor="middle" className="a-cap">价格标尺</text>
        <text x="494" y="142" textAnchor="middle" className="a-cap">店铺商品</text>
      </svg>
      <b>表里的新价，落在标尺的哪一格，一眼看清</b>
      <span className="k-muted">读取店铺当前价格和库存后，每个规格画成一条标尺：圆点偏左是降价，偏右是涨价，落进两端斜纹区的涨跌超过 50%，默认不提交。</span>
      <ul className="sb-need">
        <li><b>商品ID</b>：必填</li>
        <li><b>新价格</b>或<b>新库存</b>：至少一列</li>
        <li><b>规格ID</b>或<b>规格货号</b>：多规格商品加</li>
      </ul>
    </section>
  );
}

function ParsedTable({ table }: { table: LoadedTable }) {
  return (
    <section className="k-panel sb-tablebox k-scroll">
      <table className="k-table">
        <thead><tr><th>行</th><th>商品ID</th><th>规格ID</th><th>规格货号</th><th>新价格</th><th>新库存</th><th>检查</th></tr></thead>
        <tbody>
          {table.rows.slice(0, 500).map((r) => (
            <tr key={r.line}>
              <td className="k-num">{r.line}</td><td className="k-num">{r.itemId ?? ''}</td><td className="k-num">{r.modelId ?? ''}</td><td>{r.modelSku}</td>
              <td className="k-num">{r.newPrice ?? ''}</td><td className="k-num">{r.newStock ?? ''}</td>
              <td>{r.error ? <span className="sb-bad">{r.error}</span> : <span className="sb-ok">格式正确</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
const SPAN = 0.8; // 标尺左右各显示到 80% 涨跌幅
const place = (p: number) => 50 + (Math.max(-SPAN, Math.min(SPAN, p)) / SPAN) * 50;

function Hero({ rows, stats, includeBig }: { rows: DiffRow[]; stats: ReturnType<typeof diffStats>; includeBig: boolean }) {
  const priced = rows.filter((r) => r.status === 'change' && r.priceChanged && r.pricePct != null);
  const avg = priced.length ? priced.reduce((a, r) => a + r.pricePct!, 0) / priced.length : 0;
  const up = priced.filter((r) => r.pricePct! > 0).length;
  const stockRows = rows.filter((r) => r.status === 'change' && r.stockChanged);
  const net = stockRows.reduce((a, r) => a + (r.newStock ?? 0) - (r.oldStock ?? 0), 0);
  const held = rows.filter((r) => r.big && !includeBig).length;
  return (
    <section className="sb-hero" aria-label="本次改动概览">
      <div className="sb-tile main">
        <span className="sb-tile-k">平均调价幅度</span>
        <b className="sb-big k-num">{priced.length ? `${sign(avg)}${Math.abs(avg * 100).toFixed(1)}%` : '—'}</b>
        <span className="sb-tile-s">{priced.length} 行改价 · 涨 {up} · 降 {priced.length - up}</span>
      </div>
      <div className="sb-tile">
        <span className="sb-tile-k">库存净变化</span>
        <b className="sb-big k-num">{stockRows.length ? `${sign(net)}${Math.abs(net)}` : '—'}</b>
        <span className="sb-tile-s">{stockRows.length} 行改库存</span>
      </div>
      <div className={`sb-tile${held ? ' warn' : ''}`}>
        <span className="sb-tile-k">被拦下待核对</span>
        <b className="sb-big k-num">{held}</b>
        <span className="sb-tile-s">涨跌超 50% 的行</span>
      </div>
      <div className={`sb-tile${stats.error ? ' bad' : ''}`}>
        <span className="sb-tile-k">有问题的行</span>
        <b className="sb-big k-num">{stats.error}</b>
        <span className="sb-tile-s">共 {stats.total} 行 · 无变化 {stats.same}</span>
      </div>
    </section>
  );
}

type Filter = 'all' | 'change' | 'watch' | 'error';

function Ruler({ rows, results, includeBig, submitted }: { rows: DiffRow[]; results: Map<number, RowResult>; includeBig: boolean; submitted: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const count = (f: Filter) => rows.filter((r) => pass(r, f)).length;
  const shown = rows.filter((r) => pass(r, filter));
  return (
    <section className="sb-ruler">
      <div className="sb-ruler-hd">
        <div className="sb-filters" role="group" aria-label="筛选">
          {([['all', '全部'], ['change', '有变化'], ['watch', '需留意'], ['error', '有问题']] as [Filter, string][]).map(([k, l]) => (
            <button key={k} className={`k-chip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} <span className="k-num">{count(k)}</span></button>
          ))}
        </div>
        <div className="sb-scale">圆点偏左是降价，偏右是涨价；斜纹区表示涨跌超过 50%</div>
      </div>
      <div className="sb-list k-scroll">
        {shown.slice(0, 1000).map((r) => {
          const res = results.get(r.line);
          const st = submitted || res ? finalState(r, res, includeBig, submitted) : r.status === 'error' ? '有错误' : r.status === 'same' ? '无变化' : r.big && !includeBig ? '未提交' : '待提交';
          const note = r.status === 'error' ? r.error : failReason(res) || (st === '未提交' && r.big ? '涨跌超过 50%，未勾选提交' : '');
          const p = r.pricePct;
          const w = p == null ? 0 : Math.abs(place(p) - 50);
          return (
            <article key={r.line} className={`sb-item${r.status === 'error' ? ' err' : ''}${r.big ? ' big' : ''}`}>
              <div className="sb-who">
                <b title={r.itemName || String(r.itemId ?? '')}>{r.itemName || (r.itemId ?? `第 ${r.line} 行`)}</b>
                <span className="k-muted k-num">第 {r.line} 行 · {r.itemId ?? ''}{r.modelName ? ` · ${r.modelName}` : ''}{r.sku ? ` · ${r.sku}` : ''}</span>
              </div>
              {r.status === 'error' ? <div className="sb-errline"><AlertTriangle size={14} />{note}</div> : (
                <>
                  <div className="sb-track-box">
                    {r.newPrice == null ? <span className="k-muted sb-nochg">这行不改价</span> : (
                      <>
                        <div className="sb-track" role="img" aria-label={`价格${r.pricePct == null ? '' : fmtPct(r.pricePct)}`}>
                          <i className="sb-zero" />
                          {p != null && <i className={`sb-bar-fill ${p >= 0 ? 'up' : 'down'}${r.big ? ' big' : ''}`} style={{ left: `${Math.min(50, place(p))}%`, width: `${w}%` }} />}
                          {p != null && <i className={`sb-pin ${p >= 0 ? 'up' : 'down'}${r.big ? ' big' : ''}`} style={{ left: `${place(p)}%` }} />}
                        </div>
                        <div className="sb-price k-num">{money(r.oldPrice, r.currency)}<ArrowRight size={13} /><b>{r.newPrice}</b>{p != null && <span className={`sb-pct${r.big ? ' big' : p > 0 ? ' up' : ' down'}`}>{fmtPct(p)}</span>}</div>
                      </>
                    )}
                  </div>
                  <div className="sb-stock k-num">
                    {r.newStock == null ? <span className="k-muted">不改库存</span> : <><span className="k-muted">库存</span> {r.oldStock ?? '—'}<ArrowRight size={13} /><b>{r.newStock}</b></>}
                  </div>
                </>
              )}
              <div className="sb-state"><span className={`sb-st s-${st}`}>{st}</span>{note && r.status !== 'error' ? <span className="sb-note">{note}</span> : null}</div>
            </article>
          );
        })}
        {shown.length === 0 && <div className="k-muted sb-more">这一类没有行。</div>}
        {shown.length > 1000 && <div className="k-muted sb-more">只显示前 1000 行，提交与导出包含全部。</div>}
      </div>
    </section>
  );
}

function pass(r: DiffRow, f: Filter) {
  return f === 'all' ? true : f === 'change' ? r.status === 'change' : f === 'error' ? r.status === 'error' : r.big;
}

function AuthPage({ cred, now, onChange, makeClient, setNotice, onDone }: {
  cred: Cred; now: number; onChange: (c: Cred) => void; makeClient: () => ShopeeClient; setNotice: (n: Notice) => void; onDone: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Cred>) => onChange({ ...cred, ...p });
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); } catch (e) { setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="sb-auth">
      <section className="k-panel sb-card">
        <h3>1. 开放平台应用信息</h3>
        <p className="k-muted">先在 Shopee 开放平台注册开发者并创建应用、通过审核，拿到 Partner ID（合作方编号）和 Partner Key（合作方密钥）。这两项只保存在本机设置文件里，不会上传。</p>
        <div className="sb-grid">
          <label className="k-field">环境
            <select className="k-input" value={cred.env} onChange={(e) => set({ env: e.target.value as Cred['env'] })}>
              {Object.entries(ENVS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="k-field">店铺所在站点（决定价格能不能带小数）
            <select className="k-input" value={cred.site} onChange={(e) => set({ site: e.target.value })}>
              {SITES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="k-field">Partner ID（合作方编号）
            <input className="k-input" inputMode="numeric" value={cred.partnerId} onChange={(e) => set({ partnerId: e.target.value.trim() })} />
          </label>
          <label className="k-field">Partner Key（合作方密钥）
            <input className="k-input" type="password" autoComplete="off" value={cred.partnerKey} onChange={(e) => set({ partnerKey: e.target.value.trim() })} />
          </label>
          <label className="k-field sb-wide">授权回跳地址（须与应用里填写的回跳地址完全一致）
            <input className="k-input" value={cred.redirect} onChange={(e) => set({ redirect: e.target.value.trim() })} />
          </label>
        </div>
      </section>
      <section className="k-panel sb-card">
        <h3>2. 授权店铺</h3>
        <p className="k-muted">点「打开授权页」，用卖家账号登录并确认授权。浏览器会跳到回跳地址，把地址栏里的完整网址复制回来粘贴到下面。</p>
        <div className="sb-row">
          <button className="k-btn" disabled={!appReady(cred)} onClick={() => void openLink(authUrl(cred))}><ExternalLink size={15} />打开授权页</button>
        </div>
        <input className="k-input" placeholder="粘贴授权完成后浏览器地址栏里的完整网址" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="sb-row">
          <button className="k-btn primary" disabled={busy || !appReady(cred) || !url.trim()} onClick={() => void run(async () => {
            const r = parseRedirect(url);
            await makeClient().getToken(r.code, r.shopId, r.mainAccountId);
            setUrl(''); setNotice({ kind: 'ok', text: '授权成功，可以去改价了。授权码只能使用一次，且很快过期。' }); onDone();
          })}>{busy ? <Loader2 size={15} className="k-spin" /> : <KeyRound size={15} />}换取令牌</button>
        </div>
      </section>
      <section className="k-panel sb-card">
        <h3>3. 当前授权</h3>
        {shopReady(cred) ? (
          <ul className="sb-kv">
            <li><span>店铺 ID</span><b className="k-num">{cred.shopId}</b></li>
            <li><span>访问令牌</span><b>{expireText(cred.expireAt, now)}</b></li>
            <li><span>刷新令牌</span><b>{cred.refreshExpireAt ? `约 ${Math.max(0, Math.round((cred.refreshExpireAt - now) / 86400000))} 天后过期，期间每次使用都会续期` : '—'}</b></li>
          </ul>
        ) : <p className="k-muted">还没有授权店铺。</p>}
        <div className="sb-row">
          <button className="k-btn" disabled={busy || !shopReady(cred) || !cred.refreshToken} onClick={() => void run(async () => { await makeClient().refresh(); setNotice({ kind: 'ok', text: '令牌已刷新' }); })}><RefreshCw size={15} />立即刷新令牌</button>
          <button className="k-btn ghost" onClick={() => { void clearCred(); onChange({ ...cred, partnerKey: '', shopId: '', accessToken: '', refreshToken: '', expireAt: 0, refreshExpireAt: 0, shopIdList: undefined }); }}><Trash2 size={15} />清除本机保存的密钥和令牌</button>
        </div>
      </section>
    </div>
  );
}
