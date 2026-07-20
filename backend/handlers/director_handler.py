"""Director: the music-video phase machine (clean-room Maestro reimplementation).

analyzing -> generating -> assembling -> complete | error | cancelled

- `step(run_id)` advances exactly one phase-tick synchronously and is
  idempotent — the unit tests drive it directly, the production thread loops
  it. Shots render through the existing job queue's api slot (one at a time,
  same as every other cloud job), so cancel/progress plumbing is shared.
- Crash-resume: the run record persists after every mutation; `resume()`
  re-enters wherever the run stopped, resubmitting shots whose jobs died.
"""

from __future__ import annotations

import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from _routes._errors import HTTPError
from server_utils.shot_planner import plan_shots
from services.audio_analysis import AudioAnalysis, AudioAnalyzer, AudioSection
from services.video_assembler import AssemblyShot, VideoAssembler
from state.director_store import DirectorRun, DirectorStore

if TYPE_CHECKING:
    from state.job_queue import JobQueue

_MAX_SHOT_RETRIES = 1
_STEP_INTERVAL_SECONDS = 1.5


class DirectorHandler:
    def __init__(
        self,
        *,
        store: DirectorStore,
        job_queue: "JobQueue",
        audio_analyzer: AudioAnalyzer,
        video_assembler: VideoAssembler,
        outputs_dir: Path,
        transcribe_fn: Callable[[str], list[dict[str, object]]] | None = None,
        fal_key_check: Callable[[], bool] | None = None,
    ) -> None:
        self._store = store
        self._job_queue = job_queue
        self._analyzer = audio_analyzer
        self._assembler = video_assembler
        self._outputs_dir = outputs_dir
        self._transcribe_fn = transcribe_fn
        self._fal_key_check = fal_key_check
        self._threads: dict[str, threading.Thread] = {}
        self._cancel_flags: set[str] = set()
        self._lock = threading.Lock()

    # ── public API ───────────────────────────────────────────────────────

    def start(
        self,
        *,
        audio_path: str,
        concept: str,
        model: str,
        resolution: str,
        reference_image_paths: list[str] | None = None,
        run_thread: bool = True,
    ) -> DirectorRun:
        if not Path(audio_path).is_file():
            raise HTTPError(400, f"Song file not found: {audio_path}")
        if not concept.strip():
            raise HTTPError(400, "A concept is required — one line about the video's world.")
        if model.startswith("seedance") and self._fal_key_check is not None and not self._fal_key_check():
            raise HTTPError(
                400,
                "FAL_API_KEY_REQUIRED: Seedance renders on fal. Add your fal API key in "
                "Settings before starting a Director run.",
            )
        run = self._store.create_run(
            audio_path=audio_path,
            concept=concept.strip(),
            model=model,
            resolution=resolution,
            reference_image_paths=reference_image_paths,
        )
        if run_thread:
            self._launch_thread(run.id)
        return run

    def resume(self, run_id: str, *, run_thread: bool = True) -> DirectorRun:
        run = self._require_run(run_id)
        if run.phase == "complete":
            return run
        if run.phase in ("error", "cancelled"):
            # Re-enter at the phase implied by progress so far.
            run.error = None
            run.phase = "generating" if (run.analysis is not None and run.shots) else "analyzing"
            for shot in run.shots:
                if shot.result_path is not None:
                    continue
                # A submitted shot's job may still be live (or even done) —
                # resetting it blindly would submit a SECOND paid job.
                if shot.status == "submitted" and shot.job_id:
                    job = self._job_queue.get_job(shot.job_id)
                    if job is not None and job.status in ("queued", "running"):
                        continue  # still rendering — leave it alone
                    if job is not None and job.status == "complete" and job.result_paths:
                        shot.status = "complete"
                        shot.result_path = job.result_paths[0]
                        continue
                if shot.status in ("submitted", "error"):
                    shot.status = "pending"
                    shot.job_id = None
                    shot.error = None
            self._store.save()
        with self._lock:
            self._cancel_flags.discard(run_id)
        if run_thread:
            self._launch_thread(run.id)
        return run

    def cancel(self, run_id: str) -> DirectorRun:
        run = self._require_run(run_id)
        with self._lock:
            self._cancel_flags.add(run_id)
        for shot in run.shots:
            if shot.job_id and shot.status == "submitted":
                self._job_queue.cancel_job(shot.job_id)
        if not run.is_terminal:
            run.phase = "cancelled"
            self._store.save()
        return run

    def status(self, run_id: str | None = None) -> DirectorRun | None:
        if run_id is not None:
            return self._store.get_run(run_id)
        return self._store.latest_run()

    def all_runs(self) -> list[DirectorRun]:
        return self._store.all_runs()

    # ── the machine ──────────────────────────────────────────────────────

    def step(self, run_id: str) -> DirectorRun:
        """Advance one tick. Safe to call repeatedly from any thread."""
        run = self._require_run(run_id)
        if run.is_terminal:
            return run
        if self._is_cancelled(run_id):
            run.phase = "cancelled"
            self._store.save()
            return run
        try:
            if run.phase == "analyzing":
                self._step_analyze(run)
            elif run.phase == "generating":
                self._step_generate(run)
            elif run.phase == "assembling":
                self._step_assemble(run)
        except HTTPError:
            raise
        except Exception as exc:
            run.phase = "error"
            run.error = str(exc)
            self._store.save()
        return run

    def _step_analyze(self, run: DirectorRun) -> None:
        analysis = self._analyzer.analyze(run.audio_path)
        run.analysis = asdict(analysis)
        # Lyrics are an enhancement: transcription failure (no key, network)
        # never blocks the build — prompts just go without the sung words.
        if self._transcribe_fn is not None:
            try:
                run.lyrics = self._transcribe_fn(run.audio_path)
            except Exception:
                run.lyrics = None
        planned = plan_shots(analysis, run.concept, lyrics=run.lyrics)
        if not planned:
            raise RuntimeError("Could not plan any shots from this song")
        from state.director_store import DirectorShot

        run.shots = [
            DirectorShot(
                index=p.index,
                start=p.start,
                end=p.end,
                section_label=p.section_label,
                shot_type=p.shot_type,
                prompt=p.prompt,
                generate_seconds=p.generate_seconds,
            )
            for p in planned
        ]
        run.phase = "generating"
        self._store.save()

    def _step_generate(self, run: DirectorRun) -> None:
        changed = False
        for shot in run.shots:
            # A cancel can land while this loop is submitting — stop paying
            # for new shots the moment the flag is up.
            if self._is_cancelled(run.id):
                break
            if shot.status == "pending":
                params: dict[str, object] = {
                    "prompt": shot.prompt,
                    "duration": str(shot.generate_seconds),
                    "resolution": run.resolution,
                    "audio": "false",
                }
                if run.reference_image_paths:
                    params["referenceImagePaths"] = list(run.reference_image_paths)
                job = self._job_queue.submit(
                    job_type="video",
                    model=run.model,
                    params=params,
                    slot="api",
                    tags=["director", run.id],
                )
                # job_id before status: cancel() scans by status and must never
                # observe "submitted" with the job_id still unset.
                shot.job_id = job.id
                shot.status = "submitted"
                changed = True
            elif shot.status == "submitted" and shot.job_id:
                job = self._job_queue.get_job(shot.job_id)
                if job is None or job.status in ("error", "cancelled"):
                    reason = (job.error if job else None) or "job disappeared"
                    if shot.retries < _MAX_SHOT_RETRIES:
                        shot.retries += 1
                        shot.status = "pending"
                        shot.job_id = None
                    else:
                        shot.status = "error"
                        shot.error = reason
                    changed = True
                elif job.status == "complete":
                    if job.result_paths:
                        shot.status = "complete"
                        shot.result_path = job.result_paths[0]
                    elif shot.retries < _MAX_SHOT_RETRIES:
                        shot.retries += 1
                        shot.status = "pending"
                        shot.job_id = None
                    else:
                        shot.status = "error"
                        shot.error = "job completed with no output"
                    changed = True

        # Closing sweep: if a cancel raced this pass, cancel everything this
        # run has in flight and finish as cancelled (no later tick will run).
        if self._is_cancelled(run.id):
            for shot in run.shots:
                if shot.job_id and shot.status == "submitted":
                    self._job_queue.cancel_job(shot.job_id)
            run.phase = "cancelled"
            self._store.save()
            return

        if any(s.status == "error" for s in run.shots):
            failed = [s.index for s in run.shots if s.status == "error"]
            run.phase = "error"
            run.error = (
                f"Shot(s) {failed} failed after retry. Fix the cause (credits/keys/network) "
                "and resume — completed shots are kept."
            )
            changed = True
        elif run.shots and all(s.status == "complete" for s in run.shots):
            run.phase = "assembling"
            changed = True
        if changed:
            self._store.save()

    def _step_assemble(self, run: DirectorRun) -> None:
        shots = [
            AssemblyShot(video_path=s.result_path or "", duration=max(0.1, s.duration))
            for s in sorted(run.shots, key=lambda s: s.index)
        ]
        output = self._outputs_dir / f"director_{run.id}.mp4"
        self._assembler.assemble(shots=shots, audio_path=run.audio_path, output_path=str(output))
        run.output_path = str(output)
        # If the user cancelled while ffmpeg ran, the acknowledged "cancelled"
        # must not be overwritten by "complete" (the file still exists).
        run.phase = "cancelled" if self._is_cancelled(run.id) else "complete"
        self._store.save()

    # ── background driving ───────────────────────────────────────────────

    def _launch_thread(self, run_id: str) -> None:
        with self._lock:
            existing = self._threads.get(run_id)
            if existing and existing.is_alive():
                return
            thread = threading.Thread(
                target=self._drive, args=(run_id,), daemon=True, name=f"director-{run_id}"
            )
            self._threads[run_id] = thread
            thread.start()

    def _drive(self, run_id: str) -> None:
        while True:
            run = self._store.get_run(run_id)
            if run is None or run.is_terminal:
                return
            self.step(run_id)
            run = self._store.get_run(run_id)
            if run is None or run.is_terminal:
                return
            if run.phase == "generating":
                time.sleep(_STEP_INTERVAL_SECONDS)

    def _is_cancelled(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._cancel_flags

    def _require_run(self, run_id: str) -> DirectorRun:
        run = self._store.get_run(run_id)
        if run is None:
            raise HTTPError(404, f"Unknown director run: {run_id}")
        return run


def _float_list(value: object) -> list[float]:
    if not isinstance(value, list):
        return []
    from typing import cast

    return [float(b) for b in cast(list[object], value) if isinstance(b, (int, float))]


def analysis_from_payload(payload: dict[str, object]) -> AudioAnalysis:
    """Rehydrate a stored analysis dict (asdict output) into the dataclass."""
    from typing import cast

    sections_raw = payload.get("sections")
    sections: list[AudioSection] = []
    if isinstance(sections_raw, list):
        for item in cast(list[object], sections_raw):
            if isinstance(item, dict):
                sections.append(AudioSection(**cast(dict[str, object], item)))  # type: ignore[arg-type]
    duration = payload.get("duration")
    tempo = payload.get("tempo_bpm")
    return AudioAnalysis(
        duration=float(duration) if isinstance(duration, (int, float)) else 0.0,
        tempo_bpm=float(tempo) if isinstance(tempo, (int, float)) else 0.0,
        beats=_float_list(payload.get("beats")),
        downbeats=_float_list(payload.get("downbeats")),
        sections=sections,
    )
