# DSH Mesh

DSH Mesh connects multiple DeepSeek Harness (DSH) hosts on a LAN. One host can
act as a parent, send tasks to child hosts, receive their results, and answer
their sensitive-action approval requests. A machine can be both a child of one
host and a parent of another.

- One bundle for every node; the role is decided by the connection, not by a
  separate install.
- The parent dials, the child listens. A machine that is only a parent can turn
  off its Mesh listener entirely, so it opens no inbound port.
- Child grants permissions to a parent explicitly. A newly paired parent has no
  permission until the child turns one on.
- Child task sessions are ordinary DSH sessions: the child's workspace shows the
  task, its session, and its current permission.
- Approval requests from a child's agent are forwarded to the parent's Mesh
  panel. If the parent is unavailable, the task waits for the configured timeout
  and then fails; nothing is auto-approved.
- Results are delivered with an acknowledgement and retried. If delivery keeps
  failing, the result is kept on the child and pushed again when the parent
  reconnects.

## Install

Clone this repository on each machine:

```powershell
git clone https://github.com/Fishexploi/dsh-mesh.git
```

Then choose the cloned `dsh-mesh` folder in **Settings → Plugins → Install from
file**. To install from npm instead, publish the package and run:

```powershell
dsh plugin --profile <profile> add dsh-mesh
```

Restart DSH (or reload the profile) after the first install. The **Mesh** icon
appears in the left rail.

The package has no third-party runtime dependencies and no install scripts.

## First connection

1. On the child, open **Mesh** and note the six-digit pairing code.
2. On the parent, open **Mesh → 手动连接**, enter the child's IP, port
   (default `45900`), and the code. Same-subnet nodes also appear under
   **局域网发现** automatically.
3. On the child, open **我的上级** and grant a permission:
   - `仅可查看`
   - `工作区内修改`
   - `完全权限`

   **No grant is given by default.** The parent cannot send a task until this
   switch is on, and a task's permission can never exceed the grant.
4. On the parent, choose the child, write the task, pick a permission, and send.

The child creates an isolated workspace under its configured root and an
ordinary DSH session titled `Mesh · <task>`. The child's local user can watch the
session and stop the task, but cannot answer the parent's approval request.

## Permissions and approvals

The child is the authority. Its local grant is the ceiling; the parent's choice
for one task is clamped to that grant. A child should grant `完全权限` only to a
parent it trusts with its local account.

When the child's agent asks for approval, the request appears in the parent's
**审批** section with the tool and reason. The parent can allow once or reject.
Approval timeout is configurable in **设置** (default 10 minutes); a timeout
fails the task. `ask_user_question` forwarding is not implemented yet.

## Online state and result delivery

A parent holds a long-lived event stream to each child; a child holds the other
end for its parent. Both sides show online only while that stream is live. When
a result cannot be delivered, the child retries it five times, marks it
“成果发送失败，等待上级上线后调取”, and sends it again after the parent
reconnects.

## Security notes

- Transport is plain HTTP with a per-connection random token and a pairing
  code. Use it on a trusted LAN, or put both ends behind a private network /
  TLS terminator. TLS is not implemented yet.
- Do not expose the mesh port to the internet. The child listener accepts only
  the narrow `/mesh` protocol, never DSH's owner `/api`.
- A parent's task is a prompt for the child's agent, not a remote shell. The
  child's sandbox, permission preset, and tool policy still apply.
- Treat child results as untrusted content when they return to the parent.
- Only share a task output directory, not a whole disk. Artifacts are copied
  through the authenticated mesh connection and served from the parent's local
  download endpoint.

## Layout

```
dsh-mesh/
  index.js           Host half: listener, parent dialer, tasks, approvals, API
  client.js          Sidebar icon and main Mesh panel
  cordis.patch.yml   Bundle row
  locale/            Plugin-manager title and description
  icon.svg
```

## Limitations

- One parent per child (a child may have several children of its own).
- A parent does not inherit a child's children; connect the grandchild directly
  if the parent should task it.
- In-flight tasks are marked failed on a node restart; durable task replay is
  planned.
- Artifacts are capped at 16 files / 1.5 MB each / 8 MB total per task.
- `ask_user_question` forwarding is planned.
- Requires DSH `^0.2.2-rc.1`; the host/client plugin contracts are still
  pre-1.0, so pin the DSH version across machines.

## Development

The host transport has a dependency-free test harness:

```powershell
node test-harness.mjs
```

It starts two in-process mesh nodes on loopback, pairs them, dispatches a task,
checks the parent acknowledgement, and exercises approval forwarding.
