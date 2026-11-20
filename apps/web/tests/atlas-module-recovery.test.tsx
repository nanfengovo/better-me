import assert from "node:assert/strict";
import test, { after } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import ts from "typescript";
const dom = new Window();
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : next(url, context); } });
const React = await import("react");
Object.defineProperty(globalThis, "React", { configurable: true, value: React });
const { createRoot } = await import("react-dom/client");
const { RecoverableModule } = await import("../src/components/atlas/RecoverableModule");
after(() => { hooks.deregister(); void dom.happyDOM.abort(); Reflect.deleteProperty(globalThis, "React"); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("rejected map module stays isolated; explicit retry creates a fresh lazy loader and preserves other UI", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement, { onCaughtError() {} });
  let calls = 0, exits = 0;
  const load = async () => { if (++calls === 1) throw new Error("synthetic unavailable chunk"); return { default: ({ title }: { title: string }) => React.createElement("p", null, title) }; };
  const flush = async (action: () => void) => { await React.act(async () => { action(); for (let i = 0; i < 6; i++) await nextTurn(); }); };
  try {
    await flush(() => root.render(React.createElement("main", null, React.createElement("input", { defaultValue: "保留草稿" }), React.createElement(RecoverableModule, { load, componentProps: { title: "地图加载成功" }, label: "岗位地图", onExit: () => exits++ }))));
    assert.match(host.textContent!, /暂时无法打开/);
    await flush(() => [...host.querySelectorAll("button")].find(button => button.textContent === "返回机会列表")!.click());
    assert.equal(exits, 1);
    await flush(() => [...host.querySelectorAll("button")].find(button => button.textContent === "重新加载")!.click());
    assert.equal(calls, 2); assert.match(host.textContent!, /地图加载成功/);
    assert.equal(host.querySelector("input")!.value, "保留草稿");
    assert.equal(host.querySelector('[role="alert"]'), null);
  } finally { await flush(() => root.unmount()); host.remove(); }
});

function hasAtlasNavigationEffect(text: string) {
  const source = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") {
      const [callback, dependencies] = node.arguments;
      if (callback && ts.isArrowFunction(callback) && dependencies && ts.isArrayLiteralExpression(dependencies)
        && dependencies.elements.some(item => ts.isIdentifier(item) && item.text === "page")) {
        function inspect(child: ts.Node) {
          if (ts.isIfStatement(child) && ts.isBinaryExpression(child.expression)) {
            const condition = child.expression;
            const statement = child.thenStatement;
            if (ts.isIdentifier(condition.left) && condition.left.text === "page"
              && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
              && ts.isStringLiteral(condition.right) && condition.right.text === "atlas"
              && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
              && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === "setAtlasInitialized"
              && statement.expression.arguments.length === 1 && statement.expression.arguments[0].kind === ts.SyntaxKind.TrueKeyword) found = true;
          }
          ts.forEachChild(child, inspect);
        }
        inspect(callback.body);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

test("every page navigation initializes atlas and passes camera reset through to module recovery", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /const \{ page, setPage,[^\n]*\} = useWorkspaceNavigation\(\)/);
  // Inspect the wiring, not one-line formatting or an effect dedicated only to Atlas.
  assert.equal(hasAtlasNavigationEffect(app), true);
  assert.equal(hasAtlasNavigationEffect('useEffect(() => { if (page === "atlas") setAtlasInitialized(true); }, [page, agentMode]);'), true);
  assert.equal(hasAtlasNavigationEffect('useEffect(() => { if (page === "atlas") setAtlasInitialized(true); }, []);'), false);
  assert.equal(hasAtlasNavigationEffect('useEffect(() => { if (page === "atlas") setOtherInitialized(true); }, [page]);'), false);
  assert.match(app, /onOpenAtlas=\{\(\) => setPage\("atlas"\)\}/);
  const workspace = readFileSync(new URL("../src/components/AtlasWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<AtlasMap resetRevision=\{mapKey\}/);
  assert.match(workspace, /<RecoverableModule [^>]*resetRevision=\{props.resetRevision\}/);
});


test("camera reset retries a failed lazy module and preserves a healthy module", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement, { onCaughtError() {} });
  let calls = 0;
  const load = async () => {
    if (++calls === 1) throw new Error("synthetic unavailable chunk");
    return { default: () => React.createElement("input", { defaultValue: "当前地图配置" }) };
  };
  const render = async (resetRevision: number) => {
    await React.act(async () => {
      root.render(React.createElement(RecoverableModule, { load, componentProps: {}, label: "岗位地图", resetRevision }));
      for (let i = 0; i < 8; i++) await nextTurn();
    });
  };
  try {
    await render(0);
    assert.match(host.textContent!, /暂时无法打开/);
    await render(1);
    assert.equal(calls, 2);
    const input = host.querySelector("input")!;
    assert.ok(input);
    input.value = "用户当前输入";
    await render(2);
    assert.equal(calls, 2);
    assert.equal(host.querySelector("input"), input);
    assert.equal(input.value, "用户当前输入");
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
