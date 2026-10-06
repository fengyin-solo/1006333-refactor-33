import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, migrationReport, resetRows, saveRows } from '@/data/local-store'
import { DEVICE_MODULE_KEY, formatDateOnly, judgeDevice } from '@/data/maintenance-rule'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export { migrationReport }

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 待办口径只有这一份：动作回写和看板统计都从这里派生，
// 整改动作回写后的待办条数与安防台账等各模块台账保持一致。
export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return status !== meta.statuses[meta.statuses.length - 1]
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 环节只能一段一段往下推进：目标必须是当前段紧挨着的下一段，
  // 想跨过去的一律打回，并写清卡在哪一段。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex < 0) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」不在登记的状态序列里，卡在入口段，「${action}」已打回` }
  }
  if (currentIndex === meta.statuses.length - 1) {
    return { ok: false, message: `${meta.entity}已到末段「${current}」，没有后续环节，「${action}」已打回` }
  }
  if (targetIndex !== currentIndex + 1) {
    const nextStatus = meta.statuses[currentIndex + 1]
    return { ok: false, message: `${meta.entity}当前卡在「${current}」段，下一环节是「${nextStatus}」，不能跨段执行「${action}」，已打回` }
  }
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 保养动作回写：完成保养的设备按统一判定口径记下保养日期，
  // 列表、另存导出看到的都是同一份结论。
  if (meta.key === DEVICE_MODULE_KEY && target === '已保养') {
    updated = { ...updated, 上次保养日: formatDateOnly(new Date()) }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  // 另存文件的列与字段保持原样：表头不动；
  // 设备模块的「当前状态」列写统一判定结论，与设备台账页面看的是同一份。
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const status = meta.key === DEVICE_MODULE_KEY ? judgeDevice(row).grade : String(row.status)
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      // 待办条数与各模块台账取同一份派生口径，台账与清单同步更新。
      pending: entries.filter((row) => isPendingStatus(meta, String(row.status))).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
