"""Render paper.md into a small, dependency-free PDF (1-2 pages).

The PDF is written by hand with plain PDF 1.4 objects, Helvetica base fonts and
an uncompressed content stream, so it is fully inspectable with a text editor
and readable by standard viewers:

    python make_paper_pdf.py
"""

import re

SOURCE_FILE = "paper.md"
OUTPUT_FILE = "paper.pdf"

PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN = 72
LINE_SIZES = {9: 96, 10: 88, 12: 80}
BASE_LEADING = 13.5


def wrap(text, width):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = word if current == "" else current + " " + word
        if len(candidate) <= width:
            current = candidate
        else:
            if current != "":
                lines.append(current)
            current = word
    if current != "":
        lines.append(current)
    return lines or [""]


def parse_markdown(source):
    """Turn the paper markdown into a flat list of layout items."""
    items = []
    in_table = False
    for raw_line in source.replace("\r\n", "\n").split("\n"):
        line = raw_line.rstrip()
        stripped = line.strip()
        if stripped == "":
            items.append({"kind": "gap", "gap": 5})
            in_table = False
            continue
        if stripped.startswith("# "):
            items.append({"kind": "title", "text": stripped[2:].strip()})
            continue
        if stripped.startswith("## "):
            items.append({"kind": "heading", "text": stripped[3:].strip()})
            continue
        if stripped.startswith("|"):
            separator = re.fullmatch(r"\|[\s:|-]+\|", stripped)
            if separator:
                continue
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            text = "   ".join(cells)
            items.append({"kind": "table", "text": text, "first": not in_table})
            in_table = True
            continue
        in_table = False
        items.append({"kind": "paragraph", "text": stripped})
    return items


def layout(items):
    """Split layout items into pages of (text, font, size, x, y) draw calls."""
    pages = []
    page = []
    y = PAGE_HEIGHT - MARGIN

    def push(text, font, size, x, line_y):
        page.append({"text": text, "font": font, "size": size, "x": x, "y": line_y})

    for item in items:
        kind = item["kind"]
        if kind == "gap":
            y -= item["gap"]
            continue
        if kind == "title":
            size, font = 17, "F2"
            text = item["text"]
            width = sum(0.52 * size if char != " " else 0.28 * size for char in text)
            lines = wrap(text, LINE_SIZES[12])
            for line in lines:
                if y - size < MARGIN:
                    pages.append(page)
                    page = []
                    y = PAGE_HEIGHT - MARGIN
                push(line, font, size, max(MARGIN, (PAGE_WIDTH - width) / 2.0), y - size)
                y -= size * 1.45
            y -= 6
            continue
        if kind == "heading":
            size, font = 12, "F2"
            y -= 10
            for line in wrap(item["text"], LINE_SIZES[size]):
                if y - size < MARGIN:
                    pages.append(page)
                    page = []
                    y = PAGE_HEIGHT - MARGIN
                push(line, font, size, MARGIN, y - size)
                y -= BASE_LEADING + 1
            continue
        if kind == "table":
            size, font = 9, "F1"
            if item.get("first"):
                y -= 2
            if y - size < MARGIN:
                pages.append(page)
                page = []
                y = PAGE_HEIGHT - MARGIN
            push(item["text"], font, size, MARGIN + 24, y - size)
            y -= 11.5
            continue
        size, font = 10, "F1"
        for line in wrap(item["text"], LINE_SIZES[size]):
            if y - size < MARGIN:
                pages.append(page)
                page = []
                y = PAGE_HEIGHT - MARGIN
            push(line, font, size, MARGIN, y - size)
            y -= BASE_LEADING
        y -= 2

    if page:
        pages.append(page)
    return pages


def escape_pdf_text(text):
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def content_stream(page):
    lines = []
    for call in page:
        lines.append(
            "BT /{font} {size:.1f} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm ({text}) Tj ET".format(
                font=call["font"],
                size=call["size"],
                x=call["x"],
                y=call["y"],
                text=escape_pdf_text(call["text"]),
            )
        )
    return "\n".join(lines) + "\n"


def build_pdf(pages):
    page_count = len(pages)
    bodies = {}
    bodies[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{6 + 2 * index} 0 R" for index in range(page_count))
    bodies[2] = ("<< /Type /Pages /Kids [" + kids + f"] /Count {page_count} >>").encode("latin-1")
    bodies[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    bodies[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
    bodies[5] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"

    for index, page in enumerate(pages):
        page_number = 6 + 2 * index
        content_number = 7 + 2 * index
        stream = content_stream(page).encode("latin-1")
        bodies[page_number] = (
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> "
            f"/Contents {content_number} 0 R >>"
        ).encode("latin-1")
        bodies[content_number] = b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream"

    maximum = 5 + 2 * page_count
    header = b"%PDF-1.4\n"
    chunks = [header]
    offsets = {}
    position = len(header)
    for number in range(1, maximum + 1):
        body = bodies[number]
        chunk = f"{number} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"
        offsets[number] = position
        chunks.append(chunk)
        position += len(chunk)

    xref_position = position
    xref = ["xref", f"0 {maximum + 1}", "0000000000 65535 f "]
    for number in range(1, maximum + 1):
        xref.append(f"{offsets[number]:010d} 00000 n ")
    trailer = [
        "trailer",
        f"<< /Size {maximum + 1} /Root 1 0 R >>",
        "startxref",
        str(xref_position),
        "%%EOF",
        "",
    ]
    chunks.append(("\n".join(xref) + "\n").encode("latin-1"))
    chunks.append("\n".join(trailer).encode("latin-1"))
    return b"".join(chunks), page_count


def main():
    with open(SOURCE_FILE, encoding="utf-8") as handle:
        source = handle.read()
    pages = layout(parse_markdown(source))
    pdf_bytes, page_count = build_pdf(pages)
    with open(OUTPUT_FILE, "wb") as handle:
        handle.write(pdf_bytes)
    print(f"wrote {OUTPUT_FILE} pages={page_count} bytes={len(pdf_bytes)}")


if __name__ == "__main__":
    main()
