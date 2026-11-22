// Render measured status as text rather than inserting HTML.
function setSummary(tone, label, detail) {
  const summary = document.getElementById("summary")
  const dot = document.createElement("span")
  dot.className = tone
  dot.textContent = "\u25cf "
  dot.setAttribute("aria-hidden", "true")
  const text = document.createElement("strong")
  text.textContent = label
  summary.replaceChildren(dot, text)
  if (detail) {
    const rest = document.createElement("span")
    rest.textContent = " \u2014 " + detail
    summary.appendChild(rest)
  }
}

fetch("/api/status", { cache: "no-store" })
  .then((r) => r.json())
  .then((d) => {
    const failed = Object.entries(d.checks || {})
      .filter(([, state]) => state !== "ok")
      .map(([name]) => name)
    setSummary(
      d.ok && d.daemon4020?.state === "online" ? "ok" : "bad",
      d.ok && d.daemon4020?.state === "online" ? "serving" : "degraded",
      d.daemon4020?.reason || (failed.length > 0 ? "failed checks: " + failed.join(", ") : ""),
    )
    document.getElementById("payload").textContent = JSON.stringify(d, null, 2)
  })
  .catch((e) => {
    setSummary("bad", "unreachable", String(e))
    document.getElementById("payload").textContent = String(e)
  })
