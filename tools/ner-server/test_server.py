"""Tests of the NER server's pieces, cache and queue: python3 -m unittest discover -s tools/ner-server"""

import threading
import time
import unittest

from server import BATCH, Detector, Gate


class Counting:
    """A backend that finds every "Nordlys" and counts the pieces it is given."""

    name = "counting"
    model_name = "test"
    size = 1200

    def __init__(self, delay=0.0):
        self.pieces = 0
        self.delay = delay

    def predict(self, parts, labels, threshold):
        self.pieces += len(parts)
        time.sleep(self.delay)
        out = []
        for p in parts:
            i = p.find("Nordlys")
            out.append([] if i < 0 else [{"text": "Nordlys", "label": "company", "start": i, "end": i + 7, "score": 0.9}])
        return out


class DetectorTests(unittest.TestCase):
    def test_offsets_are_in_the_whole_text(self):
        d = Detector(Counting())
        text = "first line\n  12\tsecond line with Nordlys\n"
        [found] = d.detect([text], ["company"], 0.5)
        self.assertEqual(len(found), 1)
        self.assertEqual(text[found[0]["start"]:found[0]["end"]], "Nordlys")

    def test_a_piece_seen_before_is_not_run_again(self):
        model = Counting()
        d = Detector(model)
        system = "\n".join(f"System prompt line {i}, the same every turn." for i in range(40))
        d.detect([system], ["company"], 0.5)
        first = model.pieces
        found = d.detect([system + "\nNow write to Nordlys."], ["company"], 0.5)
        self.assertEqual(model.pieces - first, 1)  # only the new line
        self.assertEqual(found[0][0]["text"], "Nordlys")

    def test_other_labels_are_not_answered_from_the_cache(self):
        model = Counting()
        d = Detector(model)
        d.detect(["Nordlys"], ["company"], 0.5)
        d.detect(["Nordlys"], ["company", "person"], 0.5)
        self.assertEqual(model.pieces, 2)


class GateTests(unittest.TestCase):
    def test_a_small_request_goes_before_a_long_one_that_is_waiting(self):
        d = Detector(Counting(delay=0.05))
        order = []
        long_text = "\n".join(f"line {i}" for i in range(BATCH * 4))

        def long_job():
            d.detect([long_text], ["company"], 0.5)
            order.append("long")

        def short_job():
            d.detect(["Write to Nordlys"], ["company"], 0.5)
            order.append("short")

        t1 = threading.Thread(target=long_job)
        t1.start()
        time.sleep(0.02)
        t2 = threading.Thread(target=short_job)
        t2.start()
        t1.join()
        t2.join()
        self.assertEqual(order, ["short", "long"])

    def test_one_model_call_at_a_time(self):
        gate = Gate()
        running, peak = [], []

        def job():
            running.append(1)
            peak.append(len(running))
            time.sleep(0.01)
            running.pop()

        threads = [threading.Thread(target=gate.run, args=(1, job)) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(max(peak), 1)


if __name__ == "__main__":
    unittest.main()
