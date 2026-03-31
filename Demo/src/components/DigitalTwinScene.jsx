import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Float, Html, OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'

const PLACEHOLDER_MODEL_URL =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/BoxTextured/glTF/BoxTextured.gltf'

function LoadingBlock() {
  return (
    <mesh position={[0, 1.4, -2.2]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#164e63" wireframe />
    </mesh>
  )
}

function CityBlockModel() {
  const { scene } = useGLTF(PLACEHOLDER_MODEL_URL)

  const model = useMemo(() => {
    const clone = scene.clone()

    clone.traverse((child) => {
      if (child.isMesh) {
        child.material = child.material.clone()
        child.material.color = new THREE.Color('#94a3b8')
        child.material.roughness = 0.88
        child.material.metalness = 0.12
      }
    })

    return clone
  }, [scene])

  return <primitive object={model} position={[0, 1, -2.2]} rotation={[0, Math.PI / 4, 0]} scale={1.35} />
}

function DrainageAssembly({ waterLevel, blocked }) {
  const alertSegmentRef = useRef(null)
  const waterRef = useRef(null)

  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime()

    if (alertSegmentRef.current) {
      const pulse = blocked ? 1 + Math.sin(elapsed * 5) * 0.05 : 1
      alertSegmentRef.current.scale.set(pulse, pulse, pulse)
      alertSegmentRef.current.material.emissiveIntensity = blocked
        ? 0.8 + (Math.sin(elapsed * 5) + 1) * 0.2
        : 0.12
    }

    if (waterRef.current) {
      const targetScale = THREE.MathUtils.mapLinear(waterLevel, 0, 100, 0.08, 1.85)
      waterRef.current.scale.y = THREE.MathUtils.lerp(waterRef.current.scale.y, targetScale, 0.12)
      waterRef.current.position.y = -0.78 + waterRef.current.scale.y / 2
    }
  })

  return (
    <group position={[0, 0, 0]}>
      <mesh position={[-2.4, 0.15, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.34, 0.34, 2.2, 32]} />
        <meshStandardMaterial color="#475569" metalness={0.35} roughness={0.35} />
      </mesh>

      <mesh position={[0, 0.15, 0]}>
        <boxGeometry args={[3.4, 2.2, 1.45]} />
        <meshStandardMaterial
          color={blocked ? '#f87171' : '#cbd5e1'}
          transparent
          opacity={0.18}
          emissive={blocked ? '#ef4444' : '#0f172a'}
          emissiveIntensity={blocked ? 0.28 : 0.08}
        />
      </mesh>

      <mesh ref={alertSegmentRef} position={[2.4, 0.15, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.34, 0.34, 2.2, 32]} />
        <meshStandardMaterial
          color={blocked ? '#ef4444' : '#64748b'}
          emissive={blocked ? '#ef4444' : '#0f172a'}
          metalness={0.35}
          roughness={0.3}
        />
      </mesh>

      <mesh ref={waterRef} position={[0, -0.5, 0]} scale={[1, 0.75, 1]}>
        <boxGeometry args={[3.05, 1, 1.08]} />
        <meshStandardMaterial
          color="#38bdf8"
          transparent
          opacity={0.78}
          emissive="#0ea5e9"
          emissiveIntensity={0.45}
        />
      </mesh>
    </group>
  )
}

function SensorMarker({ sensor }) {
  const accent = sensor.blockageDetected ? '#fb7185' : '#22d3ee'

  return (
    <group position={sensor.position}>
      <Float speed={2} rotationIntensity={0.35} floatIntensity={0.6}>
        <mesh>
          <sphereGeometry args={[0.12, 24, 24]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.9} />
        </mesh>
      </Float>

      <Html position={[0, 0.38, 0]} center distanceFactor={10}>
        <div
          className={`rounded-full border px-2 py-1 text-[10px] shadow-lg ${
            sensor.blockageDetected
              ? 'border-rose-500/60 bg-slate-950/90 text-rose-100 shadow-rose-950/40'
              : 'border-cyan-500/50 bg-slate-950/85 text-cyan-100 shadow-cyan-950/30'
          }`}
        >
          {sensor.id} • {sensor.gps[0].toFixed(4)}, {sensor.gps[1].toFixed(4)}
        </div>
      </Html>
    </group>
  )
}

function SceneContent({ telemetry }) {
  const activeSensor = telemetry.sensors.find((sensor) => sensor.blockageDetected)

  return (
    <>
      <color attach="background" args={['#020617']} />
      <fog attach="fog" args={['#020617', 8, 18]} />
      <ambientLight intensity={1.05} />
      <hemisphereLight skyColor="#67e8f9" groundColor="#020617" intensity={0.7} />
      <directionalLight position={[5, 8, 5]} intensity={1.3} color="#e0f2fe" />
      <pointLight
        position={[2.4, 2.6, 0]}
        intensity={telemetry.blockageDetected ? 12 : 4}
        color={telemetry.blockageDetected ? '#ef4444' : '#22d3ee'}
      />

      <group position={[0, -1.05, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[7.5, 64]} />
          <meshStandardMaterial color="#08121f" />
        </mesh>

        <gridHelper args={[14, 14, '#155e75', '#0f172a']} position={[0, 0.01, 0]} />

        <Suspense fallback={<LoadingBlock />}>
          <CityBlockModel />
        </Suspense>

        <DrainageAssembly blocked={telemetry.blockageDetected} waterLevel={telemetry.waterLevel} />

        {telemetry.sensors.map((sensor) => (
          <SensorMarker key={sensor.id} sensor={sensor} />
        ))}

        {activeSensor ? (
          <Html position={[2.4, 2.7, 0]} center>
            <div className="rounded-lg border border-rose-500/40 bg-slate-950/90 px-3 py-2 text-[11px] text-rose-100 shadow-lg shadow-rose-950/40">
              Edge AI alert: blockage near {activeSensor.name}
            </div>
          </Html>
        ) : null}
      </group>

      <OrbitControls
        makeDefault
        enablePan
        enableRotate
        enableZoom
        minDistance={5}
        maxDistance={13}
        maxPolarAngle={1.55}
      />
    </>
  )
}

export default function DigitalTwinScene({ telemetry }) {
  return (
    <div className="twin-scene-canvas h-full w-full">
      <Canvas camera={{ position: [5.5, 4.5, 7], fov: 42 }} dpr={[1, 1.5]}>
        <SceneContent telemetry={telemetry} />
      </Canvas>
    </div>
  )
}

useGLTF.preload(PLACEHOLDER_MODEL_URL)
