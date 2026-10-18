import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_THEMES, getWorkspaceTheme, parseWorkspaceTheme, workspaceThemeVariables } from "../src/themes/workspace-theme.ts";

function luminance(hex: string) {
  const channels = [1, 3, 5].map(start => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + .05) / (values[1]! + .05);
}

test("all four workspace palettes have readable light and dark surfaces", () => {
  assert.deepEqual(WORKSPACE_THEMES.map(theme => theme.id), ["atelier", "navy", "plum", "graphite"]);
  for (const theme of WORKSPACE_THEMES) {
    for (const mode of ["light", "dark"] as const) {
      const colors = theme[mode];
      for (const [foreground, background] of [["text", "surface"], ["textSecondary", "surface"], ["onAction", "action"], ["railText", "rail"]] as const) {
        assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${theme.id}/${mode}: ${foreground}/${background}`);
      }
      assert.ok(contrast(colors.textMuted, colors.surface) >= 3, `${theme.id}/${mode}: muted text`);
      assert.ok(contrast(colors.accent, colors.accentSoft) >= 4.5, `${theme.id}/${mode}: selected label`);
      for (const semantic of ["warning", "danger", "info"] as const) {
        assert.ok(contrast(colors[semantic], colors[`${semantic}Soft`]) >= 4.5, `${theme.id}/${mode}: ${semantic}`);
      }
    }
  }
});

test("workspace theme validation rejects unsupported versions and executable CSS values", () => {
  const theme = getWorkspaceTheme("navy");
  for (const invalid of [null, [], { ...theme, schemaVersion: 2 }, { ...theme, id: "unknown" }, { ...theme, css: "body{}" },
    { ...theme, light: { ...theme.light, action: "url(https://invalid.test/style)" } },
    { ...theme, light: { ...theme.light, action: "#fff; color:red" } },
    { ...theme, dark: { ...theme.dark, fontFamily: "injected" } },
    { ...theme, name: { zh: "", en: "Navy" } },
  ]) assert.throws(() => parseWorkspaceTheme(invalid));
  assert.equal(getWorkspaceTheme("unknown").id, "atelier");
});

test("CSS resolver produces only workspace variables and copies parsed theme data", () => {
  const theme = getWorkspaceTheme("plum");
  const copy = { ...theme, light: { ...theme.light }, dark: { ...theme.dark } };
  const parsed = parseWorkspaceTheme(copy);
  copy.light.action = "#000000";
  assert.equal(parsed.light.action, "#744381");
  const variables = workspaceThemeVariables("plum", "dark");
  assert.equal(variables["--workspace-action"], "#81518f");
  assert.equal(variables["--workspace-preview-canvas"], "#1e1725");
  assert.ok(Object.keys(variables).every(name => name.startsWith("--workspace-")));
  assert.ok(!Object.keys(variables).some(name => name.includes("resume") || name.includes("font") || name.includes("margin")));
});
