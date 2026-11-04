// dsh-project-deck host half: 把本机的 deck CLI 暴露成模型工具。
// 面板本体是独立进程(~/.project-deck/bin/panel.py, http://127.0.0.1:9199)；
// 客户端半边(client.js)以 iframe 嵌入，不依赖本文件的 HTTP 路由。
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-project-deck'
export const inject = ['tools']

const PAGENT = join(homedir(), '.person-agent', 'bin', 'deck')

function run(args, timeout = 60000) {
  return new Promise((resolve) => {
    if (!existsSync(PAGENT)) {
      resolve('❌ 找不到 deck CLI：' + PAGENT + '（项目甲板 尚未初始化）')
      return
    }
    execFile(PAGENT, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errText = String(stderr || '').trim()
      if (err && !out) {
        resolve('❌ deck ' + args.join(' ') + ' 失败：' + (errText || err.message))
        return
      }
      resolve(out + (errText ? '\n' + errText : ''))
    })
  })
}

function toolText(name, description, argsBuilder) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value || '') }]
      },
    },
    async execute() {
      return run(argsBuilder())
    },
  }
}

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (!tools) {
    console.error('[dsh-project-deck] tools 服务不可用，跳过工具注册')
    return
  }

  const registrations = [
    toolText(
      'deck_status',
      '查看项目甲板 运行状态：项目数、周期播报开关与间隔、守护进程、微信通道、自动发现上次扫描时间。',
      () => ['status'],
    ),
    toolText(
      'deck_list',
      '列出项目注册表里的全部项目（id、名称、类型、状态、优先级、根目录）。',
      () => ['list'],
    ),
    toolText(
      'deck_scan',
      '扫描本机（以及已上报的其它节点）发现新项目候选，返回评分与理由；达到阈值的项目会在守护进程扫描时自动登记。',
      () => ['scan'],
    ),
    toolText(
      'deck_nodes',
      '查看多节点扫描的节点列表：平台、最近上报时间、项目数、在线状态。',
      () => ['nodes'],
    ),
    toolText(
      'deck_report',
      '立即生成项目播报并推送到微信（文字 + 可选的看板图）。会真实发送消息，仅在用户明确要求时调用。',
      () => ['report'],
    ),
  ]

  const registered = []
  for (const reg of registrations) {
    try {
      tools.register(reg)
      registered.push(reg.name)
    } catch (e) {
      console.error('[dsh-project-deck] 注册工具失败', reg.name, (e && e.message) || e)
    }
  }
  console.log('[dsh-project-deck] host ready, tools:', registered.join(', '))
}
