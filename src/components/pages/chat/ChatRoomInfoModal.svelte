<script lang="ts">
import { tick } from "svelte";
import type { InterconnectSite } from "@/types/chatConfig";
import ChatAvatarCropModal from "./ChatAvatarCropModal.svelte";
import ChatModal from "./ChatModal.svelte";
import { resolveExternalOrigin } from "./chatClient";
import type {
	ChatRoomActionResult,
	ChatRoomEditableCaps,
	ChatRoomGuestAccess,
	ChatRoomHistoryVisibility,
	ChatRoomJoinRule,
	ChatRoomMetaInfo,
	ChatRoomPowerLevelPatch,
} from "./chatTypes";

type InlineEditTarget =
	| "roomName"
	| "topic"
	| "canonicalAlias"
	| "joinRule"
	| "historyVisibility"
	| "guestAccess"
	| "pl:usersDefault"
	| "pl:eventsDefault"
	| "pl:stateDefault"
	| "pl:invite"
	| "pl:kick"
	| "pl:ban"
	| "pl:redact"
	| "pl:notificationsRoom"
	| "pl:addUser"
	| `plUser:${string}`;

interface Props {
	open: boolean;
	roomId: string;
	roomName: string;
	matrixRoomName?: string;
	roomAvatar?: string;
	roomTopic?: string;
	roomMeta?: ChatRoomMetaInfo | null;
	isAdmin?: boolean;
	chatServerUrl?: string;
	auth?: { kind: "waline" | "guest"; token: string } | null;
	interconnectSites?: InterconnectSite[];
	roomOnlineCount?: number;
	externalOnlineCount?: number;
	observerCount?: number;
	interconnectSitesCount?: number;
	onClose: () => void;
	onOpenInterconnectSites?: () => void;
	onSetRoomName?: (roomName: string) => Promise<ChatRoomActionResult>;
	onSetTopic?: (topic: string) => Promise<ChatRoomActionResult>;
	onSetRoomAvatar?: (avatarUrl: string) => Promise<ChatRoomActionResult>;
	onSetRoomJoinRule?: (
		joinRule: ChatRoomJoinRule,
	) => Promise<ChatRoomActionResult>;
	onSetRoomHistoryVisibility?: (
		historyVisibility: ChatRoomHistoryVisibility,
	) => Promise<ChatRoomActionResult>;
	onSetRoomGuestAccess?: (
		guestAccess: ChatRoomGuestAccess,
	) => Promise<ChatRoomActionResult>;
	onSetRoomCanonicalAlias?: (
		canonicalAlias: string,
		altAliases?: string[],
	) => Promise<ChatRoomActionResult>;
	onSetRoomPowerLevels?: (
		patch: ChatRoomPowerLevelPatch,
	) => Promise<ChatRoomActionResult>;
	onNotify?: (message: string, tone?: "default" | "error" | "success") => void;
}

const {
	open,
	roomId = "interconnect",
	roomName = "互联茶室",
	matrixRoomName = "",
	roomAvatar = "",
	roomTopic = "",
	roomMeta = null,
	isAdmin = false,
	chatServerUrl = "",
	auth = null,
	interconnectSites = [],
	roomOnlineCount = 0,
	externalOnlineCount = 0,
	observerCount = 0,
	interconnectSitesCount = 0,
	onClose,
	onOpenInterconnectSites,
	onSetRoomName,
	onSetTopic,
	onSetRoomAvatar,
	onSetRoomJoinRule,
	onSetRoomHistoryVisibility,
	onSetRoomGuestAccess,
	onSetRoomCanonicalAlias,
	onSetRoomPowerLevels,
	onNotify,
}: Props = $props();

const DEFAULT_FALLBACK_ALIAS = "#lobby:detached.online";
const DEFAULT_FALLBACK_ROOM_ID = "!CKQYQ95MT69FlskJmkcEbSmkd72I6CTgnf_nITckm4I";

const isInterconnect = $derived(roomId === "interconnect");

const defaultCaps = $derived<ChatRoomEditableCaps>({
	name: isInterconnect,
	topic: true,
	avatar: true,
	joinRule: isInterconnect,
	historyVisibility: isInterconnect,
	guestAccess: isInterconnect,
	canonicalAlias: isInterconnect,
	powerLevels: isInterconnect,
	pinnedEvents: true,
});

const effectiveCaps = $derived<ChatRoomEditableCaps>(
	roomMeta?.canEdit ?? defaultCaps,
);

function canEditField(key: keyof ChatRoomEditableCaps): boolean {
	return Boolean(isAdmin && effectiveCaps[key]);
}

const effectiveMatrixRoomName = $derived(
	matrixRoomName || (isInterconnect ? "互联聊天室" : roomName),
);
const effectiveAlias = $derived(
	(roomMeta?.canonicalAlias || "").trim() ||
		(isInterconnect ? DEFAULT_FALLBACK_ALIAS : ""),
);
const effectiveMatrixRoomId = $derived(
	(roomMeta?.matrixRoomId || "").trim() ||
		(isInterconnect ? DEFAULT_FALLBACK_ROOM_ID : ""),
);
const matrixToUrl = $derived(
	effectiveAlias
		? `https://matrix.to/#/${effectiveAlias}`
		: effectiveMatrixRoomId
			? `https://matrix.to/#/${effectiveMatrixRoomId}`
			: "",
);

const creatorsList = $derived.by(() => {
	const set = new Set<string>();
	if (roomMeta?.creator) set.add(roomMeta.creator);
	for (const c of roomMeta?.additionalCreators ?? []) {
		if (c) set.add(c);
	}
	return Array.from(set);
});
const creatorsSet = $derived(new Set(creatorsList));

const powerUserEntries = $derived.by(() => {
	const users = roomMeta?.powerLevels?.users ?? {};
	return Object.entries(users)
		.filter(([uid]) => !creatorsSet.has(uid))
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return a[0].localeCompare(b[0]);
		});
});

let editingField = $state<InlineEditTarget | null>(null);
let textDraft = $state("");
let selectDraft = $state("");
let numberDraft = $state(0);
let newUserIdDraft = $state("");
let newUserLevelDraft = $state(50);
let savingField = $state<InlineEditTarget | "avatar" | null>(null);
let avatarModalOpen = $state(false);
let avatarFailed = $state(false);
let copiedKey = $state<"alias" | "roomId" | "">("");

let activeInputEl = $state<
	HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
>(null);

$effect(() => {
	if (open) {
		editingField = null;
		savingField = null;
		avatarModalOpen = false;
		avatarFailed = false;
		copiedKey = "";
	}
});

$effect(() => {
	roomAvatar;
	avatarFailed = false;
});

function describeJoinRule(rule?: string): { label: string; desc: string } {
	switch (rule) {
		case "public":
			return { label: "公开加入 (public)", desc: "任意联邦用户可直接加入" };
		case "invite":
			return { label: "仅限邀请 (invite)", desc: "需由管理员邀请后加入" };
		case "knock":
			return { label: "敲门申请 (knock)", desc: "提交申请经批准后加入" };
		default:
			return { label: rule || "未知", desc: "由 Matrix 房间状态同步" };
	}
}

function describeHistoryVisibility(vis?: string): {
	label: string;
	desc: string;
} {
	switch (vis) {
		case "world_readable":
			return {
				label: "所有人可读 (world_readable)",
				desc: "未加入也可预览历史消息",
			};
		case "shared":
			return {
				label: "成员共享 (shared)",
				desc: "所有已加入成员可查看完整历史",
			};
		case "invited":
			return {
				label: "自受邀起 (invited)",
				desc: "仅可查看受邀后的消息记录",
			};
		case "joined":
			return {
				label: "自加入起 (joined)",
				desc: "仅可查看加入后的消息记录",
			};
		default:
			return { label: vis || "未知", desc: "由 Matrix 房间状态同步" };
	}
}

function describeGuestAccess(guest?: string): { label: string; desc: string } {
	switch (guest) {
		case "can_join":
			return {
				label: "允许访客 (can_join)",
				desc: "允许 Matrix 匿名访客直连",
			};
		case "forbidden":
			return {
				label: "禁止访客 (forbidden)",
				desc: "Matrix 联邦侧禁止匿名访客",
			};
		default:
			return { label: guest || "未知", desc: "由 Matrix 房间状态同步" };
	}
}

function resolveMatrixUserSiteLabel(matrixId: string): string {
	const origin = resolveExternalOrigin(
		{
			name: "",
			userKey: matrixId,
			matrixSender: matrixId,
		},
		interconnectSites,
	);
	return origin.chatBadge || origin.host || "";
}

function canEditPowerUser(userId: string, level: number): boolean {
	if (!canEditField("powerLevels")) return false;
	if (creatorsSet.has(userId)) return false;
	if (roomMeta?.isCreator) return true;
	if (userId === roomMeta?.adminUserId) return true;
	const myPl = roomMeta?.adminPowerLevel ?? 100;
	return level < myPl;
}

async function startInlineEdit(target: InlineEditTarget) {
	if (!isAdmin || savingField) return;
	editingField = target;
	if (target === "roomName") {
		textDraft = effectiveMatrixRoomName;
	} else if (target === "topic") {
		textDraft = roomTopic || "";
	} else if (target === "canonicalAlias") {
		textDraft = roomMeta?.canonicalAlias || effectiveAlias;
	} else if (target === "joinRule") {
		selectDraft = roomMeta?.joinRule || "invite";
	} else if (target === "historyVisibility") {
		selectDraft = roomMeta?.historyVisibility || "shared";
	} else if (target === "guestAccess") {
		selectDraft = roomMeta?.guestAccess || "forbidden";
	} else if (target === "pl:addUser") {
		newUserIdDraft = "";
		newUserLevelDraft = 50;
	} else if (target.startsWith("pl:")) {
		const pl = roomMeta?.powerLevels;
		const key = target.slice(3) as keyof NonNullable<typeof pl>;
		const val = pl ? pl[key] : 0;
		numberDraft = typeof val === "number" ? val : 0;
	} else if (target.startsWith("plUser:")) {
		const uid = target.slice(7);
		numberDraft = roomMeta?.powerLevels?.users?.[uid] ?? 0;
	}
	await tick();
	activeInputEl?.focus({ preventScroll: true });
	if (
		activeInputEl instanceof HTMLInputElement &&
		activeInputEl.type !== "number"
	) {
		activeInputEl.select();
	}
}

function cancelEdit() {
	if (savingField) return;
	editingField = null;
}

function handleInlineKeydown(event: KeyboardEvent, multiline = false) {
	if (event.isComposing) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		cancelEdit();
		return;
	}
	if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
		event.preventDefault();
		void commitInlineEdit();
	}
}

async function commitInlineEdit() {
	const field = editingField;
	if (!field || savingField) return;

	if (field === "roomName") {
		const trimmed = textDraft
			.replace(/[\r\n]+/g, " ")
			.trim()
			.slice(0, 80);
		if (!trimmed) {
			onNotify?.("房间名称不能为空", "error");
			return;
		}
		if (trimmed === effectiveMatrixRoomName) {
			editingField = null;
			return;
		}
		if (!onSetRoomName) return;
		savingField = field;
		const res = await onSetRoomName(trimmed);
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.("已同步新的 Matrix 房间名", "success");
		} else {
			onNotify?.(res.error || "修改房间名失败", "error");
		}
		return;
	}

	if (field === "topic") {
		const trimmed = textDraft
			.replace(/[\r\n]+/g, " ")
			.trim()
			.slice(0, 160);
		if (trimmed === (roomTopic || "").trim()) {
			editingField = null;
			return;
		}
		if (!onSetTopic) return;
		savingField = field;
		const res = await onSetTopic(trimmed);
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.(trimmed ? "已更新房间主题" : "已清空房间主题", "success");
		} else {
			onNotify?.(res.error || "更新房间主题失败", "error");
		}
		return;
	}

	if (field === "canonicalAlias") {
		const trimmed = textDraft.trim().slice(0, 120);
		if (trimmed === (roomMeta?.canonicalAlias || "").trim()) {
			editingField = null;
			return;
		}
		if (trimmed && !/^#[^:\s]+:[^:\s]+(?::\d+)?$/.test(trimmed)) {
			onNotify?.(
				"别名格式应为 #房间名:域名（如 #lobby:detached.online）",
				"error",
			);
			return;
		}
		if (!onSetRoomCanonicalAlias) return;
		savingField = field;
		const res = await onSetRoomCanonicalAlias(trimmed);
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.("已更新 Matrix 规范别名", "success");
		} else {
			onNotify?.(res.error || "更新规范别名失败", "error");
		}
		return;
	}

	if (field === "joinRule") {
		const next = selectDraft as ChatRoomJoinRule;
		if (next === roomMeta?.joinRule) {
			editingField = null;
			return;
		}
		if (!onSetRoomJoinRule) return;
		savingField = field;
		const res = await onSetRoomJoinRule(next);
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.("已更新加入规则", "success");
		} else {
			onNotify?.(res.error || "更新加入规则失败", "error");
		}
		return;
	}

	if (field === "historyVisibility") {
		const next = selectDraft as ChatRoomHistoryVisibility;
		if (next === roomMeta?.historyVisibility) {
			editingField = null;
			return;
		}
		if (!onSetRoomHistoryVisibility) return;
		savingField = field;
		const res = await onSetRoomHistoryVisibility(next);
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.("已更新历史消息可见性", "success");
		} else {
			onNotify?.(res.error || "更新历史消息可见性失败", "error");
		}
		return;
	}

	if (field === "guestAccess") {
		const next = selectDraft as ChatRoomGuestAccess;
		if (next === roomMeta?.guestAccess) {
			editingField = null;
			return;
		}
		if (!onSetRoomGuestAccess) return;
		savingField = field;
		const res = await onSetRoomGuestAccess(next);
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.("已更新访客访问策略", "success");
		} else {
			onNotify?.(res.error || "更新访客策略失败", "error");
		}
		return;
	}

	if (field === "pl:addUser") {
		const uid = newUserIdDraft.trim();
		if (!/^@[^:\s]+:[^:\s]+(?::\d+)?$/.test(uid)) {
			onNotify?.("请输入合法的 Matrix ID（如 @user:domain.com）", "error");
			return;
		}
		if (creatorsSet.has(uid)) {
			onNotify?.("房间创建者权限由协议固定，无法在此修改", "error");
			return;
		}
		const maxPl = roomMeta?.isCreator
			? 100
			: (roomMeta?.adminPowerLevel ?? 100);
		const lv = Math.trunc(Number(newUserLevelDraft));
		if (!Number.isFinite(lv) || lv < -1 || lv > maxPl) {
			onNotify?.(`权限等级必须在 -1 ~ ${maxPl} 之间`, "error");
			return;
		}
		if (!onSetRoomPowerLevels) return;
		savingField = field;
		const res = await onSetRoomPowerLevels({
			setUser: { userId: uid, level: lv },
		});
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.(`已设置 ${uid} 权限为 PL ${lv}`, "success");
		} else {
			onNotify?.(res.error || "设置成员权限失败", "error");
		}
		return;
	}

	if (field.startsWith("pl:")) {
		const key = field.slice(3) as keyof ChatRoomPowerLevelPatch;
		const minVal = key === "usersDefault" ? -1 : 0;
		const maxPl = roomMeta?.isCreator
			? 100
			: (roomMeta?.adminPowerLevel ?? 100);
		const lv = Math.trunc(Number(numberDraft));
		if (!Number.isFinite(lv) || lv < minVal || lv > maxPl) {
			onNotify?.(`权限值必须在 ${minVal} ~ ${maxPl} 之间`, "error");
			return;
		}
		const curVal =
			roomMeta?.powerLevels?.[
				key as keyof NonNullable<typeof roomMeta.powerLevels>
			];
		if (lv === curVal) {
			editingField = null;
			return;
		}
		if (!onSetRoomPowerLevels) return;
		savingField = field;
		const res = await onSetRoomPowerLevels({ [key]: lv });
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.("已更新房间权限门槛", "success");
		} else {
			onNotify?.(res.error || "更新权限门槛失败", "error");
		}
		return;
	}

	if (field.startsWith("plUser:")) {
		const uid = field.slice(7);
		const maxPl = roomMeta?.isCreator
			? 100
			: (roomMeta?.adminPowerLevel ?? 100);
		const lv = Math.trunc(Number(numberDraft));
		if (!Number.isFinite(lv) || lv < -1 || lv > maxPl) {
			onNotify?.(`权限值必须在 -1 ~ ${maxPl} 之间`, "error");
			return;
		}
		if (lv === (roomMeta?.powerLevels?.users?.[uid] ?? 0)) {
			editingField = null;
			return;
		}
		if (!onSetRoomPowerLevels) return;
		savingField = field;
		const res = await onSetRoomPowerLevels({
			setUser: { userId: uid, level: lv },
		});
		savingField = null;
		if (res.ok) {
			editingField = null;
			onNotify?.(`已将 ${uid} 更新为 PL ${lv}`, "success");
		} else {
			onNotify?.(res.error || "更新成员权限失败", "error");
		}
	}
}

async function handleRemovePowerUser(uid: string) {
	if (!onSetRoomPowerLevels || savingField) return;
	savingField = `plUser:${uid}`;
	const res = await onSetRoomPowerLevels({
		setUser: { userId: uid, remove: true },
	});
	savingField = null;
	if (res.ok) {
		editingField = null;
		onNotify?.(`已重置 ${uid} 为默认权限`, "success");
	} else {
		onNotify?.(res.error || "移除成员权限失败", "error");
	}
}

async function handleApplyAvatar(nextUrl: string) {
	if (!onSetRoomAvatar || savingField) return;
	savingField = "avatar";
	const res = await onSetRoomAvatar(nextUrl);
	savingField = null;
	if (res.ok) {
		onNotify?.(
			nextUrl
				? isInterconnect
					? "已上传至 Matrix 媒体库并更新房间头像"
					: "已更新房间头像"
				: "已恢复默认房间头像",
			"success",
		);
	} else {
		onNotify?.(res.error || "更新房间头像失败", "error");
	}
}

async function copyText(value: string, key: "alias" | "roomId", label: string) {
	if (!value) return;
	try {
		await navigator.clipboard.writeText(value);
		copiedKey = key;
		onNotify?.(`已复制${label}：${value}`, "success");
		setTimeout(() => {
			if (copiedKey === key) copiedKey = "";
		}, 2000);
	} catch {
		onNotify?.("复制失败，请手动长按复制", "error");
	}
}

const powerThresholdItems = $derived.by(() => {
	const pl = roomMeta?.powerLevels;
	if (!pl) return [];
	return [
		{
			editKey: "pl:eventsDefault" as const,
			label: "发言门槛",
			value: pl.eventsDefault,
			hint: "events_default",
		},
		{
			editKey: "pl:stateDefault" as const,
			label: "改设置门槛",
			value: pl.stateDefault,
			hint: "state_default",
		},
		{
			editKey: "pl:usersDefault" as const,
			label: "新成员默认",
			value: pl.usersDefault,
			hint: "users_default",
		},
		{
			editKey: "pl:invite" as const,
			label: "邀请成员",
			value: pl.invite,
			hint: "invite",
		},
		{
			editKey: "pl:kick" as const,
			label: "踢出成员",
			value: pl.kick,
			hint: "kick",
		},
		{
			editKey: "pl:ban" as const,
			label: "封禁成员",
			value: pl.ban,
			hint: "ban",
		},
		{
			editKey: "pl:redact" as const,
			label: "撤回消息",
			value: pl.redact,
			hint: "redact",
		},
		{
			editKey: "pl:notificationsRoom" as const,
			label: "@room 提醒",
			value: pl.notificationsRoom,
			hint: "notifications.room",
		},
	];
});

const joinInfo = $derived(describeJoinRule(roomMeta?.joinRule));
const histInfo = $derived(
	describeHistoryVisibility(roomMeta?.historyVisibility),
);
const guestInfo = $derived(describeGuestAccess(roomMeta?.guestAccess));
</script>

{#snippet pencilIcon(sizeClass = "size-3")}
  <svg class={sizeClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
{/snippet}

{#snippet checkIcon()}
  <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
{/snippet}

{#snippet closeIcon()}
  <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
{/snippet}

<ChatModal
  open={open}
  title="房间信息"
  size="md"
  fillHeightOnDesktop={isAdmin && isInterconnect}
  mobile="full"
  dialogClass="chat-room-info-dialog"
  onClose={() => {
    if (!savingField) onClose();
  }}
>
  <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4 text-left custom-scrollbar select-text">
    <!-- 1. 房间身份卡（左头像 + 右两行：房间名 & 主题） -->
    <section class="chat-profile-hero">
      <div class="flex items-center gap-3.5 min-w-0">
        {#if canEditField("avatar") && onSetRoomAvatar}
          <button
            type="button"
            class="chat-profile-avatar-btn shrink-0 rounded-2xl!"
            aria-label="更换或裁剪房间头像"
            disabled={savingField === "avatar"}
            onclick={() => {
              editingField = null;
              avatarModalOpen = true;
            }}
          >
            <div class="relative w-14 h-14 rounded-2xl overflow-hidden ring-1 ring-black/10 dark:ring-white/15 bg-black/5 dark:bg-white/10 flex items-center justify-center shadow-xs">
              {#if roomAvatar && !avatarFailed}
                <img
                  src={roomAvatar}
                  alt={isInterconnect ? effectiveMatrixRoomName : roomName}
                  class="w-full h-full object-cover block"
                  onerror={() => {
                    avatarFailed = true;
                  }}
                />
              {:else}
                <span class="font-mono text-lg font-bold opacity-70">#</span>
              {/if}
              {#if savingField === "avatar"}
                <span class="absolute inset-0 bg-black/45 flex items-center justify-center text-white">
                  <span class="size-4 border-2 border-white border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                </span>
              {/if}
            </div>
            <span class="chat-profile-avatar-badge" aria-hidden="true">
              {@render pencilIcon("size-2.5")}
            </span>
          </button>
        {:else}
          <div class="shrink-0 w-14 h-14 rounded-2xl overflow-hidden ring-1 ring-black/10 dark:ring-white/15 bg-black/5 dark:bg-white/10 flex items-center justify-center select-none shadow-xs">
            {#if roomAvatar && !avatarFailed}
              <img
                src={roomAvatar}
                alt={isInterconnect ? effectiveMatrixRoomName : roomName}
                class="w-full h-full object-cover block"
                onerror={() => {
                  avatarFailed = true;
                }}
              />
            {:else}
              <span class="font-mono text-lg font-bold opacity-70">#</span>
            {/if}
          </div>
        {/if}

        <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
          <!-- 第一行：真实房间名 -->
          {#if isInterconnect && editingField === "roomName"}
            <div class="chat-profile-row-editor max-w-sm">
              <input
                bind:this={activeInputEl}
                type="text"
                maxlength={80}
                bind:value={textDraft}
                disabled={savingField === "roomName"}
                aria-label="Matrix 房间名"
                placeholder="输入房间名称..."
                class="chat-auth-input chat-profile-inline-input flex-1 min-w-0"
                onkeydown={(e) => handleInlineKeydown(e)}
              />
              <button
                type="button"
                class="chat-profile-confirm-btn"
                aria-label="保存房间名称"
                disabled={savingField === "roomName"}
                onclick={() => void commitInlineEdit()}
              >
                {#if savingField === "roomName"}
                  <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                {:else}
                  {@render checkIcon()}
                {/if}
              </button>
              <button
                type="button"
                class="chat-profile-cancel-btn"
                aria-label="取消编辑房间名称"
                disabled={savingField === "roomName"}
                onclick={cancelEdit}
              >
                {@render closeIcon()}
              </button>
            </div>
          {:else}
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="font-bold text-base sm:text-[17px] text-[var(--deep-text)] dark:text-white/95 truncate leading-tight">
                {isInterconnect ? effectiveMatrixRoomName : roomName}
              </span>
              {#if isInterconnect && canEditField("name") && onSetRoomName}
                <button
                  type="button"
                  class="chat-profile-pencil-btn shrink-0"
                  aria-label="编辑房间名称"
                  onclick={() => void startInlineEdit("roomName")}
                >
                  {@render pencilIcon()}
                </button>
              {/if}
            </div>
          {/if}

          <!-- 第二行：房间主题 -->
          {#if editingField === "topic"}
            <div class="space-y-1.5 pt-0.5">
              <textarea
                bind:this={activeInputEl}
                bind:value={textDraft}
                maxlength={160}
                rows="2"
                disabled={savingField === "topic"}
                aria-label="房间主题"
                class="w-full text-xs p-2 rounded-xl bg-[var(--skin-surface)] text-[var(--deep-text)] dark:text-white/90 border border-[var(--skin-line)] outline-none focus:border-[var(--skin-accent)] resize-none"
                placeholder="输入房间主题（最多 160 字，留空可清空）..."
                onkeydown={(e) => handleInlineKeydown(e, true)}
              ></textarea>
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] text-[var(--chat-meta-color)] tabular-nums">
                  {textDraft.length}/160 · Ctrl+Enter 保存
                </span>
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="chat-profile-confirm-btn"
                    aria-label="保存房间主题"
                    disabled={savingField === "topic"}
                    onclick={() => void commitInlineEdit()}
                  >
                    {#if savingField === "topic"}
                      <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                    {:else}
                      {@render checkIcon()}
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="chat-profile-cancel-btn"
                    aria-label="取消编辑房间主题"
                    disabled={savingField === "topic"}
                    onclick={cancelEdit}
                  >
                    {@render closeIcon()}
                  </button>
                </div>
              </div>
            </div>
          {:else}
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-xs text-[var(--chat-meta-color)] leading-snug break-words min-w-0">
                {roomTopic?.trim() || (isInterconnect ? "联合公共聊天室" : "随便聊聊日常与折腾")}
              </span>
              {#if canEditField("topic") && onSetTopic}
                <button
                  type="button"
                  class="chat-profile-pencil-btn shrink-0"
                  aria-label="编辑房间主题"
                  onclick={() => void startInlineEdit("topic")}
                >
                  {@render pencilIcon()}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </section>

    <!-- 2. 实时统计（顺序：联邦成员 -> 在线人数 -> 在线旁观 -> 互联友站） -->
    {#if isInterconnect}
      <section class="grid gap-2 {isAdmin ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'}">
        <div class="p-3 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex flex-col">
          <span class="text-[11px] text-[var(--chat-meta-color)]">联邦成员</span>
          <span class="text-lg font-bold text-[var(--primary)] tabular-nums">
            {roomMeta?.joinedMemberCount ?? 0} <span class="text-xs font-normal opacity-70">人</span>
          </span>
        </div>

        <div class="p-3 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex flex-col">
          <span class="text-[11px] text-[var(--chat-meta-color)]">在线人数</span>
          <span class="text-lg font-bold text-[var(--deep-text)] dark:text-white/90 tabular-nums">
            {roomOnlineCount} <span class="text-xs font-normal opacity-70">人</span>
          </span>
        </div>

        {#if isAdmin}
          <div class="p-3 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex flex-col">
            <span class="text-[11px] text-[var(--chat-meta-color)]">在线旁观</span>
            <span class="text-lg font-bold text-[var(--chat-meta-color)] tabular-nums">
              {observerCount} <span class="text-xs font-normal opacity-70">人</span>
            </span>
          </div>
        {/if}

        <div class="p-3 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex flex-col">
          <span class="text-[11px] text-[var(--chat-meta-color)]">互联友站</span>
          <span class="text-lg font-bold text-[var(--skin-accent)] tabular-nums">
            {interconnectSitesCount} <span class="text-xs font-normal opacity-70">个</span>
          </span>
        </div>
      </section>
    {:else if isAdmin}
      <section class="grid grid-cols-2 gap-2">
        <div class="p-3 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex flex-col">
          <span class="text-[11px] text-[var(--chat-meta-color)]">房间在线</span>
          <span class="text-lg font-bold text-[var(--deep-text)] dark:text-white/90 tabular-nums">
            {roomOnlineCount} <span class="text-xs font-normal opacity-70">人</span>
          </span>
        </div>
        <div class="p-3 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex flex-col">
          <span class="text-[11px] text-[var(--chat-meta-color)]">在线旁观</span>
          <span class="text-lg font-bold text-[var(--chat-meta-color)] tabular-nums">
            {observerCount} <span class="text-xs font-normal opacity-70">人</span>
          </span>
        </div>
      </section>
    {:else}
      <section class="px-3.5 py-2.5 rounded-xl bg-[var(--skin-rail)] border border-[var(--skin-line)] flex items-center justify-between gap-2">
        <span class="text-xs text-[var(--chat-meta-color)]">当前在线</span>
        <span class="text-sm font-bold text-[var(--deep-text)] dark:text-white/90 tabular-nums">
          {roomOnlineCount} <span class="text-xs font-normal opacity-70">人正在聊天</span>
        </span>
      </section>
    {/if}

    <!-- 4. 普通成员视角：精简跨站互联入口（仅公开别名） -->
    {#if isInterconnect && !isAdmin}
      <section class="space-y-1.5">
        <div class="px-1">
          <span class="chat-settings-section-title">跨站互联</span>
        </div>

        <div class="chat-profile-list-card">
          <div class="chat-profile-row">
            <span class="chat-profile-row-label">Matrix 地址</span>
            <div class="chat-profile-row-value-wrap">
              <span class="chat-profile-row-value font-mono text-xs!">
                {effectiveAlias || "跨站联邦公共大厅"}
              </span>
              <div class="flex items-center gap-1 shrink-0">
                {#if effectiveAlias}
                  <button
                    type="button"
                    class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-[var(--deep-text)] dark:text-white/90 border-none cursor-pointer"
                    onclick={() => void copyText(effectiveAlias, "alias", "公开别名")}
                  >
                    {copiedKey === "alias" ? "已复制" : "复制"}
                  </button>
                {/if}
                {#if matrixToUrl}
                  <a
                    href={matrixToUrl}
                    target="_blank"
                    rel="noopener"
                    class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20 no-underline"
                  >
                    打开
                  </a>
                {/if}
              </div>
            </div>
          </div>
        </div>
      </section>
    {/if}

    <!-- 5. 站长专属 · Matrix 房间管理区（仅站长可见，普通成员彻底隐藏） -->
    {#if isAdmin && isInterconnect}
      <div class="pt-2 border-t border-[var(--chat-divider-color)] space-y-4">
        <div class="flex items-center justify-between gap-2 flex-wrap px-1">
          <span class="text-xs font-bold text-[var(--deep-text)] dark:text-white/90 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-[var(--skin-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            站长专属 · Matrix 房间管理
          </span>
          {#if roomMeta}
            <span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--skin-accent-soft)] text-[var(--chat-accent-text)]">
              本站账号：{roomMeta.isCreator ? "Creator ∞" : `PL ${roomMeta.adminPowerLevel ?? 0}`}
            </span>
          {/if}
        </div>

        <!-- 6a. 跨站联邦与标识 -->
        <section class="space-y-1.5">
          <div class="px-1">
            <span class="chat-settings-section-title">联邦标识与创建信息</span>
          </div>

          <div class="chat-profile-list-card">
            <!-- 规范别名 -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">公开别名</span>
              {#if editingField === "canonicalAlias"}
                <div class="chat-profile-row-editor">
                  <input
                    bind:this={activeInputEl}
                    type="text"
                    maxlength={120}
                    bind:value={textDraft}
                    disabled={savingField === "canonicalAlias"}
                    aria-label="Matrix 规范别名"
                    placeholder="#room:domain.com"
                    class="chat-auth-input chat-profile-inline-input font-mono flex-1 min-w-0"
                    onkeydown={(e) => handleInlineKeydown(e)}
                  />
                  <button
                    type="button"
                    class="chat-profile-confirm-btn"
                    aria-label="保存规范别名"
                    disabled={savingField === "canonicalAlias"}
                    onclick={() => void commitInlineEdit()}
                  >
                    {#if savingField === "canonicalAlias"}
                      <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                    {:else}
                      {@render checkIcon()}
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="chat-profile-cancel-btn"
                    aria-label="取消编辑规范别名"
                    disabled={savingField === "canonicalAlias"}
                    onclick={cancelEdit}
                  >
                    {@render closeIcon()}
                  </button>
                </div>
              {:else}
                <div class="chat-profile-row-value-wrap">
                  <span class="chat-profile-row-value font-mono text-xs!">
                    {effectiveAlias || "未设置规范别名"}
                  </span>
                  <div class="flex items-center gap-1 shrink-0">
                    {#if effectiveAlias}
                      <button
                        type="button"
                        class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-[var(--deep-text)] dark:text-white/90 border-none cursor-pointer"
                        onclick={() => void copyText(effectiveAlias, "alias", "公开别名")}
                      >
                        {copiedKey === "alias" ? "已复制" : "复制"}
                      </button>
                    {/if}
                    {#if matrixToUrl}
                      <a
                        href={matrixToUrl}
                        target="_blank"
                        rel="noopener"
                        class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20 no-underline"
                      >
                        打开
                      </a>
                    {/if}
                    {#if canEditField("canonicalAlias") && onSetRoomCanonicalAlias}
                      <button
                        type="button"
                        class="chat-profile-pencil-btn"
                        aria-label="编辑规范别名"
                        onclick={() => void startInlineEdit("canonicalAlias")}
                      >
                        {@render pencilIcon()}
                      </button>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>

            <!-- Room ID -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">Room ID</span>
              <div class="chat-profile-row-value-wrap">
                <span class="chat-profile-row-value font-mono text-xs!" title={effectiveMatrixRoomId}>
                  {effectiveMatrixRoomId}
                </span>
                <div class="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    class="px-2 py-0.5 text-[11px] font-medium rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-[var(--deep-text)] dark:text-white/90 border-none cursor-pointer"
                    onclick={() => void copyText(effectiveMatrixRoomId, "roomId", "Room ID")}
                  >
                    {copiedKey === "roomId" ? "已复制" : "复制"}
                  </button>
                  {#if canEditField("canonicalAlias") && onSetRoomCanonicalAlias}
                    <span class="chat-profile-pencil-btn invisible pointer-events-none" aria-hidden="true"></span>
                  {/if}
                </div>
              </div>
            </div>

            <!-- 房间版本与创建者 -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">协议创建</span>
              <div class="chat-profile-row-value-wrap h-auto! py-1 flex-wrap">
                <span class="chat-profile-row-value text-xs!">
                  Room v{roomMeta?.roomVersion || "12"}
                  {#if creatorsList.length > 0}
                    · {creatorsList.length} 位创建者
                  {/if}
                </span>
                {#if creatorsList.length > 0}
                  <div class="flex flex-wrap gap-1 w-full">
                    {#each creatorsList as cid (cid)}
                      <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/8 text-[11px] font-mono text-[var(--deep-text)] dark:text-white/85">
                        <span>{cid}</span>
                        <span class="text-[10px] font-sans font-semibold text-amber-600 dark:text-amber-400">∞</span>
                      </span>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </section>

        <!-- 6b. 访问与安全策略 -->
        <section class="space-y-1.5">
          <div class="px-1">
            <span class="chat-settings-section-title">访问与安全策略</span>
          </div>

          <div class="chat-profile-list-card">
            <!-- 加入规则 -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">加入规则</span>
              {#if editingField === "joinRule"}
                <div class="chat-profile-row-editor">
                  <select
                    bind:this={activeInputEl}
                    bind:value={selectDraft}
                    disabled={savingField === "joinRule"}
                    aria-label="选择加入规则"
                    class="chat-auth-input chat-profile-inline-input flex-1 min-w-0"
                    onkeydown={(e) => handleInlineKeydown(e)}
                  >
                    <option value="invite">仅限邀请 (invite)</option>
                    <option value="public">公开加入 (public)</option>
                    <option value="knock">敲门申请 (knock)</option>
                  </select>
                  <button
                    type="button"
                    class="chat-profile-confirm-btn"
                    aria-label="保存加入规则"
                    disabled={savingField === "joinRule"}
                    onclick={() => void commitInlineEdit()}
                  >
                    {#if savingField === "joinRule"}
                      <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                    {:else}
                      {@render checkIcon()}
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="chat-profile-cancel-btn"
                    aria-label="取消编辑加入规则"
                    disabled={savingField === "joinRule"}
                    onclick={cancelEdit}
                  >
                    {@render closeIcon()}
                  </button>
                </div>
              {:else}
                <div class="chat-profile-row-value-wrap">
                  <span class="chat-profile-row-value" title={joinInfo.desc}>
                    {joinInfo.label}
                  </span>
                  {#if canEditField("joinRule") && onSetRoomJoinRule}
                    <button
                      type="button"
                      class="chat-profile-pencil-btn"
                      aria-label="编辑加入规则"
                      onclick={() => void startInlineEdit("joinRule")}
                    >
                      {@render pencilIcon()}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- 历史可见性 -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">历史可见</span>
              {#if editingField === "historyVisibility"}
                <div class="chat-profile-row-editor">
                  <select
                    bind:this={activeInputEl}
                    bind:value={selectDraft}
                    disabled={savingField === "historyVisibility"}
                    aria-label="选择历史消息可见性"
                    class="chat-auth-input chat-profile-inline-input flex-1 min-w-0"
                    onkeydown={(e) => handleInlineKeydown(e)}
                  >
                    <option value="shared">成员共享 (shared)</option>
                    <option value="world_readable">所有人可读 (world_readable)</option>
                    <option value="invited">自受邀起 (invited)</option>
                    <option value="joined">自加入起 (joined)</option>
                  </select>
                  <button
                    type="button"
                    class="chat-profile-confirm-btn"
                    aria-label="保存历史消息可见性"
                    disabled={savingField === "historyVisibility"}
                    onclick={() => void commitInlineEdit()}
                  >
                    {#if savingField === "historyVisibility"}
                      <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                    {:else}
                      {@render checkIcon()}
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="chat-profile-cancel-btn"
                    aria-label="取消编辑历史消息可见性"
                    disabled={savingField === "historyVisibility"}
                    onclick={cancelEdit}
                  >
                    {@render closeIcon()}
                  </button>
                </div>
              {:else}
                <div class="chat-profile-row-value-wrap">
                  <span class="chat-profile-row-value" title={histInfo.desc}>
                    {histInfo.label}
                  </span>
                  {#if canEditField("historyVisibility") && onSetRoomHistoryVisibility}
                    <button
                      type="button"
                      class="chat-profile-pencil-btn"
                      aria-label="编辑历史消息可见性"
                      onclick={() => void startInlineEdit("historyVisibility")}
                    >
                      {@render pencilIcon()}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- 匿名访客 -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">匿名访客</span>
              {#if editingField === "guestAccess"}
                <div class="chat-profile-row-editor">
                  <select
                    bind:this={activeInputEl}
                    bind:value={selectDraft}
                    disabled={savingField === "guestAccess"}
                    aria-label="选择访客访问策略"
                    class="chat-auth-input chat-profile-inline-input flex-1 min-w-0"
                    onkeydown={(e) => handleInlineKeydown(e)}
                  >
                    <option value="forbidden">禁止访客 (forbidden)</option>
                    <option value="can_join">允许访客 (can_join)</option>
                  </select>
                  <button
                    type="button"
                    class="chat-profile-confirm-btn"
                    aria-label="保存访客策略"
                    disabled={savingField === "guestAccess"}
                    onclick={() => void commitInlineEdit()}
                  >
                    {#if savingField === "guestAccess"}
                      <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                    {:else}
                      {@render checkIcon()}
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="chat-profile-cancel-btn"
                    aria-label="取消编辑访客策略"
                    disabled={savingField === "guestAccess"}
                    onclick={cancelEdit}
                  >
                    {@render closeIcon()}
                  </button>
                </div>
              {:else}
                <div class="chat-profile-row-value-wrap">
                  <span class="chat-profile-row-value" title={guestInfo.desc}>
                    {guestInfo.label}
                  </span>
                  {#if canEditField("guestAccess") && onSetRoomGuestAccess}
                    <button
                      type="button"
                      class="chat-profile-pencil-btn"
                      aria-label="编辑访客访问策略"
                      onclick={() => void startInlineEdit("guestAccess")}
                    >
                      {@render pencilIcon()}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- 端到端加密（锁定只读，绝不开放编辑） -->
            <div class="chat-profile-row">
              <span class="chat-profile-row-label">端到端加密</span>
              <div class="chat-profile-row-value-wrap">
                <span class="chat-profile-row-value">
                  {roomMeta?.encrypted ? "已启用端到端加密" : "未开启 · 公开联邦明文互通"}
                </span>
                <span class="text-[11px] text-[var(--chat-meta-color)] shrink-0">锁定只读</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 6c. 房间权限与管理员 -->
        {#if roomMeta?.powerLevels}
          <section class="space-y-2">
            <div class="px-1">
              <span class="chat-settings-section-title">操作权限门槛与成员角色</span>
            </div>

            <!-- 操作门槛 -->
            <div class="chat-profile-list-card">
              <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:gap-px bg-[var(--skin-line)]">
                {#each powerThresholdItems as item (item.editKey)}
                  <div class="chat-profile-row bg-[var(--skin-rail)]">
                    <span class="chat-profile-row-label" title={item.hint}>{item.label}</span>
                    {#if editingField === item.editKey}
                      <div class="chat-profile-row-editor">
                        <input
                          bind:this={activeInputEl}
                          type="number"
                          min={item.editKey === "pl:usersDefault" ? -1 : 0}
                          max={roomMeta.isCreator ? 100 : (roomMeta.adminPowerLevel ?? 100)}
                          bind:value={numberDraft}
                          disabled={savingField === item.editKey}
                          aria-label={item.label}
                          class="chat-auth-input chat-profile-inline-input w-20! tabular-nums"
                          onkeydown={(e) => handleInlineKeydown(e)}
                        />
                        <button
                          type="button"
                          class="chat-profile-confirm-btn"
                          aria-label={`保存${item.label}`}
                          disabled={savingField === item.editKey}
                          onclick={() => void commitInlineEdit()}
                        >
                          {#if savingField === item.editKey}
                            <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                          {:else}
                            {@render checkIcon()}
                          {/if}
                        </button>
                        <button
                          type="button"
                          class="chat-profile-cancel-btn"
                          aria-label={`取消编辑${item.label}`}
                          disabled={savingField === item.editKey}
                          onclick={cancelEdit}
                        >
                          {@render closeIcon()}
                        </button>
                      </div>
                    {:else}
                      <div class="chat-profile-row-value-wrap">
                        <span class="chat-profile-row-value font-mono text-xs! tabular-nums">
                          PL {item.value}
                        </span>
                        {#if canEditField("powerLevels") && onSetRoomPowerLevels}
                          <button
                            type="button"
                            class="chat-profile-pencil-btn"
                            aria-label={`编辑${item.label}`}
                            onclick={() => void startInlineEdit(item.editKey)}
                          >
                            {@render pencilIcon()}
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
              <div class="px-3.5 py-2 text-[11px] text-[var(--chat-meta-color)]">
                服务器 ACL 与房间升级（PL 150）仅房间创建者（∞）可执行
              </div>
            </div>

            <!-- 成员特殊权限列表 -->
            <div class="chat-profile-list-card">
              <div class="px-3.5 py-2 flex items-center justify-between gap-2 bg-black/2 dark:bg-white/2">
                <span class="text-[11px] font-semibold text-[var(--chat-meta-color)]">
                  特殊权限成员 ({powerUserEntries.length})
                </span>
                {#if canEditField("powerLevels") && onSetRoomPowerLevels && editingField !== "pl:addUser"}
                  <button
                    type="button"
                    class="text-[11px] font-semibold text-[var(--skin-accent)] hover:underline border-none bg-transparent cursor-pointer p-0 inline-flex items-center gap-1"
                    onclick={() => void startInlineEdit("pl:addUser")}
                  >
                    {@render pencilIcon("size-2.5")}
                    <span>分配成员权限</span>
                  </button>
                {/if}
              </div>

              {#if editingField === "pl:addUser"}
                <div class="px-3.5 py-2.5 flex flex-wrap items-center gap-1.5 bg-black/3 dark:bg-white/3">
                  <input
                    bind:this={activeInputEl}
                    type="text"
                    bind:value={newUserIdDraft}
                    disabled={savingField === "pl:addUser"}
                    aria-label="Matrix 用户 ID"
                    placeholder="@user:domain.com"
                    class="chat-auth-input chat-profile-inline-input font-mono flex-1 min-w-[11rem]"
                    onkeydown={(e) => handleInlineKeydown(e)}
                  />
                  <input
                    type="number"
                    min={-1}
                    max={roomMeta.isCreator ? 100 : (roomMeta.adminPowerLevel ?? 100)}
                    bind:value={newUserLevelDraft}
                    disabled={savingField === "pl:addUser"}
                    aria-label="权限等级"
                    class="chat-auth-input chat-profile-inline-input w-20! tabular-nums"
                    onkeydown={(e) => handleInlineKeydown(e)}
                  />
                  <button
                    type="button"
                    class="chat-profile-confirm-btn"
                    aria-label="保存新增成员权限"
                    disabled={savingField === "pl:addUser"}
                    onclick={() => void commitInlineEdit()}
                  >
                    {#if savingField === "pl:addUser"}
                      <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                    {:else}
                      {@render checkIcon()}
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="chat-profile-cancel-btn"
                    aria-label="取消新增成员权限"
                    disabled={savingField === "pl:addUser"}
                    onclick={cancelEdit}
                  >
                    {@render closeIcon()}
                  </button>
                </div>
              {/if}

              <div class="max-h-52 overflow-y-auto custom-scrollbar divide-y divide-[var(--skin-line)]">
                {#each powerUserEntries as [uid, level] (uid)}
                  {@const editKey = `plUser:${uid}` as const}
                  {@const siteLabel = resolveMatrixUserSiteLabel(uid)}
                  {@const isSelfMatrix = uid === roomMeta.adminUserId}
                  <div class="px-3.5 py-2 flex items-center justify-between gap-2 text-xs">
                    <div class="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
                      <span class="font-mono text-[11.5px] text-[var(--deep-text)] dark:text-white/90 truncate">
                        {uid}
                      </span>
                      {#if isSelfMatrix}
                        <span class="text-[10px] font-semibold px-1.5 py-0.2 rounded bg-[var(--skin-accent-soft)] text-[var(--chat-accent-text)]">
                          本站
                        </span>
                      {:else if siteLabel}
                        <span class="text-[10px] px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/8 text-[var(--chat-meta-color)]">
                          {siteLabel}
                        </span>
                      {/if}
                    </div>

                    {#if editingField === editKey}
                      <div class="flex items-center gap-1 shrink-0">
                        <input
                          bind:this={activeInputEl}
                          type="number"
                          min={-1}
                          max={roomMeta.isCreator ? 100 : (roomMeta.adminPowerLevel ?? 100)}
                          bind:value={numberDraft}
                          disabled={savingField === editKey}
                          aria-label={`编辑 ${uid} 权限`}
                          class="chat-auth-input chat-profile-inline-input w-18! tabular-nums"
                          onkeydown={(e) => handleInlineKeydown(e)}
                        />
                        <button
                          type="button"
                          class="chat-profile-confirm-btn"
                          aria-label="保存成员权限"
                          disabled={savingField === editKey}
                          onclick={() => void commitInlineEdit()}
                        >
                          {#if savingField === editKey}
                            <span class="size-3 border-2 border-current border-r-transparent rounded-full motion-safe:animate-spin" aria-hidden="true"></span>
                          {:else}
                            {@render checkIcon()}
                          {/if}
                        </button>
                        <button
                          type="button"
                          class="chat-profile-cancel-btn"
                          aria-label="重置为默认权限"
                          title="重置为默认权限"
                          disabled={savingField === editKey}
                          onclick={() => void handleRemovePowerUser(uid)}
                        >
                          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="chat-profile-cancel-btn"
                          aria-label="取消编辑成员权限"
                          disabled={savingField === editKey}
                          onclick={cancelEdit}
                        >
                          {@render closeIcon()}
                        </button>
                      </div>
                    {:else}
                      <div class="flex items-center gap-1.5 shrink-0">
                        <span class="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded-md tabular-nums {level >= 100 ? 'bg-amber-500/12 text-amber-600 dark:text-amber-300' : level >= 50 ? 'bg-sky-500/12 text-sky-600 dark:text-sky-300' : 'bg-black/5 dark:bg-white/10 text-[var(--chat-meta-color)]'}">
                          PL {level}
                        </span>
                        {#if canEditPowerUser(uid, level) && onSetRoomPowerLevels}
                          <button
                            type="button"
                            class="chat-profile-pencil-btn"
                            aria-label={`编辑 ${uid} 权限`}
                            onclick={() => void startInlineEdit(editKey)}
                          >
                            {@render pencilIcon()}
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </section>
        {/if}
      </div>
    {/if}

    <!-- 7. 茶室互动指南 -->
    <section class="p-3.5 rounded-2xl bg-[var(--skin-rail)] border border-[var(--skin-line)] space-y-1.5">
      <span class="text-xs font-semibold text-[var(--chat-meta-color)] flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        茶室互动指南
      </span>
      <ul class="m-0 text-xs text-[var(--chat-meta-color)] space-y-1 pl-4 list-disc leading-relaxed">
        <li>请友善发言、真诚分享，文明交流与互动；</li>
        <li>支持点歌台投递，可与茶友们共享高品质音乐；</li>
        <li>支持 Markdown 格式排版、Lottie 动态贴纸与代码高亮。</li>
      </ul>
    </section>
  </div>
</ChatModal>

{#if canEditField("avatar") && onSetRoomAvatar}
  <ChatAvatarCropModal
    open={avatarModalOpen}
    currentAvatar={roomAvatar}
    userName={`#${roomName}`}
    chatServerUrl={chatServerUrl}
    auth={auth}
    onApplyAvatar={(url) => void handleApplyAvatar(url)}
    onResetDefault={() => void handleApplyAvatar("")}
    onClose={() => (avatarModalOpen = false)}
  />
{/if}
