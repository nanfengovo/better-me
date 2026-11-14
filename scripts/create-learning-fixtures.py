"""Original, non-personal learning acceptance PDFs. No third-party source text.

Run with BETTERME_FIXTURE_CJK_FONT pointing to the licensed font in the fixture README:
  uv run --with reportlab --with fonttools scripts/create-learning-fixtures.py
The checked-in PDFs are test assets, not user uploads or model output.
"""
from pathlib import Path
import hashlib
import os
from tempfile import TemporaryDirectory
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as PdfFont
from reportlab.lib.utils import ImageReader
from fontTools.ttLib import TTFont as FontFile
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "apps/agent-host/tests/fixtures/learning"
TARGET.mkdir(parents=True, exist_ok=True)
FONT_SHA256 = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
PAGES = [
    ("工具回执与断点恢复", [
        "这是一份 BetterMe 原创技术讲义，仅用于学习功能验收。",
        "学习目标：分清已完成、执行失败与结果未知三种状态。",
        "资料导入、原文朗读、把正文交给模型是三个独立动作。",
        "保存原答和提示记录，不能把练习通过当作生产工作经历。",
    ]),
    ("已有回执：先读取，再继续", [
        "工具结果、操作编号和完成状态应一起写入持久检查点。",
        "重新打开界面时，先只读恢复原记录，不自动执行任何工具。",
        "已有成功回执时，复用已保存结果，不再次调用相同工具。",
        "同一次尝试只查询选中的段落，不可以借资料编号读取整库。",
        "示例：操作编号 op-17 已成功，保存结果为 42 ms。",
        "预算上限是 32 次工具步骤；目标长期存在不意味着预算无限。",
    ]),
    ("缺少回执：结果未知，不直接重试", [
        "外部请求可能已经执行，但回执在断网或退出时丢失。",
        "缺少回执不等于执行失败，不能据此自动重复派送。",
        "先使用原操作编号查询或对账，无法核对就保留结果未知。",
        "恢复页面本身不授予执行许可；需要本人明确继续。",
        "否定词检查：不要重试，不等于永远禁止用户另行确认。",
        "公式样例：总步骤 = 已保存步骤 + 后续验证步骤。",
    ]),
]


def draw_page(pdf, title, lines, number):
    pdf.setFillColorRGB(0.13, 0.23, 0.19)
    pdf.setFont("LearningSans", 24)
    pdf.drawString(52, 770, title)
    pdf.setStrokeColorRGB(0.31, 0.52, 0.40)
    pdf.line(52, 748, 543, 748)
    pdf.setFont("LearningSans", 12)
    for index, line in enumerate(lines):
        pdf.drawString(52, 704 - index * 48, line)
    pdf.setFillColorRGB(0.42, 0.48, 0.44)
    pdf.setFont("LearningSans", 10)
    pdf.drawString(52, 42, "BetterMe 原创学习样本 - 不含个人资料")
    pdf.drawRightString(543, 42, f"{number} / 3")


def make(name, font_path, revision=False, mixed=False, columns=False):
    pdf = canvas.Canvas(str(TARGET / name), pagesize=(595, 842), invariant=1)
    pdf.setTitle("BetterMe - 工具回执与断点恢复")
    for number, (title, original_lines) in enumerate(PAGES, 1):
        lines = list(original_lines)
        if revision and number == 2:
            lines[2] = "修订：先校验回执的资料哈希，再复用已保存结果，不重复调用。"
        if mixed and number > 1:
            # A real image-only page: there is deliberately no hidden text layer.
            from PIL import Image, ImageDraw, ImageFont
            image = Image.new("RGB", (1190, 1684), "white")
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype(str(font_path), 25)
            draw.text((104, 100), title, font=font, fill="#203b30")
            for index, line in enumerate(lines):
                draw.text((104, 250 + index * 96), line, font=font, fill="#203b30")
            pdf.drawImage(ImageReader(image), 0, 0, width=595, height=842)
        elif columns and number == 2:
            pdf.setFont("LearningSans", 12)
            for index in range(6):
                pdf.drawString(52, 700 - index * 42, f"左栏 {index + 1}：成功回执不可重派。")
                pdf.drawString(325, 700 - index * 42, f"右栏 {index + 1}：未知结果先对账。")
        else:
            draw_page(pdf, title, lines, number)
        pdf.showPage()
    pdf.save()


def main():
    source = Path(os.environ.get("BETTERME_FIXTURE_CJK_FONT", ""))
    if not source.is_file():
        raise RuntimeError("Set BETTERME_FIXTURE_CJK_FONT to the local licensed CJK font; nothing is downloaded automatically.")
    if hashlib.sha256(source.read_bytes()).hexdigest() != FONT_SHA256:
        raise RuntimeError("The font differs from the pinned, licensed fixture source; see the fixture README.")
    with TemporaryDirectory(prefix="betterme-learning-font-") as directory:
        font = FontFile(source, recalcTimestamp=False)
        if "fvar" in font:
            font = instantiateVariableFont(font, {"wght": 400}, inplace=True)
        font.recalcTimestamp = False
        embedded = Path(directory) / "LearningSans-Regular.ttf"
        font.save(embedded)
        font.close()
        pdfmetrics.registerFont(PdfFont("LearningSans", str(embedded)))
        make("checkpoint-notes-v1.pdf", embedded)
        make("checkpoint-notes-v2.pdf", embedded, revision=True)
        make("checkpoint-notes-mixed.pdf", embedded, mixed=True)
        make("checkpoint-notes-columns.pdf", embedded, columns=True)
    print(TARGET)


if __name__ == "__main__":
    main()
