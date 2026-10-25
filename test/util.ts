let failures = 0;

export function ok(cond: unknown, msg: string) {
  console.log(cond ? "PASS" : "FAIL", msg);
  if (!cond) {
    failures++;
    process.exitCode = 1;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function done() {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
