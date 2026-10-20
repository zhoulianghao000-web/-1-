"""Generate the two experiment figures as plain PNG files with only the Python
standard library (zlib + struct). No Pillow / matplotlib is required.

    python make_figures.py

The reported-metrics chart uses the headline numbers from the last report
draft; the confusion matrix is read from metrics.json.
"""

import json
import struct
import zlib

METRICS_FILE = "metrics.json"
CHART_FILE = "figures/metrics-chart.png"
CONFUSION_FILE = "figures/confusion.png"

# Headline numbers published in the report draft.
REPORTED = {"accuracy": 0.95, "precision": 0.94, "recall": 0.96, "f1": 0.95}

TITLE = (32, 32, 40)
INK = (54, 54, 64)
MUTED = (120, 120, 132)
GRID = (226, 226, 232)
AXIS = (150, 150, 162)
BACKGROUND = (250, 250, 252)
BAR_COLORS = [(59, 110, 165), (77, 159, 107), (196, 127, 0), (138, 90, 168)]
CELL_POSITIVE = (222, 240, 226)
CELL_NEGATIVE = (250, 228, 222)

# Minimal 5x7 bitmap font: every glyph is seven rows of five pixels.
FONT = {
    " ": ["00000"] * 7,
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "J": ["00001", "00001", "00001", "00001", "00001", "10001", "01110"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
    ",": ["00000", "00000", "00000", "00000", "00110", "00110", "01100"],
    ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
    "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
    "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
    "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
    ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
}


class Canvas:
    """Small RGB canvas with rectangle and bitmap-font drawing helpers."""

    def __init__(self, width, height, background=BACKGROUND):
        self.width = width
        self.height = height
        self.pixels = bytearray(bytes(background) * (width * height))

    def set_pixel(self, x, y, color):
        if 0 <= x < self.width and 0 <= y < self.height:
            offset = (y * self.width + x) * 3
            self.pixels[offset] = color[0]
            self.pixels[offset + 1] = color[1]
            self.pixels[offset + 2] = color[2]

    def fill_rect(self, x, y, width, height, color):
        for row in range(max(0, y), min(self.height, y + height)):
            offset = (row * self.width + max(0, x)) * 3
            for _column in range(max(0, x), min(self.width, x + width)):
                self.pixels[offset] = color[0]
                self.pixels[offset + 1] = color[1]
                self.pixels[offset + 2] = color[2]
                offset += 3

    def text_width(self, text, scale):
        return len(text) * 6 * scale - scale

    def draw_text(self, x, y, text, scale=2, color=INK):
        cursor = x
        for char in str(text).upper():
            glyph = FONT.get(char, FONT[" "])
            for row_index, row in enumerate(glyph):
                for column_index, bit in enumerate(row):
                    if bit != "1":
                        continue
                    self.fill_rect(
                        cursor + column_index * scale,
                        y + row_index * scale,
                        scale,
                        scale,
                        color,
                    )
            cursor += 6 * scale

    def save(self, path):
        raw = bytearray()
        for row in range(self.height):
            raw.append(0)
            raw.extend(self.pixels[row * self.width * 3:(row + 1) * self.width * 3])
        payload = zlib.compress(bytes(raw), 9)

        def chunk(tag, data):
            checksum = zlib.crc32(tag + data) & 0xFFFFFFFF
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", checksum)

        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", payload)
        png += chunk(b"IEND", b"")
        with open(path, "wb") as handle:
            handle.write(png)


def draw_metrics_chart(metrics):
    canvas = Canvas(960, 560)
    canvas.draw_text(60, 34, "REPORTED MODEL METRICS", scale=3, color=TITLE)

    left, top = 120, 140
    plot_width, plot_height = 760, 320
    bottom = top + plot_height

    # Horizontal grid lines and the 0.0-1.0 axis labels.
    for step in range(0, 6):
        value = step / 5.0
        y = bottom - int(value * plot_height)
        canvas.fill_rect(left, y, plot_width, 2, GRID)
        canvas.draw_text(left - 66, y - 7, f"{value:.1f}", scale=2, color=MUTED)
    canvas.fill_rect(left, bottom, plot_width, 2, AXIS)
    canvas.fill_rect(left, top, 2, plot_height, AXIS)

    entries = [
        ("ACCURACY", metrics["accuracy"]),
        ("PRECISION", metrics["precision"]),
        ("RECALL", metrics["recall"]),
        ("F1", metrics["f1"]),
    ]
    bar_width = 128
    gap = 57
    for index, (label, value) in enumerate(entries):
        x = left + 36 + index * (bar_width + gap)
        height = max(2, int(round(value * plot_height)))
        y = bottom - height
        canvas.fill_rect(x, y, bar_width, height, BAR_COLORS[index])
        canvas.draw_text(x + 8, y - 30, f"{value:.2f}", scale=3, color=BAR_COLORS[index])
        canvas.draw_text(x + 4, bottom + 18, label, scale=2, color=INK)

    canvas.draw_text(left, 522, "SOURCE: REPORT DRAFT TABLE 1", scale=1, color=MUTED)
    canvas.save(CHART_FILE)


def draw_confusion_chart(metrics):
    confusion = metrics["confusion"]
    canvas = Canvas(760, 560)
    canvas.draw_text(60, 34, "CONFUSION MATRIX", scale=3, color=TITLE)
    canvas.draw_text(60, 78, "CHURN MODEL - TEST SPLIT", scale=2, color=MUTED)

    cell_width, cell_height = 220, 150
    origin_x, origin_y = 200, 150
    canvas.draw_text(origin_x + 20, origin_y - 32, "PREDICTED NEG", scale=2, color=INK)
    canvas.draw_text(origin_x + cell_width + 20, origin_y - 32, "PREDICTED POS", scale=2, color=INK)
    canvas.draw_text(34, origin_y + 40, "ACTUAL", scale=2, color=INK)
    canvas.draw_text(34, origin_y + 64, "NEG", scale=2, color=INK)
    canvas.draw_text(34, origin_y + cell_height + 40, "ACTUAL", scale=2, color=INK)
    canvas.draw_text(34, origin_y + cell_height + 64, "POS", scale=2, color=INK)

    cells = [
        ("TN", confusion["tn"], CELL_POSITIVE, (28, 92, 44)),
        ("FP", confusion["fp"], CELL_NEGATIVE, (150, 48, 36)),
        ("FN", confusion["fn"], CELL_NEGATIVE, (150, 48, 36)),
        ("TP", confusion["tp"], CELL_POSITIVE, (28, 92, 44)),
    ]
    for index, (label, value, background, ink) in enumerate(cells):
        row, column = divmod(index, 2)
        x = origin_x + column * cell_width
        y = origin_y + row * cell_height
        canvas.fill_rect(x, y, cell_width - 4, cell_height - 4, background)
        number = str(value)
        canvas.draw_text(x + (cell_width - 4 - canvas.text_width(number, 5)) // 2, y + 28, number, scale=5, color=ink)
        canvas.draw_text(x + (cell_width - 4 - canvas.text_width(label, 2)) // 2, y + 100, label, scale=2, color=MUTED)

    canvas.draw_text(origin_x, origin_y + 2 * cell_height + 26, f"N TEST = {metrics['n_test']}", scale=2, color=MUTED)
    canvas.draw_text(origin_x, origin_y + 2 * cell_height + 54, "FROM METRICS.JSON", scale=1, color=MUTED)
    canvas.save(CONFUSION_FILE)


def main():
    with open(METRICS_FILE, encoding="utf-8") as handle:
        metrics = json.load(handle)
    draw_metrics_chart(REPORTED)
    draw_confusion_chart(metrics)
    print(f"wrote {CHART_FILE} and {CONFUSION_FILE}")


if __name__ == "__main__":
    main()
