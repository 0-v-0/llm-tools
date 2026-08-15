import type { LLMProvider, LLMMessage } from '@llm-image/shared';

const SYSTEM_PROMPT = `You are an image description assistant. Your task is to provide a concise, factual description of the given image. Focus on:

1. Main subject(s) — what is/are the primary object(s) or person(s)
2. Scene/setting — where is this taking place (indoor/outdoor, type of location)
3. Colors and lighting — dominant colors, brightness, mood
4. Composition — camera angle, framing, notable visual elements
5. Style — photograph, illustration, painting, screenshot, etc.

Keep the description to 2-4 sentences. Be objective and descriptive, not interpretive. Do not speculate about emotions or narratives beyond what is visually evident.`;

export interface DescribeOptions {
	provider: LLMProvider;
	/** Full data URI, e.g. data:image/jpeg;base64,... */
	imageDataUri: string;
}

export async function describeImage(opts: DescribeOptions): Promise<string> {
	const { provider, imageDataUri } = opts;

	const messages: LLMMessage[] = [
		{
			role: 'system',
			content: SYSTEM_PROMPT,
		},
		{
			role: 'user',
			content: [
				{
					type: 'image_url',
					image_url: {
						url: imageDataUri,
					},
				},
				{
					type: 'text',
					text: 'Please describe this image concisely and factually.',
				},
			],
		},
	];

	const response = await provider.complete({ model: provider.model, messages });

	if (!response.text) {
		throw new Error('LLM returned no text description');
	}

	return response.text.trim();
}
