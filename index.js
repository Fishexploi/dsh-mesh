/**
 * DSH Mesh host half.
 *
 * One plugin for every node. A node listens for its parent (child side) and
 * may dial its own children (parent side). A machine can be both.
 *
 * Transport: plain HTTP on the LAN.
 *   POST /mesh/hello   first contact / reconnect (pairing code or token)
 *   GET  /mesh/events  long-lived NDJSON stream, child -> parent
 *   POST /mesh/rpc     parent -> child commands
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { get as httpsGetRequest } from 'node:https'
import { execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTOCOL = 1
const DISCOVERY_PORT = 45901
const DEFAULT_PORT = 45900
const UPDATE_REPO = 'Fishexploi/dsh-mesh'
const UPDATE_BRANCH = 'main'
const UPDATE_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'package.json',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
  'README.en.md',
  'LICENSE',
]
const PERMISSIONS = ['none', 'read-only', 'workspace-write', 'danger-full-access']
const RANK = { none: 0, 'read-only': 1, 'workspace-write': 2, 'danger-full-access': 3 }
const TASK_LIMIT = 120
const ARTIFACT_TOTAL = 8 * 1024 * 1024
const ARTIFACT_EACH = 1.5 * 1024 * 1024
const ARTIFACT_FILES = 16
const RESULT_TEXT_LIMIT = 200 * 1024

const now = () => Date.now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const permission = value => (PERMISSIONS.includes(value) ? value : 'none')
const rank = value => RANK[permission(value)] || 0
const usablePermission = value => permission(value) !== 'none'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function sixDigits() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function short(value, max = 400) {
  const text = String(value == null ? '' : value)
  return text.length <= max ? text : text.slice(0, max) + '...'
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function compareVersions(a, b) {
  const parse = value => String(value || '0').split('-')[0].split('.').map(part => Number(part) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0)
  }
  return 0
}

function httpsBuffer(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = httpsGetRequest(url, {
      headers: {
        'user-agent': 'dsh-mesh-updater',
        accept: '*/*',
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(httpsBuffer(next, timeoutMs))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode + ' ' + url))
        return
      }
      const chunks = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > 4 * 1024 * 1024) {
          reject(new Error('下载内容过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求不是有效 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function parseUrl(req) {
  try {
    return new URL(req.url || '/', 'http://mesh.local')
  } catch {
    return new URL('/', 'http://mesh.local')
  }
}

function safeSegment(value) {
  const name = String(value == null ? '' : value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  return name && name !== '.' && name !== '..' ? name : 'artifact'
}

function contentType(name) {
  const ext = extname(name).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.md' || ext === '.txt' || ext === '.log' || ext === '.csv') return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

function lastAssistantText(session) {
  try {
    const events = session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'assistant/message') continue
      const content = event.data && event.data.message && event.data.message.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter(block => block && block.type === 'text')
        .map(block => block.text)
        .join('\n\n')
        .trim()
      if (text) return text.slice(0, RESULT_TEXT_LIMIT)
    }
  } catch {
    // A missing or closed session simply yields no text.
  }
  return ''
}

async function collectArtifacts(root, since) {
  const artifacts = []
  let total = 0
  const walk = async dir => {
    if (artifacts.length >= ARTIFACT_FILES || total >= ARTIFACT_TOTAL) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (artifacts.length >= ARTIFACT_FILES || total >= ARTIFACT_TOTAL) return
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.dsh') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        if (info.mtimeMs < since - 1500 || info.size <= 0 || info.size > ARTIFACT_EACH) continue
        if (total + info.size > ARTIFACT_TOTAL) continue
        const data = await readFile(full)
        artifacts.push({
          name: full.slice(root.length + 1).split(sep).join('/'),
          bytes: data.length,
          data: data.toString('base64'),
        })
        total += data.length
      } catch {
        // The file may vanish while the task is finishing.
      }
    }
  }
  await walk(root)
  return artifacts
}

export const inject = ['webServer', 'tools', 'agents', 'sessionController', 'permissionPresets']

class Mesh {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = config && typeof config === 'object' ? config : {}
    this.dir = this.config.stateDir || join(dshHome(), 'state', 'dsh-mesh')
    this.packageDir = dirname(fileURLToPath(import.meta.url))
    this.version = '0.0.0'
    this.file = join(this.dir, 'state.json')
    this.downloads = join(this.dir, 'downloads')
    this.state = this.defaultState()
    this.server = null
    this.port = 0
    this.serverError = ''
    this.parentStream = null
    this.parentOnline = false
    this.children = new Map()
    this.discovered = new Map()
    this.discovery = null
    this.broadcaster = null
    this.broadcastTimer = null
    this.cleanupTimer = null
    this.pendingApprovals = new Map()
    this.ackWaiters = new Map()
    this.running = 0
    this.queue = []
    this.workerSessions = new Set()
    this.chatDisposers = new Map()
    this.intercepts = new Map()
    this.saveTimer = null
    this.stopped = false
    this.ready = false
  }

  defaultState() {
    return {
      version: 1,
      build: 4,
      stage: 'new',
      nodeId: randomUUID(),
      name: this.config.name || hostname() || 'DSH node',
      listenPort: Number(this.config.port) > 0 ? Number(this.config.port) : DEFAULT_PORT,
      listenEnabled: this.config.listenEnabled !== false,
      allowParent: this.config.allowParent !== false,
      workspaceRoot: this.config.workspaceRoot || join(this.dir, 'workspaces'),
      pairingCode: sixDigits(),
      parent: null,
      children: {},
      tasks: {},
      approvals: {},
      settings: { approvalTimeoutMs: 600000, maxConcurrent: 2 },
    }
  }

  start() {
    this.init().catch(error => {
      this.serverError = messageOf(error)
      this.state.lastError = this.serverError
      console.error('[dsh-mesh] start failed: ' + this.serverError)
      this.save()
    })
    return () => this.stop()
  }

  async init() {
    this.state.stage = 'mkdir'
    await mkdir(this.dir, { recursive: true })
    await mkdir(this.downloads, { recursive: true })
    this.state.stage = 'load'
    await this.load()
    this.version = await this.readVersion()
    await mkdir(this.state.workspaceRoot, { recursive: true })
    this.recoverTasks()
    this.state.stage = 'tools'
    this.registerTools()
    this.state.stage = 'api'
    this.registerApi()
    this.state.stage = 'chat'
    this.startChatDispatch()
    this.state.stage = 'listen'
    try {
      if (this.state.listenEnabled) {
        await this.startServer()
      }
      this.state.stage = 'discovery'
      this.startDiscovery()
      this.ready = true
      this.save()
      this.connectSavedChildren()
      console.log('[dsh-mesh] ready: ' + this.state.name + ' ' + this.state.nodeId + (this.server ? ' on :' + this.port : ' (listener off)'))
    } catch (error) {
      this.serverError = '监听端口 ' + this.state.listenPort + ' 失败：' + messageOf(error)
      console.error('[dsh-mesh] ' + this.serverError)
      this.save()
    }
  }

  async readVersion() {
    try {
      const manifest = JSON.parse(await readFile(join(this.packageDir, 'package.json'), 'utf8'))
      return String(manifest.version || '0.0.0')
    } catch {
      return '0.0.0'
    }
  }

  async load() {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      const base = this.defaultState()
      this.state = {
        ...base,
        ...parsed,
        children: parsed.children && typeof parsed.children === 'object' ? parsed.children : {},
        tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
        approvals: {},
        settings: { ...base.settings, ...(parsed.settings || {}) },
      }
      this.state.nodeId = parsed.nodeId || randomUUID()
      this.state.pairingCode = parsed.pairingCode || sixDigits()
      this.state.allowParent = parsed.allowParent !== false
      this.state.listenEnabled = parsed.listenEnabled !== false
      this.state.listenPort = Number(parsed.listenPort) > 0 ? Number(parsed.listenPort) : DEFAULT_PORT
      this.state.workspaceRoot = parsed.workspaceRoot || join(this.dir, 'workspaces')
      for (const child of Object.values(this.state.children)) {
        if (!child.alias) child.alias = this.nextChildAlias(child.id)
      }
    } catch (error) {
      console.error('[dsh-mesh] state file ignored: ' + messageOf(error))
      this.state = this.defaultState()
    }
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const body = JSON.stringify(this.state, null, 2)
      const temp = this.file + '.' + process.pid + '.tmp'
      writeFile(temp, body, 'utf8')
        .then(() => rename(temp, this.file))
        .catch(error => {
          console.error('[dsh-mesh] save failed: ' + messageOf(error))
        })
    }, 120)
    if (this.saveTimer.unref) this.saveTimer.unref()
  }

  pruneTasks() {
    const entries = Object.entries(this.state.tasks)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
    for (let i = TASK_LIMIT; i < entries.length; i += 1) delete this.state.tasks[entries[i][0]]
  }

  recoverTasks() {
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'queued' || task.status === 'running' || task.delivery === 'sending') {
        task.status = 'failed'
        task.error = task.error || '节点重启，任务中断'
        task.endedAt = task.endedAt || now()
        if (task.direction === 'in') task.delivery = 'pending'
      }
    }
  }

  // ── child listener ──────────────────────────────────────────────────────

  async startServer() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve))
      this.server = null
    }
    const server = createHttpServer((req, res) => {
      this.handleRequest(req, res).catch(error => {
        if (!res.headersSent) json(res, 500, { error: messageOf(error) })
        else res.destroy()
      })
    })
    server.on('clientError', (_error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        socket.destroy()
      }
    })
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.state.listenPort, '0.0.0.0')
    })
    this.server = server
    this.port = server.address().port
    this.state.listenPort = this.port
    this.serverError = ''
    this.save()
    console.log('[dsh-mesh] listening on 0.0.0.0:' + this.port)
  }

  async restartServer() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve))
      this.server = null
    }
    await this.startServer()
    this.broadcastNow()
  }

  async handleRequest(req, res) {
    const url = parseUrl(req)
    if (url.pathname === '/mesh/hello' && req.method === 'POST') return this.handleHello(req, res)
    if (url.pathname === '/mesh/events' && req.method === 'GET') return this.handleEvents(req, res, url)
    if (url.pathname === '/mesh/rpc' && req.method === 'POST') return this.handleRpc(req, res, url)
    if (url.pathname === '/mesh/info' && req.method === 'GET') {
      return json(res, 200, {
        protocol: PROTOCOL,
        nodeId: this.state.nodeId,
        name: this.state.name,
        port: this.port,
      })
    }
    json(res, 404, { error: 'not found' })
  }

  async handleHello(req, res) {
    if (!this.state.allowParent) {
      json(res, 403, { error: '本机未允许成为下级' })
      return
    }
    let body
    try {
      body = await readBody(req, 64 * 1024)
    } catch (error) {
      json(res, 400, { error: messageOf(error) })
      return
    }
    if (body.protocol !== PROTOCOL) {
      json(res, 426, { error: '协议版本不一致：本机 ' + PROTOCOL + '，对方 ' + body.protocol })
      return
    }
    const parentId = String(body.nodeId || '')
    const parentName = String(body.name || 'parent').slice(0, 80)
    if (!parentId) {
      json(res, 400, { error: '缺少节点 ID' })
      return
    }
    const existing = this.state.parent
    let token = existing ? existing.token : ''
    if (existing) {
      if (existing.id !== parentId) {
        json(res, 409, { error: '本机已绑定上级 ' + existing.name + '，请先断开' })
        return
      }
      if (String(body.token || '') !== existing.token && String(body.code || '') !== this.state.pairingCode) {
        json(res, 401, { error: '配对码或令牌不正确' })
        return
      }
      existing.name = parentName
      existing.lastSeen = now()
      if (!token) token = randomBytes(24).toString('hex')
      existing.token = token
    } else {
      if (String(body.code || '') !== this.state.pairingCode) {
        json(res, 401, { error: '配对码不正确' })
        return
      }
      token = randomBytes(24).toString('hex')
      this.state.parent = {
        id: parentId,
        name: parentName,
        token,
        grant: 'none',
        pairedAt: now(),
        lastSeen: now(),
      }
      console.log('[dsh-mesh] parent paired: ' + parentName + ' (' + parentId + ')')
    }
    this.save()
    json(res, 200, {
      ok: true,
      protocol: PROTOCOL,
      token,
      node: { id: this.state.nodeId, name: this.state.name, port: this.port },
      grant: this.state.parent.grant,
    })
  }

  handleEvents(req, res, url) {
    const token = String(url.searchParams.get('token') || '')
    const parent = this.state.parent && token && this.state.parent.token === token ? this.state.parent : null
    if (!parent) {
      json(res, 401, { error: '令牌无效' })
      return
    }
    if (this.parentStream) {
      try {
        this.parentStream.end()
      } catch {
        // Old stream is already closed.
      }
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      node: { id: this.state.nodeId, name: this.state.name, port: this.port },
      grant: parent.grant,
    }) + '\n')
    this.parentStream = res
    this.parentOnline = true
    parent.lastSeen = now()
    this.save()

    const heartbeat = setInterval(() => {
      if (this.parentStream !== res) return
      try {
        res.write(JSON.stringify({ type: 'ping', time: now() }) + '\n')
      } catch {
        this.closeParentStream(res)
      }
    }, 15000)
    if (heartbeat.unref) heartbeat.unref()

    const done = () => {
      clearInterval(heartbeat)
      this.closeParentStream(res)
    }
    res.on('close', done)
    res.on('error', done)
    this.sendPendingResults()
  }

  closeParentStream(stream = this.parentStream) {
    if (!stream) return
    if (this.parentStream === stream) {
      this.parentStream = null
      this.parentOnline = false
      if (this.state.parent) this.state.parent.lastSeen = now()
      this.save()
      console.log('[dsh-mesh] parent stream closed')
    }
    try {
      stream.end()
    } catch {
      // Already closed.
    }
  }

  writeParent(frame) {
    if (!this.parentStream || !this.parentOnline) return false
    try {
      this.parentStream.write(JSON.stringify(frame) + '\n')
      return true
    } catch {
      this.closeParentStream()
      return false
    }
  }

  async handleRpc(req, res, url) {
    const token = String(url.searchParams.get('token') || '')
    const parent = this.state.parent && token && this.state.parent.token === token ? this.state.parent : null
    if (!parent) {
      json(res, 401, { error: '令牌无效' })
      return
    }
    parent.lastSeen = now()
    let body
    try {
      body = await readBody(req, 2 * 1024 * 1024)
    } catch (error) {
      json(res, 400, { error: messageOf(error) })
      return
    }
    try {
      const value = await this.rpc(parent, String(body.method || ''), body.params || {})
      json(res, 200, { ok: true, value })
    } catch (error) {
      json(res, 400, { ok: false, error: messageOf(error) })
    }
  }

  async rpc(parent, method, params) {
    if (method === 'ping') return { time: now() }
    if (method === 'state') {
      return {
        node: { id: this.state.nodeId, name: this.state.name },
        grant: parent.grant,
        tasks: Object.values(this.state.tasks)
          .filter(task => task.direction === 'in')
          .slice(-40)
          .map(task => this.publicTask(task)),
      }
    }
    if (method === 'task') return this.acceptTask(parent, params.task || params)
    if (method === 'cancel') return this.cancelIncomingTask(String(params.taskId || ''))
    if (method === 'approval') return this.decideApproval(String(params.approvalId || ''), String(params.decision || ''))
    if (method === 'ack') return this.ackResult(String(params.taskId || ''))
    throw new Error('未知方法：' + method)
  }

  acceptTask(parent, input) {
    const permissionValue = permission(input.permission)
    if (!usablePermission(permissionValue)) throw new Error('任务权限无效')
    if (rank(permissionValue) > rank(parent.grant)) {
      throw new Error('上级当前只被授予 ' + parent.grant + '，不能执行 ' + permissionValue)
    }
    const prompt = String(input.prompt || '').trim()
    if (!prompt) throw new Error('任务内容为空')
    const suppliedId = String(input.id || '').trim()
    const id = /^task-[A-Za-z0-9-]{8,}$/.test(suppliedId) ? suppliedId : 'task-' + randomUUID()
    const task = {
      id,
      direction: 'in',
      peerId: parent.id,
      peerName: parent.name,
      title: String(input.title || short(prompt, 24)).slice(0, 120),
      prompt,
      permission: permissionValue,
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      sessionId: null,
      workspace: null,
      resultText: '',
      error: '',
      artifacts: [],
      delivery: 'none',
      deliveryAttempts: 0,
      deliveryError: '',
      finished: false,
    }
    this.state.tasks[id] = task
    this.pruneTasks()
    this.save()
    this.queue.push(id)
    this.pump()
    return { taskId: id, status: 'queued' }
  }

  pump() {
    if (this.stopped) return
    const limit = Math.max(1, Math.min(8, Number(this.state.settings.maxConcurrent) || 2))
    while (this.running < limit && this.queue.length) {
      const taskId = this.queue.shift()
      const task = this.state.tasks[taskId]
      if (!task || task.status !== 'queued') continue
      this.running += 1
      this.runIncomingTask(task)
        .catch(error => this.failTask(task, messageOf(error)))
        .finally(() => {
          this.running = Math.max(0, this.running - 1)
          this.pump()
        })
    }
  }

  async runIncomingTask(task) {
    task.status = 'running'
    task.startedAt = now()
    this.save()
    this.writeParent({ type: 'task_status', task: this.publicTask(task) })

    const dir = join(this.state.workspaceRoot, safeSegment(task.id))
    await mkdir(dir, { recursive: true })
    task.workspace = dir
    this.save()

    const sessionId = 'mesh-' + task.id.slice(5)
    try {
      const created = await this.createSession(sessionId, dir)
      const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
      if (resolved.error) throw resolved.error
      const agent = resolved.agent
      task.sessionId = created.sessionId
      this.workerSessions.add(created.sessionId)
      this.save()
      agent.ctx.on('approval/request', async (req, next) => {
        if (task.finished) return next()
        return this.requestApproval(task, req)
      })
      // A task received from a parent must not be re-delegated through this
      // node's own children: the parent can only command the nodes it paired
      // with directly. The worker also does not need to inspect the mesh.
      try {
        agent.ctx.tools.restrict({ deny: ['mesh_peers', 'mesh_task', 'mesh_tasks'] })
      } catch (error) {
        console.log('[dsh-mesh] worker tool restriction skipped: ' + messageOf(error))
      }
      this.applyPermission(agent, task.permission)
      try {
        await this.ctx.sessionController.rename({ sessionId: created.sessionId, title: 'Mesh · ' + task.title })
      } catch {
        // Title is cosmetic.
      }
      await agent.followup({
        content: [{ type: 'text', text: this.workerPrompt(task) }],
        source: { kind: 'user' },
      })
      await agent.whenIdle()
      if (task.finished) return
      const events = agent.session.snapshotEvents()
      let lastEnd = null
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'turn/end') {
          lastEnd = events[i]
          break
        }
      }
      if (lastEnd && lastEnd.data && lastEnd.data.reason && lastEnd.data.reason.kind !== 'completed') {
        const reason = lastEnd.data.reason
        const failure = reason.kind === 'error' && reason.error
          ? (reason.error.message || reason.error.code || '模型调用失败')
          : '本轮未正常完成：' + reason.kind
        if (task.status !== 'failed') this.failTask(task, failure)
        return
      }
      const text = lastAssistantText(agent.session)
      task.resultText = text || '任务完成，但没有文本输出。'
      task.artifacts = await collectArtifacts(dir, task.startedAt || task.createdAt)
      task.status = 'done'
      task.endedAt = now()
      task.finished = true
      this.save()
      await this.finishTask(task)
    } catch (error) {
      if (!task.finished) this.failTask(task, messageOf(error))
    }
  }

  async createSession(sessionId, cwd) {
    const preset = this.config.agentPreset || 'standard'
    try {
      return await this.ctx.sessionController.create({ sessionId, cwd, agentPreset: preset })
    } catch (error) {
      console.log('[dsh-mesh] preset ' + preset + ' unavailable, retrying without it: ' + messageOf(error))
      return await this.ctx.sessionController.create({ sessionId, cwd })
    }
  }

  applyPermission(agent, value) {
    try {
      this.ctx.permissionPresets.set(agent.session, value)
    } catch (error) {
      console.error('[dsh-mesh] permission ' + value + ' could not be applied: ' + messageOf(error))
      throw error
    }
  }

  workerPrompt(task) {
    return [
      'You are a child DSH node executing a task sent by parent DSH host "' + task.peerName + '" over DSH Mesh.',
      'Task title: ' + task.title,
      'Workspace: ' + task.workspace,
      'Effective permission: ' + task.permission,
      '',
      'Rules:',
      '- Work only inside the task workspace.',
      '- Complete the task, then finish with a concise report: what you did, the result, and the files you changed.',
      '- If a sensitive action needs approval, the request is forwarded to the parent. Wait for its decision.',
      '- Do not ask the local user questions unless the task explicitly requires a decision from the parent.',
      '',
      'Task from parent:',
      task.prompt,
    ].join('\n')
  }

  failTask(task, message) {
    if (!task || task.finished) return
    task.status = 'failed'
    task.error = message
    task.endedAt = now()
    task.finished = true
    this.save()
    this.finishTask(task).catch(error => {
      console.error('[dsh-mesh] finish failed: ' + messageOf(error))
    })
  }

  async finishTask(task) {
    if (task.direction !== 'in') return
    task.delivery = 'pending'
    task.deliveryAttempts = 0
    this.save()
    await this.deliverResult(task)
  }

  resultFrame(task) {
    return {
      type: 'result',
      task: this.publicTask(task),
      artifacts: task.artifacts || [],
    }
  }

  async deliverResult(task) {
    if (!task.finished || task.delivery === 'delivered') return
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (this.stopped || !this.parentStream || !this.parentOnline) break
      task.deliveryAttempts = attempt
      task.delivery = 'sending'
      this.save()
      if (!this.writeParent(this.resultFrame(task))) break
      if (await this.waitForAck(task.id, 5000)) {
        task.delivery = 'delivered'
        task.deliveryError = ''
        this.save()
        return
      }
      await sleep(800 * attempt)
    }
    task.delivery = 'failed'
    task.deliveryError = '成果发送失败，等待上级上线后调取'
    this.save()
    // The parent is not acknowledging; treat the link as offline so both sides
    // show the truth, and let the reconnect path push the pending result.
    this.closeParentStream()
    console.log('[dsh-mesh] result delivery failed: ' + task.id)
  }

  waitForAck(taskId, timeoutMs) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(taskId)
        resolve(false)
      }, timeoutMs)
      if (timer.unref) timer.unref()
      this.ackWaiters.set(taskId, () => {
        clearTimeout(timer)
        this.ackWaiters.delete(taskId)
        resolve(true)
      })
    })
  }

  ackResult(taskId) {
    const waiter = this.ackWaiters.get(taskId)
    if (waiter) waiter()
    const task = this.state.tasks[taskId]
    if (task && task.direction === 'in') {
      task.delivery = 'delivered'
      task.deliveryError = ''
      this.save()
    }
    return { ok: true }
  }

  sendPendingResults() {
    if (!this.parentStream) return
    const pending = Object.values(this.state.tasks)
      .filter(task => task.direction === 'in' && task.finished && task.delivery !== 'delivered')
      .sort((a, b) => (a.endedAt || a.createdAt) - (b.endedAt || b.createdAt))
    for (const task of pending) {
      task.deliveryAttempts = 0
      this.deliverResult(task).catch(error => {
        console.error('[dsh-mesh] pending result: ' + messageOf(error))
      })
    }
  }

  async cancelIncomingTask(taskId) {
    const task = this.state.tasks[taskId]
    if (!task) throw new Error('任务不存在')
    if (task.direction !== 'in') throw new Error('不是本机任务')
    if (task.finished) return { ok: true }
    task.status = 'cancelled'
    task.error = '任务被取消'
    task.endedAt = now()
    task.finished = true
    const agent = task.sessionId ? this.ctx.agents.get(task.sessionId) : undefined
    try {
      if (agent) agent.cancel({ kind: 'user' })
    } catch {
      // Cancellation is best-effort.
    }
    this.save()
    await this.finishTask(task)
    return { ok: true }
  }

  // ── approvals ───────────────────────────────────────────────────────────

  async requestApproval(task, req) {
    const approval = {
      id: 'approval-' + randomUUID(),
      taskId: task.id,
      taskTitle: task.title,
      peerId: task.peerId,
      peerName: task.peerName,
      toolName: String(req.toolName || 'tool'),
      reason: String(req.reason || ''),
      displayReason: req.displayReason || null,
      createdAt: now(),
      status: 'pending',
      direction: 'in',
    }
    this.state.approvals[approval.id] = approval
    task.approvalPending = true
    this.save()
    this.writeParent({
      type: 'approval_request',
      approval: {
        id: approval.id,
        taskId: task.id,
        taskTitle: task.title,
        permission: task.permission,
        toolName: approval.toolName,
        reason: approval.reason,
        displayReason: approval.displayReason,
        createdAt: approval.createdAt,
      },
    })
    const timeoutMs = Math.max(5000, Number(this.state.settings.approvalTimeoutMs) || 600000)
    const decision = await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(approval.id)
        resolve('timeout')
      }, timeoutMs)
      if (timer.unref) timer.unref()
      const onAbort = () => {
        clearTimeout(timer)
        this.pendingApprovals.delete(approval.id)
        resolve('cancelled')
      }
      if (req.signal) {
        if (req.signal.aborted) onAbort()
        else req.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pendingApprovals.set(approval.id, value => {
        clearTimeout(timer)
        if (req.signal) req.signal.removeEventListener('abort', onAbort)
        this.pendingApprovals.delete(approval.id)
        resolve(value)
      })
    })

    if (decision === 'timeout' || decision === 'cancelled') {
      approval.status = decision === 'timeout' ? 'timeout' : 'cancelled'
      task.approvalPending = false
      this.save()
      this.writeParent({ type: 'approval_closed', approvalId: approval.id, decision: 'cancelled' })
      const agent = task.sessionId ? this.ctx.agents.get(task.sessionId) : undefined
      try {
        if (agent) agent.cancel({ kind: 'user' })
      } catch {
        // Ignore.
      }
      this.failTask(task, decision === 'timeout' ? '等待上级审批超时，任务失败' : '审批被取消')
      return 'cancelled'
    }
    approval.status = decision === 'allowed-once' ? 'allowed' : 'rejected'
    task.approvalPending = false
    this.save()
    this.writeParent({ type: 'approval_closed', approvalId: approval.id, decision })
    return decision === 'allowed-once' ? 'allowed-once' : 'rejected'
  }

  decideApproval(approvalId, decision) {
    const approval = this.state.approvals[approvalId]
    if (!approval || approval.status !== 'pending') throw new Error('审批请求不存在或已处理')
    const resolver = this.pendingApprovals.get(approvalId)
    if (!resolver) throw new Error('审批请求已失效')
    resolver(decision === 'allowed-once' ? 'allowed-once' : 'rejected')
    return { ok: true }
  }

  // ── parent side ─────────────────────────────────────────────────────────

  connectSavedChildren() {
    for (const child of Object.values(this.state.children)) {
      if (child.token) this.openChildStream(child)
    }
  }

  childRuntime(id) {
    let runtime = this.children.get(id)
    if (!runtime) {
      runtime = { child: null, stream: null, online: false, retry: null }
      this.children.set(id, runtime)
    }
    return runtime
  }

  nextChildAlias(excludeId) {
    const used = new Set(Object.values(this.state.children)
      .filter(child => child.id !== excludeId && child.alias)
      .map(child => child.alias))
    for (let index = 0; index < 1000; index += 1) {
      const alias = index < 26
        ? '服务器' + String.fromCharCode(65 + index)
        : '服务器' + String(index + 1)
      if (!used.has(alias)) return alias
    }
    return '服务器' + randomUUID().slice(0, 4)
  }

  async helloChild(child, code) {
    const response = await this.httpJson(child.host, child.port, '/mesh/hello', 'POST', {
      protocol: PROTOCOL,
      nodeId: this.state.nodeId,
      name: this.state.name,
      code: code || undefined,
      token: child.token || undefined,
    }, 8000)
    if (!response.ok) throw new Error(response.error || '配对失败')
    child.id = response.node.id
    child.name = response.node.name || child.name
    child.port = response.node.port || child.port
    child.token = response.token
    child.grant = permission(response.grant || 'none')
    child.lastSeen = now()
    if (!child.alias) child.alias = this.nextChildAlias(child.id)
    if (!child.pairedAt) child.pairedAt = now()
    this.state.children[child.id] = child
    this.save()
    return child
  }

  async connectChild(input) {
    const host = String(input.host || '').trim()
    const port = Number(input.port)
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('地址或端口无效')
    const code = String(input.code || '').trim()
    let child = input.id && this.state.children[input.id]
    if (!child) {
      child = {
        id: input.id || 'pending-' + randomUUID(),
        name: input.name || host,
        host,
        port,
        token: '',
        grant: 'none',
        pairedAt: null,
        lastSeen: 0,
      }
      this.state.children[child.id] = child
    } else {
      child.host = host
      child.port = port
    }
    const previousId = child.id
    await this.helloChild(child, code)
    if (previousId !== child.id) delete this.state.children[previousId]
    this.state.children[child.id] = child
    this.save()
    this.openChildStream(child)
    return this.publicChild(child)
  }

  openChildStream(child) {
    const runtime = this.childRuntime(child.id)
    runtime.child = child
    if (runtime.stream) {
      try {
        runtime.stream.destroy()
      } catch {
        // Old stream is gone.
      }
      runtime.stream = null
    }
    if (runtime.retry) {
      clearTimeout(runtime.retry)
      runtime.retry = null
    }
    const req = httpRequest({
      host: child.host,
      port: child.port,
      path: '/mesh/events?token=' + encodeURIComponent(child.token || ''),
      method: 'GET',
      headers: { accept: 'application/x-ndjson' },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        runtime.online = false
        child.lastSeen = now()
        this.save()
        this.scheduleChildRetry(child)
        return
      }
      runtime.stream = res
      runtime.online = true
      child.lastSeen = now()
      this.save()
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          try {
            this.handleChildFrame(child, JSON.parse(line))
          } catch (error) {
            console.error('[dsh-mesh] bad frame from ' + child.name + ': ' + messageOf(error))
          }
        }
      })
      const finish = () => {
        if (runtime.stream === res) runtime.stream = null
        runtime.online = false
        child.lastSeen = now()
        this.save()
        this.scheduleChildRetry(child)
      }
      res.on('end', finish)
      res.on('close', finish)
      res.on('error', finish)
    })
    req.on('error', error => {
      runtime.online = false
      child.lastSeen = now()
      this.save()
      console.log('[dsh-mesh] child ' + child.name + ' offline: ' + messageOf(error))
      this.scheduleChildRetry(child)
    })
    req.end()
  }

  scheduleChildRetry(child) {
    const runtime = this.childRuntime(child.id)
    if (this.stopped || !this.state.children[child.id] || !child.token || runtime.retry) return
    runtime.retry = setTimeout(() => {
      runtime.retry = null
      if (!this.stopped && this.state.children[child.id]) this.openChildStream(child)
    }, 5000)
    if (runtime.retry.unref) runtime.retry.unref()
  }

  handleChildFrame(child, frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'hello') {
      child.grant = permission(frame.grant || child.grant)
      child.name = (frame.node && frame.node.name) || child.name
      child.port = (frame.node && frame.node.port) || child.port
      child.lastSeen = now()
      this.save()
      return
    }
    if (frame.type === 'grant') {
      child.grant = permission(frame.grant)
      child.lastSeen = now()
      this.save()
      return
    }
    if (frame.type === 'task_status') {
      const task = this.state.tasks[frame.task && frame.task.id]
      if (task) {
        Object.assign(task, this.safeTaskPatch(frame.task))
        this.save()
      }
      return
    }
    if (frame.type === 'result') {
      this.receiveResult(child, frame).catch(error => {
        console.error('[dsh-mesh] result handling failed: ' + messageOf(error))
      })
      return
    }
    if (frame.type === 'approval_request') {
      const source = frame.approval || {}
      if (!source.id) return
      this.state.approvals[source.id] = {
        ...source,
        peerId: child.id,
        peerName: child.alias || child.name,
        direction: 'out',
        status: 'pending',
        createdAt: source.createdAt || now(),
      }
      this.save()
      return
    }
    if (frame.type === 'approval_closed') {
      const approval = this.state.approvals[frame.approvalId]
      if (approval) approval.status = frame.decision === 'allowed-once' ? 'allowed' : 'rejected'
      this.save()
    }
  }

  safeTaskPatch(source = {}) {
    const patch = {}
    const keys = ['status', 'startedAt', 'endedAt', 'resultText', 'error', 'sessionId', 'workspace', 'delivery', 'deliveryError']
    for (const key of keys) if (key in source) patch[key] = source[key]
    return patch
  }

  async receiveResult(child, frame) {
    const input = frame.task || {}
    let task = this.state.tasks[input.id]
    if (!task) {
      task = {
        id: String(input.id || 'task-' + randomUUID()),
        direction: 'out',
        peerId: child.id,
        peerName: child.alias || child.name,
        title: input.title || '未命名任务',
        prompt: '',
        permission: permission(input.permission),
        status: 'done',
        createdAt: input.createdAt || now(),
        parentSessionId: '',
        artifacts: [],
        notified: true,
      }
      this.state.tasks[task.id] = task
    }
    Object.assign(task, this.safeTaskPatch(input))
    task.status = input.status === 'failed' ? 'failed' : 'done'
    task.resultText = String(input.resultText || '')
    task.error = String(input.error || '')
    task.endedAt = input.endedAt || now()
    task.delivery = 'delivered'
    task.artifacts = await this.saveArtifacts(task, frame.artifacts || [])
    this.save()
    await this.rpcChild(child, 'ack', { taskId: task.id }).catch(() => {})
    if (!task.notified) {
      task.notified = true
      this.save()
      this.notifyParentAgent(task).catch(error => {
        console.error('[dsh-mesh] notify parent failed: ' + messageOf(error))
      })
    }
  }

  async saveArtifacts(task, artifacts) {
    const root = join(this.downloads, safeSegment(task.id))
    const saved = []
    for (const artifact of artifacts.slice(0, ARTIFACT_FILES)) {
      const name = String((artifact && artifact.name) || 'artifact')
      const relative = name.split('/').map(safeSegment).join('/')
      const target = resolve(root, relative)
      if (!target.startsWith(resolve(root) + sep) && target !== resolve(root)) continue
      try {
        const data = Buffer.from(String((artifact && artifact.data) || ''), 'base64')
        if (data.length > ARTIFACT_EACH) continue
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, data)
        saved.push({ name: relative, bytes: data.length, file: target })
      } catch (error) {
        console.log('[dsh-mesh] artifact ' + name + ' skipped: ' + messageOf(error))
      }
    }
    return saved
  }

  async notifyParentAgent(task) {
    if (!task.parentSessionId) return
    const agent = this.ctx.agents.get(task.parentSessionId)
    if (!agent) return
    const status = task.status === 'done' ? '已完成' : '失败'
    const lines = [
      '[DSH Mesh] 子级「' + task.peerName + '」的任务「' + task.title + '」' + status + '。',
      '',
      task.resultText || task.error || '（无输出）',
    ]
    if (task.artifacts && task.artifacts.length) {
      lines.push('', '结果文件：' + task.artifacts.map(item => item.name).join('、'))
    }
    await agent.followup({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: { kind: 'user' },
    })
  }

  isWorkerLineage(sessionId) {
    if (!sessionId) return false
    let current = sessionId
    const seen = new Set()
    while (current && !seen.has(current)) {
      if (this.workerSessions.has(current)) return true
      seen.add(current)
      const agent = this.ctx.agents.get(current)
      current = agent && agent.session && agent.session.header
        ? agent.session.header.parentSession || ''
        : ''
    }
    return false
  }

  async dispatchTask(input) {
    const peerId = String(input.peerId || '')
    const child = this.state.children[peerId]
    if (!child) throw new Error('下级不存在')
    if (this.isWorkerLineage(String(input.parentSessionId || ''))) {
      throw new Error('本会话是上级派来的工作任务，不能向下级转派任务')
    }
    const runtime = this.children.get(peerId)
    if (!runtime || !runtime.online) throw new Error('下级当前离线')
    const requested = input.permission || (rank(child.grant) >= 2 ? 'workspace-write' : child.grant)
    const permissionValue = permission(requested)
    if (!usablePermission(permissionValue)) throw new Error('任务权限无效')
    if (rank(permissionValue) > rank(child.grant)) throw new Error('下级只授予了 ' + child.grant)
    const prompt = String(input.prompt || '').trim()
    if (!prompt) throw new Error('任务内容为空')
    const task = {
      id: 'task-' + randomUUID(),
      direction: 'out',
      peerId: child.id,
      peerName: child.alias || child.name,
      title: String(input.title || short(prompt, 24)).slice(0, 120),
      prompt,
      permission: permissionValue,
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      resultText: '',
      error: '',
      artifacts: [],
      parentSessionId: String(input.parentSessionId || ''),
      notified: false,
    }
    this.state.tasks[task.id] = task
    this.pruneTasks()
    this.save()
    try {
      const accepted = await this.rpcChild(child, 'task', {
        task: {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          permission: task.permission,
          parentName: this.state.name,
        },
      })
      if (!accepted || !accepted.taskId) throw new Error('下级没有接受任务')
      return { taskId: task.id, peer: child.name, status: 'queued' }
    } catch (error) {
      task.status = 'failed'
      task.error = messageOf(error)
      task.endedAt = now()
      this.save()
      throw error
    }
  }

  async cancelTask(taskId) {
    const task = this.state.tasks[taskId]
    if (!task) throw new Error('任务不存在')
    if (task.direction === 'in') return this.cancelIncomingTask(taskId)
    const child = this.state.children[task.peerId]
    if (child && this.childRuntime(child.id).online) await this.rpcChild(child, 'cancel', { taskId })
    task.status = 'cancelled'
    task.endedAt = now()
    this.save()
    return { ok: true }
  }

  async approve(input) {
    const approval = this.state.approvals[input.approvalId]
    if (!approval) throw new Error('审批不存在')
    if (approval.direction !== 'out') throw new Error('只有上级可以处理审批')
    const child = this.state.children[approval.peerId]
    if (!child) throw new Error('下级不存在')
    const decision = input.decision === 'allowed-once' ? 'allowed-once' : 'rejected'
    await this.rpcChild(child, 'approval', { approvalId: approval.id, decision })
    approval.status = decision === 'allowed-once' ? 'allowed' : 'rejected'
    this.save()
    return { ok: true }
  }

  setGrant(value) {
    if (!this.state.parent) throw new Error('本机还没有上级')
    const grant = permission(value)
    this.state.parent.grant = grant
    this.save()
    this.writeParent({ type: 'grant', grant })
    return { grant }
  }

  async disconnect(peerId) {
    if (this.state.parent && this.state.parent.id === peerId) {
      this.closeParentStream()
      this.state.parent = null
      this.state.pairingCode = sixDigits()
      this.save()
      this.broadcastNow()
      return { ok: true }
    }
    const child = this.state.children[peerId]
    if (!child) throw new Error('节点不存在')
    const runtime = this.children.get(peerId)
    if (runtime && runtime.retry) clearTimeout(runtime.retry)
    if (runtime && runtime.stream) {
      try {
        runtime.stream.destroy()
      } catch {
        // Ignore.
      }
    }
    this.children.delete(peerId)
    delete this.state.children[peerId]
    this.save()
    return { ok: true }
  }

  async rpcChild(child, method, params) {
    const response = await this.httpJson(
      child.host,
      child.port,
      '/mesh/rpc?token=' + encodeURIComponent(child.token || ''),
      'POST',
      { method, params },
      20000,
    )
    if (!response.ok) throw new Error(response.error || '请求失败')
    return response.value
  }

  httpJson(host, port, path, method, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body)
      const req = httpRequest({
        host,
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(raw ? JSON.parse(raw) : {})
          } catch {
            reject(new Error('节点返回了非 JSON 响应（HTTP ' + res.statusCode + '）'))
          }
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
      req.on('error', reject)
      req.end(data)
    })
  }

  // ── discovery ───────────────────────────────────────────────────────────

  startDiscovery() {
    try {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('message', (message, rinfo) => {
        try {
          const data = JSON.parse(message.toString('utf8'))
          if (!data || data.magic !== 'dsh-mesh' || data.protocol !== PROTOCOL) return
          if (data.nodeId === this.state.nodeId) return
          this.discovered.set(data.nodeId, {
            id: data.nodeId,
            name: String(data.name || rinfo.address),
            host: rinfo.address,
            port: Number(data.port) || 0,
            accepting: data.accepting !== false,
            seenAt: now(),
          })
        } catch {
          // Ignore foreign UDP traffic.
        }
      })
      socket.on('error', error => {
        console.error('[dsh-mesh] discovery socket: ' + messageOf(error))
      })
      socket.bind(DISCOVERY_PORT, '0.0.0.0')
      this.discovery = socket
    } catch (error) {
      console.error('[dsh-mesh] discovery unavailable: ' + messageOf(error))
    }
    this.cleanupTimer = setInterval(() => {
      const cutoff = now() - 15000
      for (const entry of [...this.discovered.entries()]) {
        if (entry[1].seenAt < cutoff) this.discovered.delete(entry[0])
      }
    }, 5000)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
    this.startBroadcast()
  }

  startBroadcast() {
    try {
      const socket = createSocket({ type: 'udp4' })
      socket.bind(() => {
        try {
          socket.setBroadcast(true)
        } catch {
          // Some interfaces refuse broadcast.
        }
      })
      this.broadcaster = socket
      this.broadcastTimer = setInterval(() => this.broadcastNow(), 2000)
      if (this.broadcastTimer.unref) this.broadcastTimer.unref()
      const first = setTimeout(() => this.broadcastNow(), 300)
      if (first.unref) first.unref()
    } catch (error) {
      console.error('[dsh-mesh] broadcast unavailable: ' + messageOf(error))
    }
  }

  broadcastNow() {
    if (!this.broadcaster || !this.server || this.stopped) return
    const payload = Buffer.from(JSON.stringify({
      magic: 'dsh-mesh',
      protocol: PROTOCOL,
      nodeId: this.state.nodeId,
      name: this.state.name,
      port: this.port,
      accepting: this.state.allowParent,
    }))
    try {
      this.broadcaster.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255')
    } catch {
      // Broadcast may be blocked.
    }
    try {
      this.broadcaster.send(payload, 0, payload.length, DISCOVERY_PORT, '127.0.0.1')
    } catch {
      // Ignore.
    }
  }

  // ── chat @ dispatch ─────────────────────────────────────────────────────

  startChatDispatch() {
    const attach = agent => {      if (!agent || !agent.ctx || this.workerSessions.has(agent.id) || this.chatDisposers.has(agent.id)) return
      try {
        const dispose = agent.ctx.on('agent/pre-step', async (payload, next) => {
          return this.handleChatPreStep(payload, next)
        })
        this.chatDisposers.set(agent.id, dispose)
      } catch (error) {
        console.log('[dsh-mesh] chat dispatch listener skipped: ' + messageOf(error))
      }
    }
    this.ctx.effect(() => {
      const offCreated = this.ctx.on('agent/created', ({ agent }) => attach(agent))
      const offDisposed = this.ctx.on('agent/disposed', ({ agent }) => {
        const dispose = this.chatDisposers.get(agent.id)
        if (dispose) dispose()
        this.chatDisposers.delete(agent.id)
      })
      for (const agent of this.ctx.agents.list()) attach(agent)
      this.state.chatReady = true
      this.save()
      return () => {
        offCreated()
        offDisposed()
        for (const dispose of this.chatDisposers.values()) dispose()
        this.chatDisposers.clear()
        this.state.chatReady = false
      }
    })
  }

  async handleChatPreStep(payload, next) {
    const decision = await next()
    if (decision.kind !== 'enter' || !decision.messages || !decision.messages.length) return decision
    if (this.workerSessions.has(payload.agent.id)) return decision
    let changed = false
    const messages = []
    for (const message of decision.messages) {
      const content = Array.isArray(message.content) ? message.content : []
      const text = content
        .filter(block => block && block.type === 'text')
        .map(block => block.text)
        .join('\n')
      const match = /^\s*@([^\s:：,，]+)[\s:：,，]+([\s\S]+)$/.exec(text)
      if (!match) {
        messages.push(message)
        continue
      }
      const peer = match[1].trim()
      const child = Object.values(this.state.children).find(item =>
        item.id === peer
        || (item.alias && item.alias.toLowerCase() === peer.toLowerCase())
        || item.name.toLowerCase() === peer.toLowerCase())
      if (!child) {
        messages.push(message)
        continue
      }
      const prompt = match[2].trim()
      if (!prompt) {
        messages.push(message)
        continue
      }
      const key = String(message.id || '') + '|' + child.id
      let status = this.intercepts.get(key)
      if (!status) {
        try {
          const permissionValue = rank(child.grant) >= 2 ? 'workspace-write' : child.grant
          const firstLine = prompt.split('\n')[0].trim()
          const result = await this.dispatchTask({
            peerId: child.id,
            prompt,
            title: firstLine.slice(0, 24),
            permission: permissionValue,
            parentSessionId: payload.agent.id,
          })
          status = '[DSH Mesh] 已把任务派给「' + (child.alias || child.name) + '」：' + firstLine + '\n任务号：' + result.taskId + '。结果会作为一条新消息回到这里。'
        } catch (error) {
          status = '[DSH Mesh] 派发失败：' + messageOf(error)
        }
        this.intercepts.set(key, status)
        if (this.intercepts.size > 200) {
          const first = this.intercepts.keys().next()
          if (!first.done) this.intercepts.delete(first.value)
        }
      }
      messages.push({
        ...message,
        content: [{ type: 'text', text: status }],
      })
      changed = true
    }
    return changed ? { ...decision, messages } : decision
  }

  // ── model tools ─────────────────────────────────────────────────────────

  registerTools() {
    this.ctx.effect(() => this.ctx.tools.register({
      name: 'mesh_peers',
      description: 'List DSH Mesh child hosts available to this node: online state, granted permission, and address.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => ({
        node: { id: this.state.nodeId, name: this.state.name },
        parent: this.state.parent ? {
          id: this.state.parent.id,
          name: this.state.parent.name,
          online: this.parentOnline,
          grant: this.state.parent.grant,
        } : null,
        children: Object.values(this.state.children).map(child => this.publicChild(child)),
      }),
    }))

    this.ctx.effect(() => this.ctx.tools.register({
      name: 'mesh_task',
      description: 'Send a task to one DSH Mesh child host. Returns a task id immediately; the child result is delivered later as a message to this session.',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'Child node name or node id from mesh_peers.' },
          task: { type: 'string', description: 'Complete task for the child node.' },
          title: { type: 'string', description: 'Short task title.' },
          permission: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'Requested permission; must not exceed what the child granted.',
          },
        },
        required: ['peer', 'task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        const peer = String(args.peer || '').trim()
        const child = Object.values(this.state.children).find(item =>
          item.id === peer
          || (item.alias && item.alias.toLowerCase() === peer.toLowerCase())
          || item.name.toLowerCase() === peer.toLowerCase())
        if (!child) throw new Error('找不到下级「' + peer + '」')
        return this.dispatchTask({
          peerId: child.id,
          prompt: String(args.task || ''),
          title: args.title,
          permission: args.permission,
          parentSessionId: exec && exec.agent ? exec.agent.id : '',
        })
      },
    }))

    this.ctx.effect(() => this.ctx.tools.register({
      name: 'mesh_tasks',
      description: 'List recent DSH Mesh tasks on this node.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => ({
        tasks: Object.values(this.state.tasks)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, 20)
          .map(task => this.publicTask(task)),
      }),
    }))
  }

  // ── local UI API ────────────────────────────────────────────────────────

  registerApi() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: '/mesh',
      handler: (req, res) => {
        this.handleApi(req, res).catch(error => {
          if (!res.headersSent) json(res, 500, { error: messageOf(error) })
          else res.destroy()
        })
      },
    }))
  }

  async handleApi(req, res) {
    const url = parseUrl(req)
    if (url.pathname === '/mesh/api/state' && req.method === 'GET') {
      json(res, 200, this.view())
      return
    }
    if (url.pathname === '/mesh/api/download' && req.method === 'GET') {
      await this.downloadArtifact(url, res)
      return
    }
    if (url.pathname.startsWith('/mesh/api/') && req.method === 'POST') {
      let body
      try {
        body = await readBody(req, 2 * 1024 * 1024)
      } catch (error) {
        json(res, 400, { error: messageOf(error) })
        return
      }
      try {
        const value = await this.handleApiAction(url.pathname.slice('/mesh/api/'.length), body)
        json(res, 200, { ok: true, value, state: this.view() })
      } catch (error) {
        json(res, 400, { ok: false, error: messageOf(error), state: this.view() })
      }
      return
    }
    json(res, 404, { error: 'not found' })
  }

  async handleApiAction(action, body) {
    if (action === 'settings') return this.updateSettings(body)
    if (action === 'connect') return this.connectChild(body)
    if (action === 'disconnect') return this.disconnect(String(body.peerId || ''))
    if (action === 'grant') return this.setGrant(String(body.permission || 'none'))
    if (action === 'task') return this.dispatchTask(body)
    if (action === 'cancel') return this.cancelTask(String(body.taskId || ''))
    if (action === 'approval') return this.approve(body)
    if (action === 'update-check') return this.checkUpdate()
    if (action === 'update-apply') return this.applyUpdate()
    if (action === 'pairing-code') {
      if (this.state.parent) throw new Error('已有上级，不能刷新配对码')
      this.state.pairingCode = sixDigits()
      this.save()
      return { pairingCode: this.state.pairingCode }
    }
    throw new Error('未知操作：' + action)
  }

  async updateSettings(body) {
    if (typeof body.name === 'string' && body.name.trim()) this.state.name = body.name.trim().slice(0, 80)
    if (typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim()) {
      this.state.workspaceRoot = body.workspaceRoot.trim()
      await mkdir(this.state.workspaceRoot, { recursive: true })
    }
    if (typeof body.allowParent === 'boolean') this.state.allowParent = body.allowParent
    if (Number.isFinite(Number(body.approvalTimeoutMs)) && Number(body.approvalTimeoutMs) >= 5000) {
      this.state.settings.approvalTimeoutMs = Number(body.approvalTimeoutMs)
    }
    const listenChanged = typeof body.listenEnabled === 'boolean' && body.listenEnabled !== this.state.listenEnabled
    if (typeof body.listenEnabled === 'boolean') this.state.listenEnabled = body.listenEnabled
    const nextPort = Number(body.listenPort)
    if (Number.isInteger(nextPort) && nextPort > 0 && nextPort <= 65535 && nextPort !== this.state.listenPort) {
      this.state.listenPort = nextPort
      if (this.state.listenEnabled) await this.restartServer()
    } else if (listenChanged) {
      if (!this.state.listenEnabled && this.server) {
        await new Promise(resolve => this.server.close(resolve))
        this.server = null
        this.port = 0
      } else if (this.state.listenEnabled && !this.server) {
        await this.startServer()
      }
    }
    this.save()
    this.broadcastNow()
    return this.view()
  }

  rawUpdateUrl(file) {
    return 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/' + file + '?dsh_mesh=' + Date.now()
  }

  async checkUpdate() {
    const current = await this.readVersion()
    const raw = await httpsBuffer(this.rawUpdateUrl('package.json'))
    let manifest
    try {
      manifest = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new Error('更新源返回了无效的 package.json')
    }
    const latest = String(manifest.version || '0.0.0')
    return {
      current,
      latest,
      available: compareVersions(latest, current) > 0,
      repo: 'https://github.com/' + UPDATE_REPO,
      checkedAt: now(),
    }
  }

  gitPull() {
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', this.packageDir, 'pull', '--ff-only'], {
        timeout: 30000,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message).trim()))
          return
        }
        resolve(String(stdout || '').trim())
      })
    })
  }

  async downloadUpdateFiles(latest) {
    const files = new Map()
    for (const file of UPDATE_FILES) {
      const data = await httpsBuffer(this.rawUpdateUrl(file))
      if (file === 'package.json') {
        let manifest
        try {
          manifest = JSON.parse(data.toString('utf8'))
        } catch {
          throw new Error('更新源 package.json 无效')
        }
        if (String(manifest.version || '') !== latest) {
          throw new Error('更新源版本发生变化，请重新检查更新')
        }
      }
      files.set(file, data)
    }
    for (const [file, data] of files) {
      const target = join(this.packageDir, file)
      await mkdir(dirname(target), { recursive: true })
      const temp = target + '.' + process.pid + '.mesh-update'
      await writeFile(temp, data)
      await rename(temp, target)
    }
  }

  async applyUpdate() {
    const check = await this.checkUpdate()
    if (!check.available) {
      return { ...check, updated: false, message: '已经是最新版本' }
    }
    let method = 'files'
    let gitError = ''
    if (existsSync(join(this.packageDir, '.git'))) {
      try {
        await this.gitPull()
        const pulled = await this.readVersion()
        if (compareVersions(pulled, check.latest) >= 0) {
          method = 'git'
          this.version = pulled
        } else {
          gitError = 'git pull 后版本仍为 ' + pulled
        }
      } catch (error) {
        gitError = messageOf(error)
      }
    }
    if (method !== 'git') {
      await this.downloadUpdateFiles(check.latest)
      this.version = await this.readVersion()
    }
    if (compareVersions(this.version, check.latest) < 0) {
      throw new Error('更新后版本仍为 ' + this.version + '，请检查安装目录是否可写')
    }
    const hmr = this.ctx.get('hmr')
    const reloading = Boolean(hmr && typeof hmr.runExclusive === 'function' && typeof hmr.reconcileProfile === 'function')
    if (reloading) {
      setTimeout(() => {
        hmr.runExclusive(() => hmr.reconcileProfile()).catch(error => {
          console.error('[dsh-mesh] hot reload failed: ' + messageOf(error))
        })
      }, 1200)
    }
    return {
      updated: true,
      from: check.current,
      to: this.version,
      method,
      gitError,
      reloading,
      restartRequired: !reloading,
      message: reloading ? '更新完成，正在重载插件…' : '更新完成，请重启 DSH',
    }
  }

  async downloadArtifact(url, res) {
    const taskId = String(url.searchParams.get('taskId') || '')
    const name = String(url.searchParams.get('name') || '')
    const task = this.state.tasks[taskId]
    const artifact = task && task.artifacts ? task.artifacts.find(item => item.name === name) : null
    if (!artifact || !artifact.file) {
      json(res, 404, { error: '文件不存在' })
      return
    }
    try {
      const data = await readFile(artifact.file)
      res.writeHead(200, {
        'content-type': contentType(name),
        'content-length': data.length,
        'content-disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(name.split('/').pop() || 'artifact'),
        'cache-control': 'no-store',
      })
      res.end(data)
    } catch {
      json(res, 404, { error: '文件已不存在' })
    }
  }

  // ── views / lifecycle ───────────────────────────────────────────────────

  publicChild(child) {
    const runtime = this.children.get(child.id)
    return {
      id: child.id,
      alias: child.alias || child.name,
      name: child.name,
      host: child.host,
      port: child.port,
      online: Boolean(runtime && runtime.online),
      grant: child.grant,
      lastSeen: child.lastSeen || 0,
    }
  }

  publicTask(task) {
    const value = {
      id: task.id,
      direction: task.direction,
      peerId: task.peerId,
      peerName: task.peerName,
      title: task.title,
      prompt: short(task.prompt, 4000),
      permission: task.permission,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt || null,
      endedAt: task.endedAt || null,
      resultText: task.resultText || '',
      error: task.error || '',
      delivery: task.delivery || 'none',
      deliveryError: task.deliveryError || '',
      sessionId: task.sessionId || '',
      workspace: task.workspace || '',
      approvalPending: Boolean(task.approvalPending),
    }
    if (task.artifacts && task.artifacts.length) {
      value.artifacts = task.artifacts.map(item => ({ name: item.name, bytes: item.bytes }))
    }
    return value
  }

  view() {
    const children = Object.values(this.state.children).map(child => this.publicChild(child))
    const tasks = Object.values(this.state.tasks)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 80)
      .map(task => this.publicTask(task))
    const approvals = Object.values(this.state.approvals)
      .filter(approval => approval.status === 'pending')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map(approval => ({
        id: approval.id,
        taskId: approval.taskId,
        taskTitle: approval.taskTitle || approval.taskId,
        peerId: approval.peerId,
        peerName: approval.peerName,
        direction: approval.direction,
        actionable: approval.direction === 'out',
        toolName: approval.toolName,
        reason: approval.reason,
        displayReason: approval.displayReason,
        createdAt: approval.createdAt,
      }))
    return {
      protocol: PROTOCOL,
      node: {
        id: this.state.nodeId,
        name: this.state.name,
        port: this.port,
        listenPort: this.state.listenPort,
        listening: Boolean(this.server),
        listenEnabled: this.state.listenEnabled,
        error: this.serverError,
        stage: this.state.stage,
        build: this.state.build,
        version: this.version,
        allowParent: this.state.allowParent,
        workspaceRoot: this.state.workspaceRoot,
        pairingCode: this.state.parent || !this.state.listenEnabled ? null : this.state.pairingCode,
        ready: this.ready,
        chatReady: Boolean(this.state.chatReady),
        approvalTimeoutMs: this.state.settings.approvalTimeoutMs,
        maxConcurrent: this.state.settings.maxConcurrent,
      },
      parent: this.state.parent ? {
        id: this.state.parent.id,
        name: this.state.parent.name,
        online: this.parentOnline,
        grant: this.state.parent.grant,
        lastSeen: this.state.parent.lastSeen || 0,
      } : null,
      children,
      discovered: [...this.discovered.values()]
        .filter(item => !this.state.children[item.id])
        .sort((a, b) => a.name.localeCompare(b.name)),
      tasks,
      approvals,
    }
  }

  async stop() {
    this.stopped = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    for (const resolver of this.pendingApprovals.values()) {
      try {
        resolver('cancelled')
      } catch {
        // Ignore.
      }
    }
    this.pendingApprovals.clear()
    for (const runtime of this.children.values()) {
      if (runtime.retry) clearTimeout(runtime.retry)
      if (runtime.stream) {
        try {
          runtime.stream.destroy()
        } catch {
          // Ignore.
        }
      }
    }
    this.children.clear()
    if (this.broadcastTimer) clearInterval(this.broadcastTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.broadcaster) {
      try {
        this.broadcaster.close()
      } catch {
        // Ignore.
      }
    }
    if (this.discovery) {
      try {
        this.discovery.close()
      } catch {
        // Ignore.
      }
    }
    if (this.parentStream) this.closeParentStream()
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve))
      this.server = null
    }
    try {
      await writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8')
    } catch {
      // Shutdown is best-effort.
    }
  }
}

export function apply(ctx, config) {
  const mesh = new Mesh(ctx, config)
  ctx.effect(() => {
    const dispose = mesh.start()
    return () => {
      dispose().catch(error => console.error('[dsh-mesh] stop failed: ' + messageOf(error)))
    }
  })
}

export { Mesh }
