import { useUiPreferences } from "../lib/ui-preferences";

// Reading material only: no resume props, model input, storage or apply action.
export function ResumeWritingExamples() {
  const { t } = useUiPreferences();
  const examples = [
    { title: "Henry Bettany", url: "https://henry-bettany.com/media/resume/henry-bettany-resume.pdf", note: t("本人公开的 .NET 简历：比较个人交付和协作的写法。", "A .NET engineer’s own CV: distinguish individual delivery from collaboration.") },
    { title: "The Pragmatic Engineer", url: "https://blog.pragmaticengineer.com/the-pragmatic-engineers-resume-template/", note: t("在职工程师模板：看经历、项目与贡献的顺序。", "Industry template: look at the order of roles, projects and contributions.") },
    { title: "Bill Ryan", url: "https://www.overleaf.com/latex/templates/bill-ryans-elegant-latex-resume/xcqmhktmzmsw.pdf", note: t("中文单页模板：看日期对齐和章节留白。", "One-page Chinese template: compare alignment, spacing and section hierarchy.") },
    { title: "Harvard · Tech", url: "https://cdn-careerservices.fas.harvard.edu/wp-content/uploads/sites/161/2026/07/Harvard-College-CS-Resume-Example.pdf#page=3", note: t("教学样例第 3 页：看 C#/.NET 如何对应到具体交付物。", "Teaching example, page 3: see how C#/.NET is tied to a deliverable.") },
  ];
  return <details className="writing-send-details writing-examples">
    <summary>{t("看参考写法", "See writing examples")}</summary>
    <p>{t("虚构练习：原句「负责数据校验，提升质量」。先问「校验什么？失败时发生什么？」。如果本人确认「我为导入表校验必填列，缺列时返回列名」，便可写成「为导入表校验必填列，缺列时返回列名。」没有测量，不补改善幅度。", "Fictional exercise: “Handled validation to improve quality.” Ask: what was validated, and what happened on failure? If the author confirms they checked required import columns and returned the missing names, use that behavior as the bullet. No measured change is needed.")}</p>
    <ul>{examples.map(example => <li key={example.url}>
      <a href={example.url} target="_blank" rel="noopener noreferrer">{example.title}</a>{" · "}{example.note}
    </li>)}</ul>
    <small>{t("这些例子只供阅读，不作为你的经历，也不会送入模型。", "These are reading examples, not your evidence. They are not sent to the model.")}</small>
  </details>;
}
