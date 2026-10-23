// 虾皮批量改价改库存：两个页面——「改价改库存」（选表 → 读当前数据 → 对比 → 提交 → 导出）与「店铺授权」。
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, FileSpreadsheet, KeyRound, Loader2, Play, RefreshCw, Download, ShieldCheck, Trash2 } from 'lucide-react';
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
          {ready ? <><ShieldCheck size={14} />店铺 {cred.shopId} · {cred.site} · {ENVS[cred.env].label}</> : <><KeyRound size={14} />未授权店铺</>}
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
          <section className="k-panel sb-bar">
            <button className="k-btn" onClick={() => void pick()} disabled={busy}><FileSpreadsheet size={15} />{table ? '换一个表格' : '选择表格'}</button>
            <span className="sb-file k-num">{table ? `${table.name} · ${table.rows.length} 行` : '把 .xlsx / .csv 拖进窗口，或点左侧选择'}</span>
            <span className="b-sp" />
            <label className="sb-inline">速度
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
              <div className="sb-stats">
                <span className="sb-stat">共 <b className="k-num">{stats.total}</b> 行</span>
                <span className="sb-stat chg">有变化 <b className="k-num">{stats.change}</b></span>
                <span className="sb-stat">无变化 <b className="k-num">{stats.same}</b></span>
                <span className={`sb-stat${stats.error ? ' bad' : ''}`}>有问题 <b className="k-num">{stats.error}</b></span>
                {stats.big > 0 && <span className="sb-stat warn"><AlertTriangle size={13} />涨跌超 50% <b className="k-num">{stats.big}</b></span>}
              </div>
              <DiffTable rows={diff} results={results} includeBig={includeBig} submitted={stage === 'done'} />
              <section className="k-panel sb-foot">
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
    <section className="k-panel sb-empty">
      <FileSpreadsheet size={28} />
      <b>用表格一次改很多商品的价格和库存</b>
      <span className="k-muted">表头至少要有「商品ID」和「新价格」或「新库存」；多规格商品再加「规格ID」或「规格货号」。先读取店铺当前数据对比，确认无误再提交。</span>
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

function DiffTable({ rows, results, includeBig, submitted }: { rows: DiffRow[]; results: Map<number, RowResult>; includeBig: boolean; submitted: boolean }) {
  return (
    <section className="k-panel sb-tablebox k-scroll">
      <table className="k-table">
        <thead><tr><th>行</th><th>商品 / 规格</th><th>价格</th><th>库存</th><th>状态</th></tr></thead>
        <tbody>
          {rows.slice(0, 1000).map((r) => {
            const res = results.get(r.line);
            const st = submitted || res ? finalState(r, res, includeBig, submitted) : r.status === 'error' ? '有错误' : r.status === 'same' ? '无变化' : r.big && !includeBig ? '未提交' : '待提交';
            const note = r.status === 'error' ? r.error : failReason(res) || (st === '未提交' && r.big ? '涨跌超过 50%，未勾选提交' : '');
            return (
              <tr key={r.line} className={r.status === 'error' ? 'sb-row-err' : ''}>
                <td className="k-num">{r.line}</td>
                <td><div className="sb-name"><span>{r.itemName || (r.itemId ?? '')}</span><span className="k-muted k-num">{r.itemId ?? ''}{r.modelName ? ` · ${r.modelName}` : ''}{r.sku ? ` · ${r.sku}` : ''}</span></div></td>
                <td className="k-num">{r.newPrice == null ? <span className="k-muted">不改</span> : <>{money(r.oldPrice, r.currency)} → <b>{r.newPrice}</b> {r.pricePct != null && <span className={`sb-pct${r.big ? ' big' : r.pricePct > 0 ? ' up' : ' down'}`}>{fmtPct(r.pricePct)}</span>}</>}</td>
                <td className="k-num">{r.newStock == null ? <span className="k-muted">不改</span> : <>{r.oldStock ?? '—'} → <b>{r.newStock}</b></>}</td>
                <td><span className={`sb-st s-${st}`}>{st}</span>{note ? <span className="sb-note"> {note}</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 1000 && <div className="k-muted sb-more">只显示前 1000 行，提交与导出包含全部。</div>}
    </section>
  );
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
        <p className="k-muted">先在 Shopee 开放平台注册开发者并创建应用、通过审核，拿到 Partner ID 和 Partner Key。{'这两项只保存在本机设置文件里，不会上传。'}</p>
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
          <label className="k-field">Partner ID
            <input className="k-input" inputMode="numeric" value={cred.partnerId} onChange={(e) => set({ partnerId: e.target.value.trim() })} />
          </label>
          <label className="k-field">Partner Key
            <input className="k-input" type="password" autoComplete="off" value={cred.partnerKey} onChange={(e) => set({ partnerKey: e.target.value.trim() })} />
          </label>
          <label className="k-field sb-wide">授权回跳地址（须与应用里填写的 Redirect URL 一致）
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
