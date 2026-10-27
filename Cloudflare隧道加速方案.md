# Cloudflare 隧道加速方案（2026-10-26 新增 · 2026-10-27 实测跑通）

> 一句话：把流量终点从「法国 OVH 直连」换成「Cloudflare 边缘 + 骨干网回源」，
> 绕开那条**会周期性波动**的跨境线路。
>
> **✅ 2026-10-27 状态：quick 隧道已端到端跑通并实测有效（1.75×）。**
> 只差你提供 Cloudflare 账号 + 托管域名，就能切成固定域名的正式隧道。

---

## 零、实测结论速览（2026-10-27）

用 mihomo（实际客户端）加载容器自动生成的订阅，实测结果：

| 节点 | mihomo 延迟 | 单流下载速度 | 有效 |
|---|---|---|---|
| KataBump-20330（直连 REALITY） | 242 ms | 1791 KB/s | 3/4 |
| **CF-Tunnel（走 CF 隧道）** | 326 ms | **3135 KB/s** | 3/4 |

→ **1.75× 提速**（xray 客户端单独测得 1.41×）

**但真正重要的发现是这条线路会自己恢复：**

| 时间 | 直连 CF 天花板 | 经节点单流 |
|---|---|---|
| 10-26 晚 | 1016 KB/s | 13 KB/s |
| 10-27 早 | **18780 KB/s** | 1512 KB/s |

→ 所以这个方案的价值是 **「绕开波动，始终走 CF 骨干网」**，
不是「把 13 KB/s 变成 5000 KB/s」。线路好时差距不大，线路差时差距是致命的。

---

## 一、先看证据：为什么这条线路卡

2026-10-26 实测（同一台机器、同一时刻、同样下载 6MB × 5 次）：

| 路径 | 每次下载速度 | 趋势 |
|---|---|---|
| 直连 Cloudflare 边缘 | 235 → 446 → 686 → 830 → **1016 KB/s** | 持续上升（拥塞窗口正常扩张） |
| 经 KataBump 节点（法国 OVH） | 17 → 16 → 13 → 17 → **13 KB/s** | 从第一秒就被钳死，永远长不大 |

补充对照：

- **TCP 握手成功率**：节点 60/60，Cloudflare 60/60（都是 100%，链路没断）
- **TCP p50 RTT**：节点 248ms，Cloudflare **183ms**（CF 反而更低）
- **多连接叠加**：同一节点 16 条独立连接 → 343 KB/s（14 倍）

**结论**：不是「国内出国慢」，是「国内 → 法国 OVH 这一段」的拥塞窗口被限制。
所以只要把流量终点换成 CF 边缘，再由 CF 骨干网回源到这台机器，就能绕开它。

> ⚠️ 早期文档里写的「11% 丢包」是 ICMP ping 测出来的数字，
> 跨境链路上 ICMP 被普遍限速/丢弃，那个数字偏大。
> 准确表述是：**单流 TCP 的拥塞窗口从一开始就被掐死**（症状一致，
> 但不必归因到具体的丢包率）。
>
> ⚠️⚠️ **2026-10-27 再修正**：上面「13 KB/s」这个读数**本身被测速脚本放大了**。
> 昨晚的脚本有两个 bug（计时起点算上了 SOCKS 握手 + 缓冲区丢字节），
> 用修正版函数重测，旧函数低 **2.2×**。详见 `以后怎么用.md` 3.1①。
>
> 但**结论方向不变** —— 用户当时实际感受到的「连 300KB 都没有」是真的，
> 而且这条线路确实存在明显的**时段性波动**（同一脚本，昨晚 13 KB/s / 今晚 1512 KB/s）。

---

## 二、方案形态：为什么是 cloudflared 而不是 Workers

有两条技术路线，都可行但差别很大：

### 路线 A：Cloudflare Worker（`cloudflare:sockets`）—— **不推荐**

Worker 里用 `connect()` 出站裸 TCP，再包一层 WebSocket 隧道。

**硬伤（官方文档确认）：**

| 限制 | 数值 | 影响 |
|---|---|---|
| Free 套餐每请求 CPU 时间 | **10 ms** | 高吞吐场景必然超限，直接 `Error 1102` |
| 同时等待响应头的出站连接 | **6**（Free 和 Paid 都是 6） | 多连接叠加收益被掐死 |
| 禁止出站到 CF 自己的 IP 段 | — | 落地端不能是 CF 站点 |

10ms CPU 这个限制对「持续中转大流量」是致命的。而且要按 CPU 时间算账，
不是墙钟时间。

### 路线 B：cloudflared 跑在 KataBump 容器里 —— ✅ **本项目采用**

```
你的手机/电脑
      │  VLESS over WebSocket + TLS
      ▼
Cloudflare 边缘（实测健康：p50 183ms，单流 1016 KB/s）
      │  CF 骨干网（全球高速，不经过那条坏线路）
      ▼
cloudflared（跑在 KataBump 容器里）
      │  本机回环 127.0.0.1:20399
      ▼
xray（VLESS + WS inbound）
      │
      ▼
  目标网站
```

**优点：**

- **不消耗任何 Workers 额度**（跟 Workers 完全无关）
- **不需要新的外网端口**：cloudflared 连的是容器内的回环端口。
  KataBump 只给了 1 个 allocation（20330）且无法自助增加 —— 这条路绕开了这个限制
- **CF 骨干网是全球高速链路**，回源质量远好于「国内 → 法国 OVH」直连
- **cloudflared 掉线自动重连**（守护进程已内置）

**缺点：**

- 客户端要新增一个 `ws` 传输的 VLESS 节点（现有 reality 节点保留，作为兜底）
- 需要你在 Cloudflare 有一个**托管在该账号下的域名**（用来配 Public Hostname）

---

## 三、部署步骤（你需要做的部分）

### 步骤 1 · 在 Cloudflare 后台建 Tunnel

1. 登录 Cloudflare → 左侧 **Zero Trust** → **Networks** → **Tunnels**
2. 点 **Create a tunnel** → 选 **Cloudflared** → 起个名（比如 `katabump`）
3. 选运行环境 → 页面会显示一条安装命令，**里面包含 `tunnel token`**
   —— 把那段 token 复制下来（形如 `eyJhIjoi...` 的长串）

### 步骤 2 · 把 token 写进容器里的 `cf-config.json`

> ⚠️ **实测更正（2026-10-26）**：KataBump 的 **Startup 页没有自定义环境变量入口**。
> 页面 Variables 区只有平台预定义的两个 egg 变量：
> ```json
> [{"name":"Additional Node packages","env_variable":"NODE_PACKAGES","is_editable":true},
>  {"name":"JS file","env_variable":"BOT_JS_FILE","default_value":"index.js","is_editable":true}]
> ```
> 后端 `GET /api/client/servers/{uuid}/egg` 直接 **404 NotFoundHttpException**，
> 说明该功能被平台限制了。**所以走配置文件方案。**

好消息是：**`.json` 文件可以用 Files API 直接写**（原始 body 即可，见 `以后怎么用.md` 11.5），
不用碰 index.js，改完重启就生效。

**做法：** KataBump 面板 → 服务器 → **Files** 页 → 新建文件 `cf-config.json`，内容填：

```json
{
  "mode": "token",
  "tunnel_token": "eyJhIjoi...（步骤 1 复制的 token）",
  "hostname": "vpn.example.com",
  "path": "/vless",
  "local_port": 20399
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `mode` | ✅ | `"token"`（正式隧道）或 `"quick"`（临时隧道，见 6.1） |
| `tunnel_token` | token 模式必填 | Cloudflare 后台复制的 token |
| `hostname` | token 模式必填 | 你要用的域名，如 `vpn.example.com`，**必须托管在 Cloudflare** |
| `path` | 选填 | WebSocket 路径，默认 `/vless`，两边要一致 |
| `local_port` | 选填 | 容器内回环端口，默认 `20399`，只要不被占用 |

**用 API 写（推荐，快）** —— body 传原始 JSON 文本，不要包 `content`：

```javascript
await fetch(`/api/client/servers/${uuid}/files/write?file=${encodeURIComponent('/cf-config.json')}`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf },
  body: JSON.stringify({
    mode: 'token',
    tunnel_token: 'eyJhIjoi...',
    hostname: 'vpn.example.com',
    path: '/vless'
  })
});
// → 期望 204
```

**验证写对了**（读回逐字节比对）：

```javascript
const raw = await fetch(`/api/client/servers/${uuid}/files/contents?file=${encodeURIComponent('/cf-config.json')}`,
  { credentials:'include', headers:{'Accept':'application/json','X-XSRF-TOKEN':csrf} });
console.log(await raw.text());
// 期望看到 {"mode":"token","tunnel_token":"..."} 而不是 {"content":"..."}
```

> 💡 `index.js` 里也支持环境变量 `CF_TUNNEL_TOKEN` / `CF_HOSTNAME`，
> 优先级高于文件配置；两个都配的话以环境变量为准。平台不支持环境变量时用文件即可。

### 步骤 3 · 在 Cloudflare 后台配 Public Hostname

回到 **Tunnels → 你刚建的 tunnel → Configure → Public Hostnames**，
点 **Add a public hostname**：

| 字段 | 填什么 |
|---|---|
| Subdomain | `vpn`（或任意） |
| Domain | 选你托管在 CF 的域名 |
| Path | 留空 |
| Type | `HTTP` |
| URL | `localhost:20399` |

保存后 Cloudflare 会自动给你创建一条 DNS 记录（`vpn.example.com` → 隧道）。

> ⚠️ **URL 必须是 `localhost:20399`，不能带 `https://`**。
> Cloudflare 边缘到源站这一段是 CF 内部网络，TLS 终止在边缘。

### 步骤 4 · 重启容器

KataBump 面板 → 服务器 → **Stop** → 等 15 秒 → **Start**。
（用面板按钮即可；注意这里的 Restart 按钮有坑，见 `以后怎么用.md` 坑 11）

容器启动后会自动：

1. 下载 `cloudflared` 二进制（约 40MB）
2. 用 token 连上你的隧道
3. 生成 `config.json`（多一个 WS inbound）+ `node-info.json`（多一个 `cf` 段）
4. 重新生成 `clash.yaml` / `sub.txt`

### 步骤 5 · 刷新订阅

GitHub Actions 里手动 dispatch 一次 `renew` workflow，或者本地跑：

```bash
node fetch_subscription.js
```

订阅里会多出一个 `CF-Tunnel` 节点。

---

## 四、怎么验证成功了

### 在容器里看

KataBump 面板 → 服务器 → **Console**，应该能看到：

```
[katabump] cloudflared 已启动，pid=xxx
```

以及 Cloudflare 后台 Tunnels 页面的 **Status** 显示 **Connected**。

### 看日志

```bash
# 容器内
cat /home/container/cloudflared.log
```

正常会看到类似：

```
2026-10-26T15:30:00Z INF Connection registered connIndex=0
2026-10-26T15:30:00Z INF Connection registered connIndex=1
```

如果看到 `Registered tunnel connection` 但客户端连不上，多半是 **Path 不一致**
（`CF_WS_PATH` 和 Cloudflare 后台 Public Hostname 的 Path 要对上）。

### 客户端测速

```bash
# 测 CF 节点速度（注意：mihomo 必须用 mode: rule，否则会走 DIRECT 假阳性）
mihomo -f clash.yaml &
curl -x socks5://127.0.0.1:7890 -o /dev/null -w '%{speed_download}\n' \
  --max-time 30 http://speed.cloudflare.com/__down?bytes=10000000
```

**同时检查 `/connections` 的 `chains` 字段**，确认流量真的走了 `CF-Tunnel`：

```bash
curl -s http://127.0.0.1:9090/connections | grep -o '"chains":\[[^]]*\]'
```

应该看到 `"chains":["CF-Tunnel"]`，而不是 `["DIRECT"]`。

> ⚠️ **测速铁律 1**：`mode: global` 会忽略 `rules:`，全部走 GLOBAL 组里的
> DIRECT，测出来是「几千 KB/s」的假阳性。必须 `mode: rule` + `rules: [MATCH,节点选择]`。
> 详见 `以后怎么用.md` 坑 12。

> ⚠️ **测速铁律 2（2026-10-27 新增）**：**连续打同一个测速源会被限流**。
> 本次验证中连续 4 次 `timeout`，换成 `proof.ovh.net` 后立刻正常。
> **每次换源 + 冷却 5 秒**，失败要重试一次再下结论。
>
> ⚠️ **测速铁律 3**：计时必须**从 HTTP 响应头结束开始**，精确扣掉响应头，
> 并校验实收字节数 == 请求字节数。
> 昨晚那批脚本因为这两个问题把读数压低了 2.2×。
> 正确实现见 `本地工具/verify_speed_truth.js`。

> ⚠️ **测速铁律 4**：测速前 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY`。
> 本机有系统代理环境变量，不清掉会让流量绕一圈。

---

## 五、常见问题

### Q1：能不能直接用 Cloudflare 橙云代理（不改客户端）？

**不能。** 原因：

- KataBump 只给了 1 个 allocation（`147.135.213.131:20330`），端口改不了
- 面板明确显示 `You are currently using 1 of 1 allowed allocations`
- `POST /api/client/servers/{uuid}/allocations` 返回 **404**（路由不存在），无法自助增加
- 橙云代理要求源站监听 **443**，而这里是 20330

所以只能走隧道形态，客户端必然要新增一个 ws 节点。

### Q2：现有 reality 节点要删掉吗？

**不要删。** 新旧节点并存：

- `CF-Tunnel` 走 CF 骨干网，正常情况下更快
- `KataBump-20330` 直连，作为 CF 故障时的兜底

订阅里的「自动测速」组会优先挑快的。

### Q3：CF 会不会限速/封号？

- Cloudflare Tunnel 免费版没有流量配额限制（Workers 才有 10 万次/天，但那是 Workers，隧道不涉及）
- 但 CF 有反滥用政策，**不要用它跑 BT/大流量爬虫**。
  本项目的 xray 配置里已经 block 掉 bittorrent 协议了。

### Q4：为什么容器里能跑 cloudflared？

KataBump 容器是完整 Linux 容器（Node.js 26），有出网能力，
`cloudflared` 是静态编译的单个二进制，无额外依赖，直接下载就能跑。

实测容器资源占用：
- 内存：35 MB / 371 MB 上限
- CPU：空闲时 0.00%，峰值 0.3%（上限 25%）
- 磁盘：70 MB / 716 MB

完全无压力。

### Q5：容器重启后 tunnel UUID 会变吗？

**不会。** 隧道 UUID 存在 `node-info.json` 里，重启时复用。
所以订阅里的 CF 节点 UUID 保持稳定。

（只有显式 `--reset` 才会重置。）

### Q6：为什么 cloudflared 二进制下载成功了，但隧道没起来？（2026-10-27 实战踩坑）

**症状**：`cloudflared` 二进制在文件列表里（38.4 MB），
但 `cloudflared.log` 和 `cloudflared.pid` **都不存在** —— 说明 `startCloudflared()` 从没执行。

**根因**：`supervise()` 里引用了 `info`，但 `info` 只是 `main()` 的局部变量，
`supervise` 作用域里根本没有它：

```javascript
// ❌ 错误：info 在这里不可见
async function supervise(xray, confPath, cf) {
  ...
  await superviseCloudflared(bin, info, onReady);   // ReferenceError: info is not defined
}

// ✅ 正确：把 info 作为参数传进去
async function supervise(xray, confPath, cf, info) { ... }
```

`ReferenceError` 被外层 `catch` 吞掉，只在 stdout 打了一行日志
（KataBump 面板看不到 stdout，就完全静默了）。

**排查方法**（下次遇到类似静默失败直接用）：

| 步骤 | 命令 | 作用 |
|---|---|---|
| 1 | `GET /api/client/servers/{uuid}/files/list` | 看哪些文件生成了、哪些没有 |
| 2 | `GET .../files/contents?file=/xxx.log` | 读容器里的日志文件 |
| 3 | 看 `node-info.json` 的 `cf` 段 | 判断逻辑跑到哪一步 |

**核心经验**：`index.js` 的日志只走 stdout，容器里看不到。
**任何关键状态都必须落盘成文件**，否则静默失败无法排查。

### Q7：Files API 写 `.json` 为什么可以直接传原始 body？

2026-10-27 实测结论（推翻更早的过度泛化）：

| 文件类型 | `files/write` 传原始 body | 传 `{"content":"..."}` |
|---|---|---|
| `.json` | ✅ **正确**（204，读回逐字节一致） | ❌ 磁盘上变成 `{"content":"..."}` |
| `.js` | ❌ **400 Bad Request** | ❌ 磁盘上变成 `{"content":"..."}` |

→ **`.json` 配置用 API 直接写（原始 body），`.js` 必须走 CodeMirror。**
详见 `以后怎么用.md` 11.5。

---

## 六、备用方案

### 6.1 quick 模式：不用账号、不用域名，先验证链路通不通

**这是最省事的验证方式**，不需要 Cloudflare 账号、不需要托管域名。
**2026-10-27 已用它跑通完整链路并实测有效（1.75×）。**

`cf-config.json` 填：

```json
{
  "mode": "quick",
  "path": "/vless"
}
```

容器启动后 cloudflared 会开一条**临时隧道**，随机分配一个域名，形如
`xxxxx-yyyy-zzz.trycloudflare.com`。

- 这个域名会**自动写回** `node-info.json` 的 `cf.hostname` 字段，
  并触发订阅重新生成 → 订阅里出现 `CF-Tunnel` 节点
- **容器每次重启域名都会变**（所以只能用来验证，正式用要走 token 模式）
- 域名从容器日志里取：

```javascript
// cloudflared.log 里的这一行
// 2026-10-26T15:40:00Z INF |  https://abcdefg-hijkl.trycloudflare.com
```

**注意 quick 模式的两点限制：**

1. 随机域名 → 订阅里的服务器地址每次重启都变，客户端要重新拉订阅
2. trycloudflare.com 属于 Cloudflare 公共快速隧道，**只支持 HTTP/HTTPS**，
   适合我们这种 WS 走 HTTP 升级的场景；但它没有 SLA，也不适合长期使用

**实测的容器内状态（2026-10-27）：**

| 文件 | 大小 | 说明 |
|---|---|---|
| `cloudflared` | 40,247,428 B | 二进制（可执行权限正常） |
| `cloudflared.log` | 5,517 B | 运行日志 |
| `cloudflared.pid` | 3 B | 进程号 |
| `cloudflared-download.log` | 390 B | 下载过程（含 302 跳转记录） |
| `cf-config.json` | 32 B | 配置文件 |

`cloudflared.log` 里的健康检查（全部 PASS）：

```
DNS Resolution    region1.v2.argotunnel.com  PASS
UDP Connectivity  region1.v2.argotunnel.com  PASS  QUIC connection successful
TCP Connectivity  region1.v2.argotunnel.com  PASS  HTTP/2 connection successful
Cloudflare API    api.cloudflare.com:443     PASS
SUMMARY: Environment is healthy. cloudflared will use 'quic' as primary protocol.
Registered tunnel connection connIndex=0 location=cdg09 protocol=quic
```

**一键开启 quick 模式（API 方式）**：

```javascript
await fetch(`/api/client/servers/${uuid}/files/write?file=${encodeURIComponent('/cf-config.json')}`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrf },
  body: JSON.stringify({ mode: 'quick', path: '/vless' })
});
// → 期望 204
```

然后用 power API 重启容器：

```javascript
await fetch(`/api/client/servers/${uuid}/power`, {
  method:'POST', credentials:'include',
  headers:{'Content-Type':'application/json','X-XSRF-TOKEN':csrf},
  body: JSON.stringify({ signal: 'stop' })
});
// 等 15 秒，再 { signal: 'start' }
```

> ⚠️ 面板的 **Restart** 按钮不真正重启（uptime/config.json 时间戳不变），
> 必须用 power API。见 `以后怎么用.md` 坑 11。

### 6.2 在 `index.js` 里写死 token（不推荐，但可行）

如果连 Files 页都写不了，可以直接在 `交付/index.js` 顶部找到这几行，替换成实际值：

```javascript
const CF_TUNNEL_TOKEN = 'eyJhIjoi...你的token...';
const CF_HOSTNAME = 'vpn.example.com';
```

改完后按 `以后怎么用.md` 第 11.6 节的 CodeMirror 方式保存，
然后用 power API 重启容器。

> ⚠️ 这样 token 会明文存在 `index.js` 里。
> `index.js` 可以通过面板 Files 页读到 anyone，所以安全性一般。
> 但这个 token 只授权一条隧道到你自己的机器，实际风险有限。
> 隧道跑起来后可以随时在 Cloudflare 后台轮换 token。

---

## 七、一键回滚

如果 CF 方案有问题（不影响现有 reality 节点）：

1. KataBump 面板 → **Files** → 把 `cf-config.json` 内容改成 `{}`（或直接删掉这个文件）
2. Stop → Start 容器
3. 刷新订阅

`index.js` 会自动跳过隧道逻辑（`CF_MODE` 判定为 `'off'` → `CF_ENABLED = false`），
恢复成原来只有 reality 节点的状态。

> 结论：**CF 节点是纯增量的**，原有 reality 节点一直保留、一直可用，
> 随时可以关掉隧道而没有任何副作用。

---

## 八、附：技术细节

### xray 的 WS inbound 配置

```json
{
  "listen": "127.0.0.1",
  "port": 20399,
  "protocol": "vless",
  "settings": { "clients": [{ "id": "<隧道专用UUID>" }], "decryption": "none" },
  "streamSettings": {
    "network": "ws",
    "security": "none",
    "wsSettings": { "path": "/vless" }
  }
}
```

**只绑 `127.0.0.1`** —— 不对外暴露，外部无法直接访问这个端口，
安全性等价于「只有 cloudflared 能连」。

### cloudflared 启动命令

```
cloudflared tunnel --no-autoupdate run --token <TOKEN>
```

用 token 模式而不是配置文件模式 —— tunnel 的 ingress 规则全在 Cloudflare 后台，
容器本地不需要任何配置文件。守护逻辑在 `index.js` 的 `superviseCloudflared()` 里，
掉线 5 秒后自动重连。

### 客户端节点参数

| 项 | 值 |
|---|---|
| 协议 | VLESS |
| 传输 | WebSocket |
| 加密 | TLS |
| 端口 | 443 |
| servername / Host | 你的 CF 域名 |
| path | `/vless` |

分享链接示例：

```
vless://<隧道UUID>@vpn.example.com:443?encryption=none&security=tls&type=ws&host=vpn.example.com&path=%2Fvless&sni=vpn.example.com&fp=chrome#CF-Tunnel
```
