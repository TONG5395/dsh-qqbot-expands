/**
 * 自测：绘图工具（mock fetch，不联网）
 */
import assert from 'node:assert'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { apply } from './index.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const registered = []
const fakeCtx = { logger: console, tools: { register: (d) => { registered.push(d); return () => {} } }, on: () => {} }

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push(String(url))
  if (String(url).includes('/chat/completions')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: '图来啦 ![x](data:image/png;base64,' + PNG + ')' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (String(url).includes('/images/generations')) {
    return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('not found', { status: 404 })
}

await apply(fakeCtx, {
  gate: { enabled: false },
  drawing: { enabled: true, baseUrl: 'https://example.invalid', apiKey: 'k', model: 'm', size: '512x512', protocol: 'chat', timeoutMs: 10000 },
})
const latestDraw = () => registered.filter((d) => d.name === 'qqbot_draw_image').at(-1)
const draw = latestDraw()
assert.ok(draw, 'draw 工具存在')

const r1 = await draw.execute({ prompt: '一只深海鲸鱼' }, {})
assert.ok(existsSync(r1.path), 'chat 协议应写出图片文件')
assert.ok(statSync(r1.path).size > 0)
assert.equal(r1.protocol, 'chat')
console.log('✓ chat 协议生成：', r1.path, r1.bytes, 'bytes')
unlinkSync(r1.path)

await apply(fakeCtx, {
  gate: { enabled: false },
  drawing: { enabled: true, baseUrl: 'https://example.invalid', apiKey: 'k', model: 'm', size: '512x512', protocol: 'images', timeoutMs: 10000 },
})
const r2 = await latestDraw().execute({ prompt: '第二张' }, {})
assert.equal(r2.protocol, 'images')
assert.ok(existsSync(r2.path))
console.log('✓ images 协议生成：', r2.path, r2.bytes, 'bytes')
unlinkSync(r2.path)

// 未配置 baseUrl 时明确报错
await apply(fakeCtx, {
  gate: { enabled: false },
  drawing: { enabled: true, baseUrl: '', apiKey: '', model: '', size: '512x512', protocol: 'auto', timeoutMs: 10000 },
})
await assert.rejects(() => latestDraw().execute({ prompt: 'x' }, {}), /未配置绘图接口/)
console.log('✓ 未配置时报错清晰')

console.log('调用记录：', calls.map((u) => new URL(u).pathname).join(', '))
console.log('\n绘图全部通过')
