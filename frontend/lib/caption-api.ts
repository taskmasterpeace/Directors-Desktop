const getBaseUrl = async (): Promise<string> => {
  if (window.electronAPI) {
    return await window.electronAPI.getBackendUrl()
  }
  return 'http://localhost:8000'
}

export type CaptionTargetModel = 'ltx-fast' | 'seedance-1.5-pro'

export async function captionImage(
  imagePath: string,
  targetModel: CaptionTargetModel,
): Promise<string> {
  const base = await getBaseUrl()
  const resp = await fetch(`${base}/api/caption-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imagePath, targetModel }),
  })
  if (!resp.ok) {
    throw new Error(`Caption failed: ${resp.status} ${await resp.text()}`)
  }
  const data: { prompt: string } = await resp.json()
  return data.prompt
}
