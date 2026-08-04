import { useState, useEffect, useRef } from 'react'

interface PythonSetupProps {
  onReady: () => void
}

interface SetupProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'error'
  percent: number
  downloadedBytes: number
  totalBytes: number
  speed: number
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

const formatTimeRemaining = (seconds: number): string => {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '--'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}

export function PythonSetup({ onReady }: PythonSetupProps) {
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [videoPath, setVideoPath] = useState('/splash/splash.mp4')
  const started = useRef(false)

  const getTimeRemaining = (): string => {
    if (!progress || progress.speed <= 0) return '--'
    const remainingBytes = progress.totalBytes - progress.downloadedBytes
    if (remainingBytes <= 0) return '--'
    return formatTimeRemaining(remainingBytes / progress.speed)
  }

  // Resolve video path for production
  useEffect(() => {
    const init = async () => {
      try {
        const resourcePath = await window.electronAPI.getResourcePath?.()
        if (resourcePath) {
          setVideoPath(`file://${resourcePath}/app.asar.unpacked/dist/splash/splash.mp4`)
        }
      } catch {
        // Dev mode: use relative path
      }
    }
    init()
  }, [])

  // Listen for progress events
  useEffect(() => {
    window.electronAPI.onPythonSetupProgress((data: unknown) => {
      const p = data as SetupProgress
      setProgress(p)
      if (p.status === 'complete') {
        onReady()
      } else if (p.status === 'error') {
        setError('Download failed. Please check your internet connection and try again.')
      }
    })
    return () => {
      window.electronAPI.removePythonSetupProgress()
    }
  }, [onReady])

  // Start download on mount
  useEffect(() => {
    if (started.current) return
    started.current = true
    startSetup()
  }, [])

  const startSetup = async () => {
    setError(null)
    try {
      await window.electronAPI.startPythonSetup()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to download Python environment.')
    }
  }

  const statusLabel = progress?.status === 'extracting' ? 'Extracting...' : 'Downloading Python environment...'
  const percent = progress?.percent ?? 0

  return (
    <div className="h-screen flex flex-col" style={{
      background: '#000000',
      fontFamily: "'Inter', system-ui, sans-serif",
      color: '#ffffff'
    }}>
      {/* Custom Title Bar */}
      <div style={{
        height: 32,
        background: '#000000',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 80,
        borderBottom: '1px solid #1a1a1a',
        // @ts-expect-error - Electron-specific CSS property
        WebkitAppRegion: 'drag'
      }}>
        <span style={{ fontSize: 13, color: '#a0a0a0' }}>Director's Desktop</span>
      </div>

      {/* Main Container */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        // @ts-expect-error - Electron-specific CSS property
        WebkitAppRegion: 'no-drag'
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 32px',
          borderBottom: '1px solid #1a1a1a'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em' }}>Director's Desktop</span>
          </div>
        </div>

        {/* Content Area */}
        <div style={{
          flex: 1,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          height: '100%',
        }}>
          {/* Video Section */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 140,
            background: '#0a0a0a',
            overflow: 'hidden'
          }}>
            <video
              key={videoPath}
              autoPlay
              loop
              muted
              playsInline
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block'
              }}
            >
              <source src={videoPath} type="video/mp4" />
            </video>
          </div>

          {/* Progress Section */}
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 140,
            background: '#0d0d0d',
            padding: '16px 24px',
            borderTop: '1px solid #2a2a2a'
          }}>
            {error ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 10,
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span style={{ color: '#f87171', fontSize: 13, textAlign: 'center', maxWidth: 400 }}>{error}</span>
                <button
                  onClick={() => { setError(null); started.current = false; startSetup() }}
                  style={{
                    padding: '6px 20px',
                    borderRadius: 9999,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: 'linear-gradient(125deg, #F59E0B, #D97706)',
                    border: 'none',
                    color: '#ffffff',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : (
              <>
                {/* Header row */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8
                }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {statusLabel}
                  </span>
                  <span style={{ fontSize: 13, color: '#FBBF24', fontWeight: 600 }}>
                    {percent}%
                  </span>
                </div>

                {/* Progress Bar */}
                <div style={{
                  height: 6,
                  background: '#1a1a1a',
                  borderRadius: 3,
                  overflow: 'hidden'
                }}>
                  <div style={{
                    height: '100%',
                    background: 'linear-gradient(125deg, #FBBF24, #F59E0B, #D97706)',
                    backgroundSize: '200% 200%',
                    animation: 'gradientShift 3s ease infinite',
                    borderRadius: 3,
                    width: `${percent}%`,
                    transition: 'width 0.3s ease'
                  }} />
                </div>

                {/* Stats row */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 10,
                  fontSize: 12,
                  color: '#a0a0a0'
                }}>
                  <span style={{ flex: 1 }}>
                    {progress?.status === 'extracting'
                      ? 'Setting up Python environment...'
                      : 'First-time setup — this only happens once'}
                  </span>

                  <div style={{ display: 'flex', gap: 16, marginLeft: 16, flexShrink: 0 }}>
                    {progress && progress.speed > 0 && (
                      <span style={{ color: '#F59E0B', fontWeight: 500 }}>
                        {(progress.speed / (1024 * 1024)).toFixed(1)} MB/s
                      </span>
                    )}
                    {progress && progress.downloadedBytes > 0 && (
                      <span>
                        {formatBytes(progress.downloadedBytes)}{progress.totalBytes > 0 ? ` / ${formatBytes(progress.totalBytes)}` : ''}
                      </span>
                    )}
                    {progress && progress.speed > 0 && progress.totalBytes > 0 && (
                      <span>
                        ETA: {getTimeRemaining()}
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 24px',
          borderTop: '1px solid #1a1a1a',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ fontSize: 11, color: '#666' }}>&copy; 2026 Machine King Labs</div>
        </div>
      </div>
    </div>
  )
}
