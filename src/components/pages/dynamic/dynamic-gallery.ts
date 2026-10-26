import * as FancyboxModule from "@fancyapps/ui";

type GalleryImage = {
	alt: string;
	element: HTMLImageElement;
	src: string;
};

export function registerDynamicGallery(): void {
	if (customElements.get("dynamic-gallery")) return;

	class DynamicGallery extends HTMLElement {
		private activeIndex = 0;
		private images: GalleryImage[] = [];

		connectedCallback() {
			if (this.dataset.ready) return;
			const source = this.dataset.sourceId
				? document.getElementById(this.dataset.sourceId)
				: null;
			if (!source) return;
			const elements = [...source.querySelectorAll<HTMLImageElement>("img")];
			if (elements.length === 0) return;
			this.images = elements.map((element) => {
				let alt = (element.alt || "").trim();
				let customWidth = element.dataset.customWidth;
				if (!customWidth && alt) {
					if (alt.includes("|")) {
						const [text, spec] = alt.split("|").map((s) => s.trim());
						alt = text;
						const lowerSpec = spec.toLowerCase();
						if (
							["表情", "emoji", "meme", "sticker", "sm", "small"].includes(
								lowerSpec,
							)
						) {
							customWidth = "180px";
						} else if (/^\d+(?:px|rem|%)?$/.test(lowerSpec)) {
							customWidth =
								lowerSpec.endsWith("px") ||
								lowerSpec.endsWith("rem") ||
								lowerSpec.endsWith("%")
									? lowerSpec
									: `${lowerSpec}px`;
						}
					} else if (
						["表情", "emoji", "meme", "sticker"].includes(alt.toLowerCase())
					) {
						customWidth = "180px";
					}
					if (customWidth) {
						element.dataset.customWidth = customWidth;
						element.style.setProperty("--custom-width", customWidth);
					}
				}
				return {
					alt,
					element,
					src: element.currentSrc || element.src,
				};
			});
			this.buildGrid();
			this.buildThumbnails();
			this.bindControls();
			this.dataset.ready = "true";
			this.hidden = false;
			document.dispatchEvent(new CustomEvent("dynamic-gallery:ready"));
		}

		private buildGrid() {
			const grid = this.querySelector<HTMLElement>("[data-gallery-grid]");
			if (!grid) return;
			grid.dataset.count = String(Math.min(this.images.length, 6));
			grid.dataset.layout = this.images.length === 1 ? "single" : "grid";
			this.images.slice(0, 6).forEach(({ element, alt }, index) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "page-gallery-grid-item";
				if (element.dataset.customWidth) {
					button.dataset.customWidth = element.dataset.customWidth;
					button.style.setProperty(
						"--custom-width",
						element.dataset.customWidth,
					);
					button.classList.add("is-custom-size");
				}
				button.setAttribute(
					"aria-label",
					(this.dataset.viewImage || "View image {index}").replace(
						"{index}",
						String(index + 1),
					),
				);
				// 单图交互优化：单张图片无需进入卡片内多图画廊，直接调起灯箱放大并支持快速收起；多图则打开卡片内详情
				if (this.images.length === 1) {
					button.addEventListener("click", () => this.openLightbox(0));
				} else {
					button.addEventListener("click", () => this.open(index));
				}
				const paragraph = element.closest<HTMLElement>("p");
				const container =
					element.closest<HTMLElement>("center") ??
					element.closest<HTMLElement>("figure") ??
					element;
				element.alt = alt;
				button.append(element);
				if (index === 5 && this.images.length > 6) {
					const more = document.createElement("span");
					more.className = "page-gallery-more";
					more.textContent = `+${this.images.length - 6}`;
					button.append(more);
				}
				grid.append(button);
				if (container !== element) container.remove();
				if (
					paragraph &&
					!paragraph.textContent?.trim() &&
					paragraph.querySelectorAll("img").length === 0
				) {
					paragraph.remove();
				}
			});
			for (const { element } of this.images.slice(6)) {
				const paragraph = element.closest<HTMLElement>("p");
				(
					element.closest<HTMLElement>("center") ??
					element.closest<HTMLElement>("figure") ??
					element
				).remove();
				if (
					paragraph &&
					!paragraph.textContent?.trim() &&
					paragraph.querySelectorAll("img").length === 0
				) {
					paragraph.remove();
				}
			}
		}

		private buildThumbnails() {
			const thumbnails = this.querySelector<HTMLElement>(
				"[data-gallery-thumbnails]",
			);
			if (!thumbnails) return;
			this.images.forEach(({ element, alt }, index) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "page-gallery-thumbnail";
				button.dataset.index = String(index);
				button.setAttribute(
					"aria-label",
					(this.dataset.selectImage || "Select image {index}").replace(
						"{index}",
						String(index + 1),
					),
				);
				button.addEventListener("click", () => this.select(index));
				const thumbnail = element.cloneNode(true) as HTMLImageElement;
				thumbnail.alt = alt;
				thumbnail.removeAttribute("id");
				button.append(thumbnail);
				thumbnails.append(button);
			});
		}

		private bindControls() {
			this.querySelector("[data-gallery-collapse]")?.addEventListener(
				"click",
				() => this.collapse(),
			);
			this.querySelector("[data-gallery-prev]")?.addEventListener("click", () =>
				this.select(this.activeIndex - 1),
			);
			this.querySelector("[data-gallery-next]")?.addEventListener("click", () =>
				this.select(this.activeIndex + 1),
			);
			this.querySelector("[data-gallery-lightbox]")?.addEventListener(
				"click",
				(event) => {
					event.preventDefault();
					this.openLightbox(this.activeIndex);
				},
			);
			this.querySelector("[data-gallery-main]")?.addEventListener(
				"click",
				(event) => {
					event.preventDefault();
					this.openLightbox(this.activeIndex);
				},
			);
		}

		private open(index: number) {
			if (this.images.length <= 1) {
				this.openLightbox(0);
				return;
			}
			const grid = this.querySelector<HTMLElement>("[data-gallery-grid]");
			const viewer = this.querySelector<HTMLElement>("[data-gallery-viewer]");
			if (!grid || !viewer) return;
			grid.hidden = true;
			viewer.hidden = false;

			const stage = this.querySelector<HTMLElement>(".page-gallery-stage");
			if (stage) stage.dataset.single = "false";

			const prev = this.querySelector<HTMLElement>("[data-gallery-prev]");
			const next = this.querySelector<HTMLElement>("[data-gallery-next]");
			const thumbnails = this.querySelector<HTMLElement>(
				"[data-gallery-thumbnails]",
			);
			const counter = this.querySelector<HTMLElement>("[data-gallery-counter]");

			prev?.removeAttribute("hidden");
			next?.removeAttribute("hidden");
			thumbnails?.removeAttribute("hidden");
			counter?.removeAttribute("hidden");

			this.select(index);
		}

		private collapse() {
			const grid = this.querySelector<HTMLElement>("[data-gallery-grid]");
			const viewer = this.querySelector<HTMLElement>("[data-gallery-viewer]");
			if (!grid || !viewer) return;
			grid.hidden = false;
			viewer.hidden = true;
		}

		private openLightbox(index: number) {
			const Fancybox = FancyboxModule.Fancybox;
			if ((Fancybox as any)?.Plugins?.Hash) {
				delete (Fancybox as any).Plugins.Hash;
			}
			const isSingle = this.images.length === 1;
			Fancybox.show(
				this.images.map((image) => ({
					src: image.src,
					type: "image",
					triggerEl: image.element,
					thumbEl: image.element,
				})),
				{
					startIndex: index,
					Hash: false,
					closeExisting: true,
					preload: 1,
					dragToClose: true,
					backdropClick: "close",
					Panzoom: {
						maxScale: 2,
						minScale: 1,
					},
					Toolbar: {
						display: isSingle
							? {
									left: [],
									middle: ["zoomIn", "zoomOut", "toggle1to1"],
									right: ["close"],
								}
							: {
									left: ["infobar"],
									middle: [
										"zoomIn",
										"zoomOut",
										"toggle1to1",
										"rotateCCW",
										"rotateCW",
										"flipX",
										"flipY",
									],
									right: ["slideshow", "thumbs", "close"],
								},
					},
					Thumbs: {
						autoStart: !isSingle,
						minCount: 3,
					},
					on: {
						destroy: (fb: any) => {
							try {
								const container = fb.getContainer();
								if (container) {
									const imgs = container.querySelectorAll("img");
									imgs.forEach((img: HTMLImageElement) => {
										img.src = "";
									});
								}
							} catch {}
						},
					},
				} as any,
			);
		}

		private select(index: number) {
			this.activeIndex = (index + this.images.length) % this.images.length;
			const counter = this.querySelector<HTMLElement>("[data-gallery-counter]");
			if (counter)
				counter.textContent = `${this.activeIndex + 1} / ${this.images.length}`;
			const image = this.images[this.activeIndex];
			const main = this.querySelector<HTMLImageElement>("[data-gallery-main]");
			if (!main) return;
			main.src = image.src;
			main.alt = image.alt;
			main.dataset.galleryIndex = String(this.activeIndex);
			this.querySelector<HTMLElement>("[data-gallery-lightbox]")?.setAttribute(
				"data-src",
				image.src,
			);
			this.querySelectorAll<HTMLElement>(
				"[data-gallery-thumbnails] [data-index]",
			).forEach((thumbnail) => {
				thumbnail.dataset.active = String(
					Number(thumbnail.dataset.index) === this.activeIndex,
				);
			});
			this.querySelector<HTMLElement>(
				`[data-gallery-thumbnails] [data-index="${this.activeIndex}"]`,
			)?.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
				inline: "center",
			});
		}
	}

	customElements.define("dynamic-gallery", DynamicGallery);
}
