/**
 * @file tests/unit/tokens_display_p3_lightningcss.test.ts
 * @description Uses LightningCSS's native AST (`visitor.StyleSheet`) to verify that:
 * 1. Wide-gamut `@supports (color: color(display-p3 1 1 1))` chromatic overrides in
 *    `packages/ui/src/styles/tokens.css` survive unminified, minified, and legacy-target builds.
 * 2. `.sd-badge--*` rules in `desk.css` and `.sd-pill-*` rules in `dashboard.css` reference
 *    the chromatic tokens via CSS custom properties with zero hardcoded color literals.
 * 3. Recursive AST traversal handles `@layer`, `@scope`, nested rules, and CSS-escaped selectors.
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

const CHROMATIC_TOKENS = [
  "--color-red",
  "--color-amber",
  "--color-green",
  "--color-blue",
  "--color-violet",
] as const

interface WalkContext {
  readonly inDisplayP3Supports: boolean
  readonly layers: readonly string[]
  readonly scopes: number
}

interface VisitedStyleRule {
  readonly rule: StyleRule
  readonly ctx: WalkContext
}

function isDisplayP3SupportsCondition(cond: SupportsCondition): boolean {
  switch (cond.type) {
    case "declaration":
      return (
        cond.propertyId.property === "color" &&
        cond.value.replace(/\s+/g, " ").trim().toLowerCase() === "color(display-p3 1 1 1)"
      )
    case "parens":
      return isDisplayP3SupportsCondition(cond.value)
    case "and":
    case "or":
      return cond.value.some(isDisplayP3SupportsCondition)
    default:
      return false
  }
}

function walkRules(
  rules: readonly Rule[],
  ctx: WalkContext,
  out: VisitedStyleRule[],
): void {
  for (const rule of rules) {
    switch (rule.type) {
      case "style":
        out.push({ rule: rule.value, ctx })
        if (rule.value.rules && rule.value.rules.length > 0) {
          walkRules(rule.value.rules, ctx, out)
        }
        break
      case "supports":
        walkRules(
          rule.value.rules,
          {
            ...ctx,
            inDisplayP3Supports:
              ctx.inDisplayP3Supports || isDisplayP3SupportsCondition(rule.value.condition),
          },
          out,
        )
        break
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
        walkRules(sheet.rules, { inDisplayP3Supports: false, layers: [], scopes: 0 }, collected)
      },
    },
  })
  return collected
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
  return [
    ...(rule.declarations.declarations ?? []),
    ...(rule.declarations.importantDeclarations ?? []),
  ]
}

/** Walks LightningCSS TokenOrValue trees to collect referenced custom properties and hardcoded color nodes. */
function inspectTokenTree(
  tokens: readonly TokenOrValue[],
  vars: Set<string>,
  hardcodedColors: string[],
): void {
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

          if (ctx.inDisplayP3Supports) {
            if (colorNode.value.type === "display-p3") {
              const target = isRoot ? darkP3 : lightP3
              target.set(tokenName, {
                r: colorNode.value.r,
                g: colorNode.value.g,
                b: colorNode.value.b,
              })
            }
          } else {
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

        for (const channel of [
          darkCoord!.r,
          darkCoord!.g,
          darkCoord!.b,
          lightCoord!.r,
          lightCoord!.g,
          lightCoord!.b,
        ]) {
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

    const expectedLightBadgeTokens = expectedBadgeTokens.filter(
      ([className]) => className !== "sd-badge--selected",
    )
    for (const [className, token] of expectedLightBadgeTokens) {
      const lightMatches = visited.filter(({ rule }) =>
        rule.selectors.some((sel) => hasClassSelector(sel, className) && hasLightThemeAttribute(sel)),
      )
      expect(
        lightMatches.length,
        `Expected [data-dashboard-theme="light"] AST rule for .${className}`,
      ).toBeGreaterThan(0)
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

    const expectedPillTokens: readonly (readonly [string, string])[] = [
      ["sd-pill-live", "--color-green"],
      ["sd-pill-fixture", "--color-amber"],
      ["sd-pill-alert", "--color-red"],
      ["sd-pill-sharp", "--color-violet"],
      ["sd-pill-blocked", "--sd-tier-blocked"],
    ]

    for (const [className, token] of expectedPillTokens) {
      const matches = visited.filter(({ rule }) =>
        rule.selectors.some((sel) => hasClassSelector(sel, className)),
      )
      expect(matches.length, `Expected AST rule for .${className}`).toBeGreaterThan(0)
      for (const { rule } of matches) {
        const { vars, hardcodedColors } = inspectStyleRuleColors(rule)
        expect(vars.has(token), `.${className} should reference var(${token})`).toBe(true)
        expect(hardcodedColors, `.${className} should have zero hardcoded colors`).toEqual([])
      }
    }
  })

  test("AST walker covers @layer, @scope, and CSS-escaped class selectors under @supports display-p3", () => {
    const fixtureCss = Buffer.from(`
      @layer design.tokens {
        @scope (.sd-card) to (.sd-slot) {
          @supports (color: color(display-p3 1 1 1)) {
            .sd-badge\\:p3\\/critical {
              --color-red: color(display-p3 0.9415 0.4492 0.431);
              color: var(--color-red);
              background-color: color-mix(in oklch, var(--color-red) 14%, transparent);
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
    const match = visited.find(({ rule }) =>
      rule.selectors.some((sel) => hasClassSelector(sel, "sd-badge:p3/critical")),
    )
    expect(match).toBeDefined()
    expect(match!.ctx.inDisplayP3Supports).toBe(true)
    expect(match!.ctx.layers).toEqual(["design.tokens"])
    expect(match!.ctx.scopes).toBe(1)

    const { vars } = inspectStyleRuleColors(match!.rule)
    expect(vars.has("--color-red")).toBe(true)
  })
})
