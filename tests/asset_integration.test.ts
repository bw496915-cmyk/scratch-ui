import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readRawAssetFile, resolveSafeAssetPath } from "../server/bun_image_engine.ts"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createAssetFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sportsdesk-assets-"))
  temporaryRoots.push(root)
  mkdirSync(join(root, "public/images"), { recursive: true })
  writeFileSync(join(root, "public/images/valid.svg"), "<svg></svg>")
  writeFileSync(join(root, "private.txt"), "private fixture")
  return root
}

describe("image asset filesystem containment", () => {
  test("serves a regular asset and an in-root symlink", async () => {
    const root = createAssetFixture()
    symlinkSync("valid.svg", join(root, "public/images/alias.svg"))
    const result = await readRawAssetFile(root, "public/images/alias.svg")
    expect(result?.bytes.toString()).toBe("<svg></svg>")
    expect(result?.mimeType).toBe("image/svg+xml")
  })

  test("rejects absolute and relative symlinks outside allowed asset roots", async () => {
    const root = createAssetFixture()
    symlinkSync(join(root, "private.txt"), join(root, "public/images/absolute.svg"))
    symlinkSync("../../private.txt", join(root, "public/images/relative.svg"))
    for (const name of ["absolute.svg", "relative.svg"]) {
      expect(await readRawAssetFile(root, `public/images/${name}`)).toBeNull()
    }
  })

  test("rejects directories, missing files, and traversal", () => {
    const root = createAssetFixture()
    for (const source of ["public/images", "public/missing.png", "public/../private.txt"]) {
      expect(resolveSafeAssetPath(root, source)).toBeNull()
    }
  })
})
