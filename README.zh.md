# dsh-headless-json

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)的结构化、机器可读 CI 输出。

> **English documentation: [README.md](README.md)**

dsh 官方 `headless` 模式只打印最后一条助手文本并以 0/1 退出——适合快速冒烟,但对 CI 来说信息太薄。`dsh-headless-json` 是一个 profile bundle,把任意 dsh 会话变成真正的 CI 产物:

- **事务级 JSON 报告**(会话元数据 + 每个结构化事件 + 结果 + 统计);
- **增量 NDJSON 事件流**,运行期间可实时 `tail`;
- **JUnit XML 报告**,供 GitLab CI / Jenkins / Azure DevOps 等直接展示;
- **语义化退出码**,区分成功、失败、超时、阻断、中止与中断;
- **工件清单**,收集会话输出中引用的文件路径;
- **隐私层**(文本截断、参数隐藏、密钥掩码、路径相对化);
- **双入口**:运行时内的 dsh 工具(`output_status`、`output_events`、`set_options`)+ 独立 CLI,用于离线渲染与退出码接线。

一切皆确定:给定相同的会话日志与相同的选项,产出的字节完全相同。

---

## 目录

- [功能](#功能)
- [工作原理](#工作原理)
- [包结构](#包结构)
- [安装与接入](#安装与接入)
- [一次运行产出什么](#一次运行产出什么)
- [dsh 工具](#dsh-工具)
- [CLI 参考](#cli-参考)
- [配置](#配置)
- [输出格式](#输出格式)
  - [JSON 报告](#json-报告)
  - [事件](#事件)
  - [NDJSON 流](#ndjson-流)
  - [JUnit XML](#junit-xml)
- [退出码语义](#退出码语义)
- [隐私与脱敏](#隐私与脱敏)
- [工件](#工件)
- [确定性](#确定性)
- [开发](#开发)
- [局限与兼容性](#局限与兼容性)

---

## 功能

| 领域 | 内容 |
| --- | --- |
| **会话事件流化** | 订阅 dsh 会话事件源(`session/created`、`session/event`、`session/flush`、`session/disposed`),为每个 turn/step/工具调用派生出结构化事件:类型、模型、耗时、token、工具名、参数摘要、结果、错误、状态。 |
| **JSON 输出** | 完整事务级报告:会话元数据 + 事件列表 + 结果/退出码 + 统计。可配置增量 NDJSON 流。 |
| **JUnit XML 输出** | 工具调用、步骤与轮次映射为测试用例,任何 CI 系统都能像展示测试一样展示 dsh 运行。 |
| **退出码语义** | 稳定分类(成功/失败/超时/阻断/空/中止/中断),默认码全部可覆盖。 |
| **工件收集** | 用户/助手/工具文本中引用的文件路径收集为清单;同机运行时记录存在性与大小。 |
| **隐私开关** | 工具输出截断、参数隐藏、密钥掩码、路径相对化——挂载时配置,运行时经 `set_options` 调整。 |
| **工具链** | 三个 dsh 工具(`output_status`、`output_events`、`set_options`)+ 独立 CLI(`dsh-headless-json render\|exit`)。 |

## 工作原理

本包是一个 dsh **profile bundle**:npm 包,manifest 声明:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

补丁向加载器树插入一个插件(`headless-json`)。插件订阅会话服务事件,为每个会话维护一个 Capture,事件到达时实时写出 NDJSON 行,并在会话销毁时(dsh 正常优雅关停的一部分)写出 JSON/JUnit 报告。

```
dsh 会话事件流
        │  session/created · session/event · session/flush · session/disposed
        ▼
┌─────────────────── CaptureManager ───────────────────┐
│  每会话 Capture:派生结构化事件                        │
│  (turn/step/tool 耗时、token、模型、错误)             │
│  + 工件扫描 + 原始类型分布                            │
└────────────┬──────────────────────────┬─────────────┘
             │ 实时 NDJSON 行           │ 会话结束时
             ▼                          ▼
       events.ndjson            report.json · junit.xml
```

- **采集与输出分离**:事件在内存中只派生一次;脱敏在**输出时**应用,因此用 `set_options` 改选项会影响其后每一次写出。
- **不打扰 stdout**:插件从不写 stdout,与官方 headless runner(独占 stdout)干净共存。
- **错误隔离**:每个监听器都有防护;畸形事件永远不会拖垮插件树或污染报告。

## 包结构

```
headless-json/
├── package.json              # dsh.bundle.patch 清单 + bin
├── cordis.patch.yml          # 加载器补丁(插入插件行)
├── lib/                      # 编译产物 ESM(tsc 输出)
├── bin/dsh-headless-json.js  # CLI 入口
├── src/                      # TypeScript 源码(仅仓库)
├── test/                     # node:test 测试套件(仅仓库)
├── examples/                 # 样例会话日志 + 生成产物
├── README.md / README.zh.md
└── LICENSE                   # MIT
```

上面是仓库目录树;发布的 npm 包只包含 `lib`、`bin`、`cordis.patch.yml`、`examples`、两篇 README 与 `LICENSE`。

## 安装与接入

要求:Node.js ≥ 18,以及一个组合了 `sessions` 服务的 dsh 安装(任何 base/headless profile 都满足)。

### 1. 构建(仅从源码开发时需要)

```bash
npm install
npm run build        # 或:npm test(构建 + 跑完整测试套件)
```

### 2. 把 bundle 加进 dsh profile

用 CLI(转发给 pnpm):

```bash
dsh plugin --profile headless add /path/to/headless-json
```

或直接从本仓库安装:

```bash
dsh plugin --profile headless add github:JohnXu22786/headless-json
```

或手动:在 profile 的 `package.json` 依赖中加上 `dsh-headless-json`,并加入有序的 `dsh.profile.bundles` 列表,然后在 profile 目录 `pnpm install`。dsh 下次运行时会把已安装的 bundle 与 `dsh.profile.bundles` 对账。

### 3. 运行

```bash
dsh --profile headless "run the test suite"
```

运行结束后,在工作目录的 `dsh-output/` 下得到:

```
dsh-output/report.json    # 事务级 JSON 报告
dsh-output/junit.xml      # JUnit XML 报告
dsh-output/events.ndjson  # 仅当 output.ndjson = true 时
```

### 4. 接入 CI

语义退出码在报告中;CLI 把它变成进程退出码:

```bash
dsh --profile headless "run the test suite"
code=$(dsh-headless-json exit dsh-output/report.json)
exit $code
```

或直接把 JUnit 报告交给 CI 收集器:

```bash
dsh-headless-json render dsh-output/report.json --format junit --out junit.xml
```

## 一次运行产出什么

每个会话,插件写出:

| 文件 | 时机 | 内容 |
| --- | --- | --- |
| `report.json` | 会话结束 | 完整报告(见 [JSON 报告](#json-报告)) |
| `junit.xml` | 会话结束 | JUnit XML(见 [JUnit XML](#junit-xml)) |
| `events.ndjson` | 实时 | 每事件一行 JSON,实时追加,末尾一行 `session_end` |

文件名支持 `{session}` 占位符(如 `"json_file": "report-{session}.json"`);未用时,同一进程内的第二个会话会在扩展名前追加 `-<id>`。`output.write_empty` 为 false 时,零事件的会话不写任何文件。

## dsh 工具

本 bundle 经 `ctx.tools.register` 注册三个工具,对所有 agent 可见,按调用方 agent 的会话解析。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `output_status` | 无 | 实时采集状态:事件/turn/工具计数、挂起中的工具调用、脱敏设置、流状态。 |
| `output_events` | `types?`(kind 数组)、`since?`(seq)、`limit?`(默认 200) | 请求的结构化事件,与文件相同的脱敏处理。 |
| `set_options` | 部分 `output` / `redact` / `artifacts` / `events` / `exit` | 校验后的新生效选项。 |

对话示例:

```
set_options({ "redact": { "args": "hide" } })
→ { "applied": true, "redact": { "args": "hide", ... } }
```

## CLI 参考

```
dsh-headless-json render <input> [options]   渲染报告/事件文件
dsh-headless-json exit <input> [options]     打印语义退出码
dsh-headless-json --version | --help
```

`<input>` 可以是:

- 插件产出的 `report.json`;
- 插件产出的 `events.ndjson` 流;
- 原始 dsh 会话 `.jsonl` 日志(头部行 + `session/*` 事件行);
- 原始会话事件的 JSON 数组。

| 选项 | 含义 |
| --- | --- |
| `--format json\|junit\|ndjson` | 输出格式(默认 `json`)。 |
| `--out <file>` | 写入文件而非 stdout。 |
| `--pretty` | 美化 JSON 报告。 |
| `--set <key=value>` | 覆盖选项,如 `--set redact.text_length=1200`,可重复。 |
| `--text-length <n>` | `--set redact.text_length=<n>` 的简写。 |
| `--arg-length <n>` | `--set redact.arg_length=<n>` 的简写。 |
| `--args full\|truncate\|hide` | `--set redact.args=<mode>` 的简写。 |
| `--paths relative\|absolute` | `--set redact.paths=<mode>` 的简写。 |
| `--no-secrets` | 关闭密钥掩码。 |
| `--max-events <n>` | `--set events.max_events=<n>` 的简写。 |
| `--cwd <dir>` | 路径相对化的基准目录。 |
| `--include-log-only` | 把仅日志类事件类型以 `other` 呈现。 |

说明:

- `exit` 打印退出码并用该码退出进程——CI 接线的关键。
- 脱敏类 `--set` 覆盖只对**原始会话日志**重新渲染生效。`events.ndjson` 流与 `report.json` 在采集写出时已脱敏,再输出时保持原样。

## 配置

所有键为 snake_case,可通过 bundle 补丁的 `config` 块、`set_options` 工具或 CLI `--set` 配置。配置文件容忍未知键(便于前向兼容的部署);`set_options` 与 CLI `--set` 拒绝未知键,包括未知的嵌套键。

```yaml
# cordis.patch.yml(profile 覆盖示例)
- id: headless-json
  config:
    output:
      dir: dsh-output
      json: true
      junit: true
      ndjson: true
    redact:
      text_length: 4000
      args: truncate
      paths: relative
      secrets: true
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `output.dir` | `dsh-output` | 报告目录(相对 cwd)。 |
| `output.json` | `true` | 写 `report.json`。 |
| `output.junit` | `true` | 写 `junit.xml`。 |
| `output.ndjson` | `false` | 实时流式写 `events.ndjson`。 |
| `output.json_file` | `report.json` | JSON 文件名(支持 `{session}` 占位符)。 |
| `output.junit_file` | `junit.xml` | JUnit 文件名。 |
| `output.ndjson_file` | `events.ndjson` | NDJSON 文件名。 |
| `output.write_empty` | `true` | 为零事件的会话也写报告。 |
| `output.pretty` | `false` | 美化 JSON 报告。 |
| `redact.text_length` | `4000` | 输出中任何文本值的最大字符数(`0` = 不限)。 |
| `redact.arg_length` | `500` | 工具参数摘要的最大字符数。 |
| `redact.args` | `truncate` | `full`(解析对象)、`truncate`(摘要)、`hide`(`[hidden]`)。 |
| `redact.paths` | `relative` | `relative`(相对会话 cwd)或 `absolute`。 |
| `redact.secrets` | `true` | 掩码形似密钥的字符串。 |
| `redact.secret_patterns` | `[]` | 额外的正则源字符串,在内置模式之外追加应用。 |
| `artifacts.collect` | `true` | 扫描文本中的文件路径引用。 |
| `artifacts.check_exists` | `true` | `stat` 命中的路径(仅运行机上有意义)。 |
| `artifacts.max_entries` | `500` | 工件清单最大条目数。 |
| `artifacts.pattern_extras` | `[]` | 额外的路径正则源字符串。 |
| `events.max_events` | `1000` | 报告事件列表的最大条数(`0` = 不限)。 |
| `events.trim` | `balanced` | `head` 只保留前 N 条;`balanced` 保留头尾。 |
| `events.include_log_only` | `false` | 把仅日志类型(`request/header`、`session/end-seed` 等)以 `other` 呈现。 |
| `exit.*` | 见表格 | 各类别退出码(见 [退出码语义](#退出码语义))。 |
| `capture.text_cap` | `100000` | 单段存储文本的硬上限(字符)。 |

## 输出格式

### JSON 报告

```
{
  "schema_version": 1,
  "plugin": { "name": "dsh-headless-json", "version": "0.1.0" },
  "generated_at": 1753000000000,          // 会话结束时间(派生,确定性)
  "session": {
    "id": "...", "cwd": ".", "cwd_name": "repo",
    "created_at": ..., "started_at": ..., "ended_at": ...,
    "event_count": 42,
    "parent_session": null, "agent_preset": "minimal", "delegation_depth": null
  },
  "outcome": {
    "status": "success",                  // 稳定分类
    "exit_code": 0,                       // 语义退出码
    "reason": "completed",                // 原始 turn/end 原因
    "complete": true,
    "undelivered_tool_calls": [],
    "error": null                         // 出错时为 {code, message, status?}
  },
  "stats": {
    "duration_ms": 4123.5,
    "turns": 1, "steps": 2,
    "assistant_messages": 3, "user_messages": 1,
    "tool_calls": 2, "tool_errors": 0, "undelivered_tool_calls": 0,
    "chunk_count": 14,
    "tokens": { "input": 900, "output": 300, "cache_read": 0, "cache_write": 0, "reasoning": 0 },
    "events_by_type": { "assistant/message": 3, "tool/call": 2, ... },  // 原始 dsh 类型
    "by_tool": { "bash": { "calls": 2, "errors": 0, "latency_ms_total": 800, "latency_ms_max": 500 } }
  },
  "events": [ /* 见下 */ ],
  "events_truncated": null,               // 被裁剪时为 {kept,total,dropped}
  "artifacts": [ { "path": "src/options.ts", "kind": "file", "size": 4281, "references": 3 } ]
}
```

### 事件

每个事件都带 `seq`(会话日志序号,稳定排序键)、`time`(Unix 毫秒)与 `kind`:

| kind | 附加字段 |
| --- | --- |
| `turn_start` | `turn` |
| `turn_end` | `turn`、`reason`、`error`(code/message/status)、`cause`(中止原因)、`latency_ms`、`complete` |
| `step_start` / `step_end` | `turn`、`step`、(`latency_ms`) |
| `user_message` | `turn`、`step`、`text`、`reasoning`、`blocks` |
| `assistant_message` | `turn`、`step`、`provider`、`model`、`latency_ms`、`usage`、`text`、`reasoning`、`blocks`、`stream`(chunk 数量/时间) |
| `tool_call` | `turn`、`step`、`call_id`、`tool`、`args_mode`、`args`、`args_summary`、`latency_ms`、`undelivered` |
| `tool_result` | `turn`、`step`、`call_id`、`tool`、`status`(`success`/`error`)、`latency_ms`、`text`、`blocks`、`error` |
| `todo_write` | `count`、`todos` |
| `request_context` | `provider`、`model`、`context_window` |
| `other` | `type`(仅 `events.include_log_only` 时) |

工具调用与结果按 `call_id` 关联;耗时由会话日志时间戳计算。会话结束时仍未收到 `tool/result` 的 `tool_call` 会标记 `undelivered: true`,并列入 `outcome.undelivered_tool_calls`。

### NDJSON 流

每行一个 JSON 对象,按到达顺序即时写出:同样的结构化事件,末尾追加一行汇总:

```json
{"kind":"session_end","session_id":"...","generated_at":...,
 "outcome":{"status":"success","exit_code":0,"reason":"completed"},
 "stats":{"duration_ms":4123,"turns":1,"steps":2,"tool_calls":2,"tool_errors":0}}
```

每次 `session/flush` 检查点都会 fsync 文件,`whenIdle()` 后读存储的消费者能看到持久化的流。`tool_call` 行在结果到达**之前**即被流式写出,因此这些行上的 `latency_ms` / `undelivered` 是暂定值;关联的 `tool_result` 行(或最终报告)携带权威值。

### JUnit XML

| dsh 概念 | JUnit 映射 |
| --- | --- |
| 整个会话 | `<testsuites name="dsh-headless-json">` → 一个 `<testsuite>`,属性含会话 id、cwd、status、exit_code、reason、插件版本 |
| 总体结果 | `<testcase name="run">` — 仅当 `outcome.status === "success"` 时通过,否则 `<error>`/`<failure>` |
| 每个 turn | `<testcase name="turn-N">` — `completed` 通过;`error`/`max-tokens` 失败;`blocked`/`aborted`/`interrupted` 跳过 |
| 每个 step | `<testcase name="step-N">` 带耗时;未关闭则跳过 |
| 每个工具调用 | `<testcase name="tool:NAME">` 带耗时,结果文本在 `<system-out>`;失败产生 `<failure type="dsh:tool">` |

时间以十进制秒计,timestamp 为 ISO-8601 UTC,所有文本经 XML 1.0 转义(控制字符替换)。

## 退出码语义

最终的 `turn/end` 原因映射为稳定分类与文档化退出码;每个值都可经 `exit.*` 覆盖:

| 分类 | 最终 turn/end 原因 | 默认码 |
| --- | --- | --- |
| `success` | `completed` | 0 |
| `error` | `error` | 1 |
| `timeout` | `max-tokens` | 2 |
| `blocked` | `blocked` | 3 |
| `empty` | (完全没有事件) | 4 |
| `aborted` | `aborted` | 130 |
| `interrupted` | `interrupted` | 130 |

有事件但没有闭合 `turn/end` 的会话按 `error`/`incomplete` 报告。130 遵循 SIGINT 惯例,表示用户主动中止。

## 隐私与脱敏

默认设置保守但可用。一切都在输出时应用。

- **文本截断** — 每个文本/reasoning 值按 `redact.text_length` 截断,带确定的 `…[+N more chars]` 标记。
- **参数处理** — `redact.args`:
  - `full`:解析后的参数对象,字符串值掩码/截断;
  - `truncate`(默认):掩码摘要,上限 `redact.arg_length`;
  - `hide`:字面量 `[hidden]`。
- **密钥掩码**(`redact.secrets`)— 内置覆盖 `sk-…` 密钥、`Bearer …` 头、PEM 私钥、GitHub/Google token、JWT、长 hex(保留短前缀以便辨认如 commit SHA)与形似 token 的字符串。turn/end 的错误消息按自由文本处理,同样掩码。可用 `redact.secret_patterns`(正则源字符串,配置期校验)追加。
- **路径相对化** — `redact.paths: relative`(默认)从工件路径中剥离会话 cwd,并把 `session.cwd` 渲染为 `.`;`absolute` 保留完整路径。

实际效果:默认输出不包含绝对工作区路径、不包含原始密钥串、不包含无界工具输出。

## 工件

`artifacts.collect` 开启时,每个用户/助手/工具文本都会扫描形似路径的候选(带分隔符的 POSIX/Windows 绝对路径与相对路径;URL 与邮箱被排除)。每个唯一候选成为一条工件条目并记录引用次数;`artifacts.check_exists`(默认开)且在同机运行时,`kind`(`file`/`dir`/`missing`)与 `size` 由文件系统填充。清单以 `artifacts.max_entries` 为界。

## 确定性

给定相同的会话事件与相同的生效选项:

- JSON 报告**逐字节一致**——对象键顺序由构造固定,事件按 `seq` 排序,映射型字段按排序键序列化,数字统一保留 3 位小数;
- JUnit XML 与 NDJSON 行出自同一序列化核心,三种格式永远一致。

`generated_at`(以及 JUnit 的 `timestamp`)由会话自身时间线派生——取最后一条事件的时间,因此从不依赖墙钟。

## 开发

```bash
npm install
npm run build        # tsc -> lib/
npm test             # 构建 + 跑完整套件(node:test)
npm run test:only    # 对当前构建跑测试
npm run typecheck    # tsc --noEmit
```

测试套件覆盖:事件订阅接线(基于最小假 context)、采集派生、序列化确定性、脱敏、退出码映射、JUnit 结构与转义、NDJSON 往返、CLI 端到端。

## 局限与兼容性

- **预览期 API。** dsh 处于开发者预览阶段,会话事件形态与服务语义可能演进。采集管线对所有事件做防御性读取(畸形输入只计数、不致命),所用的事件词汇均来自已发布的会话类型定义。
- **工具 schema 形态。** 三个 dsh 工具以符合 `ctx.tools.register` 期望形状的普通对象注册;若未来 dsh 改变定义 DSL,只需更新 `src/tools.ts`。组合中没有 `ctx.tools` 时,插件仍然采集与报告,只是跳过工具注册(带日志警告)。
- **退出码与官方 headless。** 官方 headless runner 按自身契约以 0/1 退出;本插件不触碰 `headlessIo`。需要细粒度退出码请用 `exit` 命令(或读 `report.json`)。
- **重渲染脱敏。** 只有原始会话日志能用不同的 `--set` 脱敏重渲染(脱敏是采集时属性,`report.json` 与 NDJSON 行已脱敏,再输出时保持原样)。

## License

MIT — 见 [LICENSE](LICENSE)。
