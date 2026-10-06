import type { EntryRow } from './types'

// 历史检修单据回填：以完工日期为轴，只回填一次（由 local-store 的迁移标记保证），
// 取值残缺的字段按完工那一年的版本模板补齐。
// 往期单据的状态是当时的判定结论，一律不动。

/** 各年份的补齐模板：当年那版单据长什么样，就按那版补 */
const YEARLY_FILL: Record<number, Record<string, string>> = {
  2024: { 检修类别: '例行保养', 检修班组: '综合运维一班', 计划工期: '3天', 更换部件: '无' },
  2025: { 检修类别: '状态检修', 检修班组: '综合运维二班', 计划工期: '5天', 更换部件: '无' },
  2026: { 检修类别: '精益检修', 检修班组: '机电运维班', 计划工期: '7天', 更换部件: '无' },
}

/** 找不晚于完工年份的最近一版；比所有版本都早就用最早的一版 */
function fillForYear(year: number): Record<string, string> {
  const years = Object.keys(YEARLY_FILL).map(Number).sort((a, b) => a - b)
  let picked = years[0]
  for (const candidate of years) {
    if (candidate <= year) {
      picked = candidate
    }
  }
  return YEARLY_FILL[picked]
}

/**
 * 回填整份检修单据。只补空值，不改已有取值；没有完工日期的单不在回填轴上，原样保留。
 * 幂等：补过的单再跑一遍不会有任何变化。
 */
export function backfillMaintenanceRecords(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    const doneDate = String(row['完工日期'] ?? '').trim()
    const year = Number(doneDate.slice(0, 4))
    if (!doneDate || !Number.isFinite(year)) {
      return row
    }
    const fill = fillForYear(year)
    const patched: EntryRow = { ...row }
    let touched = false
    for (const [field, value] of Object.entries(fill)) {
      if (String(patched[field] ?? '').trim() === '') {
        patched[field] = value
        touched = true
      }
    }
    if (touched) {
      changed = true
    }
    return touched ? patched : row
  })
  return { rows: changed ? next : rows, changed }
}
