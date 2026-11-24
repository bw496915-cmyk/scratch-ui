/**
 * Header-only `sportsdesk:*`, Dublin Core (`dc:*`), and XMP Core (`xmp:*`) image provenance
 * inspector & contextual XMP packet builder. Delegates all binary sniffing and container chunk
 * walking to `lib/xmp_container.ts`.
 *
 * @file Lib/image_provenance.ts
 */
import type {
  ImageProvenanceChannel,
  ImageProvenanceContext,
  ImageProvenanceFields,
  ImageProvenanceReport,
  R2ImageProvenanceApiResponse,
} from "../packages/contracts/src/dashboard_hydration.ts"
import { type BinaryInput, peekBytes } from "./binary.ts"
import { extractContainerMetadata } from "./xmp_container.ts"

const SPORTSDESK_XML_NS = "https://sportsdesk.ops/ns/provenance/1.0/"
const DC_XML_NS = "http://purl.org/dc/elements/1.1/"
const XMP_XML_NS = "http://ns.adobe.com/xap/1.0/"

const CORE_PROVENANCE_KEYS = ["streamId", "genU32", "merkleRoot"] as const

const EXTENDED_SPORTSDESK_KEYS = [
  "brand",
  "assetRole",
  "surfaceContext",
  "domainContext",
  "tokensVersion",
  "sourceSpec",
  "palette",
] as const

const DC_SCALAR_KEYS = ["title", "description", "creator", "rights"] as const
const XMP_CORE_KEYS = ["CreatorTool", "CreateDate"] as const

export interface ImageProvenanceContextInput {
  readonly title?: string | null | undefined
  readonly description?: string | null | undefined
  readonly creator?: string | null | undefined
  readonly rights?: string | null | undefined
  readonly creatorTool?: string | null | undefined
  readonly createDate?: string | null | undefined
  readonly brand?: string | null | undefined
  readonly assetRole?: string | null | undefined
  readonly surfaceContext?: string | null | undefined
  readonly domainContext?: string | null | undefined
  readonly tokensVersion?: string | null | undefined
  readonly sourceSpec?: string | null | undefined
  readonly palette?: string | null | undefined
  readonly subjects?: readonly string[] | undefined
}

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

function cleanText(value?: string | null): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildElement(prefix: string, name: string, value?: string | null): string | null {
  const clean = cleanText(value)
  if (!clean) return null
  return `<${prefix}:${name}>${escapeXml(clean)}</${prefix}:${name}>`
}

/**
 * Builds a canonical UTF-8 XMP packet carrying core `sportsdesk:*` provenance (`streamId`,
 * `genU32`, `merkleRoot`) plus optional Dublin Core (`dc:*`), XMP Core (`xmp:*`), and extended
 * `sportsdesk:*` branding/operational context.
 */
export function buildSportsdeskProvenanceXmp(
  fields: Partial<ImageProvenanceFields>,
  context?: ImageProvenanceContextInput | null,
): string {
  const elements: string[] = []
  let hasDc = false
  let hasXmp = false

  const streamEl = buildElement("sportsdesk", "streamId", fields.streamId)
  if (streamEl) elements.push(streamEl)

  if (
    typeof fields.genU32 === "number" &&
    Number.isInteger(fields.genU32) &&
    fields.genU32 >= 0 &&
    fields.genU32 <= 0xffffffff
  ) {
    elements.push(`<sportsdesk:genU32>${fields.genU32}</sportsdesk:genU32>`)
  }

  const rawMerkle = cleanText(fields.merkleRoot)
  if (rawMerkle) {
    const clean = rawMerkle.replace(/^0x/i, "").toLowerCase()
    elements.push(`<sportsdesk:merkleRoot>${escapeXml(clean)}</sportsdesk:merkleRoot>`)
  }

  if (context) {
    for (const key of EXTENDED_SPORTSDESK_KEYS) {
      const el = buildElement("sportsdesk", key, context[key])
      if (el) elements.push(el)
    }

    for (const key of DC_SCALAR_KEYS) {
      const el = buildElement("dc", key, context[key])
      if (el) {
        hasDc = true
        elements.push(el)
      }
    }

    const cleanSubjects = (context.subjects ?? [])
      .map((s) => cleanText(s))
      .filter((s): s is string => s !== null)
    if (cleanSubjects.length > 0) {
      hasDc = true
      const items = cleanSubjects.map((s) => `<rdf:li>${escapeXml(s)}</rdf:li>`).join("")
      elements.push(`<dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject>`)
    }

    const toolEl = buildElement("xmp", "CreatorTool", context.creatorTool)
    if (toolEl) {
      hasXmp = true
      elements.push(toolEl)
    }

    const dateEl = buildElement("xmp", "CreateDate", context.createDate)
    if (dateEl) {
      hasXmp = true
      elements.push(dateEl)
    }
  }

  const nsAttrs = [`xmlns:sportsdesk="${SPORTSDESK_XML_NS}"`]
  if (hasDc) nsAttrs.push(`xmlns:dc="${DC_XML_NS}"`)
  if (hasXmp) nsAttrs.push(`xmlns:xmp="${XMP_XML_NS}"`)

  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ${nsAttrs.join(" ")}>` +
    elements.join("") +
    `</rdf:Description></rdf:RDF></x:xmpmeta>` +
    `<?xpacket end="w"?>`
  )
}

function extractNamespacedValue(xmpXml: string, prefix: string, key: string): string | null {
  const tagRe = new RegExp(`<${prefix}:${key}\\b[^>]*>([\\s\\S]*?)</${prefix}:${key}>`, "i")
  const tagMatch = tagRe.exec(xmpXml)
  if (tagMatch && tagMatch[1] !== undefined) {
    const inner = tagMatch[1].trim()
    // Unwrap rdf:Alt / rdf:Seq / rdf:Bag single-item containers if present
    const liMatch = /<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(inner)
    const raw = liMatch && liMatch[1] !== undefined ? liMatch[1].trim() : inner
    return unescapeXml(raw)
  }

  const attrRe = new RegExp(`\\b${prefix}:${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
  const attrMatch = attrRe.exec(xmpXml)
  const attrVal = attrMatch?.[1] ?? attrMatch?.[2]
  if (attrVal !== undefined) {
    return unescapeXml(attrVal.trim())
  }
  return null
}

function extractDcSubjects(xmpXml: string): string[] {
  const blockMatch = /<dc:subject\b[^>]*>([\s\S]*?)<\/dc:subject>/i.exec(xmpXml)
  if (!blockMatch || blockMatch[1] === undefined) return []
  const out: string[] = []
  const liRe = /<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/gi
  let m: RegExpExecArray | null
  while ((m = liRe.exec(blockMatch[1])) !== null) {
    const val = cleanText(unescapeXml(m[1] ?? ""))
    if (val) out.push(val)
  }
  return out
}

function extractAllKeysFromXmp(xmpXml: string): {
  readonly raw: Record<string, string>
  readonly subjects: string[]
} {
  const raw: Record<string, string> = {}

  for (const key of CORE_PROVENANCE_KEYS) {
    const val = extractNamespacedValue(xmpXml, "sportsdesk", key)
    if (val !== null) raw[`sportsdesk:${key}`] = val
  }

  for (const key of EXTENDED_SPORTSDESK_KEYS) {
    const val = extractNamespacedValue(xmpXml, "sportsdesk", key)
    if (val !== null) raw[`sportsdesk:${key}`] = val
  }

  for (const key of DC_SCALAR_KEYS) {
    const val = extractNamespacedValue(xmpXml, "dc", key)
    if (val !== null) raw[`dc:${key}`] = val
  }

  for (const key of XMP_CORE_KEYS) {
    const val = extractNamespacedValue(xmpXml, "xmp", key)
    if (val !== null) raw[`xmp:${key}`] = val
  }

  const subjects = extractDcSubjects(xmpXml)
  if (subjects.length > 0) {
    raw["dc:subject"] = subjects.join(", ")
  }

  return { raw, subjects }
}

function normalizeProvenanceFields(
  raw: Readonly<Record<string, string>>,
  issues: string[],
): ImageProvenanceFields {
  const streamId = cleanText(raw["sportsdesk:streamId"])

  let genU32: number | null = null
  const rawGen = cleanText(raw["sportsdesk:genU32"])
  if (rawGen) {
    if (/^\d+$/.test(rawGen)) {
      const parsed = Number(rawGen)
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
  const rawMerkle = cleanText(raw["sportsdesk:merkleRoot"])
  if (rawMerkle) {
    const clean = rawMerkle.replace(/^0x/i, "").toLowerCase()
    if (/^[0-9a-f]{8,128}$/.test(clean)) {
      merkleRoot = clean
    } else {
      issues.push("invalid_merkleRoot")
    }
  }

  return { streamId, genU32, merkleRoot }
}

function normalizeProvenanceContext(
  raw: Readonly<Record<string, string>>,
  subjects: readonly string[],
): ImageProvenanceContext | undefined {
  const ctx: ImageProvenanceContext = {
    title: cleanText(raw["dc:title"]),
    description: cleanText(raw["dc:description"]),
    creator: cleanText(raw["dc:creator"]),
    rights: cleanText(raw["dc:rights"]),
    creatorTool: cleanText(raw["xmp:CreatorTool"]),
    createDate: cleanText(raw["xmp:CreateDate"]),
    brand: cleanText(raw["sportsdesk:brand"]),
    assetRole: cleanText(raw["sportsdesk:assetRole"]),
    surfaceContext: cleanText(raw["sportsdesk:surfaceContext"]),
    domainContext: cleanText(raw["sportsdesk:domainContext"]),
    tokensVersion: cleanText(raw["sportsdesk:tokensVersion"]),
    sourceSpec: cleanText(raw["sportsdesk:sourceSpec"]),
    palette: cleanText(raw["sportsdesk:palette"]),
    subjects,
  }

  const hasAny =
    ctx.title !== null ||
    ctx.description !== null ||
    ctx.creator !== null ||
    ctx.rights !== null ||
    ctx.creatorTool !== null ||
    ctx.createDate !== null ||
    ctx.brand !== null ||
    ctx.assetRole !== null ||
    ctx.surfaceContext !== null ||
    ctx.domainContext !== null ||
    ctx.tokensVersion !== null ||
    ctx.sourceSpec !== null ||
    ctx.palette !== null ||
    ctx.subjects.length > 0

  return hasAny ? ctx : undefined
}

/**
 * Inspects `sportsdesk:*`, `dc:*`, and `xmp:*` provenance & branding context across WebP
 * (`webp-xmp`), PNG (`png-text`, `png-xmp`), and explicit AVIF (`image/avif`) containers by
 * delegating container walking to `lib/xmp_container.ts`.
 */
export async function inspectImageProvenance(input: BinaryInput): Promise<ImageProvenanceReport> {
  const meta = await extractContainerMetadata(input)
  const channels: ImageProvenanceChannel[] = []
  const raw: Record<string, string> = {}
  const issues: string[] = [...meta.issues]
  let subjects: string[] = []

  if (meta.format === "png") {
    let foundPngText = false
    for (const [k, v] of Object.entries(meta.pngTextEntries)) {
      if (k.startsWith("sportsdesk:") || k.startsWith("dc:") || k.startsWith("xmp:")) {
        raw[k] = v
        foundPngText = true
      }
    }
    if (foundPngText) channels.push("png-text")

    if (meta.xmp) {
      const extracted = extractAllKeysFromXmp(meta.xmp)
      const entries = Object.entries(extracted.raw)
      if (entries.length > 0) {
        channels.push("png-xmp")
        for (const [k, v] of entries) raw[k] = v
      }
      subjects = extracted.subjects
    }
  } else if (meta.format === "webp" && meta.xmp) {
    const extracted = extractAllKeysFromXmp(meta.xmp)
    const entries = Object.entries(extracted.raw)
    if (entries.length > 0) {
      channels.push("webp-xmp")
      for (const [k, v] of entries) raw[k] = v
    }
    subjects = extracted.subjects
  } else if (meta.format === "avif" && meta.xmp) {
    const extracted = extractAllKeysFromXmp(meta.xmp)
    for (const [k, v] of Object.entries(extracted.raw)) raw[k] = v
    subjects = extracted.subjects
  }

  const fields = normalizeProvenanceFields(raw, issues)
  const context = normalizeProvenanceContext(raw, subjects)
  const available = meta.format !== "unknown"

  return {
    available,
    format: meta.format === "unknown" ? null : meta.format,
    width: meta.width,
    height: meta.height,
    byteLength: meta.byteLength,
    channels,
    fields,
    ...(context ? { context } : {}),
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
 * Fetches a bounded prefix (or full image up to `maxBytes`) from a public R2 URL and runs
 * `inspectImageProvenance` via `lib/binary.ts` + `lib/xmp_container.ts`.
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
