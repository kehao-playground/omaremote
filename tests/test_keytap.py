#!/usr/bin/env python3
"""Typeless spec §4 / §9: omaremote-keytap's parser, event order, release-on-failure, socket protocol and client
exit codes. Stdlib unittest; never opens /dev/uinput (an injected writer stands in for it).
Run: python3 -I tests/test_keytap.py"""
import importlib.machinery
import importlib.util
import json
import os
import socket
import stat
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_keytap():
    path = os.path.join(HERE, "..", "host", "omaremote-keytap")
    loader = importlib.machinery.SourceFileLoader("omaremote_keytap", path)
    spec = importlib.util.spec_from_loader("omaremote_keytap", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


kt = load_keytap()
EV_KEY, EV_SYN = 1, 0


class Recorder:
    """Stands in for the uinput fd: records (type, code, value); optionally fails on the Nth EV_KEY write."""
    def __init__(self, fail_on_key=None):
        self.events, self.keys, self.fail_on_key = [], 0, fail_on_key

    def write(self, etype, code, value):
        if etype == EV_KEY:
            self.keys += 1
            if self.fail_on_key is not None and self.keys == self.fail_on_key:
                raise OSError("injected write failure")
        self.events.append((etype, code, value))

    def key_events(self):
        return [(c, v) for (t, c, v) in self.events if t == EV_KEY]


def keyboard(fail_on_key=None):
    rec, sleeps = Recorder(fail_on_key), []
    return kt.Keyboard(rec.write, sleep=sleeps.append), rec, sleeps


class ChordTable(unittest.TestCase):
    def test_shared_fixture(self):
        with open(os.path.join(HERE, "fixtures", "chords.json"), encoding="utf-8") as f:
            table = json.load(f)
        for row in table:
            if "out" in row:
                self.assertEqual("+".join(kt.parse_chord(row["in"])), row["out"], row["in"])
            else:
                with self.assertRaises(kt.ChordError, msg=row["in"]) as cm:
                    kt.parse_chord(row["in"])
                self.assertEqual(str(cm.exception), row["err"], row["in"])

    def test_codes(self):
        self.assertEqual(kt.CODES["RightAlt"], 100)
        self.assertEqual(kt.CODES["Q"], 16)
        self.assertEqual(kt.CODES["M"], 50)
        self.assertEqual(kt.CODES["0"], 11)
        self.assertEqual(kt.CODES["F10"], 68)
        self.assertEqual(kt.CODES["F13"], 183)
        self.assertEqual(kt.CODES["F24"], 194)
        self.assertEqual(len(kt.CODES), 8 + 26 + 10 + 1 + 24)


class EventOrder(unittest.TestCase):
    def test_single_key_is_press_syn_release_syn(self):
        kb, rec, sleeps = keyboard()
        kb.tap(kt.parse_chord("RightAlt"))
        self.assertEqual(rec.events, [(EV_KEY, 100, 1), (EV_SYN, 0, 0), (EV_KEY, 100, 0), (EV_SYN, 0, 0)])
        self.assertEqual(sleeps, [0.08])

    def test_modifiers_only_keeps_written_order_and_releases_in_reverse(self):
        kb, rec, sleeps = keyboard()
        kb.tap(kt.parse_chord("RightAlt+RightShift"))
        self.assertEqual(rec.key_events(), [(100, 1), (54, 1), (54, 0), (100, 0)])
        self.assertEqual(sleeps, [0.03, 0.08, 0.03])

    def test_main_key_is_the_trigger_wherever_it_was_written(self):
        kb, rec, _ = keyboard()
        kb.tap(kt.parse_chord("space+rightctrl"))
        self.assertEqual(rec.key_events(), [(97, 1), (57, 1), (57, 0), (97, 0)])

    def test_four_name_chord_stays_under_400_ms(self):
        kb, _, sleeps = keyboard()
        kb.tap(kt.parse_chord("LeftCtrl+LeftAlt+LeftShift+A"))
        self.assertLessEqual(sum(sleeps), 0.4)


class ReleaseOnFailure(unittest.TestCase):
    def test_write_failure_mid_chord_releases_every_pressed_key(self):
        kb, rec, _ = keyboard(fail_on_key=2)   # RightCtrl down succeeds, Space down raises
        with self.assertRaises(OSError):
            kb.tap(kt.parse_chord("RightCtrl+Space"))
        self.assertEqual(rec.key_events(), [(97, 1), (57, 0), (97, 0)])
        self.assertEqual(kb.down, [])

    def test_process_reports_err_write(self):
        kb, _, _ = keyboard(fail_on_key=1)
        self.assertTrue(kt.process("tap RightAlt", kb).startswith("err write "))

    def test_close_releases_keys_left_down(self):
        rec, destroyed = Recorder(), []
        kb = kt.Keyboard(rec.write, sleep=lambda s: None, destroy=lambda: destroyed.append(True))
        kb.down = ["RightAlt"]
        kb.close()
        self.assertEqual(rec.key_events(), [(100, 0)])
        self.assertEqual(destroyed, [True])


class FakeKb:
    def __init__(self, fail=False):
        self.taps, self.fail = [], fail

    def tap(self, names):
        if self.fail:
            raise OSError("injected")
        self.taps.append("+".join(names))

    def close(self):
        pass


class Protocol(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "k.sock")

    def start(self, kb=None, stale=False):
        if stale:
            with open(self.path, "w") as f:
                f.write("stale")
        self.kb = kb or FakeKb()
        ready = threading.Event()
        threading.Thread(target=kt.serve, args=(self.path, self.kb, ready), daemon=True).start()
        self.assertTrue(ready.wait(2))

    def raw(self, payload, wait=2.0):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.path)
        if payload:
            s.sendall(payload)
        s.settimeout(wait)
        t0 = time.monotonic()
        data = b""
        try:
            while not data.endswith(b"\n"):
                chunk = s.recv(256)
                if not chunk:
                    break
                data += chunk
        finally:
            s.close()
        return data.decode(), time.monotonic() - t0

    def test_tap_ping_and_reject(self):
        self.start()
        self.assertEqual(kt.client("tap rightalt+rightshift", self.path), 0)
        self.assertEqual(self.kb.taps, ["RightAlt+RightShift"])
        self.assertEqual(kt.client("ping", self.path), 0)
        self.assertEqual(self.kb.taps, ["RightAlt+RightShift"], "ping sends no key")
        self.assertEqual(kt.client("tap Enter", self.path), 2)
        self.assertEqual(self.raw(b"hello\n")[0], "err reject unknown request\n")

    def test_read_deadline_is_500_ms_and_the_next_client_is_served(self):
        self.start()
        reply, took = self.raw(b"")
        self.assertEqual(reply, "err reject timeout\n")
        self.assertGreaterEqual(took, 0.4)
        self.assertLess(took, 0.9)
        self.assertEqual(kt.client("ping", self.path), 0)

    def test_request_over_128_bytes_is_rejected(self):
        self.start()
        self.assertEqual(self.raw(b"x" * 200)[0], "err reject too long\n")
        self.assertEqual(self.raw(b"tap " + b"A" * 123 + b"\n")[0].split(" ")[0:2], ["err", "reject"])  # 128 bytes, parsed
        self.assertEqual(self.raw(b"ping\n")[0], "ok\n")

    def test_stale_socket_file_is_replaced_and_mode_is_0600(self):
        self.start(stale=True)
        self.assertEqual(kt.client("ping", self.path), 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)


class ClientExitCodes(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "k.sock")

    def test_3_when_no_socket(self):
        self.assertEqual(kt.client("ping", self.path), 3)

    def test_4_on_err_write(self):
        ready = threading.Event()
        threading.Thread(target=kt.serve, args=(self.path, FakeKb(fail=True), ready), daemon=True).start()
        self.assertTrue(ready.wait(2))
        self.assertEqual(kt.client("tap RightAlt", self.path), 4)

    def test_5_when_the_server_accepts_and_never_replies(self):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.path)
        srv.listen(1)          # never accept(): the connection sits in the backlog and no reply ever comes
        t0 = time.monotonic()
        self.assertEqual(kt.client("ping", self.path, timeout=0.3), 5)
        self.assertLess(time.monotonic() - t0, 1.0)
        srv.close()

    def test_5_when_the_connection_breaks(self):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.path)
        srv.listen(1)

        def accept_and_close():
            c, _ = srv.accept()
            c.close()
        threading.Thread(target=accept_and_close, daemon=True).start()
        self.assertEqual(kt.client("ping", self.path), 5)
        srv.close()

    def test_default_reply_timeout_is_1_5_s(self):
        self.assertEqual(kt.REPLY_TIMEOUT, 1.5)

    def test_a_newline_inside_the_chord_is_rejected_locally(self):
        self.assertEqual(kt.client("tap Right\nAlt", self.path), 2)


class SocketPath(unittest.TestCase):
    def test_xdg_runtime_dir(self):
        old = os.environ.get("XDG_RUNTIME_DIR")
        try:
            os.environ["XDG_RUNTIME_DIR"] = "/run/user/4242"
            self.assertEqual(kt.sock_path(), "/run/user/4242/omaremote-keytap.sock")
            del os.environ["XDG_RUNTIME_DIR"]          # review focus 4: unset falls back to /run/user/<uid>
            self.assertEqual(kt.sock_path(), "/run/user/%d/omaremote-keytap.sock" % os.getuid())
        finally:
            if old is None:
                os.environ.pop("XDG_RUNTIME_DIR", None)
            else:
                os.environ["XDG_RUNTIME_DIR"] = old


class Usage(unittest.TestCase):
    def test_bad_arguments_exit_64(self):
        self.assertEqual(kt.main(["omaremote-keytap"]), 64)
        self.assertEqual(kt.main(["omaremote-keytap", "tap"]), 64)


if __name__ == "__main__":
    unittest.main()
