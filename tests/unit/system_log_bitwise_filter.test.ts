import { describe, expect, test } from "bun:test"
import {
  BitwiseLogFilterStore,
  buildBitwiseLogIndex,
  evaluateBitwiseLogIndex,
  formatBitmaskBinary,
  formatBitmaskHex,
  LOG_SEVERITY_BIT_ERROR,
  LOG_SEVERITY_BIT_INFO,
  LOG_SEVERITY_BIT_WARN,
  LOG_SEVERITY_BIT_WATCH,
  LOG_SEVERITY_MASK_ALL,
  parseBitwiseSeverityQuery,
  severityLabelToBit,
  toggleSeverityBit,
} from "../../packages/ui/src/system_log_bitwise_filter.ts"

describe("system_log_bitwise_filter: flag bitmask helpers", () => {
  test("maps weblog and unified severity labels onto canonical 4-bit flags", () => {
    expect(severityLabelToBit("CRITICAL")).toBe(LOG_SEVERITY_BIT_ERROR)
    expect(severityLabelToBit("ERROR")).toBe(LOG_SEVERITY_BIT_ERROR)
    expect(severityLabelToBit("HIGH")).toBe(LOG_SEVERITY_BIT_WARN)
    expect(severityLabelToBit("WARN")).toBe(LOG_SEVERITY_BIT_WARN)
    expect(severityLabelToBit("WATCH")).toBe(LOG_SEVERITY_BIT_WATCH)
    expect(severityLabelToBit("NORMAL")).toBe(LOG_SEVERITY_BIT_INFO)
    expect(severityLabelToBit("INFO")).toBe(LOG_SEVERITY_BIT_INFO)
  })

  test("toggles severity bits via XOR and formats hex/binary masks", () => {
    const withoutInfo = toggleSeverityBit(LOG_SEVERITY_MASK_ALL, LOG_SEVERITY_BIT_INFO)
    expect(withoutInfo).toBe(0x0e)
    expect(formatBitmaskHex(withoutInfo)).toBe("0x0E")
    expect(formatBitmaskBinary(withoutInfo)).toBe("0b1110")

    const restored = toggleSeverityBit(withoutInfo, LOG_SEVERITY_BIT_INFO)
    expect(restored).toBe(LOG_SEVERITY_MASK_ALL)
  })
})

describe("system_log_bitwise_filter: query parser", () => {
  test("parses compound bitwise OR expressions, hex/binary masks, negations, and text terms", () => {
    const q1 = parseBitwiseSeverityQuery("crit|high BB55103")
    expect(q1.effectiveMask).toBe(LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_WARN)
    expect(q1.textTerms).toEqual(["bb55103"])
    expect(q1.hasExplicitBitFilter).toBe(true)

    const q2 = parseBitwiseSeverityQuery("-info !watch 104.28")
    expect(q2.effectiveMask).toBe(LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_WARN)
    expect(q2.textTerms).toEqual(["104.28"])

    const q3 = parseBitwiseSeverityQuery("mask:0x0c")
    expect(q3.effectiveMask).toBe(0x0c)
    expect(q3.textTerms).toEqual([])

    const q4 = parseBitwiseSeverityQuery("flag:0b1001 bot_619")
    expect(q4.effectiveMask).toBe(LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_INFO)
    expect(q4.textTerms).toEqual(["bot_619"])

    const q5 = parseBitwiseSeverityQuery("sev:error,warn")
    expect(q5.effectiveMask).toBe(LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_WARN)
  })

  test("intersects explicit query flags with pre-toggled button bitmask", () => {
    const onlyErrorAndInfo = LOG_SEVERITY_BIT_ERROR | LOG_SEVERITY_BIT_INFO
    const parsed = parseBitwiseSeverityQuery("crit|warn", onlyErrorAndInfo)
    expect(parsed.effectiveMask).toBe(LOG_SEVERITY_BIT_ERROR)
  })
})

describe("system_log_bitwise_filter: SoA index & rapid evaluation", () => {
  interface MockLog {
    readonly id: string
    readonly severity: string
    readonly text: string
  }

  const sampleRows: readonly MockLog[] = [
    { id: "1", severity: "CRITICAL", text: "BB55103 198.51.100.42 BOT_BLOCK" },
    { id: "2", severity: "HIGH", text: "BB55103 203.0.113.10 RATE_LIMIT" },
    { id: "3", severity: "WATCH", text: "AA10022 192.0.2.5 LOGIN_TOKEN" },
    { id: "4", severity: "NORMAL", text: "CC99001 10.0.0.4 LOGIN_SUCCESS" },
    { id: "5", severity: "ERROR", text: "Sink r2-wagers dead delivery" },
  ]

  test("filters contiguous Uint8Array severity flags and reuses caller bitmap", () => {
    const index = buildBitwiseLogIndex(
      sampleRows,
      (row) => severityLabelToBit(row.severity),
      (row) => `${row.severity} ${row.text}`,
    )

    expect(index.bitCounts).toEqual({ error: 2, warn: 1, watch: 1, info: 1 })

    const reusableBitmap = new Uint8Array(index.length)
    const res1 = evaluateBitwiseLogIndex(
      index,
      parseBitwiseSeverityQuery("crit|high BB55103"),
      reusableBitmap,
    )
    expect(res1.visible).toBe(reusableBitmap)
    expect(res1.matchedCount).toBe(2)
    expect(Array.from(res1.visible)).toEqual([1, 1, 0, 0, 0])

    const res2 = evaluateBitwiseLogIndex(
      index,
      parseBitwiseSeverityQuery("-info -watch"),
      reusableBitmap,
    )
    expect(res2.matchedCount).toBe(3)
    expect(Array.from(res2.visible)).toEqual([1, 1, 0, 0, 1])

    const resZero = evaluateBitwiseLogIndex(
      index,
      parseBitwiseSeverityQuery("mask:0x00"),
      reusableBitmap,
    )
    expect(resZero.matchedCount).toBe(0)
    expect(Array.from(resZero.visible)).toEqual([0, 0, 0, 0, 0])
  })

  test("BitwiseLogFilterStore notifies subscribers cleanly and resets to 0x0F", () => {
    const store = new BitwiseLogFilterStore()
    let filterNotifications = 0
    let statsNotifications = 0

    const unsubFilter = store.subscribeFilter(() => {
      filterNotifications += 1
    })
    const unsubStats = store.subscribeStats(() => {
      statsNotifications += 1
    })

    store.toggleBit(LOG_SEVERITY_BIT_INFO)
    expect(store.getSnapshot().toggledMask).toBe(0x0e)
    expect(filterNotifications).toBe(1)

    store.setQuery("crit|warn bb55103")
    expect(store.getSnapshot().parsed.effectiveMask).toBe(0x0c)
    expect(filterNotifications).toBe(2)

    store.reportStats({
      matchedCount: 2,
      totalCount: 5,
      effectiveMask: 0x0c,
      elapsedMs: 0.03,
      bitCounts: { error: 2, warn: 1, watch: 1, info: 1 },
    })
    expect(statsNotifications).toBe(1)
    expect(store.getStats().matchedCount).toBe(2)

    store.reset()
    expect(store.getSnapshot().rawQuery).toBe("")
    expect(store.getSnapshot().toggledMask).toBe(LOG_SEVERITY_MASK_ALL)
    expect(filterNotifications).toBe(3)

    unsubFilter()
    unsubStats()
  })
})
