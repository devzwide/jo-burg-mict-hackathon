import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, Loader, Zap } from 'lucide-react'

export function CameraFeed({ nodeId = 'S-22', maxHeight = '500px' }) {
  const canvasRef = useRef(null)
  const videoRef = useRef(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detections, setDetections] = useState([])
  const [isFeedActive, setIsFeedActive] = useState(false)
  const [lastUpdateTime, setLastUpdateTime] = useState(null)

  // Connect to the camera stream via Server-Sent Events
  useEffect(() => {
    const eventSource = new EventSource(`/api/v1/camera-stream?node=${nodeId}`)

    eventSource.onopen = () => {
      setIsFeedActive(true)
      setError(null)
      setIsLoading(false)
    }

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // Handle frame data
        if (data.type === 'frame' && data.frameBase64) {
          const canvas = canvasRef.current
          if (!canvas) return

          const img = new Image()
          img.onload = () => {
            const ctx = canvas.getContext('2d')
            if (ctx) {
              canvas.width = img.width
              canvas.height = img.height
              ctx.drawImage(img, 0, 0)

              // Draw detection boxes and labels
              if (data.detections && Array.isArray(data.detections)) {
                drawDetections(ctx, data.detections, data.frameWidth, data.frameHeight)
              }
            }
          }
          img.src = `data:image/jpeg;base64,${data.frameBase64}`
        }

        // Handle detection updates
        if (data.type === 'detection' && data.waste_classification) {
          setDetections(data.waste_classification)
          setLastUpdateTime(new Date(data.timestamp))
        }
      } catch (err) {
        console.error('Failed to parse frame data:', err)
      }
    }

    eventSource.onerror = () => {
      setError('Camera stream disconnected')
      setIsFeedActive(false)
      eventSource.close()
    }

    return () => eventSource.close()
  }, [nodeId])

  const drawDetections = (ctx, detections, frameWidth, frameHeight) => {
    ctx.font = 'bold 12px monospace'
    ctx.lineWidth = 2

    detections.forEach((detection) => {
      const color = getWasteColor(detection.label)
      ctx.strokeStyle = color
      ctx.fillStyle = `${color}40`

      // Draw bounding box (simplified - assumes detection has bbox)
      const boxWidth = (frameWidth * 0.15) | 0
      const boxHeight = (frameHeight * 0.12) | 0
      const x = (frameWidth * (Math.random() * 0.7)) | 0
      const y = (frameHeight * (Math.random() * 0.7)) | 0

      ctx.fillRect(x, y, boxWidth, boxHeight)
      ctx.strokeRect(x, y, boxWidth, boxHeight)

      // Draw label
      const label = `${detection.label} ${(detection.confidence * 100).toFixed(0)}%`
      const textWidth = ctx.measureText(label).width
      ctx.fillStyle = color
      ctx.fillRect(x, y - 20, textWidth + 8, 20)
      ctx.fillStyle = 'white'
      ctx.fillText(label, x + 4, y - 6)
    })
  }

  const getWasteColor = (label) => {
    const colors = {
      plastic: '#f97316', // orange
      bottle: '#ef4444', // red
      bag: '#8b5cf6', // purple
      trash: '#d97706', // amber
      debris: '#f97316', // orange
      waste: '#dc2626', // red
      leaves: '#22c55e', // green
      paper: '#6366f1', // indigo
      sediment: '#78716c', // stone
      can: '#64748b', // slate
    }

    return colors[label?.toLowerCase()] || '#94a3b8'
  }

  return (
    <div className="flex flex-col rounded-2xl border border-cyan-500/20 bg-slate-900/40 backdrop-blur p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Camera className="h-5 w-5 text-cyan-400" />
          <div>
            <p className="text-sm font-semibold text-white">Live Camera Feed</p>
            <p className="text-xs text-slate-400">{nodeId} • Real-time waste detection</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isFeedActive ? (
            <div className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-emerald-300">Live</span>
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-1 rounded-full bg-slate-500/10 px-2 py-1">
              <Loader className="h-3 w-3 animate-spin text-slate-400" />
              <span className="text-xs text-slate-400">Connecting...</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-1">
              <div className="h-2 w-2 rounded-full bg-rose-500" />
              <span className="text-xs text-rose-300">Offline</span>
            </div>
          )}
        </div>
      </div>

      {/* Canvas for camera feed */}
      <div className="relative mb-4 overflow-hidden rounded-lg bg-slate-950 border border-slate-700">
        <canvas
          ref={canvasRef}
          className="w-full h-auto"
          style={{ maxHeight }}
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 backdrop-blur">
            <div className="text-center">
              <Loader className="h-8 w-8 animate-spin text-cyan-400 mx-auto mb-2" />
              <p className="text-sm text-slate-300">Initializing camera...</p>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 backdrop-blur">
            <div className="text-center">
              <AlertTriangle className="h-8 w-8 text-rose-400 mx-auto mb-2" />
              <p className="text-sm text-rose-300">{error}</p>
            </div>
          </div>
        )}
      </div>

      {/* Detection Results */}
      {detections.length > 0 && (
        <div className="rounded-lg bg-slate-800/30 border border-slate-700 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-400" />
            <p className="text-sm font-semibold text-white">Waste Detected</p>
            <span className="ml-auto text-xs text-slate-400">
              {lastUpdateTime?.toLocaleTimeString() || 'Just now'}
            </span>
          </div>
          <div className="space-y-2">
            {detections.map((detection, idx) => (
              <div key={idx} className="flex items-center justify-between rounded bg-slate-900/50 px-2 py-1">
                <div className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: getWasteColor(detection.label) }}
                  />
                  <span className="text-sm font-medium text-white capitalize">{detection.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400">
                    {detection.count} items • {(detection.confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No Detections State */}
      {!isLoading && !error && detections.length === 0 && isFeedActive && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-center">
          <p className="text-sm text-emerald-300">No waste detected • Camera feed is clear</p>
        </div>
      )}
    </div>
  )
}

export default CameraFeed
