/**
 * KataBump 自动启动器
 * ====================
 * 用途：登录面板，把处于 offline 状态的服务器点 Start 拉起来。
 *
 * 为什么需要它：
 *   - 免费容器每 4 天到期，续期后服务器是 offline 状态，需要手动点 Start
 *   - 平台维护 / 宿主机重启后，容器不会自己起来
 *   - 有了它，配合续期 workflow 就是「续期 + 开机」全自动
 *
 * 行为：
 *   1. 登录 dashboard.katabump.com（复用 Turnstile CDP 绕过）
 *   2. 进入服务器详情页
 *   3. 找 Start / Power / 启动 按钮并点击
 *   4. 等待服务器状态变成 running / online
 *   5. 截图 + Telegram 通知
 *
 * 环境变量：
 *   USERS_JSON      必填，格式 [{"username":"xxx","password":"xxx"}]
 *   TG_BOT_TOKEN    可选
 *   TG_CHAT_ID      可选
 *   HTTP_PROXY      可选
 *   CHROME_PATH     可选，默认 /usr/bin/google-chrome
 *   DRY_RUN=1       只看状态不点击（调试用）
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, exec } = require('child_process');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
// 用 9223 而不是 9222 —— 避免和 action_renew.js 在同一个 job 里抢端口
const DEBUG_PORT = parseInt(process.env.DEBUG_PORT || '9223', 10);
const DRY_RUN = process.env.DRY_RUN === '1';

/** 当前正在处理的账号 —— control.katabump.com 独立登录时要用 */
let CURRENT_USER = { username: '', password: '' };

/**
 * 服务器专属凭据（从 "Access server" 标签页读取）。
 * ⚠️ control.katabump.com 的登录密码是服务器的 "Current password"，
 *    不是 KataBump 账号密码。
 */
let SERVER_CREDENTIALS = { identifier: '', password: '', link: '', serverId: '', hexIds: [] };

/** 检查某个端口上是否有服务在监听 */
async function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
}

chromium.use(stealth);
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- 代理配置 ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : null,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : null,
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] 配置解析失败:', e.message);
    }
}

async function sendTelegram(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown',
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise((resolve) => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

// --- Turnstile CDP 绕过（与 action_renew.js 同一套逻辑）---
const INJECTED_SCRIPT = `
(function() {
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : (req && req.url) || '';
    if (url.includes('/api/v1/user/turnstile')) {
      console.log('>>> Turnstile API called');
      const headers = (req && req.headers) || {};
      console.log('>>> Headers: ' + JSON.stringify(headers));
    }
    return origFetch.apply(this, args);
  };
})();
`;

async function attemptTurnstileCdp(page) {
    try {
        const client = await page.context().newCDPSession(page);
        await client.send('Page.enable');
        await client.send('Runtime.enable');

        let found = false;
        for (const frame of page.frames()) {
            if (!frame.url().includes('challenges.cloudflare.com')) continue;
            found = true;
            const box = await frame.locator('body').boundingBox().catch(() => null);
            if (!box) continue;
            const x = box.x + box.width / 2;
            const y = box.y + 30;
            await client.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: 'left', clickCount: 1,
            });
            await client.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
            });
        }
        return found;
    } catch (e) {
        return false;
    }
}

async function isTurnstilePassed(page) {
    for (const f of page.frames()) {
        if (f.url().includes('cloudflare')) {
            try {
                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true;
            } catch (e) { /* ignore */ }
        }
    }
    return false;
}

/**
 * 切到 "Access server" 标签页。
 *
 * ⚠️ 关键：KataBump 的服务器状态和 Start 按钮不在 "General" 页，
 *    而在 "🚀 Access server" 这个子标签里。
 *    只在 General 页找，永远读到 unknown、也永远找不到启动按钮。
 *
 * 这个元素在 DOM 里可能是 <a> / <div> / <button>，
 * 而且 getByText 可能匹配到多个（外层容器 + 文字节点），
 * 所以逐个候选试，最后用 JS 直接点文本节点兜底。
 */
async function switchToAccessServerTab(page) {
    const candidates = [
        page.getByRole('tab', { name: /access server/i }),
        page.getByRole('link', { name: /access server/i }),
        page.getByRole('button', { name: /access server/i }),
        page.getByText('Access server', { exact: true }),
        page.getByText(/access server/i),
        page.locator('text=Access server'),
    ];
    for (const c of candidates) {
        try {
            await c.first().waitFor({ state: 'visible', timeout: 3000 });
            await c.first().click({ timeout: 5000 });
            await page.waitForTimeout(2000);
            console.log('   >> 已切换到 "Access server" 标签页');
            return true;
        } catch (e) { /* try next */ }
    }

    // 兜底：直接在页面里找含 "Access server" 的元素并用 JS 点击
    try {
        const done = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('a,button,div,span,li,p'));
            const hit = els.find((el) => {
                const t = (el.textContent || '').trim();
                return /access server/i.test(t) && t.length < 40;
            });
            if (!hit) return false;
            hit.click();
            return true;
        });
        if (done) {
            await page.waitForTimeout(2000);
            console.log('   >> 已切换到 "Access server" 标签页（JS 兜底）');
            return true;
        }
    } catch (e) { /* ignore */ }

    console.log('   >> 未找到 "Access server" 标签（可能面板改版了）');
    return false;
}

/** 读取页面上服务器状态文本 */
async function readServerStatus(page) {
    // --- 策略 1：找"内容恰好是状态词"的叶子元素 ---
    // 实测控制面板首页的服务器卡片上就有一个绿标，文字是 "Online"，
    // 离线时是 "Offline"。这个元素没有 badge/status 之类的 class，
    // 所以不能靠 class 找，只能靠"文本正好等于状态词"来命中。
    try {
        const badge = await page.evaluate(() => {
            const WORD = /^(online|offline|running|stopped|starting|crashed|active|inactive|已停止|已离线|运行中|在线|启动中|崩溃)$/i;
            const leaves = Array.from(document.querySelectorAll('body *'))
                .filter((el) => el.children.length === 0);   // 只看叶子节点
            for (const el of leaves) {
                const t = (el.textContent || '').trim();
                if (t && t.length < 24 && WORD.test(t)) return t;
            }
            return '';
        });
        if (badge) {
            const b = badge.toLowerCase();
            if (/offline|stopped|inactive|已停止|已离线/.test(b)) return 'offline';
            if (/online|running|active|运行中|在线/.test(b)) return 'running';
            if (/starting|启动中/.test(b)) return 'starting';
            if (/crash|崩溃/.test(b)) return 'crashed';
        }
    } catch (e) { /* ignore */ }

    // --- 策略 2：带 status/badge/pill 特征的徽章 ---
    try {
        const badge = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll(
                '[class*="badge"],[class*="status"],[class*="pill"],[class*="dot"],[class*="indicator"]'));
            for (const el of els) {
                const t = (el.textContent || '').trim();
                if (t && t.length < 30) return t;
            }
            return '';
        });
        if (badge) {
            const b = badge.toLowerCase();
            if (/offline|stopped|已停止|已离线/.test(b)) return 'offline';
            if (/running|online|运行中|在线/.test(b)) return 'running';
            if (/starting|启动中/.test(b)) return 'starting';
            if (/crash|崩溃/.test(b)) return 'crashed';
        }
    } catch (e) { /* ignore */ }

    // --- 策略 3：全页文本匹配 ---
    // ⚠️ offline 要先判，因为 "offline" 里不含 "online" 子串，但反过来
    //    "not online" 会误判成 running，所以 offline 优先更安全。
    const body = await page.locator('body').innerText().catch(() => '');
    const lower = body.toLowerCase();
    if (/\boffline\b|\bstopped\b|已停止|已离线/.test(lower)) return 'offline';
    if (/\bonline\b|\brunning\b|运行中|在线/.test(lower)) return 'running';
    if (/\bstarting\b|starting up|启动中/.test(lower)) return 'starting';
    if (/\bcrashed\b|崩溃/.test(lower)) return 'crashed';
    return 'unknown';
}

/**
 * 从 "Access server" 标签页跳到真正的控制面板。
 *
 * ⚠️ KataBump 的页面结构（实测截图确认）：
 *    - dashboard.katabump.com/server/xxx 的 "🚀 Access server" 标签页里
 *      只有 Link / Identifier / Current password 和一个 "Go to server" 按钮
 *    - **没有** Start / Power 按钮，也看不到运行状态
 *    - 真正的控制面板在 Link 字段指向的地址：
 *      https://control.katabump.com/server/<identifier>
 *      那里才有 Start / Stop / Power 按钮和运行状态
 *
 * 所以流程是：dashboard 服务器页 → 切 Access server 标签 → 读 Link → 跳 control 面板
 */
/**
 * 从 "Access server" 标签页读取服务器的登录凭据。
 *
 * ⚠️ 关键：控制面板（control.katabump.com）的密码**不是** KataBump 账号密码，
 *    而是服务器专属的 "Current password"（一个十六进制串，如 9d1c8b0f884e）。
 *    账号密码在这里登录会失败。
 *
 * 页面结构（实测截图）：
 *   Link              https://control.katabump.com/server/77f51fce
 *   Identifier        c1771abb34b6161
 *   Current password  9d1c8b0f884e
 *
 * @returns {{identifier:string, password:string}}
 */
async function readServerCredentials(page) {
    const creds = { identifier: '', password: '', link: '', serverId: '', hexIds: [] };
    try {
        const found = await page.evaluate(() => {
            const out = { identifier: '', password: '', link: '', serverId: '', hexIds: [] };

            const inputs = Array.from(document.querySelectorAll('input'));
            const valOf = (el) => (el.value || '').trim();
            const nameOf = (el) => (el.name || '').toLowerCase();
            const idOf = (el) => (el.id || '').toLowerCase();

            // 无意义的值（不是我们要的凭据）
            const isJunk = (el, v) => {
                if (!v) return true;
                const h = nameOf(el) + ' ' + idOf(el);
                if (/csrf|csrf|token/.test(h)) return true;       // csrf 表单域
                if (/^[0-9a-f]{40,}$/i.test(v)) return true;      // csrf token 本体
                if (/^\d+$/.test(v)) return true;                  // 内部数字 id（406255）
                if (/^https?:\/\//i.test(v)) return true;          // URL
                return false;
            };
            const isPwdField = (el) => /pass|secret/.test(nameOf(el) + ' ' + idOf(el));

            // --- 1) Link：值里含 control.katabump.com 的 URL ---
            // ⚠️ input 的 value **不会**出现在 innerText 里，必须单独扫 input.value
            let linkEl = null;
            for (const el of inputs) {
                const m = valOf(el).match(/https:\/\/control\.katabump\.com\/[^\s"'<>]+/);
                if (m) { out.link = m[0]; linkEl = el; break; }
            }
            if (!out.link) {
                const m = (document.body.innerText || '')
                    .match(/https:\/\/control\.katabump\.com\/[^\s"'<>]+/);
                if (m) out.link = m[0];
            }

            // --- 2) Current password：name/id 含 pass 的 input ---
            for (const el of inputs) {
                if (isPwdField(el) && valOf(el)) { out.password = valOf(el); break; }
            }

            // --- 3) Identifier：Link 输入框**后面紧跟**的那个合法值 ---
            //     实测 DOM 顺序：
            //       #13 [类型 NodeJs] #14 [Link] #15 [Identifier] #16 [Current password] #17 [csrf]
            //     ⚠️ 不能用 name 猜！name=serverid 的 input 值是内部数字 406255，不是登录 ID。
            if (linkEl) {
                const i = inputs.indexOf(linkEl);
                for (let j = i + 1; j < inputs.length; j++) {
                    const el = inputs[j];
                    const v = valOf(el);
                    if (isJunk(el, v)) continue;
                    if (isPwdField(el)) continue;
                    out.identifier = v;
                    break;
                }
            }

            // --- 4) 兜底：所有"像 ID"的十六进制串（排除密码 / csrf / URL / 纯数字）---
            const cands = [];
            for (const el of inputs) {
                const v = valOf(el);
                if (isJunk(el, v)) continue;
                if (isPwdField(el)) continue;
                if (v === out.password) continue;
                if (/^[0-9a-f]{6,32}$/i.test(v)) cands.push(v);
            }
            out.hexIds = cands;
            if (!out.identifier && cands.length) out.identifier = cands[0];

            // --- 5) serverId：Link 路径尾段（注意它跟 Identifier 不是同一个东西）---
            //     实测：Link = .../server/77f51fce，但真正能登录的 Your ID = c1771abb34b6161
            if (out.link) {
                const m = out.link.match(/\/server\/([^/?#]+)/);
                if (m) out.serverId = m[1];
            }

            return out;
        });
        creds.identifier = found.identifier || '';
        creds.password = found.password || '';
        creds.link = found.link || '';
        creds.serverId = found.serverId || '';
        creds.hexIds = found.hexIds || [];
    } catch (e) {
        console.log('   >> 读取服务器凭据异常:', e.message);
    }
    return creds;
}

async function gotoControlPanel(page) {
    // 方案 1：点 "Go to server"。
    // 注意它不一定是 <button>，可能是 <a> 或 <div>，所以用 text 匹配更保险。
    try {
        const btn = page.getByText('Go to server', { exact: true }).first();
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(5000);
        if (page.url().includes('control.katabump.com')) {
            console.log('   >> 已通过 "Go to server" 跳到控制面板');
            return page;
        }
        // 可能在新标签页打开了 —— 这是实测到的情况
        const pages = page.context().pages();
        const ctrl = pages.find((p) => p.url().includes('control.katabump.com'));
        if (ctrl) {
            console.log('   >> 控制面板在新标签页打开了');
            return ctrl;
        }
    } catch (e) { /* 试下一招 */ }

    // 方案 2：优先用已经读到的 Link；否则从页面上任何地方提取 control.katabump.com 的 URL
    try {
        let link = SERVER_CREDENTIALS.link || '';
        if (!link) {
            link = await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('*'));
                for (const el of all) {
                    const vals = [el.value, el.textContent, el.href, el.getAttribute('href')]
                        .filter(v => typeof v === 'string');
                    for (const v of vals) {
                        const m = v.match(/https:\/\/control\.katabump\.com\/[^\s"'<>]+/);
                        if (m) return m[0];
                    }
                }
                return '';
            });
        }
        if (link) {
            console.log('   >> 控制面板地址:', link);
            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(4000);
            console.log('   >> 已跳转到控制面板');
            return page;
        }
    } catch (e) { /* ignore */ }

    // 方案 3：当前页直接找 Start 按钮（老版面板结构，兼容）
    console.log('   >> ⚠️ 未能跳到控制面板，尝试在当前页直接找启动按钮');
    // 诊断：把页面上所有含 katabump.com 的文本 dump 出来
    try {
        const urls = await page.evaluate(() => {
            const out = new Set();
            for (const el of document.querySelectorAll('*')) {
                for (const v of [el.value, el.textContent, el.href]) {
                    if (typeof v === 'string' && v.includes('katabump.com') && v.length < 200) {
                        const m = v.match(/[a-z]*:\/\/[^\s"'<>]*katabump\.com[^\s"'<>]*/i);
                        if (m) out.add(m[0]);
                    }
                }
            }
            return Array.from(out).slice(0, 15);
        });
        console.log('   >> 页面上出现的 katabump 链接:', JSON.stringify(urls, null, 1));
    } catch (e) { /* ignore */ }
    return page;
}

/**
 * control.katabump.com 是独立域名，可能需要单独登录。
 * 如果跳过去发现是登录页，就用同一套凭据登录一次。
 */
async function ensureControlLogin(page) {
    try {
        const url = page.url();
        const body = await page.locator('body').innerText().catch(() => '');
        // 已经能看到 Start / Stop / Power，说明已登录，压根不需要这一步
        if (/start server|power on|stop server|power control|\bstart\b|\bstop\b|\bpower\b/i.test(body)) {
            console.log('   >> 控制面板已登录（能看到启动/停止控件）');
            return true;
        }
        const needsLogin = /login|sign ?in/i.test(url) ||
            (/\bpassword\b/i.test(body) && !/start|stop|power/i.test(body));
        if (!needsLogin) return true;

        console.log('   >> 控制面板需要登录');

        // --- 组装候选凭据组合 ---
        // control.katabump.com 用的是服务器专属凭据：
        //   Your ID  = Access server 标签页的 "Identifier"（实测 16 位，如 c1771abb34b6161）
        //   Password = "Current password"（实测 12 位，如 9d1c8b0f884e）
        //
        // ⚠️ 血泪教训：Link 路径尾段（77f51fce）**不是**登录 ID，
        //    name=serverid 的 input 值（406255）是内部数字 id，也不是。
        //    只有页面上的 "Identifier" 字段值才对。
        //    之前顺序搞反 → 试了 4 组全被拒（报 "No account matching those credentials"）。
        const ids = [];
        const push = (v) => { if (v && !ids.includes(v)) ids.push(v); };
        push(SERVER_CREDENTIALS.identifier);            // ← 真正的 Your ID，放第一
        push(SERVER_CREDENTIALS.serverId);              // Link 尾段，备选
        for (const h of (SERVER_CREDENTIALS.hexIds || [])) push(h);
        push(CURRENT_USER.username);

        const pwds = [];
        const pushP = (v) => { if (v && !pwds.includes(v)) pwds.push(v); };
        pushP(SERVER_CREDENTIALS.password);   // Current password
        pushP(CURRENT_USER.password);

        console.log('   >> 候选 ID:', ids.length, '个；候选密码:', pwds.length, '个');

        // --- 定位器 ---
        const userLocators = [
            page.getByRole('textbox', { name: 'Email' }),
            page.getByRole('textbox', { name: /email/i }),
            page.getByRole('textbox', { name: /your id/i }),
            page.getByRole('textbox', { name: /user(name)?/i }),
            page.locator('input[type="email"]'),
            page.locator('input[name*="email" i]'),
            page.locator('input[name*="user" i]'),
            page.locator('input[name*="id" i]'),
            page.locator('form input:not([type="password"])'),
        ];
        const pwdLocators = [
            page.getByRole('textbox', { name: 'Password' }),
            page.getByRole('textbox', { name: /password/i }),
            page.locator('input[type="password"]'),
        ];
        const loginLocators = [
            page.getByRole('button', { name: 'Login', exact: true }),
            page.getByRole('button', { name: /log\s*in/i }),
            page.getByRole('button', { name: /sign\s*in/i }),
            page.locator('input[type="submit"]'),
        ];

        const fillFirst = async (locators, value) => {
            for (const c of locators) {
                try {
                    await c.first().waitFor({ state: 'visible', timeout: 2000 });
                    await c.first().fill(value);
                    return true;
                } catch (e) { /* try next */ }
            }
            return false;
        };

        let loggedIn = false;
        for (const id of ids) {
            if (!id) continue;
            for (const pwd of pwds) {
                if (!pwd) continue;
                console.log('   >> 尝试登录: ID=' + id.slice(0, 8) + '… 密码=' +
                    (pwd === SERVER_CREDENTIALS.password ? '服务器密码' : '账号密码'));

                const userOk = await fillFirst(userLocators, id);
                const pwdOk = await fillFirst(pwdLocators, pwd);
                if (!userOk || !pwdOk) {
                    console.log('   >> 表单定位失败，跳过这组');
                    continue;
                }

                await page.waitForTimeout(400);
                // Turnstile
                for (let a = 0; a < 10; a++) {
                    if (await attemptTurnstileCdp(page)) break;
                    await page.waitForTimeout(1000);
                }
                // 点登录
                for (const b of loginLocators) {
                    try {
                        await b.first().waitFor({ state: 'visible', timeout: 2500 });
                        await b.first().click();
                        break;
                    } catch (e) { /* try next */ }
                }
                await page.waitForTimeout(4500);

                const afterUrl = page.url();
                const afterBody = await page.locator('body').innerText().catch(() => '');
                const ok = !/login|sign ?in/i.test(afterUrl) &&
                    !/^\s*login\s*$/i.test(afterBody.slice(0, 200));
                if (ok) {
                    console.log('   >> ✅ 登录成功，当前地址:', afterUrl);
                    loggedIn = true;
                    break;
                }
                console.log('   >> ❌ 这组凭据被拒绝');
            }
            if (loggedIn) break;
        }

        if (!loggedIn) {
            console.log('   >> ❌ 所有凭据组合都失败了');
            try {
                const b = await page.locator('body').innerText().catch(() => '');
                console.log('   >> 控制面板页面文本:', b.replace(/\s+/g, ' ').slice(0, 400));
            } catch (e2) { /* ignore */ }
        }
        return loggedIn;
    } catch (e) {
        console.log('   >> 控制面板登录处理异常:', e.message);
        try {
            const body = await page.locator('body').innerText().catch(() => '');
            console.log('   >> 控制面板页面文本:', body.replace(/\s+/g, ' ').slice(0, 400));
        } catch (e2) { /* ignore */ }
        return false;
    }
}

/**
 * 登录成功后，确保停在**服务器控制页**上。
 *
 * ⚠️ 实测：登录 control.katabump.com 后会停在根路径 https://control.katabump.com/ ，
 *    那个页面是服务器列表/空页，**没有** Start 按钮。
 *    真正的 Start / Stop / Power 按钮和运行状态在：
 *        https://control.katabump.com/server/<id>     ← 就是 Access server 的 Link
 */
async function gotoServerPage(page) {
    const target = SERVER_CREDENTIALS.link || '';
    if (!target) {
        console.log('   >> ⚠️ 没有 Link，无法定位服务器控制页');
        return page;
    }
    const cur = page.url();
    if (cur.includes('/server/')) {
        console.log('   >> 已在服务器控制页:', cur);
        return page;
    }
    try {
        console.log('   >> 正在进入服务器控制页:', target);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);
        console.log('   >> 当前地址:', page.url());
        // 登录后可能被重定向到根路径 / 服务器列表页
        if (!page.url().includes('/server/')) {
            console.log('   >> 被重定向到服务器列表页，尝试点 "Manage server"...');
            const btn = page.getByText('Manage server', { exact: true }).first();
            const ok = await btn.waitFor({ state: 'visible', timeout: 5000 })
                .then(() => btn.click({ timeout: 8000 }))
                .then(() => true).catch(() => false);
            if (ok) {
                await page.waitForTimeout(4000);
                console.log('   >> 已进入服务器详情页:', page.url());
            } else {
                console.log('   >> ⚠️ 未找到 "Manage server" 按钮');
            }
        }
    } catch (e) {
        console.log('   >> 进入服务器控制页失败:', e.message);
    }
    return page;
}

/**
 * 找并点击启动按钮（在 control.katabump.com 控制面板上）。
 *
 * 实测按钮文案可能是 Start / Power On / Start server / Boot 等，
 * 下面覆盖常见几种，并且用 JS 兜底做模糊匹配。
 */
async function clickStart(page) {
    const candidates = [
        page.getByRole('button', { name: 'Start', exact: true }),
        page.getByRole('button', { name: 'Start Server', exact: true }),
        page.getByRole('button', { name: 'Start server', exact: true }),
        page.getByRole('button', { name: 'Power On', exact: true }),
        page.getByRole('button', { name: 'Power', exact: true }),
        page.getByRole('button', { name: /start/i }),
        page.getByRole('button', { name: /power/i }),
        page.getByRole('link', { name: /start/i }),
        page.getByText(/^start$/i),
        page.getByText(/^start server$/i),
        page.getByText(/^power on$/i),
    ];
    for (const c of candidates) {
        try {
            await c.first().waitFor({ state: 'visible', timeout: 2500 });
            const visible = await c.first().isVisible();
            if (visible) {
                const label = await c.first().innerText().catch(() => '');
                console.log('   >> 找到启动按钮:', (label || '').trim(), '点击中...');
                await c.first().click();
                return true;
            }
        } catch (e) { /* try next */ }
    }

    // 兜底：JS 直接点含 start / power 的按钮
    try {
        const clicked = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('button,a,[role="button"]'));
            const hit = els.find((el) => {
                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                if (!t || t.length > 30) return false;
                if (/\b(delete|renew|cancel|close|save|change|order|buy)\b/.test(t)) return false;
                return /start|power|boot|launch|run/.test(t);
            });
            if (!hit) return false;
            hit.click();
            return true;
        });
        if (clicked) {
            console.log('   >> 找到启动按钮（JS 兜底），点击中...');
            return true;
        }
    } catch (e) { /* ignore */ }

    return false;
}

(async () => {
    const usersRaw = process.env.USERS_JSON;
    if (!usersRaw) {
        console.error('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }
    let users;
    try {
        users = JSON.parse(usersRaw);
    } catch (e) {
        console.error('USERS_JSON 解析失败:', e.message);
        process.exit(1);
    }
    if (!Array.isArray(users) || !users.length) {
        console.error('USERS_JSON 为空');
        process.exit(1);
    }

    // 启动 Chrome（带调试端口，方便 CDP 点击）
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
    } else {
        console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
        // ⚠️ 必须用独立的 user-data-dir，否则和 action_renew.js 抢同一个 profile 会起不来
        const chromeArgs = [
            `--remote-debugging-port=${DEBUG_PORT}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1280,720',
            '--user-data-dir=/tmp/chrome_start_user_data',
            'about:blank',
        ];
        if (PROXY_CONFIG) {
            chromeArgs.push(`--proxy-server=${PROXY_CONFIG.server}`);
            chromeArgs.push('--proxy-bypass-list=<-loopback>');
        }
        const child = spawn(CHROME_PATH, chromeArgs, { stdio: 'ignore', detached: true });
        // ⚠️ 必须接住 'error' 事件：Chrome 路径不存在 / 无执行权限时
        //    spawn 会异步抛 ENOENT，不接住就是未捕获异常直接崩进程，
        //    根本走不到下面的诊断分支（表现为日志莫名其妙中断）。
        child.on('error', (e) => {
            console.error('Chrome 进程启动失败:', e.message);
        });
        child.unref();

        console.log('正在等待 Chrome 初始化...');
        for (let i = 0; i < 40; i++) {
            if (await checkPort(DEBUG_PORT)) break;
            await new Promise((r) => setTimeout(r, 1000));
        }

        if (!await checkPort(DEBUG_PORT)) {
            console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
            try {
                const ver = require('child_process').execSync(
                    `${CHROME_PATH} --version 2>&1 || echo "chrome --version 执行失败"`,
                    { encoding: 'utf8', timeout: 10000 });
                console.error('Chrome 版本:', ver.trim());
            } catch (e) {
                console.error('Chrome 版本查询失败:', e.message);
            }
            try {
                const ps = require('child_process').execSync('ps aux | grep -i chrome | grep -v grep | head -5', { encoding: 'utf8' });
                console.error('Chrome 进程:', ps.trim() || '(无)');
            } catch (e) { /* ignore */ }
            await sendTelegram('❌ *自动启动失败*\n原因: Chrome 无法启动\n请查看 Actions 日志');
            process.exit(1);
        }
    }
    console.log('Chrome 已就绪。');

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    const context = browser.contexts()[0] || (await browser.newContext());
    let page = context.pages()[0] || (await context.newPage());
    await page.addInitScript(INJECTED_SCRIPT);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setExtraHTTPHeaders({ 'Proxy-Authorization': 'Basic ' + Buffer.from(`${PROXY_CONFIG.username}:${PROXY_CONFIG.password}`).toString('base64') });
    }

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    let anyStarted = false;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);
        const safeUser = (user.username || 'user').replace(/[^a-z0-9]/gi, '_');
        // 记下当前账号，控制面板（独立域名）要单独登录时要用
        CURRENT_USER = { username: user.username || '', password: user.password || '' };

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录 ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(1500);
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // 登录前 Turnstile
                let cdpClickResult = false;
                for (let a = 0; a < 15; a++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }
                if (cdpClickResult) {
                    console.log('   >> 登录前 Turnstile 已点击，等待成功标志...');
                    for (let s = 0; s < 10; s++) {
                        if (await isTurnstilePassed(page)) {
                            console.log('   >> 登录前 Turnstile 验证成功。');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                }

                await page.getByRole('button', { name: 'Login', exact: true }).click();
                await page.waitForTimeout(3000);

                try {
                    const errMsg = page.getByText('Incorrect password or no account');
                    if (await errMsg.isVisible({ timeout: 3000 })) {
                        console.error('   >> ❌ 登录失败: 账号或密码错误');
                        await sendTelegram(`❌ *自动启动失败*\n用户: ${user.username}\n原因: 账号或密码错误`);
                        continue;
                    }
                } catch (e) { /* ignore */ }
            } catch (e) {
                console.log('登录错误:', e.message);
            }

            // --- 进入服务器页 ---
            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
                await page.waitForTimeout(3000);
            } catch (e) {
                console.log('未找到 "See" 按钮。');
                await sendTelegram(`⚠️ *自动启动跳过*\n用户: ${user.username}\n原因: 未找到服务器入口`);
                continue;
            }

            // --- 切到 Access server 标签页，拿控制面板地址和服务器密码 ---
            await switchToAccessServerTab(page);

            // ⚠️ 必须在跳转之前读！Current password 只在这个标签页上有
            SERVER_CREDENTIALS = await readServerCredentials(page);
            console.log('   >> 服务器凭据:',
                'identifier=' + (SERVER_CREDENTIALS.identifier || '(未读到)'),
                'serverId=' + (SERVER_CREDENTIALS.serverId || '(未读到)'),
                'password=' + (SERVER_CREDENTIALS.password ? '(已读到)' : '(未读到)'),
                'link=' + (SERVER_CREDENTIALS.link ? '(已读到)' : '(未读到)'));

            // 诊断：把页面上所有可见行 + input 值 dump 出来，
            // 这样一眼就能看出哪个字段被读错了
            try {
                const raw = await page.evaluate(() => {
                    const lines = (document.body.innerText || '')
                        .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 40);
                    const inputs = Array.from(document.querySelectorAll('input'))
                        .map((el, i) => `#${i} name="${el.name || ''}" id="${el.id || ''}" ` +
                            `aria="${el.getAttribute('aria-label') || ''}" value="${(el.value || '').slice(0, 60)}"`)
                        .slice(0, 20);
                    return { lines, inputs };
                });
                console.log('   >> [诊断] 页面可见行:', JSON.stringify(raw.lines));
                console.log('   >> [诊断] input 元素:', JSON.stringify(raw.inputs, null, 1));
            } catch (e) { /* ignore */ }

            // --- 跳到真正的控制面板（Start/Stop 按钮和状态都在那边）---
            // ⚠️ 它会返回「真正要操作的 page」—— "Go to server" 是在新标签页打开的，
            //    如果还用原来的 dashboard page，后续所有操作都作用在错的页面上。
            const ctrlPage = await gotoControlPanel(page);
            if (ctrlPage && ctrlPage !== page) {
                page = ctrlPage;
                await page.addInitScript(INJECTED_SCRIPT).catch(() => {});
            }
            const loginOk = await ensureControlLogin(page);
            if (loginOk) {
                // ⚠️ 登录后会停在 control.katabump.com 根路径，那里没有 Start 按钮。
                //    必须进到服务器控制页 /server/<id> 才能看到启动控件。
                await gotoServerPage(page);
            }

            // --- 读状态 ---
            let status = await readServerStatus(page);
            console.log('   >> 当前地址:', page.url());
            console.log('   >> 当前状态:', status);

            if (status === 'running') {
                console.log('   >> ✅ 服务器已在运行，无需启动。');
                const shotPath = path.join(photoDir, `${safeUser}_already_running.png`);
                try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { /* ignore */ }
                await sendTelegram(`ℹ️ *服务器已在运行*\n用户: ${user.username}\n无需启动`, shotPath);
                continue;
            }

            if (DRY_RUN) {
                console.log('   >> DRY_RUN，跳过点击。');
                continue;
            }

            // --- 点 Start ---
            const clicked = await clickStart(page);
            if (!clicked) {
                console.log('   >> ❌ 未找到启动按钮。');
                const shotPath = path.join(photoDir, `${safeUser}_no_start_btn.png`);
                try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { /* ignore */ }
                // 把页面上所有按钮/链接的文案 dump 出来，方便定位
                try {
                    const btns = await page.evaluate(() => Array.from(
                        document.querySelectorAll('button,a[role="button"],input[type="submit"],input[type="button"]'))
                        .map((e) => ((e.innerText || e.value || e.textContent || '').trim() +
                                    (e.disabled ? ' [disabled]' : '')))
                        .filter((t) => t && t.length < 40));
                    console.log('   >> 页面上可见的按钮/链接:', JSON.stringify(btns));
                } catch (e) { /* ignore */ }
                await sendTelegram(`⚠️ *自动启动未找到按钮*\n用户: ${user.username}\n状态: ${status}`, shotPath);
                continue;
            }

            // --- 等待变为 running ---
            let finalStatus = status;
            for (let w = 0; w < 24; w++) {
                await page.waitForTimeout(5000);
                try {
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(2500);
                    // 万一被重定向回 dashboard，重新走一遍到控制面板的流程
                    if (!page.url().includes('control.katabump.com')) {
                        console.log('   >> 被重定向了，重新进入控制面板...');
                        await switchToAccessServerTab(page);
                        SERVER_CREDENTIALS = await readServerCredentials(page);
                        const back = await gotoControlPanel(page);
                        if (back && back !== page) page = back;
                        if (await ensureControlLogin(page)) {
                            await gotoServerPage(page);
                        }
                    } else if (!page.url().includes('/server/')) {
                        // 掉回根路径了，也要重新进服务器控制页
                        await gotoServerPage(page);
                    }
                } catch (e) { /* ignore */ }
                finalStatus = await readServerStatus(page);
                console.log(`   >> 等待中... 状态: ${finalStatus}`);
                if (finalStatus === 'running') break;
            }

            const shotPath = path.join(photoDir, `${safeUser}_start_${finalStatus}.png`);
            try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { /* ignore */ }

            if (finalStatus === 'running') {
                anyStarted = true;
                console.log('   >> ✅ 启动成功！');
                await sendTelegram(`✅ *自动启动成功*\n用户: ${user.username}\n服务器已上线`, shotPath);
            } else {
                console.log(`   >> ⚠️ 点击后状态仍为 ${finalStatus}`);
                await sendTelegram(`⚠️ *自动启动未确认*\n用户: ${user.username}\n状态: ${finalStatus}`, shotPath);
            }
        } catch (err) {
            console.error('处理用户时出错:', err);
        }
    }

    console.log('\n完成。');
    await browser.close();
    process.exit(anyStarted || !DRY_RUN ? 0 : 0);
})();
