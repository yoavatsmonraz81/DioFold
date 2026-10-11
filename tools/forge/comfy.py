"""Minimal ComfyUI HTTP client: queue an API-format workflow, wait, fetch the images."""
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

HOST = os.environ.get("COMFY_HOST", "http://127.0.0.1:8188")
CLIENT_ID = str(uuid.uuid4())


def _req(path, data=None, timeout=60):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(HOST + path, data=body, headers={"Content-Type": "application/json"} if body else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def alive():
    try:
        _req("/system_stats", timeout=3)
        return True
    except Exception:
        return False


def upload_image(path, name=None):
    """Upload a local PNG to ComfyUI's input folder; returns the stored filename."""
    import mimetypes
    name = name or path.split("/")[-1]
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        data = f.read()
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: {mimetypes.guess_type(name)[0] or 'image/png'}\r\n\r\n".encode(),
        data,
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(HOST + "/upload/image", data=b"".join(parts), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["name"]


def run(workflow, timeout=900):
    """Queue a workflow and return a list of PNG bytes from every SaveImage node."""
    res = json.loads(_req("/prompt", {"prompt": workflow, "client_id": CLIENT_ID}))
    pid = res["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        hist = json.loads(_req(f"/history/{pid}"))
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(json.dumps(status.get("messages", []))[:2000])
            images = []
            for out in entry.get("outputs", {}).values():
                for im in out.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
                    images.append(_req(f"/view?{q}"))
            return images
        time.sleep(0.5)
    raise TimeoutError(f"workflow {pid} did not finish in {timeout}s")
