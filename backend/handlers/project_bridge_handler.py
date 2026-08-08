"""Agent bridge: mirror of the renderer's project read-model + bounded action queue.

The renderer is the source of truth. It publishes a full project snapshot on
every debounced autosave; agents (Claude Code, via the agent-bridge.json
discovery file) read the mirror and submit bounded actions. The renderer polls
for pending actions, applies them through its undo stack, and reports
per-action status. This handler never mutates the project itself.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import cast

from _routes._errors import HTTPError

logger = logging.getLogger(__name__)

# The renderer autosaves roughly once a second while the editor is open. If the
# newest snapshot is older than this, treat the editor as not live so an agent
# doesn't edit a stale project it can no longer see the user working in.
EDITOR_LIVE_MAX_AGE_SECONDS = 5.0

MAX_ACTIONS_KEPT = 200
# Absolute ceiling regardless of status. Reached only if the renderer stops
# reporting entirely (editor closed), so crossing it is worth a warning.
MAX_ACTIONS_HARD = 1000

REPORTABLE_STATUSES = ("applied", "rejected")


def _dicts(value: object) -> list[dict[str, object]]:
    """Narrow arbitrary JSON to a list of dicts (non-dicts dropped)."""
    if not isinstance(value, list):
        return []
    items = cast(list[object], value)
    return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]


def _num(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    return default


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _to_local_path(src_url: str) -> str | None:
    """A filesystem path for a ``file://`` URL or a plain local path; ``None``
    for a remote http(s) source. Mirrors the renderer's ``fileUrlToPath``."""
    if src_url.startswith("file://"):
        from urllib.parse import unquote

        p = unquote(src_url[7:])  # file:///Users/x -> /Users/x
        if len(p) >= 3 and p[0] == "/" and p[1].isalpha() and p[2] == ":":
            p = p[1:]  # Windows: /C:/x -> C:/x
        return p
    if src_url.startswith(("http://", "https://")):
        return None
    return src_url


def _ffmpeg_exe() -> str | None:
    """Path to an ffmpeg binary: the bundled imageio-ffmpeg build first (reliable
    inside the packaged app), otherwise whatever is on PATH; ``None`` if neither
    exists so the caller can degrade gracefully."""
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe:
            return exe
    except Exception:
        pass
    import shutil

    return shutil.which("ffmpeg")


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


class ProjectBridgeHandler:
    def __init__(self, persistence_path: Path) -> None:
        self._lock = threading.RLock()
        self._persistence_path = persistence_path
        self._snapshot: dict[str, object] | None = None
        self._published_at: float | None = None
        self._actions: list[dict[str, object]] = []
        self._load_last_good()

    def _load_last_good(self) -> None:
        try:
            if not self._persistence_path.is_file():
                return
            raw = json.loads(self._persistence_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                stored = cast(dict[str, object], raw)
                project = stored.get("project")
                if isinstance(project, dict):
                    self._snapshot = cast(dict[str, object], project)
                    self._published_at = _num(stored.get("publishedAt")) or None
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            # Corrupt or unreadable mirror — start empty; next publish rewrites it.
            self._snapshot = None

    def publish(self, project: dict[str, object]) -> float:
        with self._lock:
            # Timestamp inside the lock: overlapping publishes commit in lock
            # order, so publishedAt never moves backwards.
            published_at = time.time()
            # Deep-copy to sever the snapshot from the caller's dict. The route
            # currently hands over a freshly deserialised body, so aliasing is
            # latent today — but a future in-process caller mutating what it
            # published (or a reader mutating current()) would silently corrupt
            # the mirror. The copy makes the store own its state unconditionally.
            self._snapshot = copy.deepcopy(project)
            self._published_at = published_at
            try:
                self._persistence_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self._persistence_path.with_suffix(".tmp")
                tmp.write_text(
                    json.dumps({"project": project, "publishedAt": published_at}),
                    encoding="utf-8",
                )
                os.replace(tmp, self._persistence_path)
            except OSError:
                pass  # Disk mirror is best-effort; the in-memory copy is authoritative.
        return published_at

    def current(self) -> tuple[dict[str, object] | None, float | None]:
        with self._lock:
            return self._snapshot, self._published_at

    def is_editor_live(self, now: float | None = None) -> bool:
        """Whether the editor is actively publishing (snapshot is fresh).

        The read-model previously exposed only publishedAt, leaving an agent to
        guess whether the user is still in the editor. A stale snapshot means
        edits queued through the bridge may never be seen or applied.
        """
        with self._lock:
            if self._published_at is None:
                return False
            reference = now if now is not None else time.time()
            return (reference - self._published_at) < EDITOR_LIVE_MAX_AGE_SECONDS

    # ── Derived read-model views ──────────────────────────────────────────

    def story(self) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        snapshot, _ = self.current()
        if snapshot is None:
            return [], []
        return _dicts(snapshot.get("storyDocs")), _dicts(snapshot.get("cast"))

    def live_transcript(self) -> list[dict[str, object]]:
        """The stitched transcript of the current cut, in timeline seconds.

        Word times persist on assets in SOURCE-media seconds; here each active
        clip's window is mapped through trimStart/speed/startTime — the same
        mapping the renderer uses — so the agent reads the cut as it stands.
        """
        snapshot, _ = self.current()
        if snapshot is None:
            return []

        assets_by_id: dict[str, dict[str, object]] = {}
        for asset in _dicts(snapshot.get("assets")):
            asset_id = _str_or_none(asset.get("id"))
            if asset_id is not None:
                assets_by_id[asset_id] = asset

        timelines = _dicts(snapshot.get("timelines"))
        active_id = snapshot.get("activeTimelineId")
        timeline = next((t for t in timelines if t.get("id") == active_id), None)
        if timeline is None and timelines:
            timeline = timelines[0]
        if timeline is None:
            return []

        clips = sorted(_dicts(timeline.get("clips")), key=lambda c: _num(c.get("startTime")))
        out: list[dict[str, object]] = []
        for clip in clips:
            asset_id = _str_or_none(clip.get("assetId"))
            if asset_id is None:
                embedded = clip.get("asset")
                if isinstance(embedded, dict):
                    asset_id = _str_or_none(cast(dict[str, object], embedded).get("id"))
            asset = assets_by_id.get(asset_id) if asset_id is not None else None
            if asset is None:
                continue
            transcript = asset.get("transcript")
            if not isinstance(transcript, dict):
                continue
            words = _dicts(cast(dict[str, object], transcript).get("words"))
            if not words:
                continue

            start_time = _num(clip.get("startTime"))
            trim_start = _num(clip.get("trimStart"))
            duration = _num(clip.get("duration"))
            speed = _num(clip.get("speed"), 1.0) or 1.0
            src_end = trim_start + duration * speed
            clip_id = _str_or_none(clip.get("id"))

            for word in words:
                w_start = _num(word.get("start"))
                w_end = _num(word.get("end"))
                if w_end <= trim_start or w_start >= src_end:
                    continue
                mapped_start = start_time + (max(w_start, trim_start) - trim_start) / speed
                mapped_end = start_time + (min(w_end, src_end) - trim_start) / speed
                entry: dict[str, object] = {
                    "text": word.get("text"),
                    "start": round(mapped_start, 4),
                    "end": round(mapped_end, 4),
                }
                if clip_id is not None:
                    entry["clipId"] = clip_id
                out.append(entry)
        return out

    # ── Perception (look at a clip) ───────────────────────────────────────

    def resolve_clip_frame(self, clip_id: str) -> tuple[str, bool]:
        """Resolve a clip id to a LOCAL image path so a caption model can SEE it.

        Mirrors the renderer's resolve logic (``clip.importedUrl || asset.url``;
        strip ``file://`` to a filesystem path). A still image already on disk is
        used directly; a video (or a remote source) has one representative frame
        extracted server-side with ffmpeg.

        Returns ``(path, is_temp)`` — when ``is_temp`` is True the caller must
        delete the file after use. Raises :class:`HTTPError` with a clear,
        user-facing message on any failure (no project, unknown clip, no source,
        or extraction impossible).
        """
        snapshot, _ = self.current()
        if snapshot is None:
            raise HTTPError(404, "no project published — open a project in the editor first")

        timelines = _dicts(snapshot.get("timelines"))
        active_id = snapshot.get("activeTimelineId")
        timeline = next((t for t in timelines if t.get("id") == active_id), None)
        if timeline is None and timelines:
            timeline = timelines[0]
        if timeline is None:
            raise HTTPError(404, "the project has no timeline")

        clip = next(
            (c for c in _dicts(timeline.get("clips")) if _str_or_none(c.get("id")) == clip_id),
            None,
        )
        if clip is None:
            raise HTTPError(404, f"no clip {clip_id} on the active timeline")

        asset: dict[str, object] | None = None
        asset_id = _str_or_none(clip.get("assetId"))
        if asset_id is not None:
            asset = next(
                (a for a in _dicts(snapshot.get("assets")) if _str_or_none(a.get("id")) == asset_id),
                None,
            )
        else:
            embedded = clip.get("asset")
            if isinstance(embedded, dict):
                asset = cast(dict[str, object], embedded)

        src_url = _str_or_none(clip.get("importedUrl"))
        if src_url is None and asset is not None:
            src_url = _str_or_none(asset.get("url"))
        if not src_url:
            raise HTTPError(422, f"clip {clip_id} has no source media to look at")

        local_path = _to_local_path(src_url)
        is_video = _str_or_none(clip.get("type")) == "video"

        # A still image already on disk needs no extraction — caption it as-is.
        if not is_video and local_path and os.path.isfile(local_path):
            return local_path, False

        # Otherwise extract one frame with ffmpeg (covers video and remote sources).
        ffmpeg = _ffmpeg_exe()
        if ffmpeg is None:
            raise HTTPError(
                422,
                "can't extract a frame to look at — ffmpeg is not available on this machine",
            )

        if is_video:
            trim_start = _num(clip.get("trimStart"))
            duration = _num(clip.get("duration"), 2.0)
            seek = trim_start + min(1.0, duration / 2)
        else:
            seek = 0.0

        source = local_path or src_url
        fd, out_path = tempfile.mkstemp(prefix="dd_lookat_", suffix=".jpg")
        os.close(fd)
        cmd = [ffmpeg, "-y", "-ss", str(seek), "-i", source, "-frames:v", "1", "-q:v", "3", out_path]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=90)
        except Exception as exc:  # timeout, OS error, ffmpeg vanished mid-run
            _safe_remove(out_path)
            raise HTTPError(422, f"couldn't extract a frame from clip {clip_id}: {exc}") from exc
        if result.returncode != 0 or not (os.path.isfile(out_path) and os.path.getsize(out_path) > 0):
            _safe_remove(out_path)
            raise HTTPError(422, f"couldn't extract a frame from clip {clip_id} (media unreadable?)")
        return out_path, True

    # ── Action queue ──────────────────────────────────────────────────────

    def submit_actions(self, actions: list[dict[str, object]]) -> list[str]:
        ids: list[str] = []
        now = time.time()
        with self._lock:
            for action in actions:
                action_id = f"act_{uuid.uuid4().hex[:12]}"
                ids.append(action_id)
                self._actions.append({
                    "id": action_id,
                    "action": action,
                    "status": "queued",
                    "reason": None,
                    "createdAt": now,
                })
            excess = len(self._actions) - MAX_ACTIONS_KEPT
            if excess > 0:
                # Evict oldest FINISHED records only — a queued/delivered action
                # (e.g. a generate_and_place still rendering) must survive so
                # its late report and status stay addressable.
                kept: list[dict[str, object]] = []
                for record in self._actions:
                    if excess > 0 and record.get("status") in ("applied", "rejected"):
                        excess -= 1
                        continue
                    kept.append(record)
                self._actions = kept

            # Hard ceiling: if the renderer never reports (editor closed mid-run),
            # nothing is ever "finished", so the finished-only eviction above frees
            # nothing and the list grew unbounded past MAX_ACTIONS_KEPT. Beyond the
            # hard cap, shed oldest DELIVERED records (already handed over — a late
            # report is unlikely) before ever touching still-queued ones.
            over_hard = len(self._actions) - MAX_ACTIONS_HARD
            if over_hard > 0:
                logger.warning(
                    "Bridge action queue past hard cap (%d) — renderer not reporting; "
                    "dropping %d oldest delivered/queued records",
                    MAX_ACTIONS_HARD, over_hard,
                )
                for status in ("delivered", "queued"):
                    if over_hard <= 0:
                        break
                    survivors: list[dict[str, object]] = []
                    for record in self._actions:
                        if over_hard > 0 and record.get("status") == status:
                            over_hard -= 1
                            continue
                        survivors.append(record)
                    self._actions = survivors
        return ids

    def pending_actions(self) -> list[dict[str, object]]:
        """Queued actions, delivered exactly once (re-polls don't double-apply)."""
        with self._lock:
            delivered: list[dict[str, object]] = []
            for record in self._actions:
                if record.get("status") == "queued":
                    record["status"] = "delivered"
                    delivered.append({"id": record["id"], "action": record["action"]})
            return delivered

    def report_results(self, results: list[dict[str, object]]) -> int:
        """Renderer reports per-action outcomes. Unknown ids are ignored (stale)."""
        updated = 0
        with self._lock:
            by_id = {record.get("id"): record for record in self._actions}
            for result in results:
                record = by_id.get(result.get("id"))
                status = result.get("status")
                if record is None or status not in REPORTABLE_STATUSES:
                    continue
                record["status"] = status
                record["reason"] = _str_or_none(result.get("reason"))
                updated += 1
        return updated

    def action_statuses(self) -> list[dict[str, object]]:
        with self._lock:
            out: list[dict[str, object]] = []
            for record in reversed(self._actions):
                action = record.get("action")
                kind = cast(dict[str, object], action).get("kind") if isinstance(action, dict) else None
                out.append({
                    "id": record.get("id"),
                    "kind": kind,
                    "status": record.get("status"),
                    "reason": record.get("reason"),
                    "createdAt": record.get("createdAt"),
                })
            return out
