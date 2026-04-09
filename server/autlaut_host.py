#!/usr/bin/env python3
"""Autlaut native messaging host — manages the TTS server lifecycle."""

import json
import os
import signal
import struct
import subprocess
import sys
import time
import urllib.request

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
PID_FILE = os.path.join(HOST_DIR, ".server.pid")


def read_message():
    """Read a Chrome native messaging message from stdin."""
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = struct.unpack("=I", raw)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data)


def send_message(msg):
    """Send a Chrome native messaging message to stdout."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_server_running(port=8787):
    """Check if the TTS server is responding on the given port."""
    try:
        req = urllib.request.Request(f"http://localhost:{port}/health")
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            return data.get("status") == "ok"
    except Exception:
        return False


def read_pid():
    """Read and validate the stored server PID."""
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # check if process exists
        return pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None


def write_pid(pid):
    with open(PID_FILE, "w") as f:
        f.write(str(pid))


def remove_pid():
    try:
        os.remove(PID_FILE)
    except FileNotFoundError:
        pass


def start_server(port=8787):
    """Start the TTS server as a detached background process."""
    if is_server_running(port):
        return {"ok": True, "status": "already_running"}

    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn",
            "app:app", "--host", "127.0.0.1", "--port", str(port),
        ],
        cwd=HOST_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    write_pid(proc.pid)

    # Poll for server readiness (up to 15 s — first launch loads the model)
    for _ in range(30):
        time.sleep(0.5)
        if is_server_running(port):
            return {"ok": True, "status": "started", "pid": proc.pid}

    return {"ok": False, "error": "Server process started but not responding after 15 s"}


def stop_server():
    """Stop the TTS server by stored PID."""
    pid = read_pid()
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        remove_pid()
        return {"ok": True, "status": "stopped"}

    # No PID on file — nothing we can do
    if is_server_running():
        return {"ok": False, "error": "Server is running but was not started by Autlaut"}
    return {"ok": True, "status": "not_running"}


def server_status(port=8787):
    running = is_server_running(port)
    pid = read_pid()
    return {"ok": True, "running": running, "pid": pid}


def main():
    msg = read_message()
    if not msg:
        return

    action = msg.get("action", "")
    port = msg.get("port", 8787)

    if action == "start":
        resp = start_server(port)
    elif action == "stop":
        resp = stop_server()
    elif action == "status":
        resp = server_status(port)
    else:
        resp = {"ok": False, "error": f"Unknown action: {action}"}

    send_message(resp)


if __name__ == "__main__":
    main()
