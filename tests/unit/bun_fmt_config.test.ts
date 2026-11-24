import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseTomlWithMeta } from "../../lib/bun_toml.ts"

const REPO_ROOT = resolve(import.meta.dir, "../..")

function runBunFmtStdin(input: string, filepath: string, extraArgs: readonly string[] = []): string {
  const proc = Bun.spawnSync(["bun", "fmt", "--stdin-filepath", filepath, ...extraArgs], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`bun fmt failed (exit ${proc.exitCode}): ${new TextDecoder().decode(proc.stderr)}`)
  }
  return new TextDecoder().decode(proc.stdout)
}

describe("bun fmt configuration, doctor diagnostics, and native formatting features", () => {
  test("bunfig.toml configures [fmt], [fmt.sortImports], and [[fmt.overrides]] identically across TOML parsers", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "bunfig.toml"), "utf8")
    const nativeParsed = parseTomlWithMeta<Record<string, unknown>>(raw)
    const fallbackParsed = parseTomlWithMeta<Record<string, unknown>>(raw, { forceFallback: true })
    expect(nativeParsed.value).toEqual(fallbackParsed.value)

    const fmt = nativeParsed.value.fmt as {
      printWidth?: number
      semi?: boolean
      sortTailwindcss?: boolean
      sortPackageJson?: boolean
      jsdoc?: boolean
      ignorePatterns?: string[]
      sortImports?: {
        internalPattern?: string[]
        newlinesBetween?: boolean
        sortSideEffects?: boolean
      }
      overrides?: Array<{
        files?: string[]
        options?: { printWidth?: number }
      }>
    }

    expect(fmt.printWidth).toBe(100)
    expect(fmt.semi).toBe(false)
    expect(fmt.sortTailwindcss).toBe(true)
    expect(fmt.sortPackageJson).toBe(true)
    expect(fmt.jsdoc).toBe(true)
    expect(fmt.sortImports?.internalPattern).toEqual(["@sportsdesk-ops/", "@/"])
    expect(fmt.sortImports?.newlinesBetween).toBe(true)
    expect(fmt.sortImports?.sortSideEffects).toBe(false)
    expect(fmt.overrides).toContainEqual({
      files: ["*.test.ts"],
      options: { printWidth: 120 },
    })
  })

  test("package.json exposes format, format:check, format:debug, and format:doctor scripts", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.format).toBe("bun fmt")
    expect(pkg.scripts?.["format:check"]).toBe("bun fmt --check")
    expect(pkg.scripts?.["format:debug"]).toBe("bun fmt --debug-check")
    expect(pkg.scripts?.["format:doctor"]).toBe("bun fmt --doctor")
  })

  test("bun fmt --doctor --format=json confirms native bunfig.toml formatting with zero unsupported options or removable Prettier packages", () => {
    const proc = Bun.spawnSync(["bun", "fmt", "--doctor", "--format=json"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(0)

    const report = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      config: { bunfig: string | null }
      files: { formatted: number; by_prettier: Record<string, number>; left_for_plugins: number }
      plugins: { not_supported: string[] }
      options_not_supported: string[]
      packages: { removable: string[] }
    }

    expect(report.config.bunfig).toBe("bunfig.toml")
    expect(report.files.formatted).toBeGreaterThan(100)
    expect(Object.keys(report.files.by_prettier)).toHaveLength(0)
    expect(report.files.left_for_plugins).toBe(0)
    expect(report.plugins.not_supported).toHaveLength(0)
    expect(report.options_not_supported).toHaveLength(0)
    expect(report.packages.removable).toHaveLength(0)
  })

  test("sorts Tailwind CSS classes with the workspace Tailwind installation and preserves dynamic leading spaces", () => {
    const sortedBtn = runBunFmtStdin(
      'export const Btn = () => <button className="text-white px-4 sm:px-8 py-2 bg-sky-700 hover:bg-sky-800" />\n',
      "packages/ui/src/sample.tsx",
    )
    expect(sortedBtn).toContain('className="bg-sky-700 px-4 py-2 text-white hover:bg-sky-800 sm:px-8"')

    const templateClass = runBunFmtStdin(
      'export const Header = ({ open }: { open: boolean }) => <div className={`header${open ? " active" : ""}`} />\n',
      "packages/ui/src/sample.tsx",
    )
    expect(templateClass).toContain('className={`header${open ? " active" : ""}`}')
  })

  test("groups imports, merges duplicate module imports, sorts package.json keys, and formats JSDoc comments", () => {
    const importsOut = runBunFmtStdin(
      [
        'import { z } from "./local.ts"',
        'import { b } from "node:path"',
        'import { a } from "node:path"',
        "",
        "export const out = [a, b, z]",
        "",
      ].join("\n"),
      "packages/ui/src/sample.ts",
    )
    expect(importsOut).toContain('import { a, b } from "node:path"')
    expect(importsOut.indexOf('from "node:path"')).toBeLessThan(importsOut.indexOf('from "./local.ts"'))

    const pkgOut = runBunFmtStdin(
      JSON.stringify({
        dependencies: { zod: "^4.0.0" },
        version: "1.0.0",
        name: "demo-pkg",
        private: true,
      }),
      "package.json",
    )
    expect(pkgOut.indexOf('"name"')).toBeLessThan(pkgOut.indexOf('"version"'))
    expect(pkgOut.indexOf('"version"')).toBeLessThan(pkgOut.indexOf('"private"'))
    expect(pkgOut.indexOf('"private"')).toBeLessThan(pkgOut.indexOf('"dependencies"'))

    const jsdocOut = runBunFmtStdin(
      [
        "/**   computes    sum  ",
        " * @param   a   first value",
        " */",
        "export const add = (a: number) => a + 1",
        "",
      ].join("\n"),
      "packages/ui/src/sample.ts",
    )
    expect(jsdocOut).toContain("Computes sum")
    expect(jsdocOut).toContain("@param a First value")
  })

  test("applies [[fmt.overrides]] printWidth=120 for *.test.ts and preserves CSS semantics where Prettier alters meaning", () => {
    const line112 =
      'export const items = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"]\n'
    const testOut = runBunFmtStdin(line112, "tests/unit/override_check.test.ts")
    const srcOut = runBunFmtStdin(line112, "packages/ui/src/override_check.ts")

    expect(testOut.trim().split("\n")).toHaveLength(1)
    expect(srcOut.trim().split("\n").length).toBeGreaterThan(1)

    const cssOut = runBunFmtStdin("x |b { font-family: Font\\ Awesome; }\n", "packages/ui/src/semantic.css")
    expect(cssOut).toContain("Font\\ Awesome")
    expect(cssOut).toContain("x |b")
  })
})
