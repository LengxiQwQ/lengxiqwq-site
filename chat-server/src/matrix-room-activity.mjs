const joinRules = {
  public: '任何人都可以加入',
  invite: '仅限受邀成员加入',
  knock: '可以申请加入',
  restricted: '符合条件的成员可以加入',
  knock_restricted: '符合条件的成员可以加入，其他人可以申请',
};

const historyVisibility = {
  invited: '受邀后可见',
  joined: '加入后可见',
  shared: '加入后可查看全部历史',
  world_readable: '所有人可见',
};

function label(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 180) : '';
}

export async function completeMatrixMemberEvent(event, fetchEvent) {
  const previousId = event?.unsigned?.replaces_state;
  if (event?.type !== 'm.room.member' || event.unsigned?.redacted_because ||
      event.unsigned?.prev_content || event.prev_content || typeof previousId !== 'string') return event;
  const previous = await fetchEvent(previousId);
  if (previous?.type !== event.type || previous.state_key !== event.state_key ||
      !previous.content?.membership) return event;
  return { ...event, unsigned: { ...event.unsigned, prev_content: previous.content } };
}

function memberActivity(event, displayName) {
  const current = event.content;
  const previous = event.unsigned?.prev_content ?? event.prev_content ?? {};
  const target = event.state_key;
  if (!target) return '';
  const self = target === event.sender;
  const oldName = label(previous.displayname);
  const newName = label(current.displayname);
  const member = newName || oldName || displayName(target);
  const actor = self ? member : displayName(event.sender);
  const reason = label(current.reason);
  const withReason = (message) => reason ? `${message}（${reason}）` : message;
  const before = previous.membership;

  switch (current.membership) {
    case 'join': {
      if (before !== 'join') {
        return !before && event.unsigned?.replaces_state
          ? `${member} 的房间成员资料已更新`
          : `${member} 加入了房间`;
      }
      const changes = [];
      if (newName !== oldName) {
        changes.push(newName ? `将昵称改为「${newName}」` : '移除了昵称');
      }
      if ((current.avatar_url || '') !== (previous.avatar_url || '')) {
        changes.push(current.avatar_url ? '更换了头像' : '移除了头像');
      }
      return changes.length ? `${oldName || displayName(target)} ${changes.join('，')}` : '';
    }
    case 'invite':
      return before === 'invite' ? '' : withReason(`${actor} 邀请 ${member} 加入房间`);
    case 'knock':
      return before === 'knock' ? '' : withReason(`${member} 申请加入房间`);
    case 'ban':
      return before === 'ban' ? '' : withReason(`${actor} 封禁了 ${member}`);
    case 'leave':
      if (before === 'leave') return '';
      if (before === 'ban') return withReason(`${actor} 解除了对 ${member} 的封禁`);
      if (before === 'invite') {
        return withReason(self ? `${member} 拒绝了邀请` : `${actor} 撤销了对 ${member} 的邀请`);
      }
      if (before === 'knock') {
        return withReason(self ? `${member} 撤回了加入申请` : `${actor} 拒绝了 ${member} 的加入申请`);
      }
      return withReason(self ? `${member} 离开了房间` : `${actor} 将 ${member} 移出了房间`);
    default:
      return '';
  }
}

export function matrixRoomActivity(event, getName) {
  if (!event?.sender || !event.event_id || !Number.isFinite(event.origin_server_ts) ||
      Math.abs(event.origin_server_ts) > 8.64e15 || !event.content || event.unsigned?.redacted_because) return null;

  const displayName = (id) => label(getName(id)) || id;
  let actor;
  const getActor = () => (actor ??= displayName(event.sender));
  const content = event.content;
  const previous = event.unsigned?.prev_content ?? event.prev_content;
  let text;
  switch (event.type) {
    case 'm.room.member':
      text = memberActivity(event, displayName);
      break;
    case 'm.room.create':
      text = `${getActor()} 创建了房间`;
      break;
    case 'm.room.name':
      if (previous && (previous.name || '') === (content.name || '')) break;
      text = label(content.name)
        ? `${getActor()} 将房间名称改为「${label(content.name)}」`
        : `${getActor()} 移除了房间名称`;
      break;
    case 'm.room.topic':
      if (previous && (previous.topic || '') === (content.topic || '')) break;
      text = label(content.topic)
        ? `${getActor()} 将房间主题改为「${label(content.topic)}」`
        : `${getActor()} 移除了房间主题`;
      break;
    case 'm.room.avatar':
      if (previous && (previous.url || '') === (content.url || '')) break;
      text = content.url ? `${getActor()} 更换了房间头像` : `${getActor()} 移除了房间头像`;
      break;
    case 'm.room.canonical_alias': {
      const aliases = [content.alias, ...(Array.isArray(content.alt_aliases) ? content.alt_aliases : [])]
        .map(label).filter(Boolean).slice(0, 5);
      text = aliases.length
        ? `${getActor()} 更新了房间地址（${aliases.join('、')}）`
        : `${getActor()} 移除了房间地址`;
      break;
    }
    case 'm.room.join_rules': {
      const rule = Object.hasOwn(joinRules, content.join_rule) ? joinRules[content.join_rule] : '';
      text = `${getActor()} 修改了房间加入规则${rule ? `（${rule}）` : ''}`;
      break;
    }
    case 'm.room.history_visibility': {
      const visibility = Object.hasOwn(historyVisibility, content.history_visibility)
        ? historyVisibility[content.history_visibility] : '';
      text = `${getActor()} 修改了历史消息可见范围${visibility ? `（${visibility}）` : ''}`;
      break;
    }
    case 'm.room.guest_access':
      text = `${getActor()} ${content.guest_access === 'can_join' ? '允许' : '禁止'}访客加入房间`;
      break;
    case 'm.room.power_levels': {
      const before = previous?.users ?? {};
      const after = content.users ?? {};
      const changes = [];
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const oldLevel = before[id] ?? previous?.users_default ?? 0;
        const newLevel = after[id] ?? content.users_default ?? 0;
        if (oldLevel !== newLevel && Number.isFinite(oldLevel) && Number.isFinite(newLevel)) {
          changes.push(`${displayName(id)} ${oldLevel} → ${newLevel}`);
        }
      }
      text = `${getActor()} 修改了房间权限${changes.length ? `（${changes.join('、')}）` : ''}`;
      break;
    }
    case 'm.room.pinned_events': {
      if (!Array.isArray(content.pinned)) break;
      const before = Array.isArray(previous?.pinned) ? previous.pinned : [];
      const added = content.pinned.filter((id) => !before.includes(id)).length;
      const removed = before.filter((id) => !content.pinned.includes(id)).length;
      if (!previous && !added) text = `${getActor()} 清空了置顶消息`;
      else if (added && removed) text = `${getActor()} 置顶了 ${added} 条消息，取消置顶了 ${removed} 条消息`;
      else if (added) text = `${getActor()} 置顶了 ${added} 条消息`;
      else if (removed) text = `${getActor()} 取消置顶了 ${removed} 条消息`;
      break;
    }
    case 'm.room.third_party_invite':
      text = content.display_name ? `${getActor()} 发出了外部邀请` : `${getActor()} 撤销了外部邀请`;
      break;
    case 'm.room.encryption':
      text = `${getActor()} 启用了房间加密`;
      break;
    case 'm.room.tombstone':
      text = `${getActor()} 已将房间迁移到新房间`;
      break;
    case 'm.call.invite':
    case 'm.rtc.notification':
    case 'org.matrix.msc4075.rtc.notification':
      text = `${getActor()} 发起了通话`;
      break;
    default:
      return null;
  }
  return text ? { actor: getActor(), text } : null;
}
