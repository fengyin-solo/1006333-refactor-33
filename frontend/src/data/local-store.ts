import { reconcileDeviceRows } from './device-reconcile'
import { backfillMaintenanceRecords } from './maintenance-backfill'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

// 存量数据迁移标记：设备台账清洗 + 检修单据回填只执行一次。
// 两个迁移函数本身都幂等，即使标记丢失重复执行也不会冒出多余设备或重复回填。
const MIGRATION_KEY = 'urban-utility-tunnel:migrations'
const MIGRATION_VERSION = 'v1:device-reconcile+maintenance-backfill'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

/** 迁移只跑一次：设备编号撞车合并、上次保养日倒推回填、检修单据按完工日期补齐 */
function migrateOnce(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (!canUseStorage()) {
    return data
  }
  if (window.localStorage.getItem(MIGRATION_KEY) === MIGRATION_VERSION) {
    return data
  }
  const next = { ...data }
  next.device = reconcileDeviceRows(next.device ?? []).rows
  next.maintenance = backfillMaintenanceRecords(next.maintenance ?? []).rows
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.localStorage.setItem(MIGRATION_KEY, MIGRATION_VERSION)
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!canUseStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migrateOnce(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return migrateOnce({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (canUseStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const seed = key === 'device' ? reconcileDeviceRows(clone(SEED_ROWS[key] ?? [])).rows : clone(SEED_ROWS[key] ?? [])
  const rows = key === 'maintenance' ? backfillMaintenanceRecords(seed).rows : seed
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
