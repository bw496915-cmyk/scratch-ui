const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(`Check the local SportsDesk package registry.

Usage: bun run registry:check
Examples:
  bun run registry:start
  bun run registry:check`)
} else if (args.length > 0) {
  console.error("Unknown argument. Run bun run registry:check --help.")
  process.exitCode = 2
} else {
  try {
    const response = await fetch("http://127.0.0.1:4873/-/ping", {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    console.log("PASS: local registry responds at http://127.0.0.1:4873")
  } catch (error: unknown) {
    console.error(
      `FAIL: local registry unavailable: ${error instanceof Error ? error.message : String(error)}. Run bun run registry:install, then bun run registry:start.`,
    )
    process.exitCode = 1
  }
}
