export interface ParsedParlayLeg {
  readonly sport: string
  readonly listedNumber: string | null
  readonly period: string | null
  readonly market: string | null
  readonly selection: string
  readonly priceAmerican: string | null
  readonly pointsBought: string | null
}

export interface ParlayComposition {
  readonly rows: number
  readonly parsedRows: number
  readonly medianLegs: number | null
  readonly twoLegRows: number
  readonly mixedSportRows: number
  readonly partialPeriodRows: number
  readonly missingPeriodRows: number
  readonly pointBuyRows: number
  readonly topMix: { readonly label: string; readonly rows: number } | null
}

export interface ParlayAccountComposition extends ParlayComposition {
  readonly login: string
  readonly customer: string | null
  readonly agent: string | null
}

export type ParlayComparisonSource = "ticker" | "weblog"

export type ParlayComparisonResponse =
  | {
      readonly source: ParlayComparisonSource
      readonly available: false
      readonly sourceDay: string | null
      readonly reason: string
    }
  | {
      readonly source: ParlayComparisonSource
      readonly available: true
      readonly sourceDay: string
      readonly scopeCount: number
      readonly matchingScopeCount: number
      readonly total: ParlayComposition
      readonly accounts: readonly ParlayAccountComposition[]
      readonly excluded: {
        readonly duplicateRows: number
        readonly conflictGroups: number
        readonly sentinelRows: number
        readonly invalidRows: number
      }
      readonly archiveBytes: number | null
    }
