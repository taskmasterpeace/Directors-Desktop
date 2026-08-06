import { useState, useRef, useEffect } from 'react'
import { Sparkles, Trash2, Square, ImageIcon, ArrowLeft, Scissors, Wand2, ListPlus, Pencil, ClipboardPaste } from 'lucide-react'
import { logger } from '../lib/logger'
import { ImageUploader } from '../components/ImageUploader'
import { AudioUploader } from '../components/AudioUploader'
import { VideoPlayer } from '../components/VideoPlayer'
import { ImageResult } from '../components/ImageResult'
import { FrameSlot } from '../components/FrameSlot'
import { SettingsPanel, type GenerationSettings } from '../components/SettingsPanel'
import { QuickModeToggles, applyQuickMode } from '../components/QuickModeToggles'
import type { QuickModeKind } from '../lib/shot-creator/quick-modes'
import { ModeTabs, type GenerationMode } from '../components/ModeTabs'
import { LtxLogo } from '../components/LtxLogo'
import { ModelStatusDropdown } from '../components/ModelStatusDropdown'
import { ModelWarmthPill } from '../components/ModelWarmthPill'
import { PlaygroundQueueStrip } from '../components/PlaygroundQueueStrip'
import { EnhanceDirectorModal } from '../components/EnhanceDirectorModal'
import {
  estimateRenderSeconds,
  estimateTotalSeconds,
  formatDuration,
  resolveLocalSize,
  MODEL_LOAD_SECONDS,
} from '../lib/generation-cost'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import { useGeneration, type QueueJob } from '../hooks/use-generation'
import { useRetake } from '../hooks/use-retake'
import { useBackend } from '../hooks/use-backend'
import { useProjects } from '../contexts/ProjectContext'
import { useAppSettings } from '../contexts/AppSettingsContext'
import { ReferencePicker } from '../components/ReferencePicker'
import { RecipePicker, insertAtCaret } from '../components/RecipePicker'
import { AtAutocompleteDropdown } from '../components/AtAutocompleteDropdown'
import { useAtCaretAutocomplete } from '../hooks/useAtCaretAutocomplete'
import { useMentionOptions } from '../hooks/useMentionOptions'
import { fileUrlToPath } from '../lib/url-to-path'
import { conditioningConflictMessage, getVideoModel } from '../lib/video-models'
import { sanitizeForcedApiVideoSettings } from '../lib/api-video-options'
import { RetakePanel } from '../components/RetakePanel'

/** Ownership label for queue jobs from this surface (Gallery grouping). */
const PLAYGROUND_TAGS = { tags: ['playground'] }

const DEFAULT_SETTINGS: GenerationSettings = {
  model: 'h3-local',
  duration: 5,
  videoResolution: '480p',
  fps: 24,
  audio: true,
  cameraMotion: 'none',
  aspectRatio: '16:9',
  // Image settings
  imageResolution: '1080p',
  imageAspectRatio: '16:9',
  imageSteps: 4,
}

export function Playground() {
  const { goHome, pendingClipReference, setPendingClipReference, pendingAnimateImage, setPendingAnimateImage, pendingRemix, setPendingRemix } = useProjects()
  const { settings: appSettings, forceApiGenerations, shouldVideoGenerateWithLtxApi, credits } = useAppSettings()
  const [mode, setMode] = useState<GenerationMode>('text-to-video')
  const [prompt, setPrompt] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const mentionOptions = useMentionOptions()
  const atAutocomplete = useAtCaretAutocomplete({
    textareaRef: promptRef,
    onChange: setPrompt,
    options: mentionOptions,
  })
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null)
  const [settings, setSettings] = useState<GenerationSettings>(() => ({ ...DEFAULT_SETTINGS }))
  // Queue work surface: the pending job being edited, and the image-mode
  // "then animate the result" chain toggle.
  const [editingJob, setEditingJob] = useState<QueueJob | null>(null)
  const [thenAnimate, setThenAnimate] = useState(false)
  const [showEnhanceDirector, setShowEnhanceDirector] = useState(false)

  // Esc backs out of edit-before-render without touching the pending job.
  useEffect(() => {
    if (!editingJob) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditingJob(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingJob])
  const [firstFrameUrl, setFirstFrameUrl] = useState<string | null>(null)
  const [firstFramePath, setFirstFramePath] = useState<string | null>(null)
  const [lastFrameUrl, setLastFrameUrl] = useState<string | null>(null)
  const [lastFramePath, setLastFramePath] = useState<string | null>(null)
  const [isEnhancing, setIsEnhancing] = useState(false)
  // Preflight problems we catch before submitting (e.g. references that would
  // be silently dropped) — rendered in the same slot as generation errors.
  const [preflightError, setPreflightError] = useState<string | null>(null)
  // Snapshot of the exact-length request taken at submit, so the placeholder
  // badge describes the RUNNING job even if settings change mid-flight.
  const [activeReservedSeconds, setActiveReservedSeconds] = useState<number | null>(null)

  const { status, processStatus } = useBackend()

  useEffect(() => {
    if (!shouldVideoGenerateWithLtxApi || mode === 'text-to-image') return
    setSettings((prev) => sanitizeForcedApiVideoSettings({ ...prev, model: 'fast' }))
  }, [mode, shouldVideoGenerateWithLtxApi])

  // Animate-still handoff (Shot Animator flow): a still image arrives from the
  // editor/gallery preloaded as the image-to-video start frame on Seedance 2.0;
  // the user writes the motion direction. When generations are forced through
  // the LTX API, Seedance isn't selectable — the still animates via the LTX
  // API instead of fighting the sanitizer.
  useEffect(() => {
    if (!pendingAnimateImage) return
    const { url, prompt: seedPrompt } = pendingAnimateImage
    setPendingAnimateImage(null)
    setMode('image-to-video')
    setSelectedImage(url)
    if (!shouldVideoGenerateWithLtxApi) {
      setSettings((prev) => ({ ...prev, model: 'seedance-2.0' }))
    }
    if (seedPrompt) setPrompt(seedPrompt)
    requestAnimationFrame(() => promptRef.current?.focus())
  }, [pendingAnimateImage, setPendingAnimateImage, shouldVideoGenerateWithLtxApi])

  // #78: a Gallery Remix lands here with the original prompt preloaded.
  useEffect(() => {
    if (!pendingRemix) return
    setMode('text-to-image')
    setPrompt(pendingRemix.prompt)
    setPendingRemix(null)
  }, [pendingRemix, setPendingRemix])

  // Clip Tool handoff: attach a freshly trimmed clip as a Seedance 2.0 video
  // reference and seed the prompt so the user describes the changes they want.
  // Video references only exist on Seedance 2.0 — under forced-LTX-API mode the
  // sanitizer would strip the model and the reference would be silently dropped
  // at submit, so refuse loudly instead of attaching something that can't work.
  useEffect(() => {
    if (!pendingClipReference) return
    const clipPath = pendingClipReference.path
    setPendingClipReference(null)
    if (shouldVideoGenerateWithLtxApi) {
      setPreflightError(
        'Video references need Seedance 2.0, which is unavailable while generations are forced through the LTX API. The clip was not attached.',
      )
      return
    }
    setMode('text-to-video')
    setSettings((prev) => ({
      ...prev,
      model: 'seedance-2.0',
      videoReferencePaths: [clipPath],
    }))
    setPrompt((prev) => (prev.includes('@Video1') ? prev : `@Video1 ${prev}`.trimEnd() + ' '))
    requestAnimationFrame(() => promptRef.current?.focus())
  }, [pendingClipReference, setPendingClipReference, shouldVideoGenerateWithLtxApi])

  // Force pro model + resolution when audio is attached (A2V only supports pro @ 1080p 16:9)
  useEffect(() => {
    if (selectedAudio && mode !== 'text-to-image') {
      setSettings(prev => {
        if (shouldVideoGenerateWithLtxApi) {
          return sanitizeForcedApiVideoSettings({ ...prev, model: 'pro' }, { hasAudio: true })
        }
        return prev.model !== 'pro' ? { ...prev, model: 'pro' } : prev
      })
    }
  }, [mode, selectedAudio, shouldVideoGenerateWithLtxApi]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle mode change
  const handleModeChange = (newMode: GenerationMode) => {
    setMode(newMode)
  }
  const {
    isGenerating,
    progress,
    statusMessage,
    elapsedSeconds,
    estimatedSeconds,
    videoUrl,
    videoPath,
    imageUrl,
    error: generationError,
    generate,
    generateImage,
    cancel,
    reset,
    lastModel,
    activeModel,
    coldStart,
  } = useGeneration()

  const {
    submitRetake,
    resetRetake,
    isRetaking,
    retakeStatus,
    retakeError,
    retakeResult,
  } = useRetake()

  const [retakeInput, setRetakeInput] = useState({
    videoUrl: null as string | null,
    videoPath: null as string | null,
    startTime: 0,
    duration: 0,
    videoDuration: 0,
    ready: false,
  })
  const [retakePanelKey, setRetakePanelKey] = useState(0)
  
  // Ref to store generated image URL for "Create video" flow
  const generatedImageRef = useRef<string | null>(null)

  const handleEnhancePrompt = async () => {
    if (isEnhancing) return
    // Video modes get the director's flow: analyze -> pick a direction ->
    // four visible takes (H3 craft baked in server-side). Image mode keeps
    // the classic one-shot enhance.
    if (mode !== 'text-to-image' && !isRetakeMode) {
      setShowEnhanceDirector(true)
      return
    }
    setIsEnhancing(true)
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          mode,
          model: settings.model,
          imagePath: selectedImage ? selectedImage.replace(/^file:\/\/\/?/, '').replace(/\//g, '\\') : null,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.enhancedPrompt) setPrompt(data.enhancedPrompt)
      }
    } catch (err) {
      logger.error(`Failed to enhance prompt: ${err}`)
    } finally {
      setIsEnhancing(false)
    }
  }

  // Armed quick mode (Wardrobe/Character/Location/Style) — applied silently at Generate.
  const [activeQuickMode, setActiveQuickMode] = useState<QuickModeKind | null>(null)

  const addQuickModePhotos = async () => {
    try {
      const files = await window.electronAPI.showOpenFileDialog({
        title: 'Add reference photo(s)',
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
        properties: ['openFile', 'multiSelections'],
      })
      if (!files || files.length === 0) return
      setSettings((prev) => ({
        ...prev,
        referenceImagePaths: [...(prev.referenceImagePaths ?? []), ...files],
      }))
    } catch { /* cancelled */ }
  }

  const handleGenerate = () => {
    if (mode === 'retake') {
      if (!retakeInput.videoPath || retakeInput.duration < 2) return
      submitRetake({
        videoPath: retakeInput.videoPath,
        startTime: retakeInput.startTime,
        duration: retakeInput.duration,
        prompt,
        mode: 'replace_audio_and_video',
      })
      return
    }

    if (mode === 'text-to-image') {
      const photos = settings.referenceImagePaths ?? []
      if (activeQuickMode) {
        if (photos.length === 0) return // toggle row shows the attach hint
        const imageOpts = {
          ...PLAYGROUND_TAGS,
          ...(thenAnimate
            ? {
                thenAnimate: {
                  model: String(settings.model),
                  duration: settings.duration,
                  resolution: settings.videoResolution,
                  aspectRatio: settings.aspectRatio || '16:9',
                },
              }
            : {}),
        }
        const applied = applyQuickMode(activeQuickMode, prompt, photos)
        generateImage(applied.prompt, {
          ...settings,
          imageModel: applied.imageModel,
          imageAspectRatio: applied.imageAspectRatio,
          imageModelParams: applied.imageModelParams,
          referenceImagePaths: applied.referenceImagePaths,
        }, imageOpts)
        return
      }
      if (!prompt.trim()) return
      generateImage(prompt, settings, {
        ...PLAYGROUND_TAGS,
        ...(thenAnimate
          ? {
              thenAnimate: {
                model: String(settings.model),
                duration: settings.duration,
                resolution: settings.videoResolution,
                aspectRatio: settings.aspectRatio || '16:9',
              },
            }
          : {}),
      })
    } else {
      const effectiveVideoSettings = shouldVideoGenerateWithLtxApi
        ? sanitizeForcedApiVideoSettings(settings)
        : settings
      if (!prompt.trim()) return
      // Never silently drop attached video references: if sanitizing stripped
      // the Seedance model they require, refuse instead of paying for a
      // generation the user didn't ask for.
      const hasVideoRefs = (settings.videoReferencePaths?.length ?? 0) > 0
      const isSeedance2Model =
        effectiveVideoSettings.model === 'seedance-2.0' || effectiveVideoSettings.model === 'seedance-2.0-fast'
      if (hasVideoRefs && !isSeedance2Model) {
        setPreflightError(
          'Video references require Seedance 2.0. Switch the model to Seedance 2.0 (or remove the @Video reference) and generate again.',
        )
        return
      }
      setPreflightError(null)
      const imagePath = selectedImage ? fileUrlToPath(selectedImage) : (firstFramePath || null)
      const audioPath = selectedAudio ? fileUrlToPath(selectedAudio) : null
      if (audioPath) effectiveVideoSettings.model = 'pro'
      setActiveReservedSeconds(settings.exactDuration ? settings.duration : null)
      generate(prompt, imagePath, effectiveVideoSettings, audioPath, lastFramePath, PLAYGROUND_TAGS)
    }
  }
  
  // Handle "Extend video" — extract last frame, set as first frame for next gen
  const handleExtendVideo = (frameUrl: string, framePath: string) => {
    setFirstFrameUrl(frameUrl)
    setFirstFramePath(framePath)
    setSelectedImage(null) // Clear manual image upload so first frame takes priority
    setPrompt('') // Clear prompt so user writes what happens next
    reset() // Clear previous generation result
    if (mode !== 'text-to-video' && mode !== 'image-to-video') {
      setMode('text-to-video')
    }
  }

  // Handle "Create video" from generated image
  const handleCreateVideoFromImage = () => {
    if (!imageUrl) {
      logger.error('No image URL available')
      return
    }

    // imageUrl is already a file:// URL — just pass it as the selected image path
    setSelectedImage(imageUrl)
    setMode('image-to-video')
    generatedImageRef.current = imageUrl
  }

  const handleClearAll = () => {
    setPrompt('')
    setPreflightError(null)
    setActiveReservedSeconds(null)
    setSelectedImage(null)
    setSelectedAudio(null)
    setFirstFrameUrl(null)
    setFirstFramePath(null)
    setLastFrameUrl(null)
    setLastFramePath(null)
    const baseDefaults = { ...DEFAULT_SETTINGS }
    const shouldSanitizeVideoSettings = shouldVideoGenerateWithLtxApi && mode !== 'text-to-image'
    setSettings(shouldSanitizeVideoSettings ? sanitizeForcedApiVideoSettings(baseDefaults) : baseDefaults)
    if (mode !== 'text-to-image') setMode('text-to-video')
    setRetakeInput({
      videoUrl: null,
      videoPath: null,
      startTime: 0,
      duration: 0,
      videoDuration: 0,
      ready: false,
    })
    setRetakePanelKey((prev) => prev + 1)
    resetRetake()
    reset()
  }

  const isRetakeMode = mode === 'retake'
  const isVideoMode = mode === 'text-to-video' || mode === 'image-to-video'
  const isBusy = isRetakeMode ? isRetaking : isGenerating
  const canGenerate = processStatus === 'alive' && !isBusy && (
    isRetakeMode
      ? retakeInput.ready && !!retakeInput.videoPath
      : mode === 'text-to-image' && activeQuickMode
        ? (settings.referenceImagePaths?.length ?? 0) > 0 // the recipe brings its own prompt
        : !!prompt.trim()
  )

  // "+ Queue" is allowed WHILE a render runs — that is its whole point.
  const canQueue = processStatus === 'alive' && !isRetakeMode && mode !== 'text-to-image' && !!prompt.trim()

  const handleQueue = () => {
    if (!canQueue) return
    const effectiveVideoSettings = shouldVideoGenerateWithLtxApi
      ? sanitizeForcedApiVideoSettings(settings)
      : settings
    const hasVideoRefs = (settings.videoReferencePaths?.length ?? 0) > 0
    const isSeedance2Model =
      effectiveVideoSettings.model === 'seedance-2.0' || effectiveVideoSettings.model === 'seedance-2.0-fast'
    if (hasVideoRefs && !isSeedance2Model) {
      setPreflightError(
        'Video references require Seedance 2.0. Switch the model to Seedance 2.0 (or remove the @Video reference) and generate again.',
      )
      return
    }
    setPreflightError(null)
    const imagePath = selectedImage ? fileUrlToPath(selectedImage) : (firstFramePath || null)
    const audioPath = selectedAudio ? fileUrlToPath(selectedAudio) : null
    if (audioPath) effectiveVideoSettings.model = 'pro'
    void generate(prompt, imagePath, effectiveVideoSettings, audioPath, lastFramePath, {
      ...PLAYGROUND_TAGS,
      enqueueOnly: true,
    })
  }

  // Edit-before-render: a queued shot loaded back into the real form.
  const handleEditQueuedJob = (job: QueueJob) => {
    setEditingJob(job)
    const p = job.params
    if (typeof p.prompt === 'string') setPrompt(p.prompt)
    setSettings(prev => ({
      ...prev,
      model: job.model as GenerationSettings['model'],
      duration: Number(p.duration ?? prev.duration) || prev.duration,
      videoResolution: typeof p.resolution === 'string' ? p.resolution : prev.videoResolution,
      aspectRatio: (typeof p.aspectRatio === 'string' ? p.aspectRatio : prev.aspectRatio) as GenerationSettings['aspectRatio'],
    }))
  }

  const handleUpdateQueuedShot = async () => {
    if (!editingJob) return
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/queue/${editingJob.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.model,
          params: {
            ...editingJob.params,
            prompt,
            duration: String(settings.duration),
            resolution: settings.videoResolution,
            aspectRatio: settings.aspectRatio || '16:9',
          },
        }),
      })
      if (res.status === 409) {
        setPreflightError('That shot already started rendering — edits only apply while queued.')
      }
    } catch {
      // The strip's next poll reconciles whatever actually happened.
    }
    setEditingJob(null)
  }

  // Compute estimated credit cost for current generation
  const estimatedCostCents = (() => {
    if (!credits.pricing) return null
    if (mode === 'text-to-image') return credits.pricing.image
    const m = settings.model as string
    // ONLY cloud video (seedance) costs points. Local models — LTX and MiniMax
    // H3 (local) — run on your own GPU and are billed in TIME, never points.
    if (m.startsWith('seedance')) {
      return (selectedImage || mode === 'image-to-video')
        ? credits.pricing.video_i2v
        : credits.pricing.video_seedance
    }
    return null
  })()

  /**
   * Local generation is billed in TIME, not points — and the time is invisible
   * until you've committed, because a cold model costs ~9 min before a single
   * frame renders. Cloud models keep showing points instead.
   *
   * Orientation is deliberately ignored: portrait measured the same as
   * landscape, so only the pixel count moves the number.
   */
  const localEta = (() => {
    if (!isVideoMode || forceApiGenerations) return null
    const model = String(settings.model ?? '')
    if (model.startsWith('seedance') || model.startsWith('dp-')) return null
    const { width, height } = resolveLocalSize(
      settings.videoResolution,
      settings.aspectRatio === '9:16' ? '9:16' : '16:9',
    )
    const render = estimateRenderSeconds(width, height, settings.duration)
    if (render <= 0) return null
    return {
      render,
      total: estimateTotalSeconds(width, height, settings.duration, status.warmth),
      cold: status.warmth !== 'warm',
    }
  })()

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          <button 
            onClick={goHome}
            className="p-2 rounded-lg hover:bg-zinc-800 transition-colors"
            title="Back to Home"
          >
            <ArrowLeft className="h-5 w-5 text-zinc-400" />
          </button>
          <div className="flex items-center gap-2.5">
            <LtxLogo className="h-6 w-auto text-white" />
            <span className="text-zinc-400 text-base font-medium tracking-wide leading-none pt-1 pl-1.5">Playground</span>
          </div>
        </div>
        
        <div className="flex items-center gap-4 pr-20">
          {/* Credit Balance */}
          {credits.balance_cents !== null && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800/80 border border-zinc-700/50">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-zinc-300 font-medium">
                {credits.balance_cents} pts
              </span>
            </div>
          )}

          {/* Model Status Dropdown */}
          {!forceApiGenerations && <ModelStatusDropdown />}

          {/* VRAM residency — distinct from the download state above. For the
              local ComfyUI engines (H3, LTX) the pill polls the shared engine's
              REAL residency so a cold model never reads as loaded-and-ready. */}
          {!forceApiGenerations && (
            <ModelWarmthPill
              warmth={status.warmth}
              expectedProfile={
                settings.model === 'h3-local' ? 'h3'
                  : settings.model === 'ltx-comfy' ? 'ltx'
                  : undefined
              }
              activeModel={
                settings.model === 'h3-local' ? 'MiniMax H3 (local)'
                  : settings.model === 'ltx-comfy' ? 'LTX 2.3 (local)'
                  : status.activeModel
              }
              gpuInfo={status.gpuInfo}
            />
          )}

          {/* GPU Info */}
          {status.gpuInfo && (
            <div className="text-sm text-zinc-500">
              {status.gpuInfo.name} ({(status.gpuInfo.vramUsed / 1024).toFixed(1)}GB / {Math.round(status.gpuInfo.vram / 1024)}GB)
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel - Controls. shrink-0: a fixed column must never be
            crushed by a wide right-panel child demanding min-content width. */}
        <div className="w-[500px] shrink-0 border-r border-zinc-800 p-6 overflow-y-auto">
          <div className="space-y-6">
            {/* Mode Tabs */}
            <ModeTabs
              mode={mode}
              onModeChange={handleModeChange}
              disabled={isBusy}
            />

            {/* Image Upload - Always shown in video mode (optional: makes it I2V) */}
            {isVideoMode && !isRetakeMode && (
              <>
                <ImageUploader
                  selectedImage={selectedImage}
                  onImageSelect={setSelectedImage}
                />
                <AudioUploader
                  selectedAudio={selectedAudio}
                  onAudioSelect={setSelectedAudio}
                />
              </>
            )}

            {isRetakeMode && (
              <RetakePanel
                resetKey={retakePanelKey}
                isProcessing={isRetaking}
                processingStatus={retakeStatus}
                onChange={(data) => setRetakeInput(data)}
              />
            )}

            {/* First / Last Frame Slots */}
            {isVideoMode && !isRetakeMode && (
              <div className="grid grid-cols-2 gap-3">
                <FrameSlot
                  label="First Frame"
                  imageUrl={firstFrameUrl}
                  onImageSet={(url, path) => { setFirstFrameUrl(url); setFirstFramePath(path) }}
                />
                <FrameSlot
                  label="Last Frame"
                  imageUrl={lastFrameUrl}
                  onImageSet={(url, path) => { setLastFrameUrl(url); setLastFramePath(path) }}
                />
              </div>
            )}

            {/* Prompt Input */}
            <div className="relative">
              <Textarea
                ref={promptRef}
                label="Prompt"
                placeholder="Write a prompt... (type @ to mention a character or reference)"
                value={prompt}
                onChange={(e) => { setPrompt(e.target.value); atAutocomplete.sync() }}
                onKeyDown={(e) => {
                  if (atAutocomplete.onKeyDown(e)) { e.preventDefault(); return }
                  // Ctrl/Cmd+Enter fires the contextual primary action (plain
                  // Enter stays a newline — H3 prompts are multi-line).
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    if (editingJob) { if (prompt.trim()) void handleUpdateQueuedShot() }
                    else if (isGenerating) { if (canQueue && !isRetakeMode) handleQueue() }
                    else if (canGenerate) handleGenerate()
                  }
                }}
                onSelect={() => atAutocomplete.sync()}
                onBlur={() => atAutocomplete.close()}
                helperText="Type @ for your Characters & References · Ctrl+Enter to generate · detailed prompts win."
                charCount={prompt.length}
                maxChars={5000}
              />
              <button
                onClick={handleEnhancePrompt}
                disabled={isEnhancing}
                className="absolute top-7 right-2 p-1.5 rounded-md text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title={prompt.trim() ? "Enhance prompt with AI" : "Generate a random prompt"}
              >
                <Wand2 className={`h-4 w-4 ${isEnhancing ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={async () => {
                  const t = (await window.electronAPI.readClipboardText?.())?.trim()
                  if (t) setPrompt(prev => (prev.trim() ? `${prev}\n${t}` : t))
                }}
                className="absolute top-7 right-10 p-1.5 rounded-md text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 transition-colors"
                title="Paste the prompt on your clipboard (appends if the box has text)"
              >
                <ClipboardPaste className="h-4 w-4" />
              </button>
              {atAutocomplete.isOpen && (
                <AtAutocompleteDropdown
                  className="absolute left-0 right-0 top-full mt-1"
                  caret={atAutocomplete.caret}
                  options={atAutocomplete.options}
                  activeIndex={atAutocomplete.activeIndex}
                  onPick={atAutocomplete.accept}
                  onHover={atAutocomplete.setActiveIndex}
                />
              )}
            </div>

            {/* Recipe quick-insert + one-tap quick modes (same row as Gen Space) */}
            <div className="flex items-center gap-2 flex-wrap">
              <RecipePicker onInsert={(text) => setPrompt(insertAtCaret(promptRef.current, prompt, text))} />
              {mode === 'text-to-image' && (
                <QuickModeToggles
                  active={activeQuickMode}
                  onToggle={setActiveQuickMode}
                  hasPhotos={(settings.referenceImagePaths?.length ?? 0) > 0}
                  onAddPhotos={() => void addQuickModePhotos()}
                />
              )}
            </div>

            {/* Settings */}
            {!isRetakeMode && (
              <SettingsPanel
                settings={settings}
                onSettingsChange={setSettings}
                mode={mode}
                forceApiGenerations={shouldVideoGenerateWithLtxApi}
                hasAudio={!!selectedAudio}
                hasReplicateApiKey={appSettings.hasReplicateApiKey}
                hasFalApiKey={appSettings.hasFalApiKey}
              />
            )}

            {mode !== 'text-to-image' && (
              <ReferencePicker
                model={settings.model}
                referenceImagePaths={settings.referenceImagePaths ?? []}
                audioReferencePaths={settings.audioReferencePaths ?? []}
                videoReferencePaths={settings.videoReferencePaths ?? []}
                onChange={({ referenceImagePaths, audioReferencePaths, videoReferencePaths }) =>
                  setSettings((prev) => ({
                    ...prev,
                    referenceImagePaths,
                    audioReferencePaths,
                    videoReferencePaths,
                  }))
                }
              />
            )}

            {/* Preflight problems (caught before submitting) */}
            {preflightError && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-sm">
                <span className="text-amber-400">{preflightError}</span>
              </div>
            )}

            {/* Error Display */}
            {(generationError || retakeError) && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm">
                {(generationError || retakeError)!.includes('TEXT_ENCODING_NOT_CONFIGURED') ? (
                  <div className="space-y-2">
                    <p className="text-red-400 font-medium">Text encoding not configured</p>
                    <p className="text-red-400/80">
                      To generate videos, you need to set up text encoding in Settings.
                    </p>
                  </div>
                ) : (generationError || retakeError)!.includes('TEXT_ENCODER_NOT_DOWNLOADED') ? (
                  <div className="space-y-2">
                    <p className="text-red-400 font-medium">Text encoder not downloaded</p>
                    <p className="text-red-400/80">
                      The local text encoder needs to be downloaded (~25 GB).
                    </p>
                  </div>
                ) : (
                  <span className="text-red-400">{generationError || retakeError}</span>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Button
                variant="outline"
                onClick={handleClearAll}
                className="flex items-center gap-2 border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700"
              >
                <Trash2 className="h-4 w-4" />
                Clear all
              </Button>
              
              {editingJob ? (
                <>
                  <Button
                    onClick={() => void handleUpdateQueuedShot()}
                    disabled={!prompt.trim()}
                    className="flex-1 flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-500"
                  >
                    <Pencil className="h-4 w-4" />
                    Update queued shot
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setEditingJob(null)}
                    className="border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700"
                  >
                    Cancel
                  </Button>
                </>
              ) : isGenerating ? (
                <>
                  <Button
                    onClick={cancel}
                    className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 text-white"
                  >
                    <Square className="h-4 w-4" />
                    Stop generation
                  </Button>
                  {mode !== 'text-to-image' && !isRetakeMode && (
                    <Button
                      variant="outline"
                      onClick={handleQueue}
                      disabled={!canQueue}
                      title="Queue this shot to render after the current one — keep composing"
                      className="flex items-center gap-2 border-amber-500/40 bg-zinc-800 text-amber-300 hover:bg-zinc-700 disabled:opacity-50"
                    >
                      <ListPlus className="h-4 w-4" />
                      + Queue
                    </Button>
                  )}
                </>
              ) : (
                <>
                <Button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className="flex-1 flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  {isRetakeMode ? (
                    <>
                      <Scissors className="h-4 w-4" />
                      {isRetaking ? 'Retaking...' : 'Retake'}
                    </>
                  ) : mode === 'text-to-image' ? (
                    <>
                      <ImageIcon className="h-4 w-4" />
                      Generate image{estimatedCostCents ? ` (${estimatedCostCents} pts)` : ''}
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      <span>
                        Generate video{estimatedCostCents ? ` (${estimatedCostCents} pts)` : ''}
                        {localEta && ` · ~${formatDuration(localEta.total)}`}
                      </span>
                    </>
                  )}
                </Button>
                {mode !== 'text-to-image' && !isRetakeMode && (
                  <Button
                    variant="outline"
                    onClick={handleQueue}
                    disabled={!canQueue}
                    title="Add this shot to the queue and keep composing"
                    className="flex items-center gap-2 border-amber-500/40 bg-zinc-800 text-amber-300 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    <ListPlus className="h-4 w-4" />
                    + Queue
                  </Button>
                )}
                </>
              )}
            </div>

            {/* Edit-before-render banner */}
            {editingJob && (
              <p className="mt-2 text-xs text-amber-300 border border-amber-500/40 bg-amber-500/10 rounded-md px-2.5 py-1.5">
                Editing queued shot — Update saves your changes to the pending render · Esc or Cancel leaves it untouched.
                {typeof editingJob.params.seed === 'number' && (
                  <span className="text-amber-300/70"> Keeps seed {editingJob.params.seed} (same seed + same prompt = same take).</span>
                )}
              </p>
            )}

            {/* Then-Animate: chain a video job onto the image via the queue's
                dependency engine — it waits for the image and animates it. */}
            {mode === 'text-to-image' && !isRetakeMode && (
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={thenAnimate}
                  onChange={e => setThenAnimate(e.target.checked)}
                  className="accent-amber-500"
                />
                Then animate the result ({getVideoModel(String(settings.model))?.displayName ?? settings.model} · {settings.duration}s — queued automatically)
              </label>
            )}

            {/* Registry-driven compensation: say when this model will ignore
                one of the attached images, before the render is paid for. */}
            {mode !== 'text-to-image' && !isRetakeMode && (selectedImage || firstFramePath) &&
              (settings.referenceImagePaths?.length ?? 0) > 0 &&
              conditioningConflictMessage(String(settings.model)) && (
              <p className="mt-2 text-xs text-amber-400/90 border border-amber-500/30 bg-amber-500/5 rounded-md px-2.5 py-1.5">
                {conditioningConflictMessage(String(settings.model))}
              </p>
            )}

            {/* The load is the surprise, so name it before the click, not after. */}
            {localEta?.cold && !isBusy && (
              <p className="mt-2 text-xs text-zinc-500">
                Model is cold — about {formatDuration(MODEL_LOAD_SECONDS)} to load,
                then {formatDuration(localEta.render)} to render. Later shots skip the load.
              </p>
            )}
          </div>
        </div>

        {/* Right Panel - Result Preview. min-w-0 lets content truncate inside
            instead of blowing out the flex row. */}
        <div className="flex-1 min-w-0 p-6">
          {mode === 'text-to-image' ? (
            <ImageResult
              imageUrl={imageUrl}
              isGenerating={isGenerating}
              progress={progress}
              statusMessage={statusMessage}
              elapsedSeconds={elapsedSeconds}
              estimatedSeconds={estimatedSeconds}
              onCreateVideo={handleCreateVideoFromImage}
              modelName={lastModel}
            />
          ) : mode === 'retake' ? (
            <VideoPlayer
              videoUrl={retakeResult?.videoUrl || null}
              videoPath={retakeResult?.videoPath || null}
              videoResolution={settings.videoResolution}
              isGenerating={isRetaking}
              progress={0}
              statusMessage={retakeStatus}
            />
          ) : (
            <VideoPlayer
              videoUrl={videoUrl}
              videoPath={videoPath}
              videoResolution={settings.videoResolution}
              isGenerating={isGenerating}
              progress={progress}
              statusMessage={statusMessage}
              elapsedSeconds={elapsedSeconds}
              estimatedSeconds={estimatedSeconds}
              modelName={activeModel ?? lastModel}
              onExtendVideo={handleExtendVideo}
              reservedSeconds={activeReservedSeconds ?? undefined}
              coldStart={coldStart}
            />
          )}

          {/* Palette-style per-job queue timers (queued + running video jobs). */}
          {/* The queue as a work surface: thumbnails, prompts, reorder/edit/
              duplicate/remove, and the finished-→-Gallery trail. */}
          <PlaygroundQueueStrip onEditJob={handleEditQueuedJob} />

          <EnhanceDirectorModal
            open={showEnhanceDirector}
            prompt={prompt}
            model={String(settings.model)}
            imagePath={selectedImage ? fileUrlToPath(selectedImage) : firstFramePath}
            onClose={() => setShowEnhanceDirector(false)}
            onApply={setPrompt}
          />
        </div>
      </main>
    </div>
  )
}
