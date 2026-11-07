import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import "./module-recovery.css";

class ModuleBoundary extends Component<{ children: ReactNode; label: string; retry: () => void; onExit?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="atlas-module-state" role="alert">
      <strong>{this.props.label}暂时无法打开</strong>
      <p>资源加载或运行异常。可以重试，其他工作区仍可使用；不会清除已保存的资料。</p>
      <div><button type="button" onClick={this.props.retry}>重新加载</button>{this.props.onExit && <button type="button" onClick={this.props.onExit}>返回机会列表</button>}</div>
    </section>;
  }
}

export function RecoverableModule<P extends object>({ load, componentProps, label, onExit }: {
  load: () => Promise<{ default: ComponentType<P> }>; componentProps: P; label: string; onExit?: () => void;
}) {
  const [Loaded, setLoaded] = useState(() => lazy(load));
  const [attempt, setAttempt] = useState(0);
  function retry() {
    // React.lazy caches rejected imports; a new lazy instance is needed for an explicit retry.
    setLoaded(() => lazy(load));
    setAttempt(value => value + 1);
  }
  return <ModuleBoundary key={attempt} label={label} retry={retry} onExit={onExit}>
    <Suspense fallback={<section className="atlas-module-state" role="status" aria-live="polite"><strong>正在打开{label}…</strong><p>首次加载需要准备地图资源。</p>{onExit && <button type="button" onClick={onExit}>先浏览机会列表</button>}</section>}>
      <Loaded {...componentProps} />
    </Suspense>
  </ModuleBoundary>;
}
