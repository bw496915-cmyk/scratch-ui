/**
 * Stat-cached Markdown -> HTML renderer for repo-owned `dashboard.md`. Uses native
 * `Bun.markdown.html()` + `Bun.nanoseconds()` when running under Bun, falling back to `marked` +
 * `process.hrtime.bigint()` under Node.js.
 *
 * @file Packages/backend/src/markdown.ts
 */

import { readFile } from "node:fs/promises"

import { marked } from "marked"

import { countNonAsciiChars } from "../../contracts/src/index.ts"
import { statStamp } from "./cache.ts"

export const DASHBOARD_MARKDOWN_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  tagFilter: true,
  noHtmlBlocks: true,
  noHtmlSpans: true,
  headings: { autolink: true, ids: true },
  collapseWhitespace: true,
} as const

interface BunMarkdownRuntime {
  readonly nanoseconds?: () => number
  readonly markdown?: {
    readonly html?: (input: string, options?: typeof DASHBOARD_MARKDOWN_OPTIONS) => string
  }
}

function getBunRuntime(): BunMarkdownRuntime | null {
  const candidate = (globalThis as { readonly Bun?: BunMarkdownRuntime }).Bun
  return candidate && typeof candidate === "object" ? candidate : null
}

function renderMarkdownToHtml(markdown: string): string {
  const bunMarkdown = getBunRuntime()?.markdown
  if (typeof bunMarkdown?.html === "function") {
    return bunMarkdown.html(markdown, DASHBOARD_MARKDOWN_OPTIONS)
  }
  return marked.parse(markdown, {
    gfm: true,
    breaks: false,
  }) as string
}

export interface RenderedDashboardMarkdown {
  readonly stamp: string
  readonly markdown: string
  readonly html: string
  readonly renderDurationMs: number
  readonly markdownBytes: number
  readonly htmlBytes: number
  readonly nonAsciiChars: number
}

/** Caches parsed `dashboard.md` + rendered HTML output keyed by mtime+size stamp. */
export class DashboardMarkdownCache {
  private readonly markdownPath: string
  private cached: RenderedDashboardMarkdown | null = null

  constructor(markdownPath: string) {
    this.markdownPath = markdownPath
  }

  async load(): Promise<RenderedDashboardMarkdown | null> {
    const stamp = await statStamp(this.markdownPath)
    if (stamp === null) {
      this.cached = null
      return null
    }
    if (this.cached === null || this.cached.stamp !== stamp) {
      const markdown = await readFile(this.markdownPath, "utf8")
      const bunNs = getBunRuntime()?.nanoseconds
      const startedNs = typeof bunNs === "function" ? bunNs() : Number(process.hrtime.bigint())
      const html = renderMarkdownToHtml(markdown)
      const finishedNs = typeof bunNs === "function" ? bunNs() : Number(process.hrtime.bigint())
      const elapsedNs = Math.max(0, finishedNs - startedNs)
      const renderDurationMs = Math.round((elapsedNs / 1_000_000) * 1000) / 1000
      this.cached = {
        stamp,
        markdown,
        html,
        renderDurationMs,
        markdownBytes: Buffer.byteLength(markdown, "utf8"),
        htmlBytes: Buffer.byteLength(html, "utf8"),
        nonAsciiChars: countNonAsciiChars(markdown),
      }
    }
    return this.cached
  }

  invalidate(): void {
    this.cached = null
  }
}
