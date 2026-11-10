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

const a = new Mesh(ctx, {
  stateDir: join(root, 'a'), name: 'A', port: 46710, allowParent: false,
})
const b = new Mesh(ctx, {
  stateDir: join(root, 'b'), name: 'B', port: 46711, allowParent: true,
})

const disposeA = a.start()
const disposeB = b.start()
try {
  await wait(() => a.server && b.server, 8000, 'servers')
  const code = b.state.pairingCode
  await a.connectChild({ name: 'B', host: '127.0.0.1', port: b.state.listenPort, code })
  await wait(() => b.state.parent && a.children.get(b.state.nodeId)?.online, 8000, 'pair + stream')
  console.log('pair ok:', b.state.parent.name, '->', a.state.children[b.state.nodeId].name)
  if (!/^服务器/.test(a.state.children[b.state.nodeId].alias || '')) throw new Error('child alias missing')

  b.setGrant('workspace-write')
  await wait(() => a.state.children[b.state.nodeId]?.grant === 'workspace-write', 8000, 'grant')

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
  await wait(() => Object.values(a.state.approvals).some(item => item.status === 'pending'), 8000, 'approval frame')
  const approval = Object.values(a.state.approvals).find(item => item.status === 'pending')
  await a.approve({ approvalId: approval.id, decision: 'allowed-once' })
  const decision = await pending
  if (decision !== 'allowed-once') throw new Error(`unexpected approval decision ${decision}`)
  console.log('approval ok:', approval.id, decision)

  console.log('ALL OK')
} finally {
  await disposeA()
  await disposeB()
  await new Promise(resolve => setTimeout(resolve, 200))
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
