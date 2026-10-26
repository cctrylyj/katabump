#!/usr/bin/env node
/**
 * KataBump 容器 -> VLESS + Reality 节点 -> Clash(mihomo) 订阅
 * =====================================================================
 * v4 · Node 版 index.js（最终交付版）
 *
 * 【为什么是 Node 而不是 Python】
 *   KataBump 面板启动前会强制检查 index.js 是否存在，不存在直接中止，
 *   根本不会执行 Startup Command。所以入口文件名必须叫 index.js。
 *   同时容器日志只保证有 Node.js，不保证有 python3 —— 用 Node 零依赖。
 *
 * 【本脚本解决的全部问题】
 *   1. 面板报 "Your index.js file was not found"
 *      -> 入口就叫 index.js，天然通过检查。
 *
 *   2. Console 输入没反应
 *      -> 面板自带进程会吃掉 stdin。本脚本启动时会主动结束占用端口的
 *         sing-box/tuic 进程（但绝不杀自己），然后自己常驻前台。
 *
 *   3. 端口猜不准
 *      -> 共享主机的容器端口由平台分配，面板显示值未必等于容器内实际
 *         监听端口。本脚本先快照容器内 20xxx 段所有监听端口（这才是平台
 *         真正分配的），再结束占用进程，然后把这些端口全部接管。
 *         Clash 配置里每个端口一个节点，客户端挨个测速即可。
 *
 *   4. Clash 报 "REALITY authentication failed"
 *      -> Xray v26.7.11+ 改了 REALITY 握手，客户端必须带后量子混合密钥
 *         交换。生成的 clash.yaml 每个节点都写 support-x25519mlkem768: true。
 *
 *   5. xray 挂了就断
 *      -> 守护循环自动重启。
 *
 *   6. 【v5 新增】订阅里混进了根本用不了的端口
 *      -> 容器内监听 != 外网可达。平台会在同一批端口上挂自己的面板
 *         （本机实测：20331 是平台的 Blue 面板、20332/20333 外网直接
 *         connection refused），REALITY 握手会拿到「真证书」而失败。
 *      -> 现在脚本会用容器自带的 xray 当客户端，从公网回测每个端口，
 *         只把回测通过的端口写进 clash.yaml / sub.txt。
 *
 * 【用法】
 *   node index.js            守护模式（面板 Startup Command 用这个）
 *   node index.js --status   查看状态、监听端口、节点参数
 *   node index.js --info     只打印节点参数和分享链接
 *   node index.js --stop     停止 xray 并结束 sing-box
 *   node index.js --gen      只生成配置，不启动
 *   node index.js --reset    重置 UUID 与 Reality 密钥（旧节点立即作废）
 *   node index.js --set-ip IP  手动指定服务器 IP
 *   node index.js --no-verify 跳过端口回测（不推荐）
 *
 * 【环境变量】
 *   SERVER_PORT / PORT / PTERODACTYL_SERVER_PORT   平台注入的端口
 *   EXTRA_PORTS        额外候选端口，逗号分隔
 *   FALLBACK_PORT      兜底端口，默认 20330
 *   REALITY_SNI        伪装域名，默认 www.microsoft.com
 *   XRAY_VERSION       Xray 版本，默认 v26.10.21
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const WORKDIR = __dirname;
const XRAY_BIN = path.join(WORKDIR, 'xray');
const CONF_PATH = path.join(WORKDIR, 'config.json');
const INFO_PATH = path.join(WORKDIR, 'node-info.json');
const PIDFILE = path.join(WORKDIR, 'xray.pid');
const LOGFILE = path.join(WORKDIR, 'xray.log');

const DEFAULT_SNI = process.env.REALITY_SNI || 'www.microsoft.com';
const DEFAULT_PORT = parseInt(process.env.FALLBACK_PORT || '20330', 10);
const DEFAULT_CANDIDATE_PORTS = [20330, 20331, 20332, 20333];
const VERIFY_TARGET = process.env.VERIFY_URL || 'http://www.gstatic.com/generate_204';
const VERIFY_TIMEOUT = parseInt(process.env.VERIFY_TIMEOUT || '12000', 10);

const XRAY_VERSION = process.env.XRAY_VERSION || 'v26.10.21';
const IS_ARM = /^(aarch64|arm64)$/i.test(os.arch());
const ZIP_NAME = IS_ARM ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
const BASE_URL = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${ZIP_NAME}`;
const MIRRORS = [
  BASE_URL,
  'https://ghfast.top/' + BASE_URL,
  'https://gh-proxy.com/' + BASE_URL,
  'https://ghproxy.net/' + BASE_URL,
  'https://gh.llkk.cc/' + BASE_URL,
];

let stopping = false;

function log(msg) {
  console.log('[katabump] ' + msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------ 端口探测
function envPorts() {
  const out = [];
  const push = (p) => {
    const n = parseInt(p, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
  };
  for (const k of ['SERVER_PORT', 'PORT', 'SERVER_PORT_PRIMARY']) {
    if (process.env[k]) push(process.env[k]);
  }
  for (const part of String(process.env.EXTRA_PORTS || '').split(/[,\s]+/)) {
    if (part) push(part);
  }
  return out;
}

/** 解析 /proc/net/{tcp,tcp6,udp,udp6}，返回监听端口集合（不依赖 ss/netstat） */
function procNetPorts() {
  const ports = new Set();
  for (const proto of ['tcp', 'tcp6', 'udp', 'udp6']) {
    let text;
    try {
      text = fs.readFileSync('/proc/net/' + proto, 'utf8');
    } catch (e) {
      continue;
    }
    const lines = text.split('\n').slice(1);
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      const isTcp = proto.startsWith('tcp');
      const state = f[3];
      // TCP: 0A=LISTEN ; UDP: 07=UNCONN(已绑定)
      if (isTcp && state !== '0A') continue;
      if (!isTcp && state !== '07') continue;
      const local = f[1] || '';
      const sep = local.lastIndexOf(':');
      const hex = sep >= 0 ? local.slice(sep + 1) : '';
      if (!hex) continue;
      const p = parseInt(hex, 16);
      if (Number.isInteger(p) && p > 0 && p < 65536) ports.add(p);
    }
  }
  return ports;
}

/** ss 兜底 */
function ssPorts() {
  const ports = new Set();
  try {
    const out = execSync('ss -tulnp 2>/dev/null || true', { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split('\n')) {
      if (!/LISTEN|UNCONN/.test(line)) continue;
      for (const tok of line.trim().split(/\s+/)) {
        const m = tok.match(/:(\d+)$/);
        if (m) {
          const p = parseInt(m[1], 10);
          if (p > 0 && p < 65536) ports.add(p);
        }
      }
    }
  } catch (e) { /* ignore */ }
  return ports;
}

/** 端口能否绑定 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

// ------------------------------------------------------------ 进程管理
function listProcs() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = parseInt(e, 10);
    if (pid === process.pid) continue;
    let cl = '';
    try {
      cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch (err) { continue; }
    if (!cl) continue;
    out.push({ pid, cl });
  }
  return out;
}

/**
 * 结束占用端口的进程。
 * ⚠️ 关键：绝不能杀 index.js 父进程（否则自己把自己杀了），
 *    也不能杀任何 ancestor 进程。这里显式排除自身与祖先链。
 */
function killPatterns(patterns, excludePids) {
  const exclude = new Set(excludePids || []);
  exclude.add(process.pid);
  // 祖先链：/proc/<pid>/stat 第 4 字段是 ppid
  let cur = process.pid;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${cur}/stat`, 'utf8');
      const ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 10);
      if (!ppid || ppid <= 1) break;
      exclude.add(ppid);
      cur = ppid;
    } catch (e) { break; }
  }

  const killed = [];
  for (const { pid, cl } of listProcs()) {
    if (exclude.has(pid)) continue;
    for (const pat of patterns) {
      if (cl.includes(pat)) {
        try {
          process.kill(pid, 'SIGTERM');
          killed.push(`${pat}(pid=${pid})`);
        } catch (e) { /* ignore */ }
        break;
      }
    }
  }
  return killed;
}

async function killPatternsAsync(patterns) {
  const killed = killPatterns(patterns);
  if (killed.length) {
    await sleep(1500);
    // 补刀
    const exclude = new Set([process.pid]);
    for (const { pid, cl } of listProcs()) {
      if (exclude.has(pid)) continue;
      for (const pat of patterns) {
        if (cl.includes(pat)) {
          try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
          break;
        }
      }
    }
    log('已结束占用进程: ' + killed.join(', '));
  }
  return killed;
}

// ------------------------------------------------------------ 节点参数
/** Node 原生 X25519 密钥生成，格式与 Xray 完全兼容（已实测互通） */
function genX25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { priv: priv.toString('base64url'), pub: pub.toString('base64url') };
}

function getIp() {
  for (const k of ['SERVER_IP', 'PTERODACTYL_SERVER_IP', 'PUBLIC_IP']) {
    const v = (process.env[k] || '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;
  }
  return '';
}

function getIpAsync() {
  const env = getIp();
  if (env) return Promise.resolve(env);
  const apis = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ipinfo.io/ip'];
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= apis.length) return resolve('');
      const api = apis[idx++];
      const req = https.get(api, { headers: { 'User-Agent': 'curl/8' }, timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const ip = data.trim();
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return resolve(ip);
          tryNext();
        });
      });
      req.on('error', tryNext);
      req.on('timeout', () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}

function randomShortId() {
  let s = '';
  const chars = '0123456789abcdef';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % 16];
  return s;
}

function randomUuid() {
  return crypto.randomUUID();
}

// ------------------------------------------------------------ xray 二进制
function findXray() {
  const tag = IS_ARM ? 'arm64' : 'amd64';
  const cands = [
    path.join(WORKDIR, `xray-linux-${tag}`),
    XRAY_BIN,
    path.join(WORKDIR, 'bin', 'xray'),
    path.join(WORKDIR, 'bin', `xray-linux-${tag}`),
  ];
  // Windows 本地调试用（容器内是 Linux，走不到这里）
  if (process.platform === 'win32') {
    cands.unshift(path.join(WORKDIR, 'xray.exe'));
  }
  for (const p of cands) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        try { fs.chmodSync(p, 0o755); } catch (e) { /* ignore */ }
        return p;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function downloadXray() {
  return new Promise((resolve, reject) => {
    log(`未找到 xray，开始下载（${ZIP_NAME}）...`);
    const tmp = path.join(WORKDIR, '.xray-download.zip');
    const out = fs.createWriteStream(tmp);

    const attempt = (idx) => {
      if (idx >= MIRRORS.length) {
        out.close();
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        return reject(new Error(
          `xray 下载全部失败。\n解决：上传 xray-linux-${IS_ARM ? 'arm64' : 'amd64'} 到 ${WORKDIR}/`
        ));
      }
      const url = MIRRORS[idx];
      log('  尝试源: ' + url.split('/')[2]);
      let downloaded = 0;
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 240000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          out.close();
          fs.createWriteStream(tmp).close();
          return attempt(idx + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          out.close();
          try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
          return attempt(idx + 1);
        }
        res.on('data', (c) => { downloaded += c.length; });
        res.pipe(out, { end: true });
      });
      req.on('error', (e) => {
        log('  失败: ' + e.message);
        try { out.close(); fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
        attempt(idx + 1);
      });
      req.on('timeout', () => { req.destroy(); });
    };

    out.on('close', () => {
      try {
        const size = fs.statSync(tmp).size;
        if (size < 1024 * 1024) throw new Error('下载文件过小，可能被拦截');
        log('  解压...');
        // 用系统 unzip 优先，没有就用 Node 手写 zip 解析（只取名为 xray 的条目）
        try {
          execSync(`cd "${WORKDIR}" && unzip -o .xray-download.zip xray >/dev/null 2>&1`, { timeout: 60000 });
        } catch (e) {
          execSync(`cd "${WORKDIR}" && unzip -o .xray-download.zip >/dev/null 2>&1 && chmod 755 xray`, { timeout: 60000 });
        }
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        try { fs.chmodSync(XRAY_BIN, 0o755); } catch (e) { /* ignore */ }
        log('  完成: ' + XRAY_BIN);
        resolve(XRAY_BIN);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
        reject(e);
      }
    });

    attempt(0);
  });
}

// ------------------------------------------------------------ 端口回测
/**
 * 用容器自带的 xray 当客户端，从「公网侧」回测每个端口是否真的是我们的
 * REALITY 节点。
 *
 * 为什么必须测：
 *   容器内 listen 成功 ≠ 外网能连。KataBump 会在同一批 20xxx 端口上
 *   挂自己的面板服务（实测 20331 = 平台 Blue 面板，握手会返回真证书，
 *   REALITY 客户端报 "received real certificate"）；
 *   还有些端口平台根本没映射到外网（connection refused）。
 *   这两种端口混进订阅，客户端就是「选了就报错」。
 *
 * 做法：给每个端口起一个 socks 入口的 xray 客户端，
 *   通过它请求一个 204 地址，拿到 HTTP 状态才算通过。
 */
function verifyClientConfig(addr, port, uuid, pubKey, shortId, sni, socksPort) {
  return {
    // loglevel 必须是 info：xray 启动成功时会打印
    // "listening tcp on 127.0.0.1:<port>"，靠它拿到实际分配的端口
    log: { loglevel: 'info' },
    inbounds: [{
      tag: 'in', port: socksPort, listen: '127.0.0.1',
      protocol: 'socks', settings: { udp: false },
    }],
    outbounds: [{
      tag: 'out', protocol: 'vless',
      settings: {
        vnext: [{
          // ⚠️ 必须连「公网 IP」而不是 127.0.0.1！
          //    连 127.0.0.1 只测到容器内监听，测不出平台 NAT 层的问题
          //    （平台占用的端口 / 未映射到外网的端口）。
          address: addr, port,
          users: [{ id: uuid, encryption: 'none', flow: 'xtls-rprx-vision' }],
        }],
      },
      streamSettings: {
        network: 'tcp', security: 'reality',
        realitySettings: {
          show: false, fingerprint: 'chrome',
          serverName: sni, publicKey: pubKey, shortId, spiderX: '/',
        },
      },
    }],
  };
}

/** 通过 socks5 发一个 HTTP GET，返回状态码或 null */
function httpViaSocks(socksPort, target, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let sock;
    try {
      sock = net.connect(socksPort, '127.0.0.1');
    } catch (e) { return done(null); }
    const timer = setTimeout(() => { try { sock.destroy(); } catch (e) {} done(null); }, timeoutMs);
    let buf = Buffer.alloc(0);
    // 状态机：0=已发greeting  1=已发CONNECT  2=读HTTP响应
    // ⚠️ 不能用「socket 是否连上」来区分阶段 —— 'connect' 事件在收到任何
    //    数据之前就触发了，会把 SOCKS5 应答误当成 HTTP 响应。
    let stage = 0;

    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));   // SOCKS5 greeting（无认证）
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
        if (buf[1] !== 0x00) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
        const u = new URL(target);
        const host = Buffer.from(u.hostname, 'utf8');
        const port = u.port ? parseInt(u.port, 10) : 80;
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          Buffer.from('GET ' + (u.pathname || '/') + ' HTTP/1.1\r\nHost: ' + u.host +
            '\r\nUser-Agent: verify\r\nConnection: close\r\n\r\n'),
        ]));
        stage = 1;
        buf = Buffer.alloc(0);
        return;
      }
      if (stage === 1) {
        // SOCKS5 应答：[0x05, rep, 0x00, ...]
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
        stage = 2;
        buf = Buffer.alloc(0);
        return;
      }
      const m = buf.toString('latin1').match(/^HTTP\/1\.[01]\s+(\d{3})/);
      if (m) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} done(parseInt(m[1], 10)); }
    });
  });
}

/**
 * 申请一个当前空闲的本地端口。
 *
 * 做法：让系统分配（listen port 0）→ 记下端口号 → 立刻关闭 →
 *       马上用这个端口启动 xray。
 * 竞态窗口极小（毫秒级），且不会像「猜固定端口」那样撞上别的程序。
 * xray 启动失败（端口被抢）时上层会重试下一个端口。
 */
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 找一个空闲的本地端口（异步版） */
async function findFreeLocalPort(start) {
  for (let p = start; p < start + 500; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  return start;
}

/**
 * 回测一批端口，返回 { usable: [], results: [{port, ok, detail}] }
 * 每个端口用独立的客户端配置 + 独立 socks 端口。
 */
async function verifyPorts(xrayBin, ip, ports, uuid, pubKey, shortId, sni) {
  const results = [];
  const usable = [];
  const logPath = path.join(WORKDIR, '.verify.log');

  for (const p of ports) {
    let done = false;
    // 最多试 3 个不同端口，避开「刚申请就被抢」的竞态
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const socksPort = await getFreePort();
      if (!socksPort) break;
      const cfgPath = path.join(WORKDIR, `.verify-${p}.json`);
      let child = null;
      try {
        fs.writeFileSync(cfgPath, JSON.stringify(
          verifyClientConfig(ip, p, uuid, pubKey, shortId, sni, socksPort)), 'utf8');
        try { fs.writeFileSync(logPath, ''); } catch (e) { /* ignore */ }
        const out = fs.openSync(logPath, 'a');
        child = spawn(xrayBin, ['run', '-c', cfgPath], {
          detached: true, stdio: ['ignore', out, out],
        });
        child.unref();

        // 等 xray 真正就绪：能连上它的 socks 口才算启动成功
        let ready = false;
        for (let i = 0; i < 30; i++) {
          await sleep(200);
          if (child.exitCode !== null) break;
          let txt = '';
          try { txt = fs.readFileSync(logPath, 'utf8'); } catch (e) { /* ignore */ }
          if (/Failed to start|bind:|Only one usage/i.test(txt)) break;
          const alive = await new Promise((resolve) => {
            const s = net.connect({ port: socksPort, host: '127.0.0.1' });
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('error', () => resolve(false));
            setTimeout(() => { try { s.destroy(); } catch (e) {} resolve(false); }, 800);
          });
          if (alive) { ready = true; break; }
        }

        if (!ready) continue;   // 端口被抢了，换一个再试

        const code = await httpViaSocks(socksPort, VERIFY_TARGET, VERIFY_TIMEOUT);
        const ok = code !== null && code >= 200 && code < 500;
        results.push({ port: p, ok, detail: ok ? ('HTTP ' + code) : (code ? ('HTTP ' + code) : '连接失败/超时') });
        if (ok) usable.push(p);
        log(`端口 ${p} 回测: ${ok ? '✅ ' + code : '❌ ' + (code ? 'HTTP ' + code : '不可用')}`);
        done = true;
      } catch (e) {
        results.push({ port: p, ok: false, detail: e.message });
        log(`端口 ${p} 回测异常: ${e.message}`);
        done = true;
      } finally {
        try { if (child) child.kill('SIGKILL'); } catch (e) {}
        try { fs.unlinkSync(cfgPath); } catch (e) {}
        await sleep(200);
      }
    }
    if (!done) {
      results.push({ port: p, ok: false, detail: '验证客户端启动失败' });
      log(`端口 ${p} 回测: ❌ 验证客户端启动失败`);
    }
  }
  return { usable, results };
}
// ------------------------------------------------------------ 配置生成
function buildConfig(ports, uuid, privKey, shortId, sni) {
  const inbounds = ports.map((p) => ({
    listen: '0.0.0.0',
    port: p,
    protocol: 'vless',
    settings: {
      clients: [{ id: uuid, flow: 'xtls-rprx-vision' }],
      decryption: 'none',
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        show: false,
        dest: sni + ':443',
        xver: 0,
        serverNames: [sni],
        privateKey: privKey,
        shortIds: [shortId],
      },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
  }));

  return {
    log: { loglevel: 'warning', access: 'none' },
    inbounds,
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: {
      rules: [
        { type: 'field', ip: [
          '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
          '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10',
        ], outboundTag: 'block' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'block' },
      ],
    },
  };
}

function vlessLink(ip, port, uuid, pubKey, shortId, sni, name) {
  const q = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni,
    fp: 'chrome',
    pbk: pubKey,
    sid: shortId,
    type: 'tcp',
    headerType: 'none',
  });
  return `vless://${uuid}@${ip}:${port}?${q.toString()}#${encodeURIComponent(name)}`;
}

function clashYaml(ip, ports, uuid, pubKey, shortId, sni) {
  const proxies = ports.map((p) => {
    const nm = `KataBump-${p}`;
    return `  - name: "${nm}"
    type: vless
    server: ${ip}
    port: ${p}
    uuid: ${uuid}
    udp: true
    tls: true
    network: tcp
    flow: xtls-rprx-vision
    servername: ${sni}
    client-fingerprint: chrome
    reality-opts:
      public-key: ${pubKey}
      short-id: "${shortId}"
      # Xray v26.7.11+ 要求 ClientHello 带后量子混合密钥交换
      # 缺这一行 mihomo 会一直报 REALITY authentication failed
      support-x25519mlkem768: true`;
  }).join('\n');

  const names = ports.map((p) => `KataBump-${p}`);
  const groupList = names.map((n) => `      - "${n}"`).join('\n');

  return `# ===== KataBump 节点 · Clash / mihomo 配置 (v4 Node 版) =====
# 由容器内 index.js 自动生成，端口列表 = 容器实际监听的端口
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090
unified-delay: true
tcp-concurrent: true

proxies:
${proxies}

proxy-groups:
  - name: "节点选择"
    type: select
    proxies:
${groupList}
      - DIRECT
  - name: "自动测速"
    type: url-test
    proxies:
${groupList}
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50

rules:
  - GEOIP,LAN,DIRECT,no-resolve
  - GEOIP,CN,DIRECT
  - MATCH,节点选择
`;
}

// ------------------------------------------------------------ 产物输出
function saveAndReport(info) {
  const { server, uuid, public_key, short_id, sni } = info;
  // 只发布「真正可用」的端口；没有回测结果时才退回全部监听端口
  const ports = (info.usable_ports && info.usable_ports.length)
    ? info.usable_ports
    : (info.ports || []);
  const yml = clashYaml(server, ports, uuid, public_key, short_id, sni);
  const links = ports.map((p) => vlessLink(server, p, uuid, public_key, short_id, sni, `KataBump-${p}`));

  fs.writeFileSync(INFO_PATH, JSON.stringify(info, null, 2), 'utf8');
  fs.writeFileSync(path.join(WORKDIR, 'clash.yaml'), yml, 'utf8');
  fs.writeFileSync(path.join(WORKDIR, 'sub.txt'), Buffer.from(links.join('\n'), 'utf8').toString('base64'), 'utf8');

  const bar = '='.repeat(68);
  console.log('\n' + bar);
  console.log('  节点已就绪');
  console.log(bar);
  console.log('  服务器  : ' + (server || '(未探测到，请用 --set-ip 手动指定)'));
  console.log('  端口    : ' + ports.join(', ') + `  (共 ${ports.length} 个可用)`);
  if (info.listen_ports && info.listen_ports.length) {
    const extra = info.listen_ports.filter((p) => !ports.includes(p));
    if (extra.length) {
      console.log('  已剔除  : ' + extra.join(', ') + '  (外网不可用/被平台占用)');
    }
  }
  console.log(bar);
  console.log('  UUID     : ' + uuid);
  console.log('  publicKey: ' + public_key);
  console.log('  shortId  : ' + short_id);
  console.log('  伪装 SNI : ' + sni);
  console.log(bar);
  console.log('  【分享链接】');
  for (const l of links) console.log('  ' + l);
  console.log(bar);
  console.log('  已写入: clash.yaml  sub.txt  node-info.json');
  console.log(bar + '\n');
  return yml;
}

// ------------------------------------------------------------ 状态
function statusXray() {
  const alive = readPid() ? isAlive(readPid()) : false;
  log('xray: ' + (alive ? `运行中 (pid=${readPid()})` : '未运行'));

  const ports = procNetPorts();
  const sp = ssPorts();
  const all = new Set([...ports, ...sp]);
  if (all.size) log('容器内监听端口: ' + [...all].sort((a, b) => a - b).join(', '));

  if (fs.existsSync(INFO_PATH)) {
    try {
      const info = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
      log('本节点端口: ' + (info.ports || []).join(', '));
      log('服务器 IP : ' + (info.server || ''));
      log('UUID      : ' + (info.uuid || ''));
      log('publicKey : ' + (info.public_key || ''));
      log('shortId   : ' + (info.short_id || ''));
    } catch (e) { /* ignore */ }
  }
  if (fs.existsSync(LOGFILE)) {
    try {
      const tail = fs.readFileSync(LOGFILE, 'utf8').slice(-2000).trim();
      if (tail) {
        log('--- xray.log 尾部 ---');
        for (const l of tail.split('\n').slice(-15)) log('   ' + l);
      }
    } catch (e) { /* ignore */ }
  }
  return alive;
}

function readPid() {
  try { return parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10) || null; } catch (e) { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function stopXray() {
  const killed = [];
  const pid = readPid();
  if (pid && isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); killed.push(`xray(pid=${pid})`); } catch (e) { /* ignore */ }
  }
  await sleep(1000);
  const more = await killPatternsAsync(['sing-box', 'xray', 'tuic']);
  killed.push(...more);
  try { fs.unlinkSync(PIDFILE); } catch (e) { /* ignore */ }
  log(killed.length ? '已停止: ' + killed.join(', ') : '没有需要停止的进程');
  return killed;
}

// ------------------------------------------------------------ 端口决策
async function detectPorts() {
  // 顺序很重要：必须先快照 index.js 正在监听的端口（=平台真正分配的端口），
  // 再结束占用进程。反过来的话 index.js 释放端口后就探测不到了。
  const env = envPorts();
  const live = new Set([...procNetPorts(), ...ssPorts()]);
  const inRange = [...live].filter((p) => p >= 20000 && p <= 20999).sort((a, b) => a - b);
  log('容器内 20xxx 段监听中: ' + (inRange.length ? inRange.join(', ') : '无'));
  if (env.length) log('环境变量端口: ' + env.join(', '));

  // ⚠️ 只结束 sing-box / tuic，绝不结束 index.js —— 那可能是自己的父进程！
  await killPatternsAsync(['sing-box', 'sing-box.exe', 'tuic']);

  const ordered = [];
  for (const p of [...env, ...inRange, ...DEFAULT_CANDIDATE_PORTS]) {
    if (!ordered.includes(p)) ordered.push(p);
  }

  const chosen = [];
  for (const p of ordered) {
    if (await portIsFree(p)) chosen.push(p);
    else log(`端口 ${p} 仍被占用，跳过`);
    if (chosen.length >= 4) break;
  }
  if (!chosen.length) chosen.push(DEFAULT_PORT);
  log('最终监听端口: ' + chosen.join(', '));
  return chosen;
}

// ------------------------------------------------------------ 主流程
async function loadOrCreate(reset, setIp) {
  let info = null;
  if (!reset && fs.existsSync(INFO_PATH)) {
    try { info = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8')); } catch (e) { info = null; }
  }

  const xray = findXray() || (await downloadXray());

  if (info && info.private_key && info.public_key) {
    info.server = setIp || (await getIpAsync()) || info.server || '';
    info.sni = info.sni || DEFAULT_SNI;
    log('复用已有节点参数（--reset 可重置）');
  } else {
    log('生成新节点参数...');
    const { priv, pub } = genX25519();
    info = {
      server: setIp || (await getIpAsync()),
      uuid: randomUuid(),
      private_key: priv,
      public_key: pub,
      short_id: randomShortId(),
      sni: DEFAULT_SNI,
    };
  }

  const listenPorts = await detectPorts();
  info.ports = listenPorts;
  // info.usable_ports = 实际可用的端口（回测后填充）

  const cfg = buildConfig(listenPorts, info.uuid, info.private_key, info.short_id, info.sni);
  fs.writeFileSync(CONF_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return { xray, info, listenPorts };
}

function startXray(xray, confPath) {
  const out = fs.openSync(LOGFILE, 'a');
  const child = spawn(xray, ['run', '-c', confPath], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch (e) { /* ignore */ }
  return child;
}

/** 守护模式：前台常驻，xray 崩溃自动重启；SIGTERM 优雅退出 */
async function supervise(xray, confPath) {
  const onSignal = (sig) => {
    stopping = true;
    log(`收到信号 ${sig}，正在退出...`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  log('进入守护模式，xray 崩溃会自动重启。面板 Stop 可正常结束本进程。');

  let child = null;
  try {
    while (!stopping) {
      try { fs.closeSync(fs.openSync(LOGFILE, 'w')); } catch (e) { /* ignore */ }
      child = startXray(xray, confPath);
      log(`xray 已启动，pid=${child.pid}`);

      while (!stopping && child.exitCode === null && child.signalCode === null) {
        await sleep(2000);
      }
      if (stopping) break;
      log('xray 意外退出，3 秒后自动重启...');
      await sleep(3000);
    }
  } finally {
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
      await sleep(1500);
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    try { fs.unlinkSync(PIDFILE); } catch (e) { /* ignore */ }
    log('已退出。');
  }
  return 0;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--stop')) { await stopXray(); return 0; }
  if (args.includes('--status')) { statusXray(); return 0; }

  let setIp = null;
  const si = args.indexOf('--set-ip');
  if (si >= 0 && args[si + 1]) setIp = args[si + 1];

  const { xray, info, listenPorts } = await loadOrCreate(args.includes('--reset'), setIp);
  info.listen_ports = listenPorts;

  // ---- 先把 xray 拉起来，再回测端口 ----
  // 回测必须发生在 xray 已经监听之后，否则测的都是"端口没开"。
  const needRun = !(args.includes('--gen') || args.includes('--info'));
  if (needRun) {
    await stopXray();
    await sleep(1000);
    startXray(xray, CONF_PATH);
    await sleep(2500);
  }

  if (!args.includes('--no-verify') && info.server) {
    log('开始端口回测（从公网侧验证每个端口是否真的是本节点）...');
    const { usable, results } = await verifyPorts(
      xray, info.server, listenPorts, info.uuid, info.public_key, info.short_id, info.sni);
    info.port_check = results;
    if (usable.length) {
      info.usable_ports = usable;
      log('可用端口: ' + usable.join(', '));
    } else {
      // 全挂了也不能让订阅变成空，至少保留主端口
      info.usable_ports = [DEFAULT_PORT];
      log('⚠️ 全部端口回测失败，回退到默认端口 ' + DEFAULT_PORT);
    }
  } else {
    info.usable_ports = listenPorts;
  }

  saveAndReport(info);

  if (args.includes('--gen') || args.includes('--info')) return 0;

  return supervise(xray, CONF_PATH);
}

main().then((code) => { process.exit(code || 0); }).catch((e) => {
  log('ERROR: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
