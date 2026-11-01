import asyncio
import base64
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app


@pytest.fixture
def client():
    with TestClient(app.app) as test_client:
        yield test_client


def test_dashboard_and_static_script_are_served(client):
    page = client.get("/")
    script = client.get("/static/js/dashboard.js")

    assert page.status_code == 200
    assert "FocusPulse AI — Attention Studio" in page.text
    assert "pdf-export-button" in page.text
    assert "reset-button" in page.text
    assert "jspdf" in page.text
    assert "mask-display" not in page.text
    assert "face-mesh-canvas" not in page.text
    assert "./static/js/dashboard.js" in page.text
    assert "./static/js/api-config.js" in page.text
    assert script.status_code == 200
    assert "getUserMedia" in script.text


def test_static_api_config_is_served(client):
    response = client.get("/static/js/api-config.js")

    assert response.status_code == 200
    assert 'window.FOCUSPULSE_API_BASE = "";' in response.text


def test_decode_frame_accepts_jpeg_and_data_url():
    ok, encoded = cv2.imencode(".jpg", np.zeros((48, 64, 3), dtype=np.uint8))
    assert ok
    data_url = "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")

    image = app.decode_frame(data_url)

    assert image.shape == (48, 64, 3)


@pytest.mark.parametrize(
    "payload",
    [None, "", "not base64", base64.b64encode(b"not a jpeg").decode("ascii")],
)
def test_decode_frame_rejects_invalid_input(payload):
    with pytest.raises(app.FrameValidationError):
        app.decode_frame(payload)


def test_decode_frame_rejects_oversized_dimensions_before_decode(monkeypatch):
    jpeg = b"\xff\xd8\xff\xc0\x00\x07\x08\x02\xd1\x05\x01"
    monkeypatch.setattr(
        app.cv2,
        "imdecode",
        lambda *_: pytest.fail("Oversized image should be rejected before decoding"),
    )

    with pytest.raises(app.FrameValidationError, match="dimensions"):
        app.decode_frame(base64.b64encode(jpeg).decode("ascii"))


def test_focus_score_decays_when_face_is_missing():
    analyzer = app.FocusAnalyzer()

    result = analyzer.update(SimpleNamespace(multi_face_landmarks=None), (480, 640, 3))

    assert result.state == "Distracted"
    assert 0 <= result.focus_score <= 72
    assert result.ear is None
    assert result.face_detected is False


def test_public_metrics_do_not_expose_face_landmarks():
    metrics = app._public_metrics(
        app.Analysis(
            state="Optimal Focus",
            focus_score=80,
            ear=0.3,
            blink_rate=15.0,
            gaze="Center",
            head_pose=None,
            face_detected=True,
        )
    )

    assert "face_landmarks" not in metrics


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(181.0, 1.0), (-158.5, 21.5), (90.0, 90.0), (-90.0, -90.0)],
)
def test_pose_angles_use_frontal_equivalent(raw, expected):
    assert app._normalize_pose_angle(raw) == pytest.approx(expected)


def test_blink_rate_discards_stale_events_even_when_face_is_missing():
    analyzer = app.FocusAnalyzer()
    analyzer.blinks.extend([analyzer.started_at, analyzer.started_at + 1])

    rate = analyzer._blink_rate(analyzer.started_at + 62)

    assert rate == 0
    assert not analyzer.blinks


def test_websocket_rejects_foreign_origin(client):
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(
            "/ws/analyze", headers={"origin": "https://untrusted.example"}
        ) as websocket:
            websocket.receive_json()

    assert error.value.code == 1008


def test_websocket_reports_invalid_frame_and_closes_mesh(client, monkeypatch):
    class FakeMesh:
        def process(self, _frame):
            return SimpleNamespace(multi_face_landmarks=None)

        def close(self):
            pass

    monkeypatch.setattr(app, "_create_face_mesh", FakeMesh)
    with client.websocket_connect("/ws/analyze", headers={"origin": "http://testserver"}) as websocket:
        assert websocket.receive_json() == {"type": "status", "status": "connected"}
        websocket.send_json({"frame": "invalid"})
        response = websocket.receive_json()
        assert response["type"] == "error"
        assert "base64" in response["message"]


def test_websocket_disconnect_releases_face_mesh(monkeypatch):
    closed = []

    class FakeMesh:
        def close(self):
            closed.append(True)

    class FakeWebSocket:
        headers = {}

        async def accept(self):
            pass

        async def send_json(self, _payload):
            pass

        async def receive_text(self):
            raise WebSocketDisconnect(code=1000)

    monkeypatch.setattr(app, "_create_face_mesh", FakeMesh)
    asyncio.run(app.analyze(FakeWebSocket()))

    assert closed == [True]
