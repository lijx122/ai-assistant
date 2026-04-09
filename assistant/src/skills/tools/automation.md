---
name: tools/automation
description: create_task、reminder_set 自动化工具说明
---

# 自动化工具

## create_task

用途：创建定时任务或一次性任务。

参数：
- name: string 任务名称
- schedule: string cron 表达式 或 ISO 时间字符串
- schedule_type: 'cron'|'interval'|'once'
- command_type: 'shell'|'assistant'|'http'
- command: string 执行内容
- alert_on_error: boolean（默认 true）失败时通知

示例：
- 每天9点检查服务状态：schedule="0 9 * * *", schedule_type='cron'
- 1小时后执行：schedule=new Date(Date.now()+3600000).toISOString()

---

## reminder_set

用途：设置一次性提醒，到时间推送到飞书/微信。

参数：
- message: string 提醒内容
- time: string 自然语言时间（「30分钟后」「明天下午3点」）
- notify: 'web'|'lark'|'both'（默认 both）

底层：创建 schedule_type='once' 的定时任务
