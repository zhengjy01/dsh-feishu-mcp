/**
 * dsh-feishu smoke test — validates the store, the lark-mcp server-params
 * builder, the public tool-name derivation, and the supervisor lifecycle
 * against a fake stdio MCP server (no network, no real Feishu credentials).
 * Sets a temp config path via DSH_FEISHU_CONFIG.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'dsh-feishu-'))
process.env.DSH_FEISHU_CONFIG = path.join(root, 'config.json')

const { FeishuStore, buildServerParams, publicToolName } = await import('../lib/index.js')

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log('  ✔ ' + label)
  } else {
    failures++
    console.error('  ✘ ' + label + (detail !== undefined ? ' → ' + String(detail) : ''))
  }
}

console.log('run 1: store round-trip')
const store = new FeishuStore()
let view = await store.view()
check('unconfigured by default', view.configured === false, JSON.stringify(view))
check('appId masked empty', view.appIdMasked === '', view.appIdMasked)

view = await store.patch({ appId: 'cli_abcdefgh12345678', appSecret: 'secret_value_123' })
check('configured after patch', view.configured === true, JSON.stringify(view))
check('appId masked', view.appIdMasked === 'cli_****5678', view.appIdMasked)
check('hasUserToken false', view.hasUserToken === false)

view = await store.patch({ userAccessToken: 'u-abc123' })
check('user token stored', view.hasUserToken === true, JSON.stringify(view))

const cfg = await store.load()
check('raw credentials persisted', cfg.appId === 'cli_abcdefgh12345678' && cfg.appSecret === 'secret_value_123' && cfg.userAccessToken === 'u-abc123')

await store.clearAll()
view = await store.view()
check('clearAll resets', view.configured === false && view.hasUserToken === false)

console.log('run 2: buildServerParams')
const params = buildServerParams({ appId: 'cli_x', appSecret: 's', userAccessToken: '', extraArgs: [] })
check('npx command', params.command === 'npx', params.command)
check('args include package + mcp + -a -s', JSON.stringify(params.args).includes('@larksuiteoapi/lark-mcp') && JSON.stringify(params.args).includes('"mcp"') && JSON.stringify(params.args).includes('"-a"') && JSON.stringify(params.args).includes('"-s"'), JSON.stringify(params.args))
check('no user token flag when absent', !JSON.stringify(params.args).includes('user_access_token'))

const paramsUser = buildServerParams({ appId: 'cli_x', appSecret: 's', userAccessToken: 'u-tok', extraArgs: ['-t', 'preset.im'] })
check('user token flag present', JSON.stringify(paramsUser.args).includes('user_access_token'), JSON.stringify(paramsUser.args))
check('extra args forwarded', JSON.stringify(paramsUser.args).includes('preset.im'), JSON.stringify(paramsUser.args))

console.log('run 3: publicToolName')
check('simple name', publicToolName('im.v1.message.create') === 'mcp__feishu__im_v1_message_create', publicToolName('im.v1.message.create'))
check('long name hashed within 64', publicToolName('a'.repeat(100)).length <= 64, publicToolName('a'.repeat(100)).length)
check('deterministic', publicToolName('bitable.v1.app.create') === publicToolName('bitable.v1.app.create'))

console.log('run 4: supervisor against fake stdio MCP server')
// A fake `npx` that ignores args and serves a trivial MCP over stdio.
const fakeBin = path.join(root, 'bin')
await mkdir(fakeBin, { recursive: true })
const fakeNpx = path.join(fakeBin, 'npx')
const fakeServerSrc = [
  '#!/usr/bin/env node',
  '// Minimal stdio MCP server: initialize -> tools/list -> tools/call.',
  "const readline = require('node:readline');",
  'const rl = readline.createInterface({ input: process.stdin });',
  "rl.on('line', (line) => {",
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  "  if (msg.method === 'initialize') {",
  "    respond(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-lark', version: '1.0.0' } });",
  "  } else if (msg.method === 'notifications/initialized') {",
  '    // no response',
  "  } else if (msg.method === 'tools/list') {",
  '    respond(msg.id, { tools: [',
  "      { name: 'im.v1.message.create', description: 'Send a Feishu message', inputSchema: { type: 'object', properties: { receive_id: { type: 'string' } } } },",
  "      { name: 'bitable.v1.app.create', description: 'Create a Bitable app', inputSchema: { type: 'object' } }",
  '    ] });',
  "  } else if (msg.method === 'tools/call') {",
  "    respond(msg.id, { content: [{ type: 'text', text: 'ok:' + JSON.stringify(msg.params?.arguments ?? {}) }] });",
  '  }',
  '  function respond(id, result) {',
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
  '  }',
  '});',
].join('\n')
await writeFile(fakeNpx, fakeServerSrc, { mode: 0o755 })
process.env.PATH = fakeBin + path.delimiter + (process.env.PATH ?? '')

// Fake cordis context.
const fakeCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: {
    register: (def) => { fakeCtx.registered.set(def.name, def); return () => fakeCtx.registered.delete(def.name) },
  },
}
fakeCtx.registered = new Map()

const { createSupervisor } = await import('../lib/index.js')
const s = createSupervisor(fakeCtx, store)
await store.patch({ appId: 'cli_fake', appSecret: 'secret_fake' })
await s.start()
await new Promise((r) => setTimeout(r, 800))
check('connected', s.isConnected() === true)
check('tools registered (mcp__feishu__*)', s.toolCount() === 2, s.toolCount() + ' tools')
const names = [...fakeCtx.registered.keys()]
check('im tool registered', names.includes('mcp__feishu__im_v1_message_create'), JSON.stringify(names))
check('bitable tool registered', names.includes('mcp__feishu__bitable_v1_app_create'), JSON.stringify(names))

// Call a tool through the bridge.
const imDef = fakeCtx.registered.get('mcp__feishu__im_v1_message_create')
const callResult = await imDef.execute({ receive_id: 'oc_test' }, { signal: new AbortController().signal })
check('tool call returns text', JSON.stringify(callResult).includes('ok:{'), JSON.stringify(callResult))

const tools = await s.listTools()
check('listTools returns raw names', tools.length === 2 && tools.includes('im.v1.message.create'), JSON.stringify(tools))

await s.dispose()
check('disposed (no tools)', s.toolCount() === 0 && fakeCtx.registered.size === 0, fakeCtx.registered.size)

await rm(root, { recursive: true, force: true })
if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed')
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
