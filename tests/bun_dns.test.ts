import { expect, test } from "bun:test"

test("prefetches a configured hostname once and the next local connection hits Bun's cache", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
        import assert from "node:assert/strict"
        import { prefetchBunDnsOrigins, readBunDnsCacheStats } from "./server/bun_dns.ts"
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
        try {
          const origin = "http://localhost:" + server.port
          prefetchBunDnsOrigins([origin, origin + "/api", server.url.href])
          const deadline = performance.now() + 1500
          while (readBunDnsCacheStats().size === 0 && performance.now() < deadline) {
            await Bun.sleep(10)
          }
          const prefetched = readBunDnsCacheStats()
          assert.equal(prefetched.totalCount, 1)
          assert.equal(prefetched.size, 1)
          const response = await fetch(origin, { proxy: false, signal: AbortSignal.timeout(3000) })
          assert.equal(await response.text(), "ok")
          assert.equal(readBunDnsCacheStats().cacheHitsCompleted, 1)
        } finally {
          await server.stop(true)
        }
      `,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(exit, stderr).toBe(0)
})
