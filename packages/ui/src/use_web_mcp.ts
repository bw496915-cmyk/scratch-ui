/**
 * React lifecycle hook that registers Sports Ops Desk WebMCP tools once on mount when
 * `navigator.modelContext` (or `document.modelContext`) is available, keeping live state refs fresh
 * without churning browser registrations.
 *
 * @file Packages/ui/src/use_web_mcp.ts
 */

import { useEffect, useRef, useState } from "react"

import {
  registerSportsDeskWebMcpTools,
  resolveBrowserModelContext,
  type SportsDeskWebMcpActions,
  type SportsDeskWebMcpSnapshot,
} from "./web_mcp.ts"

export interface UseSportsDeskWebMcpResult {
  readonly supported: boolean
  readonly registeredToolNames: readonly string[]
}

export function useSportsDeskWebMcp(
  snapshot: SportsDeskWebMcpSnapshot,
  actions: SportsDeskWebMcpActions,
): UseSportsDeskWebMcpResult {
  const snapshotRef = useRef<SportsDeskWebMcpSnapshot>(snapshot)
  const actionsRef = useRef<SportsDeskWebMcpActions>(actions)

  snapshotRef.current = snapshot
  actionsRef.current = actions

  const [status, setStatus] = useState<UseSportsDeskWebMcpResult>(() => ({
    supported: resolveBrowserModelContext() !== null,
    registeredToolNames: [],
  }))

  useEffect(() => {
    const modelContext = resolveBrowserModelContext()
    if (!modelContext) {
      setStatus({ supported: false, registeredToolNames: [] })
      return
    }

    const handle = registerSportsDeskWebMcpTools(modelContext, () => snapshotRef.current, {
      setActiveTab: (tab) => actionsRef.current.setActiveTab(tab),
      applyWagerFilters: (filters) => actionsRef.current.applyWagerFilters(filters),
      focusCustomer: (customerId) => actionsRef.current.focusCustomer(customerId),
      updateRiskThresholds: (next) => actionsRef.current.updateRiskThresholds(next),
      refreshTelemetry: () => actionsRef.current.refreshTelemetry(),
      fetchApi: (path, init) =>
        actionsRef.current.fetchApi
          ? actionsRef.current.fetchApi(path, init)
          : fetch(path, { credentials: "same-origin", ...init }),
    })

    setStatus({
      supported: handle.supported,
      registeredToolNames: handle.toolNames,
    })

    return () => {
      handle.unregister()
    }
  }, [])

  return status
}
