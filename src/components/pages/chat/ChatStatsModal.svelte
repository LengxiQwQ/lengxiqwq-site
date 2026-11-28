<script lang="ts">
import type { InterconnectSite } from "@/types/chatConfig";
import ChatModal from "./ChatModal.svelte";
import ChatStatsView, {
	type ChatStatsLayoutMode,
} from "./ChatStatsView.svelte";
import { DEFAULT_CHAT_SERVER_URL } from "./chatReactions";
import type { ChatStatsRange, ChatStatsRoomScope } from "./chatStatsTypes";
import type { ChatUserDetailSeed } from "./chatTypes";
import type { StickerItem } from "./stickerLoader";

interface Props {
	open: boolean;
	initialRoom?: ChatStatsRoomScope;
	initialRange?: ChatStatsRange;
	initialDate?: string;
	chatServerUrl?: string;
	interconnectSites?: InterconnectSite[];
	stickerMap?: Map<string, StickerItem>;
	showBackButton?: boolean;
	onBack?: () => void;
	onClose: () => void;
	onChangeLayoutMode?: (mode: ChatStatsLayoutMode) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
}

const {
	open,
	initialRoom = "interconnect",
	initialRange = "all",
	initialDate = "",
	chatServerUrl = DEFAULT_CHAT_SERVER_URL,
	interconnectSites = [],
	stickerMap,
	showBackButton = false,
	onBack,
	onClose,
	onChangeLayoutMode,
	onOpenUserProfile,
}: Props = $props();

let activeRoom = $state<ChatStatsRoomScope>(initialRoom);
let isStatsLoading = $state(false);
let statsViewRef = $state<{ refresh: () => void } | null>(null);

$effect(() => {
	if (open) {
		activeRoom = initialRoom;
	}
});

const modalSubtitle = $derived(
	activeRoom === "chat"
		? "#闲聊 · 实时统计"
		: activeRoom === "all"
			? "全站双房间 · 实时统计"
			: "#互联茶室 · 实时统计",
);
</script>

<ChatModal
  open={open}
  title="茶室数据看板"
  subtitle={modalSubtitle}
  size="lg"
  fillHeightOnDesktop={true}
  mobile="full"
  dialogClass="chat-stats-dialog"
  showBackButton={showBackButton}
  onBack={showBackButton ? onBack : undefined}
  onClose={onClose}
>
  {#snippet headerLeft()}
    <button
      type="button"
      class="chat-tool-btn chat-dialog-header-btn shrink-0"
      aria-label="刷新统计数据"
      disabled={isStatsLoading}
      onclick={() => statsViewRef?.refresh()}
    >
      <svg class="w-4 h-4 {isStatsLoading ? 'animate-spin text-[var(--skin-accent)]' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
    </button>
  {/snippet}
  <ChatStatsView
    bind:this={statsViewRef}
    active={open}
    layoutMode="modal"
    initialRoom={initialRoom}
    initialRange={initialRange}
    initialDate={initialDate}
    chatServerUrl={chatServerUrl}
    interconnectSites={interconnectSites}
    stickerMap={stickerMap}
    showBackButton={false}
    onRoomChange={(nextRoom) => (activeRoom = nextRoom)}
    onLoadingChange={(loading) => (isStatsLoading = loading)}
    onChangeLayoutMode={onChangeLayoutMode}
    onOpenUserProfile={onOpenUserProfile}
  />
</ChatModal>
