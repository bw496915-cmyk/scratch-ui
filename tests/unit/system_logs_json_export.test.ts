/**
 * @file tests/unit/system_logs_json_export.test.ts
 * @description Verifies filtered System Logs JSON selection, structured payload
 * formatting, descriptive filename generation, client-side Blob download cleanup,
 * and Export JSON button rendering in SystemLogBitwiseSearchBar / SystemLogsPanel.
 */

import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { SystemLogBitwiseSearchBar } from "../../packages/ui/src/panels/SystemLogBitwiseSearchBar.tsx"
import {
  BitwiseLogFilterStore,
  buildBitwiseLogIndex,
  LOG_SEVERITY_BIT_ERROR,
  LOG_SEVERITY_BIT_WARN,
  parseBitwiseSeverityQuery,
  severityLabelToBit,
} from "../../packages/ui/src/system_log_bitwise_filter.ts"
import {
  buildSystemLogsJsonExportPayload,
  buildSystemLogsJsonFilename,
  downloadSystemLogsJsonBlob,
  formatSystemLogsJson,
  selectBitwiseFilteredRows,
  type UnifiedSystemLogRow,
} from "../../packages/ui/src/system_logs_json_export.ts"

const SAMPLE_UNIFIED_LOGS: readonly UnifiedSystemLogRow[] = [
  {
    id: "alert:dlq-1",
    timestamp: "2026-11-22T07:45:00.000Z",
    level: "ERROR",
    customerId: "JAKE231",
    ipCategory: "PROXY_EXIT",
    source: "ALERTS",
    message: "[DEAD] ORIGINATOR_HIGH_RISK · JAKE231 (W-101) — Webhook 502",
  },
  {
    id: "r2:sink-2",
    timestamp: "2026-11-22T07:40:00.000Z",
    level: "WARN",
    customerId: "—",
    ipCategory: "CLOUD_CDN",
    source: "R2",
    message: "Sink live-odds (STALE) — Lag 18s",
  },
  {
    id: "pty:0",
    timestamp: "2026-11-22T07:35:00.000Z",
    level: "INFO",
    customerId: "MIKE882",
    ipCategory: "OPERATOR_PTY",
    source: "PTY",
    message: "$ profile MIKE882 (exit 0, 12ms)",
  },
  {
    id: "alert:ok-4",
    timestamp: "2026-11-22T07:30:00.000Z",
    level: "INFO",
    customerId: "JAKE231",
    ipCategory: "RESIDENTIAL",
    source: "ALERTS",
    message: "[DELIVERED] BASELINE · JAKE231 (W-099)",
  },
]

describe("system_logs_json_export", () => {
  test("selectBitwiseFilteredRows returns only logs matching active bitwise mask and search terms", () => {
    const index = buildBitwiseLogIndex(
      SAMPLE_UNIFIED_LOGS,
      (row) => severityLabelToBit(row.level),
      (row) => `${row.source} ${row.level} ${row.customerId} ${row.ipCategory} ${row.message}`,
    )

    const critOrWarn = parseBitwiseSeverityQuery("error|warn")
    const sevFiltered = selectBitwiseFilteredRows(SAMPLE_UNIFIED_LOGS, index, critOrWarn)
    expect(sevFiltered.map((r) => r.id)).toEqual(["alert:dlq-1", "r2:sink-2"])

    const scopedCustomer = parseBitwiseSeverityQuery("-info jake231")
    const customerFiltered = selectBitwiseFilteredRows(SAMPLE_UNIFIED_LOGS, index, scopedCustomer)
    expect(customerFiltered.map((r) => r.id)).toEqual(["alert:dlq-1"])
  })

  test("buildSystemLogsJsonExportPayload and formatSystemLogsJson produce pretty-printed structured JSON", () => {
    const parsedQuery = parseBitwiseSeverityQuery("crit|high jake231")
    const filtered = [SAMPLE_UNIFIED_LOGS[0]!]
    const payload = buildSystemLogsJsonExportPayload({
      mode: "weblogs",
      entries: filtered,
      totalRows: SAMPLE_UNIFIED_LOGS.length,
      parsedQuery,
      exportedAt: "2026-11-22T08:05:00.000Z",
      weblogFilters: {
        severityFilter: "CRITICAL",
        ipFilter: "ALL",
        kindFilter: "BOT_BLOCK_LINE_ST",
        searchQuery: "jake231",
        sortField: "time",
        sortDir: "desc",
      },
    })

    expect(payload.schemaVersion).toBe(1)
    expect(payload.mode).toBe("weblogs")
    expect(payload.totalRows).toBe(4)
    expect(payload.filteredRows).toBe(1)
    expect(payload.filters.bitwiseMask).toBe("0x0C")
    expect(payload.filters.activeSeverities).toEqual(["CRIT", "HIGH"])
    expect(payload.filters.textTerms).toEqual(["jake231"])
    expect(payload.filters.weblogFilters?.kindFilter).toBe("BOT_BLOCK_LINE_ST")

    const formatted = formatSystemLogsJson(payload)
    expect(formatted).toContain('\n  "schemaVersion": 1,\n')
    expect(formatted.endsWith("\n")).toBe(true)
    const roundTrip = JSON.parse(formatted) as typeof payload
    expect(roundTrip.entries).toEqual(filtered)
  })

  test("buildSystemLogsJsonFilename omits ALL / full masks and includes narrowed filter slugs", () => {
    const date = new Date("2026-11-22T12:00:00Z")

    expect(
      buildSystemLogsJsonFilename({
        mode: "unified",
        effectiveMask: 0x0d,
        date,
      }),
    ).toBe("sportsdesk-system-logs-unified-2026-11-22.json")

    expect(
      buildSystemLogsJsonFilename({
        mode: "weblogs",
        effectiveMask: LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_WARN,
        severityFilter: "ALL",
        kindFilter: "BOT_BLOCK_LINE_ST",
        ipFilter: "198.51.100.42",
        query: "crit|high BB55103",
        date,
      }),
    ).toBe(
      "sportsdesk-system-logs-weblogs-mask-0x0c-bot-block-line-st-198-51-100-42-crit-high-bb55103-2026-11-22.json",
    )
  })

  test("downloadSystemLogsJsonBlob writes formatted application/json Blob, triggers click, and revokes URL", async () => {
    const appended: unknown[] = []
    let clicked = 0
    let removed = 0
    const createdBlobs: Blob[] = []
    const revoked: string[] = []
    const fakeLink = {
      href: "",
      download: "",
      style: { display: "" },
      click: () => {
        clicked += 1
      },
      remove: () => {
        removed += 1
      },
    }

    const ok = downloadSystemLogsJsonBlob(
      '{\n  "ok": true\n}\n',
      "sportsdesk-system-logs-unified-2026-11-22.json",
      {
        URL: {
          createObjectURL: (blob) => {
            createdBlobs.push(blob)
            return "blob:json-export-1"
          },
          revokeObjectURL: (url) => {
            revoked.push(url)
          },
        },
        document: {
          createElement: () => fakeLink,
          body: {
            appendChild: (node) => appended.push(node),
          },
        },
      },
    )

    expect(ok).toBe(true)
    expect(clicked).toBe(1)
    expect(removed).toBe(1)
    expect(appended).toHaveLength(1)
    expect(fakeLink.href).toBe("blob:json-export-1")
    expect(fakeLink.download).toBe("sportsdesk-system-logs-unified-2026-11-22.json")
    expect(revoked).toEqual(["blob:json-export-1"])
    expect(createdBlobs[0]?.type).toContain("application/json")
    expect(await createdBlobs[0]?.text()).toBe('{\n  "ok": true\n}\n')
  })

  test("SystemLogBitwiseSearchBar renders Export JSON button with live matched count", () => {
    const store = new BitwiseLogFilterStore("error|warn", 0x0f)
    store.reportStats({
      matchedCount: 2,
      totalCount: 4,
      effectiveMask: LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_WARN,
      elapsedMs: 0.12,
      bitCounts: { error: 1, warn: 1, watch: 0, info: 2 },
    })

    const html = renderToStaticMarkup(
      React.createElement(SystemLogBitwiseSearchBar, {
        store,
        mode: "unified",
        onExportJson: () => 2,
      }),
    )

    expect(html).toContain('data-system-logs-export-json="true"')
    expect(html).toContain("Export JSON (2)")
    expect(html).not.toContain('disabled=""')

    const emptyStore = new BitwiseLogFilterStore("no-such-match", 0x0f)
    emptyStore.reportStats({
      matchedCount: 0,
      totalCount: 4,
      effectiveMask: 0x0f,
      elapsedMs: 0.05,
      bitCounts: { error: 1, warn: 1, watch: 0, info: 2 },
    })

    const disabledHtml = renderToStaticMarkup(
      React.createElement(SystemLogBitwiseSearchBar, {
        store: emptyStore,
        mode: "weblogs",
        onExportJson: () => 0,
      }),
    )

    expect(disabledHtml).toContain('data-system-logs-export-json="true"')
    expect(disabledHtml).toContain("Export JSON (0)")
    expect(disabledHtml).toContain("disabled")
  })
})
