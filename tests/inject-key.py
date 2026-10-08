#!/usr/bin/env python3
"""Inject EV_KEY press/release pairs through a temporary uinput device.

keyd 2.6.0 has no injection subcommand, and wtype cannot trigger Hyprland binds
on this host, so measuring bind edges at controlled press durations needs this.
Emits only F13-F24 and prog1 by default -- nothing on an Omarchy host binds those,
so a stray injection is inert. Never injects modifiers.

Requires root (writes /dev/uinput). Read-only on everything else.
"""
import argparse
import fcntl
import os
import re
import struct
import sys
import time

# asm-generic/ioctl.h: _IOC_NONE=0, _IOC_WRITE=1, _IOC_READ=2, and _IOW uses
# _IOC_WRITE -- so an _IOW number carries 1<<30, not 2<<30. Verified against
# /usr/include/asm-generic/ioctl.h and /usr/include/linux/uinput.h on this host.
UI_DEV_CREATE = 0x5501          # _IO(UINPUT_IOCTL_BASE, 1)
UI_DEV_DESTROY = 0x5502         # _IO(UINPUT_IOCTL_BASE, 2)
UI_SET_EVBIT = 0x40045564       # _IOW(UINPUT_IOCTL_BASE, 100, int)
UI_SET_KEYBIT = 0x40045565      # _IOW(UINPUT_IOCTL_BASE, 101, int)
UI_DEV_SETUP = 0x405C5503       # _IOW(UINPUT_IOCTL_BASE, 3, struct uinput_setup)

EV_SYN, EV_KEY = 0x00, 0x01
SYN_REPORT = 0
EVENT_FMT = "llHHi"             # struct input_event on 64-bit
SETUP_FMT = "HHHH80sI"          # struct uinput_setup; 92 bytes, matches UI_DEV_SETUP's size field

# The compositor and libinput need time to finish adding the device after
# UI_DEV_CREATE. Without this wait the first events are silently dropped, and
# that failure reads exactly like "the bind rule is strange" -- the thing this
# tool exists to measure. Mandatory, not a tuning knob to remove.
SETTLE_S = 0.5


def key_codes():
    codes = {}
    with open("/usr/include/linux/input-event-codes.h") as fh:
        for line in fh:
            m = re.match(r"#define\s+KEY_(\w+)\s+(0x[0-9a-fA-F]+|\d+)", line)
            if m and not m.group(1).endswith(("MAX", "CNT")):
                codes.setdefault(m.group(1).lower(), int(m.group(2), 0))
    return codes


class Injector:
    # The default vendor:product is deliberately NOT the remote's. keyd matches devices by
    # `[ids] <vendor>:<product>`, so a default-id injector is never grabbed and its keys go straight
    # to the compositor -- which is what the bind-layer tests want. Pass --vendor/--product to
    # impersonate the remote and exercise keyd's own remapping instead; that path is otherwise
    # untestable without a human pressing buttons.
    def __init__(self, codes, name="omaremote-inject", settle_s=SETTLE_S,
                 vendor=0x1234, product=0x5678):
        self.codes = codes
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        for code in codes.values():
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        # struct uinput_setup { struct input_id id; char name[80]; __u32 ff_effects_max; }
        # struct input_id { __u16 bustype, vendor, product, version; }
        setup = struct.pack(SETUP_FMT, 0x03, vendor, product, 1, name.encode(), 0)
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(settle_s)
        self.pressed = set()

    def _emit(self, etype, code, value):
        os.write(self.fd, struct.pack(EVENT_FMT, 0, 0, etype, code, value))

    def _syn(self):
        self._emit(EV_SYN, SYN_REPORT, 0)

    def tap(self, name, hold_ms):
        code = self.codes[name]
        self._emit(EV_KEY, code, 1)
        self._syn()
        self.pressed.add(code)
        time.sleep(hold_ms / 1000.0)
        self._emit(EV_KEY, code, 0)
        self._syn()
        self.pressed.discard(code)

    def close(self):
        for code in list(self.pressed):          # never leave a key down
            self._emit(EV_KEY, code, 0)
            self._syn()
        self.pressed.clear()
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        finally:
            os.close(self.fd)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("key", nargs="?", help="key name, e.g. f13 or prog1")
    ap.add_argument("--hold-ms", type=int, default=120)
    ap.add_argument("--seq", help="comma-separated name:hold_ms pairs, e.g. f13:120,f18:3000")
    ap.add_argument("--gap-ms", type=int, default=300, help="pause between sequence entries")
    ap.add_argument("--settle-ms", type=int, default=int(SETTLE_S * 1000))
    ap.add_argument("--vendor", type=lambda v: int(v, 16), default=0x1234,
                    help="hex vendor id for the virtual device; use the remote's to make keyd grab it")
    ap.add_argument("--product", type=lambda v: int(v, 16), default=0x5678,
                    help="hex product id for the virtual device")
    ap.add_argument("--linger-ms", type=int, default=0,
                    help="keep the virtual device alive this long AFTER the last release. "
                         "Without it the device is destroyed immediately, and a compositor that "
                         "synthesises releases for keys held on a removed device can make a LOST "
                         "release edge look delivered -- which is exactly what happened to the "
                         "2026-10-07 bind matrix.")
    args = ap.parse_args()

    if os.geteuid() != 0:
        sys.exit("inject-key: needs root to write /dev/uinput (run under sudo)")
    if not args.key and not args.seq:
        sys.exit("inject-key: give a key name or --seq")

    plan = []
    if args.seq:
        for part in args.seq.split(","):
            name, _, ms = part.partition(":")
            plan.append((name.strip().lower(), int(ms or args.hold_ms)))
    else:
        plan.append((args.key.strip().lower(), args.hold_ms))

    codes = key_codes()
    unknown = [n for n, _ in plan if n not in codes]
    if unknown:
        sys.exit(f"inject-key: unknown key name(s): {', '.join(unknown)}")

    inj = Injector(codes, settle_s=args.settle_ms / 1000.0,
                   vendor=args.vendor, product=args.product)
    try:
        for i, (name, ms) in enumerate(plan):
            if i:
                time.sleep(args.gap_ms / 1000.0)
            inj.tap(name, ms)
            print(f"injected {name} for {ms}ms", flush=True)
        if args.linger_ms:
            time.sleep(args.linger_ms / 1000.0)
            print(f"lingered {args.linger_ms}ms before destroying the device", flush=True)
    finally:
        inj.close()


if __name__ == "__main__":
    main()
