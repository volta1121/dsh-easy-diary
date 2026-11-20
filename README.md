# dsh-diary

DSH 插件：每晚定时让指定会话给自己写一篇日记，按会话分别存成本地 Markdown。

它只做一件事——到点把「今天写日记」的提示词投进会话，等她自己写完，把 `<diary>` 里的正文追加到对应的日记本。不发 QQ、不转发、不联网。

## 它怎么工作

1. 到 `at` 指定的时间（默认 22:00），插件对每个「写日记」开着的会话依次处理。
2. 往该会话投一条提示词（固定前缀 + 正文模板，见 [提示词](#提示词)）。如果她正在聊，先打断这一回合。
3. 等她自己写：见到 `<diary>…</diary>` 就收，收完停掉这一回合（最多等 `maxWaitMs`，默认 150 秒）。
4. `cleanText()` 清掉标签外的东西，`looksLikeDiary()` 复核——中文太少、像压缩记录、像条目列表的直接判不合格。
5. 把正文追加到 `diaryDir` 下这本书的 `.md`，一节 `## YYYY-MM-DD 日记`。
6. 如果这条会话勾了「写完清上下文」，再执行一次「归档注入新对话」；如果第 2 步打断了她正在聊的天，写完接回去。

一次没写成，`retryMs` 后再试，每天最多 3 次。

## 日记本

每个会话对应一个日记本文件，文件名取 `bookId`（没有就取会话 id）：

```
<diaryDir>/session-<bookId>.md
```

一本书可以跨多个会话连续写。会话换了（归档换新 / 手动换），只要 `bookId` 不变、旧 id 记进 `prevIds`，正文还是写进同一个文件；`prevIds` 也用于「注入记忆」时往回读更早的日期。

## 安装

把 `plugins/dsh-diary/` 整个目录放进 DSH 的插件搜索路径，或作为本地包安装进 profile。插件靠 `cordis.patch.yml` 插入：

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-diary
      name: dsh-diary
```

`package.json` 的 `dsh.bundle.patch` 指向它。启用后把控制页挂到 DSH 自己的 web 服务上（同源、不占端口）：`<DSH 地址>/diary-api/ui`。

## 两个界面

### 设置 → 日记（推荐）

DSH 里打开 **设置 → 日记**（`client.js` 注册 `settings.section`，中英双语、跟随 DSH 语言）。能做：

- **每天几点写**：标题旁改时间，回车即保存（写进 `at`）；
- **现在写今天** / **补写某天**；
- **看日记**：在页面内展开这一本的原文；
- **提示词**：编辑并保存实际发出的完整提示词，或「重置提示词」回到默认；
- **归档注入新对话**（二次确认）、**每 N 天归档注入新对话**；
- **写日记 / 可查旧日记** 开关、**新对话注入日记 N 天**；
- **添加会话**（按标题 / 目录 / id 搜索已有 DSH 会话）、**移除会话**（二次确认，只从列表移除，不删会话和日记本）。

传输上是两条路由：`/diary-api/*` 只读（宿主只允许 GET/HEAD），写操作走 `/diary-api-write/*`（POST，要求 `x-diary-write: 1` 头且同源）。

### HTML 控制页（旧版，兜底）

浏览器打开 `http://127.0.0.1:<DSH 端口>/diary-api/ui`（就是你日常用的 DSH 地址，同源，不需要 token）。注意桌面端页面本身跑在 `dsh-app://` 下，**别从桌面端直接拖链接**，手输或从设置页按钮打开才有正确的 http 地址。

老式独立端口仍保留：把 `port` 设成非 0 即可，地址是 `http://127.0.0.1:<port>/ui?token=<token>`。

每条会话是一张卡片，从上到下四排：

| 位置 | 内容 |
| --- | --- |
| 第一排 | 标题 / 会话 id + **看日记** / **提示词** / **移除** |
| 第二排 | **写日记**（启用） / **可查旧日记**（注入 grep 日记的规则） |
| 第三排 | **补写某天**（选日期 + 写这天） / **现在写今天** |
| 第四排 | **新对话注入日记 N 天** / **归档注入新对话** / **每 N 天归档注入新对话** |

「写完清上下文」是旧的每写必清勾选框，已从界面撤掉（等价于「每 1 天」）；`config.json` 里的 `reset: true` 仍生效，需要时可手写。

「提示词」展开的文本框里是**实际会发出去的完整内容**（含固定前缀）；保存即写入 `promptFull`，点「重置提示词」清空、回到默认那一串。

页面还支持「按标题 / 目录 / id 搜索已有会话 → 添加到设置区」。

## 配置

真实配置是插件目录下的 `config.json`；不存在时全部走内置默认值。`config.example.json` 只是脱敏样例，不参与运行。会话级字段和全局字段放在同一个文件里。

### 全局

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `at` | `"22:00"` | 每天几点写 |
| `diaryDir` | `~/.dsh/diary` | 日记本目录 |
| `maxWaitMs` | `150000` | 等正文的最长时间，超时停回合 |
| `port` | `0` | 独立控制口端口；`0` = 不开，走 DSH web 路由 `/diary-api` |
| `token` | `""` | 控制口令牌，空则首次启动自动生成 |
| `catchUp` | `true` | 启动时补写「上次打开 DSH 那天」漏掉的日记 |
| `recapDays` | `3` | 注入记忆默认天数（会话可覆盖） |
| `prompt` | `""` | 全局正文模板，空 = 内置 `DEFAULT_PROMPT` |
| `retryMs` | `300000` | 失败后隔多久重试 |
| `holdFile` | `""` | 可选：写日记时给 QQ 桥的占位文件 |
| `bridgeMapFile` | `""` | 可选：桥的会话映射文件（QQ 桥就是 `state/sessions.json`） |
| `bridgeMapUrl` | `""` | 可选：桥的会话映射 HTTP 接口（QQ 桥是 `GET /api/sessions`） |
| `bridgeMapCommand` | `""` | 可选：能打印会话映射 JSON 的命令（任何桥的兜底） |
| `bridgeMapCacheMs` | `30000` | 映射缓存多久 |
| `ifArchived` | `"auto"` | 目标会话已归档时：`auto`（有桥=临时取消归档、写完还原；无桥=跳过）/ `defer` / `unarchive` |

### 会话

| 键 | 说明 |
| --- | --- |
| `id` | 必填，DSH 会话 id（配了桥映射时会被自动对齐，可当作「上次已知值」） |
| `key` | 聊天标识，如 `group:1034279878` / `private:1879047761`；不填就从 `label` 猜 |
| `label` | 显示名 |
| `enabled` | 是否写，默认 `true` |
| `reset` | 写完是否归档换新（清上下文），默认 `false` |
| `recapDays` | 注入几天记忆 |
| `search` | 新对话是否带「可查旧日记」规则，默认 `true` |
| `prompt` | 这条会话的正文模板（旧字段） |
| `promptFull` | 这条会话的**完整**提示词（含前缀），非空时原样使用 |
| `bookId` | 日记本文件名，缺省用 `id` |
| `prevIds` | 这本书以前用过的会话 id |
| `cwd` | 会话工作目录（换会话时用） |
| `agentPreset` | 换会话时新建会话用的 preset |

## 提示词

实际发出去的内容 = `PROMPT_PREFIX`（固定前缀，告诉她这是系统任务、不是聊天）+ 正文模板，再把 `${day}` / `${file}` 替换掉。

正文模板的优先级：`promptFull` → `prompt` → 全局 `prompt` → 内置 `DEFAULT_PROMPT`。

默认模板要求她只输出 `<diary>…</diary>` 里的中文散文，3~8 句、口语、有具体细节。改模板时请保留 `<diary>` 标签，否则收不到正文。

## 与桥的可选配合

下面这些都可以不填，插件本身零外部依赖：

- `holdFile`：写日记前写一个占位 JSON（`{at, until, session, day}`）。QQ 桥读到就把自己的主动唤醒往后推，避免刚写完就被叫去聊天。
- `bridgeMapFile` / `bridgeMapUrl` / `bridgeMapCommand`：**跟随桥**。这三者任选其一（可叠加，按 file → url → command 顺序取第一个可用的），只要能给出下面这份映射：

  ```json
  { "group:1034279878": "session-3c7ca01b-…", "private:1879047761": "session-f6729ae5-…" }
  ```

  插件接受三种形状：上面的扁平形式、`{"sessions":{…}}`（QQ 桥的 `state/sessions.json`）、`{"sessions":[{"key":…,"sessionId":…}]}`（QQ 桥的 `GET /api/sessions`）。每次写日记前读一次，跟 config 里的 `id` 不一致就跟随过去（旧 id 压进 `prevIds`），这样桥自己退役/重建会话后，日记不会写到旧会话里。

- 会话被归档：DSH 会把每个回合判成 `blocked`（不调模型、没有正文）。`ifArchived: "auto"` 的处理是——配了桥就当机器行为，临时取消归档、写完再归档回去；没配桥就当人工归档，跳过并在日志里写明。也可以手动固定成 `defer` / `unarchive`。

换成 NapCat / Lagrange 等其它桥时，只要那边能吐出这份映射（文件、HTTP、命令任一），插件自动跟上；吐不出来就把这三项留空，行为和纯本地模式一致。

## 排障

- **某天没写成**：看 `<diaryDir>/dsh-diary.log`，或在控制页点「现在写今天」立刻试一次。
- **「正文不合格（中文太少（0 字）」**：这一回合根本没产出正文。常见原因是**会话被归档**——DSH 的 `ArchivedSessionGate` 会让每个回合直接 `blocked`、不调模型。在 DSH 里取消归档即可。
- **只写了半截**：`maxWaitMs` 到点就会停回合，调大它。
- **控制页打不开**：默认走 DSH 的 `/diary-api` 路由，日志会打印实际地址；只有把 `port` 设成非 0 才会起独立端口（撞端口会看到 `EADDRINUSE`）。

## 数据文件

| 路径 | 内容 |
| --- | --- |
| `config.json` | 配置（含 token，不入库） |
| `state.json` | 运行状态：`lastSeen`、`lastWrite`、`lastDeliver`、`attempts` |
| `<diaryDir>/*.md` | 日记本 |
| `<diaryDir>/dsh-diary.log` | 运行日志 |

## 测试

纯逻辑部分有单元测试（`test/clean.test.js`、`test/bridge.test.js`、`test/client.test.js`，共 14 个用例），用 Node 内置测试跑：

```bash
node --test
```

覆盖：`cleanText` 取 `<diary>` 正文、剥开头说明行、清乱码；`looksLikeDiary` 拒「中文太少」、拒压缩摘要、拒条目列表，以及正常中文日记通过；桥映射三种形状的归一化与非法值丢弃；从会话标签猜 `group:` / `private:` key。

## 已知限制

- 依赖 DSH 的 cordis 服务（`agents` / `sessions` / `workspaceRegistry` / `sessionTitle`）；DSH 大版本升级需要跟一次方法签名。
- 读会话历史走 `session.v4.jsonl.zstd` 和 `session_projcache`，属 DSH 内部格式，不是稳定 API。
- 同一时间只写一本（`runDue` 有互斥），多本依次写。

## License

MIT。
