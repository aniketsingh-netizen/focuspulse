import asyncio
import base64
import binascii
import json
import logging
import math
import os
import re
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import cv2
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("focuspulse")

MAX_FRAME_BYTES = 1_500_000
MAX_FRAME_WIDTH = 1280
MAX_FRAME_HEIGHT = 720
MAX_ANALYSIS_SESSIONS = 3
_analysis_slots = asyncio.Semaphore(MAX_ANALYSIS_SESSIONS)
_DATA_URL_PREFIX = re.compile(r"^data:image/jpeg;base64,", re.IGNORECASE)
_BASE_DIR = Path(__file__).resolve().parent


class FrameValidationError(ValueError):
    """Raised when an incoming webcam frame is invalid or too large."""


def decode_frame(encoded_frame: str) -> np.ndarray:
    """Decode a bounded JPEG data URL or base64 payload into an OpenCV image."""
    if not isinstance(encoded_frame, str):
        raise FrameValidationError("Frame must be a base64-encoded JPEG.")

    encoded_frame = _DATA_URL_PREFIX.sub("", encoded_frame, count=1)
    if not encoded_frame or len(encoded_frame) > math.ceil(MAX_FRAME_BYTES * 4 / 3) + 8:
        raise FrameValidationError("Frame is empty or exceeds the size limit.")

    try:
        image_bytes = base64.b64decode(encoded_frame, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise FrameValidationError("Frame is not valid base64.") from exc

    if not image_bytes or len(image_bytes) > MAX_FRAME_BYTES:
        raise FrameValidationError("Frame is empty or exceeds the size limit.")
    if not image_bytes.startswith(b"\xff\xd8"):
        raise FrameValidationError("Only JPEG frames are accepted.")
    width, height = _jpeg_dimensions(image_bytes)
    if width > MAX_FRAME_WIDTH or height > MAX_FRAME_HEIGHT:
        raise FrameValidationError(
            f"Frame dimensions must not exceed {MAX_FRAME_WIDTH}x{MAX_FRAME_HEIGHT}."
        )

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise FrameValidationError("Frame could not be decoded.")
    return image


def _jpeg_dimensions(image_bytes: bytes) -> tuple[int, int]:
    """Read JPEG frame dimensions before decoding to bound memory allocation."""
    position = 2
    start_of_frame = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while position + 4 <= len(image_bytes):
        if image_bytes[position] != 0xFF:
            raise FrameValidationError("Malformed JPEG frame.")
        while position < len(image_bytes) and image_bytes[position] == 0xFF:
            position += 1
        if position >= len(image_bytes):
            break
        marker = image_bytes[position]
        position += 1
        if marker in {0xD8, 0xD9, 0x01, *range(0xD0, 0xD8)}:
            if marker == 0xD9:
                break
            continue
        if position + 2 > len(image_bytes):
            break
        segment_length = int.from_bytes(image_bytes[position : position + 2], "big")
        if segment_length < 2 or position + segment_length > len(image_bytes):
            raise FrameValidationError("Malformed JPEG frame.")
        if marker in start_of_frame:
            if segment_length < 7:
                raise FrameValidationError("Malformed JPEG frame.")
            height = int.from_bytes(image_bytes[position + 3 : position + 5], "big")
            width = int.from_bytes(image_bytes[position + 5 : position + 7], "big")
            if not width or not height:
                raise FrameValidationError("JPEG frame has invalid dimensions.")
            return width, height
        if marker == 0xDA:
            break
        position += segment_length
    raise FrameValidationError("JPEG frame dimensions could not be read.")


def _landmark_xy(landmarks: Any, index: int, width: int, height: int) -> tuple[float, float]:
    point = landmarks[index]
    return point.x * width, point.y * height


def _eye_aspect_ratio(landmarks: Any, indexes: tuple[int, ...], width: int, height: int) -> float:
    outer_a = _landmark_xy(landmarks, indexes[0], width, height)
    upper_a = _landmark_xy(landmarks, indexes[1], width, height)
    upper_b = _landmark_xy(landmarks, indexes[2], width, height)
    outer_b = _landmark_xy(landmarks, indexes[3], width, height)
    lower_a = _landmark_xy(landmarks, indexes[4], width, height)
    lower_b = _landmark_xy(landmarks, indexes[5], width, height)
    horizontal = math.dist(outer_a, outer_b)
    if horizontal < 1:
        return 0.0
    return (math.dist(upper_a, lower_b) + math.dist(upper_b, lower_a)) / (2 * horizontal)


def _normalize_pose_angle(angle: float) -> float:
    """Represent equivalent head rotations within the usual frontal-facing range."""
    while angle > 90.0:
        angle -= 180.0
    while angle < -90.0:
        angle += 180.0
    return angle


def _head_pose(landmarks: Any, width: int, height: int) -> dict[str, float]:
    image_points = np.array(
        [
            _landmark_xy(landmarks, 1, width, height),
            _landmark_xy(landmarks, 152, width, height),
            _landmark_xy(landmarks, 33, width, height),
            _landmark_xy(landmarks, 263, width, height),
            _landmark_xy(landmarks, 61, width, height),
            _landmark_xy(landmarks, 291, width, height),
        ],
        dtype=np.float64,
    )
    model_points = np.array(
        [
            (0.0, 0.0, 0.0),
            (0.0, -330.0, -65.0),
            (-225.0, 170.0, -135.0),
            (225.0, 170.0, -135.0),
            (-150.0, -150.0, -125.0),
            (150.0, -150.0, -125.0),
        ],
        dtype=np.float64,
    )
    focal_length = float(width)
    camera_matrix = np.array(
        [
            [focal_length, 0.0, width / 2],
            [0.0, focal_length, height / 2],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    success, rotation_vector, _ = cv2.solvePnP(
        model_points,
        image_points,
        camera_matrix,
        np.zeros((4, 1), dtype=np.float64),
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not success:
        raise ValueError("Head pose could not be estimated.")
    rotation_matrix, _ = cv2.Rodrigues(rotation_vector)
    angles, _, _, _, _, _ = cv2.RQDecomp3x3(rotation_matrix)
    return {
        "yaw": _normalize_pose_angle(float(angles[1])),
        "pitch": _normalize_pose_angle(float(angles[0])),
        "roll": _normalize_pose_angle(float(angles[2])),
    }


def _gaze_direction(landmarks: Any) -> str:
    ratios = []
    for iris_index, corner_a, corner_b in ((468, 33, 133), (473, 362, 263)):
        iris_x = landmarks[iris_index].x
        edge_a = landmarks[corner_a].x
        edge_b = landmarks[corner_b].x
        span = edge_b - edge_a
        if abs(span) > 0.001:
            ratios.append((iris_x - edge_a) / span)
    if not ratios:
        return "Unavailable"
    ratio = sum(ratios) / len(ratios)
    if ratio < 0.36:
        return "Left"
    if ratio > 0.64:
        return "Right"
    return "Center"


@dataclass
class Analysis:
    state: str
    focus_score: int
    ear: float | None
    blink_rate: float
    gaze: str
    head_pose: dict[str, float] | None
    face_detected: bool


class FocusAnalyzer:
    """Per-connection heuristic attention estimator; it stores metrics only."""

    _LEFT_EYE = (33, 160, 158, 133, 153, 144)
    _RIGHT_EYE = (362, 385, 387, 263, 373, 380)

    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.last_update = self.started_at
        self.focus_score = 72.0
        self.ear_samples: deque[float] = deque(maxlen=150)
        self.pose_samples: deque[tuple[float, float, float]] = deque(maxlen=40)
        self.blinks: deque[float] = deque()
        self.closed_since: float | None = None
        self.gaze_away_since: float | None = None

    def update(self, results: Any, frame_shape: tuple[int, ...]) -> Analysis:
        now = time.monotonic()
        elapsed = max(0.01, now - self.last_update)
        self.last_update = now
        faces = getattr(results, "multi_face_landmarks", None)
        if not faces:
            self.focus_score = max(0.0, self.focus_score - elapsed * 8.0)
            self.closed_since = None
            self.gaze_away_since = None
            return Analysis(
                "Distracted",
                round(self.focus_score),
                None,
                self._blink_rate(now),
                "Unavailable",
                None,
                False,
            )

        landmarks = faces[0].landmark
        height, width = frame_shape[:2]
        ear = (
            _eye_aspect_ratio(landmarks, self._LEFT_EYE, width, height)
            + _eye_aspect_ratio(landmarks, self._RIGHT_EYE, width, height)
        ) / 2
        self.ear_samples.append(ear)
        if ear < 0.20:
            if self.closed_since is None:
                self.closed_since = now
        elif self.closed_since is not None:
            closed_for = now - self.closed_since
            if 0.06 <= closed_for <= 1.0:
                self.blinks.append(now)
            self.closed_since = None
        while self.blinks and now - self.blinks[0] > 60:
            self.blinks.popleft()

        try:
            pose = _head_pose(landmarks, width, height)
        except (ValueError, cv2.error, IndexError):
            pose = None
        if pose is not None:
            self.pose_samples.append((pose["yaw"], pose["pitch"], pose["roll"]))

        gaze = _gaze_direction(landmarks)
        if gaze != "Center":
            if self.gaze_away_since is None:
                self.gaze_away_since = now
        else:
            self.gaze_away_since = None

        blink_rate = self._blink_rate(now)
        ear_variability = float(np.std(self.ear_samples)) if len(self.ear_samples) > 1 else 0.0
        eye_stability = max(0.0, 100.0 - ear_variability * 450.0)
        blink_score = max(0.0, 100.0 - abs(blink_rate - 16.0) * 2.5)
        if pose is None:
            head_score = 60.0
        else:
            head_score = max(
                0.0,
                100.0
                - max(0.0, abs(pose["yaw"]) - 8.0) * 2.4
                - max(0.0, abs(pose["pitch"]) - 12.0) * 1.6
                - self._pose_trend() * 0.8,
            )
        gaze_score = 100.0 if gaze == "Center" else 55.0
        eye_open_score = 100.0 if ear >= 0.20 else max(0.0, ear * 400.0)
        target_score = (
            eye_stability * 0.22
            + blink_score * 0.20
            + head_score * 0.25
            + gaze_score * 0.13
            + eye_open_score * 0.20
        )
        smoothing_seconds = 2.5 if target_score < self.focus_score else 8.0
        self.focus_score += (target_score - self.focus_score) * min(1.0, elapsed / smoothing_seconds)
        self.focus_score = min(100.0, max(0.0, self.focus_score))

        closed_too_long = self.closed_since is not None and now - self.closed_since >= 1.2
        prolonged_closure = self.closed_since is not None and now - self.closed_since >= 0.6
        high_blink_rate = blink_rate >= 32.0 and now - self.started_at >= 20.0
        if closed_too_long or high_blink_rate or (prolonged_closure and blink_rate >= 25.0):
            state = "Fatigued/Drowsy"
        elif (
            (pose is not None and (abs(pose["yaw"]) >= 25.0 or abs(pose["pitch"]) >= 30.0))
            or (self.gaze_away_since is not None and now - self.gaze_away_since >= 2.5)
            or self.focus_score < 45.0
        ):
            state = "Distracted"
        else:
            state = "Optimal Focus"

        return Analysis(
            state,
            round(self.focus_score),
            round(ear, 3),
            round(blink_rate, 1),
            gaze,
            pose,
            True,
        )

    def _blink_rate(self, now: float) -> float:
        while self.blinks and now - self.blinks[0] > 60:
            self.blinks.popleft()
        observation_seconds = max(10.0, min(60.0, now - self.started_at))
        return len(self.blinks) * 60.0 / observation_seconds

    def _pose_trend(self) -> float:
        if len(self.pose_samples) < 2:
            return 0.0
        first = self.pose_samples[0]
        last = self.pose_samples[-1]
        return sum(abs(end - start) for start, end in zip(first, last)) / 3


def _create_face_mesh() -> Any:
    return mp.solutions.face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.55,
        min_tracking_confidence=0.55,
    )


def _public_metrics(analysis: Analysis) -> dict[str, Any]:
    pose = analysis.head_pose
    return {
        "type": "metrics",
        "state": analysis.state,
        "focus_score": analysis.focus_score,
        "ear": analysis.ear,
        "blink_rate": analysis.blink_rate,
        "gaze": analysis.gaze,
        "head_pose": (
            {key: round(value, 1) for key, value in pose.items()}
            if pose is not None
            else None
        ),
        "face_detected": analysis.face_detected,
        "timestamp": time.time(),
    }


def _allowed_origins() -> set[str]:
    return {origin.strip() for origin in os.getenv("FOCUSPULSE_ALLOWED_ORIGINS", "").split(",") if origin.strip()}


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("FocusPulse AI started")
    yield
    logger.info("FocusPulse AI stopped")


app = FastAPI(title="FocusPulse AI", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=_BASE_DIR / "static"), name="static")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "FocusPulse AI"}


@app.get("/", response_class=HTMLResponse)
async def dashboard() -> HTMLResponse:
    with open(_BASE_DIR / "templates" / "index.html", encoding="utf-8") as page:
        return HTMLResponse(page.read())


@app.websocket("/ws/analyze")
async def analyze(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    allowed_origins = _allowed_origins()
    if origin:
        if allowed_origins:
            origin_allowed = origin in allowed_origins
        else:
            try:
                parsed_origin = urlsplit(origin)
                request_host = websocket.headers.get("host", "").lower()
                origin_allowed = (
                    parsed_origin.scheme in {"http", "https"}
                    and parsed_origin.netloc.lower() == request_host
                    and not parsed_origin.username
                    and not parsed_origin.password
                )
            except ValueError:
                origin_allowed = False
        if not origin_allowed:
            await websocket.close(code=1008, reason="Origin is not allowed.")
            return

    await websocket.accept()
    mesh = None
    slot_acquired = False
    try:
        try:
            await asyncio.wait_for(_analysis_slots.acquire(), timeout=0.5)
            slot_acquired = True
        except asyncio.TimeoutError:
            await websocket.close(code=1013, reason="Analysis capacity is currently full.")
            return
        mesh = await asyncio.to_thread(_create_face_mesh)
        analyzer = FocusAnalyzer()
        await websocket.send_json({"type": "status", "status": "connected"})
        while True:
            message = await websocket.receive_text()
            if len(message) > math.ceil(MAX_FRAME_BYTES * 4 / 3) + 512:
                await websocket.close(code=1009, reason="Frame exceeds the size limit.")
                break
            try:
                payload = json.loads(message)
                if not isinstance(payload, dict) or set(payload) != {"frame"}:
                    raise FrameValidationError("Send one JSON object with a 'frame' JPEG field.")
                frame = decode_frame(payload["frame"])
            except (json.JSONDecodeError, FrameValidationError) as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
                continue
            except (TypeError, KeyError):
                await websocket.send_json({"type": "error", "message": "Frame must be a base64-encoded JPEG."})
                continue

            results = await asyncio.to_thread(
                mesh.process,
                cv2.cvtColor(frame, cv2.COLOR_BGR2RGB),
            )
            metrics = analyzer.update(results, frame.shape)
            await websocket.send_json(_public_metrics(metrics))
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception:
        logger.exception("Unexpected error in analysis WebSocket")
        try:
            await websocket.close(code=1011, reason="Analysis failed.")
        except RuntimeError:
            pass
    finally:
        if mesh is not None:
            try:
                await asyncio.to_thread(mesh.close)
            except Exception:
                logger.exception("Failed to release Face Mesh resources")
        if slot_acquired:
            _analysis_slots.release()
