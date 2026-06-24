/**
 * Transcript-driven generate chain: prompt → image → (optionally) video-from-image.
 *
 * Submits jobs to the persistent queue (the same path the rest of the app uses) so the
 * executor handles model dispatch, results, and gallery persistence. For video, the image
 * is generated first and then used as the i2v first frame — matching the user's flow
 * ("generate an image, then take that image and generate video from it").
 */

async function backendBase(): Promise<string> {
  if (window.electronAPI) return await window.electronAPI.getBackendUrl()
  return 'http://localhost:8000'
}

interface QueueJob {
  id: string
  status: string
  result_paths: string[]
  error?: string | null
}

const _MAX_WAIT_MS = 15 * 60 * 1000

async function submitJob(type: string, model: string, params: Record<string, unknown>): Promise<string> {
  const base = await backendBase()
  const resp = await fetch(`${base}/api/queue/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, model, params }),
  })
  if (!resp.ok) throw new Error(`Submit failed: ${resp.status} ${await resp.text()}`)
  const data = (await resp.json()) as { id: string }
  return data.id
}

async function waitForJob(id: string): Promise<QueueJob> {
  const base = await backendBase()
  const deadline = Date.now() + _MAX_WAIT_MS
  while (Date.now() < deadline) {
    const resp = await fetch(`${base}/api/queue/status`)
    if (resp.ok) {
      const data = (await resp.json()) as { jobs: QueueJob[] }
      const job = data.jobs.find((j) => j.id === id)
      if (job) {
        if (job.status === 'complete') return job
        if (job.status === 'error' || job.status === 'cancelled') {
          throw new Error(job.error || `Job ${job.status}`)
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('Generation timed out')
}

export interface GenerateChainResult {
  imagePath: string
  videoPath?: string
}

export async function generateFromPrompt(opts: {
  prompt: string
  mediaType: 'image' | 'video'
  imageModel: string
  videoModel: string
  onPhase?: (phase: string) => void
}): Promise<GenerateChainResult> {
  opts.onPhase?.('Generating image…')
  const imageJobId = await submitJob('image', opts.imageModel, { prompt: opts.prompt })
  const imageJob = await waitForJob(imageJobId)
  const imagePath = imageJob.result_paths[0]
  if (!imagePath) throw new Error('No image was produced')
  if (opts.mediaType === 'image') return { imagePath }

  // Use the generated image as the i2v first frame.
  opts.onPhase?.('Generating video from image…')
  const videoJobId = await submitJob('video', opts.videoModel, {
    prompt: opts.prompt,
    imagePath,
  })
  const videoJob = await waitForJob(videoJobId)
  return { imagePath, videoPath: videoJob.result_paths[0] }
}
