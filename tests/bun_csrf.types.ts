import type { CSRF, CSRFAlgorithm, CSRFGenerateOptions, CSRFVerifyOptions } from "bun"

type Equal<Actual, Expected> =
  (<Type>() => Type extends Actual ? 1 : 2) extends <Type>() => Type extends Expected ? 1 : 2
    ? true
    : false

type Assert<Condition extends true> = Condition

type ExpectedAlgorithm = "blake2b256" | "blake2b512" | "sha256" | "sha384" | "sha512" | "sha512-256"
type ExpectedEncoding = "base64" | "base64url" | "hex"

interface ExpectedGenerateOptions {
  expiresIn?: number
  encoding?: ExpectedEncoding
  algorithm?: ExpectedAlgorithm
  sessionId?: string
}

interface ExpectedVerifyOptions {
  secret?: string
  encoding?: ExpectedEncoding
  algorithm?: ExpectedAlgorithm
  maxAge?: number
  sessionId?: string
}

export type BunCsrfTypeContract = [
  Assert<Equal<CSRFAlgorithm, ExpectedAlgorithm>>,
  Assert<Equal<CSRFGenerateOptions, ExpectedGenerateOptions>>,
  Assert<Equal<CSRFVerifyOptions, ExpectedVerifyOptions>>,
  Assert<
    Equal<typeof CSRF.generate, (secret?: string, options?: ExpectedGenerateOptions) => string>
  >,
  Assert<Equal<typeof CSRF.verify, (token: string, options?: ExpectedVerifyOptions) => boolean>>,
]
