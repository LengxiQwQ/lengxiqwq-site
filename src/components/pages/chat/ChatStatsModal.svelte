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
</script>

<ChatModal
  open={open}
  title="茶室数据看板"
  subtitle={initialRoom === "chat" ? "#闲聊 · 实时统计" : "#互联茶室 · 实时统计"}
  size="lg"
  fillHeightOnDesktop={true}
  mobile="full"
  dialogClass="chat-stats-dialog"
  showBackButton={showBackButton}
  onBack={onBack}
  onClose={onClose}
>
  <ChatStatsView
    active={open}
    layoutMode="modal"
    initialRoom={initialRoom}
    initialRange={initialRange}
    initialDate={initialDate}
    chatServerUrl={chatServerUrl}
    interconnectSites={interconnectSites}
    stickerMap={stickerMap}
    showBackButton={false}
    onChangeLayoutMode={onChangeLayoutMode}
    onOpenUserProfile={onOpenUserProfile}
  />
</ChatModal>
