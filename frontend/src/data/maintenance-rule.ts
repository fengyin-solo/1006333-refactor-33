import type { EntryRow } from './types'

// 设备保养判定：全仓库唯一一份。
// 正常 / 待保养 / 已报废 的界线只在这里给，设备列表、保养动作回写、另存导出都调这里，
// 不再各写各的周期口径。规则冲突时以更严的那一档为准，宽松的一档降级成提示。

export const DEVICE_MODULE_KEY = 'device'
export const MAINTENANCE_MODULE_KEY = 'maintenance'

export type MaintenanceGrade = '正常' | '待保养' | '已报废'

export type DeviceJudgment = {
  /** 最终档位：多口径冲突时取较严的一档 */
  grade: MaintenanceGrade
  /** 被降级的宽松结论，无冲突时为空串 */
  hint: string
  /** 判定依据（给人看的一行说明） */
  basis: string
  /** 实际采用的保养周期（天） */
  cycleDays: number
  /** 采用的上次保养日（YYYY-MM-DD，可能是倒推回填值） */
  lastService: string
  /** 保养截止日（YYYY-MM-DD） */
  dueDate: string
  /** 上次保养日是否为倒推回填值 */
  backfilled: boolean
}

const STRICTNESS: Record<MaintenanceGrade, number> = { 正常: 0, 待保养: 1, 已报废: 2 }

export function stricterOf(a: MaintenanceGrade, b: MaintenanceGrade): MaintenanceGrade {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b
}

// ---------- 日期工具：只认 YYYY-MM-DD，按本地日历日处理 ----------

export function stripTime(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function parseDateOnly(raw: unknown): Date | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const match = String(raw).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) {
    return null
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateOnly(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

// ---------- 周期口径：只认这一份解析 ----------

const CYCLE_UNIT_DAYS: Record<string, number> = {
  天: 1,
  日: 1,
  周: 7,
  个月: 30,
  月: 30,
  季度: 90,
  半年: 180,
  年: 365,
}

const CYCLE_WORD_DAYS: Record<string, number> = {
  每周: 7,
  每月: 30,
  每季度: 90,
  每半年: 180,
  每年: 365,
  季度: 90,
  半年: 180,
}

/** 解析保养周期：支持「90天」「3个月」「1年」「每季度」与纯数字（按天）。解析不了返回 null。 */
export function parseCycleDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const text = String(raw).trim()
  if (!text) {
    return null
  }
  if (/^\d+$/.test(text)) {
    const days = Number(text)
    return days > 0 ? days : null
  }
  const matched = text.match(/(\d+(?:\.\d+)?)\s*(天|日|周|个月|月|季度|半年|年)/)
  if (matched) {
    const days = Math.round(Number(matched[1]) * CYCLE_UNIT_DAYS[matched[2]])
    return days > 0 ? days : null
  }
  for (const [word, days] of Object.entries(CYCLE_WORD_DAYS)) {
    if (text.includes(word)) {
      return days
    }
  }
  return null
}

// ---------- 当年那版默认口径 ----------

export type YearDefaults = {
  /** 当年版保养周期（天） */
  cycleDays: number
  /** 当年版检修计划工期（天） */
  planDays: number
  /** 当年版检修类别 */
  category: string
}

// 历史数据取值残缺时，按单据年份用对应年份那版的默认口径补齐。
const YEAR_DEFAULTS: { untilYear: number; defaults: YearDefaults }[] = [
  { untilYear: 2024, defaults: { cycleDays: 180, planDays: 10, category: '年度大修' } },
  { untilYear: 2025, defaults: { cycleDays: 120, planDays: 7, category: '季度保养' } },
]

// 现行版本：2026 年起一季一保。
export const CURRENT_DEFAULTS: YearDefaults = { cycleDays: 90, planDays: 5, category: '例行保养' }

export function defaultsForYear(year: number): YearDefaults {
  for (const entry of YEAR_DEFAULTS) {
    if (year <= entry.untilYear) {
      return entry.defaults
    }
  }
  return CURRENT_DEFAULTS
}

// ---------- 上次保养日倒推 ----------

/**
 * 倒推办法：以启用日期（投运日期）为首次保养日，按周期顺推，
 * 取不晚于基准日的最后一档作为回填的上次保养日；
 * 启用日缺失或晚于基准日时，直接取启用日（再缺则取基准日）。
 */
export function backfillLastService(commission: Date | null, cycleDays: number, today: Date): Date {
  const base = stripTime(today)
  if (!commission) {
    return base
  }
  const start = stripTime(commission)
  if (start >= base || cycleDays <= 0) {
    return start
  }
  let cursor = start
  let next = addDays(cursor, cycleDays)
  while (next <= base) {
    cursor = next
    next = addDays(cursor, cycleDays)
  }
  return cursor
}

// ---------- 统一判定 ----------

/**
 * 设备该不该保养，只看这一份结论：
 * - 已报废是终态，已经定过级别的设备不改动，周期口径不再参与；
 * - 周期口径：今天过了「上次保养日 + 周期」为待保养，否则为正常；
 * - 状态口径：台账状态为待保养则待保养，否则为正常；
 * - 两个口径冲突时以更严的那一档为准，宽松的一档写进 hint 降级成提示。
 */
export function judgeDevice(row: EntryRow, now: Date = new Date()): DeviceJudgment {
  const today = stripTime(now)
  const status = String(row.status ?? '')
  if (status === '已报废') {
    return {
      grade: '已报废',
      hint: '',
      basis: '设备已定级为已报废，终态结论不再改写',
      cycleDays: 0,
      lastService: String(row['上次保养日'] ?? ''),
      dueDate: '',
      backfilled: false,
    }
  }
  const commission = parseDateOnly(row['投运日期'])
  const year = (commission ?? today).getFullYear()
  const cycleDays = parseCycleDays(row['保养周期']) ?? defaultsForYear(year).cycleDays
  const storedLast = parseDateOnly(row['上次保养日'])
  const lastService = storedLast ?? backfillLastService(commission, cycleDays, today)
  const dueDate = addDays(lastService, cycleDays)
  const dateGrade: MaintenanceGrade = today > dueDate ? '待保养' : '正常'
  const statusGrade: MaintenanceGrade = status === '待保养' ? '待保养' : '正常'
  const grade = stricterOf(dateGrade, statusGrade)
  const hint =
    dateGrade === statusGrade
      ? ''
      : STRICTNESS[dateGrade] > STRICTNESS[statusGrade]
        ? `状态口径为「${statusGrade}」，周期口径更严，宽松一档降级为提示`
        : `周期口径为「${dateGrade}」，状态口径更严，宽松一档降级为提示`
  const basis = `周期${cycleDays}天，上次保养日${formatDateOnly(lastService)}${
    storedLast ? '' : '（按启用日期倒推回填）'
  }，截止${formatDateOnly(dueDate)}`
  return {
    grade,
    hint,
    basis,
    cycleDays,
    lastService: formatDateOnly(lastService),
    dueDate: formatDateOnly(dueDate),
    backfilled: storedLast === null,
  }
}
