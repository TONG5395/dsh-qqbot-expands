/**
 * 自测：表情包工具（挑选 / 频控 / 通过 qqbot_send_file 发送）
 */
import assert from 'node:assert'

process.env.DSH_QQBOT_GATE_STATE = '/tmp/qqbot-meme-test-state-' + process.pid + '.json'
process.env.DSH_QQBOT_GATE_LOG = '/tmp/qqbot-meme-test-log-' + process.pid + '.jsonl'
process.env.DSH_QQBOT_GREETING_STATE = '/tmp/qqbot-meme-test-peers-' + process.pid + '.json'
process.env.DSH_QQBOT_GREETING_CONFIG = '/tmp/qqbot-meme-test-config-' + process.pid + '.json'

const { apply } = await import('./index.js')

const sent = []
const registered = []
const toolsService = {
  execute: async (req) => { sent.push(req); return { content: [] } },
}
const fakeCtx = {
  logger: console,
  tools: { register: (d) => { registered.push(d); return () => {} } },
  get: (name) => (name === 'tools' ? toolsService : undefined),
  on: () => {},
}

const cfg = (meme) => ({
  gate: { enabled: false },
  greeting: { enabled: false },
  drawing: { enabled: false },
  meme: {
    enabled: true,
    packDir: (process.env.HOME || '/root') + '/.dsh/meme-packs/meme-pair-dict',
    chance: 1,
    maxRecent: 3,
    ...meme,
  },
})

await apply(fakeCtx, cfg())
const meme = registered.filter((d) => d.name === 'qqbot_send_meme').at(-1)
assert.ok(meme, 'qqbot_send_meme 应注册')
for (const name of ['qq_voice_say', 'qq_voice_stt', 'qq_voice_status']) {
  assert.ok(registered.some((d) => d.name === name), name + ' 应注册')
}
console.log('✓ 语音工具已并入同一插件')

// 1) 挑选并发给 qqbot_send_file
sent.length = 0
const r1 = await meme.execute({ tag: 'happy' }, { agent: { id: 'agent-1' } })
assert.equal(r1.sent, true, '第一次应发出')
assert.equal(sent.length, 1)
assert.equal(sent[0].name, 'qqbot_send_file')
assert.ok(sent[0].arguments.file_path.includes('/memes/'), '路径应在图库内')
console.log('✓ 表情包挑选并转交 qqbot_send_file：' + sent[0].arguments.file_path.split('/').slice(-2).join('/'))

// 2) chance=0 一定不发
sent.length = 0
await apply(fakeCtx, cfg({ chance: 0 }))
const meme0 = registered.filter((d) => d.name === 'qqbot_send_meme').at(-1)
const r2 = await meme0.execute({ tag: 'daily' }, { agent: { id: 'agent-2' } })
assert.equal(r2.sent, false)
assert.equal(r2.reason, 'chance')
assert.equal(sent.length, 0, '概率未中时不应调用发送')
console.log('✓ 每条消息概率闸生效')

// 3) chance=1 一定发
await apply(fakeCtx, cfg({ chance: 1 }))
const meme1 = registered.filter((d) => d.name === 'qqbot_send_meme').at(-1)
const r3 = await meme1.execute({ tag: 'sad' }, { agent: { id: 'agent-3' } })
assert.equal(r3.sent, true)
console.log('✓ 概率 100% 必发')

// 4) 空图库
await apply(fakeCtx, cfg({ packDir: '/tmp/definitely-not-a-meme-pack' }))
const memeEmpty = registered.filter((d) => d.name === 'qqbot_send_meme').at(-1)
const r4 = await memeEmpty.execute({ tag: 'daily' }, { agent: { id: 'agent-4' } })
assert.equal(r4.sent, false)
assert.equal(r4.reason, 'empty')
console.log('✓ 空图库返回明确原因')

console.log('\n表情包全部通过')
