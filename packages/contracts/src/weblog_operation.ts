export const WEBLOG_OPERATIONS = {
  BOT_BLOCK_LINE_ST: { event: "API", label: "Bot line block" },
  LOGIN_SUCCESS: { event: "Login", label: "Successful login" },
  LOGIN_TOKEN: { event: "Login", label: "Successful token login" },
  API_BLOCK_BET: { event: "API", label: "Bet block" },
  RATE_LIMIT: { event: "API", label: "Rate limit" },
  API_LOG: { event: "API", label: "API log" },
  API_BET: { event: "API", label: "API bet description" },
  API_TICKET: { event: "API", label: "API ticket reference" },
  API_ROUND_ROBIN: { event: "API", label: "API round robin" },
  API_PARLAY: { event: "API", label: "API parlay" },
  API_PARLAY_DESCRIPTION: { event: "API", label: "API parlay description" },
  TEAM_CHOSEN: { event: "Wager", label: "Team selection recorded" },
  WAGER_ACCEPTED: { event: "Wager", label: "Wager acceptance message" },
  VIEW: { event: "Access", label: "View recorded" },
  LINES_DISPLAYED: { event: "Access", label: "Lines displayed" },
  CASINO_ENTRY: { event: "Access", label: "Live casino entry" },
  OPEN_WAGER_EDIT: { event: "Wager", label: "Open wager edit" },
  LINE_CHANGE: { event: "Wager", label: "Line change" },
  WAGER_LIMIT: { event: "Wager", label: "Maximum wager message" },
  TEASER_ACCEPTED: { event: "Wager", label: "Teaser acceptance message" },
  ROUND_ROBIN_SELECTION: { event: "Wager", label: "Round robin selections" },
  ROUND_ROBIN_ACTIVITY: { event: "Wager", label: "Round robin activity" },
  SELECTION_LIMIT: { event: "Wager", label: "Game selection limit" },
  CUSTOMER_MESSAGE: { event: "Access", label: "Customer message popup" },
  SKIN_CHANGE: { event: "Access", label: "Portal skin change" },
  OTHER: { event: "Access", label: "Other access operation" },
} as const

export type WebLogEventKind = keyof typeof WEBLOG_OPERATIONS
export type WebLogEvent = (typeof WEBLOG_OPERATIONS)[WebLogEventKind]["event"]

export const WEBLOG_ACTION_DICTIONARY: Record<
  WebLogEventKind,
  { marker: string; meaning: string }
> = {
  BOT_BLOCK_LINE_ST: {
    marker: "BOT BLOCK LINE ST",
    meaning:
      "A bot-line block was logged. A bot key can identify the requested game and selection.",
  },
  LOGIN_SUCCESS: { marker: "Login successful", meaning: "The source recorded a successful login." },
  LOGIN_TOKEN: {
    marker: "Login successful Token",
    meaning: "The source recorded a successful token login. Refresh status is unknown.",
  },
  API_BLOCK_BET: { marker: "BLOCK BET", meaning: "The source logged a blocked bet request." },
  RATE_LIMIT: {
    marker: "Rate limit or HTTP 429",
    meaning: "The action text contains a rate-limit marker.",
  },
  API_LOG: {
    marker: "API LOG | …",
    meaning: "An API-marked message without a more specific label in the dictionary.",
  },
  API_BET: {
    marker: "API LOG | Bet : …",
    meaning: "A bet description may contain a period, market, or pick. Acceptance is unverified.",
  },
  API_TICKET: {
    marker: "API LOG | Ticket: …",
    meaning: "The API message names a ticket. The message gives no settlement result.",
  },
  API_ROUND_ROBIN: {
    marker: "API LOG | ROUND ROBIN",
    meaning: "A round-robin API message, sometimes with a ticket reference.",
  },
  API_PARLAY: {
    marker: "API LOG | PARLAY",
    meaning: "A parlay API message. UPDATE is shown when the marker appears.",
  },
  API_PARLAY_DESCRIPTION: {
    marker: "API LOG | PARLAY : …",
    meaning: "The action includes a multi-leg description. Ticket acceptance is unverified.",
  },
  TEAM_CHOSEN: {
    marker: "Chosen Team | Game Num",
    meaning: "A team selection was logged with a provider game number. Acceptance is unverified.",
  },
  WAGER_ACCEPTED: {
    marker: "Wager Accepted by:",
    meaning: "The source reports wager acceptance. A ticket match requires a separate identifier.",
  },
  VIEW: {
    marker: "View Pending, View Ultra Live, View Daily Figures…",
    meaning:
      "The source recorded a view action. The displayed label identifies the screen when recognized.",
  },
  LINES_DISPLAYED: {
    marker: "Straight, Parlay, or Teaser Lines Displayed",
    meaning: "The source reports displaying lines or the teaser list.",
  },
  CASINO_ENTRY: {
    marker: "Enter live casino",
    meaning: "The source recorded a live-casino entry action.",
  },
  OPEN_WAGER_EDIT: {
    marker: "Set Open Parlay, Set Open Teaser, Set Picks…",
    meaning: "The source recorded edits to an open parlay or teaser.",
  },
  LINE_CHANGE: {
    marker: "CHANGE LINE … / POINT or PRICE",
    meaning:
      "The message identifies a line or price change. The initiating actor and execution layer are unverified.",
  },
  WAGER_LIMIT: {
    marker: "Maximum wager amount for this selection",
    meaning: "The source recorded a limit message for a selection.",
  },
  TEASER_ACCEPTED: {
    marker: "Teaser Bets (…) Accepted",
    meaning: "The source reports teaser acceptance.",
  },
  ROUND_ROBIN_SELECTION: {
    marker: "Round Robin / Selections",
    meaning: "The source recorded a round-robin selection message.",
  },
  ROUND_ROBIN_ACTIVITY: {
    marker: "Round Robin",
    meaning: "The source recorded round-robin activity without a more specific action label.",
  },
  SELECTION_LIMIT: {
    marker: "… or more games selected are …",
    meaning: "The source recorded a message about the number of selected games.",
  },
  CUSTOMER_MESSAGE: {
    marker: "Show Customer Message popup",
    meaning: "The source recorded the customer-message popup action.",
  },
  SKIN_CHANGE: { marker: "Changed Skin", meaning: "The source recorded a portal skin change." },
  OTHER: {
    marker: "Unrecognized action",
    meaning: "No dictionary rule matched the retained operation.",
  },
}

export interface WebLogClientProfile {
  readonly site: string
  readonly version: string
  readonly count: number
  readonly operations: readonly { readonly kind: WebLogEventKind; readonly count: number }[]
}

export interface WebLogClientSummary {
  readonly rowsWithSiteVersion: number
  readonly siteCount: number
  readonly versionCount: number
  readonly profileCount: number
  readonly profiles: readonly WebLogClientProfile[]
}
