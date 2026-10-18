import assert from "node:assert/strict";
import test from "node:test";
import { nativeReconnectSnapshotConfirmed } from "../server/jd-native-edge.ts";

const executable = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = "C:/owned native reconnect/profile";
const identity = {
  pid: 4100, parent: 4000, created: "2026-10-18T00:00:00.000Z", executable, window: 1,
  command: `"${executable}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=4111 --user-data-dir="${profile}" --proxy-server=http://127.0.0.1:17891 about:blank`,
};
const snapshot = () => ({ processes: [{ ...identity }], listeners: [{ pid: identity.pid, address: "127.0.0.1" }] });
const confirmed = (state: ReturnType<typeof snapshot>) => nativeReconnectSnapshotConfirmed(state, identity, executable, profile);

test("native reconnect accepts only the remembered root and loopback debugger listeners", () => {
  const state = snapshot();
  state.listeners.push({ pid: identity.pid, address: "::1" });
  state.processes.push({ ...identity, pid: 4101, parent: identity.pid, command: `${identity.command} --type=renderer` });
  assert.equal(confirmed(state), true);
});

test("native reconnect rejects PID reuse even when the executable and profile match", () => {
  const state = snapshot(); state.processes[0]!.created = "2026-10-18T00:01:00.000Z";
  assert.equal(confirmed(state), false);
});

test("native reconnect rejects an unexpected executable or changed startup command", () => {
  for (const patch of [{ executable: "C:/other/msedge.exe" }, { command: identity.command.replace("17891", "7890") }]) {
    const state = snapshot(); Object.assign(state.processes[0]!, patch);
    assert.equal(confirmed(state), false);
  }
});

test("native reconnect rejects a replaced profile owner", () => {
  const state = snapshot(); state.processes[0]!.pid = 4200; state.listeners[0]!.pid = 4200;
  assert.equal(confirmed(state), false);
});

test("native reconnect rejects ambiguous roots and never adopts a daily browser", () => {
  const state = snapshot(); state.processes.push({ ...identity, pid: 4200 });
  assert.equal(confirmed(state), false);
  state.processes = [{ ...identity, command: identity.command.replace(profile, "C:/daily/profile") }];
  assert.equal(confirmed(state), false);
});

test("native reconnect refuses missing roots and missing or foreign debugger listeners", () => {
  const absentRoot = snapshot(); absentRoot.processes = [];
  assert.equal(confirmed(absentRoot), false);
  const absentListener = snapshot(); absentListener.listeners = [];
  assert.equal(confirmed(absentListener), false);
  const foreign = snapshot(); foreign.listeners.push({ pid: 4200, address: "127.0.0.1" });
  assert.equal(confirmed(foreign), false);
});

test("native reconnect refuses wildcard and non-loopback debugger listeners", () => {
  for (const address of ["0.0.0.0", "::", "192.168.1.2"]) {
    const state = snapshot(); state.listeners[0]!.address = address;
    assert.equal(confirmed(state), false);
  }
});

test("native reconnect requires a valid remembered startup identity and absolute profile", () => {
  const state = snapshot();
  assert.equal(nativeReconnectSnapshotConfirmed(state, { ...identity, pid: 0 }, executable, profile), false);
  assert.equal(nativeReconnectSnapshotConfirmed(state, { ...identity, command: "" }, executable, profile), false);
  assert.equal(nativeReconnectSnapshotConfirmed(state, identity, executable, "relative/profile"), false);
});
