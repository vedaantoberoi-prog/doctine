import { useRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { isNarrowViewport } from '@/lib/device';
import { ArchiveStructure } from './ArchiveStructure';
import { CloudField, Pillars, SkyDome, StonePlatform } from './Environment';
import { FloatingDocuments } from './FloatingDocuments';

type HeroSceneProps = {
  progress: RefObject<number>;
  reduced: boolean;
  onReady: () => void;
  frameloop?: 'always' | 'demand' | 'never';
};

function Lights() {
  return (
    <>
      <hemisphereLight args={['#D6E6FA', '#F3F1EB', 0.7]} />
      <ambientLight intensity={0.35} color="#E8F0FA" />
      <directionalLight
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

function CameraRig({ progress, reduced }: { progress: RefObject<number>; reduced: boolean }) {
  const pointer = useThree((state) => state.pointer);
  const aspect = useThree((state) => state.viewport.aspect);
  const narrow = aspect < 0.9;
  const lookAt = useRef(new THREE.Vector3(0, -0.2, 0));

  useFrame((state, delta) => {
    const camera = state.camera;
    const p = progress.current ?? 0;
    const parallax = reduced ? 0 : 1;
    const targetX = THREE.MathUtils.lerp(-1.3, -0.4, p) + pointer.x * 0.25 * parallax;
    const targetY = THREE.MathUtils.lerp(0.6, 0.9, p) + pointer.y * 0.15 * parallax;
    const targetZ = THREE.MathUtils.lerp(narrow ? 10.5 : 9, narrow ? 8 : 6.8, p);
    const k = reduced ? 1 : 1 - Math.exp(-delta * 3);
    camera.position.x += (targetX - camera.position.x) * k;
    camera.position.y += (targetY - camera.position.y) * k;
    camera.position.z += (targetZ - camera.position.z) * k;
    camera.lookAt(lookAt.current);
  });

  return null;
}

export default function HeroScene({ progress, reduced, onReady, frameloop = 'always' }: HeroSceneProps) {
  const narrow = isNarrowViewport();

  return (
    <Canvas
      shadows
      frameloop={frameloop}
      dpr={narrow ? [1, 1.5] : [1, 2]}
      camera={{ position: [-1.3, 0.6, 9], fov: 34, near: 0.1, far: 120 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={() => onReady()}
    >
      <fog attach="fog" args={['#B9D3F2', 14, 44]} />
      <Lights />
      <SkyDome />
      <CloudField reduced={reduced} />
      <StonePlatform />
      <Pillars />
      <ArchiveStructure />
      <FloatingDocuments progress={progress} reduced={reduced} count={narrow ? 5 : 8} />
      <Sparkles
        count={narrow ? 25 : 60}
        scale={[9, 5, 5]}
        size={2.2}
        speed={reduced ? 0 : 0.25}
        opacity={0.55}
        color="#FFFFFF"
        position={[0, 0.5, 0]}
      />
      <CameraRig progress={progress} reduced={reduced} />
    </Canvas>
  );
}
