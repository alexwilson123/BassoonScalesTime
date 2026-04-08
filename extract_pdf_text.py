from __future__ import annotations

import re
from pathlib import Path

import fitz


PDF_PATH = Path("Adobe Scan 4 Apr 2026.pdf")
OUTPUT_PATH = Path("data.txt")


def normalize_text(text: str) -> str:
    text = text.replace("\r", "\n")
    text = text.replace("\u00a0", " ")
    text = text.replace("\uf0d8", "►")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main() -> None:
    doc = fitz.open(PDF_PATH)
    sections: list[str] = [
        f"Source PDF: {PDF_PATH.name}",
        f"Pages: {doc.page_count}",
        "",
    ]

    for page_index in range(doc.page_count):
        page = doc.load_page(page_index)
        text = normalize_text(page.get_text("text"))
        sections.append(f"=== PAGE {page_index + 1} ===")
        sections.append(text or "[No extractable text found on this page]")
        sections.append("")

    OUTPUT_PATH.write_text("\n".join(sections), encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH} from {doc.page_count} pages")


if __name__ == "__main__":
    main()
