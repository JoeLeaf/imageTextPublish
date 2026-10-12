# 打包与 GitHub 发布

仓库：[JoeLeaf/imageTextPublish](https://github.com/JoeLeaf/imageTextPublish) · [构建记录](https://github.com/JoeLeaf/imageTextPublish/actions) · [下载页面](https://github.com/JoeLeaf/imageTextPublish/releases)

## 已配置的发行包

| 使用设备 | 包名示例 | 使用方式 |
| --- | --- | --- |
| Windows 64 位 | `ImageTextPublish-0.2.4-win-x64.exe` | 双击运行，无需安装 Node.js |
| Mac，Apple 芯片 | `ImageTextPublish-0.2.4-mac-arm64.dmg` | 打开 DMG，把应用拖入 Applications |
| Mac，Intel 芯片 | `ImageTextPublish-0.2.4-mac-x64.dmg` | 打开 DMG，把应用拖入 Applications |

另附 `SHA256SUMS.txt`，用于核对下载文件是否完整。当前不提供 Windows ARM 原生包、自动更新、代码签名或 Apple 公证。Mac 包由对应架构的 GitHub Mac 运行器构建，构建成功不能替代真实设备验收。

Windows 可能提示未知发布者。Mac 首次打开未公证的应用可能被 Gatekeeper 阻止；确认文件来自本仓库后，按照系统“隐私与安全性”中的“仍要打开”流程处理。不需要关闭系统的整体安全保护。

## 推荐：GitHub 自动打包

首次上传源码时，只需推送 `main`，`Check source` 会在 Windows 与 Mac 检查依赖安装、类型、测试、Electron 运行时准备和构建。安装包只在发布版本时生成。

发行前保持 Git 工作区干净、提交好说明，先通过检查：

```bash
npm ci
npm run typecheck
npm test
npm run release:check
```

更新版本、创建标签并推送。例如从 `0.2.4` 发布下一版：

```bash
npm version patch -m "chore: release %s"
git push origin main
git push origin --tags
```

`npm version patch` 会同步两个 package 文件并创建版本提交与 `v0.2.5` 标签。只推送本次标签也可以用 `git push origin v0.2.5`。标签必须与 `package.json`、`package-lock.json` 的版本完全一致。

如果版本已手动更新并提交，首次发布当前 `0.2.4` 使用：

```bash
git tag v0.2.4
git push origin main
git push origin v0.2.4
```

随后在 Actions 查看 **Build release**：

1. 三个原生运行器分别安装、测试、构建 Windows x64、Mac x64 与 Mac arm64。
2. 全部成功后才汇总三个安装包、计算 SHA-256，并创建 GitHub **草稿 Release**。
3. 仓库所有者打开 Releases 中的草稿，下载测试、编辑变更说明，再点击 **Publish release**。草稿和草稿附件对普通访问者不可见。

不需要额外配置个人 Token；工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`，只有创建草稿的作业拥有 `contents: write`。仓库应启用 GitHub Actions；若组织策略禁止写入 Release，需要仓库管理员调整对应策略。

构建失败时修复代码并发一个新版本。如果只是网络等临时失败，可在失败的运行中选择 **Re-run failed jobs**。也可以在 **Build release → Run workflow** 填写已存在的标签重新构建。重新运行只会更新该标签的草稿附件；已经公开的 Release 不会被覆盖。

每个构建作业同时保存 14 天的 Actions artifact，创建草稿前失败时也可用于诊断。它们不是公开 Release 下载链接。

## 在本机打包

准备 Node.js 22（至少 22.12），在项目目录安装依赖：

```bash
npm ci
```

Windows：

```bash
npm run dist:win
```

Mac：

```bash
npm run dist:mac
```

Mac 命令默认生成当前电脑架构的包。另一架构由对应 GitHub 运行器构建，不直接复制另一系统或架构的 `node_modules`。SQLite 和 Sharp 都有原生组件，必须匹配运行系统、架构与 Electron ABI。

输出在 `release/`。命令自动准备 Electron、恢复 SQLite 的 Electron ABI、构建界面，再生成包；`--publish never` 保证本机打包不会自动上传。只需要解压目录形式的应用时，可运行 `npm run pack`，分发时要保留整个目录。

本地安装包生成校验文件：

```bash
npm run release:checksums
```

该命令会为 `release/` 下所有符合命名规则的 EXE/DMG 生成校验值；手动发布时仅上传当前版本的包，不要混入旧版本。PowerShell 可用 `Get-FileHash <文件名> -Algorithm SHA256` 核对；Mac 可用 `shasum -a 256 <文件名>`。

## 升级与验收

升级前在应用中“备份任务数据”，保留素材原文件。关闭旧程序后打开新版；当前不会自动下载或安装更新。不要更改 `appId`、`productName` 等数据目录相关设置后直接替换已有版本，否则需检查旧数据的迁移。

每版至少检查：应用能启动、图标正常、添加账号和检查登录、选取素材和预览、数量与排期、配置导入导出。真实发帖请由使用者明确开始一条测试任务，并在抖音核对结果。CI 不登录真实账号，也不会提交真实作品。

## 源码与安装包的区别

Git 中仅提交源码、锁文件、品牌资源和文档。`node_modules/`、`dist/`、`dist-electron/`、`release/`、`artifacts/`、本地数据库及账号环境不提交；安装包放在 GitHub Releases，不放入 Git 历史。导出的配置、素材、浏览器会话与账户数据也不应放入公开仓库。

目前 `license` 为 `UNLICENSED`，公开仓库不代表授予开源许可。若以后决定开源，再由仓库所有者选定许可证并同步更新 `LICENSE` 和 package 元信息。
