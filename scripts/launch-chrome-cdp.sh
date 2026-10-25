#!/usr/bin/env bash
# ==============================================================================
# BetterMe 真实浏览器接管与环境预热脚本 (macOS / Linux)
# 通过 Chrome 远程调试模式 (--remote-debugging-port=9222) 启动真实浏览器
# 规避 WebDriver 特征检测与指纹异常，保留真实 Cookie 与登录会话
# ==============================================================================

PORT="${1:-9222}"
PROFILE_DIR="${HOME}/.betterme-chrome-profile"

mkdir -p "$PROFILE_DIR"

echo "=========================================================="
echo "🚀 启动真实 Chrome 浏览器 (远程调试接管模式)"
echo "----------------------------------------------------------"
echo "  • 调试端口: $PORT"
echo "  • 数据目录: $PROFILE_DIR"
echo "=========================================================="

# 查找 Chrome 可执行文件
CHROME_BIN=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif [ -f "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
    CHROME_BIN="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  CHROME_BIN=$(which google-chrome 2>/dev/null || which google-chrome-stable 2>/dev/null || which chromium 2>/dev/null)
fi

if [ -z "$CHROME_BIN" ] || [ ! -f "$CHROME_BIN" ]; then
  echo "⚠️ 未在默认路径找到 Google Chrome，正在尝试通过命令启动..."
  CHROME_BIN="google-chrome"
fi

echo "正在使用: $CHROME_BIN"

"$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --disable-blink-features=AutomationControlled \
  --no-first-run \
  --no-default-browser-check \
  "https://www.zhipin.com" &

CHROME_PID=$!

echo "----------------------------------------------------------"
echo "✅ 真实 Chrome 浏览器已启动 (PID: $CHROME_PID)"
echo "💡 提示："
echo "   1. 您可以在该窗口中登录 Boss直聘 / 猎聘 / 51job / 领英 / Seek / Indeed。"
echo "   2. 登录态和 Cookie 将长期持久化保存在 $PROFILE_DIR 中。"
echo "   3. BetterMe 采集程序将通过端口 $PORT 自动接管，完全复用真实指纹与环境！"
echo "=========================================================="
