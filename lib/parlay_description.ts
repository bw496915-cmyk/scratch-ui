import type { ParsedParlayLeg } from "@sportsdesk-ops/contracts"

import { parseShortDesc } from "./live_wagers.ts"
import { SPORT_CATEGORIES } from "./sport_taxonomy.ts"

const sports = new Set(
  SPORT_CATEGORIES.filter((sport) => sport !== "Other").map((sport) => sport.toLowerCase()),
)
const quotedPrice = /(?:^|\s)([+-][1-9]\d{2,4})$/
const pointBuy = /\s+-\s+buying\s+([+-]?[\d.½]+)$/i
const fullPeriod = /^(?:Game|Full Game|Match)$/i
const partialPeriod =
  /^(?:\d+(?:st|nd|rd|th)\s+(?:half|quarter|period|inning|\d+\s+innings|set|ot)|last\s+\d+\s+innings)$/i

export function readParlayOperation(operation: string): string | null {
  return /^API LOG\s*\|\s*PARLAY\s*:\s*([\s\S]+)$/i.exec(operation.trim())?.[1] ?? null
}

export function parseParlayLegs(description: string): readonly ParsedParlayLeg[] | null {
  if (description.length > 4096) return null
  const text = description
    .replace(/&(?:amp;)?(?:#189|#xBD|frac12);/gi, "½")
    .replace(/&amp;/gi, "&")
    .replace(/\s+-\s+buying\s+([+-]?[\d.½]+)\s+(For\s+)/gi, " - buying $1 - $2")
  const { legs } = parseShortDesc(text)
  const numberedLegs = (text.match(/#\d+/g) ?? []).length
  if (
    legs.length < 2 ||
    (numberedLegs > 1 && legs.length !== numberedLegs) ||
    legs.some((leg) => {
      const selection = leg.pick || leg.game
      return (
        !sports.has(leg.sport.toLowerCase()) ||
        !/^[\p{L}\p{N} .,'’&/+()½%:!?–#-]{1,160}$/u.test(selection)
      )
    })
  )
    return null

  return legs.map((leg) => {
    const selection = (leg.pick || leg.game).trim()
    const buying = pointBuy.exec(selection)
    const withoutBuy = buying ? selection.slice(0, buying.index) : selection
    const price = quotedPrice.exec(withoutBuy)
    return {
      sport: leg.sport,
      listedNumber: leg.gameNumber,
      period:
        leg.period && (fullPeriod.test(leg.period) || partialPeriod.test(leg.period))
          ? leg.period
          : null,
      market: /^[\p{L}\p{N} ()+.-]{1,80}$/u.test(leg.market) ? leg.market : null,
      selection: (price ? withoutBuy.slice(0, price.index) : withoutBuy).trim(),
      priceAmerican: price?.[1] ?? null,
      pointsBought: buying?.[1] ?? null,
    }
  })
}

export function isPartialParlayPeriod(period: string | null): boolean {
  return period !== null && partialPeriod.test(period)
}
