import path from "path"
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { AppFileSystem } from "../filesystem"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const profile = "default"
let rev = 0

const fail = (message: string) => (cause: unknown) => new Auth.AuthError({ message, cause })
const norm = (key: string) => key.replace(/\/+$/, "")
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const bump = () => ++rev

export namespace Auth {
  export class Oauth extends Schema.Class<Oauth>("OAuth")({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
    enterpriseUrl: Schema.optional(Schema.String),
  }) {}

  export class Api extends Schema.Class<Api>("ApiAuth")({
    type: Schema.Literal("api"),
    key: Schema.String,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }) {}

  export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
    type: Schema.Literal("wellknown"),
    key: Schema.String,
    token: Schema.String,
  }) {}

  const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
  export const Info = Object.assign(_Info, { zod: zod(_Info) })
  export type Info = Schema.Schema.Type<typeof _Info>

  export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  export interface Entry {
    readonly active: string | undefined
    readonly profiles: Record<string, Info>
  }

  export interface Interface {
    readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
    readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
    readonly entry: (key: string) => Effect.Effect<Entry | undefined, AuthError>
    readonly profiles: (key: string) => Effect.Effect<Record<string, Info>, AuthError>
    readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
    readonly remove: (key: string) => Effect.Effect<void, AuthError>
    readonly put: (key: string, name: string, info: Info) => Effect.Effect<void, AuthError>
    readonly activate: (key: string, name: string) => Effect.Effect<void, AuthError>
    readonly removeProfile: (key: string, name: string) => Effect.Effect<void, AuthError>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Auth") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const decode = Schema.decodeUnknownOption(Info)

      const info = (value: unknown) => Option.getOrUndefined(decode(value))

      const parse = (value: unknown) => {
        if (info(value)) return { active: profile, profiles: { [profile]: value } }
        if (!isRecord(value) || !isRecord(value.profiles)) return
        return {
          active: typeof value.active === "string" ? value.active : undefined,
          profiles: value.profiles,
        }
      }

      const list = (value: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(value).flatMap(([name, value]) => {
            const decoded = info(value)
            if (!decoded) return []
            return [[name, decoded] as const]
          }),
        )

      const pick = (profiles: Record<string, Info>, active?: string) => {
        if (active && profiles[active]) return active
        if (profiles[profile]) return profile
        return Object.keys(profiles)[0]
      }

      const entryInfo = (value: ReturnType<typeof parse>) => {
        if (!value) return
        const profiles = list(value.profiles)
        const active = pick(profiles, value.active)
        if (!active) return
        return {
          active,
          profiles,
          raw: value.profiles,
        }
      }

      const read = () =>
        Effect.tryPromise({
          try: () => Filesystem.readJson<Record<string, unknown>>(file).catch((): Record<string, unknown> => ({})),
          catch: fail("Failed to read auth data"),
        })

      const write = (data: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => Filesystem.writeJson(file, data, 0o600),
          catch: fail("Failed to write auth data"),
        })

      const all = Effect.fn("Auth.all")(() =>
        read().pipe(
          Effect.map((data) =>
            Object.fromEntries(
              Object.entries(data).flatMap(([key, value]) => {
                const entry = entryInfo(parse(value))
                if (!entry) return []
                return [[norm(key), entry.profiles[entry.active]] as const]
              }),
            ),
          ),
        ),
      )

      const get = Effect.fn("Auth.get")(function* (providerID: string) {
        return (yield* all())[norm(providerID)]
      })

      const entry = Effect.fn("Auth.entry")(function* (key: string) {
        const data = yield* read()
        const id = norm(key)
        return entryInfo(parse(data[id] ?? data[id + "/"]))
      })

      const profiles = Effect.fn("Auth.profiles")(function* (key: string) {
        return (yield* entry(key))?.profiles ?? {}
      })

      const put = Effect.fn("Auth.put")(function* (key: string, name: string, info: Info) {
        const id = norm(key)
        const data = yield* read()
        const parsed = parse(data[id] ?? data[id + "/"])
        const active = entryInfo(parsed)?.active ?? name
        delete data[key]
        delete data[id]
        delete data[id + "/"]
        yield* write({
          ...data,
          [id]: {
            active,
            profiles: {
              ...(parsed?.profiles ?? {}),
              [name]: info,
            },
          },
        })
        bump()
      })

      const activate = Effect.fn("Auth.activate")(function* (key: string, name: string) {
        const id = norm(key)
        const data = yield* read()
        const parsed = parse(data[id] ?? data[id + "/"])
        if (!parsed) {
          return yield* new AuthError({ message: `Auth profile not found: ${name}` })
        }
        const item = entryInfo(parsed)
        if (!item || !item.profiles[name]) {
          return yield* new AuthError({ message: `Auth profile not found: ${name}` })
        }
        delete data[key]
        delete data[id]
        delete data[id + "/"]
        yield* write({
          ...data,
          [id]: {
            active: name,
            profiles: item.raw,
          },
        })
        bump()
      })

      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        yield* put(key, profile, info)
        yield* activate(key, profile)
      })

      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        const id = norm(key)
        const data = yield* read()
        delete data[key]
        delete data[id]
        delete data[id + "/"]
        yield* write(data)
        bump()
      })

      const removeProfile = Effect.fn("Auth.removeProfile")(function* (key: string, name: string) {
        const id = norm(key)
        const data = yield* read()
        const parsed = parse(data[id] ?? data[id + "/"])
        if (!parsed) return
        const profiles = Object.fromEntries(Object.entries(parsed.profiles).filter(([item]) => item !== name))
        delete data[key]
        delete data[id]
        delete data[id + "/"]
        if (Object.keys(profiles).length === 0) {
          yield* write(data)
          bump()
          return
        }
        const active = entryInfo({ ...parsed, profiles })?.active
        yield* write({
          ...data,
          [id]: {
            active,
            profiles,
          },
        })
        bump()
      })

      return Service.of({ get, all, entry, profiles, set, remove, put, activate, removeProfile })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(providerID: string) {
    return runPromise((service) => service.get(providerID))
  }

  export async function all(): Promise<Record<string, Info>> {
    return runPromise((service) => service.all())
  }

  export async function entry(key: string) {
    return runPromise((service) => service.entry(key))
  }

  export async function profiles(key: string): Promise<Record<string, Info>> {
    return runPromise((service) => service.profiles(key))
  }

  export async function set(key: string, info: Info) {
    return runPromise((service) => service.set(key, info))
  }

  export async function remove(key: string) {
    return runPromise((service) => service.remove(key))
  }

  export async function put(key: string, name: string, info: Info) {
    return runPromise((service) => service.put(key, name, info))
  }

  export async function activate(key: string, name: string) {
    return runPromise((service) => service.activate(key, name))
  }

  export async function removeProfile(key: string, name: string) {
    return runPromise((service) => service.removeProfile(key, name))
  }

  export async function resolve(providerID: string, name?: string) {
    const item = await entry(providerID)
    const profile = name ?? item?.active
    const auth = profile ? item?.profiles[profile] : undefined
    const accountID = auth && "accountId" in auth && typeof auth.accountId === "string" ? auth.accountId : undefined
    return {
      profile,
      auth,
      accountID,
    }
  }

  export function revision() {
    return rev
  }
}
