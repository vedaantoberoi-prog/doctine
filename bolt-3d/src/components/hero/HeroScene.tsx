import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { isNarrowViewport } from '@/lib/device';
import { world } from '@/lib/world';
import { ArchiveStructure } from './ArchiveStructure';
import { CloudField, Pillars, SKY_HORIZON, SKY_MID, SKY_TOP, SkyDome, StonePlatform } from './Environment';
import { FloatingDocuments } from './FloatingDocuments';
import { Instruments } from './Instruments';

type HeroSceneProps = {
  /** Optional: a 0–1 value that drives how gathered the papers are. Without it, the scene follows `world`. */
  progress?: RefObject<number>;
  reduced: boolean;
  onReady: () => void;
  frameloop?: 'always' | 'demand' | 'never';
};

const DAY = { top: SKY_TOP.clone(), mid: SKY_MID.clone(), horizon: SKY_HORIZON.clone(), fog: new THREE.Color('#B9D3F2') };
const DUSK = {
  top: new THREE.Color('#040916'),
  mid: new THREE.Color('#0A2152'),
  horizon: new THREE.Color('#2A5FB8'),
  fog: new THREE.Color('#16356B'),
};

const COOL = new THREE.Color('#CFE3FF');

// Daylight eases into a deep evening blue as the page reaches its later chapters.
function Atmosphere() {
  const scene = useThree((state) => state.scene);
  const sun = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.HemisphereLight>(null);
  useFrame(() => {
    const d = world.dusk;
    SKY_TOP.copy(DAY.top).lerp(DUSK.top, d);
    SKY_MID.copy(DAY.mid).lerp(DUSK.mid, d);
    SKY_HORIZON.copy(DAY.horizon).lerp(DUSK.horizon, d);
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(DAY.fog).lerp(DUSK.fog, d);
    if (sun.current) {
      sun.current.intensity = THREE.MathUtils.lerp(1.9, 1.5, d);
      sun.current.color.set('#FFF3DE').lerp(COOL, d);
      sun.current.position.set(THREE.MathUtils.lerp(5, -3, d), THREE.MathUtils.lerp(9, 5, d), 6);
    }
    if (fill.current) fill.current.intensity = THREE.MathUtils.lerp(0.7, 0.5, d);
  });
  return (
    <>
      <hemisphereLight ref={fill} args={['#D6E6FA', '#F3F1EB', 0.7]} />
      <ambientLight intensity={0.35} color="#E8F0FA" />
      <directionalLight
        ref={sun}
        position={[5, 9, 6]}
        intensity={1.9}
        color="#FFF3DE"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-bias={-0.0008}
      />
    </>
  );
}

// The camera approaches as the papers gather, draws back and rises for the wide views, leans a little with the
// pointer on desktop, and keeps the archive beside the text on wide screens by shifting its view window.
function CameraRig({ reduced }: { reduced: boolean }) {
  const pointer = useThree((state) => state.pointer);
  const size = useThree((state) => state.size);
  const lookAt = useMemo(() => new THREE.Vector3(0, -0.2, 0), []);
  const shift = useRef(0);

  useFrame((state, delta) => {
    const camera = state.camera as THREE.PerspectiveCamera;
    const narrow = size.width / size.height < 0.9;
    const g = world.gather;
    const pull = world.pull;
    const lean = reduced || narrow ? 0 : 1;
    const targetX = THREE.MathUtils.lerp(-1.3, -0.4, g) + pull * 1.1 + pointer.x * 0.3 * lean;
    const targetY = THREE.MathUtils.lerp(0.6, 0.9, g) + pull * 1.5 + pointer.y * 0.18 * lean;
    const targetZ = THREE.MathUtils.lerp(narrow ? 19 : 9, narrow ? 17 : 6.8, g) + pull * (narrow ? 3 : 4.2);
    const k = reduced ? 1 : 1 - Math.exp(-delta * 3);
    camera.position.x += (targetX - camera.position.x) * k;
    camera.position.y += (targetY - camera.position.y) * k;
    camera.position.z += (targetZ - camera.position.z) * k;
    camera.lookAt(lookAt);

    // Wide screens: the picture sits beside the text. Tall screens: it sits above it.
    const wide = size.width / size.height > 1.15;
    const want = wide ? world.shift : 0;
    shift.current += (want - shift.current) * k;
    const lift = wide ? 0 : narrow ? 0.27 : 0.2;
    if (Math.abs(shift.current) > 0.002 || lift) {
      camera.setViewOffset(size.width, size.height, -size.width * shift.current, size.height * lift, size.width, size.height);
    } else if (camera.view) {
      camera.clearViewOffset();
    }
  });

  return null;
}

function ProgressBridge({ progress }: { progress: RefObject<number> }) {
  useFrame(() => {
    world.gather = progress.current ?? 0;
  });
  return null;
}

export default function HeroScene({ progress, reduced, onReady, frameloop = 'always' }: HeroSceneProps) {
  const narrow = isNarrowViewport();
  const [dpr, setDpr] = useState(() => Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 1.75));
  useEffect(() => {
    if (reduced) world.intro = 1;
  }, [reduced]);

  return (
    <Canvas
      shadows
      frameloop={frameloop}
      dpr={dpr}
      camera={{ position: [-1.3, 0.6, 9], fov: 34, near: 0.1, far: 120 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={() => onReady()}
    >
      <fog attach="fog" args={['#B9D3F2', 14, 44]} />
      <Atmosphere />
      <SkyDome />
      <CloudField reduced={reduced} />
      <StonePlatform />
      <Pillars />
      <ArchiveStructure />
      <Instruments reduced={reduced} light={narrow} />
      <FloatingDocuments reduced={reduced} count={narrow ? 5 : 8} />
      <Sparkles
        count={narrow ? 25 : 60}
        scale={[9, 5, 5]}
        size={2.2}
        speed={reduced ? 0 : 0.25}
        opacity={0.55}
        color="#FFFFFF"
        position={[0, 0.5, 0]}
      />
      {/* On a device that can't keep up, drop to one pixel per point and lose the soft shadows' cost */}
      <PerformanceMonitor onDecline={() => setDpr(1)} />
      <CameraRig reduced={reduced} />
      {progress ? <ProgressBridge progress={progress} /> : null}
    </Canvas>
  );
}
