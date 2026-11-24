import fs from "fs"
import path from "path"

import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { parseToml } from "./lib/bun_toml.ts"

/**
 * Transform static `.toml` ES module imports into tree-shakeable named + default exports (Bun
 * parity).
 */
function tomlImportPlugin(): Plugin {
  return {
    name: "sportsdesk-toml-import",
    transform(code: string, id: string) {
      const cleanId = id.split("?")[0] ?? id
      if (!cleanId.endsWith(".toml")) return null
      const parsed = parseToml<Record<string, unknown>>(code)
      const lines: string[] = []
      const defaultProps: string[] = []
      for (const [key, value] of Object.entries(parsed)) {
        const serialized = JSON.stringify(value)
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
          lines.push(`export const ${key} = ${serialized};`)
          defaultProps.push(`${JSON.stringify(key)}: ${key}`)
        } else {
          defaultProps.push(`${JSON.stringify(key)}: ${serialized}`)
        }
      }
      lines.push(`export default { ${defaultProps.join(", ")} };`)
      return {
        code: lines.join("\n"),
        map: null,
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const isProd = mode === "production"
  const builtAt = new Date().toISOString()
  return {
    define: {
      __DASHBOARD_BUILD_TARGET__: JSON.stringify(isProd ? "prod" : "dev"),
      __DASHBOARD_BUILD_TIME__: JSON.stringify(builtAt),
      __DASHBOARD_BUILD_COMMIT__: JSON.stringify("node-vite"),
      __DASHBOARD_BUILD_BUN_VERSION__: JSON.stringify(`node-${process.version}`),
      __DASHBOARD_BUILD_BUN_REVISION__: JSON.stringify("vite-8"),
      __DASHBOARD_BUILD_PLATFORM__: JSON.stringify(`${process.platform}/${process.arch}`),
    },
    plugins: [
      tomlImportPlugin(),
      react(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." still resolve in production builds.
      {
        name: "copy-unbundled-src-assets",
        apply: "build",
        closeBundle(error?: Error): void {
          if (error) {
            return
          }
          const distDir = path.resolve(import.meta.dirname, "dist")
          const srcAssets = path.resolve(import.meta.dirname, "src/assets")
          const distAssets = path.resolve(distDir, "src/assets")
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, { recursive: true, force: true })
          }
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: "bun:bundle",
          replacement: path.resolve(import.meta.dirname, "src/shims/bun_bundle.ts"),
        },
        {
          find: "@sportsdesk-ops/contracts/wager-tokens",
          replacement: path.resolve(import.meta.dirname, "packages/contracts/src/wager_tokens.ts"),
        },
        {
          find: "@sportsdesk-ops/contracts/slice-metrics",
          replacement: path.resolve(import.meta.dirname, "packages/contracts/src/slice_metrics.ts"),
        },
        {
          find: "@sportsdesk-ops/contracts/slice-registry",
          replacement: path.resolve(
            import.meta.dirname,
            "packages/contracts/src/slice_registry.ts",
          ),
        },
        {
          find: "@sportsdesk-ops/contracts/slice-data-table",
          replacement: path.resolve(
            import.meta.dirname,
            "packages/contracts/src/slice_data_table.ts",
          ),
        },
        {
          find: "@sportsdesk-ops/contracts/slice-diff-view",
          replacement: path.resolve(
            import.meta.dirname,
            "packages/contracts/src/slice_diff_view.ts",
          ),
        },
        {
          find: "@sportsdesk-ops/contracts/shadow-pricing",
          replacement: path.resolve(
            import.meta.dirname,
            "packages/contracts/src/shadow_pricing.ts",
          ),
        },
        {
          find: "@sportsdesk-ops/contracts/features",
          replacement: path.resolve(import.meta.dirname, "packages/contracts/src/features.ts"),
        },
        {
          find: "@sportsdesk-ops/contracts/dashboard-hydration",
          replacement: path.resolve(
            import.meta.dirname,
            "packages/contracts/src/dashboard_hydration.ts",
          ),
        },
        {
          find: "@sportsdesk-ops/contracts",
          replacement: path.resolve(import.meta.dirname, "packages/contracts/src/index.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/App",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/App.tsx"),
        },
        {
          find: "@sportsdesk-ops/ui/ShadowPricingPanel",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/ShadowPricingPanel.tsx"),
        },
        {
          find: "@sportsdesk-ops/ui/SliceMetricsViews",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/SliceMetricsViews.tsx"),
        },
        {
          find: "@sportsdesk-ops/ui/ansi",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/ansi.tsx"),
        },
        {
          find: "@sportsdesk-ops/ui/config/dashboard",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/config/dashboard.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/config/wagers",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/config/wagers.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/config",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/config/dashboard.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/hydration",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/hydration.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/links",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/links.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/panels",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/panels/index.tsx"),
        },
        {
          find: "@sportsdesk-ops/ui/shadow-pricing",
          replacement: path.resolve(
            import.meta.dirname,
            "packages/ui/src/shadow_pricing/index.tsx",
          ),
        },
        {
          find: "@sportsdesk-ops/ui/runtime-flags",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/runtime_flags.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/terminal-catalog",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/terminal_catalog.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/styles/tokens.css",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/styles/tokens.css"),
        },
        {
          find: "@sportsdesk-ops/ui/styles/reset.css",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/styles/reset.css"),
        },
        {
          find: "@sportsdesk-ops/ui/styles",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/dashboard_styles.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/types",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/types.ts"),
        },
        {
          find: "@sportsdesk-ops/ui/desk.css",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/desk.css"),
        },
        {
          find: "@sportsdesk-ops/ui",
          replacement: path.resolve(import.meta.dirname, "packages/ui/src/index.ts"),
        },
        { find: "@", replacement: path.resolve(import.meta.dirname, ".") },
      ],
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== "true",
      watch: process.env.DISABLE_HMR === "true" ? null : {},
    },
  }
})
