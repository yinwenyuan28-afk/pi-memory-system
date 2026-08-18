/**
 * Escape XML section boundary tags in injected memory content.
 * Aligns with Tencent MemoryCore escapeXmlTags (sanitize.ts).
 */
export function escapeXmlTags(text: string): string {
	return text.replace(
		/<\/?(?:user-persona|relevant-memories|scene-navigation|relevant-scenes|memory-tools-guide|memory-context|system|assistant)>/gi,
		(match) => match.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
	);
}
