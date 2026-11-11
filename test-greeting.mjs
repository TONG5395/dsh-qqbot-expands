/**
 * 自测：私聊主动问候（夜晚窗口 / 空闲阈值 / 每晚额度 / 设置页路由）
 */
import assert from 'node:assert'

process.env.DSH_QQBOT_GATE_STATE = '/tmp/qqbot-greet-test-state-' + process.pid + '.json'
process.env.DSH_QQBOT_GATE_LOG = '/tmp/qqbot-greet-test-log-' + process.pid + '.jsonl'
process.env.DSH_QQBOT_GREETING_STATE = '/tmp/qqbot-greet-test-peers-' + process.pid + '.json'
process.env.DSH_QQBOT_SETTINGS = '/tmp/qqbot-greet-test-settings-' + process.pid + '.json'

const { __test } = await import('./index.js')
const { createRuntime, resolveConfig, tickGreeting, greetingSummary } = __test

const sent = []
const bot = { sendMarkdown: async (target, text) => { sent.push({ target, text }) } }

function makeRt(greetingOverrides = {}) {
  const rt = createRuntime(resolveConfig({
    gate: { enabled: false },
    greeting: {
      enabled: true,
      idleBaseMs: 60000,
      jitterRatio: 0,
      quietStartHour: 0,
      quietEndHour: 23,
      maxPerNight: 2,
      checkIntervalMs: 300000,
      tzOffsetHours: 8,
      greetings: ['早安', '在吗'],
      ...greetingOverrides,
    },
  }))
  rt.lastBot = bot
  return rt
}

// 1) 空闲够久 → 发一条问候
sent.length = 0
const rt1 = makeRt()
rt1.greeting.state.peers['openid-a'] = { lastAt: Date.now() - 5 * 60000, name: '小明', greetedNight: '', count: 0, lastGreetedAt: 0 }
tickGreeting(rt1)
assert.equal(sent.length, 1, '应发一条问候')
assert.equal(sent[0].target.scope, 'c2c')
assert.equal(sent[0].target.targetId, 'openid-a')
assert.ok(['早安', '在吗'].includes(sent[0].text))
console.log('✓ 空闲够久会发私聊问候')

// 2) 刚问候过 → 不重复发
tickGreeting(rt1)
assert.equal(sent.length, 1, '同一窗口不应重复问候')
console.log('✓ 不会重复问候')

// 3) 没聊过的新 peer（lastAt=0）不发
sent.length = 0
const rt2 = makeRt()
rt2.greeting.state.peers['openid-new'] = { lastAt: 0, name: '', greetedNight: '', count: 0, lastGreetedAt: 0 }
tickGreeting(rt2)
assert.equal(sent.length, 0, '没聊过的不应主动打扰')
console.log('✓ 没聊过的新对话不问候')

// 4) 超出每晚上限 → 不再发
sent.length = 0
const rt3 = makeRt()
rt3.greeting.state.peers['openid-b'] = { lastAt: Date.now() - 5 * 60000, name: 'B', greetedNight: '', count: 0, lastGreetedAt: 0 }
tickGreeting(rt3)
assert.equal(sent.length, 1, '第一次应问候一次')
sent.length = 0
const peerB = rt3.greeting.state.peers['openid-b']
peerB.count = 2
peerB.lastAt = Date.now() - 5 * 60000
peerB.lastGreetedAt = 0
tickGreeting(rt3)
assert.equal(sent.length, 0, '达到每晚上限后不应再发')
console.log('✓ 每晚上限生效')

// 5) 不在静默窗口 → 不发
sent.length = 0
const hourNow = new Date(Date.now() + 8 * 3600_000).getUTCHours()
const rt4 = makeRt({ quietStartHour: (hourNow + 1) % 24, quietEndHour: (hourNow + 2) % 24 })
rt4.greeting.state.peers['openid-c'] = { lastAt: Date.now() - 5 * 60000, name: 'C', greetedNight: '', count: 0, lastGreetedAt: 0 }
tickGreeting(rt4)
assert.equal(sent.length, 0, '窗口外不应问候')
console.log('✓ 时间窗外不问候')

// 6) 关闭开关 → 不发
sent.length = 0
const rt5 = makeRt({ enabled: false })
rt5.greeting.state.peers['openid-d'] = { lastAt: Date.now() - 5 * 60000, name: 'D', greetedNight: '', count: 0, lastGreetedAt: 0 }
tickGreeting(rt5)
assert.equal(sent.length, 0, '关闭后不应问候')
console.log('✓ 开关可关闭')

// 7) 摘要可读
const rt6 = makeRt()
rt6.greeting.state.peers['openid-e'] = { lastAt: Date.now() - 60000, name: 'E', greetedNight: '', count: 0, lastGreetedAt: 0 }
const sum = greetingSummary(rt6)
assert.equal(sum.peers.length, 1)
assert.ok(typeof sum.nightKey === 'string' && sum.nightKey.length === 10)
console.log('✓ 摘要格式正常（nightKey=' + sum.nightKey + '）')

// 8) 设置页路由：GET 读、POST 写（管理员 / 表情包 / 问候）
import { EventEmitter } from 'node:events'
const { handleSettingsRoute } = __test

function fakeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  if (body !== undefined) {
    const text = JSON.stringify(body)
    setImmediate(() => {
      req.emit('data', Buffer.from(text))
      req.emit('end')
    })
  } else {
    setImmediate(() => req.emit('end'))
  }
  return req
}
function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(text) { this.body = String(text ?? '') },
  }
}

const rt8 = makeRt()
const getRes = fakeRes()
await handleSettingsRoute(rt8, fakeReq('GET'), getRes)
assert.equal(getRes.status, 200)
const got = JSON.parse(getRes.body)
assert.equal(got.greeting.enabled, true)
assert.ok(Array.isArray(got.adminOpenids))
assert.ok(typeof got.adminPrompt === 'string')
assert.ok(got.adminPrompt.includes('认人规则') === false) // 没配管理员时是提示文案
assert.ok(got.meme && typeof got.meme.chance === 'number')
assert.ok(typeof got.meme.resolvedPackDir === 'string')
console.log('✓ 设置页 GET 返回完整快照')

const postRes = fakeRes()
await handleSettingsRoute(rt8, fakeReq('POST', {
  adminOpenids: ['ADMIN-1', 'ADMIN-2'],
  meme: { enabled: true, chance: 0.4 },
  greeting: { idleBaseMs: 3600000, maxPerNight: 5, greetings: ['嗨', ' '] },
}), postRes)
assert.equal(postRes.status, 200)
const saved = JSON.parse(postRes.body)
assert.deepEqual(saved.adminOpenids, ['ADMIN-1', 'ADMIN-2'])
assert.ok(saved.adminPrompt.includes('ADMIN-1') && saved.adminPrompt.includes('认人规则'))
assert.equal(saved.meme.chance, 0.4)
assert.equal(saved.greeting.idleBaseMs, 3600000)
assert.equal(saved.greeting.maxPerNight, 5)
assert.deepEqual(saved.greeting.greetings, ['嗨'])
assert.deepEqual(rt8.cfg.gate.files.adminOpenids, ['ADMIN-1', 'ADMIN-2'])
console.log('✓ 设置页 POST 保存管理员/表情包/问候并即时生效')

// 群聊频控 / 语音 / 绘图也在同一页
const post2 = fakeRes()
await handleSettingsRoute(rt8, fakeReq('POST', {
  gate: { chance: 0.5, debounceMs: 60000, files: { requireAdminApproval: false } },
  voice: { enabled: true, ttsBaseUrl: 'voice.example.com', ttsProtocol: 'openai', autoSend: false },
  drawing: { enabled: true, baseUrl: 'draw.example.com/v1', model: 'm1', protocol: 'chat' },
}), post2)
assert.equal(post2.status, 200)
const saved2 = JSON.parse(post2.body)
assert.equal(saved2.gate.chance, 0.5)
assert.equal(saved2.gate.debounceMs, 60000)
assert.equal(saved2.gate.files.requireAdminApproval, false)
assert.equal(saved2.voice.ttsBaseUrl, 'https://voice.example.com')
assert.equal(saved2.voice.ttsProtocol, 'openai')
assert.equal(saved2.voice.autoSend, false)
assert.equal(saved2.drawing.baseUrl, 'https://draw.example.com/v1')
assert.equal(saved2.drawing.protocol, 'chat')
assert.equal(rt8.cfg.gate.chance, 0.5)
console.log('✓ 同一设置页覆盖频控/语音/绘图')

// 9) 非法字段被拒
const badRes = fakeRes()
await handleSettingsRoute(rt8, fakeReq('POST', { meme: { chance: 2 } }), badRes)
assert.equal(badRes.status, 400)
assert.ok(JSON.parse(badRes.body).error.includes('chance'))
console.log('✓ 非法配置被拒')

// 10) 设置接口准入：必须走 connection.admit()，缺服务时失败关闭
const { admitSettingsRequest } = __test

const noService = fakeRes()
assert.equal(admitSettingsRequest(undefined, fakeReq('GET'), noService), false, '无 connection 应拒绝')
assert.equal(noService.status, 403)
console.log('✓ 没有 connection 服务时设置接口失败关闭（403）')

const rejected = { admit: () => ({ rejection: 401 }) }
const r401 = fakeRes()
assert.equal(admitSettingsRequest(rejected, fakeReq('GET'), r401), false)
assert.equal(r401.status, 401)

const forbidden = { admit: () => ({ rejection: 403 }) }
const r403 = fakeRes()
assert.equal(admitSettingsRequest(forbidden, fakeReq('POST'), r403), false)
assert.equal(r403.status, 403)

const throwing = { admit: () => { throw new Error('bad credential') } }
const rThrow = fakeRes()
assert.equal(admitSettingsRequest(throwing, fakeReq('GET'), rThrow), false)
assert.equal(rThrow.status, 401)
console.log('✓ admit 拒绝（401/403）与异常都挡在设置逻辑之前')

let seen = null
const admitting = { admit: (request) => { seen = request.headers; return { peer: { id: 'peer-1' } } } }
const okReq = fakeReq('GET')
okReq.headers = { cookie: 'dsh-session=abc' }
const okRes2 = fakeRes()
assert.equal(admitSettingsRequest(admitting, okReq, okRes2), true, '已认证应放行')
assert.deepEqual(seen, { cookie: 'dsh-session=abc' }, '请求头应原样交给 admit')
console.log('✓ 已认证请求放行，请求头原样交给 connection.admit')

console.log('\n问候全部通过')
