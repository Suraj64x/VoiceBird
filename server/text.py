"""Script text -> speakable chunks."""
import re

# sentence end = . ! ? ... (plus closing quotes/brackets) followed by space + a new sentence start
_END = re.compile(r"""([.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])""")
_ABBR = re.compile(r"(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Fig|approx|Inc|Ltd|Co)|\be\.g|\bi\.e|\bU\.S|\bU\.K)\.$")
_SOFT = re.compile(r"(?<=[,;:])\s+")

_REPLACE = [
    (re.compile(r"[“”]"), '"'), (re.compile(r"[‘’]"), "'"),
    (re.compile(r"(?<=\d)\s*[–-]\s*(?=\d)"), " to "),  # 5–10 -> 5 to 10
    (re.compile(r"\s+[—–]\s+|\s*—\s*"), ", "), (re.compile(r"…"), "..."),
    (re.compile(r"\*\*|__|`+|^#{1,6}\s+", re.M), ""),  # markdown leftovers only (keeps C#, #1, snake_case)
    (re.compile(r"\s*&\s*"), " and "), (re.compile(r"(?<=\d)%"), " percent"),
    (re.compile(r"[ \t\u00a0]+"), " "), (re.compile(r" *\n[\s]*"), "\n"),
]


def normalise(text: str) -> str:
    for rx, to in _REPLACE:
        text = rx.sub(to, text)
    return text.strip()


def sentences(paragraph: str) -> list[str]:
    out: list[str] = []
    for line in normalise(paragraph).split("\n"):  # a line break (heading, list item) always ends a sentence
        start = len(out)
        for s in _END.sub(r"\1" + "\n", line).split("\n"):
            if len(out) > start and _ABBR.search(out[-1]):  # "Dr." / "e.g." did not end the sentence
                out[-1] += " " + s
            elif s.strip():
                out.append(s.strip())
    return out


def _split_long(s: str, limit: int) -> list[str]:
    """Break an over-long sentence at commas, then at spaces."""
    if len(s) <= limit:
        return [s]
    out, cur = [], ""
    for part in _SOFT.split(s):
        for w in (part.split(" ") if len(part) > limit else [part]):  # no commas to use: wrap on words
            if cur and len(cur) + len(w) + 1 > limit:
                out.append(cur)
                cur = ""
            cur = f"{cur} {w}".strip()
    if cur:
        out.append(cur)
    return out


def chunks(paragraph: str, limit: int = 260, merge_under: int = 0) -> list[str]:
    """Sentences of a paragraph, each <= limit chars. Sentences shorter than `merge_under`
    are glued to a neighbour (very short inputs make most TTS models unstable)."""
    out: list[str] = []
    for s in sentences(paragraph):
        for piece in _split_long(s, limit):
            if out and (len(piece) < merge_under or len(out[-1]) < merge_under) and len(out[-1]) + len(piece) + 1 <= limit:
                out[-1] = f"{out[-1]} {piece}"
            else:
                out.append(piece)
    return out


if __name__ == "__main__":  # self-check: python -m server.text
    p = 'Dr. Smith paid $3.50 for it. "Really?" she asked. Yes! It works — every time… And e.g. this stays whole. He said "Go." Then left.'
    s = sentences(p)
    assert s == ["Dr. Smith paid $3.50 for it.", '"Really?" she asked.', "Yes!", "It works, every time...", "And e.g. this stays whole.", 'He said "Go."', "Then left."], s
    long = ("word " * 120).strip() + "."
    c = chunks(long, limit=100)
    assert all(len(x) <= 100 for x in c) and " ".join(c) == long, c
    assert chunks("Hi. Yes! This is a longer sentence here.", limit=200, merge_under=12) == ["Hi. Yes! This is a longer sentence here."]
    assert chunks("A, b, c, " + "x" * 30 + ", " + "y" * 30, limit=40) == ["A, b, c, " + "x" * 30 + ",", "y" * 30]
    assert normalise("Tom & Jerry got 50% **bold**") == "Tom and Jerry got 50 percent bold"
    assert normalise("C# and #1 tool, snake_case, 5–10 min") == "C# and #1 tool, snake_case, 5 to 10 min"
    assert sentences("Top tools\n- Free forever\nNo ads") == ["Top tools", "- Free forever", "No ads"]
    print("text.py ok")
