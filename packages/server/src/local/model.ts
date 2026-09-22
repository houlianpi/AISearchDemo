import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HttpError } from "./contracts.ts";

export async function createLocalModelRuntime(): Promise<ModelRuntime> {
	const agentDir = getAgentDir();
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
}

export function resolveLocalModel(runtime: ModelRuntime, selector: string): Model<string> {
	const slash = selector.indexOf("/");
	if (slash < 1 || slash === selector.length - 1) {
		throw new HttpError(500, "INVALID_MODEL", `PI_MODEL must use provider/model format, received ${selector}.`);
	}
	const provider = selector.slice(0, slash);
	const modelId = selector.slice(slash + 1);
	const model = runtime.getModel(provider, modelId);
	if (!model) throw new HttpError(500, "UNKNOWN_MODEL", `Model ${selector} is not available.`);
	if (!model.input.includes("image")) {
		throw new HttpError(500, "MODEL_NOT_MULTIMODAL", `Model ${selector} does not support image input.`);
	}
	return model as Model<string>;
}
