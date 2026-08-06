import { useRef, useState, useCallback, useEffect } from 'react'
import { X, ImageIcon } from 'lucide-react'

interface FrameSlotProps {
  label: string
  imageUrl: string | null
  onImageSet: (url: string | null, path: string | null) => void
  disabled?: boolean
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

export function FrameSlot({ label, imageUrl, onImageSet, disabled }: FrameSlotProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  // Any object URL we created, so we can revoke it on replace/clear/unmount.
  const blobUrlRef = useRef<string | null>(null)

  const revokeBlob = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
  }, [])

  useEffect(() => revokeBlob, [revokeBlob])

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    revokeBlob()
    // In Electron the File has a real path — display it via file:// and skip the
    // blob entirely (no leak). Only fall back to a blob URL when there's no path.
    const path = (file as File & { path?: string }).path || null
    let url: string
    if (path) {
      url = pathToFileUrl(path)
    } else {
      url = URL.createObjectURL(file)
      blobUrlRef.current = url
    }
    onImageSet(url, path)
  }, [onImageSet, revokeBlob])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          handleFile(file)
          e.preventDefault()
          return
        }
      }
    }
  }, [handleFile])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false)
  }, [])

  const handleBrowse = () => {
    fileInputRef.current?.click()
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    revokeBlob()
    onImageSet(null, null)
  }

  return (
    <div
      className={`relative rounded-lg border-2 border-dashed transition-colors cursor-pointer
        ${isDragOver ? 'border-amber-500 bg-amber-500/10' : 'border-zinc-700 hover:border-zinc-500'}
        ${disabled ? 'opacity-50 pointer-events-none' : ''}
      `}
      onClick={handleBrowse}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      tabIndex={0}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileInput}
      />

      {imageUrl ? (
        <div className="relative aspect-video">
          <img
            src={imageUrl}
            alt={label}
            className="w-full h-full object-cover rounded-md"
          />
          <button
            onClick={handleClear}
            className="absolute top-1.5 right-1.5 p-1 rounded-full bg-black/60 hover:bg-black/80 transition-colors"
          >
            <X className="h-3.5 w-3.5 text-white" />
          </button>
          <span className="absolute bottom-1.5 left-1.5 text-[10px] font-medium text-white bg-black/60 px-1.5 py-0.5 rounded">
            {label}
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-4 px-2 gap-1.5">
          <ImageIcon className="h-5 w-5 text-zinc-500" />
          <span className="text-xs font-medium text-zinc-400">{label}</span>
          <span className="text-[10px] text-zinc-600">Paste, drop, or click</span>
        </div>
      )}
    </div>
  )
}
