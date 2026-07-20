# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportMissingTypeStubs=false, reportArgumentType=false
"""librosa-backed music analysis.

Design notes (clean-room; parameter choices are standard librosa practice):
- Beats/tempo: onset-strength beat tracking.
- Downbeats: librosa has no downbeat tracker; we assume 4/4 and pick the beat
  phase (0..3) whose beats carry the most onset energy. Best-effort by design.
- Sections: agglomerative segmentation over beat-synchronous chroma+MFCC,
  k scaled to song length; labels assigned from energy shape (first=intro,
  last=outro, loudest tercile=chorus, quietest=verse, rest=bridge).
"""

from __future__ import annotations

from pathlib import Path

from .audio_analysis import AudioAnalysis, AudioSection

_SR = 22050
_MIN_SECTIONS = 3
_MAX_SECTIONS = 12
_SECONDS_PER_SECTION = 25.0  # target granularity for k


class AudioAnalyzerImpl:
    def analyze(self, audio_path: str) -> AudioAnalysis:
        import librosa
        import numpy as np

        path = Path(audio_path)
        if not path.is_file():
            raise ValueError(f"Audio file not found: {audio_path}")
        try:
            y, sr = librosa.load(str(path), sr=_SR, mono=True)
        except Exception as exc:
            raise ValueError(f"Could not decode audio: {exc}") from exc
        if y.size == 0:
            raise ValueError("Audio file is empty")

        duration = float(len(y)) / float(sr)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, onset_envelope=onset_env)
        beat_times = [float(t) for t in librosa.frames_to_time(beat_frames, sr=sr)]
        tempo_bpm = float(np.atleast_1d(tempo)[0])

        # Downbeats: strongest of the four 4/4 phases by onset energy at beats.
        downbeats: list[float] = []
        if len(beat_frames) >= 4:
            strengths = onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]
            best_phase = int(np.argmax([float(strengths[p::4].sum()) for p in range(4)]))
            downbeats = beat_times[best_phase::4]

        sections = self._segment(y=y, sr=sr, duration=duration, beat_frames=beat_frames)
        return AudioAnalysis(
            duration=duration,
            tempo_bpm=tempo_bpm,
            beats=beat_times,
            downbeats=downbeats,
            sections=sections,
        )

    def _segment(
        self, *, y: object, sr: float, duration: float, beat_frames: object
    ) -> list[AudioSection]:
        import librosa
        import numpy as np

        k = int(max(_MIN_SECTIONS, min(_MAX_SECTIONS, round(duration / _SECONDS_PER_SECTION))))

        # RMS energy curve for labeling (frame-level, normalized 0..1).
        rms = librosa.feature.rms(y=y)[0]
        rms_max = float(rms.max()) or 1.0
        rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)

        def span_energy(start: float, end: float) -> float:
            mask = (rms_times >= start) & (rms_times < end)
            if not bool(mask.any()):
                return 0.0
            return float(rms[mask].mean()) / rms_max

        bounds_times: list[float]
        try:
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
            mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
            feats = np.vstack([librosa.util.normalize(chroma), librosa.util.normalize(mfcc)])
            bf = np.asarray(beat_frames)
            if bf.size >= k + 1:
                # Beat-synchronous features segment far more musically.
                feats = librosa.util.sync(feats, bf)
                # agglomerative() returns k boundary indices into the feature
                # sequence (beat-sync columns here), the first always 0.
                # Column j spans padded frames fix_frames(bf,0,N)[j]..[j+1],
                # i.e. column j >= 1 STARTS at bf[j-1] — mapping to bf[j]
                # would land every section one beat late.
                bound_beats = librosa.segment.agglomerative(feats, k)
                bound_frames = bf[np.clip(bound_beats[1:] - 1, 0, bf.size - 1)]
            else:
                bounds = librosa.segment.agglomerative(feats, k)
                bound_frames = bounds[1:]
            bounds_times = [float(t) for t in librosa.frames_to_time(bound_frames, sr=sr)]
        except Exception:
            # Segmentation is enhancement, not correctness: fall back to even split.
            step = duration / k
            bounds_times = [step * i for i in range(1, k)]

        edges = sorted(set([0.0] + [t for t in bounds_times if 0.5 < t < duration - 0.5] + [duration]))
        # Sections must be CONTIGUOUS and cover [0, duration]: dropping a short
        # span while keeping both its edges would leave a hole that downstream
        # turns into permanent audio/video desync. Instead, drop interior EDGES
        # that would create a span under 1s (merging it into the previous span).
        kept = [edges[0]]
        for edge in edges[1:-1]:
            if edge - kept[-1] > 1.0:
                kept.append(edge)
        if edges[-1] - kept[-1] <= 1.0 and len(kept) > 1:
            kept.pop()  # final span would be a sliver — merge into the previous
        kept.append(edges[-1])
        spans = [(kept[i], kept[i + 1]) for i in range(len(kept) - 1)]
        if not spans:
            spans = [(0.0, duration)]

        energies = [span_energy(s, e) for s, e in spans]
        order = sorted(range(len(spans)), key=lambda i: energies[i])
        third = max(1, len(spans) // 3)
        quiet = set(order[:third])
        loud = set(order[-third:])

        sections: list[AudioSection] = []
        for i, (start, end) in enumerate(spans):
            if i == 0:
                label = "intro"
            elif i == len(spans) - 1 and len(spans) > 2:
                label = "outro"
            elif i in loud:
                label = "chorus"
            elif i in quiet:
                label = "verse"
            else:
                label = "bridge"
            sections.append(AudioSection(start=start, end=end, label=label, energy=energies[i]))
        return sections
