@echo off
setlocal
chcp 65001 >nul
title 图文发布助手
pushd "%~dp0"
if errorlevel 1 goto failed

where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 22 最新版本后重试。
  goto failed
)
where npm >nul 2>&1
if errorlevel 1 (
  echo 未找到 npm。请检查 Node.js 安装与 PATH 设置。
  goto failed
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过低。需要 22.12 或更新版本，请升级后重试。
  goto failed
)

if not exist "node_modules\.bin\electron.cmd" (
  echo 首次准备依赖，请保持网络连接……
  call npm install
  if errorlevel 1 goto failed
)

echo 正在检查 Electron 运行时并匹配 SQLite 原生依赖……
call npm run setup
if errorlevel 1 goto failed

echo 正在构建桌面程序……
call npm run build
if errorlevel 1 goto failed
echo 正在启动。当前发布通道尚未接通，不能实际自动发布。
call npm start
if errorlevel 1 goto failed
popd
exit /b 0

:failed
echo.
echo 启动失败，请查看上方错误。错误未解决前不会继续启动。
echo 原生依赖问题可参考 README.md 的启动说明。
pause
popd
exit /b 1
