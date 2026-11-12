# 发布与上架

本仓库发布的包名是 **`@fishboy/dsh-mesh`**（npm 上 `dsh-mesh` 已被一个无关项目占用）。

## 0. 当前可用的发布通道：GitHub Release 附件

npm 上架还在走流程时，市场收录和安装都走这条，已经可用：

```
https://github.com/Fishexploi/dsh-mesh/releases/download/v0.4.6/fishboy-dsh-mesh-0.4.6.tgz
```

安装命令：

```powershell
dsh plugin --profile <profile> add https://github.com/Fishexploi/dsh-mesh/releases/download/v0.4.6/fishboy-dsh-mesh-0.4.6.tgz
```

发版流程：`npm pack --pack-destination <目录>` → GitHub Releases → 选已有的 tag → 传 tgz →
Publish（Release label 用 `None`，别勾 Pre-release，否则 `/releases/latest` 和索引拿不到）。
上传后确认 asset 名保持 `fishboy-dsh-mesh-<version>.tgz`，sha256 与本地 `Get-FileHash` 一致。

## 1. 发布到 npm

### 如果 npm 网页注册被风控挡住（403）

`www.npmjs.com` 走 Cloudflare 的机器人墙，某些出口 IP 一律 403；但
**注册表 API 不挡**。可以先探一下，再直接走 API 注册：

```powershell
# 确认端点可用（发一个故意写错的邮箱，预期返回 “email address you entered is invalid”）
powershell -ExecutionPolicy Bypass -File tools\npm-signup.ps1 -Probe

# 真正注册：会交互式问用户名/邮箱/密码（密码不回显），成功后把 token 写进 ~/.npmrc
powershell -ExecutionPolicy Bypass -File tools\npm-signup.ps1 -UserName fishboy -Email you@example.com
```

用户名同时就是 scope（`@fishboy/...`）。注册完去邮箱点 npm 的验证链接，
未验证邮箱的账号发布会被拒。

登录（网页登录同样可能被挡时用终端模式）：

```powershell
npm login --auth-type=legacy --registry=https://registry.npmjs.org
```

### 正常发布

```powershell
# 首次：登录 npmjs（本机 .npmrc 默认指向 npmmirror，这里必须显式指定官方源）
npm login --registry=https://registry.npmjs.org

# 首次：在 npm 上创建 scope（网页操作）https://www.npmjs.com/org/create -> @fishboy

# 每次发布前自检打包含哪些文件
npm pack --dry-run

# 发布（package.json 的 publishConfig 已固定官方源与 public）
npm publish
```

发布后验证：

```powershell
npm view @fishboy/dsh-mesh version --registry=https://registry.npmjs.org
dsh plugin --profile <profile> add @fishboy/dsh-mesh
```

## 2. GitHub Release

```powershell
git tag v0.4.0
git push origin v0.4.0
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
（或 npm 包名 `@fishboy/dsh-mesh`）。它会自动拉源码、跑格式校验与 vet 安全扫描，
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
否则更新会把新文件写进旧目录，而 patch 行里的 specifier 已经变成 `@fishboy/dsh-mesh`，
插件会在下次启动时加载失败。

- 本地目录链接安装（`link:` / `file:`）：在目标机器跑 `sync\migrate-scoped.ps1`。
- npm 版本安装：`dsh plugin --profile <profile> remove dsh-mesh`，再
  `dsh plugin --profile <profile> add @fishboy/dsh-mesh`。

## 6. 万一 npm 一直注册不了

市场收录不强制 npm：精选列表明确支持 **GitHub-only 条目**，dsh-market 也能从
压缩包链接安装。退路是把 `npm pack` 出来的 tarball 挂到 GitHub Release（现在就是这么发的），
安装命令写成

```powershell
dsh plugin --profile <profile> add https://github.com/Fishexploi/dsh-mesh/releases/download/v0.4.6/fishboy-dsh-mesh-0.4.6.tgz
```

代价：没有 npm 下载统计，更新走 GitHub 而不是 npm。这是退路，不是首选。
