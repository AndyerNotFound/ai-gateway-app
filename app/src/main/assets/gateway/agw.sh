#!/usr/bin/env bash
# ai-gateway 实例管理脚本 (Termux)
# 用法: agw.sh <start|stop|restart|status|list|logs> [实例名]
#   实例名 default → config.json
#   其他实例名 N   → config.N.json
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/.run"
LOG="$DIR/log"
mkdir -p "$RUN" "$LOG"

cfg_for() { [ "$1" = "default" ] && echo "$DIR/config.json" || echo "$DIR/config.$1.json"; }
pid_for() { echo "$RUN/$1.pid"; }
log_for() { echo "$LOG/$1.log"; }

is_running() {
  local pf pid
  pf="$(pid_for "$1")"
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

get_port() {
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((c.listen&&c.listen.port)||16384)}catch(e){console.log("?")}' "$1" 2>/dev/null
}

# 解析配置并打印打码后的摘要(key 不外泄). $1=配置路径
show_config() {
  node "$DIR/show-cfg.js" "$1" 2>/dev/null
}

health_ok() { # $1=端口, 优先 curl, 无 curl 用 node fetch
  if command -v curl >/dev/null 2>&1; then
    curl -sf -m 3 "http://127.0.0.1:$1/health" >/dev/null 2>&1
  else
    node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$1" 2>/dev/null
  fi
}

start_one() {
  local name="$1" cfg port
  cfg="$(cfg_for "$name")"
  if [ ! -f "$cfg" ]; then echo "✗ 配置不存在: $cfg"; return 1; fi
  if is_running "$name"; then
    echo "• 实例 [$name] 已在运行 (pid $(cat "$(pid_for "$name")"), 端口 $(get_port "$cfg"))"
    return 0
  fi
  # 清理同配置的孤儿进程 (用 [.] 正则避免匹配到自身)
  pkill -f "gateway[.]js $cfg" 2>/dev/null
  port="$(get_port "$cfg")"
  nohup node "$DIR/gateway.js" "$cfg" >> "$(log_for "$name")" 2>&1 &
  echo $! > "$(pid_for "$name")"
  sleep 1
  if ! is_running "$name"; then
    echo "✗ 实例 [$name] 启动失败, 最近日志:"
    tail -n 15 "$(log_for "$name")"
    rm -f "$(pid_for "$name")"
    return 1
  fi
  if [ "$port" != "?" ] && { command -v curl >/dev/null 2>&1 || command -v node >/dev/null 2>&1; }; then
    if health_ok "$port"; then
      echo "✓ 实例 [$name] 启动成功: pid $(cat "$(pid_for "$name")"), 端口 $port, 日志 $(log_for "$name")"
      show_config "$cfg"
    else
      echo "△ 实例 [$name] 进程已启动(pid $(cat "$(pid_for "$name")")) 但 $port/health 未就绪, 查看日志: $(log_for "$name")"
    fi
  else
    echo "✓ 实例 [$name] 启动成功: pid $(cat "$(pid_for "$name")")"
    show_config "$cfg"
  fi
}

stop_one() {
  local name="$1" pf pid cfg
  pf="$(pid_for "$name")"
  if [ -f "$pf" ]; then
    pid="$(cat "$pf" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      local i
      for i in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 0.4; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
      echo "✓ 已停止实例 [$name] (pid $pid)"
    else
      echo "• 实例 [$name] 未在运行 (清理陈旧 pid)"
    fi
    rm -f "$pf"
  else
    # 没有pid文件, 尝试按配置文件匹配孤儿进程
    cfg="$(cfg_for "$name")"
    if pkill -f "gateway[.]js $cfg" 2>/dev/null; then
      echo "✓ 已停止 [$name] 的孤儿进程"
    else
      echo "• 实例 [$name] 未在运行"
    fi
  fi
}

each_config_name() {
  local f name found=0
  for f in "$DIR"/config.json "$DIR"/config.*.json; do
    [ -f "$f" ] || continue
    case "$f" in
      */config.json) name=default ;;
      *) name="${f#$DIR/config.}"; name="${name%.json}" ;;
    esac
    echo "$name"
    found=1
  done
  [ "$found" = "1" ]
}

status_all() {
  local f name port st
  for f in "$DIR"/config.json "$DIR"/config.*.json; do
    [ -f "$f" ] || continue
    case "$f" in
      */config.json) name=default ;;
      *) name="${f#$DIR/config.}"; name="${name%.json}" ;;
    esac
    port="$(get_port "$f")"
    st="未运行"
    if is_running "$name"; then
      st="运行中 pid=$(cat "$(pid_for "$name")")"
      if [ "$port" != "?" ] && { command -v curl >/dev/null 2>&1 || command -v node >/dev/null 2>&1; }; then
        health_ok "$port" && st="$st 健康✓" || st="$st health无响应⚠"
      fi
    fi
    printf '%-12s port=%-6s %-28s [%s]\n' "$name" "$port" "$st" "$(basename "$f")"
  done
}

# 查看某实例的配置摘要(打码, 不泄 key). 用法: agw.sh show [实例名]
show_one() {
  local name="${1:-default}" cfg
  cfg="$(cfg_for "$name")"
  if [ ! -f "$cfg" ]; then echo "✗ 配置不存在: $cfg"; return 1; fi
  echo "实例 [$name] 配置 ($(basename "$cfg")):"
  show_config "$cfg"
}

show_logs() {
  local name="${1:-default}" n="${2:-50}"
  if [ ! -f "$(log_for "$name")" ]; then echo "无日志文件: $(log_for "$name")"; return 1; fi
  tail -n "$n" "$(log_for "$name")"
}

case "${1:-status}" in
  start)
    if [ -n "${2:-}" ]; then start_one "$2"; else each_config_name | while read -r n; do start_one "$n"; done; fi ;;
  stop)
    if [ -n "${2:-}" ]; then stop_one "$2"; else each_config_name | while read -r n; do stop_one "$n"; done; fi ;;
  restart)
    if [ -n "${2:-}" ]; then stop_one "$2"; start_one "$2"; else each_config_name | while read -r n; do stop_one "$n"; start_one "$n"; done; fi ;;
  status) status_all ;;
  show) show_one "${2:-default}" ;;
  config) node "$DIR/cfg-cli.js" "${@:2}" ;;
  list) each_config_name || echo "(无配置文件)" ;;
  logs) show_logs "${2:-default}" "${3:-50}" ;;
  help|-h|--help)
    cat <<'EOF'
ai-gateway 管理脚本
用法: agw.sh <命令> [实例名]

  start [实例名]    启动 (省略实例名=启动全部实例, 启动成功后自动显示配置摘要)
  stop [实例名]     停止 (省略=停止全部)
  restart [实例名]  重启 (改完配置后用, 会重新显示配置摘要)
  status            查看全部实例状态
  show [实例名]     查看某实例配置摘要 (打码不泄key, 默认看 default)
  config [实例名] [命令]  命令行配置工具 (交互式问答, 告别手写JSON):
      config                     交互式: 选实例 → 主菜单
      config free add            交互式添加渠道到 free 实例
      config free list           列出 free 实例的渠道
      config free remove 渠道名  删除某渠道
      config free set-port 16390 改端口
      config free set-key "密码"  设/改网关密码
      config free enable-tls [端口] 启用 HTTPS (需先 gen-cert.sh, 默认端口=HTTP+9)
      config free disable-tls      关闭 HTTPS
      config free add --name X --type openai --baseUrl URL --apiKey K --models a,b,c
  list              列出全部实例
  logs [名] [行数]  查看日志 (默认 50 行, agw.sh logs default 200)
  help              本帮助

实例与配置的对应关系:
  default → config.json
  office  → config.office.json   (复制一份 config.json 改名+改端口即可多开)
EOF
    ;;
  *) echo "未知命令: $1 (agw.sh help 查看用法)"; exit 1 ;;
esac
