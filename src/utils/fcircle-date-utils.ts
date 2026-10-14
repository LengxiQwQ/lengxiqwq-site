export interface FcircleDatePresentation {
	dateKey: string;
	displayDate: string;
	subLabel: string;
	relativeDays: number;
}

interface ZonedDateParts {
	year: number;
	month: number;
	day: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function asDate(dateInput: Date | string): Date {
	return dateInput instanceof Date ? dateInput : new Date(dateInput);
}

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = dateFormatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		dateFormatterCache.set(timeZone, formatter);
	}
	return formatter;
}

function getTimeFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = timeFormatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("zh-CN", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		timeFormatterCache.set(timeZone, formatter);
	}
	return formatter;
}

function getZonedDateParts(
	dateInput: Date | string,
	timeZone: string,
): ZonedDateParts {
	const date = asDate(dateInput);
	const parts = getDateFormatter(timeZone).formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value;

	const year = Number(get("year"));
	const month = Number(get("month"));
	const day = Number(get("day"));

	if (!year || !month || !day) {
		throw new RangeError(`Unable to format date in time zone "${timeZone}"`);
	}

	return { year, month, day };
}

function dateSerial(parts: ZonedDateParts): number {
	return Date.UTC(parts.year, parts.month - 1, parts.day);
}

export function getFcircleDateKey(
	dateInput: Date | string,
	timeZone: string,
): string {
	const { year, month, day } = getZonedDateParts(dateInput, timeZone);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getFcircleRelativeDays(
	dateInput: Date | string,
	referenceInput: Date | string,
	timeZone: string,
): number {
	const itemParts = getZonedDateParts(dateInput, timeZone);
	const referenceParts = getZonedDateParts(referenceInput, timeZone);
	return Math.round(
		(dateSerial(referenceParts) - dateSerial(itemParts)) / ONE_DAY_MS,
	);
}

export function getFcircleDatePresentation(
	dateInput: Date | string,
	referenceInput: Date | string,
	timeZone: string,
): FcircleDatePresentation {
	const itemParts = getZonedDateParts(dateInput, timeZone);
	const referenceParts = getZonedDateParts(referenceInput, timeZone);
	const relativeDays = Math.round(
		(dateSerial(referenceParts) - dateSerial(itemParts)) / ONE_DAY_MS,
	);
	const dateKey = `${itemParts.year}-${String(itemParts.month).padStart(2, "0")}-${String(itemParts.day).padStart(2, "0")}`;
	const weekDayStr =
		WEEK_DAYS[
			new Date(
				Date.UTC(itemParts.year, itemParts.month - 1, itemParts.day),
			).getUTCDay()
		];

	if (relativeDays === 0) {
		return {
			dateKey,
			displayDate: "今天",
			subLabel: `${itemParts.month}月${itemParts.day}日 · ${weekDayStr}`,
			relativeDays,
		};
	}

	if (relativeDays === 1) {
		return {
			dateKey,
			displayDate: "昨天",
			subLabel: `${itemParts.month}月${itemParts.day}日 · ${weekDayStr}`,
			relativeDays,
		};
	}

	if (relativeDays === 2) {
		return {
			dateKey,
			displayDate: "前天",
			subLabel: `${itemParts.month}月${itemParts.day}日 · ${weekDayStr}`,
			relativeDays,
		};
	}

	return {
		dateKey,
		displayDate:
			itemParts.year === referenceParts.year
				? `${itemParts.month}月${itemParts.day}日`
				: `${itemParts.year}年${itemParts.month}月${itemParts.day}日`,
		subLabel: weekDayStr,
		relativeDays,
	};
}

export function formatFcircleTime(
	dateInput: Date | string,
	timeZone: string,
): string {
	return getTimeFormatter(timeZone).format(asDate(dateInput));
}
