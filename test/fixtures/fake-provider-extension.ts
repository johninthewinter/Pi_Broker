import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fakeProviderExtension(pi: ExtensionAPI) {
	const fakeProviderUrl = process.env.PI_BROKER_FAKE_PROVIDER_URL;
	if (!fakeProviderUrl) return;

	pi.registerProvider("pi-broker-poc", {
		baseUrl: fakeProviderUrl,
		apiKey: "poc-local-no-secret",
		api: "openai-completions",
		models: [
			{
				id: "deterministic",
				name: "Pi Broker deterministic POC",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	});
}
