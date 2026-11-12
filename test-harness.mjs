import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mesh } from './index.js'

const wait = async (fn, timeout = 8000, label = 'condition') => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await fn()) return
    } catch {
      // Keep polling.
    }
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`timeout: ${label}`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-test-'))
const injected = []
const tools = []
const liveAgents = new Map()
liveAgents.set('parent-session', { inject: message => injected.push(message) })
const ctx = {
  effect: fn => {
    const dispose = fn()
    return () => dispose?.()
  },
  get: () => undefined,
  on: () => () => {},
  tools: { register: definition => { tools.push(definition); return () => {} } },
  webServer: { register: () => () => {} },
  sessionController: {
    create: async () => { throw new Error('session execution is stubbed in this test') },
    resolveAgent: async sessionId => {
      const agent = liveAgents.get(sessionId)
      return agent ? { agent } : { error: new Error('session execution is stubbed in this test') }
    },
    rename: async () => ({}),
  },
  permissionPresets: { set: () => {} },
  agents: {
    get: id => liveAgents.get(id),
    list: () => [],
  },
}

/** The Agent API takes UserMessage objects; workers receive their text. */
function textOf(message) {
  const content = message && message.content
  if (!Array.isArray(content)) return String(message || '')
  return content.filter(block => block && block.type === 'text').map(block => block.text).join('\n')
}

/** A stand-in for a worker agent: records what it was asked, answers with one text. */
function fakeAgent(sessionId, reply, asks) {
  const events = []
  return {
    id: sessionId,
    session: { header: {}, snapshotEvents: () => events },
    ctx: { on: () => () => {}, tools: { restrict: () => {} } },
    followup: async message => {
      asks.push(textOf(message))
      const text = typeof reply === 'function' ? reply(message) : reply
      events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    },
    whenIdle: async () => {},
    inject: () => {},
    cancel: () => {},
  }
}

/** Call the tool instance that owns the given out-task. */
async function toolValue(name, args, matches) {
  let last = null
  for (const tool of tools.filter(item => item.name === name)) {
    try {
      const value = await tool.execute(args)
      last = value
      if (matches(value)) return value
    } catch {
      // Belongs to the other node.
    }
  }
  return last
}

/** Minimal request/response pair for driving the local UI API in tests. */
function fakeExchange({ method = 'POST', path = '/mesh/api/state', headers = {}, remote = '127.0.0.1', body = '' } = {}) {
  const chunks = body ? [Buffer.from(body, 'utf8')] : []
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:59010', ...headers },
    socket: { remoteAddress: remote },
    on(event, handler) {
      if (event === 'data') chunks.forEach(chunk => handler(chunk))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  const out = { status: 0, body: '', headers: {} }
  const res = {
    writeHead(status, extra) {
      out.status = status
      Object.assign(out.headers, extra || {})
      return res
    },
    end(payload) {
      out.body = payload == null ? '' : String(payload)
    },
    destroy() {},
  }
  return { req, res, out }
}

async function callApi(mesh, options) {
  const { req, res, out } = fakeExchange(options)
  await mesh.handleApi(req, res)
  let parsed = null
  try { parsed = JSON.parse(out.body) } catch { parsed = null }
  return { status: out.status, headers: out.headers, body: parsed, raw: out.body }
}

const a = new Mesh(ctx, {
  stateDir: join(root, 'a'), name: 'A', port: 46710, allowParent: false,
})
const b = new Mesh(ctx, {
  stateDir: join(root, 'b'), name: 'B', port: 46711, allowParent: true, listenEnabled: true,
})

const disposeA = a.start()
const disposeB = b.start()
try {
  await wait(() => b.server, 8000, 'child listens')
  const code = b.state.pairingCode
  await a.connectChild({ name: 'B', host: '127.0.0.1', port: b.state.listenPort, code })
  await wait(() => b.state.parent && a.children.get(b.state.nodeId)?.online, 8000, 'pair + stream')
  console.log('pair ok:', b.state.parent.name, '->', a.state.children[b.state.nodeId].name)
  if (!/^服务器/.test(a.state.children[b.state.nodeId].alias || '')) throw new Error('child alias missing')

  b.setGrant('workspace-write')
  await wait(() => a.state.children[b.state.nodeId]?.grant === 'workspace-write', 8000, 'grant')

  // ── security: single-use code, hashed token, header transport, API gates ──
  if (b.state.pairingCode !== null) throw new Error('pairing code survived a successful pairing')
  if (!b.state.parent.tokenHash) throw new Error('parent token was not stored as a hash')
  if (b.state.parent.token) throw new Error('parent token still kept in clear')
  console.log('pairing hardened: code single-use, token stored as hash')

  const infoExchange = fakeExchange({ method: 'GET', path: '/mesh/info' })
  await b.handleRequest(infoExchange.req, infoExchange.res)
  const info = JSON.parse(infoExchange.out.body)
  if (Object.keys(info).join(',') !== 'protocol') throw new Error('info endpoint leaks node identity: ' + JSON.stringify(info))
  console.log('info endpoint: protocol only')

  const evilOrigin = await callApi(b, { method: 'POST', path: '/mesh/api/delete-task', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"taskId":"x"}' })
  if (evilOrigin.status !== 403) throw new Error('cross-origin POST was not rejected: ' + evilOrigin.status)
  const textPlain = await callApi(b, { method: 'POST', path: '/mesh/api/delete-task', headers: { 'content-type': 'text/plain' }, body: '{"taskId":"x"}' })
  if (textPlain.status !== 415) throw new Error('non-JSON POST was not rejected: ' + textPlain.status)
  const remote = await callApi(b, { method: 'GET', path: '/mesh/api/state', remote: '192.168.1.9' })
  if (remote.status !== 403) throw new Error('non-loopback API request was not rejected: ' + remote.status)
  const local = await callApi(b, { method: 'GET', path: '/mesh/api/state', headers: { origin: 'http://127.0.0.1:59010' } })
  if (local.status !== 200) throw new Error('local API request was rejected: ' + local.status)
  if (local.headers['x-content-type-options'] !== 'nosniff') throw new Error('nosniff header missing')
  console.log('local API gates: origin, content-type, loopback, nosniff')

  // A child that reports 0.4.0+ gets the token in the Authorization header only.
  const childRecord = a.state.children[b.state.nodeId]
  childRecord.version = '0.4.0'
  const ping = await a.rpcChild(childRecord, 'ping')
  if (!ping || typeof ping.time !== 'number') throw new Error('header token transport failed')
  childRecord.version = '0.3.0'
  const pingLegacy = await a.rpcChild(childRecord, 'ping')
  if (!pingLegacy || typeof pingLegacy.time !== 'number') throw new Error('query token fallback failed')
  console.log('token transport: header for 0.4.0+, query fallback for older')

  // ── update guard: never let an update make the host unbootable ──
  const guardRoot = join(root, 'guard')
  const guardProfile = join(guardRoot, 'profile')
  const unscopedDir = join(guardProfile, 'node_modules', 'dsh-mesh')
  mkdirSync(unscopedDir, { recursive: true })
  const scopedPatch = '- insert:\n    - id: dsh-mesh\n      name: "@fishboy/dsh-mesh"\n'
  const blocked = b.inspectUpdateTarget(scopedPatch, unscopedDir)
  if (blocked.ok) throw new Error('update guard allowed a patch row the profile cannot resolve')
  mkdirSync(join(guardProfile, 'node_modules', '@fishboy', 'dsh-mesh'), { recursive: true })
  const allowed = b.inspectUpdateTarget(scopedPatch, unscopedDir)
  if (!allowed.ok) throw new Error('update guard refused a resolvable patch row: ' + allowed.reason)
  const sameName = b.inspectUpdateTarget('- insert:\n    - id: dsh-mesh\n      name: dsh-mesh\n', unscopedDir)
  if (!sameName.ok) throw new Error('update guard refused an identical module name')
  console.log('update guard: refuses a scoped patch row until the scoped link exists')


  // ── permission pre-flight: refuse before anything is sent ──
  const tasksBefore = Object.keys(a.state.tasks).length
  a.state.children[b.state.nodeId].grant = 'none'
  let noGrant = ''
  try {
    await a.dispatchTask({ peerId: b.state.nodeId, prompt: 'do something', title: 'no grant', parentSessionId: 'parent-session' })
  } catch (error) {
    noGrant = String(error.message)
  }
  if (!/未授权/.test(noGrant)) throw new Error('dispatch without a grant was not refused clearly: ' + noGrant)
  if (Object.keys(a.state.tasks).length !== tasksBefore) throw new Error('a refused dispatch still created a task record')

  a.state.children[b.state.nodeId].grant = 'read-only'
  let tooHigh = ''
  try {
    await a.dispatchTask({ peerId: b.state.nodeId, prompt: 'write a file', title: 'needs write', permission: 'workspace-write', parentSessionId: 'parent-session' })
  } catch (error) {
    tooHigh = String(error.message)
  }
  if (!/超过/.test(tooHigh) || !/read-only/.test(tooHigh)) {
    throw new Error('permission above the grant was not refused clearly: ' + tooHigh)
  }
  if (Object.keys(a.state.tasks).length !== tasksBefore) throw new Error('an over-permission dispatch still created a task record')
  a.state.children[b.state.nodeId].grant = 'workspace-write'
  console.log('permission pre-flight: no grant and too-high permission refused before dispatch')


  const limitRoot = join(root, 'limit')
  mkdirSync(limitRoot, { recursive: true })
  const limit = new Mesh(ctx, { stateDir: limitRoot, name: 'L', port: 46712, listenEnabled: true })
  const before = limit.state.pairingCode
  limit.notePairingFailure('10.0.0.9', 'wrong code')
  limit.notePairingFailure('10.0.0.9', 'wrong code')
  limit.notePairingFailure('10.0.0.9', 'wrong code')
  if (limit.state.pairingCode === before) throw new Error('pairing code did not rotate after failures')
  limit.notePairingFailure('10.0.0.9', 'wrong code')
  limit.notePairingFailure('10.0.0.9', 'wrong code')
  if (limit.pairingGate('10.0.0.9') <= 0) throw new Error('pairing source was not locked out')
  if (limit.pairingGate('10.0.0.99') !== 0) throw new Error('lockout leaked to another address')
  console.log('pairing defence: code rotates after 3 failures, source locked after 5')

  b.state.settings.rpcPerMinute = 3
  let throttled = false
  for (let i = 0; i < 5; i += 1) {
    try {
      await a.rpcChild(childRecord, 'ping')
    } catch (error) {
      if (/频繁/.test(String(error.message))) { throttled = true; break }
      throw error
    }
  }
  if (!throttled) throw new Error('rpc rate limit did not trigger')
  b.state.settings.rpcPerMinute = 120
  console.log('rpc rate limit: enforced per parent')

  b.runIncomingTask = async task => {
    task.status = 'running'
    task.startedAt = Date.now()
    b.save()
    await new Promise(resolve => setTimeout(resolve, 60))
    task.resultText = 'stub result for ' + task.title
    task.status = 'done'
    task.endedAt = Date.now()
    task.finished = true
    b.save()
    await b.finishTask(task)
  }

  const dispatched = await a.dispatchTask({
    peerId: b.state.nodeId,
    prompt: 'say hi',
    title: 'hello task',
    permission: 'workspace-write',
    parentSessionId: 'parent-session',
  })
  await wait(() => a.state.tasks[dispatched.taskId]?.status === 'done', 8000, 'result')
  const outTask = a.state.tasks[dispatched.taskId]
  if (!outTask.resultText.includes('stub result')) throw new Error('result text missing')
  await wait(() => b.state.tasks[dispatched.taskId]?.delivery === 'delivered', 8000, 'ack')
  if (!outTask.unread) throw new Error('task was not marked unread')
  if (!injected[0] || injected[0].role !== 'user' || injected[0].source.kind !== 'dsh-mesh') throw new Error('inbox notice was not injected')
  const inboxValue = await toolValue('mesh_inbox', { taskId: dispatched.taskId },
    value => value && value.tasks && value.tasks.some(task => task.id === dispatched.taskId))
  if (!inboxValue || !inboxValue.tasks.some(task => task.id === dispatched.taskId)) throw new Error('inbox result missing')
  if (outTask.unread) throw new Error('inbox did not mark read')
  console.log('task ok:', dispatched.taskId, '->', outTask.resultText)

  // ── token control: a long report is landed, the model only gets a preview ──
  const longBody = 'HEAD\n' + 'x'.repeat(6000) + '\nEND-OF-REPORT'
  b.runIncomingTask = async task => {
    task.status = 'running'
    task.startedAt = Date.now()
    b.save()
    task.resultText = longBody
    task.status = 'done'
    task.endedAt = Date.now()
    task.finished = true
    b.save()
    await b.finishTask(task)
  }
  const longTask = await a.dispatchTask({
    peerId: b.state.nodeId,
    prompt: 'long report',
    title: 'long report',
    permission: 'workspace-write',
    parentSessionId: 'parent-session',
  })
  await wait(() => a.state.tasks[longTask.taskId]?.status === 'done', 8000, 'long result')
  const stored = a.state.tasks[longTask.taskId]
  if (!stored.resultFile) throw new Error('long result was not landed to disk')
  const landed = await readFile(stored.resultFile, 'utf8')
  if (!landed.includes('END-OF-REPORT')) throw new Error('landed result is incomplete')
  if (stored.resultChars !== longBody.length) throw new Error('full result length not recorded')
  if (stored.resultText.length >= longBody.length) throw new Error('state kept the whole report in the model path')
  if (!stored.resultTruncated) throw new Error('preview not marked truncated')
  const previewed = await toolValue('mesh_inbox', { taskId: longTask.taskId },
    value => value && value.tasks && value.tasks.some(task => task.id === longTask.taskId))
  const previewEntry = previewed.tasks.find(task => task.id === longTask.taskId)
  if (!previewEntry.resultFile || !previewEntry.truncated) throw new Error('inbox did not expose the landed file')
  if (previewEntry.chars !== longBody.length) throw new Error('inbox lost the full length')
  if (previewEntry.preview.length > 2000) throw new Error('inbox preview is not bounded')
  const fullEntry = await toolValue('mesh_inbox', { taskId: longTask.taskId, full: true },
    value => value && value.tasks && value.tasks.some(task => task.id === longTask.taskId))
  if (!fullEntry.tasks.find(task => task.id === longTask.taskId).text.includes('END-OF-REPORT')) {
    throw new Error('explicit full read did not return the report')
  }
  const listed = await toolValue('mesh_tasks', {}, value => value && value.tasks
    && value.tasks.some(task => task.id === longTask.taskId))
  const listedTask = listed.tasks.find(task => task.id === longTask.taskId)
  if ('resultText' in listedTask || 'preview' in listedTask) throw new Error('mesh_tasks still ships result text')
  if (listedTask.chars !== longBody.length) throw new Error('mesh_tasks lost the result length')
  console.log('tokens ok: landed', stored.resultFile, 'preview', stored.resultText.length, 'of', stored.resultChars)

  // ── continuation: one more turn in the child's existing session ──
  const followId = 'task-followup-test'
  const followWorkspace = join(b.state.workspaceRoot, followId)
  await mkdir(followWorkspace, { recursive: true })
  const asks = []
  liveAgents.set('mesh-followup-test', fakeAgent('mesh-followup-test', 'round two answer', asks))
  b.state.tasks[followId] = {
    id: followId,
    direction: 'in',
    peerId: b.state.parent.id,
    peerName: b.state.parent.name,
    title: 'followup test',
    prompt: 'original task',
    permission: 'workspace-write',
    status: 'done',
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 1000,
    endedAt: Date.now() - 500,
    resultText: 'round one answer',
    error: '',
    artifacts: [],
    sessionId: 'mesh-followup-test',
    workspace: followWorkspace,
    delivery: 'delivered',
    finished: true,
    notified: true,
    unread: false,
  }
  a.state.tasks[followId] = {
    id: followId,
    direction: 'out',
    peerId: b.state.nodeId,
    peerName: a.state.children[b.state.nodeId].name,
    title: 'followup test',
    prompt: 'original task',
    permission: 'workspace-write',
    status: 'done',
    createdAt: Date.now() - 1000,
    endedAt: Date.now() - 500,
    resultText: 'round one answer',
    resultChars: 16,
    error: '',
    artifacts: [],
    parentSessionId: 'parent-session',
    notified: true,
    unread: false,
  }
  const noticesBefore = injected.length
  const replyValue = await toolValue('mesh_reply', { taskId: followId, message: 'now make it shorter' },
    value => value && value.taskId === followId)
  if (!replyValue || replyValue.status !== 'running') throw new Error('mesh_reply did not start a follow-up')
  if (asks.length !== 1) throw new Error('worker was not asked exactly once')
  if (!asks[0].includes('Follow-up round 1')) throw new Error('follow-up prompt lost its round marker')
  if (!asks[0].includes('now make it shorter')) throw new Error('follow-up prompt lost the message')
  if (!asks[0].includes('REPORT.md')) throw new Error('follow-up prompt does not point at the workspace files')
  await wait(() => a.state.tasks[followId]?.status === 'done', 8000, 'follow-up result')
  const followed = a.state.tasks[followId]
  if (followed.resultText !== 'round two answer') throw new Error('follow-up result not stored')
  if ((followed.followups || []).length !== 1) throw new Error('follow-up round not recorded')
  if (!followed.unread) throw new Error('follow-up result did not reach the inbox as unread')
  if (injected.length !== noticesBefore + 1) throw new Error('follow-up did not notify the parent again')
  if (b.state.tasks[followId].sessionId !== 'mesh-followup-test') throw new Error('follow-up opened a new session')
  console.log('followup ok:', followId, 'rounds', followed.followups.length)

  // ── records: delete one, clear the finished ones, never drop a live task ──
  const clearFile = join(a.resultsDir(), 'task-clear-test.md')
  await mkdir(a.resultsDir(), { recursive: true })
  await writeFile(clearFile, '# old report')
  a.state.tasks['task-clear-test'] = {
    id: 'task-clear-test',
    direction: 'out',
    peerId: b.state.nodeId,
    peerName: 'stub child',
    title: 'clear me',
    prompt: '',
    permission: 'workspace-write',
    status: 'done',
    createdAt: Date.now(),
    endedAt: Date.now(),
    resultText: 'old',
    resultChars: 3,
    resultFile: clearFile,
    unread: false,
    notified: true,
    artifacts: [],
  }
  a.state.tasks['task-running-test'] = {
    id: 'task-running-test',
    direction: 'out',
    peerId: b.state.nodeId,
    peerName: 'stub child',
    title: 'still running',
    prompt: '',
    permission: 'workspace-write',
    status: 'running',
    createdAt: Date.now(),
    unread: false,
    artifacts: [],
  }
  let refused = false
  try {
    await a.deleteTask('task-running-test')
  } catch {
    refused = true
  }
  if (!refused) throw new Error('deleteTask accepted a running task')
  const cleared = await a.clearTasks({ peerId: b.state.nodeId })
  if (!cleared.removed) throw new Error('clearTasks removed nothing')
  if (a.state.tasks['task-clear-test']) throw new Error('finished record survived clearTasks')
  if (!a.state.tasks['task-running-test']) throw new Error('clearTasks removed a running task')
  if (existsSync(clearFile)) throw new Error('clearTasks left the landed report behind')
  const deleted = await a.deleteTask(followId)
  if (deleted.deleted !== followId || a.state.tasks[followId]) throw new Error('deleteTask did not remove the record')
  if (existsSync(join(a.resultsDir(), followId + '.md'))) throw new Error('deleteTask left the landed report behind')
  console.log('records ok: cleared', cleared.removed, 'deleted', deleted.deleted)

  const approvalTask = {
    id: 'task-approval-test',
    direction: 'in',
    peerId: b.state.parent.id,
    peerName: b.state.parent.name,
    title: 'approval test',
    permission: 'workspace-write',
    sessionId: 'fake-session',
    finished: false,
  }
  b.state.tasks[approvalTask.id] = approvalTask
  b.state.settings.approvalTimeoutMs = 5000
  const pending = b.requestApproval(approvalTask, {
    agent: { id: 'fake-session' },
    toolName: 'pwsh',
    reason: 'run a command',
  })
  // The parent only knows about the task if it dispatched it; give it one so the
  // approval can be matched and the notice injected.
  a.state.tasks[approvalTask.id] = {
    id: approvalTask.id,
    direction: 'out',
    peerId: b.state.nodeId,
    peerName: b.state.children ? 'stub child' : 'stub child',
    title: 'approval test',
    prompt: '',
    permission: 'workspace-write',
    status: 'running',
    createdAt: Date.now(),
    unread: false,
    artifacts: [],
    parentSessionId: 'parent-session',
  }
  const noticesBeforeApproval = injected.length
  await wait(() => Object.values(a.state.approvals).some(item => item.status === 'pending'), 8000, 'approval frame')
  const approval = Object.values(a.state.approvals).find(item => item.status === 'pending')
  await wait(() => a.state.tasks[approvalTask.id].approvalPending, 8000, 'approval flag')
  await wait(() => injected.length > noticesBeforeApproval, 8000, 'approval notice')
  const approvalNotice = textOf(injected[injected.length - 1])
  if (!approvalNotice.includes('审批')) throw new Error('approval notice does not mention the approval')
  const decided = await toolValue('mesh_approve', { taskId: approvalTask.id, decision: 'allowed-once' },
    value => value && value.approvalId === approval.id)
  if (!decided) throw new Error('mesh_approve did not answer the pending approval')
  const decision = await pending
  if (decision !== 'allowed-once') throw new Error(`unexpected approval decision ${decision}`)
  await wait(() => a.state.tasks[approvalTask.id].approvalPending === false, 8000, 'approval cleared')
  console.log('approval ok:', approval.id, decision, '(notice + mesh_approve)')

  console.log('ALL OK')
} finally {
  await disposeA()
  await disposeB()
  await new Promise(resolve => setTimeout(resolve, 200))
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
