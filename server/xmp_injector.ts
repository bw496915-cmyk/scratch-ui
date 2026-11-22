/**
 * @file server/xmp_injector.ts
 * @description Compatibility facade delegating to `lib/xmp_container.ts` so there is
 * one authoritative RIFF/PNG/AVIF container implementation across server and library code.
 */
export {
  type ContainerMetadataSnapshot,
  type ExtractedAvifInfo,
  type ExtractedPngMetadata,
  type ExtractedWebpXmp,
  extractAvifMetadata,
  extractContainerMetadata,
  extractPngMetadata,
  extractPngXmp,
  extractWebpXmp,
  injectPngXmp,
  injectWebpXmp,
  injectXmp,
  injectXmpIntoBlob,
  PNG_SIGNATURE,
  type SniffedImageFormat,
  type SniffedImageInfo,
  sniffImageFormat,
  sniffImageInfo,
  VP8X_FLAG_ALPHA,
  VP8X_FLAG_XMP,
  XMP_CONTAINER_MATRIX,
  XMP_PNG_KEYWORD,
  XMP_PNG_PREFIX,
  type XmpContainerHandlingRow,
} from "../lib/xmp_container.ts"
