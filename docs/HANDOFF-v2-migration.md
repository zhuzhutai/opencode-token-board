# OpenCode v2 迁移 · 交接班文档

> 插件：opencode-token-board ｜ 目标：从 OpenCode v1 插件 API 迁移到 v2
> 起始版本：0.2.0（v1 API）→ 目标 1.0.0（v2 API，破坏性变更）
> 本机环境：OpenCode CLI **v2.0.29** ｜ Node v22.23.2 ｜ Windows

---

## 阶段总览与状态

| 阶段 | 内容 | 状态 | 产出 |
|------|------|------|------|
| 0 | 实测探针（DB/SDK/事件/槽位） | ✅ 完成 | 本文件「阶段 0 结论」 |
| 1 | 依赖升级 + 入口骨架（Plugin.define） | ✅ 完成 | package.json / server.ts / tui.tsx / build.tui.mjs |
| 2 | 存储适配层（kv → storage） | ✅ 完成 | src/storage.ts / src/types.ts |
| 3 | 侧边栏迁移（slot + 数据源 + theme） | ✅ 完成 | sidebar.tsx / mapper.ts / perf-tracker.ts（重构） |
| 4 | 命令与 Dialog（keymap + dialog） | ✅ 完成 | commands.tsx（Promise 化） |
| 5 | 通知与权限拆除（attention + 删 notify） | ✅ 完成 | 删 notify.ts + 弹窗脚本；i18n 清理 |
| 6 | 报告数据源（SQLite 直连） | ✅ 完成 | db.ts（新）/ queries.ts（重写，v2 schema） |
| 7 | 全量增强（panel/router/status bar） | 🟡 已实现待 TUI 验收 | enhancements.tsx（新） |
| 8 | 验收与发布 | 🟡 部分完成 | 类型/构建/数据/加载已验证；TUI 实测 + npm 发布待做 |

**核心迁移（阶段 1-6）已全部完成并通过自动化验证。** 阶段 7 增强与阶段 8 的 TUI 实测/发布为遗留项。

---

## 执行记录（2026-10-15）

### 已完成并验证
- **类型**：`npx tsc --noEmit` 零错误
- **构建**：`npm run build` 成功 → `dist/server.js`(187b) + `dist/tui.js`(136kb)
- **数据层**：`scripts/test-queries.ts` 打包后 node 执行 **ALL TESTS PASSED**（真实 DB：6082 请求 / 1.0B token / 9 模型 / 16 天 / total=分量和 / perf TTFT/TPS/命中率 / mapper 过滤）
- **加载层**：临时探针（`.opencode/plugins/probe.ts` + dist/server.js 抛错）实测 v2 加载链路 —— 日志出现
  `loading plugin .../probe.ts` + `failed to load plugin plugin.id=opencode-token-board cause="...setup ran"`，
  **确认 `Plugin.define({id, setup})` 导出形状被 v2 接受且 setup 执行**。

### 关键决策
- 数据采集：`ctx.data.session.message.list(sessionID)` 为**唯一事实源**，事件（`session.step.ended`/`step.streamed`/`usage.updated`/`execution.succeeded`/`idle`）只触发去抖同步 + 重算；性能指标从消息 `time.{created,streamed,completed}` 直接算（不再跨事件追踪首 part）。
- 报告数据源：`opencode db` 已删 → SQLite 直连（`db.ts`：优先 `bun:sqlite`，回退 `node:sqlite`，`new Function` 动态导入绕过 TS 静态解析）；只查 v2 表 `session_message`/`session_v2`（实测含全部 v1 迁移历史，0 缺失，无需 UNION）。
- 配置：`ctx.storage.store` 响应式 Store 替代 `api.kv` + 500ms 轮询（轮询已删）。

### 遗留（未做）
1. **阶段 7 全量增强**：✅ 已实现（`src/enhancements.tsx`：① `sidebar.footer` 状态条 ② `session.panel` 全屏统计面板 ③ `ui.router` 仪表盘路由；`/usage` 菜单新增「统计面板」「仪表盘」入口），**待 TUI 验收**。
2. **TUI 实测**：侧边栏渲染、`/usage` 菜单交互、theme 配色、宽度 38/36 布局假设、@opentui 0.6 组件兼容 —— 需开 TUI 人工验证（headless 无法测渲染）。
3. **npm 发布**：package.json 版本已设 1.0.0，但未执行 `npm publish`。
4. **全局配置本地路径不加载**：实测全局 `plugins: ["file:///D:/..."]` 启动时不加载；`.opencode/plugins/` 可靠加载（项目级）；npm 包名从 `~/.cache/opencode/npm/` 缓存加载。

### 本地测试方法（不发布 npm 即可全局测试）✅ 已验证
v2 从 **`~/.cache/opencode/npm/opencode-token-board@latest/<时间戳>/node_modules/opencode-token-board/`** 加载 npm 包插件（**不是**旧 README 说的 `packages/`）。
把本地构建注入该目录，全局 `plugins: ["opencode-token-board"]`（npm 名）即加载新版本：
```powershell
$src = "D:\AndroidPr\opencode-token-board"
$pkgDir = "$env:USERPROFILE\.cache\opencode\npm\opencode-token-board@latest\1791679223909\node_modules\opencode-token-board"
Copy-Item "$src\package.json" $pkgDir -Force
Remove-Item "$pkgDir\dist" -Recurse -Force
Copy-Item "$src\dist" "$pkgDir\dist" -Recurse -Force
# 重启服务后生效
opencode service restart
```
注入后日志出现 `loading plugin .../dist/server.js` 且**无** `failed to load` WARN = 干净加载。
（时间戳子目录可能随重新拉取变化；`@opentui/*`/`solid-js`/`@opencode/plugin` 由宿主运行时提供，无需在缓存装依赖。）

### Go 用量改用官方 API（2026-10-15 追加）
- **发现**：`GET https://opencode.ai/inference/go/v1/usage` + `Authorization: Bearer <OpenCode OAuth access token>` 返回与网页一致的三桶数据（rolling/weekly/monthly 百分比 + resetsAt）。OAuth token 与 Go key 均实测 200。
- **凭证来源**：插件用 `context.client.credential.list()` 取 `integrationID==="opencode"` 的 active OAuth 凭证 `.value.access`（opencode 自管 + 自动刷新）；零手填配置。（`opencode-go` 集成 `connections:[]`，插件 API 拿不到，故用 `opencode` 的 OAuth，实测它也能调该端点。）
- **旧方案已死**：v1 抓页面（RPC `lite.subscription.get` + SSR 解析）在 v2 失效——实测 `/workspace/{id}/go` 返回空壳、无 SSR 数据。
- **实现**：重写 `go-usage.ts`（删 3 种抓取法 → 单次 GET + token 解析器注入）；`tui.tsx` 注入 `makeGoTokenResolver`；删手填 Go 配置 UI（commands.tsx）与 `SidebarConfig.go` 字段；sidebar `goConfigured()` 改为「有数据即显示」。
- **验证**：`scripts/test-go-usage.ts` 端到端 ALL PASSED（rolling 10%/292s、weekly 4%、monthly 2%）。

### 踩坑记录
- **v1 插件配置迁移缺口**：v1 的 `api.kv`（Go 配置 / 侧边栏开关 / 语言）在 v1→v2 迁移中**不会自动带入** v2 `ctx.storage.store`（实测 v2 kv 表仅 3 个系统键，无 v1 插件数据；`~/.opencode/` 仅有 perf 数据文件）。用户需经 `/usage → 设置` 重新配置。perf 数据（tokenwatch.jsonl/stats.json）与报告不受影响。
- **状态条冗余**：阶段 7 的 `sidebar.footer` 状态条与侧边栏面板顶部「四项总计」重复，已按用户要求删除；保留全屏面板 + 仪表盘。
- **PowerShell `Set-Content` 用系统 ANSI 编码损坏 UTF-8**：对含中文/箭头的源文件用 `-replace ... Set-Content` 会把 `→` 等多字节字符变 `�?`。已用 write 工具重写受影响文件（commands/sidebar/storage/tui/server）修复。**后续改 UTF-8 源文件一律用 write/edit 工具，禁用 PowerShell Set-Content。**
- `Context` 类型需从子路径 `@opencode/plugin/tui/context` 导入（index 只导出 `Plugin` 命名空间）。
- `session.message.content.updated` 事件不在 `data.on` 联合里 → 改用 `session.step.streamed`。
- @opentui/solid@0.6.6 要求 solid-js 精确 1.9.12（peer 冲突已钉死）；`@opentui/keymap` 未使用已删。

---

## 需求边界（已定稿）

**In Scope**
- 仅支持 OpenCode V2（本机 2.0.29）；不做 v1/MiMoCode 双兼容
- 等价迁移：侧边栏面板 / `/usage` 菜单 / 报告导出 / 性能追踪 / Go 余额 / i18n
- session.idle 提醒改用 v2 原生 `attention.notify`
- 报告数据源按阶段 0 结论走 sqlite 直连（`opencode db` 已删）
- 全量增强：`session.panel` 全屏面板 + `ui.router` dashboard + `sidebar.footer`/`home.footer.status` 状态条
- 配置迁移 + README 重写

**Out of Scope**
- Windows 权限弹窗整条链路（notify.ts 权限部分全删）
- v1/MiMoCode 兼容层
- 服务端插件实质逻辑（server.ts 保持最小占位）
- 报告指标口径/SQL 语义变更

---

## 阶段 0 结论（实测探针，全部落实）

### A. `opencode db` 命令已被删除 ⚠
- `opencode db "sql" --format json` 在 v2.0.29 打印帮助（未知子命令）
- 替代：`opencode debug paths db` 输出 DB 路径 `C:\Users\zzt\.local\share\opencode\opencode.db`
- 内置 `opencode stats --json` 有全量统计（sessions/prompts/tokens/cost/tools），可交叉校验
- **决策**：报告功能走 **sqlite 直连**（分支 B）。运行时是 bun，需用 `bun:sqlite` 或 node 兜底，见阶段 6

### B. DB schema 大变 ⚠（报告 SQL 全部要改表）
- v2 活跃写入新表 **`session_message`**（最新数据 10-15），旧 `message` 表停在 10-09（v1 遗留）
- 新表结构差异（对比 v1 `message`）：
  | 项 | v1 `message` | v2 `session_message` |
  |----|----|----|
  | 表名 | `message` | `session_message` |
  | 会话表 | `session` | `session_v2` |
  | 角色 | `json_extract(data,'$.role')` | **`type` 列直接是角色**（`type='assistant'`） |
  | 模型 | `$.modelID` / `$.providerID`（平铺） | **`$.model.id` / `$.model.providerID`（嵌套）** |
  | tokens 总量 | `$.tokens.total` 存在 | **`$.tokens.total` 不存在**（只有 input/output/reasoning/cache） |
  | tokens/cost | `$.tokens.*` / `$.cost` | 同（不变） |
  | 时间 | `time_created` | `time_created`（不变） |
- `session_v2.model` 是 JSON 字符串 `{"id","providerID","variant"}`，`json_extract(s.model,'$.id')` 仍可用
- 现有 SQL 中所有 `$.tokens.total` 需改为 `input+output+reasoning+cache.read+cache.write` 计算值
- 现有 SQL 中所有 `$.modelID`/`$.providerID` 改 `$.model.id`/`$.model.providerID`；`FROM message` → `session_message`；`json role='assistant'` → `type='assistant'`；`FROM session` → `session_v2`

### C. SDK 与依赖
- `@opencode/plugin@2.0.29` 与 CLI 版本对齐；peerDeps：`@opentui/core|solid >=0.5.17`、`solid-js>=1.9`、`@opencode/theme`
- **peer 冲突**：`@opentui/solid@0.6.6` 要求 solid-js **精确 1.9.12** → 已钉死
- `@opentui/keymap` 未被源码使用 → 已从 devDeps 删除
- `@opencode/client` 要求 node>=26 / bun>=1.3（印证插件运行时是 **bun**）
- 已装：@opencode/plugin、@opencode/client、@opencode/theme（dev），@opentui/core|solid 0.6.6，solid-js 1.9.12

### D. TUI Context（从 `@opencode/plugin/dist/tui/context.d.ts` 真实类型读出）
原方案 4 个待确认项全部落实：
1. **持久化 API = `context.storage`**：
   - `storage.store(key, {initial})` → `[Store<Value>, async (draft)=>void]`，SolidJS Store，**同步读**，持久化+跨 TUI 同步
   - `storage.memory(key, {initial})` → `[Store, sync (draft)=>void]`，内存，热重载共享
   - ⇒ 渲染路径直接读 Store，无需手搓内存缓存层
2. **侧边栏槽位存在**：`SlotMap` 含 `sidebar.content` 与 `sidebar.footer`（input 均 `{sessionID}`）→ 常驻侧边栏形态可保留
   - 其它槽：`session.panel`(PanelInput)、`home.footer.status`、`prompt.footer(.status/.file)`、`session.composer.top`、`app`
3. **Dialog Promise 化**：`context.ui.dialog.select/prompt/confirm/alert` 全部返回 Promise；`select` 支持 `search`/`actions`
4. **`api.state.*` 对应物**：
   - `api.state.session.messages(id)` → `context.data.session.message.list(id)`（`SessionMessageInfo[]`，先 `sync`）
   - `api.state.part(id)` → assistant 消息内嵌的 `content` 数组（见 F）
   - `api.state.config`（读 agent prompt）→ `context.data.location.agent.list()`

其它 Context 成员：`options`(插件 options)、`location`、`app`、`renderer`、`client`(OpenCodeClient)、`data`、`attention`、`theme`(ResolvedTheme)、`themeMode`、`markdown`、`keymap`、`storage`、`ui`

### E. 事件模型根本性变化 ⚠（数据采集层重写）
- **`context.data.on(type, handler)`**，payload 在 `event.data.*`（不再是 v1 的 `event.properties.*`）
- v1 事件 → v2 对照：
  | v1 | v2 | v2 payload |
  |----|----|----|
  | `message.updated` | **`session.step.ended`** | `{sessionID, assistantMessageID, finish, cost, tokens}` ← **带全 cost+tokens** |
  | `message.part.updated` | **`session.message.content.updated`** | `{sessionID, messageID, content:[...]}` |
  | `message.removed` | （无直接对应，用 message list 重算） | — |
  | `session.idle` | `session.idle` | `{sessionID}` |
  | `permission.asked` | `permission.asked` | `{id, sessionID, action, resources, save, metadata, source, message}`（action+resources 替代 v1 permission+patterns） |
  | `permission.replied` | `permission.replied` | （需确认 payload） |
  | — | `session.usage.updated` | `{sessionID, cost, tokens}`（会话级聚合，无 model） |
  | — | `session.execution.succeeded` | `{sessionID}` |
  | — | `session.step.streamed` | `{sessionID, assistantMessageID}` |

**采集策略结论**：侧边栏/性能数据以 `data.session.message.list(sessionID)` 为**唯一事实源**（每条 assistant 消息自带 model+tokens+cost+time），事件仅作「触发重算」信号（调 `data.session.message.sync` 后 invalidate），不逐事件抠 token——更稳、自愈。

### F. 消息与 token 类型
- `SessionMessageAssistant` = `{id, time:{created,streamed?,completed?}, type:"assistant", agent, model:ModelRef, content:[Text|Reasoning|Tool], cost?, tokens?, finish?}`
- `ModelRef` = `{id, providerID, variant?}`（嵌套）
- `TokenUsageInfo` = `{input, output, reasoning, cache:{read,write}}` — **无 total**
- `content` 子类型：`{type:"text",text}` / `{type:"reasoning",text,time}` / `{type:"tool",id,name,state,time}`
- **性能指标可从消息自身算**（比 v1 更简洁）：
  - TTFT = `time.streamed - time.created`
  - 延迟 = `time.completed - time.created`
  - TPS = `output / (time.completed - time.streamed)`
  - ⇒ 不再需要 v1 的 firstPartTimes 跨事件追踪

### G. Theme
- `context.theme` 是 `ResolvedTheme`（语义 token 树，值为 `@opentui/core` 的 RGBA）
- 结构：`text.base/muted/action/feedback`、`background.*`、`border.base`、`hue`、`syntax`、`markdown`、`diff` 等
- 现有 sidebar 仅用 3 个扁平键：`accent` / `primary` / `textMuted` → 需写一个小 theme 适配器映射到语义 token
- sidebar 大量自定义色用 `RGBA.fromInts(...)` 硬编码，**不受 theme 影响，可原样保留**

### H. 阶段 0 遗留待确认（不阻塞，实现时验证）
- `permission.replied` 事件 payload 具体字段（阶段 5）
- `SessionMessageUser` 用户消息结构（token 分布估算用，阶段 3）
- bun 运行时下 sqlite 可用性（`bun:sqlite` vs `node:sqlite`，阶段 6）
- sidebar 宽度 38/36 列假设在 v2 是否仍成立（阶段 3 实测）
- `@opentui/core` 0.2→0.6 组件属性断层（阶段 3 回归）

---

## 本机配置迁移现状

| 文件 | 当前状态 | 目标 |
|------|---------|------|
| `~/.config/opencode/opencode.jsonc` | ❌ 仍 v1 `"plugin": [...]` | 改 `"plugins": [...]` |
| `~/.config/opencode/cli.json` | ✅ v2 写法 `plugins:[{package,options}]`，指向 npm 包 `opencode-token-board` | 开发期改本地路径 |
| `~/.config/opencode/tui.json` | ❌ v1 残留 | v2 已由 cli.json 取代，可删 |
| `~/.config/opencode/package.json` | 锁 `@opencode-ai/plugin:1.18.31` | 清理（v2 用 @opencode/plugin） |

> 本地调试配置建议：`cli.json` 的 plugins 项改为本地路径 `{ "package": "D:/AndroidPr/opencode-token-board", "options": {"enabled": true} }`，重启 TUI 加载本地 dist。

---

## 已知风险登记

| # | 风险 | 影响 | 对策 |
|---|------|------|------|
| 1 | `opencode db` 已删 | 报告数据源 | 阶段 0 已定 sqlite 直连分支 |
| 2 | @opentui 0.2→0.6 跨大版本 | sidebar 渲染回归 | 阶段 3 专门回归；仅 3 个 theme 键受影响 |
| 3 | 事件 payload 与类型不符 | 采集层返工 | 以运行时为准；用 message.list 事实源策略降低耦合 |
| 4 | bun 下 sqlite 可用性 | 报告功能 | 阶段 6 探测，备选 node:sqlite / 外部 sqlite3.exe |
| 5 | 插件 API 仍 beta | 后续再变 | SDK 与 CLI 版本对齐锁定 2.0.29 |
| 6 | sidebar 宽度假设 | 布局抖动 | 阶段 3 实测复核 |
