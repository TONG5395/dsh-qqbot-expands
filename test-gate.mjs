/**
 * 自测：新频控闸（无效过滤 / 文件审批 / 30s 防抖 / 不限速 / 单层包装）
 * 运行：node /root/workspace/dsh-qqbot-expands/test-gate.mjs
 */
import assert from 'node:assert'

process.env.DSH_QQBOT_GATE_STATE = '/tmp/qqbot-gate-test-' + process.pid + '.json'
process.env.DSH_QQBOT_GATE_LOG = '/tmp/qqbot-gate-test-' + process.pid + '.jsonl'

const { apply } = await import('./index.js')
const { QQBot } = await import('@tencent-connect/qqbot-nodejs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const registered = []
const fakeCtx = { logger: console, tools: { register: (d) => { registered.push(d); return () => {} } }, on: () => {} }

let calls = []
let notices = []
const bot = {
  appId: '1234567890',
  logger: console,
  deriveReplyTarget(raw) {
    calls.push({ msgId: raw.messageId, content: raw.content, attachments: raw.attachments?.length ?? 0, event: raw.rawEventType })
    return null
  },
  sendMarkdown: async (_t, text) => { notices.push(text) },
}

const baseGate = {
  enabled: true,
  chance: 1,
  debounceMs: 30,
  minIntervalMs: 0,
  maxPerHour: 0,
  maxPerDay: 0,
  invalid: { enabled: true, minLength: 2, dropPureRepeat: true, dropPurePunctuation: true, dropFiller: true },
  files: { requireAdminApproval: true, adminOpenids: ['ADMIN'], approvalKeywords: ['同意', '允许'], approvalTtlMs: 600000, noticeCooldownMs: 0 },
  skipMergedAttachments: true,
}
const cfg = (over = {}) => ({ gate: { ...baseGate, ...over }, drawing: { enabled: false } })
const send = (raw) => QQBot.prototype.handleInboundMessage.call(bot, raw)
const groupMsg = (over = {}) => ({ kind: 'group', groupOpenid: 'g-' + Math.random(), senderId: 'u1', senderName: '路人', messageId: 'm-' + Math.random(), rawEventType: 'GROUP_MESSAGE_CREATE', content: '在吗', ...over })

await apply(fakeCtx, cfg())
assert.ok(registered.find((d) => d.name === 'qqbot_draw_image'))
assert.ok(registered.find((d) => d.name === 'qqbot_guard_status'))
console.log('✓ 工具注册')

// 1) 无效消息过滤
calls = []
await apply(fakeCtx, cfg())
for (const bad of ['哈', '……', '哈哈哈哈', '嗯', '！？']) await send(groupMsg({ content: bad }))
await sleep(80)
assert.equal(calls.length, 0, '无效消息不应触发任何处理')
console.log('✓ 无效消息过滤（哈 / …… / 哈哈 / 嗯 / ！？ 全拦）')

// 2) 30s 防抖合并
calls = []
await apply(fakeCtx, cfg())
const gid = 'g-demo'
await send(groupMsg({ groupOpenid: gid, senderName: 'A', content: '第一句' }))
await sleep(10)
await send(groupMsg({ groupOpenid: gid, senderName: 'B', content: '第二句', messageId: 'm-last' }))
await sleep(10)
await send(groupMsg({ groupOpenid: gid, senderName: 'C', content: '第三句', messageId: 'm-final' }))
assert.equal(calls.length, 0, '防抖窗口内不应触发')
await sleep(80)
assert.equal(calls.length, 1, '安静后应只触发一次')
assert.ok(calls[0].content.includes('第一句') && calls[0].content.includes('第三句'))
assert.equal(calls[0].msgId, 'm-final')
console.log('✓ 30s 防抖合并（3 条 → 1 次，messageId 复用最后一条）')

// 3) chance=0 不接话
calls = []
await apply(fakeCtx, cfg({ chance: 0 }))
await send(groupMsg({ content: '有人吗' }))
await sleep(80)
assert.equal(calls.length, 0)
console.log('✓ 概率闸（chance=0 不接话）')

// 4) 文件审批
calls = []
notices = []
await apply(fakeCtx, cfg())
const fileRaw = groupMsg({ groupOpenid: 'g-file', senderId: 'u2', content: '你看这个', messageId: 'm-file', attachments: [{ content_type: 'image/png', url: 'https://x/y.png' }] })
await send(fileRaw)
assert.equal(notices.length, 1, '应发一次提示')
assert.ok(notices[0].includes('同意'))
await sleep(80)
assert.equal(calls.length, 0, '非管理员文件不应进入处理')
await send(groupMsg({ groupOpenid: 'g-file', senderId: 'ADMIN', content: '同意' }))
await sleep(20)
assert.equal(calls.length, 1, '管理员同意后应重放原消息')
assert.equal(calls[0].msgId, 'm-file')
console.log('✓ 文件审批（拦下 / 提示 / 管理员同意后重放）')

// 5) 管理员文件直接放行
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ senderId: 'ADMIN', content: '我的图', messageId: 'm-admin', attachments: [{ content_type: 'image/png' }] }))
assert.equal(calls.length, 1)
console.log('✓ 管理员文件直接放行')

// 6) @ 消息直接放行
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ content: '@bot 在吗', messageId: 'm-at', rawEventType: 'GROUP_AT_MESSAGE_CREATE' }))
assert.equal(calls.length, 1)
console.log('✓ @ 消息直接放行')

// 7) 合并转发不读附件
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ groupOpenid: 'g-merge', content: '合并转发：几条聊天记录', messageId: 'm-merge', attachments: [{ content_type: 'image/png' }] }))
await sleep(80)
assert.equal(calls.length, 1)
assert.equal(calls[0].attachments, 0)
console.log('✓ 合并转发不读附件')

// 8) 反复 apply 不会叠加包装（只触发一次）
calls = []
await apply(fakeCtx, cfg())
await apply(fakeCtx, cfg())
await apply(fakeCtx, cfg())
await send(groupMsg({ groupOpenid: 'g-wrap', content: '测试叠加', messageId: 'm-wrap' }))
await sleep(80)
assert.equal(calls.length, 1, '单层包装应只触发一次')
console.log('✓ 热重载不叠加（重复 apply 只触发一次）')

// 9) 全量消息里的 <@机器人appId> 标记要放行
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ content: '<@!1234567890> 在吗', messageId: 'm-tag', rawEventType: 'GROUP_MESSAGE_CREATE' }))
assert.equal(calls.length, 1, '内容里 @ 机器人应放行')
console.log('✓ 全量消息里 @ 机器人（appId 标记）能识别')

// 10) @ 别人不算 @ 机器人
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ content: '<@!999888777> 你看', messageId: 'm-other-tag' }))
assert.equal(calls.length, 0, '@ 别人的消息不应立即放行')
console.log('✓ @ 别人不会被当成 @ 机器人')

// 11) mentions.is_you 放行
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ content: '你好', messageId: 'm-isyou', mentions: [{ is_you: true }] }))
assert.equal(calls.length, 1, 'mentions.is_you 应放行')
console.log('✓ mentions.is_you 能识别')

// 12) mentions 里 id 等于机器人 appId 也放行
calls = []
await apply(fakeCtx, cfg())
await send(groupMsg({ content: '在', messageId: 'm-id', mentions: [{ id: '1234567890' }] }))
assert.equal(calls.length, 1, 'mentions.id 命中 appId 应放行')
console.log('✓ mentions.id 命中 appId 能识别')

// 13) botIds 可补充机器人的其它 id
calls = []
await apply(fakeCtx, cfg({ botIds: ['BOTOPENID'] }))
await send(groupMsg({ content: '<@!BOTOPENID> 在吗', messageId: 'm-botid' }))
assert.equal(calls.length, 1, 'botIds 命中应放行')
console.log('✓ botIds 补充 id 生效')

// 14) 概率没过的消息进积压，下次触发一起送
calls = []
await apply(fakeCtx, cfg({ chance: 0.25 }))
const realRandom = Math.random
Math.random = () => 0.99
await send(groupMsg({ groupOpenid: 'g-bk', content: '第一条', messageId: 'm-bk1' }))
await sleep(80)
assert.equal(calls.length, 0, '第一次概率没过不应回复')
Math.random = () => 0
await send(groupMsg({ groupOpenid: 'g-bk', content: '第二条', messageId: 'm-bk2' }))
await sleep(80)
Math.random = realRandom
assert.equal(calls.length, 1, '第二次概率过了应回复一次')
assert.ok(calls[0].content.includes('第一条') && calls[0].content.includes('第二条'), '积压应和当前消息一起送')
console.log('✓ 概率没过的消息进积压，下次一起送')

// 15) @ 机器人时把积压一起带上
calls = []
await apply(fakeCtx, cfg({ chance: 0.25 }))
Math.random = () => 0.99
await send(groupMsg({ groupOpenid: 'g-atbk', senderName: '小明', content: '刚才说到哪了', messageId: 'm-ab1' }))
await sleep(80)
assert.equal(calls.length, 0)
Math.random = realRandom
await send(groupMsg({ groupOpenid: 'g-atbk', content: '<@!1234567890> 你说说', messageId: 'm-ab2' }))
assert.equal(calls.length, 1, '@ 应立即放行')
assert.ok(calls[0].content.includes('[近期群聊]') && calls[0].content.includes('刚才说到哪了'), '应带上积压')
console.log('✓ @ 机器人时附带积压群聊')

// 16) 无效消息默认不进积压
calls = []
await apply(fakeCtx, cfg({ chance: 0.25 }))
Math.random = () => 0.99
await send(groupMsg({ groupOpenid: 'g-inv', content: '哈哈哈', messageId: 'm-inv1' }))
await sleep(60)
Math.random = () => 0
await send(groupMsg({ groupOpenid: 'g-inv', content: '正经问题', messageId: 'm-inv2' }))
await sleep(80)
Math.random = realRandom
assert.equal(calls.length, 1)
assert.ok(!calls[0].content.includes('哈哈哈'), '无效消息不应进积压')
console.log('✓ 无效消息不进积压')

console.log('\n全部通过')
