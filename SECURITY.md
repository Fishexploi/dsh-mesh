# Security

DSH Mesh connects DSH hosts over a LAN: one parent dispatches tasks to child
nodes, children run them in their own sessions, sensitive actions are approved by
the parent. That puts a network service, a pairing flow and an approval channel
on your machine, so this file states the threat model, what the plugin does about
it, and what it deliberately does not do.

## Threat model

Assume the LAN is **not** fully trusted. Someone on the same network can:

- port-scan, connect to the listener and talk the `/mesh` protocol;
- capture traffic (the transport is plain HTTP unless you tunnel it);
- open a web page in the user's browser while the DSH web UI is running;
- spam pairing attempts against an unpaired child.

Assume the operator's own machine is trusted, and that DSH's own permissions and
sandbox still govern what an agent may do once a task arrives.

## Defaults

| Setting | Default | Meaning |
|---|---|---|
| Listener | **off** | A node does not accept parents until you turn it on |
| Listen address | `127.0.0.1` | Even when on, only the local machine is reachable |
| Discovery | off | UDP announcement follows the listener switch |
| Parent grant | `none` | A newly paired parent may do nothing until the child grants |

A profile upgraded from an older version keeps the listener state it already
had, so upgrading never silently cuts a paired node off.

## What is enforced

- **Pairing** — the code is six digits from `crypto.randomInt`, compared in
  constant time, **single-use** (invalid after a successful pairing). The same
  source gets its code rotated after 3 failures and is locked out for 10 minutes
  after 5. The last 20 attempts are recorded and shown in the panel.
- **Tokens** — 192-bit random per pairing, sent in `Authorization: Bearer`. The
  query-string form only survives for peers older than 0.4.0. The child stores
  the token as SHA-256, never in clear.
- **Local API** — `/mesh/api/*` requires a loopback connection, a JSON content
  type and an allowed `Origin`, and answers with `nosniff`. A cross-site form or
  `text/plain` request cannot reach it, so a web page cannot drive the plugin.
- **Rate limits** — 120 actions per minute per parent; 10 event-stream opens per
  minute per source address; task concurrency is capped by `maxConcurrent`.
- **Information** — `/mesh/info` returns the protocol number only; the pairing
  code is never served while a parent is bound.

## Not covered

- **Transport encryption.** Plain HTTP. On a shared or untrusted network, tunnel
  it (WireGuard, Tailscale, SSH port-forward) or terminate TLS in front. The
  token is not in URLs any more, but task bodies are not encrypted.
- **A compromised child.** Whoever controls a child host can run whatever its
  agent can run. Grant `danger-full-access` only to hosts you would hand a shell.
- **Prompt injection through task output.** Parent agents must treat child
  results as data, not instructions; the plugin marks them as such but the model
  ultimately decides.
- **Plugin code itself.** Sources and strategies run in-process without a
  sandbox. Read the code before installing a third-party mesh plugin.

## Reporting

Open a private advisory on the repository (`Security` → `Report a vulnerability`)
or mail the maintainer listed in `package.json`. Please do not file a public issue
for anything exploitable before it is fixed.
