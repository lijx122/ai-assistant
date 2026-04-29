#!/bin/bash
#
# 日志监控脚本示例
# 用于检测日志文件中的异常关键词
#
# 使用方法:
# 1. 将此脚本配置为定时任务
# 2. 设置环境变量 LOG_FILE 指定要监控的日志文件
# 3. 可选设置 KEYWORDS 自定义检测关键词
#
# 输出格式:
# - 正常: exit 0
# - 异常: 输出 HINT: 和 LOG: 后 exit 1
#

# 配置
LOG_FILE="${LOG_FILE:-/var/log/app.log}"
KEYWORDS="${KEYWORDS:-ERROR FATAL panic Exception}"
MAX_LINES="${MAX_LINES:-100}"

# 检查日志文件是否存在
if [ ! -f "$LOG_FILE" ]; then
    echo "HINT: 日志文件不存在: $LOG_FILE"
    echo "LOG: 请检查 LOG_FILE 环境变量设置"
    exit 1
fi

# 检查日志文件是否可读
if [ ! -r "$LOG_FILE" ]; then
    echo "HINT: 无法读取日志文件: $LOG_FILE"
    echo "LOG: 权限不足，请检查文件权限"
    exit 1
fi

# 读取最近 N 行日志
RECENT_LOGS=$(tail -n "$MAX_LINES" "$LOG_FILE" 2>/dev/null)

# 检测关键词
FOUND_ERRORS=""
for keyword in $KEYWORDS; do
    MATCHES=$(echo "$RECENT_LOGS" | grep -i "$keyword" 2>/dev/null || true)
    if [ -n "$MATCHES" ]; then
        FOUND_ERRORS="${FOUND_ERRORS}${keyword}: ${MATCHES}
"
    fi
done

# 如果有异常，输出告警信息并退出 1
if [ -n "$FOUND_ERRORS" ]; then
    echo "HINT: 检测到 ${KEYWORDS// /、} 关键词，共 $(echo "$FOUND_ERRORS" | wc -l) 处异常"
    echo "LOG: ${FOUND_ERRORS:0:500}"
    exit 1
fi

# 正常情况
exit 0
