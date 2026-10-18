import assert from "node:assert/strict";
import test from "node:test";
import { nativeExitSnapshotAbsent, nativeExitSnapshotConfirmed } from "../server/jd-native-edge.ts";

const executable = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = "C:/owned-native-exit-profile";
const process = (pid: number, parent: number, created: string, command = "--type=utility") => ({ pid, parent, created, executable, command, window: 0 });
const root = process(100, 1, "2026-10-17T01:00:00.000Z", `--user-data-dir="${profile}"`);
const child = process(101, root.pid, "2026-10-17T01:00:01.000Z");
const baseline = { processes: [process(90, 1, "2026-10-17T00:00:00.000Z", "--user-data-dir=C:/personal-profile")], listeners: [] };
const proof = (processes: typeof root[], listeners: Array<{ pid: number; address: string }> = []) => nativeExitSnapshotConfirmed({ processes, listeners }, baseline, [root, child], root, executable, profile);

test("native exit proof requires a remembered exact root and no surviving remembered identity or debug listener", () => {
  assert.equal(proof([]), true);
  assert.equal(nativeExitSnapshotConfirmed({ processes: [], listeners: [] }, baseline, [], undefined, executable, profile), false);
  assert.equal(proof([root]), false); assert.equal(proof([child]), false);
  assert.equal(proof([], [{ pid: 999, address: "127.0.0.1" }]), false);
  assert.equal(proof([], [{ pid: root.pid, address: "::1" }]), false);
});

test("native exit proof rejects an unobserved child whose remembered parent exited between machine samples", () => {
  const orphan = process(102, root.pid, "2026-10-17T01:00:02.000Z");
  assert.equal(proof([orphan]), false);
  assert.equal(proof([process(103, child.pid, "2026-10-17T01:00:03.000Z")]), false);
  assert.equal(proof([orphan, ...baseline.processes]), false);
});

test("native exit proof rejects any new same-profile Edge process including a reparented utility or replacement root", () => {
  assert.equal(proof([process(200, 1, "2026-10-17T01:01:00.000Z", `--type=utility --user-data-dir="${profile}"`)]), false);
  assert.equal(proof([process(201, 1, "2026-10-17T01:01:00.000Z", `--user-data-dir="${profile}"`)]), false);
});

test("native exit proof tolerates unrelated baseline processes and PID reuse with a different exact creation identity", () => {
  assert.equal(proof([...baseline.processes]), true);
  assert.equal(proof([process(root.pid, 1, "2026-10-17T02:00:00.000Z", "--user-data-dir=C:/unrelated-profile")]), true);
  assert.equal(proof([process(300, 1, "2026-10-17T02:00:00.000Z", "--type=utility --user-data-dir=C:/unrelated-profile")]), true);
});

test("native exit proof remembers an orphan ancestry across samples without granting it exact ownership", () => {
  const suspected = new Map<string, typeof root>();
  const exactOwned = [root, child];
  const orphan = process(102, root.pid, "2026-10-17T01:00:02.000Z");
  const grandchild = process(103, orphan.pid, "2026-10-17T01:00:03.000Z");
  const check = (processes: typeof root[], listeners: Array<{ pid: number; address: string }> = []) => nativeExitSnapshotConfirmed({ processes, listeners }, baseline, exactOwned, root, executable, profile, suspected);
  assert.equal(check([orphan], [{ pid: root.pid, address: "127.0.0.1" }]), false);
  assert.equal(check([grandchild]), false);
  assert.deepEqual(exactOwned, [root, child], "suspected ancestry never mutates the kill-ownership set");
  assert.equal(check([]), true);
});

test("unknown-root startup samples retain a same-profile orphan and its later no-profile descendant", () => {
  const suspected = new Map<string, typeof root>();
  const orphan = process(102, 999, "2026-10-17T01:00:02.000Z", `--type=utility --user-data-dir="${profile}"`);
  const grandchild = process(103, orphan.pid, "2026-10-17T01:00:03.000Z");
  const unknown = (processes: typeof root[]) => nativeExitSnapshotConfirmed({ processes, listeners: [] }, baseline, [], undefined, executable, profile, suspected);
  assert.equal(unknown([orphan]), false); assert.equal(unknown([grandchild]), false);
  assert.equal(nativeExitSnapshotAbsent({ processes: [grandchild], listeners: [] }, baseline, [], undefined, executable, profile, suspected), false);
  assert.equal(nativeExitSnapshotAbsent({ processes: [], listeners: [] }, baseline, [], undefined, executable, profile, suspected), true);
  assert.equal(unknown([]), false, "automatic recovery still requires a remembered root");
});
