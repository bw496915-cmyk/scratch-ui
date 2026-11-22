import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const seed = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
)
// JPEG APP1 EXIF with orientation 6 (rotate 90° clockwise).
const orientation6 = Buffer.from(
  "ffe100224578696600004d4d002a00000008000101120003000000010006000000000000",
  "hex",
)
let fixtureDir: string
let pngPath: string
let rotatedPath: string

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "studio-image-worker-test-"))
  pngPath = join(fixtureDir, "landscape.png")
  rotatedPath = join(fixtureDir, "rotated.jpg")
  const png = await new Bun.Image(seed).resize(7, 5, { fit: "fill" }).png().bytes()
  const jpg = await new Bun.Image(png).jpeg().bytes()
  await Bun.write(pngPath, png)
  await Bun.write(rotatedPath, Buffer.concat([jpg.subarray(0, 2), orientation6, jpg.subarray(2)]))
})

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true })
})

async function transform(
  path: string,
  resize: Bun.Image.ResizeOptions & {
    width?: number
    height?: number
  },
) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "server/bun_image_worker.ts", "transform"],
    stdin: new Blob([
      JSON.stringify({ fullPath: path, source: "fixture", format: "png", ...resize }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`Image worker exited ${code}: ${stderr}`)
  const result = JSON.parse(stdout)
  const png = Buffer.from(result.dataUrl.split(",")[1], "base64")
  const decoded = await new Bun.Image(png).metadata()
  expect([result.outputWidth, result.outputHeight]).toEqual([decoded.width, decoded.height])
  return [decoded.width, decoded.height]
}

test("height-only resize honors the target without a second fit pass", async () => {
  expect(await transform(pngPath, { height: 3, filter: "nearest" })).toEqual([4, 3])
})

test("height-only resize uses the EXIF-oriented aspect ratio", async () => {
  expect(await transform(rotatedPath, { height: 2 })).toEqual([1, 2])
})

test("height-only resize does not enlarge unless requested", async () => {
  expect(await transform(pngPath, { height: 8 })).toEqual([7, 5])
  expect(await transform(pngPath, { height: 8, withoutEnlargement: false })).toEqual([11, 8])
})

test("width-only omission and two-axis fill retain their behavior", async () => {
  expect(await transform(pngPath, { width: 4 })).toEqual([3, 2])
  expect(await transform(pngPath, { width: 4, height: 4, fit: "fill" })).toEqual([4, 4])
})
