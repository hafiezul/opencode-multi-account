import { Auth } from "../../auth"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider/models"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import type { Hooks } from "@opencode-ai/plugin"
import { Process } from "../../util/process"
import { text } from "node:stream/consumers"

type PluginAuth = NonNullable<Hooks["auth"]>

type Entry = {
  id: string
  active?: string
  profiles: Array<{
    name: string
    type: Auth.Info["type"]
    active: boolean
  }>
}

export function formatProviderLabel(input: { id: string; name?: string }) {
  if (!input.name || input.name === input.id) return input.id
  return `${input.name} ${UI.Style.TEXT_DIM}${input.id}`
}

export function formatProfileLine(input: { name: string; type: Auth.Info["type"]; active: boolean }) {
  return `  ${input.active ? "●" : "○"} ${input.name} ${UI.Style.TEXT_DIM}${input.type}${input.active ? " (active)" : ""}`
}

export function getLogoutMode(input: { total: number; profile?: string; all?: boolean }) {
  if (input.all && input.profile) return "invalid" as const
  if (input.all) return "provider" as const
  if (input.profile) return "profile" as const
  return input.total <= 1 ? ("provider" as const) : ("prompt" as const)
}

export function getProviderNames(input: {
  database: Record<string, { name?: string }>
  config?: { provider?: Record<string, { name?: string }> }
}) {
  return {
    ...Object.fromEntries(Object.entries(input.database).map(([id, x]) => [id, x.name])),
    ...Object.fromEntries(
      Object.entries(input.config?.provider ?? {})
        .filter(([, x]) => x.name !== undefined)
        .map(([id, x]) => [id, x.name]),
    ),
  }
}

export const all = Symbol("all-profiles")

const invalid = Symbol("invalid-provider")

class AmbiguousError extends Error {}

async function saveAuth(provider: string, info: Auth.Info, profile?: string) {
  if (!profile) {
    await Auth.set(provider, info)
    return
  }
  await Auth.put(provider, profile, info)
  await Auth.activate(provider, profile)
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function normalizeHttpUrl(value: string) {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol)) return
    url.search = ""
    url.hash = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url
  } catch {
    return
  }
}

function formatHttpUrl(url: URL) {
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`
}

function getWellKnownUrl(url: URL) {
  const meta = new URL(url)
  meta.pathname = `${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}.well-known/opencode`
  return meta
}

function parseWellKnownAuth(value: unknown) {
  if (!isRecord(value) || !isRecord(value.auth)) return
  const command =
    Array.isArray(value.auth.command) && value.auth.command.every(isString) ? value.auth.command : undefined
  if (!command?.length || command.some((x) => x.trim() === "")) return
  const env = typeof value.auth.env === "string" ? value.auth.env.trim() : ""
  if (!env) return
  return { command, env }
}

async function getWellKnownAuth(url: URL) {
  const meta = getWellKnownUrl(url)
  const res = await fetch(meta).catch(() => undefined)
  if (!res?.ok) return
  const json = await res.json().catch(() => undefined)
  return parseWellKnownAuth(json)
}

function matchProvider(input: { options: Array<{ label: string; value: string }>; value: string }) {
  const byID = input.options.find((x) => x.value === input.value)
  const byName = input.options.find((x) => x.label.toLowerCase() === input.value.toLowerCase())
  return byID ?? byName
}

export function resolveStoredProvider(input: {
  entries: Array<{ id: string }>
  names: Record<string, string | undefined>
  value: string
}) {
  const id = input.entries.find((x) => x.id === input.value)?.id
  if (id) return id
  const matches = input.entries.filter((x) => (input.names[x.id] ?? x.id).toLowerCase() === input.value.toLowerCase())
  if (matches.length > 1) {
    throw new AmbiguousError(
      `Provider name "${input.value}" is ambiguous. Use an exact provider id: ${matches.map((x) => x.id).join(", ")}`,
    )
  }
  return matches[0]?.id
}

function resolveProvider(input: {
  entries: Array<{ id: string }>
  names: Record<string, string | undefined>
  value: string
}) {
  try {
    return resolveStoredProvider(input)
  } catch (err) {
    if (err instanceof AmbiguousError) {
      prompts.log.error(err.message)
      return invalid
    }
    throw err
  }
}

export function getActiveEnv(input: {
  database: Record<string, { env: string[] }>
  names: Record<string, string | undefined>
  env: Record<string, string | undefined>
}) {
  return Object.entries(input.database).flatMap(([id, provider]) =>
    provider.env.filter((envVar) => input.env[envVar]).map((envVar) => ({ provider: input.names[id] ?? id, envVar })),
  )
}

export function hasProfile(input: { profiles: Array<{ name: string }>; value: string }) {
  return input.profiles.some((x) => x.name === input.value)
}

function sortProfiles(input: Record<string, Auth.Info>, active?: string) {
  return Object.entries(input)
    .sort(([a], [b]) => a.localeCompare(b))
    .sort(([a], [b]) => Number(b === active) - Number(a === active))
    .map(([name, info]) => ({
      name,
      type: info.type,
      active: name === active,
    }))
}

async function getEntries(provider?: string): Promise<Entry[]> {
  const data = await Auth.all()
  const ids = provider ? [provider] : Object.keys(data).sort()
  return Promise.all(
    ids.map(async (id) => {
      const item = await Auth.entry(id)
      if (!item) return
      return {
        id,
        active: item.active,
        profiles: sortProfiles(item.profiles, item.active),
      }
    }),
  ).then((x) => x.flatMap((item) => (item ? [item] : [])))
}

function promptProfile(input: { entry: Entry; message: string; includeAll: true }): Promise<string | typeof all>
function promptProfile(input: { entry: Entry; message: string; includeAll?: false | undefined }): Promise<string>
async function promptProfile(input: { entry: Entry; message: string; includeAll?: boolean }) {
  const extra: { label: string; value: typeof all; hint: string } = {
    label: "All profiles",
    value: all,
    hint: "remove provider entry",
  }
  const options: Array<{ label: string; value: string | typeof all; hint: string }> = [
    ...input.entry.profiles.map((x) => ({
      label: `${x.name}${x.active ? " (active)" : ""}`,
      value: x.name,
      hint: x.type,
    })),
    ...(input.includeAll ? [extra] : []),
  ]
  const value = await prompts.select<string | typeof all>({
    message: input.message,
    options,
  })
  if (prompts.isCancel(value)) throw new UI.CancelledError()
  return value
}

async function handlePluginAuth(
  plugin: { auth: PluginAuth },
  provider: string,
  methodName?: string,
  profile?: string,
): Promise<boolean> {
  let index = 0
  if (methodName) {
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      prompts.log.error(
        `Unknown method "${methodName}" for ${provider}. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
      )
      process.exit(1)
    }
    index = match
  } else if (plugin.auth.methods.length > 1) {
    const method = await prompts.select({
      message: "Login method",
      options: [
        ...plugin.auth.methods.map((x, index) => ({
          label: x.label,
          value: index.toString(),
        })),
      ],
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    index = parseInt(method)
  }
  const method = plugin.auth.methods[index]

  await new Promise((r) => setTimeout(r, 10))
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    const authorize = await method.authorize(inputs)

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      const result = await authorize.callback()
      if (result.type === "failed") {
        spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await saveAuth(
            saveProvider,
            {
              type: "oauth",
              refresh,
              access,
              expires,
              ...extraFields,
            },
            profile,
          )
        }
        if ("key" in result) {
          await saveAuth(
            saveProvider,
            {
              type: "api",
              key: result.key,
            },
            profile,
          )
        }
        spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await saveAuth(
            saveProvider,
            {
              type: "oauth",
              refresh,
              access,
              expires,
              ...extraFields,
            },
            profile,
          )
        }
        if ("key" in result) {
          await saveAuth(
            saveProvider,
            {
              type: "api",
              key: result.key,
            },
            profile,
          )
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await saveAuth(
          saveProvider,
          {
            type: "api",
            key: result.key,
          },
          profile,
        )
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  return false
}

export function resolvePluginProviders(input: {
  hooks: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs
      .command(ProvidersListCommand)
      .command(ProvidersStatusCommand)
      .command(ProvidersLoginCommand)
      .command(ProvidersSwitchCommand)
      .command(ProvidersLogoutCommand)
      .demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  builder: (yargs) =>
    yargs.option("provider", {
      alias: ["p"],
      describe: "provider id to inspect",
      type: "string",
    }),
  async handler(args) {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const config = await Config.get()
    const database = await ModelsDev.get()
    const names = getProviderNames({ database, config })
    const all = await getEntries()
    const provider = args.provider ? resolveProvider({ entries: all, names, value: args.provider }) : undefined
    if (provider === invalid) process.exit(1)
    if (args.provider && !provider) {
      prompts.log.error(`No credentials found for ${args.provider}`)
      return
    }
    const results = provider ? all.filter((x) => x.id === provider) : all

    for (const result of results) {
      prompts.log.info(formatProviderLabel({ id: result.id, name: names[result.id] }))
      for (const profile of result.profiles) {
        prompts.log.info(formatProfileLine(profile))
      }
    }

    prompts.outro(`${results.length} provider` + (results.length === 1 ? "" : "s"))

    const activeEnvVars = getActiveEnv({ database, names, env: process.env })

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const ProvidersStatusCommand = cmd({
  command: "status",
  describe: "show provider profile status",
  builder: (yargs) =>
    yargs.option("provider", {
      alias: ["p"],
      describe: "provider id to inspect",
      type: "string",
    }),
  async handler(args) {
    UI.empty()
    const config = await Config.get()
    const database = await ModelsDev.get()
    const names = getProviderNames({ database, config })
    const all = await getEntries()
    const provider = args.provider ? resolveProvider({ entries: all, names, value: args.provider }) : undefined
    if (provider === invalid) process.exit(1)
    if (args.provider && !provider) {
      prompts.log.error(`No credentials found for ${args.provider}`)
      return
    }
    const results = provider ? all.filter((x) => x.id === provider) : all
    if (results.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    for (const result of results) {
      prompts.log.info(formatProviderLabel({ id: result.id, name: names[result.id] }))
      for (const profile of result.profiles) {
        prompts.log.info(formatProfileLine(profile))
      }
    }
    prompts.outro("Done")
  },
})

export const ProvidersLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: "opencode auth provider",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      })
      .option("profile", {
        describe: "profile name to write and activate",
        type: "string",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url && isHttpUrl(args.url)) {
          const url = normalizeHttpUrl(args.url)
          if (!url) {
            prompts.log.error(`Invalid URL: ${args.url}`)
            prompts.outro("Done")
            return
          }
          const auth = await getWellKnownAuth(url)
          if (!auth) {
            prompts.log.error(`Could not load ${getWellKnownUrl(url)}`)
            prompts.outro("Done")
            return
          }
          prompts.log.info(`Running \`${auth.command.join(" ")}\``)
          const proc = Process.spawn(auth.command, {
            stdout: "pipe",
          })
          if (!proc.stdout) {
            prompts.log.error("Auth command did not produce output")
            prompts.outro("Done")
            return
          }
          const [exit, token] = await Promise.all([proc.exited, text(proc.stdout)])
          if (exit !== 0) {
            prompts.log.error("Auth command failed")
            prompts.outro("Done")
            return
          }
          const value = token.trim()
          if (!value) {
            prompts.log.error("Auth command returned an empty token")
            prompts.outro("Done")
            return
          }
          await saveAuth(
            formatHttpUrl(url),
            {
              type: "wellknown",
              key: auth.env,
              token: value,
            },
            args.profile,
          )
          prompts.log.success("Logged into " + formatHttpUrl(url))
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh(true).catch(() => {})

        const config = await Config.get()

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ModelsDev.get().then((x) => {
          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return filtered
        })
        const names = getProviderNames({ database: providers, config })

        const priority: Record<string, number> = {
          opencode: 0,
          openai: 1,
          "github-copilot": 2,
          google: 3,
          anthropic: 4,
          openrouter: 5,
          vercel: 6,
        }
        const pluginProviders = resolvePluginProviders({
          hooks: await Plugin.list(),
          existingProviders: providers,
          disabled,
          enabled,
          providerNames: names,
        })
        const options = [
          ...pipe(
            providers,
            values(),
            sortBy(
              (x) => priority[x.id] ?? 99,
              (x) => x.name ?? x.id,
            ),
            map((x) => ({
              label: formatProviderLabel({ id: x.id, name: names[x.id] }),
              value: x.id,
              hint: {
                opencode: "recommended",
                openai: "ChatGPT Plus/Pro or API key",
              }[x.id],
            })),
          ),
          ...pluginProviders.map((x) => ({
            label: formatProviderLabel(x),
            value: x.id,
            hint: "plugin",
          })),
        ]

        let provider: string
        const input = args.provider ?? args.url
        if (input) {
          const match =
            resolveProvider({
              entries: options.map((x) => ({ id: x.value })),
              names,
              value: input,
            }) ?? matchProvider({ options, value: input })?.value
          if (match === invalid) process.exit(1)
          if (!match) {
            prompts.log.error(`Unknown provider "${input}"`)
            process.exit(1)
          }
          provider = match
        } else {
          const selected = await prompts.autocomplete<string>({
            message: "Select provider",
            maxItems: 8,
            options: [
              ...options,
              {
                value: "other",
                label: "Other",
              },
            ],
          })
          if (prompts.isCancel(selected)) throw new UI.CancelledError()
          provider = selected
        }

        const plugin = await Plugin.list().then((x) => x.findLast((x) => x.auth?.provider === provider))
        if (plugin && plugin.auth) {
          const handled = await handlePluginAuth({ auth: plugin.auth }, provider, args.method, args.profile)
          if (handled) return
        }

        if (provider === "other") {
          const custom = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(custom)) throw new UI.CancelledError()
          provider = custom.replace(/^@ai-sdk\//, "")

          const customPlugin = await Plugin.list().then((x) => x.findLast((x) => x.auth?.provider === provider))
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider, args.method, args.profile)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in opencode.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
              "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
              "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
              "Configure via opencode.json options (profile, region, endpoint) or\n" +
              "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
          )
        }

        if (provider === "opencode") {
          prompts.log.info("Create an api key at https://opencode.ai/auth")
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await saveAuth(
          provider,
          {
            type: "api",
            key,
          },
          args.profile,
        )

        prompts.outro("Done")
      },
    })
  },
})

export const ProvidersSwitchCommand = cmd({
  command: "switch",
  describe: "switch the active provider profile",
  builder: (yargs) =>
    yargs
      .option("provider", {
        alias: ["p"],
        describe: "provider id to switch",
        type: "string",
      })
      .option("profile", {
        describe: "profile name to activate",
        type: "string",
      }),
  async handler(args) {
    UI.empty()
    const config = await Config.get()
    const database = await ModelsDev.get()
    const names = getProviderNames({ database, config })
    const entries = await getEntries()
    if (entries.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const provider = args.provider
      ? (resolveProvider({ entries, names, value: args.provider }) ?? args.provider)
      : await prompts.select({
          message: "Select provider",
          options: entries.map((x) => ({
            label: formatProviderLabel({ id: x.id, name: names[x.id] }),
            value: x.id,
          })),
        })
    if (provider === invalid) process.exit(1)
    if (prompts.isCancel(provider)) throw new UI.CancelledError()
    const entry = entries.find((x) => x.id === provider)
    if (!entry) {
      prompts.log.error(`No credentials found for ${provider}`)
      process.exit(1)
    }
    const profile = args.profile ?? (await promptProfile({ entry, message: "Select profile" }))
    if (!hasProfile({ profiles: entry.profiles, value: profile })) {
      prompts.log.error(`Unknown profile "${profile}" for ${provider}`)
      process.exit(1)
    }
    await Auth.activate(provider, profile)
    prompts.outro(`Switched ${provider} to ${profile}`)
  },
})

export const ProvidersLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  builder: (yargs) =>
    yargs
      .option("provider", {
        alias: ["p"],
        describe: "provider id to remove",
        type: "string",
      })
      .option("profile", {
        describe: "profile name to remove",
        type: "string",
      })
      .option("all", {
        describe: "remove all profiles for the provider",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    UI.empty()
    const mode = getLogoutMode({
      total: 0,
      profile: args.profile,
      all: args.all,
    })
    if (mode === "invalid") {
      prompts.log.error("Cannot combine --all with --profile")
      return
    }
    const credentials = await getEntries()
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const config = await Config.get()
    const database = await ModelsDev.get()
    const names = getProviderNames({ database, config })
    const provider = args.provider
      ? (resolveProvider({ entries: credentials, names, value: args.provider }) ?? args.provider)
      : await prompts.select({
          message: "Select provider",
          options: credentials.map((x) => ({
            label: formatProviderLabel({ id: x.id, name: names[x.id] }),
            value: x.id,
          })),
        })
    if (provider === invalid) process.exit(1)
    if (prompts.isCancel(provider)) throw new UI.CancelledError()
    const entry = credentials.find((x) => x.id === provider)
    if (!entry) {
      prompts.log.error(`No credentials found for ${provider}`)
      process.exit(1)
    }
    const next = getLogoutMode({
      total: entry.profiles.length,
      profile: args.profile,
      all: args.all,
    })
    const profile =
      next === "profile"
        ? args.profile!
        : next === "prompt"
          ? await promptProfile({
              entry,
              message: "Select profile to remove",
              includeAll: true,
            })
          : undefined

    if (profile === all) {
      await Auth.remove(provider)
      prompts.outro("Logout successful")
      return
    }
    if (profile) {
      if (!hasProfile({ profiles: entry.profiles, value: profile })) {
        prompts.log.error(`Unknown profile "${profile}" for ${provider}`)
        process.exit(1)
      }
      await Auth.removeProfile(provider, profile)
      prompts.outro(`Removed ${provider}/${profile}`)
      return
    }
    await Auth.remove(provider)
    prompts.outro("Logout successful")
  },
})
