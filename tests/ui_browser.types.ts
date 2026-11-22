// Compiled by packages/ui/tsconfig.json, not the Bun/server TypeScript program.
import type logo from "../packages/ui/src/logo.svg"

type Expect<T extends true> = T
export type BrowserSvgIsAUrl = Expect<typeof logo extends string ? true : false>

// @ts-expect-error A Bun-only API cannot be called from the browser program.
export type BrowserCannotUseBun = typeof Bun

// @ts-expect-error Browser code must not assume that Node's process is available.
export type BrowserCannotUseProcess = typeof process
