declare module "bun:bundle" {
  export function feature(name: string): boolean
}

declare module "*.toml" {
  const value: Record<string, any>
  export default value
  export const meta: any
  export const unsafe: any
  export const paths: any
  export const capacity: any
  export const sentinels: any
  export const panels: any
  export const thresholds: any
  export const api: any
  export const table: any
  export const filters: any
  export const clv: any
  export const polling: any
  export const links: any
  export const display: any
  export const provenance: any
  export const wire_contract: any
  export const channels: any
  export const tiers: any
  export const hold_floors: any
  export const freshness: any
  export const leagues: any
  export const alert_tiers: any
  export const bet_type_filters: any
  export const period_filters: any
  export const sport_filters: any
}

declare module "*.md" {
  const content: string
  export default content
}

declare module "*.txt" {
  const content: string
  export default content
}
