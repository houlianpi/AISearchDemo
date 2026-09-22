import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImageAnalysis } from "./contracts.ts";

export interface SubmittedResponse {
	answer: string;
	imageAnalysis: ImageAnalysis | null;
}

export function createSubmitResponseTool(onSubmit: (response: SubmittedResponse) => void) {
	return defineTool({
		name: "submit_response",
		label: "Submit response",
		description: "Submit the final answer and optional image analysis as structured data. This must be the final action of every request.",
		promptSnippet: "Use submit_response as the final action for every request",
		promptGuidelines: [
			"Always finish by calling submit_response exactly once.",
			"When an image is present, describe it and provide concise search keywords. Otherwise set imageAnalysis to null.",
		],
		parameters: Type.Object({
			answer: Type.String({ description: "Final user-facing answer grounded in the image and any search results." }),
			imageAnalysis: Type.Union([
				Type.Null(),
				Type.Object({
					description: Type.String(),
					keywords: Type.Array(Type.String()),
				}),
			]),
		}),
		async execute(_callId, params) {
			const response: SubmittedResponse = { answer: params.answer, imageAnalysis: params.imageAnalysis };
			onSubmit(response);
			return {
				content: [{ type: "text", text: "Structured response submitted." }],
				details: response,
				terminate: true,
			};
		},
	});
}
