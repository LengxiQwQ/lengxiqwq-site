<script lang="ts" generics="T extends string = string">
import { fade } from "svelte/transition";

export interface SelectOption<V = string> {
	value: V;
	label: string;
}

interface Props {
	value: T;
	options: SelectOption<T>[];
	onChange?: (value: T) => void;
	class?: string;
	panelClass?: string;
	ariaLabel?: string;
}

let {
	value = $bindable(),
	options,
	onChange,
	class: className = "",
	panelClass = "",
	ariaLabel = "Select option",
}: Props = $props();

let isOpen = $state(false);
let containerEl = $state<HTMLElement | null>(null);

const currentOption = $derived(options.find((opt) => opt.value === value));
const currentLabel = $derived(currentOption ? currentOption.label : "");

function toggleOpen(e: MouseEvent) {
	e.stopPropagation();
	isOpen = !isOpen;
}

function selectOption(optValue: T) {
	value = optValue;
	onChange?.(optValue);
	isOpen = false;
}

function handleWindowClick(e: MouseEvent) {
	if (isOpen && containerEl && !containerEl.contains(e.target as Node)) {
		isOpen = false;
	}
}

function handleKeydown(e: KeyboardEvent) {
	if (!isOpen) {
		if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
			e.preventDefault();
			isOpen = true;
		}
		return;
	}

	if (e.key === "Escape") {
		e.preventDefault();
		isOpen = false;
		return;
	}

	const currentIndex = options.findIndex((opt) => opt.value === value);

	if (e.key === "ArrowDown") {
		e.preventDefault();
		const nextIndex = (currentIndex + 1) % options.length;
		selectOption(options[nextIndex].value);
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		const prevIndex = (currentIndex - 1 + options.length) % options.length;
		selectOption(options[prevIndex].value);
	} else if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		isOpen = false;
	}
}
</script>

<svelte:window onclick={handleWindowClick} />

<div
	class="relative inline-block {isOpen ? 'z-50' : 'z-10'}"
	bind:this={containerEl}
	onkeydown={handleKeydown}
>
	<button
		type="button"
		onclick={toggleOpen}
		aria-haspopup="listbox"
		aria-expanded={isOpen}
		aria-label={ariaLabel}
		class="inline-flex items-center justify-between gap-2 min-w-[9.25rem] px-3.5 py-1.5 text-xs md:text-sm rounded-xl bg-(--card-bg) border border-(--line-divider) text-neutral-700 dark:text-neutral-300 hover:border-(--primary) focus:outline-hidden focus:border-(--primary) transition-all duration-200 shadow-2xs cursor-pointer select-none whitespace-nowrap {isOpen ? 'border-(--primary) ring-2 ring-(--primary)/20' : ''} {className}"
	>
		<span class="truncate">{currentLabel}</span>
		<svg
			class="w-3.5 h-3.5 text-neutral-400 transition-transform duration-200 shrink-0 {isOpen ? 'rotate-180 text-(--primary)' : ''}"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
		>
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if isOpen}
		<div
			class="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-50 min-w-full w-max"
			transition:fade={{ duration: 120 }}
		>
			<div
				class="rounded-2xl p-1.5 bg-(--card-bg) border border-black/5 dark:border-white/10 shadow-xl backdrop-blur-md flex flex-col gap-1 {panelClass}"
				role="listbox"
				tabindex="-1"
			>
				{#each options as opt (opt.value)}
					<button
						type="button"
						class="flex items-center justify-between w-full h-9 px-3 rounded-xl text-xs md:text-sm font-medium transition-all duration-150 cursor-pointer select-none text-left whitespace-nowrap active:scale-95 {opt.value === value
							? 'bg-(--primary)/10 text-(--primary) font-semibold'
							: 'text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'}"
						onclick={() => selectOption(opt.value)}
						role="option"
						aria-selected={opt.value === value}
					>
						<span class="mr-2.5">{opt.label}</span>
						{#if opt.value === value}
							<svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
							</svg>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>
