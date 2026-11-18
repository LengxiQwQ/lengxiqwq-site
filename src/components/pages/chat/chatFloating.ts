import {
	autoUpdate,
	computePosition,
	flip,
	hide,
	limitShift,
	offset,
	type Placement,
	shift,
	size,
} from "@floating-ui/dom";

interface ChatFloatingOptions {
	placement?: Placement;
	reference?: HTMLElement | null;
	gap?: number;
	hover?: "tooltip" | "card";
	forceOpen?: boolean;
	onReferenceHidden?: () => void;
}

const tooltipExitDuration = 90;
let dismissActiveTooltip: (() => void) | undefined;
let dismissActiveCard: (() => void) | undefined;

export function positionChatFloating(
	node: HTMLElement,
	initialOptions: ChatFloatingOptions = {},
): { update: (options: ChatFloatingOptions) => void; destroy: () => void } {
	let options = initialOptions;
	const wrapper = node.parentElement;
	let stopPositioning: (() => void) | undefined;
	let refreshPosition: (() => void) | undefined;
	let closeTimer: number | undefined;
	let hovered = false;
	let focused = false;

	function stop() {
		window.clearTimeout(closeTimer);
		stopPositioning?.();
		stopPositioning = undefined;
		refreshPosition = undefined;
		delete node.dataset.chatFloatingState;
		delete node.dataset.chatTooltipLeaving;
		if (dismissActiveTooltip === dismissTooltip) {
			dismissActiveTooltip = undefined;
		}
		if (dismissActiveCard === dismissCard) {
			dismissActiveCard = undefined;
		}
	}

	function dismissTooltip() {
		hovered = false;
		focused = false;
		stop();
	}

	function dismissCard() {
		hovered = false;
		focused = false;
		stop();
	}

	function start() {
		if (options.hover === "tooltip") {
			if (node.dataset.chatTooltipLeaving !== undefined) {
				window.clearTimeout(closeTimer);
				delete node.dataset.chatTooltipLeaving;
			}
			if (options.forceOpen) {
				if (dismissActiveTooltip === dismissTooltip) {
					dismissActiveTooltip = undefined;
				}
			} else if (dismissActiveTooltip !== dismissTooltip) {
				dismissActiveTooltip?.();
				dismissActiveTooltip = dismissTooltip;
			}
		} else if (options.hover === "card") {
			if (options.forceOpen && dismissActiveCard === dismissCard) {
				dismissActiveCard = undefined;
			}
		}
		if (stopPositioning) return;
		const reference = options.reference ?? wrapper;
		if (!reference) return;
		const messageViewport = reference.closest("[data-chat-message-scroll]");
		// A message menu must fit above the composer even though the document viewport extends below it.
		const boundary = messageViewport ?? "clippingAncestors";
		const boundaries = { boundary, altBoundary: true, padding: 6 } as const;
		let request = 0;
		refreshPosition = () => {
			const current = ++request;
			if (node.dataset.chatFloatingState !== "ready") {
				node.dataset.chatFloatingState = "measuring";
			}
			// Measure the preferred size again so a previous cap cannot prevent a needed flip.
			node.style.removeProperty("--chat-floating-width");
			node.style.removeProperty("--chat-floating-height");
			void computePosition(reference, node, {
				placement: options.placement ?? "top",
				middleware: [
					offset(options.gap ?? 6),
					flip(boundaries),
					shift({ ...boundaries, limiter: limitShift() }),
					size({
						...boundaries,
						apply({ availableWidth, availableHeight }) {
							if (current !== request) return;
							node.style.setProperty(
								"--chat-floating-width",
								`${Math.max(0, Math.floor(availableWidth))}px`,
							);
							node.style.setProperty(
								"--chat-floating-height",
								`${Math.max(0, Math.floor(availableHeight))}px`,
							);
						},
					}),
					hide({ boundary }),
				],
			}).then(({ x, y, placement, middlewareData }) => {
				if (current !== request) return;
				if (middlewareData.hide?.referenceHidden) {
					delete node.dataset.chatFloatingState;
					options.onReferenceHidden?.();
					return;
				}
				node.style.setProperty("--chat-floating-x", `${x}px`);
				node.style.setProperty("--chat-floating-y", `${y}px`);
				if (options.hover === "tooltip") {
					node.dataset.chatTooltipSide = placement.split("-")[0];
				} else if (options.hover === "card" && !options.forceOpen) {
					if (dismissActiveCard && dismissActiveCard !== dismissCard) {
						dismissActiveCard();
					}
					dismissActiveCard = dismissCard;
				}
				node.dataset.chatFloatingState = "ready";
			});
		};
		const cleanup = autoUpdate(reference, node, refreshPosition);
		if (options.hover) window.addEventListener("keydown", handleKeyDown);
		stopPositioning = () => {
			request++;
			cleanup();
			window.removeEventListener("keydown", handleKeyDown);
		};
	}

	function sync() {
		if (!options.hover || options.forceOpen || hovered || focused) {
			start();
			return;
		}
		if (
			options.hover === "tooltip" &&
			node.dataset.chatFloatingState === "ready" &&
			!window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			if (node.dataset.chatTooltipLeaving === undefined) {
				node.dataset.chatTooltipLeaving = "";
				closeTimer = window.setTimeout(stop, tooltipExitDuration);
			}
			return;
		}
		stop();
	}

	function handlePointerEnter(event: PointerEvent) {
		if (event.pointerType === "touch") return;
		window.clearTimeout(closeTimer);
		hovered = true;
		sync();
	}

	function handlePointerLeave() {
		hovered = false;
		sync();
	}

	function handleFocusIn() {
		focused = Boolean(wrapper?.querySelector(":focus-visible"));
		sync();
	}

	function handleFocusOut(event: FocusEvent) {
		if (
			event.relatedTarget instanceof Node &&
			wrapper?.contains(event.relatedTarget)
		)
			return;
		focused = false;
		sync();
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key !== "Escape" || options.forceOpen) return;
		dismissTooltip();
	}

	if (options.hover) {
		hovered =
			Boolean(wrapper?.matches(":hover")) &&
			window.matchMedia("(any-hover: hover)").matches;
		focused = Boolean(wrapper?.querySelector(":focus-visible"));
		wrapper?.addEventListener("pointerenter", handlePointerEnter);
		wrapper?.addEventListener("pointerleave", handlePointerLeave);
		wrapper?.addEventListener("focusin", handleFocusIn);
		wrapper?.addEventListener("focusout", handleFocusOut);
	}
	sync();

	return {
		update(nextOptions) {
			if (options.reference !== nextOptions.reference) stop();
			options = nextOptions;
			sync();
			refreshPosition?.();
		},
		destroy() {
			stop();
			if (!options.hover) return;
			wrapper?.removeEventListener("pointerenter", handlePointerEnter);
			wrapper?.removeEventListener("pointerleave", handlePointerLeave);
			wrapper?.removeEventListener("focusin", handleFocusIn);
			wrapper?.removeEventListener("focusout", handleFocusOut);
		},
	};
}
