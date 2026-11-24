import { describe, expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"

import {
  ANSI_SGR,
  hasControlChars,
  isColorEnabled,
  resolveAnsiPalette,
  resolveAnsiTheme,
  stripControls,
  TRUECOLOR_PALETTE,
} from "../src/theme/ansi_tokens.ts"
import {
  formatKeyValueRows,
  osc8Link,
  padGrapheme,
  renderThemedMarkdown,
  safeHref,
} from "../src/theme/markdown_ansi.ts"

describe("terminal Markdown", () => {
  test("control detection stays consistent across calls and preserves Markdown whitespace", () => {
    const source = "one\x1b\ttwo\nthree"
    expect(hasControlChars(source)).toBe(true)
    expect(hasControlChars(source)).toBe(true)
    expect(stripControls(source)).toBe("one\ttwo\nthree")
    expect(hasControlChars(source)).toBe(true)
    expect(hasControlChars("\x9d")).toBe(true)
    expect(hasControlChars("\t\n")).toBe(false)
    for (let code = 0; code <= 159; code++) {
      const character = String.fromCharCode(code)
      const control = (code < 32 && code !== 9 && code !== 10) || code >= 127
      expect(hasControlChars(character)).toBe(control)
      expect(stripControls(character)).toBe(control ? "" : character)
    }
  })

  test("respects the color environment and retains the unsealed warning style", () => {
    const { FORCE_COLOR, NO_COLOR } = process.env
    try {
      delete process.env.FORCE_COLOR
      delete process.env.NO_COLOR
      expect(isColorEnabled(true)).toBe(true)
      process.env.NO_COLOR = ""
      expect(isColorEnabled(true)).toBe(false)
      process.env.FORCE_COLOR = "0"
      expect(isColorEnabled(true)).toBe(false)
      process.env.FORCE_COLOR = "1"
      expect(isColorEnabled(true)).toBe(true)
      expect(isColorEnabled(false)).toBe(false)
      expect(resolveAnsiTheme({ columns: undefined, colors: undefined, hyperlinks: true })).toEqual({
        colors: false,
        columns: 76,
        hyperlinks: false,
        kittyGraphics: false,
      })
      expect(formatKeyValueRows([["Seal", "UNSEALED"]], { colors: true })).toContain(
        TRUECOLOR_PALETTE.warn + "UNSEALED" + ANSI_SGR.reset,
      )
      const url = "https://example.invalid/help"
      const wrapped = renderThemedMarkdown("[first second](" + url + ")", {
        columns: 6,
        colors: true,
        hyperlinks: true,
      })
      expect(wrapped.trimEnd().split("\n")).toEqual(
        ["first", "second"].map((word) => "\x1b]8;;" + url + "\x07" + word + "\x1b]8;;\x07"),
      )
    } finally {
      if (FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = FORCE_COLOR
      if (NO_COLOR === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = NO_COLOR
    }
  })

  test("renders horizontal rules at the configured width", () => {
    const markdown = "Top\n\n---\n\nBottom"
    expect(renderThemedMarkdown(markdown, { columns: 9 })).toContain("\n---------\n")
    expect(renderThemedMarkdown(markdown, { columns: 0.5 })).toContain("\n-\n")
    for (const columns of [0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      expect(renderThemedMarkdown(markdown, { columns })).toContain("\n" + "-".repeat(60) + "\n")
    }
  })

  test("revalidates OSC 8 destinations and preserves inline styles in the label", () => {
    const label = ANSI_SGR.bold + "Help\x9d\npage" + ANSI_SGR.reset
    const controlFreeLabel = ANSI_SGR.bold + "Help page" + ANSI_SGR.reset
    const url = "https://example.invalid/help"
    expect(osc8Link(label, url, true)).toBe("\x1b]8;;" + url + "\x07" + controlFreeLabel + "\x1b]8;;\x07")
    expect(osc8Link("Help", url, false)).toBe("Help (" + url + ")")
    for (const rejected of [url + "%1b", url + "?X-Amz-Signature=fixture"]) {
      expect(osc8Link(label, rejected, true)).toBe(controlFreeLabel)
      expect(osc8Link("Help", rejected, false)).toBe("Help")
    }
  })

  test("sanitizes raw and decoded controls in plain and colored output", () => {
    const markdown = [
      "### Header\x1b\x9b &#27;",
      "",
      "Plain &#x1b; text \x9d. **Bold\x07** `inline\x1b`",
      "",
      "<div>HTML\x1b\x84</div>",
      "",
      "```",
      "code\x1b\x9f",
      "```",
    ].join("\n")
    const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
    for (const colors of [false, true]) {
      const output = renderThemedMarkdown(markdown, { colors })
      const plain = stripVTControlCharacters(output)
      expect(plain).not.toMatch(controls)
      expect(plain).toContain("Header")
      expect(plain).toContain("inline")
      expect(plain).toContain("HTML")
      expect(plain).toContain("code")
      if (!colors) expect(output).not.toMatch(controls)
    }
  })

  test("rejects unsafe destinations before normalization and renders their labels only", () => {
    for (const href of [
      "https://exa\tmple.invalid",
      "https://example.invalid/\x9d",
      "https://example.invalid/&#x1b;",
      "https://example.invalid/&#9;",
      "https://example.invalid/&NewLine;",
      "https://example.invalid/%1B",
      "https://example.invalid/%C2%9D",
      "https://example.invalid/bad%ZZ",
      "https://example.invalid/?%58-Amz-Signature=fixture",
      "https://example.invalid/?a=1&amp;X-Amz-Security-Token=fixture",
      "https://user:secret@example.invalid/",
      "javascript:alert(1)",
      "mailto:test@example.invalid?subject=line%0D%0Anext",
      "mailto:test@example.invalid?X-Amz-Credential=fixture",
      "/relative",
      "//example.invalid/relative",
    ]) {
      expect(safeHref(href)).toBeNull()
    }
    expect(safeHref("https://example.invalid/help")).toBe("https://example.invalid/help")
    expect(safeHref("https://example.invalid/%E6%9D%B1")).toBe("https://example.invalid/%E6%9D%B1")
    expect(safeHref("mailto:test@example.invalid")).toBe("mailto:test@example.invalid")
    const markdown = [
      "[Credentials](https://user:secret@example.invalid/)",
      "[Raw](https://raw.invalid/\x9d)",
      "[Entity](https://entity.invalid/&#x1b;)",
      "[Signed](https://signed.invalid/?a=1&amp;X-Amz-Signature=fixture)",
      "[Safe](https://example.invalid/help)",
    ].join(" ")
    for (const colors of [false, true]) {
      const output = renderThemedMarkdown(markdown, { colors, hyperlinks: true })
      expect(output).not.toContain("user:secret")
      expect(output).not.toMatch(/raw\.invalid|entity\.invalid|signed\.invalid/)
      expect(stripVTControlCharacters(output)).toContain("Credentials")
      expect(output).toContain("https://example.invalid/help")
    }
  })

  test("custom palettes emit only valid RGB foreground styles", () => {
    const valid = "\x1b[38;2;1;2;3m"
    const palette = {
      ...TRUECOLOR_PALETTE,
      heading: "\x1b]8;;https://fixture.invalid/\x07",
      key: "\x1b[38;2;256;0;0m",
      code: valid,
    }
    const resolved = resolveAnsiPalette(true, palette)
    expect(resolved.heading).toBe(TRUECOLOR_PALETTE.heading)
    expect(resolved.key).toBe(TRUECOLOR_PALETTE.key)
    expect(resolved.code).toBe(valid)
    const rendered = renderThemedMarkdown("### Header **key** `code`", { colors: true, palette })
    expect(rendered).not.toMatch(/fixture\.invalid|256/)
    if (isColorEnabled(true)) expect(rendered).toContain(valid)
  })

  test("pads wide labels by display cells and keeps field values on one line", () => {
    expect(padGrapheme("東\x1b", 4)).toBe("東  ")
    expect(padGrapheme("👩‍💻", 4)).toBe("👩‍💻  ")
    for (const columns of [0, -1, NaN, Infinity]) {
      expect(padGrapheme("東", columns)).toBe("東")
    }
    expect(padGrapheme("東", Number.MAX_VALUE).length).toBe(65_534)
    expect(formatKeyValueRows([["東\x1b", "ready\x9d\nnow"]], { keyWidth: 4 })).toBe("東   ready now")
  })

  test("renders GFM aligned tables, tasklists, and captures heading meta IDs", () => {
    const md = [
      "# Docs Table & Meta ID",
      "",
      "| Key | Align | Latency |",
      "| :--- | :---: | ---: |",
      "| `L25` | center | 42ms |",
      "",
      "- [x] Verified",
      "- [ ] Pending",
    ].join("\n")

    let captured: import("../src/theme/markdown_ansi.ts").ThemedMarkdownMetadata | undefined
    const plain = renderThemedMarkdown(md, {
      colors: false,
      showHeadingIds: true,
      onMetadata: (meta) => {
        captured = meta
      },
    })

    expect(plain).toContain("Docs Table & Meta ID [#docs-table-meta-id]")
    expect(plain).toContain("+-----+--------+---------+")
    expect(plain).toContain("| L25 | center |    42ms |")
    expect(plain).toContain("[x] Verified")
    expect(plain).toContain("[ ] Pending")
    expect(captured?.tableCount).toBe(1)
    expect(captured?.taskSummary).toEqual({ total: 2, checked: 1, unchecked: 1 })
    expect(captured?.headingIds).toEqual([{ level: 1, id: "docs-table-meta-id", text: "Docs Table & Meta ID" }])
  })
})
