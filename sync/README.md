# 把 A 机器上的插件同步到另一台 DSH

这个目录用于把当前机器已安装的插件同步到服务器 A（或任何另一台 Windows DSH）。

同步的是**插件包和启用列表**，不包含：

- 模型 API Key / 账号凭证；
- Mnemon 记忆数据库；
- 会话记录、工作区文件；
- 各插件自己的用户配置。

这些由目标机器自己的 DSH 管理。

## 包含的插件

| 插件 | 版本 | 启用 |
| --- | --- | --- |
| `@fishexploi/dsh-mesh` | 当前仓库版本 | 是 |
| `dshmarket` | 1.73.10 | 是 |
| `dsh-mnemon` | 0.5.42 | 是 |
| `dsh-plugin-startup-animation` | 1.31.1 | 是 |
| `dsh-pet` | 0.4.7 | 安装但不在 bundle 列表（与 A 一致） |

## 用法

在目标机器上克隆仓库：

```powershell
git clone https://github.com/Fishexploi/dsh-mesh.git
cd dsh-mesh\sync
```

先看会改什么（不会安装）：

```powershell
.\install.cmd -SkipInstall
```

确认后安装：

```powershell
.\install.cmd
```

如果系统禁止运行 PowerShell 脚本，用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：

1. 备份目标 profile 的 `package.json` 和 `cordis.patch.yml`；
2. 合并依赖版本和 `dsh.profile.bundles`；
3. 把 `@fishexploi/dsh-mesh` 指向当前仓库目录；
4. 在 profile 目录执行 `pnpm install`；
5. 提示重启 DSH。

默认目标是：

```text
%USERPROFILE%\.dsh\profiles\desktop
```

如果目标机器用的是别的 profile：

```powershell
.\install.cmd -ProfileDir "C:\Users\Administrator\.dsh\profiles\你要的profile"
```

## 手动方式（没有 pnpm 时）

在目标机器的 DSH 里打开 **设置 → 插件 → 从本地安装 / 安装插件**，依次安装：

```text
dshmarket@1.73.10
dsh-mnemon@0.5.42
dsh-plugin-startup-animation@1.31.1
```

然后从本地目录安装 `@fishexploi/dsh-mesh`（也就是这个仓库的根目录），再重载/重启 DSH。

## 注意

- 目标机器需要能访问 npm 和 GitHub。
- `@fishexploi/dsh-mesh` 在目标机器上会以本地目录链接方式安装，之后可以用面板里的“检查更新”更新。
- 安装脚本只追加缺少的 bundle，不删除目标机器已有的插件。
- 如果目标机器已经有 `@fishexploi/dsh-mesh`，脚本会把依赖改成当前仓库路径；建议先备份。
- 安装完成后必须重启目标机器的 DSH，插件才会加载。
