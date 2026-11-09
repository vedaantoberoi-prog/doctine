import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createDocumentTexture, type DocumentKind } from './documentTextures';

type Vec3 = [number, number, number];

type DocumentSpec = {
  kind: DocumentKind;
  home: Vec3;
  homeRotation: Vec3;
  target: Vec3;
  homeScale: number;
};

const DOCUMENT_SPECS: DocumentSpec[] = [
  { kind: 'report', home: [3.4, 1.4, 1.2], homeRotation: [0.2, -0.5, 0.08], target: [-0.65, 0.35, 0.1], homeScale: 1 },
  { kind: 'prescription', home: [4.1, -0.9, 0.6], homeRotation: [-0.1, 0.4, -0.12], target: [0.65, 0.35, 0.1], homeScale: 1 },
  { kind: 'schedule', home: [2.2, -1.9, 1.8], homeRotation: [0.3, 0.2, 0.1], target: [-0.65, -1.25, 0.1], homeScale: 0.95 },
  { kind: 'profile', home: [0.2, 1.9, -0.8], homeRotation: [-0.2, -0.3, -0.05], target: [0.65, -1.25, 0.1], homeScale: 0.9 },
  { kind: 'dates', home: [5.0, 0.6, -1.5], homeRotation: [0, -0.6, 0.2], target: [0, 0.35, 0.25], homeScale: 0.9 },
  { kind: 'report', home: [-1.6, 2.6, -3], homeRotation: [0.1, 0.3, 0], target: [0, -0.55, -0.35], homeScale: 0.7 },
  { kind: 'prescription', home: [6, 1.8, -2.5], homeRotation: [0, -0.2, 0.15], target: [0, -2.05, -0.35], homeScale: 0.65 },
  { kind: 'schedule', home: [-2.6, -2.1, -2], homeRotation: [0.2, 0.5, -0.1], target: [0, 0.9, -0.35], homeScale: 0.6 },
];

const TARGET_SCALE = 0.55;

function smootherStep(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function DocumentSheet({
  spec,
  index,
  progress,
  reduced,
}: {
  spec: DocumentSpec;
  index: number;
  progress: RefObject<number>;
  reduced: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const texture = useMemo(() => createDocumentTexture(spec.kind), [spec.kind]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const p = smootherStep(progress.current ?? 0);
    const t = state.clock.elapsedTime;
    const phase = index * 1.7;
    const bob = reduced ? 0 : Math.sin(t * 0.6 + phase) * 0.08 * (1 - p);
    const sway = reduced ? 0 : Math.sin(t * 0.35 + phase) * 0.35 * (1 - p);

    mesh.position.set(
      THREE.MathUtils.lerp(spec.home[0], spec.target[0], p),
      THREE.MathUtils.lerp(spec.home[1], spec.target[1], p) + bob,
      THREE.MathUtils.lerp(spec.home[2], spec.target[2], p),
    );
    mesh.rotation.set(
      THREE.MathUtils.lerp(spec.homeRotation[0], 0, p),
      THREE.MathUtils.lerp(spec.homeRotation[1] + sway, 0, p),
      THREE.MathUtils.lerp(spec.homeRotation[2], 0, p),
    );
    mesh.scale.setScalar(THREE.MathUtils.lerp(spec.homeScale, TARGET_SCALE, p));
  });

  return (
    <mesh ref={meshRef} castShadow>
      <planeGeometry args={[1.1, 1.5]} />
      <meshStandardMaterial map={texture} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function FloatingDocuments({
  progress,
  reduced,
  count,
}: {
  progress: RefObject<number>;
  reduced: boolean;
  count: number;
}) {
  return (
    <group>
      {DOCUMENT_SPECS.slice(0, count).map((spec, i) => (
        <DocumentSheet key={i} spec={spec} index={i} progress={progress} reduced={reduced} />
      ))}
    </group>
  );
}
