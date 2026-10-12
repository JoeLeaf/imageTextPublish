# 开发说明

## 环境与启动

使用 Node.js 22（至少 22.12.0）及 npm。在 Windows 或 macOS 原生环境安装依赖，不要跨系统复制 `node_modules`。

```bash
npm ci
npm run setup
npm run dev
```

`setup` 显式安装 Electron 运行时，再将 `better-sqlite3` 重建为 Electron 使用的版本。Electron 44 不再自动通过 `postinstall` 下载运行时，因此首次启动和打包前需要这一步。开发模式支持界面更新，主进程修改后按开发工具提示重启应用。

生产构建并从源码运行：

```bash
npm run setup
npm run build
npm start
```

双击启动脚本也可准备依赖并构建：Windows 使用 `start-windows.cmd`；macOS 首次执行 `chmod +x start-mac.command`，再打开该脚本。首次下载需要联网。

## 检查与原生依赖

```bash
npm run typecheck
npm test
npm run setup
npm run build
```

测试在 Node.js 中运行，`npm test` 会把 SQLite 重建为 Node.js 所需的 ABI。**测试后启动或打包应用前，执行 `npm run setup` 恢复 Electron ABI**；否则可能出现 `NODE_MODULE_VERSION` 不匹配错误。`npm run dev`、`pack` 及 `dist:*` 脚本会先执行 `setup`。

原生依赖下载失败且需要源码编译时，macOS 可能需要 Xcode Command Line Tools，Windows 可能需要 Python 与 Visual Studio C++ 构建工具。先查看具体安装错误，不要将其他系统或架构编译的原生模块复制过来。

如果 Electron 下载无法完成，可临时指定镜像后重试，不需永久修改 npm registry。

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run setup
Remove-Item Env:ELECTRON_MIRROR
```

macOS：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run setup
```

打包命令与自动发布流程见 [releases.md](releases.md)。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src/renderer/` | React / Ant Design 界面、任务表单、预览与品牌样式 |
| `src/preload/` | 向界面暴露受控桌面 API |
| `src/shared/` | IPC 通道与共享类型 |
| `src/main/index.ts` | 应用生命周期、窗口、IPC、本机素材授权与导入导出 |
| `src/main/core/` | 素材读取与校验、配置校验、排期、固定批次生成 |
| `src/main/store.ts` | SQLite 数据存储、迁移与启动恢复 |
| `src/main/scheduler.ts` | 本机任务执行、账号间隔、暂停与提交结果处理 |
| `src/main/platform/` | 账号浏览器会话、创作者 SDK 桥接、ImageX 上传与提交门控 |
| `tests/` | 素材、调度、迁移及协议等自动化测试 |
| `assets/brand/` | Logo 源文件与窗口、安装包图标 |

React 界面不直接读取本机文件或登录凭据，通过 preload 与主进程通信。账号环境按账号持久隔离；最终请求通过提交门控限制单次放行，未知结果交由用户核对。平台适配器可独立更新，网页协议资料见 [文档索引](README.md)。

开发或界面检查可使用独立的数据目录，避免影响日常工作空间。`ITP_DATA_DIR` 同时隔离数据库、浏览器环境和应用实例锁。

Windows PowerShell 示例：

```powershell
$env:ITP_DATA_DIR = Join-Path $env:TEMP 'image-text-publish-dev'
npm run dev
Remove-Item Env:ITP_DATA_DIR
```

macOS 示例：

```bash
ITP_DATA_DIR="$TMPDIR/image-text-publish-dev" npm run dev
```

自动化测试与构建通过不等于实际平台发帖通过。涉及发布链路的改动需另行核对真实账号上传及最终作品回执，当前实测范围见各版本验证记录；不要将本地模拟响应标为平台成功回执。

## 界面与品牌定制

Logo 源文件为 `assets/brand/logo.svg`。修改后运行：

```bash
node scripts/generate-brand-assets.mjs
npm run build
```

脚本生成 PNG、ICO 与 ICNS，分别供运行时窗口、Windows 程序与 macOS 应用使用。打包前重新生成，可使侧栏、标题栏与发行图标一致。

主窗口使用自定义标题栏和系统窗口按钮，Windows 隐藏默认菜单行，macOS 保留系统编辑菜单以支持快捷键。更改产品名时统一修改 `package.json` 的 `build.productName`、主窗口标题与界面品牌文字。更改 `appId` 或应用名称可能影响系统识别及数据目录，先备份现有工作空间。

## 提交到仓库

提交源码、`package-lock.json`、文档及品牌资源。构建产物通过 Releases 分发，依赖目录、SQLite 数据、账号环境、个人素材和研究输出不提交。反馈问题时提供系统、架构、应用版本、复现步骤和经过脱敏的错误信息；不上传 Cookie、登录凭据或未脱敏的账号截图。

本仓库当前为 `UNLICENSED`。公开源码尚未授予开源许可，维护者决定许可后再同步更新许可文件与包信息。
