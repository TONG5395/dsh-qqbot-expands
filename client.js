// client.js — @local/dsh-qqbot-expands 的浏览器半边
//
// 设置 →「QQ 机器人 · 问候」一页管全部 QQ 适配：
//   管理员 / 群聊频控 / 表情包 / 语音 / 绘图 / 私聊问候。
// 数据来自宿主路由 /qqbot-expands/settings（GET 读、POST 写），保存后立即生效。

window.__ModuleLoader__.load({
  id: 'dsh-qqbot-expands',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    const API = '/qqbot-expands/settings'

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 24px' },
      block: { display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 14, borderBottom: '0.5px solid var(--dsw-alias-border-l3)' },
      title: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', minWidth: 110 },
      input: {
        width: 120, height: 30, padding: '0 8px', borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l3)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13,
      },
      wide: {
        width: 260, height: 30, padding: '0 8px', borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l3)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13,
      },
      area: {
        width: '100%', minHeight: 72, padding: 8, borderRadius: 8, resize: 'vertical',
        border: '0.5px solid var(--dsw-alias-border-l3)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, boxSizing: 'border-box',
      },
      btn: {
        height: 30, padding: '0 14px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 13,
        border: '0.5px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
      },
      ghost: {
        height: 28, padding: '0 12px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 12,
        border: '0.5px solid var(--dsw-alias-border-l3)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2f9e44)' },
      err: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #e03131)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
    }

    function toDraft(d) {
      const g = d.greeting || {}
      const gate = d.gate || {}
      const m = d.meme || {}
      const v = d.voice || {}
      const dr = d.drawing || {}
      return {
        adminText: (d.adminOpenids || []).join('\n'),
        gate: {
          enabled: gate.enabled !== false,
          chancePct: Math.round((gate.chance ?? 0.25) * 100),
          debounceSec: Math.round((gate.debounceMs ?? 30000) / 1000),
          invalidEnabled: gate.invalid?.enabled !== false,
          fileApproval: gate.files?.requireAdminApproval !== false,
        },
        meme: { enabled: m.enabled !== false, chancePct: Math.round((m.chance ?? 0.6) * 100) },
        voice: {
          enabled: v.enabled !== false,
          ttsBaseUrl: v.ttsBaseUrl || '',
          ttsApiKey: v.ttsApiKey || '',
          ttsProtocol: v.ttsProtocol || 'gptsovits',
          ttsModel: v.ttsModel || '',
          ttsVoice: v.ttsVoice || 'default',
          ttsFormat: v.ttsFormat || 'wav',
          asrBaseUrl: v.asrBaseUrl || '',
          asrApiKey: v.asrApiKey || '',
          asrModel: v.asrModel || 'whisper-large-v3-turbo',
          autoSend: v.autoSend !== false,
        },
        drawing: {
          enabled: dr.enabled !== false,
          baseUrl: dr.baseUrl || '',
          apiKey: dr.apiKey || '',
          model: dr.model || '',
          size: dr.size || '1024x1024',
          protocol: dr.protocol || 'auto',
        },
        greeting: {
          enabled: g.enabled !== false,
          idleMinutes: Math.round((g.idleBaseMs || 7200000) / 60000),
          jitterPct: Math.round((g.jitterRatio || 0) * 100),
          quietStartHour: g.quietStartHour ?? 22,
          quietEndHour: g.quietEndHour ?? 8,
          maxPerNight: g.maxPerNight ?? 3,
          checkMinutes: Math.round((g.checkIntervalMs || 300000) / 60000),
          tzOffsetHours: g.tzOffsetHours ?? 8,
          greetingsText: Array.isArray(g.greetings) ? g.greetings.join('\n') : '',
        },
      }
    }

    function Section() {
      const [draft, setDraft] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [msg, setMsg] = React.useState({ kind: '', text: '' })
      const [busy, setBusy] = React.useState(false)
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        fetch(API)
          .then((r) => r.json())
          .then((d) => { if (!alive) return; setSnapshot(d); setDraft(toDraft(d)) })
          .catch((err) => { if (alive) setMsg({ kind: 'err', text: '读取失败：' + err.message }) })
        return () => { alive = false }
      }, [])

      if (!draft) return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取设置…'))

      const upd = (section, key) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setDraft({ ...draft, [section]: { ...draft[section], [key]: value } })
      }
      const setTop = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })

      const save = async () => {
        setBusy(true)
        setMsg({ kind: '', text: '' })
        const g = draft.greeting, gt = draft.gate, m = draft.meme, v = draft.voice, dr = draft.drawing
        const payload = {
          adminOpenids: String(draft.adminText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          gate: {
            enabled: Boolean(gt.enabled),
            chance: Math.min(100, Math.max(0, Number(gt.chancePct) || 0)) / 100,
            debounceMs: Math.max(5, Number(gt.debounceSec) || 0) * 1000,
            invalid: { enabled: Boolean(gt.invalidEnabled) },
            files: { requireAdminApproval: Boolean(gt.fileApproval) },
          },
          meme: { enabled: Boolean(m.enabled), chance: Math.min(100, Math.max(0, Number(m.chancePct) || 0)) / 100 },
          voice: {
            enabled: Boolean(v.enabled),
            ttsBaseUrl: v.ttsBaseUrl, ttsApiKey: v.ttsApiKey, ttsProtocol: v.ttsProtocol,
            ttsModel: v.ttsModel, ttsVoice: v.ttsVoice, ttsFormat: v.ttsFormat,
            asrBaseUrl: v.asrBaseUrl, asrApiKey: v.asrApiKey, asrModel: v.asrModel,
            autoSend: Boolean(v.autoSend),
          },
          drawing: {
            enabled: Boolean(dr.enabled), baseUrl: dr.baseUrl, apiKey: dr.apiKey,
            model: dr.model, size: dr.size, protocol: dr.protocol,
          },
          greeting: {
            enabled: Boolean(g.enabled),
            idleBaseMs: Math.max(1, Number(g.idleMinutes) || 0) * 60000,
            jitterRatio: Math.min(100, Math.max(0, Number(g.jitterPct) || 0)) / 100,
            quietStartHour: Number(g.quietStartHour),
            quietEndHour: Number(g.quietEndHour),
            maxPerNight: Number(g.maxPerNight),
            checkIntervalMs: Math.max(1, Number(g.checkMinutes) || 0) * 60000,
            tzOffsetHours: Number(g.tzOffsetHours),
            greetings: String(g.greetingsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          },
        }
        try {
          const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status))
          setSnapshot(data)
          setDraft(toDraft(data))
          setMsg({ kind: 'ok', text: '已保存，立即生效' })
        } catch (err) {
          setMsg({ kind: 'err', text: '保存失败：' + err.message })
        } finally {
          setBusy(false)
        }
      }

      const copyPrompt = async () => {
        try {
          await navigator.clipboard.writeText(snapshot?.adminPrompt || '')
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch (err) {
          setMsg({ kind: 'err', text: '复制失败：' + err.message })
        }
      }

      const input = (section, key, opts = {}) => h('input', {
        style: opts.wide ? S.wide : S.input,
        type: opts.type || 'text',
        min: opts.min, max: opts.max, placeholder: opts.placeholder,
        value: draft[section][key],
        onChange: upd(section, key),
      })
      const check = (section, key) => h('input', { type: 'checkbox', checked: Boolean(draft[section][key]), onChange: upd(section, key) })
      const line = (label, ...children) => h('div', { style: S.row }, h('span', { style: S.label }, label), ...children)

      const g = draft.greeting, gt = draft.gate, m = draft.meme, v = draft.voice, dr = draft.drawing
      const peers = snapshot?.greetingState?.peers || []

      return h('div', { style: S.wrap },

        // 管理员
        h('div', { style: S.block },
          h('div', { style: S.title }, '管理员'),
          h('div', { style: S.hint }, '一行一个 openid。文件读取审批、认人提示词都会用到。'),
          h('textarea', { style: { ...S.area, ...S.mono }, placeholder: '在这里填管理员的 openid，一行一个', value: draft.adminText, onChange: setTop('adminText') }),
          line('辨认提示词', h('button', { style: S.ghost, type: 'button', onClick: copyPrompt }, copied ? '已复制' : '复制'), h('span', { style: S.hint }, '贴进 QQ 机器人的 directPrompt / groupPrompt')),
          h('textarea', { style: { ...S.area, ...S.mono, minHeight: 66 }, readOnly: true, value: snapshot?.adminPrompt || '' }),
        ),

        // 群聊频控
        h('div', { style: S.block },
          h('div', { style: S.title }, '群聊频控'),
          line('开启频控', check('gate', 'enabled'), h('span', { style: S.hint }, '未 @ 的群消息先过闸再决定接不接')),
          line('接话概率', input('gate', 'chancePct', { type: 'number', min: 0, max: 100 }), h('span', { style: S.hint }, '%（防抖到点后掷骰）')),
          line('防抖', input('gate', 'debounceSec', { type: 'number', min: 5 }), h('span', { style: S.hint }, '秒内继续来的消息合并成一批')),
          line('无效消息过滤', check('gate', 'invalidEnabled'), h('span', { style: S.hint }, '语气词、纯标点、重复串直接丢')),
          line('文件需管理员同意', check('gate', 'fileApproval'), h('span', { style: S.hint }, '非管理员发的图片/文件先拦下')),
        ),

        // 表情包
        h('div', { style: S.block },
          h('div', { style: S.title }, '表情包'),
          line('开启表情包', check('meme', 'enabled')),
          line('每条消息概率', input('meme', 'chancePct', { type: 'number', min: 0, max: 100 }), h('span', { style: S.hint }, '%（每条回复独立掷骰）')),
          h('div', { style: S.hint }, '图库目录：' + (snapshot?.meme?.resolvedPackDir || '自动检索中')),
        ),

        // 语音
        h('div', { style: S.block },
          h('div', { style: S.title }, '语音'),
          line('开启语音', check('voice', 'enabled'), h('span', { style: S.hint }, 'TTS 合成语音条 / ASR 转写')),
          line('TTS 地址', input('voice', 'ttsBaseUrl', { wide: true, placeholder: 'https://…' })),
          line('TTS 密钥', input('voice', 'ttsApiKey', { wide: true, placeholder: '可留空' })),
          line('TTS 协议', h('select', { style: S.wide, value: v.ttsProtocol, onChange: upd('voice', 'ttsProtocol') },
            h('option', { value: 'gptsovits' }, 'gptsovits'),
            h('option', { value: 'openai' }, 'openai'),
          )),
          line('音色 / 模型', input('voice', 'ttsVoice', { wide: true }), input('voice', 'ttsModel', { wide: true })),
          line('格式', input('voice', 'ttsFormat', { placeholder: 'wav' })),
          line('ASR 地址', input('voice', 'asrBaseUrl', { wide: true, placeholder: '可留空' })),
          line('ASR 密钥', input('voice', 'asrApiKey', { wide: true })),
          line('ASR 模型', input('voice', 'asrModel', { wide: true })),
          line('合成后自动发送', check('voice', 'autoSend')),
        ),

        // 绘图
        h('div', { style: S.block },
          h('div', { style: S.title }, '绘图'),
          line('开启绘图', check('drawing', 'enabled')),
          line('接口地址', input('drawing', 'baseUrl', { wide: true, placeholder: 'https://…/v1' })),
          line('密钥', input('drawing', 'apiKey', { wide: true })),
          line('模型', input('drawing', 'model', { wide: true })),
          line('尺寸', input('drawing', 'size', { placeholder: '1024x1024' })),
          line('协议', h('select', { style: S.wide, value: dr.protocol, onChange: upd('drawing', 'protocol') },
            h('option', { value: 'auto' }, 'auto'),
            h('option', { value: 'images' }, 'images'),
            h('option', { value: 'chat' }, 'chat'),
          )),
        ),

        // 私聊问候
        h('div', { style: S.block },
          h('div', { style: S.title }, '私聊主动问候'),
          line('开启问候', check('greeting', 'enabled'), h('span', { style: S.hint }, '只问候私聊，群聊绝不主动搭话')),
          line('静默时间窗',
            input('greeting', 'quietStartHour', { type: 'number', min: 0, max: 23 }), h('span', { style: S.hint }, '点 —'),
            input('greeting', 'quietEndHour', { type: 'number', min: 0, max: 23 }), h('span', { style: S.hint }, '点（跨午夜也行）')),
          line('空闲基准',
            input('greeting', 'idleMinutes', { type: 'number', min: 1 }), h('span', { style: S.hint }, '分钟，±'),
            input('greeting', 'jitterPct', { type: 'number', min: 0, max: 100 }), h('span', { style: S.hint }, '% 浮动')),
          line('每晚最多',
            input('greeting', 'maxPerNight', { type: 'number', min: 0, max: 50 }), h('span', { style: S.hint }, '条'),
            h('span', { style: S.label, minWidth: 0 }, '检查间隔'),
            input('greeting', 'checkMinutes', { type: 'number', min: 1 }), h('span', { style: S.hint }, '分钟')),
          line('时区偏移', input('greeting', 'tzOffsetHours', { type: 'number', min: -12, max: 14 }), h('span', { style: S.hint }, '小时（东八区填 8）')),
          line('问候语', h('textarea', { style: S.area, placeholder: '每行一条；留空用内置的几句', value: g.greetingsText, onChange: upd('greeting', 'greetingsText') })),
          h('div', { style: S.hint }, '今晚已登记 ' + peers.length + ' 个私聊' +
            (peers.length > 0 ? '：' + peers.slice(0, 4).map((p) => (p.name || p.id.slice(0, 6)) + '(' + (p.idleMinutes ?? '—') + '分钟)').join('、') : '')),
        ),

        h('div', { style: S.row },
          h('button', { style: S.btn, type: 'button', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          msg.kind === 'ok' ? h('span', { style: S.ok }, msg.text) : null,
          msg.kind === 'err' ? h('span', { style: S.err }, msg.text) : null,
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qqbot-expands',
        order: 8,
        label: 'QQ 机器人 · 问候',
      }, Section))
    }

    const inject = ['slots']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
