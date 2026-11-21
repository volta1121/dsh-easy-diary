# dsh-easy-diary

极简日记，减少AI幻觉，记忆错乱与人格偏移风险

<img width="590" height="451" alt="屏幕截图 2026-11-20 140125" src="https://github.com/user-attachments/assets/463ea048-34cf-495b-8e6b-5ce4bdbf7e9e" />

每晚定时让指定会话（可多选）写一篇日记
可补写指定天数
AI对话优先调用日记
可自动/手动一键归档并注入自选天数日记
可一键更改/重置日记提示词


不发 QQ、不转发、不联网。

## 它怎么工作

1. 到 `at` 指定的时间（默认 22:00），插件对每个「写日记」开着的会话依次处理。
2. 往该会话投一条提示词（固定前缀 + 正文模板，见 [提示词](#提示词)）。如果她正在聊，先打断这一回合，写完再接上。
3. 等她自己写：以会话日志的 `turn/end` 为准，这一回合结束才收正文（最多等 `maxWaitMs`，默认 150 秒；到点还没收尾就停掉回合，宁可不写也不收半篇）。
4. `cleanText()` 清掉标签外的东西，`looksLikeDiary()` 复核——中文太少、像压缩记录、像条目列表的直接判不合格；整篇写成繁体的，会要她用简体重写一遍。
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

这个仓库的**根目录就是插件本体**（没有 `plugins/dsh-diary/` 这一层，那是最早寄居在别的仓库里时留下的旧路径）。

### 最简单：从 npm 装

1. DSH → 左侧「插件」→「添加插件」。
2. 在「包名或地址」里填 **`dsh-easy-diary`**，点「安装」。
3. 在插件列表里确认它是启用状态，然后去 **设置 → 日记**。

发布页：<https://www.npmjs.com/package/dsh-easy-diary>。

> 配置 `config.json` 写在插件自己的目录里。npm 装的那份位于 profile 的 `node_modules` 下，**卸载 / 升级会连同包目录一起被替换**——升级前把 `config.json` 复制出来，装完再放回去；不想操这个心就用下面的本地目录装法。

### 本地目录（改代码，或不想走 npm）

1. 把仓库放到一个固定位置，例如 `C:\Users\<你>\.dsh\plugins\dsh-easy-diary`——`git clone https://github.com/volta1121/dsh-easy-diary`，或在 GitHub 上下 ZIP 解压。
2. 「插件」→「添加插件」，把上面那个**目录的完整路径**填进「包名或地址」，点「安装」。

配置也在同一个目录里，升级时替换目录不会丢。

### 用 Release 里的包

从 [Releases](https://github.com/volta1121/dsh-easy-diary/releases) 下 `dsh-easy-diary-*.tgz`，解压出 `package/`，再按「本地目录」那步装。

> 发布名是 `dsh-easy-diary`；插件内部 id、日志文件名（`dsh-diary.log`）、`/diary-api` 路由都没变——原本想用的 npm 名 `dsh-diary` 已被别人先占了。

装好后设置页挂在 DSH 自己的 web 服务上（同源、不占端口），入口是 **设置 → 日记**；状态自检直接 `GET <DSH 地址>/diary-api/state`。

插件靠 `cordis.patch.yml` 插入，`package.json` 的 `dsh.bundle.patch` 指向它：

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-diary
      name: dsh-easy-diary
      config: {}
```

## 设置页

DSH 里打开 **设置 → 日记**（`client.js` 注册 `settings.section`，中英双语、跟随 DSH 语言）。能做：

- **每天几点写**：标题旁改时间，回车即保存（写进 `at`；只接受 `00:00`–`23:59`）；
- **现在写今天** / **补写某天**；
- **看日记**：在页面内展开这一本的原文；
- **提示词**：编辑并保存实际发出的完整提示词，或「重置提示词」回到默认；
- **归档注入新对话**（二次确认）、**每 N 天归档注入新对话**；
- **写日记 / 可查旧日记** 开关、**新对话注入日记 N 天**；
- **添加会话**（按标题 / 目录 / id 搜索已有 DSH 会话）、**移除会话**（二次确认，只从列表移除，不删会话和日记本）。

传输上是两条路由：`/diary-api/*` 只读（宿主只允许 GET/HEAD），写操作走 `/diary-api-write/*`（POST，要求 `x-diary-write: 1` 头且同源）。旧版的独立 HTML 控制页已经删掉；`port` 设成非 0 时只剩同样的 JSON 接口，不再有 `/ui`。

改任何设置都立即写进 `config.json`（热重载生效，不用重启），并立刻按新时间重排定时器；但**不会**因此马上写日记，新增会话、从关到开也一样——它们从下一次 `at` 开始算。要当场补今天（或补某天），用卡片上的「现在写今天」/「补写这天」。

## 安全边界（重要）

- **只读接口 `/diary-api/*` 不校验身份**：DSH 的 resource 路由不把 Peer 传下来（宿主源码原话：the request becomes a Fetch Request **without a Peer**），只把 `Host` 头交下来，socket 地址在宿主门口就丢了。所以 `/diary-api/state`、`/diary-api/sessions`、`/diary-api/read` 对任何能连上 DSH 端口的进程都可读（含会话 id 与日记全文）。
- **写接口 `/diary-api-write/*` 只接受本机来源**：除了 `x-diary-write: 1` 头和同源 `Origin` 检查，还会比对 `req.socket.remoteAddress`——TCP 层给的地址伪造不了，局域网来的请求一律 403 `local only`（并记一条日志）。挡不住的只有「本机上的进程」，那是信任边界以内的事。
- **DSH 绑到非回环地址时会告警**：插件在挂路由时读 `webServer.host`，一旦发现不是 `127.0.0.1` / `::1`，日志里会写一行警告，`/diary-api/state` 里也会带 `bindHost` 和 `nonLoopback: true`。DSH 本身拒绝通配地址（`0.0.0.0` 会直接报错），但允许绑某张网卡的具体 IP——绑了就等于把日记全文开放给该网络。
- 结论：**默认部署（绑回环）只有本机可读可写；绑到局域网 IP 时，别人能读、不能写**。

## 配置

真实配置是插件目录下的 `config.json`；不存在时全部走内置默认值。`config.example.json` 只是脱敏样例，不参与运行。会话级字段和全局字段放在同一个文件里。

### 全局

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `at` | `"22:00"` | 每天几点写 |
| `diaryDir` | `~/.dsh/diary` | 日记本目录 |
| `maxWaitMs` | `150000` | 等正文的最长时间，超时停回合 |
| `port` | `0` | 独立端口（同一套 JSON 接口）；`0` = 不开，走 DSH web 路由 `/diary-api` |
| `token` | `""` | 控制口令牌，空则首次启动自动生成并写回 `config.json` |
| `catchUp` | `true` | 启动时补写「上次打开 DSH 那天」漏掉的日记 |
| `recapDays` | `3` | 新对话注入最近几篇日记（会话可覆盖；按篇数算，不是日历天） |
| `prompt` | `""` | 全局正文模板，空 = 内置 `DEFAULT_PROMPT` |
| `retryMs` | `300000` | 失败后隔多久重试 |
| `holdFile` | `""` | 可选：写日记时给 QQ 桥的占位文件 |
| `bridgeMapFile` | `""` | 可选：桥的会话映射文件（QQ 桥就是 `state/sessions.json`） |
| `bridgeMapUrl` | `""` | 可选：桥的会话映射 HTTP 接口（QQ 桥是 `GET /api/sessions`） |
| `bridgeMapCommand` | `""` | 可选：能打印会话映射 JSON 的命令（任何桥的兜底）。**注意它会被 `execSync` 执行——`config.json` 等同于可执行代码，别把不可信的文件放进插件目录** |
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
| `recapDays` | 新对话注入几篇日记（篇数） |
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

- **某天没写成**：看 `<diaryDir>/dsh-diary.log`，或在设置页点「现在写今天」立刻试一次。
- **「正文不合格（中文太少（0 字）」**：这一回合根本没产出正文。常见原因是**会话被归档**——DSH 的 `ArchivedSessionGate` 会让每个回合直接 `blocked`、不调模型。在 DSH 里取消归档即可。
- **只写了半截**：`maxWaitMs` 到点就会停回合，调大它。
- **设置页打不开**：默认走 DSH 的 `/diary-api` 路由，日志会打印实际地址；`GET /diary-api/state` 能返回 JSON 就说明路由是通的。只有把 `port` 设成非 0 才会起独立端口（撞端口会看到 `EADDRINUSE`，插件会自己重试）。
- **换会话后日记又写回旧会话**：说明桥映射没跟上。插件每次写之前会重读映射（`bridgeMapCacheMs` 默认 30 秒），换会话时也会主动改桥的映射文件；桥进程如果正在写同一个文件，以桥重启后读到的为准。

## 数据文件

| 路径 | 内容 |
| --- | --- |
| `config.json` | 配置（含 token，不入库）；写入是原子的（临时文件 + fsync + rename） |
| `state.json` | 运行状态：`lastSeen`、`lastWrite`、`lastDeliver`、`attempts`；换会话/移除会话后会自动剪掉孤儿键 |
| `<diaryDir>/*.md` | 日记本 |
| `<diaryDir>/dsh-diary.log` | 运行日志（`diaryDir` 改了就跟新目录） |

## 测试

纯逻辑部分有单元测试（`test/` 下五个文件，共 20 个用例），用 Node 内置测试跑：

```bash
node --test
```

覆盖：`cleanText` 取 `<diary>` 正文、剥开头说明行、清乱码；`looksLikeDiary` 拒「中文太少」、拒压缩摘要、拒条目列表，以及正常中文日记通过；桥映射三种形状的归一化与非法值丢弃；从会话标签猜 `group:` / `private:` key；`normalizeAt` 接受 `7:05` 并拒绝 `25:00` / `22:70`；`validDay` 挡住 `2026-02-31` 这种假日期；`client.js` 注册的 id 必须等于包名。

## 已知限制

- 依赖 DSH 的 cordis 服务（`agents` / `sessions` / `workspaceRegistry` / `sessionTitle`）；DSH 大版本升级需要跟一次方法签名。
- 读会话历史走 `session.v4.jsonl.zstd` 和 `session_projcache`，属 DSH 内部格式，不是稳定 API。
- 同一时间只写一本（`runDue` 有互斥），多本依次写。
- 写接口只认真实来源回环。如果你用 DSH 的远程/手机访问，从别的机器打开设置页时**读**能用、**改设置**会被 403；那种部署请先在插件里放开（把 `writeHandler` 里的 `isLoopbackAddr` 检查换成显式白名单）。
- 只读接口无法区分来源，这是宿主 API 的限制，不是本插件能补的。
- 「新对话注入 N 篇」依赖 DSH 的 `agent.inject`（静默、不触发回复）。如果哪天宿主没有这个接口，插件**跳过注入**，只在日志里写一行、并在设置页标出来（`/diary-api/state` 的 `recapOk: false`）——不会退回 `followup`，因为那会让模型真的回一句、在 QQ 群里是能被看见的。

## License

MIT。
