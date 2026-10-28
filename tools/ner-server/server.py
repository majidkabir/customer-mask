#!/usr/bin/env python3
"""A local NER server for customer-mask.

customer-mask (with "detection": "ner" or "both") sends the text it is about to
mask here and masks the names this server finds. Run it on the developer's
machine, or on one machine in your network; text sent here never goes further.

    python3 tools/ner-server/server.py                      # GLiNER (default)
    python3 tools/ner-server/server.py --backend spacy      # spaCy, smaller and faster

API (JSON):
    GET  /health  -> {"ok": true, "backend": ..., "model": ...}
    POST /detect  {"texts": [...], "labels": ["company", "person"], "threshold": 0.5}
                  -> {"results": [[{"text", "label", "start", "end", "score"?}, ...], ...]}
                  one list per text, in order; "label" is one of the labels asked for.

Nothing is logged: not the texts, not what was found.
"""

import argparse
import heapq
import itertools
import json
import os
import re
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 16 * 1024 * 1024
BATCH = 16  # pieces per model call; between calls a smaller waiting request goes first
CACHE_SIZE = 50000  # pieces whose results are kept


LINE_NUMBER = re.compile(r"[ \t]*\d+\t")


def lines(text):
    """Each non-empty line of the text with its offset, without a leading line
    number such as the Read tool adds ("  12<tab>"). Models find names in a
    table row or a log line better on their own than inside a block of them."""
    offset = 0
    for line in text.splitlines(keepends=True):
        m = LINE_NUMBER.match(line)
        skip = m.end() if m else 0
        body = line[skip:].rstrip("\r\n")
        if body.strip():
            yield offset + skip, body
        offset += len(line)


def chunks(text, size):
    """Splits text into pieces of at most `size` characters, at a line break or
    space where there is one, with each piece's offset in the text."""
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            cut = max(text.rfind("\n", start, end), text.rfind(" ", start, end))
            if cut > start + size // 2:
                end = cut + 1
        yield start, text[start:end]
        start = end


class Gliner:
    """GLiNER: finds whatever labels it is asked for ("company", "person",
    "street address", ...), no training needed. Needs
    `pip install gliner protobuf sentencepiece` (gliner brings PyTorch; the
    PII model's tokenizer needs the other two); the model is downloaded from
    Hugging Face once."""

    name = "gliner"

    def __init__(self, model):
        from gliner import GLiNER

        self.model_name = model or "urchade/gliner_multi_pii-v1"
        self.model = GLiNER.from_pretrained(self.model_name)
        # GLiNER reads up to about 384 words at a time; longer text is split.
        self.size = 1200

    def predict(self, parts, labels, threshold):
        """Entities per piece, with offsets in the piece."""
        run = getattr(self.model, "inference", None) or getattr(self.model, "batch_predict_entities", None)
        found = run(parts, labels, threshold=threshold) if run else [
            self.model.predict_entities(p, labels, threshold=threshold) for p in parts
        ]
        return [[{"text": e["text"], "label": e["label"], "start": e["start"], "end": e["end"],
                  "score": round(float(e["score"]), 3)} for e in ents] for ents in found]


# What spaCy's fixed entity types mean in the labels customer-mask asks for.
SPACY_TYPES = {
    "company": {"ORG"}, "organization": {"ORG"}, "organisation": {"ORG"}, "customer": {"ORG"},
    "person": {"PERSON", "PER"}, "name": {"PERSON", "PER"},
    "location": {"GPE", "LOC"}, "city": {"GPE"}, "country": {"GPE"}, "place": {"GPE", "LOC", "FAC"},
    "address": {"FAC", "LOC"},
}


class Spacy:
    """spaCy: a fixed set of entity types (organizations, people, places), very
    fast on a CPU. Needs `pip install spacy` and a model, e.g. en_core_web_lg
    (English, the default; the small en_core_web_sm misses more names) or
    da_core_news_lg (Danish). Has no confidence score."""

    name = "spacy"

    def __init__(self, model):
        import spacy

        self.model_name = model or "en_core_web_lg"
        self.nlp = spacy.load(self.model_name, exclude=["tagger", "parser", "lemmatizer", "attribute_ruler", "morphologizer"])
        self.size = 100_000

    def predict(self, parts, labels, threshold):
        """Entities per piece, with offsets in the piece."""
        wanted = {label: SPACY_TYPES.get(label.lower(), set()) for label in labels}
        out = []
        for doc in self.nlp.pipe(parts, batch_size=256):
            found = []
            for ent in doc.ents:
                for label, types in wanted.items():
                    if ent.label_ in types:
                        found.append({"text": ent.text, "label": label, "start": ent.start_char, "end": ent.end_char})
                        break
            out.append(found)
        return out


class Gate:
    """One model call at a time (models are not all thread-safe). Of the
    requests waiting, the one with the fewest pieces left goes next, so a
    prompt isn't stuck behind a long file."""

    def __init__(self):
        self.cond = threading.Condition()
        self.busy = False
        self.waiting = []
        self.seq = itertools.count()

    def run(self, size, fn):
        key = (size, next(self.seq))
        with self.cond:
            heapq.heappush(self.waiting, key)
            while self.busy or self.waiting[0] != key:
                self.cond.wait()
            heapq.heappop(self.waiting)
            self.busy = True
        try:
            return fn()
        finally:
            with self.cond:
                self.busy = False
                self.cond.notify_all()


class Detector:
    """Splits texts into pieces (lines, long ones cut), answers pieces it has
    seen before from a cache (Claude Code sends the same system prompt and
    reminders every turn), and runs the rest through the backend a batch at a
    time."""

    def __init__(self, backend):
        self.backend = backend
        self.name = backend.name
        self.model_name = backend.model_name
        self.gate = Gate()
        self.cache = {}
        self.cache_lock = threading.Lock()

    def detect(self, texts, labels, threshold):
        pieces = [
            (i, off + o, part)
            for i, t in enumerate(texts)
            for off, line in lines(t)
            for o, part in chunks(line, self.backend.size)
        ]
        key = (tuple(labels), threshold)
        with self.cache_lock:
            found = {p: self.cache.get((key, p)) for _, _, p in pieces}
        todo = list(dict.fromkeys(p for p, ents in found.items() if ents is None))
        for n in range(0, len(todo), BATCH):
            batch = todo[n:n + BATCH]
            ents = self.gate.run(len(todo) - n, lambda: self.backend.predict(batch, labels, threshold))
            with self.cache_lock:
                for p, e in zip(batch, ents):
                    found[p] = e
                    if len(self.cache) >= CACHE_SIZE:
                        self.cache.pop(next(iter(self.cache)))
                    self.cache[(key, p)] = e
        results = [[] for _ in texts]
        for i, off, p in pieces:
            for e in found[p]:
                results[i].append({**e, "start": e["start"] + off, "end": e["end"] + off})
        return results


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR would let a second server take the same port.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        # HTTPServer looks up the host's name (socket.getfqdn), which can take
        # 30 s or more on some Macs.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[0], self.server_address[1]


def make_handler(backend):

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # never log what was sent
            pass

        def answer(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self.answer(200, {"ok": True, "backend": backend.name, "model": backend.model_name})
            else:
                self.answer(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/detect":
                return self.answer(404, {"error": "not found"})
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY:
                return self.answer(413, {"error": "request too large"})
            try:
                req = json.loads(self.rfile.read(length))
                texts = req["texts"]
                labels = req.get("labels") or ["company", "person"]
                threshold = float(req.get("threshold", 0.5))
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    raise ValueError("texts must be a list of strings")
            except (ValueError, KeyError, TypeError) as err:
                return self.answer(400, {"error": str(err)})
            results = backend.detect(texts, labels, threshold)
            self.answer(200, {"results": results})

    return Handler


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--backend", choices=["gliner", "spacy"], default="gliner")
    p.add_argument("--model", help="model name (default: urchade/gliner_multi_pii-v1, or en_core_web_lg for spaCy)")
    p.add_argument("--host", default="127.0.0.1", help="address to listen on (default: this machine only)")
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()

    started = time.time()
    backend = Detector(Gliner(args.model) if args.backend == "gliner" else Spacy(args.model))
    backend.detect(["Warm-up: Nordlys Trading A/S and Lars Holm."], ["company", "person"], 0.5)
    print(
        f"customer-mask NER: {backend.name} ({backend.model_name}) loaded in {time.time() - started:.1f} s, "
        f"listening on http://{args.host}:{args.port}",
        file=sys.stderr,
    )
    Server((args.host, args.port), make_handler(backend)).serve_forever()


if __name__ == "__main__":
    main()
