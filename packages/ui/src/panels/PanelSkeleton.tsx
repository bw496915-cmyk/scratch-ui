import type React from "react"
import { styles } from "../dashboard_styles.ts"

export interface SkeletonBlockProps {
  readonly width?: string | number
  readonly height?: string | number
  readonly radius?: string | number
  readonly tone?: "default" | "subtle" | "accent"
  readonly style?: React.CSSProperties
}

export function SkeletonBlock({
  width = "100%",
  height = 14,
  radius = 4,
  tone = "default",
  style,
}: SkeletonBlockProps): React.ReactElement {
  const className =
    tone === "subtle"
      ? "sd-skeleton sd-skeleton--subtle"
      : tone === "accent"
        ? "sd-skeleton sd-skeleton--accent"
        : "sd-skeleton"
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        width,
        height,
        borderRadius: radius,
        flexShrink: 0,
        ...style,
      }}
    />
  )
}

export interface SkeletonKpiStripProps {
  readonly count?: number
  readonly minWidth?: number
}

export function SkeletonKpiStrip({
  count = 4,
  minWidth = 220,
}: SkeletonKpiStripProps): React.ReactElement {
  return (
    <div
      data-skeleton="kpi-strip"
      aria-hidden="true"
      style={{
        ...styles.kpiGrid,
        gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
        marginBottom: 0,
      }}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          style={{
            ...styles.kpiCard,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <SkeletonBlock width={`${56 + (idx % 3) * 12}%`} height={12} />
          <SkeletonBlock width={`${48 + (idx % 2) * 18}%`} height={24} tone="accent" />
          <SkeletonBlock width={`${72 - (idx % 3) * 8}%`} height={11} tone="subtle" />
        </div>
      ))}
    </div>
  )
}

export interface SkeletonTableRowsProps {
  readonly columnWidths: readonly string[]
  readonly rowCount?: number
  readonly rowHeight?: number
  readonly skeletonId?: string
}

/**
 * Geometry-matched <tr> skeleton rows for existing <tbody> slots so column headers
 * stay aligned and layout shift stays <= 2px when hydrated rows arrive.
 */
export function SkeletonTableRows({
  columnWidths,
  rowCount = 6,
  rowHeight = 40,
  skeletonId = "table-rows",
}: SkeletonTableRowsProps): React.ReactElement {
  return (
    <>
      {Array.from({ length: rowCount }).map((_, rowIdx) => (
        <tr
          key={`${skeletonId}-${rowIdx}`}
          data-skeleton={rowIdx === 0 ? skeletonId : undefined}
          aria-hidden="true"
          style={{
            height: `${rowHeight}px`,
            borderBottom: "1px solid #1e293b",
          }}
        >
          {columnWidths.map((width, colIdx) => {
            const jitterPct = ((rowIdx * 17 + colIdx * 11) % 18) - 6
            const parsed = Number.parseFloat(width)
            const finalWidth =
              width.endsWith("%") && Number.isFinite(parsed)
                ? `${Math.max(28, Math.min(96, Math.round(parsed + jitterPct)))}%`
                : width
            return (
              <td
                key={colIdx}
                style={{
                  ...styles.td,
                  verticalAlign: "middle",
                }}
              >
                <SkeletonBlock
                  width={finalWidth}
                  height={colIdx === 0 ? 13 : 12}
                  tone={colIdx === 0 ? "accent" : "default"}
                />
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}

export interface SkeletonTableCardProps {
  readonly titleWidth?: number | string
  readonly subtitleWidth?: number | string
  readonly columnWidths: readonly string[]
  readonly rowCount?: number
  readonly skeletonId?: string
}

export function SkeletonTableCard({
  titleWidth = 240,
  subtitleWidth = 140,
  columnWidths,
  rowCount = 6,
  skeletonId = "table-card",
}: SkeletonTableCardProps): React.ReactElement {
  return (
    <div style={styles.tableCard} data-skeleton={skeletonId} aria-hidden="true">
      <div style={styles.tableHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <SkeletonBlock width={titleWidth} height={15} />
          <SkeletonBlock width={76} height={14} tone="subtle" />
        </div>
        <SkeletonBlock width={subtitleWidth} height={12} tone="subtle" />
      </div>
      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              {columnWidths.map((w, idx) => (
                <th key={idx} style={styles.th}>
                  <SkeletonBlock width={w} height={10} tone="subtle" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <SkeletonTableRows
              columnWidths={columnWidths}
              rowCount={rowCount}
              skeletonId={`${skeletonId}-rows`}
            />
          </tbody>
        </table>
      </div>
    </div>
  )
}

export interface SkeletonChartCardProps {
  readonly height?: number
  readonly skeletonId?: string
}

export function SkeletonChartCard({
  height = 240,
  skeletonId = "chart-card",
}: SkeletonChartCardProps): React.ReactElement {
  return (
    <div
      data-skeleton={skeletonId}
      aria-hidden="true"
      style={{
        backgroundColor: "#0d1527",
        border: "1px solid #1e293b",
        borderRadius: "8px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <SkeletonBlock width={280} height={15} />
          <SkeletonBlock width={200} height={11} tone="subtle" />
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <SkeletonBlock width={86} height={22} tone="subtle" />
          <SkeletonBlock width={96} height={22} tone="subtle" />
        </div>
      </div>
      <div
        style={{
          height: `${height}px`,
          borderRadius: "6px",
          border: "1px solid rgba(30, 41, 59, 0.9)",
          backgroundColor: "rgba(9, 14, 27, 0.72)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          boxSizing: "border-box",
        }}
      >
        {[0, 1, 2, 3].map((lineIdx) => (
          <div
            key={lineIdx}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <SkeletonBlock width={38} height={10} tone="subtle" />
            <SkeletonBlock
              width="100%"
              height={lineIdx === 1 ? 3 : 1}
              tone={lineIdx === 1 ? "accent" : "subtle"}
            />
          </div>
        ))}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            paddingLeft: "50px",
          }}
        >
          {[0, 1, 2, 3, 4, 5].map((tick) => (
            <SkeletonBlock key={tick} width={34} height={10} tone="subtle" />
          ))}
        </div>
      </div>
    </div>
  )
}

export interface SkeletonSplitWorkspaceProps {
  readonly statusMessage: string
  readonly endpointLabel?: string
  readonly rowCount?: number
  readonly skeletonId?: string
}

export function SkeletonSplitWorkspace({
  statusMessage,
  endpointLabel = "GET /api/customers",
  rowCount = 6,
  skeletonId = "split-workspace",
}: SkeletonSplitWorkspaceProps): React.ReactElement {
  const tableColumns = ["78%", "70%", "64%", "58%", "72%", "56%"] as const
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={statusMessage}
      data-profiles-source="pending"
      data-skeleton={skeletonId}
      style={styles.showcaseGrid}
    >
      {/* Left Column: Customer Profiles Table Skeleton */}
      <div style={styles.tablePanel}>
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid #1e293b",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 700,
                color: "#f8fafc",
                marginBottom: "3px",
              }}
            >
              {statusMessage}
            </div>
            <div style={{ fontSize: "11px", color: "#94a3b8" }}>
              Hydrating bettor profiles, risk directives, and downline tags…
            </div>
          </div>
          <code
            style={{
              fontSize: "11px",
              color: "#7dd3fc",
              whiteSpace: "nowrap",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            {endpointLabel}
          </code>
        </div>
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                {tableColumns.map((w, idx) => (
                  <th key={idx} style={styles.th}>
                    <SkeletonBlock width={w} height={10} tone="subtle" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SkeletonTableRows
                columnWidths={tableColumns}
                rowCount={rowCount}
                rowHeight={42}
                skeletonId={`${skeletonId}-rows`}
              />
            </tbody>
          </table>
        </div>
      </div>

      {/* Right Column: Sticky Inspector Detail Skeleton */}
      <div className="detail-panel" style={styles.detailCard} aria-hidden="true">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "12px",
            marginBottom: "14px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
            <SkeletonBlock width="58%" height={18} tone="accent" />
            <SkeletonBlock width="76%" height={12} tone="subtle" />
          </div>
          <SkeletonBlock width={72} height={24} />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "10px",
            marginBottom: "16px",
          }}
        >
          {[0, 1, 2, 3].map((box) => (
            <div
              key={box}
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                backgroundColor: "rgba(15, 23, 42, 0.72)",
                border: "1px solid #1e293b",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <SkeletonBlock width="54%" height={10} tone="subtle" />
              <SkeletonBlock width="70%" height={16} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <SkeletonBlock width="42%" height={12} tone="subtle" />
          <SkeletonBlock width="100%" height={12} />
          <SkeletonBlock width="92%" height={12} />
          <SkeletonBlock width="84%" height={12} tone="subtle" />
        </div>
      </div>
    </div>
  )
}

export interface SkeletonCardGridProps {
  readonly count?: number
  readonly minColWidth?: number
  readonly skeletonId?: string
}

export function SkeletonCardGrid({
  count = 4,
  minColWidth = 380,
  skeletonId = "card-grid",
}: SkeletonCardGridProps): React.ReactElement {
  return (
    <div
      data-skeleton={skeletonId}
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${minColWidth}px, 1fr))`,
        gap: "16px",
      }}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          style={{
            ...styles.tableCard,
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
              <SkeletonBlock width="56%" height={15} />
              <SkeletonBlock width="80%" height={11} tone="subtle" />
            </div>
            <SkeletonBlock width={78} height={20} tone="accent" />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: "8px",
              padding: "8px 10px",
              borderRadius: "6px",
              backgroundColor: "rgba(15, 23, 42, 0.7)",
            }}
          >
            {[0, 1, 2].map((col) => (
              <div key={col} style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                <SkeletonBlock width="72%" height={10} tone="subtle" />
                <SkeletonBlock width="56%" height={13} />
              </div>
            ))}
          </div>
          <SkeletonBlock width="100%" height={48} tone="subtle" radius={6} />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "8px",
            }}
          >
            {[0, 1].map((m) => (
              <div
                key={m}
                style={{
                  padding: "6px 8px",
                  borderRadius: "5px",
                  backgroundColor: "rgba(30, 41, 59, 0.55)",
                  border: "1px solid rgba(51, 65, 85, 0.7)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "5px",
                }}
              >
                <SkeletonBlock width="58%" height={10} tone="subtle" />
                <SkeletonBlock width="74%" height={12} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function SkeletonFilterBar({
  pillCount = 5,
}: {
  readonly pillCount?: number
}): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-skeleton="filter-bar"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        alignItems: "center",
        padding: "12px",
        borderRadius: "8px",
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        border: "1px solid #1e293b",
      }}
    >
      <SkeletonBlock width={280} height={36} radius={6} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {Array.from({ length: pillCount }).map((_, idx) => (
          <SkeletonBlock
            key={idx}
            width={74 + (idx % 3) * 14}
            height={28}
            radius={6}
            tone="subtle"
          />
        ))}
      </div>
    </div>
  )
}

export function SkeletonSurveillanceBrief(): React.ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading surveillance brief"
      data-skeleton="surveillance-brief"
      style={{
        backgroundColor: "#0d1527",
        borderRadius: "8px",
        border: "1px solid #1e293b",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "10px 16px",
          backgroundColor: "rgba(4, 7, 14, 0.55)",
          borderBottom: "1px solid #1e293b",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <SkeletonBlock width={170} height={15} />
          <SkeletonBlock width={94} height={14} tone="accent" />
          <SkeletonBlock width={86} height={14} tone="subtle" />
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <SkeletonBlock width={84} height={24} tone="subtle" />
          <SkeletonBlock width={88} height={24} tone="subtle" />
        </div>
      </div>
      <div
        style={{
          padding: "18px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        <SkeletonBlock width="42%" height={20} tone="accent" />
        <SkeletonBlock width="94%" height={13} />
        <SkeletonBlock width="86%" height={13} tone="subtle" />
        <div
          style={{
            marginTop: "6px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "12px",
          }}
        >
          {[0, 1, 2].map((c) => (
            <div
              key={c}
              style={{
                padding: "12px",
                borderRadius: "6px",
                backgroundColor: "rgba(15, 23, 42, 0.72)",
                border: "1px solid #1e293b",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <SkeletonBlock width="58%" height={11} tone="subtle" />
              <SkeletonBlock width="72%" height={18} />
              <SkeletonBlock width="88%" height={11} tone="subtle" />
            </div>
          ))}
        </div>
        <SkeletonBlock width="34%" height={17} style={{ marginTop: "6px" }} />
        {[0, 1, 2, 3].map((row) => (
          <SkeletonBlock
            key={row}
            width={`${92 - row * 7}%`}
            height={12}
            tone={row % 2 === 0 ? "default" : "subtle"}
          />
        ))}
      </div>
    </div>
  )
}

export interface DashboardAuthShellSkeletonProps {
  readonly activeTab?: string
}

/**
 * Full-workspace skeletal frame displayed while operator session authentication
 * completes (`!authReady`), eliminating the bare placeholder screen and giving
 * immediate structural presence tailored to the selected tab.
 */
export function DashboardAuthShellSkeleton({
  activeTab = "customers",
}: DashboardAuthShellSkeletonProps): React.ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Authenticating operator session and preparing dashboard panels"
      data-skeleton="auth-shell"
      data-skeleton-tab={activeTab}
      style={{ display: "flex", flexDirection: "column", gap: "18px" }}
    >
      {/* Slim authentication hydration notice */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "10px 14px",
          borderRadius: "8px",
          backgroundColor: "rgba(15, 23, 42, 0.78)",
          border: "1px solid #1e293b",
          fontSize: "12px",
          color: "#94a3b8",
        }}
      >
        <span>Awaiting operator session authentication to hydrate live feeds…</span>
        <span
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: "11px",
            color: "#38bdf8",
          }}
        >
          hydrating: {activeTab}
        </span>
      </div>

      {activeTab === "surveillance" ? (
        <>
          <SkeletonKpiStrip count={4} />
          <SkeletonSurveillanceBrief />
        </>
      ) : activeTab === "r2" ? (
        <>
          <SkeletonCardGrid count={4} skeletonId="auth-r2-grid" />
        </>
      ) : activeTab === "wagers" ? (
        <>
          <SkeletonKpiStrip count={4} />
          <SkeletonChartCard height={220} skeletonId="auth-wagers-chart" />
          <SkeletonFilterBar pillCount={6} />
          <SkeletonTableCard
            columnWidths={["12%", "10%", "12%", "8%", "18%", "16%", "10%", "14%"]}
            rowCount={6}
            skeletonId="auth-wagers-table"
          />
        </>
      ) : activeTab === "bet-ticker" ? (
        <>
          <SkeletonKpiStrip count={4} />
          <div className="sd-split-grid">
            <SkeletonTableCard
              columnWidths={["38%", "18%", "22%", "22%"]}
              rowCount={4}
              skeletonId="auth-demux-left"
            />
            <SkeletonTableCard
              columnWidths={["34%", "18%", "24%", "24%"]}
              rowCount={4}
              skeletonId="auth-demux-right"
            />
          </div>
          <SkeletonTableCard
            columnWidths={["12%", "12%", "10%", "14%", "22%", "14%", "16%"]}
            rowCount={6}
            skeletonId="auth-bet-ticker-table"
          />
        </>
      ) : activeTab === "rankings" ? (
        <>
          <SkeletonKpiStrip count={4} />
          <SkeletonFilterBar pillCount={4} />
          <SkeletonTableCard
            columnWidths={["8%", "16%", "18%", "12%", "10%", "10%", "12%", "14%"]}
            rowCount={6}
            skeletonId="auth-rankings-table"
          />
        </>
      ) : (
        <>
          <SkeletonKpiStrip count={4} />
          <SkeletonFilterBar pillCount={6} />
          <SkeletonSplitWorkspace
            statusMessage="Preparing Customer Cohorts & Live Inspector…"
            endpointLabel="session handshake"
            rowCount={6}
            skeletonId="auth-customers-workspace"
          />
        </>
      )}
    </div>
  )
}
