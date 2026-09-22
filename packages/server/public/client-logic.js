export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateImageFile(file) {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Image must not exceed 5 MiB.");
}

export function buildMessageRequest(prompt, image) {
  return image ? { prompt, image } : { prompt };
}

export function createSessionId(cryptoApi = globalThis.crypto) {
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return "web-" + cryptoApi.randomUUID();
  return "web-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export class RequestLifecycle {
  constructor() { this.version = 0; this.controller = null; }
  start() {
    this.cancel();
    this.controller = new AbortController();
    return { version: this.version, controller: this.controller };
  }
  cancel() {
    this.version++;
    if (this.controller) this.controller.abort();
    this.controller = null;
  }
  isCurrent(request) { return request.version === this.version && request.controller === this.controller; }
  finish(request) { if (this.isCurrent(request)) this.controller = null; }
}
