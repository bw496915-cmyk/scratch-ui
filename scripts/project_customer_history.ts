#!/usr/bin/env bun
import { chmod, mkdir, rename } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
/** Project private graded exports to count-only/descriptive per-account history. */
import { parseArgs } from "node:util"

import { projectRetainedCustomerHistory } from "../packages/backend/src/retained_customer_history.ts"
import { parseCustomerRetainedHistory } from "../packages/contracts/src/customer_history.ts"
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source: { type: "string", multiple: true },
    out: { type: "string", default: ".local/customer-history.json" },
    help: { type: "boolean" },
    "if-changed": { type: "boolean" },
  },
})
if (values.help) {
  console.log(
    "Usage: bun run scripts/project_customer_history.ts --source graded-today.json --source graded-window.json [--out .local/customer-history.json] [--if-changed]\nOffline projection only; no login, network requests, messages or account changes. Inputs must be provider graded-export arrays. Private output is mode 0600. Overlap is deduplicated; conflicts and unsupported lifecycle rows are withheld.",
  )
  process.exit(0)
}
if (!values.source?.length || values.source.length > 16)
  throw new Error("Provide 1..16 --source files; use --help for an example")
if (values.source.some((source) => resolve(source) === resolve(values.out)))
  throw new Error("Projection output cannot replace a source export")
const sources: unknown[] = [],
  evidence = []
for (const source of values.source) {
  const file = Bun.file(source)
  if (file.size > 128 * 1024 * 1024)
    throw new Error("A graded source exceeds the 128 MiB offline input limit")
  const bytes = await file.bytes()
  sources.push(JSON.parse(new TextDecoder().decode(bytes)))
  evidence.push({
    file: basename(source),
    bytes: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  })
}
const projectorHasher = new Bun.CryptoHasher("sha256")
for (const name of [
  "scripts/project_customer_history.ts",
  "packages/backend/src/retained_customer_history.ts",
  "packages/contracts/src/customer_history.ts",
])
  projectorHasher.update(await Bun.file(new URL(`../${name}`, import.meta.url)).bytes())
const projectorSha256 = projectorHasher.digest("hex")
if (values["if-changed"]) {
  try {
    const previous: unknown = await Bun.file(values.out).json()
    if (
      typeof previous === "object" &&
      previous !== null &&
      "schemaVersion" in previous &&
      "kind" in previous &&
      "wholeAccountHistory" in previous &&
      "projectorSha256" in previous &&
      "generatedAt" in previous &&
      "sources" in previous &&
      "records" in previous &&
      previous.schemaVersion === 1 &&
      previous.kind === "f402-retained-wager-metrics" &&
      previous.wholeAccountHistory === false &&
      previous.projectorSha256 === projectorSha256 &&
      typeof previous.generatedAt === "string" &&
      Number.isFinite(Date.parse(previous.generatedAt)) &&
      JSON.stringify(previous.sources) === JSON.stringify(evidence) &&
      Array.isArray(previous.records) &&
      previous.records.every(
        (r: unknown) =>
          typeof r === "object" &&
          r !== null &&
          "customerKey" in r &&
          typeof r.customerKey === "string" &&
          "metrics" in r &&
          parseCustomerRetainedHistory(r.metrics) !== null,
      )
    ) {
      console.log(
        JSON.stringify({
          status: "unchanged",
          generatedAt: previous.generatedAt,
          wholeAccountHistory: false,
        }),
      )
      process.exit(0)
    }
  } catch {
    /* Missing or invalid output must be rebuilt from validated inputs. */
  }
}
const result = {
  projectorSha256,
  ...projectRetainedCustomerHistory(sources),
  generatedAt: new Date().toISOString(),
  sources: evidence,
}
const output = values.out
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
const temp = `${output}.tmp-${process.pid}`
await Bun.write(temp, JSON.stringify(result), { mode: 0o600 })
await chmod(temp, 0o600)
await rename(temp, output)
console.log(
  JSON.stringify({
    output,
    status: "updated",
    generatedAt: result.generatedAt,
    summary: result.summary,
    sources: result.sources,
    wholeAccountHistory: false,
  }),
)
