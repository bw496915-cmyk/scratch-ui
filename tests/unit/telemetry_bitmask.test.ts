import { describe, expect, test } from "bun:test"

import { redactIpToSubnetHash } from "../../lib/http_auth.ts"
import { toLiveWager } from "../../lib/live_wagers.ts"
import { normalizeRawCustomerToProfileRecord } from "../../server/profile_inspect.ts"
import { buildEnrichedWebLogs } from "../../server/weblog_inspect.ts"
import {
  bloomMayOverlap64,
  buildSurveillanceBitmaskIndex,
  CORR_BIT_BLOCK_TO_FILL_RACE,
  CORR_BIT_PROXY_SYNDICATE,
  CORR_BIT_SHARED_ENTITY,
  CORR_BIT_SHARED_GAME_ID,
  CORR_BIT_SHARED_SUBNET_HASH,
  countSetBits,
  encodeProfileSignalMask,
  encodeWagerSignalMask,
  encodeWebLogSignalMask,
  intersectBitsets,
  parseWagerLineAndOdds,
  popcount32,
  PROF_BIT_ORIGINATOR,
  PROF_BIT_SHARP,
  PROF_BIT_SYNDICATE_HIGH,
  WAGER_BIT_FRACTIONAL_OR_ASIAN_LINE,
  WAGER_BIT_LIVE,
  WAGER_BIT_WRITER_GSLIVE,
  WLOG_BIT_BOT_BLOCK,
  WLOG_BIT_DATACENTER,
  WLOG_BIT_VALID_IPV4,
} from "../../src/lib/telemetry_bitmask.ts"

describe("L1: Bitwise Telemetry Parsing & Cross-Feed Correlation Spine", () => {
  test("parseWagerLineAndOdds extracts fractional half-lines, Asian split lines, and American odds", () => {
    expect(parseWagerLineAndOdds("Los Angeles Rams -140")).toEqual({
      line: null,
      oddsAmerican: -140,
      isFractionalOrAsian: false,
    })
    expect(parseWagerLineAndOdds("Houston/Portland O 2½,3 -130")).toEqual({
      line: 2.75,
      oddsAmerican: -130,
      isFractionalOrAsian: true,
    })
    expect(parseWagerLineAndOdds("Warriors -2½ -110")).toEqual({
      line: -2.5,
      oddsAmerican: -110,
      isFractionalOrAsian: true,
    })
  })

  test("encodeWebLogSignalMask packs bot block, IP classification, IPv4, and BotKey bits", () => {
    const { entries } = buildEnrichedWebLogs([
      {
        dateLabel: "November 19, 2026",
        timeEst: "08:21:55 AM",
        ip: "102.128.164.122",
        action: 'API LOG | BLOCK BET | BOT BLOCK LINE ST | #[{"key":"bot_619137349_0_L_U_0","val":"BB55103"}]',
      },
    ])

    const mask = encodeWebLogSignalMask({ ...entries[0]!, rawIp: "102.128.164.122" })
    expect((mask & WLOG_BIT_BOT_BLOCK) !== 0).toBe(true)
    expect((mask & WLOG_BIT_DATACENTER) !== 0).toBe(false)
    const measured = encodeWebLogSignalMask({
      ...entries[0]!,
      ipMeta: { classification: "DATACENTER" },
    })
    expect((measured & WLOG_BIT_DATACENTER) !== 0).toBe(true)
    expect((mask & WLOG_BIT_VALID_IPV4) !== 0).toBe(true)
    // Packed market=Total(2) at bit 12 and side=Under(2) at bit 16
    expect((mask >>> 12) & 3).toBe(2)
    expect((mask >>> 16) & 7).toBe(2)
    expect(popcount32(mask)).toBeGreaterThanOrEqual(4)
  })

  test("buildSurveillanceBitmaskIndex correlates weblogs, wagers, and profiles via bitwise masks & SoA bitsets", () => {
    const { entries } = buildEnrichedWebLogs([
      {
        dateLabel: "November 19, 2026",
        timeEst: "08:21:55 AM",
        ip: "102.128.164.122",
        action: 'API LOG | BLOCK BET | BOT BLOCK LINE ST | #[{"key":"bot_619137349_0_L_U_0","val":"BB55103"}]',
      },
    ])

    const wager = toLiveWager({
      WagerNumber: 9001,
      CustomerID: "BB55103",
      Login: "BB55103",
      WagerType: "S",
      AmountWagered: 2500,
      ToWinAmount: 2272,
      VolumeAmount: 2500,
      TicketWriter: "GSLIVE",
      InsertDateTime: "2026-11-19T08:22:10-05:00",
      VIP: "1",
      ShortDesc: "S.LIVE\r\nBasketball - Lakers vs Suns / Game / Total / Under 228½ -110 #619137349",
    })

    const profile = normalizeRawCustomerToProfileRecord({
      customer_id: "BB55103",
      agent_id: "AG10",
      master_agent: "MA01",
      tier: "TIER_1_ORIGINATOR",
      sharp_score: 8.7,
      syndicate_prob: 0.85,
      lifetime_volume_usd: 320000,
      ip_address: "102.128.164.122",
    })

    expect(profile.ipAddress).toBe(`102.128.164.0/24#${entries[0]!.ipMeta.ipHash}`)
    expect(redactIpToSubnetHash("102.128.164.122").hash).toBe(entries[0]!.ipMeta.ipHash)

    const wMask = encodeWagerSignalMask(wager)
    expect((wMask & WAGER_BIT_LIVE) !== 0).toBe(true)
    expect((wMask & WAGER_BIT_WRITER_GSLIVE) !== 0).toBe(true)
    expect((wMask & WAGER_BIT_FRACTIONAL_OR_ASIAN_LINE) !== 0).toBe(true)

    const pMask = encodeProfileSignalMask(profile)
    expect((pMask & PROF_BIT_SHARP) !== 0).toBe(true)
    expect((pMask & PROF_BIT_ORIGINATOR) !== 0).toBe(true)
    expect((pMask & PROF_BIT_SYNDICATE_HIGH) !== 0).toBe(true)

    const index = buildSurveillanceBitmaskIndex({
      weblogs: entries,
      wagers: [wager],
      profiles: [profile],
      raceWindowSec: 60,
    })

    expect(index.entityIds).toEqual(["BB55103"])
    const corr = index.results[0]!
    expect((corr.correlationMask & CORR_BIT_SHARED_ENTITY) !== 0).toBe(true)
    expect((corr.correlationMask & CORR_BIT_SHARED_GAME_ID) !== 0).toBe(true)
    expect((corr.correlationMask & CORR_BIT_SHARED_SUBNET_HASH) !== 0).toBe(true)
    expect((corr.correlationMask & CORR_BIT_BLOCK_TO_FILL_RACE) !== 0).toBe(true)
    expect((corr.correlationMask & CORR_BIT_PROXY_SYNDICATE) !== 0).toBe(false)
    expect(corr.sharedGames).toEqual(["619137349"])
    expect(corr.minBlockToFillDeltaSec).toBe(15)

    // SoA bitset intersection & Bloom overlap
    const tripleOverlap = intersectBitsets(
      intersectBitsets(index.bitsets.hasWeblogBlock, index.bitsets.hasWagerFill),
      index.bitsets.hasSharpProfile,
    )
    expect(countSetBits(tripleOverlap)).toBe(1)
    expect(
      bloomMayOverlap64(index.gameBloomLo[0]!, index.gameBloomHi[0]!, index.gameBloomLo[0]!, index.gameBloomHi[0]!),
    ).toBe(true)

    const queried = index.queryByMask({
      weblogAll: WLOG_BIT_BOT_BLOCK,
      wagerAll: WAGER_BIT_LIVE | WAGER_BIT_WRITER_GSLIVE,
      profileAll: PROF_BIT_ORIGINATOR,
      correlationAll: CORR_BIT_BLOCK_TO_FILL_RACE | CORR_BIT_SHARED_GAME_ID,
    })
    expect(queried).toHaveLength(1)
    expect(queried[0]?.entityId).toBe("BB55103")
  })
})
