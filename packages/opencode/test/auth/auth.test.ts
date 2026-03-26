import path from "path"
import { beforeEach, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Global } from "../../src/global"

const file = path.join(Global.Path.data, "auth.json")

beforeEach(async () => {
  await Bun.write(file, "{}")
})

test("set normalizes trailing slashes in keys", async () => {
  await Auth.set("https://example.com/", {
    type: "wellknown",
    key: "TOKEN",
    token: "abc",
  })
  const data = await Auth.all()
  expect(data["https://example.com"]).toBeDefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("legacy entries load as the default profile", async () => {
  await Bun.write(
    file,
    JSON.stringify({
      gitlab: {
        type: "oauth",
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 3600000,
        accountId: "acct",
      },
    }),
  )

  const auth = await Auth.get("gitlab")
  expect(auth?.type).toBe("oauth")
  if (auth?.type === "oauth") expect(auth.accountId).toBe("acct")

  const entry = await Auth.entry("gitlab")
  expect(entry).toBeDefined()
  expect(entry?.active).toBe("default")
  expect(Object.keys(entry?.profiles ?? {})).toEqual(["default"])

  await Auth.put("gitlab", "work", {
    type: "api",
    key: "work-key",
  })

  const next = await Auth.entry("gitlab")
  expect(next?.active).toBe("default")
  expect(Object.keys(next?.profiles ?? {}).sort()).toEqual(["default", "work"])

  const raw = (await Bun.file(file).json()) as {
    gitlab: {
      active: string
      profiles: {
        default: {
          accountId: string
        }
      }
    }
  }
  expect(raw.gitlab.active).toBe("default")
  expect(raw.gitlab.profiles.default.accountId).toBe("acct")
})

test("multi-profile entries expose the active auth and normalize top-level keys", async () => {
  await Bun.write(
    file,
    JSON.stringify({
      gitlab: {
        active: "work",
        profiles: {
          personal: {
            type: "api",
            key: "personal-key",
          },
          work: {
            type: "oauth",
            access: "work-access",
            refresh: "work-refresh",
            expires: Date.now() + 3600000,
          },
        },
      },
      "https://example.com/": {
        active: "ops",
        profiles: {
          ops: {
            type: "wellknown",
            key: "TOKEN",
            token: "abc",
          },
        },
      },
    }),
  )

  const auth = await Auth.get("gitlab")
  expect(auth?.type).toBe("oauth")
  if (auth?.type === "oauth") expect(auth.access).toBe("work-access")

  const all = await Auth.all()
  expect(Object.keys(all).sort()).toEqual(["gitlab", "https://example.com"])
  expect(all["https://example.com"]?.type).toBe("wellknown")

  const profiles = await Auth.profiles("gitlab")
  expect(Object.keys(profiles).sort()).toEqual(["personal", "work"])
})

test("stale active falls back to another valid profile", async () => {
  await Bun.write(
    file,
    JSON.stringify({
      gitlab: {
        active: "stale",
        profiles: {
          stale: {
            nope: true,
          },
          work: {
            type: "oauth",
            access: "work-access",
            refresh: "work-refresh",
            expires: Date.now() + 3600000,
          },
        },
      },
    }),
  )

  expect((await Auth.get("gitlab"))?.type).toBe("oauth")
  expect((await Auth.entry("gitlab"))?.active).toBe("work")
  expect(Object.keys(await Auth.all())).toEqual(["gitlab"])
})

test("put, activate, update, and removeProfile preserve siblings and active auth", async () => {
  await Bun.write(
    file,
    JSON.stringify({
      gitlab: {
        active: "work",
        profiles: {
          work: {
            type: "oauth",
            access: "work-access",
            refresh: "work-refresh",
            expires: Date.now() + 3600000,
            scope: "read:user",
          },
        },
      },
    }),
  )

  await Auth.put("gitlab", "personal", {
    type: "api",
    key: "personal-key",
  })

  let entry = await Auth.entry("gitlab")
  expect(entry?.active).toBe("work")
  expect(Object.keys(entry?.profiles ?? {}).sort()).toEqual(["personal", "work"])
  expect((await Auth.get("gitlab"))?.type).toBe("oauth")

  await Auth.activate("gitlab", "personal")
  expect((await Auth.get("gitlab"))?.type).toBe("api")
  expect(Object.keys(await Auth.all())).toEqual(["gitlab"])

  await Auth.put("gitlab", "personal", {
    type: "wellknown",
    key: "TOKEN",
    token: "next",
  })

  entry = await Auth.entry("gitlab")
  expect(entry?.active).toBe("personal")
  expect(entry?.profiles["personal"]?.type).toBe("wellknown")

  const raw = (await Bun.file(file).json()) as {
    gitlab: {
      profiles: {
        work: {
          scope: string
        }
      }
    }
  }
  expect(raw.gitlab.profiles.work.scope).toBe("read:user")

  await Auth.removeProfile("gitlab", "personal")
  entry = await Auth.entry("gitlab")
  expect(entry?.active).toBe("work")
  expect(Object.keys(entry?.profiles ?? {})).toEqual(["work"])
  expect((await Auth.get("gitlab"))?.type).toBe("oauth")

  await Auth.removeProfile("gitlab", "work")
  expect(await Auth.entry("gitlab")).toBeUndefined()
  expect(await Auth.get("gitlab")).toBeUndefined()
  expect(await Auth.all()).toEqual({})
})

test("activate rejects non-decodable profiles", async () => {
  await Bun.write(
    file,
    JSON.stringify({
      gitlab: {
        active: "work",
        profiles: {
          bad: {
            nope: true,
          },
          work: {
            type: "api",
            key: "work-key",
          },
        },
      },
    }),
  )

  await expect(Auth.activate("gitlab", "bad")).rejects.toThrow("Auth profile not found: bad")
  expect((await Auth.entry("gitlab"))?.active).toBe("work")

  const raw = (await Bun.file(file).json()) as {
    gitlab: {
      active: string
    }
  }
  expect(raw.gitlab.active).toBe("work")
})

test("remove deletes both trailing-slash and normalized keys", async () => {
  await Auth.set("https://example.com", {
    type: "wellknown",
    key: "TOKEN",
    token: "abc",
  })
  await Auth.remove("https://example.com/")
  const data = await Auth.all()
  expect(data["https://example.com"]).toBeUndefined()
  expect(data["https://example.com/"]).toBeUndefined()
})
