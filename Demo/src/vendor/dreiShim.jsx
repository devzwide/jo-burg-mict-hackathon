import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { extend, useFrame, useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

extend({ OrbitControlsImpl })

export function OrbitControls({ makeDefault = false, ...props }) {
  const { camera, gl, invalidate } = useThree()
  const set = useThree((state) => state.set)
  const previous = useThree((state) => state.controls)
  const controlsRef = useRef(null)

  useEffect(() => {
    const controls = controlsRef.current

    if (!controls) {
      return undefined
    }

    const handleChange = () => invalidate()
    controls.addEventListener('change', handleChange)

    if (makeDefault) {
      set({ controls })
    }

    return () => {
      controls.removeEventListener('change', handleChange)

      if (makeDefault) {
        set({ controls: previous ?? null })
      }
    }
  }, [gl, invalidate, makeDefault, previous, set])

  useFrame(() => controlsRef.current?.update())

  return <orbitControlsImpl ref={controlsRef} args={[camera, gl.domElement]} {...props} />
}

export function Float({
  children,
  speed = 1,
  rotationIntensity = 1,
  floatIntensity = 1,
  ...props
}) {
  const groupRef = useRef(null)
  const origin = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    if (groupRef.current) {
      origin.copy(groupRef.current.position)
    }
  }, [origin])

  useFrame(({ clock }) => {
    if (!groupRef.current) {
      return
    }

    const elapsed = clock.getElapsedTime() * speed
    groupRef.current.position.y = origin.y + Math.sin(elapsed) * 0.1 * floatIntensity
    groupRef.current.rotation.y = Math.sin(elapsed * 0.6) * 0.1 * rotationIntensity
    groupRef.current.rotation.x = Math.cos(elapsed * 0.7) * 0.05 * rotationIntensity
  })

  return (
    <group ref={groupRef} {...props}>
      {children}
    </group>
  )
}

export function Html({ children, position = [0, 0, 0], center = false, distanceFactor = 10 }) {
  const { gl, camera, size } = useThree()
  const anchorRef = useRef(null)
  const container = useMemo(() => document.createElement('div'), [])
  const worldPosition = useMemo(() => new THREE.Vector3(), [])
  const projected = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    const parent = gl.domElement.parentElement

    if (!parent) {
      return undefined
    }

    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative'
    }

    container.style.position = 'absolute'
    container.style.top = '0'
    container.style.left = '0'
    container.style.pointerEvents = 'none'
    container.style.transformOrigin = 'top left'
    parent.appendChild(container)

    return () => {
      if (parent.contains(container)) {
        parent.removeChild(container)
      }
    }
  }, [container, gl])

  useFrame(() => {
    if (!anchorRef.current) {
      return
    }

    anchorRef.current.getWorldPosition(worldPosition)
    const distance = camera.position.distanceTo(worldPosition)
    projected.copy(worldPosition).project(camera)

    const isVisible = projected.z > -1 && projected.z < 1
    container.style.display = isVisible ? 'block' : 'none'

    const x = (projected.x * 0.5 + 0.5) * size.width
    const y = (-projected.y * 0.5 + 0.5) * size.height
    const scale = Math.min(Math.max(distanceFactor / Math.max(distance, 0.1), 0.65), 1.15)
    container.style.transform = `translate3d(${x}px, ${y}px, 0) ${center ? 'translate(-50%, -50%)' : ''} scale(${scale})`
  })

  return (
    <>
      <group ref={anchorRef} position={position} />
      {createPortal(children, container)}
    </>
  )
}

export function useGLTF(url) {
  return useLoader(GLTFLoader, url)
}

useGLTF.preload = (url) => useLoader.preload(GLTFLoader, url)
