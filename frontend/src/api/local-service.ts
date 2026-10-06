import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { isDevicePending, judgeDeviceMaintenance, statusForLevel, todayStr } from '@/data/maintenance-rule'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 待办口径只有这一份：进入收口状态就不再算待办；设备走统一保养判定 */
export function isPendingRow(meta: ModuleMeta, row: EntryRow): boolean {
  if (meta.key === 'device') {
    return isDevicePending(row)
  }
  return !meta.closedStatuses.includes(String(row.status))
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

/**
 * 环节守卫：环节只能一段一段往下推进。
 * 每个动作在模块登记里声明了可发起的环节（actionFrom）；想跨过去的一律打回，
 * 并写清当前卡在哪一段、该先完成哪个动作。
 */
function checkStage(meta: ModuleMeta, action: string, current: string, target: string): ActionResult | null {
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const from = meta.actionFrom[action] ?? []
  if (from.includes(current)) {
    return null
  }
  const stageIndex = meta.statuses.indexOf(current)
  if (stageIndex < 0) {
    return { ok: false, message: `当前状态「${current}」不在${meta.entity}的流转环节里，无法执行「${action}」` }
  }
  // 找一个能解卡的动作：从当前环节能发起、且目标环节正是本动作需要的发起段
  const unblock = meta.actions.find(
    (candidate) =>
      candidate !== action &&
      (meta.actionFrom[candidate] ?? []).includes(current) &&
      from.includes(meta.actionTargets[candidate]),
  )
  if (unblock) {
    return {
      ok: false,
      message: `不能跨段执行「${action}」：当前卡在「${current}」，请先「${unblock}」推进到「${meta.actionTargets[unblock]}」`,
    }
  }
  const fromIndexes = from.map((stage) => meta.statuses.indexOf(stage)).filter((index) => index >= 0)
  const needed = from.map((stage) => `「${stage}」`).join('或')
  if (fromIndexes.length > 0 && stageIndex > Math.max(...fromIndexes)) {
    return {
      ok: false,
      message: `当前已在「${current}」，「${action}」需在${needed}段发起，不能重复或往回推进`,
    }
  }
  return { ok: false, message: `不能跨段执行「${action}」：当前卡在「${current}」，需先推进到${needed}段` }
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
  const rejected = checkStage(meta, action, current, target)
  if (rejected) {
    return rejected
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (meta.key === 'device') {
    // 完成保养回写保养日期，之后待办与否由统一判定说了算
    if (action === '完成保养') {
      updated['上次保养日'] = todayStr()
    }
    updated.pending = isDevicePending(updated)
  } else {
    updated.pending = !meta.closedStatuses.includes(target)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (meta.key === 'device') {
    const verdict = judgeDeviceMaintenance(updated)
    return { ok: true, message: `${meta.entity}已${action}，台账状态「${target}」；统一判定：${verdict.level}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  // 另存文件的列与字段保持原样；设备的「当前状态」列写统一判定结论，与列表、动作回写同一份
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const status =
      meta.key === 'device'
        ? statusForLevel(judgeDeviceMaintenance(row).level, String(row.status))
        : row.status
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
  // 台账与清单取同一份行数据，待办条数用同一个口径现算，两边永远一致
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => isPendingRow(meta, row)).length,
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
