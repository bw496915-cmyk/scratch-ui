function getCsrfToken(): string {
  if (typeof document === "undefined") return ""
  const match = document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1] ?? "") : ""
}

export function apiPostHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const csrf = getCsrfToken()
  if (csrf) {
    headers["x-csrf-token"] = csrf
  }
  return headers
}
