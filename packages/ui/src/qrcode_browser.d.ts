declare module "qrcode/lib/browser.js" {
  export function create(
    text: string,
    options: { readonly errorCorrectionLevel: "L" | "M" | "Q" | "H" },
  ): { readonly modules: { readonly size: number; readonly data: Uint8Array } }
}
