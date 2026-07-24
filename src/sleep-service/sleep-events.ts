const MAX_EVENTS = 200;

export interface SleepServiceEvent {
  seq: number;
  at: number;
  event: { type: string; detail?: string };
}

export class SleepEventRing {
  private events: SleepServiceEvent[] = [];
  private nextSeq = 1;
  private terminal = false;
  private waiters: Array<(res: { events: SleepServiceEvent[]; nextSeq: number; terminal: boolean; gap: boolean }) => void> = [];

  push(type: string, detail?: string): void {
    if (this.terminal) return;
    const ev: SleepServiceEvent = { seq: this.nextSeq++, at: Date.now(), event: { type, detail } };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.wakeWaiters();
  }

  setTerminal(): void {
    this.terminal = true;
    this.wakeWaiters();
  }

  get isTerminal(): boolean { return this.terminal; }
  get lastSeq(): number { return this.nextSeq - 1; }

  readAfter(afterSeq: number, limit: number, waitMs: number): Promise<{ events: SleepServiceEvent[]; nextSeq: number; gap: boolean; terminal: boolean }> {
    const results = this.events.filter(e => e.seq > afterSeq);
    const gap = results.length > 0 && results[0]!.seq > afterSeq + 1;
    if (results.length > 0 || this.terminal) {
      const sliced = results.slice(0, limit);
      return Promise.resolve({
        events: sliced, nextSeq: this.nextSeq, gap: gap || afterSeq > 0 && results.length === 0,
        terminal: this.terminal,
      });
    }

    if (waitMs <= 0) {
      return Promise.resolve({ events: [], nextSeq: this.nextSeq, gap: false, terminal: this.terminal });
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        const later = this.events.filter(e => e.seq > afterSeq);
        resolve({
          events: later.slice(0, limit), nextSeq: this.nextSeq,
          gap: afterSeq > 0 && later.length > 0 && later[0]!.seq > afterSeq + 1,
          terminal: this.terminal,
        });
      }, waitMs);
      this.waiters.push((res: { events: SleepServiceEvent[]; nextSeq: number; terminal: boolean; gap: boolean }) => {
        clearTimeout(timer);
        resolve({ events: res.events.slice(0, limit), nextSeq: res.nextSeq, gap: res.gap, terminal: res.terminal });
      });
    });
  }

  private wakeWaiters(): void {
    const waiters = this.waiters.splice(0);
    const snapshot = [...this.events];
    const term = this.terminal;
    const nseq = this.nextSeq;
    for (const w of waiters) {
      try { w({ events: snapshot, nextSeq: nseq, terminal: term, gap: false }); } catch { /* best effort */ }
    }
  }
}
