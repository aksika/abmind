export interface LocalPeerIdentity {
  pid: number;
  uid: number;
  username: string;
}

export interface LocalPeerIdentityProvider {
  getSelfIdentity(): Promise<LocalPeerIdentity>;
  getPeerIdentity(fd: number): Promise<LocalPeerIdentity | null>;
}

export class UnixPeerIdentityProvider implements LocalPeerIdentityProvider {
  async getSelfIdentity(): Promise<LocalPeerIdentity> {
    return {
      pid: process.pid,
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      username: process.env.USER ?? process.env.USERNAME ?? "unknown",
    };
  }

  async getPeerIdentity(_fd: number): Promise<LocalPeerIdentity | null> {
    return null;
  }
}

export function getSocketPeerIdentity(socket: import("node:net").Socket): { uid: number; pid: number } | null {
  try {
    const handle = (socket as unknown as { _handle?: { getPeerCredentials?: () => { uid: number; pid: number } } })._handle;
    if (handle && typeof handle.getPeerCredentials === "function") {
      return handle.getPeerCredentials();
    }
    return null;
  } catch {
    return null;
  }
}

export class InjectablePeerIdentityProvider implements LocalPeerIdentityProvider {
  private selfIdentity: LocalPeerIdentity;
  private peerResults: Map<number, LocalPeerIdentity | null> = new Map();

  constructor(selfIdentity: LocalPeerIdentity) {
    this.selfIdentity = selfIdentity;
  }

  setPeerResult(fd: number, identity: LocalPeerIdentity | null): void {
    this.peerResults.set(fd, identity);
  }

  async getSelfIdentity(): Promise<LocalPeerIdentity> {
    return this.selfIdentity;
  }

  async getPeerIdentity(fd: number): Promise<LocalPeerIdentity | null> {
    return this.peerResults.get(fd) ?? null;
  }
}
