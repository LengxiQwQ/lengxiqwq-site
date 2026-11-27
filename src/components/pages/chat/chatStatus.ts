export const MAX_CHAT_STATUS_CHARACTERS = 20;
const MAX_MATRIX_STATUS_BYTES = 256;
const statusSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});
const statusEncoder = new TextEncoder();

export function countChatStatusCharacters(status: string): number {
	return Array.from(statusSegmenter.segment(status)).length;
}

export function fitsMatrixStatus(status: string): boolean {
	return statusEncoder.encode(status).length <= MAX_MATRIX_STATUS_BYTES;
}
