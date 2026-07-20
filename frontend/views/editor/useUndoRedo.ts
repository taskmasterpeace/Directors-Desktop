import { useRef, useCallback } from 'react'
import type { Asset, TimelineClip, TimelineMarker, Track, SubtitleClip } from '../../types/project'
import { MAX_UNDO_HISTORY, type UndoAction } from './video-editor-utils'

interface UseUndoRedoParams {
  clips: TimelineClip[]
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  tracks: Track[]
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>
  subtitles: SubtitleClip[]
  setSubtitles: React.Dispatch<React.SetStateAction<SubtitleClip[]>>
  markers: TimelineMarker[]
  setMarkers: React.Dispatch<React.SetStateAction<TimelineMarker[]>>
  assets: Asset[]
  currentProjectId: string | null
  deleteAsset: (projectId: string, assetId: string) => void
  addAsset: (projectId: string, asset: Asset) => void
  updateAsset: (projectId: string, assetId: string, updates: Partial<Asset>) => void
  selectedClipIds: Set<string>
  setSelectedClipIds: React.Dispatch<React.SetStateAction<Set<string>>>
  currentTime: number
}

export function useUndoRedo({
  clips,
  setClips,
  tracks,
  setTracks,
  subtitles,
  setSubtitles,
  markers,
  setMarkers,
  assets,
  currentProjectId,
  deleteAsset,
  addAsset,
  updateAsset,
  selectedClipIds,
  setSelectedClipIds,
  currentTime,
}: UseUndoRedoParams) {
  const undoStackRef = useRef<UndoAction[]>([])
  const redoStackRef = useRef<UndoAction[]>([])
  const skipHistoryRef = useRef(false)
  const clipboardRef = useRef<TimelineClip[]>([])

  const pushUndo = useCallback((currentClips?: TimelineClip[]) => {
    const snapshot = currentClips || clips
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)), { type: 'clips', clips: snapshot.map(c => ({ ...c })), markers: markers.map(m => ({ ...m })) }]
    redoStackRef.current = []
  }, [clips, markers])

  const pushAssetUndo = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)), { type: 'assets', assets: assets.map(a => ({ ...a })) }]
    redoStackRef.current = []
  }, [assets])

  const pushTrackUndo = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)), {
      type: 'tracks',
      tracks: tracks.map(t => ({ ...t })),
      clips: clips.map(c => ({ ...c })),
      subtitles: subtitles.map(s => ({ ...s })),
      markers: markers.map(m => ({ ...m })),
    }]
    redoStackRef.current = []
  }, [tracks, clips, subtitles, markers])

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return
    const action = undoStackRef.current.pop()!
    if (action.type === 'clips') {
      redoStackRef.current.push({ type: 'clips', clips: clips.map(c => ({ ...c })), markers: markers.map(m => ({ ...m })) })
      skipHistoryRef.current = true
      setClips(action.clips)
      if (action.markers) setMarkers(action.markers)
      skipHistoryRef.current = false
    } else if (action.type === 'assets' && currentProjectId) {
      redoStackRef.current.push({ type: 'assets', assets: assets.map(a => ({ ...a })) })
      const prevAssets = action.assets
      const prevIds = new Set(prevAssets.map(a => a.id))
      const currentIds = new Set(assets.map(a => a.id))
      assets.filter(a => !prevIds.has(a.id)).forEach(a => deleteAsset(currentProjectId, a.id))
      prevAssets.filter(a => !currentIds.has(a.id)).forEach(a => {
        addAsset(currentProjectId, { ...a })
      })
      prevAssets.filter(a => currentIds.has(a.id)).forEach(a => {
        updateAsset(currentProjectId, a.id, a)
      })
    } else if (action.type === 'tracks') {
      redoStackRef.current.push({
        type: 'tracks',
        tracks: tracks.map(t => ({ ...t })),
        clips: clips.map(c => ({ ...c })),
        subtitles: subtitles.map(s => ({ ...s })),
        markers: markers.map(m => ({ ...m })),
      })
      skipHistoryRef.current = true
      setTracks(action.tracks)
      setClips(action.clips)
      setSubtitles(action.subtitles)
      if (action.markers) setMarkers(action.markers)
      skipHistoryRef.current = false
    }
  }, [clips, tracks, subtitles, markers, assets, currentProjectId, deleteAsset, addAsset, updateAsset, setClips, setTracks, setSubtitles, setMarkers])

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return
    const action = redoStackRef.current.pop()!
    if (action.type === 'clips') {
      undoStackRef.current.push({ type: 'clips', clips: clips.map(c => ({ ...c })), markers: markers.map(m => ({ ...m })) })
      skipHistoryRef.current = true
      setClips(action.clips)
      if (action.markers) setMarkers(action.markers)
      skipHistoryRef.current = false
    } else if (action.type === 'assets' && currentProjectId) {
      undoStackRef.current.push({ type: 'assets', assets: assets.map(a => ({ ...a })) })
      const nextAssets = action.assets
      const nextIds = new Set(nextAssets.map(a => a.id))
      const currentIds = new Set(assets.map(a => a.id))
      assets.filter(a => !nextIds.has(a.id)).forEach(a => deleteAsset(currentProjectId, a.id))
      nextAssets.filter(a => !currentIds.has(a.id)).forEach(a => {
        addAsset(currentProjectId, { ...a })
      })
      nextAssets.filter(a => currentIds.has(a.id)).forEach(a => {
        updateAsset(currentProjectId, a.id, a)
      })
    } else if (action.type === 'tracks') {
      undoStackRef.current.push({
        type: 'tracks',
        tracks: tracks.map(t => ({ ...t })),
        clips: clips.map(c => ({ ...c })),
        subtitles: subtitles.map(s => ({ ...s })),
        markers: markers.map(m => ({ ...m })),
      })
      skipHistoryRef.current = true
      setTracks(action.tracks)
      setClips(action.clips)
      setSubtitles(action.subtitles)
      if (action.markers) setMarkers(action.markers)
      skipHistoryRef.current = false
    }
  }, [clips, tracks, subtitles, markers, assets, currentProjectId, deleteAsset, addAsset, updateAsset, setClips, setTracks, setSubtitles, setMarkers])

  const handleCopy = useCallback(() => {
    if (selectedClipIds.size === 0) return
    clipboardRef.current = clips.filter(c => selectedClipIds.has(c.id)).map(c => ({ ...c }))
  }, [clips, selectedClipIds])

  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return
    pushUndo()
    const earliest = clipboardRef.current.reduce((min, c) => Math.min(min, c.startTime), Infinity)
    const newClips = clipboardRef.current.map(c => ({
      ...c,
      id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      startTime: currentTime + (c.startTime - earliest),
    }))
    setClips(prev => [...prev, ...newClips])
    setSelectedClipIds(new Set(newClips.map(c => c.id)))
  }, [currentTime, pushUndo, setClips, setSelectedClipIds])

  const handleCut = useCallback(() => {
    if (selectedClipIds.size === 0) return
    handleCopy()
    pushUndo()
    setClips(prev => prev.filter(c => !selectedClipIds.has(c.id)))
    setSelectedClipIds(new Set())
  }, [selectedClipIds, handleCopy, pushUndo, setClips, setSelectedClipIds])

  return {
    undoStackRef,
    redoStackRef,
    skipHistoryRef,
    clipboardRef,
    pushUndo,
    pushAssetUndo,
    pushTrackUndo,
    handleUndo,
    handleRedo,
    handleCopy,
    handlePaste,
    handleCut,
  }
}
