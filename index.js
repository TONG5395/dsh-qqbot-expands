/**
 * @local/dsh-qqbot-fixes
 *
 * 给官方 @tencent-connect/dsh-qqbot 补两块缺失能力：
 *
 * 1. 绘图工具 qqbot_draw_image
 *    兼容两种上游协议：
 *      images  POST {baseUrl}/images/generations → data[0].b64_json 或 data[0].url
 *      chat    POST {baseUrl}/chat/completions  → 图片以 data URI / URL 嵌在 content 里
 *    protocol=auto 时先按配置协议请求，失败自动换另一条。
 *    生成结果落到 ~/.dsh-qqbot/media/（qqbot_send_file 白名单内），由模型调用 qqbot_send_file 发出。
 *
 * 2. 群聊全量消息频控闸
 *    requireMention=false 时官方插件会对每条群消息都回复。这里在 SDK 入站入口
 *    （QQBot.handleInboundMessage）前拦截未 @ 的群消息，按概率 / 最短间隔 / 小时额 / 日额
 *    丢弃一部分，直接不进入中间件链与 agent，不烧 token。
 *    @ 消息、私聊消息永远放行。
 *
 * 配置在 profile 的 cordis.patch.yml 里，id 为 qqbot-fixes。
 *
 * @module dsh-qqbot-fixes
 */
import Schema from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'qqbot-fixes'
export const inject = ['tools']

const QQ_HOME = join(homedir(), '.dsh-qqbot')
const MEDIA_ROOT = join(QQ_HOME, 'media')
const STATE_FILE = process.env.DSH_QQBOT_GATE_STATE || join(QQ_HOME, 'gate-state.json')
const LOG_FILE = process.env.DSH_QQBOT_GATE_LOG || join(QQ_HOME, 'gate-log.jsonl')

/** 蓝汐的角色外观：拟人化虎鲸少女，禁止兽头怪物化 */
const DEFAULT_CHARACTER_PROMPT =
  '拟人化的虎鲸少女：人类少女的面容与身型，深海蓝／宝蓝色长卷发，蓝色大眼睛、眼尾微微下垂，头顶一根呆毛；' +
  '一对鲸鱼鳍造型的兽耳，身后拖着宽大的深蓝色鲸鱼尾巴；穿藏青色日系女仆裙、纯白围裙、白色蕾丝发带，' +
  '领口黑色蝴蝶结，围裙裙摆绣小鲸鱼。二次元插画，柔和水彩质感。' +
  '必须是正常比例的人类少女五官，不要兽头、不要怪物化、不要鱼眼。'

export const Config = Schema.object({
  gate: Schema.object({
    enabled: Schema.boolean().default(true),
    chance: Schema.number().default(0.25),
    minIntervalMs: Schema.number().default(0),
    maxPerHour: Schema.number().default(0),
    maxPerDay: Schema.number().default(0),
    debounceMs: Schema.number().default(30000),
    /** 没随机到的消息最多积压多少条，下次触发时一起送上 */
    backlogMax: Schema.number().default(30),
    /** 被无效过滤的消息是否也进积压（默认否，避免语气词污染上下文） */
    backlogInvalid: Schema.boolean().default(false),
    invalid: Schema.object({
      enabled: Schema.boolean().default(true),
      minLength: Schema.number().default(2),
      dropPureRepeat: Schema.boolean().default(true),
      dropPurePunctuation: Schema.boolean().default(true),
      dropFiller: Schema.boolean().default(true),
    }).default({
      enabled: true,
      minLength: 2,
      dropPureRepeat: true,
      dropPurePunctuation: true,
      dropFiller: true,
    }),
    files: Schema.object({
      requireAdminApproval: Schema.boolean().default(true),
      adminOpenids: Schema.array(Schema.string()).default([]),
      approvalKeywords: Schema.array(Schema.string()).default(['同意', '允许', '可以读', '读吧', '批准', '看吧']),
      approvalTtlMs: Schema.number().default(600000),
      noticeCooldownMs: Schema.number().default(300000),
    }).default({
      requireAdminApproval: true,
      adminOpenids: [],
      approvalKeywords: ['同意', '允许', '可以读', '读吧', '批准', '看吧'],
      approvalTtlMs: 600000,
      noticeCooldownMs: 300000,
    }),
    skipMergedAttachments: Schema.boolean().default(true),
    /** 机器人自身的其它 id（openid/uin 等）；内容里的 @ 标记命中这些也算 @ 机器人 */
    botIds: Schema.array(Schema.string()).default([]),
  }).default({
    enabled: true,
    chance: 0.25,
    minIntervalMs: 0,
    maxPerHour: 0,
    maxPerDay: 0,
    debounceMs: 30000,
    backlogMax: 30,
    backlogInvalid: false,
    invalid: { enabled: true, minLength: 2, dropPureRepeat: true, dropPurePunctuation: true, dropFiller: true },
    files: {
      requireAdminApproval: true,
      adminOpenids: [],
      approvalKeywords: ['同意', '允许', '可以读', '读吧', '批准', '看吧'],
      approvalTtlMs: 600000,
      noticeCooldownMs: 300000,
    },
    skipMergedAttachments: true,
    botIds: [],
  }),
  voice: Schema.object({
    enabled: Schema.boolean().default(true),
    ttsBaseUrl: Schema.string().default(''),
    ttsApiKey: Schema.string().default(''),
    ttsProtocol: Schema.union(['gptsovits', 'openai']).default('gptsovits'),
    ttsModel: Schema.string().default(''),
    ttsVoice: Schema.string().default('default'),
    ttsFormat: Schema.string().default('wav'),
    asrBaseUrl: Schema.string().default(''),
    asrApiKey: Schema.string().default(''),
    asrModel: Schema.string().default('whisper-large-v3-turbo'),
    autoSend: Schema.boolean().default(true),
    timeoutMs: Schema.number().default(120000),
  }).default({
    enabled: true,
    ttsBaseUrl: '',
    ttsApiKey: '',
    ttsProtocol: 'gptsovits',
    ttsModel: '',
    ttsVoice: 'default',
    ttsFormat: 'wav',
    asrBaseUrl: '',
    asrApiKey: '',
    asrModel: 'whisper-large-v3-turbo',
    autoSend: true,
    timeoutMs: 120000,
  }),
  meme: Schema.object({
    enabled: Schema.boolean().default(true),
    /** 图库目录；空 = 自动检索 dsh-meme 的图库目录 */
    packDir: Schema.string().default(''),
    /** 每条消息附带表情包的概率（0~1） */
    chance: Schema.number().default(0.6),
    /** 最近几张不重复 */
    maxRecent: Schema.number().default(3),
  }).default({
    enabled: true,
    packDir: '',
    chance: 0.6,
    maxRecent: 3,
  }),
  greeting: Schema.object({
    enabled: Schema.boolean().default(true),
    idleBaseMs: Schema.number().default(7200000),
    jitterRatio: Schema.number().default(0.4),
    quietStartHour: Schema.number().default(22),
    quietEndHour: Schema.number().default(8),
    maxPerNight: Schema.number().default(3),
    checkIntervalMs: Schema.number().default(300000),
    tzOffsetHours: Schema.number().default(8),
    greetings: Schema.array(Schema.string()).default([]),
  }).default({
    enabled: true,
    idleBaseMs: 7200000,
    jitterRatio: 0.4,
    quietStartHour: 22,
    quietEndHour: 8,
    maxPerNight: 3,
    checkIntervalMs: 300000,
    tzOffsetHours: 8,
    greetings: [],
  }),
  drawing: Schema.object({
    enabled: Schema.boolean().default(true),
    baseUrl: Schema.string().default(''),
    apiKey: Schema.string().default(''),
    model: Schema.string().default(''),
    size: Schema.string().default('1024x1024'),
    protocol: Schema.union(['auto', 'images', 'chat']).default('auto'),
    timeoutMs: Schema.number().default(300000),
    /** 画「蓝汐本人」时附加的角色外观设定，避免画成兽头怪物 */
    characterPrompt: Schema.string().default(DEFAULT_CHARACTER_PROMPT),
    /** 命中这些词的提示词自动套角色设定 */
    characterKeywords: Schema.array(Schema.string()).default(['蓝汐', '自拍', '头像', '女仆', '虎鲸', '本人']),
  }).default({
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    protocol: 'auto',
    timeoutMs: 300000,
    characterPrompt: DEFAULT_CHARACTER_PROMPT,
    characterKeywords: ['蓝汐', '自拍', '头像', '女仆', '虎鲸', '本人'],
  }),
})

// ─────────────────────────── 通用 ───────────────────────────

function log(message) {
  // 项目经验：logger.info 不进引擎日志，console.log 才进
  console.log('[qqbot-fixes] ' + message)
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function resolveConfig(config) {
  const cfg = config ?? {}
  const gate = cfg.gate ?? {}
  const invalid = gate.invalid ?? {}
  const files = gate.files ?? {}
  const meme = cfg.meme ?? {}
  const greeting = cfg.greeting ?? {}
  const drawing = { ...(cfg.drawing ?? {}) }
  drawing.baseUrl = normalizeBaseUrl(drawing.baseUrl)
  return {
    gate: {
      enabled: gate.enabled !== false,
      chance: clamp01(toNumber(gate.chance, 0.25), 0.25),
      minIntervalMs: Math.max(0, toNumber(gate.minIntervalMs, 0)),
      maxPerHour: Math.max(0, toNumber(gate.maxPerHour, 0)),
      maxPerDay: Math.max(0, toNumber(gate.maxPerDay, 0)),
      debounceMs: Math.max(0, toNumber(gate.debounceMs, 30000)),
      backlogMax: Math.max(0, toNumber(gate.backlogMax, 30)),
      backlogInvalid: gate.backlogInvalid === true,
      invalid: {
        enabled: invalid.enabled !== false,
        minLength: Math.max(0, toNumber(invalid.minLength, 2)),
        dropPureRepeat: invalid.dropPureRepeat !== false,
        dropPurePunctuation: invalid.dropPurePunctuation !== false,
        dropFiller: invalid.dropFiller !== false,
      },
      files: {
        requireAdminApproval: files.requireAdminApproval !== false,
        adminOpenids: Array.isArray(files.adminOpenids) ? files.adminOpenids.map((x) => String(x)) : [],
        approvalKeywords: Array.isArray(files.approvalKeywords) && files.approvalKeywords.length > 0
          ? files.approvalKeywords.map((x) => String(x))
          : ['同意', '允许', '可以读', '读吧', '批准', '看吧'],
        approvalTtlMs: Math.max(0, toNumber(files.approvalTtlMs, 600000)),
        noticeCooldownMs: Math.max(0, toNumber(files.noticeCooldownMs, 300000)),
      },
      skipMergedAttachments: gate.skipMergedAttachments !== false,
      botIds: Array.isArray(gate.botIds) ? gate.botIds.map((x) => String(x)).filter((x) => x !== '') : [],
    },
    voice: voiceBridge.resolveConfig({ ...(cfg.voice ?? {}) }),
    meme: {
      enabled: meme.enabled !== false,
      packDir: typeof meme.packDir === 'string' ? meme.packDir.trim() : '',
      chance: clamp01(toNumber(meme.chance, 0.6), 0.6),
      maxRecent: Math.max(1, toNumber(meme.maxRecent, 3)),
    },
    greeting: {
      enabled: greeting.enabled !== false,
      idleBaseMs: Math.max(60000, toNumber(greeting.idleBaseMs, 7200000)),
      jitterRatio: Math.min(1, Math.max(0, toNumber(greeting.jitterRatio, 0.4))),
      quietStartHour: Math.min(23, Math.max(0, Math.floor(toNumber(greeting.quietStartHour, 22)))),
      quietEndHour: Math.min(23, Math.max(0, Math.floor(toNumber(greeting.quietEndHour, 8)))),
      maxPerNight: Math.max(0, toNumber(greeting.maxPerNight, 3)),
      checkIntervalMs: Math.max(30000, toNumber(greeting.checkIntervalMs, 300000)),
      tzOffsetHours: toNumber(greeting.tzOffsetHours, 8),
      greetings: Array.isArray(greeting.greetings) ? greeting.greetings.map((x) => String(x)) : [],
    },
    drawing: {
      enabled: drawing.enabled !== false,
      baseUrl: drawing.baseUrl,
      characterPrompt: typeof drawing.characterPrompt === 'string' ? drawing.characterPrompt : DEFAULT_CHARACTER_PROMPT,
      characterKeywords: Array.isArray(drawing.characterKeywords) && drawing.characterKeywords.length > 0
        ? drawing.characterKeywords.map((x) => String(x))
        : ['蓝汐', '自拍', '头像', '女仆', '虎鲸', '本人'],
      apiKey: String(drawing.apiKey ?? '').trim(),
      model: String(drawing.model ?? '').trim(),
      size: String(drawing.size ?? '1024x1024').trim() || '1024x1024',
      protocol: ['auto', 'images', 'chat'].includes(drawing.protocol) ? drawing.protocol : 'auto',
      timeoutMs: Math.max(5000, toNumber(drawing.timeoutMs, 300000)),
    },
  }
}

function clamp01(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function withTimeout(ms, signal) {
  const timeout = AbortSignal.timeout(ms)
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
}

// ─────────────────────────── 频控闸 ───────────────────────────

/**
 * 全局注册表：热重载会重新执行本模块，这里保证 QQBot 原型上只有一层包装。
 * 每次 apply 只替换 controller（新代码 + 新配置），旧 controller 先 dispose。
 */
const REG_KEY = Symbol.for('@local/dsh-qqbot-fixes/registry')

function registry() {
  let reg = globalThis[REG_KEY]
  if (!reg) {
    reg = { controller: null, original: null, installed: false, QQBot: null }
    globalThis[REG_KEY] = reg
  }
  return reg
}

const FILLER_CHARS = new Set([...'嗯哦啊哈嘿额呃好行对是这那吧呢呀嘛噢喔哎诶欸啊哦哪咯呗'])

function emptyState() {
  return {
    version: 2,
    groups: {},
    totals: { passed: 0, blocked: 0, deferred: 0, byReason: {} },
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.groups) {
      const merged = emptyState()
      merged.groups = parsed.groups
      merged.totals = { ...emptyState().totals, ...(parsed.totals ?? {}) }
      merged.totals.byReason = { ...(parsed.totals?.byReason ?? {}) }
      return merged
    }
  } catch {
    // 文件不存在或损坏都从空状态开始
  }
  return emptyState()
}

function saveState(rt) {
  if (!rt.state) return
  try {
    mkdirSync(QQ_HOME, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(rt.state, null, 2), 'utf8')
  } catch (err) {
    log('状态落盘失败：' + (err?.message ?? err))
  }
}

function scheduleSave(rt) {
  if (rt.saveTimer !== null) clearTimeout(rt.saveTimer)
  rt.saveTimer = setTimeout(() => {
    rt.saveTimer = null
    saveState(rt)
  }, 1500)
  rt.saveTimer.unref?.()
}

/** 决策日志（排查用）：~/.dsh-qqbot/gate-log.jsonl，超过 1MB 轮转一次 */
function recordLog(entry) {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry })
    let size = 0
    try { size = statSync(LOG_FILE).size } catch { size = 0 }
    if (size > 1024 * 1024) {
      try { renameSync(LOG_FILE, LOG_FILE + '.1') } catch { /* ignore */ }
    }
    appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch {
    // 日志失败不影响主流程
  }
}

function createRuntime(cfg) {
  return {
    rid: randomUUID().slice(0, 6),
    cfg,
    lastBot: null,
    meme: { usage: new Map() },
    greeting: {
      cfg: cfg.greeting,
      state: loadGreetingState(),
      timer: null,
      saveTimer: null,
    },
    state: loadState(),
    pending: new Map(),
    /** 没随机到 / 被限速拦下的消息，等下次触发时一起送上：groupKey -> { lines } */
    backlog: new Map(),
    fileApprovals: new Map(),
    noticeAt: new Map(),
    saveTimer: null,
    disposed: false,
  }
}

function noteTotals(rt, reason, kind) {
  const totals = rt.state.totals
  if (kind === 'deferred') {
    totals.deferred += 1
  } else if (kind === 'blocked') {
    totals.blocked += 1
    totals.byReason[reason] = (totals.byReason[reason] ?? 0) + 1
  } else {
    totals.passed += 1
  }
}

function localDayKey(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function groupState(rt, groupKey, now) {
  const groups = rt.state.groups
  let st = groups[groupKey]
  if (!st) {
    st = { last: 0, hourKey: 0, dayKey: '', hourCount: 0, dayCount: 0 }
    groups[groupKey] = st
  }
  const hourKey = Math.floor(now / 3600000)
  const dayKey = localDayKey(now)
  if (st.hourKey !== hourKey) {
    st.hourKey = hourKey
    st.hourCount = 0
  }
  if (st.dayKey !== dayKey) {
    st.dayKey = dayKey
    st.dayCount = 0
  }
  return st
}

/** 去掉 @ 标记、表情标签、不可见字符后做判定。 */
function cleanText(rawContent) {
  return String(rawContent ?? '')
    .replace(/<faceType=[^>]*>/gi, ' ')
    .replace(/<@!?[^>]*>/g, ' ')
    .replace(/<[^>]{1,40}>/g, ' ')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .trim()
}

function isPurePunctuation(text) {
  return text !== '' && /^[\s\p{P}\p{S}]+$/u.test(text)
}

function isPureRepeat(text) {
  const chars = [...text.replace(/\s+/g, '')]
  if (chars.length === 0 || chars.length > 8) return false
  return chars.every((c) => c === chars[0])
}

function isFillerOnly(text) {
  const chars = [...text.replace(/[\s\p{P}\p{S}]/gu, '')]
  if (chars.length === 0) return false
  return chars.every((c) => FILLER_CHARS.has(c))
}

function isInvalidText(text, invalid) {
  if (!invalid.enabled) return false
  const t = String(text ?? '').trim()
  if (t === '') return true
  if ([...t].length < invalid.minLength) return true
  if (invalid.dropPurePunctuation && isPurePunctuation(t)) return true
  if (invalid.dropPureRepeat && isPureRepeat(t)) return true
  if (invalid.dropFiller && isFillerOnly(t)) return true
  return false
}

function looksMergedForward(raw) {
  if (!raw) return false
  if (raw.ark) return true
  const content = String(raw.content ?? '')
  return /合并转发|合并消息|\[合并\]|转发消息/.test(content)
}

function isApprovalText(text, keywords) {
  if (/不同意|不准|不行|别读|禁止|拒绝/.test(text)) return false
  return keywords.some((k) => text.includes(k))
}

/** 判定是否 @ 了机器人：只认指向机器人自己的 @（事件类型 / mentions.is_you / id 匹配） */
function detectMention(raw, botIds) {
  if (!raw) return { mentioned: false, tags: [], mentions: [], reason: 'no-raw' }
  const content = String(raw.content ?? '')
  const tags = [...content.matchAll(/<@!?([^>]{1,64})>/g)].map((m) => ({ text: m[0], id: m[1] }))
  const list = Array.isArray(raw.mentions) ? raw.mentions : []
  const mentions = list.map((m) => ({
    id: m?.id,
    is_you: m?.is_you,
    member_openid: m?.member_openid,
    user_openid: m?.user_openid,
    bot: m?.bot,
  }))
  const ids = new Set(botIds.map((x) => String(x)).filter((x) => x !== ''))

  if (raw.rawEventType === 'GROUP_AT_MESSAGE_CREATE') {
    return { mentioned: true, tags, mentions, reason: 'event' }
  }
  if (mentions.some((m) => m.is_you === true)) {
    return { mentioned: true, tags, mentions, reason: 'is_you' }
  }
  if (mentions.some((m) => [m.id, m.member_openid, m.user_openid].some((v) => v !== undefined && v !== '' && ids.has(String(v))))) {
    return { mentioned: true, tags, mentions, reason: 'mention-id' }
  }
  if (tags.some((t) => ids.has(t.id))) {
    return { mentioned: true, tags, mentions, reason: 'content-tag' }
  }
  return { mentioned: false, tags, mentions, reason: 'not-mentioned' }
}

function groupKeyOf(raw) {
  return String(raw?.groupOpenid ?? raw?.senderId ?? 'unknown-group')
}

function notifyNeedApproval(rt, bot, raw) {
  const files = rt.cfg.gate.files
  const key = groupKeyOf(raw)
  const now = Date.now()
  const last = rt.noticeAt.get(key) ?? 0
  if (now - last < files.noticeCooldownMs) return
  rt.noticeAt.set(key, now)
  const target = { scope: 'group', targetId: raw.groupOpenid, msgId: raw.messageId }
  const text = '收到文件/图片，需主人（管理员）回复「同意」后我才能读取。'
  try {
    Promise.resolve(bot.sendMarkdown(target, text)).catch((err) => {
      log('提示发送失败：' + (err?.message ?? err))
    })
  } catch (err) {
    log('提示发送异常：' + (err?.message ?? err))
  }
}

function appendBacklog(rt, key, lines) {
  let b = rt.backlog.get(key)
  if (!b) {
    b = { lines: [] }
    rt.backlog.set(key, b)
  }
  b.lines.push(...lines)
  const max = rt.cfg.gate.backlogMax
  if (max > 0 && b.lines.length > max) b.lines = b.lines.slice(-max)
}

function takeBacklog(rt, key) {
  const b = rt.backlog.get(key)
  if (!b || b.lines.length === 0) return []
  rt.backlog.delete(key)
  return b.lines
}

function backlogSize(rt, key) {
  const b = rt.backlog.get(key)
  return b ? b.lines.length : 0
}

function deferMerge(rt, bot, raw, text) {
  const key = groupKeyOf(raw)
  const debounceMs = rt.cfg.gate.debounceMs
  let st = rt.pending.get(key)
  if (!st) {
    st = { lines: [], lastRaw: raw, bot, timer: null }
    rt.pending.set(key, st)
  }
  const name = raw.senderName ?? raw.senderId ?? 'someone'
  st.lines.push(`[${name}] ${text}`)
  st.lastRaw = raw
  st.bot = bot
  if (st.timer) clearTimeout(st.timer)
  st.timer = setTimeout(() => fireMerge(rt, key), debounceMs)
  st.timer.unref?.()
  noteTotals(rt, 'deferred', 'deferred')
}

function fireMerge(rt, key) {
  const st = rt.pending.get(key)
  if (!st) return
  rt.pending.delete(key)
  if (rt.disposed || st.lines.length === 0) return
  const gate = rt.cfg.gate
  if (Math.random() > gate.chance) {
    appendBacklog(rt, key, st.lines)
    log('防抖到点，概率未过，' + st.lines.length + ' 条转入积压（共 ' + backlogSize(rt, key) + ' 条）')
    noteTotals(rt, 'chance', 'blocked')
    recordLog({ gid: key, decision: 'chance-block', count: st.lines.length, backlog: backlogSize(rt, key) })
    scheduleSave(rt)
    return
  }
  const lines = [...takeBacklog(rt, key), ...st.lines]
  const merged = lines.join('\n')
  const synthetic = { ...st.lastRaw, content: merged }
  log('防抖触发，本次送 ' + lines.length + ' 条（含积压）')
  noteTotals(rt, 'pass', 'passed')
  recordLog({ gid: key, decision: 'reply', count: lines.length, text: merged.slice(0, 200) })
  scheduleSave(rt)
  Promise.resolve()
    .then(() => registry().original.call(st.bot, synthetic))
    .catch((err) => {
      log('防抖重放失败：' + (err?.message ?? err))
      recordLog({ gid: key, decision: 'replay-error', error: String(err?.message ?? err) })
    })
}

function planInbound(rt, bot, raw) {
  if (raw) {
    rt.lastBot = bot
    if (raw.kind !== 'group' && rt.greeting.cfg.enabled) recordPeer(rt, raw)
  }
  const gate = rt.cfg?.gate
  if (!gate?.enabled) return { action: 'pass' }
  if (!raw || raw.kind !== 'group') return { action: 'pass' }

  const now = Date.now()
  const key = groupKeyOf(raw)
  const text = cleanText(raw.content)
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : []
  const senderId = String(raw.senderId ?? '')
  const senderName = raw.senderName ?? senderId
  const isAdmin = gate.files.adminOpenids.includes(senderId)
  const appId = String(bot?.appId ?? bot?.creds?.appId ?? '')
  const botIds = [appId, ...(gate.botIds ?? [])].filter((x) => x !== '')
  const mention = detectMention(raw, botIds)
  const mentioned = mention.mentioned
  const baseLog = {
    rid: rt.rid,
    gid: key,
    sender: senderId,
    event: raw.rawEventType,
    mentioned,
    mention: mention.reason,
    tags: mention.tags.slice(0, 3),
    mentions: mention.mentions.slice(0, 3),
    att: attachments.length,
    text: text.slice(0, 120),
  }
  const backlogLine = '[' + senderName + '] ' + text
  const toBacklog = () => appendBacklog(rt, key, [backlogLine])

  // 1) 管理员说「同意」：重放最近被拦下的文件消息
  if (isAdmin && !mentioned && isApprovalText(text, gate.files.approvalKeywords)) {
    const pending = rt.fileApprovals.get(key)
    if (pending && now - pending.at < gate.files.approvalTtlMs) {
      rt.fileApprovals.delete(key)
      log('管理员批准，重放文件消息')
      noteTotals(rt, 'approval', 'passed')
      recordLog({ ...baseLog, decision: 'approval-replay' })
      scheduleSave(rt)
      setTimeout(() => {
        Promise.resolve(registry().original.call(bot, pending.raw)).catch((err) => {
          log('批准重放失败：' + (err?.message ?? err))
        })
      }, 0)
      return { action: 'drop' }
    }
    log('管理员说了同意，但没有待读取的文件，忽略')
    recordLog({ ...baseLog, decision: 'approval-idle' })
    return { action: 'drop' }
  }

  // 2) 合并转发里不读附件
  if (attachments.length > 0 && gate.skipMergedAttachments && looksMergedForward(raw)) {
    log('合并转发消息，忽略附件只按文本处理')
    deferMerge(rt, bot, { ...raw, attachments: [] }, text)
    return { action: 'drop' }
  }

  // 3) 文件/图片：管理员本人直接读；其他人等管理员同意
  if (attachments.length > 0) {
    if (isAdmin) {
      noteTotals(rt, 'admin-file', 'passed')
      recordLog({ ...baseLog, decision: 'admin-file-pass' })
      return { action: 'pass' }
    }
    if (gate.files.requireAdminApproval) {
      rt.fileApprovals.set(key, { raw, at: now })
      notifyNeedApproval(rt, bot, raw)
      noteTotals(rt, 'file-blocked', 'blocked')
      recordLog({ ...baseLog, decision: 'file-blocked' })
      scheduleSave(rt)
      return { action: 'drop' }
    }
    return { action: 'pass' }
  }

  // 4) @ 机器人：直接放行，并把积压的群聊一起送进上下文
  if (mentioned) {
    const backlog = takeBacklog(rt, key)
    let passRaw = raw
    if (backlog.length > 0) {
      const current = String(raw.content ?? '')
      passRaw = {
        ...raw,
        content: '[近期群聊]\n' + backlog.join('\n') + '\n[当前消息]\n' + current,
      }
      log('@ 机器人放行，附带积压 ' + backlog.length + ' 条')
    }
    noteTotals(rt, 'mention', 'passed')
    recordLog({ ...baseLog, decision: 'mention-pass', backlog: backlog.length })
    scheduleSave(rt)
    return { action: 'pass', raw: passRaw }
  }

  // 5) 无效消息过滤（默认不进积压）
  if (isInvalidText(text, gate.invalid)) {
    if (gate.backlogInvalid) toBacklog()
    noteTotals(rt, 'invalid', 'blocked')
    recordLog({ ...baseLog, decision: 'invalid', backlog: backlogSize(rt, key) })
    scheduleSave(rt)
    return { action: 'drop' }
  }

  // 6) 限速（0 = 不限）：被拦的消息转进积压，等下次触发一起送
  const st = groupState(rt, key, now)
  if (gate.minIntervalMs > 0 && st.last !== 0 && now - st.last < gate.minIntervalMs) {
    toBacklog()
    noteTotals(rt, 'interval', 'blocked')
    recordLog({ ...baseLog, decision: 'interval', backlog: backlogSize(rt, key) })
    scheduleSave(rt)
    return { action: 'drop' }
  }
  if (gate.maxPerHour > 0 && st.hourCount >= gate.maxPerHour) {
    toBacklog()
    noteTotals(rt, 'hour', 'blocked')
    recordLog({ ...baseLog, decision: 'hour', backlog: backlogSize(rt, key) })
    scheduleSave(rt)
    return { action: 'drop' }
  }
  if (gate.maxPerDay > 0 && st.dayCount >= gate.maxPerDay) {
    toBacklog()
    noteTotals(rt, 'day', 'blocked')
    recordLog({ ...baseLog, decision: 'day', backlog: backlogSize(rt, key) })
    scheduleSave(rt)
    return { action: 'drop' }
  }
  st.last = now
  st.hourCount += 1
  st.dayCount += 1
  scheduleSave(rt)

  // 7) 30s 防抖合并
  deferMerge(rt, bot, raw, text)
  recordLog({ ...baseLog, decision: 'deferred', backlog: backlogSize(rt, key) })
  return { action: 'drop' }
}

function installGate(QQBot, rt) {
  const reg = registry()
  if (!reg.installed) {
    // 清掉历史热重载叠加的包装，只留最底层原始方法
    let base = QQBot.prototype.handleInboundMessage
    while (base && base.__qqbotFixesWrapper === true) base = base.__original
    reg.original = base && typeof base === 'function' ? base : QQBot.prototype.handleInboundMessage
    const wrapper = async function patchedHandleInboundMessage(raw) {
      const c = reg.controller
      if (c && !c.rt.disposed) {
        try {
          const plan = c.dispatch(this, raw)
          if (!plan || plan.action === 'drop') return
          return reg.original.call(this, plan.raw ?? raw)
        } catch (err) {
          log('闸判定异常，放行：' + (err?.message ?? err))
        }
      }
      return reg.original.call(this, raw)
    }
    wrapper.__qqbotFixesWrapper = true
    wrapper.__original = reg.original
    QQBot.prototype.handleInboundMessage = wrapper
    reg.installed = true
    reg.QQBot = QQBot
  }
  const previous = reg.controller
  if (previous && previous.rt !== rt) previous.dispose()
  reg.controller = {
    rt,
    dispatch: (bot, raw) => planInbound(rt, bot, raw),
    dispose: () => disposeRuntime(rt),
  }
  log('频控闸已安装（单层包装，配置已刷新）')
}

function disposeRuntime(rt) {
  if (rt.disposed) return
  rt.disposed = true
  for (const [, st] of rt.pending) {
    if (st.timer) clearTimeout(st.timer)
  }
  rt.pending.clear()
  rt.backlog.clear()
  rt.fileApprovals.clear()
  rt.noticeAt.clear()
  if (rt.saveTimer !== null) clearTimeout(rt.saveTimer)
  saveState(rt)
}

// ─────────────────────────── 表情包（dsh-meme 图库适配） ───────────────────────────

const MEME_DEFAULT_TAGS = ['daily', 'happy', 'angry', 'sad', 'confused', 'shy']

function expandHome(p) {
  const s = String(p ?? '')
  return s.startsWith('~') ? join(homedir(), s.slice(1).replace(/^[/\\]/, '')) : s
}

/**
 * 自动检索 dsh-meme 的图库目录，顺序：
 *   1. 配置 packDir
 *   2. DSH_HOME/dsh-expression.json 的 memeRoot / enabledPacks[0]
 *   3. 扫描 DSH_HOME/meme-packs/* 里带 memes 子目录的包
 *   4. 默认 ~/.dsh/meme-packs/meme-pair-dict
 */
function resolveMemeRoot(cfg) {
  if (typeof cfg.packDir === 'string' && cfg.packDir.trim() !== '') return expandHome(cfg.packDir.trim())
  const homes = [...new Set([process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean))]
  for (const home of homes) {
    try {
      const expr = JSON.parse(readFileSync(join(home, 'dsh-expression.json'), 'utf8'))
      if (typeof expr.memeRoot === 'string' && expr.memeRoot !== '') return expandHome(expr.memeRoot)
      if (Array.isArray(expr.enabledPacks) && typeof expr.enabledPacks[0] === 'string') {
        const root = join(home, 'meme-packs', expr.enabledPacks[0])
        if (readdirSync(join(root, 'memes')).length > 0) return root
      }
    } catch {
      // 继续找下一个
    }
  }
  for (const home of homes) {
    try {
      const packs = readdirSync(join(home, 'meme-packs'), { withFileTypes: true }).filter((d) => d.isDirectory())
      for (const pack of packs) {
        const root = join(home, 'meme-packs', pack.name)
        try {
          if (readdirSync(join(root, 'memes')).length > 0) return root
        } catch {
          // 这个包没有 memes 子目录
        }
      }
    } catch {
      // 没有 meme-packs 目录
    }
  }
  return join(homedir(), '.dsh', 'meme-packs', 'meme-pair-dict')
}

const MEME_EXT = /\.(gif|png|jpe?g|webp|bmp)$/i

/** 扫描图库：返回 [{ tag, path }] */
function listMemes(root) {
  const out = []
  const base = join(root, 'memes')
  let tags = []
  try {
    tags = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const tag of tags) {
    let files = []
    try {
      files = readdirSync(join(base, tag)).filter((f) => MEME_EXT.test(f))
    } catch {
      continue
    }
    for (const f of files) out.push({ tag, path: join(base, tag, f) })
  }
  return out
}

function pickMeme(root, { tag, query, exclude }) {
  const all = listMemes(root)
  if (all.length === 0) return null
  const tagFiltered = tag && tag !== 'any' ? all.filter((m) => m.tag === tag) : all
  const q = String(query ?? '').trim()
  const queryFiltered = q === '' ? tagFiltered : tagFiltered.filter((m) => m.path.toLowerCase().includes(q.toLowerCase()))
  const pool = queryFiltered.length > 0 ? queryFiltered : tagFiltered.length > 0 ? tagFiltered : all
  const fresh = pool.filter((m) => !exclude.includes(m.path))
  const candidates = fresh.length > 0 ? fresh : pool
  return candidates[Math.floor(Math.random() * candidates.length)]
}

function memeKeyOf(exec) {
  const agentId = exec?.agent?.id ?? exec?.agent?.session?.id
  return typeof agentId === 'string' && agentId !== '' ? 'agent:' + agentId : 'default'
}

function hashKey(key) {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) | 0
  return 'k' + (h >>> 0).toString(36)
}

function memeUsage(rt, key) {
  const store = rt.meme.usage
  let u = store.get(key)
  if (!u) {
    u = { last: 0, recent: [] }
    store.set(key, u)
  }
  return u
}

/** 频控：每条消息按概率决定带不带表情包 */
function memeChanceBlocked(rt) {
  const cfg = rt.cfg.meme
  return cfg.chance < 1 && Math.random() > cfg.chance
}

function noteMemeSent(rt, key, path) {
  const cfg = rt.cfg.meme
  const u = memeUsage(rt, key)
  u.last = Date.now()
  u.recent.push(path)
  if (u.recent.length > Math.max(1, cfg.maxRecent)) u.recent.shift()
}

// ─────────────────────────── 私聊主动问候 ───────────────────────────

const GREETING_STATE_FILE = process.env.DSH_QQBOT_GREETING_STATE || join(QQ_HOME, 'greeting-state.json')
const GREETING_CONFIG_FILE = process.env.DSH_QQBOT_GREETING_CONFIG || join(QQ_HOME, 'greeting-config.json')

const DEFAULT_GREETINGS = [
  '还没睡呀？',
  '在忙吗，主人。',
  '夜深了，记得喝口水。',
  '我还在呢，有事随时叫我。',
]

function loadGreetingState() {
  try {
    const parsed = JSON.parse(readFileSync(GREETING_STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.peers) return parsed
  } catch {
    // 文件不存在或损坏都从空状态开始
  }
  // 一次性迁移旧版 greeter-state.json（peers 是数组）；测试用 env 指定状态文件时不迁移
  if (process.env.DSH_QQBOT_GREETING_STATE !== undefined) return { version: 1, peers: {} }
  try {
    const legacy = JSON.parse(readFileSync(join(QQ_HOME, 'greeter-state.json'), 'utf8'))
    if (legacy && Array.isArray(legacy.peers)) {
      const peers = {}
      for (const p of legacy.peers) {
        if (!p || p.scope !== 'c2c' || typeof p.targetId !== 'string' || p.targetId === '') continue
        peers[p.targetId] = {
          lastAt: Number(p.lastActiveAt) || 0,
          name: '',
          greetedNight: '',
          count: 0,
          lastGreetedAt: Number(p.lastGreetAt) || 0,
        }
      }
      log('已迁移旧版问候状态：' + Object.keys(peers).length + ' 个私聊')
      return { version: 1, peers }
    }
  } catch {
    // 没有旧文件就跳过
  }
  return { version: 1, peers: {} }
}

function saveGreetingState(rt) {
  if (rt.greeting.saveTimer !== null) clearTimeout(rt.greeting.saveTimer)
  rt.greeting.saveTimer = setTimeout(() => {
    rt.greeting.saveTimer = null
    try {
      mkdirSync(QQ_HOME, { recursive: true })
      writeFileSync(GREETING_STATE_FILE, JSON.stringify(rt.greeting.state, null, 2), 'utf8')
    } catch (err) {
      log('问候状态落盘失败：' + (err?.message ?? err))
    }
  }, 1000)
  rt.greeting.saveTimer.unref?.()
}

function recordPeer(rt, raw) {
  const id = String(raw?.senderId ?? '')
  if (id === '') return
  const now = Date.now()
  const peers = rt.greeting.state.peers
  let p = peers[id]
  if (!p) {
    p = { lastAt: 0, name: '', greetedNight: '', count: 0, lastGreetedAt: 0 }
    peers[id] = p
  }
  p.lastAt = now
  if (typeof raw.senderName === 'string' && raw.senderName !== '') p.name = raw.senderName
  saveGreetingState(rt)
}

/** 时区偏移后的本地时间（用 UTC 字段读本地小时） */
function localHour(now, tzOffsetHours) {
  return new Date(now + tzOffsetHours * 3600_000).getUTCHours()
}

function inQuietWindow(hour, start, end) {
  if (start === end) return true
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** 夜晚归属：0 点~quietEndHour 归前一天，避免午夜重置额度 */
function nightKeyOf(now, tzOffsetHours, quietEndHour) {
  const shifted = new Date(now + tzOffsetHours * 3600_000)
  const hour = shifted.getUTCHours()
  let d = shifted
  if (hour < quietEndHour) d = new Date(shifted.getTime() - 24 * 3600_000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function pickGreeting(cfg) {
  const list = cfg.greetings.length > 0 ? cfg.greetings : DEFAULT_GREETINGS
  return list[Math.floor(Math.random() * list.length)]
}

function greetingSummary(rt) {
  const g = rt.greeting.cfg
  const peers = Object.entries(rt.greeting.state.peers)
  const now = Date.now()
  const nightKey = nightKeyOf(now, g.tzOffsetHours, g.quietEndHour)
  const rows = peers
    .map(([id, p]) => ({
      id,
      name: p.name || '',
      idleMinutes: p.lastAt ? Math.round((now - p.lastAt) / 60000) : null,
      countTonight: p.greetedNight === nightKey ? p.count : 0,
      lastGreetedAt: p.lastGreetedAt || null,
    }))
    .sort((a, b) => (b.idleMinutes ?? -1) - (a.idleMinutes ?? -1))
  return { nightKey, peers: rows }
}

function tickGreeting(rt) {
  const g = rt.greeting.cfg
  if (!g.enabled || !rt.lastBot) return
  const now = Date.now()
  const hour = localHour(now, g.tzOffsetHours)
  if (!inQuietWindow(hour, g.quietStartHour, g.quietEndHour)) return
  const nightKey = nightKeyOf(now, g.tzOffsetHours, g.quietEndHour)
  let changed = false

  for (const [id, p] of Object.entries(rt.greeting.state.peers)) {
    if (p.greetedNight !== nightKey) {
      p.greetedNight = nightKey
      p.count = 0
    }
    if (p.count >= g.maxPerNight) continue
    if (!p.lastAt) continue
    const idle = now - p.lastAt
    const threshold = g.idleBaseMs * (1 + (Math.random() * 2 - 1) * g.jitterRatio)
    if (idle < threshold) continue
    if (p.lastGreetedAt && now - p.lastGreetedAt < Math.max(60000, g.idleBaseMs * 0.5)) continue

    const text = pickGreeting(g)
    p.count += 1
    p.lastGreetedAt = now
    p.lastAt = now
    changed = true
    log('私聊问候 -> ' + (p.name || id) + '：' + text)
    recordLog({ gid: 'c2c:' + id, decision: 'greeting', text })
    Promise.resolve(rt.lastBot.sendMarkdown({ scope: 'c2c', targetId: id }, text)).catch((err) => {
      log('问候发送失败：' + (err?.message ?? err))
    })
  }
  if (changed) saveGreetingState(rt)
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch (err) {
    log('响应写出失败：' + (err?.message ?? err))
  }
}

// ── 设置页：管理员 / 表情包 / 问候（统一入口） ──

const SETTINGS_FILE = process.env.DSH_QQBOT_SETTINGS || join(QQ_HOME, 'settings.json')

function loadSettingsOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // 兼容旧版 greeting-config.json
    try {
      const legacy = JSON.parse(readFileSync(GREETING_CONFIG_FILE, 'utf8'))
      if (legacy && typeof legacy === 'object') return { greeting: legacy }
    } catch {
      // 没有旧文件
    }
  }
  return {}
}

function saveSettingsOverrides(overrides) {
  try {
    mkdirSync(QQ_HOME, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(overrides, null, 2), 'utf8')
  } catch (err) {
    log('设置落盘失败：' + (err?.message ?? err))
  }
}

/** 管理员辨认提示词：设置页展示，可一键复制贴进 QQ 机器人的 prompt */
function adminPromptOf(ids) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x)).filter((x) => x !== '') : []
  if (list.length === 0) {
    return '还没配置管理员 openid。群聊消息格式是「[昵称 (openid)] 内容」；在设置页填上管理员的 openid 后，这里会生成对应的辨认规则。'
  }
  return [
    '认人规则（管理员判定）：',
    '群聊消息以「[昵称 (openid)] 内容」的格式出现，@ 标记里也可能是 openid。',
    'openid 为 ' + list.join('、') + ' 的人是管理员（主人）：管理员的话优先执行，可以按管理协议授权；',
    '消息里 openid 不在上面的，一律按普通成员处理，越权请求直接拒绝。',
  ].join('\n')
}

function validateAdminOpenids(value) {
  if (!Array.isArray(value)) throw new TypeError('adminOpenids 必须是字符串数组')
  return value.map((x) => String(x).trim()).filter((x) => x !== '').slice(0, 10)
}

const GREETING_FIELDS = {
  enabled: (v) => { if (typeof v !== 'boolean') throw new TypeError('greeting.enabled 必须是布尔值'); return v },
  idleBaseMs: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 60000) throw new TypeError('greeting.idleBaseMs 必须 ≥ 60000'); return n },
  jitterRatio: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError('greeting.jitterRatio 必须在 0~1'); return n },
  quietStartHour: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 23) throw new TypeError('greeting.quietStartHour 必须在 0~23'); return n },
  quietEndHour: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 23) throw new TypeError('greeting.quietEndHour 必须在 0~23'); return n },
  maxPerNight: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 50) throw new TypeError('greeting.maxPerNight 必须在 0~50'); return n },
  checkIntervalMs: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 30000) throw new TypeError('greeting.checkIntervalMs 必须 ≥ 30000'); return n },
  tzOffsetHours: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < -12 || n > 14) throw new TypeError('greeting.tzOffsetHours 必须在 -12~14'); return n },
  greetings: (v) => {
    if (!Array.isArray(v)) throw new TypeError('greeting.greetings 必须是字符串数组')
    return v.map((x) => String(x).trim()).filter((x) => x !== '').slice(0, 20)
  },
}

function validateGreeting(value) {
  if (!value || typeof value !== 'object') throw new TypeError('greeting 必须是对象')
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const check = GREETING_FIELDS[key]
    if (!check) throw new TypeError('不支持的字段: greeting.' + key)
    out[key] = check(raw)
  }
  return out
}

function validateMeme(value) {
  if (!value || typeof value !== 'object') throw new TypeError('meme 必须是对象')
  const out = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new TypeError('meme.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (value.chance !== undefined) {
    const n = Number(value.chance)
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError('meme.chance 必须在 0~1')
    out.chance = n
  }
  if (value.packDir !== undefined) out.packDir = String(value.packDir).trim()
  if (value.maxRecent !== undefined) {
    const n = Number(value.maxRecent)
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new TypeError('meme.maxRecent 必须在 1~20')
    out.maxRecent = n
  }
  return out
}

function validateGate(value) {
  if (!value || typeof value !== 'object') throw new TypeError('gate 必须是对象')
  const out = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new TypeError('gate.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (value.chance !== undefined) {
    const n = Number(value.chance)
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError('gate.chance 必须在 0~1')
    out.chance = n
  }
  if (value.debounceMs !== undefined) {
    const n = Number(value.debounceMs)
    if (!Number.isFinite(n) || n < 5000) throw new TypeError('gate.debounceMs 必须 ≥ 5000')
    out.debounceMs = n
  }
  if (value.invalid !== undefined) {
    if (!value.invalid || typeof value.invalid !== 'object') throw new TypeError('gate.invalid 必须是对象')
    if (value.invalid.enabled !== undefined) {
      if (typeof value.invalid.enabled !== 'boolean') throw new TypeError('gate.invalid.enabled 必须是布尔值')
      out.invalid = { enabled: value.invalid.enabled }
    }
  }
  if (value.files !== undefined) {
    if (!value.files || typeof value.files !== 'object') throw new TypeError('gate.files 必须是对象')
    if (value.files.requireAdminApproval !== undefined) {
      if (typeof value.files.requireAdminApproval !== 'boolean') throw new TypeError('gate.files.requireAdminApproval 必须是布尔值')
      out.files = { requireAdminApproval: value.files.requireAdminApproval }
    }
  }
  return out
}

function validateDrawing(value) {
  if (!value || typeof value !== 'object') throw new TypeError('drawing 必须是对象')
  const out = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new TypeError('drawing.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (value.baseUrl !== undefined) out.baseUrl = normalizeBaseUrl(String(value.baseUrl))
  if (value.apiKey !== undefined) out.apiKey = String(value.apiKey).trim()
  if (value.model !== undefined) out.model = String(value.model).trim()
  if (value.size !== undefined) out.size = String(value.size).trim()
  if (value.protocol !== undefined) {
    if (!['auto', 'images', 'chat'].includes(value.protocol)) throw new TypeError('drawing.protocol 只能是 auto/images/chat')
    out.protocol = value.protocol
  }
  if (value.timeoutMs !== undefined) {
    const n = Number(value.timeoutMs)
    if (!Number.isFinite(n) || n < 5000) throw new TypeError('drawing.timeoutMs 必须 ≥ 5000')
    out.timeoutMs = n
  }
  return out
}

function validateVoice(value) {
  if (!value || typeof value !== 'object') throw new TypeError('voice 必须是对象')
  const out = {}
  const str = (key) => { if (value[key] !== undefined) out[key] = String(value[key]).trim() }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new TypeError('voice.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (value.ttsBaseUrl !== undefined) out.ttsBaseUrl = normalizeBaseUrl(String(value.ttsBaseUrl))
  if (value.asrBaseUrl !== undefined) out.asrBaseUrl = normalizeBaseUrl(String(value.asrBaseUrl))
  for (const key of ['ttsApiKey', 'ttsModel', 'ttsVoice', 'ttsFormat', 'asrApiKey', 'asrModel']) str(key)
  if (value.ttsProtocol !== undefined) {
    if (!['gptsovits', 'openai'].includes(value.ttsProtocol)) throw new TypeError('voice.ttsProtocol 只能是 gptsovits/openai')
    out.ttsProtocol = value.ttsProtocol
  }
  if (value.autoSend !== undefined) {
    if (typeof value.autoSend !== 'boolean') throw new TypeError('voice.autoSend 必须是布尔值')
    out.autoSend = value.autoSend
  }
  if (value.timeoutMs !== undefined) {
    const n = Number(value.timeoutMs)
    if (!Number.isFinite(n) || n < 3000) throw new TypeError('voice.timeoutMs 必须 ≥ 3000')
    out.timeoutMs = n
  }
  return out
}

const SETTINGS_VALIDATORS = {
  adminOpenids: validateAdminOpenids,
  gate: validateGate,
  meme: validateMeme,
  voice: validateVoice,
  drawing: validateDrawing,
  greeting: validateGreeting,
}

function settingsSnapshot(rt) {
  const adminOpenids = rt.cfg.gate.files.adminOpenids
  return {
    adminOpenids,
    adminPrompt: adminPromptOf(adminOpenids),
    meme: {
      enabled: rt.cfg.meme.enabled,
      chance: rt.cfg.meme.chance,
      packDir: rt.cfg.meme.packDir,
      maxRecent: rt.cfg.meme.maxRecent,
      resolvedPackDir: resolveMemeRoot(rt.cfg.meme),
    },
    gate: {
      enabled: rt.cfg.gate.enabled,
      chance: rt.cfg.gate.chance,
      debounceMs: rt.cfg.gate.debounceMs,
      invalid: rt.cfg.gate.invalid,
      files: { requireAdminApproval: rt.cfg.gate.files.requireAdminApproval },
    },
    drawing: {
      enabled: rt.cfg.drawing.enabled,
      baseUrl: rt.cfg.drawing.baseUrl,
      apiKey: rt.cfg.drawing.apiKey,
      model: rt.cfg.drawing.model,
      size: rt.cfg.drawing.size,
      protocol: rt.cfg.drawing.protocol,
      timeoutMs: rt.cfg.drawing.timeoutMs,
    },
    voice: { ...rt.cfg.voice },
    greeting: rt.greeting.cfg,
    greetingState: greetingSummary(rt),
  }
}

async function handleSettingsRoute(rt, req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, settingsSnapshot(rt))
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, error: '请求体解析失败：' + (err?.message ?? err) })
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
    return
  }
  const next = {}
  for (const [key, value] of Object.entries(body)) {
    const check = SETTINGS_VALIDATORS[key]
    if (!check) {
      sendJson(res, 400, { ok: false, error: '不支持的字段: ' + key })
      return
    }
    try {
      next[key] = check(value)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof TypeError ? err.message : String(err) })
      return
    }
  }

  if (next.adminOpenids !== undefined) rt.cfg.gate.files.adminOpenids = next.adminOpenids
  if (next.gate !== undefined) {
    if (next.gate.enabled !== undefined) rt.cfg.gate.enabled = next.gate.enabled
    if (next.gate.chance !== undefined) rt.cfg.gate.chance = next.gate.chance
    if (next.gate.debounceMs !== undefined) rt.cfg.gate.debounceMs = next.gate.debounceMs
    if (next.gate.invalid !== undefined) Object.assign(rt.cfg.gate.invalid, next.gate.invalid)
    if (next.gate.files !== undefined) Object.assign(rt.cfg.gate.files, next.gate.files)
  }
  if (next.meme !== undefined) Object.assign(rt.cfg.meme, next.meme)
  if (next.drawing !== undefined) Object.assign(rt.cfg.drawing, next.drawing)
  if (next.voice !== undefined) {
    Object.assign(rt.cfg.voice, next.voice)
    // 重新归一化（baseUrl 补协议、非法项回落），并原地写回，保证工具闭包看到新值
    Object.assign(rt.cfg.voice, voiceBridge.resolveConfig(rt.cfg.voice))
  }
  if (next.greeting !== undefined) {
    Object.assign(rt.greeting.cfg, next.greeting)
    if (next.greeting.checkIntervalMs !== undefined) {
      if (rt.greeting.timer !== null) clearInterval(rt.greeting.timer)
      rt.greeting.timer = setInterval(() => tickGreeting(rt), rt.greeting.cfg.checkIntervalMs)
      rt.greeting.timer.unref?.()
    }
  }

  const overrides = loadSettingsOverrides()
  if (next.adminOpenids !== undefined) overrides.adminOpenids = next.adminOpenids
  if (next.gate !== undefined) overrides.gate = { ...(overrides.gate ?? {}), ...next.gate }
  if (next.meme !== undefined) overrides.meme = { ...(overrides.meme ?? {}), ...next.meme }
  if (next.drawing !== undefined) overrides.drawing = { ...(overrides.drawing ?? {}), ...next.drawing }
  if (next.voice !== undefined) overrides.voice = { ...(overrides.voice ?? {}), ...next.voice }
  if (next.greeting !== undefined) overrides.greeting = { ...(overrides.greeting ?? {}), ...next.greeting }
  saveSettingsOverrides(overrides)

  log('设置已更新：' + Object.keys(next).join(', '))
  sendJson(res, 200, { ok: true, ...settingsSnapshot(rt) })
}

function registerSettingsRoutes(ctx, rt) {
  const inject = ctx.inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['webServer'], (scoped) => {
    const webServer = scoped.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const dispose = webServer.register({
      kind: 'exact',
      path: '/qqbot-fixes/settings',
      handler: (req, res) => { void handleSettingsRoute(rt, req, res) },
    })
    scoped.effect(() => dispose, 'qqbot-fixes.settings-routes')
  })
}

// ─────────────────────────── 语音（外接 TTS / ASR，QQ 语音条） ───────────────────────────
// 原 @local/dsh-voice-qq-bridge 的逻辑并入本插件，保持一次性安装即可用。
// 提供 qq_voice_say / qq_voice_stt / qq_voice_status 三个工具。

const voiceBridge = (() => {

/** QQ 插件固定媒体根目录（qqbot_send_file 路径白名单默认允许） */
const QQ_MEDIA_ROOT = resolve(homedir(), '.dsh-qqbot', 'media')

/** 支持的音频扩展名 */
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.amr', '.silk', '.slk', '.m4a', '.flac', '.webm'])

const ASR_MAX_BYTES = 25 * 1024 * 1024

/** GPT-SoVITS 单次请求的安全文本长度（实测约 500 字上限，留余量） */
const SOVITS_CHUNK_CHARS = 400

/** 取配置字符串，空串回落到环境变量，再回落到默认值。 */
function pick(configValue, envName, fallback) {
  if (typeof configValue === 'string' && configValue.trim() !== '') return configValue.trim()
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return fallback
}

/** 归一化 baseUrl：去尾斜杠，缺协议时补 https:// */
function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return 'https://' + trimmed
}

/** 解析并校验配置，非法项逐项回落，不影响其余字段。 */
function resolveConfig(config, warn = (m) => console.warn('[voice-qq-bridge] ' + m)) {
  const cfg = config ?? {}
  const ttsBaseUrl = normalizeBaseUrl(pick(cfg.ttsBaseUrl, 'DSH_VOICE_TTS_BASE', ''))
  const ttsApiKey = pick(cfg.ttsApiKey, 'DSH_VOICE_TTS_KEY', '')
  const rawProtocol = pick(cfg.ttsProtocol, 'DSH_VOICE_TTS_PROTOCOL', 'gptsovits').toLowerCase()
  const ttsProtocol = rawProtocol === 'openai' ? 'openai' : 'gptsovits'
  const ttsModel = pick(cfg.ttsModel, 'DSH_VOICE_TTS_MODEL', '')
  const ttsVoice = pick(cfg.ttsVoice, 'DSH_VOICE_TTS_VOICE', 'default')
  const rawFormat = pick(cfg.ttsFormat, 'DSH_VOICE_TTS_FORMAT', 'wav').toLowerCase()
  const ttsFormat = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'].includes(rawFormat) ? rawFormat : 'wav'
  const asrBaseUrl = normalizeBaseUrl(pick(cfg.asrBaseUrl, 'DSH_VOICE_ASR_BASE', ''))
  const asrApiKey = pick(cfg.asrApiKey, 'DSH_VOICE_ASR_KEY', '')
  const asrModel = pick(cfg.asrModel, 'DSH_VOICE_ASR_MODEL', 'whisper-large-v3-turbo')
  const autoSend = cfg.autoSend !== false
  let timeoutMs = 120000
  if (cfg.timeoutMs !== undefined) {
    if (typeof cfg.timeoutMs !== 'number' || !Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
      warn('timeoutMs 不合法（需大于 0 的毫秒数），已回落 120000。')
    } else {
      timeoutMs = Math.min(10 * 60 * 1000, Math.max(3000, Math.round(cfg.timeoutMs)))
    }
  }
  return { enabled: cfg.enabled !== false, ttsBaseUrl, ttsApiKey, ttsProtocol, ttsModel, ttsVoice, ttsFormat, asrBaseUrl, asrApiKey, asrModel, autoSend, timeoutMs }
}

/** 组合超时与外部取消信号。 */
function withTimeout(ms, outer) {
  const timer = AbortSignal.timeout(ms)
  return outer === undefined ? timer : AbortSignal.any([timer, outer])
}

/** 把任意错误压成一句可读中文。 */
function describeError(err) {
  if (err === undefined || err === null) return '未知错误'
  const cause = err.cause && (err.cause.code || err.cause.message)
  return String(err.message ?? err) + (cause ? '（' + cause + '）' : '')
}

/** 读取 HTTP 错误体，截断到 300 字符。 */
async function readErrorBody(response) {
  try {
    const text = await response.text()
    return text.trim().slice(0, 300)
  } catch {
    return ''
  }
}

/** 从 JSON 错误体里提取 error 字段，提取不到就返回原文。 */
function extractApiError(detail) {
  if (!detail) return ''
  try {
    const parsed = JSON.parse(detail)
    if (parsed && typeof parsed.error === 'string') return parsed.error
  } catch {
    /* 非 JSON，原样返回 */
  }
  return detail
}

// ─────────────────────────── WAV 拼接 ───────────────────────────

/** 解析 WAV：返回格式信息与 data 段偏移/长度。非 WAV 返回 undefined。 */
function parseWav(buffer) {
  if (buffer.length < 44) return undefined
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return undefined
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return undefined
  const info = {
    channels: buffer.readUInt16LE(22),
    sampleRate: buffer.readUInt32LE(24),
    bitsPerSample: buffer.readUInt16LE(34),
    dataOffset: 0,
    dataLength: 0,
  }
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      info.dataOffset = offset + 8
      info.dataLength = Math.min(size, buffer.length - offset - 8)
      return info
    }
    offset += 8 + size + (size % 2)
  }
  return undefined
}

/** 构造 44 字节 WAV 头。 */
function buildWavHeader({ channels, sampleRate, bitsPerSample }, dataLength) {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataLength, 40)
  return header
}

/** 按静音间隔拼接多段 WAV；格式不一致时退回第一段（保证可播放）。 */
function concatWav(buffers, gapMs = 250) {
  const parsed = buffers.map(parseWav)
  if (parsed.some((p) => p === undefined)) return undefined
  const first = parsed[0]
  const sameFormat = parsed.every(
    (p) => p.channels === first.channels && p.sampleRate === first.sampleRate && p.bitsPerSample === first.bitsPerSample,
  )
  if (!sameFormat) return buffers[0]
  const bytesPerSample = first.channels * (first.bitsPerSample / 8)
  const gapBytes = Math.round((gapMs / 1000) * first.sampleRate) * bytesPerSample
  const gap = Buffer.alloc(gapBytes)
  const parts = []
  let total = 0
  for (let i = 0; i < buffers.length; i++) {
    const info = parsed[i]
    const data = buffers[i].subarray(info.dataOffset, info.dataOffset + info.dataLength)
    if (i > 0 && gapBytes > 0) {
      parts.push(gap)
      total += gapBytes
    }
    parts.push(data)
    total += data.length
  }
  return Buffer.concat([buildWavHeader(first, total), ...parts])
}

/** 按句末标点切分文本，保证每段不超过 limit 字符。 */
function splitText(text, limit = SOVITS_CHUNK_CHARS) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return []
  if (clean.length <= limit) return [clean]
  const sentences = clean.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) ?? [clean]
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current !== '') {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < sentence.length; i += limit) chunks.push(sentence.slice(i, i + limit))
      continue
    }
    if ((current + sentence).length > limit) {
      chunks.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

// ─────────────────────────── TTS ───────────────────────────

/** 单次 GPT-SoVITS 合成（不分段）。 */
async function sovitsOnce(cfg, { text, ref, speed }, signal) {
  const body = { text }
  if (typeof ref === 'string' && ref !== '') body.ref = ref
  if (typeof speed === 'number' && Number.isFinite(speed)) body.speed = speed
  const headers = { 'content-type': 'application/json' }
  if (cfg.ttsApiKey !== '') headers.authorization = 'Bearer ' + cfg.ttsApiKey
  const response = await fetch(cfg.ttsBaseUrl + '/tts', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: withTimeout(cfg.timeoutMs, signal),
  })
  if (!response.ok) {
    const detail = extractApiError(await readErrorBody(response))
    throw new Error('TTS 接口返回 HTTP ' + response.status + (detail ? '：' + detail : ''))
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('TTS 接口返回了空音频。')
  return bytes
}

/** 单次 OpenAI 兼容合成（不分段）。 */
async function openaiOnce(cfg, { text, voice, model, format, speed }, signal) {
  const body = {
    model: model ?? cfg.ttsModel,
    voice: voice ?? cfg.ttsVoice,
    input: text,
    response_format: format ?? cfg.ttsFormat,
  }
  if (typeof speed === 'number' && Number.isFinite(speed)) body.speed = speed
  const response = await fetch(cfg.ttsBaseUrl + '/audio/speech', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + cfg.ttsApiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(cfg.timeoutMs, signal),
  })
  if (!response.ok) {
    const detail = extractApiError(await readErrorBody(response))
    throw new Error('TTS 接口返回 HTTP ' + response.status + (detail ? '：' + detail : ''))
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('TTS 接口返回了空音频。')
  return bytes
}

/** 合成入口：自动分段，WAV 会自动拼接。 */
async function synthesize(cfg, options, signal) {
  if (cfg.ttsBaseUrl === '') throw new Error('未配置 TTS 接口地址：请在 cordis.patch.yml 填 ttsBaseUrl，或设置环境变量 DSH_VOICE_TTS_BASE。')
  const chunks = cfg.ttsProtocol === 'gptsovits' ? splitText(options.text) : [options.text]
  if (chunks.length === 0) throw new Error('要合成的文本为空。')
  const parts = []
  for (const chunk of chunks) {
    const bytes = cfg.ttsProtocol === 'gptsovits'
      ? await sovitsOnce(cfg, { ...options, text: chunk }, signal)
      : await openaiOnce(cfg, { ...options, text: chunk }, signal)
    parts.push(bytes)
  }
  if (parts.length === 1) return { audio: parts[0], chunks: 1 }
  const merged = concatWav(parts)
  return { audio: merged ?? parts[0], chunks: parts.length }
}

// ─────────────────────────── ASR ───────────────────────────

/** 扩展名 → MIME。 */
function mimeOf(path) {
  switch (extname(path).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.ogg': return 'audio/ogg'
    case '.aac': return 'audio/aac'
    case '.amr': return 'audio/amr'
    case '.silk':
    case '.slk': return 'audio/silk'
    case '.m4a': return 'audio/mp4'
    case '.flac': return 'audio/flac'
    case '.webm': return 'audio/webm'
    default: return 'application/octet-stream'
  }
}

/** 调用 OpenAI 兼容 /audio/transcriptions 转写音频。 */
async function transcribe(cfg, { audioPath, language, prompt, model }, signal) {
  if (cfg.asrBaseUrl === '') throw new Error('未配置 ASR 接口地址：当前语音服务只提供 TTS，转写需要另配一个 OpenAI 兼容 ASR 端点（如 Groq whisper），填 asrBaseUrl 或设环境变量 DSH_VOICE_ASR_BASE。')
  if (cfg.asrApiKey === '') throw new Error('未配置 ASR 密钥：请在配置里填 asrApiKey，或设置环境变量 DSH_VOICE_ASR_KEY。')
  const bytes = readFileSync(audioPath)
  if (bytes.length === 0) throw new Error('音频文件为空：' + audioPath)
  if (bytes.length > ASR_MAX_BYTES) throw new Error('音频超过 25MB 上限，请先压缩后再转写。')
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeOf(audioPath) }), basename(audioPath))
  form.append('model', model ?? cfg.asrModel)
  if (typeof language === 'string' && language !== '') form.append('language', language)
  if (typeof prompt === 'string' && prompt !== '') form.append('prompt', prompt)
  const response = await fetch(cfg.asrBaseUrl + '/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + cfg.asrApiKey },
    body: form,
    signal: withTimeout(cfg.timeoutMs, signal),
  })
  if (!response.ok) {
    const detail = extractApiError(await readErrorBody(response))
    throw new Error('ASR 接口返回 HTTP ' + response.status + (detail ? '：' + detail : ''))
  }
  const payload = await response.json()
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (text === '') throw new Error('ASR 接口没有返回转写文本。')
  return { text, model: model ?? cfg.asrModel }
}

// ─────────────────────────── QQ 发送 ───────────────────────────

/** 生成落到 QQ 媒体目录的输出路径（该目录在 qqbot_send_file 白名单内）。 */
function mediaOutputPath(extension, stem) {
  mkdirSync(QQ_MEDIA_ROOT, { recursive: true })
  const safeStem = String(stem ?? 'qq-voice').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'qq-voice'
  return join(QQ_MEDIA_ROOT, safeStem + '-' + Date.now() + '-' + randomUUID().slice(0, 8) + '.' + extension)
}

/** 通过 tools 服务把文件发给当前 QQ 会话（复用 qqbot_send_file）。 */
async function sendToQq(ctx, filePath, exec) {
  const tools = ctx.get('tools')
  if (!tools?.execute) return { sent: false, reason: 'tools 服务不可用' }
  if (tools.get?.('qqbot_send_file') === undefined) {
    return { sent: false, reason: 'qqbot_send_file 未注册（QQ 机器人插件未启用？）' }
  }
  try {
    const result = await tools.execute({
      callId: 'voice-qq-bridge-' + randomUUID(),
      name: 'qqbot_send_file',
      arguments: { file_path: filePath },
      agent: exec?.agent,
      signal: exec?.signal ?? new AbortController().signal,
    })
    if (result?.isError === true) {
      return { sent: false, reason: result.error?.message ?? '未知错误' }
    }
    return { sent: true }
  } catch (err) {
    return { sent: false, reason: describeError(err) }
  }
}

// ─────────────────────────── 工具定义 ───────────────────────────

function buildTools(cfg, ctx, logger) {
  const engineHint = cfg.ttsProtocol === 'gptsovits'
    ? '当前引擎 GPT-SoVITS：speed 是时长倍率，<1 更快、>1 更慢；单段超过 ' + SOVITS_CHUNK_CHARS + ' 字会自动分段并拼接。'
    : '当前引擎 OpenAI 兼容：speed 为常规倍率，>1 更快。'

  const voiceSay = {
    name: 'qq_voice_say',
    description:
      '把文本合成为语音并（默认）以 QQ 语音条发到当前会话，走配置的外接语音 API。'
      + '适合「用语音回复我」「念一下这段」这类要求；纯文字回复不要调用。' + engineHint,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要朗读的文本（必填，超长会自动分段）。' },
        ref: { type: 'string', description: 'GPT-SoVITS 参考音色 preset（可选，默认取配置 ttsVoice，如 default / sad / nervous / surprise）。' },
        voice: { type: 'string', description: 'OpenAI 兼容协议的音色 id（可选）。' },
        speed: { type: 'number', description: '语速参数（可选，语义随引擎，见工具说明）。' },
        send: { type: 'boolean', description: '是否自动发到当前 QQ 会话（可选，默认取配置 autoSend）。' },
        output: { type: 'string', description: '自定义输出音频绝对路径（可选，默认写入 QQ 媒体目录）。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          chunks: { type: 'integer' },
          engine: { type: 'string' },
          sent: { type: 'boolean' },
          sendError: { type: 'string' },
        },
        required: ['path', 'bytes', 'chunks', 'engine', 'sent'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value ?? {}
        const lines = ['语音已生成：' + v.path + '（' + v.bytes + ' 字节，' + v.chunks + ' 段，引擎 ' + v.engine + '）']
        if (v.sent === true) lines.push('已作为 QQ 语音条发送到当前会话。')
        else if (v.sendError) lines.push('未自动发送：' + v.sendError)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text === '') throw new Error('qq_voice_say: text 必填。')
      const ref = typeof args.ref === 'string' && args.ref !== '' ? args.ref : cfg.ttsVoice
      const voice = typeof args.voice === 'string' && args.voice !== '' ? args.voice : cfg.ttsVoice
      const speed = typeof args.speed === 'number' && Number.isFinite(args.speed) ? args.speed : undefined
      const { audio, chunks } = await synthesize(cfg, { text, ref, voice, speed, format: cfg.ttsFormat, model: cfg.ttsModel }, exec?.signal)
      const extension = cfg.ttsProtocol === 'gptsovits' ? 'wav' : (cfg.ttsFormat === 'pcm' ? 'wav' : cfg.ttsFormat)
      const target = typeof args.output === 'string' && args.output.trim() !== ''
        ? resolve(args.output.trim())
        : mediaOutputPath(extension, 'qq-voice')
      writeFileSync(target, audio)
      const shouldSend = typeof args.send === 'boolean' ? args.send : cfg.autoSend
      let sent = false
      let sendError
      if (shouldSend) {
        const outcome = await sendToQq(ctx, target, exec)
        sent = outcome.sent
        if (!sent) {
          sendError = outcome.reason
          logger?.warn?.('voice-qq-bridge: 自动发送失败：' + sendError)
        }
      }
      return { path: target, bytes: audio.length, chunks, engine: cfg.ttsProtocol, sent, ...(sendError ? { sendError } : {}) }
    },
    timeoutMs: cfg.timeoutMs + 30000,
  }

  const voiceStt = {
    name: 'qq_voice_stt',
    description:
      '把本地音频文件转写为文字，走配置的 OpenAI 兼容 ASR 接口。'
      + '注意：当前 TTS 服务不提供转写，需另配 asrBaseUrl；QQ 语音消息也不会自动下载到本地，'
      + '请让用户把语音另存/转发为音频文件后提供路径。',
    parameters: {
      type: 'object',
      properties: {
        audio: { type: 'string', description: '音频文件路径（必填，绝对路径或相对会话工作目录）。' },
        language: { type: 'string', description: '语言提示（可选，如 zh）。' },
        prompt: { type: 'string', description: '提示词，用于专有名词纠偏（可选）。' },
        model: { type: 'string', description: 'ASR 模型（可选，默认取配置 asrModel）。' },
        output: { type: 'string', description: '把转写文本写成 .txt 的路径（可选）。' },
      },
      required: ['audio'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          audio: { type: 'string' },
          textFile: { type: 'string' },
        },
        required: ['text', 'model', 'audio'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value ?? {}
        const lines = ['转写完成（模型 ' + v.model + '）：', v.text]
        if (v.textFile) lines.push('', '已写入：' + v.textFile)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const audio = typeof args.audio === 'string' ? args.audio.trim() : ''
      if (audio === '') throw new Error('qq_voice_stt: audio 必填。')
      const audioPath = resolve(audio)
      const ext = extname(audioPath).toLowerCase()
      if (!AUDIO_EXTS.has(ext)) {
        throw new Error('qq_voice_stt: 不支持的音频格式 ' + (ext || '(无扩展名)') + '。支持：' + [...AUDIO_EXTS].join(' '))
      }
      statSync(audioPath)
      const result = await transcribe(cfg, {
        audioPath,
        language: typeof args.language === 'string' ? args.language : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        model: typeof args.model === 'string' && args.model !== '' ? args.model : cfg.asrModel,
      }, exec?.signal)
      let textFile
      if (typeof args.output === 'string' && args.output.trim() !== '') {
        textFile = resolve(args.output.trim())
        writeFileSync(textFile, result.text, 'utf8')
      }
      return { text: result.text, model: result.model, audio: audioPath, ...(textFile ? { textFile } : {}) }
    },
    timeoutMs: cfg.timeoutMs + 30000,
  }

  const voiceStatus = {
    name: 'qq_voice_status',
    description: '检查外接语音 API 配置是否就绪（TTS / ASR 接口地址、协议、密钥、QQ 发送通道），不发起网络请求。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ttsReady: { type: 'boolean' },
          asrReady: { type: 'boolean' },
          qqSendReady: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['ttsReady', 'asrReady', 'qqSendReady', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
    },
    async execute() {
      const tools = ctx.get('tools')
      const qqSendReady = tools?.get?.('qqbot_send_file') !== undefined
      const ttsReady = cfg.ttsBaseUrl !== ''
      const asrReady = cfg.asrBaseUrl !== '' && cfg.asrApiKey !== ''
      const lines = [
        'TTS：' + (ttsReady
          ? '就绪（' + cfg.ttsProtocol + ' @ ' + cfg.ttsBaseUrl + (cfg.ttsApiKey !== '' ? '，已带密钥' : '，无密钥') + (cfg.ttsProtocol === 'gptsovits' ? '，默认音色 ' + cfg.ttsVoice : '') + '）'
          : '未就绪（缺 ttsBaseUrl）'),
        'ASR：' + (asrReady ? '就绪（' + cfg.asrBaseUrl + '，模型 ' + cfg.asrModel + '）' : '未配置（当前语音服务只提供 TTS，转写需另配 OpenAI 兼容 ASR 端点）'),
        'QQ 发送：' + (qqSendReady ? '就绪（qqbot_send_file 已注册）' : '未就绪（QQ 机器人插件未启用）'),
        '自动发送：' + (cfg.autoSend ? '开' : '关'),
      ]
      return { ttsReady, asrReady, qqSendReady, summary: lines.join('\n') }
    },
  }

  return [voiceSay, voiceStt, voiceStatus]
}


  return { resolveConfig, buildTools }
})()

// ─────────────────────────── 绘图 ───────────────────────────

function pickImageExt(mime, bytes) {
  if (bytes && bytes.length >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif'
  }
  const m = /image\/(png|jpe?g|webp|gif)/i.exec(String(mime ?? ''))
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
  return 'png'
}

function saveImage(bytes, mime) {
  mkdirSync(MEDIA_ROOT, { recursive: true })
  const ext = pickImageExt(mime, bytes)
  const path = join(MEDIA_ROOT, 'draw-' + Date.now() + '-' + randomUUID().slice(0, 8) + '.' + ext)
  writeFileSync(path, bytes)
  return path
}

async function readErrorBody(res) {
  try {
    const text = await res.text()
    return text.slice(0, 800)
  } catch {
    return ''
  }
}

async function downloadImage(cfg, url, signal) {
  const res = await fetch(url, { signal: withTimeout(cfg.timeoutMs, signal) })
  if (!res.ok) throw new Error('下载图片 HTTP ' + res.status)
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? '' }
}

/** 按 baseUrl 生成候选前缀：没有 /v1 时先试 /v1，再试原样（兼容 new-api 与直连 OpenAI 风格）。 */
function apiBases(baseUrl) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  if (base === '') return []
  return /\/v\d+$/i.test(base) ? [base] : [base + '/v1', base]
}

/** POST JSON 到上游，自动跳过返回 HTML 的路径候选；返回解析后的 JSON。 */
async function postJson(cfg, path, body, signal) {
  let lastError = null
  for (const base of apiBases(cfg.baseUrl)) {
    const url = base + path
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: withTimeout(cfg.timeoutMs, signal),
      })
      const text = await res.text()
      if (!res.ok) {
        lastError = new Error('HTTP ' + res.status + ' ' + url + '：' + text.slice(0, 300))
        continue
      }
      const trimmed = text.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        lastError = new Error('返回非 JSON（可能是 Web 前端页面）：' + url)
        continue
      }
      return JSON.parse(trimmed)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('请求失败')
}

function contentText(payload) {
  const message = payload?.choices?.[0]?.message
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part?.text === 'string') return part.text
        const url = part?.image_url?.url ?? part?.inline_data?.data
        return typeof url === 'string' ? url : ''
      })
      .join('\n')
  }
  if (Array.isArray(message?.images)) {
    return message.images.map((img) => img?.url ?? img?.b64_json ?? '').join('\n')
  }
  return ''
}

function decodeDataUri(text) {
  const m = /data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=_\-]+)/i.exec(text)
  if (!m) return null
  const bytes = Buffer.from(m[2], 'base64')
  return bytes.length > 0 ? { bytes, mime: 'image/' + m[1].toLowerCase() } : null
}

async function viaImages(cfg, prompt, size, model, signal) {
  const payload = await postJson(
    cfg,
    '/images/generations',
    { model, prompt, size, n: 1, response_format: 'b64_json' },
    signal,
  )
  const item = payload?.data?.[0]
  if (!item) throw new Error('images 没有返回 data[0]')
  if (typeof item.b64_json === 'string' && item.b64_json !== '') {
    return { bytes: Buffer.from(item.b64_json, 'base64'), mime: 'image/png' }
  }
  if (typeof item.url === 'string' && item.url !== '') {
    return downloadImage(cfg, item.url, signal)
  }
  throw new Error('images 返回里既无 b64_json 也无 url')
}

async function viaChat(cfg, prompt, model, signal) {
  const payload = await postJson(
    cfg,
    '/chat/completions',
    { model, messages: [{ role: 'user', content: prompt }], stream: false },
    signal,
  )
  const text = contentText(payload)
  if (text === '') throw new Error('chat 返回里没有内容')

  const inline = decodeDataUri(text)
  if (inline) return inline

  const imageUrl = /https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'<>]*)?/i.exec(text)
  if (imageUrl) return downloadImage(cfg, imageUrl[0], signal)

  throw new Error('chat 返回里找不到图片（既无 data URI 也无图片链接）')
}

async function drawImage(cfg, { prompt, size, model, protocol }, signal) {
  if (!cfg.enabled) throw new Error('绘图未启用：配置 qqbot-fixes.drawing.enabled=false')
  if (cfg.baseUrl === '') throw new Error('未配置绘图接口：请在 cordis.patch.yml 的 qqbot-fixes.drawing.baseUrl 填地址')
  const effectiveModel = model || cfg.model
  if (effectiveModel === '') throw new Error('未配置绘图模型：请在 qqbot-fixes.drawing.model 填模型 id')

  const order = protocol === 'auto'
    ? (cfg.protocol === 'chat' ? ['chat', 'images'] : ['images', 'chat'])
    : [protocol]

  let lastError = null
  for (const attempt of order) {
    try {
      const result = attempt === 'chat'
        ? await viaChat(cfg, prompt, effectiveModel, signal)
        : await viaImages(cfg, prompt, size || cfg.size, effectiveModel, signal)
      if (!result.bytes || result.bytes.length === 0) throw new Error('返回的图片数据为空')
      return { ...result, protocol: attempt }
    } catch (err) {
      lastError = err
      log('绘图协议 ' + attempt + ' 失败：' + (err?.message ?? err))
    }
  }
  throw new Error('绘图失败：' + (lastError?.message ?? '未知错误'))
}

function safeFileName(raw) {
  const trimmed = String(raw ?? '').trim()
  return trimmed === '' ? '' : trimmed
}

function buildTools(ctx, rt) {
  const drawTool = {
    name: 'qqbot_draw_image',
    description: '调用绘图 API 生成图片并保存到本地，返回文件路径。要发到当前 QQ 会话时，把返回的 path 原样传给 qqbot_send_file 的 file_path。画本机机器人「蓝汐」本人时把 character 设为 true，会套用拟人化虎鲸少女的角色外观设定。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '绘图提示词（建议写清主体、风格、构图）' },
        size: { type: 'string', description: '尺寸，如 1024x1024；缺省用配置值' },
        model: { type: 'string', description: '模型 id；缺省用配置值' },
        protocol: { type: 'string', enum: ['auto', 'images', 'chat'], description: '上游协议；自动时按配置先试再换' },
        output: { type: 'string', description: '可选输出路径；缺省写到 ~/.dsh-qqbot/media/draw-*.png' },
        character: { type: 'boolean', description: '是否套用蓝汐的角色外观设定（画本机机器人本人/自拍时用）。不填则按提示词关键词自动判断。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'number' },
          protocol: { type: 'string' },
          model: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['path', 'bytes', 'protocol', 'model', 'prompt'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value ?? {}
        return [{ type: 'text', text: `已生成图片（${v.protocol} / ${v.model}）：${v.path}\n如需发送到当前会话，把该路径传给 qqbot_send_file。` }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('qqbot_draw_image: prompt 必填。')
      const cfg = rt.cfg.drawing
      const useCharacter = typeof args.character === 'boolean'
        ? args.character
        : cfg.characterKeywords.some((k) => k !== '' && prompt.includes(k))
      const finalPrompt = useCharacter && cfg.characterPrompt !== ''
        ? prompt + '\n\n角色设定：' + cfg.characterPrompt
        : prompt
      const result = await drawImage(cfg, {
        prompt: finalPrompt,
        size: typeof args.size === 'string' ? args.size.trim() : '',
        model: typeof args.model === 'string' ? args.model.trim() : '',
        protocol: ['auto', 'images', 'chat'].includes(args.protocol) ? args.protocol : cfg.protocol,
      }, exec?.signal)
      let path = saveImage(result.bytes, result.mime)
      const custom = safeFileName(args.output)
      if (custom !== '') {
        path = custom
        writeFileSync(path, result.bytes)
      }
      log('绘图完成：' + path + ' (' + result.bytes.length + ' bytes, ' + result.protocol + ')')
      return { path, bytes: result.bytes.length, protocol: result.protocol, model: args.model || cfg.model, prompt }
    },
    timeoutMs: 600000,
  }

  const statusTool = {
    name: 'qqbot_guard_status',
    description: '查看 QQ 频控闸与绘图工具的当前配置和计数（不发起网络请求）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          gateEnabled: { type: 'boolean' },
          gate: { type: 'object', additionalProperties: true },
          totals: { type: 'object', additionalProperties: true },
          groups: { type: 'object', additionalProperties: true },
          drawingReady: { type: 'boolean' },
          drawing: { type: 'object', additionalProperties: true },
          summary: { type: 'string' },
        },
        required: ['gateEnabled', 'gate', 'totals', 'groups', 'drawingReady', 'drawing', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
    },
    async execute() {
      const gate = rt.cfg.gate
      const drawing = rt.cfg.drawing
      const totals = rt.state?.totals ?? { passed: 0, blocked: 0, deferred: 0, byReason: {} }
      const groups = rt.state?.groups ?? {}
      const drawingReady = drawing.enabled && drawing.baseUrl !== '' && drawing.model !== ''
      const lines = [
        '频控闸：' + (gate.enabled ? '开' : '关') + '（概率 ' + gate.chance + '，最短 ' + Math.round(gate.minIntervalMs / 1000) + 's，' + gate.maxPerHour + '/时，' + gate.maxPerDay + '/日）',
        '已放行 ' + totals.passed + '，已拦截 ' + totals.blocked + (Object.keys(totals.byReason).length > 0 ? '（' + Object.entries(totals.byReason).map(([k, v]) => k + '=' + v).join('，') + '）' : ''),
        '群计数：' + (Object.keys(groups).length === 0 ? '无' : Object.entries(groups).map(([k, v]) => k + '=' + v.hourCount + '/时,' + v.dayCount + '/日').join('；')),
        '积压：' + (rt.backlog.size === 0 ? '无' : [...rt.backlog.entries()].map(([k, v]) => k + '=' + v.lines.length + ' 条').join('；')),
        '表情包：' + (rt.cfg.meme.enabled ? '开（每条消息 ' + Math.round(rt.cfg.meme.chance * 100) + '% 概率）' : '关'),
        '绘图：' + (drawingReady ? '就绪（' + drawing.protocol + ' @ ' + drawing.baseUrl + '，模型 ' + drawing.model + '）' : '未就绪（检查 baseUrl / model / enabled）'),
      ]
      return { gateEnabled: gate.enabled, gate, totals, groups, drawingReady, drawing, summary: lines.join('\n') }
    },
  }

  const memeTool = {
    name: 'qqbot_send_meme',
    description:
      '从本地表情包图库挑一张并发到当前 QQ 会话，自带频控（冷却/每小时/每天/概率）。' +
      '返回 sent:true 表示已发出；sent:false 表示这一轮不要发表情包，只回文字，不要重试。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '情绪分类：daily / happy / angry / sad / confused / shy；不填则全库随机' },
        query: { type: 'string', description: '按文件名关键词再筛（如 猫、比心、无语）' },
        target: { type: 'string', description: '可选发送目标 "c2c:openid" 或 "group:openid"；缺省发当前会话' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean' },
          reason: { type: 'string' },
          path: { type: 'string' },
          tag: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['sent', 'reason'],
        additionalProperties: true,
      },
      render: (_args, value) => {
        const v = value ?? {}
        const lines = v.sent
          ? ['表情包已发出：' + (v.tag || '')]
          : ['这一轮不发表情包：' + (v.reason || '')]
        if (v.hint) lines.push(v.hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const cfg = rt.cfg.meme
      if (!cfg.enabled) return { sent: false, reason: 'disabled', hint: '表情包功能已关闭' }
      const key = memeKeyOf(exec)
      if (memeChanceBlocked(rt)) {
        log('表情包跳过：概率未中')
        return { sent: false, reason: 'chance', hint: '本轮只回文字，不要重试' }
      }
      const root = resolveMemeRoot(cfg)
      const usage = memeUsage(rt, key)
      const pick = pickMeme(root, { tag: args.tag, query: args.query, exclude: usage.recent })
      if (!pick) return { sent: false, reason: 'empty', hint: '图库为空或没有匹配：' + root }
      const tools = ctx.get('tools')
      if (!tools || typeof tools.execute !== 'function') {
        return { sent: false, reason: 'no-tools', hint: '工具服务不可用' }
      }
      try {
        const result = await tools.execute({
          callId: 'qqbot-send-meme-' + randomUUID(),
          name: 'qqbot_send_file',
          arguments: {
            file_path: pick.path,
            ...(typeof args.target === 'string' && args.target !== '' ? { target: args.target } : {}),
          },
          agent: exec?.agent,
          signal: exec?.signal ?? new AbortController().signal,
        })
        if (result && result.isError === true) {
          const msg = result.error?.message ?? '发送失败'
          log('表情包发送失败：' + msg)
          return { sent: false, reason: 'send-error', hint: msg }
        }
      } catch (err) {
        log('表情包发送异常：' + (err?.message ?? err))
        return { sent: false, reason: 'send-error', hint: String(err?.message ?? err) }
      }
      noteMemeSent(rt, key, pick.path)
      recordLog({ gid: 'meme:' + hashKey(key), decision: 'meme-sent', text: pick.path })
      log('表情包已发：' + pick.path)
      return { sent: true, reason: 'ok', path: pick.path, tag: pick.tag }
    },
  }

  const tools = [drawTool, statusTool, memeTool]
  for (const definition of voiceBridge.buildTools(rt.cfg.voice, ctx, ctx.logger ?? console)) {
    tools.push(definition)
  }
  return tools
}

// ─────────────────────────── 入口 ───────────────────────────

// 仅供单测使用（不参与运行时）
export const __test = { createRuntime, resolveConfig, tickGreeting, greetingSummary, handleSettingsRoute, settingsSnapshot }

export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const overrides = loadSettingsOverrides()
  if (Array.isArray(overrides.adminOpenids)) resolved.gate.files.adminOpenids = overrides.adminOpenids.map((x) => String(x))
  if (overrides.gate && typeof overrides.gate === 'object') {
    if (typeof overrides.gate.chance === 'number') resolved.gate.chance = overrides.gate.chance
    if (typeof overrides.gate.debounceMs === 'number') resolved.gate.debounceMs = overrides.gate.debounceMs
    if (typeof overrides.gate.enabled === 'boolean') resolved.gate.enabled = overrides.gate.enabled
    if (overrides.gate.invalid && typeof overrides.gate.invalid === 'object') Object.assign(resolved.gate.invalid, overrides.gate.invalid)
    if (overrides.gate.files && typeof overrides.gate.files === 'object') Object.assign(resolved.gate.files, overrides.gate.files)
  }
  if (overrides.drawing && typeof overrides.drawing === 'object') Object.assign(resolved.drawing, overrides.drawing)
  if (overrides.meme && typeof overrides.meme === 'object') Object.assign(resolved.meme, overrides.meme)
  if (overrides.greeting && typeof overrides.greeting === 'object') Object.assign(resolved.greeting, overrides.greeting)
  resolved.voice = voiceBridge.resolveConfig({ ...(config?.voice ?? {}), ...(overrides.voice ?? {}) })
  const rt = createRuntime(resolved)

  try {
    const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
    installGate(QQBot, rt)
  } catch (err) {
    log('加载 qqbot-nodejs 失败，频控闸未安装：' + (err?.message ?? err))
  }

  const disposers = []
  for (const definition of buildTools(ctx, rt)) {
    disposers.push(ctx.tools.register(definition))
  }

  // 私聊主动问候定时器 + 统一设置页路由
  registerSettingsRoutes(ctx, rt)
  rt.greeting.timer = setInterval(() => tickGreeting(rt), rt.greeting.cfg.checkIntervalMs)
  rt.greeting.timer.unref?.()

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose()
      if (rt.greeting.timer !== null) clearInterval(rt.greeting.timer)
      if (rt.greeting.saveTimer !== null) clearTimeout(rt.greeting.saveTimer)
      const reg = registry()
      if (reg.controller && reg.controller.rt === rt) reg.controller = null
      disposeRuntime(rt)
    })
  }

  log(
    '已加载：频控闸 ' + (rt.cfg.gate.enabled ? '开' : '关') +
    '（chance=' + rt.cfg.gate.chance + '，防抖 ' + rt.cfg.gate.debounceMs + 'ms，文件需管理员同意 ' +
    (rt.cfg.gate.files.requireAdminApproval ? '开' : '关') + '），绘图 ' +
    (rt.cfg.drawing.baseUrl !== '' ? '已配置' : '未配置'),
  )
}
