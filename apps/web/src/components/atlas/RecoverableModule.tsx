import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import "./module-recovery.css";
import { useUiPreferences, type UiTranslator } from "../../lib/ui-preferences";

class ModuleBoundary extends Component<{ children: ReactNode; label: string; retry: () => void; onExit?: () => void; t: UiTranslator; resetRevision?: number }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (this.state.failed && previous.resetRevision !== this.props.resetRevision) this.props.retry();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { t, label } = this.props;
    return <section className="atlas-module-state" role="alert">
      <strong>{t(`${label}暂时无法打开`, `${label} could not be opened`)}</strong>
      <p>{t("资源加载或运行异常。可以重试；不会清除已保存的资料。", "A resource failed to load or run. You can retry without clearing saved data.")}</p>
      <div><button type="button" onClick={this.props.retry}>{t("重新加载", "Reload")}</button>{this.props.onExit && <button type="button" onClick={this.props.onExit}>{t("返回机会列表", "Back to opportunities")}</button>}</div>
    </section>;
  }
}

export function RecoverableModule<P extends object>({ load, componentProps, label, onExit, resetRevision }: {
  load: () => Promise<{ default: ComponentType<P> }>; componentProps: P; label: string; onExit?: () => void; loadingHint?: string; resetRevision?: number;
}) {
  const { t } = useUiPreferences();
  const [Loaded, setLoaded] = useState(() => lazy(load));
  const [attempt, setAttempt] = useState(0);
  function retry() {
    // React.lazy caches rejected imports; a new lazy instance is needed for an explicit retry.
    setLoaded(() => lazy(load));
    setAttempt(value => value + 1);
  }
  return <ModuleBoundary key={attempt} label={label} retry={retry} onExit={onExit} t={t} resetRevision={resetRevision}>
    <Suspense fallback={null}>
      <Loaded {...componentProps} />
    </Suspense>
  </ModuleBoundary>;
}
