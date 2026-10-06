import {
  deriveLastMaintenanceDate,
  judgeDeviceMaintenance,
  statusForLevel,
  todayStr,
} from './maintenance-rule'
import type { MaintenanceLevel } from './maintenance-rule'
import type { EntryRow } from './types'

// 存量设备台账的清洗：设备编号撞车合并 + 上次保养日回填。
// 整个流程幂等：重复执行结果不变，初始化跑几遍都不会冒出多余设备。

export type ReconcileResult = {
  rows: EntryRow[]
  /** 撞车合并的缘由，逐条写清，便于审计 */
  notes: string[]
}

const SEVERITY: Record<MaintenanceLevel, number> = { 正常: 1, 待保养: 2, 已报废: 3 }

/** 上次保养日缺失的按启用日期倒推补上；已有值的一律不动（老账照旧） */
function backfillLastMaintenance(row: EntryRow): EntryRow {
  const lastDone = String(row['上次保养日'] ?? '').trim()
  if (lastDone) {
    return row
  }
  const derived = deriveLastMaintenanceDate(row['投运日期'])
  if (!derived) {
    return row
  }
  return { ...row, 上次保养日: derived }
}

/**
 * 同一设备编号出现多条时按同一台合并：
 * 以最早登记的一条为底，其余各条只补缺（底行已有的字段不覆盖）；
 * 状态取各条统一判定结论中较严的一档，并在「合并缘由」里写清来龙去脉。
 */
function mergeGroup(code: string, group: EntryRow[], today: string): { row: EntryRow; note: string } {
  const keeper: EntryRow = { ...group[0] }
  for (const rest of group.slice(1)) {
    for (const [field, value] of Object.entries(rest)) {
      if (field === 'id') {
        continue
      }
      if (keeper[field] === undefined || keeper[field] === '') {
        keeper[field] = value
      }
    }
  }
  const verdicts = group.map((row) => judgeDeviceMaintenance(row, today))
  const strictest = verdicts.reduce((a, b) => (SEVERITY[a.level] >= SEVERITY[b.level] ? a : b))
  keeper.status = statusForLevel(strictest.level, String(keeper.status ?? ''))
  keeper.pending = strictest.level === '待保养'
  const ids = group.map((row) => `#${row.id}`).join('、')
  const note =
    `设备编号 ${code} 撞车：记录 ${ids} 按同一台处理，保留较早登记，` +
    `其余记录只补缺不覆盖；状态取各记录统一判定中较严的一档「${strictest.level}」`
  keeper['合并缘由'] = note
  return { row: keeper, note }
}

/**
 * 清洗整份设备台账：先按设备编号分组合并撞车，再逐台回填上次保养日。
 * 已经定过级别（有登记状态）且编号不撞车的设备，状态一律不动。
 */
export function reconcileDeviceRows(rows: EntryRow[], today: string = todayStr()): ReconcileResult {
  const notes: string[] = []
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const code = String(row['设备编号'] ?? '').trim()
    const bucket = groups.get(code) ?? []
    bucket.push(row)
    groups.set(code, bucket)
  }
  const merged: EntryRow[] = []
  for (const [code, group] of groups) {
    if (group.length > 1) {
      const { row, note } = mergeGroup(code, group, today)
      notes.push(note)
      merged.push(backfillLastMaintenance(row))
    } else {
      merged.push(backfillLastMaintenance(group[0]))
    }
  }
  return { rows: merged, notes }
}

/**
 * 初始化播种：种子设备按编号并入现有台账，编号已存在的跳过。
 * 重复执行不会冒出多余设备。
 */
export function mergeSeedDevices(existing: EntryRow[], seed: EntryRow[]): EntryRow[] {
  const known = new Set(existing.map((row) => String(row['设备编号'] ?? '').trim()))
  const additions = seed.filter((row) => !known.has(String(row['设备编号'] ?? '').trim()))
  return [...existing, ...additions]
}
