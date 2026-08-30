// Resource -> max-concurrency config for the broker's slot/license arbiter.
// Parsed once at startup from PI_BROKER_SLOTS, e.g.
//   PI_BROKER_SLOTS='{"local-mlx":1,"qwencode":2,"openai-gpt":1}'
// A resource with no entry is unknown to the broker: acquire() on it is
// rejected with a clear error rather than silently granted as "unlimited".
// This machine's whole reason for this feature is that unmanaged
// concurrency on a scarce local/quota resource silently corrupts state
// (two heavy local model servers both fail); defaulting an unconfigured
// name to "no limit" would let a typo'd resource name quietly reproduce
// the exact failure mode this system exists to prevent. Fail loud instead:
// the caller must register the resource's capacity before anyone can rely
// on it as a lock.
export function readSlotConfig(env = process.env) {
  const raw = env.PI_BROKER_SLOTS;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PI_BROKER_SLOTS must be valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("PI_BROKER_SLOTS must be a JSON object of resource -> max");
  }
  const config = {};
  for (const [resource, max] of Object.entries(parsed)) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(
        `PI_BROKER_SLOTS.${resource} must be a positive integer`
      );
    }
    config[resource] = max;
  }
  return config;
}
