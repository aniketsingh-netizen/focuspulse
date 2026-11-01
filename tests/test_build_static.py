from pathlib import Path

import pytest

from scripts.build_static import build_static_site


ROOT = Path(__file__).resolve().parents[1]


def test_static_build_contains_dashboard_and_config(tmp_path):
    output = tmp_path / "dist"

    build_static_site(ROOT, output, "https://api.example.com/")

    assert (output / "index.html").read_bytes() == (
        ROOT / "templates" / "index.html"
    ).read_bytes()
    assert (output / "static" / "js" / "dashboard.js").read_bytes() == (
        ROOT / "static" / "js" / "dashboard.js"
    ).read_bytes()
    assert (output / "static" / "js" / "api-config.js").read_text(
        encoding="utf-8"
    ) == 'window.FOCUSPULSE_API_BASE = "https://api.example.com";\n'


@pytest.mark.parametrize(
    "api_base_url",
    [
        "http://api.example.com",
        "https://api.example.com/path",
        "ftp://api.example.com",
        "https://user:password@api.example.com",
        "https://api.example.com?key=value",
        "not a URL",
    ],
)
def test_static_build_rejects_non_origin_api_urls(tmp_path, api_base_url):
    with pytest.raises(ValueError):
        build_static_site(ROOT, tmp_path / "dist", api_base_url)
