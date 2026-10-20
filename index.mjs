import plugin from "./provider.mjs"

// A host resolves a plugin module and reads the factory off it. Which shape it
// reads is the host's business and not this package's to narrow: magpie builds
// one from `default.server`, which is the shape provider.mjs already exports, so
// that object is forwarded whole rather than the factory being renamed into a
// shape nothing else in the package uses. The `id` comes with it, because a
// loader that keys plugins by id needs the same one the provider registers — and
// it is the provider's own id, not a second copy of it: it is read from the
// module, so the two cannot drift.
//
// The named export stays for anything that already imported it by name, and
// `server` is offered as a name too, so `mod.default.server` and `mod.server`
// both resolve. The `id` is offered beside them, so a host that resolves the
// plugin by a named export has something to key it by: the two ways in carry
// the same two facts, and the id is the provider's own either way — read from
// the module rather than written out here, so the two cannot drift.
//
// Both halves of what the object carries are checked here, the `id` as well as
// the factory: a provider.mjs that lost either one would otherwise load
// cleanly and hand the host a plugin it cannot key or start.
//
// The check reads own properties only, as the rest of the package reads its
// maps: a value inherited from a prototype is not something provider.mjs
// exported, and an inherited `server` or `id` would satisfy the guard with
// something the provider never wrote — the one case this guard exists to
// catch. And an id is a name: one of nothing but spaces is no name at all, so
// it is refused here rather than registered under it.
//
// The two own properties are checked before either is read, and each is read
// exactly once. A value inherited from a prototype is not something provider.mjs
// exported; a getter on the object is read once, so the value checked and the
// value exported are the same read. The id is a name, and one of nothing but
// spaces is no name at all.
if (
  !Object.hasOwn(plugin ?? {}, "server") ||
  !Object.hasOwn(plugin ?? {}, "id")
) {
  throw new TypeError(
    "provider.mjs must default-export a plugin with a `server` factory and an `id`",
  )
}
const factory = plugin.server
const name = plugin.id
if (typeof factory !== "function" || typeof name !== "string" || !name.trim()) {
  throw new TypeError(
    "provider.mjs must default-export a plugin with a `server` factory and an `id`",
  )
}
// An id is a name, and the name that leaves is exactly the one that was
// checked. Trimming it here would publish a different name than the provider
// registers (the provider's own `id` constant is what `server()` reports), and
// exporting the raw value with the padding is the drift this guard exists to
// stop. So a padded id is refused rather than silently normalised: the author
// named the plugin with spaces and has to decide against which spelling a host
// will key it.
if (name !== name.trim()) {
  throw new TypeError(
    "provider.mjs's plugin id is a name and must not carry surrounding whitespace",
  )
}

export const ZenFreePlugin = factory
export const server = factory
export const id = name
// The provider's object is forwarded as it is. A copy would be a second object
// with its own getters and prototype, and a host that compares the import with
// the provider's export would be comparing two things; the two values the guard
// read are the object's own own-property reads, so forwarding the original
// cannot publish a value the guard did not see.
export default plugin
