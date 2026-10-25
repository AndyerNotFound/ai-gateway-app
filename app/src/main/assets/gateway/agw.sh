#!/usr/bin/env bash
# [2026-10-21 eMudhra] node 改用系统证书库(已剔除 emSign ECC Root CA - G3)
export NODE_OPTIONS="${NODE_OPTIONS//--use-openssl-ca/} --use-openssl-ca"
export SSL_CERT_FILE="${SSL_CERT_FILE:-${PREFIX:-/data/data/com.termux/files/usr}/etc/tls/cert.pem}"
# ai-gateway 网关管理脚本 (单进程多实例模式)
# 一个 node 进程托管目录下全部 config*.json:
#   - 主端口(default 实例 listen.port)按 /实例名/ 路径前缀路由, 无前缀 = default
#   - 各实例原有端口继续监听(兼容旧客户端)
#   - 实例增删改/启停/改名 全部在面板内热生效, 无需重启进程
# 用法: agw.sh <start|stop|restart|status|list|logs>
#   (实例名参数保留兼容, 但单进程模式下不再需要)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/.run"
LOG="$DIR/log"
mkdir -p "$RUN" "$LOG"
PIDFILE="$RUN/main.pid"
LOGFILE="$LOG/gateway.log"

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # 防 PID 复用: 确认该进程确实是本网关 (2026-10-10 事故: PID 被 u1s1-proxy 复用导致误判"已在运行")
  grep -q "ai-gateway/gateway[.]js" "/proc/$pid/cmdline" 2>/dev/null
}

get_main_port() {
  node -e 'try{const fs=require("fs");let raw=fs.readFileSync(process.argv[1],"utf8");try{const c=require(process.argv[2]+"/crypt.js");if(c.isEncText(raw))raw=c.decryptText(raw,c.loadPass())}catch(_){};console.log((JSON.parse(raw).listen||{}).port||16384)}catch(e){console.log("?")}' "$DIR/config.json" "$DIR" 2>/dev/null
}

show_config() {
  node "$DIR/show-cfg.js" "$DIR/config.json" 2>/dev/null
}

health_ok() {
  local port="$1" ca="$DIR/tls/ca.pem"
  if command -v curl >/dev/null 2>&1; then
    [ -f "$ca" ] && curl -sf -m 3 --cacert "$ca" "https://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0
    curl -sf -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1
  else
    node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$port" 2>/dev/null
  fi
}

list_instances() {
  local f name
  [ -f "$DIR/config.json" ] && echo "default"
  for f in "$DIR"/config.*.json; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .json)"
    echo "${name#config.}"
  done
}

start_gw() {
  if is_running; then
    echo "• 网关已在运行 (pid $(cat "$PIDFILE"), 主端口 $(get_main_port))"
    echo "  单进程模式: 实例增删/启停/改名请在面板内操作(热生效, 无需重启)"
    return 0
  fi
  # 清理孤儿主进程(用 [.] 正则避免匹配自身)
  pkill -f "ai-gateway/gateway[.]js" 2>/dev/null
  if [ ! -f "$DIR/config.json" ]; then echo "✗ 主配置不存在: $DIR/config.json"; return 1; fi
  nohup node "$DIR/gateway.js" >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  if ! is_running; then
    echo "✗ 网关启动失败, 最近日志:"
    tail -n 20 "$LOGFILE"
    rm -f "$PIDFILE"
    return 1
  fi
  local port
  port="$(get_main_port)"
  if [ "$port" != "?" ] && health_ok "$port"; then
    echo "✓ 网关启动成功: pid $(cat "$PIDFILE"), 主端口 $port, 日志 $LOGFILE"
    echo "  实例访问: http://127.0.0.1:$port/实例名/v1/... (无前缀=default)"
    echo "  管理面板: http://127.0.0.1:$port/admin/m3"
  else
    echo "△ 网关进程已启动(pid $(cat "$PIDFILE")) 但 $port/health 未就绪, 查看日志: $LOGFILE"
  fi
  show_config
}

stop_gw() {
  local pid
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$pid" ] && grep -q "ai-gateway/gateway[.]js" "/proc/$pid/cmdline" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
    fi
    rm -f "$PIDFILE"
  fi
  # 兜底清孤儿
  pkill -f "ai-gateway/gateway[.]js" 2>/dev/null
  echo "✓ 网关已停止"
}

status_gw() {
  if is_running; then
    local pid port
    pid="$(cat "$PIDFILE")"
    port="$(get_main_port)"
    echo "● 网关运行中: pid $pid, 主端口 $port"
    if health_ok "$port"; then echo "  health: OK"; else echo "  health: 未就绪"; fi
  else
    echo "○ 网关未在运行"
  fi
  echo "实例配置:"
  local n
  for n in $(list_instances); do echo "  - $n"; done
}

case "${1:-}" in
  start)        start_gw ;;
  stop)         stop_gw ;;
  restart)      stop_gw; sleep 1; start_gw ;;
  status)       status_gw ;;
  list)         list_instances ;;
  logs)         tail -n "${2:-50}" "$LOGFILE" ;;
  show)         show_config ;;
  *)
    echo "ai-gateway 网关管理 (单进程多实例模式)"
    echo "用法: $0 <start|stop|restart|status|list|logs [行数]|show>"
    echo ""
    echo "说明: 一个进程托管全部实例; 实例的增删/启停/改名/渠道管理"
    echo "      都在 Web 面板内热生效: http://127.0.0.1:$(get_main_port)/admin/m3"
    echo ""
    echo "加密访问(HTTPS):  agw-tls 看状态 | agw-tls setup 一键开启 | agw-tls use 给代码"
    ;;
esac
