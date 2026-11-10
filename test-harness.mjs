import { mkdtemp, rm } from 'node:fs/promises'
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
const ctx = {
  effect: fn => {
    const dispose = fn()
    return () => dispose?.()
  },
  on: () => () => {},
  tools: { register: () => () => {} },
  webServer: { register: () => () => {} },
  sessionController: {
    create: async () => { throw new Error('session execution is stubbed in this test') },
    resolveAgent: async () => ({ error: new Error('session execution is stubbed in this test') }),
    rename: async () => ({}),
  },
  permissionPresets: { set: () => {} },
  agents: { get: () => undefined, list: () => [] },
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
  })
  await wait(() => a.state.tasks[dispatched.taskId]?.status === 'done', 8000, 'result')
  const outTask = a.state.tasks[dispatched.taskId]
  if (!outTask.resultText.includes('stub result')) throw new Error('result text missing')
  await wait(() => b.state.tasks[dispatched.taskId]?.delivery === 'delivered', 8000, 'ack')
  console.log('task ok:', dispatched.taskId, '->', outTask.resultText)

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
