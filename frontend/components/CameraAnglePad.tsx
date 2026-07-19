import { useCallback, useRef } from 'react'
import {
  CAMERA_PRESETS,
  DEFAULT_CAMERA_ANGLE,
  getCameraAngleDescription,
  type CameraAngle,
} from '../lib/shot-creator/camera-angle'

/**
 * Visual camera-angle control for the Camera Angle model.
 *
 * The pad is a top-down view of the camera orbiting the subject: the angle
 * around the centre is azimuth, the distance from the centre is how close the
 * camera is. Elevation (tilt) is the slider underneath. These are the same
 * three values Palette's 3D gizmo drives, and they go straight to
 * /api/v2/images/camera-angle, which builds the `<sks>` prompt server-side.
 */
export function CameraAnglePad({
  angle,
  onChange,
}: {
  angle: CameraAngle
  onChange: (angle: CameraAngle) => void
}) {
  const padRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Pad geometry: subject at the centre, camera dot orbiting it.
  const SIZE = 132
  const CENTRE = SIZE / 2
  const MAX_R = CENTRE - 14

  // distance 0 (wide) sits at the rim, 10 (close-up) hugs the subject.
  const radius = MAX_R - (angle.distance / 10) * (MAX_R - 16)
  // 0° = front (below the subject, facing the viewer), sweeping clockwise.
  const rad = ((angle.azimuth - 90) * Math.PI) / 180
  const dotX = CENTRE + radius * Math.cos(rad)
  const dotY = CENTRE + radius * Math.sin(rad)

  const applyFromPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = padRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = clientX - rect.left - CENTRE
      const y = clientY - rect.top - CENTRE
      const azimuth = (((Math.atan2(y, x) * 180) / Math.PI + 90) % 360 + 360) % 360
      const r = Math.min(MAX_R, Math.max(16, Math.hypot(x, y)))
      // invert the radius→distance mapping above
      const distance = ((MAX_R - r) / (MAX_R - 16)) * 10
      onChange({
        ...angle,
        azimuth: Math.round(azimuth),
        distance: Math.round(distance * 10) / 10,
      })
    },
    [angle, onChange, CENTRE, MAX_R],
  )

  return (
    <div className="flex flex-col gap-2.5 w-[188px]">
      <div
        ref={padRef}
        role="application"
        aria-label="Camera angle"
        className="relative mx-auto rounded-full bg-zinc-900 border border-zinc-700 cursor-crosshair select-none"
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={(e) => {
          draggingRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          applyFromPoint(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) applyFromPoint(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          draggingRef.current = false
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
      >
        {/* orbit guide rings */}
        <div
          className="absolute rounded-full border border-dashed border-zinc-700/70"
          style={{ inset: 14 }}
        />
        {/* the subject */}
        <div
          className="absolute rounded-full bg-zinc-600"
          style={{ width: 12, height: 12, left: CENTRE - 6, top: CENTRE - 6 }}
        />
        {/* sight line from camera to subject */}
        <svg className="absolute inset-0 pointer-events-none" width={SIZE} height={SIZE}>
          <line
            x1={dotX}
            y1={dotY}
            x2={CENTRE}
            y2={CENTRE}
            stroke="currentColor"
            className="text-amber-500/50"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        </svg>
        {/* the camera */}
        <div
          className="absolute rounded-full bg-amber-400 ring-2 ring-amber-400/25 pointer-events-none"
          style={{ width: 11, height: 11, left: dotX - 5.5, top: dotY - 5.5 }}
        />
        <span className="absolute left-1/2 -translate-x-1/2 bottom-1 text-[9px] text-zinc-600">front</span>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-400 w-8 shrink-0">Tilt</span>
        <input
          type="range"
          min={-30}
          max={60}
          value={angle.elevation}
          onChange={(e) => onChange({ ...angle, elevation: Number(e.target.value) })}
          className="flex-1 h-1 accent-amber-500"
        />
        <span className="text-[10px] text-zinc-300 w-7 text-right">{angle.elevation}°</span>
      </label>

      <p className="text-[10px] text-zinc-400 leading-snug">{getCameraAngleDescription(angle)}</p>

      <div className="flex flex-wrap gap-1">
        {CAMERA_PRESETS.map((preset) => (
          <button
            key={preset.name}
            onClick={() => onChange({ ...preset.angle })}
            className="px-1.5 py-0.5 rounded text-[10px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            {preset.name}
          </button>
        ))}
        <button
          onClick={() => onChange({ ...DEFAULT_CAMERA_ANGLE })}
          className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  )
}
