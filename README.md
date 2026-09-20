# widget-agent server

把 [pi coding agent](https://github.com/earendil-works/pi) 作为 SDK 跑在 Cloudflare Workers + Durable Objects 上，
工具（bash / 文件读写）在客户端本机执行，服务端只负责编排、状态与扇出。

- 一个 user 一个 Durable Object，按请求中的 user-id 路由
- 会话持久化在 DO 的 SQLite 里，可跨 DO 驱逐 / 重新部署恢复
- 客户端通过 WebSocket 长连接接收吐字与工具调用事件，并在本地执行工具

---

## 目录

- [一、为什么这么切（第一性原理）](#一为什么这么切第一性原理)
- [二、架构](#二架构)
- [三、目录结构](#三目录结构)
- [四、关键设计决策](#四关键设计决策)
- [五、通信协议](#五通信协议)
- [六、本地运行与测试](#六本地运行与测试)
- [七、部署](#七部署)
- [八、踩过的坑（重要）](#八踩过的坑重要)
- [九、已知缺口与后续计划](#九已知缺口与后续计划)

---

## 一、为什么这么切（第一性原理）

Agent 的本质是一个循环：`组装 context → 调 LLM 流 → 解析 tool_use → 执行 tool → 追加结果 → 重复`。
把循环里的每个原语按"它真正依赖什么"归类，切分线就自己浮现了：

| 原语 | 真实依赖 | 能否落在 Workers |
| --- | --- | --- |
| 组装 context / 系统提示词 / 上下文压缩 | 纯计算 | ✅ |
| 调 LLM 流 | `fetch` + SSE 解析 | ✅ pi-ai 底层走全局 fetch |
| 会话历史 | 单写者的追加日志 | ✅ DO 天然单线程 = 单写者，SQLite 10 GB/DO |
| tool 执行 | 进程 / 文件系统 | ❌ 必须离开 Workers |
| 流式推送 + 双向通信 | 长连接扇出 | ✅ DO WebSocket |

结论：**Cloudflare 上只跑「编排 + 状态 + 扇出」，工具下沉到客户端**。
这不是对平台限制的妥协，而是正确的切分线 —— Claude Code / Codex / Cursor / MCP 都是这个形状。

对应的行业最佳实践：

1. **云端大脑 + 本地手脚**：tool 调用建模成带 `callId` 的 request/response RPC，必须自带超时、取消、流式 stdout。
2. **Durable agent = append-only 事件日志**：不存"当前状态快照"，存事件流，状态由重放得出。
3. **恢复靠游标**：客户端重连时带 `sinceSeq`，服务端补发之后的条目。
4. **合帧**：不要一个 token 一个 WS 帧，Cloudflare 明确建议 batching，否则单 DO 吞吐被上下文切换吃掉。

---

## 二、架构

```mermaid
flowchart LR
  C["客户端 CLI (Node)<br/>stdin/stdout + 工具执行器<br/>bash / read / write / edit / ls / find"]
  W["Worker (无状态)<br/>校验身份 → 取 userId<br/>转发 Upgrade 请求"]
  DO["UserAgentDO (idFromName(userId))<br/>pi AgentSession × N<br/>WebSocket + SQLite 条目日志"]
  L["LLM 网关<br/>(OpenAI 兼容)"]

  C <-- "WebSocket (JSON)" --> W
  W --> DO
  DO -- "fetch SSE" --> L
  DO -. "op.call / op.result RPC" .-> C
```

### 一次 turn 的时序

```mermaid
sequenceDiagram
  participant C as 客户端
  participant DO as UserAgentDO
  participant L as LLM 网关

  C->>DO: prompt
  DO-->>C: ack（立即返回，turn 脱离 handler 运行）
  DO->>L: POST /v1/chat/completions (stream)
  L-->>DO: text_delta …
  DO-->>C: stream（40ms 合帧）
  L-->>DO: tool_calls
  DO-->>C: op.call { callId, op: "bash.exec", args }
  C->>C: 本机执行
  C-->>DO: op.update（stdout 增量，base64）
  C-->>DO: op.result { callId, ok, result }
  DO->>L: 带上 tool 结果继续
  L-->>DO: 最终回答
  DO->>DO: 增量落盘 SessionEntry → SQLite
  DO-->>C: stream + agent_end
```

关键点：

- `webSocketMessage` **先 ack、再脱离运行 turn**。若在 handler 里 await 整个 turn，
  后续的 `op.result` 帧可能被排队，直接死锁。
- turn 运行期间用 `setInterval` 保活。仅有一个 pending promise 并不能阻止 DO 休眠，但活动的 timer 可以。
- 每条入站 WS 消息会**重置 DO 的 30 秒 CPU 预算**，所以工具往返频繁反而是安全的；
  另外在 `wrangler.jsonc` 里把 `limits.cpu_ms` 提到 5 分钟。

---

## 三、目录结构

```
server/
├── package.json                    npm workspaces 根
├── tsconfig.base.json
└── packages/
    ├── protocol/                   客户端与服务端唯一的契约（无运行时依赖）
    │   └── src/index.ts            消息联合类型 + RemoteOpMap + VIRTUAL_ROOT
    ├── server/                     Cloudflare Worker
    │   ├── wrangler.jsonc
    │   ├── .dev.vars.example
    │   └── src/
    │       ├── typebox-setup.ts    必须最先 import：关闭 TypeBox JIT
    │       ├── index.ts            Worker 入口：鉴权 + 路由到 DO
    │       ├── env.ts              环境变量类型与默认值
    │       ├── user-id.ts          身份解析（当前是原型桩）
    │       ├── do/
    │       │   ├── user-agent-do.ts  Durable Object 主体
    │       │   ├── session-store.ts  SQLite schema 与条目日志
    │       │   ├── session-runner.ts 单个 AgentSession 的生命周期 + 事件映射
    │       │   ├── op-rpc.ts         远程工具 RPC（超时/取消/流式）
    │       │   └── outbox.ts         事件合帧
    │       └── agent/
    │           ├── model.ts          ModelRuntime + 自定义 provider
    │           ├── remote-ops.ts     pi *Operations 的远程实现
    │           └── session-factory.ts 创建会话 + 从条目日志恢复消息/模型/思考等级
    └── client/                     无 TUI 的 Node CLI
        ├── .env.example
        └── src/
            ├── index.ts            stdin/stdout REPL + 事件渲染
            └── local-ops.ts        本机工具执行 + 路径映射与越界校验
```

---

## 四、关键设计决策

| 关注点 | 决策 | 依据 |
| --- | --- | --- |
| 会话存储 | `SessionManager.inMemory()` + 增量把 pi 的 `SessionEntry` 落进 DO SQLite | CF 的 `node:fs` 是内存 VFS，且 `/tmp` **按请求隔离**，文件版 SessionManager 不可用 |
| 会话恢复 | 读回条目 → 线性重链 `parentId` → `buildSessionContext()` → 回填消息、模型与思考等级 | v1 没有分支/fork，线性重链是精确的；模型若已下架则回退到默认值 |
| 落盘触发 | 持有自己的 `SessionManager` 引用，在 `message_end` / `turn_end` / `tool_execution_end` / `compaction_end` 后 drain `getEntries()` | pi 的 `entry_appended` 事件**只针对扩展自定义条目**，不是通用持久化钩子 |
| 工具 | 不重写工具，而是实现 pi 自己留的 `BashOperations` / `ReadOperations` / `EditOperations` / `WriteOperations` / `LsOperations` / `FindOperations` | pi 源码注释原文："Override these to delegate ... to remote systems (for example SSH)"；这样参数校验、截断、diff、prompt 文案全部保留，只换 IO 层 |
| 工具注册 | `createAgentSession({ customTools, tools })`，同名 customTools 在注册表中覆盖内置工具 | `_refreshToolRegistry` 中 custom 在 builtin 之后 set |
| 路径 | 服务端一律用虚拟根 `/workspace` 解析，客户端映射到真实 cwd 并校验越界 | Workers 的 `node:path` 只有 POSIX 语义，直接传 `D:\repo` 会解析错 |
| 模型接入 | `ModelRuntime.create({ credentials: InMemoryCredentialStore, modelsPath: null })` + `registerProvider(<当前 provider>, { api: "openai-completions", ... })` | 全内存，密钥留在 Workers Secret |
| 多 provider | `gateway`、`deepseek`、`copilot` 都使用 OpenAI 兼容接口，`LLM_PROVIDER` 选定**唯一**生效的一家，只注册它 | 未使用的 provider 不需要配置 key |
| 扩展 | 关闭（`noExtensions: true`）。将来用 `DefaultResourceLoader({ extensionFactories })` 编译期内联 | jiti 动态加载 TS 在 Workers 不可用（无 eval / 无动态 import） |
| 协议 | 自建 JSON over WS，词表对齐 pi RPC mode | `@earendil-works/pi-client` + `pi-protocol` 是 CBOR、官方标注 Experimental，且不支持客户端执行工具 |
| 并发 | 单 DO 内多 session，同时 streaming 的 session 数上限由 `MAX_CONCURRENT_TURNS` 控制（默认 3） | |

### 模型 provider（Opus / DeepSeek / GPT / Gemini）

同一部署同一时刻只跑**一家**上游，由 `LLM_PROVIDER` 决定；切换 = 改配置 + 重启/重新部署，不是每会话可选项。

| provider | baseUrl 变量 | key 变量 | 默认模型变量 | 可用模型 |
| --- | --- | --- | --- | --- |
| `gateway`（默认） | `LLM_BASE_URL` | `LLM_API_KEY` | `DEFAULT_MODEL` | `claude-opus-4.8/4.7/4.5`、`claude-sonnet-4.5`、`gpt-5.6-sol`、`gpt-5.5` |
| `deepseek` | `DEEPSEEK_BASE_URL` | `DEEPSEEK_API_KEY` | `DEEPSEEK_DEFAULT_MODEL` | `deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` |
| `copilot` | `COPILOT_BASE_URL` | `COPILOT_API_KEY` | `COPILOT_DEFAULT_MODEL` | `gpt-5.6-sol`、`gemini-3.8-flash` |

定义都在 [`packages/server/src/agent/model.ts`](packages/server/src/agent/model.ts) 的 `PROVIDERS` 数组里，新增 provider 在此追加。

`createModelRuntime` **只注册当前选中的那一家**，不会因为没有配置其它 provider 的 key 而启动失败。

当前 `wrangler.jsonc` 选择 `copilot`，默认模型为 `gpt-5.6-sol`，base URL 为
`https://copilot.buildnow.work/v1`，新会话思考等级为 `medium`，使用本地 `COPILOT_API_KEY`。
这里的 `copilot` 是自定义网关名称，不使用 GitHub Copilot 登录流程。
DeepSeek 配置保留，模型为 `deepseek-v4-flash`，base URL 为 `https://ds.buildnow.work/v1`，
使用 `DEEPSEEK_API_KEY`；其 `medium` 兼容档位由上游映射为原生 `high`。
GPT 参数复用已有 GPT-5.6 SOL 定义（200K context、32K max output、文本/图片输入）。
`copilot` 下 GPT-5.6 SOL **新会话默认 `medium`**；不影响原 `gateway` 下的 GPT，也不降低输出上限。
Gemini 参数取自该网关的 `/v1/models`：文本/图片输入、65,536 最大输出；
上下文预算采用较低的 983,040 prompt 上限，而非 1,048,576 总窗口，避免超过网关输入限制。
Gemini 支持 `low/medium/high`，默认 `medium`，与 pi 新会话默认等级一致；恢复会话仍保留其已保存等级。
本地 key 放在被 Git 忽略的 `packages/server/.dev.vars` 的 `COPILOT_API_KEY`，不要写进 `wrangler.jsonc`。
GPT 与 Gemini 共用该 endpoint 和 key；切换 `COPILOT_DEFAULT_MODEL` 后重启服务端并**新建会话**，
既有同 provider 会话不会随默认模型变化而迁移。
同样，已保存的思考等级不会被新默认值覆盖；对比 `medium` 时须重启服务并新建会话，
查看请求日志中的实际 `reasoning_effort=medium`，而不是继续一个保存了 `low` 的会话。

`gateway` / `deepseek` 的 `compat` 不同：

| compat 项 | gateway | deepseek | 原因 |
| --- | --- | --- | --- |
| `supportsDeveloperRole` | `false` | `false` | gateway 静默丢弃 `role: "developer"`；DeepSeek 直接 400：``unknown variant `developer` `` |
| `thinkingFormat` | 默认 `openai` | `deepseek` | DeepSeek 接受 `thinking: { type }`，推理内容走 `reasoning_content`（pi 的 `openai-completions` 已原生识别并转成 `thinking_delta`） |
| `maxTokensField` | 自动探测 | `max_tokens` | DeepSeek 两个字段都收，钉死避免 URL 探测猜错 |

`copilot` 使用与原 GPT 网关相同的 OpenAI Chat Completions 接入方式，并使用 `system` 而非 `developer` role。

DeepSeek 的 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 都声明
`input: ["text", "image"]`；这两个旧 ID 当前由上游路由到支持视觉的 `deepseek-flash`。
`deepseek-v4-pro` 仍为纯文本，带图片的请求会在调用模型前明确拒绝。

**切换 provider 对既有会话的影响**：`resolveRestoredModel` 发现持久化的模型不属于当前 provider 时，会回退到新 provider 的默认模型，而不是报错。也就是说切完 `LLM_PROVIDER`，老会话仍然打得开、历史仍然完整，但会**迁移到新家的默认模型**上。这跟下面第 ④ 条冒烟测试（"模型不跟随默认值漂移"）在语义上是有张力的：那条约束只在 provider 不变时成立。反过来做——老会话直接不可用——显然更糟。

另外这必然是一次**缓存前缀失效**：换了上游，prefill 缓存从头重建。

### 页面读取：先整页，超限才探查

prompt 默认直接用一次 `read` 读取捕获的 HTML，不再强制 `regions → outline → 多次 slice`。
完整页面已经进入上下文后，要求直接选择字段并写文件；不再通过另一个工具重复确认同一页面。
只有明确缺失的客户端 URL、尺寸或选区元数据才额外读取，避免把 manifest 和 HTML 重复灌入上下文。
选区信息使用 `html_probe { path: "/workspace/source-regions.json", mode: "metadata" }`：
只返回来源及每个 region 的 id/xpath/selector/tag，省略 `regions[].html` 和 `sourceHtml`。
普通 `read` 行为不变，metadata 模式不会改写文件；无效 manifest 或过大的元数据明确报错。

模型上下文窗口与工具输出上限是两回事：pi 原生 `read` 最多返回 2,000 行 / 50 KiB，
超长单行也会被拒绝。遇到这个限制时，使用一次
`html_probe { path: "/workspace/source.html", mode: "full" }`：

- 在预算内返回**完整原始 HTML**，不走原有 24,000 字符摘要截断，也不删除 SVG、属性或脚本内容；
  这些内容仅作为源数据返回，不执行脚本。
- 单次源文件最多 512 KiB，且不超过「模型 contextWindow − 当前上下文用量 − 最大输出 − 4,096」；
  以 UTF-8 字节数作为保守 token 上界。用量未知时采用 48 KiB 保守预算。
- 超出预算时明确说明**没有返回整页**，并直接提供有界的 regions 摘要，而非返回开头一小段让模型继续翻页。
  此时才使用定向 outline/search；不再重复请求 regions 或 full。
- `slice` 保留为局部补查工具，偏移仍基于清理后的 HTML，不是原始全文。
  prompt 明确禁止 800/1000 字符步进、重叠读取和逐段重建整页。已有结构化模式及默认 `regions` 保持兼容。

模型行为仍需实际任务观察，不能仅据工具实现承诺固定耗时。

### 原页面 XPath、片段根节点与真实数据

用户提供的 `/html[1]/body[1]/...` XPath 属于原页面；抓取文件可能仅有 body 内容或选区 outerHTML。
即使文件补上了 html/body，原始祖先链与兄弟序号也不会自动恢复。prompt 要求区分这两种坐标：
运行时先尝试原 XPath 并校验目标，再按顺序尝试抓取内容里确实存在的稳定 ID/class 锚点，
不能盲删 XPath 前缀或修改序号。

`querySelector("#specific, .fallback, li")` 按 DOM 顺序返回第一个匹配，不是按选择器优先级返回。
brief 提供了可复制的 `resolveRoot` 模式，逐个查询候选并检查选区身份/主字段；
找不到时明确告警。单例根和位于节点自身的字段也必须包含，不能只查 descendants。
优先每个选区一个原 XPath 加一个已验证的稳定 CSS 锚点，不再重复输出等价的绝对 CSS 祖先链；
各选区复用小型定位函数，不构建通用跨站提取框架或添加无证据的备用算法。
主字段全 null 的硬编码摘要行不算提取成功，renderer 也不能用抓取时看到的数字作为缺值兜底。

一年走势图必须有真实的一年观察序列。当前选中的 `1D` 与可点击的 `1Y` 不是同一回事；
52 周高低点仅是区间，不能插值成一年走势或冒充年回报。数据不足时保留有效报价、明确区间含义，
显示缺少一年历史并提示切换 `1Y` 后重新捕获，不生成 synthetic checkpoints 或“看起来合理”的曲线。
固定宿主尺寸下移除空行网格，用明确缺失状态代替大块空白；不编数据来填满卡片。

### 避免重复 brief

`copilot`（GPT/Gemini）支持 system role，现在只接收一份 system brief。
新会话不再把整份 brief 复制进首条 user；恢复旧会话时，在 `convertToLlm` 的出站视图中去掉已知的
`<agent_brief>` 包装，保留实际用户请求、图片及 SQLite 历史原文，不重写存储。
这也避免恢复会话继续携带旧版的重复提示。未修改普通用户消息或 assistant/tool 内容。

原有 `gateway` / `deepseek` 的 user-message 兼容兜底保留；从 system-only 会话切回这些 provider 时，
若历史尚无兜底 brief，会在下一条用户消息补一次。新行为减少重复输入，不额外调用模型，
但不承诺固定的生成耗时，也不降低字段正确性或图表真实性。去重本身不改写已保存的推理等级。

### 请求耗时与隐藏推理

计时入口是 `session.agent.streamFunction`，在等待 HTTP 响应头**之前**开始；工具结果消息不再计作
LLM 调用，因此不会再有交替出现的 `0ms stop=?`。`llmCalls` 统计 SDK 流调用，包括走同一入口的压缩；
SDK 内部 HTTP 重试仍属于同一个流调用，不是物理 HTTP 请求计数。

- `begin`：provider、model 和传入的 reasoning 选项；缺失时为 `unset`，不据此声称上游已关闭思考。
- `request`：SDK payload hook 后的实际模型、`reasoning_effort`、thinking 和输出限制字段；
  未使用的字段显示 `?`。不记录请求正文、认证信息或响应头内容。
- `headers`：从流调用到收到响应头的耗时及状态码；包括请求准备、网络、等待与 SDK 内部重试。
- 完成行的 `ttft`：从流调用到首个非空 thinking/text/tool-argument delta；不是首个用户可见文字。
  `stream` 是首个 delta 到流结束，`maxGap` 是非空 delta 间最大间隔。
- `think/text/args` 为收到的字符数；`promptTokens/outputTokens/reasoningTokens/cacheRead/cacheWrite`
  来自 SDK 解析的上游 usage。prompt 含缓存，reasoning 是 output 的子集，不能再次加到 output 上。
- 当前 SDK 将缺失的 OpenAI `reasoning_tokens` 规范化为 0，无法再区分“明确为零”和“未报告”。
  因此日志中 0 显示为 `reasoningTokens=0-or-unreported`，undefined 显示 `unreported`；
  **`think=0ch` 或这个模糊零值都不能证明模型没有隐藏推理**。
- TURN 的 `llm` 为实测流区间、`tools` 为工具区间（并行取并集），剩余时间单列 `other`。
  去掉含混的 `prefill` 命名，以及集中返回参数时被夸大的字符估算 tok/s。

`low` 是降低推理强度的请求，不是时间上限。模型生成完整文件、网关缓冲和排队仍可能耗时，
应同时比较完整请求耗时、输出用量与提取正确性，不通过截断输出或省略必要校验来提速。

### 打包结果


| 指标 | 值 | 限制 |
| --- | --- | --- |
| Worker 原始体积 | ~13.1 MB | 64 MB |
| Worker gzip 体积 | ~2.32 MB | 10 MB（付费版） |

`npm run bundle:check` 可随时复测。

### 上下文缓存（prefill）

恢复出来的请求体与内存中的**逐字节一致**，所以 provider 侧的前缀缓存可以命中。这条链路是逐段核对过的：

| 环节 | 结论 |
| --- | --- |
| 条目 JSON round-trip | 无损（`SessionEntry` 只含 JSON 原生类型） |
| `sessionEntryToContextMessages` | `message` 条目恒等返回 |
| `convertToLlm` | 普通消息保持原样；`copilot` 的 user 消息确定性移除已知重复 brief，存储原文不变 |
| `convertMessages`（发给 provider） | 重建 payload，`timestamp` 被丢弃 |
| system prompt | `buildSystemPrompt` 无 `new Date()`，纯函数 of `{cwd, tools, snippets, skills, contextFiles}` |

我们这边这些输入全是常量：`cwd` 固定为 `/workspace`、6 个固定工具、skills/contextFiles 为空、
`getReadmePath()` 来自被 `define` 钉死的 `import.meta.url`。

顺带一个意外收益：**用虚拟根而不是客户端真实 cwd，让 system prompt 在不同机器、不同目录间也保持一致**，
缓存前缀更稳。

会打断缓存的三种情况：

1. **compaction** —— 前面一段历史被换成一条 summary，前缀从头变，压缩后第一次请求必然全价。
2. **模型或思考等级变化** —— 已通过恢复持久化的 `model_change` / `thinking_level_change` 修掉。
3. **网关路由** —— `prompt_cache_key` 只在 `baseUrl` 含 `api.openai.com` 时才发送
   （见 pi 的 `packages/ai/src/api/openai-completions.ts`），session 亲和性头也要
   `compat.sendSessionAffinityHeaders` 才发。
   多副本网关下同一会话可能落到不同后端，这大概率比消息一致性更是实际瓶颈。
   验证方式：看响应 `usage.prompt_tokens_details.cached_tokens`。

---

## 五、通信协议

定义在 [`packages/protocol/src/index.ts`](packages/protocol/src/index.ts)，JSON over WebSocket，`id` 关联请求/响应。

### 客户端 → 服务端

| 消息 | 说明 |
| --- | --- |
| `hello` | 握手，上报协议版本与真实 cwd |
| `session.list` / `session.create` / `session.attach` / `session.detach` / `session.delete` | 会话管理，`attach` 可带 `sinceSeq` 做增量恢复 |
| `prompt` | 发起一轮对话，可带 `images`；streaming 中需指定 `streamingBehavior: "steer" \| "followUp"` |
| `abort` | 中断当前 turn |
| `op.result` / `op.update` | 工具执行结果 / 流式增量（base64） |
| `ping` | 保活 |

### 服务端 → 客户端

| 消息 | 说明 |
| --- | --- |
| `ready` | 连接就绪，返回会话列表、并发上限和可选 `capabilities.promptImages` |
| `ack` | 命令响应 |
| `history` | 会话历史（含图片），较长记录分多帧返回，`hasMore` 表示还有后续帧 |
| `stream` | **批量**的 agent 事件数组 |
| `op.call` | 请客户端执行一次操作 |
| `op.abort` | 取消某次操作 |
| `session.updated` / `fatal` | 会话元信息更新 / 致命错误 |

### 聊天中上传图片（支持同一条消息多张）

保持协议版本 1，`images` 和能力声明均为可选字段，原来的纯文本消息不变。
新客户端发送图片前应确认 `ready.capabilities.promptImages` 存在；旧服务端没有这个能力声明。
图片使用 JSON 文本帧传输，不发送裸二进制 WebSocket 帧，也不需要客户端携带上游 API key。

```json
{
  "t": "prompt",
  "id": "req-images-1",
  "sessionId": "<session.create 返回的 sessionId>",
  "text": "比较这两张图片",
  "images": [
    { "mimeType": "image/webp", "data": "<第一张图片的纯 Base64>" },
    { "mimeType": "image/png", "data": "<第二张图片的纯 Base64>" }
  ]
}
```

这是本项目的 WebSocket 格式，不是上游的 `messages/image_url` 格式。
`images[].data` **不带** `data:image/...;base64,` 前缀或换行；服务端通过 SDK 转成模型的图片内容块，
保持图片顺序，一次交给模型。`text` 可以省略或为空，但必须有至少一张图片。
文本和图片都没有的空消息会被拒绝。运行中的会话也可在同一消息上添加
`"streamingBehavior": "steer"` 或 `"followUp"`，图片会随该消息一起排队，不会只排队文本。

`capabilities.promptImages` 返回以下限制，客户端应据此限制选择：

| 限制 | 当前值 |
| --- | --- |
| `mimeTypes` | PNG、JPEG、WebP、GIF 对应的 MIME；校验 MIME 与文件签名 |
| `maxImages` | 每条消息最多 4 张 |
| `maxImageBytes` | 单张原图最多 786,432 字节（768 KiB） |
| `maxTotalImageBytes` | 原图合计最多 786,432 字节（不是每张都可以占满 768 KiB） |
| `maxPromptBytes` | 带图片的整条 JSON 文本帧最多 1,250,000 UTF-8 字节 |
| 纯文本与普通工具 RPC 帧 | 仍为 1,000,000 UTF-8 字节 |

这些是应用限制，不是模型的视觉上限。现有 SQLite 会话条目有 1.5 MB 安全限制，而 Base64 会膨胀约 1/3，
还需给文字、brief 和条目元数据留空间。因此大图应先缩小或压缩为 WebP/JPEG；不会默默截断图片。
服务端会在成功 ack **之前**拒绝格式错误、超限、能力声明不支持图片的模型或按大小预检无法安全持久化的输入。
模型上游的解码/推理错误通过 `message_end.errorMessage`（或 `error` 事件）返回，客户端须展示；
签名校验不等于完整图片解码校验。

图片随用户消息保存在现有会话条目中，尚未被常规上下文压缩移出的图片随恢复后的消息进入模型上下文。
UI 历史仍保留原图条目。`history` 的用户条目为
`{ "k": "user", "text": "...", "images": [...] }`，纯图片消息不会被丢弃。
大段历史按条目边界拆成最多 4 MiB 的帧；保存各帧的 `lastSeq` 可用于增量恢复，
直到 `hasMore: false` 才是本次历史回放结束。Node CLI 显示图片类型/大小，不打印 Base64；
图形客户端可使用 `data:${mimeType};base64,${data}` 作为图片预览地址。
照片采用现有会话访问控制，不新增公开图片 URL；生产环境仍须完成本文列出的身份校验加固。

如果仅询问附图内容，agent 在聊天中回答，不会自动读取工作区或生成 widget。
若要求生成 widget，图片可作视觉参考，但不能代替用于编写 DOM 提取器的捕获 HTML。

### 流事件（`stream.events[]`）

`text_delta`、`thinking_delta`、`tool_start`、`tool_update`、`tool_end`、
`message_end`、`turn_end`、`agent_end`（带 token 用量）、`compaction`、`aborted`、`error`。

连续的 `text_delta` 会在 Outbox 里合并成一条，40 ms 或 32 KB 触发一次 flush。

### 远程操作（`op.call`）

`bash.exec`、`fs.readFile`、`fs.writeFile`、`fs.mkdir`、`fs.access`、`fs.stat`、
`fs.readdir`、`fs.exists`、`fs.glob`、`fs.imageMimeType`。

这组操作**刻意与 pi 的 `*Operations` 接口一一对应**，所以远程实现是纯粹的转发，没有语义翻译。

---

## 六、本地运行与测试

### 前置

- Node ≥ 22
- 一个 OpenAI 兼容的 LLM 网关（当前默认配置在 `wrangler.jsonc` 的 `LLM_BASE_URL`）

### 1. 安装依赖

```powershell
cd d:\project\widget-agent4\server
npm install
```

> 如果 npm registry 是内部代理，可能出现 `sharp` 版本缺失导致的 `ETARGET`。
> 根 `package.json` 里已经加了 `overrides: { "sharp": "0.35.3" }` 规避。

### 2. 配置密钥

```powershell
Copy-Item packages\server\.dev.vars.example packages\server\.dev.vars
# 编辑 .dev.vars，填入当前 provider 需要的那个 key
```

`.dev.vars` 已在 `.gitignore` 中，不会提交。只有 `LLM_PROVIDER` 选中的那一家的 key 是必需的，
其它 provider 的 key 留占位符也能正常启动。

### 2.5 切换 Opus / DeepSeek / GPT / Gemini

改 `packages/server/wrangler.jsonc` 的 `vars.LLM_PROVIDER`：

```jsonc
"LLM_PROVIDER": "gateway",   // Opus / GPT
"LLM_PROVIDER": "deepseek",  // DeepSeek
"LLM_PROVIDER": "copilot",   // GPT-5.6 SOL / Gemini 3.8 Flash，共用此 provider 的 endpoint / key
```

然后**重启 `npm run dev`** —— wrangler 不会对 `wrangler.jsonc` 的改动做热重载，
不重启的话你会以为切了其实没切。生产环境同样是改配置后 `npm run deploy`。

验证切没切成功：新建会话时 `ack` 里的 `models` 数组就是当前 provider 的 catalog。

### 3. 启动服务端

```powershell
npm run dev
```

看到 `Ready on http://127.0.0.1:8787` 即成功。绑定信息里应能看到
`USER_AGENT (Durable Object)`、`LLM_PROVIDER` 当前的取值，以及配置的 provider 变量。

### 4. 启动客户端（另开一个终端）

客户端的配置放在 `packages/client/.env`（**不是** `.dev.vars` —— 那个是 wrangler 专属的，
只注入 Worker 的 `env`，客户端进程读不到）：

```powershell
cd d:\project\widget-agent4\server
Copy-Item packages\client\.env.example packages\client\.env
# 编辑 .env，把 WA_CWD 改成 agent 实际要操作的目录
npm run client
```

客户端用 Node 内置的 `process.loadEnvFile()` 读它，**shell 里已设的环境变量优先于文件**，
所以临时切换时直接覆盖即可：

```powershell
$env:WA_USER_ID = "alice"; npm run client
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WA_SERVER_URL` | `ws://127.0.0.1:8787/ws` | 服务端 WS 地址 |
| `WA_USER_ID` | `dev-user` | 会作为 `X-User-Id` 头发送，决定路由到哪个 DO |
| `WA_CWD` | `process.cwd()` | 虚拟根 `/workspace` 映射到的真实目录 |

客户端命令：`/new`、`/sessions`、`/attach <id>`、`/image`、`/images`、`/abort`、`/help`、`/quit`；
其余输入都作为 prompt 发送。

单图和多图命令（路径有空格时加引号）：

```text
/image "C:\pictures\one.webp" 这张图片里有什么？
/images "C:\pictures\one.webp" "C:\pictures\two.png" -- 比较这两张图
```

`/images` 中 `--` 前都是图片路径，后面是提问；省略 `--` 及问题可发送纯图片消息。
多张图片属于**同一条 prompt**，不是依次发送多轮。相对路径基于 `WA_CWD`。
Node 客户端会先检查全部文件及总大小，再一起编码上传；旧服务端不声明图片能力时会在本地明确拒绝，
不会把图片发送给一个可能忽略它们的旧服务端。更换服务端版本后须重新连接以获取新的 ready 能力声明。

### 5. 冒烟测试

**① 工具链路**（验证 LLM → 工具调用 → 客户端执行 → 结果回传）

```
> List the files in the current directory with ls, then read package.json and tell me the workspace globs. Finally run `node -v` with bash. Be brief.
```

期望看到 `✓ ls`、`✓ read`、`✓ bash`，且返回的是你机器上的真实内容。

**② 会话持久化 + 冷启动恢复**

```
> /new
> Run `node -v` with bash and remember the exact version string. Reply with just the version.
> /quit
```

然后**重启 `npm run dev`**（让 DO 内存状态彻底丢失），重新启动客户端。
连接后应打印 `[restored N entries]`，再问：

```
> Without using any tools, repeat the exact node version string you found earlier.
```

模型应能答出之前的版本号 —— 说明历史完全由 DO SQLite 重放得出。

**③ 路径越界防护**

```
> Read the file ../../../etc/passwd
```

期望工具返回 `path escapes the session workspace`。

**④ 模型不跟随默认值漂移**

先用当前默认模型建一个会话并对话一轮，`/quit`；把 `wrangler.jsonc` 里的 `DEFAULT_MODEL`
改成另一个模型，重启 `npm run dev`，再连回同一个会话继续对话。会话应该仍然用**原来的**模型
（引导条目 `model_change` / `thinking_level_change` 已经落盘）。

要直接观察的话，在 `createRemoteSession` 里临时加一行日志：

```ts
console.log(`[session] ${sessionId} model=${model.id} thinking=${thinkingLevel ?? "default"}`);
```

注意这条只在 **provider 不变**时成立。换了 `LLM_PROVIDER`，老会话会迁移到新 provider 的默认模型
（见上面「模型 provider」一节）。

**⑤ provider 切换**

把 `LLM_PROVIDER` 改成 `deepseek`，重启 `npm run dev`，然后跑一遍 ① 的工具链路用例。
应该能看到同样的 `✓ ls` / `✓ read` 和真实的本机内容 —— 换上游不改变工具语义。

DeepSeek 会先吐一段 `thinking_delta` 再出正文（`reasoning_content` 被 pi 映射成了思考流），
这是预期行为，不是把推理泄漏进了正文。

### 6. 静态检查

```powershell
npm run typecheck      # server + client 类型检查
npm run bundle:check   # 打包并输出 Worker 体积
node --experimental-strip-types --test packages\server\test\model.test.mjs packages\server\test\page-reading.test.mjs packages\server\test\prompt-contract.test.mjs packages\server\test\timing.test.mjs
# 图片协议、WebSocket、SDK、恢复和 Node CLI（离线，不调用真实模型）：
node --experimental-strip-types --test packages\protocol\test\images.test.mjs packages\client\test\image-prompt.test.mjs packages\client\test\cli-images.test.mjs packages\server\test\image-history.test.mjs packages\server\test\image-session.test.mjs packages\server\test\websocket-images.test.mjs
```

### 7. 手动验证 DeepSeek 图片识别

使用 Node 22.19+，无需启动 Worker，也无需额外安装依赖：

```powershell
node scripts\deepseek-vision.mjs
# 或指定图片和问题：
node scripts\deepseek-vision.mjs "$HOME\Downloads\123.webp" "这张图片里有什么？请用中文描述。"
```

默认读取当前用户 Downloads 下的 `123.webp`，根据文件内容识别 MIME 并发送完整 Base64 data URL。
密钥优先读取 `DEEPSEEK_API_KEY` 环境变量，否则自动读取项目 `packages/server/.dev.vars` 中同名变量；
无需手填或将密钥写进脚本。默认 endpoint 为 `https://ds.buildnow.work/v1`、模型为 `deepseek-v4-flash`，
可分别通过 `DEEPSEEK_BASE_URL` / `DEEPSEEK_DEFAULT_MODEL` 环境变量覆盖。
请求使用 `thinking=enabled`、`reasoning_effort=medium`、`max_tokens=2048`、`stream=false`。

运行后显示图片大小、SHA-256、请求摘要、HTTP 状态、完整 API 响应及最终回答。
不打印密钥，控制台省略 Base64，但实际请求会携带完整图片；HTTP 错误、超时、输出截断或空回复会报错。
脚本直接调用 API，不经过 agent 的模型图片能力过滤，也不修改应用配置。执行脚本才会上传指定图片。
离线脚本回归可运行 `node --test scripts\deepseek-vision.test.mjs`，不会调用真实 API。

### 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 工具全部返回 `Code generation from strings disallowed` | TypeBox JIT 未关闭 | 确认 `src/index.ts` 第一行是 `import "./typebox-setup.ts"` |
| Worker 启动报 `The "path" argument must be of type string` | `import.meta.url` 未注入 | 检查 `wrangler.jsonc` 的 `define` |
| `ls` / `read` 报路径错误 | cwd 传了原生 Windows 路径 | 服务端必须用 `VIRTUAL_ROOT`，映射在客户端做 |
| 连接后没有 `[restored N entries]` | 条目没落盘 | 检查 `SessionRunner.persist()` 是否被触发 |

---

## 七、部署

```powershell
# 只需要放当前 LLM_PROVIDER 选中的那一家的 key
npx wrangler secret put LLM_API_KEY -c packages\server\wrangler.jsonc
npx wrangler secret put DEEPSEEK_API_KEY -c packages\server\wrangler.jsonc
npx wrangler secret put COPILOT_API_KEY -c packages\server\wrangler.jsonc
npm run deploy
```

生产环境需要先确认：

- `LLM_PROVIDER` 指向的是你想要的那一家，且对应的 key 已经 `secret put` 过
- `MAX_CONCURRENT_TURNS` 是否需要调整
- **身份校验必须换掉原型桩**（见下一节）

各 provider 的 key 提前放进 secret store 后，切换只需改 `vars.LLM_PROVIDER` 再 deploy 一次。

---

## 八、踩过的坑（重要）

这几条都是 pi + Workers 组合下必然会遇到、且报错信息完全指不到根因的问题。

### 1. TypeBox JIT 被 Workers 禁止

pi 用 `Compile()`（`typebox/compile`）校验 tool 参数，内部走 `new Function`，
Workers 直接抛 `Code generation from strings disallowed for this context`，
表现为**所有工具调用都失败**。

修法：在一个独立模块里关掉加速，并让它在任何 pi 模块之前被求值。

```ts
// src/typebox-setup.ts
import { Settings } from "typebox/system";
Settings.Set({ useAcceleration: false });
```

```ts
// src/index.ts —— 必须是第一行 import
import "./typebox-setup.ts";
```

### 2. `import.meta.url` 在打包后是 undefined

pi 的 `config.ts` 在模块作用域执行 `fileURLToPath(import.meta.url)` 做包路径探测，
Worker 一启动就崩。修法是在 `wrangler.jsonc` 里定义常量（该值只用于 CLI 自更新/文档路径，运行时用不到）：

```jsonc
"define": {
  "import.meta.url": "\"file:///worker/index.js\""
}
```

### 3. `entry_appended` 不是通用持久化钩子

pi 只在**扩展调用 `pi.appendEntry()`** 时才发这个事件，普通消息条目不会触发。
一开始订阅它做持久化，结果 SQLite 里一条都没有，恢复自然是空的。

修法：自己持有 `SessionManager` 实例，在若干事件后增量 drain：

```ts
const entries = this.sessionManager.getEntries();
for (let i = this.persistedEntries; i < entries.length; i++) { /* 落盘 */ }
this.persistedEntries = entries.length;
```

另外要注意游标 `persistedEntries` 的初值：每次打开会话时 pi 都会往新的内存 `SessionManager` 里写
`model_change` / `thinking_level_change` 两条引导条目。规则是——**新会话必须落盘它们，恢复的会话必须跳过**：

```ts
persistedEntries: history.length > 0 ? sessionManager.getEntries().length : 0
```

初值恒为 `getEntries().length` 会导致引导条目永远不落盘，恢复时读不到会话原本的模型和思考等级，
于是静默回退成 `DEFAULT_MODEL` + `thinking: off`；初值恒为 0 则会每恢复一次就重复追加两条。

### 4. 服务端路径解析是 POSIX-only

Workers 的 `node:path` 没有 win32 语义。把客户端的 `D:\repo` 当作 pi 的 cwd，
`resolve(".", "D:\\repo")` 会得到无意义的路径，工具静默失败。

修法：服务端固定用 `VIRTUAL_ROOT = "/workspace"`，客户端负责
`/workspace/... → <真实 cwd>/...` 的映射，并顺手做越界校验（顺便得到一层纵深防御）。

### 5. `/tmp` 是按请求隔离的

Cloudflare 的 `node:fs` 是内存 VFS，文档明确写着"在一个请求内写进 `/tmp` 的文件，
在其它并发或后续请求中不可见"。这意味着**文件版 `SessionManager` 完全不可用**，
必须走 `inMemory()` + DO SQLite。

### 6. Workers 的 `process.env` 里有你的密钥 🔒

`nodejs_compat` 会把 Worker 的 vars 和 **secrets** 一起填进 `process.env`。实测：

```
GET /health -> {"processEnvKeys":["LLM_BASE_URL","DEFAULT_MODEL","MAX_CONCURRENT_TURNS","LLM_API_KEY"]}
```

这本身没问题，但 pi 的 `bash` 工具会用 `getShellEnv()`（即 `process.env`）构造子进程环境，
再通过 `BashOperations.exec(command, cwd, { env })` 传下来。**把这个 `env` 原样转发给客户端，
就等于把网关 API key 注入到用户机器上的每一个 shell。**

修法是白名单，只放行 pi 自己的会话变量：

```ts
function sessionEnv(env) {
	const forwarded = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (key.startsWith("PI_") && value !== undefined) forwarded[key] = value;
	}
	return Object.keys(forwarded).length > 0 ? forwarded : undefined;
}
```

顺带一提，`env` 这个参数很容易在实现 `BashOperations` 时被漏掉（它在解构的第 4 个位置）。
漏掉的后果不只是变量缺失：`exposeSessionEnvironment` 默认为 `true` 时，pi 会往系统提示词里加一条
"Inspect PI_* environment variables for current model and session details"，
于是提示词说有、运行时没有，模型会读到空值。

### 7. 其它环境问题

- 内部 npm 代理缺 `sharp@0.35.2`，用根 `overrides` 钉到 `0.35.3`。
- `grep` 无法远程化：pi 的 grep 实现在任何情况下都会 spawn ripgrep，
  `GrepOperations` 只提供 `isDirectory` / `readFile` 给上下文行用，拦不住搜索本身。

---

## 九、已知缺口与后续计划

### 对外暴露前必须处理

1. **身份校验是原型桩** ⚠️
   `X-User-Id` 请求头被原样信任，任何人都能冒充任意用户读取其会话。
   替换点已隔离在 [`packages/server/src/user-id.ts`](packages/server/src/user-id.ts) 的
   `resolveUserId()`，改成校验 JWT 或 Cloudflare Access 断言即可，其余代码无需改动。

2. **工具执行没有审批** ⚠️
   客户端全自动执行，无审批、无命令过滤。仓库内容里的 prompt injection
   可以直接变成客户端的任意命令执行 —— 仅在完全可信的本机场景使用。

### 功能缺口

3. **`grep` 未接入**
   pi 的 grep 实现无条件 spawn ripgrep，`GrepOperations` 拦不住搜索本身。
   需要用 `defineTool` 写一个同名自定义工具，把搜索整体 RPC 给客户端（同名会覆盖内置工具）。
   目前模型会退化成用 `bash` 跑 `rg`，功能不缺但少了 pi 的结果格式化。

4. **skills / extensions 未接入**
   需要一个内存版 `ResourceLoader`（`getSkills()` 返回内存 `Skill[]`）+
   `extensionFactories` 编译期内联。注意 pi 在**调用技能时**会 `readFileSync(skill.filePath)`，
   `/tmp` 的每请求隔离特性需要额外处理。

5. **客户端只驱动单会话**
   服务端的 3 路并发限制已实现，Node 客户端仍只驱动一个当前会话。历史会回放文字和图片摘要，
   图形客户端需要自行渲染 `history` 中的图片，并使用 `lastSeq` / `hasMore` 管理增量恢复。

### 已知的实现瑕疵

6. **大文件与图片有不同的预算**
   普通 RPC 保留 1,000,000 字节应用帧上限，`fs.readFile` 已按 512 KiB 范围分片。
   聊天图片不走文件 RPC，遵守上文单条 prompt 的数量、原图合计和帧大小限制。
   这不是大文件/媒体库上传方案；大量历史图片仍会增加会话存储与模型上下文成本。

7. **`details.patch` 被丢弃**
   pi 专门为 SDK 消费者生成了标准 unified patch 和 `firstChangedLine`，
   但 `session-runner.ts` 只转发了 `content` 里的文本。给 `tool_end` 事件加上 `details` 即可。

8. **断线时 `rejectAll` 过于粗暴**
   `releaseSocket()` 一旦发现有 session 失去 owner，就 reject 掉**所有** session 的挂起操作。
   单客户端无影响，多客户端并发时 A 断线会误杀 B 正在跑的工具。
   修法是给 `PendingOp` 记上 `sessionId`，按 session 过滤。

9. **turn 级别不可恢复**
   DO 重启（部署、驱逐）会丢掉进行中的 turn，`OpRpc` 的 pending Map 是纯内存的，
   挂起的 Promise 永远不会 resolve，turn 静默卡死。keepalive 只能防休眠，防不了重启。
   要真正可恢复，需要把 pending tool call 也写进 SQLite，重连后重新下发 `op.call`。

10. **恢复后条目树是空的**
    只回填了 `agent.state.messages`，新的 `SessionManager` 里只有引导条目。
    普通对话和 compaction 不受影响（它们基于 messages），但 pi 的
    **fork / clone / tree navigation** 在恢复后的会话上不可用。
