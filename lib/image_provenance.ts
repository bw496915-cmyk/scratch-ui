/**
 * @file lib/image_provenance.ts
 * @description Header-only `sportsdesk:*` image provenance inspector & XMP builder.
 * Delegates all binary sniffing and container chunk walking to `lib/xmp_container.ts`
 * (zero private RIFF/PNG/ISOBMFF walkers).
 */
import type {
  ImageProvenanceChannel,
  ImageProvenanceFields,
  ImageProvenanceReport,
  R2ImageProvenanceApiResponse,
} from "../packages/contracts/src/dashboard_hydration.ts"
import { type BinaryInput, peekBytes } from "./binary.ts"
import { extractContainerMetadata } from "./xmp_container.ts"

const SPORTSDESK_XML_NS = "https://sportsdesk.ops/ns/provenance/1.0/"

const PROVENANCE_KEY_NAMES = ["streamId", "genU32", "merkleRoot"] as const
type ProvenanceKeyName = (typeof PROVENANCE_KEY_NAMES)[number]

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * Builds a canonical UTF-8 XMP packet carrying `sportsdesk:streamId`,
 * `sportsdesk:genU32`, and `sportsdesk:merkleRoot` provenance attributes/elements.
 */
export function buildSportsdeskProvenanceXmp(fields: Partial<ImageProvenanceFields>): string {
  const elements: string[] = []
  if (typeof fields.streamId === "string" && fields.streamId.trim().length > 0) {
    elements.push(`<sportsdesk:streamId>${escapeXml(fields.streamId.trim())}</sportsdesk:streamId>`)
  }
  if (
    typeof fields.genU32 === "number" &&
    Number.isInteger(fields.genU32) &&
    fields.genU32 >= 0 &&
    fields.genU32 <= 0xffffffff
  ) {
    elements.push(`<sportsdesk:genU32>${fields.genU32}</sportsdesk:genU32>`)
  }
  if (typeof fields.merkleRoot === "string" && fields.merkleRoot.trim().length > 0) {
    const clean = fields.merkleRoot.trim().replace(/^0x/i, "").toLowerCase()
    elements.push(`<sportsdesk:merkleRoot>${escapeXml(clean)}</sportsdesk:merkleRoot>`)
  }

  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:sportsdesk="${SPORTSDESK_XML_NS}">` +
    elements.join("") +
    `</rdf:Description></rdf:RDF></x:xmpmeta>` +
    `<?xpacket end="w"?>`
  )
}

function extractSportsdeskKeysFromXmp(xmpXml: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PROVENANCE_KEY_NAMES) {
    const tagRe = new RegExp(`<sportsdesk:${key}\\b[^>]*>([\\s\\S]*?)</sportsdesk:${key}>`, "i")
    const tagMatch = tagRe.exec(xmpXml)
    if (tagMatch && tagMatch[1] !== undefined) {
      out[`sportsdesk:${key}`] = unescapeXml(tagMatch[1].trim())
      continue
    }
    const attrRe = new RegExp(`\\bsportsdesk:${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
    const attrMatch = attrRe.exec(xmpXml)
    const attrVal = attrMatch?.[1] ?? attrMatch?.[2]
    if (attrVal !== undefined) {
      out[`sportsdesk:${key}`] = unescapeXml(attrVal.trim())
    }
  }
  return out
}

function normalizeProvenanceFields(
  raw: Readonly<Record<string, string>>,
  issues: string[],
): ImageProvenanceFields {
  const rawStreamId = raw["sportsdesk:streamId"]
  const streamId =
    typeof rawStreamId === "string" && rawStreamId.trim().length > 0 ? rawStreamId.trim() : null

  let genU32: number | null = null
  const rawGen = raw["sportsdesk:genU32"]
  if (typeof rawGen === "string" && rawGen.trim().length > 0) {
    const trimmed = rawGen.trim()
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed)
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) {
        genU32 = parsed
      } else {
        issues.push("invalid_genU32")
      }
    } else {
      issues.push("invalid_genU32")
    }
  }

  let merkleRoot: string | null = null
  const rawMerkle = raw["sportsdesk:merkleRoot"]
  if (typeof rawMerkle === "string" && rawMerkle.trim().length > 0) {
    const clean = rawMerkle.trim().replace(/^0x/i, "").toLowerCase()
    if (/^[0-9a-f]{8,128}$/.test(clean)) {
      merkleRoot = clean
    } else {
      issues.push("invalid_merkleRoot")
    }
  }

  return { streamId, genU32, merkleRoot }
}

/**
 * Inspects `sportsdesk:*` provenance across WebP (`webp-xmp`), PNG (`png-text`, `png-xmp`),
 * and explicit AVIF (`image/avif`) containers by delegating container walking to `lib/xmp_container.ts`.
 */
export async function inspectImageProvenance(input: BinaryInput): Promise<ImageProvenanceReport> {
  const meta = await extractContainerMetadata(input)
  const channels: ImageProvenanceChannel[] = []
  const raw: Record<string, string> = {}
  const issues: string[] = [...meta.issues]

  if (meta.format === "png") {
    let foundPngText = false
    for (const [k, v] of Object.entries(meta.pngTextEntries)) {
      if (k.startsWith("sportsdesk:")) {
        raw[k] = v
        foundPngText = true
      }
    }
    if (foundPngText) channels.push("png-text")

    if (meta.xmp) {
      const xmpKeys = extractSportsdeskKeysFromXmp(meta.xmp)
      const entries = Object.entries(xmpKeys)
      if (entries.length > 0) {
        channels.push("png-xmp")
        for (const [k, v] of entries) raw[k] = v
      }
    }
  } else if (meta.format === "webp" && meta.xmp) {
    const xmpKeys = extractSportsdeskKeysFromXmp(meta.xmp)
    const entries = Object.entries(xmpKeys)
    if (entries.length > 0) {
      channels.push("webp-xmp")
      for (const [k, v] of entries) raw[k] = v
    }
  } else if (meta.format === "avif" && meta.xmp) {
    const xmpKeys = extractSportsdeskKeysFromXmp(meta.xmp)
    for (const [k, v] of Object.entries(xmpKeys)) raw[k] = v
  }

  const fields = normalizeProvenanceFields(raw, issues)
  const available = meta.format !== "unknown"

  return {
    available,
    format: meta.format === "unknown" ? null : meta.format,
    width: meta.width,
    height: meta.height,
    byteLength: meta.byteLength,
    channels,
    fields,
    raw,
    issues,
  }
}

export interface ProbeR2ImageProvenanceOptions {
  readonly key: string
  readonly bucketPublicBase: string
  readonly fetchImpl?: typeof fetch | undefined
  readonly maxBytes?: number | undefined
}

/**
 * Fetches a bounded prefix (or full image up to `maxBytes`) from a public R2 URL
 * and runs `inspectImageProvenance` via `lib/binary.ts` + `lib/xmp_container.ts`.
 */
export async function probeR2ImageProvenance(
  options: ProbeR2ImageProvenanceOptions,
): Promise<R2ImageProvenanceApiResponse> {
  const base = options.bucketPublicBase.replace(/\/+$/, "")
  const publicUrl = `${base}/${options.key}`
  const fetcher = options.fetchImpl ?? fetch
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(4096, options.maxBytes ?? 512 * 1024))

  try {
    const res = await fetcher(publicUrl, {
      method: "GET",
      headers: { range: `bytes=0-${maxBytes - 1}` },
    })
    if (!res.ok && res.status !== 206) {
      return {
        schemaVersion: 1,
        key: options.key,
        publicUrl,
        fetchedBytes: 0,
        report: {
          available: false,
          format: null,
          width: null,
          height: null,
          byteLength: 0,
          channels: [],
          fields: { streamId: null, genU32: null, merkleRoot: null },
          raw: {},
          issues: [`http_${res.status}`],
          errorCode: `HTTP_${res.status}`,
        },
      }
    }
    const bytes = await peekBytes(res, maxBytes)
    const report = await inspectImageProvenance(bytes)
    return {
      schemaVersion: 1,
      key: options.key,
      publicUrl,
      fetchedBytes: bytes.byteLength,
      report,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      schemaVersion: 1,
      key: options.key,
      publicUrl,
      fetchedBytes: 0,
      report: {
        available: false,
        format: null,
        width: null,
        height: null,
        byteLength: 0,
        channels: [],
        fields: { streamId: null, genU32: null, merkleRoot: null },
        raw: {},
        issues: ["fetch_failed"],
        errorCode: msg.slice(0, 80),
      },
    }
  }
}
