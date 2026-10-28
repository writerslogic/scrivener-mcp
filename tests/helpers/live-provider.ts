export const describeLiveAnthropic =
	process.env.SCRIVENER_RUN_LIVE_AI_TESTS === '1' && process.env.ANTHROPIC_API_KEY?.trim()
		? describe
		: describe.skip;
