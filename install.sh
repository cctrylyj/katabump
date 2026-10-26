#!/bin/sh
# KataBump 节点 · 一键安装脚本（Node 版）
# 用法（面板 Console 执行）：
#     sh /home/container/install.sh
#
# 作用：
#   1. 选对架构的 xray 并加可执行权限（面板上传后权限经常丢失）
#   2. 清理面板自带的 sing-box / tuic 进程
#   3. 生成配置并启动节点
#
# ⚠️ 执行前请先在面板点【Stop】，否则前台进程会吃掉你输入的命令。

cd /home/container 2>/dev/null || cd "$(dirname "$0")"

echo "==> 检测架构"
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) TAG="arm64" ;;
  x86_64|amd64)  TAG="amd64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac
echo "    架构: $ARCH  ->  xray-linux-$TAG"

if [ ! -f "xray-linux-$TAG" ]; then
  echo "!! 找不到 xray-linux-$TAG"
  echo "   请在面板文件管理里上传该文件到 /home/container/"
  exit 1
fi

chmod 755 "xray-linux-$TAG" 2>/dev/null || true
cp -f "xray-linux-$TAG" xray
chmod 755 xray
echo "    已安装: /home/container/xray"

if [ ! -f "index.js" ]; then
  echo "!! 找不到 index.js"
  echo "   请在面板文件管理里上传 index.js 到 /home/container/"
  exit 1
fi
chmod 755 index.js 2>/dev/null || true

echo "==> 清理面板自带的 sing-box / tuic"
pkill -f sing-box 2>/dev/null || true
pkill -f tuic 2>/dev/null || true
sleep 1

echo "==> 生成配置并启动"
node /home/container/index.js &

sleep 4
echo ""
echo "============================================================"
echo " 完成。查看节点参数："
echo "     node /home/container/index.js --status"
echo " 配置文件："
echo "     /home/container/clash.yaml"
echo "     /home/container/sub.txt"
echo "============================================================"
