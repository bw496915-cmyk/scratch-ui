import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
test("scheduled projection preserves observation time when unchanged and last good metrics on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "customer-history-projection-"))
  directories.push(directory)
  const source = join(directory, "graded.json"),
    output = join(directory, "history.json")
  const rows = [
    {
      CustomerID: "ACCOUNT1",
      TicketNumber: "T1",
      WagerNumber: "W1",
      AmountWagered: "10000",
      AmountWon: "9000",
      AmountLost: "0",
      AmountRefunded: "0",
      WagerStatus: "W",
      FreePlayFlag: "N",
      AcceptedDateTime: "2026-11-10 12:00:00",
      TicketWriter: "Internet",
    },
  ]
  await Bun.write(source, JSON.stringify(rows))
  async function run() {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "run",
        "scripts/project_customer_history.ts",
        "--source",
        source,
        "--out",
        output,
        "--if-changed",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout }
  }
  const first = await run()
  expect(first.exitCode).toBe(0)
  expect(JSON.parse(first.stdout).status).toBe("updated")
  const original = await Bun.file(output).text(),
    originalStamp = (await stat(output)).mtimeMs
  expect((await stat(output)).mode & 0o777).toBe(0o600)
  const second = await run()
  expect(second.exitCode).toBe(0)
  expect(JSON.parse(second.stdout).status).toBe("unchanged")
  expect(await Bun.file(output).text()).toBe(original)
  expect((await stat(output)).mtimeMs).toBe(originalStamp)
  await Bun.write(source, JSON.stringify([{ ...rows[0], AmountWagered: "20000" }]))
  expect(JSON.parse((await run()).stdout).status).toBe("updated")
  expect((await Bun.file(output).json()).records[0].metrics.meanStakeUsd).toBe(200)
  const lastGood = await Bun.file(output).text()
  await Bun.write(source, "{invalid")
  expect((await run()).exitCode).not.toBe(0)
  expect(await Bun.file(output).text()).toBe(lastGood)
  await Bun.write(source, JSON.stringify(rows))
  await Bun.write(output, "{}")
  expect(JSON.parse((await run()).stdout).status).toBe("updated")
})
