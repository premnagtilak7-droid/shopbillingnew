import { useEffect, useRef } from 'react'

export function useBarcodeScanner(onScan, enabled = true) {
  const bufferRef = useRef('')
  const lastKeyAtRef = useRef(0)
  const resetTimerRef = useRef(null)

  useEffect(() => {
    if (!enabled) return undefined

    const handleKeyDown = event => {
      const now = Date.now()
      const gap = lastKeyAtRef.current ? now - lastKeyAtRef.current : 0

      if (event.key === 'Enter') {
        const code = bufferRef.current.trim()
        if (code.length >= 4 && gap > 0 && gap < 30) {
          event.preventDefault()
          event.stopPropagation()
          onScan(code)
        }
        bufferRef.current = ''
        lastKeyAtRef.current = 0
        clearTimeout(resetTimerRef.current)
        return
      }

      if (event.key.length !== 1) return

      if (!lastKeyAtRef.current || gap >= 30) {
        bufferRef.current = event.key
      } else {
        bufferRef.current += event.key
      }
      lastKeyAtRef.current = now

      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => {
        bufferRef.current = ''
        lastKeyAtRef.current = 0
      }, 100)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      clearTimeout(resetTimerRef.current)
    }
  }, [enabled, onScan])
}

export function playBarcodeBeep() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0.08, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.08)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.08)
    oscillator.addEventListener('ended', () => { try { context.close() } catch {} })
  } catch (error) {
    console.warn('Barcode beep blocked by browser:', error)
  }
}
