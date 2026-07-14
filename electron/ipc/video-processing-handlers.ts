import { ipcMain } from 'electron'
import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { findFfmpegPath, urlToFilePath, runFfmpeg, fileHasAudio } from '../export/ffmpeg-utils'
import { getAllowedRoots } from '../config'
import { validatePath } from '../path-validation'
import { logger } from '../logger'

export function registerVideoProcessingHandlers(): void {
  ipcMain.handle(
    'extract-video-frame',
    async (
      _event,
      videoUrl: string,
      seekTime: number,
      width?: number,
      quality?: number,
    ): Promise<{ path: string; url: string }> => {
      const ffmpeg = findFfmpegPath()
      if (!ffmpeg) {
        throw new Error('ffmpeg not found')
      }

      const inputPath = urlToFilePath(videoUrl)
      // Keep the same allowlist policy the other file-touching handlers use.
      try {
        validatePath(inputPath, getAllowedRoots())
      } catch (err) {
        throw new Error(String(err))
      }
      if (!fs.existsSync(inputPath)) {
        throw new Error(`Video file not found: ${inputPath}`)
      }

      const outputName = `ltx_frame_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`
      const outputPath = path.join(os.tmpdir(), outputName)

      const args: string[] = [
        '-ss', String(Math.max(0, seekTime)),
        '-i', inputPath,
        ...(width ? ['-vf', `scale=${width}:-2`] : []),
        '-frames:v', '1',
        '-q:v', String(quality ?? 2),
        '-y',
        outputPath,
      ]

      logger.info(`[extract-frame] ${args.join(' ').slice(0, 300)}`)

      const result = spawnSync(ffmpeg, args, { timeout: 10000 })

      if (result.status !== 0) {
        const stderr = result.stderr?.toString().slice(-300) || ''
        throw new Error(`ffmpeg frame extraction failed (code ${result.status}): ${stderr}`)
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error('ffmpeg produced no output file')
      }

      const fileUrl = `file://${outputPath}`
      return { path: outputPath, url: fileUrl }
    },
  )

  // Trim a fixed-length segment out of a source video. Re-encodes so the cut is
  // frame-accurate at an arbitrary start (a stream copy would snap to keyframes).
  // Clips are short (15/30s), so the re-encode cost is a few seconds.
  ipcMain.handle(
    'clip-trim',
    async (
      _event,
      data: { inputUrl: string; startSeconds: number; lengthSeconds: number; outputPath: string },
    ): Promise<{ success: boolean; outputPath?: string; error?: string }> => {
      const ffmpeg = findFfmpegPath()
      if (!ffmpeg) return { success: false, error: 'FFmpeg not found' }

      const inputPath = urlToFilePath(data.inputUrl)

      try {
        validatePath(inputPath, getAllowedRoots())
        validatePath(data.outputPath, getAllowedRoots())
      } catch (err) {
        return { success: false, error: String(err) }
      }

      if (!fs.existsSync(inputPath)) {
        return { success: false, error: `Source video not found: ${path.basename(inputPath)}` }
      }

      const start = Math.max(0, Number(data.startSeconds) || 0)
      const length = Number(data.lengthSeconds) || 0
      if (length <= 0) return { success: false, error: 'Invalid clip length' }

      const hasAudio = fileHasAudio(ffmpeg, inputPath)
      const args: string[] = [
        '-y',
        // Seek before -i for a fast, still frame-accurate seek when re-encoding.
        '-ss', String(start),
        '-i', inputPath,
        '-t', String(length),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        data.outputPath,
      ]

      const result = await runFfmpeg(ffmpeg, args)
      if (!result.success) return { success: false, error: result.error }

      if (!fs.existsSync(data.outputPath)) {
        return { success: false, error: 'FFmpeg produced no output file' }
      }
      return { success: true, outputPath: data.outputPath }
    },
  )
}
