<#
.SYNOPSIS
  BetterMe 真实浏览器接管与环境预热脚本 (Windows PowerShell)
  通过 Chrome / Edge 远程调试模式 (--remote-debugging-port=9222) 启动真实浏览器
#>

param(
  [int]$Port = 9222,
  [string]$UserDataDir = "$HOME\.betterme-chrome-profile"
)

if (-not (Test-Path $UserDataDir)) {
  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "🚀 启动真实浏览器 (远程调试接管模式)" -ForegroundColor Green
Write-Host "  • 调试端口: $Port"
Write-Host "  • 数据目录: $UserDataDir"
Write-Host "==========================================================" -ForegroundColor Cyan

$chromePaths = @(
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:LocalAppData}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
)

$browserExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browserExe) {
  Write-Warning "未找到 Chrome 或 Edge 安装路径，请手动指定。"
  exit 1
}

Write-Host "正在使用: $browserExe" -ForegroundColor Yellow

Start-Process -FilePath $browserExe -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$UserDataDir`"",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "https://www.zhipin.com"
)

Write-Host "----------------------------------------------------------"
Write-Host "✅ 真实浏览器已启动，调试端口已就绪。" -ForegroundColor Green
Write-Host "💡 提示："
Write-Host "   1. 您可以在该窗口中登录 Boss直聘 / 猎聘 / 51job / 领英 / Seek / Indeed。"
Write-Host "   2. 登录态和 Cookie 将长期持久化保存在 $UserDataDir 中。"
Write-Host "   3. BetterMe 采集程序将通过端口 $Port 自动接管，完全复用真实指纹与环境！"
Write-Host "==========================================================" -ForegroundColor Cyan
