import { expect, test } from "bun:test"

test("generates and verifies a CSRF token with Bun's default secret in the same runtime", () => {
  const token = Bun.CSRF.generate()
  expect(Bun.CSRF.verify(token)).toBe(true)
})
