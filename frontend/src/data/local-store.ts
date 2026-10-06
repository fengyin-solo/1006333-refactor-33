import { MIGRATION_VERSION, migrateEntries, migrateModuleRows } from './migration'
import { SEED_ROWS } from './seed'
import type { EntryRow, MigrationReport } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
// 迁移版本与报告单独存：版本不变不重跑，初始化重复执行也不会冒出多余设备。
const META_KEY = 'urban-utility-tunnel:meta'

type StorageMeta = {
  version: number
  report: MigrationReport
}

const EMPTY_REPORT: MigrationReport = { version: MIGRATION_VERSION, ranAt: '', notes: [] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let lastReport: MigrationReport = EMPTY_REPORT

function readMeta(): StorageMeta | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    const raw = window.localStorage.getItem(META_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as StorageMeta
    return typeof parsed?.version === 'number' ? parsed : null
  } catch {
    return null
  }
}

function writeStorage(rows: Record<string, EntryRow[]>, meta: StorageMeta): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  window.localStorage.setItem(META_KEY, JSON.stringify(meta))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  let base = fallback
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        base = { ...fallback, ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
      } catch {
        base = fallback
      }
    }
  }
  const meta = readMeta()
  if (meta && meta.version >= MIGRATION_VERSION) {
    lastReport = meta.report ?? EMPTY_REPORT
    return base
  }
  // 老账迁移只跑一次：设备编号去重、上次保养日回填、历史单据按完工日期补齐，
  // 都不改写已有状态结论；跑完把版本号写死，重复初始化不会再动数据。
  const { rows, report } = migrateEntries(base)
  lastReport = report
  writeStorage(rows, { version: MIGRATION_VERSION, report })
  return rows
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
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  // 重置也过同一份迁移：去重与回填口径和初始化保持一致。
  const { rows } = migrateModuleRows(key, clone(SEED_ROWS[key] ?? []))
  saveRows(key, rows)
  return rows
}

export function migrationReport(): MigrationReport {
  allRows() // 确保迁移已经跑过
  return lastReport
}

export function storageKey(): string {
  return STORAGE_KEY
}
