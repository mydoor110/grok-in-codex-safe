export const CAPABILITIES = ["read", "edit", "test", "buildImage", "push", "deploy"];
export const DEFAULT_WRITE_CAPABILITIES = ["read", "edit", "test"];
export const DEFAULT_READ_CAPABILITIES = ["read"];
export const STAGES = ["inspect", "implement", "verify", "package", "publish"];

const BUILD_ALLOWS = [
  "Bash(docker build*)", "Bash(docker compose*)", "Bash(docker-compose*)",
  "Bash(docker ps*)", "Bash(docker logs*)", "Bash(docker inspect*)",
  "Bash(docker rm*)", "Bash(docker stop*)", "Bash(docker run*)", "Bash(docker images*)"
];
const PUSH_DENIES = ["Bash(docker push*)", "Bash(docker image push*)", "Bash(docker login*)"];
const PUSH_ALLOWS = ["Bash(docker push*)", "Bash(docker image push*)", "Bash(docker tag*)", "Bash(git push*)"];

export function effectiveCapabilities(acceptance = {}, write = true) {
  if (Array.isArray(acceptance.capabilities) && acceptance.capabilities.length) return acceptance.capabilities;
  return write === false ? DEFAULT_READ_CAPABILITIES : DEFAULT_WRITE_CAPABILITIES;
}

export function normalizeCapabilities(list, { write = true } = {}) {
  if (list == null) return write ? [...DEFAULT_WRITE_CAPABILITIES] : [...DEFAULT_READ_CAPABILITIES];
  if (!Array.isArray(list) || list.some(value => !CAPABILITIES.includes(value))) {
    throw new Error("Invalid acceptance field: capabilities");
  }
  const set = new Set(list);
  set.add("read");
  if (write && list.includes("edit")) set.add("edit");
  return CAPABILITIES.filter(name => set.has(name));
}

export function commandCapability(command = "") {
  const text = String(command);
  if (/\b(?:kubectl|helm)\b|\bterraform\s+apply\b|\b(?:aws|gcloud|az)\s+/i.test(text)) return "deploy";
  if (/\b(?:git\s+push|docker\s+(?:image\s+)?push|npm\s+publish|pnpm\s+publish)\b/i.test(text)) return "push";
  if (/\bdocker\b|\bpodman\b/i.test(text)) return "buildImage";
  if (/\b(?:npm\s+(?:test|run\s+test|run\s+lint)|pnpm\s+(?:test|lint)|yarn\s+test|pytest|mvn\s+test|gradle\s+test)\b/i.test(text)) return "test";
  if (/\bgit\s+(?:add|commit)\b/i.test(text)) return "edit";
  return null;
}

export function assertCommandCapability(command, capabilities) {
  const needed = commandCapability(command);
  if (needed && !capabilities.includes(needed)) {
    throw new Error(`Command is outside permitted capabilities (${needed}): ${command}`);
  }
}

export function mutatesProduction(capabilities = []) {
  return capabilities.includes("push") || capabilities.includes("deploy");
}

function dropRule(list, rule) {
  return list.filter(item => item !== rule);
}

export function applyCapabilities(control, capabilities, { sensitiveApproved = false } = {}) {
  const caps = new Set(capabilities);
  if ((caps.has("push") || caps.has("deploy")) && !sensitiveApproved) {
    throw new Error("CAPABILITY_MISSING: push/deploy require sensitiveApproved=true");
  }
  let deny = [...(control.deny || [])];
  let allow = [...(control.allow || [])];
  if (caps.has("buildImage")) {
    deny = dropRule(deny, "Bash(docker*)");
    for (const rule of BUILD_ALLOWS) if (!allow.includes(rule)) allow.push(rule);
    if (!caps.has("push")) {
      for (const rule of PUSH_DENIES) if (!deny.includes(rule)) deny.push(rule);
    }
  }
  if (caps.has("push")) {
    deny = dropRule(dropRule(dropRule(deny, "Bash(docker*)"), "Bash(git push*)"), "Bash(npm publish*)");
    for (const rule of PUSH_ALLOWS) if (!allow.includes(rule)) allow.push(rule);
  }
  if (caps.has("deploy")) {
    deny = dropRule(dropRule(deny, "Bash(kubectl*)"), "Bash(terraform*)");
    for (const rule of ["Bash(kubectl*)", "Bash(terraform*)"]) if (!allow.includes(rule)) allow.push(rule);
  }
  return { ...control, allow, deny };
}

export function isMutableTag(tag) {
  const value = String(tag || "").split("/").pop().split(":").pop();
  return !value || ["latest", "stable", "dev", "main", "master"].includes(value);
}

export function normalizePublish(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid acceptance field: publish");
  if (raw.images != null && !Array.isArray(raw.images)) throw new Error("Invalid acceptance field: publish.images");
  const images = (raw.images || []).map(image => {
    if (!image || typeof image !== "object" || typeof image.repository !== "string" || typeof image.tag !== "string") {
      throw new Error("Invalid publish image: repository and tag are required");
    }
    for (const key of ["digest", "immutableTag"]) {
      if (image[key] != null && typeof image[key] !== "string") throw new Error(`Invalid publish image ${key}`);
    }
    return {
      repository: image.repository,
      tag: image.tag,
      digest: image.digest || null,
      immutableTag: image.immutableTag || null
    };
  });
  const requireImmutableTags = raw.requireImmutableTags !== false;
  if (requireImmutableTags) {
    for (const image of images) {
      if (isMutableTag(image.tag) && isMutableTag(image.immutableTag) && !image.digest) {
        throw new Error(`CAPABILITY_MISSING: publish tag is mutable (need date-sha or digest): ${image.repository}:${image.tag}`);
      }
    }
  }
  if (raw.allowDirtyPublish != null && typeof raw.allowDirtyPublish !== "boolean") {
    throw new Error("Invalid acceptance field: publish.allowDirtyPublish");
  }
  return { images, allowDirtyPublish: Boolean(raw.allowDirtyPublish), requireImmutableTags };
}

export function productionMutatingReceipts(receipts = []) {
  return receipts.filter(receipt => {
    const needed = commandCapability(receipt.command);
    return needed === "push" || needed === "deploy";
  });
}
