// Stand-ins for Session.js and the SimpleX CLI, so the tests need neither network nor installs.

export class FakePoller {
  failing = false;
  polls = 0;
  async poll() {
    this.polls++;
    if (this.failing) throw new Error("Ran out of swarms for polling");
    return [];
  }
}

export class FakeSession {
  handlers: Record<string, ((m: unknown) => void)[]> = {};
  sent: any[] = [];
  failNext = 0;
  getSessionID() {
    return "05" + "a".repeat(64);
  }
  on(e: string, cb: (m: unknown) => void) {
    (this.handlers[e] ??= []).push(cb);
  }
  emit(e: string, m: unknown) {
    for (const h of this.handlers[e] ?? []) h(m);
  }
  async getFile(a: { name?: string }) {
    return new File([new Uint8Array([1, 2, 3])], a.name ?? "x.bin", { type: "application/octet-stream" });
  }
  async sendMessage(args: unknown) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("network down");
    }
    this.sent.push(args);
    return { messageHash: "h", syncMessageHash: "s", timestamp: Date.now() };
  }
}
