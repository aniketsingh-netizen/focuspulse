import json
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]


def _validated_api_origin(value: str) -> str:
    origin = value.strip().rstrip("/")
    if not origin:
        return ""
    try:
        parsed = urlsplit(origin)
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("API_BASE_URL must be a valid HTTPS origin.") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("API_BASE_URL must be an HTTPS origin without a path, query, or fragment.")
    return origin


def build_static_site(source_root: Path, output_root: Path, api_base_url: str = "") -> None:
    api_origin = _validated_api_origin(api_base_url)
    output_root.mkdir(parents=True, exist_ok=True)
    js_output = output_root / "static" / "js"
    js_output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_root / "templates" / "index.html", output_root / "index.html")
    shutil.copyfile(source_root / "static" / "js" / "dashboard.js", js_output / "dashboard.js")
    (js_output / "api-config.js").write_text(
        "window.FOCUSPULSE_API_BASE = " + json.dumps(api_origin) + ";\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    destination = Path(os.environ.get("OUTPUT_DIR", ROOT / "dist"))
    if not destination.is_absolute():
        destination = ROOT / destination
    build_static_site(
        ROOT,
        destination,
        os.environ.get("API_BASE_URL", ""),
    )
