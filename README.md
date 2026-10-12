# 图文发布助手

个人自用的 Windows / macOS 本地桌面工具，技术栈为 Electron、React、TypeScript、Node.js 和 SQLite。第一版管理抖音多账号与图文任务；手机、视频、跨设备实时同步暂未实现。

**v0.2 已接入抖音图文协议通道**：本地图片经过 ImageX 上传，最终表单请求由该账号创作者网页的正常 SDK 生成签名，不用模拟点击发布。每次开始会检查账号身份、上传授权与签名注入；作品是否成功由平台回执确认。真实最终发帖与平台审核仍待你用自己的首条任务验证，macOS 尚未实机验证。

## 启动

Windows 可直接打开 `release/win-unpacked/图文发布助手.exe`，保留同目录的配套文件；无需安装 Node.js。也可将 `release/图文发布助手-Windows-x64-v0.2.2.zip` 整体解压后使用。

先安装 Node.js 22 的最新版本（至少 22.12），在项目目录运行：

```bash
npm install
npm run setup
npm run build
npm start
```

`npm run setup` 显式执行 Electron 的安装脚本（Electron 44 不再自动通过 `postinstall` 下载运行时），再重建 `better-sqlite3` 以匹配 Electron 的运行时。下载或重建失败时先查看终端错误；macOS 从源码编译可能需要 Xcode Command Line Tools，Windows 可能需要 Visual Studio 的 C++ 构建工具。

也可使用启动脚本：Windows 双击 `start-windows.cmd`；Mac 首次在终端执行 `chmod +x start-mac.command` 后双击 `start-mac.command`。脚本切换到项目目录，检查 Node.js 至少为 22.12，首次准备依赖，每次执行 `setup`、构建再启动，失败时保留错误供查看。首次安装需要联网。更新依赖或切换操作系统后，应重新安装并重建原生依赖，不能直接复制另一系统的 `node_modules`。

开发与检查：

```bash
npm run dev
npm run typecheck
npm test
```

`npm test` 会将 SQLite 重建为 Node.js 测试环境版本。测试后启动应用前执行 `npm run setup`，恢复 Electron 版本；双击启动脚本会自动完成这一步。

如果首次安装卡在 Electron 下载，可仅在当前终端临时指定镜像后重试，不需要永久修改 npm registry。Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm install
npm run setup
Remove-Item Env:ELECTRON_MIRROR
```

macOS：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run setup
```

## 使用流程

1. 在“账号管理”添加账号，打开该账号的独立窗口登录。程序会自动检测身份，首次验证成功后隐藏登录窗口；也可点击“检查登录”。关闭账号窗口会保留后台会话，重启程序后可继续检查持久登录状态。账号环境隔离并持久保存会话，**不等于关闭后清空数据的真正无痕模式**。
2. 新建任务，为文案和图片分别选择文件夹或文件；支持单选、多选文件。每个 TXT / Markdown / TEXT 文件作为一篇完整文案；“本批发布条数”默认填入有效文案文件数量，可手动调整。单批最多 1000 条，更多素材请分批。图片随机选择，默认每条 1 张，可调整图片数和发布间隔。
3. 扫描素材，再生成整批预览，逐条检查文案、图片、标题、可见范围和北京时间排期。允许再次使用已发布或被其他任务使用的文案；不同文件即使内容相同也分别计数。选择文件时只读取明确选中的文件，选择文件夹时扫描文件夹及其子目录。
4. 确认并保存任务。**保存不会自动发布**，实际发布需要单独点击“开始”。首次建议 1 条、1 张图片、仅自己可见，核对平台作品后再扩大批次。重试沿用原预览的文案和图片，不重新随机选择。
5. 在任务详情暂停、继续、取消或处理失败。结果不确定时先在抖音核对作品列表，再明确确认“已发布”或“未发布”，避免重复提交。

当前图片选择为随机方式，自定义关键词或文件名匹配规则尚未实现。正文最多 1000 字、可选标题最多 20 字、每条最多 35 张，超长文案保留原样并要求调整。文本文件最大 1 MiB，单张图片最大 50 MiB，支持 JPEG、PNG、WebP。

同一账号的多个任务共用发布间隔，任意一条提交结果未知时会阻止该账号继续发帖；请核对平台再处理。网页 SDK 自动重试的最终请求会被拦截，一次提交最多放行一次。上传未完成时中断不会发帖；最终提交后断网、异常回执或休眠会保守标记为待核对。需要平台二次验证时应在账号窗口正常完成，程序不自动处理验证码。

## 数据与迁移

- **导出配置**：账号名称、任务规则、目录提示；不包含发布历史。导入后通过“复制任务”创建新任务。
- **备份任务数据**：保存稿件快照、任务状态与发布记录，便于恢复和检查。
- 两者均**不包含素材原文件、登录凭据或浏览器环境**。素材文件夹需单独复制，新机器需重新登录账号。
- Windows 与 Mac 的路径不同。导入后原路径只作提示，必须重新绑定本机文本和图片目录；程序会核对素材内容，迁移任务不会自动开始。
- 再次迁移遇到重复账号或任务时，程序会显示替换范围。确认“备份并替换”后，先将当前工作空间写入数据目录的 `migration-backups`，再事务导入另一台电脑的数据；取消则保留原状态。

数据存放在应用的本机数据目录，可在“数据与记录”中打开。迁移请使用应用的导入导出，不要同步正在使用的数据库文件，也不要跨系统复制浏览器 profile。

## 执行边界

任务只在本机程序运行时执行；程序退出、电脑关闭或休眠时不会执行。中断后的任务需要检查并手动继续，不承诺在关闭或睡眠期间准点发布。抖音的账号验证、平台审核和作品最终可见状态以平台显示为准。

打包命令为 `npm run dist:win` 和 `npm run dist:mac`；macOS 发行包应在 Mac 上构建。本仓库当前不提供已经实机验收的 Mac 安装包。

## 界面品牌定制

主窗口已移除 Windows 的默认菜单行，使用简洁标题栏与系统窗口按钮。Logo 源文件为 `assets/brand/logo.svg`；修改后运行 `node scripts/generate-brand-assets.mjs` 再构建打包，可同步更新窗口、侧栏和程序文件图标。产品名需统一修改窗口标题、界面品牌和 package.json 的 productName。macOS 保留系统编辑菜单以支持快捷键。
