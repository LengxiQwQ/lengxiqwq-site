const GITHUB_REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const GITHUB_URL_PATTERN =
	/^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\/.*)?$/i;

export function isValidGithubRepository(repo: unknown): repo is string {
	return typeof repo === "string" && GITHUB_REPOSITORY_PATTERN.test(repo);
}

/** 从 GitHub URL 中提取 "owner/repo" 仓库标识 */
export function parseGithubRepoFromUrl(
	url: string | undefined | null,
): string | null {
	if (!url) return null;
	const match = url.trim().match(GITHUB_URL_PATTERN);
	if (!match) return null;
	const repo = match[1].replace(/\.git$/i, "");
	return isValidGithubRepository(repo) ? repo : null;
}

/** 紧凑计数（如 1.2K / 3.4M），去掉英文字符计数里的窄不换行空格 */
export function formatCount(value: number): string {
	return Intl.NumberFormat("en-us", {
		notation: "compact",
		maximumFractionDigits: 1,
	})
		.format(value)
		.replaceAll(" ", "");
}
