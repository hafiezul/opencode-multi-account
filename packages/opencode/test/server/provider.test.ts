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

Log.init({ print: false })

beforeEach(async () => {
  await Auth.remove(id)
  await Auth.remove(pluginID)
})

afterEach(async () => {
  await Auth.remove(id)
  await Auth.remove(pluginID)
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
        const res = await app.request("/provider")
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
        const res = await app.request(`/provider/${id}/activate`, {
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

        const next = await app.request("/provider")
        const data = (await next.json()) as {
          profile: Record<string, { active: string; names: string[] }>
        }
        expect(data.profile[id]?.active).toBe("personal")
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
        const first = (await (await app.request("/provider")).json()) as {
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

        await app.request(`/provider/${pluginID}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: "personal" }),
        })

        const second = (await (await app.request("/provider")).json()) as {
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
