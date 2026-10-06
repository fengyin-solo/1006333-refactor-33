import type { EntryRow } from './types'

// 设备保养判定：全仓库只在这里写一遍。
// 列表展示、保养动作回写、另存导出三处统一调用本文件，
// 「正常 / 待保养 / 已报废」三档界线只由这里给，其他任何地方不得再写一套口径。

export type MaintenanceLevel = '正常' | '待保养' | '已报废'

export type MaintenanceVerdict = {
  /** 最终结论：多路信号冲突时取较严的一档 */
  level: MaintenanceLevel
  /** 被降级的宽松档结论写在这里，只作提示，不作依据 */
  hint: string
  /** 按统一口径算出的应保养日，算不出为空串 */
  dueDate: string
  /** 判定依据，便于对账时说明结论怎么来的 */
  basis: string
}

/** 严重度：档级越高越严，冲突时以严的为准 */
const SEVERITY: Record<MaintenanceLevel, number> = { 正常: 1, 待保养: 2, 已报废: 3 }

/** 保养周期解析不出来时的默认口径：90 天 */
export const DEFAULT_CYCLE_DAYS = 90

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function todayStr(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function parseDate(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const date = new Date(`${text}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function addDays(dateStr: string, days: number): string {
  const date = parseDate(dateStr)
  if (!date) {
    return ''
  }
  date.setDate(date.getDate() + days)
  return formatDate(date)
}

/**
 * 保养周期统一换算成天数。
 * 认得：纯数字（按天）、"90天"、"2周"、"3个月"/"3月"、"1季度"、"半年"、"1年"。
 * 认不出的按默认 90 天，并在判定依据里写明，不悄悄各算各的。
 */
export function parseCycleDays(raw: unknown): { days: number; fallback: boolean } {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return { days: DEFAULT_CYCLE_DAYS, fallback: true }
  }
  const plain = Number(text)
  if (Number.isFinite(plain) && plain > 0) {
    return { days: Math.round(plain), fallback: false }
  }
  if (text.includes('半年')) {
    return { days: 180, fallback: false }
  }
  const match = text.match(/(\d+(?:\.\d+)?)\s*(天|日|周|个月|月|季度|年)/)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2]
    const factor =
      unit === '天' || unit === '日' ? 1
      : unit === '周' ? 7
      : unit === '个月' || unit === '月' ? 30
      : unit === '季度' ? 90
      : 365
    return { days: Math.max(1, Math.round(amount * factor)), fallback: false }
  }
  return { days: DEFAULT_CYCLE_DAYS, fallback: true }
}

/**
 * 上次保养日缺失时的倒推办法（全仓库统一这一种）：
 * 以启用日期（投运日期）视同首次保养，即 上次保养日 := 投运日期。
 * 启用验收即首次保养，是偏保守（偏严）的口径：老设备会被判为待保养，
 * 促使补录真实保养记录，而不是凭空假设一直按期保养。
 * 投运日期也缺失或不是合法日期时返回空串，由判定函数从严处理。
 */
export function deriveLastMaintenanceDate(commissionDate: unknown): string {
  const text = String(commissionDate ?? '').trim()
  const date = parseDate(text)
  return date ? formatDate(date) : ''
}

/** 台账状态口径下的档位：已报废最严，待保养次之，其余都算正常 */
function ledgerLevelOf(status: string): MaintenanceLevel {
  if (status === '已报废') {
    return '已报废'
  }
  if (status === '待保养') {
    return '待保养'
  }
  return '正常'
}

/**
 * 唯一判定入口。输入一台设备的行数据，输出三档结论。
 * 两路信号：周期口径（上次保养日 + 周期 与今天比较）、台账口径（登记状态）。
 * 规则冲突时以更严的那一档为准，宽松的一档降级写进 hint。
 */
export function judgeDeviceMaintenance(row: EntryRow, today: string = todayStr()): MaintenanceVerdict {
  const status = String(row.status ?? '')
  const cycle = parseCycleDays(row['保养周期'])

  let lastDone = String(row['上次保养日'] ?? '').trim()
  let derived = false
  if (!lastDone) {
    lastDone = deriveLastMaintenanceDate(row['投运日期'])
    derived = lastDone !== ''
  }

  let cycleLevel: MaintenanceLevel
  let dueDate = ''
  let cycleBasis: string
  if (!lastDone) {
    // 上次保养日和启用日期都没有，周期无从算起，从严按待保养
    cycleLevel = '待保养'
    cycleBasis = '上次保养日与投运日期均缺失，周期无从核算，从严按待保养'
  } else {
    dueDate = addDays(lastDone, cycle.days)
    cycleLevel = dueDate <= today ? '待保养' : '正常'
    const source = derived ? `${lastDone}（按启用日期倒推）` : lastDone
    const cycleText = cycle.fallback ? `${cycle.days}天（周期无法解析，按默认口径）` : `${cycle.days}天`
    cycleBasis = `上次保养日 ${source}，周期 ${cycleText}，应保养日 ${dueDate}`
  }

  const ledgerLevel = ledgerLevelOf(status)
  const strict = SEVERITY[cycleLevel] >= SEVERITY[ledgerLevel] ? cycleLevel : ledgerLevel
  const loose = strict === cycleLevel ? ledgerLevel : cycleLevel

  let hint = ''
  if (cycleLevel !== ledgerLevel) {
    const looseText = loose === ledgerLevel ? `台账登记「${status || '未登记'}」` : '周期口径'
    hint = `${looseText}结论为「${loose}」，与较严档冲突，已降级为提示；以「${strict}」为准`
  }

  return {
    level: strict,
    hint,
    dueDate,
    basis: `${cycleBasis}；台账登记「${status || '未登记'}」`,
  }
}

/**
 * 三档结论映射回台账状态用词。
 * 正常档不细分为运行中/已保养：登记为已保养的保持已保养，其余记运行中。
 */
export function statusForLevel(level: MaintenanceLevel, currentStatus: string): string {
  if (level === '已报废') {
    return '已报废'
  }
  if (level === '待保养') {
    return '待保养'
  }
  return currentStatus === '已保养' ? '已保养' : '运行中'
}

/** 设备是否计入待办：只看统一判定的结论，全仓库一个口径 */
export function isDevicePending(row: EntryRow, today: string = todayStr()): boolean {
  return judgeDeviceMaintenance(row, today).level === '待保养'
}
