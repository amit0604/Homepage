import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { jwtDecode } from 'jwt-decode';
import { isJwtExpired } from '../utils/jwtSession';
import {
  ConvRailGlyph,
  ChatIconBubbleDouble,
  ChatIconPin,
  ChatIconPaperclip,
  ChatIconFaceSmile,
  ChatIconArrowUpSend,
  ChatIconXPlain,
  ChatIconChevronLeft,
  ChatIconChevronRight,
  ChatIconPlusCircle,
} from './chat/ChatIosIcons';
import AppleEmoji from './chat/AppleEmoji';
import MessageBodyAppleText from './chat/MessageBodyAppleText';

const POLL_MSG_MS = 5000;
const SEARCH_DEBOUNCE_MS = 320;
const CHAT_GLOBAL_ID = '__global__';
/** Set from home unread widget; consumed when switching to Chat. */
const CHAT_FOCUS_CONV_STORAGE_KEY = 'sc_chat_focus_conv_id';
const MAX_TEXT = 16000;
const MAX_ATTACH = 10 * 1024 * 1024;
/** Read-receipt popover auto-hides unless the pointer is over it; hover pauses this timer. */
const READ_RECEIPT_AUTO_CLOSE_MS = 2100;
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🔥', '✅', '👀'];

function clipChatSnippet(text, max = 120) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function chatDeskHiddenStorageKey(username) {
  const u = String(username || '').trim().toLowerCase();
  return `sc_chatDeskHidden:${u || 'guest'}`;
}

const COMPOSER_AUTOSIZE_MAX_PX = 180;

/** Label for the right-hand chat info panel (thread type). */
function deskThreadMeta(conv) {
  if (!conv || conv.type === 'global' || String(conv.id) === CHAT_GLOBAL_ID) {
    return { kind: 'Open channel', hint: 'Anyone can read this thread.' };
  }
  if (conv.type === 'dm') {
    return { kind: 'Direct message', hint: 'Only you and your contact see these messages.' };
  }
  if (conv.type === 'group') {
    return { kind: 'Group chat', hint: 'Members and admins listed in the header menu.' };
  }
  return { kind: 'Chat', hint: '' };
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const yy = pad(d.getFullYear() % 100);
    return `${h}:${min}:${s} ${day}/${month}/${yy}`;
  } catch {
    return '';
  }
}

function formatShortThreadDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`;
  } catch {
    return '';
  }
}

function normU(u) {
  return String(u || '').trim().toLowerCase();
}

/** Sidebar row: online/offline (DM) or N/M online (group) from GET /chat/conversations `listPresence`. */
function ConvListPresence({ lp }) {
  if (!lp || !lp.kind) return null;
  if (lp.kind === 'dm') {
    const on = !!lp.online;
    return (
      <span
        className="teams-chat__conv-status"
        title={on ? 'Online' : `Last seen ${lp.lastSeenLabel || 'unknown'}`}
      >
        <span
          className={`teams-chat__presence-dot teams-chat__presence-dot--sm${
            on ? ' teams-chat__presence-dot--on' : ' teams-chat__presence-dot--off'
          }`}
          aria-hidden
        />
        <span className="teams-chat__conv-status-text">{on ? 'Online' : 'Offline'}</span>
      </span>
    );
  }
  if (lp.kind === 'group' && lp.othersCount > 0) {
    const on = lp.onlineCount > 0;
    return (
      <span
        className="teams-chat__conv-status"
        title={`${lp.onlineCount} of ${lp.othersCount} members online`}
      >
        <span
          className={`teams-chat__presence-dot teams-chat__presence-dot--sm${
            on ? ' teams-chat__presence-dot--on' : ' teams-chat__presence-dot--off'
          }`}
          aria-hidden
        />
        <span className="teams-chat__conv-status-text">
          {lp.onlineCount}/{lp.othersCount} online
        </span>
      </span>
    );
  }
  return null;
}

/** Cheap fingerprint so background polls skip setState when nothing changed. */
function messagesSignature(msgs) {
  if (!Array.isArray(msgs)) return '_';
  return msgs
    .map((m) => {
      const r = m.reactions && typeof m.reactions === 'object' ? m.reactions : {};
      const rk = Object.keys(r)
        .sort()
        .map((k) => `${k}:${(r[k] || []).length}`)
        .join('.');
      const rb = Array.isArray(m.readBy)
        ? m.readBy
            .map((x) => x.username)
            .sort()
            .join(',')
        : '';
      const rp = m.replyToMessageId ? String(m.replyToMessageId) : '';
      const rpt = m.replyPreview && m.replyPreview.text != null ? String(m.replyPreview.text) : '';
      const del = m.delivery?.status || '';
      return `${del}|${m._id}:${m.createdAt || ''}:${rk}:${rb}:${rp}:${rpt}`;
    })
    .join('|');
}

function authHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function downloadChatAttachment(ev, a) {
  ev.preventDefault();
  try {
    const token = localStorage.getItem('token');
    const r = await fetch(a.url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    if (!r.ok) return;
    const blob = await r.blob();
    const u = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = u;
    link.download = (a.name && String(a.name).slice(0, 180)) || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(u);
  } catch {
    /* ignore */
  }
}

const MUTE_CHOICES = [
  ['1h', 'For 1 hour'],
  ['8h', 'For 8 hours'],
  ['24h', 'For 24 hours'],
  ['1w', 'For 1 week'],
  ['forever', 'Until I unmute'],
];

function mutedLabel(until) {
  if (!until) return '';
  if (until === 'forever') return 'Muted';
  return `Muted until ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

async function setChatMute(conversationId, duration) {
  const r = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/mute`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ duration }),
  });
  if (!r.ok) throw new Error('Could not change mute');
}

function notifyChatActivity() {
  try {
    window.dispatchEvent(new CustomEvent('sc:chat-activity'));
  } catch {
    /* ignore */
  }
}

/**
 * Teams-style chat: Everyone + DMs + admin group chats, search, attachments, reactions.
 */
/** Header button: mute this chat for a while, or unmute it. */
function ChatMuteButton({ conv, onChange }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (conv.mutedUntil) {
    return (
      <button type="button" className="teams-chat__head-btn teams-chat__head-btn--muted" title={mutedLabel(conv.mutedUntil)} onClick={() => onChange(null)}>
        🔕 Unmute
      </button>
    );
  }
  return (
    <div className="teams-chat__mute-wrap">
      <button
        type="button"
        className="teams-chat__head-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        Mute
      </button>
      {open ? (
        <ul className="teams-chat__mute-menu" role="menu" aria-label="Mute this chat">
          {MUTE_CHOICES.map(([value, label]) => (
            <li role="none" key={value}>
              <button type="button" role="menuitem" className="teams-chat__ctx-item" onClick={() => { setOpen(false); onChange(value); }}>
                {label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TeamsChatPanel() {
  const [chatOff, setChatOff] = useState(false);
  const [loadingBoot, setLoadingBoot] = useState(true);
  const [session, setSession] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(CHAT_GLOBAL_ID);
  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState('');
  /** IME composition — hide mirrored layer so glyphs stay visible while composing. */
  const [composerComposing, setComposerComposing] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [userHits, setUserHits] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupSearch, setGroupSearch] = useState('');
  const [groupHits, setGroupHits] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [reactPopover, setReactPopover] = useState(null);
  const [readReceiptPop, setReadReceiptPop] = useState(null);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersPayload, setMembersPayload] = useState(null);
  const [adminDraft, setAdminDraft] = useState([]);
  const [emojiMenuOpen, setEmojiMenuOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  /** Right tips panel hidden (wider thread); persisted per user on server + localStorage. */
  const [deskHidden, setDeskHidden] = useState(false);
  /** Right-click message menu: viewport coords + message id */
  const [msgContextMenu, setMsgContextMenu] = useState(null);
  /** Right-click conversation row: remove DM / leave group */
  const [convContextMenu, setConvContextMenu] = useState(null);
  /** Filter sidebar chat list by title / name */
  const [chatNameFilter, setChatNameFilter] = useState('');
  const [memberModalSearch, setMemberModalSearch] = useState('');
  const [memberModalHits, setMemberModalHits] = useState([]);
  const [memberListSearch, setMemberListSearch] = useState('');
  const [memberListFilter, setMemberListFilter] = useState('all');
  /** From GET messages: typing + peer last-seen for DMs/groups */
  const [presence, setPresence] = useState({ typing: [], peers: [] });
  const [pinnedMessage, setPinnedMessage] = useState(null);
  /** From GET /api/chat/summary — users online in lobby (presence window). */
  const [lobbyOnlineCount, setLobbyOnlineCount] = useState(null);
  const [onlineUsersPopOpen, setOnlineUsersPopOpen] = useState(false);
  const [onlineUsersList, setOnlineUsersList] = useState([]);
  const [onlineUsersLoading, setOnlineUsersLoading] = useState(false);
  const searchTimer = useRef(null);
  const emojiMenuRef = useRef(null);
  const groupSearchTimer = useRef(null);
  const memberModalSearchTimer = useRef(null);
  const listRef = useRef(null);
  const railRef = useRef(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const composerMirrorInnerRef = useRef(null);

  const syncComposerMirrorScroll = useCallback(() => {
    const inner = composerMirrorInnerRef.current;
    const ta = composerInputRef.current;
    if (!inner || !ta) return;
    inner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }, []);

  const adjustComposerHeight = useCallback(() => {
    const el = composerInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, 34), COMPOSER_AUTOSIZE_MAX_PX);
    el.style.height = `${next}px`;
    syncComposerMirrorScroll();
  }, [syncComposerMirrorScroll]);

  useLayoutEffect(() => {
    adjustComposerHeight();
  }, [text, adjustComposerHeight]);

  const onlineUsersPopRef = useRef(null);
  /** When true, new data should keep the list pinned to the bottom (like Teams/WhatsApp). */
  const stickToBottomRef = useRef(true);
  const readReceiptHoverRef = useRef(false);
  const readReceiptCloseTimerRef = useRef(null);
  const typingIdleTimerRef = useRef(null);
  const prevActiveIdRef = useRef(activeId);

  const orderedConversations = useMemo(() => {
    const list = [...conversations];
    list.sort((a, b) => {
      if (String(a.id) === CHAT_GLOBAL_ID) return -1;
      if (String(b.id) === CHAT_GLOBAL_ID) return 1;
      return 0;
    });
    return list;
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    const q = chatNameFilter.trim().toLowerCase();
    if (!q) return orderedConversations;
    return orderedConversations.filter((c) => {
      const title = (c.title != null ? String(c.title) : '').toLowerCase();
      const idHay = String(c.id || '').toLowerCase();
      return title.includes(q) || idHay.includes(q);
    });
  }, [orderedConversations, chatNameFilter]);

  const closeMsgContextMenu = useCallback(() => setMsgContextMenu(null), []);
  const closeConvContextMenu = useCallback(() => setConvContextMenu(null), []);

  useEffect(() => {
    if (!onlineUsersPopOpen) return undefined;
    const onDocDown = (ev) => {
      if (onlineUsersPopRef.current && onlineUsersPopRef.current.contains(ev.target)) return;
      setOnlineUsersPopOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [onlineUsersPopOpen]);

  const openMsgContextMenu = useCallback((e, m) => {
    if (e.target.closest('a[href]')) return;
    e.preventDefault();
    e.stopPropagation();
    setReactPopover(null);
    setReadReceiptPop(null);
    setConvContextMenu(null);
    setMsgContextMenu({ x: e.clientX, y: e.clientY, messageId: m._id });
  }, []);

  const openConvContextMenu = useCallback((e, c) => {
    if (!session || !c) return;
    e.preventDefault();
    e.stopPropagation();
    setReactPopover(null);
    setReadReceiptPop(null);
    setMsgContextMenu(null);
    setConvContextMenu({ x: e.clientX, y: e.clientY, convId: c.id });
  }, [session]);

  const ctxMessage = useMemo(() => {
    if (!msgContextMenu?.messageId) return null;
    return messages.find((x) => String(x._id) === String(msgContextMenu.messageId)) ?? null;
  }, [msgContextMenu, messages]);

  useEffect(() => {
    if (msgContextMenu && !ctxMessage) setMsgContextMenu(null);
  }, [msgContextMenu, ctxMessage]);

  const ctxConv = useMemo(() => {
    if (!convContextMenu?.convId) return null;
    return conversations.find((x) => String(x.id) === String(convContextMenu.convId)) ?? null;
  }, [convContextMenu, conversations]);

  useEffect(() => {
    if (convContextMenu && !ctxConv) setConvContextMenu(null);
  }, [convContextMenu, ctxConv]);

  useEffect(() => {
    if (!msgContextMenu && !convContextMenu) return undefined;
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        closeMsgContextMenu();
        closeConvContextMenu();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [msgContextMenu, convContextMenu, closeMsgContextMenu, closeConvContextMenu]);

  useEffect(() => {
    if (!reactPopover && !readReceiptPop) return undefined;
    const onDocClick = (ev) => {
      if (ev.target.closest('.teams-chat__react-who-popover--pinned')) return;
      if (ev.target.closest('.teams-chat__read-panel--pinned')) return;
      if (ev.target.closest('.teams-chat__react-count-btn')) return;
      if (ev.target.closest('.teams-chat__ctx-menu')) return;
      if (ev.target.closest('.teams-chat__ctx-backdrop')) return;
      if (ev.target.closest('.teams-chat__react-hover-bar')) return;
      setReactPopover(null);
      setReadReceiptPop(null);
    };
    const t = window.setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('click', onDocClick);
    };
  }, [reactPopover, readReceiptPop]);

  useEffect(() => {
    if (!reactPopover && !readReceiptPop && !msgContextMenu && !convContextMenu) return undefined;
    const el = listRef.current;
    const elRail = railRef.current;
    const close = () => {
      setReactPopover(null);
      setReadReceiptPop(null);
      setMsgContextMenu(null);
      setConvContextMenu(null);
    };
    el?.addEventListener('scroll', close, { passive: true });
    elRail?.addEventListener('scroll', close, { passive: true });
    return () => {
      el?.removeEventListener('scroll', close);
      elRail?.removeEventListener('scroll', close);
    };
  }, [reactPopover, readReceiptPop, msgContextMenu, convContextMenu]);

  useEffect(() => {
    if (!readReceiptPop) return undefined;
    readReceiptHoverRef.current = false;
    readReceiptCloseTimerRef.current = window.setTimeout(() => {
      readReceiptCloseTimerRef.current = null;
      if (!readReceiptHoverRef.current) {
        setReadReceiptPop(null);
      }
    }, READ_RECEIPT_AUTO_CLOSE_MS);
    return () => {
      if (readReceiptCloseTimerRef.current != null) {
        window.clearTimeout(readReceiptCloseTimerRef.current);
        readReceiptCloseTimerRef.current = null;
      }
    };
  }, [readReceiptPop]);

  const onReadReceiptPanelEnter = useCallback(() => {
    readReceiptHoverRef.current = true;
    if (readReceiptCloseTimerRef.current != null) {
      window.clearTimeout(readReceiptCloseTimerRef.current);
      readReceiptCloseTimerRef.current = null;
    }
  }, []);

  const onReadReceiptPanelLeave = useCallback(() => {
    readReceiptHoverRef.current = false;
    setReadReceiptPop(null);
  }, []);

  useEffect(() => {
    if (!emojiMenuOpen) return undefined;
    const onDocClick = (ev) => {
      if (emojiMenuRef.current && emojiMenuRef.current.contains(ev.target)) return;
      setEmojiMenuOpen(false);
    };
    const t = window.setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('click', onDocClick);
    };
  }, [emojiMenuOpen]);

  const readSession = useCallback(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setSession(null);
      return;
    }
    try {
      const d = jwtDecode(token);
      if (isJwtExpired(d)) {
        setSession(null);
        return;
      }
      setSession({
        username: d.username,
        displayName: d.displayName || d.username,
        isAdmin: !!d.isAdmin,
      });
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    readSession();
  }, [readSession]);

  useEffect(() => {
    const onFocus = () => readSession();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [readSession]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/public');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        setChatOff(d.lobbyChatEnabled === false);
      } catch {
        if (!cancelled) setChatOff(false);
      } finally {
        if (!cancelled) setLoadingBoot(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setDeskHiddenPersisted = useCallback(
    (next) => {
      setDeskHidden(next);
      const key = chatDeskHiddenStorageKey(session?.username);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      if (session && !chatOff) {
        fetch('/api/chat/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ deskHidden: next }),
        }).catch(() => {});
      }
    },
    [session, chatOff],
  );

  useEffect(() => {
    if (chatOff) return;
    const key = chatDeskHiddenStorageKey(session?.username);
    let fromLocal = false;
    try {
      fromLocal = localStorage.getItem(key) === '1';
    } catch {
      /* ignore */
    }
    if (!session) {
      setDeskHidden(fromLocal);
      return undefined;
    }
    let cancelled = false;
    fetch('/api/chat/preferences', { headers: { ...authHeaders() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d && typeof d.deskHidden === 'boolean') {
          setDeskHidden(d.deskHidden);
          try {
            localStorage.setItem(key, d.deskHidden ? '1' : '0');
          } catch {
            /* ignore */
          }
        } else {
          setDeskHidden(fromLocal);
        }
      })
      .catch(() => {
        if (!cancelled) setDeskHidden(fromLocal);
      });
    return () => {
      cancelled = true;
    };
  }, [session, chatOff]);

  const fetchConversations = useCallback(async () => {
    if (chatOff) return;
    const token = localStorage.getItem('token');
    if (!token) {
      setConversations([
        {
          id: CHAT_GLOBAL_ID,
          type: 'global',
          title: 'Everyone',
          unread: 0,
        },
      ]);
      return;
    }
    try {
      const r = await fetch('/api/chat/conversations', { headers: { ...authHeaders() } });
      if (r.status === 403) {
        setConversations([
          { id: CHAT_GLOBAL_ID, type: 'global', title: 'Everyone', unread: 0 },
        ]);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const list = Array.isArray(d.conversations) ? d.conversations : [];
      setConversations(list);
    } catch {
      /* keep prior */
    }
  }, [chatOff]);

  useEffect(() => {
    if (loadingBoot || chatOff) return;
    fetchConversations();
  }, [loadingBoot, chatOff, fetchConversations]);

  useEffect(() => {
    if (loadingBoot || chatOff) return;
    const onVis = () => {
      if (!document.hidden) fetchConversations();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [loadingBoot, chatOff, fetchConversations]);

  /** Home page unread list: jump to the chosen thread when landing on Chat. */
  useEffect(() => {
    if (loadingBoot || chatOff || conversations.length === 0) return;
    let raw = null;
    try {
      raw = sessionStorage.getItem(CHAT_FOCUS_CONV_STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    const exists = conversations.some((c) => String(c.id) === String(raw));
    if (!exists) {
      try {
        sessionStorage.removeItem(CHAT_FOCUS_CONV_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    setActiveId(raw);
    try {
      sessionStorage.removeItem(CHAT_FOCUS_CONV_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, [loadingBoot, chatOff, conversations]);

  const markRead = useCallback(
    async (cid) => {
      const token = localStorage.getItem('token');
      if (!token || !cid) return;
      try {
        await fetch(`/api/chat/conversations/${encodeURIComponent(cid)}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: '{}',
        });
        notifyChatActivity();
        fetchConversations();
      } catch {
        /* ignore */
      }
    },
    [fetchConversations],
  );

  const fetchMessages = useCallback(async ({ silent = false } = {}) => {
    if (chatOff || !activeId) return;
    if (!silent) {
      setLoadingMsgs(true);
      setError('');
    }
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/messages`, {
        headers: { ...authHeaders() },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const next = Array.isArray(d.messages) ? d.messages : [];
      setPresence({
        typing: Array.isArray(d.presence?.typing) ? d.presence.typing : [],
        peers: Array.isArray(d.presence?.peers) ? d.presence.peers : [],
      });
      if (d.pinnedMessage !== undefined) {
        setPinnedMessage(d.pinnedMessage);
      }
      if (silent) {
        setMessages((prev) => {
          if (messagesSignature(prev) === messagesSignature(next)) return prev;
          return next;
        });
      } else {
        setMessages(next);
      }
    } catch (e) {
      if (!silent) {
        setError(e.message || 'Failed to load messages');
        setMessages([]);
        setPresence({ typing: [], peers: [] });
        setPinnedMessage(null);
      }
    } finally {
      if (!silent) setLoadingMsgs(false);
    }
  }, [activeId, chatOff]);

  const sendTyping = useCallback(
    async (typing) => {
      if (!session || chatOff || !activeId) return;
      try {
        await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/typing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ typing }),
        });
      } catch {
        /* ignore */
      }
    },
    [session, chatOff, activeId],
  );

  const updatePin = useCallback(
    async (messageId) => {
      if (!session || !activeId) return;
      setError('');
      try {
        const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/pin`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ messageId }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
        await fetchMessages({ silent: true });
      } catch (e) {
        setError(e.message || 'Could not update pin');
      }
    },
    [session, activeId, fetchMessages],
  );

  useEffect(() => {
    const prev = prevActiveIdRef.current;
    prevActiveIdRef.current = activeId;
    if (prev !== activeId && session && !chatOff) {
      fetch(`/api/chat/conversations/${encodeURIComponent(prev)}/typing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ typing: false }),
      }).catch(() => {});
    }
  }, [activeId, session, chatOff]);

  useEffect(() => {
    if (!session || chatOff) return undefined;
    const ping = () => {
      fetch('/api/chat/presence/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: '{}',
      }).catch(() => {});
    };
    ping();
    const onVis = () => {
      if (!document.hidden) ping();
    };
    document.addEventListener('visibilitychange', onVis);
    const id = setInterval(ping, 45000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(id);
    };
  }, [session, chatOff]);

  useEffect(() => {
    if (loadingBoot || chatOff) return undefined;
    const loadOnline = () => {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      fetch('/api/chat/summary', { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.enabled === true && typeof d.onlineNow === 'number') {
            setLobbyOnlineCount(d.onlineNow);
          } else {
            setLobbyOnlineCount(null);
          }
        })
        .catch(() => setLobbyOnlineCount(null));
    };
    loadOnline();
    const id = setInterval(loadOnline, 25000);
    const onActivity = () => loadOnline();
    window.addEventListener('sc:chat-activity', onActivity);
    return () => {
      clearInterval(id);
      window.removeEventListener('sc:chat-activity', onActivity);
    };
  }, [loadingBoot, chatOff]);

  const openOnlineUsersPopup = useCallback(() => {
    if (!session) return;
    setOnlineUsersPopOpen((v) => !v);
  }, [session]);

  useEffect(() => {
    if (!onlineUsersPopOpen || !session || chatOff) return;
    setOnlineUsersLoading(true);
    fetch('/api/chat/online-users', { headers: { ...authHeaders() } })
      .then((r) => (r.ok ? r.json() : Promise.resolve({ users: [] })))
      .then((d) => {
        const list = Array.isArray(d?.users) ? d.users : [];
        setOnlineUsersList(list);
      })
      .catch(() => setOnlineUsersList([]))
      .finally(() => setOnlineUsersLoading(false));
  }, [onlineUsersPopOpen, session, chatOff]);

  useEffect(() => {
    if (loadingBoot || chatOff) return;
    setReactPopover(null);
    setReadReceiptPop(null);
    setReplyTarget(null);
    stickToBottomRef.current = true;
    let cancelled = false;
    (async () => {
      await fetchMessages({ silent: false });
      if (!cancelled) await markRead(activeId);
    })();
    const id = setInterval(() => {
      if (!document.hidden) {
        fetchMessages({ silent: true });
        fetchConversations();
      }
    }, POLL_MSG_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeId, loadingBoot, chatOff, fetchMessages, fetchConversations, markRead]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const stickyPx = 80;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      stickToBottomRef.current = scrollHeight - scrollTop - clientHeight <= stickyPx;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [activeId]);

  useLayoutEffect(() => {
    if (loadingMsgs || !messages.length) return;
    if (!stickToBottomRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loadingMsgs, activeId]);

  const scrollToBottom = () => {
    stickToBottomRef.current = true;
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const runUserDirectory = useCallback(async (q, setter) => {
    const token = localStorage.getItem('token');
    if (!token || q.length < 1) {
      setter([]);
      return;
    }
    try {
      const r = await fetch(`/api/chat/directory?q=${encodeURIComponent(q)}`, {
        headers: { ...authHeaders() },
      });
      if (!r.ok) throw new Error('search failed');
      const d = await r.json();
      setter(Array.isArray(d.users) ? d.users : []);
    } catch {
      setter([]);
    }
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!userSearch.trim()) {
      setUserHits([]);
      return;
    }
    searchTimer.current = setTimeout(() => {
      runUserDirectory(userSearch.trim(), setUserHits);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [userSearch, runUserDirectory]);

  useEffect(() => {
    if (groupSearchTimer.current) clearTimeout(groupSearchTimer.current);
    if (!groupSearch.trim()) {
      setGroupHits([]);
      return;
    }
    groupSearchTimer.current = setTimeout(() => {
      runUserDirectory(groupSearch.trim(), setGroupHits);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (groupSearchTimer.current) clearTimeout(groupSearchTimer.current);
    };
  }, [groupSearch, runUserDirectory]);

  useEffect(() => {
    if (memberModalSearchTimer.current) clearTimeout(memberModalSearchTimer.current);
    if (!membersModalOpen || !memberModalSearch.trim()) {
      setMemberModalHits([]);
      return;
    }
    memberModalSearchTimer.current = setTimeout(() => {
      runUserDirectory(memberModalSearch.trim(), setMemberModalHits);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (memberModalSearchTimer.current) clearTimeout(memberModalSearchTimer.current);
    };
  }, [memberModalSearch, membersModalOpen, runUserDirectory]);

  const leaveOrRemoveChat = async (c) => {
    if (!session || !c || c.type === 'global') return;
    const msg =
      c.type === 'dm'
        ? 'Remove this direct chat from your list?'
        : 'Leave this group? (Ask an admin to add you again if needed.)';
    if (!window.confirm(msg)) return;
    setError('');
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(c.id)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      if (String(activeId) === String(c.id)) setActiveId(CHAT_GLOBAL_ID);
      await fetchConversations();
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Could not update chat');
    }
  };

  const deleteGroupForEveryone = async () => {
    if (!session || !activeConv || activeConv.type !== 'group' || !activeConv.isChatAdmin) return;
    if (
      !window.confirm(
        'Delete this group and all its messages for everyone? This cannot be undone.',
      )
    ) {
      return;
    }
    setError('');
    try {
      const r = await fetch(
        `/api/chat/conversations/${encodeURIComponent(activeId)}?purge=true`,
        { method: 'DELETE', headers: { ...authHeaders() } },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      setActiveId(CHAT_GLOBAL_ID);
      setMembersModalOpen(false);
      await fetchConversations();
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Could not delete group');
    }
  };

  const openMembersModal = async () => {
    if (!session || !activeId || activeConv?.type !== 'group') return;
    setMembersModalOpen(true);
    setMembersLoading(true);
    setMembersPayload(null);
    setMemberListSearch('');
    setMemberListFilter('all');
    setError('');
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/members`, {
        headers: { ...authHeaders() },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      setMembersPayload(d);
      const admins = (d.members || []).filter((m) => m.isChatAdmin).map((m) => String(m.username));
      setAdminDraft(admins.length ? admins : (d.members || []).slice(0, 1).map((m) => String(m.username)));
    } catch (e) {
      setError(e.message || 'Could not load members');
      setMembersModalOpen(false);
    } finally {
      setMembersLoading(false);
    }
  };

  const saveGroupAdmins = async () => {
    if (!membersPayload?.isChatAdmin || adminDraft.length < 1) return;
    setError('');
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/admins`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ adminUsernames: adminDraft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      await reloadMembersPayload();
      await fetchConversations();
    } catch (e) {
      setError(e.message || 'Could not save admins');
    }
  };

  const toggleAdminDraft = (username) => {
    const u = String(username);
    setAdminDraft((prev) => {
      if (prev.some((p) => normU(p) === normU(u))) {
        const next = prev.filter((p) => normU(p) !== normU(u));
        return next.length ? next : prev;
      }
      return [...prev, u];
    });
  };

  const startDm = async (username) => {
    if (!session || !username) return;
    setError('');
    setSearchOpen(false);
    setUserSearch('');
    setUserHits([]);
    try {
      const r = await fetch('/api/chat/conversations/dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ withUsername: username }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      await fetchConversations();
      if (d.id) setActiveId(d.id);
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Could not open chat');
    }
  };

  const createGroup = async (e) => {
    e.preventDefault();
    if (!session?.isAdmin || !groupTitle.trim()) return;
    const members = groupMembers.map((m) => m.username).filter(Boolean);
    const adminUsernames = groupMembers.filter((m) => m.isGroupAdmin).map((m) => m.username);
    setError('');
    try {
      const r = await fetch('/api/chat/conversations/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ title: groupTitle.trim(), members, adminUsernames }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      setGroupOpen(false);
      setGroupTitle('');
      setGroupMembers([]);
      setGroupSearch('');
      await fetchConversations();
      if (d.id) setActiveId(d.id);
      notifyChatActivity();
    } catch (err) {
      setError(err.message || 'Could not create group');
    }
  };

  const addGroupMember = (u) => {
    if (!u?.username) return;
    if (groupMembers.some((m) => normU(m.username) === normU(u.username))) return;
    setGroupMembers((prev) => [
      ...prev,
      { username: u.username, displayName: u.displayName || u.username, isGroupAdmin: false },
    ]);
    setGroupSearch('');
    setGroupHits([]);
  };

  const toggleGroupMemberAdmin = (username) => {
    setGroupMembers((prev) =>
      prev.map((m) =>
        normU(m.username) === normU(username) ? { ...m, isGroupAdmin: !m.isGroupAdmin } : m,
      ),
    );
  };

  const reloadMembersPayload = async () => {
    const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/members`, {
      headers: { ...authHeaders() },
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      setMembersPayload(d);
      const admins = (d.members || []).filter((m) => m.isChatAdmin).map((m) => String(m.username));
      setAdminDraft(
        admins.length ? admins : (d.members || []).slice(0, 1).map((m) => String(m.username)),
      );
    }
  };

  const addMemberViaApi = async (u) => {
    if (!u?.username || !membersPayload?.isChatAdmin) return;
    setError('');
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ add: [u.username] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      if (d.action === 'dissolved') {
        setMembersModalOpen(false);
        setActiveId(CHAT_GLOBAL_ID);
      }
      setMemberModalSearch('');
      setMemberModalHits([]);
      await reloadMembersPayload();
      await fetchConversations();
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Could not add member');
    }
  };

  const removeMemberViaApi = async (username) => {
    if (!membersPayload?.isChatAdmin || !username) return;
    if (!window.confirm(`Remove ${username} from this group?`)) return;
    setError('');
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ remove: [username] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      if (d.action === 'dissolved') {
        setMembersModalOpen(false);
        setActiveId(CHAT_GLOBAL_ID);
      }
      await reloadMembersPayload();
      await fetchConversations();
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Could not remove member');
    }
  };

  const uploadFile = async (file) => {
    if (!file || !session) return;
    if (file.size > MAX_ATTACH) {
      setError('Each file must be 10 MB or smaller.');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/chat/attachments', {
      method: 'POST',
      headers: { ...authHeaders() },
      body: fd,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'Upload failed');
    return {
      url: d.url,
      name: d.name || file.name,
      mime: d.mime || file.type || '',
      size: d.size || file.size || 0,
    };
  };

  const onPickFiles = async (ev) => {
    const files = ev.target?.files;
    if (!files?.length || !session) return;
    setError('');
    try {
      const slice = Array.from(files).slice(0, Math.max(0, 5 - pendingFiles.length));
      const metas = await Promise.all(slice.map((f) => uploadFile(f)));
      setPendingFiles((p) => [...p, ...metas.filter(Boolean)].slice(0, 5));
    } catch (e) {
      setError(e.message || 'Upload failed');
    }
    ev.target.value = '';
  };

  const onComposerChange = (e) => {
    const v = e.target.value;
    setText(v);
    if (!session || chatOff) return;
    if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
    sendTyping(true);
    typingIdleTimerRef.current = setTimeout(() => {
      typingIdleTimerRef.current = null;
      sendTyping(false);
    }, 3500);
  };

  const send = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const t = text.replace(/\r\n/g, '\n').trim();
    if ((!t && pendingFiles.length === 0) || !session) return;
    if (typingIdleTimerRef.current) {
      clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
    sendTyping(false);
    setSending(true);
    setError('');
    try {
      const body = { text: t, attachments: pendingFiles };
      if (replyTarget?._id) body.replyToMessageId = replyTarget._id;
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(activeId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      setText('');
      setPendingFiles([]);
      setReplyTarget(null);
      await fetchMessages({ silent: true });
      await fetchConversations();
      notifyChatActivity();
      scrollToBottom();
      if (d.message?._id) {
        /* optimistic ok */
      }
    } catch (err) {
      setError(err.message || 'Send failed');
    } finally {
      setSending(false);
      queueMicrotask(() => {
        const el = composerInputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        try {
          const len = el.value.length;
          el.setSelectionRange(len, len);
        } catch {
          /* ignore */
        }
        adjustComposerHeight();
      });
    }
  };

  const toggleReaction = async (messageId, emoji) => {
    if (!session) return;
    setError('');
    try {
      const r = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ emoji }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Reaction failed');
      setMessages((prev) =>
        prev.map((m) => (String(m._id) === String(messageId) ? d.message || m : m)),
      );
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Reaction failed');
    }
  };

  const removeMessage = async (messageId) => {
    if (!session) return;
    if (!window.confirm('Delete this message?')) return;
    setError('');
    try {
      const r = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.message || `HTTP ${r.status}`);
      }
      await fetchMessages({ silent: true });
      await fetchConversations();
      notifyChatActivity();
    } catch (e) {
      setError(e.message || 'Delete failed');
    }
  };

  const copyText = (s) => {
    if (!s) return;
    navigator.clipboard?.writeText(s).catch(() => {});
  };

  const activeConv = conversations.find((c) => String(c.id) === String(activeId));
  const deskMeta = deskThreadMeta(activeConv);

  const threadSummary = useMemo(() => {
    if (messages.length < 25) return null;
    const first = messages[0];
    const last = messages[messages.length - 1];
    return {
      count: messages.length,
      from: formatShortThreadDate(first?.createdAt),
      to: formatShortThreadDate(last?.createdAt),
    };
  }, [messages]);

  const dmPeer = useMemo(() => {
    if (activeConv?.type !== 'dm' || !presence.peers?.length) return null;
    return presence.peers[0];
  }, [activeConv?.type, presence.peers]);

  /** Prefer live message payload; fall back to sidebar listPresence while messages load. */
  const dmHeaderPresence = useMemo(() => {
    if (activeConv?.type !== 'dm') return null;
    if (dmPeer) {
      return { online: !!dmPeer.online, lastSeenLabel: dmPeer.lastSeenLabel || '' };
    }
    const lp = activeConv?.listPresence;
    if (lp && lp.kind === 'dm') {
      return { online: !!lp.online, lastSeenLabel: lp.lastSeenLabel || '' };
    }
    return null;
  }, [activeConv?.type, activeConv?.listPresence, dmPeer]);

  const groupOnlineCount = useMemo(() => {
    if (!presence.peers?.length) return 0;
    return presence.peers.filter((p) => p.online).length;
  }, [presence.peers]);

  const groupPresenceByUser = useMemo(() => {
    const m = new Map();
    const peers = Array.isArray(presence.peers) ? presence.peers : [];
    for (let i = 0; i < peers.length; i += 1) {
      const p = peers[i];
      const key = normU(p?.username);
      if (!key) continue;
      m.set(key, {
        online: !!p.online,
        lastSeenLabel: p.lastSeenLabel || 'unknown',
      });
    }
    return m;
  }, [presence.peers]);

  const modalMemberRows = useMemo(() => {
    const rows = Array.isArray(membersPayload?.members) ? [...membersPayload.members] : [];
    const self = normU(session?.username);
    const search = memberListSearch.trim().toLowerCase();
    const enriched = rows.map((m) => {
      const nu = normU(m.username);
      if (nu && self && nu === self) {
        return { ...m, online: true, lastSeenLabel: 'online' };
      }
      const pr = groupPresenceByUser.get(nu);
      if (pr) return { ...m, online: !!pr.online, lastSeenLabel: pr.lastSeenLabel || 'unknown' };
      return { ...m, online: false, lastSeenLabel: 'unknown' };
    });
    const filtered = enriched.filter((m) => {
      if (memberListFilter === 'online' && !m.online) return false;
      if (memberListFilter === 'admins' && !m.isChatAdmin) return false;
      if (!search) return true;
      const dn = String(m.displayName || '').toLowerCase();
      const un = String(m.username || '').toLowerCase();
      return dn.includes(search) || un.includes(search);
    });
    filtered.sort((a, b) => {
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      if (!!a.isChatAdmin !== !!b.isChatAdmin) return a.isChatAdmin ? -1 : 1;
      return String(a.displayName || a.username || '').localeCompare(
        String(b.displayName || b.username || ''),
        undefined,
        { sensitivity: 'base' },
      );
    });
    return filtered;
  }, [membersPayload?.members, session?.username, groupPresenceByUser, memberListSearch, memberListFilter]);

  const modalMemberStats = useMemo(() => {
    const rows = Array.isArray(membersPayload?.members) ? membersPayload.members : [];
    let online = 0;
    let admins = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const m = rows[i];
      if (m.isChatAdmin) admins += 1;
      const nu = normU(m.username);
      if (nu && nu === normU(session?.username)) {
        online += 1;
        continue;
      }
      const pr = groupPresenceByUser.get(nu);
      if (pr?.online) online += 1;
    }
    return { total: rows.length, online, admins };
  }, [membersPayload?.members, session?.username, groupPresenceByUser]);

  const ctxMenuStyle = useMemo(() => {
    if (!msgContextMenu) return null;
    const w = 240;
    const h = 320;
    const pad = 8;
    const winW = typeof window !== 'undefined' ? window.innerWidth : 800;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 600;
    let x = msgContextMenu.x;
    let y = msgContextMenu.y;
    x = Math.min(x, winW - w - pad);
    y = Math.min(y, winH - h - pad);
    x = Math.max(pad, x);
    y = Math.max(pad, y);
    return { left: x, top: y };
  }, [msgContextMenu]);

  const convCtxMenuStyle = useMemo(() => {
    if (!convContextMenu) return null;
    const w = 220;
    const h = 140;
    const pad = 8;
    const winW = typeof window !== 'undefined' ? window.innerWidth : 800;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 600;
    let x = convContextMenu.x;
    let y = convContextMenu.y;
    x = Math.min(x, winW - w - pad);
    y = Math.min(y, winH - h - pad);
    x = Math.max(pad, x);
    y = Math.max(pad, y);
    return { left: x, top: y };
  }, [convContextMenu]);

  const ctxIsSelf =
    session &&
    ctxMessage &&
    normU(ctxMessage.fromUsername) === normU(session.username);
  const ctxCanDelete =
    session &&
    ctxMessage &&
    (ctxIsSelf ||
      session.isAdmin ||
      (activeConv?.type === 'group' && activeConv?.isChatAdmin));
  const ctxCanPin =
    session && ctxMessage && (activeConv?.type !== 'global' || session.isAdmin);
  const ctxIsPinned =
    !!(pinnedMessage && ctxMessage && String(pinnedMessage._id) === String(ctxMessage._id));

  const scrollToPinnedMessage = () => {
    if (!pinnedMessage?._id) return;
    const id = String(pinnedMessage._id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = document.querySelector(`[data-chat-msg-id="${id}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const insertEmoji = (emo) => {
    setText((prev) => `${prev}${emo}`);
    if (session && !chatOff && activeId) {
      sendTyping(true);
      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = setTimeout(() => {
        typingIdleTimerRef.current = null;
        sendTyping(false);
      }, 3500);
    }
  };

  if (loadingBoot) {
    return (
      <div className="teams-chat teams-chat--loading" aria-busy="true">
        <p className="teams-chat__hint">Loading chat…</p>
      </div>
    );
  }

  if (chatOff) {
    return (
      <div className="lobby-page__disabled" role="status">
        <p className="lobby-page__disabled-title">Chat is not available</p>
        <p className="lobby-page__disabled-text">
          An administrator or this deployment can disable chat. The rest of the site still works.
        </p>
      </div>
    );
  }

  return (
    <div className="teams-chat" aria-label="Team chat">
      {error ? (
        <p className="teams-chat__err" role="alert">
          {error}
        </p>
      ) : null}

      <aside className="teams-chat__rail">
        <div className="teams-chat__rail-find-head">
          <p className="teams-chat__rail-section-label teams-chat__rail-section-label--find">Find someone</p>
          {lobbyOnlineCount != null ? (
            <div ref={onlineUsersPopRef} className="teams-chat__rail-online-wrap">
              <button
                type="button"
                className="teams-chat__rail-online-count"
                title={session ? 'Show users online now' : 'Sign in to view who is online'}
                disabled={!session}
                onClick={openOnlineUsersPopup}
                aria-label="Show online users"
              >
                <span
                  className="teams-chat__presence-dot teams-chat__presence-dot--on teams-chat__presence-dot--sm"
                  aria-hidden
                />
                <span className="teams-chat__rail-online-count-num">{lobbyOnlineCount}</span>
              </button>
              {onlineUsersPopOpen ? (
                <div className="teams-chat__online-pop" role="dialog" aria-label="Online users">
                  {onlineUsersLoading ? (
                    <span className="teams-chat__online-pop-empty">Loading…</span>
                  ) : onlineUsersList.length > 0 ? (
                    <ul className="teams-chat__online-pop-list">
                      {onlineUsersList.map((u) => (
                        <li key={u.username}>
                          <button
                            type="button"
                            className="teams-chat__online-pop-user"
                            onClick={() => {
                              setOnlineUsersPopOpen(false);
                              startDm(u.username);
                            }}
                          >
                            <span className="teams-chat__online-pop-name">{u.displayName || u.username}</span>
                            <span className="teams-chat__online-pop-login">{u.username}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="teams-chat__online-pop-empty">No users online right now.</span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="teams-chat__rail-hint">
          {session ? '' : 'Sign in to search and start a direct message.'}
        </p>
        <div className="teams-chat__search-wrap">
          <input
            id="chat-user-search"
            type="search"
            className="teams-chat__search"
            placeholder={session ? 'Name or username…' : 'Sign in to search…'}
            value={userSearch}
            disabled={!session}
            onChange={(e) => {
              setUserSearch(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => session && setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 180)}
          />
          {session && searchOpen && userHits.length > 0 ? (
            <ul className="teams-chat__search-results" role="listbox">
              {userHits.map((u) => (
                <li key={`${u.source || 'app'}-${u.username}`}>
                  <button
                    type="button"
                    className="teams-chat__search-hit"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => startDm(u.username)}
                  >
                    <span className="teams-chat__search-hit-main">
                      <span className="teams-chat__search-name">{u.displayName}</span>
                      <span
                        className={`teams-chat__source-tag${u.source === 'ad' ? ' teams-chat__source-tag--ad' : ''}`}
                        title={u.source === 'ad' ? 'Active Directory' : 'Seen in this app'}
                      >
                        {u.source === 'ad' ? 'AD' : 'App'}
                      </span>
                    </span>
                    <span className="teams-chat__search-user">{u.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {session?.isAdmin ? (
          <button type="button" className="teams-chat__new-group" onClick={() => setGroupOpen(true)}>
            <span className="teams-chat__new-group-ico" aria-hidden>
              <ChatIconPlusCircle />
            </span>
            New group chat
          </button>
        ) : null}

        <div className="teams-chat__rail-chats-block">
          <p className="teams-chat__rail-section-label teams-chat__rail-section-label--spaced teams-chat__rail-section-label--chats">
            <span className="teams-chat__rail-chats-ico" aria-hidden>
              <ChatIconBubbleDouble />
            </span>
            Chats
          </p>
          <p className="teams-chat__rail-hint teams-chat__rail-hint--chats">
            {session
              ? 'Everyone, direct messages, and groups. Right-click a chat to mute, remove or leave it.'
              : 'Sign in to see direct messages and groups. Everyone is available without signing in.'}
          </p>
          <label className="teams-chat__chat-filter-label" htmlFor="teams-chat-filter-chats">
            <span className="sr-only">Search chats by name</span>
            <input
              id="teams-chat-filter-chats"
              type="search"
              className="teams-chat__chat-filter"
              placeholder="Search chats…"
              value={chatNameFilter}
              onChange={(e) => setChatNameFilter(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
        <ul ref={railRef} className="teams-chat__conv-list" aria-label="Chats">
          {filteredConversations.length === 0 ? (
            <li className="teams-chat__conv-empty">
              <p className="teams-chat__hint">No chats match “{chatNameFilter.trim()}”.</p>
            </li>
          ) : null}
          {filteredConversations.map((c) => (
            <li key={c.id}>
              <div
                className="teams-chat__conv-wrap"
                onContextMenu={
                  session ? (e) => openConvContextMenu(e, c) : undefined
                }
              >
                <button
                  type="button"
                  className={`teams-chat__conv${String(c.id) === String(activeId) ? ' teams-chat__conv--active' : ''}`}
                  onClick={() => setActiveId(c.id)}
                >
                  <span
                    className="teams-chat__conv-leading"
                    title={c.type === 'global' ? 'Channel' : c.type === 'dm' ? 'Direct message' : 'Group'}
                  >
                    <span className="teams-chat__conv-icon" aria-hidden>
                      <ConvRailGlyph type={c.type} />
                    </span>
                    <span className="teams-chat__conv-text-stack">
                      <span className="teams-chat__conv-title">
                        {c.title || 'Chat'}
                        {c.source ? <span className="teams-chat__source-tag teams-chat__conv-source">{c.source}</span> : null}
                        {c.mutedUntil ? <span className="teams-chat__muted-mark" title={mutedLabel(c.mutedUntil)} aria-label={mutedLabel(c.mutedUntil)}>🔕</span> : null}
                      </span>
                      <ConvListPresence lp={c.listPresence} />
                    </span>
                  </span>
                  {c.unread > 0 ? (
                    <span className={`teams-chat__conv-badge${c.mutedUntil ? ' teams-chat__conv-badge--muted' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>
                  ) : null}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <div className="teams-chat__main">
        <header className="teams-chat__main-head">
          <div className="teams-chat__main-head-top">
            <div className="teams-chat__main-head-text">
              <h2 className="teams-chat__main-title">{activeConv?.title || 'Everyone'}</h2>
              {activeConv?.type === 'global' ? (
                <p className="teams-chat__main-sub">Open channel · anyone can read · sign in to post</p>
              ) : null}
              {activeConv?.type === 'dm' ? (
                <p className="teams-chat__main-sub teams-chat__main-sub--with-presence">
                  {dmHeaderPresence ? (
                    <>
                      <span
                        className={`teams-chat__presence-dot${
                          dmHeaderPresence.online
                            ? ' teams-chat__presence-dot--on'
                            : ' teams-chat__presence-dot--off'
                        }`}
                        aria-hidden
                      />
                      <span>
                        {dmHeaderPresence.online
                          ? 'Online'
                          : `Last seen ${dmHeaderPresence.lastSeenLabel}`}
                      </span>
                    </>
                  ) : (
                    'Direct message'
                  )}
                </p>
              ) : null}
              {activeConv?.type === 'group' ? (
                <>
                  <p className="teams-chat__main-sub">
                    {activeConv?.source
                      ? `Connected to ${activeConv.source} · messages are shared with that app`
                      : 'Group chat · open Members to see who is here or manage admins'}
                  </p>
                  {presence.peers && presence.peers.length > 0 ? (
                    <p className="teams-chat__main-sub teams-chat__main-sub--with-presence teams-chat__main-sub--tight">
                      <span
                        className={`teams-chat__presence-dot${
                          groupOnlineCount > 0
                            ? ' teams-chat__presence-dot--on'
                            : ' teams-chat__presence-dot--off'
                        }`}
                        aria-hidden
                      />
                      <span>
                        {groupOnlineCount} of {presence.peers.length} online
                      </span>
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="teams-chat__main-head-actions">
              {session && activeConv ? (
                <ChatMuteButton
                  conv={activeConv}
                  onChange={async (duration) => {
                    await setChatMute(activeConv.id, duration).catch(() => {});
                    await fetchConversations();
                    notifyChatActivity();
                  }}
                />
              ) : null}
              {session && activeConv?.type === 'group' ? (
                <div className="teams-chat__main-actions">
                  <button type="button" className="teams-chat__head-btn" onClick={openMembersModal}>
                    Members
                  </button>
                  {activeConv.isChatAdmin ? (
                    <button
                      type="button"
                      className="teams-chat__head-btn teams-chat__head-btn--danger"
                      onClick={deleteGroupForEveryone}
                    >
                      Delete group
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          {!deskHidden ? (
            <button
              type="button"
              className="teams-chat__desk-toggle-head"
              onClick={() => setDeskHiddenPersisted(true)}
              title="Hide tips panel"
              aria-label="Hide tips panel"
              aria-controls="teams-chat-desk-panel"
              aria-expanded
            >
              <span className="teams-chat__desk-chev" aria-hidden>
                <ChatIconChevronRight />
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="teams-chat__desk-toggle-head"
              onClick={() => setDeskHiddenPersisted(false)}
              title="Show tips panel"
              aria-label="Show tips panel"
              aria-controls="teams-chat-desk-panel"
              aria-expanded={false}
            >
              <span className="teams-chat__desk-chev" aria-hidden>
                <ChatIconChevronLeft />
              </span>
            </button>
          )}
        </header>

        {presence.typing && presence.typing.length > 0 ? (
          <p className="teams-chat__typing" aria-live="polite">
            {presence.typing.map((t) => t.displayName || t.username).join(', ')}
            {presence.typing.length === 1 ? ' is typing…' : ' are typing…'}
          </p>
        ) : null}
        {threadSummary ? (
          <p className="teams-chat__thread-summary" role="status">
            This thread has {threadSummary.count} messages ({threadSummary.from} – {threadSummary.to}).
          </p>
        ) : null}
        {pinnedMessage ? (
          <div className="teams-chat__pinned-bar">
            <span className="teams-chat__pinned-ico" aria-hidden>
              <ChatIconPin />
            </span>
            <button type="button" className="teams-chat__pinned-body" onClick={scrollToPinnedMessage}>
              <span className="teams-chat__pinned-label">Pinned</span>
              <span className="teams-chat__pinned-snippet" dir="auto">
                {(pinnedMessage.fromDisplayName || pinnedMessage.fromUsername || 'User').trim()}:{' '}
                <MessageBodyAppleText
                  as="span"
                  text={clipChatSnippet(pinnedMessage.text)}
                />
              </span>
            </button>
            {session && (activeConv?.type !== 'global' || session.isAdmin) ? (
              <button type="button" className="teams-chat__pinned-unpin" onClick={() => updatePin(null)}>
                Unpin
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="teams-chat__messages" ref={listRef} tabIndex={0}>
          {loadingMsgs && <p className="teams-chat__hint">Loading messages…</p>}
          {!loadingMsgs && messages.length === 0 && (
            <p className="teams-chat__hint">
              No messages here yet. {session ? 'Send the first one below.' : 'Sign in to join the conversation.'}
            </p>
          )}
          {!loadingMsgs &&
            messages.map((m) => {
              const isSelf = session && normU(m.fromUsername) === normU(session.username);
              const isFirstMessage =
                messages.length > 0 && String(m._id) === String(messages[0]._id);
              const isLastMessage =
                messages.length > 0 && String(m._id) === String(messages[messages.length - 1]._id);
              const reactions = m.reactions && typeof m.reactions === 'object' ? m.reactions : {};
              const reactionMembers =
                m.reactionMembers && typeof m.reactionMembers === 'object' ? m.reactionMembers : {};
              const reactionKeys = Object.keys(reactions);
              return (
                <div
                  key={m._id}
                  className={`teams-chat__msg-row${isSelf ? ' teams-chat__msg-row--self' : ''}`}
                >
                  <span className="teams-chat__msg-avatar" aria-hidden="true">
                    {String(m.fromDisplayName || m.fromUsername || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <div className="teams-chat__msg-hover-wrap">
                    {session ? (
                      <div
                        className={`teams-chat__react-hover-bar${
                          isFirstMessage ? ' teams-chat__react-hover-bar--below' : ''
                        }`}
                        aria-label="Add reaction"
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        {QUICK_EMOJI.map((emo) => {
                          const mine = reactions[emo]?.some((u) => normU(u) === normU(session.username));
                          return (
                            <button
                              key={emo}
                              type="button"
                              className="teams-chat__react-hover-btn"
                              title={mine ? 'Remove reaction' : `React with ${emo}`}
                              aria-label={mine ? 'Remove reaction' : `React with ${emo}`}
                              onClick={() => toggleReaction(m._id, emo)}
                            >
                              <AppleEmoji
                                emoji={emo}
                                imgClassName="teams-chat__emoji-apple-img teams-chat__emoji-apple-img--hover"
                              />
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <article
                      className={`teams-chat__msg${isSelf ? ' teams-chat__msg--self' : ''}`}
                      data-chat-msg-id={m._id}
                      onContextMenu={(e) => openMsgContextMenu(e, m)}
                    >
                  <div className="teams-chat__msg-head">
                    <div className="teams-chat__msg-who">
                      {isSelf ? (
                        <span className="teams-chat__msg-author">You</span>
                      ) : (
                        <button
                          type="button"
                          className="teams-chat__msg-author teams-chat__msg-author--link"
                          disabled={!session || !m.fromUsername || !!m.external}
                          title={
                            m.external
                              ? `From ${m.source}`
                              : session
                              ? `Send a message to ${m.fromDisplayName || m.fromUsername}`
                              : 'Sign in to send a direct message'
                          }
                          onClick={() => session && m.fromUsername && startDm(m.fromUsername)}
                        >
                          {m.fromDisplayName || m.fromUsername || 'User'}
                        </button>
                      )}
                      {m.external && m.source ? <span className="teams-chat__source-tag">{m.source}</span> : null}
                      <time className="teams-chat__msg-time" dateTime={m.createdAt || undefined}>
                        {formatTime(m.createdAt)}
                      </time>
                      {m.delivery?.status ? (
                        <span className={`teams-chat__delivery teams-chat__delivery--${m.delivery.status}`}>
                          {{ pending: 'Sending', delivered: 'Delivered', failed: 'Not delivered' }[m.delivery.status] || ''}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {m.replyPreview && m.replyToMessageId ? (
                    <blockquote className="teams-chat__msg-reply-quote" dir="auto">
                      <span className="teams-chat__msg-reply-who">
                        {m.replyPreview.fromDisplayName || m.replyPreview.fromUsername || 'User'}
                      </span>
                      <span className="teams-chat__msg-reply-snippet">
                        {m.replyPreview.text ? (
                          <MessageBodyAppleText as="span" text={m.replyPreview.text} />
                        ) : (
                          '…'
                        )}
                      </span>
                    </blockquote>
                  ) : null}
                  {m.text ? <MessageBodyAppleText text={m.text} className="teams-chat__msg-body" /> : null}
                  {Array.isArray(m.attachments) && m.attachments.length > 0 ? (
                    <ul className="teams-chat__attach-list">
                      {m.attachments.map((a) => (
                        <li key={`${m._id}-${a.url}`}>
                          <a
                            href={a.url}
                            className="teams-chat__attach-link"
                            {...(/^\/api\/uploads\//.test(String(a.url))
                              ? { onClick: (e) => downloadChatAttachment(e, a) }
                              : { target: '_blank', rel: 'noopener noreferrer' })}
                          >
                            {a.name || 'Attachment'}
                            {a.size ? ` · ${(a.size / 1024).toFixed(1)} KB` : ''}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="teams-chat__reactions">
                    {reactionKeys.map((emoji) => {
                      const users = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
                      const members = Array.isArray(reactionMembers[emoji])
                        ? reactionMembers[emoji]
                        : users.map((uname) => ({ username: uname, displayName: uname }));
                      const me = session && users.some((u) => normU(u) === normU(session.username));
                      const popOpen =
                        reactPopover &&
                        String(reactPopover.messageId) === String(m._id) &&
                        reactPopover.emoji === emoji;
                      const namesLine = members.map((p) => p.displayName || p.username).join(', ');
                      return (
                        <span key={emoji} className="teams-chat__react-pair">
                          <button
                            type="button"
                            className={`teams-chat__react-emoji${me ? ' teams-chat__react-emoji--mine' : ''}`}
                            onClick={() => session && toggleReaction(m._id, emoji)}
                            disabled={!session}
                            title={
                              session
                                ? me
                                  ? 'Remove reaction'
                                  : `React with ${emoji} (replaces your current reaction)`
                                : 'Sign in to react'
                            }
                          >
                            <AppleEmoji
                              emoji={emoji}
                              imgClassName="teams-chat__emoji-apple-img teams-chat__emoji-apple-img--react"
                            />
                          </button>
                          <span className="teams-chat__react-meta">
                            <button
                              type="button"
                              className="teams-chat__react-count-btn"
                              title={namesLine || 'Who reacted'}
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                if (popOpen) {
                                  setReactPopover(null);
                                  return;
                                }
                                setReadReceiptPop(null);
                                setReactPopover({ messageId: m._id, emoji });
                              }}
                            >
                              {users.length}
                            </button>
                          </span>
                        </span>
                      );
                    })}
                    {reactPopover && String(reactPopover.messageId) === String(m._id) ? (
                      <div
                        className="teams-chat__react-who-popover teams-chat__react-who-popover--pinned"
                        role="dialog"
                        aria-label={`People who reacted with ${reactPopover.emoji}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="teams-chat__react-who-title">
                          <span className="teams-chat__react-who-title-label">Reacted with</span>
                          <AppleEmoji
                            emoji={reactPopover.emoji}
                            imgClassName="teams-chat__emoji-apple-img teams-chat__emoji-apple-img--who-title"
                          />
                          <span className="sr-only">{reactPopover.emoji}</span>
                        </p>
                        <ul className="teams-chat__react-who-list">
                          {(reactionMembers[reactPopover.emoji] ||
                            (Array.isArray(reactions[reactPopover.emoji])
                              ? reactions[reactPopover.emoji].map((uname) => ({
                                  username: uname,
                                  displayName: uname,
                                }))
                              : [])
                          ).map((person) => (
                            <li key={person.username}>
                              {session && normU(person.username) !== normU(session.username) ? (
                                <button
                                  type="button"
                                  className="teams-chat__react-who-person"
                                  onClick={() => {
                                    setReactPopover(null);
                                    startDm(person.username);
                                  }}
                                >
                                  {person.displayName || person.username}
                                </button>
                              ) : (
                                <span className="teams-chat__react-who-person teams-chat__react-who-person--static">
                                  {person.displayName || person.username}
                                  {session && normU(person.username) === normU(session.username) ? ' (you)' : ''}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  {isSelf && session && readReceiptPop && String(readReceiptPop.messageId) === String(m._id) ? (
                    <div
                      className={`teams-chat__read-wrap${isLastMessage ? ' teams-chat__read-wrap--flip-up' : ''}`}
                      onMouseEnter={onReadReceiptPanelEnter}
                      onMouseLeave={onReadReceiptPanelLeave}
                    >
                      <div
                        className="teams-chat__read-panel--pinned"
                        role="dialog"
                        aria-label="Who read this message"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="teams-chat__react-who-title">Read receipts</p>
                        {Array.isArray(m.readBy) && m.readBy.length > 0 ? (
                          <ul className="teams-chat__react-who-list">
                            {m.readBy.map((person) => (
                              <li key={person.username}>
                                {session && normU(person.username) !== normU(session.username) ? (
                                  <button
                                    type="button"
                                    className="teams-chat__react-who-person"
                                    onClick={() => {
                                      setReadReceiptPop(null);
                                      startDm(person.username);
                                    }}
                                  >
                                    {person.displayName || person.username}
                                  </button>
                                ) : (
                                  <span className="teams-chat__react-who-person teams-chat__react-who-person--static">
                                    {person.displayName || person.username}
                                    {session && normU(person.username) === normU(session.username) ? ' (you)' : ''}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="teams-chat__read-empty">
                            No other readers yet (people appear after they open this chat).
                          </p>
                        )}
                      </div>
                    </div>
                  ) : null}
                </article>
                  </div>
                </div>
              );
            })}
          <div ref={bottomRef} />
        </div>

        {session ? (
          <div className="teams-chat__composer">
            <form className="teams-chat__composer-form" onSubmit={send}>
              <input
                ref={fileInputRef}
                type="file"
                className="teams-chat__file-input"
                tabIndex={-1}
                aria-hidden="true"
                accept=".txt,.json,.md,.markdown,.csv,.log,.xml,.yml,.yaml,.tsv,text/*,application/json"
                multiple
                onChange={onPickFiles}
              />
              {pendingFiles.length > 0 ? (
                <div className="teams-chat__pending-inline">
                  {pendingFiles.map((f) => (
                    <span key={f.url} className="teams-chat__pending-chip">
                      {f.name}
                      <button
                        type="button"
                        className="teams-chat__pending-chip-x"
                        onClick={() => setPendingFiles((p) => p.filter((x) => x.url !== f.url))}
                        aria-label="Remove attachment"
                      >
                        <ChatIconXPlain />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {replyTarget ? (
                <div className="teams-chat__reply-draft">
                  <div className="teams-chat__reply-draft-main">
                    <span className="teams-chat__reply-draft-label">Replying to</span>
                    <span className="teams-chat__reply-draft-who">
                      {replyTarget.fromDisplayName || replyTarget.fromUsername || 'User'}
                    </span>
                    <span className="teams-chat__reply-draft-snippet" dir="auto">
                      <MessageBodyAppleText as="span" text={clipChatSnippet(replyTarget.text)} />
                    </span>
                  </div>
                  <button
                    type="button"
                    className="teams-chat__reply-draft-x"
                    aria-label="Cancel reply"
                    onClick={() => setReplyTarget(null)}
                  >
                    <ChatIconXPlain />
                  </button>
                </div>
              ) : null}
              <div className="teams-chat__composer-row teams-chat__composer-row--fill">
                <button
                  type="button"
                  className="teams-chat__composer-tool teams-chat__composer-tool--lead"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach file"
                  aria-label="Attach file"
                >
                  <ChatIconPaperclip className="teams-chat__apple-ico teams-chat__apple-ico--tool" />
                </button>
                <div className="teams-chat__input-shell">
                  <div
                    className="teams-chat__input-underlay"
                    aria-hidden="true"
                    style={{ visibility: composerComposing ? 'hidden' : 'visible' }}
                  >
                    <div ref={composerMirrorInnerRef} className="teams-chat__input-underlay-inner">
                      {text ? (
                        <MessageBodyAppleText
                          as="span"
                          text={text}
                          emojiImgSizeClassName="teams-chat__emoji-apple-img--composer-inline"
                        />
                      ) : null}
                    </div>
                  </div>
                  <textarea
                    id="teams-chat-input"
                    ref={composerInputRef}
                    className={`teams-chat__input-inline${
                      composerComposing ? '' : ' teams-chat__input-inline--mirror'
                    }`}
                    dir="auto"
                    rows={1}
                    value={text}
                    maxLength={MAX_TEXT}
                    onChange={onComposerChange}
                    onCompositionStart={() => setComposerComposing(true)}
                    onCompositionEnd={() => setComposerComposing(false)}
                    onScroll={syncComposerMirrorScroll}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    aria-label="Type a message"
                  />
                </div>
                <div className="teams-chat__composer-trailing">
                  <div className="teams-chat__composer-emoji-wrap" ref={emojiMenuRef}>
                    <button
                      type="button"
                      className="teams-chat__composer-tool"
                      aria-label="Emoji"
                      title="Emoji"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEmojiMenuOpen((o) => !o);
                      }}
                    >
                      <ChatIconFaceSmile className="teams-chat__apple-ico teams-chat__apple-ico--tool" />
                    </button>
                    {emojiMenuOpen ? (
                      <div
                        className="teams-chat__emoji-flyout teams-chat__emoji-flyout--trailing"
                        role="listbox"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {QUICK_EMOJI.map((emo) => (
                          <button
                            key={emo}
                            type="button"
                            className="teams-chat__emoji-flyout-item"
                            aria-label={`Insert ${emo}`}
                            onClick={() => {
                              insertEmoji(emo);
                              setEmojiMenuOpen(false);
                            }}
                          >
                            <AppleEmoji
                              emoji={emo}
                              imgClassName="teams-chat__emoji-apple-img teams-chat__emoji-apple-img--flyout"
                            />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="submit"
                    className="teams-chat__send-inline"
                    disabled={sending || (!text.trim() && pendingFiles.length === 0)}
                    title="Send"
                  >
                    {sending ? (
                      <span className="teams-chat__send-dots">…</span>
                    ) : (
                      <ChatIconArrowUpSend className="teams-chat__apple-ico teams-chat__apple-ico--send" />
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : (
          <p className="teams-chat__hint teams-chat__hint--foot">
            Sign in to post, react, and message people. Everyone can read this channel.
          </p>
        )}
      </div>

      {!deskHidden ? (
      <aside
        id="teams-chat-desk-panel"
        className="teams-chat__desk"
        aria-label="Chat tips and shortcuts"
      >
        <div className="teams-chat__desk-card">
          <h3 className="teams-chat__desk-h">This chat</h3>
          <p className="teams-chat__desk-thread-title">{activeConv?.title || 'Everyone'}</p>
          <p className="teams-chat__desk-kind">{deskMeta.kind}</p>
          <p className="teams-chat__desk-muted">{deskMeta.hint}</p>
          <dl className="teams-chat__desk-stats">
            <div className="teams-chat__desk-stat">
              <dt>Messages loaded</dt>
              <dd>{messages.length}</dd>
            </div>
            {messages.length > 0 ? (
              <div className="teams-chat__desk-stat">
                <dt>Latest activity</dt>
                <dd>
                  <time dateTime={messages[messages.length - 1]?.createdAt || undefined}>
                    {formatTime(messages[messages.length - 1]?.createdAt)}
                  </time>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        <div className="teams-chat__desk-card">
          <h3 className="teams-chat__desk-h">Tips</h3>
          <ul className="teams-chat__desk-tips">
            <li>
              <strong>Send</strong> — Enter sends the message.
            </li>
            <li>
              <strong>New line</strong> — Shift+Enter adds a line in the composer.
            </li>
            <li>
              <strong>Reply</strong> — Right‑click a message (or long‑press) to reply, copy, pin, or delete when allowed.
            </li>
            <li>
              <strong>Files</strong> — Use the clip to attach images or documents (size limits apply).
            </li>
          </ul>
        </div>

        {session && !chatOff ? (
          <div className="teams-chat__desk-card">
            <h3 className="teams-chat__desk-h">Quick emoji</h3>
            <p className="teams-chat__desk-muted teams-chat__desk-muted--tight">
              Tap to insert into the message box — you can edit before sending.
            </p>
            <div className="teams-chat__desk-emojis">
              {QUICK_EMOJI.map((emo) => (
                <button
                  key={emo}
                  type="button"
                  className="teams-chat__desk-emoji-btn"
                  title={`Insert ${emo}`}
                  aria-label={`Insert ${emo}`}
                  onClick={() => insertEmoji(emo)}
                >
                  <AppleEmoji
                    emoji={emo}
                    imgClassName="teams-chat__emoji-apple-img teams-chat__emoji-apple-img--desk"
                  />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="teams-chat__desk-card teams-chat__desk-card--dim">
            <p className="teams-chat__desk-signin-hint">
              Sign in and select a conversation to compose messages and use quick emoji inserts.
            </p>
          </div>
        )}
      </aside>
      ) : null}

      {membersModalOpen && activeConv?.type === 'group' ? (
        <div
          className="teams-chat__modal-backdrop"
          role="presentation"
          onClick={() => {
            setMembersModalOpen(false);
            setMemberModalSearch('');
            setMemberModalHits([]);
            setMemberListSearch('');
            setMemberListFilter('all');
          }}
        >
          <div
            className="teams-chat__modal teams-chat__modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="members-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="members-modal-title">{activeConv?.title || 'Group'} — members</h3>
            {membersLoading ? (
              <p className="teams-chat__hint">Loading…</p>
            ) : membersPayload ? (
              <>
                {membersPayload.isChatAdmin ? (
                  <div className="teams-chat__members-add-block">
                    <label htmlFor="member-modal-search" className="teams-chat__members-add-label">
                      Add people
                    </label>
                    <input
                      id="member-modal-search"
                      className="teams-chat__modal-input"
                      value={memberModalSearch}
                      onChange={(e) => setMemberModalSearch(e.target.value)}
                      placeholder="Search app + AD…"
                    />
                    {memberModalHits.length > 0 ? (
                      <ul className="teams-chat__search-results teams-chat__search-results--modal">
                        {memberModalHits
                          .filter(
                            (h) =>
                              !(membersPayload.members || []).some(
                                (mem) => normU(mem.username) === normU(h.username),
                              ),
                          )
                          .map((u) => (
                            <li key={`${u.source || 'app'}-${u.username}`}>
                              <button
                                type="button"
                                className="teams-chat__search-hit"
                                onClick={() => addMemberViaApi(u)}
                              >
                                <span className="teams-chat__search-hit-main">
                                  <span className="teams-chat__search-name">{u.displayName}</span>
                                  <span
                                    className={`teams-chat__source-tag${u.source === 'ad' ? ' teams-chat__source-tag--ad' : ''}`}
                                  >
                                    {u.source === 'ad' ? 'AD' : 'App'}
                                  </span>
                                </span>
                                <span className="teams-chat__search-user">{u.username}</span>
                              </button>
                            </li>
                          ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                <div className="teams-chat__members-toolbar">
                  <div className="teams-chat__members-summary">
                    <span>{modalMemberStats.total} members</span>
                    <span>{modalMemberStats.online} online</span>
                    <span>{modalMemberStats.admins} admins</span>
                  </div>
                  <div className="teams-chat__members-filters" role="tablist" aria-label="Filter members">
                    <button
                      type="button"
                      className={`teams-chat__members-filter-btn${
                        memberListFilter === 'all' ? ' teams-chat__members-filter-btn--active' : ''
                      }`}
                      onClick={() => setMemberListFilter('all')}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={`teams-chat__members-filter-btn${
                        memberListFilter === 'online' ? ' teams-chat__members-filter-btn--active' : ''
                      }`}
                      onClick={() => setMemberListFilter('online')}
                    >
                      Online
                    </button>
                    <button
                      type="button"
                      className={`teams-chat__members-filter-btn${
                        memberListFilter === 'admins' ? ' teams-chat__members-filter-btn--active' : ''
                      }`}
                      onClick={() => setMemberListFilter('admins')}
                    >
                      Admins
                    </button>
                  </div>
                  <input
                    className="teams-chat__modal-input"
                    value={memberListSearch}
                    onChange={(e) => setMemberListSearch(e.target.value)}
                    placeholder="Filter current members…"
                    aria-label="Filter current group members"
                  />
                </div>
                <ul className="teams-chat__members-list">
                  {modalMemberRows.map((m) => (
                    <li key={m.username} className="teams-chat__members-row">
                      <div>
                        <span className="teams-chat__members-name">{m.displayName || m.username}</span>
                        <span className="teams-chat__members-login">{m.username}</span>
                        <span className="teams-chat__members-presence">
                          <span
                            className={`teams-chat__presence-dot teams-chat__presence-dot--sm${
                              m.online ? ' teams-chat__presence-dot--on' : ' teams-chat__presence-dot--off'
                            }`}
                            aria-hidden
                          />
                          <span>{m.online ? 'Online' : `Last seen ${m.lastSeenLabel}`}</span>
                        </span>
                      </div>
                      <div className="teams-chat__members-row-actions">
                        {membersPayload.isChatAdmin ? (
                          <label className="teams-chat__admin-check">
                            <input
                              type="checkbox"
                              checked={adminDraft.some((p) => normU(p) === normU(m.username))}
                              onChange={() => toggleAdminDraft(m.username)}
                            />
                            <span>Admin</span>
                          </label>
                        ) : m.isChatAdmin ? (
                          <span className="teams-chat__badge-admin">Admin</span>
                        ) : null}
                        {membersPayload.isChatAdmin &&
                        normU(m.username) !== normU(session?.username) ? (
                          <button
                            type="button"
                            className="teams-chat__members-remove-btn"
                            onClick={() => removeMemberViaApi(m.username)}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {modalMemberRows.length === 0 ? (
                  <p className="teams-chat__members-help">No members match this filter.</p>
                ) : null}
                {membersPayload.isChatAdmin ? (
                  <div className="teams-chat__modal-actions teams-chat__modal-actions--start">
                    <button type="button" className="teams-chat__btn-primary" onClick={saveGroupAdmins}>
                      Save admins
                    </button>
                    <p className="teams-chat__members-help">
                      Group admins can delete the group or change who is an admin. At least one admin is required.
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="teams-chat__modal-actions">
              <button
                type="button"
                className="teams-chat__btn-secondary"
                onClick={() => {
                  setMembersModalOpen(false);
                  setMemberModalSearch('');
                  setMemberModalHits([]);
                  setMemberListSearch('');
                  setMemberListFilter('all');
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {groupOpen ? (
        <div className="teams-chat__modal-backdrop" role="presentation" onClick={() => setGroupOpen(false)}>
          <div
            className="teams-chat__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-chat-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="group-chat-title">New group chat</h3>
            <form onSubmit={createGroup}>
              <label htmlFor="group-title-input">Group name</label>
              <input
                id="group-title-input"
                className="teams-chat__modal-input"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                required
              />
              <label htmlFor="group-member-search">Add members</label>
              <input
                id="group-member-search"
                className="teams-chat__modal-input"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                placeholder="Search app + Active Directory…"
              />
              {groupHits.length > 0 ? (
                <ul className="teams-chat__search-results teams-chat__search-results--modal">
                  {groupHits.map((u) => (
                    <li key={`${u.source || 'app'}-${u.username}`}>
                      <button type="button" className="teams-chat__search-hit" onClick={() => addGroupMember(u)}>
                        <span className="teams-chat__search-hit-main">
                          <span className="teams-chat__search-name">{u.displayName}</span>
                          <span
                            className={`teams-chat__source-tag${u.source === 'ad' ? ' teams-chat__source-tag--ad' : ''}`}
                          >
                            {u.source === 'ad' ? 'AD' : 'App'}
                          </span>
                        </span>
                        <span className="teams-chat__search-user">{u.username}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="teams-chat__group-create-hint">
                You will be a member and admin. Others are <strong>members</strong> by default — check <strong>Admin</strong>{' '}
                for anyone who should manage the group.
              </p>
              {groupMembers.length > 0 ? (
                <ul className="teams-chat__member-chips teams-chat__member-chips--detailed">
                  {groupMembers.map((u) => (
                    <li key={u.username}>
                      <span className="teams-chat__member-chip-name">{u.displayName}</span>
                      <label className="teams-chat__member-chip-admin">
                        <input
                          type="checkbox"
                          checked={!!u.isGroupAdmin}
                          onChange={() => toggleGroupMemberAdmin(u.username)}
                        />
                        Admin
                      </label>
                      <button
                        type="button"
                        className="teams-chat__member-chip-remove"
                        onClick={() =>
                          setGroupMembers((prev) => prev.filter((x) => x.username !== u.username))
                        }
                      >
                        <ChatIconXPlain size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="teams-chat__modal-actions">
                <button type="button" className="teams-chat__btn-secondary" onClick={() => setGroupOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="teams-chat__btn-primary" disabled={!groupTitle.trim()}>
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {((msgContextMenu && ctxMessage && ctxMenuStyle) || (convContextMenu && ctxConv && convCtxMenuStyle)) ? (
        <>
          <div
            className="teams-chat__ctx-backdrop"
            role="presentation"
            aria-hidden="true"
            onClick={() => {
              closeMsgContextMenu();
              closeConvContextMenu();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMsgContextMenu();
              closeConvContextMenu();
            }}
          />
          {msgContextMenu && ctxMessage && ctxMenuStyle ? (
          <ul
            className="teams-chat__ctx-menu"
            role="menu"
            style={ctxMenuStyle}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {session ? (
              <li role="none">
                <button
                  type="button"
                  className="teams-chat__ctx-item"
                  role="menuitem"
                  onClick={() => {
                    closeMsgContextMenu();
                    setReplyTarget({
                      _id: ctxMessage._id,
                      text: ctxMessage.text || '',
                      fromDisplayName: ctxMessage.fromDisplayName || ctxMessage.fromUsername || 'User',
                      fromUsername: ctxMessage.fromUsername,
                    });
                    document.getElementById('teams-chat-input')?.focus();
                  }}
                >
                  Reply
                </button>
              </li>
            ) : null}
            {ctxMessage.text ? (
              <li role="none">
                <button
                  type="button"
                  className="teams-chat__ctx-item"
                  role="menuitem"
                  onClick={() => {
                    closeMsgContextMenu();
                    copyText(ctxMessage.text);
                  }}
                >
                  Copy
                </button>
              </li>
            ) : null}
            {ctxCanPin ? (
              <li role="none">
                <button
                  type="button"
                  className="teams-chat__ctx-item"
                  role="menuitem"
                  onClick={() => {
                    closeMsgContextMenu();
                    if (ctxIsPinned) updatePin(null);
                    else updatePin(ctxMessage._id);
                  }}
                >
                  {ctxIsPinned ? 'Unpin' : 'Pin'}
                </button>
              </li>
            ) : null}
            {ctxCanDelete ? (
              <li role="none">
                <button
                  type="button"
                  className="teams-chat__ctx-item teams-chat__ctx-item--danger"
                  role="menuitem"
                  onClick={() => {
                    closeMsgContextMenu();
                    removeMessage(ctxMessage._id);
                  }}
                >
                  Delete
                </button>
              </li>
            ) : null}
            {ctxIsSelf && session ? (
              <li role="none">
                <button
                  type="button"
                  className="teams-chat__ctx-item"
                  role="menuitem"
                  onClick={() => {
                    closeMsgContextMenu();
                    if (readReceiptPop && String(readReceiptPop.messageId) === String(ctxMessage._id)) {
                      setReadReceiptPop(null);
                    } else {
                      setReactPopover(null);
                      setReadReceiptPop({ messageId: ctxMessage._id });
                    }
                  }}
                >
                  {Array.isArray(ctxMessage.readBy) && ctxMessage.readBy.length > 0
                    ? `Seen by ${ctxMessage.readBy.length}`
                    : 'Who read this'}
                </button>
              </li>
            ) : null}
          </ul>
          ) : null}
          {convContextMenu && ctxConv && convCtxMenuStyle && session ? (
            <ul
              className="teams-chat__ctx-menu"
              role="menu"
              style={convCtxMenuStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Conversation actions"
            >
              {ctxConv.mutedUntil ? (
                <li role="none">
                  <button
                    type="button"
                    className="teams-chat__ctx-item"
                    role="menuitem"
                    onClick={async () => {
                      closeConvContextMenu();
                      await setChatMute(ctxConv.id, null).catch(() => {});
                      await fetchConversations();
                      notifyChatActivity();
                    }}
                  >
                    Unmute
                  </button>
                </li>
              ) : (
                MUTE_CHOICES.map(([value, label]) => (
                  <li role="none" key={value}>
                    <button
                      type="button"
                      className="teams-chat__ctx-item"
                      role="menuitem"
                      onClick={async () => {
                        closeConvContextMenu();
                        await setChatMute(ctxConv.id, value).catch(() => {});
                        await fetchConversations();
                        notifyChatActivity();
                      }}
                    >
                      {value === 'forever' ? 'Mute until I unmute' : `Mute ${label.toLowerCase()}`}
                    </button>
                  </li>
                ))
              )}
              {ctxConv.type !== 'global' ? (
                <li role="none">
                  <button
                    type="button"
                    className="teams-chat__ctx-item teams-chat__ctx-item--danger"
                    role="menuitem"
                    onClick={() => {
                      closeConvContextMenu();
                      leaveOrRemoveChat(ctxConv);
                    }}
                  >
                    {ctxConv.type === 'dm' ? 'Remove from your list' : 'Leave group'}
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : null}

    </div>
  );
}

export default TeamsChatPanel;
