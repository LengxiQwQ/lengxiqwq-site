import argparse
import io
import json
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from PIL import Image, UnidentifiedImageError


MARKDOWN_IMAGE = re.compile(r'!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)')
MAX_IMAGE_EDGE = 100_000
MAX_PROBE_BYTES = 2 * 1024 * 1024
FORMATS = ("JPEG", "PNG", "WEBP", "GIF", "AVIF")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_json(path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def candidate_urls(data_dir):
    messages = [
        message
        for room in ("chat", "interconnect")
        for message in load_json(data_dir / f"messages_{room}.json")
        if not message.get("isRecalled") and message.get("status") not in ("recalled", "deleted")
    ]
    for message in sorted(messages, key=lambda item: item.get("createdAt") or 0, reverse=True):
        for attachment in message.get("attachments") or []:
            if attachment.get("type") == "image" and not attachment.get("isSticker"):
                yield attachment.get("url")
        for match in MARKDOWN_IMAGE.finditer(message.get("content") or ""):
            yield match[1] or match[2]


def allowed_url(url, hosts):
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        return parts.scheme == "https" and parts.netloc.lower() in hosts and not parts.fragment
    except ValueError:
        return False


def read_dimensions(opener, url):
    request = Request(url, headers={"Range": f"bytes=0-{MAX_PROBE_BYTES - 1}"})
    deadline = time.monotonic() + 12
    with opener.open(request, timeout=4) as response:
        if response.status not in (200, 206):
            return None
        if response.status == 206 and not response.headers.get("Content-Range", "").startswith("bytes 0-"):
            return None
        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
            return None
        data = bytearray()
        while len(data) < MAX_PROBE_BYTES and time.monotonic() < deadline:
            chunk = response.read1(min(256 * 1024, MAX_PROBE_BYTES - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            try:
                with Image.open(io.BytesIO(data), formats=FORMATS) as image:
                    width, height = image.size
                    if image.getexif().get(274) in (5, 6, 7, 8):
                        width, height = height, width
                    if 0 < width <= MAX_IMAGE_EDGE and 0 < height <= MAX_IMAGE_EDGE:
                        return {"width": width, "height": height}
                    return None
            except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
                continue
    return None


def write_atomic(path, data):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        temp_path = Path(output.name)
        try:
            json.dump(data, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        except BaseException:
            output.close()
            temp_path.unlink(missing_ok=True)
            raise
    try:
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Collect dimensions for historical chat images.")
    parser.add_argument("data_dir", type=Path, help="Directory with copies of both message JSON files")
    parser.add_argument("--allow-host", action="append", required=True, help="Exact HTTPS hostname to probe")
    parser.add_argument("--limit", type=int, default=50, help="Max uncached URLs to probe this run")
    parser.add_argument("--offset", type=int, default=0, help="Skip this many eligible URLs in recent-first order")
    parser.add_argument("--write", action="store_true", help="Save successful probes to the sidecar")
    args = parser.parse_args()
    if args.limit < 1 or args.offset < 0:
        parser.error("--limit must be positive and --offset must be non-negative")
    hosts = {host.lower() for host in args.allow_host}
    if any(not re.fullmatch(r"[a-z0-9.-]+", host) for host in hosts):
        parser.error("--allow-host accepts hostnames only")

    output = args.data_dir / "chat_image_dimensions.json"
    sizes = load_json(output) if output.exists() else {}
    eligible = list(dict.fromkeys(url for url in candidate_urls(args.data_dir) if allowed_url(url, hosts)))
    pending = [url for url in eligible[args.offset:] if url not in sizes][:args.limit]
    opener = build_opener(NoRedirects())
    found = 0
    for url in pending:
        try:
            result = read_dimensions(opener, url)
        except (URLError, OSError, ValueError, Image.DecompressionBombError):
            result = None
        if result:
            sizes[url] = result
            found += 1
        time.sleep(0.25)
    if args.write and found:
        write_atomic(output, sizes)
    print(f"eligible={len(eligible)} probed={len(pending)} resolved={found} unresolved={len(pending) - found} saved={found if args.write else 0}")


if __name__ == "__main__":
    main()
