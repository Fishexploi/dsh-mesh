# 发布与上架

本仓库发布的包名是 **`@fishexploi/dsh-mesh`**（npm 上 `dsh-mesh` 已被一个无关项目占用）。

## 1. 发布到 npm

```powershell
# 首次：登录 npmjs（本机 .npmrc 默认指向 npmmirror，这里必须显式指定官方源）
npm login --registry=https://registry.npmjs.org

# 首次：在 npm 上创建 scope（网页操作）https://www.npmjs.com/org/create -> @fishexploi

# 每次发布前自检打包含哪些文件
npm pack --dry-run

# 发布（package.json 的 publishConfig 已固定官方源与 public）
npm publish
```

发布后验证：

```powershell
npm view @fishexploi/dsh-mesh version --registry=https://registry.npmjs.org
dsh plugin --profile <profile> add @fishexploi/dsh-mesh
```

## 2. GitHub Release

```powershell
git tag v0.3.0
git push origin v0.3.0
```

然后在 GitHub 上把 tag 变成 Release，附一段更新说明。目录站会从 tag / npm 版本读元数据。

## 3. 进插件市场

三条通道，互不冲突，建议都做：

### 3.1 awesome-dsh-plugin（进 dsh-market 与官方 Discover 的主通道）

dsh-market 和 DSH 0.2.1+ 的 **Plugins → Discover** 都读这份精选列表
（`https://awesome-dsh-plugin.com/plugins.json`，索引包 `dsh-plugin-catalog`）。
到 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提 PR，在分类下加一条（Workflow & Automation）：

```markdown
- [Fishexploi/dsh-mesh](https://github.com/Fishexploi/dsh-mesh) - LAN mesh for DeepSeek Harness: one DSH delegates tasks to other DSH hosts on the same network, each child works in its own isolated session and workspace, results come back with files, sensitive actions are approved by the parent, and a finished task can be continued with one follow-up instruction inside the child's existing session. Long reports are landed on disk and only a bounded preview reaches the parent model, so delegation does not flood its context.
```

要求（对照本仓库）：能被 `dsh plugin add` 装 ✅、声明 `dsh.bundle` ✅、描述属实 ✅、
分类正确 ✅、持续维护 — 每次发版记得同步。

### 3.2 dsh.so

打开 <https://www.dsh.so/zh/submit/>，粘贴仓库地址 `github.com/Fishexploi/dsh-mesh`
（或 npm 包名 `@fishexploi/dsh-mesh`）。它会自动拉源码、跑格式校验与 vet 安全扫描，
通过后生成条目 Issue 交给维护者合并。收录要求：`dsh` 字段 ✅、README 有安装说明 ✅、
SPDX 许可证 ✅、插件 id 符合 `^[a-z0-9]+(-[a-z0-9]+)*$` ✅、有可扫描源码 ✅。

### 3.3 让仓库被自动索引

在 GitHub 仓库上添加 topic：**`dsh-plugin`**（外加 `dsh`、`deepseek-harness`）。
dsh.so 与部分目录站会按 topic 自动索引。

## 4. 上架时会被问到 / 会被扫描的点

- 插件的「检查更新 / 一键更新」会**从 GitHub 下载文件覆盖自身源码**。这是联网 + 写文件，
  扫描器通常给警告级而不是阻断级；README 里已说明它只从 `raw.githubusercontent` 按
  commit sha 取、由用户手动触发、不静默更新 —— 提交时把这段指给审核者。
- 插件是**可信 in-process JS，没有沙箱**，而且本插件会在子级机器上执行任务。README 的
  权限模型章节要保留，并在条目描述里点出来。
- `sync/install.ps1` 会执行 `pnpm install`，属于安装期脚本；它不是插件运行时的一部分，
  在提交说明里讲清楚用途。

## 5. 旧机器迁移

0.2.x 及更早的安装用的是不带 scope 的 `dsh-mesh`。包名变了以后，**先迁移再更新**，
否则更新会把新文件写进旧目录，而 patch 行里的 specifier 已经变成 `@fishexploi/dsh-mesh`，
插件会在下次启动时加载失败。

- 本地目录链接安装（`link:` / `file:`）：在目标机器跑 `sync\migrate-scoped.ps1`。
- npm 版本安装：`dsh plugin --profile <profile> remove dsh-mesh`，再
  `dsh plugin --profile <profile> add @fishexploi/dsh-mesh`。
