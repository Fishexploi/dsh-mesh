window.__ModuleLoader__.load({
  id: 'dsh-mesh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef } = React;

    let store = null;

    const TOKEN = {
      bg: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      good: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const PERMISSION_LABEL = {
      none: '未授权',
      'read-only': '仅可查看',
      'workspace-write': '工作区内修改',
      'danger-full-access': '完全权限',
    };
    const PERMISSION_RANK = { none: 0, 'read-only': 1, 'workspace-write': 2, 'danger-full-access': 3 };
    const STATUS_LABEL = {
      queued: '排队中',
      running: '进行中',
      done: '已完成',
      failed: '失败',
      cancelled: '已取消',
    };

    function timeText(value) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return '—';
      }
    }

    function createStore() {
      let snapshot = { data: null, error: '', loading: true };
      const listeners = new Set();
      let timer = null;
      let refreshing = false;

      const emit = () => listeners.forEach(listener => listener());
      const set = next => {
        snapshot = { ...snapshot, ...next };
        emit();
      };

      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          const response = await fetch('/mesh/api/state', { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          set({ data, error: '', loading: false });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error), loading: false });
        } finally {
          refreshing = false;
        }
      };

      const act = async (action, body = {}) => {
        const response = await fetch(`/mesh/api/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        let value = null;
        try {
          value = await response.json();
        } catch {
          value = null;
        }
        if (!response.ok || !value || value.ok === false) {
          throw new Error(value?.error || `HTTP ${response.status}`);
        }
        if (value.state) set({ data: value.state, error: '', loading: false });
        else await refresh();
        return value.value;
      };

      return {
        get: () => snapshot,
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        refresh,
        act,
        start() {
          refresh();
          if (!timer) timer = setInterval(refresh, 2000);
        },
        stop() {
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
    }

    const useSnapshot = React.useSyncExternalStore
      ? () => React.useSyncExternalStore(store.subscribe, store.get, store.get)
      : () => {
          const [value, setValue] = useState(store.get());
          useEffect(() => {
            setValue(store.get());
            return store.subscribe(() => setValue(store.get()));
          }, []);
          return value;
        };

    function Dot({ online, title }) {
      return h('span', {
        title: title || (online ? '在线' : '离线'),
        style: {
          width: 8,
          height: 8,
          borderRadius: 99,
          display: 'inline-block',
          background: online ? TOKEN.good : TOKEN.idle,
          boxShadow: online ? `0 0 0 3px color-mix(in srgb, ${TOKEN.good} 18%, transparent)` : 'none',
          flex: '0 0 auto',
        },
      });
    }

    function Badge({ children, tone = 'neutral' }) {
      const color = tone === 'bad' ? TOKEN.bad : tone === 'warn' ? TOKEN.warn : tone === 'good' ? TOKEN.good : TOKEN.muted;
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          lineHeight: '18px',
          padding: '0 7px',
          borderRadius: 999,
          color,
          border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
          background: `color-mix(in srgb, ${color} 9%, transparent)`,
          whiteSpace: 'nowrap',
        },
      }, children);
    }

    function Button({ children, onClick, disabled, kind = 'default', title, type = 'button', style }) {
      const primary = kind === 'primary';
      const danger = kind === 'danger';
      const base = {
        appearance: 'none',
        border: `1px solid ${danger ? 'color-mix(in srgb, ' + TOKEN.bad + ' 45%, transparent)' : primary ? TOKEN.brand : TOKEN.border}`,
        background: primary ? TOKEN.brand : danger ? 'color-mix(in srgb, ' + TOKEN.bad + ' 8%, transparent)' : TOKEN.layer,
        color: primary ? '#fff' : danger ? TOKEN.bad : TOKEN.text,
        borderRadius: 7,
        padding: '5px 10px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        ...style,
      };
      return h('button', { type, title, onClick, disabled, style: base }, children);
    }

    function Card({ children, style, ...rest }) {
      return h('div', {
        ...rest,
        style: {
          border: `1px solid ${TOKEN.border}`,
          background: TOKEN.layer,
          borderRadius: 10,
          padding: 14,
          ...style,
        },
      }, children);
    }

    function Section({ title, hint, extra, children }) {
      return h('section', { style: { marginTop: 22 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 } },
          h('h2', { style: { fontSize: 13, fontWeight: 600, margin: 0, letterSpacing: 0.2 } }, title),
          hint ? h('span', { style: { fontSize: 11, color: TOKEN.muted } }, hint) : null,
          h('span', { style: { flex: 1 } }),
          extra || null,
        ),
        children,
      );
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: TOKEN.muted } },
        h('span', null, label),
        children,
        hint ? h('span', { style: { fontSize: 11, color: TOKEN.muted } }, hint) : null,
      );
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      border: `1px solid ${TOKEN.border2}`,
      background: TOKEN.bg,
      color: TOKEN.text,
      borderRadius: 7,
      padding: '7px 9px',
      fontFamily: 'inherit',
      fontSize: 12,
      outline: 'none',
    };

    function Input(props) {
      return h('input', { ...props, style: { ...inputStyle, ...(props.style || {}) } });
    }

    function Select({ options, ...props }) {
      return h('select', { ...props, style: { ...inputStyle, ...(props.style || {}) } },
        options.map(option => h('option', { key: option.value, value: option.value }, option.label)),
      );
    }

    function Empty({ children }) {
      return h('div', {
        style: {
          border: `1px dashed ${TOKEN.border}`,
          borderRadius: 9,
          padding: '18px 14px',
          color: TOKEN.muted,
          fontSize: 12,
          textAlign: 'center',
        },
      }, children);
    }

    function TaskCard({ task, nodeName, onCancel }) {
      const [open, setOpen] = useState(false);
      const active = task.status === 'queued' || task.status === 'running';
      const tone = task.status === 'failed' ? 'bad' : task.status === 'done' ? 'good' : task.status === 'running' ? 'warn' : 'neutral';
      const artifacts = task.artifacts || [];
      return h(Card, { style: { padding: 12, marginBottom: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Badge, { tone: task.direction === 'in' ? 'warn' : 'neutral' }, task.direction === 'in' ? '接收' : '派出'),
          h('strong', { style: { fontSize: 13, fontWeight: 600 } }, task.title || '未命名任务'),
          h(Badge, { tone }, STATUS_LABEL[task.status] || task.status),
          task.approvalPending ? h(Badge, { tone: 'warn' }, '等待审批') : null,
          task.delivery === 'failed' ? h(Badge, { tone: 'bad' }, '成果待调取') : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11, color: TOKEN.muted } }, `${task.direction === 'in' ? '来自' : '发给'} ${task.peerName || '—'}`),
        ),
        h('div', { style: { display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: TOKEN.muted, flexWrap: 'wrap' } },
          h('span', null, `权限：${PERMISSION_LABEL[task.permission] || task.permission}`),
          h('span', null, `创建：${timeText(task.createdAt)}`),
          task.sessionId ? h('span', null, `会话：${task.sessionId}`) : null,
          task.workspace ? h('span', { title: task.workspace }, `工作区：${task.workspace}`) : null,
        ),
        task.error ? h('div', { style: { marginTop: 8, color: TOKEN.bad, fontSize: 12, whiteSpace: 'pre-wrap' } }, task.error) : null,
        task.deliveryError ? h('div', { style: { marginTop: 6, color: TOKEN.warn, fontSize: 11 } }, task.deliveryError) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 9, alignItems: 'center' } },
          h(Button, { onClick: () => setOpen(value => !value) }, open ? '收起结果' : '查看结果'),
          active ? h(Button, { kind: 'danger', onClick: () => onCancel(task) }, '取消') : null,
          artifacts.length ? h('span', { style: { fontSize: 11, color: TOKEN.muted } }, `${artifacts.length} 个结果文件`) : null,
        ),
        open ? h('div', { style: { marginTop: 10 } },
          h('pre', {
            style: {
              margin: 0,
              padding: 10,
              background: TOKEN.bg,
              border: `1px solid ${TOKEN.border}`,
              borderRadius: 7,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 11,
              lineHeight: 1.55,
              maxHeight: 360,
              overflow: 'auto',
            },
          }, task.resultText || '（还没有结果）'),
          artifacts.length ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
            artifacts.map(artifact => task.direction === 'out'
              ? h('a', {
                  key: artifact.name,
                  href: `/mesh/api/download?taskId=${encodeURIComponent(task.id)}&name=${encodeURIComponent(artifact.name)}`,
                  style: { color: TOKEN.brand, fontSize: 12, textDecoration: 'none' },
                }, `下载 ${artifact.name}（${Math.max(1, Math.round(artifact.bytes / 1024))} KB）`)
              : h('span', { key: artifact.name, style: { color: TOKEN.muted, fontSize: 12 } },
                  `结果文件：${artifact.name}（${Math.max(1, Math.round(artifact.bytes / 1024))} KB）`,
                )),
          ) : null,
        ) : null,
      );
    }

    function ApprovalCard({ approval, onDecide }) {
      return h(Card, { style: { padding: 12, marginBottom: 8, borderColor: `color-mix(in srgb, ${TOKEN.warn} 38%, ${TOKEN.border})` } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Badge, { tone: 'warn' }, approval.direction === 'out' ? '上级审批' : '等待上级'),
          h('strong', { style: { fontSize: 13 } }, approval.taskTitle || approval.taskId),
          h('span', { style: { fontSize: 11, color: TOKEN.muted } }, `子级：${approval.peerName || '—'}`),
        ),
        h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.6 } },
          h('div', null, h('span', { style: { color: TOKEN.muted } }, '工具：'), approval.toolName || '—'),
          approval.reason ? h('div', { style: { marginTop: 3 } }, h('span', { style: { color: TOKEN.muted } }, '原因：'), approval.reason) : null,
        ),
        approval.actionable
          ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
              h(Button, { kind: 'primary', onClick: () => onDecide(approval, 'allowed-once') }, '允许一次'),
              h(Button, { kind: 'danger', onClick: () => onDecide(approval, 'rejected') }, '拒绝'),
            )
          : h('div', { style: { marginTop: 9, fontSize: 11, color: TOKEN.muted } }, '已转发给上级，等待对方在 Mesh 面板中处理。'),
      );
    }

    function ChildCard({ child, onTask, onDisconnect }) {
      const [open, setOpen] = useState(false);
      const [title, setTitle] = useState('');
      const [prompt, setPrompt] = useState('');
      const [permission, setPermission] = useState(
        child.grant === 'none' ? 'read-only' : child.grant,
      );
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const allowed = ['read-only', 'workspace-write', 'danger-full-access'].filter(
        value => PERMISSION_RANK[value] <= PERMISSION_RANK[child.grant],
      );
      useEffect(() => {
        if (!allowed.includes(permission) && allowed.length) setPermission(allowed[allowed.length - 1]);
      }, [child.grant]);

      const send = async () => {
        setError('');
        setBusy(true);
        try {
          await onTask({ peerId: child.id, title: title.trim() || prompt.trim().slice(0, 24), prompt, permission });
          setOpen(false);
          setTitle('');
          setPrompt('');
        } catch (value) {
          setError(value instanceof Error ? value.message : String(value));
        } finally {
          setBusy(false);
        }
      };

      return h(Card, { style: { marginBottom: 8, padding: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Dot, { online: child.online }),
          h('strong', { style: { fontSize: 13 } }, child.name || child.id),
          h(Badge, { tone: child.online ? 'good' : 'neutral' }, child.online ? '在线' : '离线'),
          h(Badge, { tone: child.grant === 'none' ? 'warn' : 'neutral' }, `授予：${PERMISSION_LABEL[child.grant] || child.grant}`),
          h('span', { style: { flex: 1 } }),
          h(Button, { disabled: !child.online || child.grant === 'none', onClick: () => setOpen(value => !value) }, '派任务'),
          h(Button, { kind: 'danger', onClick: () => onDisconnect(child) }, '断开'),
        ),
        h('div', { style: { marginTop: 6, fontSize: 11, color: TOKEN.muted } }, `${child.host}:${child.port}`),
        child.grant === 'none'
          ? h('div', { style: { marginTop: 7, fontSize: 11, color: TOKEN.warn } }, '对方还没有在本机授予任务权限；需要子级在「我的上级」里打开权限开关。')
          : null,
        open ? h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
          h(Field, { label: '任务标题' }, h(Input, { value: title, placeholder: '例如：检查登录模块', onChange: event => setTitle(event.target.value) })),
          h(Field, { label: '任务内容' },
            h('textarea', {
              value: prompt,
              rows: 5,
              placeholder: '写下要子级 DSH 完成的任务；它会创建一个独立会话并执行。',
              onChange: event => setPrompt(event.target.value),
              style: { ...inputStyle, resize: 'vertical', lineHeight: 1.55 },
            }),
          ),
          h(Field, { label: '任务权限', hint: `不能超过子级授予的「${PERMISSION_LABEL[child.grant]}」` },
            h(Select, {
              value: permission,
              options: allowed.map(value => ({ value, label: PERMISSION_LABEL[value] })),
              onChange: event => setPermission(event.target.value),
            }),
          ),
          error ? h('div', { style: { color: TOKEN.bad, fontSize: 12 } }, error) : null,
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { kind: 'primary', disabled: busy || !prompt.trim(), onClick: send }, busy ? '发送中…' : '发送任务'),
            h(Button, { onClick: () => setOpen(false) }, '取消'),
          ),
        ) : null,
      );
    }

    function ParentCard({ parent, onGrant, onDisconnect }) {
      return h(Card, { style: { padding: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Dot, { online: parent.online }),
          h('strong', { style: { fontSize: 13 } }, parent.name || parent.id),
          h(Badge, { tone: parent.online ? 'good' : 'neutral' }, parent.online ? '在线' : '离线'),
          h('span', { style: { flex: 1 } }),
          h(Button, { kind: 'danger', onClick: () => onDisconnect(parent) }, '断开'),
        ),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' } },
          h(Field, { label: '授予上级的权限', hint: '默认不授予；只有打开后，上级才能派任务或查看结果。' },
            h(Select, {
              value: parent.grant || 'none',
              options: ['none', 'read-only', 'workspace-write', 'danger-full-access'].map(value => ({
                value,
                label: value === 'none' ? '不授予' : PERMISSION_LABEL[value],
              })),
              onChange: event => onGrant(event.target.value),
            }),
          ),
          h('div', { style: { fontSize: 11, color: TOKEN.muted, paddingBottom: 5 } },
            '上级新建任务时只能选择不超过此档位的权限。',
          ),
        ),
      );
    }

    function DiscoverCard({ item, onConnect }) {
      return h(Card, { style: { padding: 11, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 } },
        h(Dot, { online: item.accepting }),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
          h('div', { style: { fontSize: 11, color: TOKEN.muted } }, `${item.host}:${item.port}`),
        ),
        h('span', { style: { flex: 1 } }),
        h(Button, { kind: 'primary', onClick: () => onConnect(item) }, '配对连接'),
      );
    }

    function MeshPanel() {
      const snapshot = useSnapshot(store);
      const data = snapshot.data;
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [manualHost, setManualHost] = useState('');
      const [manualPort, setManualPort] = useState('45900');
      const [manualCode, setManualCode] = useState('');
      const [pairing, setPairing] = useState(null);
      const [pairCode, setPairCode] = useState('');
      const [pairError, setPairError] = useState('');
      const [pairBusy, setPairBusy] = useState(false);

      if (snapshot.loading && !data) {
        return h('div', { style: { padding: 28, color: TOKEN.muted, fontSize: 12 } }, '正在连接 DSH Mesh 本地服务…');
      }
      if (!data) {
        return h('div', { style: { padding: 28, color: TOKEN.bad, fontSize: 12 } },
          `无法读取 Mesh 状态：${snapshot.error || '未知错误'}`,
        );
      }

      const node = data.node || {};
      const parent = data.parent;
      const children = data.children || [];
      const discovered = data.discovered || [];
      const tasks = data.tasks || [];
      const approvals = data.approvals || [];

      const run = async (action, body) => {
        setBusy(true);
        setError('');
        try {
          return await store.act(action, body);
        } catch (value) {
          setError(value instanceof Error ? value.message : String(value));
          throw value;
        } finally {
          setBusy(false);
        }
      };

      const connectDiscovered = item => {
        setPairing(item);
        setPairCode('');
        setPairError('');
      };

      const submitPair = async () => {
        if (!pairing || pairBusy) return;
        if (pairCode.length !== 6) {
          setPairError('请输入 6 位配对码');
          return;
        }
        setPairBusy(true);
        setPairError('');
        try {
          await run('connect', {
            id: pairing.id,
            name: pairing.name,
            host: pairing.host,
            port: pairing.port,
            code: pairCode.trim(),
          });
          setPairing(null);
        } catch (value) {
          setPairError(value instanceof Error ? value.message : String(value));
        } finally {
          setPairBusy(false);
        }
      };

      const connectManual = async () => {
        try {
          await run('connect', { host: manualHost.trim(), port: Number(manualPort), code: manualCode.trim() });
          setManualHost('');
          setManualCode('');
        } catch {
          // run() already surfaced the error.
        }
      };

      return h('div', {
        style: {
          height: '100%',
          overflow: 'auto',
          background: TOKEN.bg,
          color: TOKEN.text,
          fontFamily: 'inherit',
          fontSize: 13,
          padding: '22px 26px 70px',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 9 } },
              h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: 0.2 } }, 'DSH Mesh'),
              h(Badge, { tone: node.listening ? 'good' : 'bad' }, node.listening ? `监听 :${node.port}` : '未监听'),
              h(Badge, { tone: node.ready ? 'good' : 'warn' }, node.ready ? '本机就绪' : '启动中'),
            ),
            h('div', { style: { marginTop: 5, fontSize: 12, color: TOKEN.muted } },
              `${node.name || '未命名节点'} · ${node.id || ''}`,
            ),
          ),
          h('span', { style: { flex: 1 } }),
          node.pairingCode
            ? h(Card, { style: { padding: '7px 11px', display: 'flex', alignItems: 'center', gap: 9 } },
                h('span', { style: { fontSize: 11, color: TOKEN.muted } }, '下级配对码'),
                h('strong', { style: { fontSize: 16, letterSpacing: 2, fontFamily: 'ui-monospace, Consolas, monospace' } }, node.pairingCode),
                h(Button, { onClick: () => run('pairing-code', {}).catch(() => {}) }, '刷新'),
              )
            : h(Badge, { tone: parent ? 'good' : 'neutral' }, parent ? '已绑定上级' : '监听已关闭'),
        ),
        node.error ? h('div', {
          style: { marginTop: 12, padding: '9px 11px', borderRadius: 8, color: TOKEN.bad, background: `color-mix(in srgb, ${TOKEN.bad} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${TOKEN.bad} 30%, transparent)`, fontSize: 12 },
        }, node.error) : null,
        error ? h('div', { style: { marginTop: 10, color: TOKEN.bad, fontSize: 12 } }, error) : null,

        h('div', {
          style: {
            marginTop: 12,
            padding: '8px 11px',
            borderRadius: 8,
            border: `1px solid ${TOKEN.border}`,
            background: TOKEN.layer,
            color: TOKEN.muted,
            fontSize: 12,
            lineHeight: 1.6,
          },
        },
          '聊天里也可以直接派任务：输入 ',
          h('code', { style: { color: TOKEN.brand, fontFamily: 'ui-monospace, Consolas, monospace' } }, '@下级名 任务内容'),
          ' 发送即可；不需要打开这个面板。',
        ),

        approvals.length
          ? h(Section, { title: '审批', hint: `${approvals.length} 个待处理` },
              approvals.map(approval => h(ApprovalCard, {
                key: approval.id,
                approval,
                onDecide: (item, decision) => run('approval', { approvalId: item.id, decision }).catch(() => {}),
              })),
            )
          : null,

        parent
          ? h(Section, { title: '我的上级', hint: '它给你派任务；你决定授予它多少权限' },
              h(ParentCard, {
                parent,
                onGrant: value => run('grant', { permission: value }).catch(() => {}),
                onDisconnect: item => {
                  if (window.confirm(`断开上级「${item.name}」？`)) run('disconnect', { peerId: item.id }).catch(() => {});
                },
              }),
            )
          : null,

        h(Section, {
          title: '我的下级',
          hint: '只有对方在本机授予权限后，你才能派任务',
          extra: h(Button, { onClick: () => store.refresh() }, '刷新'),
        },
          children.length
            ? children.map(child => h(ChildCard, {
                key: child.id,
                child,
                onTask: input => run('task', input),
                onDisconnect: item => {
                  if (window.confirm(`断开下级「${item.name}」？`)) run('disconnect', { peerId: item.id }).catch(() => {});
                },
              }))
            : h(Empty, null, '还没有下级。让另一台 DSH 打开 Mesh，并把它的配对码填到下面。'),
        ),

        discovered.length
          ? h(Section, { title: '局域网发现', hint: '同一网段内正在监听的下级' },
              discovered.map(item => h(DiscoverCard, { key: item.id, item, onConnect: connectDiscovered })),
            )
          : null,

        h(Section, { title: '手动连接', hint: '跨网段或广播被防火墙拦截时使用' },
          h(Card, { style: { padding: 12 } },
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 110px 120px auto', gap: 8, alignItems: 'end' } },
              h(Field, { label: '主机 / IP' }, h(Input, { value: manualHost, placeholder: '192.168.1.20', onChange: event => setManualHost(event.target.value) })),
              h(Field, { label: '端口' }, h(Input, { value: manualPort, inputMode: 'numeric', onChange: event => setManualPort(event.target.value) })),
              h(Field, { label: '配对码' }, h(Input, { value: manualCode, placeholder: '6 位数字', onChange: event => setManualCode(event.target.value) })),
              h(Button, { kind: 'primary', disabled: busy || !manualHost.trim(), onClick: connectManual }, '连接'),
            ),
          ),
        ),

        h(Section, { title: '任务', hint: '上级派出的和下级执行的都显示在这里' },
          tasks.length
            ? tasks.slice(0, 30).map(task => h(TaskCard, {
                key: task.id,
                task,
                nodeName: node.name,
                onCancel: item => {
                  if (window.confirm(`取消任务「${item.title}」？`)) run('cancel', { taskId: item.id }).catch(() => {});
                },
              }))
            : h(Empty, null, '还没有任务。'),
        ),

        h(Section, {
          title: '设置',
          extra: h(Button, { onClick: () => setSettingsOpen(value => !value) }, settingsOpen ? '收起' : '展开'),
        },
          settingsOpen
            ? h(SettingsCard, {
                node,
                busy,
                onSave: value => run('settings', value).then(() => setSettingsOpen(false)),
              })
            : h('div', { style: { fontSize: 12, color: TOKEN.muted } },
                `监听端口 ${node.listenPort} · 工作区 ${node.workspaceRoot} · 审批超时 ${Math.round((node.approvalTimeoutMs || 0) / 60000)} 分钟`,
              ),
        ),

        pairing ? h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '输入配对码',
          onClick: () => {
            if (!pairBusy) setPairing(null);
          },
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          },
        },
          h(Card, {
            onClick: event => event.stopPropagation(),
            style: { width: 'min(420px, 100%)', padding: 20, boxShadow: '0 24px 70px rgba(0, 0, 0, 0.35)' },
          },
            h('div', { style: { fontSize: 16, fontWeight: 650 } }, '配对连接'),
            h('div', { style: { marginTop: 4, fontSize: 12, color: TOKEN.muted } },
              `${pairing.name} · ${pairing.host}:${pairing.port}`,
            ),
            h('div', { style: { marginTop: 14 } },
              h(Field, { label: '配对码', hint: '在子级 Mesh 面板顶部可以看到 6 位配对码' },
                h(Input, {
                  value: pairCode,
                  autoFocus: true,
                  maxLength: 6,
                  inputMode: 'numeric',
                  placeholder: '6 位数字',
                  onChange: event => setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6)),
                  onKeyDown: event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitPair();
                    }
                    if (event.key === 'Escape') setPairing(null);
                  },
                  style: { letterSpacing: 6, fontSize: 18, textAlign: 'center', padding: '10px 12px' },
                }),
              ),
            ),
            pairError ? h('div', { style: { marginTop: 10, color: TOKEN.bad, fontSize: 12, whiteSpace: 'pre-wrap' } }, pairError) : null,
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
              h(Button, { onClick: () => setPairing(null), disabled: pairBusy }, '取消'),
              h(Button, {
                kind: 'primary',
                disabled: pairBusy || pairCode.length !== 6,
                onClick: submitPair,
              }, pairBusy ? '连接中…' : '连接'),
            ),
          ),
        ) : null,
      );
    }

    function SettingsCard({ node, busy, onSave }) {
      const [name, setName] = useState(node.name || '');
      const [port, setPort] = useState(String(node.listenPort || 45900));
      const [allowParent, setAllowParent] = useState(Boolean(node.allowParent));
      const [listenEnabled, setListenEnabled] = useState(Boolean(node.listenEnabled));
      const [workspaceRoot, setWorkspaceRoot] = useState(node.workspaceRoot || '');
      const [timeoutMinutes, setTimeoutMinutes] = useState(String(Math.round((node.approvalTimeoutMs || 600000) / 60000)));
      const [error, setError] = useState('');

      const save = async () => {
        setError('');
        try {
          await onSave({
            name,
            listenPort: Number(port),
            allowParent,
            listenEnabled,
            workspaceRoot,
            approvalTimeoutMs: Math.max(5, Number(timeoutMinutes) || 10) * 60000,
          });
        } catch (value) {
          setError(value instanceof Error ? value.message : String(value));
        }
      };

      return h(Card, { style: { padding: 14, display: 'flex', flexDirection: 'column', gap: 11 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10 } },
          h(Field, { label: '本机名称' }, h(Input, { value: name, onChange: event => setName(event.target.value) })),
          h(Field, { label: '监听端口', hint: '修改后会重新监听' }, h(Input, { value: port, inputMode: 'numeric', onChange: event => setPort(event.target.value) })),
        ),
        h(Field, { label: '任务工作区根目录', hint: '每个任务会在这里创建独立子目录' },
          h(Input, { value: workspaceRoot, onChange: event => setWorkspaceRoot(event.target.value) })),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: listenEnabled, onChange: event => setListenEnabled(event.target.checked) }),
          '开放 Mesh 端口，允许别的 DSH 连接本机',
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: allowParent, onChange: event => setAllowParent(event.target.checked) }),
          '允许别的 DSH 连接本机，把我作为下级',
        ),
        h(Field, { label: '审批超时（分钟）', hint: '上级一直不处理审批时，任务会在超时后失败' },
          h(Input, { value: timeoutMinutes, inputMode: 'numeric', onChange: event => setTimeoutMinutes(event.target.value) })),
        error ? h('div', { style: { color: TOKEN.bad, fontSize: 12 } }, error) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, { kind: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存设置'),
        ),
      );
    }

    function MeshIcon({ size = 20, active = false }) {
      const snapshot = useSnapshot(store);
      const pending = snapshot.data?.approvals?.filter(item => item.actionable).length || 0;
      const color = active ? TOKEN.brand : 'currentColor';
      return h('span', { style: { position: 'relative', display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center' } },
        h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
          h('path', { d: 'M5.5 7.5 12 12l6.5-4.5M12 12l6.5 6.5M5.5 7.5 6 17l6-5' }),
          h('circle', { cx: 5.5, cy: 7.5, r: 2.1, fill: color, stroke: 'none' }),
          h('circle', { cx: 18.5, cy: 7.5, r: 2.1, fill: color, stroke: 'none' }),
          h('circle', { cx: 6, cy: 17, r: 2.1, fill: color, stroke: 'none' }),
          h('circle', { cx: 18.5, cy: 18.5, r: 2.1, fill: color, stroke: 'none' }),
          h('circle', { cx: 12, cy: 12, r: 1.7, fill: color, stroke: 'none' }),
        ),
        pending > 0
          ? h('span', {
              style: {
                position: 'absolute',
                top: -2,
                right: -2,
                minWidth: 7,
                height: 7,
                borderRadius: 99,
                background: TOKEN.bad,
                border: `1.5px solid ${TOKEN.bg}`,
              },
            })
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        store = createStore();
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            store.start();
            return () => store.stop();
          });
        } else {
          store.start();
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'mesh',
          order: 20,
          label: 'Mesh',
        }, MeshIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'mesh',
        }, MeshPanel));
      },
    };
  },
});
