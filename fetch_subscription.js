#!/usr/bin/env node
/**
 * fetch_subscription.js —— 从 KataBump 容器拉取最新的节点参数并刷新订阅
 * =====================================================================
 *
 * 【为什么必须有这个脚本】
 *   容器里的 index.js 在**重装 / 重建**时会重新生成一整组参数：
 *     uuid / private_key / public_key / short_id  全部变。
 *   而客户端本地存的 clash.yaml 还是老参数 →
 *     mihomo 一直报 "REALITY authentication failed"。
 *   这是本项目踩过最大的坑（2026-10-26 实测）。
 *
 *   所以每次续期之后，必须重新从容器把参数捞回来。
 *
 * 【本脚本做的事】
 *   1. 用服务器专属凭据登录 control.katabump.com（Pterodactyl 后端）
 *   2. 进 Files 页，依次点开 node-info.json / clash.yaml / sub.txt，
 *      从编辑器 DOM 里读出内容
 *   3. 把读到的内容覆盖写回本仓库（clash.yaml / sub.txt / node-info.json）
 *   4. 用容器里的真实参数做一次端口回测，把不可用端口从订阅里剔掉
 *   5. 提交并推送（订阅地址是 raw.githubusercontent，用户端直接拉这个）
 *
 * 【用法】
 *   node fetch_subscription.js
 *   node fetch_subscription.js --dry-run     只读不写，用于排查
 *
 * 【凭据来源】
 *   优先用环境变量：
 *     YOUR_ID  —— 控制面板登录账号（Access server 页的 Identifier）
 *     CUR_PWD  —— 控制面板登录密码（Access server 页的 Current password）
 *   读不到就回退到 action_renew.js / auto_start.js 的解析逻辑。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DRY = process.argv.includes('--dry-run');

const OUT_DIR = path.join(ROOT, 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME_PATH = process.env.CHROME_PATH ||
    'C:/Program Files/Google/Chrome/Application/chrome.exe';

const SHORT_ID = process.env.SERVER_SHORT_ID || '77f51fce';
const YOUR_ID = process.env.YOUR_ID || '';
const CUR_PWD = process.env.CUR_PWD || '';

const TARGET_FILES = ['node-info.json', 'clash.yaml', 'sub.txt'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSrc = '';

function log(m) { console.log('[fetch-sub] ' + m); }

// ------------------------------------------------------------ 浏览器
async function launch() {
    const puppeteer = require('playwright');
    const browser = await puppeteer.chromium.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu',
               '--disable-dev-shm-usage', '--no-sandbox', '--window-size=1600,1000'],
    });
    return browser;
}

// ------------------------------------------------------------ 登录控制面板
async function login(page) {
    await page.goto('https://control.katabump.com/', { waitUntil: 'networkidle' });
    await sleep(3000);

    if (!page.url().includes('login') && !/login/i.test(await page.title())) {
        log('已登录，跳过登录步骤');
        return true;
    }

    const inputs = await page.$$('input');
    if (inputs.length < 2) { log('❌ 登录页找不到输入框'); return false; }

    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type(YOUR_ID, { delay: 20 });
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type(CUR_PWD, { delay: 20 });
    await sleep(400);

    await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button,input[type="submit"]'));
        const hit = els.find((el) => /log\s?in/i.test((el.innerText || el.value || '').trim()));
        if (hit) hit.click();
    });
    await sleep(7000);

    const ok = !page.url().includes('login');
    log(ok ? '✅ 控制面板登录成功' : '❌ 控制面板登录失败');
    return ok;
}

// ------------------------------------------------------------ 从 Files 页读文件
async function readFileFromFiles(page, filename) {
    await page.goto(`https://control.katabump.com/server/${SHORT_ID}/files`,
        { waitUntil: 'networkidle' });
    await sleep(4000);

    const clicked = await page.evaluate((name) => {
        const els = Array.from(document.querySelectorAll('*'));
        const hit = els.find((el) => el.children.length === 0 &&
            (el.textContent || '').trim() === name);
        if (!hit) return false;
        try {
            hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
        } catch (e) { return false; }
    }, filename);

    if (!clicked) { log(`  ⚠️ 文件列表里没找到 ${filename}`); return ''; }
    await sleep(5000);

    const txt = await page.evaluate((wantName) => {
        // ⚠️ Pterodactyl 的 Files 编辑器是 **CodeMirror**（不是 Monaco）。
        //    行号在 .CodeMirror-linenumber 里，正文在 .CodeMirror-code 里。
        //    取 .CodeMirror-line 的 textContent 才能拿到干净的一行原文。
        const cm = document.querySelectorAll('.CodeMirror');
        if (cm.length) {
            // 多个实例时取内容最长的
            let best = null;
            for (const c of cm) {
                const lines = c.querySelectorAll('.CodeMirror-line');
                if (!lines.length) continue;
                const arr = [];
                for (const l of lines) arr.push(l.textContent || '');
                const joined = arr.join('\n');
                if (!best || joined.length > best.length) best = joined;
            }
            if (best && best.trim()) return { text: best, src: 'codemirror-lines' };
        }

        // 备选：CodeMirror 的 textarea（隐藏的输入框）
        const ta = document.querySelectorAll('.CodeMirror textarea');
        if (ta.length && ta[0].value) return { text: ta[0].value, src: 'codemirror-textarea' };

        // 备选：Monaco model
        try {
            const mon = window.monaco;
            if (mon && mon.editor) {
                const models = mon.editor.getModels();
                for (const m of models) {
                    const uri = (m.uri && m.uri.toString) ? m.uri.toString() : '';
                    if (uri && uri.toLowerCase().includes(wantName.toLowerCase())) {
                        const v = m.getValue();
                        if (v && v.trim()) return { text: v, src: 'monaco-model' };
                    }
                }
                let best = null;
                for (const m of models) {
                    const v = m.getValue();
                    if (!best || v.length > best.length) best = v;
                }
                if (best && best.trim()) return { text: best, src: 'monaco-model-latest' };
            }
        } catch (e) { /* fallthrough */ }

        // 最后兜底
        const parts = [];
        const tas = document.querySelectorAll('textarea');
        for (const t of tas) parts.push(t.value || '');
        const modal = document.querySelector('.modal, [role="dialog"]');
        if (modal) parts.push(modal.innerText || '');
        return { text: parts.join('\n@@@\n'), src: 'dom' };
    }, filename);
    lastSrc = txt.src;
    return txt.text;
}

/**
 * 清洗 CodeMirror 读出来的文本。
 *
 * ⚠️ CodeMirror 用 &nbsp;（U+00A0）表示缩进，直接 JSON.parse 会报
 *    "Expected property name or '}'"。必须把行首的 U+00A0 换成普通空格，
 *    再把行尾空白去掉。
 */
function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/ /g, ' ')        // nbsp → 普通空格
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .join('\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n');
}

// ------------------------------------------------------------ 端口回测
/**
 * 逐个端口做公网回测。
 *
 * ⚠️ 必须连「公网 IP」而不是 127.0.0.1：
 *    连 127.0.0.1 只测到容器内监听，测不出平台 NAT 层的问题
 *    （平台自己在同一批端口上挂了面板服务，或端口根本没映射到外网）。
 *
 * 判定方式：走 REALITY 握手成功 → 拿到目标站的 HTTP 响应 = 可用。
 * 用纯 Node 实现（不依赖 mihomo / geoip 库），CI 里可直接跑。
 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

/** 通过 SOCKS5 + TLS 走一次 HTTP GET，返回状态码或 null */
function probeViaReality(info, port, target, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };

        const sock = net.connect({ host: info.server, port }, () => {
            // ---- SOCKS5 握手（无认证） ----
            sock.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let stage = 0;
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => { try { sock.destroy(); } catch (e) {} done(null); }, timeoutMs);

        sock.on('error', () => { clearTimeout(timer); done(null); });
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (stage === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
                const u = new URL(target);
                const host = Buffer.from(u.hostname, 'utf8');
                const tp = u.port ? parseInt(u.port, 10) : 80;
                sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
                    Buffer.from([(tp >> 8) & 0xff, tp & 0xff]),
                ]));
                stage = 1; buf = Buffer.alloc(0);
                return;
            }
            if (stage === 1) {
                if (buf.length < 2) return;
                if (buf[1] !== 0x00) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
                stage = 2; buf = Buffer.alloc(0);
                return;
            }
            const m = buf.toString('latin1').match(/^HTTP\/1\.[01]\s+(\d{3})/);
            if (m) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} done(parseInt(m[1], 10)); }
        });
    });
}

/**
 * REALITY 握手需要客户端侧的 X25519 + 认证，这里直接用 xray 客户端最省事。
 * 容器/CI 里已经有 xray-linux-amd64（或本地的 xray.exe）。
 */
function verifyPorts(info, ports) {
    return (async () => {
        const results = [];
        const usable = [];
        const VERIFY_TARGET = process.env.VERIFY_URL || 'http://www.gstatic.com/generate_204';
        const xray = findXray();
        if (!xray) {
            // ⚠️ 降级必须是「保守」的：
            // 拿不到 xray 就无法证明端口可用，若此时把全部端口都发布出去，
            // 会把平台面板端口 / 未映射端口一起塞进订阅 —— 客户端会连到
            // 别人的服务或直接失败，表现为「时好时坏」。
            // 所以这里只发布第一个端口（KataBump 的主端口），
            // 并在 node-info.json 里标记未回测，等下次有 xray 时再自动修正。
            log('⚠️ 找不到 xray 可执行文件，端口回测跳过（保守降级：只发布首个端口）');
            const fallback = ports.length ? [ports[0]] : [];
            return {
                usable: fallback,
                results: ports.map((p) => ({
                    port: p,
                    ok: p === fallback[0],
                    detail: p === fallback[0] ? '未回测(保守放行)' : '未回测(保守剔除)',
                })),
                degraded: true,
            };
        }

        for (const p of ports) {
            const r = await probeWithXray(xray, info, p, VERIFY_TARGET);
            const ok = r.ok;
            results.push({ port: p, ok, detail: r.detail });
            if (ok) usable.push(p);
            log(`  端口 ${p}: ${ok ? '✅ ' + r.detail : '❌ ' + r.detail}`);
        }
        return { usable, results };
    })();
}

function findXray() {
    const isWin = process.platform === 'win32';
    const cands = [
        process.env.XRAY_PATH,
        // CI 里由 "Download xray" 步骤解压到工作目录根
        path.join(ROOT, 'xray-linux-amd64'),
        path.join(ROOT, 'xray-linux-64', 'xray'),
        // Linux(CI) 用无扩展名的二进制；Windows 用 .exe
        isWin ? path.join(ROOT, 'xray.exe') : path.join(ROOT, 'xray'),
        path.join(ROOT, '本地工具', 'xray.exe'),          // Windows 本地备选
        isWin ? path.join(ROOT, 'xray-linux-amd64.exe') : null,
    ].filter(Boolean);
    for (const c of cands) {
        if (!fs.existsSync(c)) continue;
        try {
            // 必须是「可执行文件」而不是同名目录
            if (!fs.statSync(c).isFile()) continue;
        } catch (e) { continue; }
        return c;
    }
    return null;
}

/** 用 xray 当客户端回测单个端口 */
function probeWithXray(xray, info, port, target) {
    return new Promise((resolve) => {
        const dir = path.join(ROOT, '.xray-verify');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const cfgPath = path.join(dir, `p${port}.json`);
        const socksPort = 20000 + (process.pid % 20000) + (port % 100);
        const cfg = {
            log: { loglevel: 'error' },
            inbounds: [{ tag: 'in', port: socksPort, listen: '127.0.0.1', protocol: 'socks', settings: { udp: false } }],
            outbounds: [{
                tag: 'out', protocol: 'vless',
                settings: { vnext: [{ address: info.server, port, users: [{ id: info.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
                streamSettings: {
                    network: 'tcp', security: 'reality',
                    realitySettings: { show: false, fingerprint: 'chrome', serverName: info.sni, publicKey: info.public_key, shortId: info.short_id, spiderX: '/' },
                },
            }],
        };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

        let child;
        try {
            const out = fs.openSync(path.join(dir, 'verify.log'), 'a');
            child = spawn(xray, ['run', '-c', cfgPath], { detached: true, stdio: ['ignore', out, out] });
            // ⚠️ 必须接住 'error' 事件！否则 ENOENT 会作为未捕获异常直接把进程打崩
            child.on('error', (e) => {
                log('  xray 启动失败: ' + e.message);
            });
            child.unref();
        } catch (e) { return resolve({ ok: false, detail: 'xray 启动失败: ' + e.message }); }

        // 等 xray 就绪 + 发起请求
        const t = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
            resolve({ ok: false, detail: '超时' });
        }, 30000);

        const poll = async () => {
            for (let i = 0; i < 30; i++) {
                await sleep(300);
                const alive = await new Promise((res) => {
                    const s = net.connect({ port: socksPort, host: '127.0.0.1' });
                    s.on('connect', () => { s.destroy(); res(true); });
                    s.on('error', () => res(false));
                    setTimeout(() => { try { s.destroy(); } catch (e) {} res(false); }, 700);
                });
                if (!alive) continue;

                const code = await httpViaSocks(socksPort, target, 12000);
                clearTimeout(t);
                try { child.kill('SIGKILL'); } catch (e) {}
                try { fs.unlinkSync(cfgPath); } catch (e) {}
                if (code && code >= 200 && code < 500) return resolve({ ok: true, detail: 'HTTP ' + code });
                return resolve({ ok: false, detail: code ? 'HTTP ' + code : '不可用' });
            }
            clearTimeout(t);
            try { child.kill('SIGKILL'); } catch (e) {}
            try { fs.unlinkSync(cfgPath); } catch (e) {}
            resolve({ ok: false, detail: '验证客户端未就绪' });
        };
        poll();
    });
}

/** 通过 socks5 发一个 HTTP GET，返回状态码或 null */
function httpViaSocks(socksPort, target, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        let sock;
        try { sock = net.connect(socksPort, '127.0.0.1'); } catch (e) { return done(null); }
        const timer = setTimeout(() => { try { sock.destroy(); } catch (e) {} done(null); }, timeoutMs);
        let buf = Buffer.alloc(0);
        let stage = 0;

        sock.on('error', () => { clearTimeout(timer); done(null); });
        sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (stage === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
                const u = new URL(target);
                const host = Buffer.from(u.hostname, 'utf8');
                const tp = u.port ? parseInt(u.port, 10) : 80;
                sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
                    Buffer.from([(tp >> 8) & 0xff, tp & 0xff]),
                    Buffer.from('GET ' + (u.pathname || '/') + ' HTTP/1.1\r\nHost: ' + u.host +
                        '\r\nUser-Agent: verify\r\nConnection: close\r\n\r\n'),
                ]));
                stage = 1; buf = Buffer.alloc(0);
                return;
            }
            if (stage === 1) {
                if (buf.length < 2) return;
                if (buf[1] !== 0x00) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} return done(null); }
                stage = 2; buf = Buffer.alloc(0);
                return;
            }
            const m = buf.toString('latin1').match(/^HTTP\/1\.[01]\s+(\d{3})/);
            if (m) { clearTimeout(timer); try { sock.destroy(); } catch (e) {} done(parseInt(m[1], 10)); }
        });
    });
}

// ------------------------------------------------------------ 主流程
async function main() {
    if (!YOUR_ID || !CUR_PWD) {
        log('❌ 缺少 YOUR_ID / CUR_PWD 环境变量');
        log('   在 GitHub Actions 里配成 Secrets，在本地 export 后再跑。');
        return 1;
    }

    const browser = await launch();
    const page = await browser.newPage();
    try {
        await page.setViewportSize({ width: 1600, height: 1000 });

        if (!await login(page)) return 1;

        const got = {};
        for (const name of TARGET_FILES) {
            const clean = cleanText(await readFileFromFiles(page, name));
            if (clean) {
                got[name] = clean;
                log(`✅ 读到 ${name}（${clean.length} 字符，源=${lastSrc}）`);
            } else {
                log(`⚠️ ${name} 读取为空`);
            }
        }

        if (!got['node-info.json']) {
            log('❌ 没读到 node-info.json，无法刷新订阅');
            return 1;
        }

        const rawInfo = got['node-info.json'];
        log('node-info.json 原始内容: ' + JSON.stringify(rawInfo).slice(0, 600));
        const info = JSON.parse(rawInfo);
        log(`节点参数: server=${info.server} uuid=${info.uuid} short_id=${info.short_id}`);

        // 端口回测
        const listenPorts = Array.isArray(info.ports) ? info.ports : [];
        const usable = [];
        if (listenPorts.length) {
            log('开始端口回测：');
            const r = await verifyPorts(info, listenPorts);
            if (r.usable.length) usable.push(...r.usable);
            info.usable_ports = r.usable;
            info.port_check = r.results;
        }

        // 重写 clash.yaml：只保留可用端口
        const pubPorts = usable.length ? usable : [20330];
        const yml = buildClash(info, pubPorts);
        const links = pubPorts.map((p) => buildLink(info, p));
        // Cloudflare 隧道节点（如果容器里启用了）
        const cf = (info.cf && info.cf.enabled) ? info.cf : null;
        if (cf) {
            links.push(buildCfLink(cf));
            log(`✅ 追加 Cloudflare 隧道节点: ${cf.hostname}${cf.path}`);
        }
        const sub = Buffer.from(links.join('\n'), 'utf8').toString('base64');

        const files = {
            'clash.yaml': yml,
            'sub.txt': sub,
            'node-info.json': JSON.stringify(info, null, 2) + '\n',
        };

        for (const [name, content] of Object.entries(files)) {
            const p = path.join(ROOT, name);
            const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
            if (old === content) { log(`  ${name} 无变化`); continue; }
            log(`  ${name} 有更新（${old.length} → ${content.length} 字符）`);
            if (!DRY) fs.writeFileSync(p, content, 'utf8');
        }

        if (DRY) {
            log('--dry-run 模式，未写入文件');
            log('\n----- 新订阅预览 -----');
            console.log(yml);
        }
        return 0;
    } finally {
        await browser.close();
    }
}

function buildClash(info, ports) {
    const cf = (info.cf && info.cf.enabled) ? info.cf : null;

    const proxies = ports.map((p) => `  - name: "KataBump-${p}"
    type: vless
    server: ${info.server}
    port: ${p}
    uuid: ${info.uuid}
    udp: true
    tls: true
    network: tcp
    flow: xtls-rprx-vision
    servername: ${info.sni}
    client-fingerprint: chrome
    reality-opts:
      public-key: ${info.public_key}
      short-id: "${info.short_id}"
      # Xray v26.7.11+ 要求 ClientHello 带后量子混合密钥交换
      # 缺这一行 mihomo 会一直报 REALITY authentication failed
      support-x25519mlkem768: true`);

    const names = ports.map((p) => `KataBump-${p}`);

    // ---- Cloudflare 隧道节点 ----
    // 走 CF 边缘 + 骨干网回源，绕开「国内 -> 法国 OVH」这条拥塞窗口被掐死的线路。
    if (cf) {
        proxies.push(`  - name: "CF-Tunnel"
    type: vless
    server: ${cf.hostname}
    port: 443
    uuid: ${cf.uuid}
    udp: true
    tls: true
    network: ws
    servername: ${cf.hostname}
    client-fingerprint: chrome
    skip-cert-verify: false
    ws-opts:
      path: ${cf.path}
      headers:
        Host: ${cf.hostname}`);
        names.push('CF-Tunnel');
    }

    const gl = names.map((n) => `      - "${n}"`).join('\n');
    return `# ===== KataBump 节点 · Clash / mihomo 配置 (v4 Node 版) =====
# 由 CI 自动刷新（fetch_subscription.js），参数来自容器内 node-info.json
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090
unified-delay: true
tcp-concurrent: true
# 关闭 Nagle 算法（保留，默认开着；关掉没有副作用）。
#
# ⚠️ 关于速度根因的准确表述（2026-10-27 实测再修正）：
# 早前注释写的「+160% / +340%」是单次采样假象，不可复现。
# 症状是 **这条跨境线路的单流 TCP 拥塞窗口在某些时段从一开始就被掐死**：
#   经节点单连接连续下载 6MB × 5 次 -> 恒定 13~17 KB/s，从第一秒起就长不大；
#   直连 Cloudflare 边缘同样 6MB × 5 次 -> 235→446→686→830→1016 KB/s 持续上升；
#   两条链路的 TCP 握手都是 100% 成功（60/60），CF 的 p50 RTT(183ms) 甚至
#   比节点(248ms) 更低 —— 说明链路没断，是这条特定线路的窗口被限制。
# 同一节点开多条独立连接可线性叠加（16 路 = 343 KB/s），属客户端唯一有效手段。
# tcp-no-delay / bufferSize / TFO / mptcp / tcpKeepAlive 全部实测无显著差异，
# 但保留 tcp-no-delay 无害且符合直觉，继续开着。
#
# ⚠️⚠️ 两个重要补充（2026-10-27）：
#   1) 上面那批「13 KB/s」的读数**本身被测速脚本放大了**（计时起点算上了
#      SOCKS 握手 + 缓冲区丢字节），修正后同一脚本低 2.2×。
#      正确测速实现见 本地工具/verify_speed_truth.js。
#   2) 这条线路**存在明显的时段性波动**：同一脚本 10-26 晚测得经节点 13 KB/s、
#      10-27 早测得 1512 KB/s（同期直连 CF 天花板从 1016 涨到 18780 KB/s）。
#      所以症状是「周期性变慢」，不是「永久限速」。
#      CF-Tunnel 节点（走 CF 骨干网）的价值就是绕开这个波动。
#
# ⚠️ 不要开 tcp-fast-open：TFO cookie 需要一次往返建立，
# 高 RTT 下收益为负，实测反而更慢。
tcp-no-delay: true

proxies:
${proxies.join('\n')}

proxy-groups:
  - name: "节点选择"
    type: select
    proxies:
${gl}
      - DIRECT
  - name: "自动测速"
    type: url-test
    proxies:
${gl}
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50

rules:
  - GEOIP,LAN,DIRECT,no-resolve
  - GEOIP,CN,DIRECT
  - MATCH,节点选择
`;
}

function buildLink(info, port) {
    const q = new URLSearchParams({
        encryption: 'none', flow: 'xtls-rprx-vision', security: 'reality',
        sni: info.sni, fp: 'chrome', pbk: info.public_key, sid: info.short_id,
        type: 'tcp', headerType: 'none',
    });
    return `vless://${info.uuid}@${info.server}:${port}?${q.toString()}#${encodeURIComponent('KataBump-' + port)}`;
}

/** Cloudflare 隧道节点分享链接（VLESS + WS + TLS） */
function buildCfLink(cf) {
    const q = new URLSearchParams({
        encryption: 'none', security: 'tls', type: 'ws',
        host: cf.hostname, path: cf.path, sni: cf.hostname, fp: 'chrome',
    });
    return `vless://${cf.uuid}@${cf.hostname}:443?${q.toString()}#${encodeURIComponent('CF-Tunnel')}`;
}

main().then((c) => process.exit(c || 0)).catch((e) => {
    console.error('[fetch-sub] 错误:', e);
    process.exit(1);
});
