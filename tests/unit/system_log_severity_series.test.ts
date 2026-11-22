import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  buildUnifiedLog24HourSeveritySeries,
  buildWebLog24HourSeveritySeries,
  LOG_SEVERITY_LEVELS,
  normalizeLogSeverityLevel,
  parseSystemLogEntryTimestampMs,
  SYSTEM_LOG_HOUR_MS,
  SYSTEM_LOG_WINDOW_HOURS,
} from "../../packages/ui/src/system_log_severity_series.ts"
import {
  BitwiseLogFilterStore,
  buildBitwiseLogIndex,
  LOG_SEVERITY_BIT_ERROR,
  LOG_SEVERITY_BIT_WARN,
  severityLabelToBit,
} from "../../packages/ui/src/system_log_bitwise_filter.ts"
import type { UnifiedSystemLogRow } from "../../packages/ui/src/system_logs_json_export.ts"
import { SystemLogSeverityBarChart } from "../../packages/ui/src/panels/SystemLogSeverityBarChart.tsx"
import { SystemLogsPanel } from "../../packages/ui/src/panels/HeaderSectionViews.tsx"

describe("system_log_severity_series: normalization & timestamp parsing", () => {
  test("maps all weblog and unified severity tokens onto canonical 4 tiers", () => {
    expect(normalizeLogSeverityLevel("CRITICAL")).toBe("CRITICAL")
    expect(normalizeLogSeverityLevel("crit")).toBe("CRITICAL")
    expect(normalizeLogSeverityLevel("ERROR")).toBe("CRITICAL")
    expect(normalizeLogSeverityLevel("fatal")).toBe("CRITICAL")

    expect(normalizeLogSeverityLevel("HIGH")).toBe("HIGH")
    expect(normalizeLogSeverityLevel("warn")).toBe("HIGH")
    expect(normalizeLogSeverityLevel("WARNING")).toBe("HIGH")

    expect(normalizeLogSeverityLevel("WATCH")).toBe("WATCH")
    expect(normalizeLogSeverityLevel("med")).toBe("WATCH")
    expect(normalizeLogSeverityLevel("MEDIUM")).toBe("WATCH")

    expect(normalizeLogSeverityLevel("NORMAL")).toBe("NORMAL")
    expect(normalizeLogSeverityLevel("INFO")).toBe("NORMAL")
    expect(normalizeLogSeverityLevel("unknown")).toBe("NORMAL")
  })

  test("parses sourceSortMs, ISO timestamps, numeric epoch seconds/ms, sourceTime, and dateLabel fallback", () => {
    expect(parseSystemLogEntryTimestampMs({ sourceSortMs: 1_795_340_000_000 })).toBe(
      1_795_340_000_000,
    )
    expect(parseSystemLogEntryTimestampMs({ timestamp: 1_795_340_123_000 })).toBe(1_795_340_123_000)
    expect(parseSystemLogEntryTimestampMs({ timestamp: "1795340123" })).toBe(1_795_340_123_000)
    expect(parseSystemLogEntryTimestampMs({ timestamp: "2026-11-22T12:15:00.000Z" })).toBe(
      Date.parse("2026-11-22T12:15:00.000Z"),
    )
    expect(parseSystemLogEntryTimestampMs({ sourceTime: "2026-11-22 10:30:00" })).toBe(
      Date.parse("2026-11-22T10:30:00-05:00"),
    )
    expect(
      parseSystemLogEntryTimestampMs({ dateLabel: "Nov 22, 2026", timeEst: "11:45:00 EST" }),
    ).toBeGreaterThan(0)
    expect(parseSystemLogEntryTimestampMs({ timestamp: "" })).toBeNull()
    expect(parseSystemLogEntryTimestampMs({})).toBeNull()
  })
})

describe("system_log_severity_series: 24-hour hourly bucketing", () => {
  const anchorMs = Date.parse("2026-11-22T20:30:00.000Z")

  test("aggregates WebLog entries into 24 hourly buckets and counts outside-window & unparsed rows", () => {
    const entries = [
      { severity: "CRITICAL", sourceSortMs: anchorMs - 15 * 60_000 }, // Current hour (bucket 23)
      { severity: "CRITICAL", sourceSortMs: anchorMs - 5 * 60_000 }, // Current hour (bucket 23)
      { severity: "HIGH", sourceSortMs: anchorMs - 2 * SYSTEM_LOG_HOUR_MS }, // Bucket 21
      { severity: "WATCH", sourceSortMs: anchorMs - 2 * SYSTEM_LOG_HOUR_MS }, // Bucket 21
      { severity: "NORMAL", sourceSortMs: anchorMs - 2 * SYSTEM_LOG_HOUR_MS }, // Bucket 21
      { severity: "NORMAL", sourceSortMs: anchorMs - 2 * SYSTEM_LOG_HOUR_MS }, // Bucket 21 -> peak hour (4 events)
      { severity: "HIGH", sourceSortMs: anchorMs - 23 * SYSTEM_LOG_HOUR_MS }, // Oldest live bucket (bucket 0)
      { severity: "CRITICAL", sourceSortMs: anchorMs - 26 * SYSTEM_LOG_HOUR_MS }, // >24h outside window
      { severity: "WATCH", sourceTime: null, dateLabel: "" }, // Unparsed timestamp
    ]

    const result = buildWebLog24HourSeveritySeries(entries, { anchorMs })
    expect(result.buckets.length).toBe(SYSTEM_LOG_WINDOW_HOURS)
    expect(result.windowMode).toBe("live")
    expect(result.includedLogs).toBe(7)
    expect(result.outsideWindowLogs).toBe(1)
    expect(result.unparsedTimestampLogs).toBe(1)
    expect(result.totals).toEqual({
      CRITICAL: 2,
      HIGH: 2,
      WATCH: 1,
      NORMAL: 2,
      total: 7,
    })

    const bucket0 = result.buckets[0]!
    const bucket21 = result.buckets[21]!
    const bucket23 = result.buckets[23]!
    expect(bucket0.HIGH).toBe(1)
    expect(bucket21).toMatchObject({
      CRITICAL: 0,
      HIGH: 1,
      WATCH: 1,
      NORMAL: 2,
      total: 4,
      relativeLabel: "-2h",
    })
    expect(bucket23).toMatchObject({
      CRITICAL: 2,
      HIGH: 0,
      WATCH: 0,
      NORMAL: 0,
      total: 2,
      relativeLabel: "This hr",
    })
    expect(result.peakHourCount).toBe(4)
    expect(result.peakHourLabel).toBe(bucket21.hourLabel)
  })

  test("anchors to latest capture window when all loaded logs predate the live 24h window", () => {
    const captureTime = Date.parse("2026-10-15T14:20:00.000Z")
    const unifiedRows: readonly UnifiedSystemLogRow[] = [
      {
        id: "u1",
        timestamp: new Date(captureTime).toISOString(),
        level: "ERROR",
        customerId: "BB55103",
        ipCategory: "PROXY_EXIT",
        source: "ALERTS",
        message: "Dead delivery webhook 502",
      },
      {
        id: "u2",
        timestamp: new Date(captureTime - 3 * SYSTEM_LOG_HOUR_MS).toISOString(),
        level: "WARN",
        customerId: "AA10022",
        ipCategory: "DATACENTER",
        source: "R2",
        message: "Sink stale latency",
      },
      {
        id: "u3",
        timestamp: new Date(captureTime - 3 * SYSTEM_LOG_HOUR_MS).toISOString(),
        level: "INFO",
        customerId: "—",
        ipCategory: "DESK_INTERNAL",
        source: "PTY",
        message: "$ status (exit 0)",
      },
    ]

    const result = buildUnifiedLog24HourSeveritySeries(unifiedRows, { anchorMs })
    expect(result.buckets.length).toBe(SYSTEM_LOG_WINDOW_HOURS)
    expect(result.windowMode).toBe("capture")
    expect(result.includedLogs).toBe(3)
    expect(result.outsideWindowLogs).toBe(0)
    expect(result.totals).toEqual({
      CRITICAL: 1,
      HIGH: 1,
      WATCH: 0,
      NORMAL: 1,
      total: 3,
    })
    expect(result.buckets[23]!.CRITICAL).toBe(1)
    expect(result.buckets[20]!.HIGH).toBe(1)
    expect(result.buckets[20]!.NORMAL).toBe(1)
  })

  test("preserves zero totals across 24 buckets when source array is empty", () => {
    const result = buildWebLog24HourSeveritySeries([], { anchorMs })
    expect(result.buckets.length).toBe(24)
    expect(result.windowMode).toBe("live")
    expect(result.includedLogs).toBe(0)
    expect(result.peakHourLabel).toBeNull()
    expect(result.peakHourCount).toBe(0)
    expect(result.totals.total).toBe(0)
  })
})

describe("SystemLogSeverityBarChart & SystemLogsPanel Recharts UI", () => {
  const anchorMs = Date.parse("2026-11-22T20:30:00.000Z")

  const sampleWeblogs = [
    {
      severity: "CRITICAL",
      sourceSortMs: anchorMs - 20 * 60_000,
      text: "BB55103 webhook 502 BOT_BLOCK",
    },
    {
      severity: "HIGH",
      sourceSortMs: anchorMs - 2 * SYSTEM_LOG_HOUR_MS,
      text: "BB55103 RATE_LIMIT warning",
    },
    {
      severity: "WATCH",
      sourceSortMs: anchorMs - 4 * SYSTEM_LOG_HOUR_MS,
      text: "AA10022 LOGIN_TOKEN watch",
    },
    {
      severity: "NORMAL",
      sourceSortMs: anchorMs - 6 * SYSTEM_LOG_HOUR_MS,
      text: "CC99001 heartbeat ok",
    },
  ]

  test("renders Recharts bar chart SVG, 4 severity toggles, and layout controls in populated state", () => {
    const html = renderToStaticMarkup(
      React.createElement(SystemLogSeverityBarChart, {
        mode: "weblogs",
        weblogEntries: sampleWeblogs,
        anchorMs,
      }),
    )

    expect(html).toContain('data-system-logs-severity-chart="true"')
    expect(html).toContain("Log Severity Distribution (Last 24 Hours)")
    expect(html).toContain("4 events (24h)")
    expect(html).toContain("recharts-responsive-container")
    expect(html).toContain("recharts-wrapper")
    expect(html).toContain('data-severity-chart-layout="stacked"')
    expect(html).toContain('data-severity-chart-layout="grouped"')
    for (const sev of LOG_SEVERITY_LEVELS) {
      expect(html).toContain(`data-severity-series-toggle="${sev}"`)
      expect(html).toContain(`<span>${sev}</span><span style="color:#e2e8f0">(1)</span>`)
    }
  })

  test("synchronizes chart buckets and Filtered/All Loaded toggle with BitwiseLogFilterStore", () => {
    const store = new BitwiseLogFilterStore()
    store.setMask(LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_WARN)
    store.setQuery("BB55103")

    const index = buildBitwiseLogIndex(
      sampleWeblogs,
      (row) => severityLabelToBit(row.severity),
      (row) => `${row.severity} ${row.text}`,
    )

    const html = renderToStaticMarkup(
      React.createElement(SystemLogSeverityBarChart, {
        mode: "weblogs",
        weblogEntries: sampleWeblogs,
        weblogBitwiseIndex: index,
        bitwiseStore: store,
        anchorMs,
      }),
    )

    expect(html).toContain("2 events (24h)")
    expect(html).toContain(">Filtered<")
    expect(html).toContain(">All Loaded<")
    expect(html).toContain('<span>CRITICAL</span><span style="color:#e2e8f0">(1)</span>')
    expect(html).toContain('<span>HIGH</span><span style="color:#e2e8f0">(1)</span>')
    expect(html).toContain('<span>WATCH</span><span style="color:#e2e8f0">(0)</span>')
    expect(html).toContain('<span>NORMAL</span><span style="color:#e2e8f0">(0)</span>')
  })

  test("renders loading skeleton while waiting on initial weblogs fetch and empty state when no logs match", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(SystemLogSeverityBarChart, {
        mode: "weblogs",
        weblogEntries: [],
        loading: true,
        anchorMs,
      }),
    )
    expect(loadingHtml).toContain('data-severity-chart-loading="true"')

    const store = new BitwiseLogFilterStore()
    store.setQuery("nonexistent-customer-xyz")
    const index = buildBitwiseLogIndex(
      sampleWeblogs,
      (row) => severityLabelToBit(row.severity),
      (row) => `${row.severity} ${row.text}`,
    )

    const filteredEmptyHtml = renderToStaticMarkup(
      React.createElement(SystemLogSeverityBarChart, {
        mode: "weblogs",
        weblogEntries: sampleWeblogs,
        weblogBitwiseIndex: index,
        bitwiseStore: store,
        anchorMs,
      }),
    )
    expect(filteredEmptyHtml).toContain('data-severity-chart-empty="true"')
    expect(filteredEmptyHtml).toContain("Clear Active Filter")

    const unpopulatedHtml = renderToStaticMarkup(
      React.createElement(SystemLogSeverityBarChart, {
        mode: "weblogs",
        weblogEntries: [],
        unifiedLogs: [
          {
            id: "u1",
            timestamp: new Date(anchorMs - 10_000).toISOString(),
            level: "INFO",
            customerId: "—",
            ipCategory: "DESK_INTERNAL",
            source: "DESK",
            message: "Desk healthy",
          },
        ],
        loading: false,
        onRefreshWeblogs: () => {},
        onSwitchToUnified: () => {},
        anchorMs,
      }),
    )
    expect(unpopulatedHtml).toContain('data-severity-chart-empty="true"')
    expect(unpopulatedHtml).toContain("Refresh Weblogs")
    expect(unpopulatedHtml).toContain("View Unified Stream (1)")
  })

  test("mounts SystemLogSeverityBarChart inside SystemLogsPanel", () => {
    const panelHtml = renderToStaticMarkup(
      React.createElement(SystemLogsPanel, {
        alertRecords: [],
        terminalHistory: [],
        r2PipelineData: null,
        healthData: null,
        wagersProvenance: {
          mode: "live",
          label: "LIVE FEED",
          title: "Live feed active",
          source: "live",
          synthetic: false,
        },
        onNavigateTab: () => {},
      }),
    )

    expect(panelHtml).toContain('aria-label="Client-Side Bitwise Severity Filter"')
    expect(panelHtml).toContain('data-system-logs-severity-chart="true"')
    expect(panelHtml).toContain("Log Severity Distribution (Last 24 Hours)")
  })
})
