# dsh-qqbot-expands

DeepSeek Harness（DSH）插件：**在 QQ 官方机器人插件 `@tencent-connect/dsh-qqbot` 基础上的功能拓展**。

提供群聊频控、私聊主动问候、表情包、语音、绘图，以及一个统一设置页。

> 本插件不是官方插件，与腾讯、DeepSeek 均无隶属关系；它是运行在官方 QQ 机器人插件之上的扩展层，只使用 QQ 开放平台公开接口与 DSH 官方插件机制。

---

## 合规声明（请先读）

本插件是**官方 QQ 机器人插件的功能补全**，不替换、不修改官方插件代码，所有消息收发仍由官方插件完成。设计上遵守 QQ 开放平台规范：

- **不伪造消息**：不合成 `msg_id` / `event_id`，不伪造平台事件，只处理平台真实下发的事件；
- **不绕过配额**：主动消息、被动回复窗口、频率限制都按平台规则走，本插件只做“少回”的收敛，不做“多回”的突破；
- **不读取无权限内容**：平台不下发的消息不抓取，群聊全量消息需要群主在群里开启对应权限后才生效；
- **不收集、不上传数据**：所有状态只落在本机 `~/.dsh-qqbot/`，不向任何第三方回传；
- **文件读取需管理员授权**：非管理员发送的图片/文件默认拦截，必须管理员明确同意后才读取；
- 使用前请确认你的机器人已按 QQ 开放平台要求完成注册、审核，并在群主/管理员授权范围内使用。

如果平台规则与本文冲突，以 QQ 开放平台规则为准。

---

## 前置依赖（重要）

| 依赖 | 是否必须 | 说明 |
| --- | --- | --- |
| DSH（DeepSeek Harness） | **必须** | 插件运行在 DSH profile 中，建议 0.2.1 及以上 |
| `@tencent-connect/dsh-qqbot` | **必须** | **官方 QQ 机器人插件，必须已安装并完成绑定**；本插件不包含任何 QQ 协议实现，没有它无法工作 |
| `dsh-meme` | **表情包功能必须** | 提供 `send_meme` 与表情图库；不装则 `qqbot_send_meme` 找不到图库，表情包相关功能不可用 |
| 外接 TTS / ASR 服务 | 语音功能可选 | GPT-SoVITS 或 OpenAI 兼容端点；没有则语音工具报“未配置” |
| 绘图 API | 绘图功能可选 | 兼容 `images` / `chat` 两种协议的第三方服务 |

**没有官方 QQ 机器人插件，本插件不会加载任何功能。** 本插件注册的工具都依赖官方插件提供的发送通道与会话管理。

---

## 安装

### 方式 A：从 npm 安装（已发布版本，推荐）

```bash
dsh plugin --profile web add dsh-qqbot-expands
```

### 方式 B：从 GitHub 安装（跟 main 最新）

```bash
dsh plugin --profile web add "github:TONG5395/dsh-qqbot-expands"
```

`dsh plugin` 会把参数转给 profile 里的 pnpm。装完确认两件事：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 里有 `dsh-qqbot-expands`；
2. 同文件 `dsh.profile.bundles` 数组里有 `"dsh-qqbot-expands"`（没有就手动加上）。

也可以直接走 pnpm：

```bash
cd ~/.dsh/profiles/web
pnpm add github:TONG5395/dsh-qqbot-expands
```

### 方式 C：本地目录

```bash
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-qqbot-expands
```

### 方式 D：压缩包

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-qqbot-expands-0.4.1.tar.gz
```

### 启用与配置

1. 在 profile 的 `package.json` 里把 `"dsh-qqbot-expands"` 加进 `dsh.profile.bundles`；
2. 在 profile 的 `cordis.patch.yml` 里加配置块（见下方“配置参考”）；
3. 重启 DSH 引擎；
4. 打开设置 →「QQ 机器人 · 问候」，六块设置都在这里。

> 提示：`dsh plugin add` 只负责安装包，`dsh.profile.bundles` 与 `cordis.patch.yml` 里的配置仍需确认。装完可用 `dsh --profile web --dump-config` 检查条目是否出现。

---

## 功能教程

### 1. 群聊频控（主动接话收敛）

**解决什么问题**：官方插件在 `requireMention: false` 时，对每条群消息都回复，容易刷屏、烧 token。本插件在消息进入 agent 之前拦一道。

**判定流程**（只针对群聊、且没有 @ 机器人的消息）：

1. **无效消息过滤**：空内容、纯标点/表情、单个语气词（嗯/哦/好）、纯重复串（哈哈哈、66666）直接丢弃；
2. **防抖合并**：消息先进队列，默认 30 秒内继续来的消息并入同一批，安静满 30 秒才结算；
3. **概率**：结算时按 `chance` 掷骰，没中就**不丢弃**，进“积压”队列；
4. **积压**：下次掷中时，把积压的消息和当前这批一起送进 agent，机器人按完整上下文回复；
5. **限速**（可选）：`minIntervalMs` / `maxPerHour` / `maxPerDay`，默认全为 0（不限制）。

**永远放行**：@ 机器人的消息、私聊消息。

**文件与图片**：非管理员发送的带附件消息会被拦下，并在群里提示“需要主人同意”；管理员回复 `同意` / `允许` / `读吧` 后，原消息会被重放读取（有效期 10 分钟，同群提示有 5 分钟冷却）。管理员本人发的文件直接放行。

**合并转发**：命中合并转发/ark 卡片时只取文字，不读取里面的图片和文件。

**调参建议**：冷清群 `chance` 0.3~0.5；热闹群 0.1~0.2；`debounceMs` 30~60 秒；`backlogMax` 20~30 条。

### 2. 私聊主动问候

**触发条件**（全部满足）：

- 只对**私聊**生效，群聊绝不主动搭话；
- 对方**先说过话**（有历史对话），没聊过的新会话不打扰；
- 当前时间在时段窗内（默认 22:00–08:00）；
- 对方空闲时间超过 `idleBaseMs ± jitterRatio`（默认 2 小时 ±40%）；
- 今晚问候次数未达 `maxPerNight`（默认 3 条）。

**状态**：`~/.dsh-qqbot/greeting-state.json`；旧版 `greeter-state.json` 会自动迁移。

**想立刻验证**：设置页把“静默时间窗”改成包含当前时间（例如 8–23），空闲基准改 1 分钟，检查间隔改 1 分钟，然后等 2~3 分钟。

### 3. 表情包（依赖 dsh-meme）

**前置**：必须安装 `dsh-meme` 并准备好图库（默认 `~/.dsh/meme-packs/`）。

**工具**：`qqbot_send_meme`

- `tag`：`daily` / `happy` / `angry` / `sad` / `confused` / `shy`；
- `query`：按文件名关键词再筛（如 `猫`、`比心`、`无语`）；
- 每次调用按 `meme.chance` 概率决定发不发；被概率拦下时返回 `sent:false`，这一轮不要重试。

**图库目录自动检索**：配置 `packDir` → `$DSH_HOME/dsh-expression.json` 的 `memeRoot` / `enabledPacks[0]` → `$DSH_HOME/meme-packs/*` 里第一个含 `memes` 的包 → `~/.dsh/meme-packs/meme-pair-dict`。

**必须在官方 QQ 插件里放行图库目录**：`im-qqbot` 配置的 `sendFile.extraRoots` 要包含图库根目录（例如 `/root/.dsh/meme-packs`），否则发送会被路径白名单拒绝。

**建议提示词**（加到官方插件的 `directPrompt` / `groupPrompt`）：

```
表情包规则（qqbot_send_meme，QQ 专属）
【默认】每轮回复配一张表情包；工具返回 sent:false 就这一轮只回文字，不要重试、不要自己补发。
流程：1) 调 qqbot_send_meme，按情绪传 tag 或按内容传 query；
      2) 工具会自动选图并发到当前 QQ 会话，不需要再调 qqbot_send_file；
      3) sent:true 继续写正文；sent:false 说明频控拦了或没图，正文照常写。
```

### 4. 语音（TTS / ASR）

**工具**：`qq_voice_say`（合成并发语音条）、`qq_voice_stt`（转写音频）、`qq_voice_status`（自检）。

- TTS 支持两种协议：`gptsovits`（POST `{base}/tts`，`{text, ref, speed}`）与 `openai`（POST `{base}/audio/speech`）；
- ASR 走 OpenAI 兼容 `POST {base}/audio/transcriptions`；
- `autoSend: true` 时合成完自动调 `qqbot_send_file` 发到当前会话；
- QQ 官方插件不会自动下载语音附件，转写需要先把音频拿到本地文件。

**配置**：见下方 `voice` 段。地址可留空，用环境变量 `DSH_VOICE_TTS_BASE` / `DSH_VOICE_TTS_KEY` 等兜底。

### 5. 绘图

**工具**：`qqbot_draw_image`

- 兼容 `images`（`POST {base}/images/generations`）与 `chat`（`POST {base}/chat/completions`）两种上游；
- `protocol: auto` 时先按配置试，失败自动换另一条；
- baseUrl 没写 `/v1` 时会自动补（兼容 new-api 一类服务）；
- 生成结果落到 `~/.dsh-qqbot/media/`，模型再调 `qqbot_send_file` 发出；
- 画角色本人时把 `character` 设为 `true`，会套用拟人化角色外观设定。

### 6. 统一设置页

重启后打开 设置 →「QQ 机器人 · 问候」，一页六块：

- **管理员**：管理员 openid（一行一个），并生成“认人提示词”，一键复制贴进官方插件 prompt；
- **群聊频控**：开关、接话概率、防抖秒数、无效过滤、文件审批；
- **表情包**：开关、每条消息概率、当前图库目录；
- **语音**：TTS/ASR 地址、密钥、协议、音色、格式、自动发送；
- **绘图**：开关、地址、密钥、模型、尺寸、协议；
- **私聊问候**：开关、时段窗、空闲基准、浮动、每晚额度、检查间隔、时区、问候语。

保存写入 `~/.dsh-qqbot/settings.json`，立即生效；改完设置页需要刷新一次 Web 界面（首次出现该页需要重启引擎）。

---

## 配置参考

```yaml
- id: qqbot-expands
  name: 'dsh-qqbot-expands'
  config:
    gate:
      enabled: true
      chance: 0.25            # 防抖到点后的接话概率
      debounceMs: 30000       # 静默多久合并一批
      backlogMax: 30          # 没随机到的消息最多攒多少条
      backlogInvalid: false   # 无效噪音是否也进积压
      minIntervalMs: 0        # 0 = 不限制
      maxPerHour: 0
      maxPerDay: 0
      invalid:
        enabled: true
        minLength: 2
        dropPureRepeat: true
        dropPurePunctuation: true
        dropFiller: true
      files:
        requireAdminApproval: true
        adminOpenids: []      # 建议在设置页填
        approvalKeywords: [同意, 允许, 可以读, 读吧, 批准, 看吧]
        approvalTtlMs: 600000
        noticeCooldownMs: 300000
      skipMergedAttachments: true
      botIds: []              # 机器人 openid 等额外 id（@ 判定兜底）
    meme:
      enabled: true
      packDir: ''             # 空 = 自动检索 dsh-meme 图库
      chance: 0.6             # 每条消息附带表情包的概率
      maxRecent: 3
    voice:
      enabled: true
      ttsBaseUrl: ''
      ttsApiKey: ''
      ttsProtocol: gptsovits  # gptsovits / openai
      ttsModel: ''
      ttsVoice: default
      ttsFormat: wav
      asrBaseUrl: ''
      asrApiKey: ''
      asrModel: whisper-large-v3-turbo
      autoSend: true
      timeoutMs: 120000
    drawing:
      enabled: true
      baseUrl: ''
      apiKey: ''
      model: ''
      size: 1024x1024
      protocol: auto          # images / chat / auto
      timeoutMs: 300000
    greeting:
      enabled: true
      idleBaseMs: 7200000
      jitterRatio: 0.4
      quietStartHour: 22
      quietEndHour: 8
      maxPerNight: 3
      checkIntervalMs: 300000
      tzOffsetHours: 8
      greetings: []
```

### 官方 QQ 插件的配套设置

```yaml
- id: im-qqbot
  config:
    requireMention: false     # 频控才有意义；改回 true 请同时关闭 gate.enabled
    sendFile:
      restrictPaths: true
      extraRoots:
        - /root/.dsh/meme-packs   # 表情包目录必须放行
```

---

## 常见问题

**机器人完全不回复？**
先看官方插件是否正常（绑定、网关、`requireMention`），再看群主是否开启了全量消息权限；最后看设置页概率与防抖。

**@ 了也不回？**
多数是 @ 识别问题：设置页把机器人 openid 填进 `botIds`（从日志或官方插件会话里能看到）。

**表情包发不出去？**
检查 `sendFile.extraRoots` 是否包含图库根目录；设置页能看到当前解析到的图库路径。

**文件/图片不读？**
需要管理员 openid，且非管理员文件必须管理员回复“同意”。

**语音没声音？**
TTS 地址/协议/密钥是否配好；服务端是否支持对应格式。

**设置页看不到？**
重启引擎一次，再刷新页面。

---

## 开发与测试

```bash
node test-gate.mjs      # 群聊频控
node test-greeting.mjs  # 私聊问候 + 设置页路由
node test-meme.mjs      # 表情包挑选与概率
node test-draw.mjs      # 绘图协议
```

四个测试都不联网，使用临时状态文件。

> 这四个脚本只存在于源码仓库，不在 npm 包的 `files` 白名单里，所以从 npm 装到的版本没有它们；要跑测试请克隆仓库后在根目录执行。
> `test-meme.mjs` 需要本机有可用的表情图库（默认 `~/.dsh/meme-packs/meme-pair-dict/memes/<情绪>/`），挑不到图会失败。

---

## 免责声明

- 本项目是社区插件，非官方项目，与腾讯 / DeepSeek 无隶属关系。
- 使用本插件即表示你已阅读并遵守 QQ 开放平台的相关规则；因违反平台规则导致的后果由使用者自行承担。
- 请勿用于骚扰、刷屏、垃圾营销等场景。本项目只做“少回、可控”的收敛。
- 软件按 MIT 协议“原样”提供，不附带任何担保。
