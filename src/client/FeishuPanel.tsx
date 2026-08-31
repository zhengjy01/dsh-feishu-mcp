/**
 * Feishu settings panel — rendered inside the web settings page
 * (settings.section entry). Configuration form (App ID / App Secret /
 * optional user token), connection status, test-connection button with the
 * discovered tool list, and a reset button. Plain React, no emoji, no
 * external UI package — inline styles only.
 */
import { useCallback, useEffect, useState } from 'react'
import { FeishuApi, type FeishuConfigView, type FeishuTestResult } from './api.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new FeishuApi()

/** One shared style sheet (kept tiny and theme-agnostic). */
const s = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxWidth: '620px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
  } as const,
  title: { fontWeight: 600, fontSize: '13px', margin: 0 } as const,
  status: { fontSize: '12px', opacity: 0.85 } as const,
  statusWarn: { fontSize: '12px', opacity: 0.9, color: '#c9763a' } as const,
  hint: { fontSize: '12px', opacity: 0.85, lineHeight: '1.5', margin: 0 } as const,
  row: { display: 'flex', gap: '6px', alignItems: 'center' } as const,
  label: { fontSize: '12px', opacity: 0.85, whiteSpace: 'nowrap' } as const,
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  flex: { flex: 1 } as const,
  button: {
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(128,128,128,0.14)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  msg: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.9 } as const,
  list: { fontSize: '12px', margin: 0, paddingLeft: '18px', maxHeight: '180px', overflowY: 'auto' } as const,
}

/** Status line for the current config view. */
function statusText(view: FeishuConfigView | null): string {
  if (view === null) return '加载中…'
  const conf = view.configured ? '已配置（App ID ' + view.appIdMasked + '）' : '未配置'
  const conn = view.connected ? '已连接' : '未连接'
  return conf + ' · MCP ' + conn + (view.connected ? '（' + view.toolCount + ' 个工具）' : '') +
    (view.hasUserToken ? ' · 含用户令牌' : '') +
    (view.tokenUpdatedAt ? ' · 最近连接 ' + view.tokenUpdatedAt : '')
}

/** The Feishu settings panel component. */
export function FeishuPanel(): JSX.Element {
  const [view, setView] = useState<FeishuConfigView | null>(null)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [userToken, setUserToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [testResult, setTestResult] = useState<FeishuTestResult | null>(null)

  const refresh = useCallback(async () => {
    try {
      const v = await api.getStatus()
      setView(v)
    } catch (error) {
      setMsg('读取状态失败: ' + String(error instanceof Error ? error.message : error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /** Run one async panel action with busy/message bookkeeping. */
  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      setMsg(await action())
    } catch (error) {
      setMsg('操作失败: ' + String(error instanceof Error ? error.message : error))
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    void run(async () => {
      const next = await api.setConfig({
        ...(appId.trim() !== '' ? { appId } : {}),
        ...(appSecret.trim() !== '' ? { appSecret } : {}),
        ...(userToken.trim() !== '' ? { userAccessToken: userToken } : {}),
      })
      setView(next)
      if (appId.trim() !== '') setAppId('')
      if (appSecret.trim() !== '') setAppSecret('')
      if (userToken.trim() !== '') setUserToken('')
      return '配置已保存' + (next.configured ? '（App ID ' + next.appIdMasked + '）。' : '：还需 App ID 与 App Secret。')
    })
  }

  const testNow = (): void => {
    void run(async () => {
      const result = await api.test()
      setTestResult(result)
      await refresh()
      return result.ok ? '[ok] 已连接：' + result.toolCount + ' 个工具' : '[failed] ' + result.message
    })
  }

  const clearAll = (): void => {
    void run(async () => {
      const next = await api.reset()
      setView(next)
      setTestResult(null)
      return '已清除全部飞书凭据。'
    })
  }

  return (
    <div style={s.card}>
      <p style={s.title}>飞书 MCP 连接</p>

      <p style={s.hint}>
        通过官方 @larksuiteoapi/lark-mcp 服务器把飞书开放平台 API 接入 DSH：配置飞书自建应用的
        App ID / App Secret 后，agent 即可用 <b>mcp__feishu__*</b> 工具操作飞书（IM 消息、多维表格
        Bitable、云文档、日历、云盘等）。先在
        <a href="https://open.feishu.cn/" target="_blank" rel="noreferrer"> 飞书开放平台</a>
        创建企业自建应用，添加所需权限（im/bitable/docx/calendar/drive 等）并发布版本。用户令牌可选，
        配置后以用户身份访问私有资源。
      </p>

      <div style={view !== null && (view.configured || view.connected) ? s.status : s.statusWarn}>{statusText(view)}</div>

      <div style={s.row}>
        <span style={s.label}>App ID</span>
        <input style={{ ...s.input, ...s.flex }} value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={view?.configured ? '已配置，留空不改' : 'cli_xxxxxxxxxxxxxxxx'} />
      </div>
      <div style={s.row}>
        <span style={s.label}>App Secret</span>
        <input style={{ ...s.input, ...s.flex }} type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={view?.hasAppSecret ? '已配置，留空不改' : '输入 App Secret'} />
      </div>
      <div style={s.row}>
        <span style={s.label}>用户令牌</span>
        <input style={{ ...s.input, ...s.flex }} type="password" value={userToken} onChange={(e) => setUserToken(e.target.value)} placeholder={view?.hasUserToken ? '已配置，留空不改' : '可选：user_access_token'} />
      </div>

      <div style={s.row}>
        <button style={s.button} onClick={save} disabled={busy}>保存配置</button>
        <button style={s.button} onClick={testNow} disabled={busy}>测试连接</button>
        <button style={s.button} onClick={clearAll} disabled={busy}>清除凭据</button>
        <button style={s.button} onClick={() => void refresh()} disabled={busy}>刷新</button>
      </div>

      {testResult !== null && testResult.tools.length > 0 && (
        <>
          <p style={s.hint}>发现 {testResult.toolCount} 个飞书工具（agent 侧以 mcp__feishu__* 前缀调用）：</p>
          <ul style={s.list}>
            {testResult.tools.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </>
      )}
      {msg !== '' && <div style={s.msg}>{msg}</div>}
    </div>
  )
}
