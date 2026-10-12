#!/bin/bash
set -u

fail() {
  printf '\n启动失败，请查看上方错误并参考 README.md。\n'
  read -r -p '按回车关闭此窗口……' _reply
  exit 1
}

cd -- "$(dirname -- "$0")" || fail
if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js。请安装 Node.js 22 最新版本，并确认终端可运行 node。\n'
  fail
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '未找到 npm，请检查 Node.js 安装与 PATH 设置。\n'
  fail
fi
if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"; then
  printf 'Node.js 版本过低。需要 22.12 或更新版本，请升级后重试。\n'
  fail
fi

if [ ! -x node_modules/.bin/electron ]; then
  printf '首次准备依赖，请保持网络连接……\n'
  npm ci || fail
fi

printf '正在检查 Electron 运行时并匹配 SQLite 原生依赖……\n'
npm run setup || fail

printf '正在构建桌面程序……\n'
npm run build || fail
printf '正在启动。任务需在界面中确认并点击“开始”才会发布。\n'
npm start || fail
