import fs from "node:fs";
import { paths } from "./config.ts";
import { log, errMsg } from "./log.ts";

export type SessionContact = {
  alias: string;
  displayName?: string;
  firstSeen: number;
  lastSeen: number;
};

/** What a forwarded SimpleX message points back to, so quoting it replies to the right person. */
export type Ref = {
  sessionId: string;
  groupId?: string;
  timestamp: number;
  text?: string;
};

export type SerializedAttachment = {
  id: string;
  name?: string;
  size?: number;
  caption?: string;
  contentType?: string;
  width?: number;
  height?: number;
  key?: string; // base64
  digest?: string; // base64
};

/** A Session message waiting to be forwarded to SimpleX. */
export type InboundItem = {
  hash: string;
  from: string;
  groupId?: string;
  displayName?: string;
  timestamp: number;
  text?: string;
  quoteText?: string;
  attachments: SerializedAttachment[];
  downloaded?: { path: string; name: string }[];
  failedAttachments?: number;
  tries: number;
  receivedAt: number;
  newContact?: boolean;
};

/** A reply from SimpleX waiting to be sent to Session. */
export type OutboundItem = {
  id: string;
  ownerItemId: number;
  to: string;
  text?: string;
  files: { path: string; name: string; contentType: string }[];
  voice?: boolean;
  quote?: { timestamp: number; author: string; text?: string };
  createdAt: number;
  tries: number;
  nextAt: number;
};

/** A file the owner sent in SimpleX that is still being downloaded by the CLI. */
export type PendingOwnerFile = {
  ownerItemId: number;
  to: string;
  text?: string;
  msgType: string;
  fileName: string;
  quote?: OutboundItem["quote"];
  requestedAt: number;
};

export type State = {
  version: 1;
  /** Key/value storage used internally by Session.js (keys, last poll hashes, seen-message hashes). */
  sessionjs: Record<string, string>;
  /** Name shown to Session contacts (optional). */
  sessionDisplayName?: string;
  owner?: { contactId: number; pairedAt: number };
  invitation?: { link: string; connId: number; agentConnId: string; createdAt: number };
  contacts: Record<string, SessionContact>;
  active?: string;
  refs: Record<string, Ref>;
  toSimplex: InboundItem[];
  toSession: OutboundItem[];
  pendingOwnerFiles: Record<string, PendingOwnerFile>;
  sentFiles: Record<string, string>;
};

const MAX_REFS = 3000;
const SEEN_HASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Session keeps messages ~14 days

function emptyState(): State {
  return {
    version: 1,
    sessionjs: {},
    contacts: {},
    refs: {},
    toSimplex: [],
    toSession: [],
    pendingOwnerFiles: {},
    sentFiles: {},
  };
}

class Store {
  state: State = emptyState();
  private timer: ReturnType<typeof setTimeout> | undefined;

  load() {
    if (fs.existsSync(paths.state)) {
      try {
        this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(paths.state, "utf8")) };
      } catch (e) {
        // Never silently start fresh: that would re-pair and lose the queue.
        throw new Error(`Cannot read ${paths.state}: ${errMsg(e)}`);
      }
    }
    this.pruneSeenHashes();
  }

  /** Schedule a write. Writes are debounced and atomic (tmp file + rename). */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 250);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      const tmp = paths.state + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, paths.state);
    } catch (e) {
      log.error("Could not save state:", errMsg(e));
    }
  }

  addRef(itemId: number, ref: Ref) {
    this.state.refs[String(itemId)] = ref;
    const keys = Object.keys(this.state.refs); // integer keys iterate in ascending order
    if (keys.length > MAX_REFS) {
      for (const k of keys.slice(0, keys.length - MAX_REFS)) delete this.state.refs[k];
    }
    this.save();
  }

  /** Session.js remembers every message hash it has seen; drop ones older than Session's own retention. */
  private pruneSeenHashes() {
    const cutoff = Date.now() - SEEN_HASH_TTL_MS;
    for (const [k, v] of Object.entries(this.state.sessionjs)) {
      if (k.startsWith("message_hash:") && Number(v) < cutoff) delete this.state.sessionjs[k];
    }
  }
}

export const store = new Store();

/** Storage adapter for Session.js, persisted inside state.json. */
export const sessionStorage = {
  get(key: string) {
    return store.state.sessionjs[key] ?? null;
  },
  set(key: string, value: string) {
    if (store.state.sessionjs[key] === value) return;
    store.state.sessionjs[key] = value;
    store.save();
  },
  delete(key: string) {
    delete store.state.sessionjs[key];
    store.save();
  },
  has(key: string) {
    return key in store.state.sessionjs;
  },
};
