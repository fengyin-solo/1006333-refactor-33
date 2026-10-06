<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备台账管理管理</h2>
        <p class="page-desc">维护管廊设备，围绕设备编号、设备名称、设备型号、所属舱室做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管廊设备</button>
        <button class="btn" type="button" @click="exportRows">导出设备台账管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>保养判定</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <strong>{{ judgmentOf(row).grade }}</strong>
            <template v-if="judgmentOf(row).hint">
              <br />
              <span class="hint-text">{{ judgmentOf(row).hint }}</span>
            </template>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无设备台账管理数据，可先登记管廊设备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备台账管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
    <ul v-if="migrationNotes.length" class="migration-notes">
      <li v-for="note in migrationNotes" :key="note">{{ note }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  migrationReport,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { judgeDevice } from '@/data/maintenance-rule'
import type { DeviceJudgment } from '@/data/maintenance-rule'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('device')
const columns = ["设备编号", "设备名称", "设备型号", "所属舱室", "投运日期", "保养周期", "上次保养日", "设备状态"]
const actions = ["登记运行", "完成保养", "报废设备"]
const statuses = ["待保养", "运行中", "已保养", "已报废"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const migrationNotes = ref<string[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 保养判定只有一份口径：正常 / 待保养 / 已报废 的界线由 data/maintenance-rule.ts 给出，
// 这里只取结论来展示，不再自己算周期。
const judgments = computed(() => {
  const map = new Map<number, DeviceJudgment>()
  for (const row of rows.value) {
    map.set(Number(row.id), judgeDevice(row))
  }
  return map
})

function judgmentOf(row: EntryRow): DeviceJudgment {
  return judgments.value.get(Number(row.id)) ?? judgeDevice(row)
}

// 统计卡与清单取同一份判定，两边数字一致。
const stats = computed(() => {
  const grades = rows.value.map((row) => judgmentOf(row).grade)
  return [
    { label: '正常设备', value: grades.filter((grade) => grade === '正常').length },
    { label: '待保养设备', value: grades.filter((grade) => grade === '待保养').length },
    { label: '已报废设备', value: grades.filter((grade) => grade === '已报废').length },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管廊设备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    migrationNotes.value = migrationReport()
      .notes.filter((note) => note.module === meta.key)
      .map((note) => note.text)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设备台账管理列表读取失败'
  }
}

onMounted(reload)
</script>
