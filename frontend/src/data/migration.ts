import {
  DEVICE_MODULE_KEY,
  MAINTENANCE_MODULE_KEY,
  backfillLastService,
  defaultsForYear,
  formatDateOnly,
  parseCycleDays,
  parseDateOnly,
  stripTime,
} from './maintenance-rule'
import type { EntryRow, MigrationNote, MigrationReport } from './types'

// 老账迁移只跑一次：版本号写进 localStorage 的 meta 项，版本不变不重跑。
// 迁移本身也做成幂等的（去重保留先登记的、回填只补空缺），重复初始化也不会冒出多余设备。
export const MIGRATION_VERSION = 1

// 设备台账：编号撞车按同一台处理；上次保养日缺失的按启用日期倒推回填。
// 已有状态结论（待保养/运行中/已保养/已报废）一律不改写。
function migrateDeviceRows(rows: EntryRow[], today: Date): { rows: EntryRow[]; notes: MigrationNote[] } {
  const notes: MigrationNote[] = []
  const seen = new Map<string, number>()
  const out: EntryRow[] = []
  for (const row of rows) {
    const code = String(row['设备编号'] ?? '').trim()
    if (code) {
      const keptId = seen.get(code)
      if (keptId !== undefined) {
        // 设备编号撞车：按同一台处理，保留先登记的那条，缘由写进迁移报告。
        notes.push({
          module: DEVICE_MODULE_KEY,
          text: `设备编号 ${code} 撞车：按同一台处理，保留先登记的 id=${keptId}，id=${row.id} 不再单列`,
        })
        continue
      }
      seen.set(code, Number(row.id))
    }
    if (!parseDateOnly(row['上次保养日'])) {
      // 存量设备缺上次保养日：按启用日期（投运日期）倒推回填，倒推办法见 maintenance-rule.ts。
      const commission = parseDateOnly(row['投运日期'])
      const year = (commission ?? today).getFullYear()
      const cycleDays = parseCycleDays(row['保养周期']) ?? defaultsForYear(year).cycleDays
      const filled = backfillLastService(commission, cycleDays, today)
      out.push({ ...row, 上次保养日: formatDateOnly(filled) })
      notes.push({
        module: DEVICE_MODULE_KEY,
        text: `设备 ${code || row.id} 缺上次保养日，按启用日期倒推回填为 ${formatDateOnly(filled)}`,
      })
      continue
    }
    out.push(row)
  }
  return { rows: out, notes }
}

// 设施检修历史单据：以完工日期为轴回填一次，取值残缺的按当年那版补齐；
// 检修状态是当时的判定，一律不动，往期保养记录沿用当时的结论。
function migrateMaintenanceRows(rows: EntryRow[], today: Date): { rows: EntryRow[]; notes: MigrationNote[] } {
  const notes: MigrationNote[] = []
  const out = rows.map((row) => {
    let next = row
    const filled: string[] = []
    const done = parseDateOnly(next['完工日期'])
    if (!done) {
      // 完工日期本身残缺：没有别的日期轴可挂，按迁移执行日补记并写清缘由。
      next = { ...next, 完工日期: formatDateOnly(today) }
      filled.push('完工日期')
    }
    const year = (done ?? today).getFullYear()
    const defaults = defaultsForYear(year)
    if (String(next['计划工期'] ?? '').trim() === '') {
      next = { ...next, 计划工期: `${defaults.planDays}天` }
      filled.push('计划工期')
    }
    if (String(next['检修类别'] ?? '').trim() === '') {
      next = { ...next, 检修类别: defaults.category }
      filled.push('检修类别')
    }
    if (filled.length > 0) {
      notes.push({
        module: MAINTENANCE_MODULE_KEY,
        text: `检修记录 ${String(next['检修编号'] ?? next.id)} 取值残缺，按${year}年那版补齐：${filled.join('、')}`,
      })
    }
    return next
  })
  return { rows: out, notes }
}

export function migrateModuleRows(
  key: string,
  rows: EntryRow[],
  now: Date = new Date(),
): { rows: EntryRow[]; notes: MigrationNote[] } {
  const today = stripTime(now)
  if (key === DEVICE_MODULE_KEY) {
    return migrateDeviceRows(rows, today)
  }
  if (key === MAINTENANCE_MODULE_KEY) {
    return migrateMaintenanceRows(rows, today)
  }
  return { rows, notes: [] }
}

export function migrateEntries(
  all: Record<string, EntryRow[]>,
  now: Date = new Date(),
): { rows: Record<string, EntryRow[]>; report: MigrationReport } {
  const notes: MigrationNote[] = []
  const rows: Record<string, EntryRow[]> = {}
  for (const [key, list] of Object.entries(all)) {
    const result = migrateModuleRows(key, list, now)
    rows[key] = result.rows
    notes.push(...result.notes)
  }
  return { rows, report: { version: MIGRATION_VERSION, ranAt: now.toISOString(), notes } }
}
