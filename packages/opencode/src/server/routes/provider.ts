import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { ModelID, ProviderID } from "../../provider/schema"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { Auth, normalizeProfile } from "../../auth"
import { Monitor } from "../../monitor"
import { Instance } from "../../project/instance"

const log = Log.create({ service: "server" })
const Profile = z.object({
  active: z.string(),
  names: z.array(z.string()),
})

const AuthError = z.object({
  name: z.string(),
  message: z.string(),
})

const BadRequest = z
  .object({
    data: z.any(),
    errors: z.array(z.record(z.string(), z.any())),
    success: z.literal(false),
  })
  .meta({
    ref: "BadRequestError",
  })

const AuthErrorResponse = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(z.union([AuthError, BadRequest])),
      },
    },
  },
} as const

const PublicModel = Provider.Model.omit({
  options: true,
  headers: true,
})

const PublicProvider = z.object({
  id: ProviderID.zod,
  name: z.string(),
  env: z.array(z.string()),
  models: z.record(z.string(), PublicModel),
})

function publicProvider(item: Provider.Info) {
  return {
    id: item.id,
    name: item.name,
    env: item.env,
    models: mapValues(item.models, (model) => ({
      id: model.id,
      providerID: model.providerID,
      api: model.api,
      name: model.name,
      family: model.family,
      capabilities: model.capabilities,
      cost: model.cost,
      limit: model.limit,
      status: model.status,
      release_date: model.release_date,
      ...(model.variants ? { variants: model.variants } : {}),
    })),
  }
}

async function profile(ids: string[]) {
  return Object.fromEntries(
    (
      await Promise.all(
        ids.map(async (id) => {
          const item = await Auth.entry(id)
          if (!item?.active) return []
          return [[id, { active: item.active, names: Object.keys(item.profiles).sort() }] as const]
        }),
      )
    ).flat(),
  )
}

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: PublicProvider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                    profile: z.record(z.string(), Profile),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const connected = await Provider.list()
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected,
        )
        const ids = Object.keys(connected)
        return c.json({
          all: Object.values(providers).map(publicProvider),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: ids,
          profile: await profile(ids),
        })
      },
    )
    .post(
      "/:providerID/activate",
      describeRoute({
        summary: "Activate provider profile",
        description: "Switch the active auth profile for a provider.",
        operationId: "provider.activate",
        responses: {
          200: {
            description: "Active provider profile",
            content: {
              "application/json": {
                schema: resolver(Profile),
              },
            },
          },
          ...AuthErrorResponse,
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          profile: z.string().meta({ description: "Profile name" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const profileName = c.req.valid("json").profile
        await Auth.activate(providerID, profileName)
        await Instance.dispose()
        const item = await Auth.entry(providerID)
        return c.json({
          active: item!.active!,
          names: Object.keys(item!.profiles).sort(),
        })
      },
    )
    .delete(
      "/:providerID/profile",
      describeRoute({
        summary: "Remove provider profile",
        description: "Remove a single auth profile for a provider.",
        operationId: "provider.removeProfile",
        responses: {
          200: {
            description: "Remaining provider profiles",
            content: {
              "application/json": {
                schema: resolver(Profile.nullable()),
              },
            },
          },
          ...AuthErrorResponse,
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "query",
        z.object({
          profile: z.string().meta({ description: "Profile name" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const profile = c.req.valid("query").profile
        await Auth.removeProfile(providerID, profile)
        await Instance.dispose()
        const item = await Auth.entry(providerID)
        if (!item?.active) return c.json(null)
        return c.json({
          active: item.active,
          names: Object.keys(item.profiles).sort(),
        })
      },
    )
    .get(
      "/monitor",
      describeRoute({
        summary: "Get provider monitor snapshot",
        description: "Retrieve a normalized monitor snapshot for a provider/profile/model scope.",
        operationId: "provider.monitor",
        responses: {
          200: {
            description: "Normalized monitor snapshot",
            content: {
              "application/json": {
                schema: resolver(Monitor.Snapshot),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: ProviderID.zod.meta({ description: "Provider ID" }),
          profile: z.string().optional().meta({ description: "Provider profile" }),
          model: ModelID.zod.meta({ description: "Model ID" }),
          variant: z.string().optional().meta({ description: "Model variant" }),
          refresh: z.coerce.boolean().optional().meta({ description: "Force refresh" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(
          await Monitor.get(
            {
              provider: query.provider,
              profile: query.profile,
              model: query.model,
              variant: query.variant,
            },
            { refresh: query.refresh },
          ),
        )
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          profile: z.string().optional().meta({ description: "Profile name" }),
          inputs: z.record(z.string(), z.string()).optional().meta({ description: "Prompt inputs" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, profile, inputs } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
          profile: normalizeProfile(profile),
          inputs,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          profile: z.string().optional().meta({ description: "Profile name" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, profile, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          profile: normalizeProfile(profile),
          code,
        })
        return c.json(true)
      },
    ),
)
