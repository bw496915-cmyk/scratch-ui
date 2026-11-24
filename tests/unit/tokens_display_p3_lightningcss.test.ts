/**
 * Uses LightningCSS's native AST (`visitor.StyleSheet`) and Bun's `HTMLRewriter` to verify:
 *
 * 1. Wide-gamut `@supports` Display P3 chromatic overrides in `packages/ui/src/styles/tokens.css` survive unminified,
 *    minified, and legacy-target transforms.
 * 2. `.sd-badge--*` rules in `desk.css` and `.sd-pill-*` rules in `dashboard.css` consume the chromatic tokens with zero
 *    hardcoded color literals.
 * 3. Stack-accumulated 3-valued `@supports` polarity (`not`/`and`/`or`, nested contradictions, and arbitrary
 *    color-accepting Display P3 probes).
 * 4. `light-dark()` & juxtaposed two-token AST integrity across single-color longhands, `--color-*` custom properties,
 *    shorthands, `color-scheme` co-presence, and inline `<style>` blocks extracted from standalone HTML templates via
 *    `HTMLRewriter`.
 *
 * @file Tests/unit/tokens_display_p3_lightningcss.test.ts
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  type Declaration,
  type Rule,
  type Selector,
  type StyleRule,
  type SupportsCondition,
  type TokenOrValue,
  transform,
} from "lightningcss"

const WORKSPACE_ROOT = resolve(import.meta.dir, "../..")
const TOKENS_CSS_PATH = resolve(WORKSPACE_ROOT, "packages/ui/src/styles/tokens.css")
const DESK_CSS_PATH = resolve(WORKSPACE_ROOT, "packages/ui/src/desk.css")
const DASHBOARD_CSS_PATH = resolve(WORKSPACE_ROOT, "src/dashboard/dashboard.css")

const STANDALONE_HTML_TEMPLATES = [
  "static/telegram-miniapp-dashboard.html",
  "static/live-bets.html",
  "static/customer-churn-simulation-dashboard.html",
  "static/status.html",
  "docs/graph.html",
] as const

const CHROMATIC_TOKENS = ["--color-red", "--color-amber", "--color-green", "--color-blue", "--color-violet"] as const

const FORBIDDEN_LIGHT_DARK_POLYFILL_VARS = new Set([
  "--lightningcss-light",
  "--lightningcss-dark",
  "--buncss-light",
  "--buncss-dark",
])

/** All CSS longhands that accept a single `<color>` value (must never hold juxtaposed 2-token rewrites). */
const SINGLE_COLOR_LONGHAND_PROPS = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-block-start-color",
  "border-block-end-color",
  "border-inline-start-color",
  "border-inline-end-color",
  "outline-color",
  "fill",
  "stroke",
  "caret-color",
  "accent-color",
  "text-decoration-color",
])

/** All color-accepting properties valid inside a `@supports (<prop>: color(display-p3 ...))` probe. */
const COLOR_ACCEPTING_PROBE_PROPS = new Set([
  ...SINGLE_COLOR_LONGHAND_PROPS,
  "background",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "outline",
  "box-shadow",
  "text-shadow",
])

/** Matches any valid CSS Color 4 `color(display-p3 <r> <g> <b> [/ <alpha>])` probe value. */
const DISPLAY_P3_COLOR_PROBE_RE =
  /^color\(\s*display-p3\s+(?:none|[+-]?(?:\d+\.?\d*|\.\d+)%?)\s+(?:none|[+-]?(?:\d+\.?\d*|\.\d+)%?)\s+(?:none|[+-]?(?:\d+\.?\d*|\.\d+)%?)(?:\s*\/\s*(?:none|[+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/i

type DisplayP3SupportsPolarity = "requires-p3" | "forbids-p3" | "unrelated"

interface WalkContext {
  readonly p3SupportsPolarity: DisplayP3SupportsPolarity
  readonly layers: readonly string[]
  readonly scopes: number
}

interface VisitedStyleRule {
  readonly rule: StyleRule
  readonly ctx: WalkContext
}

interface LightDarkAstViolation {
  readonly kind: "polyfill-var" | "juxtaposed-color-tokens" | "missing-color-scheme"
  readonly property: string
  readonly detail: string
}

/** Exact 3-valued negation: `requires-p3 <-> forbids-p3`, `unrelated -> unrelated`. */
function notPolarity(p: DisplayP3SupportsPolarity): DisplayP3SupportsPolarity {
  if (p === "requires-p3") return "forbids-p3"
  if (p === "forbids-p3") return "requires-p3"
  return "unrelated"
}

/** Exact 3-valued conjunction: `forbids-p3` dominates (contradiction), else `requires-p3`, else `unrelated`. */
function andPolarity(a: DisplayP3SupportsPolarity, b: DisplayP3SupportsPolarity): DisplayP3SupportsPolarity {
  if (a === "forbids-p3" || b === "forbids-p3") return "forbids-p3"
  if (a === "requires-p3" || b === "requires-p3") return "requires-p3"
  return "unrelated"
}

/** Exact 3-valued disjunction: `requires-p3` iff both require; `forbids-p3` iff both forbid; else `unrelated`. */
function orPolarity(a: DisplayP3SupportsPolarity, b: DisplayP3SupportsPolarity): DisplayP3SupportsPolarity {
  if (a === "requires-p3" && b === "requires-p3") return "requires-p3"
  if (a === "forbids-p3" && b === "forbids-p3") return "forbids-p3"
  return "unrelated"
}

function isDisplayP3ProbeDeclaration(property: string, rawValue: string): boolean {
  if (!COLOR_ACCEPTING_PROBE_PROPS.has(property.toLowerCase())) return false
  return DISPLAY_P3_COLOR_PROBE_RE.test(rawValue.trim())
}

/** Evaluates a LightningCSS `@supports` condition AST via the 3-valued truth table. */
function evaluateDisplayP3SupportsCondition(cond: SupportsCondition): DisplayP3SupportsPolarity {
  switch (cond.type) {
    case "declaration":
      return isDisplayP3ProbeDeclaration(cond.propertyId.property, cond.value) ? "requires-p3" : "unrelated"
    case "parens":
      return evaluateDisplayP3SupportsCondition(cond.value)
    case "not":
      return notPolarity(evaluateDisplayP3SupportsCondition(cond.value))
    case "and":
      return cond.value.reduce<DisplayP3SupportsPolarity>(
        (acc, branch) => andPolarity(acc, evaluateDisplayP3SupportsCondition(branch)),
        "unrelated",
      )
    case "or": {
      if (cond.value.length === 0) return "unrelated"
      const [first, ...rest] = cond.value
      return rest.reduce<DisplayP3SupportsPolarity>(
        (acc, branch) => orPolarity(acc, evaluateDisplayP3SupportsCondition(branch)),
        evaluateDisplayP3SupportsCondition(first!),
      )
    }
    default:
      return "unrelated"
  }
}

function walkRules(rules: readonly Rule[], ctx: WalkContext, out: VisitedStyleRule[]): void {
  for (const rule of rules) {
    switch (rule.type) {
      case "style":
        out.push({ rule: rule.value, ctx })
        if (rule.value.rules && rule.value.rules.length > 0) {
          walkRules(rule.value.rules, ctx, out)
        }
        break
      case "supports": {
        const branchPolarity = evaluateDisplayP3SupportsCondition(rule.value.condition)
        // Stack-accumulate nested `@supports` with 3-valued AND so outer/inner contradictions resolve to `forbids-p3`.
        const nextPolarity = andPolarity(ctx.p3SupportsPolarity, branchPolarity)
        walkRules(rule.value.rules, { ...ctx, p3SupportsPolarity: nextPolarity }, out)
        break
      }
      case "layer-block": {
        const layerName = rule.value.name ? rule.value.name.join(".") : "<anonymous>"
        walkRules(rule.value.rules, { ...ctx, layers: [...ctx.layers, layerName] }, out)
        break
      }
      case "scope":
        walkRules(rule.value.rules, { ...ctx, scopes: ctx.scopes + 1 }, out)
        break
      case "media":
      case "container":
      case "starting-style":
        walkRules(rule.value.rules, ctx, out)
        break
      default:
        break
    }
  }
}

/** Parses CSS via LightningCSS's AST visitor and collects all style rules with enclosing at-rule context. */
function collectStyleRulesFromAst(filename: string, code: Uint8Array): VisitedStyleRule[] {
  const collected: VisitedStyleRule[] = []
  transform({
    filename,
    code,
    visitor: {
      StyleSheet(sheet) {
        walkRules(sheet.rules, { p3SupportsPolarity: "unrelated", layers: [], scopes: 0 }, collected)
      },
    },
  })
  return collected
}

/** Extracts inline `<style>` block bodies from HTML via Bun's streaming `HTMLRewriter`. */
function extractInlineStylesFromHtml(html: string): string[] {
  const blocks: string[] = []
  let current = ""

  new HTMLRewriter()
    .on("style", {
      element() {
        current = ""
      },
      text(chunk) {
        current += chunk.text
        if (chunk.lastInTextNode) {
          const trimmed = current.trim()
          if (trimmed.length > 0) {
            blocks.push(trimmed)
          }
          current = ""
        }
      },
    })
    .transform(html)

  return blocks
}

function isRootSelector(selector: Selector): boolean {
  return selector.length === 1 && selector[0]?.type === "pseudo-class" && selector[0].kind === "root"
}

function hasLightThemeAttribute(selector: Selector): boolean {
  return selector.some(
    (c) =>
      c.type === "attribute" &&
      c.name === "data-dashboard-theme" &&
      c.operation?.operator === "equal" &&
      c.operation.value === "light",
  )
}

function isExactLightThemeSelector(selector: Selector): boolean {
  return selector.length === 1 && hasLightThemeAttribute(selector)
}

function hasClassSelector(selector: Selector, className: string): boolean {
  return selector.some((c) => c.type === "class" && c.name === className)
}

function getAllDeclarations(rule: StyleRule): readonly Declaration[] {
  return [...(rule.declarations.declarations ?? []), ...(rule.declarations.importantDeclarations ?? [])]
}

/** Walks LightningCSS TokenOrValue trees (including `unresolved-color` / `light-dark`) to collect vars & literal colors. */
function inspectTokenTree(tokens: readonly TokenOrValue[], vars: Set<string>, hardcodedColors: string[]): void {
  for (const node of tokens) {
    switch (node.type) {
      case "var":
        vars.add(node.value.name.ident)
        if (node.value.fallback) {
          inspectTokenTree(node.value.fallback, vars, hardcodedColors)
        }
        break
      case "function":
        inspectTokenTree(node.value.arguments, vars, hardcodedColors)
        break
      case "unresolved-color":
        if (node.value.type === "light-dark") {
          inspectTokenTree(node.value.light, vars, hardcodedColors)
          inspectTokenTree(node.value.dark, vars, hardcodedColors)
        } else {
          inspectTokenTree(node.value.alpha, vars, hardcodedColors)
        }
        break
      case "color":
        hardcodedColors.push(node.value.type)
        break
      case "token":
        if (node.value.type === "hash" || node.value.type === "id-hash") {
          hardcodedColors.push(`#${node.value.value}`)
        }
        break
      default:
        break
    }
  }
}

function inspectStyleRuleColors(rule: StyleRule): {
  readonly vars: ReadonlySet<string>
  readonly hardcodedColors: readonly string[]
} {
  const vars = new Set<string>()
  const hardcodedColors: string[] = []
  const colorProps = new Set(["color", "background-color", "border-color", "box-shadow"])

  for (const decl of getAllDeclarations(rule)) {
    if (decl.property === "unparsed") {
      inspectTokenTree(decl.value.value, vars, hardcodedColors)
    } else if (decl.property === "custom") {
      inspectTokenTree(decl.value.value, vars, hardcodedColors)
    } else if (colorProps.has(decl.property)) {
      hardcodedColors.push(decl.property)
    }
  }

  return { vars, hardcodedColors }
}

function isNonWhitespaceToken(node: TokenOrValue): boolean {
  return !(node.type === "token" && (node.value.type === "white-space" || node.value.type === "comment"))
}

/**
 * Inspects AST declarations across all visited style rules to guard against lowered `light-dark()` rewrites and broken
 * color-scheme contracts:
 *
 * 1. Walks ALL declarations (longhands, shorthands like `background`/`border`/`outline`/`box-shadow`, and `--*` custom
 *    properties) for forbidden `--lightningcss-light`/`--buncss-light` vars.
 * 2. Enforces single top-level non-whitespace node on all single-color longhands and `--color-*` custom properties
 *    (catching juxtaposed `var(...) var(...)` rewrites directly in the AST).
 * 3. Asserts `color-scheme` co-presence whenever any `light-dark()` AST node appears in the stylesheet.
 */
function auditLightDarkAst(visited: readonly VisitedStyleRule[]): LightDarkAstViolation[] {
  const violations: LightDarkAstViolation[] = []
  let hasLightDark = false
  let hasColorScheme = false

  const walkTokens = (property: string, tokens: readonly TokenOrValue[]): void => {
    for (const node of tokens) {
      if (node.type === "var") {
        if (FORBIDDEN_LIGHT_DARK_POLYFILL_VARS.has(node.value.name.ident)) {
          violations.push({
            kind: "polyfill-var",
            property,
            detail: node.value.name.ident,
          })
        }
        if (node.value.fallback) {
          walkTokens(property, node.value.fallback)
        }
      } else if (node.type === "function") {
        if (node.value.name.toLowerCase() === "light-dark") {
          hasLightDark = true
        }
        walkTokens(property, node.value.arguments)
      } else if (node.type === "unresolved-color") {
        if (node.value.type === "light-dark") {
          hasLightDark = true
          walkTokens(property, node.value.light)
          walkTokens(property, node.value.dark)
        } else {
          walkTokens(property, node.value.alpha)
        }
      } else if (node.type === "color" && node.value.type === "light-dark") {
        hasLightDark = true
      }
    }
  }

  const checkSingleValueTokenCount = (property: string, tokens: readonly TokenOrValue[]): void => {
    const topLevel = tokens.filter(isNonWhitespaceToken)
    if (topLevel.length !== 1) {
      violations.push({
        kind: "juxtaposed-color-tokens",
        property,
        detail: `expected 1 top-level color/function node, got ${topLevel.length} (${topLevel.map((n) => n.type).join(", ")})`,
      })
    }
  }

  for (const { rule } of visited) {
    for (const decl of getAllDeclarations(rule)) {
      if (decl.property === "color-scheme") {
        hasColorScheme = true
        continue
      }

      if (decl.property === "unparsed") {
        const propName = decl.value.propertyId.property
        if (propName === "color-scheme") {
          hasColorScheme = true
        }
        walkTokens(propName, decl.value.value)
        if (SINGLE_COLOR_LONGHAND_PROPS.has(propName)) {
          checkSingleValueTokenCount(propName, decl.value.value)
        }
      } else if (decl.property === "custom") {
        const customName = decl.value.name
        walkTokens(customName, decl.value.value)
        if (customName.startsWith("--color-")) {
          checkSingleValueTokenCount(customName, decl.value.value)
        }
      } else {
        // Parsed declarations (e.g., `color: light-dark(#111, #eee)` or `border: 1px solid light-dark(...)`)
        const val = (decl as { value?: unknown }).value
        if (val && typeof val === "object") {
          const stack: unknown[] = [val]
          while (stack.length > 0) {
            const cur = stack.pop()
            if (!cur || typeof cur !== "object") continue
            if (Array.isArray(cur)) {
              for (const item of cur) stack.push(item)
              continue
            }
            const rec = cur as Record<string, unknown>
            if (rec.type === "light-dark") {
              hasLightDark = true
            }
            for (const v of Object.values(rec)) {
              if (v && typeof v === "object") stack.push(v)
            }
          }
        }
      }
    }
  }

  if (hasLightDark && !hasColorScheme) {
    violations.push({
      kind: "missing-color-scheme",
      property: "color-scheme",
      detail: "stylesheet uses light-dark() without any color-scheme declaration",
    })
  }

  return violations
}

describe("Display P3 chromatic tokens & LightningCSS AST survival", () => {
  test("preserves @supports (color: color(display-p3 1 1 1)) AST overrides for all 5 chromatic tokens across transforms", () => {
    const rawCss = readFileSync(TOKENS_CSS_PATH)

    const cases = [
      { label: "unminified", minify: false, targets: undefined },
      { label: "minified", minify: true, targets: undefined },
      // Legacy browser targets where Display P3 is unsupported — @supports must still survive untouched.
      { label: "legacy targets", minify: true, targets: { chrome: 90 << 16, firefox: 90 << 16 } },
    ] as const

    for (const { label, minify, targets } of cases) {
      const transformed = transform({
        filename: TOKENS_CSS_PATH,
        code: rawCss,
        minify,
        targets,
      })

      expect(transformed.warnings).toEqual([])
      const visited = collectStyleRulesFromAst(TOKENS_CSS_PATH, transformed.code)
      expect(auditLightDarkAst(visited)).toEqual([])

      const darkSrgb = new Map<string, string>()
      const lightSrgb = new Map<string, string>()
      const darkP3 = new Map<string, { r: number; g: number; b: number }>()
      const lightP3 = new Map<string, { r: number; g: number; b: number }>()

      for (const { rule, ctx } of visited) {
        const isRoot = rule.selectors.some(isRootSelector)
        const isLight = rule.selectors.some(isExactLightThemeSelector)
        if (!isRoot && !isLight) continue

        for (const decl of getAllDeclarations(rule)) {
          if (decl.property !== "custom") continue
          const tokenName = decl.value.name
          const colorNode = decl.value.value.find((t) => t.type === "color")
          if (!colorNode || colorNode.type !== "color") continue

          if (ctx.p3SupportsPolarity === "requires-p3") {
            if (colorNode.value.type === "display-p3") {
              const target = isRoot ? darkP3 : lightP3
              target.set(tokenName, {
                r: colorNode.value.r,
                g: colorNode.value.g,
                b: colorNode.value.b,
              })
            }
          } else if (ctx.p3SupportsPolarity === "unrelated") {
            const target = isRoot ? darkSrgb : lightSrgb
            target.set(tokenName, colorNode.value.type)
          }
        }
      }

      for (const token of CHROMATIC_TOKENS) {
        expect(darkSrgb.get(token), `Missing dark sRGB fallback for ${token} (${label})`).toBe("rgb")
        expect(lightSrgb.get(token), `Missing light sRGB fallback for ${token} (${label})`).toBe("rgb")

        const darkCoord = darkP3.get(token)
        const lightCoord = lightP3.get(token)
        expect(darkCoord, `Missing dark display-p3 AST override for ${token} (${label})`).toBeDefined()
        expect(lightCoord, `Missing light display-p3 AST override for ${token} (${label})`).toBeDefined()

        for (const channel of [darkCoord!.r, darkCoord!.g, darkCoord!.b, lightCoord!.r, lightCoord!.g, lightCoord!.b]) {
          expect(channel).toBeGreaterThanOrEqual(0)
          expect(channel).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  test("points .sd-badge--* AST rules in desk.css at chromatic tokens with zero hardcoded color literals", () => {
    const transformed = transform({
      filename: DESK_CSS_PATH,
      code: readFileSync(DESK_CSS_PATH),
      minify: true,
    })
    const visited = collectStyleRulesFromAst(DESK_CSS_PATH, transformed.code)
    expect(auditLightDarkAst(visited)).toEqual([])

    const expectedBadgeTokens: readonly (readonly [string, (typeof CHROMATIC_TOKENS)[number]])[] = [
      ["sd-badge--selected", "--color-blue"],
      ["sd-badge--originator", "--color-red"],
      ["sd-badge--syndicate-link", "--color-amber"],
      ["sd-badge--clv-leader", "--color-green"],
      ["sd-badge--parlay-critical", "--color-red"],
      ["sd-badge--sharp", "--color-blue"],
      ["sd-badge--whale", "--color-violet"],
      ["sd-badge--alert-operator", "--color-red"],
    ]

    for (const [className, token] of expectedBadgeTokens) {
      const darkMatches = visited.filter(({ rule }) =>
        rule.selectors.some((sel) => hasClassSelector(sel, className) && !hasLightThemeAttribute(sel)),
      )
      expect(darkMatches.length, `Expected dark AST rule for .${className}`).toBeGreaterThan(0)
      for (const { rule } of darkMatches) {
        const { vars, hardcodedColors } = inspectStyleRuleColors(rule)
        expect(vars.has(token), `.${className} should reference var(${token})`).toBe(true)
        expect(hardcodedColors, `.${className} should have zero hardcoded colors`).toEqual([])
      }
    }

    const expectedLightBadgeTokens = expectedBadgeTokens.filter(([className]) => className !== "sd-badge--selected")
    for (const [className, token] of expectedLightBadgeTokens) {
      const lightMatches = visited.filter(({ rule }) =>
        rule.selectors.some((sel) => hasClassSelector(sel, className) && hasLightThemeAttribute(sel)),
      )
      expect(lightMatches.length, `Expected [data-dashboard-theme="light"] AST rule for .${className}`).toBeGreaterThan(
        0,
      )
      for (const { rule } of lightMatches) {
        const { vars, hardcodedColors } = inspectStyleRuleColors(rule)
        expect(vars.has(token), `light .${className} should reference var(${token})`).toBe(true)
        expect(hardcodedColors, `light .${className} should have zero hardcoded colors`).toEqual([])
      }
    }
  })

  test("points .sd-pill-* AST rules in dashboard.css at chromatic tokens with zero hardcoded color literals", () => {
    const transformed = transform({
      filename: DASHBOARD_CSS_PATH,
      code: readFileSync(DASHBOARD_CSS_PATH),
      minify: true,
    })
    const visited = collectStyleRulesFromAst(DASHBOARD_CSS_PATH, transformed.code)
    expect(auditLightDarkAst(visited)).toEqual([])

    const expectedPillTokens: readonly (readonly [string, string])[] = [
      ["sd-pill-live", "--color-green"],
      ["sd-pill-fixture", "--color-amber"],
      ["sd-pill-alert", "--color-red"],
      ["sd-pill-sharp", "--color-violet"],
      ["sd-pill-blocked", "--sd-tier-blocked"],
    ]

    for (const [className, token] of expectedPillTokens) {
      const matches = visited.filter(({ rule }) => rule.selectors.some((sel) => hasClassSelector(sel, className)))
      expect(matches.length, `Expected AST rule for .${className}`).toBeGreaterThan(0)
      for (const { rule } of matches) {
        const { vars, hardcodedColors } = inspectStyleRuleColors(rule)
        expect(vars.has(token), `.${className} should reference var(${token})`).toBe(true)
        expect(hardcodedColors, `.${className} should have zero hardcoded colors`).toEqual([])
      }
    }
  })

  test("stack-accumulates 3-valued @supports polarity across @layer, @scope, escaped selectors, contradictions, and general P3 probes", () => {
    const fixtureCss = Buffer.from(`
      @layer design.tokens {
        @scope (.sd-card) to (.sd-slot) {
          @supports (background-color: color(display-p3 0 0 0)) {
            .sd-badge\\:p3\\/probe {
              --color-red: color(display-p3 0.9415 0.4492 0.431);
              color: var(--color-red);
            }
          }
          @supports not (color: color(display-p3 1 1 1)) {
            .sd-fallback-not {
              --color-red: #f87171;
            }
            @supports (color: color(display-p3 1 1 1)) {
              .sd-outer-forbid-inner-require {
                --color-red: #f87171;
              }
            }
          }
          @supports (color: color(display-p3 1 1 1)) and (display: grid) {
            .sd-p3-and-grid {
              --color-blue: color(display-p3 0.3041 0.7362 0.9822);
            }
          }
          @supports (color: color(display-p3 1 1 1)) or (display: grid) {
            .sd-p3-or-grid {
              --color-blue: #38bdf8;
            }
          }
          @supports (color: color(display-p3 1 1 1)) or (border-color: color(display-p3 0.5 0.25 0 / 0.8)) {
            .sd-p3-or-both {
              --color-violet: color(display-p3 0.7311 0.5112 0.9986);
            }
          }
          @supports (color: color(display-p3 1 1 1)) {
            @supports not (color: color(display-p3 1 1 1)) {
              .sd-outer-require-inner-forbid {
                --color-amber: #fbbf24;
              }
            }
            @supports (display: grid) {
              .sd-outer-require-inner-unrelated {
                --color-green: color(display-p3 0.3974 0.8713 0.4904);
              }
            }
          }
          @supports not (not (color: color(display-p3 1 1 1))) {
            .sd-double-negated {
              --color-green: color(display-p3 0.3974 0.8713 0.4904);
            }
          }
        }
      }
    `)

    const transformed = transform({
      filename: "fixture.css",
      code: fixtureCss,
      minify: true,
    })
    expect(transformed.warnings).toEqual([])

    const visited = collectStyleRulesFromAst("fixture.css", transformed.code)
    const byClass = (name: string) =>
      visited.find(({ rule }) => rule.selectors.some((sel) => hasClassSelector(sel, name)))

    const escaped = byClass("sd-badge:p3/probe")
    expect(escaped).toBeDefined()
    expect(escaped!.ctx.p3SupportsPolarity).toBe("requires-p3")
    expect(escaped!.ctx.layers).toEqual(["design.tokens"])
    expect(escaped!.ctx.scopes).toBe(1)

    expect(byClass("sd-fallback-not")?.ctx.p3SupportsPolarity).toBe("forbids-p3")
    expect(byClass("sd-outer-forbid-inner-require")?.ctx.p3SupportsPolarity).toBe("forbids-p3")
    expect(byClass("sd-outer-require-inner-forbid")?.ctx.p3SupportsPolarity).toBe("forbids-p3")
    expect(byClass("sd-outer-require-inner-unrelated")?.ctx.p3SupportsPolarity).toBe("requires-p3")
    expect(byClass("sd-p3-and-grid")?.ctx.p3SupportsPolarity).toBe("requires-p3")
    expect(byClass("sd-p3-or-grid")?.ctx.p3SupportsPolarity).toBe("unrelated")
    expect(byClass("sd-p3-or-both")?.ctx.p3SupportsPolarity).toBe("requires-p3")
    expect(byClass("sd-double-negated")?.ctx.p3SupportsPolarity).toBe("requires-p3")
  })

  test("AST light-dark() guard enforces --color-* tokens, all color longhands/shorthands, and color-scheme co-presence", () => {
    const validLightDarkCss = Buffer.from(`
      :root {
        color-scheme: light dark;
        --color-red: light-dark(#dc2626, #f87171);
      }
      .badge-modern {
        color: light-dark(#dc2626, #f87171);
        background-color: light-dark(var(--surface-panel), var(--surface-elevated));
        border-top-color: var(--color-red);
        outline-color: var(--color-red);
        fill: var(--color-red);
        stroke: var(--color-red);
        caret-color: var(--color-red);
        accent-color: var(--color-red);
        text-decoration-color: var(--color-red);
        border: 1px solid var(--color-red);
        box-shadow: 0 0 0 1px var(--color-red);
      }
    `)

    const modernOut = transform({
      filename: "pair-table.module.css",
      code: validLightDarkCss,
      targets: { chrome: 125 << 16 },
    })
    expect(auditLightDarkAst(collectStyleRulesFromAst("pair-table.module.css", modernOut.code))).toEqual([])

    // Missing `color-scheme` locks `light-dark()` silently to the light branch.
    const missingSchemeCss = Buffer.from(`
      .badge-no-scheme {
        color: light-dark(#dc2626, #f87171);
      }
    `)
    const missingSchemeViolations = auditLightDarkAst(
      collectStyleRulesFromAst("pair-table.module.css", missingSchemeCss),
    )
    expect(missingSchemeViolations).toContainEqual({
      kind: "missing-color-scheme",
      property: "color-scheme",
      detail: "stylesheet uses light-dark() without any color-scheme declaration",
    })

    // Legacy targets lower `light-dark()` into juxtaposed `--lightningcss-light`/`--lightningcss-dark`
    // across `--color-*` custom properties, longhands, and shorthands.
    const legacyOut = transform({
      filename: "pair-table.module.css",
      code: validLightDarkCss,
      targets: { chrome: 100 << 16 },
    })
    const legacyViolations = auditLightDarkAst(collectStyleRulesFromAst("pair-table.module.css", legacyOut.code))
    expect(legacyViolations.some((v) => v.kind === "polyfill-var" && v.property === "--color-red")).toBe(true)
    expect(legacyViolations.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "--color-red")).toBe(
      true,
    )
    expect(legacyViolations.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "color")).toBe(true)
    expect(
      legacyViolations.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "background-color"),
    ).toBe(true)

    // Shorthands & additional single-color longhands with `--buncss-light` / `--lightningcss-light`:
    // shorthands flag forbidden vars without falsely failing single-token count; longhands flag both.
    const shorthandAndLonghandCss = Buffer.from(`
      :root { color-scheme: light dark; }
      .shorthand-only {
        border: 1px solid var(--buncss-light, #dc2626) var(--buncss-dark, #f87171);
        box-shadow: 0 1px 2px var(--lightningcss-light, #000);
        outline-color: var(--buncss-light, #dc2626) var(--buncss-dark, #f87171);
        text-decoration-color: var(--buncss-light, #dc2626) var(--buncss-dark, #f87171);
      }
    `)
    const mixedViolations = auditLightDarkAst(
      collectStyleRulesFromAst("pair-table.module.css", shorthandAndLonghandCss),
    )
    expect(mixedViolations.some((v) => v.kind === "polyfill-var" && v.property === "border")).toBe(true)
    expect(mixedViolations.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "border")).toBe(false)
    expect(mixedViolations.some((v) => v.kind === "polyfill-var" && v.property === "box-shadow")).toBe(true)
    expect(mixedViolations.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "outline-color")).toBe(
      true,
    )
    expect(
      mixedViolations.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "text-decoration-color"),
    ).toBe(true)
  })

  test("extracts inline <style> blocks from standalone HTML templates via HTMLRewriter into the same AST audit", () => {
    let totalStyleBlocksAudited = 0

    for (const relPath of STANDALONE_HTML_TEMPLATES) {
      const fullPath = resolve(WORKSPACE_ROOT, relPath)
      const html = readFileSync(fullPath, "utf8")
      const styleBlocks = extractInlineStylesFromHtml(html)
      expect(styleBlocks.length, `Expected at least one <style> block in ${relPath}`).toBeGreaterThan(0)

      for (let i = 0; i < styleBlocks.length; i += 1) {
        const blockName = `${relPath}#style[${i}]`
        const transformed = transform({
          filename: blockName,
          code: Buffer.from(styleBlocks[i]!),
          minify: true,
        })
        const visited = collectStyleRulesFromAst(blockName, transformed.code)
        expect(auditLightDarkAst(visited), `AST violation in ${blockName}`).toEqual([])
        totalStyleBlocksAudited += 1
      }
    }

    expect(totalStyleBlocksAudited).toBeGreaterThanOrEqual(STANDALONE_HTML_TEMPLATES.length)

    // Confirm inline <style> blocks with broken light-dark() / missing color-scheme are caught too.
    const badHtml = `<!doctype html><html><head><style>
      .inline-bad { color: var(--buncss-light, #111) var(--buncss-dark, #eee); }
    </style><style>
      .inline-no-scheme { background-color: light-dark(#fff, #000); }
    </style></head><body></body></html>`
    const extracted = extractInlineStylesFromHtml(badHtml)
    expect(extracted).toHaveLength(2)

    const v0 = auditLightDarkAst(collectStyleRulesFromAst("inline#0", Buffer.from(extracted[0]!)))
    expect(v0.some((v) => v.kind === "polyfill-var" && v.detail === "--buncss-light")).toBe(true)
    expect(v0.some((v) => v.kind === "juxtaposed-color-tokens" && v.property === "color")).toBe(true)

    const v1 = auditLightDarkAst(collectStyleRulesFromAst("inline#1", Buffer.from(extracted[1]!)))
    expect(v1.some((v) => v.kind === "missing-color-scheme")).toBe(true)
  })
})
