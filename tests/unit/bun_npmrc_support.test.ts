import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  parseBunLockFile,
  resolveDefaultInstallLinkerStrategy,
  summarizeBunLockFile,
} from "../../packages/contracts/src/bun_lockfile.ts"
import {
  ERR_NPMRC_INVALID_CREDENTIAL,
  ERR_NPMRC_INVALID_SCHEME,
  auditRegistryCredentialMatch,
  buildRegistryCredentialLookupKeys,
  convertNpmrcToBunfigToml,
  expandNpmrcEnvVars,
  matchRegistryCredentials,
  parseBunfigInstallToml,
  parseNpmrc,
  parseNpmrcBoolean,
  resolveBunPackageConfig,
} from "../../packages/contracts/src/npmrc.ts"
import {
  loadBunNpmrcFromDisk,
  loadRedactedNpmrcStatusSummary,
} from "../../packages/api/src/npmrc_loader.ts"
import { createConfigStatusStore } from "../../packages/api/src/config_status.ts"
import { NpmrcSupportSection } from "../../packages/ui/src/panels/NpmrcSupportSection.tsx"

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sportsdesk-npmrc-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("Bun .npmrc support — syntax, env interpolation, and npm booleans", () => {
  test("expands ${NAME} when set, keeps verbatim when unset, and expands ${NAME?} to empty string when unset", () => {
    const env = { SET_VAR: "alpha-123" }
    expect(expandNpmrcEnvVars("${SET_VAR}", env)).toBe("alpha-123")
    expect(expandNpmrcEnvVars("${UNSET_VAR}", env)).toBe("${UNSET_VAR}")
    expect(expandNpmrcEnvVars("${UNSET_VAR?}", env)).toBe("")
    expect(expandNpmrcEnvVars("pre-${SET_VAR}-${UNSET_VAR?}-post", env)).toBe("pre-alpha-123--post")
  })

  test("handles unquoted comments (# and ;), escaped \\# and \\;, and surrounding whitespace", () => {
    const parsed = parseNpmrc(
      [
        "  registry = http://localhost:4873/   # trailing comment",
        "  public-hoist-pattern = *eslint\\#1*\\;bar ; semicolon comment",
        "  //localhost:4873/:email = ignored@example.com # npm ignores email",
      ].join("\n"),
    )

    expect(parsed.registry).toBe("http://localhost:4873/")
    expect(parsed.publicHoistPattern).toEqual(["*eslint#1*;bar"])
    expect(parsed.registryAuth["//localhost:4873/"]?.email).toBe("ignored@example.com")
  })

  test("evaluates npm boolean semantics accurately", () => {
    expect(parseNpmrcBoolean("false")).toBe(false)
    expect(parseNpmrcBoolean("FALSE")).toBe(false)
    expect(parseNpmrcBoolean("null")).toBe(false)
    expect(parseNpmrcBoolean("undefined")).toBe(false)
    expect(parseNpmrcBoolean("0")).toBe(false)

    expect(parseNpmrcBoolean("")).toBe(true)
    expect(parseNpmrcBoolean("1")).toBe(true)
    expect(parseNpmrcBoolean("True")).toBe(true)
    expect(parseNpmrcBoolean("true")).toBe(true)
    expect(parseNpmrcBoolean("yes")).toBe(true)
  })
})

describe("Bun .npmrc support — file discovery, precedence, and install options", () => {
  test("resolves user .npmrc via NPM_CONFIG_USERCONFIG, XDG_CONFIG_HOME, or HOME and merges in exact precedence order", () => {
    const root = createTempDir()
    const home = join(root, "home")
    const xdg = join(root, "xdg")
    const project = join(root, "project")
    mkdirSync(home, { recursive: true })
    mkdirSync(xdg, { recursive: true })
    mkdirSync(project, { recursive: true })

    writeFileSync(
      join(xdg, ".npmrc"),
      [
        "registry=https://xdg.example.com/",
        "cache=./relative-xdg-cache",
        "save-exact=true",
        "//xdg.example.com/:_authToken=xdg-secret-tok",
      ].join("\n"),
    )

    writeFileSync(
      join(project, ".npmrc"),
      [
        "@myorg:registry=https://org.example.com/team/a/",
        "link-workspace-packages=true",
        "ignore-scripts=true",
        "dry-run=true",
        "node-linker=pnpm",
        "omit[]=dev",
        "omit[]=optional",
        "include=dev",
        "public-hoist-pattern[]=*eslint*",
        "public-hoist-pattern[]=*prettier*",
        "hoist-pattern=*",
        "hoist=false",
        "ca=-----BEGIN CERTIFICATE-----\\nA\\n-----END CERTIFICATE-----",
        "cafile=./certs/ca.crt",
      ].join("\n"),
    )

    writeFileSync(
      join(project, "bunfig.toml"),
      ["[install]", 'registry = "https://bunfig.example.com/"', "exact = false"].join("\n"),
    )

    const loaded = loadBunNpmrcFromDisk({
      cwd: project,
      projectRoot: project,
      homeDir: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
      },
    })

    // bunfig.toml overrides user .npmrc registry and save-exact
    expect(loaded.resolved.defaultRegistry.url).toBe("https://bunfig.example.com/")
    expect(loaded.resolved.defaultRegistry.source).toBe("project-bunfig")
    expect(loaded.resolved.saveExact).toBe(false)

    // Relative cache resolved relative to the xdg .npmrc directory
    expect(loaded.resolved.cache.dir).toBe(join(xdg, "relative-xdg-cache"))
    // Relative cafile resolved relative to project .npmrc; cafile wins over ca when both set
    expect(loaded.resolved.tls.cafile).toBe(join(project, "certs/ca.crt"))
    expect(loaded.resolved.tls.ca).toEqual([])

    // Install options & include overriding omit
    expect(loaded.resolved.linkWorkspacePackages).toBe(true)
    expect(loaded.resolved.ignoreScripts).toBe(true)
    expect(loaded.resolved.dryRun).toBe(true)
    expect(loaded.resolved.linker).toBe("isolated") // pnpm -> isolated
    expect(loaded.resolved.omittedDependencies).toEqual(["optional"])
    expect(loaded.resolved.publicHoistPattern).toEqual(["*eslint*", "*prettier*"])
    expect(loaded.resolved.hoistPattern).toEqual(["*"])
    expect(loaded.resolved.hoist).toBe(false)

    // NPM_CONFIG_USERCONFIG (relative to cwd) overrides XDG_CONFIG_HOME
    const ciNpmrcDir = join(project, "ci")
    mkdirSync(ciNpmrcDir, { recursive: true })
    writeFileSync(join(ciNpmrcDir, "custom.npmrc"), "cache=false\n")
    const loadedUserConfig = loadBunNpmrcFromDisk({
      cwd: project,
      projectRoot: project,
      homeDir: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        NPM_CONFIG_USERCONFIG: "./ci/custom.npmrc",
      },
    })
    expect(loadedUserConfig.resolved.cache.disabled).toBe(true)
    expect(loadedUserConfig.resolved.cache.dir).toBeNull()
  })

  test("later ca replaces earlier cafile (and vice versa) across .npmrc, bunfig.toml, and CLI", () => {
    const user = parseNpmrc("cafile=~/certs/user.pem", {
      source: "user-npmrc",
      homeDir: "/home/desk",
    })
    const project = parseNpmrc('ca[]="CERT-1"\nca[]="CERT-2"', {
      source: "project-npmrc",
    })

    const merged1 = resolveBunPackageConfig({
      userNpmrc: user,
      projectNpmrc: project,
    })
    expect(merged1.tls.cafile).toBeNull()
    expect(merged1.tls.ca).toEqual(["CERT-1", "CERT-2"])

    const merged2 = resolveBunPackageConfig({
      userNpmrc: user,
      projectNpmrc: project,
      cli: { cafile: "/etc/ssl/override.crt" },
    })
    expect(merged2.tls.cafile).toBe("/etc/ssl/override.crt")
    expect(merged2.tls.ca).toEqual([])
  })

  test("preserves scoped registry with own credentials when --registry points to a different host", () => {
    const project = parseNpmrc(
      [
        "registry=https://registry.npmjs.org/",
        "@private:registry=https://private.example.com/",
        "//private.example.com/:_authToken=priv-tok",
        "@publicmirror:registry=https://mirror.example.com/",
      ].join("\n"),
    )

    const resolved = resolveBunPackageConfig({
      projectNpmrc: project,
      cli: { registry: "https://cli-override.example.org/" },
    })

    // @private has its own credentials -> keeps its config-file registry
    expect(resolved.scopes.private?.url).toBe("https://private.example.com/")
    // @publicmirror has NO own credentials -> follows override
    expect(resolved.scopes.publicmirror?.url).toBe("https://cli-override.example.org/")
  })

  test("supports install-strategy and all node-linker aliases plus NPM_CONFIG_IGNORE_SCRIPTS", () => {
    const linked = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc("install-strategy=linked"),
    })
    expect(linked.linker).toBe("isolated")

    const nm = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc("node-linker=node-modules"),
    })
    expect(nm.linker).toBe("hoisted")

    const envScripts = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc("ignore-scripts=false"),
      env: { NPM_CONFIG_IGNORE_SCRIPTS: "1" },
    })
    expect(envScripts.ignoreScripts).toBe(true)
  })
})

describe("Bun .npmrc support — credential matching & security invariants", () => {
  test("matches credentials by dropping path segments and treating default ports (:443/:80) identically", () => {
    const keys = buildRegistryCredentialLookupKeys(new URL("https://npm.example.com:443/team/a/"))
    expect(keys).toEqual([
      "//npm.example.com/team/a/",
      "//npm.example.com:443/team/a/",
      "//npm.example.com/team/",
      "//npm.example.com:443/team/",
      "//npm.example.com/",
      "//npm.example.com:443/",
    ])

    const config = resolveBunPackageConfig({
      userNpmrc: parseNpmrc(
        [
          "//npm.example.com/:_authToken=root-token",
          "//npm.example.com/team/:_authToken=team-token",
        ].join("\n"),
        { source: "user-npmrc" },
      ),
      projectNpmrc: parseNpmrc("//npm.example.com/team/:_authToken=project-team-token", {
        source: "project-npmrc",
      }),
    })

    // Project .npmrc replaces user .npmrc for same key; drops /a/ to match /team/
    const teamMatch = matchRegistryCredentials(config, {
      kind: "registry",
      targetUrl: "https://npm.example.com:443/team/a/pkg",
    })
    expect(teamMatch.matched).toBe(true)
    expect(teamMatch.authorizationHeader).toBe("Bearer project-team-token")
    expect(teamMatch.matchedPrefix).toBe("//npm.example.com/team/")

    // Unrelated path falls back to root //npm.example.com/
    const rootMatch = matchRegistryCredentials(config, {
      kind: "registry",
      targetUrl: "https://npm.example.com/other/pkg",
    })
    expect(rootMatch.authorizationHeader).toBe("Bearer root-token")
  })

  test("supports username + base64 _password and raw _auth Basic headers", () => {
    const base64Pass = Buffer.from("s3cret!", "utf8").toString("base64")
    const config = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc(
        [
          "//basic.example.com/:username=alice",
          `//basic.example.com/:_password=${base64Pass}`,
          "//raw.example.com/:_auth=YWxpY2U6cmF3",
        ].join("\n"),
      ),
    })

    const m1 = matchRegistryCredentials(config, {
      kind: "registry",
      targetUrl: "https://basic.example.com/pkg",
    })
    expect(m1.scheme).toBe("Basic")
    expect(m1.authorizationHeader).toBe(
      `Basic ${Buffer.from("alice:s3cret!", "utf8").toString("base64")}`,
    )

    const m2 = matchRegistryCredentials(config, {
      kind: "registry",
      targetUrl: "https://raw.example.com/pkg",
    })
    expect(m2.authorizationHeader).toBe("Basic YWxpY2U6cmF3")
  })

  test("applies exact precedence: bunfig/env token win over .npmrc //host/, while //host/ replaces .npmrc registry= inline creds", () => {
    // 1. .npmrc //host/ replaces inline creds inside .npmrc registry= line
    const npmrcReplaced = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc(
        [
          "registry=https://olduser:oldpass@reg.example.com/",
          "//reg.example.com/:_authToken=host-line-token",
        ].join("\n"),
      ),
    })
    const res1 = matchRegistryCredentials(npmrcReplaced, {
      kind: "registry",
      targetUrl: "https://reg.example.com/pkg",
    })
    expect(res1.authorizationHeader).toBe("Bearer host-line-token")

    // 2. bunfig.toml inline scope credential wins over .npmrc //host/ line
    const bunfigWins = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc("//reg.example.com/:_authToken=npmrc-token"),
      projectBunfig: parseBunfigInstallToml(
        [
          "[install.scopes]",
          'myorg = { url = "https://reg.example.com/", token = "$BF_TOK" }',
        ].join("\n"),
        "project-bunfig",
        { BF_TOK: "bunfig-token" },
      ),
    })
    const res2 = matchRegistryCredentials(bunfigWins, {
      kind: "registry",
      targetUrl: "https://reg.example.com/pkg",
      scope: "@myorg",
    })
    expect(res2.authorizationHeader).toBe("Bearer bunfig-token")
    expect(res2.source).toBe("bunfig")

    // 3. BUN_CONFIG_TOKEN wins over .npmrc //host/ line for default registry
    const envWins = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc(
        ["registry=https://reg.example.com/", "//reg.example.com/:_authToken=npmrc-token"].join(
          "\n",
        ),
      ),
      env: { BUN_CONFIG_TOKEN: "env-override-token" },
    })
    const res3 = matchRegistryCredentials(envWins, {
      kind: "registry",
      targetUrl: "https://reg.example.com/pkg",
    })
    expect(res3.authorizationHeader).toBe("Bearer env-override-token")
    expect(res3.source).toBe("env-token")
  })

  test("enforces tarball same-origin, cross-origin HTTPS-only, transitive-none, and publishConfig rules", () => {
    const config = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc(
        [
          "registry=https://registry.example.com/",
          "//registry.example.com/:_authToken=reg-token",
          "//cdn.partner.com/:_authToken=cdn-token",
          "//insecure.partner.com/:_authToken=http-token",
        ].join("\n"),
      ),
    })

    // Same-origin tarball gets registry credentials
    const sameOrigin = matchRegistryCredentials(config, {
      kind: "tarball",
      targetUrl: "https://registry.example.com/foo/-/foo-1.0.0.tgz",
      namedBy: "project",
    })
    expect(sameOrigin.authorizationHeader).toBe("Bearer reg-token")

    // Cross-origin HTTPS tarball with matching .npmrc line gets that line's token
    const crossHttps = matchRegistryCredentials(config, {
      kind: "tarball",
      targetUrl: "https://cdn.partner.com/tarballs/foo-1.0.0.tgz",
      namedBy: "project",
    })
    expect(crossHttps.authorizationHeader).toBe("Bearer cdn-token")

    // Cross-origin HTTP tarball gets NO credentials even if .npmrc has a line
    const crossHttp = matchRegistryCredentials(config, {
      kind: "tarball",
      targetUrl: "http://insecure.partner.com/tarballs/foo-1.0.0.tgz",
      namedBy: "project",
    })
    expect(crossHttp.matched).toBe(false)

    // Cross-origin HTTPS tarball with NO .npmrc line never leaks registry token
    const crossUnknown = matchRegistryCredentials(config, {
      kind: "tarball",
      targetUrl: "https://evil.example.net/foo-1.0.0.tgz",
      namedBy: "project",
    })
    expect(crossUnknown.matched).toBe(false)

    // Transitive tarball URL receives NO configured credentials
    const transitive = matchRegistryCredentials(config, {
      kind: "tarball",
      targetUrl: "https://cdn.partner.com/tarballs/foo-1.0.0.tgz",
      namedBy: "transitive",
    })
    expect(transitive.matched).toBe(false)

    // publishConfig.registry: HTTPS-only .npmrc match, no env var expansion
    const pubHttps = matchRegistryCredentials(config, {
      kind: "publishConfig",
      targetUrl: "https://cdn.partner.com/npm/",
    })
    expect(pubHttps.authorizationHeader).toBe("Bearer cdn-token")

    const pubHttp = matchRegistryCredentials(config, {
      kind: "publishConfig",
      targetUrl: "http://insecure.partner.com/npm/",
    })
    expect(pubHttp.matched).toBe(false)

    // Unexpanded env syntax in publishConfig.registry fails URL validation cleanly
    const pubUnexpanded = auditRegistryCredentialMatch(config, {
      kind: "publishConfig",
      targetUrl: "${CUSTOM_PUBLISH_URL}",
    })
    expect(pubUnexpanded.matched).toBe(false)
    expect(pubUnexpanded.error).toContain(ERR_NPMRC_INVALID_SCHEME)
  })

  test("rejects unsupported URL schemes and newline/NUL characters in credentials", () => {
    expect(() => parseNpmrc("registry=ftp://files.example.com/")).toThrow(ERR_NPMRC_INVALID_SCHEME)
    expect(() => parseNpmrc("registry=not-a-url")).toThrow(ERR_NPMRC_INVALID_SCHEME)
    expect(() =>
      parseNpmrc("//npm.example.com/:_authToken=${BAD_TOK}", {
        env: { BAD_TOK: "tok\r\nX-Injected: 1" },
      }),
    ).toThrow(ERR_NPMRC_INVALID_CREDENTIAL)
    expect(() =>
      parseNpmrc("//npm.example.com/:_authToken=${NUL_TOK}", {
        env: { NUL_TOK: "tok\0null" },
      }),
    ).toThrow(ERR_NPMRC_INVALID_CREDENTIAL)
  })
})

describe("Bun .npmrc support — redaction, bunfig.toml migration, Status API & UI", () => {
  test("never leaks raw tokens in bunfig migration output, redacted disk summary, or ConfigStatusStore", () => {
    const secretToken = "npm_SUPER_SECRET_LIVE_TOKEN_987654"
    const resolved = resolveBunPackageConfig({
      projectNpmrc: parseNpmrc(
        [
          "registry=http://localhost:4873/",
          "@myorg:registry=https://npm.example.com/team/a/",
          "//npm.example.com/team/:_authToken=${MY_ORG_TOKEN}",
          "ignore-scripts=true",
          "save-exact=true",
          "node-linker=isolated",
        ].join("\n"),
        { env: { MY_ORG_TOKEN: secretToken } },
      ),
    })

    const toml = convertNpmrcToBunfigToml(resolved)
    expect(toml).toContain('registry = "http://localhost:4873/"')
    expect(toml).toContain("ignoreScripts = true")
    expect(toml).toContain("exact = true")
    expect(toml).toContain('linker = "isolated"')
    expect(toml).toContain('token = "$MY_ORG_TOKEN"')
    expect(toml).not.toContain(secretToken)

    const store = createConfigStatusStore({
      env: {
        BUN_CONFIG_TOKEN: secretToken,
        NPM_CONFIG_TOKEN: secretToken,
      },
    })
    const snapshot = store.getSnapshot()
    expect(snapshot.npmrc).toBeDefined()
    expect(JSON.stringify(snapshot)).not.toContain(secretToken)
  })

  test("NpmrcSupportSection renders precedence stack, workspace policy, migrator, and credential inspector", () => {
    const summary = loadRedactedNpmrcStatusSummary()
    const html = renderToStaticMarkup(React.createElement(NpmrcSupportSection, { summary }))
    expect(html).toContain('data-status-view="npmrc"')
    expect(html).toContain("Bun Configuration Precedence Order")
    expect(html).toContain("Resolved Workspace Package Policy")
    expect(html).toContain("Supply-Chain Security")
    expect(html).toContain("Lockfile Policy")
    expect(html).toContain("[run] Process &amp; Shell")
    expect(html).toContain("noOrphans=true")
    expect(html).toContain("Interactive .npmrc Validator")
    expect(html).toContain("Generated bunfig.toml Equivalent")
    expect(html).toContain("Credential Matching Inspector")
  })
})

describe("Bun bunfig.toml Package Manager & [run] configuration", () => {
  test("parses full [install], [install.lockfile], [install.cache], [install.security], and [run] sections", () => {
    const parsed = parseBunfigInstallToml(
      [
        "[install]",
        "optional = false",
        "dev = true",
        "peer = false",
        "production = true",
        "exact = true",
        "saveTextLockfile = false",
        'auto = "fallback"',
        'linker = "isolated"',
        "globalStore = true",
        "minimumReleaseAge = 259200",
        'minimumReleaseAgeExcludes = ["react@19.0.0", "zod@3.24.0"]',
        'publicHoistPattern = ["*eslint*", "*prettier*"]',
        'hoistPattern = "*"',
        "",
        "[install.lockfile]",
        "save = true",
        'print = "yarn"',
        "",
        "[install.cache]",
        'dir = "~/.bun/install/cache"',
        "disable = false",
        "disableManifest = true",
        "",
        "[install.security]",
        'scanner = "@oven/bun-security-scanner"',
        "",
        "[run]",
        'shell = "bun"',
        "bun = true",
        "silent = true",
        "noOrphans = true",
      ].join("\n"),
      "project-bunfig",
    )

    const resolved = resolveBunPackageConfig({ projectBunfig: parsed })

    // production = true skips devDependencies and implicitly enables frozenLockfile
    expect(resolved.installDeps).toEqual({
      optional: false,
      dev: false,
      peer: false,
      production: true,
    })
    expect(resolved.omittedDependencies).toEqual(["dev", "peer", "optional"])
    expect(resolved.lockfile).toEqual({
      save: true,
      saveTextLockfile: false,
      frozenLockfile: true,
      print: "yarn",
    })
    expect(resolved.autoInstall).toBe("fallback")
    expect(resolved.cache.disableManifest).toBe(true)
    expect(resolved.cache.dir).toBe("~/.bun/install/cache")
    expect(resolved.security).toEqual({
      minimumReleaseAge: 259200,
      minimumReleaseAgeExcludes: ["react@19.0.0", "zod@3.24.0"],
      scanner: "@oven/bun-security-scanner",
    })
    expect(resolved.publicHoistPattern).toEqual(["*eslint*", "*prettier*"])
    expect(resolved.hoistPattern).toEqual(["*"])
    expect(resolved.run).toEqual({
      shell: "bun",
      bun: true,
      silent: true,
      noOrphans: true,
    })

    const emittedToml = convertNpmrcToBunfigToml(resolved)
    expect(emittedToml).toContain("production = true")
    expect(emittedToml).toContain("frozenLockfile = true")
    expect(emittedToml).toContain('auto = "fallback"')
    expect(emittedToml).toContain('print = "yarn"')
    expect(emittedToml).toContain("disableManifest = true")
    expect(emittedToml).toContain('scanner = "@oven/bun-security-scanner"')
    expect(emittedToml).toContain("noOrphans = true")
    expect(emittedToml).toContain('shell = "bun"')
    expect(emittedToml).toContain("bun = true")
    expect(emittedToml).toContain("silent = true")
  })

  test("honors install.globalDir and install.globalBinDir only from global bunfig.toml or env, ignoring project-local overrides", () => {
    const globalBf = parseBunfigInstallToml(
      ["[install]", 'globalDir = "~/.bun/install/global"', 'globalBinDir = "~/.bun/bin"'].join(
        "\n",
      ),
      "global-bunfig",
    )
    const projectBf = parseBunfigInstallToml(
      [
        "[install]",
        'globalDir = "/tmp/should-be-ignored"',
        'globalBinDir = "/tmp/bin-ignored"',
      ].join("\n"),
      "project-bunfig",
    )

    const resolved = resolveBunPackageConfig({
      globalBunfig: globalBf,
      projectBunfig: projectBf,
    })

    expect(resolved.globalInstall.globalDir).toBe("~/.bun/install/global")
    expect(resolved.globalInstall.globalBinDir).toBe("~/.bun/bin")
    expect(resolved.warnings.some((w) => w.key === "install.globalDir")).toBe(true)
    expect(resolved.warnings.some((w) => w.key === "install.globalBinDir")).toBe(true)

    // Env vars BUN_INSTALL_GLOBAL_DIR and BUN_INSTALL_BIN override global bunfig
    const envOverridden = resolveBunPackageConfig({
      globalBunfig: globalBf,
      env: {
        BUN_INSTALL_GLOBAL_DIR: "/opt/bun/global",
        BUN_INSTALL_BIN: "/opt/bun/bin",
      },
    })
    expect(envOverridden.globalInstall.globalDir).toBe("/opt/bun/global")
    expect(envOverridden.globalInstall.globalBinDir).toBe("/opt/bun/bin")
  })

  test("workspace bunfig.toml enables ignoreScripts, minimumReleaseAge, lockfile.save, and run.noOrphans", () => {
    const summary = loadRedactedNpmrcStatusSummary()
    expect(summary.options.ignoreScripts).toBe(true)
    expect(summary.options.globalStore).toBe(true)
    expect(summary.options.minimumReleaseAge).toBe("3d")
    expect(summary.options.lockfileSave).toBe(true)
    expect(summary.options.runNoOrphans).toBe(true)
  })
})

describe("BunLockFile (bun.lock) & install linker strategy", () => {
  test("parses JSONC bun.lock with comments, trailing commas, and full metadata maps", () => {
    const rawJsonc = `{
      // Bun text lockfile sample
      "lockfileVersion": 2,
      "configVersion": 1,
      /* Workspace topology */
      "workspaces": {
        "": {
          "name": "monorepo-root",
          "dependencies": { "zod": "^3.24.0" },
        },
        "packages/core": {
          "name": "@acme/core",
          "version": "1.2.0",
          "devDependencies": { "typescript": "^5.8.0" },
        },
      },
      "overrides": { "ws": "8.18.0", },
      "trustedDependencies": ["esbuild",],
      "patchedDependencies": {
        "left-pad@1.3.0": "patches/left-pad+1.3.0.patch",
      },
      "catalog": { "react": "19.0.0", },
      "packages": {
        "esbuild": ["esbuild@0.25.0", "", { "hasInstallScript": true }, "sha512-abc"],
        "@esbuild/linux-x64": ["@esbuild/linux-x64@0.25.0", "", { "os": "linux", "cpu": "x64", "libc": "glibc" }, "sha512-def"],
        "zod": ["zod@3.24.0", "", {}, "sha512-ghi"],
      },
    }`

    const lockfile = parseBunLockFile(rawJsonc)
    expect(lockfile.lockfileVersion).toBe(2)
    expect(lockfile.configVersion).toBe(1)
    expect(Object.keys(lockfile.workspaces)).toEqual(["", "packages/core"])

    const summary = summarizeBunLockFile(lockfile)
    expect(summary.isWorkspaceProject).toBe(true)
    expect(summary.workspaceCount).toBe(2)
    expect(summary.packageCount).toBe(3)
    expect(summary.hasInstallScriptCount).toBe(1)
    expect(summary.hasInstallScriptPackages).toEqual(["esbuild"])
    expect(summary.libcNativePackageCount).toBe(1)
    expect(summary.overrideCount).toBe(1)
    expect(summary.trustedDependencyCount).toBe(1)
    expect(summary.patchedDependencyCount).toBe(1)
    expect(summary.catalogCount).toBe(1)
    expect(summary.defaultLinkerStrategy).toBe("isolated")
  })

  test("resolves default install linker strategy accurately across configVersion 0, unset, and 1", () => {
    const legacyV0 = resolveDefaultInstallLinkerStrategy({
      lockfileVersion: 2,
      configVersion: 0,
      workspaces: { "": { name: "root" }, "packages/a": { name: "a" } },
    })
    expect(legacyV0.linker).toBe("hoisted")
    expect(legacyV0.isWorkspaceProject).toBe(true)

    const legacyUnset = resolveDefaultInstallLinkerStrategy({
      lockfileVersion: 1,
      workspaces: { "": { name: "root" }, "packages/a": { name: "a" } },
    })
    expect(legacyUnset.linker).toBe("hoisted")

    const singlePkgV1 = resolveDefaultInstallLinkerStrategy({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: { "": { name: "single-app" } },
    })
    expect(singlePkgV1.linker).toBe("hoisted")
    expect(singlePkgV1.isWorkspaceProject).toBe(false)

    const monorepoV1 = resolveDefaultInstallLinkerStrategy({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: { "": { name: "root" }, "packages/ui": { name: "ui" } },
    })
    expect(monorepoV1.linker).toBe("isolated")
    expect(monorepoV1.isWorkspaceProject).toBe(true)
  })

  test("applies precedence: bun.lock configVersion default < .npmrc < bunfig.toml < CLI --linker", () => {
    const monorepoLockfile = parseBunLockFile(
      JSON.stringify({
        lockfileVersion: 2,
        configVersion: 1,
        workspaces: { "": { name: "root" }, "packages/api": { name: "api" } },
      }),
    )

    const fromLockfile = resolveBunPackageConfig({ bunLockfile: monorepoLockfile })
    expect(fromLockfile.linker).toBe("isolated")
    expect(fromLockfile.linkerSource).toBe("bun-lockfile")
    expect(fromLockfile.layersApplied).toContain("bun-lockfile")

    const fromNpmrc = resolveBunPackageConfig({
      bunLockfile: monorepoLockfile,
      projectNpmrc: parseNpmrc("node-linker=hoisted\n", { source: "project-npmrc" }),
    })
    expect(fromNpmrc.linker).toBe("hoisted")
    expect(fromNpmrc.linkerSource).toBe("project-npmrc")

    const fromBunfig = resolveBunPackageConfig({
      bunLockfile: monorepoLockfile,
      projectNpmrc: parseNpmrc("node-linker=hoisted\n", { source: "project-npmrc" }),
      projectBunfig: parseBunfigInstallToml('[install]\nlinker = "isolated"\n', "project-bunfig"),
    })
    expect(fromBunfig.linker).toBe("isolated")
    expect(fromBunfig.linkerSource).toBe("project-bunfig")

    const fromCli = resolveBunPackageConfig({
      bunLockfile: monorepoLockfile,
      projectBunfig: parseBunfigInstallToml('[install]\nlinker = "isolated"\n', "project-bunfig"),
      cli: { linker: "hoisted" },
    })
    expect(fromCli.linker).toBe("hoisted")
    expect(fromCli.linkerSource).toBe("cli")
  })

  test("loads workspace bun.lock on disk, resolves isolated linker, traces configVersion, and renders BunLockFile UI card", () => {
    const summary = loadRedactedNpmrcStatusSummary({
      homeDir: join(process.cwd(), "tests", "fixtures"),
      env: {},
    })
    expect(summary.lockfileSummary).not.toBeNull()
    expect(summary.lockfileSummary?.lockfileVersion).toBeGreaterThanOrEqual(2)
    expect(summary.lockfileSummary?.configVersion).toBe(1)
    expect(summary.lockfileSummary?.workspaceCount).toBe(5)
    expect(summary.lockfileSummary?.isWorkspaceProject).toBe(true)
    expect(summary.lockfileSummary?.defaultLinkerStrategy).toBe("isolated")
    expect(summary.lockfileSummary?.hasInstallScriptCount).toBeGreaterThan(0)
    expect(summary.lockfileSummary?.libcNativePackageCount).toBeGreaterThan(0)
    expect(summary.options.linker).toBe("isolated")
    expect(summary.options.linkerSource).toBe("bun-lockfile")
    expect(summary.layers.some((l) => l.layer === "bun-lockfile" && l.detected)).toBe(true)

    const store = createConfigStatusStore()
    const snapshot = store.getSnapshot()
    expect(snapshot.items.some((item) => item.key === "BUN_LOCKFILE.configVersion")).toBe(true)
    expect(snapshot.items.some((item) => item.key === "BUN_LOCKFILE.lockfileVersion")).toBe(true)

    const html = renderToStaticMarkup(React.createElement(NpmrcSupportSection, { summary }))
    expect(html).toContain('data-bun-lockfile-panel="true"')
    expect(html).toContain("Install Linker Strategy")
    expect(html).toContain("Effective linker: isolated (bun-lockfile)")
    expect(html).toContain("packages/contracts")
  })
})
