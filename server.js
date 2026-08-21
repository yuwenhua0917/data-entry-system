/**
 * 内外径检测数据录入系统
 *
 * 双模式运行：
 *   本地模式（无 DATABASE_URL）：数据存 data/*.json，端口 8787
 *   云端模式（有 DATABASE_URL）：数据存 PostgreSQL，端口用 process.env.PORT
 *
 * 云端部署后二维码地址永久固定，手机 4G/5G 直接扫码访问。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const db = require('./db');

const PORT = parseInt(process.env.PORT || '8787', 10);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- 时间工具 ----------
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDateTime(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function genId() { return crypto.randomUUID(); }

// ---------- 网络 ----------
function getLanIps() {
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips.length ? ips : ['localhost'];
}

// ---------- HTTP 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

// ---------- 校验 ----------
function isNumber(v) { return typeof v === 'number' && isFinite(v); }
function asNonNegativeInt(v, field) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!isNumber(n) || n < 0) throw new Error(`${field} 必须为不小于 0 的数字`);
  return Math.round(n);
}

// ---------- 业务逻辑 ----------
async function buildRecord(body) {
  const deviceId = String(body.deviceId || '').trim();
  if (!deviceId) throw new Error('设备编码不能为空');

  const record = {
    id: genId(),
    deviceId,
    production: asNonNegativeInt(body.production, '生产数量'),
    ng: asNonNegativeInt(body.ng, 'NG品数据'),
    ngInner: asNonNegativeInt(body.ngInner, '内径不良数'),
    ngOuter: asNonNegativeInt(body.ngOuter, '外径不良数'),
    shift: String(body.shift || '').trim(),
    operator: String(body.operator || '').trim(),
    remark: String(body.remark || '').trim(),
    createdAt: fmtDateTime(),
    date: fmtDate(),
    ts: Date.now(),
  };

  const devices = await db.getDevices();
  if (devices[deviceId]) {
    record.deviceName = devices[deviceId].name || deviceId;
  } else {
    await db.saveDevice({ id: deviceId, name: deviceId, line: '', createdAt: fmtDateTime() });
    record.deviceName = deviceId;
  }
  return record;
}

function inDateRange(record, from, to) {
  if (from && record.date < from) return false;
  if (to && record.date > to) return false;
  return true;
}

function buildSummary(records) {
  const byDevice = {};
  const byDate = {};
  const total = { production: 0, ng: 0, ngInner: 0, ngOuter: 0, count: 0 };

  for (const r of records) {
    if (!byDevice[r.deviceId]) {
      byDevice[r.deviceId] = { deviceId: r.deviceId, deviceName: r.deviceName || r.deviceId, production: 0, ng: 0, ngInner: 0, ngOuter: 0, count: 0 };
    }
    const d = byDevice[r.deviceId];
    d.production += r.production; d.ng += r.ng; d.ngInner += r.ngInner; d.ngOuter += r.ngOuter; d.count += 1;

    if (!byDate[r.date]) {
      byDate[r.date] = { date: r.date, production: 0, ng: 0, ngInner: 0, ngOuter: 0, count: 0 };
    }
    const dd = byDate[r.date];
    dd.production += r.production; dd.ng += r.ng; dd.ngInner += r.ngInner; dd.ngOuter += r.ngOuter; dd.count += 1;

    total.production += r.production; total.ng += r.ng; total.ngInner += r.ngInner; total.ngOuter += r.ngOuter; total.count += 1;
  }

  const deviceList = Object.values(byDevice);
  for (const d of deviceList) {
    d.ngRate = d.production ? +(d.ng / d.production * 100).toFixed(2) : 0;
  }
  total.ngRate = total.production ? +(total.ng / total.production * 100).toFixed(2) : 0;

  return { total, byDevice: deviceList, byDate: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)) };
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const query = url.searchParams;

  if (req.method === 'GET' && pathname === '/api/info') {
    return sendJson(res, 200, {
      port: PORT,
      isCloud: db.isCloud,
      ips: getLanIps(),
    });
  }

  // 访问方式汇总
  if (req.method === 'GET' && pathname === '/api/access') {
    const cloudUrl = process.env.RENDER_EXTERNAL_URL || null;
    const ips = getLanIps();
    const cf   = tunnels.cloudflare  ? (tunnels.cloudflare.url  ? `${tunnels.cloudflare.url}/mobile`  : null) : null;
    const p    = tunnels.primary     ? (tunnels.primary.url     ? `${tunnels.primary.url}/mobile`     : null) : null;
    const s    = tunnels.secondary   ? (tunnels.secondary.url   ? `${tunnels.secondary.url}/mobile`   : null) : null;
    const longTerm = db.isCloud ? `${cloudUrl}/mobile` : (p || cf || s || null); // 最推荐的固定打印入口
    const stable   = db.isCloud ? `${cloudUrl}/mobile` : (cf || p || s || null); // 最稳定的入口
    return sendJson(res, 200, {
      ok: true,
      data: {
        isCloud: db.isCloud,
        longTerm,
        stable,
        cloudUrl: db.isCloud ? `${cloudUrl}/mobile` : null,
        tunnels: !db.isCloud ? {
          cloudflare: cf ? { url: cf, error: tunnels.cloudflare.error } : null,
          primary:    p  ? { url: p,  subdomain: tunnels.primary.subdomain,   error: tunnels.primary.error   } : null,
          secondary:  s  ? { url: s,  subdomain: null,                         error: tunnels.secondary.error } : null,
        } : null,
        tunnelSubdomain: !db.isCloud ? (tunnels.primary && tunnels.primary.subdomain) : null,
        tunnelError: !db.isCloud
          ? (!cf && !p && !s ? (tunnels.cloudflare && tunnels.cloudflare.error) || (tunnels.primary && tunnels.primary.error) || '公网隧道正在连接，请稍候...' : null)
          : null,
        lan: db.isCloud ? [] : ips.map((ip) => `http://${ip}:${PORT}/mobile`),
        localhost: `http://localhost:${PORT}/mobile`,
        ips,
        port: PORT,
      },
    });
  }

  // 设备
  if (req.method === 'GET' && pathname === '/api/devices') {
    const devices = await db.getDevices();
    const list = Object.values(devices).sort((a, b) => a.id.localeCompare(b.id));
    return sendJson(res, 200, list);
  }
  if (req.method === 'POST' && pathname === '/api/devices') {
    try {
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      if (!id) throw new Error('设备编码不能为空');
      const devices = await db.getDevices();
      const device = {
        id,
        name: String(body.name || id).trim(),
        line: String(body.line || '').trim(),
        createdAt: devices[id] ? devices[id].createdAt : fmtDateTime(),
      };
      await db.saveDevice(device);
      return sendJson(res, 200, { ok: true, device });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'DELETE' && pathname === '/api/devices') {
    const id = String(query.get('id') || '').trim();
    if (!id) return sendJson(res, 400, { ok: false, error: '缺少设备编码' });
    await db.deleteDevice(id);
    return sendJson(res, 200, { ok: true });
  }

  // 记录
  if (req.method === 'GET' && pathname === '/api/records') {
    const deviceId = query.get('deviceId') || '';
    const from = query.get('from') || '';
    const to = query.get('to') || '';
    let records = await db.getRecords();
    if (deviceId) records = records.filter((r) => r.deviceId === deviceId);
    if (from || to) records = records.filter((r) => inDateRange(r, from, to));
    records.sort((a, b) => b.ts - a.ts);
    return sendJson(res, 200, records);
  }
  if (req.method === 'POST' && pathname === '/api/records') {
    try {
      const body = await readBody(req);
      const record = await buildRecord(body);
      await db.addRecord(record);
      return sendJson(res, 200, { ok: true, record });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'DELETE' && pathname === '/api/records') {
    const id = String(query.get('id') || '').trim();
    if (!id) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
    const records = await db.getRecords();
    const found = records.some((r) => r.id === id);
    if (!found) return sendJson(res, 404, { ok: false, error: '未找到该记录' });
    await db.deleteRecord(id);
    return sendJson(res, 200, { ok: true });
  }

  // 汇总
  if (req.method === 'GET' && pathname === '/api/summary') {
    const from = query.get('from') || '';
    const to = query.get('to') || '';
    let records = await db.getRecords();
    if (from || to) records = records.filter((r) => inDateRange(r, from, to));
    return sendJson(res, 200, buildSummary(records));
  }

  // 导出 CSV
  if (req.method === 'GET' && pathname === '/api/export') {
    const deviceId = query.get('deviceId') || '';
    const from = query.get('from') || '';
    const to = query.get('to') || '';
    let records = await db.getRecords();
    if (deviceId) records = records.filter((r) => r.deviceId === deviceId);
    if (from || to) records = records.filter((r) => inDateRange(r, from, to));
    records.sort((a, b) => a.ts - b.ts);

    const header = ['时间', '日期', '设备编码', '设备名称', '生产数量', 'NG品数据', '内径不良数', '外径不良数', '班次', '检验员', '备注'];
    const lines = [header.join(',')];
    const esc = (v) => {
      v = v == null ? '' : String(v);
      if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    };
    for (const r of records) {
      lines.push([r.createdAt, r.date, r.deviceId, r.deviceName || '', r.production, r.ng, r.ngInner, r.ngOuter, r.shift, r.operator, r.remark].map(esc).join(','));
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="record_${fmtDate()}.csv"`,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(csv);
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel === 'mobile') rel = 'mobile.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- 请求处理（HTTP / HTTPS 共用）----------
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      return await handleApi(req, res, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(res, url.pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  } catch (e) {
    console.error('[服务器错误]', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, error: e.message || '服务器错误' }));
  }
}

// ---------- 依赖安装（main() 启动时先一次性完成，避免多个隧道启动函数同时 spawnSync 导致 EBUSY）----------
async function ensureOptionalDependencies() {
  if (db.isCloud) return;
  const ltOk = (() => { try { require('localtunnel'); return true; } catch (e) { return false; } })();
  const cfOk = (() => { try { require.resolve('cloudflared'); return true; } catch (e) { return false; } })()
    || fs.existsSync(path.join(ROOT, 'data', 'cloudflared.exe'));
  if (ltOk && cfOk) {
    console.log('[依赖] localtunnel / cloudflared 已就绪，跳过安装。');
    return;
  }
  const missing = [];
  if (!ltOk) missing.push('localtunnel');
  // cloudflared 缺就 npm 装；data/ 下有二进制可直接跳过
  const needNpmCloudflared = !cfOk && !fs.existsSync(path.join(ROOT, 'data', 'cloudflared.exe'));
  if (needNpmCloudflared) missing.push('cloudflared');
  if (!missing.length) return;

  console.log(`[依赖] 首次启动，正在一次性安装：${missing.join('、')}（仅安装一次，之后启动跳过）`);
  // 注意：cloudflared 包安装时 npm 会 rename 其 .bin 目录；如果 AV/杀软锁 cloudflared.exe，安装就会失败。
  // 缓解：先把 node_modules/cloudflared/（如存在）搬到临时位置，npm 完成再放回来。
  const nm = path.join(ROOT, 'node_modules');
  const stashDir = path.join(ROOT, '.tmp_npm_stash');
  const stashPath = path.join(stashDir, 'cloudflared');
  let stashed = false;
  try {
    if (needNpmCloudflared) {
      // 不强行 stash：cloudflared 根本不在 node_modules，直接安装
    } else if (missing.length && fs.existsSync(path.join(nm, 'cloudflared'))) {
      // 只缺 localtunnel，但 npm 扫描会触发 cloudflared rename EBUSY → 先搬开
      if (!fs.existsSync(stashDir)) fs.mkdirSync(stashDir, { recursive: true });
      if (!fs.existsSync(stashPath)) {
        fs.renameSync(path.join(nm, 'cloudflared'), stashPath);
        stashed = true;
      }
    }
  } catch (e) { console.warn('[依赖] 无法 stash cloudflared：', e.message); }

  const { spawnSync } = require('child_process');
  const args = ['install', '--no-save', '--no-audit', '--no-fund'].concat(missing);
  const r = spawnSync('npm', args, { cwd: ROOT, windowsHide: true, shell: true, timeout: 600000, stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn(`[依赖] npm install ${missing.join(' ')} 返回码 ${r.status}，可能未完全安装；缺少的隧道会自动重试。`);
  } else {
    console.log('[依赖] 安装完成。');
  }
  // 恢复 cloudflared
  if (stashed && fs.existsSync(stashPath)) {
    try {
      if (fs.existsSync(path.join(nm, 'cloudflared'))) {
        fs.rmSync(path.join(nm, 'cloudflared'), { recursive: true, force: true });
      }
      fs.renameSync(stashPath, path.join(nm, 'cloudflared'));
    } catch (e) { console.warn('[依赖] 恢复 cloudflared 失败，改用 data/cloudflared.exe：', e.message); }
  }
}

// ---------- 公网隧道（手机 4G/5G 可访问）----------
const tunnels = {
  cloudflare: { key: 'cloudflare', label: '① 稳定（推荐）',   url: null, error: null, retries: 0, child: null },
  primary:    { key: 'primary',    label: '② 固定（打印）',   url: null, subdomain: null, error: null, retries: 0, inst: null },
  secondary:  { key: 'secondary',  label: '③ 备用',           url: null, subdomain: null, error: null, retries: 0, inst: null },
};

async function ensureLt() { return require('localtunnel'); }

function ensureCloudflaredExe() {
  // cloudflared npm 包自己的位置（如果 package 没坏的话）
  const packageLocs = [
    path.join(ROOT, 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe'),
    path.join(ROOT, 'node_modules', '.bin', 'cloudflared.exe'),
    path.join(ROOT, 'data', 'cloudflared.exe'),
  ];
  let src = null;
  for (const p of packageLocs) if (fs.existsSync(p)) { src = p; break; }
  if (!src) return 'cloudflared'; // 全没找到，就尝试 PATH 里叫 cloudflared 的那个
  // 如果路径只包含可在默认 CMD 代码页(≈GBK)里表示的 ASCII/半角字符，直接返回原路径
  if (/^[A-Za-z]:\\[A-Za-z0-9\.\-\_\\\/ :()]+$/.test(src)) return src;
  // 含中文/特殊字符 → 复制到 %TEMP%\cloudflared_<hash>.exe 再 spawn（纯 ASCII 路径）
  try {
    const tmp = process.env.TEMP || process.env.TMP || require('os').tmpdir();
    const hash = crypto.createHash('md5').update(src).digest('hex').slice(0, 8);
    const dst = path.join(tmp, `cf_${hash}.exe`);
    const needCopy = !fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs;
    if (needCopy) fs.copyFileSync(src, dst);
    console.log(`[隧道] cloudflared 原路径含中文/特殊字符，已复制到: ${dst}`);
    return dst;
  } catch (e) {
    console.warn('[隧道] 复制 cloudflared 到 TEMP 失败，回退原路径（可能因代码页问题找不到）：', e.message);
    return src;
  }
}

function startCloudflared(info) {
  if (db.isCloud) return;
  if (process.env.DISABLE_CF === '1') { info.error = '已禁用 cloudflared 隧道'; return; }
  (async () => {
    try {
      const exe = ensureCloudflaredExe();
      console.log(`[隧道-${info.label}] 使用 cloudflared 程序：${exe}`);
      const { spawn } = require('child_process');
      const args = ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--loglevel', 'info'];
      const p = spawn(exe, args, { cwd: ROOT, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      info.child = p;
      let stderrBuf = '';
      let stdoutBuf = '';
      let firstFailPrinted = false;
      const doneUrl = Promise.race([
        new Promise((res) => {
          p.stderr.on('data', (d) => {
            const s = String(d);
            stderrBuf += s;
            if (!firstFailPrinted && stderrBuf.length >= 400) {
              console.log(`[隧道-${info.label}] cloudflared stderr（首次失败诊断，前 400 字）：`, stderrBuf.slice(0, 500));
              firstFailPrinted = true;
            }
            const m = stderrBuf.match(/https?:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com[^\s]*/);
            if (m) res(m[0]);
          });
          p.stdout.on('data', (d) => {
            const s = String(d);
            stdoutBuf += s;
            const m = s.match(/https?:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com[^\s]*/);
            if (m) res(m[0]);
          });
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('cloudflared 60 秒内未输出 trycloudflare URL，stderr: ' + stderrBuf.slice(0, 400))), 60000)),
      ]);
      p.on('exit', (code, signal) => {
        if (code !== 0 && !firstFailPrinted) {
          console.log(`[隧道-${info.label}] cloudflared 非零退出 code=${code}，stderr：`, stderrBuf.slice(0, 600));
          firstFailPrinted = true;
        }
        info.url = null; info.child = null;
        console.log(`[隧道-${info.label}] 退出，code=${code} signal=${signal}，8 秒后重启`);
        setTimeout(() => startCloudflared(info), 8000);
      });
      p.on('error', (err) => {
        info.error = '启动失败：' + (err.message || err);
        info.retries += 1;
        console.error(`[隧道-${info.label}]`, info.error);
        setTimeout(() => startCloudflared(info), 10000);
      });
      const u = await doneUrl;
      info.url = u.replace(/\/$/, '');
      info.error = null;
      info.retries = 0;
      console.log('------------------------------------------------');
      console.log(`  [4G/5G 可扫·${info.label}] 公网地址: ${info.url}/mobile`);
      console.log('  ✅ 零配置 Cloudflare 官方隧道，在公司/校园网 511 网关下比 loca.lt 更稳定');
      console.log('  ⚠ 每次系统重启，这个地址会变化；需要打印长期贴请看"② 固定二维码"');
    } catch (e) {
      info.error = (info.error || '') + '; ' + (e.message || e);
      info.retries += 1;
      console.error(`[隧道-${info.label}] 启动失败（第 ${info.retries} 次）：`, e.message || e);
      setTimeout(() => startCloudflared(info), 10000);
    }
  })();
}

async function startOneLt(info, wantSubdomain) {
  try {
    const lt = await ensureLt();
    const opts = { port: PORT };
    if (wantSubdomain) opts.subdomain = wantSubdomain;
    const t = await lt(opts);
    info.inst = t;
    info.url = t.url.replace(/\/$/, '');
    info.error = null;
    info.retries = 0;
    if (wantSubdomain && !info.url.includes(wantSubdomain)) {
      info.error = `子域名"${wantSubdomain}"已被他人占用，系统临时分配了另一个地址，不建议打印长期贴。可编辑 data/tunnel-name.txt 换一个更独特的名字后重启。`;
      console.log(`[隧道-${info.label}] ⚠ 子域名被占用，当前地址：${info.url}`);
    } else {
      console.log('------------------------------------------------');
      console.log(`  [4G/5G 可扫·${info.label}] 公网地址: ${info.url}/mobile`);
      if (wantSubdomain) console.log(`  子域名: ${wantSubdomain}（data/tunnel-name.txt，可修改）`);
    }
    t.on('close', () => {
      console.log(`[隧道-${info.label}] 断开，6 秒后重连...`);
      info.url = null; info.inst = null;
      setTimeout(() => startOneLt(info, wantSubdomain), 6000);
    });
    t.on('error', () => {
      info.url = null; info.inst = null;
      setTimeout(() => startOneLt(info, wantSubdomain), 6000);
    });
  } catch (e) {
    info.error = (info.error || '') + '; ' + (e.message || e);
    info.retries += 1;
    console.error(`[隧道-${info.label}] 启动失败（第 ${info.retries} 次）：`, e.message || e);
    setTimeout(() => startOneLt(info, wantSubdomain), 10000);
  }
}

async function startTunnel() {
  if (db.isCloud) return;
  if (process.env.DISABLE_TUNNEL === '1') {
    tunnels.primary.error = '已禁用公网隧道。';
    return;
  }
  const DATA_DIR = path.join(ROOT, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const TUNNEL_NAME_FILE = path.join(DATA_DIR, 'tunnel-name.txt');

  // 读或生成"固定"子域名（给 localtunnel primary 用）
  let primarySub;
  if (fs.existsSync(TUNNEL_NAME_FILE)) {
    primarySub = fs.readFileSync(TUNNEL_NAME_FILE, 'utf8').trim();
  } else {
    primarySub = 'entry-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(TUNNEL_NAME_FILE, primarySub, 'utf8');
  }
  tunnels.primary.subdomain = primarySub;

  // 1) 先启 cloudflared（最稳）
  startCloudflared(tunnels.cloudflare);
  // 2) 2 秒后启 localtunnel primary 固定
  setTimeout(() => startOneLt(tunnels.primary, primarySub), 2000);
  // 3) 再 3 秒后启 localtunnel secondary 随机
  setTimeout(() => startOneLt(tunnels.secondary, null), 5000);
}

// ---------- 启动 ----------
async function main() {
  await db.initDb();
  // 在 server listen 之前，一次性安装完 tunnel 依赖
  // （避免多个隧道启动函数并发 spawnSync('npm install') 导致 EBUSY）
  await ensureOptionalDependencies();

  const server = http.createServer((req, res) => handleRequest(req, res));
  server.listen(PORT, '0.0.0.0', () => {
    console.log('================================================');
    console.log('  内外径检测数据录入系统 已启动');
    console.log('================================================');
    if (db.isCloud) {
      const cloudUrl = process.env.RENDER_EXTERNAL_URL || `https://your-app.onrender.com`;
      console.log(`  云端固定地址: ${cloudUrl}/mobile`);
      console.log('  （此地址永久不变，可打印二维码贴现场，手机 4G/5G 直接扫码）');
    } else {
      console.log(`  电脑端管理页面: http://localhost:${PORT}`);
      for (const ip of getLanIps()) {
        console.log(`  局域网录入页面: http://${ip}:${PORT}/mobile`);
      }
    }
    console.log(`  模式: ${db.isCloud ? '云端 (PostgreSQL)' : '本地 (JSON 文件)'}`);
    console.log('================================================');
    if (!db.isCloud) startTunnel();
  });
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
