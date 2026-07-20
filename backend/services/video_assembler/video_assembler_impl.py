"""ffmpeg assembly: trim shots to beat length, concat, mux the song.

Three passes, all via the bundled imageio-ffmpeg binary (same pattern as the
retake conform):
1. Normalize each shot — exact -t trim, uniform fps/codec/pixfmt, audio
   stripped — so the concat demuxer is safe across model outputs.
2. Concat the normalized clips (stream copy).
3. Mux the original song as the only audio track, -shortest.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from .video_assembler import AssemblyShot

_FPS = 24
_PER_CLIP_TIMEOUT = 300
_CONCAT_TIMEOUT = 600


def _ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return str(imageio_ffmpeg.get_ffmpeg_exe())


def _run(args: list[str], timeout: int) -> None:
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if result.returncode != 0:
        tail = result.stderr.decode(errors="replace")[-800:]
        raise RuntimeError(f"ffmpeg failed ({result.returncode}): {tail}")


class VideoAssemblerImpl:
    def assemble(self, *, shots: list[AssemblyShot], audio_path: str, output_path: str) -> None:
        if not shots:
            raise RuntimeError("Nothing to assemble: no shots")
        if not Path(audio_path).is_file():
            raise RuntimeError(f"Song file not found: {audio_path}")
        for shot in shots:
            if not Path(shot.video_path).is_file():
                raise RuntimeError(f"Shot file missing: {shot.video_path}")

        exe = _ffmpeg_exe()
        workdir = Path(tempfile.mkdtemp(prefix="director_assemble_"))
        try:
            normalized: list[Path] = []
            for i, shot in enumerate(shots):
                norm = workdir / f"norm_{i:03d}.mp4"
                _run(
                    [
                        exe, "-y",
                        "-i", shot.video_path,
                        "-t", f"{max(0.1, shot.duration):.3f}",
                        "-r", str(_FPS),
                        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                        "-pix_fmt", "yuv420p",
                        "-an",
                        str(norm),
                    ],
                    timeout=_PER_CLIP_TIMEOUT,
                )
                normalized.append(norm)

            concat_list = workdir / "concat.txt"
            # ffmpeg concat-demuxer quoting: a single quote inside a quoted
            # string is written as '\'' (close, escaped quote, reopen). Without
            # this, any temp path containing an apostrophe (e.g. a Windows
            # user named O'Brien) kills every assembly.
            def _quoted(p: Path) -> str:
                return "'" + p.as_posix().replace("'", "'\\''") + "'"

            concat_list.write_text(
                "".join(f"file {_quoted(p)}\n" for p in normalized), encoding="utf-8"
            )
            silent = workdir / "silent.mp4"
            _run(
                [exe, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list), "-c", "copy", str(silent)],
                timeout=_CONCAT_TIMEOUT,
            )

            out = Path(output_path)
            out.parent.mkdir(parents=True, exist_ok=True)
            _run(
                [
                    exe, "-y",
                    "-i", str(silent),
                    "-i", audio_path,
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest",
                    str(out),
                ],
                timeout=_CONCAT_TIMEOUT,
            )
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
