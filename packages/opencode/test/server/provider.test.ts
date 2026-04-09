import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

const id = "server-switch-list"
const pluginID = "server-switch-plugin"
const targetID = "server-switch-target"

Log.init({ print: false })

function call(app: ReturnType<typeof Server.Default>, dir: string, url: string, init?: RequestInit) {
  return app.app.request(url, {
    ...init,
    headers: {
      ...init?.headers,
      "x-opencode-directory": dir,
    },
  })
}

beforeEach(async () => {
  await Auth.remove(id)
  await Auth.remove(pluginID)
  await Auth.remove(targetID)
})

afterEach(async () => {
  await Auth.remove(id)
  await Auth.remove(pluginID)
  await Auth.remove(targetID)
})

describe("provider endpoints", () => {
  test.serial("list returns public profile metadata", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          [id]: {
            name: "Switch List",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            api: "https://api.example.com/v1",
            options: {
              apiKey: "config-secret",
            },
            models: {
              model: {
                name: "Model",
                tool_call: true,
                limit: { context: 4000, output: 1000 },
                options: {
                  apiKey: "model-secret",
                },
                headers: {
                  Authorization: "Bearer header-secret",
                },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put(id, "work", { type: "api", key: "work-key" })
        await Auth.put(id, "personal", { type: "api", key: "personal-key" })
        await Auth.activate(id, "work")

        const app = Server.Default()
        const res = await call(app, tmp.path, "/provider")
        const body = (await res.json()) as {
          all: Array<{
            id: string
            key?: string
            options?: unknown
            models: Record<string, { options?: unknown; headers?: unknown }>
          }>
          connected: string[]
          profile: Record<string, { active: string; names: string[] }>
        }
        const item = body.all.find((item) => item.id === id)

        expect(res.status).toBe(200)
        expect(body.all.some((item) => item.id === id)).toBe(true)
        expect(body.connected).toContain(id)
        expect(body.profile[id]).toEqual({
          active: "work",
          names: ["personal", "work"],
        })
        expect(item).toBeDefined()
        expect(item).not.toHaveProperty("key")
        expect(item).not.toHaveProperty("options")
        expect(item?.models.model).not.toHaveProperty("options")
        expect(item?.models.model).not.toHaveProperty("headers")
        expect(JSON.stringify(body)).not.toContain("work-key")
        expect(JSON.stringify(body)).not.toContain("personal-key")
        expect(JSON.stringify(body)).not.toContain("config-secret")
        expect(JSON.stringify(body)).not.toContain("model-secret")
        expect(JSON.stringify(body)).not.toContain("header-secret")
      },
    })
  })

  test.serial("activate switches the active profile", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          [id]: {
            name: "Switch List",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            api: "https://api.example.com/v1",
            models: {
              model: {
                name: "Model",
                tool_call: true,
                limit: { context: 4000, output: 1000 },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put(id, "work", { type: "api", key: "work-key" })
        await Auth.put(id, "personal", { type: "api", key: "personal-key" })
        await Auth.activate(id, "work")

        const app = Server.Default()
        const res = await call(app, tmp.path, `/provider/${id}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "personal" }),
        })
        const body = (await res.json()) as {
          active: string
          names: string[]
        }

        expect(res.status).toBe(200)
        expect(body).toEqual({
          active: "personal",
          names: ["personal", "work"],
        })
        expect((await Provider.list())[ProviderID.make(id)]?.key).toBe("personal-key")

        const next = await call(app, tmp.path, "/provider")
        const data = (await next.json()) as {
          profile: Record<string, { active: string; names: string[] }>
        }
        expect(data.profile[id]?.active).toBe("personal")
      },
    })
  })

  test.serial("removeProfile removes a single profile", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          [id]: {
            name: "Switch List",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            api: "https://api.example.com/v1",
            models: {
              model: {
                name: "Model",
                tool_call: true,
                limit: { context: 4000, output: 1000 },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put(id, "work", { type: "api", key: "work-key" })
        await Auth.put(id, "personal", { type: "api", key: "personal-key" })
        await Auth.activate(id, "work")

        const app = Server.Default()
        const res = await call(app, tmp.path, `/provider/${id}/profile?profile=work`, {
          method: "DELETE",
        })
        const body = (await res.json()) as {
          active: string
          names: string[]
        } | null

        expect(res.status).toBe(200)
        expect(body).toEqual({
          active: "personal",
          names: ["personal"],
        })
        expect(await Auth.entry(id)).toMatchObject({
          active: "personal",
          profiles: {
            personal: {
              type: "api",
              key: "personal-key",
            },
          },
        })
      },
    })
  })

  test.serial("removeProfile fails for missing profile", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          [id]: {
            name: "Switch List",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            api: "https://api.example.com/v1",
            models: {
              model: {
                name: "Model",
                tool_call: true,
                limit: { context: 4000, output: 1000 },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put(id, "work", { type: "api", key: "work-key" })
        await Auth.activate(id, "work")

        const app = Server.Default()
        const res = await call(app, tmp.path, `/provider/${id}/profile?profile=missing`, {
          method: "DELETE",
        })
        const body = (await res.json()) as { name?: string; message?: string }

        expect(res.status).toBe(400)
        expect(body.name).toBe("AuthError")
        expect(body.message).toBe("Auth profile not found: missing")
      },
    })
  })

  test.serial("removeProfile fails for missing provider", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default()
        const res = await call(app, tmp.path, `/provider/missing/profile?profile=work`, {
          method: "DELETE",
        })
        const body = (await res.json()) as { name?: string; message?: string }

        expect(res.status).toBe(400)
        expect(body.name).toBe("AuthError")
        expect(body.message).toBe("Auth profile not found: work")
      },
    })
  })

  test.serial("auth set and oauth routes normalize default profile names", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          [id]: {
            name: "Switch List",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            api: "https://api.example.com/v1",
            models: {
              model: {
                name: "Model",
                tool_call: true,
                limit: { context: 4000, output: 1000 },
              },
            },
          },
        },
      },
      init: async (dir) => {
        const file = path.join(dir, "oauth-plugin.js")
        await Bun.write(
          file,
          [
            "export default async () => ({",
            "  auth: {",
            `    provider: \"${pluginID}\",`,
            "    methods: [",
            "      {",
            '        type: "oauth",',
            '        label: "OAuth",',
            "        async authorize() {",
            "          return {",
            '            url: "https://example.com",',
            '            instructions: "Authorize",',
            '            method: "code",',
            "            async callback(code) {",
            '              return { type: "success", key: `key-${code}` }',
            "            },",
            "          }",
            "        },",
            "      },",
            "    ],",
            "  },",
            "})",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [`file://${file}`],
              provider: {
                [pluginID]: {
                  name: "OAuth Plugin",
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  api: "https://api.example.com/v1",
                  models: {
                    model: {
                      name: "Model",
                      tool_call: true,
                      limit: { context: 4000, output: 1000 },
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default()

        const authRes = await call(app, tmp.path, `/auth/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: " default ",
            auth: {
              type: "api",
              key: "default-key",
            },
          }),
        })

        expect(authRes.status).toBe(200)
        expect(await Auth.entry(id)).toMatchObject({
          active: "default",
          profiles: {
            default: {
              type: "api",
              key: "default-key",
            },
          },
        })

        const named = await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: 0,
            profile: "work",
          }),
        })

        expect(named.status).toBe(200)

        const namedCb = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: 0,
            profile: "work",
            code: "named",
          }),
        })

        expect(namedCb.status).toBe(200)
        expect(await Auth.entry(pluginID)).toMatchObject({
          active: "work",
          profiles: {
            work: {
              type: "api",
              key: "key-named",
            },
          },
        })

        const def = await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: 0,
            profile: "default",
          }),
        })

        expect(def.status).toBe(200)

        const defCb = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: 0,
            profile: "default",
            code: "default",
          }),
        })

        expect(defCb.status).toBe(200)
        expect(await Auth.entry(pluginID)).toMatchObject({
          active: "default",
          profiles: {
            work: {
              type: "api",
              key: "key-named",
            },
            default: {
              type: "api",
              key: "key-default",
            },
          },
        })
      },
    })
  })

  test.serial("oauth pending state is isolated by profile", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "oauth-plugin.js")
        await Bun.write(
          file,
          [
            "export default async () => ({",
            "  auth: {",
            `    provider: \"${pluginID}\",`,
            "    methods: [",
            "      {",
            '        type: "oauth",',
            '        label: "OAuth",',
            "        async authorize() {",
            "          return {",
            '            url: "https://example.com",',
            '            instructions: "Authorize",',
            '            method: "code",',
            "            async callback(code) {",
            '              return { type: "success", key: `key-${code}` }',
            "            },",
            "          }",
            "        },",
            "      },",
            "    ],",
            "  },",
            "})",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [`file://${file}`],
              provider: {
                [pluginID]: {
                  name: "OAuth Plugin",
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  api: "https://api.example.com/v1",
                  models: {
                    model: {
                      name: "Model",
                      tool_call: true,
                      limit: { context: 4000, output: 1000 },
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default()

        await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "work" }),
        })
        await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "personal" }),
        })

        const work = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "work", code: "work" }),
        })
        const personal = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "personal", code: "personal" }),
        })

        expect(work.status).toBe(200)
        expect(personal.status).toBe(200)
        expect(await Auth.entry(pluginID)).toMatchObject({
          active: "personal",
          profiles: {
            personal: {
              type: "api",
              key: "key-personal",
            },
            work: {
              type: "api",
              key: "key-work",
            },
          },
        })
      },
    })
  })

  test.serial("oauth callback preserves plugin provider overrides", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "oauth-plugin.js")
        await Bun.write(
          file,
          [
            "export default async () => ({",
            "  auth: {",
            `    provider: \"${pluginID}\",`,
            "    methods: [",
            "      {",
            '        type: "oauth",',
            '        label: "OAuth",',
            "        async authorize() {",
            "          return {",
            '            url: "https://example.com",',
            '            instructions: "Authorize",',
            '            method: "code",',
            "            async callback(code) {",
            `              return { type: "success", provider: "${targetID}", key: \`key-\${code}\` }`,
            "            },",
            "          }",
            "        },",
            "      },",
            "    ],",
            "  },",
            "})",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [`file://${file}`],
              provider: {
                [pluginID]: {
                  name: "OAuth Plugin",
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  api: "https://api.example.com/v1",
                  models: {
                    model: {
                      name: "Model",
                      tool_call: true,
                      limit: { context: 4000, output: 1000 },
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default()

        const auth = await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "work" }),
        })

        expect(auth.status).toBe(200)

        const cb = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "work", code: "named" }),
        })

        expect(cb.status).toBe(200)
        expect(await Auth.entry(pluginID)).toBeUndefined()
        expect(await Auth.entry(targetID)).toMatchObject({
          active: "work",
          profiles: {
            work: {
              type: "api",
              key: "key-named",
            },
          },
        })
      },
    })
  })

  test.serial("oauth pending state is isolated by method", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "oauth-plugin.js")
        await Bun.write(
          file,
          [
            "export default async () => ({",
            "  auth: {",
            `    provider: \"${pluginID}\",`,
            "    methods: [",
            "      {",
            '        type: "oauth",',
            '        label: "OAuth 0",',
            "        async authorize() {",
            "          return {",
            '            url: "https://example.com/0",',
            '            instructions: "Authorize 0",',
            '            method: "code",',
            "            async callback(code) {",
            '              return { type: "success", key: `key-0-${code}` }',
            "            },",
            "          }",
            "        },",
            "      },",
            "      {",
            '        type: "oauth",',
            '        label: "OAuth 1",',
            "        async authorize() {",
            "          return {",
            '            url: "https://example.com/1",',
            '            instructions: "Authorize 1",',
            '            method: "code",',
            "            async callback(code) {",
            '              return { type: "success", key: `key-1-${code}` }',
            "            },",
            "          }",
            "        },",
            "      },",
            "    ],",
            "  },",
            "})",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [`file://${file}`],
              provider: {
                [pluginID]: {
                  name: "OAuth Plugin",
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  api: "https://api.example.com/v1",
                  models: {
                    model: {
                      name: "Model",
                      tool_call: true,
                      limit: { context: 4000, output: 1000 },
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default()

        await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "work" }),
        })
        await call(app, tmp.path, `/provider/${pluginID}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 1, profile: "work" }),
        })

        const first = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0, profile: "work", code: "zero" }),
        })

        expect(first.status).toBe(200)
        expect(await Auth.entry(pluginID)).toMatchObject({
          active: "work",
          profiles: {
            work: {
              type: "api",
              key: "key-0-zero",
            },
          },
        })

        const second = await call(app, tmp.path, `/provider/${pluginID}/oauth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 1, profile: "work", code: "one" }),
        })

        expect(second.status).toBe(200)
        expect(await Auth.entry(pluginID)).toMatchObject({
          active: "work",
          profiles: {
            work: {
              type: "api",
              key: "key-1-one",
            },
          },
        })
      },
    })
  })

  test.serial("list refreshes provider models and defaults after profile activation", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "switch-plugin.js")
        await Bun.write(
          file,
          [
            "export async function SwitchPlugin() {",
            "  return {",
            "    auth: {",
            `      provider: \"${pluginID}\",`,
            "      async loader(getAuth, provider) {",
            "        const info = await getAuth()",
            '        if (!info || info.type !== "api") return {}',
            '        const keep = info.key === "work-key" ? "work-model" : "personal-model"',
            "        provider.models = Object.fromEntries(Object.entries(provider.models).filter(([id]) => id === keep))",
            "        return { apiKey: info.key }",
            "      },",
            "    },",
            "  }",
            "}",
            "export default SwitchPlugin",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [`file://${file}`],
              provider: {
                [pluginID]: {
                  name: "Switch Plugin",
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  api: "https://api.example.com/v1",
                  models: {
                    "work-model": {
                      name: "Work Model",
                      tool_call: true,
                      limit: { context: 4000, output: 1000 },
                    },
                    "personal-model": {
                      name: "Personal Model",
                      tool_call: true,
                      limit: { context: 4000, output: 1000 },
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put(pluginID, "work", { type: "api", key: "work-key" })
        await Auth.put(pluginID, "personal", { type: "api", key: "personal-key" })
        await Auth.activate(pluginID, "work")

        const app = Server.Default()
        const first = (await (await call(app, tmp.path, "/provider")).json()) as {
          all: Array<{ id: string; models: Record<string, unknown> }>
          default: Record<string, string>
          profile: Record<string, { active: string; names: string[] }>
        }
        const work = first.all.find((item) => item.id === pluginID)

        expect(work).toBeDefined()
        expect(Object.keys(work!.models)).toEqual(["work-model"])
        expect(first.default[pluginID]).toBe("work-model")
        expect(first.profile[pluginID]).toEqual({
          active: "work",
          names: ["personal", "work"],
        })

        await call(app, tmp.path, `/provider/${pluginID}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "personal" }),
        })

        const second = (await (await call(app, tmp.path, "/provider")).json()) as {
          all: Array<{ id: string; models: Record<string, unknown> }>
          default: Record<string, string>
          profile: Record<string, { active: string; names: string[] }>
        }
        const personal = second.all.find((item) => item.id === pluginID)

        expect(personal).toBeDefined()
        expect(Object.keys(personal!.models)).toEqual(["personal-model"])
        expect(second.default[pluginID]).toBe("personal-model")
        expect(second.profile[pluginID]).toEqual({
          active: "personal",
          names: ["personal", "work"],
        })
      },
    })
  })
})
